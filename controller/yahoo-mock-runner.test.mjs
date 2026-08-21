import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./yahoo-mock-runner.js", import.meta.url), "utf8");
const controllerSource = await readFile(new URL("./yahoo-draft-controller.js", import.meta.url), "utf8");

function loadRunner(controllerApi = {}) {
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

function player(position, number, rank) {
  return {
    yahooId: `${position}-${number}`,
    name: `${position} Player ${number}`,
    position,
    team: position === "DEF" ? "" : "TST",
    rank,
  };
}

function genericBoard() {
  const board = [];
  let rank = 1;
  for (const position of ["RB", "WR", "QB", "TE", "DEF", "K"]) {
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

test("the public policy always exposes at least five candidates through round 13", () => {
  const board = helpers.validateBoard(genericBoard());
  const picks = [];
  for (let round = 1; round <= 13; round += 1) {
    const availablePlayers = board.filter(
      (candidate) => !picks.some((pick) => pick.yahooId === candidate.yahooId),
    );
    const targets = helpers.buildTargets({
      round,
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

test("reserves the public mock specialist filters for rounds 14 and 15", () => {
  assert.equal(helpers.filterLabelForRound(13), "All Positions");
  assert.equal(helpers.filterLabelForRound(14), "Team Defenses");
  assert.equal(helpers.filterLabelForRound(15), "Kickers");
  assert.deepEqual(Array.from(helpers.allowedPositions(14, [], mockConfig)), ["DEF"]);
  assert.deepEqual(Array.from(helpers.allowedPositions(15, [], mockConfig)), ["K"]);
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
  assert.throws(() => api.create({ ...base, expectedSeat: 5 }, environment), /room or seat/);
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
                document.title = "YOUR TURN, DRAFT NOW | Live NFL Draft";
                document.body.innerText = `YOUR TURN • ROUND ${filled + 1}, PICK 6\nYOUR TEAM (${filled}/15)`;
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
  const armed = Array.from(runner.exportReceipts()).filter((entry) => entry.kind === "runner_round_armed");
  assert.equal(armed.at(-2).filterLabel, "Team Defenses");
  assert.equal(armed.at(-1).filterLabel, "Kickers");
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
  runner.halt("handoff_drill");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(runner.getStatus().state, "halted");
  assert.equal(controllerCreates, 0);
  assert.equal(runner.exportReceipts().at(-1).reason, "handoff_drill");
});
