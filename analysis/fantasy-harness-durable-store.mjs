// Candidate-owned persistence for the PR60 ledger. No default runtime path,
// scheduler, browser, native admission, credential access, or force-unlock API.
import { openPhaseStore, phaseRevisionFits } from './fantasy-phase-store.mjs';
import { newLedger, recoverInterrupted, validateLedger } from './fantasy-harness-ledger.mjs';

const SCHEMA = 'fantasy-harness-store-v2';
const requireThat = (ok, code) => { if (!ok) throw new Error(code); };
const attemptKey = job => `${job.id}/${job.actionId}`;
const snapshot = (revision, ledger, attempts) => ({ schema: SCHEMA, revision, ledger, attempts });

function requireCompletionRoom(state, next) {
  const job = Object.values(next.jobs).find(j => j.status === 'Running' || j.status === 'Unknown');
  if (!job) return;
  const running = job.status === 'Running';
  const key = attemptKey(job);
  const attempt = state.attempts[key];
  const remainingAttempts = running && !attempt ? 2 : running && attempt === 'Reserved' ? 1 : 0;
  const attempts = remainingAttempts ? { ...state.attempts, [key]: 'Submitting' } : state.attempts;

  // Budget the next ledger write, remaining attempt transitions, an outcome
  // for Running, and a separate postflight. The largest record includes the
  // longer interruption reason and the terminal status and watermark.
  const completed = running ? recoverInterrupted(next) : structuredClone(next);
  completed.revision++;
  completed.jobs[job.id].status = 'Succeeded';
  completed.closedThrough = Math.max(completed.closedThrough, job.scheduledFor);
  const lastRevision = state.revision + 2 + Number(running) + remainingAttempts;
  requireThat(phaseRevisionFits(snapshot(lastRevision, completed, attempts)) &&
    (!running || phaseRevisionFits(snapshot(lastRevision, next, attempts))),
    running ? 'store_capacity_before_dispatch' : 'store_capacity_before_postflight');
}

export function openHarnessStore(root, { owner, scheduleFingerprint, initialize = false } = {}) {
  const empty = newLedger({ owner, scheduleFingerprint });
  const phase = openPhaseStore(root, { initialize });

  function envelope() {
    const state = phase.load();
    requireThat(state.schema === SCHEMA &&
      Object.keys(state).sort().join('|') === 'attempts|ledger|revision|schema' &&
      state.attempts && Object.getPrototypeOf(state.attempts) === Object.prototype, 'store_schema_invalid');
    const ledger = validateLedger(state.ledger);
    requireThat(ledger.owner === owner && ledger.scheduleFingerprint === scheduleFingerprint, 'store_binding_mismatch');
    let attemptRevisions = 0;
    for (const [key, status] of Object.entries(state.attempts)) {
      const job = ledger.jobs[key.split('/')[0]];
      requireThat(job?.attempts === 1 && key === attemptKey(job) &&
        ['Reserved', 'Submitting', 'Released'].includes(status), 'store_attempt_invalid');
      attemptRevisions += status === 'Reserved' ? 1 : 2;
    }
    requireThat(state.revision === ledger.revision + 1 + attemptRevisions, 'store_revision_mismatch');
    return { state, ledger };
  }

  try {
    if (initialize) requireThat(phase.compareAndSwap(0, snapshot(1, empty, {})), 'store_initialization_not_confirmed');
    envelope();
  } catch (error) {
    if (initialize) phase.abandon();
    else { try { phase.close(); } catch { phase.abandon(); } }
    throw error;
  }

  return Object.freeze({
    async load() { return envelope().ledger; },
    async compareAndSwap(revision, next) {
      const { state, ledger } = envelope();
      if (revision !== ledger.revision) return false;
      const checked = validateLedger(next);
      requireThat(checked.revision === revision + 1, 'ledger_revision_invalid');
      requireThat(checked.owner === owner && checked.scheduleFingerprint === scheduleFingerprint, 'store_binding_mismatch');
      for (const [id, old] of Object.entries(ledger.jobs)) {
        const job = checked.jobs[id];
        requireThat(job && job.actionId === old.actionId && job.scheduledFor === old.scheduledFor &&
          job.deadline === old.deadline && (old.attempts === 0 || job.attempts === old.attempts), 'ledger_history_changed');
        requireThat(!(old.attempts > 0 && job.status === 'Claimed'), 'same_id_retry_not_admitted');
        const attempt = state.attempts[attemptKey(old)];
        requireThat(job.status !== 'Failed' || job.reason !== 'confirmed_no_submission' ||
          !attempt || attempt === 'Released', 'no_submission_not_confirmed');
      }
      for (const job of Object.values(checked.jobs)) {
        const old = ledger.jobs[job.id];
        if (job.status === 'Running' && old?.status !== 'Running')
          requireThat(old?.status === 'Claimed' && old.attempts === 0 && job.attempts === 1, 'same_id_retry_not_admitted');
      }
      requireCompletionRoom(state, checked);
      return phase.compareAndSwap(state.revision, snapshot(state.revision + 1, checked, state.attempts));
    },

    attemptsFor({ deadline, occurrenceId, actionId }) {
      const key = `${occurrenceId}/${actionId}`;
      let reservedHere = false;
      function current() {
        const { state, ledger } = envelope();
        const job = ledger.jobs[occurrenceId];
        return { state, bound: job?.status === 'Running' && job.attempts === 1 &&
          job.actionId === actionId && job.deadline === deadline };
      }
      function transition(suppliedKey, from, to) {
        if (suppliedKey !== key) return false;
        try {
          const { state, bound } = current();
          if (!bound || state.attempts[key] !== from) return false;
          requireThat(phase.compareAndSwap(state.revision,
            snapshot(state.revision + 1, state.ledger, { ...state.attempts, [key]: to })), 'attempt_commit_not_confirmed');
          return true;
        } catch (error) {
          phase.abandon(); // An uncertain mark must not be followed by a release.
          throw error;
        }
      }
      return Object.freeze({
        reserve(suppliedKey) {
          if (!transition(suppliedKey, undefined, 'Reserved')) return false;
          reservedHere = true;
          return true;
        },
        markSubmitting: suppliedKey => reservedHere && transition(suppliedKey, 'Reserved', 'Submitting'),
        release: suppliedKey => reservedHere && transition(suppliedKey, 'Reserved', 'Released'),
        isSubmitting() {
          if (!reservedHere) return false;
          try {
            const { state, bound } = current();
            return bound && state.attempts[key] === 'Submitting';
          } catch (error) {
            phase.abandon();
            throw error;
          }
        },
      });
    },
    close() { phase.close(); },
    abandon() { phase.abandon(); }, // Retains uncertain/crash locks.
  });
}
