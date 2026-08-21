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

`yahoo-mock-runner.js` layers a roster-aware 15-round public-mock policy over the exact-row controller. It requires a programmatically observed 12-team room, expected seat, empty 15-player roster, exact public-mock roster shape, and five visible Yahoo-ID fallbacks before each turn. It switches Yahoo to Team Defenses for Round 14 and Kickers for Round 15, disallows QB2/TE2, prevents the prior seven-WR roster, stores a durable receipt before arming the next round, and never navigates away on failure.

The separate `real_league_19_idp` configuration is deliberately marked unverified and cannot be executed by the runner. Public mocks do not qualify the real room's 19-round or IDP behavior.

The runner exposes a one-way `halt()` kill switch. A halted runner cannot resume; a new, explicitly armed runner is required.

## Verification

```bash
node --test controller/yahoo-draft-controller.test.mjs
node --test controller/yahoo-mock-runner.test.mjs
```
