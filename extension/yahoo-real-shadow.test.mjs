import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { realScoringRows, realSettingsTables } from "../tests/fixtures/real-league-settings.mjs";
import { SCORING_SCHEMA_HASH } from "../analysis/build-v5-board.mjs";

const readerSource = await readFile(new URL("../controller/yahoo-page-readers.js", import.meta.url), "utf8");
const shadowSource = await readFile(new URL("./yahoo-real-shadow.js", import.meta.url), "utf8");
const runnerSource = await readFile(new URL("../controller/yahoo-mock-runner.js", import.meta.url), "utf8");
const context = { clearInterval, console, crypto, Date, Event:class Event {}, Math, setInterval, setTimeout };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(readerSource, context);
vm.runInContext(runnerSource, context);
vm.runInContext(shadowSource, context);
const helpers = context.SKRODZKaiYahooRealShadow._test;

function healthyBoard(now = Date.now()) {
  return {
    ...helpers.scoringIdentity,
    replacementRoster:{ teamCount:12, rosterSlots:helpers.expectedRoster.filter((s) => !["BN", "IR"].includes(s)) },
    replacementBySlot:{QB:300,WR:150,RB:180,TE:120,"W/R/T":140,K:80,DEF:75,D:60,DB:60,LB:60},
    generatedAt:new Date(now - 100).toISOString(),
    sourceExpirations:[{sourceId:"yahoo",observedAt:new Date(now - 100).toISOString(),maxAgeHours:6}],
    marketAdpReceipt:{ observedAt:new Date(now - 100).toISOString(), sourceAsOf:new Date(now - 100).toISOString(), rows:218 },
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
  "Passing Touchdowns\tYahoo Default\t6",
  "Receptions\t.25",
  "Roster Positions:\tQB, WR, WR, WR, RB, RB, TE, W/R/T, K, DEF, D, DB, LB, BN, BN, BN, BN, BN, BN, IR",
].join("\n");

function documentFixture(body, { title = "", buttons = [], rows = [], scoring = realScoringRows, teams = [], headings = [] } = {}) {
  return { title, body:{ innerText:body }, querySelectorAll(selector) {
    if (selector === "table") return realSettingsTables(scoring);
    if (selector === "button") return buttons;
    if (selector === "tr") return rows;
    if (selector === '.ys-team[data-id]') return teams;
    if (selector === "h1,h2,h3,h4,h5,h6,div,span") return headings;
    return [];
  } };
}

test("verifies the exact real league settings while keeping team ID separate from draft slot", () => {
  const settings = helpers.parseSettings(documentFixture(settingsBody), { pathname:"/f1/420010/settings" });
  assert.equal(settings.ready, true);
  assert.equal(settings.teamId, 7);
  assert.deepEqual([...settings.rosterSlots], [...helpers.expectedRoster]);
  assert.equal(helpers.parseDraftSlot("Your Draft Position: 11th"), 11);
  assert.equal(helpers.parseDraftSlot("Draft position pending"), null);
});

function advisoryFixture({ ownedIds = [], seat = 6, visibleCount = 6 } = {}) {
  const now = Date.now();
  const players = Array.from({length:8}, (_, i) => ({
    yahooId:String(101 + i), name:`Player ${i}`, team:"BUF", position:i === 7 ? "QB" : "WR", eligible:[i === 7 ? "QB" : "WR"],
    rank:i + 1, projection:i === 7 ? 500 : 240 - i, perGamePoints:15, vor:100, automaticEligible:true, manualEligible:true,
    weeklyPoints:Array.from({length:17}, (_, w) => w === 6 ? 0 : (i === 7 ? 500 : 240 - i) / 16), bye:7,
  }));
  const rows = players.slice(0, visibleCount).map((p) => {
    const node = {innerText:`${p.name}\n${p.position}\n${p.team}`, getAttribute:() => p.yahooId, querySelector:() => null};
    const button = {innerText:"Draft",disabled:false};
    return {querySelector:() => node, querySelectorAll:(selector) => selector === "button" ? [button] : [], node, button};
  });
  const first = Array.from({length:12}, (_, i) => String(i + 1));
  [first[seat - 1], first[6]] = [first[6], first[seat - 1]];
  const teams = Array.from({length:19}, (_, round) => round % 2 ? [...first].reverse() : first).flat()
    .map((id) => ({getAttribute:() => id, textContent:id === "7" ? "You" : "Opponent"}));
  const round = ownedIds.length + 1;
  const overall = context.SKRODZKaiYahooMockRunner.decision.overallPick(round, seat, 12);
  const rosterText = `YOUR TEAM (${ownedIds.length}/19)`;
  const headings = ownedIds.length ? [{innerText:rosterText, querySelectorAll:() => ownedIds.map((id) => ({getAttribute:() => id}))}] : [];
  const document = documentFixture(`${rosterText}\nYOUR QUEUE IS EMPTY\nYOUR TURN • ROUND ${round}, PICK ${overall}`, {
    title:"YOUR TURN | Live NFL Draft", teams, rows, headings,
    buttons:[{innerText:"Autodraft",querySelector:() => null}],
  });
  const boardData = {...healthyBoard(now),players};
  const settings = helpers.settingsReceipt(helpers.parseSettings(documentFixture(settingsBody), {pathname:"/f1/420010/settings"}), now);
  const input = {documentRef:document, locationRef:{pathname:"/draftclient/f1/420010/7"}, settings, boardData, now,
    attestation:{ok:true,version:"0.16.4",digest:"a".repeat(64),bootId:"boot-12345678",bootedAt:now}};
  return { input, rows, players, document, teams };
}

test("REAL recommendations use only fresh visible identities and a separately observed snake slot", () => {
  const f = advisoryFixture();
  const snapshot = helpers.buildSnapshot(f.input);
  assert.equal(snapshot.shadow.adviceError, null);
  assert.equal(snapshot.context.seat, 6);
  assert.equal(snapshot.context.teamId, 7);
  assert.equal(snapshot.recommendations.length, 5);
  assert.ok(snapshot.recommendations.every((p) => p.yahooId !== "108"), "hidden high-value QB is not called available");
  assert.match(snapshot.ladderState, /VISIBLE POOL/);
  assert.equal(snapshot.context.armed, false);
  assert.equal(snapshot.controls.arm.disabled, true);
  assert.ok(snapshot.shadow.decision.recomputeMs < 1000);
  assert.equal(snapshot.between.nextPick, 19);
  assert.equal(snapshot.between.intervening, 12);
});

test("REAL advisory clears recommendations on every missing or conflicting input", () => {
  const cases = [
    (f) => {f.input.settings = null;},
    (f) => {f.input.attestation = null;},
    (f) => {f.input.boardData.leagueId = "542830";},
    (f) => {f.teams[0].getAttribute = () => "7";},
    (f) => {f.document.title = "Waiting";},
    (f) => {f.document.body.innerText = f.document.body.innerText.replace("(0/19)", "(1/19)");},
    (f) => {f.rows[0].node.innerText = "Player 0\nWR\nSEA";},
    (f) => {f.rows[1].node.getAttribute = () => "101";},
    (f) => {f.rows.forEach((row) => {row.button.disabled = true;});},
    (f) => {f.input.now += 7 * 3600000;},
  ];
  for (const change of cases) {
    const f = advisoryFixture(); change(f);
    const snapshot = helpers.buildSnapshot(f.input);
    assert.equal(snapshot.recommendations.length, 0, change.toString());
    assert.equal(snapshot.controls.arm.disabled, true);
  }
});

test("REAL visible-pool advice labels unmodelled rows and accepts Yahoo name abbreviations", () => {
  const f = advisoryFixture();
  f.rows[0].node.getAttribute = () => "UNMODELLED";
  f.rows[1].node.innerText = "P. One\nWR\nBUF";
  const snapshot = helpers.buildSnapshot(f.input);
  assert.equal(snapshot.shadow.adviceError, null);
  assert.equal(snapshot.shadow.unmodelledVisibleRows, 1);
  assert.ok(snapshot.recommendations.every((p) => p.yahooId !== "UNMODELLED"));
  assert.match(snapshot.warnings.map((w) => w.text).join(" "), /lack a usable model/);
});

test("REAL advice recomputes from observed roster membership, not an assumed slot assignment", () => {
  const f = advisoryFixture({ownedIds:["108"]});
  const snapshot = helpers.buildSnapshot(f.input);
  assert.equal(snapshot.shadow.adviceError, null);
  assert.equal(snapshot.context.round, 2);
  assert.equal(snapshot.roster[0].player.yahooId, "108");
  assert.equal(snapshot.roster[0].slot, "OBSERVED");
  assert.match(snapshot.latestText, /not verified Yahoo slot placement/);
});

test("REAL visible DEF identity accepts Yahoo's missing team line", () => {
  const f = advisoryFixture();
  Object.assign(f.players[0], {name:"Bills",position:"DEF",eligible:["DEF"]});
  f.rows[0].node.innerText = "Bills\nDEF";
  assert.equal(helpers.buildSnapshot(f.input).shadow.adviceError, null);
});

test("REAL advice refuses conflicting rendered own-roster identity sets", () => {
  const f = advisoryFixture({ownedIds:["108"]});
  const original = f.document.querySelectorAll;
  f.document.querySelectorAll = (selector) => selector === "h1,h2,h3,h4,h5,h6,div,span"
    ? ["108","107"].map((id) => ({innerText:"YOUR TEAM (1/19)",querySelectorAll:() => [{getAttribute:() => id}]}))
    : original(selector);
  const snapshot = helpers.buildSnapshot(f.input);
  assert.equal(snapshot.shadow.adviceError, "real_roster_identity_unreadable");
  assert.equal(snapshot.recommendations.length, 0);
});

test("fails closed on any clock, scoring, identity, or roster mismatch", () => {
  for (const changed of [
    settingsBody.replace("30 Seconds", "1 Minute"),
    settingsBody.replace("2 minute Drillers", "Other League"),
    settingsBody.replace(", DB", ""),
  ]) {
    assert.equal(helpers.parseSettings(documentFixture(changed), { pathname:"/f1/420010/settings" }).ready, false);
  }
});

test("full observed REAL scoring rejects every altered/missing row and ignores Yahoo defaults", () => {
  const parse = (scoring) => helpers.parseSettings(documentFixture(settingsBody, {scoring}), {pathname:"/f1/420010/settings"});
  assert.equal(helpers.scoringIdentity.scoringSchemaHash, SCORING_SCHEMA_HASH);
  assert.equal(parse(realScoringRows).ready, true);
  for (let index = 0; index < realScoringRows.length; index += 1) {
    const changed = structuredClone(realScoringRows);
    changed[index][1] = "999";
    if (realScoringRows[index][1] !== "League Value") assert.equal(parse(changed).ready, false, realScoringRows[index][0]);
    assert.equal(parse(realScoringRows.filter((_, i) => i !== index)).ready, false);
  }
  assert.equal(parse([...realScoringRows, ["Extra category", "1"]]).ready, false);
  assert.equal(parse([...realScoringRows, ...realScoringRows]).ready, false);
  assert.equal(parse(realScoringRows.map(([label, value]) => [label, value, "999"])).ready, true);
  const receipt = helpers.settingsReceipt(parse(realScoringRows), 1000);
  for (const key of ["leagueId", "scoringModel", "scoringSchemaHash", "teamId"]) assert.equal(helpers.validSettingsReceipt({...receipt, [key]:"wrong"}, 1001), false);
  assert.equal(helpers.validSettingsReceipt({...receipt, expiresAt:receipt.expiresAt + 1}, 1001), false);
});

test("REAL board cannot borrow a TEST identity, replacement roster, or expired source", () => {
  const now = 1000;
  const board = healthyBoard(now);
  for (const key of ["leagueId", "scoringModel", "scoringSchemaHash"]) assert.equal(helpers.boardHealth({...board, [key]:"TEST"}, now).ready, false);
  for (const replacementRoster of [{teamCount:10,rosterSlots:board.replacementRoster.rosterSlots}, {teamCount:12,rosterSlots:["QB"]}]) assert.equal(helpers.boardHealth({...board,replacementRoster},now).ready,false);
  assert.equal(helpers.boardHealth({...board, sourceExpirations:[{sourceId:"yahoo",observedAt:new Date(now-7*3600000).toISOString(),maxAgeHours:6}]},now).ready,false);
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

test("REAL SHADOW displays healthy runtime identity and locks when attestation is unavailable", () => {
  const document = documentFixture(settingsBody);
  const attestation = { ok:true, version:"0.16.4", digest:"a".repeat(64), bootId:"boot-12345678", bootedAt:1_000 };
  const healthy = helpers.buildSnapshot({ documentRef:document, locationRef:{ pathname:"/f1/420010/settings" }, settings:null, boardData:healthyBoard(1_000), attestation, now:1_001 });
  assert.equal(healthy.label, "REAL SHADOW · READ ONLY");
  assert.equal(healthy.attestation.digest, "a".repeat(64));
  const missing = helpers.buildSnapshot({ documentRef:document, locationRef:{ pathname:"/f1/420010/settings" }, settings:null, boardData:healthyBoard(1_000), now:1_001 });
  assert.equal(missing.label, "REAL SHADOW LOCKED");
  assert.ok(missing.warnings.some((warning) => /Runtime attestation is unavailable/.test(warning.text)));
  assert.match(shadowSource, /Runtime \$\{runtimeText\}/);
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
    createElement() { return { id:"", textContent:"", style:{}, setAttribute() {} }; },
    querySelectorAll(selector) { return selector === "table" && body.innerText === settingsBody ? realSettingsTables() : []; },
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
    SKRODZKaiYahooRealBoard:healthyBoard(),
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
