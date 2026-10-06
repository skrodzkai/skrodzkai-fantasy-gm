# In-season IDP weekly candidate and same-heartbeat insertion

This source candidate is not installed. The coordinator must review the exact source diff and
installation package before changing the existing `fantasy-daily-roster-and-waiver-review`
heartbeat. No new automation, Yahoo write or roster delegation is introduced here.

## Model contract

`refresh-weekly-projection.mjs --full` uses `inseason-idp.mjs` for IDP rows. Completed
weeks must be exactly 1 through the upcoming target week minus one. The same actuals cutoff and
current measured role are reused for two subsequent forecasts, capped at week 18; no future
actuals are fetched or invented. A numeric Sleeper player row needs an
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

## Approved multiweek source candidate (October 5, 2026)

This package is source only. Existing Monday 22:00 readiness, Tuesday 08:00 planning and the
approved release-event workflow are the proposed integration points. No installation,
automation edit, Yahoo submission or transaction approval occurs through these CLIs.

Monday refresh:

```sh
node analysis/refresh-weekly-projection.mjs --full --season=2026 --target-week=5 \
  --board=/path/to/custom-prior-board.json --out=/path/to/monday-week5 \
  --prior-forecast=/path/to/earlier/week4-multiweek-rankings.json
```

`--full` stamps actual report generation after acquisition; `--generated-at` is rejected.
The completed cutoff is weeks 1–4 here, with separately verified week 5/6/7 schedules. It
writes each `weekN-full-rankings.json` and HTML plus `week5-multiweek-rankings.json`. Week 18
ends the horizon. Offense algorithms remain unchanged. IDP role is estimated at the cutoff
and carried across the horizon with current injury designations. Recovery, future injury
changes and calibrated intervals are unknown and labeled. Yahoo numbers apply only to the
original target week, never copied to later weeks.

Offline replay supplies `--sleeper-week1=...` through cutoff, `--players=...`, and
`--schedule-week1=...` through the final horizon week (`--schedule=...` also denotes the first
target-week schedule). Each capture needs a matching `.receipt.json` with `sourceId`,
`season`, `week` (null for `sleeper-players`), true `retrievedAt` and content SHA-256. Schedule
events must match season/type 2/week. Completed historical schedules must positively indicate
every parsed game is final. Duplicate team games are rejected. Future schedules supply opponent
and kickoff only. Absent teams in incomplete ESPN captures stay `UNKNOWN`; no inferred byes.

Independently verified byes use `--byes-week5=/path/to/verified-byes.json` (and matching options
for other horizon weeks). The bounded input has `source:"NFL_OFFICIAL_VERIFIED_READBACK"`,
`verified:true`, integer `season`/`week`, unique canonical `teams:["SEA",...]`, ISO `capturedAt`
and supporting `https://www.nfl.com/...` `sourceUrl`. The sidecar has
`sourceId:"verified-byes"`, matching period/hash and `retrievedAt` equal to `capturedAt`.
The collector/owner verifies the named teams against that official page; supplying a URL
alone is not verification. A team also present in the game capture conflicts and fails closed.
Only named bye teams receive zero forecasts; other absent teams remain unknown. Preseason
board byes are not used.

K uses participating current-season own-team FG/PAT attempts as scoring opportunities, with
pooled make rates and one observed pooled game of smoothing. League scoring is exactly 3 per
FG, +1 PAT and -1 missed PAT, with no distance tiers. Drives and future offense changes are
unmodeled. DEF separates sack, interception, fumble and points-allowed points; rare TD/safety/
block/return scores use the league pool including zero games. Own components shrink by one
pooled observed game. Opponent exposure uses defensive results against that offense after an
exact completed historical team-game schedule join; current player teams are never retroactively
assigned. Where supported, own and opponent estimates are equally averaged; this and smoothing
are disclosed uncalibrated choices. Missing opponent exposure is unknown, with own/pool estimates
labeled. K/DEF preseason weighting and historical whole-score multipliers are removed. Sleeper
omits zero event keys on participating box scores; that convention requires a measured K
participation row or DEF `pts_allow` row. Missing rows are not zero. DEF extra-point returns
have no distinct supported field and remain unmodeled. Predictive improvement is not accepted.

Tuesday planning reads the saved Monday report without a refresh:

```sh
node analysis/refresh-weekly-projection.mjs --plan-roster \
  --rankings=/path/to/monday-week5/week5-multiweek-rankings.json \
  --roster-snapshot=/path/to/fresh-full-yahoo-readback.json --out=/path/to/tuesday-planning
```

The snapshot has the IDP snapshot's season/week/league/team/source/capture/expiry binding, plus
`fullRosterVerified:true`, `availableVerified:true`, `slots`, full `roster`, and `available`.
Slots are exact unique IDs, e.g. `{id:"RB1",eligible:["RB"]}`,
`{id:"FLEX",eligible:["RB","WR","TE"]}`, `{id:"D",eligible:["D"]}`. Every current starter
occupies one named slot. Every row has numeric-string exact `yahooId`, Yahoo `eligible`,
verified `locked` and raw `injuryStatus` (null means no designation observed). Roster rows have
`ownership:"OWNED"`, verified `droppable` and `slot` (exact slot ID, `BN`, or `IR`); available
rows have `ownership:"UNOWNED"`, verified `availability:"FA"`/`"W"`; W requires a future
`conditionalExpiresAt`. Availability is never inferred from model ranking. Unknown ownership,
eligibility, injury marker, availability, lock/drop facts, stale snapshot, duplicate Yahoo/physical
identity or unjoined roster yields `HOLD`. Unmodeled available players are excluded with reasons.
Unknown reserves are disclosed/excluded from modeled matching; unknown current starters or
incomplete known horizon lineups yield `HOLD`. IR never fills a starter slot. Current locks pin
the exact slot, including locked bench exclusion; future locks are not presumed. Established
IDP continuity and expected-snap/tackle edge gates remain.

Polynomial slot matching compares every legal single add/drop across positions. Weekly starter
gains and horizon sums are separate; a horizon gain with a weekly loss is a review tradeoff.
Bench QB/K/DEF/IDP/offense contribution is audited; defense pairs/current-plus-available stash
options are compared. Zero deterministic contribution does not mean a bench player is worthless:
injury insurance and upside are unmodeled. Each package has `approvalRequired:true`,
`executableNow:false`, exact IDs and legal constraints. Future acquisition availability is not
assumed or called safe/risky. W remains conditional on fresh verified FA after release and exact
approval; existing release, single-flight and receipt controls still govern execution.

The output stores readable package objects once in `alternatives`, sorted by summed starter
gain. `proposals` and `defenseAlternatives` are zero-based indices into that array: display
`alternatives[index]` for approval review. The common `baseline` has the full before lineups.
Each alternative's `after` contains `{week,points,changes}`: reconstruct its selected lineup by
replacing each baseline pick with the same-slot entry in `changes`, leaving other slots unchanged.
Only changed slot assignments are repeated per leg; package objects and full before lineups are
not duplicated. This representation preserves exact slot identities and approval conditions.

Optional `coverageRecords` contain
`{temporaryYahooId:"...",coveredYahooIds:["..."],reviewAt:"ISO",expiresAt:"ISO"}` with exact
current roster IDs. Expiry/review produces `REVIEW_COVERAGE` only, never an automatic drop or
renewed transaction permission. Coverage records require owner review.

## Forecast evaluation and candidate acceptance

Each full refresh writes `forecast-actuals.json` and `forecast-evaluation.json`. Optional
`--prior-forecast` names a genuine earlier full or multiweek saved report. Its exact identities
join completed Sleeper actuals and verified final schedules, using the exact league scorer.
Generation, actual acquisition and final-game verification retain their own clocks.
`completedVerifiedAt` records acquisition of a final schedule, not an invented game-end time.
Actual capture must follow that verification; stale/partial offline inputs are excluded and
receipts are never rewritten. Forecast generation must precede kickoff, source receipts precede
generation, and cutoff/period/identity must match. After-kickoff recomputations are excluded.
Missing earlier forecasts yield `NOT_EVALUATED`. Results give per-position MAE and rank comparison
against the forecast's completed-game-mean naive baseline. Yahoo is evaluated only with a verified
saved timestamp before kickoff; otherwise its sample is zero. No auto-tuning or deployment gate
change occurs.

`forecast-actuals.json` retains no-row/no-participation entities under `unresolvedPlayers` with
`NO_PARTICIPATION_ROW_UNRESOLVED`; they are excluded from scored outcomes, never changed to zero.
Evaluation shows their positions and reason counts under `exclusionsByPosition`. Available-per-method
metric totals are labeled unpaired. `pairedComparisons` reports forecast vs naive and forecast vs
timestamped Yahoo MAE/rank metrics on each comparator's same-player subset, with explicit samples;
compare those paired metrics when deciding whether either method performed better.

Reproduce evaluation from the emitted artifact:

```sh
node analysis/refresh-weekly-projection.mjs --evaluate-forecasts \
  --rankings=/path/to/earlier/week4-multiweek-rankings.json \
  --actuals=/path/to/later/forecast-actuals.json --out=/path/to/evaluation
```

Candidate insertion into the SAME existing heartbeat: Monday records the single successful
multiweek path, cutoff, schedules, receipts and evaluation status. Monday also collects the
official named bye evidence once for the three-week horizon: without it, any rostered starter
coverage that cannot be completed from known schedules yields `HOLD`. The unchanged installed
automation does not collect these new inputs; installation/integration is pending. Tuesday collects fresh full
roster/availability facts, runs `--plan-roster`, and presents exact packages/tradeoffs for approval.
At an already approved release event the existing reconciler verifies live facts and consumes
that exact action's bounded authority under receipt rules. No new schedule, polling, transaction
code or live configuration change is proposed. Source test/review/PR acceptance and future
forecast acceptance are separate; predictive improvement, installation, live integration and
runtime behavior remain pending.

## October 6 current-role and roster-planning repair candidate

This section describes the source candidate, not a live installation or heartbeat edit.
Monday still performs one full refresh. Offense players with measured offensive snaps use
completed-season team opportunity budgets and recent measured shares. Yardage/completion/
reception efficiency shrinks by one pooled position player-game; TD/turnover/threshold bonuses
use pooled position rates. Individual hot TD averages and preseason backup points do not anchor
current starters. Team allocations are capped at the observed budget. Missing snaps and conflicting
historical team denominators remain unknown. A QB with relief snaps but no measured full-start
workload has no starter projection. A depth-one QB whose latest game was partial has no normal
forecast; prior measured full starts support a separately labeled conditional full-start case.
Depth rank never distributes workload to backups. IDP, K and DEF point models are unchanged.
Every offense row without measured role remains unknown, regardless of a preseason prior,
source-family count, depth rank or box-score-only production.
These choices are uncalibrated; source tests/replays are not evidence of predictive improvement.

The read-only Yahoo candidate now captures each exact player's `is_editable`, rather than
substituting roster-level editability. A bounded complete FA/W traversal uses the existing GET
routes, with no position filter, no retry, and a short terminal page for each status. A page limit,
duplicate/ownership change or settings drift stops collection as incomplete.

```sh
node analysis/yahoo-fantasy-operations.mjs snapshot all:200 \
  --out=/path/to/private-readback.json
node analysis/yahoo-fantasy-operations.mjs planner-input \
  /path/to/private-readback.json /path/to/monday/week5-multiweek-rankings.json \
  2026-10-06T20:00:00Z --out=/path/to/private-planner-input.json
node analysis/refresh-weekly-projection.mjs --plan-roster \
  --rankings=/path/to/monday/week5-multiweek-rankings.json \
  --roster-snapshot=/path/to/private-planner-input.json --out=/path/to/planning
```

The example expiry is illustrative; supply a real bounded freshness expiry. Output files use
mode 0600 and exclusive creation. Do not put private snapshots in Git or review packets.
Snapshot freshness uses the roster read clock, never the later final pool-page clock.
Repeated Yahoo positions receive occurrence IDs within equivalent slot positions. Exact player
editability supplies captured lock facts; the planner recomputes current-game locks at its actual
evaluation time from verified kickoff, pins starters to their exact slots, and forbids started-game
bench/candidate current-week use even when a later Yahoo editability field permits dropping.
Candidate lineup eligibility may use a verified future same-week
kickoff with a currently editable roster, explicitly labeled. Unknown candidate locks exclude that
candidate. A verified current-bye candidate with locked=null can instead appear as future-only
research: never current-week use and never an approval proposal, even with other gates known.
Unknown Yahoo candidate injury codes (including NA and IR-R) exclude that exact candidate;
unknown roster injury codes still HOLD planning and are not armed for game checks.
Advisory drop comparison requires player editable=1, undroppable=0, cant-cut-list=none,
no pending claims and a non-IR slot; a fresh execution preflight still decides actual drop legality.
W review expiry bounds the conditional proposal and does not establish waiver release time.
Missing acquisition capacity/limit semantics, unknown drop legality, pending claims/trades or
an incomplete candidate pool produce transaction `HOLD`; baseline, bench costs,
`conditionalProposals` indices and independently verified game checks remain visible. Missing
values, zero and negative limit sentinels never mean unlimited. An optional fourth planner-input
file is an exact verified Yahoo supplement with season/week/league/team, source, verified=true,
capturedAt/expiresAt, per-player locks/drop facts and their basis, or addCapacityVerified plus
addCapacityBasis. It must come from supported current readbacks, not invented booleans.

At existing 75-minute and 15-minute checkpoints, collect a small official availability packet
and recompute the affected-player overlay from the SAME saved base. No season refresh or service:

```sh
node analysis/refresh-weekly-projection.mjs --overlay-availability \
  --rankings=/path/to/monday/week5-multiweek-rankings.json \
  --official-overlay=/path/to/official-facts.json --out=/path/to/unique-checkpoint
```

The packet has integer season/week, source="NFL_OFFICIAL_VERIFIED_READBACK", verified=true,
supporting official NFL/club sourceUrl, actual capturedAt, future expiresAt and `facts`. Each fact
has exact numeric playerId, status, source/verified/sourceUrl and its own capturedAt/expiresAt
(not later than the packet clocks). Status is ACTIVE, OUT, IR, PUP, NFI, SUSPENDED, INACTIVE,
QUESTIONABLE, DOUBTFUL, RESTRICTED or UNKNOWN. Sources must be verified official pages by the
collector; the source tag is a readback contract, not URL discovery. Replacement-role facts can
set replacementRole=true; no workload is invented. A partial QB's ACTIVE readback restores its
measured full-start case only with fullStarterRoleVerified=true, supported by that official role
readback. Source clocks/expiry and base/evidence hashes are retained; originals stay fixed.

Optional `redistributions` contain donorPlayerId, channel (passAttempts/carries/targets), and
recipientPlayerIds. The donor needs official confirmed absence; recipients need official ACTIVE
facts and existing measured same-team channel opportunity. A recipient gets an uncalibrated
estimate proportional to its measured opportunity divided by team budget minus this donor only.
With several absent donors this intentionally underallocates rather than silently renormalizing
the remaining recipients; every donor's unassigned opportunity is retained. No equal splits,
depth-three/four/five promotion, unmeasured replacement QB volume, cross-channel transfers or
extra team opportunities. Unsupported recipients remain HOLD; unused opportunities remain
unallocated, with an explicit unknown bucket. Rare official numeric plans can instead supply
fact.workload with kind="OFFICIAL_QUANTIFIED_WORKLOAD", expectedVolume for all three channels,
support and the same official evidence-clock fields; numeric plans and restored partial-QB
full-start scenarios must conserve the existing team budget across all known teammate allocations.
An overfilled team fails closed instead of inventing a replacement allocation.

Q/D/restriction/unknown facts remain scenarios with no probability or generic haircut. Run the
same overlay command twice with `--availability-scenario=current-role` and
`--availability-scenario=unavailable` for separately labeled conditional cases. A questionable
donor's redistribution is applied only in its unavailable scenario. Compare both planner outputs
together before reviewing any robust gain; a single scenario emits no approval proposal.
Unknown current-role components stay unknown even in the available case.

`gameChecks.rosterSchedule` preserves verified roster/schedule facts independently of add/drop
gates. `actionableChecks` groups only future existing checkpoints: unlocked starters and direct
eligible bench substitutions whose actual current starter destination remains unlocked at that
checkpoint. IR, known unavailable players, past/locked games, missing locks and expired checkpoints
are excluded. Expired official facts are unknown, never reused as a current OUT designation;
an unflagged Yahoo status is not official clearance. No unapproved slot rearrangement is assumed. Thus a Monday bench QB has no check
when its only Sunday QB destination is already locked. The coordinator alone updates the same
heartbeat after source acceptance; these helpers schedule nothing and authorize no Yahoo write.
