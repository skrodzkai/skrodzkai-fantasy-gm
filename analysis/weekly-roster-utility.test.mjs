import assert from "node:assert/strict";
import test from "node:test";

import { buildWeeklyProjectionProfile, expectedGamesFromInjury } from "./weekly-roster-utility.mjs";

test("creates a 17-week profile with the bye removed", () => {
  const profile = buildWeeklyProjectionProfile({
    perGamePoints: 20,
    byeWeek: 8,
    expectedGamesThroughWeek17: 16,
  });
  assert.equal(profile.weeklyPoints.length, 17);
  assert.equal(profile.weeklyPoints[7], 0);
  assert.equal(profile.weeklyPoints.reduce((sum, value) => sum + value, 0), 320);
  assert.equal(profile.expectedGamesThroughWeek17, 16);
});

test("separates explicit missed weeks from remaining availability", () => {
  const profile = buildWeeklyProjectionProfile({
    perGamePoints: 10,
    byeWeek: 6,
    expectedGamesThroughWeek17: 12,
    unavailableWeeks: [1, 2],
    weeklyAvailability: { 3: 0.5 },
  });
  assert.equal(profile.availabilityProbability[0], 0);
  assert.equal(profile.availabilityProbability[1], 0);
  assert.equal(profile.availabilityProbability[2], 0.5);
  assert.ok(Math.abs(profile.expectedGamesThroughWeek17 - 12) < 1e-9);
});

test("never mistakes source disagreement for an outcome interval", () => {
  const unavailable = buildWeeklyProjectionProfile({ perGamePoints: 12, byeWeek: 5 });
  assert.equal(unavailable.weeklyOutcomeLow, null);
  assert.equal(unavailable.uncertaintyStatus, "WEEKLY_OUTCOME_INTERVAL_UNAVAILABLE");
  const calibrated = buildWeeklyProjectionProfile({
    perGamePoints: 12,
    byeWeek: 5,
    perGameOutcomeLow: 7,
    perGameOutcomeHigh: 19,
  });
  assert.equal(calibrated.weeklyOutcomeLow[0], 7);
  assert.equal(calibrated.weeklyOutcomeHigh[0], 19);
});

test("uses only explicit health evidence for expected games", () => {
  assert.equal(expectedGamesFromInjury({ draftAction: "CLEAR" }), 16);
  assert.equal(expectedGamesFromInjury({ draftAction: "EXCLUDE" }), 0);
  assert.equal(expectedGamesFromInjury({ draftAction: "REVIEW" }), null);
  assert.equal(expectedGamesFromInjury({ draftAction: "REVIEW", expectedGamesThroughWeek17: 11 }), 11);
});
