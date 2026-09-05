import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPlayerBoard,
  deriveJointReplacementLevels,
  deriveReplacementRanks,
  scoreOffenseStatLine,
  scoreWeeklyOffenseStatLines,
  scoreIdpStatLine,
  scoreKickerStatLine,
} from "./player-intelligence.mjs";

test("cached offense-table kicker rows cannot halve Yahoo kicker projections", () => {
  const board = buildPlayerBoard({
    asOf:"2026-09-05T18:18:06Z", minimumFreshSources:1, replacementRanks:{K:2},
    players:[{playerId:"40819",name:"Brandon Aubrey",position:"K"},{playerId:"29792",name:"Ka'imi Fairbairn",position:"K"}],
    sources:[
      {sourceId:"yahoo",updatedAt:"2026-09-05T16:58:19Z",rows:[{playerId:"40819",perGamePoints:8.904375},{playerId:"29792",perGamePoints:8.638125}]},
      {sourceId:"razzball",updatedAt:"2026-09-05T16:00:00Z",rows:[{playerId:"40819",position:"K",scoringKind:"offense",projectionGames:17,stats:{passingYards:0,rushingYards:0,receptions:0}}]},
    ],
  });
  const aubrey = board.players.find(p=>p.playerId==="40819");
  assert.equal(aubrey.perGamePoints, 8.904375);
  assert.equal(aubrey.sourceFamilyCount, 1);
  assert.deepEqual(aubrey.sourceFamilyPerGamePoints, {yahoo:8.904375});
  assert.ok(aubrey.perGamePoints > board.players.find(p=>p.playerId==="29792").perGamePoints);
});

test("scores the league's QB premium and yardage bonuses exactly", () => {
  assert.equal(
    scoreOffenseStatLine({
      passingCompletions: 25,
      passingYards: 300,
      passingTouchdowns: 3,
      interceptions: 1,
      rushingYards: 100,
      rushingTouchdowns: 1,
      rushingHundredYardGames: 1,
    }),
    48.5,
  );
});

test("does not invent a weekly 100-yard bonus from season totals", () => {
  assert.equal(scoreOffenseStatLine({ rushingYards: 580 }), 58);
});

test("counts every weekly 100-yard event instead of awarding one season bonus", () => {
  assert.equal(
    scoreOffenseStatLine({
      rushingYards: 650,
      rushingHundredYardGames: 3,
      receivingYards: 1_200,
      receivingHundredYardGames: 5,
    }),
    201,
  );
});

test("scores weekly projection rows so each threshold event is preserved", () => {
  assert.equal(scoreWeeklyOffenseStatLines([
    { rushingYards: 101, rushingHundredYardGames: 1 },
    { rushingYards: 99 },
    { receivingYards: 120, receivingHundredYardGames: 1 },
  ]), 36);
});

test("scores every observed IDP category with the league's exact values", () => {
  assert.equal(scoreIdpStatLine({
    soloTackles: 10,
    assistedTackles: 4,
    sacks: 2,
    interceptions: 1,
    forcedFumbles: 1,
    fumbleRecoveries: 1,
    touchdowns: 1,
    safeties: 1,
    passesDefended: 2,
    blockedKicks: 1,
    tacklesForLoss: 3,
    turnoverReturnYards: 20,
    extraPointReturns: 1,
  }), 36);
});

test("scores kicker raw stats with the league's flat field-goal and missed-PAT rules", () => {
  assert.equal(scoreKickerStatLine({ fieldGoalsMade: 30, extraPointsMade: 40, extraPointsAttempted: 42 }), 128);
});

test("joint replacement reassigns multi-position players across flex and IDP slots", () => {
  const result = deriveJointReplacementLevels({
    teamCount: 2,
    rosterSlots: ["WR", "W/R/T", "D", "DB", "LB"],
    players: [
      { playerId: "w1", position: "WR", eligible: ["WR"], consensusPoints: 100 },
      { playerId: "w2", position: "WR", eligible: ["WR"], consensusPoints: 90 },
      { playerId: "w3", position: "WR", eligible: ["WR"], consensusPoints: 80 },
      { playerId: "w4", position: "WR", eligible: ["WR"], consensusPoints: 70 },
      { playerId: "r1", position: "RB", eligible: ["RB"], consensusPoints: 75 },
      { playerId: "r2", position: "RB", eligible: ["RB"], consensusPoints: 65 },
      { playerId: "d1", position: "DL", eligible: ["DL", "D"], consensusPoints: 60 },
      { playerId: "d2", position: "DL", eligible: ["DL", "D"], consensusPoints: 50 },
      { playerId: "b1", position: "DB", eligible: ["DB", "D"], consensusPoints: 55 },
      { playerId: "b2", position: "DB", eligible: ["DB", "D"], consensusPoints: 45 },
      { playerId: "b3", position: "DB", eligible: ["DB", "D"], consensusPoints: 35 },
      { playerId: "b4", position: "DB", eligible: ["DB", "D"], consensusPoints: 25 },
      { playerId: "l1", position: "LB", eligible: ["LB", "D"], consensusPoints: 58 },
      { playerId: "l2", position: "LB", eligible: ["LB", "D"], consensusPoints: 48 },
      { playerId: "l3", position: "LB", eligible: ["LB", "D"], consensusPoints: 38 },
      { playerId: "l4", position: "LB", eligible: ["LB", "D"], consensusPoints: 28 },
    ],
  });
  assert.equal(result.assignments.length, 10);
  assert.deepEqual(result.replacementBySlot, { WR: 90, "W/R/T": 75, D: 50, DB: 45, LB: 48, CB: 45, S: 45 });
});

test("derives replacement ranks while exposing every roster-share assumption", () => {
  const result = deriveReplacementRanks({
    teamCount: 12,
    starters: { QB: 1, RB: 2, WR: 3, TE: 1 },
    flexSlots: 1,
    flexShares: { RB: 0.4, WR: 0.5, TE: 0.1 },
    benchSlots: 6,
    benchShares: { QB: 0.1, RB: 0.35, WR: 0.4, TE: 0.15 },
  });
  assert.deepEqual(result.rankByPosition, { QB: 20, RB: 54, WR: 71, TE: 24 });
  assert.equal(result.assumptions.QB.direct, 12);
});

test("builds an uncertainty-aware VORP board from fresh independent inputs", () => {
  const board = buildPlayerBoard({
    asOf: "2026-08-22T12:00:00Z",
    players: [
      { playerId: "q1", name: "Quarterback One", position: "QB" },
      { playerId: "q2", name: "Quarterback Two", position: "QB" },
    ],
    replacementRanks: { QB: 2 },
    sources: [
      {
        sourceId: "model-a",
        updatedAt: "2026-08-22T10:00:00Z",
        rows: [
          { playerId: "q1", leaguePoints: 400 },
          { playerId: "q2", leaguePoints: 300 },
        ],
      },
      {
        sourceId: "model-b",
        updatedAt: "2026-08-22T09:00:00Z",
        rows: [
          { playerId: "q1", leaguePoints: 380 },
          { playerId: "q2", leaguePoints: 310 },
        ],
      },
    ],
  });
  assert.equal(board.players[0].playerId, "q1");
  assert.equal(board.players[0].consensusPoints, 390);
  assert.equal(board.players[0].replacementPoints, 305);
  assert.equal(board.players[0].vorp, 85);
  assert.equal(board.players[0].executable, true);
});

test("normalizes source game assumptions before combining projections", () => {
  const board = buildPlayerBoard({
    asOf: "2026-08-22T12:00:00Z",
    players: [{ playerId: "q1", name: "Quarterback One", position: "QB", expectedGames: 14 }],
    replacementRanks: { QB: 1 },
    sources: [
      { sourceId: "full", updatedAt: "2026-08-22T10:00:00Z", rows: [{ playerId: "q1", leaguePoints: 340, projectionGames: 17 }] },
      { sourceId: "short", updatedAt: "2026-08-22T10:00:00Z", rows: [{ playerId: "q1", leaguePoints: 280, projectionGames: 14 }] },
    ],
  });
  assert.equal(board.players[0].perGamePoints, 20);
  assert.equal(board.players[0].consensusPoints, 280);
  assert.equal(board.players[0].sourceSpreadLow, 280);
});

test("keeps source spread separate from calibrated player outcomes", () => {
  const board = buildPlayerBoard({
    asOf: "2026-08-22T12:00:00Z",
    players: [{ playerId: "r1", name: "Runner", position: "RB" }],
    replacementRanks: { RB: 1 },
    sources: [
      { sourceId: "a", updatedAt: "2026-08-22T10:00:00Z", rows: [{ playerId: "r1", leaguePoints: 200 }] },
      { sourceId: "b", updatedAt: "2026-08-22T10:00:00Z", rows: [{ playerId: "r1", leaguePoints: 240 }] },
    ],
  });
  assert.equal(board.players[0].sourceDisagreementStatus, "AVAILABLE_DIAGNOSTIC_ONLY");
  assert.equal(board.players[0].outcomeLow, null);
  assert.equal(board.players[0].outcomeHigh, null);
  assert.equal(board.players[0].uncertaintyStatus, "OUTCOME_INTERVAL_UNAVAILABLE");
});

test("stale or single-source projections cannot enter the executable ladder", () => {
  const board = buildPlayerBoard({
    asOf: "2026-08-22T12:00:00Z",
    players: [{ playerId: "r1", name: "Runner", position: "RB" }],
    replacementRanks: { RB: 1 },
    sources: [
      {
        sourceId: "fresh",
        updatedAt: "2026-08-22T11:00:00Z",
        rows: [{ playerId: "r1", leaguePoints: 200 }],
      },
      {
        sourceId: "stale",
        updatedAt: "2026-08-01T11:00:00Z",
        rows: [{ playerId: "r1", leaguePoints: 500 }],
      },
    ],
  });
  assert.equal(board.players[0].executable, false);
  assert.match(board.players[0].blockReason, /found 1/);
});

test("two feeds from one family count as one independent projection", () => {
  const board = buildPlayerBoard({
    asOf: "2026-08-22T12:00:00Z",
    players: [{ playerId: "r1", name: "Runner", position: "RB" }],
    replacementRanks: { RB: 1 },
    sources: [
      { sourceId: "feed-a", family: "same", updatedAt: "2026-08-22T11:00:00Z", rows: [{ playerId: "r1", leaguePoints: 200 }] },
      { sourceId: "feed-b", family: "same", updatedAt: "2026-08-22T11:00:00Z", rows: [{ playerId: "r1", leaguePoints: 220 }] },
    ],
  });
  assert.equal(board.players[0].sourceCount, 2);
  assert.equal(board.players[0].sourceFamilyCount, 1);
  assert.equal(board.players[0].consensusPoints, 210);
  assert.equal(board.players[0].executable, false);
});

test("required Yahoo family cannot be replaced by two external families", () => {
  const board = buildPlayerBoard({
    asOf: "2026-08-22T12:00:00Z",
    players: [{ playerId: "r1", name: "Runner", position: "RB" }],
    replacementRanks: { RB: 1 },
    evidencePolicy: () => ({ minimumFreshFamilies: 2, requiredFamilies: ["yahoo"] }),
    sources: [
      { sourceId: "external-a", family: "a", updatedAt: "2026-08-22T11:00:00Z", rows: [{ playerId: "r1", leaguePoints: 200 }] },
      { sourceId: "external-b", family: "b", updatedAt: "2026-08-22T11:00:00Z", rows: [{ playerId: "r1", leaguePoints: 220 }] },
    ],
  });
  assert.equal(board.players[0].sourceFamilyCount, 2);
  assert.equal(board.players[0].executable, false);
  assert.equal(board.players[0].evidenceStatus, "MISSING_REQUIRED_PROJECTION_FAMILY");
  assert.deepEqual(board.players[0].missingRequiredSourceFamilies, ["yahoo"]);
});

test("projection omission receipts propagate without fabricated numeric values", () => {
  const board = buildPlayerBoard({
    asOf: "2026-08-22T12:00:00Z",
    players: [{ playerId: "r1", name: "Runner", position: "RB" }],
    replacementRanks: { RB: 1 },
    evidencePolicy: () => ({ minimumFreshFamilies: 2, requiredFamilies: ["yahoo"] }),
    sources: [
      { sourceId: "yahoo", family: "yahoo", updatedAt: "2026-08-22T11:00:00Z", rows: [{ playerId: "r1", leaguePoints: 200 }] },
      { sourceId: "espn", family: "espn-clay", updatedAt: "2026-08-22T11:00:00Z", acceptedOmissions: ["rushingHundredYardGames"], rows: [{ playerId: "r1", stats: { rushingYards: 1_000 }, omittedScoringCategories: ["rushingHundredYardGames"] }] },
    ],
  });
  assert.deepEqual(board.players[0].omittedScoringCategories, ["rushingHundredYardGames"]);
  assert.equal(board.players[0].consensusPoints, 150);
  assert.match(board.players[0].projectionBlendPolicy, /equal-family-mean/);
  assert.equal(board.players[0].sourceFamilyPerGamePoints["espn-clay"], 100 / 17);
  assert.equal(board.players[0].executable, true);
});

test("unaccepted omissions remain diagnostic and cannot satisfy evidence policy", () => {
  const board = buildPlayerBoard({
    asOf: "2026-08-22T12:00:00Z",
    players: [{ playerId: "r1", name: "Runner", position: "RB" }],
    replacementRanks: { RB: 1 },
    evidencePolicy: () => ({ minimumFreshFamilies: 2, requiredFamilies: ["yahoo"] }),
    sources: [
      { sourceId: "yahoo", family: "yahoo", updatedAt: "2026-08-22T11:00:00Z", rows: [{ playerId: "r1", leaguePoints: 200 }] },
      { sourceId: "partial", family: "partial", updatedAt: "2026-08-22T11:00:00Z", rows: [{ playerId: "r1", stats: { rushingYards: 1_000 }, omittedScoringCategories: ["rushingTouchdowns"] }] },
    ],
  });
  assert.equal(board.players[0].consensusPoints, 200);
  assert.equal(board.players[0].scorableSourceFamilyCount, 1);
  assert.deepEqual(board.players[0].unacceptedOmittedScoringCategories, ["rushingTouchdowns"]);
  assert.equal(board.players[0].executable, false);
});

test("uses the median once three scorable source families are available", () => {
  const board = buildPlayerBoard({
    asOf: "2026-08-22T12:00:00Z",
    players: [{ playerId: "r1", name: "Runner", position: "RB" }],
    replacementRanks: { RB: 1 },
    sources: [
      { sourceId: "a", family: "a", updatedAt: "2026-08-22T11:00:00Z", rows: [{ playerId: "r1", leaguePoints: 100 }] },
      { sourceId: "b", family: "b", updatedAt: "2026-08-22T11:00:00Z", rows: [{ playerId: "r1", leaguePoints: 200 }] },
      { sourceId: "c", family: "c", updatedAt: "2026-08-22T11:00:00Z", rows: [{ playerId: "r1", leaguePoints: 900 }] },
    ],
  });
  assert.equal(board.players[0].consensusPoints, 200);
  assert.match(board.players[0].projectionBlendPolicy, /median/);
});

test("scores IDP raw-stat rows under the league IDP rules", () => {
  const board = buildPlayerBoard({
    asOf: "2026-08-22T12:00:00Z",
    players: [{ playerId: "d1", name: "Defender", position: "LB" }],
    replacementRanks: { LB: 1 },
    minimumFreshSources: 1,
    sources: [{
      sourceId: "idp",
      family: "idp",
      updatedAt: "2026-08-22T11:00:00Z",
      rows: [{ playerId: "d1", scoringKind: "idp", projectionGames: 17, stats: { soloTackles: 100, sacks: 5 } }],
    }],
  });
  assert.equal(board.players[0].consensusPoints, 60);
});

test("globally gated IDP decision points favor the tackle floor while preserving raw consensus", () => {
  const complete = {
    soloTackles: 0, assistedTackles: 0, sacks: 0, interceptions: 0,
    forcedFumbles: 0, fumbleRecoveries: 0, touchdowns: 0, safeties: 0,
    passesDefended: 0, blockedKicks: 0, tacklesForLoss: 0,
    turnoverReturnYards: 0, extraPointReturns: 0, snaps: 850,
  };
  const board = buildPlayerBoard({
    asOf: "2026-08-22T12:00:00Z",
    players: [
      { playerId: "floor", name: "Floor", position: "LB" },
      { playerId: "splash", name: "Splash", position: "LB" },
    ],
    replacementRanks: { LB: 1 },
    minimumFreshSources: 1,
    idpCalibration: {
      globalGate: { pass: true },
      positionParameters: { LB: { volatileWeight: 0.25, roleExponent: 0, trainingSnapMean: 50 } },
    },
    sources: [{
      sourceId: "idp",
      family: "idp",
      updatedAt: "2026-08-22T11:00:00Z",
      rows: [
        { playerId: "floor", scoringKind: "idp", projectionGames: 17, stats: { ...complete, soloTackles: 120 } },
        { playerId: "splash", scoringKind: "idp", projectionGames: 17, stats: { ...complete, touchdowns: 10 } },
      ],
    }],
  });
  const floor = board.players.find((player) => player.playerId === "floor");
  const splash = board.players.find((player) => player.playerId === "splash");
  assert.equal(floor.consensusPoints, splash.consensusPoints);
  assert.equal(floor.idpDecisionPoints, floor.consensusPoints);
  assert.equal(splash.idpDecisionPoints, splash.consensusPoints * 0.25);
  assert.ok(floor.overallRank < splash.overallRank);
  assert.equal(floor.idpModelStatus, "ACTIVE");
});

test("failed IDP global gate preserves baseline ordering", () => {
  const players = [
    { playerId: "b", name: "Bravo", position: "LB" },
    { playerId: "a", name: "Alpha", position: "LB" },
  ];
  const sources = [{ sourceId: "idp", family: "idp", updatedAt: "2026-08-22T11:00:00Z", rows: [
    { playerId: "a", scoringKind: "idp", leaguePoints: 100 },
    { playerId: "b", scoringKind: "idp", leaguePoints: 100 },
  ] }];
  const baseline = buildPlayerBoard({ asOf: "2026-08-22T12:00:00Z", players, sources, replacementRanks: { LB: 1 }, minimumFreshSources: 1 });
  const failed = buildPlayerBoard({ asOf: "2026-08-22T12:00:00Z", players, sources, replacementRanks: { LB: 1 }, minimumFreshSources: 1, idpCalibration: { globalGate: { pass: false } } });
  assert.deepEqual(failed.players.map((player) => player.playerId), baseline.players.map((player) => player.playerId));
  assert.deepEqual(failed.players.map((player) => player.vorp), baseline.players.map((player) => player.vorp));
});

test("scores kicker raw-stat rows under the league kicker rules", () => {
  const board = buildPlayerBoard({
    asOf: "2026-08-22T12:00:00Z",
    players: [{ playerId: "k1", name: "Kicker", position: "K" }],
    replacementRanks: { K: 1 },
    minimumFreshSources: 1,
    sources: [{ sourceId: "kicker", family: "kicker", updatedAt: "2026-08-22T11:00:00Z", rows: [{ playerId: "k1", scoringKind: "kicker", projectionGames: 17, stats: { fieldGoalsMade: 30, extraPointsMade: 40, extraPointsAttempted: 42 } }] }],
  });
  assert.equal(board.players[0].consensusPoints, 128);
});

test("team-defense season aggregates remain diagnostic even when a row joins", () => {
  const board = buildPlayerBoard({
    asOf: "2026-08-22T12:00:00Z",
    players: [{ playerId: "def1", name: "Buffalo", position: "DEF" }],
    replacementRanks: { DEF: 1 },
    minimumFreshSources: 1,
    sources: [{
      sourceId: "defense",
      family: "defense",
      updatedAt: "2026-08-22T11:00:00Z",
      rows: [{
        playerId: "def1",
        scoringKind: "team-defense",
        leaguePoints: 999,
        stats: { interceptions: 20, returnTouchdowns: 3 },
      }],
    }],
  });
  assert.equal(board.players[0].consensusPoints, null);
  assert.equal(board.players[0].scorableSourceFamilyCount, 0);
});

test("null and blank projection values do not become zero-point evidence", () => {
  const board = buildPlayerBoard({
    asOf: "2026-08-22T12:00:00Z",
    players: [{ playerId: "r1", name: "Runner", position: "RB" }],
    replacementRanks: { RB: 1 },
    sources: [
      { sourceId: "null", updatedAt: "2026-08-22T11:00:00Z", rows: [{ playerId: "r1", leaguePoints: null }] },
      { sourceId: "blank", updatedAt: "2026-08-22T11:00:00Z", rows: [{ playerId: "r1", leaguePoints: "" }] },
    ],
  });
  assert.equal(board.players[0].consensusPoints, null);
  assert.equal(board.players[0].sourceCount, 0);
  assert.equal(board.players[0].executable, false);
});
