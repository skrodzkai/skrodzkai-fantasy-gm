import assert from "node:assert/strict";
import test from "node:test";

import { buildV5ReadinessReport } from "./build-v5-readiness-report.mjs";

test("builds a sanitized report while excluding Joe from opponent analytics", () => {
  const rows = [];
  for (const season of [2024, 2025]) {
    for (const managerId of ["joe", "opponent"]) {
      for (let round = 1; round <= 19; round += 1) {
        rows.push({ season, managerId, draftSlot: managerId === "joe" ? 1 : 2, pick: (round - 1) * 12 + 2, round, position: round === 15 ? "K" : round === 16 ? "DEF" : round === 17 ? "LB" : round === 18 ? "DB" : round === 19 ? "DL" : "RB" });
      }
    }
  }
  const report = buildV5ReadinessReport({
    historyRows: rows,
    generatedAt: "2026-08-23T00:00:00Z",
    playerBoard: {
      generatedAt: "2026-08-23T00:00:00Z",
      scoringModel: "test",
      sources: [],
      replacementRanks: { QB: 12 },
      injuryCoverage: { complete: true },
      injuryFreshnessPolicy: { default: 24, LEAGUE_PLATFORM: 24 },
      players: [
        { yahooId: "99001", position: "WR", yahooPosition: "WR", yahooEligibilityFilters: ["O"], eligible: ["WR"], consensusPoints: 92, executable: false, automaticEligible: false, validationStatus: "DUAL_ROLE_SCORING_UNVERIFIED" },
        { yahooId: "99002", position: "CB", yahooPosition: "CB", yahooEligibilityFilters: ["DB"], eligible: ["CB", "DB"], consensusPoints: 90, executable: true, automaticEligible: false, validationStatus: "DUAL_ROLE_SCORING_UNVERIFIED" },
      ],
    },
    opponentCalibration: { calibration: { enabled: true, excludedManagers: 1, excludedRows: 38 }, room: { opening: { RB: 1 } } },
  });
  assert.equal(report.historicalCoverage.rows, 76);
  assert.equal(report.historicalCoverage.excludedJoeRows, 38);
  assert.equal(report.historicalCoverage.opponentRows, 38);
  assert.equal(report.specialistSurvival.excludedRows, 38);
  assert.equal(report.specialistBacktest.holdoutSeason, "2025");
  assert.deepEqual(report.playerBoard.travisHunter.map((player) => player.yahooId), ["99001", "99002"]);
  assert.ok(report.playerBoard.travisHunter.every((player) => player.automaticEligible === false));
  assert.ok(report.playerBoard.travisHunter.every((player) => player.validationStatus === "DUAL_ROLE_SCORING_UNVERIFIED"));
  assert.deepEqual(report.playerBoard.injuryCoverage, { complete: true });
  assert.deepEqual(report.playerBoard.injuryFreshnessPolicy, { default: 24, LEAGUE_PLATFORM: 24 });
  assert.equal(JSON.stringify(report).includes("opponent"), true, "generic posture labels are allowed");
  assert.equal(JSON.stringify(report).includes('"managerId"'), false);
});
