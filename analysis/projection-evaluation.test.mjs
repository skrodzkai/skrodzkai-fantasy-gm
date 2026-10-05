import assert from "node:assert/strict";
import test from "node:test";
import { evaluateWeeklyForecasts } from "./projection-evaluation.mjs";

test("weekly evaluation is point-in-time, identity-bound and report-only with a naive baseline", () => {
  const hash = "a".repeat(64);
  const receipt = (sourceId, week, retrievedAt) => ({ sourceId, season: 2026, week, retrievedAt, contentSha256: hash });
  const forecast = { season: 2026, targetWeek: 2, completedThroughWeek: 1, generatedAt: "2026-09-16T00:00:00Z",
    provenance: { week1List: [receipt("sleeper", 1, "2026-09-15T00:00:00Z")], schedule: receipt("espn-schedule", 2, "2026-09-15T00:00:00Z") },
    players: [1, 2, 3].map((id) => ({ playerId: String(id), sleeperId: String(id), position: "RB", rankable: true,
      kickoff: "2026-09-20T17:00:00Z", weeklyExpectation: id * 5, naiveBaseline: id * 4,
      yahooWeek2Projection: 999 })) };
  const actual = { season: 2026, week: 2, completed: true, completedVerifiedAt: "2026-09-21T00:00:00Z", retrievedAt: "2026-09-21T01:00:00Z",
    scoringSource: "analysis/player-intelligence.mjs", receipts: { actuals: receipt("sleeper", 2, "2026-09-21T01:00:00Z"),
      completedSchedule: receipt("espn-schedule", 2, "2026-09-21T00:00:00Z") }, players: [1, 2, 3].map((id) => ({ playerId: String(id), sleeperId: String(id),
      position: "RB", kickoff: "2026-09-20T17:00:00Z", actualPoints: id * 6 })) };
  const result = evaluateWeeklyForecasts([forecast], [actual]);
  assert.equal(result.status, "EVALUATED_REPORT_ONLY");
  assert.equal(result.byPosition.RB.forecast.mae, 2);
  assert.equal(result.byPosition.RB.naiveCompletedGameMean.mae, 4);
  assert.equal(result.byPosition.RB.forecast.spearman, 1);
  assert.equal(result.byPosition.RB.yahooTimestampedComparison.sample, 0);
  assert.equal(result.tuning, "DISABLED");
  assert.equal(evaluateWeeklyForecasts([], [actual]).status, "NOT_EVALUATED");
  assert.equal(evaluateWeeklyForecasts([{ ...forecast, generatedAt: "2026-09-20T18:00:00Z" }], [actual]).status, "NOT_EVALUATED");
  assert.equal(evaluateWeeklyForecasts([{ ...forecast, completedThroughWeek: 2 }], [actual]).status, "NOT_EVALUATED");
  const changed = structuredClone(actual); changed.players[0].sleeperId = "different";
  assert.equal(evaluateWeeklyForecasts([forecast], [changed]).evaluated.length, 2);
  const incomplete = structuredClone(actual); delete incomplete.receipts;
  assert.equal(evaluateWeeklyForecasts([forecast], [incomplete]).status, "NOT_EVALUATED");
  const partial = structuredClone(actual); partial.retrievedAt = "2026-09-20T18:00:00Z";
  partial.receipts.actuals.retrievedAt = partial.retrievedAt;
  assert.equal(evaluateWeeklyForecasts([forecast], [partial]).status, "NOT_EVALUATED");
  const unequalForecast = structuredClone(forecast);
  unequalForecast.players[2].naiveBaseline = null;
  unequalForecast.players[0].yahooComparisonCapturedAt = "2026-09-15T12:00:00Z";
  unequalForecast.players[0].yahooWeek2Projection = 6;
  const unequal = evaluateWeeklyForecasts([unequalForecast], [actual]).byPosition.RB;
  assert.equal(unequal.forecast.mae, 2);
  assert.equal(unequal.pairedComparisons.naiveCompletedGameMean.sample, 2);
  assert.equal(unequal.pairedComparisons.naiveCompletedGameMean.forecast.mae, 1.5);
  assert.equal(unequal.pairedComparisons.naiveCompletedGameMean.comparator.mae, 3);
  assert.equal(unequal.pairedComparisons.yahooTimestampedComparison.sample, 1);
  assert.equal(unequal.pairedComparisons.yahooTimestampedComparison.forecast.mae, 1);
  assert.equal(unequal.pairedComparisons.yahooTimestampedComparison.comparator.mae, 0);
  const unresolved = structuredClone(actual);
  unresolved.players.shift();
  unresolved.unresolvedPlayers = [{ playerId: "1", sleeperId: "1", position: "RB", reason: "NO_PARTICIPATION_ROW_UNRESOLVED" }];
  const absent = evaluateWeeklyForecasts([forecast], [unresolved]);
  assert.equal(absent.evaluated.length, 2);
  assert.equal(absent.exclusionsByPosition.RB.NO_PARTICIPATION_ROW_UNRESOLVED, 1);
  assert.equal(absent.excluded[0].position, "RB");
  assert.equal(absent.byPosition.RB.forecast.mae, 2.5);
});

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
