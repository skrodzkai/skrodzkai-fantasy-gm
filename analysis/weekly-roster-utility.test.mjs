import assert from "node:assert/strict";
import test from "node:test";
import { compareMultiweekRoster, strongestLegalLineup } from "./multiweek-roster-planning.mjs";

function planningFixture() {
  const now = Date.parse("2026-10-02T09:00:00Z"), generatedAt = "2026-10-02T07:00:00Z";
  const players = [
    { playerId: "1", sleeperId: "s1", position: "RB", name: "Back", values: [10, 10, 10] },
    { playerId: "2", sleeperId: "s2", position: "K", name: "Kicker", values: [8, 8, 8] },
    { playerId: "3", sleeperId: "NE", position: "DEF", name: "Defense", values: [-2, 10, -2] },
    { playerId: "4", sleeperId: "s4", position: "QB", name: "Reserve quarterback", values: [20, 20, 20] },
    { playerId: "5", sleeperId: "BUF", position: "DEF", name: "Streaming defense", values: [8, -4, 8] },
    { playerId: "6", sleeperId: "s6", position: "RB", name: "New back", values: [9, 15, 15] },
  ];
  const report = { season: 2026, targetWeek: 4, generatedAt, weeks: [4, 5, 6].map((targetWeek, i) => ({ season: 2026, targetWeek,
    completedThroughWeek: 3, generatedAt, provenance: { schedule: { season: 2026, week: targetWeek } }, players: players.map((row) => ({ ...row,
      rankable: true, weeklyExpectation: row.values[i], scheduleStatus: "VERIFIED_GAME", kickoff: `2026-10-${10 + i}T17:00:00Z` })) })) };
  const snapshot = { source: "YAHOO_VERIFIED_READBACK", fullRosterVerified: true, availableVerified: true, season: 2026, week: 4,
    leagueId: "420010", teamId: "7", capturedAt: "2026-10-02T08:00:00Z", expiresAt: "2026-10-02T10:00:00Z",
    slots: [{ id: "RB1", eligible: ["RB"] }, { id: "K", eligible: ["K"] }, { id: "DEF", eligible: ["DEF"] }],
    roster: ["1", "2", "3", "4"].map((yahooId, i) => ({ yahooId, eligible: [players[i].position], ownership: "OWNED", locked: false,
      droppable: true, injuryStatus: null, slot: ["RB1", "K", "DEF", "BN"][i] })),
    available: ["5", "6"].map((yahooId, i) => ({ yahooId, eligible: [players[4 + i].position], ownership: "UNOWNED", locked: false,
      injuryStatus: null, availability: "FA" })) };
  return { report, snapshot, now };
}

test("full roster planner prices cross-position bench drops, defense stashes, and weekly tradeoffs", () => {
  const f = planningFixture(), result = compareMultiweekRoster(f.report, f.snapshot, f.now);
  assert.equal(result.disposition, "PROPOSE_FOR_EXACT_APPROVAL");
  const proposals = result.proposals.map((index) => result.alternatives[index]);
  const stash = proposals.find((p) => p.addYahooId === "5" && p.dropYahooId === "4");
  assert.deepEqual(stash.weeklyGains.map((row) => row.starterPointGain), [10, 0, 10]);
  assert.equal(stash.summedStarterPointGain, 20);
  assert.deepEqual(stash.defensePairYahooIds, ["3", "5"]);
  assert.ok(proposals.every((p) => p.approvalRequired && !p.executableNow));
  assert.ok(result.defenseAlternatives.every((index) => result.alternatives[index].addPosition === "DEF"));
  assert.ok(result.alternatives.every((p) => !Object.hasOwn(p, "before")));
  for (const [i, after] of stash.after.entries()) {
    const baseline = result.baseline[i];
    const reconstructed = baseline.selected.map((pick) => after.changes.find((change) => change.slot === pick.slot) ?? pick);
    assert.equal(reconstructed.reduce((sum, pick) => sum + pick.points, 0), after.points);
    assert.equal(new Set(reconstructed.map((pick) => pick.yahooId)).size, reconstructed.length);
    assert.ok(after.changes.length <= 1);
  }
  const tradeoff = proposals.find((p) => p.addYahooId === "6" && p.dropYahooId === "1");
  assert.deepEqual(tradeoff.weeklyGains.map((row) => row.starterPointGain), [-1, 5, 5]);
  assert.equal(tradeoff.tradeoff, "HORIZON_GAIN_WITH_WEEKLY_STARTER_LOSS_REQUIRES_REVIEW");
  assert.match(result.benchAudit[0].unmodeledValue, /NOT_WORTHLESS/);
  assert.deepEqual(result.benchAudit[0].weeklyStarterContribution.map((r) => r.points), [0, 0, 0]);
  assert.equal(result.baseline[0].selected.find((pick) => pick.yahooId === "3").points, -2);
});

test("planner pins current exact locks, frees future locks and excludes locked bench/IR", () => {
  const rows = [{ yahooId: "1", eligible: ["RB", "WR"], slot: "RB1", locked: true, points: { 4: 10, 5: 10 } },
    { yahooId: "2", eligible: ["RB"], slot: "BN", locked: false, points: { 4: 20, 5: 20 } },
    { yahooId: "3", eligible: ["WR"], slot: "WR1", locked: false, points: { 4: 5, 5: 5 } },
    { yahooId: "4", eligible: ["RB", "WR"], slot: "BN", locked: true, points: { 4: 100, 5: 100 } },
    { yahooId: "5", eligible: ["RB", "WR"], slot: "IR", locked: false, points: { 4: 200, 5: 200 } }];
  const slots = [{ id: "RB1", eligible: ["RB"] }, { id: "WR1", eligible: ["WR"] }];
  const current = strongestLegalLineup(rows, slots, 4, 4), future = strongestLegalLineup(rows, slots, 5, 4);
  assert.equal(current.points, 15);
  assert.equal(current.selected.find((p) => p.yahooId === "1").slot, "RB1");
  assert.equal(future.points, 120);
  assert.ok(!future.selected.some((p) => p.yahooId === "5"));
});

test("planner holds stale/unknown facts, exact identity aliases, expired W and missing current forecasts", () => {
  for (const mutate of [
    (f) => { f.snapshot.expiresAt = "2026-10-02T08:30:00Z"; },
    (f) => { delete f.snapshot.roster[0].ownership; },
    (f) => { f.snapshot.available[0].injuryStatus = "UNKNOWN"; },
    (f) => { f.snapshot.available[0].availability = "W"; f.snapshot.available[0].conditionalExpiresAt = "2026-10-02T08:30:00Z"; },
    (f) => { f.report.weeks.forEach((week) => { week.players[4].sleeperId = "s1"; }); },
    (f) => { delete f.report.weeks[0].players[0].scheduleStatus; },
    (f) => { delete f.report.generatedAt; },
    (f) => { f.report.weeks.pop(); },
  ]) {
    const f = planningFixture(); mutate(f);
    assert.equal(compareMultiweekRoster(f.report, f.snapshot, f.now).disposition, "HOLD");
  }
  const f = planningFixture();
  f.snapshot.available.push({ ...f.snapshot.available[0], yahooId: "999" });
  const result = compareMultiweekRoster(f.report, f.snapshot, f.now);
  assert.equal(result.disposition, "PROPOSE_FOR_EXACT_APPROVAL");
  assert.equal(result.excludedCandidates.find((row) => row.yahooId === "999").reason, "UNJOINED_EXACT_YAHOO_IDENTITY");
});

test("temporary coverage expiry creates review and W remains conditional", () => {
  const f = planningFixture();
  f.snapshot.available[0].availability = "W";
  f.snapshot.available[0].conditionalExpiresAt = "2026-10-03T10:00:00Z";
  f.snapshot.coverageRecords = [{ temporaryYahooId: "4", coveredYahooIds: ["1"], reviewAt: "2026-10-02T08:00:00Z", expiresAt: "2026-10-02T08:30:00Z" }];
  const result = compareMultiweekRoster(f.report, f.snapshot, f.now);
  assert.equal(result.coverageReviews[0].disposition, "REVIEW_COVERAGE");
  assert.equal(result.coverageReviews[0].action, "REVIEW_ONLY_NO_AUTOMATIC_DROP");
  assert.match(result.proposals.map((index) => result.alternatives[index]).find((row) => row.addYahooId === "5").executionCondition, /AFTER_RELEASE/);
});

test("general planner retains IDP continuity and role/tackle edge controls", () => {
  const f = planningFixture();
  f.snapshot.slots[0].eligible = ["LB"];
  f.snapshot.roster[0].eligible = ["LB"];
  f.snapshot.available[1].eligible = ["LB"];
  for (const week of f.report.weeks) {
    week.players[0].position = "LB";
    week.players[5].position = "LB";
    week.players[0].idpModel = { status: "SNAP_ROLE_MODEL", roleContinuity: "LATEST_WEEK_MEASURED", expectedSnaps: 60, tacklePoints: 9 };
    week.players[5].idpModel = { status: "SNAP_ROLE_MODEL", roleContinuity: "LATEST_WEEK_MEASURED", expectedSnaps: 50, tacklePoints: 8 };
  }
  let result = compareMultiweekRoster(f.report, f.snapshot, f.now);
  assert.ok(!result.proposals.some((index) => result.alternatives[index].addYahooId === "6"));
  f.report.weeks[0].players[0].idpModel.roleContinuity = "UNVERIFIED_NO_TEAM_SNAP_ROWS";
  result = compareMultiweekRoster(f.report, f.snapshot, f.now);
  assert.equal(result.reason, "STARTER_IDP_ROLE_CONTINUITY_REQUIRES_REVIEW");
});

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

test("ranks by resolved disposition and keeps every unrankable row with its reason", () => {
  const rows = [
    { playerId: "1", name: "QB1", position: "QB", weeklyExpectation: 25, priorPerGame: 24, unrankableReason: null },
    { playerId: "2", name: "RB1", position: "RB", weeklyExpectation: 18, priorPerGame: 16, unrankableReason: null },
    { playerId: "3", name: "RB2", position: "RB", weeklyExpectation: 20, priorPerGame: 15, unrankableReason: null },
    // A healthy prior-only player ranked ON their prior is rankable — not dropped.
    { playerId: "3b", name: "PriorOnly", position: "RB", weeklyExpectation: 12, priorPerGame: 12, unrankableReason: null },
    { playerId: "4", name: "OutWR", position: "WR", weeklyExpectation: null, unrankableReason: "CONFIRMED_INACTIVE_OUT" },
    { playerId: "5", name: "FreeAgent", position: "TE", weeklyExpectation: null, unrankableReason: "NO_CURRENT_TEAM" },
    { playerId: "6", name: "Empty", position: "WR", weeklyExpectation: null, unrankableReason: "NO_PRIOR_OR_COMPLETED_WEEK_ACTUAL" },
  ];
  const ranked = assignFullRanks(rows);
  const byId = Object.fromEntries(ranked.map((r) => [r.playerId, r]));
  assert.equal(ranked.length, 7); // nothing dropped
  assert.equal(byId["1"].overallRank, 1);
  assert.equal(byId["3"].overallRank, 2);
  assert.equal(byId["2"].overallRank, 3);
  assert.equal(byId["3b"].overallRank, 4);
  assert.equal(byId["3"].positionRank, 1); // RB2 (20) outranks RB1 (18) within RB
  assert.equal(byId["2"].positionRank, 2);
  assert.equal(byId["3b"].positionRank, 3);
  assert.equal(byId["1"].positionRank, 1);
  assert.equal(byId["4"].rankable, false);
  assert.equal(byId["4"].overallRank, null);
  assert.equal(byId["4"].unrankableReason, "CONFIRMED_INACTIVE_OUT");
  assert.equal(byId["5"].unrankableReason, "NO_CURRENT_TEAM");
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
