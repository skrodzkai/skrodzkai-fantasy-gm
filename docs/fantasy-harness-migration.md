# Fantasy harness migration — source-only ledger seam

This candidate moves implementation forward without replacing the existing custom
weekly strategy, installing an agent, changing any schedule, or performing Yahoo
work. It introduces a tested domain ledger and an injected dispatch seam. It is
NOT a working unattended deployment or a replacement owner yet.

## Existing architecture and intended integration

Integrate with an existing agent harness through an explicitly admitted inference
route and a fixed Fantasy wake adapter. Do not replace the custom weekly strategy.
Scheduler delivery is a trigger, not proof of a successful roster operation. A
future runner must consult the domain ledger on every entry path, including manual
invocations; redelivered triggers must not cause a second submission. Process exit
status and elapsed time are never proof of the absence of a roster effect.

This JavaScript seam belongs with the existing Fantasy operation modules. It does
not alter a harness registry or claim that a production runner is already admitted.
The durable-store and adapter interfaces are generic implementation contracts, not
copied private runtime code. No host paths, account credentials, private repository
names, live schedules or private operational evidence are included.

Use the existing `yahoo-fantasy-operations.mjs` GET-only connector for reads and
independent reconciliation. Mutations retain the permitted browser path (Chrome
preferred, Safari backup). No transport fallback after an ambiguous submission.
No live API access, OAuth scope, browser session, credential or standing authority
is asserted by this source. PR #58's release-browser repair remains a separate
adoption decision; this patch neither imports nor installs that candidate.

## Contract

- Exact observed schedule and timezone are fingerprinted, not inferred. Occurrence
  identity is its scheduled UTC millisecond slot; early/expired wakes are rejected.
- Owner identity is fixed in the ledger. Production fencing must establish ONE
  canonical writer across manual and scheduled entry points before this is wired.
- Intent is a validated exact before/after roster for the existing fixed
  target and current week. Canonical hashing blocks repeated actions across wakes.
  Identity ordering cannot evade dedup. Strategy is an upstream input, unchanged.
- `Claimed -> Running` must durably commit by atomic compare-and-swap before the
  dispatch adapter is called. Refused/uncertain persistence never issues an effect.
  A fresh injected-clock check after commit rejects expiry or a backward clock.
  The adapter receives the unchanged deadline/action/occurrence binding and must
  recheck that deadline at its final browser submission boundary, not just entry.
- Every submitted or uncertain outcome becomes `Unknown` until independent
  postflight. Restart changes interrupted `Running` to `Unknown`, never pending.
  Unknown blocks subsequent occurrences; an exit code or old transaction is not
  reconciliation. This candidate deliberately has no Unknown-to-retry operation.
- A trusted adapter may return `{kind:'no_effect',stage:'before_submit',
  submissionStarted:false}` ONLY if it can positively prove it never began a final
  submission. That is the sole retryable result, once, within the original window
  and before a later occurrence. Timeouts/absence of a receipt are never proof.
- Postflight requires an independent read after dispatch, at most 60 seconds old,
  exact target/week and full resulting roster, no pending claims, and a separately
  confirmed receipt. Mismatch remains Unknown. The trusted adapter must bind the
  receipt to this action and independently establish freshness/target membership;
  booleans here are typed evidence inputs, not a Yahoo receipt verifier.
- Expired unsubmitted claims may close without dispatch. Closed-through slots
  reject replay; no automatic catch-up. History is bounded at 1,024 occurrences and
  fails closed at capacity; no unsafe compaction removes action dedup evidence.
- Handoff evaluation is pure: exact schedule match, old owner proven quiescent,
  no unresolved work and a future next slot. It neither disables the old automation
  nor activates the harness. It is readiness evidence, not cutover authorization.

## Production work deliberately still missing

1. Durable store adapter: validate integrity on load; atomic expected-revision CAS;
   durable fsync/commit acknowledgement; global writer fencing; no in-memory-only
   or expired-lock takeover. Test real restart, disk-full and torn-write behavior.
2. Fixed Fantasy runner in the existing harness, including current strategy inputs,
   fresh API preflight, lock/eligibility/standing-scope enforcement, browser adapter
   and independent bound receipt/postflight adapter. The `submit` callback in these
   tests is a fixture ONLY. Never connect a generic command supplied by a model.
3. Observed schedule/timezone and installed-version receipts; source tests cannot
   establish the currently installed runtime. No invented schedule is shipped.
4. Read-only shadow verification, then separately authorized single-owner cutover
   with old work drained/reconciled. Keep the current schedule until that boundary.
5. Restore prior owner only after stopping and reconciling the new owner. Source
   rollback is reverting this patch; it cannot undo a Yahoo roster transaction.

Ordinary strategy and proven pre-submit recovery should run within the user's
standing authorized scope without repeated conversational approvals. Authentication,
permission denials, new scopes, legally required gates and unresolved effects do not
become bypassable. No gambling, financial execution or security changes are added.

## Verification

`node --test analysis/fantasy-harness-ledger.test.mjs` exercises synthetic fixtures
only, including concurrent delivery, persistence loss, recovery, freshness and
handoff checks. Existing `npm run test:draft` automatically includes this test.
No dependency or CI workflow change is needed. Neither suite is live acceptance.
