import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWeeklyProjectionProfile,
  expectedGamesFromInjury,
  scoreWeeklyLeaguePoints,
  buildWeeklyPlayerProjection,
  buildWeeklyProjectionReport,
  deriveOpportunityRates,
  opportunityExpectedPoints,
  assignFullRanks,
} from "./weekly-roster-utility.mjs";

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

test("scores a Week 1 stat line under the exact league rules", () => {
  // 10 carries / 100 rush yd / 1 rush TD (+100yd bonus) + 2 rec / 24 rec yd.
  const monangai = scoreWeeklyLeaguePoints({
    rushingYards: 100,
    rushingTouchdowns: 1,
    rushingHundredYardGames: 1,
    receptions: 2,
    receivingYards: 24,
  });
  assert.ok(Math.abs(monangai - 20.9) < 1e-9);
  const idp = scoreWeeklyLeaguePoints({ soloTackles: 6, assistedTackles: 2, sacks: 1 }, "idp");
  assert.ok(Math.abs(idp - (6 * 0.5 + 2 * 0.25 + 1 * 2)) < 1e-9);
  assert.throws(() => scoreWeeklyLeaguePoints({}, "teamdefense"), /unsupported scoringKind/);
});

test("blends prior and Week 1 with documented shrinkage and never substitutes Yahoo", () => {
  const projection = buildWeeklyPlayerProjection({
    playerId: "42025",
    name: "Kyle Monangai",
    position: "RB",
    priorPerGame: 10,
    week1StatLine: { rushingYards: 100, rushingTouchdowns: 1, rushingHundredYardGames: 1 },
    week1Weight: 0.25,
    yahooWeek2Projection: 7.59,
  });
  // week1 = 100*0.1 + 6 + 2 = 18; baseline = 0.25*18 + 0.75*10 = 12.
  assert.equal(projection.week1Points, 18);
  assert.equal(projection.weeklyBaseline, 12);
  assert.equal(projection.weeklyExpectation, 12);
  assert.equal(projection.confidence, "PRIOR_AND_WEEK1");
  assert.equal(projection.priorShrinkageApplied, true);
  // Yahoo is comparison only: the custom number is not overwritten by it.
  assert.notEqual(projection.weeklyExpectation, projection.yahooWeek2Projection);
  assert.ok(Math.abs(projection.deltaVsYahoo - (12 - 7.59)) < 1e-9);
});

test("prior-only players expose NO weekly projection; prior kept separate", () => {
  const projection = buildWeeklyPlayerProjection({ name: "No Week 1", priorPerGame: 8 });
  assert.equal(projection.confidence, "PRIOR_ONLY");
  assert.equal(projection.weeklyBaseline, 8);
  // A prior-only row (e.g. a team defense) must not present a weekly number.
  assert.equal(projection.weeklyProjectionAvailable, false);
  assert.equal(projection.weeklyExpectation, null);
  assert.equal(projection.deltaVsYahoo, null);
  assert.equal(projection.priorPerGame, 8);
  assert.deepEqual(projection.missingInputs, ["week1_actuals"]);
  assert.ok(projection.notes.some((note) => note.includes("NOT a Week-2 projection")));
});

test("reports insufficient and week1-only evidence explicitly", () => {
  const nothing = buildWeeklyPlayerProjection({ name: "Empty" });
  assert.equal(nothing.confidence, "INSUFFICIENT");
  assert.equal(nothing.weeklyExpectation, null);
  assert.deepEqual(nothing.missingInputs, ["prior_per_game", "week1_actuals"]);
  const week1Only = buildWeeklyPlayerProjection({ name: "Rookie", week1Points: 15 });
  assert.equal(week1Only.confidence, "WEEK1_ONLY");
  assert.equal(week1Only.weeklyBaseline, 15);
  assert.deepEqual(week1Only.missingInputs, ["prior_per_game"]);
});

test("QUESTIONABLE is flagged but NEVER given a generic availability haircut", () => {
  const questionable = buildWeeklyPlayerProjection({
    priorPerGame: 10,
    week1Points: 10,
    availabilityStatus: "QUESTIONABLE",
  });
  // No generic status haircut: the prior already assumes availability, and there is no
  // player-specific evidence to justify a second discount.
  assert.equal(questionable.availabilityProbability, 1);
  assert.equal(questionable.availabilityBasis, "UNCERTAIN_FLAGGED_NO_DISCOUNT");
  assert.equal(questionable.weeklyBaseline, 10);
  assert.equal(questionable.weeklyExpectation, 10);
  assert.ok(questionable.notes.some((note) => note.includes("NO generic haircut")));
  assert.equal(questionable.matchupFactor, 1);
  assert.equal(questionable.matchupStatus, "OPPONENT_KNOWN_STRENGTH_UNSOURCED");
  assert.throws(() => buildWeeklyPlayerProjection({ priorPerGame: 5, availabilityStatus: "NOPE" }), /unknown availabilityStatus/);
  assert.throws(() => buildWeeklyPlayerProjection({ priorPerGame: 5, week1Weight: 2 }), /week1Weight/);
});

test("availability discounts ONLY on player-specific probability; confirmed-inactive is a factual zero", () => {
  const explicit = buildWeeklyPlayerProjection({
    priorPerGame: 10,
    week1Points: 10,
    availabilityProbability: 0.5,
    availabilityStatus: "QUESTIONABLE",
  });
  assert.equal(explicit.availabilityProbability, 0.5);
  assert.equal(explicit.availabilityBasis, "PLAYER_SPECIFIC_PROBABILITY");
  assert.ok(Math.abs(explicit.weeklyExpectation - 5) < 1e-9);
  const out = buildWeeklyPlayerProjection({ priorPerGame: 10, week1Points: 10, availabilityStatus: "OUT" });
  assert.equal(out.availabilityProbability, 0);
  assert.equal(out.availabilityBasis, "CONFIRMED_INACTIVE");
  assert.equal(out.weeklyExpectation, 0);
});

test("opportunity drives the Week-1 signal; carries/targets change the forecast", () => {
  // Volume valued at league-average points/opportunity: 1 pt/carry, 1.5 pt/target.
  const rates = deriveOpportunityRates([
    { position: "RB", carries: 50, targets: 40, passingPoints: 0, rushingPoints: 50, receivingPoints: 60 },
  ]);
  assert.ok(Math.abs(rates.ratesByPosition.RB.rush - 1) < 1e-9);
  assert.ok(Math.abs(rates.ratesByPosition.RB.rec - 1.5) < 1e-9);
  const light = opportunityExpectedPoints({ position: "RB", carries: 10, targets: 2 }, rates);
  const heavy = opportunityExpectedPoints({ position: "RB", carries: 40, targets: 20 }, rates);
  assert.ok(Math.abs(light - (10 * 1 + 2 * 1.5)) < 1e-9); // 13
  assert.ok(Math.abs(heavy - (40 * 1 + 20 * 1.5)) < 1e-9); // 70
  assert.ok(heavy > light);
  // Same observed points and prior, but more opportunity => higher projection.
  const base = { priorPerGame: 8, week1Points: 12, week1Weight: 0.25, opportunityShare: 0.6 };
  const lowOpp = buildWeeklyPlayerProjection({ ...base, position: "RB", week1OpportunityPoints: light });
  const highOpp = buildWeeklyPlayerProjection({ ...base, position: "RB", week1OpportunityPoints: heavy });
  assert.equal(lowOpp.week1SignalBasis, "OPPORTUNITY_AND_EFFICIENCY");
  // signal = 0.6*opp + 0.4*observed; baseline = 0.25*signal + 0.75*prior.
  assert.ok(Math.abs(lowOpp.week1Signal - (0.6 * light + 0.4 * 12)) < 1e-9);
  assert.ok(Math.abs(lowOpp.weeklyBaseline - (0.25 * lowOpp.week1Signal + 0.75 * 8)) < 1e-9);
  assert.ok(highOpp.weeklyExpectation > lowOpp.weeklyExpectation);
});

test("deriveOpportunityRates falls back to the all-position rate below the minimum sample", () => {
  const rates = deriveOpportunityRates([
    { position: "WR", targets: 100, receivingPoints: 200 }, // WR rec rate 2.0, trusted
    { position: "TE", targets: 5, receivingPoints: 5 }, // TE rec sample 5 < 40 => fallback
  ]);
  assert.equal(rates.ratesByPosition.WR.rec, 2);
  assert.equal(rates.sampleByPosition.TE.rec.trusted, false);
  // overall rec rate = (200+5)/(100+5) = 1.952...; TE falls back to it.
  assert.ok(Math.abs(rates.ratesByPosition.TE.rec - 205 / 105) < 1e-9);
});

test("scores a Week 1 team-defense line under the exact league DST rules", () => {
  // Patriots Week 1: 2 sacks, 13 points allowed (7-13 band). League: sack 1, band 7-13 = 4.
  const patriots = scoreWeeklyLeaguePoints(
    { sacks: 2, pointsAllowed7To13: 1 },
    "teamdef",
  );
  assert.ok(Math.abs(patriots - (2 * 1 + 4)) < 1e-9);
  // A takeaway-heavy shutout: 3 sacks, 2 INT, 1 fumble recovery, 1 def TD, 0 allowed (band 0 = 10).
  const dominant = scoreWeeklyLeaguePoints(
    { sacks: 3, interceptions: 2, fumbleRecoveries: 1, defensiveTouchdowns: 1, pointsAllowed0: 1 },
    "teamdef",
  );
  assert.ok(Math.abs(dominant - (3 * 1 + 2 * 1 + 1 * 2 + 1 * 6 + 10)) < 1e-9); // 23
});

test("team defense regresses its one-game DST signal toward the league Week-1 mean, not Yahoo", () => {
  // No opportunity model for DST: the Week-1 signal is the observed league-scored result. The prior
  // is the Week-1 league DST mean (shrinkage target), never the excluded Yahoo season number.
  const leagueMean = 5.44;
  const projection = buildWeeklyPlayerProjection({
    name: "Patriots",
    position: "DEF",
    priorPerGame: leagueMean,
    week1StatLine: { sacks: 2, pointsAllowed7To13: 1 },
    scoringKind: "teamdef",
    week1Weight: 0.25,
    yahooWeek2Projection: 6.5,
  });
  assert.equal(projection.week1Points, 6); // exact league DST score
  assert.equal(projection.week1SignalBasis, "OBSERVED_ONLY_NO_OPPORTUNITY_MODEL");
  assert.equal(projection.confidence, "PRIOR_AND_WEEK1");
  assert.equal(projection.weeklyProjectionAvailable, true);
  assert.ok(Math.abs(projection.weeklyBaseline - (0.25 * 6 + 0.75 * leagueMean)) < 1e-9);
  assert.equal(projection.matchupFactor, 1); // no matchup factor
  assert.notEqual(projection.weeklyExpectation, projection.yahooWeek2Projection);
});

test("assigns overall and position ranks and flags every unrankable row with a reason", () => {
  const rows = [
    { playerId: "1", name: "QB1", position: "QB", weeklyProjectionAvailable: true, weeklyExpectation: 25, availabilityProbability: 1, priorPerGame: 24, confidence: "PRIOR_AND_WEEK1" },
    { playerId: "2", name: "RB1", position: "RB", weeklyProjectionAvailable: true, weeklyExpectation: 18, availabilityProbability: 1, priorPerGame: 16, confidence: "PRIOR_AND_WEEK1" },
    { playerId: "3", name: "RB2", position: "RB", weeklyProjectionAvailable: true, weeklyExpectation: 20, availabilityProbability: 1, priorPerGame: 15, confidence: "WEEK1_ONLY" },
    { playerId: "4", name: "OutWR", position: "WR", weeklyProjectionAvailable: true, weeklyExpectation: 0, availabilityProbability: 0, availabilityStatus: "OUT", confidence: "PRIOR_AND_WEEK1" },
    { playerId: "5", name: "NoActual", position: "TE", weeklyProjectionAvailable: false, weeklyExpectation: null, availabilityProbability: 1, confidence: "PRIOR_ONLY", priorPerGame: 9 },
    { playerId: "6", name: "Empty", position: "WR", weeklyProjectionAvailable: false, weeklyExpectation: null, availabilityProbability: 1, confidence: "INSUFFICIENT" },
  ];
  const ranked = assignFullRanks(rows);
  const byId = Object.fromEntries(ranked.map((r) => [r.playerId, r]));
  assert.equal(ranked.length, 6); // nothing dropped
  assert.equal(byId["1"].overallRank, 1);
  assert.equal(byId["3"].overallRank, 2);
  assert.equal(byId["2"].overallRank, 3);
  assert.equal(byId["1"].positionRank, 1);
  assert.equal(byId["3"].positionRank, 1); // RB2 (20) outranks RB1 (18) within RB
  assert.equal(byId["2"].positionRank, 2);
  assert.equal(byId["4"].rankable, false);
  assert.equal(byId["4"].overallRank, null);
  assert.ok(byId["4"].unrankableReason.includes("OUT"));
  assert.equal(byId["5"].unrankableReason, "NO_COMPLETED_WEEK_ACTUAL");
  assert.equal(byId["6"].unrankableReason, "NO_PRIOR_OR_COMPLETED_WEEK_ACTUAL");
  // Input rows are untouched (pure).
  assert.equal(rows[0].overallRank, undefined);
});

test("assembles a report with coverage counts and preserved provenance", () => {
  const report = buildWeeklyProjectionReport({
    generatedAt: "2026-09-15T18:00:00Z",
    targetWeek: 2,
    provenance: { prior: "v15-board", week1: "sleeper" },
    players: [
      { name: "A", priorPerGame: 10, week1Points: 20 },
      { name: "B", priorPerGame: 8 },
      { name: "C" },
    ],
  });
  assert.equal(report.coverage.PRIOR_AND_WEEK1, 1);
  assert.equal(report.coverage.PRIOR_ONLY, 1);
  assert.equal(report.coverage.INSUFFICIENT, 1);
  assert.equal(report.provenance.week1, "sleeper");
  assert.equal(report.targetWeek, 2);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.modelChoices.week1Weight, 0.25);
  assert.equal(report.modelChoices.opportunityShare, 0.6);
  assert.ok(report.modelChoices.opportunityRationale.includes("opportunity"));
  assert.ok(report.modelChoices.availability.includes("no generic status haircut"));
  // Prior-only player "B" exposes no weekly projection; player "A" does.
  const rowB = report.players.find((row) => row.name === "B");
  assert.equal(rowB.weeklyProjectionAvailable, false);
  assert.equal(rowB.weeklyExpectation, null);
  const rowA = report.players.find((row) => row.name === "A");
  assert.equal(rowA.weeklyProjectionAvailable, true);
});
