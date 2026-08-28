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
  const boardData = { generatedAt:new Date(900).toISOString(), injuryCoverage:{ complete:true }, byeCoverage:{ complete:true }, players:[] };
  const document = documentFixture("YOUR TEAM (4/19)", { buttons:[] });
  const snapshot = helpers.buildSnapshot({ documentRef:document, locationRef:{ pathname:"/draftclient/f1/420010/7" }, settings:receipt, boardData, now:1_001 });
  assert.equal(snapshot.mode, "REAL SHADOW");
  assert.equal(snapshot.context.teamId, 7);
  assert.equal(snapshot.context.armed, false);
  assert.equal(snapshot.controls.arm.disabled, true);
  assert.equal(snapshot.controls.halt.disabled, true);
  assert.equal(snapshot.controls.export.disabled, false);
  assert.equal(snapshot.shadow.roster.filled, 4);
  assert.equal(snapshot.recommendations.length, 0);
});

test("real shadow source contains no Yahoo execution primitive", () => {
  assert.doesNotMatch(shadowSource, /\.click\s*\(/);
  assert.doesNotMatch(shadowSource, /dispatchEvent\s*\(/);
  assert.doesNotMatch(shadowSource, /SKRODZKaiYahooDraftController/);
  assert.doesNotMatch(shadowSource, /setFilter\s*\(/);
  assert.doesNotMatch(shadowSource, /localStorage/);
});
