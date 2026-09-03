import assert from "node:assert/strict";
import test from "node:test";

import { buildRankingIntelligence, renderRankingCsv } from "./ranking-intelligence.mjs";

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
