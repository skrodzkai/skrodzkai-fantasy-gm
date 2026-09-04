# Astra draft audit — 2026-09-04

Scope: source repair candidate v0.16.2, based on deployed v0.16.1 at
`b03c3232092a30cdb320928fa9ad8ab0523f9678`. This is not a deployment or live-draft PASS.
Real league 420010 remains execution-disabled. No Yahoo picks or season transactions
were made during this source audit.

## Reproduced defects and repairs

- **Inconsistent next-pick value.** Current picks included bounded bench opportunity
  value and backup-QB/TE discounts, but the one-turn lookahead used undiscounted
  lineup deltas. Both turns now use the same marginal-value calculation. Next-turn
  alternatives obey next-round specialist eligibility, roster completion, position
  limits, and distinct player identity. The six-candidate approximation remains;
  this is not a season-long optimal-policy solver.
- **Fragile lease timing.** The content script expired ownership after one second,
  versus the background's three seconds. Ownership now lasts at most 2.5 seconds
  from the acknowledged message's send time, leaving 500 ms before background
  expiry. A delayed acknowledgement cannot resurrect an expired lease.
- **Performance target mistaken for a safety deadline.** The unchanged deployed
  scorer itself exceeded its old 250 ms abort threshold in a local bundled-board
  run (364 ms). Candidate runs also showed intermittent pauses. Keep 250 ms as a
  reported performance target, use a 1,000 ms computation ceiling and 1,200 ms
  panel ceiling, and shorten the optional selection hold to reserve 250 ms inside
  the unchanged 2,000 ms turn-to-click deadline. The UI reports the actual hold
  deadline. No retry or alternative decision model is added. The five-second
  detection clock margin and two-second pre-click clock margin are unchanged.
- **Intent/readback grading.** An intentional on-clock pick outside the original
  five-target ladder was incorrectly rejected. It now requires one same-run,
  same-turn choice receipt, an unchanged baseline, and choice-before-click timing.
  Conversely, selecting a different baseline target without a matching intentional
  override is now rejected as unintended selection. Fable caught a follow-up
  receipt-shape mistake: the runner emits a string turn, not an object with a
  label. The grader now joins the actual string contract and rejects impossible
  coexistence of an applied pre-staged pin and an on-clock choice on one turn.
- **Team-defense display names.** Final roster readback can join a mascot-only
  draft name to the full city/team name only for a DEF roster slot, a DEF pick,
  a Yahoo NFL team link, a whole-word suffix, and a unique match. Player identities
  are not fuzzy matched. Parser failures visibly lock the final roster panel.
- **Incomplete integration proof.** The existing offline runner replay replaced
  the click controller. A new synthetic-DOM test drives all 19 TEST turns through
  the production page readers, runner, actual click controller, and exact roster-ID
  confirmation, including immediate adjacent snake turns and an outside-baseline
  on-clock override. The actual runner/controller receipts go untouched into the
  acceptance grader; only the final roster/attestation envelope is fabricated.
  This reproduced the receipt-shape failure before the correction and passes
  afterward. Wrong-shaped or missing choice receipts still fail. It does not
  claim to reproduce Yahoo rendering, Chrome timers, or a live draft.
- **Version drift risk.** A test now checks manifest, content script, shadow script,
  and acceptance-grader version agreement. Version-only fixtures move together.

The changes reuse the existing files and contracts: no dependency, service,
storage schema, provider spend, fallback, or new execution permission. Feasibility
caching is local to one decision and caches roster geometry, never player scores.

Local verification: `npm run test:draft` passed **284/284** on this candidate;
`git diff --check` passed. Fable review, CI, deployment, current-data refresh, and
live Yahoo acceptance are separate gates, not implied by this result.

## What the ranking package actually establishes

The inspected morning package was generated at 08:27 Pacific; its Yahoo inputs
were captured around 08:19. These are timestamps, not a claim of a completed noon
refresh. Free-source offense includes Yahoo, CBS, Razzball and ESPN projections
rescored under the real league's rules. QB scoring premium, weekly bye availability,
and held-out-cleared opponent-position pressure are already represented.

Important limitations:

- Injury coverage means a status field exists for every covered player. It does
  not mean each injury has an official team-report adjudication. This package had
  zero official team injury reports; several elite questionable players were
  manual-only. Do not clear them automatically or equate a Q tag with season-out.
- The inspected IDP calibration gate was unavailable/diagnostic-only. Tackle-model
  ordering was not active. Raw multi-source consensus is not evidence that this
  system has outperformed Yahoo's IDP rankings.
- The sportsbook overlay had zero usable lines. Gambling-market projections were
  not influencing picks. No subscription is needed or authorized.
- Source consensus/spread is not a calibrated outcome distribution. The opponent
  position model showed a modest held-out gain; it is not a certain prediction of
  another manager's next pick, and TEST seats are not real-manager identities.

## Mandatory live gates — still not proven by local tests

1. Reconfirm the TEST settings in the same Chrome session: league 542830, Yahoo
   team 3, 19 rounds, one-minute picks, half-PPR, four-point passing TD, and **two D**
   slots. Yahoo settings were observed on September 4 to show today's 15:30 PDT
   draft. The three-D automation wording was corrected; the source already had two.
2. Refresh current inputs before claiming the noon package complete. Obtain the
   exact reviewed/merged/deployed source and fresh runtime attestation; local green
   tests do not establish that Chrome loaded it.
3. When the snake slot is published, use settings → draft overview → arm → enter
   the room from that same tab. Team URL 3 is not the snake slot. Do not rely on
   sessionStorage transferring into an independently opened draft tab.
4. Keep the runner tab selected and visible in its Chrome window; a separate
   command-center window is fine. Mute Yahoo audio. Require empty roster, Autodraft
   off, empty queue, current lease, exact clock/title/banner readers, and all six
   specialist filter labels before arming.
5. **Unresolved live-pool gate:** the runner ranks available visible Draft rows
   under All Positions. The preserved old postmortem does not prove that this view
   exposes the late-round K/DEF/IDP candidates. Inspect actual live DOM counts and
   exact IDs, including specialist rows. Do not treat a synthetic full-pool fixture
   as proof or silently switch strategy to an unreviewed filter/scroller fallback.
   If the pool is incomplete, do not arm; retain a sanitized capture for the fix.
6. Test a valid exact-ID next-pick pin and, after a confirmed pick, a rejected pin
   for an already-drafted player on separate off-turn intervals. Never stage a pin
   while an owned-turn banner exists. The invalid pin must retain the baseline and
   leave a rejection receipt. On-clock choices must match click receipts.
7. Export the untouched extension JSON, obtain final Yahoo roster readback, and run
   the strict acceptance grader with both manual-override requirements. A local
   replay is not a clean Yahoo draft. Owner rescue, Autodraft, runtime fallback,
   wrong selection, missing receipt, or any unknown live gate is not PASS.

The browser automation bridge timed out during this audit while native Chrome
controls remained usable. This is a separate operational limitation; it neither
proves nor disproves the installed draft extension. It requires a fresh browser
probe before the 15:00 preflight. Do not replace that proof with an assurance.
