import test from "node:test";
import assert from "node:assert/strict";

import { assembleV5Board } from "./build-v5-board.mjs";

function fixture(overrides = {}) {
  return assembleV5Board({
    asOf: "2026-08-22T12:00:00Z",
    baselineObservedAt: "2026-08-21T12:00:00Z",
    sleeperObservedAt: "2026-08-22T10:05:00Z",
    baselineRows: [
      {
        yahoo_id: "1",
        name: "Quarterback",
        team: "BUF",
        position: "QB",
        projection: 400,
        gsis_id: "g1",
        sleeper_id: "s1",
        payload_json: JSON.stringify({ eligible: ["QB"] }),
      },
    ],
    offenseSnapshot: {
      observedAt: "2026-08-22T10:00:00Z",
      players: [
        {
          yahooId: "1",
          name: "Quarterback",
          team: "BUF",
          position: "QB",
          yahooProjectedPoints: 420,
          yahooPreseasonRank: 4,
          rosteredPercent: 100,
          injuryStatus: null,
        },
      ],
    },
    specialistSnapshot: { positions: {}, eligibilityEvidence: {} },
    sleeperPlayers: { s1: { yahoo_id: 1, status: "Active", injury_status: null } },
    eligibilitySnapshot: null,
    ...overrides,
  });
}

test("combines Yahoo and the league-scored baseline with visible weights", () => {
  const board = fixture();
  assert.equal(board.players[0].consensusPoints, 413);
  assert.deepEqual(board.players[0].sourceIds, [
    "league-scored-history-market-baseline",
    "yahoo-season-projection",
  ]);
  assert.equal(board.players[0].executable, true);
  assert.equal(board.boards.offense[0].draftBoardRank, 1);
});

test("K and DEF use current Yahoo preseason rank rather than projection order", () => {
  const board = fixture({
    baselineRows: [
      { yahoo_id: "10", name: "Kicker A", team: "A", position: "K", projection: 100 },
      { yahoo_id: "11", name: "Kicker B", team: "B", position: "K", projection: 150 },
    ],
    offenseSnapshot: { observedAt: "2026-08-22T10:00:00Z", players: [] },
    specialistSnapshot: { positions: { K: [
      { yahooId: "10", name: "Kicker A", team: "A", position: "K", yahooProjectedPoints: 100, yahooPreseasonRank: 20 },
      { yahooId: "11", name: "Kicker B", team: "B", position: "K", yahooProjectedPoints: 150, yahooPreseasonRank: 40 },
    ] }, eligibilityEvidence: {} },
    sleeperPlayers: {
      a: { yahoo_id: 10, status: "Active", injury_status: null },
      b: { yahoo_id: 11, status: "Active", injury_status: null },
    },
  });
  assert.deepEqual(board.boards.specialists.K.map((player) => player.yahooId), ["10", "11"]);
  assert.equal(board.specialistRankingBasis.K, "Yahoo preseason rank");
});

test("Yahoo injury markers block automatic use even when projection evidence is complete", () => {
  const board = fixture({
    offenseSnapshot: {
      observedAt: "2026-08-22T10:00:00Z",
      players: [
        {
          yahooId: "1",
          name: "Quarterback",
          team: "BUF",
          position: "QB",
          yahooProjectedPoints: 420,
          injuryStatus: "Q",
        },
      ],
    },
    sleeperPlayers: { s1: { yahoo_id: 1, status: "Active", injury_status: null } },
  });
  assert.equal(board.players[0].executable, false);
  assert.equal(board.players[0].injury.conflict, true);
});

test("filter membership preserves dual-role Yahoo eligibility evidence", () => {
  const board = fixture({
    specialistSnapshot: {
      eligibilityEvidence: { travisHunterInDbFilter: true },
      positions: { DB: [{ yahooId: "1", name: "Quarterback", position: "QB", yahooProjectedPoints: 420 }] },
    },
  });
  assert.deepEqual(board.players[0].yahooEligibilityFilters, ["DB", "O"]);
  assert.equal(board.eligibilityEvidence.travisHunterInDbFilter, true);
});

test("an exact name-team baseline match preserves Travis Hunter as the verified CB exception", () => {
  const board = fixture({
    baselineRows: [{
      yahoo_id: "",
      name: "Travis Hunter",
      team: "JAX",
      position: "WR",
      projection: 100,
      payload_json: JSON.stringify({
        eligible: ["WR", "W/R/T", "CB", "DB", "D"],
        specialist_qualified: true,
        specialist: { draft_position: "DB" },
      }),
    }],
    offenseSnapshot: {
      observedAt: "2026-08-22T10:00:00Z",
      players: [{ yahooId: "41787", name: "Travis Hunter", team: "JAX", position: "WR", yahooProjectedPoints: 92 }],
    },
    specialistSnapshot: {
      eligibilityEvidence: { travisHunterInDbFilter: true },
      positions: { DB: [{ yahooId: "41787", name: "Travis Hunter", team: "JAX", position: "WR", yahooProjectedPoints: 92 }] },
    },
    sleeperPlayers: {},
  });
  assert.equal(board.players[0].position, "DB");
  assert.equal(board.players[0].yahooPosition, "WR");
  assert.equal(board.players[0].sourceCount, 2);
  assert.deepEqual(board.players[0].eligible, ["WR", "W/R/T", "CB", "DB", "D"]);
  assert.equal(board.boards.specialists.DB[0].yahooId, "41787");
});

test("league-specific eligibility adds unprojected CB fallbacks without inventing points", () => {
  const board = fixture({
    eligibilitySnapshot: {
      positionFilter: "CB",
      players: [{ yahooId: "2", name: "Corner", team: "BUF", position: "CB", eligible: ["CB"] }],
    },
  });
  const corner = board.players.find((player) => player.yahooId === "2");
  assert.equal(corner.position, "DB");
  assert.deepEqual(corner.eligible, ["CB"]);
  assert.equal(corner.consensusPoints, null);
  assert.equal(corner.executable, false);
  assert.equal(corner.yahooEligibilityFilters.includes("CB"), true);
});
