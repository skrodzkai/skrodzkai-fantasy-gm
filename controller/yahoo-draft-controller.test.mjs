import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./yahoo-draft-controller.js", import.meta.url), "utf8");
const readerSource = await readFile(new URL("./yahoo-page-readers.js", import.meta.url), "utf8");
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
    body: "YOUR TURN • ROUND 1, PICK 8\nYOUR TEAM (0/15)",
  });
  draftButton.click = () => click?.({ document, location });
  const row = {
    querySelector: (selector) => (selector === ".ys-player[data-id]" ? playerNode : null),
    querySelectorAll: (selector) => (selector === "button" ? [draftButton] : []),
  };
  document.querySelectorAll = (selector) => {
    if (selector === "button") return [draftButton, button("Autodraft")];
    if (selector === "tr") return [row];
    if (selector === '[role="dialog"]') return [];
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
});

test("detects checked Autodraft rather than the unrelated refresh icon", () => {
  const inactive = documentFixture({ buttons: [button("", "refresh"), button("Autodraft")] });
  const active = documentFixture({ buttons: [button("", "refresh"), button("Autodraft", "checkmark-default")] });
  assert.equal(helpers.isAutodraftActive(inactive), false);
  assert.equal(helpers.isAutodraftActive(active), true);
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
    document: documentFixture({ title: "5 picks until your turn", body: "YOUR TEAM (0/15)" }),
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
      document.body.innerText = "BRIAN's Pick • You're up in 14 Picks\nYOUR TEAM (1/15)";
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

test("waits for the turn banner after a non-atomic roster repaint", async (t) => {
  const environment = liveEnvironment({
    click: ({ document }) => {
      document.body.innerText = "YOUR TURN • ROUND 1, PICK 8\nYOUR TEAM (1/15)";
      setTimeout(() => {
        document.title = "14 picks until your turn | Live NFL Draft";
        document.body.innerText = "BRIAN's Pick • You're up in 14 Picks\nYOUR TEAM (1/15)";
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
      document.body.innerText = "YOUR TURN • ROUND 2, PICK 1\nYOUR TEAM (1/15)";
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
  environment.document.body.innerText = "YOUR TEAM (0/15)";
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
