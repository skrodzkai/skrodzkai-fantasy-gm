import assert from "node:assert/strict";
import test from "node:test";

import { attachHistoricalCalibration, buildRankingIntelligence, renderRankingCsv } from "./ranking-intelligence.mjs";

function player(index, position = "RB") {
  return {
    yahooId: String(index), name: `Player ${index}`, team: "BUF", position, eligible: [position], overallRank: index,
    expectedGames: 17, bye: 7, sourceFamilyPerGamePoints: { yahoo: 10 }, injury: { status: "CLEAR", draftAction: "CLEAR", evidence: [] },
  };
}

function snapshot(sourceId, sourceFamily, players) {
  return {
    manifest: { sourceId, sourceFamily, sourceAsOf: "2026-09-02T16:00:00Z" },
    rows: players.map((entry) => ({ playerId: entry.yahooId, name: entry.name, team: entry.team, position: entry.position, projectionGames: 17, scoringKind: "offense", stats: { rushingYards: 1700 }, omittedScoringCategories: ["rushingHundredYardGames", "rushingTouchdowns", "receptions", "receivingYards", "receivingTouchdowns", "receivingHundredYardGames", "returnYards", "returnTouchdowns", "twoPointConversions", "fumblesLost", "offensiveFumbleReturnTouchdowns"] })),
  };
}

test("ranking bundle freezes source rows but blocks incomplete-scoring challengers", () => {
  const players = Array.from({ length: 60 }, (_, index) => player(index + 1));
  const source = snapshot("challenger", "challenger", players);
  const result = buildRankingIntelligence({ board: { generatedAt: "2026-09-02T16:30:00Z", players }, snapshots: [source], generatedAt: "2026-09-02T17:00:00Z" });
  assert.equal(result.rawSources[0].rows.length, 60);
  assert.equal(result.players[0].scorableSourceFamilies.includes("challenger"), false);
  assert.ok(result.players[0].flags.includes("SCORING_EVIDENCE_UNVALIDATED"));
  assert.match(renderRankingCsv(result.players), /^candidateRank,previousRank,/);
});

test("historical calibration is annotation-only", () => {
  const players = [player(1)];
  const source = snapshot("challenger", "challenger", players);
  const input = { board: { generatedAt: "2026-09-02T16:30:00Z", players }, snapshots: [source], generatedAt: "2026-09-02T17:00:00Z" };
  const withoutCalibration = buildRankingIntelligence(input);
  const withCalibration = buildRankingIntelligence({
    ...input,
    historicalCalibration: {
      currentPlayers: [{ yahooId: "1", gsisId: "g1", position: "RB", status: "SEASON_RANGE_GATE_FAILED", activeWeek: { p20: 4, p80: 22 }, availability: { p20: 10, p50: 15, p80: 16 }, season: null }],
    },
  });
  const footballFields = ["candidateRank", "candidatePoints", "vorp", "sourceFamilyPerGamePoints"];
  const select = (row) => Object.fromEntries(footballFields.map((field) => [field, row[field]]));
  assert.deepEqual(select(withCalibration.players[0]), select(withoutCalibration.players[0]));
  assert.equal(withCalibration.players[0].calibrationStatus, "SEASON_RANGE_GATE_FAILED");
  assert.equal(withCalibration.players[0].activeWeekP20, 4);
  assert.equal(withCalibration.players[0].seasonP50, null);
});

test("annotates a frozen pack without changing football fields", () => {
  const frozen = { schemaVersion: 1, astraModelBrief: { validation: [] }, players: [{ yahooId: "1", position: "RB", candidateRank: 7, candidatePoints: 201, vorp: 45, sourceFamilyPerGamePoints: { yahoo: 12 } }] };
  const before = structuredClone(frozen.players[0]);
  const result = attachHistoricalCalibration(frozen, { currentPlayers: [{ yahooId: "1", status: "ACTIVE_WEEK_GATE_FAILED", activeWeek: null, availability: { p20: 8, p50: 14, p80: 16 }, season: null }] });
  assert.deepEqual(Object.fromEntries(Object.keys(before).map((key) => [key, result.players[0][key]])), before);
  assert.equal(result.players[0].availabilityP50, 14);
  assert.equal(result.schemaVersion, 2);
});

test("does not claim historical validation when calibration is absent", () => {
  const frozen = { schemaVersion: 1, astraModelBrief: { validation: ["source-family ablation"] }, players: [{ yahooId: "1", position: "RB" }] };
  const result = attachHistoricalCalibration(frozen);
  assert.deepEqual(result.astraModelBrief.validation, ["source-family ablation"]);
  assert.equal(Object.hasOwn(result.astraModelBrief, "calibrationPolicy"), false);
});
