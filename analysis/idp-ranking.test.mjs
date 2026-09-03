import test from "node:test";
import assert from "node:assert/strict";

import { IDP_SCORING, scoreIdpStatLine } from "./player-intelligence.mjs";
import {
  IDP_POINT_BUCKET_FIELDS,
  buildIdpSourceProfile,
  combineIdpSourceProfiles,
  idpDecisionScore,
  scoreIdpBuckets,
  validateIdpBucketCoverage,
} from "./idp-ranking.mjs";

const stats = {
  soloTackles: 100, assistedTackles: 40, sacks: 5, interceptions: 2,
  forcedFumbles: 2, fumbleRecoveries: 1, touchdowns: 1, safeties: 0,
  passesDefended: 8, blockedKicks: 0, tacklesForLoss: 10,
  turnoverReturnYards: 20, extraPointReturns: 0, snaps: 900,
};

test("assigns every exact league IDP scoring field to exactly one bucket", () => {
  assert.equal(validateIdpBucketCoverage(IDP_SCORING), true);
  assert.deepEqual(Object.values(IDP_POINT_BUCKET_FIELDS).flat().sort(), Object.keys(IDP_SCORING).sort());
  assert.throws(() => validateIdpBucketCoverage({ ...IDP_SCORING, inventedCategory: 1 }), /coverage mismatch/);
});

test("per-row bucket points exactly sum to the league scorer", () => {
  const buckets = scoreIdpBuckets(stats, IDP_SCORING);
  assert.equal(Object.values(buckets).reduce((sum, value) => sum + value, 0), scoreIdpStatLine(stats));
});

test("combines complete raw-family component shares without replacing consensus", () => {
  const first = buildIdpSourceProfile({ stats, scoring: IDP_SCORING, sourceId: "a", projectionGames: 17 });
  const second = buildIdpSourceProfile({ stats: { ...stats, interceptions: 0 }, scoring: IDP_SCORING, sourceId: "b", projectionGames: 16 });
  const combined = combineIdpSourceProfiles([first, second]);
  assert.equal(combined.status, "AVAILABLE");
  assert.equal(combined.rawFamilyCount, 2);
  assert.equal(combined.projectionGames, 16.5);
  assert.ok(Math.abs(Object.values(combined.bucketShares).reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
});

test("decision formula is consensus times component and prior-role scales", () => {
  const profile = combineIdpSourceProfiles([
    buildIdpSourceProfile({ stats, scoring: IDP_SCORING, sourceId: "a", projectionGames: 17 }),
  ]);
  const decision = idpDecisionScore({
    consensusPoints: 100,
    profile,
    position: "LB",
    calibration: {
      globalGate: { pass: true },
      positionParameters: { LB: { volatileWeight: 0.5, roleExponent: 0, trainingSnapMean: 50 } },
    },
  });
  const expectedScale = profile.bucketShares.tackleFloor + profile.bucketShares.stableDisruption + 0.5 * profile.bucketShares.volatileSplash;
  assert.equal(decision.status, "ACTIVE");
  assert.ok(Math.abs(decision.points - 100 * expectedScale) < 1e-12);
});

test("generic D eligibility cannot select a physical-position coefficient", () => {
  const profile = combineIdpSourceProfiles([
    buildIdpSourceProfile({ stats, scoring: IDP_SCORING, sourceId: "a", projectionGames: 17 }),
  ]);
  const decision = idpDecisionScore({
    consensusPoints: 100,
    profile,
    position: "D",
    calibration: { globalGate: { pass: true }, positionParameters: { DL: { volatileWeight: 0.1, roleExponent: 1, trainingSnapMean: 50 } } },
  });
  assert.equal(decision.status, "NOT_IDP");
  assert.equal(decision.points, 100);
});

test("failed global gate and incomplete raw profiles preserve consensus", () => {
  const failed = idpDecisionScore({ consensusPoints: 100, profile: null, position: "LB", calibration: { globalGate: { pass: false } } });
  assert.equal(failed.points, 100);
  assert.equal(failed.scale, 1);
  const incomplete = idpDecisionScore({
    consensusPoints: 100,
    profile: { status: "INCOMPLETE_RAW_STAT_PROFILE" },
    position: "LB",
    calibration: { globalGate: { pass: true }, positionParameters: { LB: { volatileWeight: 0.5, roleExponent: 0, trainingSnapMean: 50 } } },
  });
  assert.equal(incomplete.points, 100);
  assert.match(incomplete.warning, /NO_COMPLETE/);
});
