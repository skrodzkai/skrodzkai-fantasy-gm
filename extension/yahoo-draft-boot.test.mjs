import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { withScoringTable } from "../tests/fixtures/league-two-settings.mjs";
import { makeDraftRail } from "../tests/fixtures/draft-rail.mjs";

const files = ["../controller/yahoo-page-readers.js", "../controller/yahoo-draft-controller.js", "../controller/yahoo-mock-runner.js", "yahoo-mock-extension.js"];
const sources = await Promise.all(files.map((file) => readFile(new URL(file, import.meta.url), "utf8")));
const preflightKey = "skrodzkai-yahoo-mock-extension-preflight-v1";
const receiptKey = "skrodzkai-yahoo-mock-extension-receipts-v1";
function storage() {
  const map = new Map();
  return { getItem:(key) => map.get(key) ?? null, setItem:(key, value) => map.set(key, String(value)), removeItem:(key) => map.delete(key) };
}

function fixture({ path = "/draftclient/f1/542830/3", bridge = "ok", filled = 0, configured = false, stale = false, startable = false } = {}) {
  const timers = new Map();
  let timerId = 0;
  let runtimeFailure = false;
  const { state, rail } = makeDraftRail();
  const context = vm.createContext({ console, Date, URLSearchParams });
  context.globalThis = context;
  sources.forEach((source) => vm.runInContext(source, context));
  const first = [9,6,5,1,7,10,12,3,2,8,11,4].map(String);
  const teams = Array.from({ length:19 }, (_, round) => round % 2 ? [...first].reverse() : first).flat()
    .map((id) => ({ getAttribute:() => id, textContent:id === "3" ? "You" : `Team ${id}` }));
  const select = { value:"All Positions", options:["All Positions", "Kickers", "Team Defenses", "Defensive Players"].map((label) => ({ textContent:label, value:label })), dispatchEvent() { if (!startable) assert.fail("blocked boot must not change Yahoo filters"); } };
  const document = {
    title:"You pick 8th | Live NFL Draft | Yahoo Fantasy Sports",
    body:{ innerText:`League Two\nDraft Starting Soon\nYOUR TEAM (${filled}/19)\nYour queue is empty.` },
    getElementById:(id) => id === "skrodzkai-yahoo-mock-control" ? { _controlApi:rail } : null,
    querySelectorAll:(selector) => selector === '.ys-team[data-id]' ? teams : selector === "select" ? [select] : selector === "button" ? [{ textContent:"Autodraft", querySelector:() => null }] : [],
  };
  const localStorage = storage();
  const sessionStorage = storage();
  const helpers = context.SKRODZKaiYahooMockExtension._test;
  const settingsDoc = { body:{ innerText:"League Name:\tLeague Two\nDraft Type:\tLive Standard Draft\nMax Teams:\t12\nLive Draft Pick Time:\t1 Minute\nPassing Touchdowns\t4\nReceptions Yahoo Default\t1\t0.5\nRoster Positions:\tQB, WR, WR, WR, RB, RB, TE, W/R/T, W/R/T, K, DEF, D, D, BN, BN, BN, BN, BN, BN, IR, IR, IR" } };
  localStorage.setItem("skrodzkai-yahoo-test-settings-v1", JSON.stringify(helpers.makeTestSettingsReceipt(helpers.parseTestSettings(withScoringTable(settingsDoc), { pathname:"/f1/542830/settings" }))));
  const attestation = { ok:true, version:"0.16.3", digest:"a".repeat(64), bootId:"synthetic-boot-1234", bootedAt:1 };
  const now = Date.now() - (stale ? 25 * 3600_000 : 1000);
  const board = { leagueId:"542830", scoringModel:"league-two-2026", scoringSchemaHash:configured ? context.SKRODZKaiYahooMockRunner.configs.test_league_19_idp.expectedScoring.scoringSchemaHash : "b".repeat(64), generatedAt:new Date(now).toISOString(),
    marketAdpReceipt:{ observedAt:new Date(now).toISOString(), rows:218 },
    sourceExpirations:[{sourceId:"yahoo",observedAt:new Date(now).toISOString(),maxAgeHours:6}],
    replacementRoster:{teamCount:12,rosterSlots:context.SKRODZKaiYahooMockRunner.configs.test_league_19_idp.rosterSlots.filter(s=>s!=="BN")},
    injuryCoverage:{ complete:true, checkedPlayers:6, expectedPlayers:6 }, byeCoverage:{ complete:true, playersWithBye:6, playersTotal:6 }, players:[] };
  if (startable) {
    board.players = ["QB", "RB", "WR", "TE", "K", "DEF", "LB", "CB"].flatMap((position, group) => Array.from({ length:8 }, (_, index) => ({
      yahooId:String(50000 + group * 100 + index), name:`${position} Player ${index}`, position, team:`T${index}`, eligible:[position],
      rank:group * 8 + index + 1, projection:400 - group * 20 - index, automaticEligible:true, manualEligible:true,
    })));
    board.replacementBySlot = { QB:200, RB:100, WR:100, TE:80, "W/R/T":100, K:60, DEF:60, D:60 };
    const baseQuery = document.querySelectorAll;
    document.querySelectorAll = (selector) => selector === "tr" ? board.players.filter((player) => select.value !== "Team Defenses" || player.position === "DEF").map((player) => ({
      querySelector:() => ({ innerText:`${player.name}\n${player.position}\n${player.team}`, getAttribute:() => player.yahooId, querySelector:() => null }),
    })) : baseQuery(selector);
  }
  context.SKRODZKaiYahooMockBoard = board;
  const environment = { ...context, document, location:{ pathname:path }, localStorage, sessionStorage,
    setInterval(fn) { timers.set(++timerId, fn); return timerId; }, clearInterval(id) { timers.delete(id); },
    setTimeout, clearTimeout,
    crypto, Event:class Event { constructor(type) { this.type = type; } },
    SKRODZKaiYahooMockBoard:board,
    chrome:bridge === "missing" ? {} : { runtime:{
      onMessage:{ addListener() {}, removeListener() {} },
      async sendMessage(message) {
        if (runtimeFailure) throw new Error("test bridge failure");
        return message.type === "version_handshake" ? attestation : { ok:bridge !== "conflict" };
      },
    } },
  };
  return { environment, rail, state, helpers, timers, boot:() => context.SKRODZKaiYahooMockExtension.boot(environment),
    breakRuntime() { runtimeFailure = true; } };
}

test("production boot exposes TEST scoring refusal before ARM, not a false ready state", async () => {
  const f = fixture(); await f.boot();
  assert.equal(f.state.mode, "TEST");
  assert.equal(f.state.context.seat, 8);
  assert.equal(f.state.label, "TEST PREFLIGHT LOCKED");
  assert.match(f.state.detail, /test_board_scoring_identity_mismatch/);
  assert.equal(f.rail.controls.arm.disabled, true);
});

test("draft-home cannot advertise ARM while TEST scoring is unverified", async () => {
  const f = fixture({ path:"/f1/542830/draft" });
  f.environment.document.body.innerText = "SKRODZKai\nLeague Two · 12 Teams · 19 Rounds · 1 minute\nYour Draft Position: 8th";
  await f.boot();
  assert.equal(f.state.label, "TEST PREFLIGHT LOCKED");
  assert.match(f.state.detail, /test_board_scoring_identity_mismatch/);
  assert.equal(f.rail.controls.arm.disabled, true);
});

test("a verified public waiting room acquires MOCK identity rather than retaining UNKNOWN", async () => {
  const f = fixture({ path:"/f1/mock_waiting" });
  f.environment.location.search = "?mlid=9391926&lobby=standard";
  f.environment.document.body.innerText = `Mock Draft\nStarts In\n04:00 You will draft 7th\n${Array.from({ length:12 }, (_, index) => index + 1).join("\t")}\nRoster Positions\n\nQB, WR, WR, RB, RB, TE, W/R/T, K, DEF\nStat Categories`;
  await f.boot();
  assert.equal(f.state.mode, "MOCK");
  assert.equal(f.state.context.roomId, "9391926");
});

test("synthetic configured startup traverses production bridge, ARM, preparation and runner start", async () => {
  const f = fixture({ configured:true, startable:true });
  await f.boot();
  assert.equal(f.state.label, "TEST READY TO ARM", f.state.detail);
  await f.rail.controls.arm.handler();
  const runner = f.environment.__skrodzkaiYahooMockExtensionV1?.runner;
  try {
    assert.ok(runner, f.state.detail);
    assert.equal(runner.getStatus().state, "running", f.state.detail);
    assert.equal(runner.getStatus().seat, 8);
    assert.equal(runner.getStatus().urlSeat, 3);
    assert.equal(runner.getStatus().picks.length, 0);
    assert.equal(f.state.label, "RUNNING");
    runner.stop("synthetic_status_check");
    // Exercise the production status timer after terminal state, not a regex.
    for (const callback of [...f.timers.values()]) await callback();
    assert.equal(f.state.context.armed, false);
  } finally { runner?.stop("synthetic_startup_complete"); }
});

test("production boot rejects stale data and nonempty recovery instead of creating a runner", async () => {
  for (const [options, reason] of [[{ stale:true }, /draft_board_stale/], [{ filled:1 }, /RECOVERY REQUIRED/]]) {
    const f = fixture(options); await f.boot();
    assert.match(f.state.detail, reason);
    assert.equal(f.rail.controls.arm.disabled, true);
    assert.equal(f.environment.__skrodzkaiYahooMockExtensionV1, undefined);
  }
});

test("unreadable roster prevents ARM even with synthetic configured scoring", async () => {
  const f = fixture({ configured:true });
  f.environment.document.body.innerText = "League Two\nDraft Starting Soon\nYour queue is empty.";
  await f.boot();
  assert.equal(f.rail.controls.arm.disabled, true);
  assert.match(f.state.detail, /test_roster_readback_unavailable/);
});

test("terminal runner identity survives token removal and subsequent bridge failure", async () => {
  const f = fixture({ bridge:"missing" });
  const token = { roomId:"542830", urlSeat:3, seat:8 };
  const status = { roomId:"542830", urlSeat:3, seat:8, runId:"fixture-run", state:"failed", picks:[] };
  f.environment.__skrodzkaiYahooMockExtensionV1 = { token, runner:{ halt() {}, getStatus:() => status } };
  const runnerKey = "skrodzkai-yahoo-mock-runner-receipts-v1";
  f.environment.localStorage.setItem(runnerKey, JSON.stringify([{ ...status, kind:"runner_failed" }]));
  await f.boot();
  const identity = f.helpers.receiptIdentity(f.environment);
  assert.equal(identity.seat, 8);
  const exported = f.helpers.buildExportPayload({ ...identity, storage:f.environment.localStorage, runner:f.environment.__skrodzkaiYahooMockExtensionV1.runner });
  assert.equal(exported.runnerReceipts.length, 1);
  assert.equal(exported.extensionReceipts[0].seat, 8);
  f.environment.location.pathname = "/draftclient/f1/542830/9";
  assert.equal(f.helpers.receiptIdentity(f.environment).seat, null, "different URL team must not inherit the old snake slot");
});

test("production boot retains exact URL team on bridge failure, without inventing snake slot", async () => {
  for (const path of ["/draftclient/f1/542830/3", "/f1/542830/settings", "/f1/542830/draft", "/f1/542830/3"]) {
    const f = fixture({ path, bridge:"missing" }); await f.boot();
    assert.equal(f.state.mode, "TEST");
    assert.equal(f.state.locked, true);
    assert.equal(f.rail.controls.export.disabled, false);
    const result = f.helpers.buildExportPayload({ roomId:"542830", seat:null, urlSeat:3, storage:f.environment.localStorage });
    assert.equal(result.seat, null);
    assert.ok(result.extensionReceipts.length > 0);
    assert.ok(result.extensionReceipts.every((entry) => entry.roomId === "542830" && entry.urlSeat === 3 && entry.seat === null));
  }
});

test("production boot refuses wrong TEST team, a conflicting runner lease, and an unarmed unknown room", async () => {
  for (const options of [{ path:"/draftclient/f1/542830/8" }, { bridge:"conflict" }, { path:"/draftclient/f1/99/6" }]) {
    const f = fixture(options); await f.boot();
    assert.equal(f.rail.controls.arm.disabled, true);
    assert.notEqual(f.state.label, "TEST READY TO ARM");
    assert.equal(f.environment.__skrodzkaiYahooMockExtensionV1, undefined);
  }
});

test("actual ARM handler becomes terminal on runtime failure and does not silently retry", async () => {
  const f = fixture({ configured:true }); await f.boot();
  assert.equal(f.state.label, "TEST READY TO ARM", f.state.detail);
  assert.equal(f.rail.controls.arm.disabled, false);
  f.breakRuntime();
  await f.rail.controls.arm.handler();
  assert.equal(f.state.label, "TEST ARM REFUSED");
  assert.match(f.state.detail, /terminal refusal/);
  assert.equal(f.rail.controls.arm.disabled, true);
  assert.equal(f.environment.sessionStorage.getItem(preflightKey), null);
  const rows = JSON.parse(f.environment.localStorage.getItem(receiptKey));
  assert.equal(rows.filter((entry) => entry.kind === "test_room_arm_refused").length, 1);
});

test("compact dock markup keeps lifecycle and export outside hidden body; not a CSS render test", () => {
  const source = sources[3];
  const header = source.slice(source.indexOf('<header class="cap">'), source.indexOf('<div class="body">'));
  assert.match(header, /data-dock-primary/);
  assert.match(header, /data-dock-target/);
  assert.match(header, /<span data-compact-status>/);
  assert.doesNotMatch(source, /\.compact-status\s*\{[^}]*display:\s*none/);
  assert.match(source, /\.dock-readout span \{ display:block/);
  assert.doesNotMatch(header, />SAFE/);
  assert.match(source, /data\.dockPrimary\.textContent = label/);
  assert.match(source, /data\.dockTarget\.textContent = message/);
  assert.equal((source.match(/data\.dockPrimary\.textContent =/g) ?? []).length, 1);
  assert.equal((source.match(/data\.dockTarget\.textContent =/g) ?? []).length, 1);
  assert.match(source, /context = \{ \.\.\.ui\.context, \.\.\.context \}/);
  assert.match(source, /prepend\(controls\.export\)/);
});
