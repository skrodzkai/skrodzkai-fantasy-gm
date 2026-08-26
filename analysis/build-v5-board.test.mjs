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
    specialistSnapshot: { observedAt: "2026-08-22T10:01:00Z", positions: {}, eligibilityEvidence: {} },
    sleeperPlayers: { s1: { yahoo_id: 1, status: "Active", injury_status: null } },
    eligibilitySnapshot: null,
    replacementRoster: null,
    ...overrides,
  });
}

test("keeps history and market data out of projection evidence", () => {
  const board = fixture();
  assert.equal(board.players[0].consensusPoints, 420);
  assert.deepEqual(board.players[0].sourceIds, ["yahoo-season-projection"]);
  assert.equal(board.players[0].automaticEligible, false);
  assert.equal(board.players[0].manualEligible, true);
  assert.equal(board.players[0].validationStatus, "UNVALIDATED_SINGLE_SOURCE_PROJECTION");
  assert.equal(board.boards.offense[0].draftBoardRank, 1);
});

test("validates offense only with two fresh independent projection families", () => {
  const board = fixture({ projectionSnapshots: [{
    manifest: {
      snapshotId: "espn-clay-test", sourceId: "espn-mike-clay", sourceFamily: "espn-clay",
      sourceAsOf: "2026-08-22T11:00:00Z", retrievedAt: "2026-08-22T11:10:00Z",
      contentSha256: "a".repeat(64), gamesBasis: "17", projectionPeriod: "2026", licenseUseNote: "test",
    },
    rows: [{ name: "Quarterback", team: "BUF", position: "QB", projectionGames: 17, stats: { passingCompletions: 300, passingYards: 4000, passingTouchdowns: 30, interceptions: 10 } }],
  }] });
  assert.equal(board.players[0].sourceFamilyCount, 2);
  assert.equal(board.players[0].automaticEligible, true);
  assert.equal(board.players[0].validationStatus, "EXECUTABLE");
});

test("K and DEF use current Yahoo preseason rank rather than projection order", () => {
  const board = fixture({
    baselineRows: [
      { yahoo_id: "10", name: "Kicker A", team: "A", position: "K", projection: 100 },
      { yahoo_id: "11", name: "Kicker B", team: "B", position: "K", projection: 150 },
    ],
    offenseSnapshot: { observedAt: "2026-08-22T10:00:00Z", players: [] },
    specialistSnapshot: { observedAt: "2026-08-22T10:01:00Z", positions: { K: [
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
  assert.ok(board.boards.specialists.K.every((player) => player.validationStatus === "UNVALIDATED_SPECIALIST_PROJECTION"));
  assert.ok(board.boards.specialists.K.every((player) => player.automaticEligible === true));
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
      observedAt: "2026-08-22T10:01:00Z",
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
      observedAt: "2026-08-22T10:01:00Z",
      eligibilityEvidence: { travisHunterInDbFilter: true },
      positions: { DB: [{ yahooId: "41787", name: "Travis Hunter", team: "JAX", position: "WR", yahooProjectedPoints: 92 }] },
    },
    sleeperPlayers: {},
  });
  assert.equal(board.players[0].position, "WR");
  assert.equal(board.players[0].yahooPosition, "WR");
  assert.equal(board.players[0].sourceCount, 1);
  assert.deepEqual(board.players[0].eligible, ["WR", "W/R/T", "CB", "DB", "D"]);
  assert.equal(board.players[0].automaticEligible, false);
  assert.equal(board.players[0].manualEligible, true);
  assert.equal(board.players[0].validationStatus, "DUAL_ROLE_SCORING_UNVERIFIED");
  assert.equal(board.boards.specialists.DB[0].yahooId, "41787");
});

test("split Yahoo Travis Hunter identities remain manual-only", () => {
  const board = fixture({
    baselineRows: [],
    offenseSnapshot: {
      observedAt: "2026-08-22T10:00:00Z",
      players: [{ yahooId: "99001", name: "Travis Hunter", team: "JAX", position: "WR", yahooProjectedPoints: 90 }],
    },
    specialistSnapshot: {
      observedAt: "2026-08-22T10:01:00Z",
      positions: { DB: [{ yahooId: "99002", name: "Travis Hunter", team: "JAX", position: "CB", yahooProjectedPoints: 90 }] },
      eligibilityEvidence: {},
    },
    sleeperPlayers: {},
  });
  const hunters = board.players.filter((player) => player.name === "Travis Hunter");
  assert.deepEqual(hunters.map((player) => player.yahooId).sort(), ["99001", "99002"]);
  assert.ok(hunters.every((player) => player.automaticEligible === false));
  assert.ok(hunters.every((player) => player.validationStatus === "DUAL_ROLE_SCORING_UNVERIFIED"));
});

test("a lone current Travis Hunter identity remains manual-only with two fresh families", () => {
  const board = fixture({
    baselineRows: [],
    offenseSnapshot: {
      observedAt: "2026-08-22T10:00:00Z",
      players: [{ yahooId: "99001", name: "Travis Hunter", team: "JAX", position: "WR", yahooProjectedPoints: 90 }],
    },
    projectionSnapshots: [{
      manifest: {
        snapshotId: "espn-clay-hunter", sourceId: "espn-mike-clay", sourceFamily: "espn-clay",
        sourceAsOf: "2026-08-22T11:00:00Z", retrievedAt: "2026-08-22T11:10:00Z",
        contentSha256: "b".repeat(64), gamesBasis: "17", projectionPeriod: "2026", licenseUseNote: "test",
      },
      rows: [{ name: "Travis Hunter", team: "JAX", position: "WR", projectionGames: 17, stats: { receptions: 50, receivingYards: 700, receivingTouchdowns: 5, receivingHundredYardGames: 0, rushingHundredYardGames: 0 } }],
    }],
    specialistSnapshot: { observedAt: "2026-08-22T10:01:00Z", positions: {}, eligibilityEvidence: {} },
    sleeperPlayers: {},
  });
  assert.equal(board.players[0].sourceFamilyCount, 2);
  assert.equal(board.players[0].automaticEligible, false);
  assert.equal(board.players[0].manualEligible, true);
  assert.equal(board.players[0].validationStatus, "DUAL_ROLE_SCORING_UNVERIFIED");
});

test("league-specific eligibility adds unprojected CB fallbacks without inventing points", () => {
  const board = fixture({
    eligibilitySnapshot: {
      observedAt: "2026-08-22T10:02:00Z",
      positionFilter: "CB",
      players: [{ yahooId: "2", name: "Corner", team: "BUF", position: "CB", eligible: ["CB"] }],
    },
  });
  const corner = board.players.find((player) => player.yahooId === "2");
  assert.equal(corner.position, "CB");
  assert.deepEqual(corner.eligible, ["CB"]);
  assert.equal(corner.consensusPoints, null);
  assert.equal(corner.executable, false);
  assert.equal(corner.yahooEligibilityFilters.includes("CB"), true);
});

test("receipts every Yahoo snapshot timestamp and rejects missing eligibility evidence time", () => {
  const board = fixture({
    eligibilitySnapshot: {
      observedAt: "2026-08-22T10:02:00Z",
      positionFilter: "CB",
      players: [],
    },
  });
  assert.deepEqual(board.snapshotReceipts, {
    yahooOffenseObservedAt: "2026-08-22T10:00:00Z",
    yahooSpecialistObservedAt: "2026-08-22T10:01:00Z",
    yahooEligibilityObservedAt: "2026-08-22T10:02:00Z",
  });
  assert.throws(() => fixture({ eligibilitySnapshot: { positionFilter: "CB", players: [] } }), /eligibilitySnapshot\.observedAt/);
  assert.throws(() => fixture({ specialistSnapshot: { positions: {}, eligibilityEvidence: {} } }), /specialistSnapshot\.observedAt/);
});

test("a stale specialist snapshot cannot borrow the offense timestamp", () => {
  const board = fixture({
    baselineRows: [{ yahoo_id: "10", name: "Kicker", team: "BUF", position: "K", projection: 100 }],
    offenseSnapshot: { observedAt: "2026-08-22T10:00:00Z", players: [] },
    specialistSnapshot: {
      observedAt: "2026-08-01T10:00:00Z",
      positions: { K: [{ yahooId: "10", name: "Kicker", team: "BUF", position: "K", yahooProjectedPoints: 100, yahooPreseasonRank: 1 }] },
      eligibilityEvidence: {},
    },
    sleeperPlayers: { k: { yahoo_id: 10, status: "Active", injury_status: null } },
  });
  const kicker = board.players.find((player) => player.yahooId === "10");
  assert.equal(kicker.executable, false);
  assert.match(kicker.blockReason, /requires 1 fresh projection families|no fresh injury evidence/);
});

test("an offense row keeps its own projection and injury timestamp when it also appears in a stale specialist filter", () => {
  const board = fixture({
    offenseSnapshot: {
      observedAt: "2026-08-22T10:00:00Z",
      players: [{ yahooId: "1", name: "Quarterback", team: "BUF", position: "QB", yahooProjectedPoints: 420, injuryStatus: null }],
    },
    specialistSnapshot: {
      observedAt: "2026-08-01T10:00:00Z",
      positions: { DB: [{ yahooId: "1", name: "Quarterback", team: "BUF", position: "QB", yahooProjectedPoints: 1, injuryStatus: "O" }] },
      eligibilityEvidence: {},
    },
  });
  const player = board.players[0];
  assert.equal(player.consensusPoints, 420);
  assert.equal(player.injury.evidence.find((entry) => entry.sourceId === "yahoo-player-list").observedAt, "2026-08-22T10:00:00Z");
  assert.equal(player.injury.draftAction, "CLEAR");
  assert.equal(player.injury.evidence.find((entry) => entry.sourceId === "yahoo-player-list").status, "CLEAR");
  assert.deepEqual(player.yahooEligibilityFilters, ["DB", "O"]);
});

test("emits the compact injury watchlist in the board artifact", () => {
  const board = fixture({
    offenseSnapshot: {
      observedAt: "2026-08-22T10:00:00Z",
      players: [{ yahooId: "1", name: "Quarterback", team: "BUF", position: "QB", yahooProjectedPoints: 420, injuryStatus: "Q" }],
    },
  });
  assert.deepEqual(board.injuryWatchlist.map((player) => player.yahooId), ["1"]);
  assert.equal(board.injuryWatchlist[0].draftAction, "REVIEW");
});
