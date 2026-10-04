# In-season IDP weekly candidate and same-heartbeat insertion

This source candidate is not installed. The coordinator must review the exact source diff and
installation package before changing the existing `fantasy-daily-roster-and-waiver-review`
heartbeat. No new automation, Yahoo write or roster delegation is introduced here.

## Model contract

`refresh-weekly-projection.mjs --full` now uses `inseason-idp.mjs` for IDP rows only. Completed
weeks must be exactly 1 through target week minus one. A numeric Sleeper player row needs an
explicit `def_snp` and positive `tm_def_snp` to supply role evidence. Missing data is unknown;
explicit zero defensive snaps is a measured zero. GSIS identity collapses aliases. S and CB
normalize to DB, and DL/LB/DB can fill generic D. The latest snap share and recent trend drive
expected snaps. A pooled position tackle rate shrinks each player's rate by one observed
team-game of snaps; position pooled non-tackle event scoring is separate from individual splash.
The league scorer supplies exact category points. The role-change threshold (20 share points)
and one-game smoothing strength are transparent model choices, not calibrated weights. An
aggregate historical opponent IDP factor is omitted because it does not measure a defender's
position-specific tackle opportunity. If the latest week has no team defensive snap rows,
the latest measured role carries forward for one week with `HIGH` uncertainty and
`UNVERIFIED_NO_TEAM_SNAP_ROWS`; this can be a bye or a source gap. A missing player row when
the team has snap rows leaves the role unknown. A starter with uncertain continuity makes the
planning comparison `HOLD` pending review of completed-week coverage.
An add with this flag is excluded from streaming proposals until that coverage is verified.
The JSON
contains components, sample snaps/games, role change and uncertainty. No calibrated outcome
interval or predictive-lift claim exists.

## Planning input and execution

Monday's successful full refresh is the single refresh for its target week. Tuesday planning
reads that same saved `weekN-full-rankings.json`. The coordinator supplies a fresh, verified
Yahoo IDP-only snapshot, then runs the same script in planning mode without fetching or
rebuilding the full report:

```sh
node analysis/refresh-weekly-projection.mjs --plan-idp \
  --rankings=/path/to/monday/weekN-full-rankings.json \
  --idp-snapshot=/path/to/verified-tuesday-idp-snapshot.json \
  --out=/path/to/tuesday-planning
```

The snapshot is a small local JSON input with `season` (integer), `week` (integer),
`leagueId:"420010"`, `teamId:"7"`, `source:"YAHOO_VERIFIED_READBACK"`, ISO
`capturedAt` and future `expiresAt`, `slots:["D","DB","LB"]`, `roster` and `available`.
Each roster IDP has exact numeric-string `yahooId`, current `slot` (`D`, `DB`, `LB`, or `BN`),
Yahoo `eligible` positions, and verified boolean `droppable` and `locked`. Each candidate has
exact `yahooId`, Yahoo `eligible` positions, and verified `availability:"FA"` or `"W"`.
Each candidate also carries verified boolean `locked` and raw `injuryStatus` (string or null);
locked or confirmed inactive candidates are excluded, while uncertain injury flags are shown.
Yahoo O, PUP-R/PUP-P, NFI-R/NFI-A and SUSP markers are normalized to their inactive
equivalents. Unknown non-empty status markers fail closed. Locked, confirmed-inactive,
unknown-status and expired-waiver exclusions have separate reasons; Q/D remain disclosed
uncertain designations, not healthy clearance.
For `W`, provide `conditionalExpiresAt` as an ISO time after the snapshot; it bounds the
FA-after-release proposal. W is never treated as FA at planning time. Candidates with no
joinable Yahoo ID are listed as excluded; roster join failures still return `HOLD`.
The collector must verify league/team, ownership, availability, eligibility and locks before
writing the snapshot; do not copy an FA label from the model universe or browser state. Its
expiry must reflect that collector's actual freshness policy. Unknown or duplicate identities,
expired/wrong-period input, an unknown starting IDP role, incomplete lineup and absent legal
edge return `HOLD`.

The planner jointly fills D/DB/LB, respects locked starters, and compares each exact legal
drop, including legal bench drops, plus a verified available add to the current lineup. It
requires a positive lineup gain plus more expected snaps and tackle points than the starter
actually displaced, except for a confirmed unavailable starter. High-uncertainty role risers
remain eligible for review when that evidence gate passes; their uncertainty is shown with the
gain. Held and unjoinable candidates are listed. The output includes ranked exact IDs, lineup
before/after, gain, components, snapshot expiry and `approvalRequired:true`; these are
uncalibrated review proposals, not approved transactions. The output explicitly says next-week
coverage is unavailable when no separately verified next-week schedule was supplied. The
target-week schedule from Monday's refresh governs target-week byes; never infer later byes
from the preseason board.

## Candidate block for the existing heartbeat

> **Monday 22:00 readiness:** After the next target week is known, run the existing full refresh
> once, including the new IDP model. Record its successful report path, source receipts,
> completed-week cutoff, schedule period and target week. Reuse that exact report at Tuesday
> planning and game checks; no full rerun at each check.
>
> **Tuesday 08:00 planning:** Alongside offense and DEF review, obtain one current Yahoo IDP
> readback for league 420010/team 7 with exact roster/FA/W IDs, eligibility, drop legality and
> lineup locks. Run `--plan-idp` against Monday's saved report. If it returns `HOLD`, show the
> reason and ask for no IDP transaction. Otherwise present the ranked exact add/drop/fallback
> packages, role/tackle/event evidence, uncertainty, Week N value, snapshot expiry and explicit
> approval question. A W package is conditional on verified FA availability after waiver release,
> bounded by `conditionalExpiresAt`, and is never executable at Tuesday planning. Treat
> next-week/bye benefit as unavailable unless a verified schedule for
> that week is separately supplied. Do not state or imply a current FA from model ranking alone.
>
> **Approved release event:** Place any specifically approved IDP legs alongside approved
> offense/DEF legs in their explicit package order. Reconcile the live lineup, locks, drop
> legality and Yahoo availability in the existing 15-second bounded availability loop; retain
> current single-flight and receipt rules. FA-only approval never becomes a priority-spending
> waiver claim. No fresh or standing transaction authority comes from this model.
>
> **Pregame overlays:** Use the existing official availability and kickoff/lock checks for
> already approved lineup changes. No new polling event or independent service.

The coordinator owns source review, draft PR, install comparison against the dirty installed
checkout, automation edit, rollback, next-run verification and approval bookkeeping. The
cached Week 4 candidate under the task parent is engineering evidence only; it cannot prove
runtime installation, current Yahoo FA status or a successful weekly decision.
Before installation, confirm the existing heartbeat uses `--full`: the legacy non-full CLI
now fails closed when its roster input includes IDPs, since it lacks the completed-week
defensive snap and identity inputs required by this model.
