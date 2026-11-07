# Raven dispatch integration — source candidate

This increment connects the PR60 ledger contract to an injected Raven adapter
factory. It does not start a runner or native session, supply operator grants,
change the existing owner or scheduler, or install anything in the active runtime.

The integration uses the existing `dispatchClaimed` transition: an atomic,
read-back `Running` record precedes the adapter call. A dispatched input remains
`Unknown` until a separate reader supplies fresh exact full-roster evidence and
an action/occurrence-bound receipt. A browser input acknowledgement is not a
verified website transaction. Replayed or unresolved jobs cannot submit again.

The repository fixtures use synthetic player identities and injected providers.
The separate integration fixture requires an explicit path to the reviewed Raven
artifact and checks its pinned hash before import. It uses an in-memory fake
session, never the installed Raven executable or a browser. These checks prove
source compatibility and ledger behavior only; ordinary repository CI does not
have that external artifact and does not run the separate integration fixture.

## Remaining production prerequisites

- A fixed, admitted owner bootstrap with current canonical approval, preflight,
  Stop and unchanged schedule binding; importing this module is not activation.
- Trusted page planning, full proposal and grant evidence readers, operator
  authorization, and the existing registered native transport. The reviewed
  adapter binds proposal URL to observed URL; this alone does not establish that
  navigation reached the intended target from `plan.url`.
- Durable Raven reservation/mark/release under the same writer fence. These
  callbacks must not advance the main ledger revision during `submit`, because
  `dispatchClaimed` commits its outcome against that revision. The fixture's
  in-memory marks are not a production attempt journal.
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
