import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { reconcileSettingsAndYahoo } from "./draft-readiness.mjs";

export function loadRuntime(boardSource, runnerSource) {
  const startedAt = performance.now();
  const context = { console, crypto, Date, Math, setInterval, setTimeout, clearInterval };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(boardSource, context);
  vm.runInContext(runnerSource, context);
  const forbiddenGlobals = ["fetch", "document", "window", "XMLHttpRequest", "WebSocket", "process", "require", "module", "Buffer"]
    .filter((key) => key in context);
  const boardData = context.SKRODZKaiYahooMockBoard;
  const source = Array.isArray(boardData.players)
    ? boardData.players
    : [...boardData.offense, ...boardData.kickers, ...boardData.defenses, ...boardData.idp];
  return {
    board: [...new Map(source.map((player) => [String(player.yahooId), player])).values()],
    replacementBySlot: boardData.replacementBySlot,
    survivalCalibration: boardData.survivalCalibration ?? null,
    scoringSchemaHash: boardData.scoringSchemaHash ?? null,
    scoringIdentity: { leagueId:boardData.leagueId, scoringModel:boardData.scoringModel, scoringSchemaHash:boardData.scoringSchemaHash },
    runnerSourceSha256: createHash("sha256").update(runnerSource).digest("hex"),
    coldStartMs: performance.now() - startedAt,
    forbiddenVmGlobals: forbiddenGlobals,
    runner: context.SKRODZKaiYahooMockRunner,
  };
}

function sampleUnit(seed, yahooId) {
  let value = (seed ^ 0x9e3779b9) >>> 0;
  for (const character of String(yahooId)) value = Math.imul(value ^ character.charCodeAt(0), 2654435761) >>> 0;
  value ^= value >>> 16;
  return (value >>> 0) / 0x100000000;
}

function sampledMarketPick(player, seed) {
  const low = player.adpEarliest ?? player.adpLow;
  const high = player.adpLatest ?? player.adpHigh;
  const observed = Number.isFinite(low) && Number.isFinite(high);
  const earliest = observed ? Math.min(low, high) : Number(player.marketMean ?? player.rank ?? 999);
  const latest = observed ? Math.max(low, high) : earliest + 36;
  return earliest + sampleUnit(seed, player.yahooId) * (latest - earliest);
}

function rosterShape(picks) {
  const counts = {};
  for (const pick of picks) counts[pick.position] = (counts[pick.position] ?? 0) + 1;
  return counts;
}

function thinnedSpecialistIds(board, seed) {
  const unavailable = new Set();
  for (const position of ["K", "DEF", "D", "LB", "CB", "S"]) {
    const candidates = board
      .filter((player) => player.position === position)
      .sort((left, right) => sampleUnit(seed + position.length, left.yahooId) - sampleUnit(seed + position.length, right.yahooId));
    const removeCount = Math.min(Math.max(0, candidates.length - 5), Math.floor(candidates.length * 0.1));
    for (const player of candidates.slice(0, removeCount)) unavailable.add(player.yahooId);
  }
  return unavailable;
}

export function chooseOpponentPlayer({ marketOrder, drafted, picks, config, helpers }) {
  return marketOrder.find((player) => player.manualEligible === true &&
    !drafted.some((pick) => pick.yahooId === player.yahooId || helpers.sameRosterIdentity(pick, player)) &&
    helpers.canCompleteRoster({ player, picks, config })) ?? null;
}

export function simulateOne({ board, helpers, config, replacementBySlot, survivalCalibration, seat, seed }) {
  const validated = helpers.validateBoard(board);
  const unavailableSpecialists = thinnedSpecialistIds(validated, seed);
  const picks = [];
  const opponentPicks = [];
  const draftedByOpponents = new Set();
  const opponentRosters = new Map(Array.from({ length:config.teams }, (_, index) => [index + 1, []]).filter(([otherSeat]) => otherSeat !== seat));
  const marketOrder = validated.filter((player) => !unavailableSpecialists.has(player.yahooId))
    .sort((left, right) => sampledMarketPick(left, seed) - sampledMarketPick(right, seed) || left.rank - right.rank);
  let lastOverallPick = 0;
  const draftOpponentsThrough = (lastPick) => {
    for (let overall = lastOverallPick + 1; overall <= lastPick; overall += 1) {
      const otherRound = Math.floor((overall - 1) / config.teams) + 1;
      const offset = (overall - 1) % config.teams;
      const otherSeat = otherRound % 2 ? offset + 1 : config.teams - offset;
      const roster = opponentRosters.get(otherSeat);
      if (!roster) throw new Error(`opponent_simulation_crossed_owned_pick:${overall}`);
      const player = chooseOpponentPlayer({ marketOrder, drafted:[...picks, ...opponentPicks], picks:roster, config, helpers });
      if (!player) throw new Error(`opponent_roster_cannot_complete:seat_${otherSeat}:pick_${overall}`);
      roster.push(player);
      draftedByOpponents.add(player.yahooId);
      opponentPicks.push({ ...player, seat:otherSeat, round:otherRound, overallPick:overall });
    }
    lastOverallPick = lastPick;
  };
  for (let round = 1; round <= config.rounds; round += 1) {
    const currentPick = helpers.overallPick(round, seat, config.teams);
    draftOpponentsThrough(currentPick - 1);
    const availablePlayers = validated
      .filter((player) => !picks.some((pick) => pick.yahooId === player.yahooId))
      .filter((player) => !draftedByOpponents.has(player.yahooId))
      .filter((player) => !opponentPicks.some((pick) => helpers.sameRosterIdentity(pick, player)))
      .filter((player) => !unavailableSpecialists.has(player.yahooId))
      .map((player) => ({ yahooId: player.yahooId, name: player.name, position: player.position, team: player.team }));
    let decision;
    try {
      decision = helpers.buildDecisionLadder({
        round,
        seat,
        picks,
        board: validated,
        availablePlayers,
        minimum: 5,
        config,
        replacementBySlot,
        survivalCalibration,
        // Match the shipped runner: no observed live run-pressure input exists.
        runPressureByPosition: {},
      });
    } catch (error) {
      const allowed = helpers.allowedPositions(round, picks, config, seat);
      const visible = Object.fromEntries(allowed.map((position) => [position, availablePlayers.filter((player) => player.position === position).length]));
      throw new Error(`seat_${seat}_seed_${seed}_round_${round}:${String(error?.message ?? error)}:${JSON.stringify({ allowed, visible, counts: rosterShape(picks), picks: picks.map((pick) => ({ yahooId:pick.yahooId, position:pick.position, eligible:pick.eligible })) })}`);
    }
    const selected = decision.targets[0];
    picks.push({
      ...selected,
      round,
      utilityModel: decision.decision.utilityModel,
      recomputeMs: decision.decision.recomputeMs,
      fallbackUsed: decision.decision.fallbackUsed,
      pAvailableNext: decision.decision.positionLeaders[0]?.pAvailableNext ?? null,
      marginalUtility: decision.decision.positionLeaders[0]?.marginalUtility ?? null,
      ladder: decision.targets.map((target, index) => ({
        yahooId: target.yahooId,
        name: target.name,
        position: target.position,
        marginalUtility: decision.decision.positionLeaders[index]?.marginalUtility ?? null,
        expectedNextUtility: decision.decision.positionLeaders[index]?.expectedNextUtility ?? null,
        decisionScore: decision.decision.positionLeaders[index]?.adjustedScore ?? null,
        pAvailableNext: decision.decision.positionLeaders[index]?.pAvailableNext ?? null,
      })),
    });
    lastOverallPick = currentPick;
  }
  draftOpponentsThrough(config.teams * config.rounds);
  return {
    simulationId: `seat-${seat}-seed-${seed}`,
    teamCount: config.teams,
    seat,
    seed,
    validRoster: helpers.validateCompletedRoster(picks, config),
    specialistUnavailableCount: unavailableSpecialists.size,
    counts: rosterShape(picks),
    picks,
    opponents: [...opponentRosters].map(([opponentSeat, roster]) => ({
      seat:opponentSeat,
      validRoster:helpers.maximumFilledStarterSlots(roster, config) === config.rosterSlots.filter((slot) => !["BN", "IR"].includes(slot)).length && roster.length === config.rounds,
      picks:opponentPicks.filter((pick) => pick.seat === opponentSeat).map(({ yahooId, name, position, eligible, automaticEligible, round, overallPick }) => ({ yahooId, name, position, eligible, automaticEligible, round, overallPick })),
    })),
  };
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function lateRoundDistribution(simulations, lateRound = 14) {
  const picks = simulations.flatMap((simulation) => simulation.picks.filter((pick) => pick.round >= lateRound));
  const counts = rosterShape(picks);
  return { lateRound, counts, total: picks.length };
}

function openingDistribution(simulations) {
  const bySeat = {};
  for (const simulation of simulations) {
    const key = String(simulation.seat);
    bySeat[key] ??= {};
    const opening = simulation.picks.slice(0, 4).map((pick) => pick.position).join("-");
    bySeat[key][opening] = (bySeat[key][opening] ?? 0) + 1;
  }
  return bySeat;
}

function specialistTimingPass(simulation, config) {
  const specialists = simulation.picks.filter((pick) => ["K", "DEF", "D", "LB", "CB", "S"].includes(pick.position));
  const kDef = specialists.filter((pick) => ["K", "DEF"].includes(pick.position));
  const idp = specialists.filter((pick) => ["D", "LB", "CB", "S"].includes(pick.position));
  return kDef.every((pick) => pick.round >= 15) &&
    idp.every((pick) => pick.round >= 17) &&
    kDef.filter((pick) => pick.round <= 16).length === 2 &&
    idp.length === Number(config.categoryLimits?.IDP ?? 0);
}

export function buildRehearsalReport({ boardSource, runnerSource, generatedAt, seeds = [2026, 2027, 2028, 2029, 2030] }) {
  const { board, replacementBySlot, survivalCalibration, scoringSchemaHash, runnerSourceSha256, coldStartMs, forbiddenVmGlobals, runner } = loadRuntime(boardSource, runnerSource);
  const config = runner.configs.real_league_19_idp;
  const helpers = runner._test;
  if (!replacementBySlot || !Object.keys(replacementBySlot).length) throw new Error("extension board is missing joint replacement baselines");
  const simulations = Array.from({ length: 12 }, (_, index) => index + 1)
    .flatMap((seat) => seeds.map((seed) => simulateOne({ board, helpers, config, replacementBySlot, survivalCalibration, seat, seed })));
  const contingencies = [10, 11, 12].flatMap((teams) => {
    const contingencyConfig = { ...runner.configs.test_league_19_idp, teams };
    return Array.from({ length:teams }, (_, index) => index + 1)
      .map((seat) => simulateOne({ board, helpers, config:contingencyConfig, replacementBySlot, survivalCalibration, seat, seed:2026 }));
  });
  const reference = simulations[0];
  const identityChaos = reconcileSettingsAndYahoo({
    settings: { leagueKey: "542830", teamKey: "3", seat: reference.seat, requireReadOnly: true },
    yahoo: { leagueKey: "542830", teamKey: "wrong", seat: reference.seat, readOnly: true, eligiblePlayerIds: [] },
  });
  const duplicateProbeBoard = helpers.validateBoard(board);
  const duplicateProbe = helpers.buildDecisionLadder({
    round: 2,
    seat: reference.seat,
    picks: [reference.picks[0]],
    board: duplicateProbeBoard,
    availablePlayers: duplicateProbeBoard,
    minimum: 5,
    config,
    replacementBySlot,
    survivalCalibration,
  });
  const recomputeValues = simulations.flatMap((simulation) => simulation.picks.map((pick) => pick.recomputeMs));
  const latency = {
    scope: "offline-compute-only",
    draftClockSeconds: 30,
    ownedTurnBudgetMs: 2000,
    coldStartMs,
    recomputeP50Ms: percentile(recomputeValues, 0.5),
    recomputeP95Ms: percentile(recomputeValues, 0.95),
    recomputeMaxMs: recomputeValues.length ? Math.max(...recomputeValues) : null,
    recomputeBudgetMs: helpers.decisionRecomputeBudgetMs,
    fallbackCount: simulations.flatMap((simulation) => simulation.picks).filter((pick) => pick.fallbackUsed).length,
    fallbackContract: "fail closed before any Yahoo click",
  };
  const allowedFirst = helpers.allowedPositions(1, [], config, 1);
  const allowedLast = helpers.allowedPositions(config.rounds, [], config, 12);
  const policyChecks = {
    allPositionFilterEveryRound: helpers.filterLabelForRound(1, [], config, 1) === "All Positions" && helpers.filterLabelForRound(config.rounds, [], config, 12) === "All Positions",
    allPositionsRemainVisibleAcrossRounds: JSON.stringify(allowedFirst) === JSON.stringify(allowedLast),
    specialistTimingContained: simulations.every((simulation) => specialistTimingPass(simulation, config)),
    weeklyUtilityEveryRound: simulations.every((simulation) => simulation.picks.every((pick) => pick.utilityModel === "WEEKLY_OPTIMAL_LINEUP_W1_17")),
    jointReplacementBaselinesPresent: Object.keys(replacementBySlot).length >= 10,
    dualRoleNeverAutoSelected: simulations.every((simulation) => simulation.picks.every((pick) => pick.name !== "Travis Hunter" && !["41787", "99001", "99002"].includes(String(pick.yahooId)))),
    realLeagueExecutionDisabled: config.qualification === "unverified-real-room",
    vmExecutionGlobalsAbsent: forbiddenVmGlobals.length === 0,
    scoringSchemaReceipted: /^[a-f0-9]{64}$/.test(String(scoringSchemaHash ?? "")),
    minimumThreeRunningBacks: simulations.every((simulation) => Number(simulation.counts.RB ?? 0) >= 3),
    rosterConstructionVaries: new Set(simulations.map((simulation) => JSON.stringify(simulation.counts))).size > 1,
    thirdTightEndNotDeterministic: simulations.some((simulation) => Number(simulation.counts.TE ?? 0) < 3),
    opponentRostersValid: simulations.every((simulation) => simulation.opponents.every((opponent) => opponent.validRoster)),
  };
  const chaos = {
    wrongTeamIdentity: { pass: identityChaos.status === "LOCKED", observed: identityChaos },
    duplicatePick: {
      pass: duplicateProbe.targets.every((target) => String(target.yahooId) !== String(reference.picks[0].yahooId)),
      rejectedYahooId: reference.picks[0].yahooId,
    },
    incompleteRoster: { pass: helpers.validateCompletedRoster(reference.picks.slice(0, -1), config) === false },
  };
  const validRosters = simulations.filter((simulation) => simulation.validRoster).length;
  const acceptanceGates = {
    simulationCount: simulations.length === 60,
    allRostersValid: validRosters === simulations.length,
    everyPickWithinOwnedTurnBudget: latency.recomputeMaxMs < latency.ownedTurnBudgetMs,
    zeroDecisionFallbacks: latency.fallbackCount === 0,
    teamCountContingencies: contingencies.length === 33 && contingencies.every((simulation) => simulation.validRoster && specialistTimingPass(simulation, runner.configs.test_league_19_idp)),
    policyChecks: Object.values(policyChecks).every(Boolean),
    chaosChecks: Object.values(chaos).every((scenario) => scenario.pass),
  };
  const accepted = Object.values(acceptanceGates).every(Boolean);
  return {
    schemaVersion: 4,
    generatedAt,
    basis: "2 Minute Drillers roster-shape feasibility and compute latency, not predictive draft quality or live proof. Opponents select in deterministic market order from manual-eligible identities, independent of our automatic injury/validation policy; per-seat legal completion uses explicit modelling caps, not observed Yahoo position limits. No opponent round script. Includes uncalibrated rank fallback and 10% specialist stress thinning; live run pressure is zero as deployed. REAL execution remains disabled.",
    accepted,
    simulations: simulations.length,
    seats: 12,
    seeds,
    nodeVersion: process.version,
    scoringSchemaHash,
    runnerSourceSha256,
    validRosters,
    latency,
    acceptanceGates,
    policyChecks,
    lateRoundDistribution: lateRoundDistribution(simulations),
    openingDistribution: openingDistribution(simulations),
    teamCountContingencies: {
      evidenceClass:"TEST_ROSTER_SHAPE_ONLY_NOT_REAL_SCORING_QUALIFICATION",
      simulations:contingencies.length,
      byTeams:Object.fromEntries([10, 11, 12].map((teams) => [teams, {
        simulations:contingencies.filter((simulation) => simulation.teamCount === teams).length,
        validRosters:contingencies.filter((simulation) => simulation.teamCount === teams && simulation.validRoster).length,
      }])),
      accepted:contingencies.length === 33 && contingencies.every((simulation) => simulation.validRoster && specialistTimingPass(simulation, runner.configs.test_league_19_idp)),
    },
    rehearsals: { validReference: reference.validRoster, chaos },
    teams: simulations.map((simulation) => ({
      simulationId: simulation.simulationId,
      seat: simulation.seat,
      opponents: simulation.opponents,
      seed: simulation.seed,
      specialistUnavailableCount: simulation.specialistUnavailableCount,
      counts: simulation.counts,
      picks: simulation.picks,
    })),
  };
}

// The old replay used a fake click controller and treated disappearing rows as
// opponent picks. Production runner/controller and kill-switch tests now own
// that proof; this CLI must not turn an unverified TEST schema into readiness.
export async function replayRunnerLoop({ boardSource, runnerSource }) {
  const runtime = loadRuntime(boardSource, runnerSource);
  const failure = runtime.runner.decision.scoringFailure(runtime.runner.configs.test_league_19_idp, runtime.scoringIdentity);
  return { evidenceClass:"OFFLINE_RUNNER_LOOP_REPLAY", yahooLiveDraft:false, yahooTestLeagueCleanAutomationPass:false,
    accepted:false, status:failure ? "LOCKED" : "NOT_RUN",
    failure:failure ?? "runner_loop_retired_use_production_controller_tests", completion:null };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((entry) => {
    const [key, ...value] = entry.split("=");
    return [key.replace(/^--/, ""), value.join("=")];
  }));
  for (const required of ["board", "runner", "output", "generated-at"]) {
    if (!args[required]) throw new Error(`missing --${required}=...`);
  }
  const [boardSource, runnerSource] = await Promise.all([readFile(args.board, "utf8"), readFile(args.runner, "utf8")]);
  const runnerLoopEvidence = await replayRunnerLoop({ boardSource, runnerSource });
  const report = buildRehearsalReport({ boardSource, runnerSource, generatedAt: args["generated-at"] });
  report.runnerLoopEvidence = runnerLoopEvidence;
  await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output: args.output, accepted: report.accepted, runnerLoopAccepted: report.runnerLoopEvidence.accepted, acceptanceGates: report.acceptanceGates, simulations: report.simulations, validRosters: report.validRosters, recomputeP95Ms: report.latency.recomputeP95Ms, fallbackCount: report.latency.fallbackCount, chaosPass: Object.values(report.rehearsals.chaos).every((scenario) => scenario.pass) })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
