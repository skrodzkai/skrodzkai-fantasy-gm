import assert from "node:assert/strict";
import test from "node:test";

import {
  enrichBoardWithDraftSignals,
  parseCsvLine,
  parseNflverseDepthCharts,
  parseNflverseSchedule,
} from "./draft-signal-overlay.mjs";

const TEAMS = Array.from({ length: 32 }, (_, index) => `T${String(index).padStart(2, "0")}`);

function player(yahooId, position, team, rank, projection = 200 - rank) {
  return {
    yahooId: String(yahooId),
    gsisId: `g-${yahooId}`,
    name: `${position} ${yahooId}`,
    team,
    position,
    eligible: [position],
    draftBoardRank: rank,
    specialistRank: rank,
    overallRank: rank,
    consensusPoints: projection,
    perGamePoints: projection / 17,
    weeklyPoints: Array(17).fill(projection / 17),
    sourceIds: ["yahoo-season-projection", "espn-mike-clay"],
  };
}

function boardFixture() {
  const offense = Array.from({ length: 150 }, (_, index) => {
    const position = ["QB", "RB", "WR", "TE"][index % 4];
    return player(index + 1, position, TEAMS[index % TEAMS.length], index + 1, 400 - index);
  });
  const idp = Array.from({ length: 40 }, (_, index) => player(1001 + index, index % 3 === 0 ? "DL" : index % 3 === 1 ? "LB" : "DB", TEAMS[index % TEAMS.length], index + 1, 180 - index));
  const kicker = player(2001, "K", TEAMS[0], 1, 120);
  const defense = player(3001, "DEF", TEAMS[0], 1, 110);
  return {
    players: [...offense, ...idp, kicker, defense],
    boards: {
      unified: [...offense, ...idp, kicker, defense],
      offense,
      specialists: {
        K: [kicker],
        DEF: [defense],
        DL: idp.filter((entry) => entry.position === "DL"),
        LB: idp.filter((entry) => entry.position === "LB"),
        DB: idp.filter((entry) => entry.position === "DB"),
      },
    },
  };
}

function rosterCsv(board) {
  const header = "season,team,position,depth_chart_position,jersey_number,status,full_name,first_name,last_name,birth_date,height,weight,college,gsis_id,espn_id,sportradar_id,yahoo_id";
  const rows = board.players.map((entry) => `2026,${entry.team},${entry.position},${entry.position},1,ACT,${entry.name},First,Last,2000-01-01,72,200,Test,${entry.gsisId},,,${entry.yahooId}`);
  return `${header}\n${rows.join("\n")}\n`;
}

function depthCsv(board, observedAt = "2026-09-02T12:00:00Z") {
  const header = "dt,team,player_name,espn_id,gsis_id,pos_grp_id,pos_grp,pos_id,pos_name,pos_abb,pos_slot,pos_rank";
  const rows = board.players.map((entry) => `${observedAt},${entry.team},${entry.name},,${entry.gsisId},1,Base,1,${entry.position},${entry.position},1,1`);
  return `${header}\n${rows.join("\n")}\n2026-09-01T12:00:00Z,T00,Old Player,,old,1,Base,1,QB,QB,1,1\n`;
}

function scheduleCsv() {
  const header = "game_id,season,game_type,week,gameday,weekday,gametime,away_team,away_score,home_team,home_score,location,result,total,overtime,old_game_id,gsis,nfl_detail_id,pfr,pff,espn,ftn,away_rest,home_rest,away_moneyline,home_moneyline,spread_line,away_spread_odds,home_spread_odds,total_line";
  const rows = [];
  for (let week = 1; week <= 4; week += 1) {
    for (let index = 0; index < TEAMS.length; index += 2) {
      rows.push(`2026_${week}_${index},2026,REG,${week},2026-09-01,Sunday,13:00,${TEAMS[index]},,${TEAMS[index + 1]},,Home,,,,,,,,,,,,,,,-3,-110,-110,44`);
    }
  }
  return `${header}\n${rows.join("\n")}\n`;
}

const SOURCE_URLS = {
  depthCharts: "https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_2026.csv",
  rosters: "https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_2026.csv",
  schedule: "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv",
};

function enrich(overrides = {}) {
  const board = boardFixture();
  return enrichBoardWithDraftSignals({
    board,
    projectionSnapshots: [{ rows: [{ playerId: "1", stats: { passingYards: 1000 } }] }],
    depthChartCsv: depthCsv(board),
    rosterCsv: rosterCsv(board),
    scheduleCsv: scheduleCsv(),
    marketOverlay: {
      sourcesChecked: [{
        sourceId: "draftkings",
        sourceUrl: "https://sportsbook.draftkings.com/page/nfl-player-props",
        capturedAt: "2026-09-02T12:30:00Z",
        status: "LINES_CAPTURED",
      }],
      entries: [{
        yahooId: "1",
        sourceId: "draftkings",
        sourceUrl: "https://sportsbook.draftkings.com/page/nfl-player-props",
        marketType: "season_pass_yards",
        lineValue: 1200,
        capturedAt: "2026-09-02T12:30:00Z",
      }],
      roleFindings: [],
    },
    asOf: "2026-09-02T13:00:00Z",
    sourceRetrievedAt: {
      depthCharts: "2026-09-02T12:55:00Z",
      rosters: "2026-09-02T12:54:00Z",
      schedule: "2026-09-02T12:53:00Z",
    },
    sourceUrls: SOURCE_URLS,
    ...overrides,
  });
}

test("parses quoted CSV cells and keeps the newest depth-chart snapshot regardless of row order", () => {
  assert.deepEqual(parseCsvLine('a,"b,c","d""e"'), ["a", "b,c", 'd"e']);
  const parsed = parseNflverseDepthCharts("dt,team,player_name\n2026-09-01T12:00:00Z,BUF,Old\n2026-09-02T12:00:00Z,BUF,Current\n");
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].player_name, "Current");
});

test("requires all 64 regular-season games in Weeks 1-4", () => {
  assert.equal(parseNflverseSchedule(scheduleCsv()).length, 64);
  assert.throws(() => parseNflverseSchedule(scheduleCsv().split("\n").slice(0, -2).join("\n")), /must contain 64/);
});

test("adds complete role, schedule, specialist, and market signals without changing projections", () => {
  const enriched = enrich();
  assert.equal(enriched.draftSignalOverlay.projectionUnchanged, true);
  assert.equal(enriched.draftSignalOverlay.sourceReceipts[0].sourceAsOfBasis, "latest-dataset-observation");
  assert.equal(enriched.draftSignalOverlay.sourceReceipts[1].sourceAsOfBasis, "local-file-mtime-no-publisher-timestamp");
  assert.equal(enriched.draftSignalOverlay.sourceReceipts[1].retrievedAt, "2026-09-02T12:54:00.000Z");
  assert.equal(enriched.draftSignalOverlay.sourceReceipts[1].ageHours, 0.1);
  assert.equal(enriched.draftSignalOverlay.roleAudit.offenseTargets, 150);
  assert.equal(enriched.draftSignalOverlay.roleAudit.idpTargets, 40);
  assert.equal(enriched.draftSignalOverlay.roleAudit.uniqueTargets, 190);
  assert.equal(enriched.draftSignalOverlay.roleAudit.rosterCoverageComplete, true);
  assert.equal(enriched.draftSignalOverlay.roleAudit.depthChartCoverageComplete, true);
  assert.equal(enriched.draftSignalOverlay.specialistContext.scheduleComplete, true);
  assert.equal(enriched.draftSignalOverlay.market.flaggedPlayers, 1);
  assert.equal(enriched.players.find((entry) => entry.yahooId === "1").draftSignals.market[0].flag, "MARKET_ABOVE_ESPN_ANCHOR");
  assert.equal(enriched.players.find((entry) => entry.yahooId === "2").draftSignals.market, null);
  assert.ok(Number.isFinite(enriched.players.find((entry) => entry.position === "K").draftSignals.specialist.teamOffenseRank));
  assert.equal(enriched.players.find((entry) => entry.position === "DEF").draftSignals.specialist.scheduleComplete, true);
});

test("preserves an independently ordered unified board", () => {
  const board = boardFixture();
  board.boards.unified = [...board.boards.unified].reverse();
  const expected = board.boards.unified.map((entry) => entry.yahooId);
  const enriched = enrich({ board });
  assert.deepEqual(enriched.boards.unified.map((entry) => entry.yahooId), expected);
  assert.ok(enriched.boards.unified.every((entry) => entry.draftSignals));
});

test("uses defensive depth for IDP context instead of a higher-ranked special-teams row", () => {
  const board = boardFixture();
  const target = board.boards.specialists.DB[0];
  const base = depthCsv(board);
  const current = "2026-09-02T12:00:00Z";
  const original = `${current},${target.team},${target.name},,${target.gsisId},1,Base,1,${target.position},${target.position},1,1`;
  const special = `${current},${target.team},${target.name},,${target.gsisId},9,Special Teams,9,Punt Returner,PR,1,1`;
  const defensive = `${current},${target.team},${target.name},,${target.gsisId},2,Base 4-3 D,2,Cornerback,LCB,1,2`;
  const enriched = enrich({ board, depthChartCsv: base.replace(original, `${special}\n${defensive}`) });
  const signal = enriched.boards.specialists.DB.find((entry) => entry.yahooId === target.yahooId).draftSignals;
  assert.equal(signal.specialist.depthPosition, "LCB");
  assert.equal(signal.specialist.depthRank, 2);
  assert.ok(signal.warnings.includes("IDP_NOT_FIRST_ON_CURRENT_DEPTH_CHART"));
});

test("stale market lines remain receipted but cannot create a disagreement flag", () => {
  const base = enrich({
    marketOverlay: {
      sourcesChecked: [{ sourceId: "fanduel", sourceUrl: "https://sportsbook.fanduel.com/navigation/nfl", capturedAt: "2026-09-02T12:30:00Z", status: "LINES_CAPTURED" }],
      entries: [{ yahooId: "1", sourceId: "fanduel", sourceUrl: "https://sportsbook.fanduel.com/navigation/nfl", marketType: "season_pass_yards", lineValue: 1200, capturedAt: "2026-08-31T12:59:00Z" }],
    },
  });
  const signal = base.players.find((entry) => entry.yahooId === "1").draftSignals.market[0];
  assert.equal(signal.fresh, false);
  assert.equal(signal.flag, null);
  assert.equal(base.draftSignalOverlay.market.freshLineCount, 0);
});

test("uses only a unique exact name-team fallback when nflverse has no Yahoo ID", () => {
  const board = boardFixture();
  const csv = rosterCsv(board).replace(/,1\n/, ",\n");
  const depth = depthCsv(board);
  for (const row of [board.players, board.boards.unified, board.boards.offense].flat()) {
    if (row.yahooId === "1") delete row.gsisId;
  }
  const enriched = enrich({ board, rosterCsv: csv, depthChartCsv: depth });
  assert.equal(enriched.players.find((entry) => entry.yahooId === "1").draftSignals.role.rosterMatched, true);
  assert.equal(enriched.players.find((entry) => entry.yahooId === "1").draftSignals.role.rosterMatchMethod, "EXACT_NAME_TEAM_UNIQUE");
});

test("shows current IDP depth context for a dual-role offensive identity", () => {
  const board = boardFixture();
  const dual = board.players[0];
  dual.position = "WR";
  dual.eligible = ["WR", "CB", "DB", "D"];
  board.boards.specialists.DB.unshift(dual);
  const current = "2026-09-02T12:00:00Z";
  const base = depthCsv(board);
  const offensive = `${current},${dual.team},${dual.name},,${dual.gsisId},1,Base,1,WR,WR,1,1`;
  const defensive = `${current},${dual.team},${dual.name},,${dual.gsisId},2,Base 4-3 D,2,Cornerback,LCB,1,1`;
  const enriched = enrich({ board, depthChartCsv: base.replace(offensive, `${offensive}\n${defensive}`) });
  const signal = enriched.boards.specialists.DB.find((entry) => entry.yahooId === dual.yahooId).draftSignals.specialist;
  assert.equal(signal.kind, "IDP");
  assert.equal(signal.depthRank, 1);
  assert.equal(signal.depthPosition, "LCB");
  assert.equal(enriched.draftSignalOverlay.roleAudit.overlappingEligibleTargets, 1);
  assert.equal(enriched.draftSignalOverlay.roleAudit.rosterCoverageComplete, true);
});

test("rejects unsupported or misattributed market sources", () => {
  assert.throws(() => enrich({
    marketOverlay: {
      sourcesChecked: [{ sourceId: "draftkings", sourceUrl: "https://example.com/nfl", capturedAt: "2026-09-02T12:30:00Z" }],
      entries: [],
    },
  }), /must use sportsbook\.draftkings\.com/);
});
