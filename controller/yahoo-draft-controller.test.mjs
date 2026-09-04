import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { evaluateTestDraftExport } from "../analysis/test-draft-acceptance.mjs";

const source = await readFile(new URL("./yahoo-draft-controller.js", import.meta.url), "utf8");
const readerSource = await readFile(new URL("./yahoo-page-readers.js", import.meta.url), "utf8");
const runnerSource = await readFile(new URL("./yahoo-mock-runner.js", import.meta.url), "utf8");
const context = {
  clearInterval,
  console,
  crypto,
  Date,
  Math,
  setInterval,
  setTimeout,
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(readerSource, context);
vm.runInContext(source, context);
vm.runInContext(runnerSource, context);
const helpers = context.SKRODZKaiYahooDraftController._test;
const controllerApi = context.SKRODZKaiYahooDraftController;

function button(text, icon = null, disabled = false) {
  return {
    disabled,
    innerText: text,
    querySelector(selector) {
      return selector === 'svg[data-icon="checkmark-default"]' && icon === "checkmark-default" ? {} : null;
    },
  };
}

function documentFixture({ title = "", body = "", buttons = [], rows = [] } = {}) {
  return {
    title,
    body: { innerText: body },
    querySelectorAll(selector) {
      if (selector === "button") return buttons;
      if (selector === "tr") return rows;
      return [];
    },
  };
}

function storageFixture() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function liveEnvironment({ click, confirmationDeadlineMs = 200 } = {}) {
  const location = {
    assigned: null,
    pathname: "/draftclient/f1/9369352/8",
    assign(path) {
      this.assigned = path;
    },
  };
  const playerNode = {
    innerText: "D. Jones\nQB\nInd\nBye 13",
    getAttribute: (name) => (name === "data-id" ? "31838" : null),
    querySelector: (selector) => (selector === "img[title]" ? { getAttribute: () => "D. Jones" } : null),
  };
  const draftButton = button("Draft");
  const document = documentFixture({
    title: "YOUR TURN, DRAFT NOW | Live NFL Draft",
    body: "00:59\nYOUR TURN • ROUND 1, PICK 8\nYOUR TEAM (0/15)\nAutodraft will pick from queue\nYour queue is empty.",
  });
  document.confirmedYahooIds = null;
  const rosterPlayerNode = (yahooId) => ({ getAttribute:(name) => name === "data-id" ? yahooId : null });
  const rosterPanel = {
    get innerText() { return document.body.innerText; },
    querySelectorAll(selector) {
      if (selector !== ".ys-player[data-id]") return [];
      const filled = Number(document.body.innerText.match(/YOUR TEAM \((\d+)\//)?.[1] ?? 0);
      const ids = document.confirmedYahooIds ?? (filled > 0 ? ["31838"] : []);
      return ids.map(rosterPlayerNode);
    },
    parentElement:null,
  };
  const rosterHeading = {
    get innerText() { return document.body.innerText.match(/YOUR TEAM \(\d+\/\d+\)/)?.[0] ?? ""; },
    querySelectorAll:() => [],
    parentElement:rosterPanel,
  };
  draftButton.click = () => click?.({ document, location });
  const row = {
    querySelector: (selector) => (selector === ".ys-player[data-id]" ? playerNode : null),
    querySelectorAll: (selector) => (selector === "button" ? [draftButton] : []),
  };
  document.querySelectorAll = (selector) => {
    if (selector === "button") return [draftButton, button("Autodraft")];
    if (selector === "tr") return [row];
    if (selector === '[role="dialog"]') return [];
    if (selector === "h1,h2,h3,h4,h5,h6,div,span") return [rosterHeading];
    return [];
  };
  return {
    clearInterval,
    confirmationDeadlineMs,
    crypto: { randomUUID: () => `session-${Math.random()}` },
    document,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    localStorage: storageFixture(),
    location,
    setInterval,
    setTimeout,
  };
}

async function waitFor(predicate, timeoutMs = 500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not reached before timeout");
}

test("production readers, runner and click controller produce 19 gradeable TEST picks including an on-clock override", async () => {
  const runnerApi = context.SKRODZKaiYahooMockRunner;
  const config = runnerApi.configs.test_league_19_idp;
  const board = ["QB", "RB", "WR", "TE", "K", "DEF", "LB", "CB"].flatMap((position, positionIndex) =>
    Array.from({ length:20 }, (_, index) => ({
      yahooId:String(50000 + positionIndex * 100 + index), name:`${position} Player ${index}`,
      position, team:position === "DEF" ? "" : "BUF", eligible:position === "LB" ? ["LB", "D"] : position === "CB" ? ["CB", "DB", "D"] : [position],
      rank:positionIndex * 20 + index + 1, projection:500 - positionIndex * 35 - index,
      replacementPoints:100, vor:400 - positionIndex * 35 - index,
      adpLow:positionIndex * 20 + index + 10, adpHigh:positionIndex * 20 + index + 30,
      automaticEligible:true, manualEligible:true,
    })));
  const rosterIds = [];
  const clickedIds = [];
  const document = documentFixture();
  const setTurn = (round) => {
    const pick = runnerApi._test.overallPick(round, 1, 12);
    document.title = round <= 19 ? "YOUR TURN, DRAFT NOW | Live NFL Draft" : "Draft complete";
    document.body.innerText = `00:30\n${round <= 19 ? `YOUR TURN • ROUND ${round}, PICK ${pick}` : "Draft complete"}\nYOUR TEAM (${rosterIds.length}/19)\nYour queue is empty.`;
  };
  const rows = board.map((entry) => {
    const playerNode = {
      innerText:`${entry.name}\n${entry.position}\n${entry.team ? `${entry.team}\n` : ""}Bye 7`,
      getAttribute:(key) => key === "data-id" ? entry.yahooId : null,
      querySelector:() => null,
    };
    const draftButton = button("Draft");
    draftButton.click = () => {
      assert.ok(!clickedIds.includes(entry.yahooId), "no repeated click");
      clickedIds.push(entry.yahooId);
      rosterIds.push(entry.yahooId);
      // Adjacent snake turns can open immediately, with no off-turn frame.
      setTurn(rosterIds.length + 1);
    };
    return { entry, draftButton, querySelector:(selector) => selector === ".ys-player[data-id]" ? playerNode : null, querySelectorAll:(selector) => selector === "button" ? [draftButton] : [] };
  });
  const rosterPanel = {
    get innerText() { return `YOUR TEAM (${rosterIds.length}/19)`; },
    querySelectorAll:(selector) => selector === ".ys-player[data-id]" ? rosterIds.map((id) => ({ getAttribute:(key) => key === "data-id" ? id : null })) : [],
    parentElement:null,
  };
  const heading = { get innerText() { return rosterPanel.innerText; }, querySelectorAll:() => [], parentElement:rosterPanel };
  const labels = runnerApi._test.requiredTestFilterLabels();
  const select = { value:"All Positions", options:Array.from(labels, (label) => ({ value:label, textContent:label })), dispatchEvent() {} };
  document.querySelectorAll = (selector) => {
    if (selector === "button") return [button("Autodraft")];
    if (selector === "tr") return rows.filter((row) => !rosterIds.includes(row.entry.yahooId));
    if (selector === "select") return [select];
    if (selector === "h1,h2,h3,h4,h5,h6,div,span") return [heading];
    return [];
  };
  setTurn(1);
  const storage = storageFixture();
  const environment = { document, location:{ pathname:"/draftclient/f1/542830/3" }, localStorage:storage,
    crypto, clearInterval, clearTimeout, setInterval, setTimeout,
    Event:class Event { constructor(type) { this.type=type; } },
    getComputedStyle:() => ({ display:"block", visibility:"visible" }),
    SKRODZKaiYahooDraftController:controllerApi,
  };
  const runtimeAttestation = { ok:true, version:"0.16.2", digest:"a".repeat(64), bootId:"synthetic-boot-1234", bootedAt:1 };
  const runner = runnerApi.create({
    configName:"test_league_19_idp", executionMode:"TEST", expectedRoomId:"542830", expectedSeat:1, expectedUrlSeat:3,
    observedTeamCount:12, observedRosterSlots:config.rosterSlots, board, selectionHoldMs:100, minimumFallbacks:5,
    replacementBySlot:{ QB:300, RB:180, WR:170, TE:140, "W/R/T":175, K:80, DEF:75, D:70 },
    assertRunnerLease:() => true,
    runtimeAttestation,
  }, environment);
  runner.start();
  try {
    await waitFor(() => runner.getStatus().pendingDecision !== null);
    const baseline = runner.exportReceipts().find((row) => row.kind === "runner_turn_resolved").decision.targetYahooIds;
    const override = board.find((player) => player.position === "RB" && !baseline.includes(player.yahooId));
    assert.ok(override, "the override must be outside all five baseline targets");
    assert.equal(runner.chooseOnClock(override.yahooId, "test_operator"), true);
    await waitFor(() => ["completed", "failed"].includes(runner.getStatus().state), 10_000);
    const status = runner.getStatus();
    assert.equal(status.state, "completed", JSON.stringify(status.failure));
    assert.equal(clickedIds.length, 19);
    assert.deepEqual(Array.from(status.picks, (pick) => pick.yahooId), clickedIds);
    const controllers = JSON.parse(storage.getItem(controllerApi.receiptKey));
    assert.equal(controllers.filter((row) => row.kind === "draft_click").length, 19);
    assert.equal(controllers.filter((row) => row.kind === "pick_confirmed").length, 19);
    assert.ok(status.picks.every((pick) => pick.turnDetectionToClickMs < 2000));
    assert.ok(!runner.exportReceipts().some((row) => row.kind === "runner_failed"));
    assert.equal(clickedIds[0], override.yahooId);
    // Only the final Yahoo roster/attestation envelope is synthetic. Runner and
    // click-controller receipts are consumed untouched, as the extension exports them.
    const finalRosterSlots = runnerApi._test.allocateRosterSlots(status.picks, config.rosterSlots).map((entry) => ({
      slot:entry.slot, yahooId:entry.player?.yahooId ?? null, name:entry.player?.name ?? null, empty:!entry.player,
    }));
    const payload = {
      extensionVersion:"0.16.2", runtimeAttestation, roomId:status.roomId, seat:status.seat, urlSeat:status.urlSeat, status,
      operatorAttestation:{ status:"none", source:"operator_attested", attestedAt:new Date().toISOString(), interventions:[] },
      runnerReceipts:runner.exportReceipts(), controllerReceipts:controllers,
      extensionReceipts:[{ at:new Date().toISOString(), version:"0.16.2", roomId:status.roomId, seat:status.seat,
        urlSeat:status.urlSeat, runId:status.runId, kind:"final_roster_readback", valid:true, finalRosterSlots }],
    };
    const result = evaluateTestDraftExport(payload);
    assert.equal(result.status, "PASS", JSON.stringify(result.errors));
    assert.equal(result.picks[0].replayMode, "ON_CLOCK_OVERRIDE");
    assert.equal(result.picks[0].targetIndex, -1);
    const choice = payload.runnerReceipts.find((entry) => entry.kind === "runner_on_clock_choice_applied");
    assert.equal(typeof choice.turn, "string", "the grader must use the producer's string turn contract");
    const wrongTurn = structuredClone(payload);
    wrongTurn.runnerReceipts.find((entry) => entry.kind === "runner_on_clock_choice_applied").turn = { label:choice.turn };
    assert.ok(evaluateTestDraftExport(wrongTurn).errors.includes("on_clock_choice_unknown_turn"));
    const missingChoice = { ...payload, runnerReceipts:payload.runnerReceipts.filter((entry) => entry !== choice) };
    assert.ok(evaluateTestDraftExport(missingChoice).errors.includes("round_1_unintended_selection"));
  } finally { runner.stop("test_cleanup"); }
});

test("requires both the live title and exact owned-turn banner", () => {
  const stale = documentFixture({
    title: "2 picks until your turn | Live NFL Draft",
    body: "YOUR TURN - 17TH PICK\nYOUR TEAM (0/15)",
  });
  assert.equal(helpers.readOwnedTurn(stale), null);

  const live = documentFixture({
    title: "YOUR TURN, DRAFT NOW | Live NFL Draft",
    body: "YOUR TURN • ROUND 1, PICK 8\nYOUR TURN - 17TH PICK\nYOUR TEAM (0/15)",
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.readOwnedTurn(live))),
    { label: "R1P8", round: 1, pick: 8 },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(controllerApi.runtime.readOwnedTurn(live))),
    { label: "R1P8", round: 1, pick: 8 },
  );
  assert.equal(controllerApi.runtime.readOwnedTurnState(live).state, "OWNED");
  assert.equal(controllerApi.runtime.readOwnedTurnState(stale).state, "OFF_TURN");
  assert.equal(controllerApi.runtime.readOwnedTurnState(documentFixture({ title:"YOUR TURN, DRAFT NOW", body:"YOUR TEAM (0/15)" })).state, "INCONSISTENT");
});

test("detects checked Autodraft rather than the unrelated refresh icon", () => {
  const inactive = documentFixture({ buttons: [button("", "refresh"), button("Autodraft")] });
  const active = documentFixture({ buttons: [button("", "refresh"), button("Autodraft", "checkmark-default")] });
  const unknown = documentFixture({ buttons: [button("", "refresh")] });
  assert.equal(helpers.isAutodraftActive(inactive), false);
  assert.equal(helpers.isAutodraftActive(active), true);
  assert.equal(helpers.readAutodraftState(inactive), "INACTIVE");
  assert.equal(helpers.readAutodraftState(active), "ACTIVE");
  assert.equal(helpers.readAutodraftState(unknown), "UNKNOWN");
  assert.equal(helpers.readQueueState(documentFixture({ body:"Autodraft will pick from queue\nYour queue is empty." })), "EMPTY");
  assert.equal(helpers.readQueueState(documentFixture({ body:"Queue\nPlayer One" })), "NONEMPTY_OR_UNKNOWN");
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.readDraftClock(documentFixture({ body:"00:37" })))), { label:"00:37", seconds:37 });
  assert.equal(helpers.readDraftClock(documentFixture({ body:"00:37\n01:05" })), null);
});

test("excludes chat text from turn, queue, and clock signals and blocks Yahoo selection takeover banners", () => {
  const chat = { innerText:"YOUR TURN • ROUND 9, PICK 99\n00:00\nQueue" };
  const document = documentFixture({ title:"2 picks until your turn", body:"00:37\nYOUR TEAM (0/15)\nAutodraft will pick from queue\nYour queue is empty.\nYOUR TURN • ROUND 9, PICK 99\n00:00\nQueue" });
  document.querySelectorAll = (selector) => selector.includes("contenteditable") ? [chat] : selector === "button" ? [button("Autodraft")] : [];
  assert.equal(helpers.readOwnedTurnState(document).state, "OFF_TURN");
  assert.equal(helpers.readQueueState(document), "EMPTY");
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.readDraftClock(document))), { label:"00:37", seconds:37 });
  const blocked = documentFixture({ body:"Yahoo is preparing your selection" });
  assert.deepEqual(Array.from(context.SKRODZKaiYahooPageReaders.blockers(blocked, context)), ["YAHOO PREPARING SELECTION"]);
});

test("parses the Yahoo room and roster transition", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.parseRoom("/draftclient/f1/9369352/8"))),
    { roomId: "9369352", seat: 8 },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.parseRosterCount("YOUR TEAM (2/15)"))),
    { filled: 2, total: 15 },
  );
});

test("matches Yahoo player ID before exact displayed identity", () => {
  const player = { yahooId: "31908", name: "T. McLaurin", position: "WR", team: "WAS" };
  assert.equal(helpers.matchesTarget(player, { yahooId: "31908" }), true);
  assert.equal(
    helpers.matchesTarget(player, { yahooId: "", name: "T. McLaurin", position: "wr", team: "Was" }),
    true,
  );
  assert.equal(
    helpers.matchesTarget(player, { yahooId: "", name: "T. McLaurin", position: "WR", team: "BUF" }),
    false,
  );
});

test("reads identity from the observed Yahoo player-row contract", () => {
  const playerNode = {
    innerText: "D. Jones\nQB\nInd\nBye 13",
    getAttribute(name) {
      return name === "data-id" ? "31838" : null;
    },
    querySelector(selector) {
      return selector === "img[title]" ? { getAttribute: () => "D. Jones" } : null;
    },
  };
  const row = {
    querySelector(selector) {
      return selector === ".ys-player[data-id]" ? playerNode : null;
    },
  };
  const player = helpers.readPlayerRow(row);
  assert.deepEqual(
    JSON.parse(JSON.stringify({ ...player, player: undefined, row: undefined })),
    { yahooId: "31838", name: "D. Jones", position: "QB", team: "IND" },
  );
});

test("reads a team defense row whose observed Yahoo contract has no team line", () => {
  const playerNode = {
    innerText: "Chargers\nDEF\nBye 12",
    getAttribute(name) {
      return name === "data-id" ? "100024" : null;
    },
    querySelector() {
      return null;
    },
  };
  const row = {
    querySelector(selector) {
      return selector === ".ys-player[data-id]" ? playerNode : null;
    },
  };
  const player = helpers.readPlayerRow(row);
  assert.deepEqual(
    JSON.parse(JSON.stringify({ ...player, player: undefined, row: undefined })),
    { yahooId: "100024", name: "Chargers", position: "DEF", team: "" },
  );
});

test("reads Yahoo CB, S, and DT specialist rows used by the test league", () => {
  for (const [yahooId, name, position, team] of [
    ["41001", "Corner One", "CB", "BUF"],
    ["41002", "Safety One", "S", "BAL"],
    ["41003", "Tackle One", "DT", "TEN"],
  ]) {
    const playerNode = {
      innerText: `${name}\n${position}\n${team}\nBye 9`,
      getAttribute: (attribute) => attribute === "data-id" ? yahooId : null,
      querySelector: (selector) => selector === "img[title]" ? { getAttribute: () => name } : null,
    };
    const row = { querySelector: (selector) => selector === ".ys-player[data-id]" ? playerNode : null };
    const observed = helpers.readPlayerRow(row);
    assert.deepEqual(
      JSON.parse(JSON.stringify({ ...observed, player: undefined, row: undefined })),
      { yahooId, name, position, team },
    );
  }
});

test("accepts only the exact player row's enabled Draft action", () => {
  const targetRow = documentFixture({
    buttons: [button("Draft"), button("Draft", null, true)],
  });
  const otherRow = documentFixture({ buttons: [button("Draft")] });
  assert.equal(helpers.findDraftButtons(targetRow).length, 1);
  assert.equal(helpers.findDraftButtons(otherRow).length, 1);
});

test("rejects empty, incomplete, and duplicate target ladders", () => {
  assert.throws(() => helpers.validateTargets([]), /nonempty/);
  assert.throws(() => helpers.validateTargets([{ name: "T. McLaurin", position: "WR" }]), /requires/);
  assert.throws(
    () => helpers.validateTargets([{ yahooId: "31908" }, { yahooId: "31908" }]),
    /duplicate/,
  );
});

test("allows only one page-resident controller", () => {
  const environment = {
    clearInterval() {},
    crypto: { randomUUID: () => "test-session" },
    document: documentFixture({ title: "5 picks until your turn", body: "YOUR TEAM (0/15)\nAutodraft will pick from queue\nYour queue is empty.", buttons:[button("Autodraft")] }),
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    localStorage: storageFixture(),
    location: { pathname: "/draftclient/f1/9369352/8", assign() {} },
    setInterval: () => 1,
    setTimeout,
  };
  const first = controllerApi.create({ targets: [{ yahooId: "31838" }] }, environment);
  assert.throws(
    () => controllerApi.create({ targets: [{ yahooId: "31908" }] }, environment),
    /another Yahoo draft controller/,
  );
  first.start();
  first.stop();
});

test("refuses a room, seat, or roster total that differs from preflight", () => {
  const environment = liveEnvironment();
  assert.throws(
    () => controllerApi.create({ targets: [{ yahooId: "31838" }], expectedRoomId: "9999999" }, environment),
    /does not match/,
  );
  assert.throws(
    () => controllerApi.create({ targets: [{ yahooId: "31838" }], expectedSeat: 7 }, environment),
    /does not match/,
  );
  assert.throws(
    () => controllerApi.create({ targets: [{ yahooId: "31838" }], expectedRosterTotal: 19 }, environment).start(),
    /roster total does not match/,
  );
});

test("clicks the exact row and confirms the roster transition", async (t) => {
  const environment = liveEnvironment({
    click: ({ document }) => {
      document.title = "14 picks until your turn | Live NFL Draft";
      document.body.innerText = "BRIAN's Pick • You're up in 14 Picks\nYOUR TEAM (1/15)\nAutodraft will pick from queue\nYour queue is empty.";
    },
  });
  const controller = controllerApi
    .create(
      { targets: [{ yahooId: "31838" }], pollMs: 25, confirmationDeadlineMs: 200 },
      environment,
    )
    .start();
  t.after(() => controller.stop());
  await waitFor(() => controller.getStatus().confirmedPicks === 1);
  assert.deepEqual(
    Array.from(controller.exportReceipts(), (entry) => entry.kind),
    ["controller_started", "draft_click", "pick_confirmed"],
  );
  assert.equal(environment.location.assigned, null);
  controller.stop();
});

test("fails closed when Yahoo rosters a different player ID after the click", async (t) => {
  const environment = liveEnvironment({
    click: ({ document }) => {
      document.confirmedYahooIds = ["99999"];
      document.title = "14 picks until your turn | Live NFL Draft";
      document.body.innerText = "BRIAN's Pick • You're up in 14 Picks\nYOUR TEAM (1/15)\nAutodraft will pick from queue\nYour queue is empty.";
    },
  });
  const controller = controllerApi
    .create({ targets:[{ yahooId:"31838" }], pollMs:25, confirmationDeadlineMs:200, failureAction:"stay" }, environment)
    .start();
  t.after(() => controller.stop());
  await waitFor(() => controller.getStatus().state === "failed");
  assert.match(controller.getStatus().failure.code, /^confirmed_player_identity_mismatch:expected_31838:observed_99999$/);
  assert.equal(controller.getStatus().confirmedPicks, 0);
});

test("waits for the turn banner after a non-atomic roster repaint", async (t) => {
  const environment = liveEnvironment({
    click: ({ document }) => {
      document.body.innerText = "00:58\nYOUR TURN • ROUND 1, PICK 8\nYOUR TEAM (1/15)\nAutodraft will pick from queue\nYour queue is empty.";
      setTimeout(() => {
        document.title = "14 picks until your turn | Live NFL Draft";
        document.body.innerText = "BRIAN's Pick • You're up in 14 Picks\nYOUR TEAM (1/15)\nAutodraft will pick from queue\nYour queue is empty.";
      }, 40);
    },
  });
  const controller = controllerApi
    .create(
      { targets: [{ yahooId: "31838" }], pollMs: 25, confirmationDeadlineMs: 200 },
      environment,
    )
    .start();
  t.after(() => controller.stop());
  await waitFor(() => controller.getStatus().confirmedPicks === 1);
  assert.equal(controller.getStatus().failure, null);
});

test("confirms a pick when the snake wrap immediately opens a new owned turn", async (t) => {
  let clickCount = 0;
  const environment = liveEnvironment({
    click: ({ document }) => {
      clickCount += 1;
      document.title = "YOUR TURN, DRAFT NOW | Live NFL Draft";
      document.body.innerText = "00:59\nYOUR TURN • ROUND 2, PICK 1\nYOUR TEAM (1/15)\nAutodraft will pick from queue\nYour queue is empty.";
    },
  });
  const controller = controllerApi
    .create(
      {
        targets: [{ yahooId: "31838" }],
        pollMs: 25,
        confirmationDeadlineMs: 200,
        maxConfirmedPicks: 1,
      },
      environment,
    )
    .start();
  t.after(() => controller.stop());
  await waitFor(() => controller.getStatus().confirmedPicks === 1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(controller.getStatus().failure, null);
  assert.equal(controller.getStatus().state, "completed");
  assert.equal(clickCount, 1);
  assert.equal(controller.exportReceipts().at(-1).kind, "pick_confirmed");
});

test("enforces the minimum available target count on the owned turn", async (t) => {
  const environment = liveEnvironment();
  const controller = controllerApi
    .create(
      {
        targets: [{ yahooId: "31838" }],
        pollMs: 25,
        minimumAvailableTargets: 5,
        failureAction: "stay",
      },
      environment,
    )
    .start();
  t.after(() => controller.stop());
  await waitFor(() => controller.getStatus().state === "failed");
  assert.equal(controller.getStatus().failure.code, "fewer_than_5_approved_targets_available");
  assert.equal(environment.location.assigned, null);
});

test("records failure and leaves the room when confirmation times out", async (t) => {
  const environment = liveEnvironment({ click() {} });
  const controller = controllerApi
    .create(
      { targets: [{ yahooId: "31838" }], pollMs: 25, confirmationDeadlineMs: 50 },
      environment,
    )
    .start();
  t.after(() => controller.stop());
  await waitFor(() => controller.getStatus().state === "failed");
  assert.equal(controller.getStatus().failure.code, "pick_confirmation_timeout");
  assert.equal(environment.location.assigned, "/f1/mock_lobby");
  assert.deepEqual(
    Array.from(controller.exportReceipts(), (entry) => entry.kind),
    ["controller_started", "draft_click", "controller_failed"],
  );
});

test("leaves the room even when the failure receipt cannot be written", async (t) => {
  const environment = liveEnvironment();
  environment.document.title = "5 picks until your turn | Live NFL Draft";
  environment.document.body.innerText = "YOUR TEAM (0/15)\nAutodraft will pick from queue\nYour queue is empty.";
  const controller = controllerApi
    .create({ targets: [{ yahooId: "31838" }], pollMs: 25 }, environment)
    .start();
  t.after(() => controller.stop());
  environment.localStorage.setItem(controllerApi.receiptKey, "not-json");
  environment.document.querySelectorAll = (selector) => {
    if (selector === "button") return [button("Autodraft", "checkmark-default")];
    if (selector === '[role="dialog"]') return [];
    return [];
  };
  await waitFor(() => controller.getStatus().state === "failed");
  assert.equal(environment.location.assigned, "/f1/mock_lobby");
  assert.match(controller.getStatus().failure.receiptError, /Unexpected token|JSON/);
});

test("can fail closed without navigating away from a real draft surface", async (t) => {
  const environment = liveEnvironment({ click() {} });
  const controller = controllerApi
    .create(
      {
        targets: [{ yahooId: "31838" }],
        pollMs: 25,
        confirmationDeadlineMs: 50,
        expectedRoomId: "9369352",
        expectedSeat: 8,
        expectedRosterTotal: 15,
        failureAction: "stay",
      },
      environment,
    )
    .start();
  t.after(() => controller.stop());
  await waitFor(() => controller.getStatus().state === "failed");
  assert.equal(controller.getStatus().failure.code, "pick_confirmation_timeout");
  assert.equal(environment.location.assigned, null);
});
