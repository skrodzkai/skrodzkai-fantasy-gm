import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPlayerBoard,
  deriveJointReplacementLevels,
  deriveReplacementRanks,
  scoreOffenseStatLine,
  scoreIdpStatLine,
} from "./player-intelligence.mjs";

test("scores the league's QB premium and yardage bonuses exactly", () => {
  assert.equal(
    scoreOffenseStatLine({
      passingCompletions: 25,
      passingYards: 300,
      passingTouchdowns: 3,
      interceptions: 1,
      rushingYards: 100,
      rushingTouchdowns: 1,
    }),
    48.5,
  );
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
