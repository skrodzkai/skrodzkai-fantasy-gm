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
      players: [{ yahooId: "41787", position: "DB", yahooPosition: "WR", yahooEligibilityFilters: ["DB", "O"], eligible: ["WR", "CB", "DB"], consensusPoints: 92, executable: true }],
    },
    opponentCalibration: { calibration: { enabled: true, excludedManagers: 1, excludedRows: 38 }, room: { opening: { RB: 1 } } },
  });
  assert.equal(report.historicalCoverage.rows, 76);
  assert.equal(report.historicalCoverage.excludedJoeRows, 38);
  assert.equal(report.historicalCoverage.opponentRows, 38);
  assert.equal(report.specialistSurvival.excludedRows, 38);
  assert.equal(report.specialistBacktest.holdoutSeason, "2025");
  assert.equal(report.playerBoard.travisHunter.draftPosition, "DB");
  assert.equal(JSON.stringify(report).includes("opponent"), true, "generic posture labels are allowed");
  assert.equal(JSON.stringify(report).includes('"managerId"'), false);
});
