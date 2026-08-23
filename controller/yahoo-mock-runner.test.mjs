import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./yahoo-mock-runner.js", import.meta.url), "utf8");
const controllerSource = await readFile(new URL("./yahoo-draft-controller.js", import.meta.url), "utf8");

function loadRunner(controllerApi = {}) {
  if (controllerApi.runtime && typeof controllerApi.runtime.readOwnedTurn !== "function") {
    controllerApi.runtime.readOwnedTurn = () => ({ label: "R1P6", round: 1, pick: 6 });
  }
  const context = {
    clearInterval,
    console,
    crypto,
    Date,
    Event: class Event {
      constructor(type) {
        this.type = type;
      }
    },
    Math,
    setInterval,
    setTimeout,
    SKRODZKaiYahooDraftController: controllerApi,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.SKRODZKaiYahooMockRunner;
}

const runnerApi = loadRunner();
const helpers = runnerApi._test;
const mockConfig = runnerApi.configs.public_mock_15;
const testConfig = runnerApi.configs.test_league_19_idp;

function player(position, number, rank, overrides = {}) {
  const candidate = {
    yahooId: `${position}-${number}`,
    name: `${position} Player ${number}`,
    position,
    team: position === "DEF" ? "" : "TST",
    rank,
    ...overrides,
  };
  if (["QB", "RB", "WR", "TE"].includes(position)) {
    candidate.vor ??= 300 - rank;
    candidate.adpLow ??= rank + 150;
    candidate.adpHigh ??= rank + 170;
  }
  return candidate;
}

function genericBoard() {
  const board = [];
  let rank = 1;
  for (const position of ["RB", "WR", "QB", "TE", "DEF", "K"]) {
    for (let index = 1; index <= 20; index += 1) board.push(player(position, index, rank++));
  }
  return board;
}

function testLeagueBoard() {
  const board = [];
  let rank = 1;
  for (const position of ["RB", "WR", "QB", "TE", "DEF", "K", "D", "LB", "CB", "S"]) {
    for (let index = 1; index <= 20; index += 1) board.push(player(position, index, rank++));
  }
  return board;
}

function storageFixture() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not reached before timeout");
}

test("keeps the real 19-round IDP configuration unqualified for execution", () => {
  assert.equal(runnerApi.configs.real_league_19_idp.rosterTotal, 19);
  assert.equal(runnerApi.configs.real_league_19_idp.qualification, "unverified-real-room");
  assert.deepEqual(
    Array.from(runnerApi.configs.real_league_19_idp.rosterSlots),
    ["QB", "WR", "WR", "WR", "RB", "RB", "TE", "W/R/T", "K", "DEF", "D", "DB", "LB", "BN", "BN", "BN", "BN", "BN", "BN"],
  );
});

test("records the verified board position when Yahoo displays a narrower specialist label", () => {
  const board = helpers.validateBoard([player("D", 1, 1)]);
  assert.equal(helpers.positionForConfirmedPick(board, { yahooId: "D-1", position: "DE" }), "D");
  assert.throws(
    () => helpers.positionForConfirmedPick(board, { yahooId: "missing", position: "DE" }),
    /absent from the verified board/,
  );
});

test("qualifies only the exact retained test-league identity and rotates all six specialist picks by snake seat", () => {
  assert.equal(testConfig.leagueId, "18599");
  assert.equal(testConfig.urlTeamId, 12);
  assert.equal(testConfig.rounds, 19);
  assert.deepEqual(
    Array.from(testConfig.rosterSlots),
    ["QB", "WR", "WR", "RB", "RB", "W/R", "W/R/T", "K", "DEF", "D", "LB", "CB", "S", "BN", "BN", "BN", "BN", "BN", "BN"],
  );
  assert.deepEqual(Array.from(helpers.allowedPositions(14, [], testConfig, 1)), ["K"]);
  assert.deepEqual(Array.from(helpers.allowedPositions(14, [], testConfig, 6)), ["DEF"]);
  assert.deepEqual(Array.from(helpers.requiredTestFilterLabels()), ["All Positions", "Kickers", "Team Defenses", "Defensive Players", "Linebackers", "Defensive Backs"]);
  for (let seat = 1; seat <= 12; seat += 1) {
    assert.equal(helpers.specialistOrderForSeat(seat)[2], "D", `seat ${seat} must consume Yahoo's generic D slot first`);
  }
  const picks = [
    player("K", 1, 1), player("DEF", 1, 2), player("LB", 1, 3),
    player("D", 1, 4), player("S", 1, 5), player("CB", 1, 6),
  ];
  assert.deepEqual(Array.from(helpers.allowedPositions(19, picks, testConfig, 1)), []);
  const offense = [
    player("QB", 1, 1),
    ...Array.from({ length: 2 }, (_, index) => player("RB", index + 1, index + 2)),
    ...Array.from({ length: 6 }, (_, index) => player("WR", index + 1, index + 4)),
    ...Array.from({ length: 2 }, (_, index) => player("TE", index + 1, index + 10)),
  ];
  assert.deepEqual(Array.from(helpers.allowedPositions(12, offense, testConfig, 1)), ["RB"]);
  assert.equal(helpers.allowedPositions(8, [player("QB", 1, 1), player("TE", 1, 2)], testConfig, 1).includes("QB"), false);
  assert.equal(helpers.allowedPositions(8, [player("QB", 1, 1), player("TE", 1, 2)], testConfig, 1).includes("TE"), false);
  const minimumsMet = [
    player("QB", 1, 1), player("TE", 1, 2),
    ...Array.from({ length: 4 }, (_, index) => player("RB", index + 1, index + 3)),
    ...Array.from({ length: 4 }, (_, index) => player("WR", index + 1, index + 7)),
  ];
  assert.equal(helpers.allowedPositions(12, minimumsMet, testConfig, 1).includes("QB"), true);
  assert.equal(helpers.allowedPositions(13, minimumsMet, testConfig, 1).includes("TE"), true);
});

test("observed TEST roster validation rejects the Watts-in-D and Hutchinson-on-bench shape", () => {
  const offense = [
    player("QB", 1, 1),
    ...Array.from({ length:4 }, (_, index) => player("RB", index + 1, index + 2)),
    ...Array.from({ length:6 }, (_, index) => player("WR", index + 1, index + 6)),
    ...Array.from({ length:2 }, (_, index) => player("TE", index + 1, index + 12)),
  ];
  const specialists = [player("K", 1, 14), player("DEF", 1, 15), player("D", 1, 16), player("LB", 1, 17), player("CB", 1, 18), player("S", 1, 19)];
  const picks = [...offense, ...specialists];
  const clean = helpers.allocateRosterSlots(picks, testConfig.rosterSlots).map((entry) => ({
    slot:entry.slot,
    yahooId:entry.player?.yahooId ?? null,
    empty:!entry.player,
  }));
  assert.equal(helpers.validateObservedTestRoster(clean, picks), true);

  const bad = clean.map((entry) => ({ ...entry }));
  const dSlot = bad.find((entry) => entry.slot === "D");
  const sSlot = bad.find((entry) => entry.slot === "S");
  const bench = bad.find((entry) => entry.slot === "BN");
  dSlot.yahooId = specialists.find((pick) => pick.position === "S").yahooId;
  sSlot.yahooId = null;
  sSlot.empty = true;
  bench.yahooId = specialists.find((pick) => pick.position === "D").yahooId;
  bench.empty = false;
  assert.equal(helpers.validateObservedTestRoster(bad, picks), false);
});

test("recognizes only the exact public mock roster shape", () => {
  assert.equal(helpers.sameSlots(mockConfig.rosterSlots, mockConfig.rosterSlots), true);
  assert.equal(helpers.sameSlots(mockConfig.rosterSlots.slice(0, -1), mockConfig.rosterSlots), false);
  const changed = [...mockConfig.rosterSlots];
  changed[9] = "D";
  assert.equal(helpers.sameSlots(changed, mockConfig.rosterSlots), false);
});

test("prevents the early wide-receiver pileup until offensive starters and FLEX are filled", () => {
  const picks = [
    player("RB", 1, 1),
    player("WR", 1, 2),
    player("WR", 2, 3),
    player("WR", 3, 4),
  ];
  assert.deepEqual(Array.from(helpers.allowedPositions(5, picks, mockConfig)), ["QB", "RB", "TE"]);
  picks.push(player("RB", 2, 5), player("QB", 1, 6), player("TE", 1, 7));
  assert.equal(helpers.offenseComplete(helpers.positionCounts(picks), mockConfig), true);
  assert.deepEqual(Array.from(helpers.allowedPositions(9, picks, mockConfig)), ["RB", "WR"]);
});

test("the public policy always exposes at least five strategic fallbacks through round 13", () => {
  const board = helpers.validateBoard(genericBoard());
  const picks = [];
  for (let round = 1; round <= 13; round += 1) {
    const availablePlayers = board.filter(
      (candidate) => !picks.some((pick) => pick.yahooId === candidate.yahooId),
    );
    const { targets } = helpers.buildDecisionLadder({
      round,
      seat: 6,
      picks,
      board,
      availablePlayers,
      minimum: 5,
      config: mockConfig,
    });
    assert.ok(targets.length >= 5, `round ${round} should have five fallbacks`);
    picks.push({ ...targets[0] });
  }
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.positionCounts(picks))),
    { RB: 5, WR: 6, QB: 1, TE: 1 },
  );
});

test("a room-bound next-pick pin becomes target one while retaining verified baseline fallbacks", () => {
  const board = helpers.validateBoard(genericBoard());
  const availablePlayers = board.map((candidate) => ({ ...candidate }));
  const baseline = helpers.buildDecisionLadder({
    round: 1,
    seat: 6,
    picks: [],
    board,
    availablePlayers,
    minimum: 5,
    config: mockConfig,
  }).targets;
  const applied = helpers.applyManualOverride({
    stage: { roomId: "99", seat: 6, expectedRound: 1, targets: [{ yahooId: "WR-10" }] },
    roomId: "99",
    seat: 6,
    round: 1,
    board,
    availablePlayers,
    baselineTargets: baseline,
    allowed: helpers.allowedPositions(1, [], mockConfig, 6),
    minimum: 5,
  });
  assert.equal(applied.manualOverride.status, "applied");
  assert.equal(applied.manualOverride.chosenYahooId, "WR-10");
  assert.equal(applied.targets[0].yahooId, "WR-10");
  assert.equal(applied.targets.length, baseline.length + 1);
  assert.equal(new Set(applied.targets.map((target) => target.yahooId)).size, baseline.length + 1);

  const wrongRound = helpers.applyManualOverride({
    stage: { roomId: "99", seat: 6, expectedRound: 2, targets: [{ yahooId: "WR-10" }] },
    roomId: "99",
    seat: 6,
    round: 1,
    board,
    availablePlayers,
    baselineTargets: baseline,
    allowed: helpers.allowedPositions(1, [], mockConfig, 6),
    minimum: 5,
  });
  assert.equal(wrongRound.manualOverride.status, "rejected");
  assert.equal(wrongRound.manualOverride.reason, "manual_pin_round_mismatch");
  assert.deepEqual(
    JSON.parse(JSON.stringify(Array.from(wrongRound.targets, (target) => target.yahooId))),
    JSON.parse(JSON.stringify(Array.from(baseline, (target) => target.yahooId))),
  );
  const illegalPosition = helpers.applyManualOverride({
    stage: { roomId: "99", seat: 6, expectedRound: 1, targets: [{ yahooId: "DEF-1" }] },
    roomId: "99",
    seat: 6,
    round: 1,
    board,
    availablePlayers,
    baselineTargets: baseline,
    allowed: helpers.allowedPositions(1, [], mockConfig, 6),
    minimum: 5,
  });
  assert.equal(illegalPosition.manualOverride.status, "rejected");
  assert.equal(illegalPosition.manualOverride.reason, "manual_pin_unavailable_or_ineligible");
  assert.equal(illegalPosition.manualOverride.consume, true);
});

test("reserves the public mock specialist filters for rounds 14 and 15", () => {
  assert.equal(helpers.filterLabelForRound(13), "All Positions");
  assert.equal(helpers.filterLabelForRound(14), "Team Defenses");
  assert.equal(helpers.filterLabelForRound(15), "Kickers");
  assert.deepEqual(Array.from(helpers.allowedPositions(14, [], mockConfig)), ["DEF"]);
  assert.deepEqual(Array.from(helpers.allowedPositions(15, [], mockConfig)), ["K"]);
});

test("computes exact snake windows, including both zero-opponent wraps", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.turnWindow(2, 1, 12))),
    { currentPick: 24, nextPick: 25, interveningOpponentPicks: 0 },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.turnWindow(1, 12, 12))),
    { currentPick: 12, nextPick: 13, interveningOpponentPicks: 0 },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.turnWindow(2, 3, 12))),
    { currentPick: 22, nextPick: 27, interveningOpponentPicks: 4 },
  );
  assert.equal(helpers.overallPick(3, 7, 12), 31);
  assert.equal(helpers.overallPick(4, 10, 12), 39);
});

test("uses observed ADP boundaries without pretending equality is certainty", () => {
  const candidate = { adpEarliest: 20, adpLatest: 30 };
  assert.equal(helpers.survivalBucket(candidate, 19, 10), "likely_there");
  assert.equal(helpers.survivalBucket(candidate, 20, 10), "ambiguous");
  assert.equal(helpers.survivalBucket(candidate, 30, 10), "ambiguous");
  assert.equal(helpers.survivalBucket(candidate, 31, 10), "likely_gone");
  assert.equal(helpers.survivalBucket(candidate, 31, 0), "certain_through_wrap");
});

test("treats a position with no projected next-turn survivor as replacement-level urgency", () => {
  const board = helpers.validateBoard([
    player("RB", 1, 1, { vor: 40, adpLow: 1, adpHigh: 2 }),
    player("RB", 2, 2, { vor: 20, adpLow: 2, adpHigh: 3 }),
    player("WR", 1, 3, { vor: 35, adpLow: 50, adpHigh: 60 }),
    player("WR", 2, 4, { vor: 30, adpLow: 61, adpHigh: 70 }),
    player("QB", 1, 5, { vor: 25, adpLow: 50, adpHigh: 60 }),
    player("QB", 2, 6, { vor: 20, adpLow: 61, adpHigh: 70 }),
    player("TE", 1, 7, { vor: 22, adpLow: 50, adpHigh: 60 }),
    player("TE", 2, 8, { vor: 18, adpLow: 61, adpHigh: 70 }),
  ]);
  const scored = helpers.scorePositionLeaders({ round: 2, seat: 3, picks: [player("WR", 90, 90)], pool: board, materialEdgePoints: 15, config: mockConfig });
  const runningBack = scored.leaders.find((leader) => leader.player.position === "RB");
  assert.equal(runningBack.bucket, "position_unavailable_next_turn");
  assert.equal(runningBack.comparator, null);
  assert.equal(runningBack.adjustedScore, 40);
});

test("scores only the highest-VORP player at a position even when a lower player looks urgent", () => {
  const board = helpers.validateBoard([
    player("TE", 1, 1, { vor: 100, adpLow: 50, adpHigh: 60 }),
    player("TE", 2, 2, { vor: 80, adpLow: 10, adpHigh: 15 }),
    player("TE", 3, 3, { vor: 60, adpLow: 55, adpHigh: 70 }),
    player("RB", 1, 4, { vor: 90, adpLow: 10, adpHigh: 15 }),
    player("RB", 2, 5, { vor: 70, adpLow: 55, adpHigh: 70 }),
    player("WR", 1, 6, { vor: 85, adpLow: 10, adpHigh: 15 }),
    player("WR", 2, 7, { vor: 75, adpLow: 55, adpHigh: 70 }),
    player("QB", 1, 8, { vor: 70, adpLow: 10, adpHigh: 15 }),
    player("QB", 2, 9, { vor: 65, adpLow: 55, adpHigh: 70 }),
  ]);
  const scored = helpers.scorePositionLeaders({
    round: 3,
    seat: 3,
    picks: [player("RB", 90, 90), player("WR", 90, 91)],
    pool: board,
    materialEdgePoints: 15,
    config: mockConfig,
  });
  const tightEnd = scored.leaders.find((leader) => leader.player.position === "TE");
  assert.equal(tightEnd.player.yahooId, "TE-1");
  assert.equal(tightEnd.bucket, "likely_there");
  assert.equal(tightEnd.adjustedScore, 0);
});

test("selects, defers, and rejects elite TE from the actual gap and survival context", () => {
  function boardFor(teRange, teVor = 110) {
    return helpers.validateBoard([
      player("TE", 1, 1, { vor: teVor, adpLow: teRange[0], adpHigh: teRange[1] }),
      player("TE", 2, 20, { vor: 70, adpLow: 55, adpHigh: 70 }),
      player("RB", 1, 2, { vor: 100, adpLow: 10, adpHigh: 20 }),
      player("RB", 2, 21, { vor: 80, adpLow: 55, adpHigh: 70 }),
      player("WR", 1, 3, { vor: 95, adpLow: 10, adpHigh: 20 }),
      player("WR", 2, 22, { vor: 80, adpLow: 55, adpHigh: 70 }),
      player("QB", 1, 4, { vor: 80, adpLow: 10, adpHigh: 20 }),
      player("QB", 2, 23, { vor: 75, adpLow: 55, adpHigh: 70 }),
    ]);
  }
  const base = {
    round: 3,
    seat: 3,
    picks: [player("RB", 90, 90), player("WR", 90, 91)],
    availablePlayers: null,
    minimum: 1,
    materialEdgePoints: 15,
    config: mockConfig,
  };
  const decide = (board) => helpers.buildDecisionLadder({
    ...base,
    board,
    availablePlayers: board,
  }).targets[0].position;
  assert.equal(decide(boardFor([10, 20])), "TE", "large TE gap should win when the player is likely gone");
  assert.equal(decide(boardFor([55, 70])), "RB", "elite TE should defer when the same player is likely available");
  assert.equal(decide(boardFor([30, 55], 82)), "RB", "an ambiguous sub-material TE gap should not win");
});

test("enforces every early RB/WR floor boundary and only permits a material exception", () => {
  const makeBoard = (teVor) => helpers.validateBoard([
    player("TE", 1, 1, { vor: teVor, adpLow: 10, adpHigh: 20 }),
    player("TE", 2, 30, { vor: 70, adpLow: 55, adpHigh: 70 }),
    player("RB", 1, 2, { vor: 100, adpLow: 10, adpHigh: 20 }),
    player("RB", 2, 31, { vor: 70, adpLow: 55, adpHigh: 70 }),
    player("WR", 1, 3, { vor: 95, adpLow: 10, adpHigh: 20 }),
    player("WR", 2, 32, { vor: 75, adpLow: 55, adpHigh: 70 }),
    player("QB", 1, 4, { vor: 80, adpLow: 10, adpHigh: 20 }),
    player("QB", 2, 33, { vor: 75, adpLow: 55, adpHigh: 70 }),
  ]);
  const weakException = helpers.scorePositionLeaders({
    round: 3,
    seat: 3,
    picks: [player("RB", 90, 90)],
    pool: makeBoard(110),
    materialEdgePoints: 15,
    config: mockConfig,
  });
  const blockedTe = weakException.leaders.find((leader) => leader.player.position === "TE");
  assert.equal(blockedTe.floorRequired, 2);
  assert.equal(blockedTe.postPickRbwr, 1);
  assert.equal(blockedTe.floorException, false);
  assert.equal(weakException.ranked[0].player.position, "RB");

  const materialException = helpers.scorePositionLeaders({
    round: 4,
    seat: 3,
    picks: [player("RB", 90, 90), player("WR", 90, 91), player("QB", 90, 92)],
    pool: makeBoard(120),
    materialEdgePoints: 15,
    config: mockConfig,
  });
  const allowedTe = materialException.leaders.find((leader) => leader.player.position === "TE");
  assert.equal(allowedTe.floorException, true);
  assert.equal(materialException.ranked[0].player.position, "TE");

  const impossibleEarlyException = helpers.scorePositionLeaders({
    round: 3,
    seat: 3,
    picks: [player("RB", 90, 90)],
    pool: makeBoard(140),
    materialEdgePoints: 15,
    config: mockConfig,
  });
  assert.equal(
    impossibleEarlyException.leaders.find((leader) => leader.player.position === "TE").floorException,
    false,
  );

  for (let round = 1; round <= 4; round += 1) {
    const picks = Array.from({ length: Math.max(0, round - 2) }, (_, index) => player("RB", 80 + index, 80 + index));
    const scored = helpers.scorePositionLeaders({
      round,
      seat: 3,
      picks,
      pool: makeBoard(80),
      materialEdgePoints: 15,
      config: mockConfig,
    });
    assert.equal(scored.floorRequired, round - 1);
  }
});

test("accepts a complete balanced public-mock roster and rejects the prior seven-WR shape", () => {
  const balanced = [
    ...Array.from({ length: 5 }, (_, index) => player("RB", index + 1, index + 1)),
    ...Array.from({ length: 6 }, (_, index) => player("WR", index + 1, index + 20)),
    player("QB", 1, 40),
    player("TE", 1, 41),
    player("DEF", 1, 42),
    player("K", 1, 43),
  ];
  assert.equal(helpers.validateCompletedRoster(balanced, mockConfig), true);
  const priorShape = [
    ...Array.from({ length: 4 }, (_, index) => player("RB", index + 1, index + 1)),
    ...Array.from({ length: 7 }, (_, index) => player("WR", index + 1, index + 20)),
    player("QB", 1, 40),
    player("TE", 1, 41),
    player("DEF", 1, 42),
    player("K", 1, 43),
  ];
  assert.equal(helpers.validateCompletedRoster(priorShape, mockConfig), false);
});

test("refuses non-12-team rooms, wrong seats, and mismatched roster shapes before start", () => {
  const controllerApi = {
    runtime: {
      parseRoom: () => ({ roomId: "9378515", seat: 6 }),
      parseRosterCount: () => ({ filled: 0, total: 15 }),
    },
  };
  const api = loadRunner(controllerApi);
  const environment = {
    SKRODZKaiYahooDraftController: controllerApi,
    crypto,
    document: { body: { innerText: "YOUR TEAM (0/15)" } },
    localStorage: storageFixture(),
    location: { pathname: "/draftclient/f1/9378515/6" },
  };
  const base = {
    board: genericBoard(),
    expectedRoomId: "9378515",
    expectedSeat: 6,
    observedTeamCount: 12,
    observedRosterSlots: mockConfig.rosterSlots,
  };
  for (const observedTeamCount of [8, 10, 14]) {
    assert.throws(() => api.create({ ...base, observedTeamCount }, environment), /exactly 12 teams/);
  }
  assert.throws(() => api.create({ ...base, expectedSeat: 5 }, environment), /draft room or URL team/);
  assert.throws(
    () => api.create({ ...base, observedRosterSlots: mockConfig.rosterSlots.slice(0, -1) }, environment),
    /roster shape/,
  );
  assert.throws(
    () => api.create({ ...base, configName: "real_league_19_idp" }, environment),
    /not qualified/,
  );
});

test("kill switch leaves Autodraft off and cannot resume without creating a new runner", async () => {
  let stoppedReason = null;
  const rows = genericBoard().map((candidate) => ({ player: { ...candidate, row: {} } }));
  const select = {
    value: "all",
    options: [
      { textContent: "All Positions", value: "all" },
      { textContent: "Team Defenses", value: "def" },
      { textContent: "Kickers", value: "k" },
    ],
    dispatchEvent() {},
  };
  const controllerApi = {
    runtime: {
      isAutodraftActive: () => false,
      parseRoom: () => ({ roomId: "9378515", seat: 6 }),
      parseRosterCount: () => ({ filled: 0, total: 15 }),
      readPlayerRow: (row) => row.player,
    },
    create() {
      return {
        exportReceipts: () => [{ kind: "draft_click" }],
        getStatus: () => ({ state: "running", confirmedPicks: 0 }),
        start() {
          return this;
        },
        stop(reason) {
          stoppedReason = reason;
        },
      };
    },
  };
  const api = loadRunner(controllerApi);
  const storage = storageFixture();
  const environment = {
    Event: class Event {
      constructor(type) {
        this.type = type;
      }
    },
    SKRODZKaiYahooDraftController: controllerApi,
    clearInterval,
    crypto,
    document: {
      body: { innerText: "YOUR TEAM (0/15)" },
      querySelectorAll(selector) {
        if (selector === "select") return [select];
        if (selector === "tr") return rows;
        return [];
      },
    },
    localStorage: storage,
    location: { pathname: "/draftclient/f1/9378515/6" },
    setInterval,
    setTimeout,
  };
  const runner = api.create(
    {
      board: genericBoard(),
      expectedRoomId: "9378515",
      expectedSeat: 6,
      observedTeamCount: 12,
      observedRosterSlots: mockConfig.rosterSlots,
      materialEdgePoints: 18,
    },
    environment,
  ).start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  runner.halt();
  assert.equal(runner.getStatus().state, "halted");
  assert.equal(stoppedReason, "kill_switch");
  assert.equal(runner.halt(), runner);
  assert.throws(() => runner.start(), /cannot start/);
  const halted = runner.exportReceipts().at(-1);
  const started = runner.exportReceipts().find((entry) => entry.kind === "runner_started");
  assert.equal(started.materialEdgePoints, 15, "production edge must stay locked at 15");
  assert.equal(halted.kind, "runner_halted");
  assert.equal(halted.autodraftActive, false);
  assert.equal(halted.draftClicks, 1);
  assert.equal(halted.pickConfirmations, 0);
});

test("rechecks the empty roster at start and rejects post-preflight drift", () => {
  let filled = 0;
  const controllerApi = {
    runtime: {
      isAutodraftActive: () => false,
      parseRoom: () => ({ roomId: "9378515", seat: 6 }),
      parseRosterCount: () => ({ filled, total: 15 }),
      readPlayerRow: (row) => row.player,
    },
  };
  const api = loadRunner(controllerApi);
  const environment = {
    Event,
    SKRODZKaiYahooDraftController: controllerApi,
    clearInterval,
    crypto,
    document: { body: { innerText: "YOUR TEAM (0/15)" } },
    localStorage: storageFixture(),
    location: { pathname: "/draftclient/f1/9378515/6" },
    setInterval,
    setTimeout,
  };
  const runner = api.create({
    board: genericBoard(),
    expectedRoomId: "9378515",
    expectedSeat: 6,
    observedTeamCount: 12,
    observedRosterSlots: mockConfig.rosterSlots,
  }, environment);
  filled = 1;
  assert.throws(() => runner.start(), /roster changed after preflight/);
});

test("fails when the confirmed Yahoo roster count drifts from the runner pick count", async (t) => {
  let stopped = false;
  const board = genericBoard();
  const select = {
    value: "all",
    options: [
      { textContent: "All Positions", value: "all" },
      { textContent: "Team Defenses", value: "def" },
      { textContent: "Kickers", value: "k" },
    ],
    dispatchEvent() {},
  };
  const rows = board.map((candidate) => ({ player: { ...candidate, row: {} } }));
  const controllerApi = {
    runtime: {
      isAutodraftActive: () => false,
      parseRoom: () => ({ roomId: "9378515", seat: 6 }),
      parseRosterCount: () => ({ filled: 0, total: 15 }),
      readPlayerRow: (row) => row.player,
    },
    create() {
      return {
        exportReceipts: () => [
          { kind: "draft_click", detectionToClickMs: 3 },
          {
            kind: "pick_confirmed",
            yahooId: "RB-1",
            name: "RB Player 1",
            position: "RB",
            team: "TST",
            turn: "R1P6",
            rosterAfter: { filled: 2, total: 15 },
            clickToConfirmationMs: 170,
          },
        ],
        getStatus: () => ({ state: "completed", confirmedPicks: 1 }),
        start() {
          return this;
        },
        stop() {
          stopped = true;
        },
      };
    },
  };
  const api = loadRunner(controllerApi);
  const environment = {
    Event: class Event {
      constructor(type) {
        this.type = type;
      }
    },
    SKRODZKaiYahooDraftController: controllerApi,
    clearInterval,
    crypto,
    document: {
      body: { innerText: "YOUR TEAM (0/15)" },
      querySelectorAll(selector) {
        if (selector === "select") return [select];
        if (selector === "tr") return rows;
        return [];
      },
    },
    localStorage: storageFixture(),
    location: { pathname: "/draftclient/f1/9378515/6" },
    setInterval,
    setTimeout,
  };
  const runner = api.create({
    board,
    expectedRoomId: "9378515",
    expectedSeat: 6,
    observedTeamCount: 12,
    observedRosterSlots: mockConfig.rosterSlots,
  }, environment).start();
  t.after(() => runner.stop());
  await waitFor(() => runner.getStatus().state === "failed");
  assert.equal(runner.getStatus().failure.code, "roster_drift");
  assert.equal(stopped, true);
});

test("resolves the live ladder then consumes a valid next-pick pin without losing baseline fallbacks", async () => {
  const board = [];
  let rank = 1;
  const addPosition = (position, topVor, secondVor, thirdVor) => {
    for (let index = 1; index <= 10; index += 1) {
      const vor = index === 1 ? topVor : index === 2 ? secondVor : index === 3 ? thirdVor : thirdVor - index;
      const range = index === 1 ? [1, 5] : [30 + index, 45 + index];
      board.push(player(position, index, rank++, { vor, adpLow: range[0], adpHigh: range[1] }));
    }
  };
  addPosition("RB", 100, 90, 60);
  addPosition("TE", 100, 70, 55);
  addPosition("WR", 90, 80, 60);
  addPosition("QB", 90, 80, 60);
  for (let index = 1; index <= 10; index += 1) board.push(player("DEF", index, rank++));
  for (let index = 1; index <= 10; index += 1) board.push(player("K", index, rank++));

  let ownedTurn = null;
  let controllerCreates = 0;
  let capturedTargets = null;
  let consumedOverride = null;
  let stagedOverride = { roomId: "9378515", seat: 6, expectedRound: 1, targets: [{ yahooId: "WR-10" }] };
  const available = new Set(board.map((candidate) => candidate.yahooId));
  const select = {
    value: "all",
    options: [
      { textContent: "All Positions", value: "all" },
      { textContent: "Team Defenses", value: "def" },
      { textContent: "Kickers", value: "k" },
    ],
    dispatchEvent() {},
  };
  const controllerApi = {
    runtime: {
      isAutodraftActive: () => false,
      parseRoom: () => ({ roomId: "9378515", seat: 6 }),
      parseRosterCount: () => ({ filled: 0, total: 15 }),
      readOwnedTurn: () => ownedTurn,
      readPlayerRow: (row) => row.player,
    },
    create(options) {
      controllerCreates += 1;
      capturedTargets = options.targets;
      return {
        exportReceipts: () => [],
        getStatus: () => ({ state: "running", confirmedPicks: 0 }),
        start() { return this; },
        stop() {},
      };
    },
  };
  const api = loadRunner(controllerApi);
  const environment = {
    Event: class Event { constructor(type) { this.type = type; } },
    SKRODZKaiYahooDraftController: controllerApi,
    clearInterval,
    crypto,
    document: {
      body: { innerText: "YOUR TEAM (0/15)" },
      querySelectorAll(selector) {
        if (selector === "select") return [select];
        if (selector === "tr") {
          return board.filter((candidate) => available.has(candidate.yahooId)).map((candidate) => ({
            player: { ...candidate, row: {} },
          }));
        }
        return [];
      },
    },
    localStorage: storageFixture(),
    location: { pathname: "/draftclient/f1/9378515/6" },
    setInterval,
    setTimeout,
  };
  const runner = api.create({
    board,
    expectedRoomId: "9378515",
    expectedSeat: 6,
    observedTeamCount: 12,
    observedRosterSlots: mockConfig.rosterSlots,
    readManualOverride: () => stagedOverride,
    consumeManualOverride: (outcome) => { consumedOverride = outcome; },
  }, environment).start();

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(controllerCreates, 0, "off-turn runner must not pre-arm a stale ladder");
  available.delete("RB-2");
  ownedTurn = { label: "R1P6", round: 1, pick: 6 };
  await waitFor(() => controllerCreates === 1);
  runner.halt("test_complete");

  assert.equal(capturedTargets[0].yahooId, "WR-10");
  assert.equal(capturedTargets[1].yahooId, "RB-1");
  assert.equal(consumedOverride.status, "applied");
  assert.equal(consumedOverride.chosenYahooId, "WR-10");
  const resolved = runner.exportReceipts().find((entry) => entry.kind === "runner_turn_resolved");
  const rbDecision = resolved.decision.positionLeaders.find((leader) => leader.player.position === "RB");
  assert.equal(rbDecision.comparator.yahooId, "RB-3");
  assert.equal(resolved.decision.baselineChosenYahooId, "RB-1");
  assert.deepEqual(Array.from(resolved.decision.targetYahooIds).slice(0, 3), ["WR-10", "RB-1", "TE-1"]);
  assert.equal(resolved.decision.manualOverride.status, "applied");
  assert.equal("availablePlayers" in resolved.decision, false);
  assert.ok(JSON.stringify(resolved).length < 8000, "strategy receipt should stay compact");

  stagedOverride = { roomId: "9378515", seat: 6, expectedRound: 1, targets: [{ yahooId: "MISSING" }] };
  ownedTurn = { label: "R1P6", round: 1, pick: 6 };
  controllerCreates = 0;
  capturedTargets = null;
  consumedOverride = null;
  const rejectedRunner = api.create({
    board,
    expectedRoomId: "9378515",
    expectedSeat: 6,
    observedTeamCount: 12,
    observedRosterSlots: mockConfig.rosterSlots,
    readManualOverride: () => stagedOverride,
    consumeManualOverride: (outcome) => { consumedOverride = outcome; },
  }, environment).start();
  await waitFor(() => controllerCreates === 1);
  rejectedRunner.halt("test_complete");
  assert.equal(consumedOverride.status, "rejected");
  assert.equal(consumedOverride.reason, "manual_pin_unavailable_or_ineligible");
  assert.equal(consumedOverride.consume, true);
  assert.equal(capturedTargets[0].yahooId, "RB-1");
  assert.equal(rejectedRunner.exportReceipts().find((entry) => entry.kind === "runner_turn_resolved").decision.manualOverride.status, "rejected");
});

test("runner advances across an immediate slot-12 wrap without reusing the stale ladder", async (t) => {
  const board = genericBoard();
  const drafted = new Set();
  const clicked = [];
  let filled = 0;

  const select = {
    value: "all",
    options: [
      { textContent: "All Positions", value: "all" },
      { textContent: "Team Defenses", value: "def" },
      { textContent: "Kickers", value: "k" },
    ],
    dispatchEvent() {},
  };

  const document = {
    title: "YOUR TURN, DRAFT NOW | Live NFL Draft",
    body: { innerText: "YOUR TURN • ROUND 1, PICK 12\nYOUR TEAM (0/15)" },
    querySelectorAll(selector) {
      if (selector === "select") return [select];
      if (selector === '[role="dialog"]') return [];
      const rows = board
        .filter((candidate) => !drafted.has(candidate.yahooId))
        .filter((candidate) => {
          if (select.value === "def") return candidate.position === "DEF";
          if (select.value === "k") return candidate.position === "K";
          return ["QB", "RB", "WR", "TE"].includes(candidate.position);
        })
        .map((candidate) => {
          const draftButton = {
            disabled: false,
            innerText: "Draft",
            querySelector() {
              return null;
            },
            click() {
              clicked.push(candidate.yahooId);
              drafted.add(candidate.yahooId);
              filled += 1;
              if (filled === 1) {
                document.title = "YOUR TURN, DRAFT NOW | Live NFL Draft";
                document.body.innerText = "YOUR TURN • ROUND 2, PICK 13\nYOUR TEAM (1/15)";
              } else {
                document.title = "22 picks until your turn | Live NFL Draft";
                document.body.innerText = `YOUR TEAM (${filled}/15)`;
              }
            },
          };
          const playerNode = {
            innerText: `${candidate.name}\n${candidate.position}\n${candidate.team || "Bye 12"}`,
            getAttribute(name) {
              return name === "data-id" ? candidate.yahooId : null;
            },
            querySelector(selector) {
              return selector === "img[title]" ? { getAttribute: () => candidate.name } : null;
            },
          };
          const row = {
            querySelector(selector) {
              return selector === ".ys-player[data-id]" ? playerNode : null;
            },
            querySelectorAll(selector) {
              return selector === "button" ? [draftButton] : [];
            },
          };
          return row;
        });
      if (selector === "tr") return rows;
      if (selector === "button") {
        return [
          ...rows.flatMap((row) => row.querySelectorAll("button")),
          { innerText: "Autodraft", querySelector: () => null },
        ];
      }
      return [];
    },
  };

  const context = {
    clearInterval,
    console,
    crypto,
    Date,
    Event: class Event {
      constructor(type) {
        this.type = type;
      }
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    localStorage: storageFixture(),
    location: { pathname: "/draftclient/f1/9378515/12", assign() {} },
    Math,
    setInterval,
    setTimeout,
  };
  context.document = document;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(controllerSource, context);
  vm.runInContext(source, context);

  const runner = context.SKRODZKaiYahooMockRunner.create({
    board,
    expectedRoomId: "9378515",
    expectedSeat: 12,
    observedTeamCount: 12,
    observedRosterSlots: mockConfig.rosterSlots,
  }, context).start();
  t.after(() => runner.stop());

  await waitFor(() => runner.getStatus().picks.length === 2);
  assert.equal(runner.getStatus().failure, null);
  assert.deepEqual(clicked, ["RB-1", "RB-2"]);
  assert.deepEqual(
    Array.from(runner.exportReceipts(), (entry) => entry.kind).filter((kind) => kind === "runner_pick_confirmed"),
    ["runner_pick_confirmed", "runner_pick_confirmed"],
  );
});

test("runner completes all 15 rounds and switches to the DEF and K filters", async (t) => {
  const board = genericBoard();
  const drafted = new Set();
  const clicked = [];
  const filterEvents = [];
  let filled = 0;

  const select = {
    value: "all",
    options: [
      { textContent: "All Positions", value: "all" },
      { textContent: "Team Defenses", value: "def" },
      { textContent: "Kickers", value: "k" },
    ],
    dispatchEvent(event) {
      if (event.type === "change") filterEvents.push(this.value);
    },
  };

  const document = {
    title: "YOUR TURN, DRAFT NOW | Live NFL Draft",
    body: { innerText: "YOUR TURN • ROUND 1, PICK 6\nYOUR TEAM (0/15)" },
    querySelectorAll(selector) {
      if (selector === "select") return [select];
      if (selector === '[role="dialog"]') return [];
      const rows = board
        .filter((candidate) => !drafted.has(candidate.yahooId))
        .filter((candidate) => {
          if (select.value === "def") return candidate.position === "DEF";
          if (select.value === "k") return candidate.position === "K";
          return ["QB", "RB", "WR", "TE"].includes(candidate.position);
        })
        .map((candidate) => {
          const draftButton = {
            disabled: false,
            innerText: "Draft",
            querySelector() {
              return null;
            },
            click() {
              clicked.push(candidate);
              drafted.add(candidate.yahooId);
              filled += 1;
              if (filled < mockConfig.rounds) {
                const nextRound = filled + 1;
                const nextPick = helpers.overallPick(nextRound, 6, 12);
                document.title = "YOUR TURN, DRAFT NOW | Live NFL Draft";
                document.body.innerText = `YOUR TURN • ROUND ${nextRound}, PICK ${nextPick}\nYOUR TEAM (${filled}/15)`;
              } else {
                document.title = "Draft complete | Live NFL Draft";
                document.body.innerText = "YOUR TEAM (15/15)";
              }
            },
          };
          const playerNode = {
            innerText: `${candidate.name}\n${candidate.position}\n${candidate.team || "Bye 12"}`,
            getAttribute(name) {
              return name === "data-id" ? candidate.yahooId : null;
            },
            querySelector(selector) {
              return selector === "img[title]" ? { getAttribute: () => candidate.name } : null;
            },
          };
          return {
            querySelector(selector) {
              return selector === ".ys-player[data-id]" ? playerNode : null;
            },
            querySelectorAll(selector) {
              return selector === "button" ? [draftButton] : [];
            },
          };
        });
      if (selector === "tr") return rows;
      if (selector === "button") {
        return [
          ...rows.flatMap((row) => row.querySelectorAll("button")),
          { innerText: "Autodraft", querySelector: () => null },
        ];
      }
      return [];
    },
  };

  const context = {
    clearInterval,
    console,
    crypto,
    Date,
    Event: class Event {
      constructor(type) {
        this.type = type;
      }
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    localStorage: storageFixture(),
    location: { pathname: "/draftclient/f1/9378515/6", assign() {} },
    Math,
    setInterval,
    setTimeout,
  };
  context.document = document;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(controllerSource, context);
  vm.runInContext(source, context);

  const runner = context.SKRODZKaiYahooMockRunner.create({
    board,
    expectedRoomId: "9378515",
    expectedSeat: 6,
    observedTeamCount: 12,
    observedRosterSlots: mockConfig.rosterSlots,
  }, context).start();
  t.after(() => runner.stop());

  await waitFor(() => runner.getStatus().state === "completed", 5000);
  assert.equal(runner.getStatus().failure, null);
  assert.equal(clicked.length, 15);
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.positionCounts(clicked))),
    { RB: 5, WR: 6, QB: 1, TE: 1, DEF: 1, K: 1 },
  );
  assert.deepEqual(clicked.slice(-2).map((candidate) => candidate.position), ["DEF", "K"]);
  assert.deepEqual(filterEvents.slice(-2), ["def", "k"]);
  const armed = Array.from(runner.exportReceipts()).filter((entry) => entry.kind === "runner_turn_resolved");
  assert.equal(armed.at(-2).filterLabel, "Team Defenses");
  assert.equal(armed.at(-1).filterLabel, "Kickers");
});

test("verified TEST runner completes 19 rounds through the real CB, S, and DT row parser", async (t) => {
  const board = testLeagueBoard();
  const drafted = new Set();
  const clicked = [];
  let filled = 0;
  const options = [
    ["All Positions", "all"], ["Team Defenses", "def"], ["Kickers", "k"],
    ["Defensive Players", "d"], ["Linebackers", "lb"], ["Defensive Backs", "db"],
  ].map(([textContent, value]) => ({ textContent, value }));
  const select = { value: "all", options, dispatchEvent() {} };
  const visibleForFilter = (candidate) => {
    if (select.value === "def") return candidate.position === "DEF";
    if (select.value === "k") return candidate.position === "K";
    if (select.value === "d") return candidate.position === "D";
    if (select.value === "lb") return candidate.position === "LB";
    if (select.value === "db") return ["CB", "S"].includes(candidate.position);
    return ["QB", "RB", "WR", "TE"].includes(candidate.position);
  };
  const document = {
    title: "YOUR TURN, DRAFT NOW | Live NFL Draft",
    body: { innerText: "YOUR TURN • ROUND 1, PICK 6\nYOUR TEAM (0/19)" },
    querySelectorAll(selector) {
      if (selector === "select") return [select];
      if (selector === '[role="dialog"]') return [];
      const rows = board.filter((candidate) => !drafted.has(candidate.yahooId) && visibleForFilter(candidate)).map((candidate) => {
        const displayedPosition = candidate.position === "D" ? "DT" : candidate.position;
        const draftButton = {
          disabled: false,
          innerText: "Draft",
          querySelector: () => null,
          click() {
            clicked.push({ ...candidate, displayedPosition });
            drafted.add(candidate.yahooId);
            filled += 1;
            if (filled < testConfig.rounds) {
              const round = filled + 1;
              document.title = "YOUR TURN, DRAFT NOW | Live NFL Draft";
              document.body.innerText = `YOUR TURN • ROUND ${round}, PICK ${helpers.overallPick(round, 6, 12)}\nYOUR TEAM (${filled}/19)`;
            } else {
              document.title = "Draft complete | Live NFL Draft";
              document.body.innerText = "YOUR TEAM (19/19)";
            }
          },
        };
        const playerNode = {
          innerText: `${candidate.name}\n${displayedPosition}\n${candidate.team || "Bye 12"}`,
          getAttribute: (name) => name === "data-id" ? candidate.yahooId : null,
          querySelector: (selector) => selector === "img[title]" ? { getAttribute: () => candidate.name } : null,
        };
        return {
          querySelector: (selector) => selector === ".ys-player[data-id]" ? playerNode : null,
          querySelectorAll: (selector) => selector === "button" ? [draftButton] : [],
        };
      });
      if (selector === "tr") return rows;
      if (selector === "button") return [...rows.flatMap((row) => row.querySelectorAll("button")), { innerText: "Autodraft", querySelector: () => null }];
      return [];
    },
  };
  const context = {
    clearInterval,
    console,
    crypto,
    Date,
    Event: class Event { constructor(type) { this.type = type; } },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    localStorage: storageFixture(),
    location: { pathname: "/draftclient/f1/18599/12", assign() {} },
    Math,
    setInterval,
    setTimeout,
  };
  context.document = document;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(controllerSource, context);
  vm.runInContext(source, context);
  const runner = context.SKRODZKaiYahooMockRunner.create({
    board,
    configName: "test_league_19_idp",
    executionMode: "TEST",
    expectedRoomId: "18599",
    expectedSeat: 6,
    expectedUrlSeat: 12,
    observedTeamCount: 12,
    observedRosterSlots: testConfig.rosterSlots,
  }, context).start();
  t.after(() => runner.stop());
  await waitFor(() => runner.getStatus().state === "completed", 5000);
  assert.equal(runner.getStatus().failure, null);
  assert.equal(clicked.length, 19);
  const counts = helpers.positionCounts(runner.getStatus().picks);
  assert.equal(["QB", "RB", "WR", "TE"].reduce((sum, position) => sum + (counts[position] ?? 0), 0), 13);
  for (const position of ["K", "DEF", "D", "LB", "CB", "S"]) assert.equal(counts[position], 1);
  assert.equal(clicked.find((pick) => pick.position === "D")?.displayedPosition, "DT");
});

test("halt during filter arming prevents a controller from being created", async () => {
  let controllerCreates = 0;
  const select = {
    value: "all",
    options: [
      { textContent: "All Positions", value: "all" },
      { textContent: "Team Defenses", value: "def" },
      { textContent: "Kickers", value: "k" },
    ],
    dispatchEvent() {},
  };
  const controllerApi = {
    runtime: {
      isAutodraftActive: () => false,
      parseRoom: () => ({ roomId: "9378515", seat: 6 }),
      parseRosterCount: () => ({ filled: 0, total: 15 }),
      readPlayerRow: (row) => row.player,
    },
    create() {
      controllerCreates += 1;
      throw new Error("controller must not be created after halt");
    },
  };
  const api = loadRunner(controllerApi);
  const environment = {
    Event: class Event {
      constructor(type) {
        this.type = type;
      }
    },
    SKRODZKaiYahooDraftController: controllerApi,
    clearInterval,
    crypto,
    document: {
      body: { innerText: "YOUR TEAM (0/15)" },
      querySelectorAll(selector) {
        if (selector === "select") return [select];
        if (selector === "tr") return [];
        return [];
      },
    },
    localStorage: storageFixture(),
    location: { pathname: "/draftclient/f1/9378515/6" },
    setInterval,
    setTimeout,
  };
  const runner = api.create({
    board: genericBoard(),
    expectedRoomId: "9378515",
    expectedSeat: 6,
    observedTeamCount: 12,
    observedRosterSlots: mockConfig.rosterSlots,
    filterDeadlineMs: 200,
  }, environment).start();

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(runner.getStatus().busy, true);
  runner.halt("handoff_drill");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(runner.getStatus().state, "halted");
  assert.equal(controllerCreates, 0);
  assert.equal(runner.exportReceipts().at(-1).reason, "handoff_drill");
});
