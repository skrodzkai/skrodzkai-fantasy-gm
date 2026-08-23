import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./yahoo-mock-extension.js", import.meta.url), "utf8");
const boardSource = await readFile(new URL("./yahoo-mock-board.js", import.meta.url), "utf8");
const controllerSource = await readFile(new URL("../controller/yahoo-draft-controller.js", import.meta.url), "utf8");
const runnerSource = await readFile(new URL("../controller/yahoo-mock-runner.js", import.meta.url), "utf8");
const popupSource = await readFile(new URL("./command-center.js", import.meta.url), "utf8");
const popupCss = await readFile(new URL("./command-center.css", import.meta.url), "utf8");
const popupHtml = await readFile(new URL("./command-center.html", import.meta.url), "utf8");
const backgroundSource = await readFile(new URL("./command-center-background.js", import.meta.url), "utf8");
const context = {
  console,
  Date,
  URLSearchParams,
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context);
vm.runInContext(boardSource, context);
const helpers = context.SKRODZKaiYahooMockExtension._test;

function waitingFixture({ teams = 12, starters = "QB, WR, WR, RB, RB, TE, W/R/T, K, DEF", seat = 7 } = {}) {
  const numbers = Array.from({ length: teams }, (_, index) => index + 1).join("\t");
  return {
    document: {
      body: {
        innerText: `Mock Draft\nStarts In\n04:00 You will draft ${seat}th\n${numbers}\nRoster Positions\n\n${starters}\nStat Categories`,
      },
    },
    location: { pathname: "/f1/mock_waiting", search: "?mlid=9391926&lobby=standard" },
  };
}

test("qualifies only the exact 12-team public mock waiting-room shape", () => {
  const fixture = waitingFixture();
  const snapshot = helpers.parseWaitingRoom(fixture.document, fixture.location);
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.roomId, "9391926");
  assert.equal(snapshot.seat, 7);
  assert.equal(snapshot.teamCount, 12);
  assert.deepEqual([...snapshot.rosterSlots], [...helpers.publicRosterSlots]);
});

test("rejects the wrong team count, roster shape, path, or missing seat", () => {
  const fourteen = waitingFixture({ teams: 14 });
  assert.deepEqual(
    [...helpers.parseWaitingRoom(fourteen.document, fourteen.location).errors],
    ["mock_team_count_not_12"],
  );

  const idp = waitingFixture({ starters: "QB, WR, WR, WR, RB, RB, TE, W/R/T, K, DEF, D, DB, LB" });
  assert.deepEqual(
    [...helpers.parseWaitingRoom(idp.document, idp.location).errors],
    ["mock_roster_shape_mismatch"],
  );

  const realPath = waitingFixture();
  realPath.location.pathname = "/draftclient/f1/470/7";
  assert.equal(
    helpers.parseWaitingRoom(realPath.document, realPath.location).errors.includes("not_public_mock_waiting_room"),
    true,
  );

  const missingSeat = waitingFixture();
  missingSeat.document.body.innerText = missingSeat.document.body.innerText.replace("You will draft 7th", "Seat pending");
  assert.equal(
    helpers.parseWaitingRoom(missingSeat.document, missingSeat.location).errors.includes("mock_seat_missing"),
    true,
  );
});

test("binds an arm token to one room and seat with a fixed expiration", () => {
  const fixture = waitingFixture();
  const snapshot = helpers.parseWaitingRoom(fixture.document, fixture.location);
  const armRecord = helpers.makePreflight(snapshot, 1_000);
  assert.equal(armRecord.expiresAt, 1_801_000);
  assert.equal(helpers.validateDraftPreflight(armRecord, { roomId: "9391926", seat: 7 }, 1_001), null);
  assert.equal(helpers.validateDraftPreflight(armRecord, { roomId: "9391926", seat: 6 }, 1_001), "draft_room_or_url_team_changed");
  assert.equal(helpers.validateDraftPreflight(armRecord, { roomId: "9391927", seat: 7 }, 1_001), "draft_room_or_url_team_changed");
  assert.equal(helpers.validateDraftPreflight(armRecord, { roomId: "9391926", seat: 7 }, armRecord.expiresAt), "draft_arm_expired");
  assert.equal(helpers.validateDraftPreflight(null, { roomId: "9391926", seat: 7 }, 1_001), "approved_draft_arm_required");
});

test("binds the verified test league to team 12 while keeping the snake draft slot separate", () => {
  const settingsDocument = {
    body: {
      innerText: "League Name:\tHORSE COLLAR #2\nDraft Type:\tLive Standard Draft\nMax Teams:\t12\nLive Draft Pick Time:\t1 Minute, 15 Seconds\nRoster\u00a0Positions:\tQB, WR, WR, RB, RB, W/R, W/R/T, K, DEF, D, LB, CB, S, BN, BN, BN, BN, BN, BN, IR, IR, IR",
    },
  };
  const settingsSnapshot = helpers.parseTestSettings(settingsDocument, { pathname: "/f1/18599/settings" });
  assert.equal(settingsSnapshot.ready, true);
  const settingsReceipt = helpers.makeTestSettingsReceipt(settingsSnapshot, 1_000);
  assert.equal(helpers.validTestSettingsReceipt(settingsReceipt, 1_001), true);
  const document = {
    body: {
      innerText: "SKRODZKai\nHORSE COLLAR #2 · 12 Teams · 19 Rounds · 1 minute 15 seconds\nYour Draft Position: 4th",
    },
  };
  const location = { pathname: "/f1/18599/draft" };
  const snapshot = helpers.parseTestDraftHome(document, location, settingsReceipt, 1_001);
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.urlSeat, 12);
  assert.equal(snapshot.seat, 4);
  assert.equal(helpers.parseTestDraftHome({ body: { innerText: document.body.innerText.replace("SKRODZKai", "Chef Joe") } }, location, settingsReceipt, 1_001).ready, false);
  assert.deepEqual([...snapshot.rosterSlots], [...helpers.testRosterSlots]);
  const preflight = helpers.makeTestPreflight(snapshot, 1_000);
  assert.equal(preflight.seat, 4);
  assert.equal(preflight.urlSeat, 12);
  assert.equal(preflight.expiresAt, 14_401_000);
  assert.equal(helpers.validateDraftPreflight(preflight, { roomId: "18599", seat: 12 }, 1_001), null);
  assert.equal(helpers.validateDraftPreflight(preflight, { roomId: "18599", seat: 4 }, 1_001), "draft_room_or_url_team_changed");
  assert.equal(
    helpers.parseTestDraftHome({ body: { innerText: document.body.innerText.replace("Your Draft Position: 4th", "Draft position pending") } }, location, settingsReceipt, 1_001).ready,
    false,
  );
  assert.equal(helpers.parseTestDraftHome(document, location, null, 1_001).errors.includes("verified_test_settings_preflight_required"), true);
  assert.equal(
    helpers.parseTestDraftHome({ body: { innerText: document.body.innerText.replace("Your Draft Position: 4th", "Projected Draft Position: 4th") } }, location, settingsReceipt, 1_001).errors.includes("test_draft_slot_pending"),
    true,
  );
});

test("attaches current Yahoo defense IDs only to exact ranked teams", () => {
  const available = [
    { yahooId: "1001", name: "Seattle", position: "DEF", team: "SEA" },
    { yahooId: "1002", name: "Denver", position: "DEF", team: "DEN" },
    { yahooId: "1003", name: "Houston", position: "DEF", team: "HOU" },
    { yahooId: "1004", name: "Minnesota", position: "DEF", team: "MIN" },
    { yahooId: "1005", name: "Philadelphia", position: "DEF", team: "PHI" },
  ];
  const ranks = [
    { name: "Seahawks", team: "SEA", rank: 3 },
    { name: "Broncos", team: "DEN", rank: 1 },
    { name: "Texans", team: "HOU", rank: 5 },
    { name: "Vikings", team: "MIN", rank: 4 },
    { name: "Eagles", team: "PHI", rank: 2 },
  ];
  const merged = helpers.mergeDefenseBoard(available, ranks);
  assert.deepEqual([...merged.map((player) => player.yahooId)], ["1002", "1005", "1001", "1004", "1003"]);
  assert.throws(() => helpers.mergeDefenseBoard(available.slice(0, 4), ranks), /fewer_than_5_verified_defenses/);
});

test("exports runner and controller receipts using distinct draft-slot and Yahoo-team identities", () => {
  const values = new Map([
    ["skrodzkai-yahoo-mock-extension-receipts-v1", JSON.stringify([
      { roomId: "99", seat: 3, kind: "keep" },
      { roomId: "99", seat: 4, kind: "drop" },
    ])],
    ["skrodzkai-yahoo-mock-runner-receipts-v1", JSON.stringify([
      { roomId: "99", seat: 3, kind: "runner" },
    ])],
    ["skrodzkai-yahoo-draft-controller-receipts-v1", JSON.stringify([
      { roomId: "98", seat: 3, kind: "drop" },
      { roomId: "99", seat: 12, kind: "controller" },
    ])],
  ]);
  const payload = helpers.buildExportPayload({
    roomId: "99",
    seat: 3,
    urlSeat: 12,
    storage: { getItem: (key) => values.get(key) ?? null },
    runner: { getStatus: () => ({ state: "completed", picks: Array(15).fill({}) }) },
  });
  assert.deepEqual([...payload.extensionReceipts.map((entry) => entry.kind)], ["keep"]);
  assert.deepEqual([...payload.runnerReceipts.map((entry) => entry.kind)], ["runner"]);
  assert.deepEqual([...payload.controllerReceipts.map((entry) => entry.kind)], ["controller"]);
  assert.equal(payload.urlSeat, 12);
  assert.equal(payload.status.state, "completed");
});

test("manifest has only the two public-mock surfaces plus the exact verified test league and no broad permissions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.6.1");
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.background, { service_worker: "extension/command-center-background.js" });
  assert.deepEqual(manifest.web_accessible_resources, [{
    resources: ["extension/assets/skrodzkai-enterprises-blue.png", "extension/assets/skrodzkai-globe-mark.png"],
    matches: ["https://football.fantasysports.yahoo.com/*"],
  }]);
  assert.deepEqual(manifest.content_scripts[0].matches, [
    "https://football.fantasysports.yahoo.com/f1/mock_waiting*",
    "https://football.fantasysports.yahoo.com/f1/18599/settings*",
    "https://football.fantasysports.yahoo.com/f1/18599/draft*",
    "https://football.fantasysports.yahoo.com/draftclient/f1/*",
  ]);
  assert.deepEqual(manifest.content_scripts[0].exclude_matches, [
    "https://football.fantasysports.yahoo.com/draftclient/f1/420010/*",
  ]);
  assert.equal(manifest.content_scripts[0].world, undefined);
  assert.deepEqual(manifest.content_scripts[0].js, [
    "controller/yahoo-draft-controller.js",
    "controller/yahoo-mock-runner.js",
    "extension/yahoo-mock-board.js",
    "extension/yahoo-mock-extension.js",
  ]);
});

test("popup command center uses the canonical blue SKRODZKai app language and a local relay", () => {
  assert.match(popupHtml, /skrodzkai-enterprises-blue\.png/);
  assert.match(popupHtml, /Draft Command Center/);
  assert.match(popupCss, /--blue:#0a84ff/);
  assert.match(popupCss, /--cyan:#63d9ff/);
  assert.match(popupCss, /Avenir Next/);
  assert.doesNotMatch(`${popupCss}\n${source}`, /#ffd60a|240,186,82|--gold|--yellow/);
  assert.match(popupSource, /NO YAHOO RUNNER/);
  assert.match(popupSource, /runnerMissing/);
  assert.match(backgroundSource, /type:\s*"popup"/);
  assert.match(backgroundSource, /width:\s*1180/);
  assert.match(backgroundSource, /skz\.popupWindowId/);
  assert.match(backgroundSource, /skz\.tabId/);
  assert.match(backgroundSource, /chrome\.tabs\.sendMessage/);
  assert.match(source, /open_command_center/);
  assert.match(source, /skrodzkai-globe-mark\.png/);
});

test("war-room roster placement respects exact and flex slots rather than pick order", () => {
  const roster = helpers.buildUiRoster([
    { yahooId: "r", name: "Runner", position: "RB" },
    { yahooId: "q", name: "Quarterback", position: "QB" },
    { yahooId: "t", name: "Tight End", position: "TE" },
  ], helpers.testRosterSlots);
  assert.equal(roster.find((entry) => entry.slot === "QB")?.player?.yahooId, "q");
  assert.equal(roster.find((entry) => entry.slot === "RB")?.player?.yahooId, "r");
  assert.equal(roster.find((entry) => entry.slot === "W/R/T")?.player?.yahooId, "t");
});

test("war-room recommendations show only the resolved live ladder with real metrics", () => {
  const board = [{ yahooId: "1", name: "One", position: "RB", team: "BUF", confidence: "MULTI_SOURCE" }];
  assert.deepEqual([...helpers.buildUiRecommendations(board, null)], []);
  const [recommendation] = helpers.buildUiRecommendations(board, {
    targetYahooIds: ["1"],
    positionLeaders: [{ player: { yahooId: "1" }, bucket: "likely_gone", adjustedScore: 8.25 }],
  });
  assert.equal(recommendation.edge, "+8.3");
  assert.equal(recommendation.confidence, "MULTI_SOURCE");
  assert.match(recommendation.reason, /likely_gone/);
  const [manual] = helpers.buildUiRecommendations(board, {
    targetYahooIds: ["1"],
    manualOverride: { status: "applied", chosenYahooId: "1" },
    positionLeaders: [],
  });
  assert.equal(manual.manual, true);
  assert.match(manual.reason, /operator pin validated/);
});

test("opponent window stays honest about TEST-room history while exposing the snake horizon", () => {
  const window = helpers.buildUiOpponentWindow({
    currentPick: 17,
    nextPick: 32,
    interveningOpponentPicks: 14,
    positionLeaders: [
      { bucket: "likely_gone", player: { name: "Alpha", position: "RB" } },
      { bucket: "likely_available", player: { name: "Beta", position: "WR" } },
    ],
  }, "TEST");
  assert.equal(window.currentPick, 17);
  assert.equal(window.nextPick, 32);
  assert.equal(window.intervening, 14);
  assert.deepEqual([...window.atRisk], ["Alpha (RB)"]);
  assert.match(window.managerNote, /2 Minute Drillers.*intentionally withheld/);
});

test("bundled board contains unique current IDs and complete observed offense ranges", () => {
  const board = context.SKRODZKaiYahooMockBoard;
  assert.ok(board.offense.length >= 100);
  assert.ok(board.kickers.length >= 12);
  assert.equal(board.defenses.length, 32);
  assert.ok(board.idp.length >= 36);
  const ids = [...board.offense, ...board.kickers].map((player) => String(player.yahooId));
  assert.equal(new Set(ids).size, ids.length);
  assert.match(board.source, /v5 free-source board/);
  for (const player of board.offense) {
    assert.equal(Number.isFinite(player.vor), true);
    assert.equal(Number.isFinite(player.adpLow), true);
    assert.equal(Number.isFinite(player.adpHigh), true);
    assert.equal(player.confidence, "MULTI_SOURCE");
  }
});

test("extension contains no network or remote-model execution path", () => {
  for (const bundledSource of [source, boardSource, controllerSource, runnerSource, popupSource, backgroundSource]) {
    assert.doesNotMatch(bundledSource, /\bfetch\s*\(/);
    assert.doesNotMatch(bundledSource, /XMLHttpRequest|WebSocket|EventSource/);
    assert.doesNotMatch(bundledSource, /openrouter|anthropic|openai/i);
  }
  assert.doesNotMatch(`${popupSource}\n${backgroundSource}`, /https?:\/\//);
  assert.doesNotMatch(source, />HIDE</);
});

test("war-room mode allowlist fails closed for REAL and league 420010", () => {
  const allowed = helpers.modeAllowlist({ mode: "MOCK", leagueId: "9391926" });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.mode, "MOCK");
  assert.equal(allowed.leagueId, "9391926");
  assert.equal(helpers.modeAllowlist({ mode: "REAL", leagueId: "9391926" }).allowed, false);
  assert.equal(helpers.modeAllowlist({ mode: "TEST", leagueId: "420010" }).allowed, false);
  assert.equal(helpers.parseWaitingRoom(waitingFixture().document, {
    pathname: "/f1/mock_waiting",
    search: "?mlid=420010",
  }).ready, false);
});

test("manual override pins exact Yahoo IDs to the next room-bound round without clicking", () => {
  const values = new Map();
  const storage = { setItem: (key, value) => values.set(key, value) };
  const stage = helpers.stageManualTargets(storage, [
    { yahooId: "40168", name: "Puka Nacua", position: "WR", team: "LAR" },
    { yahooId: "40059", name: "Jahmyr Gibbs", position: "RB", team: "DET" },
  ], { roomId: "9391926", seat: 7, expectedRound: 4 }, "2026-08-22T00:00:00.000Z");
  assert.deepEqual(stage.targets.map((target) => target.yahooId), ["40168", "40059"]);
  assert.equal(stage.expectedRound, 4);
  assert.equal(JSON.parse(values.get("skrodzkai-yahoo-mock-manual-stage-v1")).roomId, "9391926");
  assert.throws(() => helpers.stageManualTargets(storage, [{ yahooId: "40168" }], { roomId: "9391926", seat: 7 }), /next round/);
  assert.throws(() => helpers.validateExactYahooTargets([{ yahooId: "Puka" }]), /exact Yahoo ID/);
  assert.throws(() => helpers.validateExactYahooTargets([{ yahooId: "40168" }, { yahooId: "40168" }]), /duplicated/);
});

test("popup command-center rendering exposes the operations, override, intel, and kill surfaces", () => {
  const combinedUi = `${source}\n${popupHtml}`;
  for (const label of [
    "Draft Command Center", "FANTASY OPERATIONS", "League", "Room", "Seat", "Round / Pick", "Clock",
    "Armed", "Autodraft", "Kill switch", "Our roster", "Decision ladder", "Opponent window",
    "Next-pick override", "Warnings", "Decision receipts", "Pin next pick", "KILL SWITCH",
  ]) assert.match(combinedUi, new RegExp(label.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")));
  assert.match(combinedUi, /width: min\(380px, calc\(100vw - 32px\)\)/);
  assert.match(popupCss, /grid-template-columns:250px minmax\(390px,1fr\) 300px/);
  assert.match(source, /rail\.setRoster\(TEST_ROSTER_SLOTS\.map/);
});
