// LAMAR_RAVEN_ADAPTER_PATH=/path/to/reviewed/raven-executor.mjs node --test --test-isolation=none analysis/fantasy-raven-harness.integration.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claim, recoverInterrupted, scheduleFingerprint } from './fantasy-harness-ledger.mjs';
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

const fixtureUrl = 'https://fixture.invalid/roster?week=9';
async function fixture(t, {
  grantExpiresAt = deadline, stopped = false, planUrl = fixtureUrl, observationPatch = {}, pageOpenError = false,
  mutateObservation = false, mutateEvidence = false, closeError = false, stopAfterMark = false,
  closeWriterAfterMark = false, failMarkWrite = false, sessionFailure,
} = {}) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'pr60-raven-'));
  let store;
  t.after(() => {
    try { store?.close(); }
    finally {
      chmodSync(root, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });
  store = openHarnessStore(root, { ...schedule, initialize: true });
  const before = await store.load();
  const claimed = claim(before, claimInput);
  assert.equal(await store.compareAndSwap(before.revision, claimed), true);
  const job = claimed.jobs[id];
  const binding = { deadline, occurrenceId: id, actionId: job.actionId };

  const observations = [];
  const attemptKey = id + '/' + job.actionId;
  let time = claimInput.now;
  let proposalEvidence;
  let grant;
  let evidenceRead = false;
  let grantRead = false;
  const target = { id: 'fixture-target', role: 'button', name: 'Fixture confirm' };
  const action = { kind: 'click' };
  const observation = {
    url: fixtureUrl, pageGeneration: 1, observationId: 'fixture-observation', observationDigest: sha('observation'),
    targets: [target], ...observationPatch,
  };
  const latest = () => {
    const latest = readdirSync(root).filter(name => name.endsWith('.json')).sort().at(-1);
    return JSON.parse(readFileSync(path.join(root, latest), 'utf8')).state;
  };
  const latestJob = () => latest().ledger.jobs[id];
  const latestAttempt = () => latest().attempts[attemptKey];
  const record = (event, details = {}) => {
    const state = latest();
    observations.push({ event, status: state.ledger.jobs[id].status, attempt: state.attempts[attemptKey], ...details });
  };
  const session = {
    async initialize() { assert.equal(this, session); },
    async call(method) {
      assert.equal(this, session);
      assert.equal(method, 'tools/list');
      return { result: { tools: ['page_open', 'page_propose_action', 'page_act'].map(name => ({ name })) } };
    },
    async tool(method, params) {
      assert.equal(this, session);
      record(method, { params });
      switch (method) {
        case 'page_open':
          return { isError: pageOpenError, data: { outcome: 'OBSERVED', session: 'fixture-session', observation } };
        case 'page_propose_action': {
          const proposal = {
            schema: 'raven-action-proposal-v1', proposalId: 'fixture-proposal', ...scope,
            profileId: 'fixture', sessionId: 'fixture-session', pageGeneration: observation.pageGeneration,
            observationId: observation.observationId, observationDigest: observation.observationDigest,
            origin: 'https://fixture.invalid', url: observation.url, target, action, createdAt: time, expiresAt: deadline + 100,
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
      assert.equal(this, session);
      record('close');
      if (closeError) throw new Error('fixture_cleanup_failure');
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
    profileId: 'fixture', ravenScope: { ...scope }, monotonic: () => 0,
    readStop: async () => {
      if (mutateObservation && observations.at(-1)?.event === 'page_open')
        observation.url = 'https://fixture.invalid/unplanned';
      if (mutateEvidence && evidenceRead)
        proposalEvidence.proposal.url = 'https://fixture.invalid/unplanned';
      if (failMarkWrite && grantRead) chmodSync(root, 0o500);
      if ((stopAfterMark || closeWriterAfterMark) && latestAttempt() === 'Submitting') {
        if (closeWriterAfterMark) { store.close(); store = null; }
        return stopAfterMark;
      }
      return stopped;
    },
    resolvePagePlan: async (intent, context) => {
      record('plan', { intent, context });
      return {
        schema: 'raven-lamar-page-plan-v1', actionId: job.actionId, target: { role: target.role, name: target.name }, action,
        ...(planUrl === null ? {} : { url: planUrl }),
      };
    },
    openSession: () => {
      record('session');
      if (sessionFailure === 'missing close') return { ...session, close: undefined };
      if (sessionFailure === 'rejected acquisition') throw new Error('fixture_acquisition_failure');
      return session;
    },
    readProposalEvidence: async () => { evidenceRead = true; return proposalEvidence; },
    // Synthetic evidence supplied by the test operator, outside the adapter.
    awaitOperatorGrant: async ({ proposalId, proposalDigest, deadline: requestedDeadline }) => {
      record('grant', { deadline: requestedDeadline });
      grant = {
        schema: 'raven-operator-action-grant-v1', proposalId, proposalDigest, ...scope,
        grantedAt: time, expiresAt: grantExpiresAt,
      };
      return true;
    },
    readGrantEvidence: async () => { grantRead = true; return grant; },
    attempts: { reserve: assert.fail, markSubmitting: assert.fail, release: assert.fail },
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
      receipt: { occurrenceId: id, actionId: job.actionId, receiptId: 'fixture-receipt', ...receiptPatch },
    };
  };
  const verifyReceipt = async (receipt, context) => {
    assert.deepEqual(context, binding);
    assert.equal(receipt.receiptId, 'fixture-receipt');
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
    root, observations, outcomes, job, binding, harness, latestJob, latestAttempt,
    load: () => store.load(),
    reopen() {
      store?.close();
      store = null;
      store = openHarnessStore(root, schedule);
    },
    abandon() { store.abandon(); store = null; },
    mutateProviderOptions() {
      raven.ravenScope.owner = 'fixture-other';
      raven.openSession = assert.fail;
      raven.resolvePagePlan = assert.fail;
    },
    async recover() {
      const before = await store.load();
      assert.equal(await store.compareAndSwap(before.revision, recoverInterrupted(before)), true);
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
    'plan', 'session', 'page_open', 'page_propose_action', 'grant', 'page_act', 'close',
  ]);
  assert.ok(f.observations.every(o => o.status === 'Running'));
  assert.deepEqual(f.observations[0].context, f.binding);
  assert.deepEqual(f.observations[0].intent, f.job.intent);
  assert.equal(f.observations.find(o => o.event === 'grant').deadline, deadline);
  assert.equal(f.observations.find(o => o.event === 'session').attempt, 'Reserved');
  assert.equal(f.observations.find(o => o.event === 'page_act').attempt, 'Submitting');
  assert.equal(f.outcomes.length, 1);
  assert.equal(f.outcomes[0].kind, 'raven_input_dispatched');
  assert.equal(f.outcomes[0].websiteTransactionVerified, false);
  assert.deepEqual(f.outcomes[0].context, f.binding);

  f.reopen();
  f.advanceTo(62000);
  const reopened = f.harness();
  const unknown = await f.load();
  assert.equal(unknown.jobs[id].status, 'Unknown');
  assert.equal(unknown.revision, 3);
  assert.equal(f.latestAttempt(), 'Submitting');
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
    'plan', 'session', 'page_open', 'page_propose_action', 'grant', 'close',
  ]);
  assert.equal(f.latestJob().status, 'Failed');
  assert.equal(f.latestAttempt(), 'Released');
});

test('Raven Stop before opening a session leaves the claimed occurrence terminal without a send', async t => {
  const f = await fixture(t, { stopped: true });
  const harness = f.harness();
  assert.equal((await harness.dispatch(id)).status, 'Failed');
  assert.equal(f.outcomes[0].reason, 'STOPPED_BEFORE:open-session');
  assert.deepEqual(f.observations.map(o => o.event), ['plan']);
  f.reopen();
  assert.equal(f.latestAttempt(), 'Released');
  await assert.rejects(f.harness().dispatch(id), /not_dispatchable/);
});
test('wrong or missing observed URLs stop before proposal, grant, and send', async t => {
  for (const url of ['https://other.invalid/roster?week=9', 'https://fixture.invalid/other?week=9',
    'https://fixture.invalid/roster?week=10', 'invalid url', undefined]) {
    await t.test(String(url), async t => {
      const f = await fixture(t, { observationPatch: { url } });
      assert.equal((await f.harness().dispatch(id)).status, 'Failed');
      assert.equal(f.outcomes[0].reason, 'observed_url_mismatch');
      assert.deepEqual(f.observations.map(o => o.event), ['plan', 'session', 'page_open', 'close']);
      assert.equal(f.latestAttempt(), 'Released');
    });
  }
});

test('invalid or non-HTTPS plans never open a session or reserve an attempt', async t => {
  for (const [name, planUrl] of [
    ['leading whitespace', ' https://fixture.invalid/roster?week=9'],
    ['missing URL', null],
    ['relative URL', '/roster?week=9'],
    ['HTTP URL', 'http://fixture.invalid/roster?week=9'],
    ['data URL', 'data:text/plain,fixture'],
    ['JavaScript URL', 'javascript:void(0)'],
  ]) {
    await t.test(name, async t => {
      const f = await fixture(t, { planUrl });
      assert.equal((await f.harness().dispatch(id)).status, 'Unknown');
      assert.deepEqual(f.observations.map(o => o.event), ['plan']);
      assert.equal(f.latestAttempt(), undefined);
    });
  }
});

test('a page-open error with the exact planned URL never reaches proposal, grant, or send', async t => {
  const f = await fixture(t, { pageOpenError: true });
  assert.equal((await f.harness().dispatch(id)).status, 'Failed');
  assert.equal(f.outcomes[0].reason, 'observed_url_mismatch');
  assert.deepEqual(f.observations.map(o => o.event), ['plan', 'session', 'page_open', 'close']);
  assert.equal(f.latestAttempt(), 'Released');
});

test('mutating the returned observation cannot redirect the proposal binding', async t => {
  const f = await fixture(t, { mutateObservation: true });
  assert.equal((await f.harness().dispatch(id)).status, 'Failed');
  assert.equal(f.outcomes[0].reason, 'PROPOSAL_NOT_THE_INTENDED_ACTION');
  assert.deepEqual(f.observations.map(o => o.event), ['plan', 'session', 'page_open', 'page_propose_action', 'close']);
  assert.equal(f.latestAttempt(), 'Released');
});

test('mutating provider options or returned proposal evidence cannot alter captured bindings', async t => {
  const f = await fixture(t, { mutateEvidence: true });
  const harness = f.harness();
  f.mutateProviderOptions();
  assert.equal((await harness.dispatch(id)).status, 'Unknown');
  assert.equal(f.outcomes[0].kind, 'raven_input_dispatched');
  assert.equal(f.latestAttempt(), 'Submitting');
});

test('session cleanup failure after a URL mismatch keeps the occurrence Unknown', async t => {
  const f = await fixture(t, { observationPatch: { url: 'https://other.invalid/' }, closeError: true });
  assert.equal((await f.harness().dispatch(id)).status, 'Unknown');
  assert.equal(f.outcomes[0].kind, 'ambiguous');
  assert.equal(f.outcomes[0].cleanup.closeError, 'fixture_cleanup_failure');
  assert.deepEqual(f.observations.map(o => o.event), ['plan', 'session', 'page_open', 'close']);
  assert.equal(f.latestAttempt(), 'Released');
});

test('Stop after the durable mark retains Submitting and Unknown without a send', async t => {
  const f = await fixture(t, { stopAfterMark: true });
  assert.equal((await f.harness().dispatch(id)).status, 'Unknown');
  assert.equal(f.outcomes[0].kind, 'ambiguous');
  assert.equal(f.outcomes[0].reason, 'STOPPED_BEFORE:act');
  f.reopen();
  assert.equal(f.latestAttempt(), 'Submitting');
  assert.equal(f.latestJob().status, 'Unknown');
  assert.equal(f.observations.some(o => o.event === 'page_act'), false);
});

test('losing the writer fence after mark blocks send and leaves Running for explicit recovery', async t => {
  const f = await fixture(t, { closeWriterAfterMark: true });
  await assert.rejects(f.harness().dispatch(id), /STORE_CLOSED_OR_POISONED/);
  assert.equal(f.outcomes[0].kind, 'ambiguous');
  assert.equal(f.outcomes[0].released, null);
  assert.equal(f.observations.filter(o => o.event === 'close').length, 1);
  assert.equal(f.observations.some(o => o.event === 'page_act'), false);
  f.reopen();
  assert.equal(f.latestAttempt(), 'Submitting');
  assert.equal(f.latestJob().status, 'Running');
  await assert.rejects(f.harness().dispatch(id), /not_dispatchable/);
  await f.recover();
  assert.equal(f.latestJob().status, 'Unknown');
});

test('failed durable mark prevents send and release and retains the crash lock', async t => {
  const f = await fixture(t, { failMarkWrite: true });
  await assert.rejects(f.harness().dispatch(id), /STORE_CLOSED_OR_POISONED/);
  chmodSync(f.root, 0o700);
  assert.equal(f.outcomes[0].kind, 'ambiguous');
  assert.equal(f.outcomes[0].reason, 'MARK_SUBMITTING_FAILED');
  assert.equal(f.outcomes[0].released, false);
  assert.equal(f.latestAttempt(), 'Reserved');
  assert.equal(f.latestJob().status, 'Running');
  assert.equal(f.observations.some(o => o.event === 'page_act'), false);
  assert.equal(existsSync(path.join(f.root, 'writer.lock')), true);
  assert.throws(() => openHarnessStore(f.root, schedule), /EEXIST/);
  f.abandon();
});

test('invalid or rejected session acquisition stays ambiguous and never sends', async t => {
  for (const [sessionFailure, closeError] of [
    ['missing close', 'SESSION_INVALID'],
    ['rejected acquisition', 'ACQUISITION_FAILED:fixture_acquisition_failure'],
  ]) {
    await t.test(sessionFailure, async t => {
      const f = await fixture(t, { sessionFailure });
      assert.equal((await f.harness().dispatch(id)).status, 'Unknown');
      assert.equal(f.outcomes[0].kind, 'ambiguous');
      assert.equal(f.outcomes[0].cleanup.closeError, closeError);
      assert.deepEqual(f.observations.map(o => o.event), ['plan', 'session']);
      assert.equal(f.latestAttempt(), 'Released');
    });
  }
});
