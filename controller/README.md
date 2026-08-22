# Yahoo draft controller

This is a dependency-free, page-resident controller for Yahoo NFL live draft rooms. It acts only from a nonempty ordered target ladder, never turns on Yahoo Autodraft, and stores a receipt before every Draft click plus a roster-transition confirmation afterward.

## Safety boundary

- Run only on `/draftclient/f1/<room>/<seat>` after dismissing Yahoo tutorials or dialogs.
- Prefer Yahoo player IDs. The fallback identity requires the exact displayed Yahoo name, position, and team abbreviation.
- On an owned turn Yahoo renders a `Draft` button inside every available player row. The controller clicks only the button inside the uniquely matched target row; it never uses a page-global Draft selector.
- The controller requires both the live `YOUR TURN` document title and the exact `YOUR TURN • ROUND …, PICK …` banner. Static future-pick text is ignored.
- A checked Autodraft control, blocking dialog, ambiguous player, ambiguous Draft action, changed room, unavailable ladder, or unconfirmed roster transition stops the controller.
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

`yahoo-mock-runner.js` layers a roster-aware 15-round public-mock policy over the exact-row controller. It requires a programmatically observed 12-team room, expected seat, empty 15-player roster, exact public-mock roster shape, and five visible Yahoo-ID fallbacks. Offensive board entries must include finite VORP and both endpoints of an observed market-ADP range; DEF and K retain static rank ordering.

The runner waits for the controller's exact owned-turn signal before reading the live rows and resolving the strategy. For Rounds 1–12 it compares the highest-VORP available player at each eligible position with the best same-position player expected to remain at the next snake turn. Zero-opponent wraps are treated as certain availability. Otherwise the observed ADP range classifies the leader as likely gone, likely available, or ambiguous. An ambiguous gap must clear the 15-point material-edge allowance, representing one point per week across the 15-week fantasy season.

Through Round 4, the hypothetical post-pick roster must contain at least `round - 1` RB/WR players. The exception is evaluated only in Round 4, when a second QB/TE may break that final floor if its adjusted drop-off beats the best RB/WR by the same 15-point material edge; allowing the exception earlier can create an unrecoverable Round 4 deficit. This preserves an early elite-TE selection when the actual scarcity gap supports it without hardcoding an elite headcount. Round 13 uses terminal offensive VORP because the remaining turns are specialist-only. Rounds 14 and 15 switch Yahoo to Team Defenses and Kickers.

Fallbacks are built iteratively: after choosing a position leader, the runner removes it hypothetically and recomputes the position leaders. The compact per-turn receipt records the snake window, one leader and comparator per position, survival bucket, drop-off scores, roster-floor result, chosen Yahoo ID, and final target IDs. It does not persist the full live board. The QB1/TE1 limits, balanced offense requirement, exact-row click contract, and non-navigating failure behavior remain unchanged.

The separate `real_league_19_idp` configuration is deliberately marked unverified and cannot be executed by the runner. Public mocks do not qualify the real room's 19-round or IDP behavior.

The runner exposes a one-way `halt()` kill switch. A halted runner cannot resume; a new, explicitly armed runner is required.

## Local Chrome extension

The repository root is also a dependency-free Manifest V3 extension. Load the repository directory as an unpacked extension in Chrome. It requests no general extension permissions and runs only on Yahoo's public mock waiting room and NFL draftclient paths.

The compact `SKRODZKai` control rail must be armed from `/f1/mock_waiting`. Arming records a 30-minute, tab-scoped token containing the programmatically observed mock room, seat, 12-team count, and exact public 15-round roster shape. The draftclient refuses to start without that matching token, so opening the real league draft directly cannot arm or execute this public-mock runner.

On the matching draftclient page the extension:

1. Rechecks the exact room, seat, empty `0/15` roster, Autodraft-off state, and position filters.
2. Binds current Yahoo defense IDs to the local specialist rankings and restores `All Positions` before the draft begins.
3. Starts the existing deterministic runner inside the page, removing model and browser-control latency from the pick clock.
4. Exposes a one-way `HALT` control and a JSON `EXPORT` containing room-scoped extension, runner, and controller receipts.

The extension remains mock-only. The unverified 19-round IDP configuration is still non-executable, and this package grants no real-league authority.

## Draft-night analysis

The dependency-free scripts under `analysis/` keep model work outside the live
click path:

- `opponent-calibration.mjs` trains a recency-weighted, owner-to-room-shrunk
  position-demand model and enables it only when an untouched season plus a
  manager-clustered interval beat the room baseline. Its CLI requires Joe's
  owner ID to be excluded from every stage.
- `opponent-window.mjs` converts an observed owner-to-seat order into exact
  snake-window position pressure without exposing raw owner identities in its
  output.
- `draft-committee.mjs` creates compact, packet-hashed candidate ballots and
  accepts consensus only when both responses are valid, available, and inside
  the deadline. Otherwise the deterministic baseline order is unchanged.

None of these scripts click Yahoo or create real-draft authority. A late model
response is advisory evidence only and never delays the extension.

## Verification

```bash
node --test controller/yahoo-draft-controller.test.mjs
node --test controller/yahoo-mock-runner.test.mjs
node --test extension/yahoo-mock-extension.test.mjs
node --test analysis/*.test.mjs
```
