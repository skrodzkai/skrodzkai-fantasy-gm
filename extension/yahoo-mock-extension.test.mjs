import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./yahoo-mock-extension.js", import.meta.url), "utf8");
const boardSource = await readFile(new URL("./yahoo-mock-board.js", import.meta.url), "utf8");
const controllerSource = await readFile(new URL("../controller/yahoo-draft-controller.js", import.meta.url), "utf8");
const runnerSource = await readFile(new URL("../controller/yahoo-mock-runner.js", import.meta.url), "utf8");
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
  assert.equal(helpers.validateDraftPreflight(armRecord, { roomId: "9391926", seat: 6 }, 1_001), "mock_room_or_seat_changed");
  assert.equal(helpers.validateDraftPreflight(armRecord, { roomId: "9391927", seat: 7 }, 1_001), "mock_room_or_seat_changed");
  assert.equal(helpers.validateDraftPreflight(armRecord, { roomId: "9391926", seat: 7 }, armRecord.expiresAt), "mock_arm_expired");
  assert.equal(helpers.validateDraftPreflight(null, { roomId: "9391926", seat: 7 }, 1_001), "mock_waiting_room_arm_required");
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

test("exports only receipts from the exact room and seat", () => {
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
      { roomId: "99", seat: 3, kind: "controller" },
    ])],
  ]);
  const payload = helpers.buildExportPayload({
    roomId: "99",
    seat: 3,
    storage: { getItem: (key) => values.get(key) ?? null },
    runner: { getStatus: () => ({ state: "completed", picks: Array(15).fill({}) }) },
  });
  assert.deepEqual([...payload.extensionReceipts.map((entry) => entry.kind)], ["keep"]);
  assert.deepEqual([...payload.runnerReceipts.map((entry) => entry.kind)], ["runner"]);
  assert.deepEqual([...payload.controllerReceipts.map((entry) => entry.kind)], ["controller"]);
  assert.equal(payload.status.state, "completed");
});

test("manifest has only the two Yahoo mock surfaces and no broad permissions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.permissions, undefined);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.content_scripts[0].matches, [
    "https://football.fantasysports.yahoo.com/f1/mock_waiting*",
    "https://football.fantasysports.yahoo.com/draftclient/f1/*",
  ]);
  assert.equal(manifest.content_scripts[0].world, undefined);
  assert.deepEqual(manifest.content_scripts[0].js, [
    "controller/yahoo-draft-controller.js",
    "controller/yahoo-mock-runner.js",
    "extension/yahoo-mock-board.js",
    "extension/yahoo-mock-extension.js",
  ]);
});

test("bundled board contains unique current IDs and complete observed offense ranges", () => {
  const board = context.SKRODZKaiYahooMockBoard;
  assert.equal(board.offense.length, 138);
  assert.equal(board.kickers.length, 28);
  assert.equal(board.defenses.length, 32);
  const ids = [...board.offense, ...board.kickers].map((player) => String(player.yahooId));
  assert.equal(new Set(ids).size, ids.length);
  for (const player of board.offense) {
    assert.equal(Number.isFinite(player.vor), true);
    assert.equal(Number.isFinite(player.adpLow), true);
    assert.equal(Number.isFinite(player.adpHigh), true);
  }
});

test("extension contains no network or remote-model execution path", () => {
  for (const bundledSource of [source, boardSource, controllerSource, runnerSource]) {
    assert.doesNotMatch(bundledSource, /\bfetch\s*\(/);
    assert.doesNotMatch(bundledSource, /XMLHttpRequest|WebSocket|EventSource/);
    assert.doesNotMatch(bundledSource, /openrouter|anthropic|openai/i);
  }
  assert.doesNotMatch(source, />HIDE</);
});
