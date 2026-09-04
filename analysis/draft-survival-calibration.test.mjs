import assert from "node:assert/strict";
import test from "node:test";

import {
  calibratedSurvivalProbability,
  evaluateSurvivalCalibration,
  parseMarketHistory,
  trainSurvivalModel,
} from "./draft-survival-calibration.mjs";

test("parses only point-in-time rows with usable market ADP", () => {
  const rows = parseMarketHistory("season,owner_id,position,overall_pick,market_adp,yahoo_rank\n2025,a,QB,10,15.5,12\n2025,b,RB,20,,18\n");
  assert.deepEqual(rows, [{ season: 2025, managerId: "a", position: "QB", pick: 10, marketAdp: 15.5, yahooRank: 12, staticBpaRank: null }]);
});

test("empirical survival falls as the next pick moves later", () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({
    season: 2024,
    managerId: `m${index % 6}`,
    position: "QB",
    marketAdp: 50,
    pick: 35 + index,
  }));
  const model = trainSurvivalModel(rows, { minimumPositionSamples: 10 });
  const early = calibratedSurvivalProbability(model, { position: "QB", marketMean: 50, nextPick: 40 });
  const late = calibratedSurvivalProbability(model, { position: "QB", marketMean: 50, nextPick: 70 });
  assert.ok(early > late);
  const run = calibratedSurvivalProbability(model, { position: "QB", marketMean: 50, nextPick: 55, runPressure: 2 });
  const calm = calibratedSurvivalProbability(model, { position: "QB", marketMean: 50, nextPick: 55 });
  assert.ok(run < calm);
});

test("held-out gate reports missing Yahoo and static BPA evidence instead of inventing it", () => {
  const rows = [];
  for (let season = 2021; season <= 2025; season += 1) {
    for (let index = 0; index < 40; index += 1) {
      const position = index % 2 ? "QB" : "RB";
      const marketAdp = index + 20;
      const residual = position === "QB" ? -8 : 8;
      rows.push({ season, managerId: `m${index % 8}`, position, marketAdp, pick: marketAdp + residual });
    }
  }
  const result = evaluateSurvivalCalibration(rows, { holdoutSeason: 2025, minimumPositionSamples: 20, bootstrapSamples: 200 });
  assert.equal(result.calibration.events, 120);
  assert.equal(result.calibration.comparisonCoverage.publicMarketAdpInput, true);
  assert.equal(result.calibration.comparisonCoverage.roomResidualBaseline, true);
  assert.equal(result.calibration.comparisonCoverage.publicAdpSurvivalBenchmark, false);
  assert.equal(result.calibration.comparisonCoverage.yahooPreDraftRank, false);
  assert.equal(result.calibration.comparisonCoverage.staticBpa, false);
  assert.equal(result.calibration.enabled, false);
  assert.match(result.calibration.reason, /disabled_without_positive_public_adp_benchmark/);
  assert.match(result.calibration.comparisonCoverage.unavailableReason, /not captured/);
});
