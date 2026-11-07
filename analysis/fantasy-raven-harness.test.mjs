import test from 'node:test';
import assert from 'node:assert/strict';
import { claim, newLedger } from './fantasy-harness-ledger.mjs';
import { createRavenHarness } from './fantasy-raven-harness.mjs';
import { TARGET } from './yahoo-fantasy-readonly.mjs';

test('dispatch uses the injected adapter and only independently verified, action-bound postflight closes Unknown', async () => {
  const owner = 'fixture-owner';
  const fingerprint = 'a'.repeat(64);
  const { season, leagueId: league, teamId: team } = TARGET;
  const intent = {
    season, league, team, week: 9,
    before: [{ id: '11', slot: 'BN' }], after: [{ id: '11', slot: 'QB' }],
  };
  let state = claim(newLedger({ owner, scheduleFingerprint: fingerprint }), {
    owner, fingerprint, scheduledFor: 100, deadline: 200, now: 110, intent,
  });
  const binding = { deadline: 200, occurrenceId: '100', actionId: state.jobs['100'].actionId };
  const attempts = Object.freeze({});
  const store = {
    attemptsFor(context) {
      assert.deepEqual(context, binding);
      assert.ok(Object.isFrozen(context));
      return attempts;
    },
    async load() { return state; },
    async compareAndSwap(revision, next) {
      assert.equal(revision, state.revision);
      state = next;
      return true;
    },
  };
  let time = 110;
  const clock = () => time;
  const calls = [];
  let receiptOccurrence = 'other';
  let verified = false;
  const harness = createRavenHarness({
    store, owner, clock, raven: {
      profileId: 'fixture', attempts: { reserve: assert.fail }, resolvePagePlan: assert.fail, openSession: assert.fail,
      readProposalEvidence: assert.fail, awaitOperatorGrant: assert.fail, readGrantEvidence: assert.fail, readStop: assert.fail,
    },
    createRavenSubmitAdapter(options) {
      assert.equal(options.profileId, 'fixture');
      assert.equal(options.clock, clock);
      assert.equal(options.attempts, attempts);
      return {
        async submit(submittedIntent, context) {
          calls.push('submit');
          assert.equal(state.jobs['100'].status, 'Running');
          assert.deepEqual(submittedIntent, intent);
          assert.deepEqual(context, binding);
          return { kind: 'raven_input_dispatched' };
        },
      };
    },
    async readPostflight(context) {
      calls.push('read');
      assert.deepEqual(context, binding);
      return {
        evidence: { source: 'independent_read', observedAt: time, season, league, team, week: 9, roster: intent.after, pendingClear: true },
        receipt: { occurrenceId: receiptOccurrence, actionId: binding.actionId },
      };
    },
    async verifyReceipt(receipt, context) {
      calls.push('verify');
      assert.deepEqual(context, binding);
      assert.equal(receipt.occurrenceId, binding.occurrenceId);
      return verified;
    },
  });

  await assert.rejects(harness.reconcile('100'), /postflight_not_expected/);
  assert.equal((await harness.dispatch('100')).status, 'Unknown');
  assert.deepEqual(calls, ['submit']);
  time = 120;
  await assert.rejects(harness.reconcile('100'), /postflight_receipt_unverified/);
  assert.deepEqual(calls, ['submit', 'read']);
  receiptOccurrence = '100';
  await assert.rejects(harness.reconcile('100'), /postflight_receipt_unverified/);
  assert.equal(state.jobs['100'].status, 'Unknown');
  verified = true;
  assert.equal((await harness.reconcile('100')).status, 'Succeeded');
  assert.equal(state.jobs['100'].status, 'Succeeded');
});

test('assembly requires independent postflight, an adapter factory, and store-owned attempts', () => {
  const createRavenSubmitAdapter = () => ({});
  const readers = { readPostflight: () => {}, verifyReceipt: () => {} };
  assert.throws(() => createRavenHarness({ createRavenSubmitAdapter }), /independent_postflight_required/);
  assert.throws(() => createRavenHarness(readers), /raven_submit_required/);
  assert.throws(() => createRavenHarness({ createRavenSubmitAdapter, ...readers }), /durable_attempts_required/);
});
