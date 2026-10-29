// Source-only harness seam. No scheduler, credentials, model calls or Yahoo transport.
import { createHash } from 'node:crypto';
import { TARGET } from './yahoo-fantasy-readonly.mjs';

const copy = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requireThat = (ok, code) => { if (!ok) throw new Error(code); };
const integer = n => Number.isSafeInteger(n) && n >= 0;
const exactKeys = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).sort().join('|') === [...keys].sort().join('|');
function roster(rows) {
  requireThat(Array.isArray(rows) && rows.length > 0 && rows.length <= 100, 'invalid_roster');
  const result = rows.map(r => {
    requireThat(exactKeys(r, ['id', 'slot']) && /^[1-9][0-9]*$/.test(r.id) &&
      typeof r.id === 'string' && typeof r.slot === 'string' && /^[A-Z][A-Z0-9/]{0,15}$/.test(r.slot), 'invalid_player');
    return { id: r.id, slot: r.slot };
  }).sort((a,b) => a.id.localeCompare(b.id));
  requireThat(new Set(result.map(r => r.id)).size === result.length, 'duplicate_player');
  return result;
}
function normalizeIntent(intent) {
  requireThat(exactKeys(intent, ['season','league','team','week','before','after']), 'invalid_intent');
  requireThat(intent.season === TARGET.season && intent.league === TARGET.leagueId && intent.team === TARGET.teamId &&
    Number.isInteger(intent.week) && intent.week >= 1 && intent.week <= 18, 'wrong_target');
  const normalized = { season: intent.season, league: intent.league, team: intent.team,
    week: intent.week, before: roster(intent.before), after: roster(intent.after) };
  requireThat(hash(normalized.before) !== hash(normalized.after), 'no_change');
  return normalized;
}
export function newLedger({ owner, scheduleFingerprint }) {
  requireThat(typeof owner === 'string' && owner.length > 0 && owner.length <= 128 &&
    /^[a-f0-9]{64}$/.test(scheduleFingerprint), 'invalid_configuration');
  return { schema: 1, revision: 0, owner, scheduleFingerprint, closedThrough: -1, jobs: {}, actions: {} };
}
export function scheduleFingerprint({ schedule, timezone }) {
  requireThat(typeof schedule === 'string' && schedule.length > 0 && typeof timezone === 'string' && timezone.length > 0,
    'invalid_schedule');
  // Hash exact authoritative values. Do not infer, normalize, or invent the old schedule.
  return hash({ schedule, timezone });
}
function checked(state) {
  requireThat(exactKeys(state, ['schema','revision','owner','scheduleFingerprint','closedThrough','jobs','actions']), 'invalid_ledger');
  requireThat(state?.schema === 1 && integer(state.revision) && Number.isSafeInteger(state.closedThrough) &&
    state.closedThrough >= -1 && state.jobs && state.actions &&
    !Array.isArray(state.jobs) && !Array.isArray(state.actions) &&
    typeof state.owner === 'string' && state.owner.length > 0 && /^[a-f0-9]{64}$/.test(state.scheduleFingerprint), 'invalid_ledger');
  requireThat(Object.keys(state.jobs).length <= 1024, 'ledger_capacity');
  for (const [id,j] of Object.entries(state.jobs)) {
    requireThat(id === String(j.scheduledFor) && j.id === id && integer(j.scheduledFor) &&
      integer(j.deadline) && j.deadline > j.scheduledFor &&
      ['Claimed','Running','Unknown','Succeeded','Failed'].includes(j.status) &&
      integer(j.attempts) && j.attempts <= 2 &&
      (j.attempts === 0 ? j.status === 'Claimed' || (j.status === 'Failed' && j.reason === 'expired_without_dispatch') :
        integer(j.startedAt) && j.startedAt >= j.scheduledFor && j.startedAt < j.deadline) &&
      hash(normalizeIntent(j.intent)) === j.actionId && state.actions[j.actionId] === id, 'invalid_job');
  }
  requireThat(Object.keys(state.actions).length === Object.keys(state.jobs).length, 'invalid_action_index');
  requireThat(Object.values(state.jobs).filter(j => ['Claimed','Running','Unknown'].includes(j.status)).length <= 1, 'multiple_active_jobs');
}
function owned(state, owner) { checked(state); requireThat(owner === state.owner, 'owner_mismatch'); }
function changed(state) { const next = copy(state); next.revision++; return next; }
function job(state, id) { const j = state.jobs[id]; requireThat(j, 'unknown_occurrence'); return j; }
function terminal(state, j, status) {
  j.status = status;
  state.closedThrough = Math.max(state.closedThrough, j.scheduledFor);
}
export function claim(state, { owner, fingerprint, scheduledFor, deadline, now, intent }) {
  owned(state, owner);
  requireThat(fingerprint === state.scheduleFingerprint, 'schedule_drift');
  requireThat([scheduledFor, deadline, now].every(integer) && scheduledFor <= now && now < deadline &&
    deadline > scheduledFor, 'outside_window');
  const id = String(scheduledFor), normalized = normalizeIntent(intent), actionId = hash(normalized);
  requireThat(!Object.hasOwn(state.jobs, id) && scheduledFor > state.closedThrough, 'duplicate_or_stale_occurrence');
  requireThat(!Object.values(state.jobs).some(j => ['Claimed','Running','Unknown'].includes(j.status)), 'unresolved_occurrence');
  requireThat(!Object.hasOwn(state.actions, actionId), 'duplicate_action');
  requireThat(Object.keys(state.jobs).length < 1024, 'ledger_capacity');
  const next = changed(state);
  next.jobs[id] = { id, scheduledFor, deadline, actionId, intent: normalized, status: 'Claimed', attempts: 0 };
  next.actions[actionId] = id;
  return next;
}
export function begin(state, { owner, id, now }) {
  owned(state, owner); const current = job(state,id);
  requireThat(current.status === 'Claimed' && integer(now) && now >= current.scheduledFor && now < current.deadline, 'not_dispatchable');
  const next = changed(state); next.jobs[id].status = 'Running'; next.jobs[id].attempts++; next.jobs[id].startedAt = now;
  return next;
}
export function finish(state, { owner, id, outcome }) {
  owned(state,owner); requireThat(job(state,id).status === 'Running', 'not_running');
  const next = changed(state), j = next.jobs[id];
  // Only a trusted adapter's pre-submit rejection may prove no effect. Transport errors,
  // timeouts, exit codes, and absence from the limited transaction list cannot.
  if (outcome?.kind === 'no_effect' && outcome?.stage === 'before_submit' && outcome?.submissionStarted === false) {
    terminal(next,j,'Failed'); j.reason = 'confirmed_no_submission';
  } else {
    j.status = 'Unknown'; j.reason = 'postflight_required';
  }
  return next;
}
export function retryConfirmedNoEffect(state, { owner, id, now }) {
  owned(state,owner); const j = job(state,id);
  requireThat(j.status === 'Failed' && j.reason === 'confirmed_no_submission' && j.attempts === 1 &&
    integer(now) && now >= j.scheduledFor && now < j.deadline &&
    !Object.values(state.jobs).some(other => other.id !== id && other.scheduledFor > j.scheduledFor), 'retry_forbidden');
  const next = changed(state); next.jobs[id].status = 'Claimed'; return next;
}
export function recoverInterrupted(state) {
  checked(state); const next = changed(state);
  for (const j of Object.values(next.jobs)) if (j.status === 'Running') {
    j.status = 'Unknown'; j.reason = 'interrupted_after_dispatch_boundary';
  }
  return next;
}
export function postflight(state, { owner, id, evidence, now, maxAgeMs = 60000 }) {
  owned(state,owner); const current = job(state,id);
  requireThat(current.status === 'Unknown', 'postflight_not_expected');
  // Completion requires a separate reader, exact unchanged unrelated players, and explicit
  // transaction/browser confirmation. A read error or mismatch leaves Unknown untouched.
  requireThat(exactKeys(evidence, ['source','observedAt','season','league','team','week','roster','pendingClear','receiptConfirmed']) &&
    evidence.source === 'independent_read' && integer(evidence.observedAt) && integer(now) && integer(maxAgeMs) && maxAgeMs <= 60000 &&
    evidence.observedAt >= current.startedAt && evidence.observedAt <= now && now - evidence.observedAt <= maxAgeMs &&
    evidence.season === current.intent.season && evidence.league === current.intent.league &&
    evidence.team === current.intent.team && evidence.week === current.intent.week &&
    evidence.pendingClear === true && evidence.receiptConfirmed === true &&
    hash(roster(evidence.roster)) === hash(current.intent.after), 'postflight_unproven');
  const next = changed(state); terminal(next,next.jobs[id],'Succeeded'); return next;
}
export function expireClaimed(state, { owner, id, now }) {
  owned(state,owner); const j = job(state,id);
  requireThat(j.status === 'Claimed' && integer(now) && now >= j.deadline, 'not_expired_claim');
  const next = changed(state); terminal(next,next.jobs[id],'Failed');
  next.jobs[id].reason = 'expired_without_dispatch'; return next;
}
export function handoffReadiness(state, { owner, fingerprint, oldOwnerQuiescent, nextScheduledFor, now }) {
  owned(state,owner);
  const blockers = [];
  if (fingerprint !== state.scheduleFingerprint) blockers.push('schedule_drift');
  if (oldOwnerQuiescent !== true) blockers.push('old_owner_not_proven_quiescent');
  if (Object.values(state.jobs).some(j => ['Claimed','Running','Unknown'].includes(j.status))) blockers.push('unresolved_occurrence');
  if (![nextScheduledFor,now].every(integer) || nextScheduledFor <= now || nextScheduledFor <= state.closedThrough)
    blockers.push('next_slot_not_future');
  return { ready: blockers.length === 0, blockers, changesSchedule: false, activatesOwner: false };
}

// Store contract: load validates durable state; compareAndSwap must atomically commit and
// durably acknowledge an expected revision under the ONE canonical writer's ownership fence.
// No production store/adapter is supplied, so importing this file cannot perform live work.
export async function dispatchClaimed({ store, adapter, owner, id, clock = Date.now }) {
  const before = await store.load();
  const now = clock();
  const running = begin(before,{ owner,id,now });
  requireThat(await store.compareAndSwap(before.revision,running) === true, 'commit_not_confirmed');
  let outcome;
  try {
    const dispatchAt = clock();
    if (!integer(dispatchAt) || dispatchAt < now || dispatchAt >= running.jobs[id].deadline)
      outcome = { kind: 'no_effect', stage: 'before_submit', submissionStarted: false };
    else outcome = await adapter.submit(copy(running.jobs[id].intent), {
      deadline: running.jobs[id].deadline, occurrenceId: id, actionId: running.jobs[id].actionId,
    });
  }
  catch { outcome = { kind: 'ambiguous' }; }
  const after = finish(running,{ owner,id,outcome });
  requireThat(await store.compareAndSwap(running.revision,after) === true, 'completion_commit_not_confirmed');
  return copy(after.jobs[id]);
}
