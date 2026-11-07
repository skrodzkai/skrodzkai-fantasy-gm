// Source assembly for the already-open, owner-fenced PR60 store.
import { dispatchClaimed, postflight } from './fantasy-harness-ledger.mjs';

const bind = (method, receiver) => typeof method === 'function' ? method.bind(receiver) : undefined;

export function createRavenHarness({
  store, owner, createRavenSubmitAdapter, raven, readPostflight, verifyReceipt, clock = Date.now,
}) {
  if (typeof readPostflight !== 'function' || typeof verifyReceipt !== 'function')
    throw new Error('independent_postflight_required');
  if (typeof createRavenSubmitAdapter !== 'function') throw new Error('raven_submit_required');
  const attemptsFor = bind(store?.attemptsFor, store);
  if (!attemptsFor) throw new Error('durable_attempts_required');
  const {
    profileId, ravenScope, resolvePagePlan, openSession, readProposalEvidence, awaitOperatorGrant,
    readGrantEvidence, readStop, signal, monotonic,
  } = raven;
  if (![resolvePagePlan, openSession, readProposalEvidence, awaitOperatorGrant, readGrantEvidence, readStop]
    .every(provider => typeof provider === 'function')) throw new Error('raven_providers_required');
  const scope = structuredClone(ravenScope);

  const adapter = {
    async submit(intent, dispatchContext) {
      const context = Object.freeze({ ...dispatchContext });
      const attempts = attemptsFor(context);
      let plannedUrl;
      const submitter = createRavenSubmitAdapter({
        profileId, ravenScope: structuredClone(scope), clock, monotonic, signal, readStop, attempts,
        async resolvePagePlan(...args) {
          const plan = structuredClone(await resolvePagePlan(...args));
          const url = plan?.url;
          if (typeof url !== 'string' || /[\u0000-\u0020\u007f]/.test(url) || !URL.canParse(url))
            throw new Error('planned_url_invalid');
          if (new URL(url).protocol !== 'https:') throw new Error('planned_url_invalid');
          plannedUrl = url;
          return plan;
        },
        async openSession() {
          const client = await openSession();
          if (!client) return client;
          const tool = bind(client.tool, client);
          const close = bind(client.close, client);
          let atPlannedUrl = false;
          return {
            initialize: bind(client.initialize, client),
            call: bind(client.call, client),
            // Raven remains the single cleanup owner.
            close: close && (async () => structuredClone(await close())),
            tool: tool && (async (method, params) => {
              if (method === 'page_open') {
                atPlannedUrl = false;
                if (typeof plannedUrl !== 'string' || params?.url !== plannedUrl) throw new Error('planned_url_mismatch');
                const opened = structuredClone(await tool(method, params));
                if (opened?.isError || opened?.data?.outcome !== 'OBSERVED' ||
                    opened.data.observation?.url !== plannedUrl)
                  throw new Error('observed_url_mismatch');
                atPlannedUrl = true;
                return opened;
              }
              if (method === 'page_propose_action') {
                if (!atPlannedUrl) throw new Error('observed_url_mismatch');
                return structuredClone(await tool(method, params));
              }
              if (method === 'page_act') {
                if (!atPlannedUrl) throw new Error('observed_url_mismatch');
                if (!attempts.isSubmitting()) throw new Error('submission_mark_not_current');
                if (!(clock() < context.deadline)) throw new Error('dispatch_deadline_passed');
              }
              return tool(method, params);
            }),
          };
        },
        readProposalEvidence: async input => structuredClone(await readProposalEvidence(input)),
        awaitOperatorGrant,
        readGrantEvidence: async input => structuredClone(await readGrantEvidence(input)),
      });
      if (typeof submitter?.submit !== 'function') throw new Error('raven_submit_required');
      return submitter.submit(intent, context);
    },
  };

  return Object.freeze({
    dispatch(id) {
      return dispatchClaimed({ store, adapter, owner, id, clock });
    },

    // readPostflight is an independent GET-only provider. verifyReceipt must
    // authenticate its receipt for this exact action, independently of submit.
    async reconcile(id) {
      const state = await store.load();
      if (state.owner !== owner) throw new Error('owner_mismatch');
      const job = state.jobs[id];
      if (job?.status !== 'Unknown') throw new Error('postflight_not_expected');
      const binding = Object.freeze({ deadline: job.deadline, occurrenceId: job.id, actionId: job.actionId });
      const { evidence, receipt } = structuredClone(await readPostflight(binding, structuredClone(job.intent)));
      if (receipt?.occurrenceId !== binding.occurrenceId || receipt?.actionId !== binding.actionId ||
          await verifyReceipt(receipt, binding) !== true)
        throw new Error('postflight_receipt_unverified');

      const next = postflight(state, { owner, id, evidence: { ...evidence, receiptConfirmed: true }, now: clock() });
      if (await store.compareAndSwap(state.revision, next) !== true)
        throw new Error('postflight_commit_not_confirmed');
      return next.jobs[id];
    },
  });
}
