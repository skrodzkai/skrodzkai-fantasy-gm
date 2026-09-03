import assert from "node:assert/strict";
import test from "node:test";

import { HISTORICAL_STATS_REQUIRED_COLUMNS, buildHistoricalCalibration, buildIdpRankingCalibration, calibrationPosition, parseHistoricalSeason, scoreHistoricalStatRow } from "./historical-player-calibration.mjs";

function csvFixture(columns, rows) {
  return [columns.join(","), ...rows.map((row) => columns.map((column) => row[column] ?? "").join(","))].join("\n");
}

test("uses Yahoo scoring lane eligibility for dual-record players", () => {
  const offense = { position: "WR", yahooEligibilityFilters: ["O", "W/R/T"] };
  const defense = { position: "WR", specialistPosition: "CB", yahooEligibilityFilters: ["CB", "DB"] };
  assert.equal(calibrationPosition(offense), "WR");
  assert.equal(calibrationPosition(defense), "DB");
});

test("scores nflverse weekly offense with exact league bonuses and premium", () => {
  const [row] = scoreHistoricalStatRow({
    player_id: "q1", player_display_name: "Quarterback", season: "2024", week: "1", season_type: "REG", position: "QB", team: "BUF",
    completions: "25", passing_yards: "300", passing_tds: "3", passing_interceptions: "1",
    rushing_yards: "100", rushing_tds: "1", fumbles_lost_total: "0",
  });
  assert.equal(row.points, 48.5);
  assert.equal(row.statEvidence, true);
});

test("does not mint an IDP lane from an offensive player's incidental tackle", () => {
  const rows = scoreHistoricalStatRow({ player_id: "q1", season: "2024", week: "1", season_type: "REG", position: "QB", def_tackles_solo: "1" });
  assert.deepEqual(rows.map((row) => row.position), ["QB"]);
});

test("rejects historical stats schema drift before scoring", () => {
  assert.throws(() => parseHistoricalSeason({
    statsText: "player_id,season,week,season_type,position\nq1,2025,1,REG,QB",
    rosterText: "unused\nvalue",
    snapText: "unused\nvalue",
    scheduleRows: [{ season: "2025", week: "1", game_type: "REG", away_team: "BUF", home_team: "NYJ" }],
    season: 2025,
  }), /stats 2025 schema drift/);
});

test("builds exact PFR-to-GSIS snap appearances and excludes Week 18", () => {
  const statsText = csvFixture(HISTORICAL_STATS_REQUIRED_COLUMNS, [
    { player_id: "gsis-1", player_display_name: "Quarterback", season: 2025, week: 1, season_type: "REG", position: "QB", team: "BUF" },
    { player_id: "gsis-1", player_display_name: "Quarterback", season: 2025, week: 18, season_type: "REG", position: "QB", team: "BUF", completions: 20, passing_yards: 300, passing_tds: 2 },
    { player_id: "gsis-1", player_display_name: "Quarterback", season: 2024, week: 1, season_type: "REG", position: "QB", team: "BUF", completions: 20, passing_yards: 300, passing_tds: 2 },
  ]);
  const rosterText = [
    "season,team,position,status,full_name,birth_date,gsis_id,pfr_id,week,game_type",
    "2025,BUF,QB,ACT,Quarterback,1998-01-01,gsis-1,pfr-1,1,REG",
    "2025,BUF,QB,ACT,Quarterback,1998-01-01,gsis-1,pfr-1,18,REG",
  ].join("\n");
  const snapText = [
    "season,game_type,week,pfr_player_id,position,offense_snaps,defense_snaps,st_snaps",
    "2025,REG,1,pfr-1,QB,50,0,0",
    "2025,REG,18,pfr-1,QB,50,0,0",
  ].join("\n");
  const scheduleRows = [
    { season: "2025", game_type: "REG", week: "1", away_team: "BUF", home_team: "NYJ" },
    { season: "2025", game_type: "REG", week: "18", away_team: "BUF", home_team: "NYJ" },
  ];
  const parsed = parseHistoricalSeason({ statsText, rosterText, snapText, scheduleRows, season: 2025 });
  assert.deepEqual(parsed.weeklyScores.map((row) => [row.week, row.points, row.appearanceSource]), [[1, 0, "SNAPS"]]);
  assert.equal(parsed.playerSeasons[0].eligibleGames, 1);
  assert.equal(parsed.playerSeasons[0].appearances, 1);
});

test("split Yahoo identities share one person-level availability prior", () => {
  const weeklyScores = [];
  const playerSeasons = [];
  for (let season = 2020; season <= 2025; season += 1) {
    for (const position of ["WR", "DB"]) {
      for (let player = 1; player <= 4; player += 1) {
        for (let week = 1; week <= 4; week += 1) weeklyScores.push({ season, playerId: `${position}-${player}`, position, week, points: 4 + player });
        playerSeasons.push({ season, playerId: `${position}-${player}`, position, ageBand: "LE_25", eligibleGames: 4, appearances: position === "WR" ? 4 : 2, equivalentGamesThroughWeek17: position === "WR" ? 16 : 8 });
      }
    }
  }
  const board = {
    currentRosterRows: [{ gsis_id: "hunter", birth_date: "2003-05-18" }],
    players: [
      { yahooId: "99001", name: "Travis Hunter", position: "WR", yahooEligibilityFilters: ["O"], gsisId: "hunter", candidatePoints: 160, expectedGames: 16 },
      { yahooId: "99002", name: "Travis Hunter", position: "WR", specialistPosition: "CB", yahooEligibilityFilters: ["CB", "DB"], gsisId: "hunter", candidatePoints: 80, expectedGames: 16 },
    ],
  };
  const output = buildHistoricalCalibration({ weeklyScores, playerSeasons, board, generatedAt: "2026-09-03T01:00:00Z" });
  const [offense, defense] = output.currentPlayers;
  assert.equal(offense.availabilityPosition, "WR");
  assert.equal(defense.availabilityPosition, "WR");
  assert.deepEqual(offense.availability, defense.availability);
  assert.equal(offense.position, "WR");
  assert.equal(defense.position, "DB");
});

function syntheticHistory(holdoutPoints) {
  const weeklyScores = [];
  const playerSeasons = [];
  for (let season = 2020; season <= 2025; season += 1) {
    for (let player = 1; player <= 4; player += 1) {
      for (let week = 1; week <= 4; week += 1) {
        weeklyScores.push({ season, playerId: `q${player}`, position: "QB", week, points: season === 2025 ? holdoutPoints + player : 10 + player });
      }
      playerSeasons.push({ season, playerId: `q${player}`, position: "QB", ageBand: "26_29", eligibleGames: 4, appearances: 4, equivalentGamesThroughWeek17: 16 });
    }
  }
  return { weeklyScores, playerSeasons };
}

test("freezes baseline hyperparameters before reading the 2025 holdout", () => {
  const low = syntheticHistory(1);
  const high = syntheticHistory(1000);
  const a = buildHistoricalCalibration({ ...low, board: { players: [] }, generatedAt: "2026-09-03T01:00:00Z" });
  const b = buildHistoricalCalibration({ ...high, board: { players: [] }, generatedAt: "2026-09-03T01:00:00Z" });
  assert.deepEqual(a.parameterSelection, b.parameterSelection);
  assert.notEqual(a.challengerZero.activeGameMae, b.challengerZero.activeGameMae);
});

function syntheticIdpHistory(holdoutSnapMultiplier = 1, holdoutPointMultiplier = 1) {
  const weeklyScores = [];
  for (let season = 2020; season <= 2025; season += 1) {
    for (const position of ["DL", "LB", "DB"]) {
      for (let player = 1; player <= 30; player += 1) {
        const holdoutMultiplier = season === 2025 ? holdoutPointMultiplier : 1;
        const tackleFloor = (2 + player / 20) * holdoutMultiplier;
        const stableDisruption = (player % 7) / 10 * holdoutMultiplier;
        const volatileSplash = (player % 5) / 5 * holdoutMultiplier;
        weeklyScores.push({
          season,
          playerId: `${position}-${player}`,
          position,
          week: 1,
          points: tackleFloor + stableDisruption + volatileSplash,
          idpBuckets: { tackleFloor, stableDisruption, volatileSplash },
          defenseSnaps: (40 + player / 2) * (season === 2025 ? holdoutSnapMultiplier : 1),
        });
      }
    }
  }
  return weeklyScores;
}

test("IDP parameter selection and holdout predictions cannot read same-season snaps", () => {
  const baselineParams = { decay: 0.75, shrinkGames: 4 };
  const normal = buildIdpRankingCalibration({ weeklyScores: syntheticIdpHistory(1), baselineParams });
  const contaminated = buildIdpRankingCalibration({ weeklyScores: syntheticIdpHistory(10_000), baselineParams });
  assert.deepEqual(normal.preregistration, contaminated.preregistration);
  assert.deepEqual(normal.holdoutMetrics, contaminated.holdoutMetrics);
  assert.deepEqual(normal.gateByPosition, contaminated.gateByPosition);
});

test("IDP preregistration cannot read same-season points or component shares", () => {
  const baselineParams = { decay: 0.75, shrinkGames: 4 };
  const normal = buildIdpRankingCalibration({ weeklyScores: syntheticIdpHistory(1, 1), baselineParams });
  const contaminated = buildIdpRankingCalibration({ weeklyScores: syntheticIdpHistory(1, 100), baselineParams });
  assert.deepEqual(normal.preregistration, contaminated.preregistration);
  assert.notDeepEqual(normal.holdoutMetrics, contaminated.holdoutMetrics);
});
