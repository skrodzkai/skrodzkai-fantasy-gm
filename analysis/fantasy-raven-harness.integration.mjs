// LAMAR_RAVEN_ADAPTER_PATH=/path/to/reviewed/raven-executor.mjs node --test --test-isolation=none analysis/fantasy-raven-harness.integration.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claim, scheduleFingerprint } from './fantasy-harness-ledger.mjs';
import { openHarnessStore } from './fantasy-harness-durable-store.mjs';
import { createRavenHarness } from './fantasy-raven-harness.mjs';
import { TARGET } from './yahoo-fantasy-readonly.mjs';

const adapterPath = process.env.LAMAR_RAVEN_ADAPTER_PATH;
if (!adapterPath) throw new Error('LAMAR_RAVEN_ADAPTER_PATH must name the reviewed artifact');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const source = readFileSync(adapterPath);
assert.equal(sha(source), 'a66004c565a6d493cc1dd72be612b466fa51e93a97348887765132bede35a898');
const { createRavenSubmitAdapter } = await import('data:text/javascript;base64,' + source.toString('base64'));
const owner = 'fixture-owner';
const scope = { taskId: 'fixture-task', owner, epoch: 'fixture-epoch' };
const schedule = { owner, scheduleFingerprint: scheduleFingerprint({ schedule: 'fixture-only', timezone: 'UTC' }) };
const scheduledFor = 1000;
const id = String(scheduledFor);
const deadline = 2000;
const claimInput = {
  owner, fingerprint: schedule.scheduleFingerprint, scheduledFor, deadline, now: 1100,
  intent: {
    season: TARGET.season, league: TARGET.leagueId, team: TARGET.teamId, week: 9,
    before: [{ id: '22', slot: 'WR' }, { id: '11', slot: 'BN' }, { id: '33', slot: 'QB' }],
    after: [{ id: '22', slot: 'BN' }, { id: '11', slot: 'WR' }, { id: '33', slot: 'QB' }],
  },
};

async function fixture(t, { grantExpiresAt = deadline, stopped = false } = {}) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'pr60-raven-'));
  let store;
  t.after(() => {
    try { store?.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  store = openHarnessStore(root, { ...schedule, initialize: true });
  const before = await store.load();
  const claimed = claim(before, claimInput);
  assert.equal(await store.compareAndSwap(before.revision, claimed), true);
  const job = claimed.jobs[id];
  const binding = { deadline, occurrenceId: id, actionId: job.actionId };

  const observations = [];
  const attemptKey = id + '/' + job.actionId;
  let attempt = null;
  let time = claimInput.now;
  let proposalEvidence;
  let grant;
  const url = 'about:blank';
  const target = { id: 'fixture-target', role: 'button', name: 'Fixture confirm' };
  const action = { kind: 'click' };
  const observation = {
    url, pageGeneration: 1, observationId: 'fixture-observation', observationDigest: sha('observation'), targets: [target],
  };
  const latestJob = () => {
    const latest = readdirSync(root).filter(name => name.endsWith('.json')).sort().at(-1);
    return JSON.parse(readFileSync(path.join(root, latest), 'utf8')).state.ledger.jobs[id];
  };
  const record = (event, details = {}) => {
    observations.push({ event, status: latestJob().status, attempt, ...details });
  };
  const session = {
    async initialize() {},
    async call(method) {
      assert.equal(method, 'tools/list');
      return { result: { tools: ['page_open', 'page_propose_action', 'page_act'].map(name => ({ name })) } };
    },
    async tool(method, params) {
      record(method, { params });
      switch (method) {
        case 'page_open':
          return { data: { outcome: 'OBSERVED', session: 'fixture-session', observation } };
        case 'page_propose_action': {
          const proposal = {
            schema: 'raven-action-proposal-v1', proposalId: 'fixture-proposal', ...scope,
            profileId: 'fixture', sessionId: 'fixture-session', pageGeneration: observation.pageGeneration,
            observationId: observation.observationId, observationDigest: observation.observationDigest,
            origin: 'null', url, target, action, createdAt: time, expiresAt: deadline + 100,
            pageContentTrust: 'fixture',
          };
          const proposalDigest = sha(JSON.stringify(proposal));
          proposalEvidence = { proposal, proposalDigest };
          return { data: { status: 'AWAITING_OPERATOR_GRANT', proposalId: proposal.proposalId, proposalDigest } };
        }
        case 'page_act':
          return { data: { outcome: 'DISPATCHED', dispatched: true, events: 1 } };
        default:
          throw new Error('unexpected_fixture_tool');
      }
    },
    async close() {
      record('close');
      return {
        exit: { code: 0, signal: null },
        closed: {
          childReaped: true, cleanupUncertain: false, journalUncertain: false,
          stopDurabilityUncertain: false, revocationUncertain: false,
        },
      };
    },
  };
  const raven = {
    profileId: 'fixture', ravenScope: scope, monotonic: () => 0,
    readStop: async () => stopped,
    resolvePagePlan: async (intent, context) => {
      record('plan', { intent, context });
      return { schema: 'raven-lamar-page-plan-v1', actionId: job.actionId, url, target: { role: target.role, name: target.name }, action };
    },
    openSession: () => {
      record('session');
      return session;
    },
    readProposalEvidence: async () => proposalEvidence,
    // Synthetic evidence supplied by the test operator, outside the adapter.
    awaitOperatorGrant: async ({ proposalId, proposalDigest, deadline: requestedDeadline }) => {
      record('grant', { deadline: requestedDeadline });
      grant = {
        schema: 'raven-operator-action-grant-v1', proposalId, proposalDigest, ...scope,
        grantedAt: time, expiresAt: grantExpiresAt,
      };
      return true;
    },
    readGrantEvidence: async () => grant,
    // In-memory stand-in for the missing owner-fenced Raven attempt journal.
    attempts: {
      async reserve(key) {
        record('reserve', { key });
        if (key !== attemptKey || attempt !== null || latestJob().status !== 'Running') return false;
        attempt = 'reserved';
        return true;
      },
      async markSubmitting(key) {
        record('mark', { key });
        if (key !== attemptKey || attempt !== 'reserved' || latestJob().status !== 'Running') return false;
        attempt = 'submitting';
        return true;
      },
      async release(key) {
        record('release', { key });
        if (key !== attemptKey || attempt !== 'reserved') return false;
        attempt = null;
        return true;
      },
    },
  };

  let evidencePatch = {};
  let receiptPatch = {};
  let verifierResult = true;
  const readPostflight = async (context, intent) => {
    assert.deepEqual(context, binding);
    assert.deepEqual(intent, job.intent);
    const { season, league, team, week, after } = job.intent;
    return {
      evidence: { source: 'independent_read', observedAt: time - 1, season, league, team, week, roster: after, pendingClear: true, ...evidencePatch },
      receipt: { occurrenceId: id, actionId: job.actionId, token: 'fixture-receipt', ...receiptPatch },
    };
  };
  const verifyReceipt = async (receipt, context) => {
    assert.deepEqual(context, binding);
    assert.equal(receipt.token, 'fixture-receipt');
    return verifierResult;
  };
  const outcomes = [];
  const harness = () => createRavenHarness({
    store, owner, raven, readPostflight, verifyReceipt, clock: () => time,
    createRavenSubmitAdapter(options) {
      const adapter = createRavenSubmitAdapter(options);
      return {
        async submit(intent, context) {
          const outcome = await adapter.submit(intent, context);
          outcomes.push(outcome);
          return outcome;
        },
      };
    },
  });

  return {
    root, observations, outcomes, job, binding, harness, latestJob,
    load: () => store.load(),
    reopen() {
      store.close();
      store = null;
      store = openHarnessStore(root, schedule);
    },
    advanceTo(value) { time = value; },
    postflight({ evidence = {}, receipt = {}, verified = true } = {}) {
      evidencePatch = evidence;
      receiptPatch = receipt;
      verifierResult = verified;
    },
  };
}

test('PR60 persists Running, dispatches Raven once, and reconciles only the exact independent receipt after reopen', async t => {
  const f = await fixture(t);
  const harness = f.harness();
  assert.throws(() => openHarnessStore(f.root, schedule), /EEXIST/);

  const [first, second] = await Promise.allSettled([harness.dispatch(id), harness.dispatch(id)]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(first.value.status, 'Unknown');
  assert.equal(second.status, 'rejected');
  assert.match(second.reason.message, /commit_not_confirmed/);
  assert.equal(f.latestJob().status, 'Unknown');
  assert.deepEqual(f.observations.map(o => o.event), [
    'plan', 'reserve', 'session', 'page_open', 'page_propose_action', 'grant', 'mark', 'page_act', 'close',
  ]);
  assert.ok(f.observations.every(o => o.status === 'Running'));
  assert.deepEqual(f.observations[0].context, f.binding);
  assert.deepEqual(f.observations[0].intent, f.job.intent);
  assert.equal(f.observations.find(o => o.event === 'grant').deadline, deadline);
  assert.equal(f.observations.find(o => o.event === 'mark').key, id + '/' + f.job.actionId);
  assert.equal(f.observations.find(o => o.event === 'page_act').attempt, 'submitting');
  assert.equal(f.outcomes.length, 1);
  assert.equal(f.outcomes[0].kind, 'raven_input_dispatched');
  assert.equal(f.outcomes[0].websiteTransactionVerified, false);
  assert.deepEqual(f.outcomes[0].context, f.binding);

  f.reopen();
  f.advanceTo(62000);
  const reopened = f.harness();
  const unknown = await f.load();
  assert.equal(unknown.jobs[id].status, 'Unknown');
  await assert.rejects(reopened.dispatch(id), /not_dispatchable/);
  const nextOccurrence = { ...claimInput, scheduledFor: 61999, deadline: 63000, now: 62000 };
  assert.throws(() => claim(unknown, nextOccurrence), /unresolved_occurrence/);

  for (const [patch, code] of [
    [{ receipt: { actionId: sha('different action') } }, /postflight_receipt_unverified/],
    [{ receipt: { occurrenceId: '999' } }, /postflight_receipt_unverified/],
    [{ verified: 'true' }, /postflight_receipt_unverified/],
    [{ evidence: { source: 'raven' } }, /postflight_unproven/],
    [{ evidence: { pendingClear: false } }, /postflight_unproven/],
    [{ evidence: { team: 'wrong-target' } }, /postflight_unproven/],
    [{ evidence: { observedAt: 1100 } }, /postflight_unproven/],
    [{ evidence: { roster: f.job.intent.after.filter(row => row.id !== '33') } }, /postflight_unproven/],
  ]) {
    f.postflight(patch);
    await assert.rejects(reopened.reconcile(id), code);
    assert.deepEqual(await f.load(), unknown);
  }

  f.postflight();
  assert.equal((await reopened.reconcile(id)).status, 'Succeeded');
  f.reopen();
  const succeeded = await f.load();
  assert.equal(succeeded.jobs[id].status, 'Succeeded');
  assert.throws(() => claim(succeeded, nextOccurrence), /duplicate_action/);
  assert.equal(f.observations.filter(o => o.event === 'page_act').length, 1);
});

test('Raven rejects a fixture grant that outlives the unchanged PR60 deadline before marking or sending', async t => {
  const f = await fixture(t, { grantExpiresAt: deadline + 1 });
  const result = await f.harness().dispatch(id);
  assert.equal(result.status, 'Failed');
  assert.equal(result.reason, 'confirmed_no_submission');
  assert.equal(f.outcomes[0].reason, 'GRANT_OUTLIVES_DOMAIN_DEADLINE');
  assert.deepEqual(f.observations.map(o => o.event), [
    'plan', 'reserve', 'session', 'page_open', 'page_propose_action', 'grant', 'close', 'release',
  ]);
  assert.equal(f.latestJob().status, 'Failed');
});

test('Raven Stop before opening a session leaves the claimed occurrence terminal without a send', async t => {
  const f = await fixture(t, { stopped: true });
  const harness = f.harness();
  assert.equal((await harness.dispatch(id)).status, 'Failed');
  assert.equal(f.outcomes[0].reason, 'STOPPED_BEFORE:open-session');
  assert.deepEqual(f.observations.map(o => o.event), ['plan', 'reserve', 'release']);
  await assert.rejects(harness.dispatch(id), /not_dispatchable/);
});
