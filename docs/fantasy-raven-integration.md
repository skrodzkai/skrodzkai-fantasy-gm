# Raven dispatch integration — source candidate

This increment connects the PR60 ledger contract to an injected Raven adapter
factory. It does not start a runner or native session, supply operator grants,
change the existing owner or scheduler, or install anything in the active runtime.

The integration uses the existing `dispatchClaimed` transition: an atomic,
read-back `Running` record precedes the adapter call. A dispatched input remains
`Unknown` until a separate reader supplies fresh exact full-roster evidence and
an action/occurrence-bound receipt. A browser input acknowledgement is not a
verified website transaction. Replayed or unresolved jobs cannot submit again.

The candidate opens a private v2 harness envelope in the existing hash-linked
phase journal. Ledger CAS compares the ledger revision and carries forward the
latest attempt map. Reserving, marking, and releasing advance only the journal
revision. Each attempt matches the exact Running occurrence, action, and
deadline. Only the dispatch that reserved it can mark or release it, and a
Released entry stays in the journal. A clean reopen preserves all attempt
states and never resumes them. An uncertain mark retains the writer lock and
prevents both send and a confirmed no-submission result.

The store checks the revision limit and serialized byte limit before committing
Running. It budgets five writes for Running, Reserved, Submitting or Released,
the outcome, and independent postflight. The byte projection covers the
Submitting entry, the interruption reason, and the terminal status and
watermark. Physical disk failure can still require supervised reconciliation.
Opening the predecessor v1 envelope fails explicitly. This candidate provides
no data migration.

Each dispatch captures its own page plan. The owner seam accepts a parseable
absolute HTTPS URL and compares the observed URL to the captured string exactly,
including path, query, and fragment. Any differing redirect or normalization
fails before proposal or grant. The owner snapshots observation, proposal,
and grant evidence across awaits. The frozen Raven adapter still owns session
cleanup and validates the full proposal and grant binding. Before forwarding
`page_act`, the owner checks the durable Submitting entry under the same
writer fence and rechecks the original deadline.

The repository fixtures use synthetic player identities and injected providers.
The separate integration fixture requires an explicit path to the reviewed Raven
artifact and checks its pinned hash before import. It uses an in-memory fake
session, never the installed Raven executable or a browser. These checks prove
source compatibility and ledger behavior only; ordinary repository CI does not
have that external artifact and does not run the separate integration fixture.

## Remaining production prerequisites

- A fixed, admitted owner bootstrap with current canonical approval, preflight,
  Stop and unchanged schedule binding; importing this module is not activation.
- Trusted production page planning, full proposal and grant evidence readers,
  operator authorization, and the existing registered native transport.
- An admitted private v2 journal and a supervised reconciliation decision for
  any predecessor data.
- Independent GET-only target/full-roster/pending-clear evidence and a receipt
  verifier bound to the exact action and occurrence, rather than a transport's
  self-reported success.
- Separately authorized adoption and single-owner cutover after incumbent
  quiescence, unresolved-work reconciliation and a verified future schedule slot.

The private filesystem store fences cooperating writers of its directory only.
It provides no global owner election, automatic crash-lock reclamation, live
retry authority, or guarantee against disk failure or same-user tampering.
Existing failed and consumed decision IDs remain terminal. This candidate does
not extend any native test scope or create a new recovery budget.

Rollback is a source revert before adoption. No Yahoo action is performed by
these fixtures, so there is no roster rollback operation.

## Focused checks

Run the repository checks with:

```sh
node --test analysis/fantasy-harness-ledger.test.mjs analysis/fantasy-harness-durable-store.test.mjs analysis/fantasy-raven-harness.test.mjs
```

For the separately supplied reviewed artifact, set `LAMAR_RAVEN_ADAPTER_PATH`
to that exact file and explicitly run:

```sh
node --test analysis/fantasy-raven-harness.integration.mjs
```

The pinned adapter SHA256 is
`a66004c565a6d493cc1dd72be612b466fa51e93a97348887765132bede35a898`.
Missing or different bytes fail the integration fixture; they are not silently
substituted or treated as a passing skipped check.
