import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./yahoo-mock-runner.js", import.meta.url), "utf8");
const replacementBySlot = Object.freeze({
  QB: 300, RB: 180, WR: 170, TE: 140, "W/R": 175, "W/R/T": 175,
  K: 80, DEF: 75, D: 70, DB: 65, LB: 68, CB: 65, S: 65,
});

function loadRunner(controllerApi = {}, clock = Date) {
  const context = {
    clearInterval,
    console,
    crypto,
    Date: clock,
    Event: class Event { constructor(type) { this.type = type; } },
    Math,
    setInterval,
    setTimeout,
    SKRODZKaiYahooDraftController: controllerApi,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.SKRODZKaiYahooMockRunner;
}

const api = loadRunner();
const helpers = api._test;
const mockConfig = api.configs.public_mock_15;
const testConfig = api.configs.test_league_19_idp;

function player(position, number, rank, overrides = {}) {
  const eligible = position === "LB" ? ["LB", "D"]
    : position === "CB" ? ["CB", "DB", "D"]
      : position === "S" ? ["S", "DB", "D"]
        : [position];
  return {
    yahooId: `${position}-${number}`,
    name: `${position} Player ${number}`,
    position,
    team: position === "DEF" ? "" : "TST",
    rank,
    projection: 500 - rank,
    replacementPoints: 100,
    eligible,
    automaticEligible: true,
    manualEligible: true,
    vor: 400 - rank,
    adpLow: rank + 8,
    adpHigh: rank + 24,
    ...overrides,
  };
}

function boardForConfig(config) {
  const positions = config.name === "test_league_19_idp"
    ? ["QB", "RB", "WR", "TE", "K", "DEF", "D", "LB", "CB", "S"]
    : ["QB", "RB", "WR", "TE", "K", "DEF"];
  let rank = 1;
  return helpers.validateBoard(positions.flatMap((position) =>
    Array.from({ length: 16 }, (_, index) => player(position, index + 1, rank++))
  ));
}

function storageFixture() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not reached before timeout");
}

test("keeps the real league unqualified and hard-separate from TEST", () => {
  assert.equal(api.configs.real_league_19_idp.qualification, "unverified-real-room");
  assert.equal(testConfig.leagueId, "542830");
  assert.equal(testConfig.urlTeamId, 3);
  assert.equal(testConfig.minimumTeams, 10);
  assert.equal(testConfig.maximumTeams, 12);
  assert.equal(testConfig.rounds, 19);
  assert.equal(api.configs.real_league_19_idp.positionLimits.K, 1);
  const board = boardForConfig(testConfig);
  assert.equal(helpers.buildDecisionLadder({
    round:1, seat:6, picks:[], board, availablePlayers:board, minimum:5,
    config:api.configs.real_league_19_idp, replacementBySlot,
  }).targets.length, 5);
});

test("preserves exact Yahoo multi-position eligibility without requiring market ADP", () => {
  const [hunter] = helpers.validateBoard([player("WR", 1, 24, {
    yahooId: "41787",
    eligible: ["WR", "CB"],
    automaticEligible: false,
    manualEligible: true,
    validationStatus: "DUAL_ROLE_SCORING_UNVERIFIED",
    adpLow: null,
    adpHigh: null,
    draftSignals: { attentionRequired:true, warnings:["ROLE_WATCH"], role:{ depthRank:1 }, market:null, specialist:{ kind:"IDP", depthPosition:"LCB", depthRank:1 } },
  })]);
  assert.deepEqual(Array.from(hunter.eligible), ["WR", "CB"]);
  assert.equal(hunter.automaticEligible, false);
  assert.equal(hunter.manualEligible, true);
  assert.equal(hunter.marketStatus, "BOARD_RANK_FALLBACK_UNCALIBRATED");
  assert.equal(hunter.draftSignals.specialist.depthPosition, "LCB");
  assert.deepEqual(Array.from(hunter.draftSignals.warnings), ["ROLE_WATCH"]);
});

test("missing board eligibility metadata fails closed", () => {
  const candidate = player("RB", 99, 99, { automaticEligible: undefined, manualEligible: undefined, validationStatus: undefined });
  const [validated] = helpers.validateBoard([candidate]);
  assert.equal(validated.automaticEligible, false);
  assert.equal(validated.manualEligible, false);
  assert.equal(validated.validationStatus, "MISSING_VALIDATION_STATUS");
});

test("never converts a missing projection to zero and labels Yahoo-rank survival fallback", () => {
  assert.throws(() => helpers.validateBoard([player("WR", 1, 1, { projection:null })]), /invalid league projection/);
  const [withheld] = helpers.validateBoard([player("CB", 1, 1, {
    projection:null, automaticEligible:false, manualEligible:false, yahooRank:368, adpLow:null, adpHigh:null,
  })]);
  assert.equal(withheld.projection, null);
  assert.equal(withheld.marketMean, 368);
  assert.equal(withheld.marketStatus, "YAHOO_PRESEASON_RANK_UNCALIBRATED");
});

test("keeps one visible position pool while containing autonomous specialists to late rounds", () => {
  assert.deepEqual(Array.from(helpers.allowedPositions(14, [], testConfig, 1)), ["QB", "RB", "WR", "TE", "K", "DEF", "D", "LB", "CB", "S"]);
  assert.equal(helpers.filterLabelForRound(1, [], testConfig, 1), "All Positions");
  assert.equal(helpers.filterLabelForRound(19, [], testConfig, 12), "All Positions");
  assert.deepEqual(Array.from(helpers.requiredTestFilterLabels()), ["All Positions", "Kickers", "Team Defenses", "Defensive Players"]);
  assert.equal(helpers.automaticCandidateAllowed({ player:player("K", 1, 1), round:14, picks:[], config:testConfig }), false);
  assert.equal(helpers.automaticCandidateAllowed({ player:player("K", 1, 1), round:15, picks:[], config:testConfig }), true);
  assert.equal(helpers.automaticCandidateAllowed({ player:player("LB", 1, 1), round:16, picks:[], config:testConfig }), false);
  assert.equal(helpers.automaticCandidateAllowed({ player:player("LB", 1, 1), round:17, picks:[], config:testConfig }), true);
  assert.equal(helpers.automaticCandidateAllowed({ player:player("K", 1, 1), round:1, picks:[], config:mockConfig }), true);
});

test("joint roster utility allocates flex and IDP eligibility instead of comparing raw points", () => {
  const config = { ...testConfig, rosterSlots: ["WR", "W/R/T", "D", "DB", "LB", "BN"] };
  const picks = [
    player("WR", 1, 1, { projection: 220, eligible: ["WR"] }),
    player("CB", 1, 2, { projection: 120, eligible: ["CB", "DB", "D"] }),
    player("LB", 1, 3, { projection: 130, eligible: ["LB", "D"] }),
  ];
  const utility = helpers.optimalRosterUtility(picks, config, replacementBySlot);
  assert.equal(utility, (220 - 170) + (120 - 65) + (130 - 68));
  assert.equal(helpers.maximumFilledStarterSlots(picks, config), 3);
});

test("weekly utility gives bench and QB2 picks real bye-week value after starters are filled", () => {
  const config = {
    ...testConfig,
    rounds: 4,
    rosterSlots: ["QB", "RB", "BN", "BN"],
    positionLimits: { QB: 2, RB: 3 },
  };
  const weekly = (points, byeIndex = null) => Array.from({ length: 17 }, (_, index) => index === byeIndex ? 0 : points);
  const picks = helpers.validateBoard([
    player("QB", 1, 1, { projection: 480, weeklyPoints: weekly(30, 4), weeklyAvailability: weekly(1, 4) }),
    player("RB", 1, 2, { projection: 400, weeklyPoints: weekly(25, 5), weeklyAvailability: weekly(1, 5) }),
  ]);
  const pool = helpers.validateBoard([
    player("QB", 2, 3, { projection: 384, weeklyPoints: weekly(24), weeklyAvailability: weekly(1) }),
    player("RB", 2, 4, { projection: 368, weeklyPoints: weekly(23), weeklyAvailability: weekly(1) }),
  ]);
  const result = helpers.scoreCandidates({ round: 3, seat: 6, picks, pool, config, replacementBySlot });
  assert.equal(result.utilityModel, "WEEKLY_OPTIMAL_LINEUP_W1_17");
  assert.ok(result.ranked.find((entry) => entry.player.position === "QB").marginalUtility > 0);
  assert.ok(result.ranked.find((entry) => entry.player.position === "RB").marginalUtility > 0);
});

test("offensive bench candidates retain bounded opportunity value after starters are filled", () => {
  const config = { ...mockConfig, rounds:3, rosterSlots:["RB", "BN", "BN"], positionLimits:{ RB:3 } };
  const picks = helpers.validateBoard([player("RB", 1, 1, { projection:450, vor:300 })]);
  const pool = helpers.validateBoard([player("RB", 2, 2, { projection:400, vor:200 })]);
  const [candidate] = helpers.scoreCandidates({ round:2, seat:1, picks, pool, config, replacementBySlot }).ranked;
  assert.equal(candidate.starterMarginalUtility, 0);
  assert.equal(candidate.benchOpportunityValue, 60);
  assert.equal(candidate.marginalUtility, 60);
});

test("league-scored quarterback value can beat generic Yahoo order with an explicit VONA reason", () => {
  const config = { ...mockConfig, rounds: 6, rosterSlots: ["QB", "RB", "WR", "W/R/T", "BN", "BN"], positionLimits: { QB:2, RB:4, WR:4, TE:2 } };
  const board = helpers.validateBoard([
    player("QB", 1, 1, { projection:1200, yahooRank:20, adpLow:null, adpHigh:null }),
    player("RB", 1, 2, { projection:360, yahooRank:1, adpLow:null, adpHigh:null }),
    player("WR", 1, 3, { projection:350, yahooRank:2, adpLow:null, adpHigh:null }),
    player("TE", 1, 4, { projection:300, yahooRank:3, adpLow:null, adpHigh:null }),
    player("RB", 2, 5, { projection:340, yahooRank:4, adpLow:null, adpHigh:null }),
    player("WR", 2, 6, { projection:330, yahooRank:5, adpLow:null, adpHigh:null }),
  ]);
  const result = helpers.buildDecisionLadder({ round:1, seat:6, picks:[], board, availablePlayers:board, minimum:5, config, replacementBySlot });
  assert.equal(result.targets[0].position, "QB");
  assert.match(result.decision.positionLeaders[0].valueReason, /league-scored BPA/);
  assert.match(result.decision.positionLeaders[0].valueReason, /Y!20/);
});

test("QB2 and bye annotations explain the recommendation without changing ranking", () => {
  const chosen = helpers.validateBoard([player("QB", 2, 2, { bye:7, yahooRank:30 })])[0];
  const scored = { window:{ currentPick:18, nextPick:31, interveningOpponentPicks:12 }, utilityModel:"WEEKLY_OPTIMAL_LINEUP_W1_17", recomputeMs:2 };
  const entry = { player:chosen, marginalUtility:14, expectedNextUtility:3, costOfWaiting:11, decisionScore:17, pAvailableNext:0.2, survivalStatus:"TEST" };
  const yes = helpers.summarizeDecision(scored, [entry], [player("QB", 1, 1, { bye:5 })]);
  assert.deepEqual(JSON.parse(JSON.stringify(yes.qb2)), { recommendation:"YES", reason:"remaining-QB cliff: 20% next-turn survival" });
  assert.equal(yes.chosenYahooId, chosen.yahooId);

  const conflict = helpers.summarizeDecision(scored, [{ ...entry, player:{ ...chosen, bye:5 } }], [player("QB", 1, 1, { bye:5 })]);
  assert.match(conflict.qb2.reason, /weekly-utility conflict/);
  assert.equal(conflict.qb2.recommendation, "NO");

  const bye = helpers.summarizeDecision(scored, [{ ...entry, player:{ ...chosen, position:"WR", bye:9 } }], [
    player("RB", 1, 1, { bye:9 }),
    player("WR", 1, 2, { bye:9 }),
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(bye.byeConcentration)), { warning:true, week:9, count:3, limit:2, reason:"Week 9 would contain 3 rostered players" });
});

test("the two Travis Hunter Yahoo identities cannot occupy the same roster", () => {
  const [offense, defense] = helpers.validateBoard([
    player("WR", 1, 1, { yahooId:"99001", name:"Travis Hunter", team:"JAX", eligible:["WR"], automaticEligible:false, manualEligible:true }),
    player("CB", 1, 2, { yahooId:"99002", name:"Travis Hunter", team:"JAX", eligible:["CB", "DB", "D"], automaticEligible:false, manualEligible:true }),
  ]);
  assert.equal(helpers.canCompleteRoster({ player:defense, picks:[offense], config:testConfig }), false);
  const override = helpers.applyManualOverride({
    stage:{ roomId:"542830", seat:6, expectedRound:2, targets:[{ yahooId:"99002" }] },
    roomId:"542830", seat:6, round:2, board:[offense, defense], availablePlayers:[defense],
    baselineTargets:Array.from({ length:5 }, (_, index) => ({ yahooId:`fallback-${index}` })),
    picks:[offense], config:testConfig,
  });
  assert.equal(override.manualOverride.status, "rejected");
  assert.equal(override.manualOverride.reason, "manual_pin_unavailable_or_ineligible");
});

test("confirmed picks preserve canonical board identity instead of Yahoo display abbreviations", () => {
  assert.match(source, /name: boardPlayer\?\.name \?\? confirmation\.name/);
  assert.match(source, /team: boardPlayer\?\.team \?\? confirmation\.team/);
});

test("snake-seat geometry changes next-turn survival metrics on the same board", () => {
  const pool = helpers.validateBoard(boardForConfig(mockConfig).slice(0, 12));
  const edge = helpers.scoreCandidates({ round:1, seat:1, picks:[], pool, config:mockConfig, replacementBySlot });
  const middle = helpers.scoreCandidates({ round:1, seat:6, picks:[], pool, config:mockConfig, replacementBySlot });
  const yahooId = pool[0].yahooId;
  const atEdge = edge.ranked.find((entry) => entry.player.yahooId === yahooId);
  const atMiddle = middle.ranked.find((entry) => entry.player.yahooId === yahooId);
  assert.notEqual(edge.window.nextPick, middle.window.nextPick);
  assert.notEqual(atEdge.pAvailableNext, atMiddle.pAvailableNext);
  assert.notEqual(edge.window.interveningOpponentPicks, middle.window.interveningOpponentPicks);
});

test("a confirmed target preserves its weekly profile for the following round", () => {
  const weekly = (points, byeIndex = null) => Array.from({ length: 17 }, (_, index) => index === byeIndex ? 0 : points);
  const board = helpers.validateBoard([
    player("QB", 1, 1, { weeklyPoints: weekly(30, 4), weeklyAvailability: weekly(1, 4) }),
    player("RB", 1, 2, { weeklyPoints: weekly(25, 5), weeklyAvailability: weekly(1, 5) }),
    player("WR", 1, 3, { weeklyPoints: weekly(24, 6), weeklyAvailability: weekly(1, 6) }),
    player("TE", 1, 4, { weeklyPoints: weekly(20, 7), weeklyAvailability: weekly(1, 7) }),
    player("RB", 2, 5, { weeklyPoints: weekly(22, 8), weeklyAvailability: weekly(1, 8) }),
    player("WR", 2, 6, { weeklyPoints: weekly(21, 9), weeklyAvailability: weekly(1, 9) }),
  ]);
  const first = helpers.buildDecisionLadder({
    round: 1, seat: 6, picks: [], board, availablePlayers: board, minimum: 5,
    config: mockConfig, replacementBySlot,
  });
  assert.equal(first.targets[0].weeklyPoints.length, 17);
  const second = helpers.buildDecisionLadder({
    round: 2,
    seat: 6,
    picks: [first.targets[0]],
    board,
    availablePlayers: board.filter((candidate) => candidate.yahooId !== first.targets[0].yahooId),
    minimum: 5,
    config: mockConfig,
    replacementBySlot,
  });
  assert.equal(second.decision.utilityModel, "WEEKLY_OPTIMAL_LINEUP_W1_17");
});

test("grouped weekly scoring matches the ungrouped exact lineup reference", () => {
  const weekly = (points, byeIndex = null) => Array.from({ length: 17 }, (_, index) => index === byeIndex ? 0 : points);
  const config = {
    ...testConfig,
    rounds: 5,
    rosterSlots: ["QB", "RB", "W/R/T", "BN", "BN"],
    positionLimits: { QB: 6, RB: 6, WR: 6, TE: 6 },
  };
  const picks = helpers.validateBoard([
    player("RB", 1, 1, { weeklyPoints: weekly(25, 4), weeklyAvailability: weekly(1, 4) }),
  ]);
  const pool = helpers.validateBoard([
    player("QB", 1, 2, { weeklyPoints: weekly(28, 5), weeklyAvailability: weekly(1, 5) }),
    player("QB", 2, 3, { weeklyPoints: weekly(23, 4), weeklyAvailability: weekly(1, 4) }),
    player("RB", 2, 4, { weeklyPoints: weekly(22, 6), weeklyAvailability: weekly(1, 6) }),
    player("WR", 1, 5, { weeklyPoints: weekly(21, 5), weeklyAvailability: weekly(1, 5) }),
    player("WR", 2, 6, { weeklyPoints: weekly(20, 7), weeklyAvailability: weekly(1, 7) }),
    player("TE", 1, 7, { weeklyPoints: weekly(19, 6), weeklyAvailability: weekly(1, 6) }),
  ]);
  const scored = helpers.scoreCandidates({ round: 2, seat: 6, picks, pool, config, replacementBySlot });
  const baseUtility = helpers.optimalRosterUtility(picks, config, replacementBySlot);
  const reference = pool.map((candidate) => ({
    player: candidate,
    marginalUtility: helpers.optimalRosterUtility([...picks, candidate], config, replacementBySlot) - baseUtility,
    pAvailableNext: helpers.survivalProbability(candidate, scored.window.nextPick, 0, null, scored.window.currentPick),
  }));
  const nextCandidates = reference.slice().sort((left, right) =>
    right.marginalUtility - left.marginalUtility || left.player.rank - right.player.rank
  ).slice(0, 6);
  const referenceMarginal = (candidate, roster) => {
    const raw = helpers.optimalRosterUtility([...roster, candidate], config, replacementBySlot) -
      helpers.optimalRosterUtility(roster, config, replacementBySlot);
    if (helpers.maximumFilledStarterSlots([...roster, candidate], config) > helpers.maximumFilledStarterSlots(roster, config)) return raw;
    const count = roster.filter((pick) => pick.position === candidate.position).length;
    const depth = candidate.position === "RB" ? (count < 4 ? 0.30 : 0.12)
      : candidate.position === "WR" ? (count < config.offenseStarters.WR + 2 ? 0.24 : 0.12)
        : candidate.position === "QB" ? (count === 1 ? 0.06 : 0.01) : (count === 1 ? 0.05 : 0.01);
    const lineup = ["QB", "TE"].includes(candidate.position) ? (count === 1 ? 0.35 : 0.10) : 1;
    return raw * lineup + Math.max(0, candidate.vor) * depth + Number(candidate.perGamePoints) * depth * 0.1;
  };
  for (const entry of reference) {
    const alternatives = nextCandidates
      .filter((candidate) => candidate !== entry)
      .map((candidate) => ({
        ...candidate,
        marginalAfterEntry: referenceMarginal(candidate.player, [...picks, entry.player]),
      }))
      .sort((left, right) => right.marginalAfterEntry - left.marginalAfterEntry || left.player.rank - right.player.rank);
    let noneBetter = 1;
    let expectedNextUtility = 0;
    for (const candidate of alternatives) {
      expectedNextUtility += noneBetter * candidate.pAvailableNext * candidate.marginalAfterEntry;
      noneBetter *= 1 - candidate.pAvailableNext;
    }
    const actual = scored.ranked.find((candidate) => candidate.player.yahooId === entry.player.yahooId);
    assert.ok(Math.abs(actual.marginalUtility - entry.marginalUtility) < 1e-9);
    assert.ok(Math.abs(actual.expectedNextUtility - expectedNextUtility) < 1e-9);
    assert.ok(Math.abs(actual.decisionScore - (entry.marginalUtility + expectedNextUtility)) < 1e-9);
  }
});

test("next-turn bench value matches the same decision made on that next turn", () => {
  const config = { ...testConfig, teams:12, rounds:3, rosterSlots:["QB", "BN", "BN"], positionLimits:{ QB:3 } };
  const qb = (id, ppg, bye) => player("QB", id, 100, {
    projection:ppg * 16, perGamePoints:ppg, vor:ppg * 16 - 160, marketMean:200,
    weeklyPoints:Array.from({ length:17 }, (_, week) => week === bye ? 0 : ppg),
  });
  const picks = [qb(1, 30, 4)];
  const pool = [qb(2, 20, 5), qb(3, 19, 5)];
  const baselines = { QB:160 };
  const scored = helpers.scoreCandidates({ round:2, seat:6, picks, pool, config, replacementBySlot:baselines });
  for (const entry of scored.ranked) {
    const remaining = pool.filter((candidate) => candidate !== entry.player);
    const next = helpers.scoreCandidates({ round:3, seat:6, picks:[...picks, entry.player], pool:remaining, config, replacementBySlot:baselines });
    const expected = next.ranked[0].marginalUtility * helpers.survivalProbability(remaining[0], scored.window.nextPick, 0, null, scored.window.currentPick);
    assert.ok(Math.abs(entry.expectedNextUtility - expected) < 1e-9);
    assert.ok(entry.expectedNextUtility > 0, "even the weaker backup retains the existing bounded depth value");
  }
});

test("lookahead respects next-round specialist policy, including newly unlocked candidates", () => {
  const config = { ...testConfig, teams:12 };
  const picks = [player("QB", 1, 1),
    ...Array.from({ length:4 }, (_, i) => player("RB", i + 1, i + 2)),
    ...Array.from({ length:6 }, (_, i) => player("WR", i + 1, i + 6)),
    player("TE", 1, 12), player("TE", 2, 13)];
  const rb = player("RB", 5, 100);
  const wr = player("WR", 7, 101);
  const k = player("K", 1, 120, { projection:100, marketMean:200 });
  const def = player("DEF", 1, 121, { projection:90, marketMean:200 });
  const withoutSpecialists = helpers.scoreCandidates({ round:14, seat:6, picks, pool:[rb, wr], config, replacementBySlot });
  assert.ok(withoutSpecialists.ranked.every((entry) => entry.expectedNextUtility === 0), "round-15 offense cannot be promised when both K and DEF remain");
  const withSpecialists = helpers.scoreCandidates({ round:14, seat:6, picks, pool:[rb, wr, k, def], config, replacementBySlot });
  assert.ok(withSpecialists.ranked.every((entry) => ["RB", "WR"].includes(entry.player.position)), "no early specialist pick");
  const kSurvival = helpers.survivalProbability(k, withSpecialists.window.nextPick, 0, null, withSpecialists.window.currentPick);
  const defSurvival = helpers.survivalProbability(def, withSpecialists.window.nextPick, 0, null, withSpecialists.window.currentPick);
  const expected = kSurvival * 20 + (1 - kSurvival) * defSurvival * 15;
  assert.ok(withSpecialists.ranked.every((entry) => Math.abs(entry.expectedNextUtility - expected) < 1e-9));
});

test("uses the held-out survival packet when its gate is enabled", () => {
  const candidate = helpers.validateBoard([player("QB", 1, 20, { adpLow: 45, adpHigh: 55 })])[0];
  const survivalCalibration = {
    calibration: { enabled: true, positionLayerEnabled: true },
    model: {
      minimumPositionSamples: 2,
      global: { sampleCount: 3, scale: 5, values: [{ residual: -10, weight: 1 }, { residual: 0, weight: 1 }, { residual: 10, weight: 1 }] },
      positions: { QB: { sampleCount: 3, scale: 5, values: [{ residual: -10, weight: 1 }, { residual: 0, weight: 1 }, { residual: 10, weight: 1 }] } },
    },
  };
  assert.ok(Math.abs(helpers.survivalProbability(candidate, 50, 0, survivalCalibration) - 0.75) < 1e-12);
  const pool = [candidate, ...boardForConfig(mockConfig).slice(0, 8)];
  const result = helpers.scoreCandidates({ round: 3, seat: 6, picks: [], pool, config: mockConfig, replacementBySlot, survivalCalibration });
  assert.equal(result.ranked.find((entry) => entry.player.yahooId === candidate.yahooId).survivalStatus, "HELD_OUT_CALIBRATED_POSITION_RESIDUAL");
});

test("position runs change acquisition probability, never football projection or marginal utility", () => {
  const candidate = helpers.validateBoard([player("WR", 1, 20, { projection: 250, adpLow: 30, adpHigh: 50 })])[0];
  const calm = helpers.survivalProbability(candidate, 45, 0);
  const run = helpers.survivalProbability(candidate, 45, 2);
  assert.ok(run < calm);
  const pool = [candidate, ...boardForConfig(mockConfig).slice(0, 8)];
  const calmScore = helpers.scoreCandidates({ round: 3, seat: 6, picks: [], pool, config: mockConfig, replacementBySlot });
  const runScore = helpers.scoreCandidates({ round: 3, seat: 6, picks: [], pool, config: mockConfig, replacementBySlot, runPressureByPosition: { WR: 2 } });
  const calmEntry = calmScore.ranked.find((entry) => entry.player.yahooId === candidate.yahooId);
  const runEntry = runScore.ranked.find((entry) => entry.player.yahooId === candidate.yahooId);
  assert.equal(runEntry.player.projection, calmEntry.player.projection);
  assert.equal(runEntry.marginalUtility, calmEntry.marginalUtility);
  assert.ok(runEntry.pAvailableNext < calmEntry.pAvailableNext);
});

test("filtered rows are not opponent-pick evidence; TEST requires a verified scoring schema", () => {
  assert.equal(helpers.runPressureFromAvailability, undefined);
  assert.equal(helpers.scoringFailure(testConfig, {}), "test_board_scoring_identity_mismatch");
  assert.equal(helpers.scoringFailure({ ...testConfig, expectedScoring:{ ...testConfig.expectedScoring, scoringSchemaHash:null } }, {}), "test_scoring_schema_unverified");
  const expectedScoring = { leagueId:"542830", scoringModel:"league-two-2026", scoringSchemaHash:"b".repeat(64) };
  const fixture = { ...testConfig, expectedScoring };
  assert.equal(helpers.scoringFailure(fixture, expectedScoring), null);
  for (const key of Object.keys(expectedScoring)) assert.equal(helpers.scoringFailure(fixture, { ...expectedScoring, [key]:"wrong" }), "test_board_scoring_identity_mismatch");
});

function discoveryFixture({ owned = false, missingFilter = false, allUnavailable = false } = {}) {
  const board = boardForConfig(testConfig);
  const calls = [];
  let ownedTurn = owned;
  let queue = "EMPTY";
  let roster = 0;
  let controllerCreated = 0;
  const select = { value:"All Positions", options:helpers.requiredTestFilterLabels().filter((label) => !missingFilter || label !== "Kickers")
    .map((label) => ({ value:label, textContent:label })), dispatchEvent(event) { if (event.type === "change") calls.push({ label:this.value, owned:ownedTurn }); } };
  const players = () => board.filter((player) => select.value === "All Positions" ? !allUnavailable
    : select.value === "Kickers" ? player.position === "K" : select.value === "Team Defenses" ? player.position === "DEF" : ["D", "LB", "CB", "S"].includes(player.position));
  const turn = { label:"R1P6", round:1, pick:6 };
  const runtime = {
    parseRoom:() => ({ roomId:"542830", seat:3 }), readOwnedTurn:() => ownedTurn ? turn : null,
    readOwnedTurnState:() => ({ state:ownedTurn ? "OWNED" : "OFF_TURN", turn:ownedTurn ? turn : null }),
    readRosterCount:() => ({ filled:roster, total:19 }), readAutodraftState:() => "INACTIVE", readQueueState:() => queue,
    readDraftClock:() => ({ label:"00:30", seconds:30 }), readAvailablePlayerRows:players,
  };
  const controller = { runtime, create() { controllerCreated++; return {
    start() { return this; }, stop() {}, getStatus:() => ({ state:"running", confirmedPicks:0 }), exportReceipts:() => [],
  }; } };
  const api = loadRunner(controller);
  const environment = { document:{ querySelectorAll:() => [select] }, location:{ pathname:"/draftclient/f1/542830/3" },
    localStorage:storageFixture(), crypto, setTimeout, clearTimeout, setInterval, clearInterval,
    Event:class Event { constructor(type) { this.type = type; } }, SKRODZKaiYahooDraftController:controller,
    SKRODZKaiYahooPageReaders:{ readDiscoveryRows:players, readProjectedOrder:() => ({ descending:true }) } };
  const runner = api.create({ configName:"test_league_19_idp", executionMode:"TEST", expectedRoomId:"542830", expectedSeat:6, expectedUrlSeat:3,
    observedTeamCount:12, observedRosterSlots:testConfig.rosterSlots, board, replacementBySlot, scoringIdentity:api.configs.test_league_19_idp.expectedScoring,
    replacementRoster:{teamCount:12,rosterSlots:testConfig.rosterSlots.filter(s=>s!=="BN")},
    assertRunnerLease:() => true, runtimeAttestation:{ ok:true, version:"0.16.3", digest:"a".repeat(64), bootId:"synthetic-12345678", bootedAt:1 },
    selectionHoldMs:0, filterDeadlineMs:500,
  }, environment);
  return { runner, calls, select, enterTurn:() => { ownedTurn = true; }, changeQueue:() => { queue = "NONEMPTY_OR_UNKNOWN"; },
    changeRoster:() => { roster = 1; }, controllers:() => controllerCreated };
}

test("incomplete discovery uses exactly one receipted pre-click All Positions fallback with five fresh targets", async () => {
  const f = discoveryFixture({ owned:true }); f.runner.start();
  try {
    await waitFor(() => f.controllers() === 1);
    const receipts = f.runner.exportReceipts();
    const fallback = receipts.filter((row) => row.kind === "view_fallback_all_positions");
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].beforeClick, true);
    const resolved = receipts.find((row) => row.kind === "runner_turn_resolved");
    assert.equal(resolved.filterLabel, "All Positions");
    assert.equal(resolved.viewFallback, true);
    assert.ok(resolved.coverage.targetYahooIds.length >= 5);
    assert.ok(resolved.coverage.targetYahooIds.every((id) => resolved.coverage.yahooIds.includes(id)));
    assert.ok(resolved.panelReadyMs < 1200);
  } finally { f.runner.stop(); }
});

test("off-turn discovery yields before further filter writes when an owned banner arrives", async () => {
  const f = discoveryFixture(); f.runner.start();
  try {
    await waitFor(() => f.calls.some((call) => call.label === "Kickers"));
    f.enterTurn();
    await waitFor(() => f.controllers() === 1);
    assert.deepEqual(f.calls.filter((call) => call.owned).map((call) => call.label), ["All Positions"]);
    assert.equal(f.runner.exportReceipts().filter((row) => row.kind === "view_fallback_all_positions").length, 1);
  } finally { f.runner.stop(); }
});

test("discovery failure cannot fallback across queue or roster drift, nor retry a failed All Positions read", async () => {
  for (const mutate of ["changeQueue", "changeRoster"]) {
    const f = discoveryFixture({ missingFilter:true }); f.runner.start();
    try {
      await waitFor(() => f.runner.exportReceipts().some((row) => row.kind === "view_discovered"));
      f[mutate](); f.enterTurn();
      await waitFor(() => f.runner.getStatus().state === "failed");
      assert.equal(f.controllers(), 0);
      assert.equal(f.runner.exportReceipts().filter((row) => row.kind === "view_fallback_all_positions").length, 0);
    } finally { f.runner.stop(); }
  }
  const f = discoveryFixture({ owned:true, allUnavailable:true }); f.runner.start();
  try {
    await waitFor(() => f.runner.getStatus().state === "failed", 1000);
    assert.equal(f.controllers(), 0);
    assert.equal(f.runner.exportReceipts().filter((row) => row.kind === "view_fallback_all_positions").length, 1);
  } finally { f.runner.stop(); }
});

test("unified BPA plus one-turn alternatives returns five legal exact-ID targets", () => {
  const board = boardForConfig(mockConfig);
  const decision = helpers.buildDecisionLadder({
    round: 1,
    seat: 6,
    picks: [],
    board,
    availablePlayers: board,
    minimum: 5,
    config: mockConfig,
    replacementBySlot,
  });
  assert.equal(decision.targets.length, 5);
  assert.equal(new Set(decision.targets.map((target) => target.yahooId)).size, 5);
  assert.equal(decision.decision.policy, "JOINT_BPA_ONE_TURN_VONA");
  assert.equal(decision.decision.positionLeaders.every((entry) => Number.isFinite(entry.marginalUtility)), true);
});

test("requires five targets through round 18 but accepts the legal final-pick ladder", () => {
  const picks = helpers.validateBoard([
    ...Array.from({ length: 2 }, (_, index) => player("QB", index + 20, index + 1)),
    ...Array.from({ length: 6 }, (_, index) => player("WR", index + 20, index + 3)),
    ...Array.from({ length: 4 }, (_, index) => player("RB", index + 20, index + 9)),
    player("TE", 20, 13),
    player("DEF", 20, 14),
    player("D", 20, 15),
    player("LB", 20, 16),
    player("CB", 20, 17),
    player("S", 20, 18),
  ]);
  const candidates = helpers.validateBoard(Array.from({ length: 4 }, (_, index) => player("K", index + 30, index + 30)));

  assert.throws(() => helpers.buildDecisionLadder({
    round: 18,
    seat: 1,
    picks: picks.slice(0, 17),
    board: candidates,
    availablePlayers: candidates,
    minimum: 5,
    config: testConfig,
    replacementBySlot,
  }), /fewer_than_5_eligible_targets/);

  const final = helpers.buildDecisionLadder({
    round: 19,
    seat: 1,
    picks,
    board: candidates,
    availablePlayers: candidates,
    minimum: 5,
    config: testConfig,
    replacementBySlot,
  });
  assert.equal(final.targets.length, 4);

  const override = helpers.applyManualOverride({
    stage: { roomId: "test", seat: 1, expectedRound: 19, targets: [{ yahooId: candidates[3].yahooId }] },
    roomId: "test",
    seat: 1,
    round: 19,
    board: candidates,
    availablePlayers: candidates,
    baselineTargets: final.targets,
    allowed: ["K"],
    minimum: 5,
    picks,
    config: testConfig,
  });
  assert.equal(override.targets.length, 4);
  assert.equal(override.targets[0].yahooId, candidates[3].yahooId);
  assert.equal(override.manualOverride.status, "applied");
});

test("recompute budget breach fails closed instead of changing the decision model", () => {
  const board = boardForConfig(mockConfig);
  assert.throws(() => helpers.buildDecisionLadder({
    round:1, seat:6, picks:[], board, availablePlayers:board, minimum:5,
    config:mockConfig, replacementBySlot, recomputeBudgetMs:-1,
  }), /decision_recompute_budget_exceeded/);
});

test("endgame feasibility forces the only position that can complete the roster", () => {
  const startersWithoutK = [
    player("QB", 1, 1), player("RB", 1, 2), player("RB", 2, 3),
    player("WR", 1, 4), player("WR", 2, 5), player("WR", 3, 6),
    player("TE", 1, 7), player("DEF", 1, 8),
  ];
  const bench = [player("RB", 3, 9), player("RB", 4, 10), player("RB", 5, 11), player("WR", 4, 12), player("WR", 5, 13), player("WR", 6, 14)];
  const picks = [...startersWithoutK, ...bench];
  assert.equal(helpers.canCompleteRoster({ player: player("K", 1, 15), picks, config: mockConfig }), true);
  assert.equal(helpers.canCompleteRoster({ player: player("TE", 2, 15), picks, config: mockConfig }), false);
});

test("specialist eligibility cannot bypass the no-specialist-bench limits", () => {
  const real = api.configs.real_league_19_idp;
  const idpPicks = [player("D", 1, 1), player("LB", 1, 2), player("CB", 1, 3)];
  assert.equal(helpers.canCompleteRoster({ player:player("S", 1, 4), picks:idpPicks, config:real }), false);
  assert.equal(helpers.canCompleteRoster({ player:player("CB", 2, 4), picks:[player("CB", 1, 3)], config:real }), true);
  assert.equal(helpers.canCompleteRoster({ player:player("K", 2, 4), picks:[player("K", 1, 3)], config:real }), false);
});

test("manual override may choose a visible dual-role player while automatic BPA excludes it", () => {
  const board = boardForConfig(mockConfig);
  const hunter = helpers.validateBoard([player("WR", 99, 24, {
    yahooId: "41787", eligible: ["WR", "CB"], automaticEligible: false, manualEligible: true,
    validationStatus: "DUAL_ROLE_SCORING_UNVERIFIED",
  })])[0];
  const fullBoard = [...board, hunter];
  const baseline = helpers.buildDecisionLadder({ round:1, seat:6, picks:[], board:fullBoard, availablePlayers:fullBoard, minimum:5, config:mockConfig, replacementBySlot }).targets;
  assert.equal(baseline.some((target) => target.yahooId === "41787"), false);
  const override = helpers.applyManualOverride({
    stage:{ roomId:"99", seat:6, expectedRound:1, targets:[{ yahooId:"41787" }] },
    roomId:"99", seat:6, round:1, board:fullBoard, availablePlayers:fullBoard,
    baselineTargets:baseline, allowed:helpers.allowedPositions(1, [], mockConfig, 6), minimum:5, picks:[], config:mockConfig,
  });
  assert.equal(override.manualOverride.status, "applied");
  assert.equal(override.targets[0].yahooId, "41787");
  assert.equal(override.targets.slice(1).every((target) => baseline.some((base) => base.yahooId === target.yahooId)), true);
});

test("observed TEST roster validation rejects a specialist displaced to the bench", () => {
  const picks = [
    player("QB",1,1), player("RB",1,2), player("RB",2,3), player("WR",1,4), player("WR",2,5), player("WR",3,6), player("TE",1,7),
    player("RB",3,8), player("WR",4,9), player("K",1,10), player("DEF",1,11), player("D",1,12), player("LB",1,13),
    player("QB",2,14), player("RB",4,15), player("WR",5,16), player("TE",2,17), player("RB",5,18), player("WR",6,19),
  ];
  const clean = helpers.allocateRosterSlots(picks, testConfig.rosterSlots).map((entry) => ({ slot:entry.slot, yahooId:entry.player?.yahooId ?? null, empty:!entry.player }));
  assert.equal(helpers.validateObservedTestRoster(clean, picks), true);
  const bad = clean.map((entry) => ({ ...entry }));
  const d = bad.find((entry) => entry.slot === "D");
  const benchSlot = bad.find((entry) => entry.slot === "BN");
  const displaced = d.yahooId;
  d.yahooId = benchSlot.yahooId;
  benchSlot.yahooId = displaced;
  assert.equal(helpers.validateObservedTestRoster(bad, picks), false);
});

function integrationFixture({ selectionHoldMs = 80, autodraftState = "INACTIVE", queueState = "EMPTY", unstableRows = false, ownedSignalState = "OWNED", draftClockSeconds = 59, leaseState = { current:true }, readStallMs = 0 } = {}) {
  const board = boardForConfig(mockConfig);
  const rows = board.slice(0, 20).map((entry) => ({ player:entry }));
  const staleRows = board.slice(60, 80).map((entry) => ({ player:entry }));
  let rowReads = 0;
  let clockOffset = 0;
  class FixtureDate extends Date { static now() { return Date.now() + clockOffset; } }
  const select = { value:"all", options:[{ value:"all", textContent:"All Positions" }], dispatchEvent() {} };
  const document = {
    body:{ innerText:"0 / 15" },
    querySelectorAll(selector) { if (selector === "select") return [select]; if (selector === "tr") { rowReads += 1; return unstableRows && rowReads === 1 ? staleRows : rows; } return []; },
  };
  let controllerTargets = null;
  let controllerOptions = null;
  const controllerApi = {
    runtime:{
      parseRoom:() => ({ roomId:"99", seat:6 }),
      parseRosterCount:() => ({ filled:0, total:15 }),
      readRosterCount:() => ({ filled:0, total:15 }),
      readAutodraftState:() => autodraftState,
      readQueueState:() => queueState,
      readDraftClock:() => ({ label:`00:${String(draftClockSeconds).padStart(2, "0")}`, seconds:draftClockSeconds }),
      isAutodraftActive:() => false,
      readOwnedTurn:() => ({ label:"R1P6", round:1, pick:6 }),
      readOwnedTurnState:() => ownedSignalState === "OWNED" ? { state:"OWNED", turn:{ label:"R1P6", round:1, pick:6 } } : { state:ownedSignalState, turn:null },
      readPlayerRow:(row) => row.player,
      readAvailablePlayerRows:() => {
        rowReads += 1;
        if (rowReads === 2) clockOffset += readStallMs;
        return unstableRows && rowReads === 1 ? staleRows.map((row) => row.player) : rows.map((row) => row.player);
      },
    },
    create(options) {
      controllerTargets = options.targets;
      controllerOptions = options;
      let state = "created";
      return {
        start() { state = "running"; return this; },
        stop() { state = "stopped"; },
        getStatus() { return { state, confirmedPicks:0 }; },
        exportReceipts() { return []; },
      };
    },
  };
  const runnerApi = loadRunner(controllerApi, FixtureDate);
  let clearedTimeouts = 0;
  const environment = {
    Event: class Event { constructor(type) { this.type=type; } },
    clearInterval,
    clearTimeout(id) { clearedTimeouts += 1; clearTimeout(id); },
    crypto,
    document,
    location:{ pathname:"/draftclient/f1/99/6" },
    localStorage:storageFixture(),
    setInterval,
    setTimeout,
    SKRODZKaiYahooDraftController:controllerApi,
  };
  const runner = runnerApi.create({
    configName:"public_mock_15", executionMode:"MOCK", expectedRoomId:"99", expectedSeat:6, expectedUrlSeat:6,
    observedTeamCount:12, observedRosterSlots:mockConfig.rosterSlots, minimumFallbacks:5, pollMs:25,
    filterDeadlineMs:500, selectionHoldMs, replacementBySlot, board,
    assertRunnerLease:() => leaseState.current === true,
    runtimeAttestation:{ ok:true, version:"0.16.3", digest:"a".repeat(64), bootId:"boot-12345678", bootedAt:1 },
  }, environment);
  return { runner, board, getControllerTargets:() => controllerTargets, getControllerOptions:() => controllerOptions, getClearedTimeouts:() => clearedTimeouts, getRowReads:() => rowReads,
    setSignals(values) { ownedSignalState = values.owned ?? ownedSignalState; autodraftState = values.autodraft ?? autodraftState; queueState = values.queue ?? queueState; } };
}

test("between decisions a transient unreadable frame suspends actions without killing the run", async () => {
  for (const signals of [{owned:"INCONSISTENT"}, {autodraft:"UNKNOWN"}, {queue:"UNKNOWN"}]) {
    const fixture = integrationFixture({ownedSignalState:"OFF_TURN"});
    fixture.runner.start();
    try {
      fixture.setSignals(signals);
      await new Promise(resolve=>setTimeout(resolve, 65));
      assert.equal(fixture.runner.getStatus().state, "running");
      assert.equal(fixture.getRowReads(), 0, "uncertain monitor must not select filters or resolve players");
      assert.equal(fixture.getControllerTargets(), null);
      fixture.setSignals({owned:"OWNED",autodraft:"INACTIVE",queue:"EMPTY"});
      await waitFor(()=>fixture.runner.getStatus().pendingDecision);
    } finally { fixture.runner.halt("test_complete"); }
  }
});

test("uncertain observation cannot delay affirmative danger or survive beyond 250ms", async () => {
  for (const danger of [{autodraft:"ACTIVE"}, {autodraft:"UNKNOWN",queue:"NONEMPTY_OR_UNKNOWN"}, null]) {
    const fixture = integrationFixture({ownedSignalState:"OFF_TURN"});
    fixture.runner.start();
    try {
      fixture.setSignals({autodraft:"UNKNOWN"});
      await new Promise(resolve=>setTimeout(resolve, 40));
      if (danger) fixture.setSignals({autodraft:"INACTIVE",...danger});
      await waitFor(()=>fixture.runner.getStatus().state==="failed");
      assert.equal(fixture.getControllerTargets(), null);
      assert.match(fixture.runner.getStatus().failure.code, /autodraft|queue/);
    } finally { fixture.runner.halt("test_complete"); }
  }
});

test("conditional survival handles endpoints, long waits, and players already past ADP", () => {
  const p=helpers.validateBoard([player("RB",1,1,{adpLow:1,adpHigh:8})])[0];
  for (const [round,seat] of [[1,12],[2,1]]) {
    const current=helpers.overallPick(round,seat,12);
    assert.equal(helpers.survivalProbability(p,current+1,0,null,current),1);
  }
  const short=helpers.survivalProbability(p,102,0,null,100);
  const long=helpers.survivalProbability(p,124,0,null,100);
  assert.ok(short>long && short<1 && long>0);
  assert.equal(helpers.survivalProbability(p,null,0,null,100),0);
});

test("unknown state during an owned decision remains immediately terminal", async () => {
  const fixture=integrationFixture({selectionHoldMs:1200});
  fixture.runner.start();
  try {
    await waitFor(()=>fixture.runner.getStatus().pendingDecision);
    fixture.setSignals({autodraft:"UNKNOWN"});
    await waitFor(()=>fixture.runner.getStatus().state==="failed");
    assert.equal(fixture.getControllerTargets(),null);
    assert.equal(fixture.runner.getStatus().failure.code,"autodraft_state_unknown_monitor");
  } finally { fixture.runner.halt("test_complete"); }
});

test("TEST replacement values bind exact field size and starter slots", () => {
  for(const teams of [10,12]) {
    const config={...testConfig,teams};
    const binding={teamCount:teams,rosterSlots:config.rosterSlots.filter(s=>s!=="BN")};
    assert.equal(helpers.replacementFailure(config,binding),null);
    assert.equal(helpers.replacementFailure(config,{...binding,teamCount:11}),"test_replacement_room_mismatch");
    assert.equal(helpers.replacementFailure(config,{...binding,rosterSlots:["QB"]}),"test_replacement_room_mismatch");
    assert.equal(helpers.replacementFailure(config,null),"test_replacement_room_mismatch");
  }
});

test("a slow panel shortens the optional hold without relaxing the two-second click deadline", async () => {
  const fixture = integrationFixture({ selectionHoldMs:1200, readStallMs:900 });
  fixture.runner.start();
  try {
    await waitFor(() => fixture.runner.getStatus().pendingDecision);
    const pending = fixture.runner.getStatus().pendingDecision;
    const resolved = fixture.runner.exportReceipts().find((row) => row.kind === "runner_turn_resolved");
    assert.ok(resolved.panelReadyMs >= 900 && resolved.panelReadyMs < 1200);
    assert.equal(resolved.panelBudgetMs, 1200);
    assert.ok(pending.deadlineAt - pending.detectedAt <= 1752);
    assert.ok(pending.deadlineAt - pending.detectedAt - resolved.panelReadyMs < 900);
    assert.equal(fixture.runner.chooseOnClock(pending.targetYahooIds[0]), true);
    assert.ok(fixture.getControllerOptions().selectionDeadlineMs < 1100);
    assert.ok(fixture.getControllerOptions().selectionDeadlineMs > 0);
    assert.equal(fixture.getControllerOptions().minimumClockSeconds, 2);
  } finally { fixture.runner.halt(); }
});

test("runner creation refuses unknown Autodraft state or a nonempty Yahoo queue", () => {
  assert.throws(() => integrationFixture({ autodraftState:"UNKNOWN" }), /autodraft_state_unknown_at_create/);
  assert.throws(() => integrationFixture({ queueState:"NONEMPTY_OR_UNKNOWN" }), /yahoo_queue_not_empty_or_unknown_at_create/);
});

test("runner requires an acknowledged live lease and a five-second owned-turn clock margin", async () => {
  assert.throws(() => integrationFixture({ leaseState:{ current:false } }), /runner lease is required/);
  const fixture = integrationFixture({ draftClockSeconds:4 });
  fixture.runner.start();
  await waitFor(() => fixture.runner.getStatus().state === "failed");
  assert.match(fixture.runner.getStatus().failure.code, /draft_clock_margin_exhausted_at_detection/);
  assert.equal(fixture.getControllerTargets(), null);
});

test("runner lease loss before selection fails closed without constructing a controller", async () => {
  const leaseState = { current:true };
  const fixture = integrationFixture({ selectionHoldMs:100, leaseState });
  fixture.runner.start();
  await waitFor(() => fixture.runner.getStatus().pendingDecision);
  leaseState.current = false;
  await waitFor(() => fixture.runner.getStatus().state === "failed");
  assert.match(fixture.runner.getStatus().failure.code, /runner_lease_not_current/);
  assert.equal(fixture.getControllerTargets(), null);
});

test("runner fails closed on an inconsistent owned-turn signal", async () => {
  const fixture = integrationFixture({ ownedSignalState:"INCONSISTENT" });
  fixture.runner.start();
  await waitFor(() => fixture.runner.getStatus().state === "failed");
  assert.equal(fixture.runner.getStatus().failure.code, "owned_turn_signal_inconsistent");
  assert.equal(fixture.getControllerTargets(), null);
});

test("runner waits for a stable Yahoo player set after the filter settles", async () => {
  const fixture = integrationFixture({ unstableRows:true, selectionHoldMs:500 });
  fixture.runner.start();
  await waitFor(() => fixture.runner.getStatus().pendingDecision);
  const finalIds = new Set(fixture.board.slice(0, 20).map((player) => player.yahooId));
  assert.equal(fixture.getRowReads() >= 3, true);
  assert.equal(fixture.runner.getStatus().pendingDecision.targetYahooIds.every((yahooId) => finalIds.has(yahooId)), true);
  fixture.runner.halt();
});

test("final round accepts the remaining legal ladder while earlier rounds retain five fallbacks", () => {
  assert.equal(helpers.controllerMinimumAvailableTargets(18, [{}, {}], testConfig, 5), 5);
  assert.equal(helpers.controllerMinimumAvailableTargets(19, [{}, {}], testConfig, 5), 2);
});

test("on-clock exact choice starts immediately and keeps baseline fallbacks", async () => {
  const fixture = integrationFixture({ selectionHoldMs:500 });
  fixture.runner.start();
  await waitFor(() => fixture.runner.getStatus().pendingDecision);
  const pending = fixture.runner.getStatus().pendingDecision;
  const chosen = pending.targetYahooIds[1];
  const hotkeyStartedAt = Date.now();
  assert.equal(fixture.runner.chooseOnClock(chosen, "test_hotkey"), true);
  assert.equal(Date.now() - hotkeyStartedAt < 100, true);
  await waitFor(() => fixture.getControllerTargets());
  assert.equal(fixture.getControllerTargets()[0].yahooId, chosen);
  assert.equal(fixture.getControllerTargets().length >= 5, true);
  assert.equal(fixture.getClearedTimeouts() >= 1, true);
  const receipts = fixture.runner.exportReceipts();
  assert.equal(receipts.some((entry) => entry.kind === "runner_on_clock_choice_applied"), true);
  const resolved = receipts.find((entry) => entry.kind === "runner_turn_resolved");
  assert.equal(resolved.panelReadyMs < 250, true);
  assert.equal(resolved.decision.recomputeMs < 250, true);
  fixture.runner.halt();
});

test("invalid on-clock choice is receipted while the baseline remains armed", async () => {
  const fixture = integrationFixture({ selectionHoldMs:40 });
  fixture.runner.start();
  await waitFor(() => fixture.runner.getStatus().pendingDecision);
  const baseline = fixture.runner.getStatus().pendingDecision.targetYahooIds[0];
  assert.equal(fixture.runner.chooseOnClock("missing", "test_search"), false);
  await waitFor(() => fixture.getControllerTargets());
  assert.equal(fixture.getControllerTargets()[0].yahooId, baseline);
  assert.equal(fixture.runner.exportReceipts().some((entry) => entry.kind === "runner_on_clock_choice_rejected" && entry.baselineRetained), true);
  fixture.runner.halt();
});

test("kill switch during the decision window prevents every later controller start", async () => {
  const fixture = integrationFixture({ selectionHoldMs:80 });
  fixture.runner.start();
  await waitFor(() => fixture.runner.getStatus().pendingDecision);
  fixture.runner.halt("kill_switch");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(fixture.runner.getStatus().state, "halted");
  assert.equal(fixture.getControllerTargets(), null);
  assert.equal(fixture.runner.exportReceipts().filter((entry) => entry.kind === "runner_halted").length, 1);
});
