import assert from "node:assert/strict";
import test from "node:test";

import { makePublicProjectionSnapshot, parseCbsPositionHtml, parseFfcAdp, parseRazzballHtml } from "./parse-public-projections.mjs";

test("parses CBS raw QB projections while ignoring CBS fantasy points", () => {
  const html = `<table><tbody><tr class="TableBase-bodyTr"><td class="TableBase-bodyTd"><span class="CellPlayerName--long"><span><a>Josh Allen</a><span class="CellPlayerName-position"> QB </span><span class="CellPlayerName-team"> BUF </span></span></span></td>${[17,489,334,3704,217.9,30,13,99.9,125,610,4.9,10,4,412.3,24.3].map((value) => `<td class="TableBase-bodyTd TableBase-bodyTd--number">${value}</td>`).join("")}</tr></tbody></table>`;
  const parsed = parseCbsPositionHtml(html, "QB");
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].name, "Josh Allen");
  assert.equal(parsed.rows[0].stats.passingTouchdowns, 30);
  assert.equal(parsed.rows[0].stats.rushingTouchdowns, 10);
  assert.equal("leaguePoints" in parsed.rows[0], false);
});

test("uses CBS's receiver-specific column order and position-specific omissions", () => {
  const html = `<tr class="TableBase-bodyTr"><td class="TableBase-bodyTd"><span class="CellPlayerName--long"><a>Puka Nacua</a><span class="CellPlayerName-position">WR</span><span class="CellPlayerName-team">LAR</span></span></td>${[17,160,110,1500,88.2,13.6,10,5,30,6,1,1,300,17.6].map((value) => `<td class="TableBase-bodyTd">${value}</td>`).join("")}</tr>`;
  const row = parseCbsPositionHtml(html, "WR").rows[0];
  assert.equal(row.stats.targets, 160);
  assert.equal(row.stats.receivingYards, 1500);
  assert.equal(row.stats.rushingYards, 30);
  assert.equal(row.omittedScoringCategories.includes("passingYards"), false);
});

test("parses Razzball offense and IDP tables by their published headers", () => {
  const offense = `<table id="neorazzstatstable"><tr>${["#","Name","Pos","Team","STD PTS","1/2PPR PTS","PPR PTS","Snaps","Cmp","Att","Pass Yds","Pass TD","Int","Rush","Rush Yds","Run TD","Tgt","Rec","Rec Yds","Rec TD"].map((x) => `<th>${x}</th>`).join("")}</tr><tr>${["","Josh Allen","QB","BUF",383,383,383,1068,372,532,3945,27.1,11.7,128,658,13.1,0,0,0,0].map((x) => `<td>${x}</td>`).join("")}</tr></table>`;
  const idp = `<table id="neorazzstatstable"><tr>${["#","Name","Team","Pos","Pos Det","Games","Health","Snaps","Tackles","Tackles Solo","Tackles Ast","TFL","Sacks","Pass Def","Ints","Fum Forc","Fum Rec","Saf","TD Ret","Ret Yds","STD PTS"].map((x) => `<th>${x}</th>`).join("")}</tr><tr>${["","Travis Hunter","JAX","DB","CB",17,100,582,38.2,24.6,13.6,1.5,0,6.5,.8,.6,.3,0,.1,13,67.6].map((x) => `<td>${x}</td>`).join("")}</tr></table>`;
  const offenseRows = parseRazzballHtml(offense, "offense").rows;
  const idpRows = parseRazzballHtml(idp, "idp").rows;
  assert.equal(offenseRows[0].stats.passingYards, 3945);
  assert.equal(idpRows[0].scoringKind, "idp");
  assert.equal(idpRows[0].stats.passesDefended, 6.5);
  assert.equal(idpRows[0].detailedPosition, "CB");
});

test("parses Razzball kicker stats and keeps team-defense aggregates diagnostic", () => {
  const kicker = `<table id="neorazzstatstable"><tr>${["#","Name","Team","Pos","Games","FG","FGA","XP","XPA"].map((x) => `<th>${x}</th>`).join("")}</tr><tr>${["","Tyler Bass","BUF","K",17,30,35,40,42].map((x) => `<td>${x}</td>`).join("")}</tr></table>`;
  const defense = `<table id="neorazzstatstable"><tr>${["#","Name","Team","Pos","Games","Sck","Int","Fum For","Fum","Saf","TD Ret","Ret Yds","Points","Yards"].map((x) => `<th>${x}</th>`).join("")}</tr><tr>${["","Bills","BUF","DEF",17,45,18,12,10,1,3,120,320,5000].map((x) => `<td>${x}</td>`).join("")}</tr></table>`;
  const kickerRow = parseRazzballHtml(kicker, "k").rows[0];
  const defenseRow = parseRazzballHtml(defense, "def").rows[0];
  assert.equal(kickerRow.scoringKind, "kicker");
  assert.equal(kickerRow.stats.fieldGoalsMade, 30);
  assert.equal(defenseRow.scoringKind, "team-defense");
  assert.equal(defenseRow.stats.pointsAllowed, 320);
});

test("builds a deterministic public-source receipt and parses FFC ADP", () => {
  const snapshot = makePublicProjectionSnapshot({
    sourceId: "cbs-projections", sourceFamily: "cbs", documents: { QB: "one", RB: "two" },
    sourceAsOf: "2026-09-02T12:00:00Z", retrievedAt: "2026-09-02T12:05:00Z", rows: [],
    coverage: {}, licenseUseNote: "Derived values only.",
  });
  assert.match(snapshot.manifest.contentSha256, /^[a-f0-9]{64}$/);
  const adp = parseFfcAdp({ players: [{ name: "Josh Allen", team: "BUF", position: "QB", adp: 8.2, min_pick: 2, max_pick: 18, times_drafted: 4000 }] });
  assert.deepEqual(adp[0], { sourceRank: 1, name: "Josh Allen", team: "BUF", position: "QB", adp: 8.2, minimumPick: 2, maximumPick: 18, timesDrafted: 4000 });
});
