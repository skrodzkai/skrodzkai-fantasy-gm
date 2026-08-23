import assert from "node:assert/strict";
import test from "node:test";

import {
  auditLateRoundConcentration,
  backtestSpecialistSurvival,
  buildOpponentSeatWarCards,
  evaluateRosterConstraints,
  gradeChaosScenarios,
  rehearseExactRoster,
  reconcileSettingsAndYahoo,
  specialistSurvivalByWindow,
} from "./draft-readiness.mjs";

test("late-round audit reports concentration and requires justified exemptions", () => {
  const records = [
    { simulationId: "s1", picks: [{ round: 15, position: "K" }, { round: 16, position: "K" }] },
    { simulationId: "s2", picks: [{ round: 15, position: "K" }, { round: 16, position: "DEF" }] },
  ];
  const result = auditLateRoundConcentration(records, { minSamples: 1, minSimulationCount: 2, minPositionCoverage: 1, maxConcentration: 0.6, minEntropy: 0.5 });
  assert.equal(result.accepted, false);
  assert.equal(result.metrics.concentration, 0.75);
  assert.equal(result.metrics.maxRoundConcentration, 1);
  assert.equal(result.metrics.simulationCount, 2);
  const exempted = auditLateRoundConcentration(records, {
    minSamples: 1, minSimulationCount: 2, minPositionCoverage: 1, maxConcentration: 0.6, minEntropy: 0.5,
    exemptions: [
      { metric: "concentration", reason: "K scarcity supplied by test fixture", evidence: { source: "fixture" } },
      { metric: "roundConcentration", reason: "two-round test fixture is intentionally fixed", evidence: { source: "fixture" } },
    ],
  });
  assert.equal(exempted.accepted, true);
  const ungrounded = auditLateRoundConcentration(records, { maxConcentration: 0.6, exemptions: [{ metric: "concentration", reason: "hand wave" }] });
  assert.ok(ungrounded.violations.includes("invalid_exemption"));
});

test("specialist survival uses exact snake windows and excludes Joe", () => {
  const rows = [
    { season: 2024, managerId: "opponent-a", round: 14, seat: 2, position: "K" },
    { season: 2024, managerId: "opponent-a", round: 15, seat: 2, position: "DEF" },
    { season: 2025, managerId: "opponent-b", round: 13, seat: 12, position: "K" },
    { season: 2025, managerId: "joe", round: 14, seat: 2, position: "K" },
    { season: 2025, managerId: "opponent-b", round: 17, seat: 12, position: "DL" },
  ];
  const model = specialistSurvivalByWindow(rows, { targetRounds: [14], targetSeats: [2], teams: 12 });
  assert.equal(model.sampleDrafts, 2);
  assert.equal(model.windows[0].overallPick, 167);
  assert.equal(model.positions.K.windows[0].sampleCount, 2);
  assert.equal(model.positions.K.windows[0].probability, 0.5);
  assert.equal(model.positions.D.windows[0].sampleCount, 2);
  const backtest = backtestSpecialistSurvival(rows, { holdoutSeason: 2025, targetRounds: [14], targetSeats: [2], teams: 12 });
  assert.equal(backtest.holdoutSeason, "2025");
  assert.ok(backtest.metrics.sampleCount > 0);
  assert.equal(backtest.events.every((event) => typeof event.probability === "number"), true);
});

test("roster constraints use supplied bye, schedule, stacks, handcuffs, and bench facts", () => {
  const roster = [
    { playerId: "a", position: "RB", team: "A", byeWeek: 9, starter: true },
    { playerId: "b", position: "WR", team: "A", byeWeek: 9, starter: true },
    { playerId: "c", position: "TE", team: "B", byeWeek: 7, starter: false, covers: ["WR"] },
  ];
  const result = evaluateRosterConstraints({ roster, constraints: {
    maxByeCollision: 1,
    requiredStacks: [{ team: "A", min: 2 }],
    handcuffs: [{ starterId: "a", handcuffId: "missing" }],
    benchOptionality: { required: 1, slots: ["WR"] },
  } });
  assert.equal(result.ok, false);
  assert.ok(result.violations.includes("bye_collision_week_9"));
  assert.ok(result.violations.includes("missing_handcuff_for_a"));
  assert.equal(result.metrics.optionalBenchCount, 1);
});

function nineteenPicks() {
  const positions = ["QB", "QB", "RB", "RB", "RB", "RB", "RB", "WR", "WR", "WR", "WR", "WR", "TE", "TE", "K", "DEF", "D", "LB", "DB"];
  return positions.map((position, index) => ({ round: index + 1, playerId: `p${index + 1}`, position, latencyMs: 10 }));
}

test("19-round rehearsal validates exact roster, intentional fallback, and latency receipts", () => {
  const picks = nineteenPicks();
  picks[17] = { ...picks[17], playerId: "fallback", fallbackInjected: true };
  const result = rehearseExactRoster({
    picks,
    rosterShape: { QB: 2, RB: 5, WR: 5, TE: 2, K: 1, DEF: 1, D: 1, LB: 1, DB: 1 },
    fallbacks: [{ round: 18, fallbackId: "fallback", primaryUnavailable: true }],
    latencyBudgetMs: 100,
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.receipts[17].status, "fallback");
  assert.equal(result.receipts.every((receipt) => receipt.latencyPass), true);
  const late = rehearseExactRoster({ picks: nineteenPicks(), rosterShape: { QB: 2 }, latencyBudgetMs: 1 });
  assert.equal(late.status, "LOCKED");
  assert.ok(late.errors.includes("round_1_latency_budget_missed"));
});

test("war cards expose sample counts and do-not-act thresholds without manager identities", () => {
  const result = buildOpponentSeatWarCards([
    { seat: 1, managerId: "private-a", position: "RB" },
    { seat: 1, managerId: "private-a", position: "RB" },
    { seat: 2, managerId: "private-b", position: "WR" },
  ], { minSamples: 2, minSupport: 0.8 });
  assert.equal(result.cards[0].sampleCount, 2);
  assert.equal(result.cards[0].doNotAct, false);
  assert.equal(result.cards[1].doNotAct, true);
  assert.equal(JSON.stringify(result).includes("private-a"), false);
});

test("Yahoo reconciliation fails closed on identity, read-only, and eligibility drift", () => {
  const locked = reconcileSettingsAndYahoo({
    settings: { leagueKey: "l", teamKey: "t", seat: 4 },
    yahoo: { leagueKey: "other", teamKey: "t", seat: 4, readOnly: false, eligiblePlayerIds: ["ok"] },
    requestedPlayerIds: ["ok", "bad"],
  });
  assert.equal(locked.status, "LOCKED");
  assert.equal(locked.ok, false);
  assert.ok(locked.reasons.includes("identity_mismatch_leagueKey"));
  assert.ok(locked.reasons.includes("yahoo_read_only_contract_missing"));
  assert.ok(locked.reasons.includes("requested_player_not_yahoo_eligible"));
  const ready = reconcileSettingsAndYahoo({
    settings: { leagueKey: "l", teamKey: "t", seat: 4 },
    yahoo: { leagueKey: "l", teamKey: "t", seat: 4, readOnly: true, eligiblePlayerIds: ["ok"] },
    requestedPlayerIds: ["ok"],
  });
  assert.equal(ready.status, "READY");
});

test("chaos grading returns deterministic pass/fail receipts", () => {
  const result = gradeChaosScenarios([
    {
      id: "identity",
      type: "missing_yahoo_identity",
      input: { settings: { leagueKey: "l", teamKey: "t", seat: 4 }, yahoo: { leagueKey: "l", teamKey: "t", readOnly: true } },
      expected: {
        ok: false,
        status: "LOCKED",
        reasons: ["missing_identity_seat"],
        identityMatched: false,
        eligibility: { requestedCount: 0, eligibleCount: 0, allEligible: true },
      },
      mustFailClosed: true,
    },
  ]);
  assert.equal(result.pass, true);
  assert.equal(result.passed, 1);
  assert.equal(result.total, 1);
});
