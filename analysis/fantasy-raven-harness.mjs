// Source assembly for the already-open, owner-fenced PR60 store. The incumbent
// supplies Raven's providers, including durable attempt markers under the same
// fence that do not advance the ledger revision while dispatch is in flight.
import { dispatchClaimed, postflight } from './fantasy-harness-ledger.mjs';

export function createRavenHarness({
  store, owner, createRavenSubmitAdapter, raven, readPostflight, verifyReceipt, clock = Date.now,
}) {
  if (typeof readPostflight !== 'function' || typeof verifyReceipt !== 'function')
    throw new Error('independent_postflight_required');
  const adapter = createRavenSubmitAdapter({ ...raven, clock });
  if (typeof adapter?.submit !== 'function') throw new Error('raven_submit_required');

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
