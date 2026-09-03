import assert from "node:assert/strict";
import test from "node:test";

import { buildProjectionEvaluation, currentSourceAblations, scorePublisherOutcomes, validatePrePeriodSnapshot } from "./projection-evaluation.mjs";

test("rejects publisher snapshots that were not available before the evaluation period", () => {
  assert.throws(() => validatePrePeriodSnapshot({ manifest: { sourceId: "future", sourceAsOf: "2026-09-10T00:00:00Z" } }, "2026-09-09T00:00:00Z"), /not point-in-time evidence/);
  assert.equal(validatePrePeriodSnapshot({ manifest: { sourceId: "valid", sourceAsOf: "2026-09-08T23:59:59Z" } }, "2026-09-09T00:00:00Z"), true);
});

test("current ablation reports sensitivity without mutating source values", () => {
  const players = [
    { yahooId: "1", position: "RB", sourceFamilyPerGamePoints: { yahoo: 10, espn: 20, cbs: 30 } },
    { yahooId: "2", position: "RB", sourceFamilyPerGamePoints: { yahoo: 30, espn: 20, cbs: 10 } },
  ];
  const before = JSON.stringify(players);
  const result = currentSourceAblations(players);
  assert.equal(result.yahoo.comparedPlayers, 2);
  assert.equal(JSON.stringify(players), before);
});

test("keeps publisher accuracy and learned weights disabled without forward evidence", () => {
  const result = buildProjectionEvaluation({
    rankingPack: { players: [{ yahooId: "1", position: "RB", sourceFamilyPerGamePoints: { example: 10 } }], rawSources: [{ manifest: { sourceId: "frozen", sourceFamily: "example", sourceAsOf: "2026-09-02T00:00:00Z" }, rows: [{ playerId: "1" }] }] },
    historicalCalibration: { challengerZero: { status: "HOLDOUT_SCORED" } },
    generatedAt: "2026-09-03T01:00:00Z",
  });
  assert.equal(result.publisherAccuracy.status, "FORWARD_EVIDENCE_PENDING");
  assert.equal(result.learnedWeightGate.enabled, false);
  assert.equal(result.forwardSnapshotReceipt.snapshots[0].rows, 1);
  assert.match(result.forwardSnapshotReceipt.snapshots[0].sha256, /^[a-f0-9]{64}$/);
});

test("scores only genuine pre-period publisher snapshots against later outcomes", () => {
  const snapshots = [
    { manifest: { sourceId: "alpha", sourceAsOf: "2026-09-08T00:00:00Z" }, rows: [{ playerId: "1", position: "RB", perGamePoints: 10 }, { playerId: "2", position: "RB", perGamePoints: 20 }] },
    { manifest: { sourceId: "beta", sourceAsOf: "2026-09-08T00:00:00Z" }, rows: [{ playerId: "1", position: "RB", perGamePoints: 12 }, { playerId: "2", position: "RB", perGamePoints: 18 }] },
  ];
  const outcomes = [{ playerId: "1", position: "RB", week: 1, points: 11 }, { playerId: "2", position: "RB", week: 1, points: 17 }];
  const result = scorePublisherOutcomes({ snapshots, outcomes, periodStart: "2026-09-09T00:00:00Z" });
  assert.equal(result.bySource.alpha.byPosition.RB.weeklyMae, 2);
  assert.equal(result.bySource.beta.byPosition.RB.weeklyMae, 1);
  assert.equal(result.pairwiseSourceErrorCorrelation["alpha|beta"].commonPlayerWeeks, 2);
});
