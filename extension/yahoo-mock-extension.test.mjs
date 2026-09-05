import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { sourceRuntimeAttestation } from "../analysis/runtime-attestation.mjs";
import { withScoringTable, scoringRows } from "../tests/fixtures/league-two-settings.mjs";

const source = await readFile(new URL("./yahoo-mock-extension.js", import.meta.url), "utf8");
const boardSource = await readFile(new URL("./yahoo-mock-board.js", import.meta.url), "utf8");
const controllerSource = await readFile(new URL("../controller/yahoo-draft-controller.js", import.meta.url), "utf8");
const readersSource = await readFile(new URL("../controller/yahoo-page-readers.js", import.meta.url), "utf8");
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
vm.runInContext(readersSource, context);
vm.runInContext(runnerSource, context);
vm.runInContext(source, context);
vm.runInContext(boardSource, context);
const helpers = context.SKRODZKaiYahooMockExtension._test;

test("TEST preflight checks every scoring row, rejects added/missing rows, and ignores Yahoo-default values", () => {
  const doc = { body:{ innerText:"League Name:\tLeague Two\nDraft Type:\tLive Standard Draft\nMax Teams:\t12\nLive Draft Pick Time:\t1 Minute\nPassing Touchdowns\t4\nReceptions\t0.5\nRoster Positions:\tQB, WR, WR, WR, RB, RB, TE, W/R/T, W/R/T, K, DEF, D, D, BN, BN, BN, BN, BN, BN, IR, IR, IR" } };
  const parse = (rows) => helpers.parseTestSettings(withScoringTable(doc, rows), { pathname:"/f1/542830/settings" });
  assert.equal(parse(scoringRows).ready, true);
  for (let index = 0; index < scoringRows.length; index++) {
    if (scoringRows[index][1] === "League Value") continue;
    const changed = structuredClone(scoringRows);
    changed[index][1] = "999";
    assert.equal(parse(changed).ready, false, scoringRows[index][0]);
    assert.equal(parse(scoringRows.filter((_, offset) => offset !== index)).ready, false);
  }
  assert.equal(parse([...scoringRows, ["Unexpected scoring", "1"]]).ready, false);
  const defaults = scoringRows.map((row) => row.length === 3 && row[1] !== "League Value" ? [row[0], row[1], "999"] : row);
  assert.equal(parse(defaults).ready, true, "only the league-value column is authoritative");
  const receipt = helpers.makeTestSettingsReceipt(parse(scoringRows), 1000);
  assert.equal(helpers.validTestSettingsReceipt({ ...receipt, scoringSchemaHash:null }, 1001), false);
  assert.equal(helpers.validTestSettingsReceipt({ ...receipt, scoringSchemaHash:"a".repeat(64) }, 1001), false);
});
const backgroundContext = { Date, TextEncoder, URL };
backgroundContext.globalThis = backgroundContext;
vm.createContext(backgroundContext);
vm.runInContext(backgroundSource, backgroundContext);
const backgroundHelpers = backgroundContext.SKRODZKaiCommandCenterBackground;

function memorySession(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.filter((key) => values.has(key)).map((key) => [key, values.get(key)]));
    },
    async set(update) { for (const [key, value] of Object.entries(update)) values.set(key, value); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); },
    value(key) { return values.get(key); },
  };
}

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

function healthyBoard(now = 1_000) {
  return {
    generatedAt: new Date(now - 100).toISOString(),
    marketAdpReceipt: { observedAt:new Date(now - 100).toISOString(), sourceAsOf:new Date(now - 100).toISOString(), rows:218 },
    injuryCoverage: { complete:true, checkedPlayers:872, expectedPlayers:872 },
    byeCoverage: { complete:true, playersWithBye:872, playersTotal:872 },
    players: Array.from({ length:6 }, (_, index) => ({ yahooId:String(index + 1) })),
  };
}

function memoryLocalStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
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
  const board = healthyBoard();
  const armRecord = helpers.makePreflight(snapshot, 1_000, board);
  assert.equal(armRecord.expiresAt, 1_801_000);
  assert.equal(helpers.validateDraftPreflight(armRecord, { roomId: "9391926", seat: 7 }, 1_001, board), null);
  assert.equal(helpers.validateDraftPreflight(armRecord, { roomId: "9391926", seat: 6 }, 1_001, board), "draft_room_or_url_team_changed");
  assert.equal(helpers.validateDraftPreflight(armRecord, { roomId: "9391927", seat: 7 }, 1_001, board), "draft_room_or_url_team_changed");
  assert.equal(helpers.validateDraftPreflight(armRecord, { roomId: "9391926", seat: 7 }, armRecord.expiresAt, healthyBoard(armRecord.expiresAt)), "draft_arm_expired");
  assert.equal(helpers.validateDraftPreflight(null, { roomId: "9391926", seat: 7 }, 1_001), "approved_draft_arm_required");
});

test("board health is a single fail-closed arm gate with visible freshness and coverage", () => {
  const now = Date.parse("2026-08-27T18:00:00Z");
  const board = healthyBoard(now);
  assert.equal(helpers.boardHealthGate(board, now), null);
  const futureBoard = { ...board, generatedAt:new Date(now + 15 * 60 * 1_000 + 1).toISOString() };
  assert.equal(helpers.boardHealthGate(futureBoard, now), "draft_board_timestamp_in_future");
  assert.equal(helpers.boardHealthGate({ ...board, generatedAt:"2026-08-26T17:59:59Z" }, now), "draft_board_stale_over_24h");
  assert.equal(helpers.boardHealthGate({ ...board, injuryCoverage:{ complete:false } }, now), "draft_board_injury_coverage_incomplete");
  assert.equal(helpers.boardHealthGate({ ...board, injuryCoverage:{ complete:true, checkedPlayers:871, expectedPlayers:872 } }, now), "draft_board_injury_coverage_incomplete");
  assert.equal(helpers.boardHealthGate({ ...board, injuryCoverage:{ complete:true, checkedPlayers:873, expectedPlayers:873 } }, now), "draft_board_injury_coverage_incomplete");
  assert.equal(helpers.boardHealthGate({ ...board, byeCoverage:{ complete:false, playersWithBye:871, playersTotal:872 } }, now), "draft_board_bye_coverage_incomplete");

  const snapshot = helpers.parseWaitingRoom(waitingFixture().document, waitingFixture().location);
  assert.throws(() => helpers.makePreflight(snapshot, now, { ...board, injuryCoverage:{ complete:false } }), /draft_board_injury_coverage_incomplete/);
  const preflight = helpers.makePreflight(snapshot, now, board);
  assert.equal(helpers.validateDraftPreflight(preflight, { roomId:"9391926", seat:7 }, now, futureBoard), "draft_board_timestamp_in_future");

  const localStorage = memoryLocalStorage();
  const rendered = [];
  const events = [];
  helpers.refuseArmForBoardHealth({ localStorage, SKRODZKaiYahooMockBoard:futureBoard }, {
    setWarnings(warnings) { rendered.push({ warnings }); },
    render(...args) { rendered.push({ render:args }); },
    addEvent(...args) { events.push(args); },
  }, { kind:"mock_arm_refused", roomId:"9391926", seat:7, expectedRosterTotal:15 }, new Error("draft_board_timestamp_in_future"));
  const receipts = JSON.parse(localStorage.getItem("skrodzkai-yahoo-mock-extension-receipts-v1"));
  assert.equal(receipts.at(-1).kind, "mock_arm_refused");
  assert.equal(receipts.at(-1).failure, "draft_board_timestamp_in_future");
  assert.deepEqual(rendered.find((entry) => entry.render)?.render, ["bad", "BOARD HEALTH LOCKED", "draft_board_timestamp_in_future"]);
  assert.deepEqual(events.at(-1), ["arm refused", "draft_board_timestamp_in_future"]);
  assert.equal((source.match(/kind: "mock_arm_refused"/g) ?? []).length, 1);
  assert.equal((source.match(/kind: "test_arm_refused"/g) ?? []).length, 1);
  assert.match(source, /const preflightError = validateDraftPreflight\([\s\S]*kind: "extension_locked"[\s\S]*failure: preflightError/);
  const signalBoard = {
    ...board,
    draftSignalOverlay: { projectionUnchanged:true, roleAudit:{ rosterMatched:188, uniqueTargets:188, totalTargets:190 }, market:{ coverageStatus:"NO_ELIGIBLE_LINES_CAPTURED" } },
    players: board.players.map((player, index) => index ? player : { ...player, name:"Signal Player", draftSignals:{ warnings:["CURRENT_ROLE_WATCH"] } }),
  };
  const warnings = helpers.buildUiWarnings({
    room:{ roomId:"9391926", seat:7 }, armRecord:null, autodraft:false, roster:{ total:15 }, board:signalBoard.players, boardData:signalBoard, decision:{ targetYahooIds:["1"] }, expectedRosterTotal:15, now,
  });
  assert.ok(warnings.some((warning) => /Data as-of/.test(warning.text)));
  assert.ok(warnings.some((warning) => /Injury coverage: COMPLETE/.test(warning.text)));
  assert.ok(warnings.some((warning) => /Bye coverage: COMPLETE · 872\/872/.test(warning.text)));
  assert.ok(warnings.some((warning) => /Ranking overlay: PROJECTION-SAFE · role 188\/188 · market NO_ELIGIBLE_LINES_CAPTURED/.test(warning.text)));
  assert.ok(warnings.some((warning) => /Signal Player: CURRENT_ROLE_WATCH/.test(warning.text)));
});

test("binds League Two team 3 while keeping its live field size and snake slot separate", () => {
  const settingsDocument = {
    body: {
      innerText: "League Name:\tLeague Two\nDraft Type:\tLive Standard Draft\nMax Teams:\t12\nLive Draft Pick Time:\t1 Minute\nPassing Touchdowns\t4\nReceptions Yahoo Default\t1\t0.5\nRoster\u00a0Positions:\tQB, WR, WR, WR, RB, RB, TE, W/R/T, W/R/T, K, DEF, D, D, BN, BN, BN, BN, BN, BN, IR, IR, IR",
    },
  };
  const settingsSnapshot = helpers.parseTestSettings(withScoringTable(settingsDocument), { pathname: "/f1/542830/settings" });
  assert.equal(settingsSnapshot.ready, true);
  assert.equal(
    helpers.parseTestSettings({ body: { innerText: settingsDocument.body.innerText.replace("1 Minute\n", "1 Minute, 15 Seconds\n") } }, { pathname: "/f1/542830/settings" }).errors.includes("verified_test_clock_mismatch"),
    true,
  );
  const settingsReceipt = helpers.makeTestSettingsReceipt(settingsSnapshot, 1_000);
  assert.equal(helpers.validTestSettingsReceipt(settingsReceipt, 1_001), true);
  const document = {
    body: {
      innerText: "SKRODZKai\nLeague Two · 10 Teams · 19 Rounds · 1 minute\nYour Draft Position: 4th",
    },
  };
  const location = { pathname: "/f1/542830/draft" };
  const snapshot = helpers.parseTestDraftHome(document, location, settingsReceipt, 1_001);
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.urlSeat, 3);
  assert.equal(snapshot.teamCount, 10);
  assert.equal(snapshot.seat, 4);
  assert.equal(
    helpers.parseTestDraftHome({ body: { innerText: document.body.innerText.replace("1 minute\n", "1 minute 15 seconds\n") } }, location, settingsReceipt, 1_001).errors.includes("verified_test_summary_mismatch"),
    true,
  );
  assert.equal(helpers.parseTestDraftHome({ body: { innerText: document.body.innerText.replace("SKRODZKai", "Chef Joe") } }, location, settingsReceipt, 1_001).ready, false);
  assert.deepEqual([...snapshot.rosterSlots], [...helpers.testRosterSlots]);
  const board = healthyBoard();
  assert.throws(() => helpers.makeTestPreflight(snapshot, 1_000, board), /test_board_scoring_identity_mismatch/);
  const preflight = { version:context.SKRODZKaiYahooMockExtension.version, mode:"test_league_19_idp", roomId:"542830", urlSeat:3, seat:4, observedTeamCount:10, observedRosterSlots:snapshot.rosterSlots, expiresAt:14_401_000 };
  assert.equal(helpers.validateDraftPreflight(preflight, { roomId: "542830", seat: 3 }, 1_001, board), "test_board_scoring_identity_mismatch");
  assert.equal(helpers.validateDraftPreflight(preflight, { roomId: "542830", seat: 4 }, 1_001, board), "draft_room_or_url_team_changed");
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

test("qualifies the actual TEST prestart snake strip, not Yahoo team number as draft slot", () => {
  const first = [9,6,5,1,7,10,12,3,2,8,11,4].map(String);
  const ids = Array.from({ length:19 }, (_, round) => round % 2 ? [...first].reverse() : first).flat();
  const teams = ids.map((id) => ({ getAttribute:() => id, textContent:id === "3" ? "You" : `Team ${id}` }));
  const filters = [{ options:["All Positions", "Kickers", "Team Defenses", "Defensive Players"].map((label) => ({ textContent:label })) }];
  const buttons = [{ textContent:"Autodraft", querySelector:() => null }];
  const document = { title:"You pick 8th | Live NFL Draft | Yahoo Fantasy Sports",
    body:{ innerText:"League Two\nDraft Starting Soon\nYOUR TEAM (0/19)\nYour queue is empty." },
    querySelectorAll:(selector) => selector === '.ys-team[data-id]' ? teams : selector === "select" ? filters : selector === "button" ? buttons : [] };
  // Build the exact existing settings receipt, retaining its validation fields.
  const settingsDocument = { body:{ innerText:"League Name:\tLeague Two\nDraft Type:\tLive Standard Draft\nMax Teams:\t12\nLive Draft Pick Time:\t1 Minute\nPassing Touchdowns\t4\nReceptions Yahoo Default\t1\t0.5\nRoster Positions:\tQB, WR, WR, WR, RB, RB, TE, W/R/T, W/R/T, K, DEF, D, D, BN, BN, BN, BN, BN, BN, IR, IR, IR" } };
  const receipt = helpers.makeTestSettingsReceipt(helpers.parseTestSettings(withScoringTable(settingsDocument), { pathname:"/f1/542830/settings" }), 1_000);
  const location = { pathname:"/draftclient/f1/542830/3" };
  const parse = (doc = document, loc = location, r = receipt) => helpers.parseTestDraftClient(doc, loc, r, 1_001);
  assert.deepEqual([...helpers.requiredTestFilterLabels()], ["All Positions", "Kickers", "Team Defenses", "Defensive Players"]);
  assert.equal(parse().ready, true);
  assert.equal(parse().seat, 8);
  assert.equal(parse().urlSeat, 3);
  assert.equal(parse().teamCount, 12);
  assert.throws(() => helpers.makeTestPreflight(parse(), 1_001, healthyBoard()), /test_board_scoring_identity_mismatch/);
  assert.equal(parse(document, { pathname:"/draftclient/f1/420010/3" }).ready, false);
  assert.equal(parse(document, { pathname:"/draftclient/f1/542830/8" }).ready, false);
  assert.equal(parse(document, location, null).ready, false);
  assert.equal(parse(document, location, { ...receipt, expiresAt:1_000 }).ready, false);
  assert.equal(parse({ ...document, title:document.title.replace("8th", "3rd") }).ready, false);
  assert.equal(parse({ ...document, body:{ innerText:document.body.innerText.replace("0/19", "1/19") } }).ready, false);
  assert.equal(parse({ ...document, body:{ innerText:document.body.innerText.replace("Draft Starting Soon", "YOUR TURN • ROUND 1, PICK 8") } }).ready, false);
  assert.equal(parse({ ...document, body:{ innerText:document.body.innerText.replace("Your queue is empty.", "Queue has one player") } }).ready, false);
  buttons[0].querySelector = () => ({});
  assert.equal(parse().ready, false);
  buttons[0].querySelector = () => null;
  buttons.push(buttons[0]);
  assert.equal(parse().ready, false);
  buttons.pop();
  filters[0].options.pop();
  assert.equal(parse().ready, false);
  filters[0].options.push({ textContent:"Defensive Players" });
  teams[12] = teams[13];
  assert.equal(parse().ready, false);
  teams.pop();
  assert.equal(parse().ready, false);
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
    runtimeAttestation:{ ok:true, version:"0.16.3", digest:"a".repeat(64), bootId:"boot-12345678", bootedAt:1 },
    operatorAttestation: helpers.makeOperatorAttestation("NONE", "2026-08-23T21:00:00.000Z"),
  });
  assert.deepEqual([...payload.extensionReceipts.map((entry) => entry.kind)], ["keep"]);
  assert.deepEqual([...payload.runnerReceipts.map((entry) => entry.kind)], ["runner"]);
  assert.deepEqual([...payload.controllerReceipts.map((entry) => entry.kind)], ["controller"]);
  assert.equal(payload.urlSeat, 12);
  assert.equal(payload.status.state, "completed");
  assert.equal(payload.operatorAttestation.status, "none");
  assert.equal(payload.runtimeAttestation.bootId, "boot-12345678");
});

test("manifest has only the two public-mock surfaces plus the exact verified test league and no broad permissions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.16.3");
  for (const path of ["./yahoo-mock-extension.js", "./yahoo-real-shadow.js", "../analysis/test-draft-acceptance.mjs"]) {
    const versionedSource = await readFile(new URL(path, import.meta.url), "utf8");
    const version = versionedSource.match(/const (?:EXTENSION_)?VERSION = "([^"]+)";/)?.[1];
    assert.equal(version, manifest.version, `${path} must agree with the installed manifest`);
  }
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.background, { service_worker: "extension/command-center-background.js" });
  assert.deepEqual(manifest.web_accessible_resources, [{
    resources: ["extension/assets/skrodzkai-enterprises-blue.png", "extension/assets/skrodzkai-globe-mark.png"],
    matches: ["https://football.fantasysports.yahoo.com/*"],
  }]);
  assert.deepEqual(manifest.content_scripts[0].matches, [
    "https://football.fantasysports.yahoo.com/f1/mock_waiting*",
    "https://football.fantasysports.yahoo.com/f1/542830/settings*",
    "https://football.fantasysports.yahoo.com/f1/542830/draft*",
    "https://football.fantasysports.yahoo.com/f1/542830/3",
    "https://football.fantasysports.yahoo.com/f1/542830/3/*",
    "https://football.fantasysports.yahoo.com/draftclient/f1/*",
  ]);
  assert.deepEqual(manifest.content_scripts[0].exclude_matches, [
    "https://football.fantasysports.yahoo.com/draftclient/f1/420010/*",
  ]);
  assert.equal(manifest.content_scripts[0].world, undefined);
  assert.deepEqual(manifest.content_scripts[0].js, [
    "controller/yahoo-page-readers.js",
    "controller/yahoo-draft-controller.js",
    "controller/yahoo-mock-runner.js",
    "extension/yahoo-mock-board.js",
    "extension/yahoo-mock-extension.js",
  ]);
  assert.deepEqual(manifest.content_scripts[1].matches, [
    "https://football.fantasysports.yahoo.com/f1/420010/settings*",
    "https://football.fantasysports.yahoo.com/f1/420010/draft*",
    "https://football.fantasysports.yahoo.com/f1/420010/7",
    "https://football.fantasysports.yahoo.com/f1/420010/7/*",
    "https://football.fantasysports.yahoo.com/draftclient/f1/420010/7",
    "https://football.fantasysports.yahoo.com/draftclient/f1/420010/7/*",
  ]);
  assert.deepEqual(manifest.content_scripts[1].js, [
    "controller/yahoo-page-readers.js",
    "extension/yahoo-mock-board.js",
    "extension/yahoo-real-shadow.js",
  ]);
  assert.equal(manifest.content_scripts[1].js.includes("controller/yahoo-mock-runner.js"), false);
  assert.equal(manifest.content_scripts[1].js.includes("controller/yahoo-draft-controller.js"), false);
  assert.equal(manifest.content_scripts[1].js.includes("extension/yahoo-mock-extension.js"), false);
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
  assert.match(backgroundSource, /skz\.runnerTabId/);
  assert.match(backgroundSource, /tabs\.sendMessage/);
  assert.match(source, /open_command_center/);
  assert.match(source, /skrodzkai-globe-mark\.png/);
  assert.match(popupSource, /ON_CLOCK/);
  assert.match(popupSource, /NEXT_PICK/);
  assert.match(popupSource, /UNKNOWN \/ BLOCKED/);
  assert.match(source, /on_clock_command_intent_mismatch/);
  assert.match(source, /next_pick_command_intent_mismatch/);
  assert.match(source, /manual_command_rejected/);
});

test("synthetic Travis Hunter identities cannot be sent to Yahoo", () => {
  assert.throws(() => helpers.validateExactYahooTargets([{ yahooId:"99001", name:"Travis Hunter", position:"WR", team:"JAX" }]), /synthetic identity/);
});

test("command-center relay binds kill and pin to the runner tab even when an arm page keeps publishing", async () => {
  const session = memorySession();
  let now = 100;
  const router = backgroundHelpers.createStateRouter(session, () => now);
  await router.handleState({ role:"arm-owner", at:now, snapshot:{ label:"READY TO ARM" } }, { tab:{ id:11 } });
  now = 101;
  await router.handleState({ role:"runner", at:now, snapshot:{ label:"RUNNING" }, board:[{ yahooId:"1" }] }, { tab:{ id:22 } });
  now = 102;
  await router.handleState({ role:"arm-owner", at:now, snapshot:{ label:"READY TO ARM" } }, { tab:{ id:11 } });
  assert.equal(session.value("skz.snapshot").label, "RUNNING");
  assert.equal(await router.targetTab("kill"), 22);
  assert.equal(await router.targetTab("pin"), 22);
  assert.equal(await router.targetTab("arm"), 11);
  await router.removeTab(22);
  assert.equal(session.value("skz.snapshot").label, "READY TO ARM");
  assert.equal(await router.targetTab("kill"), null);
});

test("command-center relay grants one fresh runner tab and rejects a competing tab", async () => {
  const session = memorySession();
  let now = 100;
  const router = backgroundHelpers.createStateRouter(session, () => now);
  assert.equal(await router.handleState({ role:"runner", at:now, snapshot:{ label:"RUNNING" } }, { tab:{ id:22 } }), true);
  now = 101;
  assert.equal(await router.handleState({ role:"runner", at:now, snapshot:{ label:"COMPETING" } }, { tab:{ id:23 } }), false);
  assert.equal(session.value("skz.runnerTabId"), 22);
  assert.equal(session.value("skz.snapshot").label, "RUNNING");
  now = 4001;
  assert.equal(await router.handleState({ role:"runner", at:now, snapshot:{ label:"REPLACEMENT" } }, { tab:{ id:23 } }), true);
  assert.equal(session.value("skz.runnerTabId"), 23);
});

test("command-center relay can arm an exact live TEST runner when no overview arm page remains", async () => {
  const session = memorySession();
  const router = backgroundHelpers.createStateRouter(session, () => 100);
  await router.handleState({ role:"runner", at:100, snapshot:{ label:"READY TO ARM TEST" } }, { tab:{ id:22 } });
  assert.equal(await router.targetTab("arm"), 22);
});

test("REAL SHADOW can never receive mutation commands or overwrite the live board", async () => {
  const session = memorySession({ "skz.board":[{ yahooId:"test" }] });
  let now = 100;
  const router = backgroundHelpers.createStateRouter(session, () => now);
  await router.handleState({ role:"shadow", at:now, snapshot:{ mode:"REAL SHADOW", label:"READ ONLY" }, board:[{ yahooId:"real" }] }, { tab:{ id:33 } });
  assert.deepEqual(session.value("skz.board"), [{ yahooId:"test" }]);
  assert.equal(await router.targetTab("arm"), null);
  assert.equal(await router.targetTab("pin"), null);
  assert.equal(await router.targetTab("kill"), null);
  assert.equal(await router.targetTab("export"), null);
  now = 101;
  await router.handleState({ role:"runner", at:now, snapshot:{ label:"RUNNING" }, board:[{ yahooId:"test-2" }] }, { tab:{ id:22 } });
  now = 102;
  await router.handleState({ role:"shadow", at:now, snapshot:{ mode:"REAL SHADOW", label:"READ ONLY" } }, { tab:{ id:33 } });
  assert.equal(session.value("skz.snapshot").label, "RUNNING");
  assert.equal(await router.targetTab("export"), 22);
});

test("background exposes session storage to isolated content scripts", () => {
  const access = [];
  const session = { ...memorySession(), setAccessLevel(options) { access.push(options); return Promise.resolve(); } };
  const chromeApi = {
    storage:{ session },
    runtime:{ getManifest:() => ({ version:"0.16.3" }), getURL:(value) => value, onMessage:{ addListener() {} } },
    windows:{ onRemoved:{ addListener() {} }, update:async () => {}, create:async () => ({ id:1 }) },
    tabs:{ onRemoved:{ addListener() {} }, sendMessage:async () => ({ ok:true }) },
  };
  backgroundHelpers.register(chromeApi);
  assert.equal(access.length, 1);
  assert.equal(access[0].accessLevel, "TRUSTED_AND_UNTRUSTED_CONTEXTS");
});

test("command-center bridge sends content changes separately from its stable heartbeat", () => {
  const messages = [];
  let tick = null;
  const runtime = { sendMessage(message) { messages.push(message); return Promise.resolve({ ok:true }); }, onMessage:{ addListener() {}, removeListener() {} } };
  const rail = { getSnapshot:() => ({ label:"RUNNING", board:[{ yahooId:"1" }] }), setOpenHandler() {}, command() { return true; } };
  helpers.attachCommandCenterBridge({ chrome:{ runtime }, location:{ pathname:"/draftclient/f1/123/4" }, setInterval(callback) { tick = callback; return 1; }, clearInterval() {} }, rail);
  assert.equal(helpers.commandCenterRole("/draftclient/f1/123/4"), "runner");
  assert.equal(helpers.commandCenterRole("/f1/mock_waiting"), "arm-owner");
  assert.equal(helpers.commandCenterRole("/f1/542830/3"), "arm-owner");
  assert.equal(messages[0].role, "runner");
  assert.equal(messages[0].snapshot.label, "RUNNING");
  tick();
  assert.equal(messages[1].snapshot, undefined);
  assert.equal(messages[1].board, undefined);
  assert.equal(Number.isFinite(messages[1].at), true);
});

test("runner lease tolerates a one-second timer gap but never extends on a delayed ACK", async () => {
  let now = 10_000;
  const leaseContext = { Date:class extends Date { static now() { return now; } }, console };
  leaseContext.globalThis = leaseContext;
  vm.createContext(leaseContext);
  vm.runInContext(source, leaseContext);
  let acknowledge;
  let delayed = false;
  const runtime = { sendMessage() {
    return delayed ? new Promise((resolve) => { acknowledge = resolve; }) : Promise.resolve({ ok:true });
  }, onMessage:{ addListener() {}, removeListener() {} } };
  const rail = { getSnapshot:() => ({ board:[] }), setOpenHandler() {}, command() {} };
  const bridge = leaseContext.SKRODZKaiYahooMockExtension._test.attachCommandCenterBridge({
    chrome:{ runtime }, location:{ pathname:"/draftclient/f1/542830/3" }, setInterval:() => 1, clearInterval() {},
  }, rail);
  await bridge.claimRunner();
  now += 1500;
  assert.equal(bridge.hasFreshRunnerLease(), true);
  now = 10_000 + backgroundHelpers.HEARTBEAT_TTL_MS - 500;
  assert.equal(bridge.hasFreshRunnerLease(), true);
  now += 1;
  assert.equal(bridge.hasFreshRunnerLease(), false);
  delayed = true;
  const pending = bridge.publish();
  now += backgroundHelpers.HEARTBEAT_TTL_MS + 1;
  acknowledge({ ok:true });
  await pending;
  await Promise.resolve();
  assert.equal(bridge.hasFreshRunnerLease(), false, "old heartbeat ACK cannot reanimate an expired lease");
  bridge.stop();
});

test("bridge locks every action when Chrome invalidates the extension context", () => {
  let locked = "";
  let halted = "";
  const runtime = {
    sendMessage() { throw new Error("Extension context invalidated."); },
    onMessage:{ addListener() {}, removeListener() {} },
  };
  const rail = {
    getSnapshot:() => ({ label:"READY", board:[] }),
    controls:{ export:{} },
    setOpenHandler() {},
    command() { return true; },
    lock(reason) { locked = reason; },
  };
  const environment = {
    chrome:{ runtime },
    location:{ pathname:"/draftclient/f1/542830/3" },
    localStorage:{ getItem:() => null, setItem() {} },
    setInterval() { throw new Error("invalid bridge must not start a timer"); },
    clearInterval() {},
    __skrodzkaiYahooMockExtensionV1:{ runner:{ halt(reason) { halted = reason; } }, statusTimer:7 },
  };
  helpers.attachCommandCenterBridge(environment, rail);
  assert.match(locked, /Reload & Verify/);
  assert.equal(halted, "extension_context_invalidated");
  assert.equal((source.match(/if \(rail\.isLocked\(\)\) return false;/g) ?? []).length >= 4, true);
  assert.match(source, /for \(const observer of ui\.observers\) observer\.disconnect\(\)/);
  assert.match(source, /WAITING FOR FINAL ROSTER/);
});

test("version handshake requires the current installed background version", async () => {
  assert.equal((await helpers.requireCurrentExtensionVersion({ chrome:{ runtime:{ sendMessage:async () => ({ ok:true, version:"0.16.3", digest:"a".repeat(64), bootId:"boot-12345678", bootedAt:1 }) } } })).version, "0.16.3");
  await assert.rejects(
    helpers.requireCurrentExtensionVersion({ chrome:{ runtime:{ sendMessage:async () => ({ ok:true, version:"0.7.5" }) } } }),
    /extension_version_mismatch/,
  );
  await assert.rejects(
    helpers.requireCurrentExtensionVersion({ chrome:{ runtime:{ sendMessage() { throw new Error("invalidated"); } } } }),
    /extension_context_invalidated/,
  );
  assert.equal(backgroundHelpers.extensionVersion({ runtime:{ getManifest:() => ({ version:"0.16.3" }) } }), "0.16.3");
  const attestation = { ok:true, version:"0.16.3", digest:"a".repeat(64), bootId:"boot-12345678", bootedAt:1 };
  assert.equal(helpers.sameRuntimeAttestation(attestation, { ...attestation }), true);
  assert.equal(helpers.sameRuntimeAttestation(attestation, { ...attestation, bootId:"boot-87654321" }), false);
  assert.doesNotMatch(backgroundSource, /identify_arm_surface|tabs\.query/);
});

test("runtime attestation hashes the complete manifest-derived runtime set and survives worker restarts", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const derived = [...new Set([
    "manifest.json",
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap((entry) => entry.js),
    "extension/command-center.html",
    "extension/command-center.js",
    "extension/command-center.css",
  ])].sort();
  assert.deepEqual([...backgroundHelpers.RUNTIME_FILES].sort(), derived);

  const bytes = new TextEncoder();
  const digest = await backgroundHelpers.runtimeDigest(
    { runtime:{ getURL:(path) => path } },
    async (path) => bytes.encode(`fixture:${path}`),
    webcrypto,
    TextEncoder,
  );
  assert.match(digest, /^[a-f0-9]{64}$/);
  const sourceAttestation = await sourceRuntimeAttestation(fileURLToPath(new URL("..", import.meta.url)));
  assert.equal(sourceAttestation.version, "0.16.3");
  assert.match(sourceAttestation.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(sourceAttestation.files, [...backgroundHelpers.RUNTIME_FILES]);

  const session = memorySession();
  const chromeApi = { runtime:{ getManifest:() => ({ version:"0.16.3" }) }, storage:{ session } };
  let digestCalls = 0;
  const first = await backgroundHelpers.createRuntimeAttestor(chromeApi, {
    clock:() => 100,
    digest:async () => { digestCalls += 1; return digest; },
    randomId:() => "boot-12345678",
  }).current();
  const restartedWorker = await backgroundHelpers.createRuntimeAttestor(chromeApi, {
    clock:() => 200,
    digest:async () => { digestCalls += 1; return "b".repeat(64); },
    randomId:() => "boot-87654321",
  }).current();
  assert.deepEqual(restartedWorker, first);
  assert.equal(digestCalls, 1);
});

test("background reload gate permits only an idle TEST/MOCK sender and enforces cooldown", async () => {
  const sender = { tab:{ id:7, url:"https://football.fantasysports.yahoo.com/f1/542830/settings" }, url:"https://football.fantasysports.yahoo.com/f1/542830/settings" };
  const idleSession = memorySession();
  const idleRouter = backgroundHelpers.createStateRouter(idleSession, () => 20_000);
  assert.deepEqual(JSON.parse(JSON.stringify(await idleRouter.reloadGate(sender))), { ok:true });
  assert.deepEqual(JSON.parse(JSON.stringify(await idleRouter.reloadGate(sender))), { ok:false, error:"reload_cooldown_active" });

  const running = memorySession({ "skz.runnerSeenAt":20_000, "skz.runnerTabId":9 });
  assert.deepEqual(
    JSON.parse(JSON.stringify(await backgroundHelpers.createStateRouter(running, () => 20_000).reloadGate(sender))),
    { ok:false, error:"reload_refused_runner_active" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(await backgroundHelpers.createStateRouter(memorySession(), () => 20_000).reloadGate({ tab:{ id:8 }, url:"https://football.fantasysports.yahoo.com/f1/420010/settings" }))),
    { ok:false, error:"reload_sender_not_test_surface" },
  );
});

test("reload marker requires a new extension-session boot identity and remains fail closed", () => {
  const before = { ok:true, version:"0.16.3", digest:"a".repeat(64), bootId:"boot-before", bootedAt:100 };
  const marker = helpers.makeReloadMarker(before, 1_000);
  assert.equal(helpers.evaluateReloadMarker(marker, before, 1_001).status, "failed");
  const after = { ...before, bootId:"boot-after", bootedAt:200 };
  assert.equal(helpers.evaluateReloadMarker(marker, after, 1_001).status, "passed");
  assert.equal(helpers.evaluateReloadMarker(marker, after, marker.expiresAt + 1).status, "failed");
  assert.equal(helpers.reloadRefusal({ context:{ armed:true } }), "reload_refused_while_armed");
  assert.equal(helpers.reloadRefusal({ context:{ ownedTurn:true } }), "reload_refused_during_owned_turn");
  assert.equal(helpers.reloadRefusal({ context:{ autodraft:true } }), "reload_refused_while_autodraft_active");
  assert.equal(helpers.reloadRefusal({ context:{} }), null);
  assert.match(source, /\["reload", "export"\]\.includes\(name\)/);
  assert.match(backgroundSource, /if \(message\?\.type === "version_handshake"\)[\s\S]*?return true;/);
});

test("Reload & Verify locks Yahoo controls, writes a marker, asks the background, and refreshes the same tab", async () => {
  const attestation = { ok:true, version:"0.16.3", digest:"a".repeat(64), bootId:"boot-before", bootedAt:100 };
  const storage = memoryLocalStorage();
  const messages = [];
  let handler = null;
  let scheduled = null;
  let lockLabel = "";
  let reloads = 0;
  const rail = {
    setReloadHandler(value) { handler = value; },
    getSnapshot() { return { attestation, context:{ armed:false, ownedTurn:false, autodraft:false } }; },
    lock(_reason, label) { lockLabel = label; },
  };
  helpers.installReloadAndVerify({
    chrome:{ runtime:{ id:"extension-id", sendMessage(message) { messages.push(message); return Promise.resolve({ ok:true }); } } },
    sessionStorage:storage,
    location:{ reload() { reloads += 1; } },
    setTimeout(callback) { scheduled = callback; return 1; },
    clearTimeout() {},
  }, rail);
  assert.equal(handler(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lockLabel, "RELOAD VERIFYING");
  assert.equal(messages[0].type, "reload_extension");
  assert.equal(JSON.parse(storage.getItem("skrodzkai-runtime-reload-marker-v1")).bootId, "boot-before");
  scheduled();
  assert.equal(reloads, 1);

  const refusedStorage = memoryLocalStorage();
  let refusedHandler = null;
  let refusedLocked = false;
  let refusedPending = null;
  helpers.installReloadAndVerify({
    chrome:{ runtime:{ id:"extension-id", sendMessage:async () => ({ ok:false, error:"reload_refused_runner_active" }) } },
    sessionStorage:refusedStorage,
    location:{ reload() {} },
    setTimeout() { return 2; },
    clearTimeout() {},
  }, {
    setReloadHandler(value) { refusedHandler = value; },
    getSnapshot() { return { attestation, context:{} }; },
    lock() { refusedLocked = true; },
    setReloadPending(value) { refusedPending = value; },
    addEvent() {},
    render() {},
  });
  assert.equal(refusedHandler(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refusedLocked, false);
  assert.equal(refusedPending, false);
  assert.equal(refusedStorage.getItem("skrodzkai-runtime-reload-marker-v1"), null);
});

test("Reload & Verify is absent inside the live draft client", () => {
  let handler = "not-cleared";
  const controls = { reload:{ disabled:false, title:"" } };
  helpers.installReloadAndVerify({ location:{ pathname:"/draftclient/f1/542830/3" } }, {
    controls,
    setReloadHandler(value) { handler = value; },
  });
  assert.equal(handler, null);
  assert.equal(controls.reload.disabled, true);
  assert.match(controls.reload.title, /disabled inside the live Yahoo draft client/);
});

test("recommendation hotkeys resolve only during an owned-turn decision window", () => {
  const recommendations = [{ yahooId:"1" }, { yahooId:"2" }, { yahooId:"3" }];
  assert.equal(helpers.ownedTurnFromRunnerStatus({ pendingDecision:{ turn:"R1P6" } }), true);
  assert.equal(helpers.ownedTurnFromRunnerStatus({ pendingDecision:null }), false);
  assert.equal(helpers.recommendationHotkeyPlayer({ context:{ ownedTurn:false }, recommendations }, { key:"1", target:{} }), null);
  assert.equal(helpers.recommendationHotkeyPlayer({ context:{ ownedTurn:true }, recommendations }, { key:"2", target:{} })?.yahooId, "2");
  assert.equal(helpers.recommendationHotkeyPlayer({ context:{ ownedTurn:true }, recommendations }, { key:"1", target:{ tagName:"INPUT" } }), null);
  assert.match(popupSource, /state\?\.context\?\.ownedTurn===true/);
  assert.match(source, /ui\.context = \{ \.\.\.context, roomId \}/);
  assert.match(source, /getSnapshot\(\) \{\s*return \{ version:VERSION,[^}]*context:ui\.context/);
});

test("war-room roster placement respects exact and flex slots rather than pick order", () => {
  const roster = helpers.buildUiRoster([
    { yahooId: "r", name: "Runner", position: "RB" },
    { yahooId: "q", name: "Quarterback", position: "QB" },
    { yahooId: "t1", name: "Tight End One", position: "TE" },
    { yahooId: "t2", name: "Tight End Two", position: "TE" },
  ], helpers.testRosterSlots);
  assert.equal(roster.find((entry) => entry.slot === "QB")?.player?.yahooId, "q");
  assert.equal(roster.find((entry) => entry.slot === "RB")?.player?.yahooId, "r");
  assert.equal(roster.find((entry) => entry.slot === "TE")?.player?.yahooId, "t1");
  assert.equal(roster.find((entry) => entry.slot === "W/R/T")?.player?.yahooId, "t2");
});

test("war-room roster placement reproduces Yahoo generic-D priority", () => {
  const roster = helpers.buildUiRoster([
    { yahooId:"s", name:"Safety", position:"S" },
    { yahooId:"d", name:"Edge", position:"D" },
    { yahooId:"lb", name:"Linebacker", position:"LB" },
    { yahooId:"cb", name:"Corner", position:"CB" },
  ], helpers.testRosterSlots);
  const defensiveSlots = roster.filter((entry) => entry.slot === "D");
  assert.deepEqual(Array.from(defensiveSlots, (entry) => entry.player?.yahooId), ["s", "d"]);
  assert.deepEqual(Array.from(roster.filter((entry) => entry.slot === "BN" && entry.player), (entry) => entry.player.yahooId), ["lb", "cb"]);
});

test("final Yahoo roster parser records the observed slot and exact drafted player", () => {
  const picks = [
    { yahooId:"41883", name:"Xavier Watts", position:"S" },
    { yahooId:"33957", name:"Aidan Hutchinson", position:"D" },
  ];
  const row = (slot, name, yahooId, classNames = []) => ({
    classList:{ contains:(value) => classNames.includes(value) },
    querySelectorAll:(selector) => selector === "td" ? [{ innerText:slot }, { innerText:name || "(Empty)" }] : [],
    querySelector:() => name ? { textContent:name, getAttribute:() => `https://sports.yahoo.com/nfl/players/${yahooId}` } : null,
  });
  const observed = helpers.parseFinalRosterDocument({ querySelectorAll:() => [
    row("D", "Xavier Watts", "41883"),
    row("D", "", "", ["empty-position"]),
    row("BN", "Aidan Hutchinson", "33957"),
  ] }, picks);
  assert.deepEqual(JSON.parse(JSON.stringify(observed)), [
    { slot:"D", yahooId:"41883", name:"Xavier Watts", empty:false },
    { slot:"D", yahooId:null, name:null, empty:true },
    { slot:"BN", yahooId:"33957", name:"Aidan Hutchinson", empty:false },
  ]);
});

test("final roster accepts full DEF team names without fuzzy player identity", () => {
  const row = (slot, name) => ({
    querySelectorAll:() => [{ innerText:slot }, { innerText:name }],
    querySelector:() => ({ textContent:name, getAttribute:() => "https://sports.yahoo.com/nfl/teams/houston/" }),
  });
  const picks = [{ yahooId:"100034", name:"Texans", position:"DEF" }];
  const parse = (slot, name, candidates = picks) => helpers.parseFinalRosterDocument({ querySelectorAll:() => [row(slot, name)] }, candidates);
  assert.equal(parse("DEF", "Houston Texans")[0].yahooId, "100034");
  assert.throws(() => parse("WR", "Houston Texans"), /final_roster_player_unmatched/);
  assert.throws(() => parse("DEF", "Houston Texans", [{ ...picks[0], name:"Texan" }]), /final_roster_player_unmatched/);
  assert.throws(() => parse("DEF", ""), /final_roster_player_unmatched/);
  assert.throws(() => parse("DEF", "Houston Texans", [...picks, { ...picks[0], yahooId:"999", name:"Houston Texans" }]), /final_roster_player_unmatched/);
});

test("operator attestation is explicit none, explicit intervention, or missing", () => {
  assert.equal(helpers.makeOperatorAttestation("NONE").status, "none");
  assert.equal(helpers.makeOperatorAttestation("none").status, "missing");
  const intervention = helpers.makeOperatorAttestation("INTERVENTION: prevented Yahoo from taking Chase");
  assert.equal(intervention.status, "intervention");
  assert.equal(intervention.interventions[0].kind, "prevented_autodraft");
  assert.equal(helpers.makeOperatorAttestation(null).status, "missing");
});

test("war-room recommendations show only the resolved live ladder with real metrics", () => {
  const board = [{ yahooId: "1", name: "One", position: "K", team: "BUF", confidence: "MULTI_SOURCE", draftSignals:{ specialist:{ kind:"K", teamOffenseRank:3, week1ImpliedPoints:27.5 } } }];
  assert.deepEqual([...helpers.buildUiRecommendations(board, null)], []);
  const [recommendation] = helpers.buildUiRecommendations(board, {
    targetYahooIds: ["1"],
    positionLeaders: [{
      player: { yahooId: "1" },
      adjustedScore: 8.25,
      marginalUtility: 8.25,
      costOfWaiting: 2.1,
      pAvailableNext: 0.2,
    }],
  });
  assert.equal(recommendation.edge, "8.3");
  assert.equal(recommendation.confidence, "MULTI_SOURCE");
  assert.match(recommendation.reason, /BPA 8\.3 · wait 2\.1 · Pnext 20%/);
  assert.match(recommendation.reason, /K offense #3 · W1 implied 27\.5/);
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
      { pAvailableNext: 0.2, player: { name: "Alpha", position: "RB" } },
      { pAvailableNext: 0.8, player: { name: "Beta", position: "WR" } },
    ],
  }, "TEST");
  assert.equal(window.currentPick, 17);
  assert.equal(window.nextPick, 32);
  assert.equal(window.intervening, 14);
  assert.deepEqual([...window.atRisk], ["Alpha (RB)"]);
  assert.match(window.managerNote, /2 Minute Drillers.*intentionally withheld/);
});

test("bundled board contains unique IDs and labeled market evidence or fallback", () => {
  const board = context.SKRODZKaiYahooMockBoard;
  const offense = board.players.filter((player) => ["QB", "RB", "WR", "TE"].includes(player.position));
  const kickers = board.players.filter((player) => player.position === "K");
  const idp = board.players.filter((player) => ["D", "LB", "CB", "S"].includes(player.position));
  assert.ok(offense.length >= 100);
  assert.ok(kickers.length >= 12);
  assert.equal(board.defenses.length, 32);
  assert.ok(idp.length >= 36);
  const ids = [...offense, ...kickers].map((player) => String(player.yahooId));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(board.players.map((player) => String(player.yahooId))).size, board.players.length);
  const hunters = board.players.filter((player) => ["41787", "99001", "99002"].includes(String(player.yahooId)));
  assert.equal(hunters.map((player) => String(player.yahooId)).sort().join(","), "99001,99002");
  assert.ok(hunters.every((player) => player.automaticEligible === false));
  assert.ok(hunters.every((player) => player.manualEligible === true));
  assert.ok(hunters.every((player) => player.validationStatus === "DUAL_ROLE_SCORING_UNVERIFIED"));
  assert.match(board.source, /raw projections scored under exact league rules/);
  const automaticOffense = offense.filter((player) => player.automaticEligible);
  assert.ok(automaticOffense.length >= 100);
  assert.ok(automaticOffense.every((player) => player.confidence === "MULTI_SOURCE"));
  for (const player of offense) {
    assert.equal(Number.isFinite(player.vor), true);
    if (player.adpLow == null) {
      assert.equal(player.adpHigh, null);
      assert.equal(Number.isFinite(player.yahooRank) || Number.isFinite(player.valueRank), true);
    } else {
      assert.equal(Number.isFinite(player.adpLow), true);
      assert.equal(Number.isFinite(player.adpHigh), true);
    }
    assert.ok(["MULTI_SOURCE", "WITHHELD"].includes(player.confidence));
  }
  assert.ok([...kickers, ...idp].some((player) => player.validationStatus === "UNVALIDATED_SPECIALIST_PROJECTION"));
});

test("extension contains no network or remote-model execution path", () => {
  for (const bundledSource of [source, boardSource, controllerSource, runnerSource, popupSource]) {
    assert.doesNotMatch(bundledSource, /\bfetch\s*\(/);
    assert.doesNotMatch(bundledSource, /XMLHttpRequest|WebSocket|EventSource/);
    assert.doesNotMatch(bundledSource, /openrouter|anthropic|openai/i);
  }
  assert.equal((backgroundSource.match(/\bfetch\s*\(/g) ?? []).length, 1);
  assert.match(backgroundSource, /fetch\(chromeApi\.runtime\.getURL\(path\)\)/);
  assert.doesNotMatch(backgroundSource, /XMLHttpRequest|WebSocket|EventSource/);
  assert.doesNotMatch(backgroundSource, /openrouter|anthropic|openai/i);
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
    "Next-pick override", "Warnings", "Decision receipts", "Choose / Pin", "KILL SWITCH",
  ]) assert.match(combinedUi, new RegExp(label.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")));
  assert.match(combinedUi, /width: min\(380px, calc\(100vw - 32px\)\)/);
  assert.match(popupCss, /grid-template-columns:250px minmax\(390px,1fr\) 300px/);
  assert.match(source, /rail\.setRoster\(TEST_ROSTER_SLOTS\.map/);
});
