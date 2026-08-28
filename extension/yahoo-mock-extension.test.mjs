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
vm.runInContext(runnerSource, context);
vm.runInContext(source, context);
vm.runInContext(boardSource, context);
const helpers = context.SKRODZKaiYahooMockExtension._test;
const backgroundContext = { Date };
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
  assert.equal((source.match(/kind: "test_arm_refused"/g) ?? []).length, 2);
  assert.match(source, /const preflightError = validateDraftPreflight\([\s\S]*kind: "extension_locked"[\s\S]*failure: preflightError/);
  const warnings = helpers.buildUiWarnings({
    room:{ roomId:"9391926", seat:7 }, armRecord:null, autodraft:false, roster:{ total:15 }, board:board.players, boardData:board, expectedRosterTotal:15, now,
  });
  assert.ok(warnings.some((warning) => /Data as-of/.test(warning.text)));
  assert.ok(warnings.some((warning) => /Injury coverage: COMPLETE/.test(warning.text)));
  assert.ok(warnings.some((warning) => /Bye coverage: COMPLETE · 872\/872/.test(warning.text)));
});

test("binds the verified test league to team 12 while keeping the snake draft slot separate", () => {
  const settingsDocument = {
    body: {
      innerText: "League Name:\tHORSE COLLAR #2\nDraft Type:\tLive Standard Draft\nMax Teams:\t12\nLive Draft Pick Time:\t1 Minute, 15 Seconds\nPassing Touchdowns\t4\nReceptions Yahoo Default\t1\t0.5\nRoster\u00a0Positions:\tQB, WR, WR, RB, RB, W/R, W/R/T, K, DEF, D, LB, CB, S, BN, BN, BN, BN, BN, BN, IR, IR, IR",
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
  const board = healthyBoard();
  const preflight = helpers.makeTestPreflight(snapshot, 1_000, board);
  assert.equal(preflight.seat, 4);
  assert.equal(preflight.urlSeat, 12);
  assert.equal(preflight.expiresAt, 14_401_000);
  assert.equal(helpers.validateDraftPreflight(preflight, { roomId: "18599", seat: 12 }, 1_001, board), null);
  assert.equal(helpers.validateDraftPreflight(preflight, { roomId: "18599", seat: 4 }, 1_001, board), "draft_room_or_url_team_changed");
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

test("arms the exact TEST draftclient from its live slot while preserving Yahoo team identity", () => {
  const options = ["All Positions", "Kickers", "Team Defenses", "Defensive Players", "Linebackers", "Defensive Backs"]
    .map((textContent) => ({ textContent, value: textContent }));
  const select = { options };
  const document = {
    body: { innerText: "YAHOO FANTASY FOOTBALL DRAFT\nHORSE COLLAR #2\nYOUR TURN - 3RD PICK\nYOUR TURN - 22ND PICK\nYOUR TEAM (0/19)" },
    querySelectorAll(selector) { return selector === "select" ? [select] : []; },
  };
  const settingsReceipt = {
    roomId: "18599",
    observedTeamCount: 12,
    observedRosterSlots: [...helpers.testRosterSlots],
    observedFullRosterSlots: [...helpers.testRosterSlots, "IR", "IR", "IR"],
    expiresAt: 10_000,
  };
  const snapshot = helpers.parseTestDraftClient(document, { pathname: "/draftclient/f1/18599/12" }, settingsReceipt, 1_000);
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.seat, 3);
  assert.equal(snapshot.urlSeat, 12);
  assert.equal(snapshot.rosterSlots.length, 19);
  assert.deepEqual([...snapshot.missingFilters], []);
  assert.deepEqual([...helpers.requiredTestFilterLabels()], ["All Positions", "Kickers", "Team Defenses", "Defensive Players", "Linebackers", "Defensive Backs"]);
  assert.equal(helpers.makeTestPreflight(snapshot, 1_000, healthyBoard()).seat, 3);
  assert.equal(helpers.parseTestDraftClient(document, { pathname: "/draftclient/f1/420010/12" }, settingsReceipt, 1_000).ready, false);
  assert.equal(helpers.parseTestDraftClient({ ...document, body: { innerText: document.body.innerText.replace("0/19", "1/19") } }, { pathname: "/draftclient/f1/18599/12" }, settingsReceipt, 1_000).ready, false);
  const sevenPicked = helpers.parseTestDraftClient({ ...document, body: { innerText: document.body.innerText.replace("0/19", "7/19").replace("YOUR TURN - 3RD PICK", "WAITING FOR PICK") } }, { pathname: "/draftclient/f1/18599/12" }, settingsReceipt, 1_000);
  assert.equal(sevenPicked.ready, false);
  assert.equal(sevenPicked.errors.includes("test_draft_slot_missing"), true);
  assert.equal(sevenPicked.errors.includes("test_draft_roster_not_empty"), true);
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
    operatorAttestation: helpers.makeOperatorAttestation("NONE", "2026-08-23T21:00:00.000Z"),
  });
  assert.deepEqual([...payload.extensionReceipts.map((entry) => entry.kind)], ["keep"]);
  assert.deepEqual([...payload.runnerReceipts.map((entry) => entry.kind)], ["runner"]);
  assert.deepEqual([...payload.controllerReceipts.map((entry) => entry.kind)], ["controller"]);
  assert.equal(payload.urlSeat, 12);
  assert.equal(payload.status.state, "completed");
  assert.equal(payload.operatorAttestation.status, "none");
});

test("manifest has only the two public-mock surfaces plus the exact verified test league and no broad permissions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.12.0");
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
    "https://football.fantasysports.yahoo.com/f1/18599/12",
    "https://football.fantasysports.yahoo.com/f1/18599/12/*",
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
  assert.equal(await router.targetTab("export"), 33);
  now = 101;
  await router.handleState({ role:"runner", at:now, snapshot:{ label:"RUNNING" }, board:[{ yahooId:"test-2" }] }, { tab:{ id:22 } });
  now = 102;
  await router.handleState({ role:"shadow", at:now, snapshot:{ mode:"REAL SHADOW", label:"READ ONLY" } }, { tab:{ id:33 } });
  assert.equal(session.value("skz.snapshot").label, "RUNNING");
  assert.equal(await router.targetTab("export"), 22);
});

test("command-center bridge sends content changes separately from its stable heartbeat", () => {
  const messages = [];
  let tick = null;
  const runtime = { sendMessage(message) { messages.push(message); return Promise.resolve({ ok:true }); }, onMessage:{ addListener() {}, removeListener() {} } };
  const rail = { getSnapshot:() => ({ label:"RUNNING", board:[{ yahooId:"1" }] }), setOpenHandler() {}, command() { return true; } };
  helpers.attachCommandCenterBridge({ chrome:{ runtime }, location:{ pathname:"/draftclient/f1/123/4" }, setInterval(callback) { tick = callback; return 1; }, clearInterval() {} }, rail);
  assert.equal(helpers.commandCenterRole("/draftclient/f1/123/4"), "runner");
  assert.equal(helpers.commandCenterRole("/f1/mock_waiting"), "arm-owner");
  assert.equal(helpers.commandCenterRole("/f1/18599/12"), "arm-owner");
  assert.equal(messages[0].role, "runner");
  assert.equal(messages[0].snapshot.label, "RUNNING");
  tick();
  assert.equal(messages[1].snapshot, undefined);
  assert.equal(messages[1].board, undefined);
  assert.equal(Number.isFinite(messages[1].at), true);
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
    setOpenHandler() {},
    command() { return true; },
    lock(reason) { locked = reason; },
  };
  const environment = {
    chrome:{ runtime },
    location:{ pathname:"/draftclient/f1/18599/12" },
    localStorage:{ getItem:() => null, setItem() {} },
    setInterval() { throw new Error("invalid bridge must not start a timer"); },
    clearInterval() {},
    __skrodzkaiYahooMockExtensionV1:{ runner:{ halt(reason) { halted = reason; } }, statusTimer:7 },
  };
  helpers.attachCommandCenterBridge(environment, rail);
  assert.match(locked, /Hard-refresh/);
  assert.equal(halted, "extension_context_invalidated");
  assert.equal((source.match(/if \(rail\.isLocked\(\)\) return false;/g) ?? []).length >= 4, true);
  assert.match(source, /for \(const observer of ui\.observers\) observer\.disconnect\(\)/);
  assert.match(source, /WAITING FOR FINAL ROSTER/);
});

test("version handshake requires the current installed background version", async () => {
  assert.equal(await helpers.requireCurrentExtensionVersion({ chrome:{ runtime:{ sendMessage:async () => ({ ok:true, version:"0.12.0" }) } } }), "0.12.0");
  await assert.rejects(
    helpers.requireCurrentExtensionVersion({ chrome:{ runtime:{ sendMessage:async () => ({ ok:true, version:"0.7.5" }) } } }),
    /extension_version_mismatch/,
  );
  await assert.rejects(
    helpers.requireCurrentExtensionVersion({ chrome:{ runtime:{ sendMessage() { throw new Error("invalidated"); } } } }),
    /extension_context_invalidated/,
  );
  assert.equal(backgroundHelpers.extensionVersion({ runtime:{ getManifest:() => ({ version:"0.12.0" }) } }), "0.12.0");
  assert.doesNotMatch(backgroundSource, /identify_arm_surface|tabs\.query/);
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
    { yahooId: "t", name: "Tight End", position: "TE" },
  ], helpers.testRosterSlots);
  assert.equal(roster.find((entry) => entry.slot === "QB")?.player?.yahooId, "q");
  assert.equal(roster.find((entry) => entry.slot === "RB")?.player?.yahooId, "r");
  assert.equal(roster.find((entry) => entry.slot === "W/R/T")?.player?.yahooId, "t");
});

test("war-room roster placement reproduces Yahoo generic-D priority", () => {
  const roster = helpers.buildUiRoster([
    { yahooId:"s", name:"Safety", position:"S" },
    { yahooId:"d", name:"Edge", position:"D" },
    { yahooId:"lb", name:"Linebacker", position:"LB" },
    { yahooId:"cb", name:"Corner", position:"CB" },
  ], helpers.testRosterSlots);
  assert.equal(roster.find((entry) => entry.slot === "D")?.player?.yahooId, "s");
  assert.equal(roster.find((entry) => entry.slot === "S")?.player, null);
  assert.equal(roster.find((entry) => entry.slot === "BN")?.player?.yahooId, "d");
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
    row("S", "", "", ["empty-position"]),
    row("BN", "Aidan Hutchinson", "33957"),
  ] }, picks);
  assert.deepEqual(JSON.parse(JSON.stringify(observed)), [
    { slot:"D", yahooId:"41883", name:"Xavier Watts", empty:false },
    { slot:"S", yahooId:null, name:null, empty:true },
    { slot:"BN", yahooId:"33957", name:"Aidan Hutchinson", empty:false },
  ]);
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
  const board = [{ yahooId: "1", name: "One", position: "RB", team: "BUF", confidence: "MULTI_SOURCE" }];
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
    "Next-pick override", "Warnings", "Decision receipts", "Choose / Pin", "KILL SWITCH",
  ]) assert.match(combinedUi, new RegExp(label.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")));
  assert.match(combinedUi, /width: min\(380px, calc\(100vw - 32px\)\)/);
  assert.match(popupCss, /grid-template-columns:250px minmax\(390px,1fr\) 300px/);
  assert.match(source, /rail\.setRoster\(TEST_ROSTER_SLOTS\.map/);
});
