# Yahoo draft controller

This is a dependency-free, page-resident controller for Yahoo NFL live draft rooms. It acts only from a nonempty ordered target ladder, never turns on Yahoo Autodraft, and stores a receipt before every Draft click plus a roster-transition confirmation afterward.

## Safety boundary

### Failed-draft repair: source-only readiness

This repair is not a live-draft qualification. The last TEST draft included a user-confirmed Round 1 Yahoo autopick, manual recovery, and no untouched completed extension export. Do not describe its roster as a clean automated result.

- The compact dock displays the lifecycle label and failure detail directly. Clock verification and identity remain on the compact line; recommendation updates cannot erase failures. ARM (on arm-owner surfaces) and EXPORT are visible without opening the large center.
- TEST `542830`, Yahoo team `3`, requires its own league/model/schema identity. Its complete enabled scoring rows were observed on 2026-09-05 and fingerprinted in the runner contract. The bundled board is still REAL `420010` data, not relabeled TEST data: TEST ARM remains blocked until a fresh, matching TEST board is built and separately deployed. Public mocks rehearse execution, not TEST scoring calibration. Real execution remains disabled.
- After initial board preparation, the runner alone controls off-turn view discovery. It reads All Positions, Kickers, Team Defenses, and Defensive Players; the latter requires the observed Proj Pts column in verified descending numeric order. Missing projections remain missing. Coverage means rendered rows, not the complete Yahoo player database. Discovery cancels before another filter write when our turn starts.
- Off-turn rows only choose a view hint. The owned-turn ladder is rebuilt from fresh, visible, clickable rows in that single view. Failed specialist discovery or insufficient legal targets in the hint permits **one** visible, receipted All Positions fallback before any Draft click, requiring five fresh legal targets. This fallback minimum intentionally remains five even in the final round; only the primary path permits a smaller final-round ladder. The 1.2-second panel and 2-second detection-to-click budgets never restart. This fallback forfeits clean acceptance. Failed All Positions reads, safety failures, or ambiguous/post-click actions stop; they are not retried.
- At an actual snake endpoint, the immediately preceding round's complete discovery may supply a view hint only after the preceding pick is confirmed and the overall picks are consecutive. Already-picked IDs are removed; no rows or buttons are reused. Non-adjacent or older discovery still fails the freshness gate. Every adjacent hint is receipted.
- Disappearing rows are not opponent-pick evidence. The extension supplies no live run-pressure inference; only explicitly supplied calibrated pressure may affect survival estimates. No ranking weights changed here.
- Nonempty initial rosters display RECOVERY REQUIRED. ARM failure is terminal: leave the room, correct preflight, and enter using Yahoo's own draft link under new execution authority. No automatic resume, in-room reload, or retry of ambiguous picks.
- Failure exports preserve exact room and URL team even if the snake slot or extension attestation is unknown. Unknown values stay null; these exports cannot pass acceptance. Acceptance also checks same-turn view coverage and runtime receipts.

Verification is deliberately separated: synthetic-page fixtures exercise production boot/bridge/ARM/preparation/runner/controller from slots 1, 6, and 12 at a 30-second clock, with genuine adjacent snake turns and a 100-row All Positions limit. Valid and rejected pre-staged pins use production command handlers. Synthetic final-roster and runtime evidence do not establish a live Yahoo PASS, browser rendering, or installed-extension readiness. Merge, deployment, activation, and Yahoo actions remain separate gates.

- Run only on `/draftclient/f1/<room>/<seat>` after dismissing Yahoo tutorials or dialogs.
- Prefer Yahoo player IDs. The fallback identity requires the exact displayed Yahoo name, position, and team abbreviation.
- On an owned turn Yahoo renders a `Draft` button inside every available player row. The controller clicks only the button inside the uniquely matched target row; it never uses a page-global Draft selector.
- The controller requires both the live `YOUR TURN` document title and the exact `YOUR TURN • ROUND …, PICK …` banner. Static future-pick text is ignored.
- The exact Yahoo Autodraft control must be present and visibly unchecked, and Yahoo must visibly report `Your queue is empty`. Active, missing, duplicated, or ambiguous safety controls stop the controller before any click and are rechecked through confirmation.
- A blocking dialog, ambiguous player, ambiguous Draft action, changed room, unavailable ladder, or unconfirmed roster transition stops the controller.
- A standalone controller defaults to returning a failed mock to the lobby. The qualification runner overrides that default with `failureAction: "stay"`, stops clicking, and preserves the draft page for inspection or handoff.
- `failureAction: "stay"` is the non-navigating failure mode for a real-room handoff. It stops clicking and preserves the draft page; it does not make an unverified real draft executable.

## Load and start

Inject `yahoo-draft-controller.js` into the Yahoo draft page, then provide a preapproved ordered ladder:

```js
const controller = SKRODZKaiYahooDraftController.create({
  targets: [
    { yahooId: "31908" },
    { name: "T. McLaurin", position: "WR", team: "Was" },
  ],
});

controller.start();
controller.getStatus();
controller.exportReceipts();
```

Bind the controller to an approved preflight when the room, seat, and roster size are known:

```js
const controller = SKRODZKaiYahooDraftController.create({
  expectedRoomId: "9378515",
  expectedSeat: 6,
  expectedRosterTotal: 15,
  failureAction: "stay",
  targets: [{ yahooId: "32711" }],
});
```

The controller persists receipts in Yahoo-origin local storage under `skrodzkai-yahoo-draft-controller-receipts-v1`. Injection does not start the controller; `start()` is the explicit execution boundary.

## Public-mock qualification runner

`yahoo-mock-runner.js` layers a roster-aware policy over the exact-row controller. It requires a programmatically observed 12-team room, expected seat, empty roster, exact qualified roster shape, joint replacement baselines, and five visible exact-Yahoo-ID fallbacks. The player pool retains Yahoo multi-position eligibility and league-scored projections; observed market ranges or Yahoo preseason rank affect only availability estimates, never football value.

The runner waits for the controller's exact owned-turn signal before constructing a clickable ladder; TEST view discovery runs off-turn as described above. Each decision uses one freshly verified visible pool. It computes exact marginal Weeks 1–17 utility over the best legal weekly lineups, so byes, explicit missed games, and QB2 substitution value are priced directly. Once an offensive player no longer adds a starter slot, the engine retains a bounded 15% share of positive VOR as bench opportunity value instead of treating useful depth as zero. It then estimates continuous next-turn survival from the held-out league curve (or a visibly uncalibrated market fallback) and evaluates the best one-turn alternatives. Explicitly supplied position pressure alters only survival, never projection, replacement level, or marginal utility; table disappearance supplies no pressure.

The 19-round formats add one reviewed containment gate for weak specialist forecasts: K and DEF cannot be selected automatically before Round 15, both must be filled by the end of Round 16, and ordinary IDPs cannot be selected automatically before Round 17. Manual exact-ID selection remains available for an earlier specialist when Joe explicitly chooses it, but that intentional deviation forfeits a clean League Two acceptance result. The public 15-round mock retains its existing rules. There is no RB/WR floor, QB/TE timing rule, or hidden position filter. Missing-market players remain visible with labeled evidence rather than disappearing from the board.

The compact per-turn receipt records the snake window, starter marginal utility, bench opportunity value, expected next-turn utility, cost of waiting, continuous availability probability, chosen Yahoo ID, and five target IDs. A recompute over 1,000 ms or a panel ready time of 1,200 ms or more fails closed before any Yahoo click; it never swaps to a different ranking model. The on-clock chooser exposes the same three leading targets plus searchable exact-ID selection, keeps all five baseline fallbacks, and starts the page-local click controller synchronously. The controller accepts a pick only after the exact Yahoo ID appears in the rendered `YOUR TEAM` panel and the turn advances.

The exact `test_league_19_idp` lane is bound to `SKRODZKai`, team 3 in Yahoo League Two (`542830`). It separates the URL team ID from the snake draft slot and binds the actual 10–12 team field observed when Yahoo publishes the order. The 19-slot shape is QB, three WR, two RB, TE, two W/R/T, K, DEF, two generic D, and six bench slots. K, DEF, D, LB, CB, and S remain in the ranked board, while each clickable ladder uses its freshly verified view. Automatic timing containment and roster feasibility require both K/DEF slots, two late IDP starters, and no IDP bench stash. Dual-role offense/IDP players remain manual-only until Yahoo scoring credit is verified. Fresh, non-conflicting `REVIEW` injury players are also manual-only and visibly carry their status and availability assumption; `EXCLUDE`, stale, and conflicting records remain blocked. The separate `real_league_19_idp` configuration remains non-executable; real league 420010 is hard-disabled.

The runner exposes a one-way `halt()` kill switch. A halted runner cannot resume; a new, explicitly armed runner is required. Keep the active draft tab in the foreground so Chrome does not throttle its runner heartbeat and relinquish the single-tab lease.

## Local Chrome extension

The repository root is also a dependency-free Manifest V3 extension. Load the repository directory as an unpacked extension in Chrome. It requests no general extension permissions and runs MOCK/TEST execution only on Yahoo's public mock waiting room and exact League Two surfaces. Version `0.16.3` keeps an isolated read-only observer on exact real-league 420010 / team 7 surfaces; that content-script set contains no runner, controller, or mutation path. **Reload & Verify** is available only on idle, off-clock TEST/MOCK setup surfaces and is disabled inside the live draft client. It reloads the unpacked extension, refreshes the same Yahoo tab, and requires a new extension-session boot ID plus a healthy manifest-version/runtime-digest handshake before restoring controls. A missing rail after reload means Chrome could not inject the extension and requires manual inspection. Stale, missing, or mismatched attestations remain visibly locked.

The compact `SKRODZKai` command center arms public mocks from `/f1/mock_waiting`. The TEST lane parses `/f1/542830/settings` for the exact roster, 12-team maximum, 60-second clock, and every enabled scoring row in each section. It reads the league-value column, not Yahoo defaults; missing, added, changed, or duplicate rows fail closed. The settings receipt binds the verified scoring hash. Subject to all scoring and board-health gates, TEST may be explicitly armed from `/f1/542830/draft` or the exact prestart draftclient with its verified full snake strip, empty roster, and team 3 at the independently observed snake slot. Each token binds the room, URL team, snake slot, actual team count, and roster shape. An arm failure is terminal; league 420010 is excluded at manifest and runtime layers.

For a separate TEST board, use the existing `analysis/build-v5-board.mjs` CLI
with `--league-id=542830`, the observed `--team-count=12` (10–12 supported),
`--adp=<raw-FFC-JSON>`, `--adp-observed-at=<actual-retrieval-ISO>`, and its
existing required input paths. `--as-of` must match the current build clock
within 15 minutes. The shared ADP helper applies exact name/team/position market
values and carries their freshness/hash receipt into the board; copying an old
file cannot refresh its explicit observation timestamp. Both Yahoo
projection snapshots must carry the TEST league/model/schema identity; REAL
snapshots are rejected, never relabeled. Independent raw statistics are rescored
using TEST coefficients. Aggregate kicker totals cannot invent distance buckets;
the REAL-trained IDP calibration is withheld. Freshness, injury, identity,
multi-source, and export-coverage gates remain in force. The default build and
`refresh-draft-prep.mjs` remain REAL-only; the TEST builder does not replace the
bundled board or deploy it.

Yahoo rows with projected `games` use that denominator; invalid or unknown
explicit games are excluded individually and listed in `projectionDiagnostics`.
Null games require an explicitly established snapshot `projectionGames` basis;
do not guess 16 or 17 for team defenses. Legacy inputs that omit the games field
retain their existing 17-game source contract. Reduced projected games cap weekly
availability, but do not provide medical clearance: fewer than 16 games without
an explicit availability disposition remain manual-review only. `PUP-R` maps to
PUP; injury exclusions and conflicts take precedence in displayed validation.
Current Yahoo team and eligibility replace stale baseline facts, including old
specialist and position-fallback channels. Travis Hunter remains manual-only.

Validate the actual result with `export-extension-board.mjs`, then the production
`boardHealthGate` and TEST `scoringFailure`. Export requires at least 100 usable
offensive players, 12 kickers, and exactly 32 defenses. A missing source-period
basis is a data gap, not permission to relax these thresholds. The late-IDP
negative synthetic fixture forces two open D slots in the last two rounds,
removes D rows at turn entry and from the fallback, and verifies one receipted
fallback followed by a stop with no additional click or completion receipt.

On the matching draftclient page the extension:

1. Rechecks the exact room, URL team, snake slot, empty `0/15` or `0/19` roster, Autodraft-off state, and roster shape.
2. Uses current exact Yahoo IDs from the static free-source board, restores `All Positions`, and requires two identical availability reads after the filter reports its expected value.
3. Starts the existing deterministic runner inside the page, removing model and browser-control latency from the pick clock.
4. Displays lifecycle, clock, and failure state in the compact dock, with roster, ladder, snake horizon, warnings, and receipts in the separate command center. It does not infer opponent pressure from table changes.
5. Accepts a conditional next-pick pin only before the owned turn. The pin binds the exact room, snake slot, and next round; the runner applies it only when the Yahoo ID is still available and position-legal. Otherwise it records the rejection and immediately executes the unchanged five-target baseline ladder.
6. Exposes a one-way `HALT` control and a JSON `EXPORT` containing room-scoped extension, runner, and controller receipts plus the exact loaded-runtime attestation. The background grants the fresh runner lease to only one Yahoo draft tab; a competing tab locks itself. Export requires an explicit owner attestation: `NONE`, or `INTERVENTION:` plus a brief description when the owner prevented or replaced a Yahoo automatic selection. Missing or intervention evidence locks TEST acceptance.
7. On the exact TEST team page, reads Yahoo's rendered starter and bench rows and records one final-roster receipt. Acceptance requires both generic D slots to contain Yahoo-eligible IDPs and no drafted IDP on `BN`.

The TEST-room opponent panel uses only the observed snake window and the live decision ladder. It explicitly withholds 2 Minute Drillers manager-history projections because those owner identities do not participate in the retained test league.

The extension permits public mocks and exact League Two TEST execution only. The real 19-round IDP configuration remains non-executable, and this package grants no real-league authority.

## Draft-night analysis

The dependency-free scripts under `analysis/` keep model work outside the live
click path:

- `opponent-calibration.mjs` trains recency-weighted room and manager-phase
  tendencies and emits pseudonymous manager profiles only when an untouched
  season plus a manager-clustered interval beats the room baseline. Its CLI
  excludes Joe's history from every stage and keeps the owner map private.
- `opponent-window.mjs` and `opponent-war-room.mjs` bind the announced snake
  order to held-out-cleared position pressure. Manager tendencies are a close-
  tier tiebreak only; the fallback is the room phase and no exact-player claim
  is made.
- `draft-survival-calibration.mjs` learns the empirical league draft residual
  curve and gates the narrower position layer on held-out Brier improvement.
  Missing point-in-time Yahoo/static-BPA history is reported, never rebuilt.
- `draft-committee.mjs` creates compact, packet-hashed candidate ballots and
  accepts consensus only when both responses are valid, available, and inside
  the deadline. Otherwise the deterministic baseline order is unchanged.
- `build-v5-board.mjs` and `export-extension-board.mjs` reconcile free Yahoo,
  league-scored history/market, injury, and eligibility evidence into the
  static executable board without a live network/model dependency. The board
  normalizes sources per game, preserves weekly bonus events, and receipts
  offense, specialist, health, and eligibility observation times separately.
- `injury-monitor.mjs` keeps injuries, suspensions, holdouts, and role
  uncertainty on a compact manual-review watchlist, receipts full-player
  coverage, and changes expected games only from explicit consistent evidence.
- `weekly-roster-utility.mjs` creates the 17-week availability and scoring
  profiles used by the live optimizer while keeping source disagreement
  separate from calibrated player outcome intervals.
- `test-draft-acceptance.mjs` keeps two explicit, non-interchangeable receipt
  contracts. The default `league_two_test_19_idp` contract grades League Two
  TEST execution and requires Yahoo's independent final-roster readback. The
  `public_mock_15` contract grades only public-room execution evidence, reports
  `PUBLIC_MOCK_PASS`, and records that no final-roster page exists on that
  surface. Public evidence never substitutes for retained TEST or real-room
  acceptance. Both contracts replay recorded choices and mark counterfactual
  scoring unavailable when compact receipts did not preserve unchosen outcomes.
  Downstream League Two TEST gates must require both `status === "PASS"` and
  `contract === "league_two_test_19_idp"`; the generic `valid` field and process
  exit code also cover public-only evidence and are not sufficient.
- The League Two grader also requires the same runtime attestation at export and
  runner start, Autodraft visibly off, the Yahoo queue visibly empty, a unique
  Yahoo clock reading, command-center readiness under 250 ms, and every owned-
  turn detection-to-click interval under 2 seconds. Use
  `--require-manual-override=true --require-rejected-override=true` for the final
  rehearsal: stage one valid next-pick pin and, on a different round, one player
  Yahoo has already drafted. The latter must be visibly rejected while the
  unchanged five-target baseline completes the pick. Do not invoke Reload &
  Verify inside the draft client. The kill-switch regression is in
  `controller/yahoo-mock-runner.test.mjs`; a live halt intentionally invalidates
  a clean run.
- `build-v5-readiness-report.mjs` and `run-v5-rehearsals.mjs` produce the
  sanitized history, specialist-survival, 12-seat roster, concentration, and
  chaos receipts stored outside the repository.

None of these scripts click Yahoo or create real-draft authority. A late model
response is advisory evidence only and never delays the extension.

## Verification

```bash
node --test controller/yahoo-draft-controller.test.mjs
node --test controller/yahoo-mock-runner.test.mjs
node --test extension/yahoo-mock-extension.test.mjs
node --test analysis/*.test.mjs
```
