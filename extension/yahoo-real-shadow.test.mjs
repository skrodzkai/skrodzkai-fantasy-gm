import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const readerSource = await readFile(new URL("../controller/yahoo-page-readers.js", import.meta.url), "utf8");
const shadowSource = await readFile(new URL("./yahoo-real-shadow.js", import.meta.url), "utf8");
const context = { clearInterval, console, crypto, Date, Event:class Event {}, Math, setInterval, setTimeout };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(readerSource, context);
vm.runInContext(shadowSource, context);
const helpers = context.SKRODZKaiYahooRealShadow._test;

function healthyBoard(now = Date.now()) {
  return {
    generatedAt:new Date(now - 100).toISOString(),
    injuryCoverage:{ complete:true, checkedPlayers:1, expectedPlayers:1 },
    byeCoverage:{ complete:true, playersWithBye:1, playersTotal:1 },
    players:[],
  };
}

const settingsBody = [
  "League Name:\t2 minute Drillers",
  "Draft Type:\tLive Standard Draft",
  "Max Teams:\t12",
  "Live Draft Pick Time:\t30 Seconds",
  "Passing Touchdowns\t6",
  "Receptions\t.25",
  "Roster Positions:\tQB, WR, WR, WR, RB, RB, TE, W/R/T, K, DEF, D, DB, LB, BN, BN, BN, BN, BN, BN, IR",
].join("\n");

function documentFixture(body, { title = "", buttons = [], rows = [] } = {}) {
  return { title, body:{ innerText:body }, querySelectorAll(selector) { if (selector === "button") return buttons; if (selector === "tr") return rows; return []; } };
}

test("verifies the exact real league settings while keeping team ID separate from draft slot", () => {
  const settings = helpers.parseSettings(documentFixture(settingsBody), { pathname:"/f1/420010/settings" });
  assert.equal(settings.ready, true);
  assert.equal(settings.teamId, 7);
  assert.deepEqual([...settings.rosterSlots], [...helpers.expectedRoster]);
  assert.equal(helpers.parseDraftSlot("Your Draft Position: 11th"), 11);
  assert.equal(helpers.parseDraftSlot("Draft position pending"), null);
});

test("fails closed on any clock, scoring, identity, or roster mismatch", () => {
  for (const changed of [
    settingsBody.replace("30 Seconds", "1 Minute"),
    settingsBody.replace("Passing Touchdowns\t6", "Passing Touchdowns\t4"),
    settingsBody.replace("Receptions\t.25", "Receptions\t1"),
    settingsBody.replace("2 minute Drillers", "Other League"),
    settingsBody.replace(", DB", ""),
  ]) {
    assert.equal(helpers.parseSettings(documentFixture(changed), { pathname:"/f1/420010/settings" }).ready, false);
  }
});

test("draft-client snapshot is read-only and uses a fresh exact settings receipt", () => {
  const observed = helpers.parseSettings(documentFixture(settingsBody), { pathname:"/f1/420010/settings" });
  const receipt = helpers.settingsReceipt(observed, 1_000);
  const boardData = healthyBoard(1_000);
  const document = documentFixture("YOUR TEAM (4/19)", { buttons:[] });
  const snapshot = helpers.buildSnapshot({ documentRef:document, locationRef:{ pathname:"/draftclient/f1/420010/7" }, settings:receipt, boardData, now:1_001 });
  assert.equal(snapshot.mode, "REAL SHADOW");
  assert.equal(snapshot.context.teamId, 7);
  assert.equal(snapshot.context.armed, false);
  assert.equal(snapshot.controls.arm.disabled, true);
  assert.equal(snapshot.controls.halt.disabled, true);
  assert.equal(snapshot.controls.export.disabled, true);
  assert.equal(snapshot.shadow.roster.filled, 4);
  assert.equal(snapshot.recommendations.length, 0);
});

test("boot persists a settings receipt when Yahoo hydrates after document idle", async () => {
  let rail = null;
  let tick = null;
  const stored = new Map();
  const body = { innerText:"Loading settings…", append(element) { rail = element; } };
  const documentRef = {
    title:"",
    body,
    getElementById(id) { return rail?.id === id ? rail : null; },
    createElement() { return { id:"", textContent:"", setAttribute() {} }; },
    querySelectorAll() { return []; },
  };
  const messages = [];
  const environment = {
    chrome:{
      storage:{ session:{
        async get(key) { return stored.has(key) ? { [key]:stored.get(key) } : {}; },
        async set(update) { for (const [key, value] of Object.entries(update)) stored.set(key, value); },
        async remove(key) { stored.delete(key); },
      } },
      runtime:{ sendMessage(message) { messages.push(message); return Promise.resolve({ ok:true }); } },
    },
    document:documentRef,
    location:{ pathname:"/f1/420010/settings" },
    SKRODZKaiYahooMockBoard:healthyBoard(),
    setInterval(callback) { tick = callback; return 1; },
    clearInterval() {},
  };
  const handle = await context.SKRODZKaiYahooRealShadow.boot(environment);
  assert.equal(handle.getSnapshot().shadow.settingsVerified, false);
  body.innerText = settingsBody;
  tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(stored.has("skz.realShadowSettings"), true);
  assert.equal(handle.getSnapshot().shadow.settingsVerified, true);
  assert.equal(messages.at(-1).snapshot.mode, "REAL SHADOW");
});

test("real shadow source contains no Yahoo execution primitive", () => {
  assert.doesNotMatch(shadowSource, /\.click\s*\(/);
  assert.doesNotMatch(shadowSource, /dispatchEvent\s*\(/);
  assert.doesNotMatch(shadowSource, /SKRODZKaiYahooDraftController/);
  assert.doesNotMatch(shadowSource, /runtime\.onMessage/);
  assert.doesNotMatch(shadowSource, /setFilter\s*\(/);
  assert.doesNotMatch(shadowSource, /localStorage/);
});
