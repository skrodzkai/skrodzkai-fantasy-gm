import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from 'node:fs/promises';

import { buildDraftWatchlist, compileInjuryBoard } from "./injury-monitor.mjs";
test('dated research packet contains 36 distinct narrative profiles and three analyst role holds from official reporting', async()=>{
  const reports=JSON.parse(await readFile(new URL('./injury-research-20260906.json',import.meta.url),'utf8'));
  const news=reports.filter(r=>r.sourceKind==='reported_news');
  assert.equal(news.length,36);assert.equal(new Set(news.map(r=>r.playerId)).size,36);
  assert(reports.filter(r=>r.status==='ROLE_UNCERTAIN').every(r=>r.note.startsWith('Analyst role-review classification')));
  for(const row of news){assert(/^\d+$/.test(row.playerId));assert(row.name&&row.draftImpact&&/^https:\/\//.test(row.sourceUrl));}
  const board=compileInjuryBoard({reports,asOf:'2026-09-07T00:10:00Z'});
  assert.equal(board.players.filter(p=>p.status==='ROLE_UNCERTAIN').length,3);
  assert(board.players.every(p=>!p.executable));
});

test('researched news is dated context, never health clearance or coverage', () => {
  const news={playerId:'p1',sourceId:'beat-report',sourceKind:'reported_news',publishedAt:'2026-08-22',observedAt:'2026-08-23T10:00:00Z',sourceUrl:'https://example.com/report',note:'Coach expects participation.',reportedReturn:'Week 1 expected, not confirmed.',draftImpact:'Watch the final report.'};
  const compile=reports=>compileInjuryBoard({reports,asOf:'2026-08-23T12:00:00Z',expectedPlayerIds:['p1']});
  const only=compile([news]);assert.equal(only.players[0].draftAction,'REVIEW');assert.equal(only.coverage.complete,false);
  const result=compile([report({status:'Q',sourceKind:'yahoo'}),news]);
  assert.equal(result.players[0].executable,false);
  assert.equal(result.players[0].evidence.find(e=>e.narrativeOnly).publishedAt,'2026-08-22');
  for(const invalid of [{status:'ACTIVE'},{expectedGamesThroughWeek17:16},{unavailableWeeks:[1]},{publishedAt:'2026-08-24'},{sourceUrl:null}])assert.throws(()=>compile([{...news,...invalid}]));
  assert.equal(compile([report({status:'QUESTIONABLE'}),news]).players[0].conflict,false);
  const spaced={...news,sourceKind:' reported_news '};
  assert.throws(()=>compile([{...spaced,status:'ACTIVE'}]));
  const normalized=compile([spaced]);assert.equal(normalized.coverage.complete,false);assert.equal(normalized.players[0].evidence[0].status,null);
});

test('role uncertainty is separate from health disagreement and withholds availability consistently',()=>{
  for(const status of ['CLEAR','ACTIVE','QUESTIONABLE']){
    const p=compileInjuryBoard({asOf:'2026-08-23T12:00:00Z',reports:[report({status}),report({sourceId:'team',sourceKind:'team_official',status:'ROLE_UNCERTAIN'})]}).players[0];
    assert.equal(p.roleUncertain,true);assert.equal(p.conflict,false);assert.equal(p.draftAction,'REVIEW');assert.equal(p.expectedGamesThroughWeek17,null);assert.equal(p.availabilityStatus,'ROLE_UNCERTAIN');
  }
});

function report(overrides = {}) {
  return {
    playerId: "p1",
    sourceId: "source",
    sourceKind: "yahoo",
    observedAt: "2026-08-23T10:00:00Z",
    status: "UNKNOWN",
    ...overrides,
  };
}

test("official fresh OUT status excludes a player", () => {
  const result = compileInjuryBoard({
    asOf: "2026-08-22T12:00:00Z",
    reports: [
      {
        playerId: "p1",
        sourceId: "nfl-week-1",
        sourceKind: "nfl_official",
        observedAt: "2026-08-22T10:00:00Z",
        status: "Out",
        bodyPart: "knee",
      },
    ],
  });
  assert.equal(result.players[0].draftAction, "EXCLUDE");
  assert.equal(result.players[0].executable, false);
});

test("material source disagreement requires manual review", () => {
  const result = compileInjuryBoard({
    asOf: "2026-08-22T12:00:00Z",
    reports: [
      {
        playerId: "p1",
        sourceId: "club",
        sourceKind: "team_official",
        observedAt: "2026-08-22T10:00:00Z",
        status: "Active",
      },
      {
        playerId: "p1",
        sourceId: "yahoo",
        sourceKind: "yahoo",
        observedAt: "2026-08-22T11:00:00Z",
        status: "Doubtful",
      },
    ],
  });
  assert.equal(result.players[0].conflict, true);
  assert.equal(result.players[0].draftAction, "REVIEW");
  assert.match(result.players[0].blockReason, /conflict/);
});

test("stale evidence cannot silently clear a player", () => {
  const result = compileInjuryBoard({
    asOf: "2026-08-22T12:00:00Z",
    reports: [
      {
        playerId: "p1",
        sourceId: "old",
        sourceKind: "sleeper",
        observedAt: "2026-08-15T12:00:00Z",
        status: "Active",
      },
    ],
  });
  assert.equal(result.players[0].draftAction, "REVIEW");
  assert.match(result.players[0].blockReason, /no fresh/);
});

test("fresh consistent active evidence clears a player", () => {
  const result = compileInjuryBoard({
    asOf: "2026-08-22T12:00:00Z",
    reports: [
      {
        playerId: "p1",
        sourceId: "nfl",
        sourceKind: "nfl_official",
        observedAt: "2026-08-22T10:00:00Z",
        status: "Full",
      },
      {
        playerId: "p1",
        sourceId: "club",
        sourceKind: "team_official",
        observedAt: "2026-08-22T09:00:00Z",
        status: "Active",
      },
    ],
  });
  assert.equal(result.players[0].draftAction, "CLEAR");
  assert.equal(result.players[0].executable, true);
});

test("fresh but unknown evidence carries an explicit manual-review reason", () => {
  const result = compileInjuryBoard({
    asOf: "2026-08-22T12:00:00Z",
    reports: [
      {
        playerId: "p1",
        sourceId: "yahoo",
        sourceKind: "yahoo",
        observedAt: "2026-08-22T10:00:00Z",
        status: "UNKNOWN",
      },
    ],
  });
  assert.equal(result.players[0].draftAction, "REVIEW");
  assert.match(result.players[0].blockReason, /UNKNOWN/);
});

test("holdout and role uncertainty stay on the compact manual watchlist", () => {
  const board = compileInjuryBoard({
    asOf: "2026-08-23T12:00:00Z",
    reports: [
      report({ playerId: "h", sourceId: "holdout", status: "CONTRACT_HOLDOUT" }),
      report({ playerId: "r", sourceId: "role", status: "ROLE_RISK" }),
      report({ playerId: "c", sourceId: "clear", status: "CLEAR" }),
    ],
  });
  assert.equal(board.players.find((player) => player.playerId === "h").draftAction, "REVIEW");
  assert.equal(board.players.find((player) => player.playerId === "r").draftAction, "REVIEW");
  assert.deepEqual(buildDraftWatchlist(board).map((player) => player.yahooId).sort(), ["h", "r"]);
});

test("a suspension needs a reported return to avoid automatic exclusion", () => {
  const missingReturn = compileInjuryBoard({
    asOf: "2026-08-23T12:00:00Z",
    reports: [report({ playerId: "s", sourceId: "suspension", status: "SUSPENSION" })],
  });
  assert.equal(missingReturn.players[0].draftAction, "EXCLUDE");
  const datedReturn = compileInjuryBoard({
    asOf: "2026-08-23T12:00:00Z",
    reports: [report({ playerId: "s", sourceId: "suspension", status: "SUSPENDED", reportedReturn: "Week 3" })],
  });
  assert.equal(datedReturn.players[0].draftAction, "REVIEW");
  assert.deepEqual(datedReturn.players[0].reportedReturns, ["Week 3"]);
});

test("receipts complete-player injury coverage and fails closed on unchecked players", () => {
  const board = compileInjuryBoard({
    asOf: "2026-08-23T12:00:00Z",
    expectedPlayerIds: ["p1", "p2"],
    reports: [report({ playerId: "p1", sourceId: "yahoo-p1", status: "CLEAR" })],
  });
  assert.equal(board.coverage.expectedPlayers, 2);
  assert.equal(board.coverage.checkedPlayers, 1);
  assert.equal(board.coverage.complete, false);
  assert.deepEqual(board.coverage.uncheckedPlayerIds, ["p2"]);
  assert.equal(board.players.find((player) => player.playerId === "p2").executable, false);
});

test("prices games only from explicit consistent injury evidence", () => {
  const board = compileInjuryBoard({
    asOf: "2026-08-23T12:00:00Z",
    reports: [
      report({ playerId: "p1", sourceId: "club", sourceKind: "team_official", status: "QUESTIONABLE", expectedGamesThroughWeek17: 12, unavailableWeeks: [1, 2] }),
      report({ playerId: "p1", sourceId: "yahoo", status: "QUESTIONABLE", expectedGamesThroughWeek17: 12 }),
    ],
  });
  assert.equal(board.players[0].expectedGamesThroughWeek17, 12);
  assert.deepEqual(board.players[0].unavailableWeeks, [1, 2]);
  assert.equal(board.players[0].availabilityStatus, "EXPLICIT");

  const conflict = compileInjuryBoard({
    asOf: "2026-08-23T12:00:00Z",
    reports: [
      report({ playerId: "p1", sourceId: "club", sourceKind: "team_official", status: "QUESTIONABLE", expectedGamesThroughWeek17: 6 }),
      report({ playerId: "p1", sourceId: "yahoo", status: "QUESTIONABLE", expectedGamesThroughWeek17: 12 }),
    ],
  });
  assert.equal(conflict.players[0].conflict, true);
  assert.equal(conflict.players[0].expectedGamesThroughWeek17, null);
});
