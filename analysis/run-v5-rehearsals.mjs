import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

import { reconcileSettingsAndYahoo } from "./draft-readiness.mjs";

function loadRuntime(boardSource, runnerSource) {
  const context = { console, crypto, Date, Math, setInterval, setTimeout, clearInterval };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(boardSource, context);
  vm.runInContext(runnerSource, context);
  const boardData = context.SKRODZKaiYahooMockBoard;
  const source = Array.isArray(boardData.players)
    ? boardData.players
    : [...boardData.offense, ...boardData.kickers, ...boardData.defenses, ...boardData.idp];
  return {
    board: [...new Map(source.map((player) => [String(player.yahooId), player])).values()],
    replacementBySlot: boardData.replacementBySlot,
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

function pressureFromRecentPicks(recentPicks) {
  const counts = rosterShape(recentPicks);
  return Object.fromEntries(Object.entries(counts).map(([position, count]) => [position, Math.min(2, Math.max(-2, (count - 1) / 2))]));
}

function simulateOne({ board, helpers, config, replacementBySlot, seat, seed }) {
  const validated = helpers.validateBoard(board);
  const unavailableSpecialists = thinnedSpecialistIds(validated, seed);
  const picks = [];
  const opponentPicks = [];
  const draftedByOpponents = new Set();
  for (let round = 1; round <= config.rounds; round += 1) {
    const currentPick = helpers.overallPick(round, seat, config.teams);
    const opponentPicksBeforeTurn = Math.max(0, currentPick - round);
    const requiredOpponentPicks = opponentPicksBeforeTurn - opponentPicks.length;
    const opponentPool = validated
      .filter((player) => player.automaticEligible !== false)
      .filter((player) => !picks.some((pick) => pick.yahooId === player.yahooId))
      .filter((player) => !draftedByOpponents.has(player.yahooId))
      .filter((player) => !unavailableSpecialists.has(player.yahooId))
      .sort((left, right) => sampledMarketPick(left, seed) - sampledMarketPick(right, seed) || left.rank - right.rank);
    for (const player of opponentPool.slice(0, requiredOpponentPicks)) {
      draftedByOpponents.add(player.yahooId);
      opponentPicks.push(player);
    }
    const availablePlayers = validated
      .filter((player) => !picks.some((pick) => pick.yahooId === player.yahooId))
      .filter((player) => !draftedByOpponents.has(player.yahooId))
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
        runPressureByPosition: pressureFromRecentPicks(opponentPicks.slice(-12)),
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
  }
  return {
    simulationId: `seat-${seat}-seed-${seed}`,
    seat,
    seed,
    validRoster: helpers.validateCompletedRoster(picks, config),
    specialistUnavailableCount: unavailableSpecialists.size,
    counts: rosterShape(picks),
    picks,
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

export function buildRehearsalReport({ boardSource, runnerSource, generatedAt, seeds = [2026, 2027, 2028, 2029, 2030] }) {
  const { board, replacementBySlot, runner } = loadRuntime(boardSource, runnerSource);
  const config = runner.configs.real_league_19_idp;
  const helpers = runner._test;
  if (!replacementBySlot || !Object.keys(replacementBySlot).length) throw new Error("extension board is missing joint replacement baselines");
  const simulations = Array.from({ length: 12 }, (_, index) => index + 1)
    .flatMap((seat) => seeds.map((seed) => simulateOne({ board, helpers, config, replacementBySlot, seat, seed })));
  const reference = simulations[0];
  const identityChaos = reconcileSettingsAndYahoo({
    settings: { leagueKey: "18599", teamKey: "12", seat: reference.seat, requireReadOnly: true },
    yahoo: { leagueKey: "18599", teamKey: "wrong", seat: reference.seat, readOnly: true, eligiblePlayerIds: [] },
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
  });
  const recomputeValues = simulations.flatMap((simulation) => simulation.picks.map((pick) => pick.recomputeMs));
  const latency = {
    recomputeP95Ms: percentile(recomputeValues, 0.95),
    recomputeBudgetMs: 100,
    fallbackCount: simulations.flatMap((simulation) => simulation.picks).filter((pick) => pick.fallbackUsed).length,
    fallbackContract: "static verified value order",
  };
  const allowedFirst = helpers.allowedPositions(1, [], config, 1);
  const allowedLast = helpers.allowedPositions(config.rounds, [], config, 12);
  const policyChecks = {
    allPositionFilterEveryRound: helpers.filterLabelForRound(1, [], config, 1) === "All Positions" && helpers.filterLabelForRound(config.rounds, [], config, 12) === "All Positions",
    noRoundDependentPositionGate: JSON.stringify(allowedFirst) === JSON.stringify(allowedLast),
    jointReplacementBaselinesPresent: Object.keys(replacementBySlot).length >= 10,
    dualRoleNeverAutoSelected: simulations.every((simulation) => simulation.picks.every((pick) => String(pick.yahooId) !== "41787")),
    realLeagueExecutionDisabled: config.qualification === "unverified-real-room",
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
  const accepted = simulations.length === 60 && validRosters === simulations.length &&
    latency.recomputeP95Ms < latency.recomputeBudgetMs &&
    Object.values(policyChecks).every(Boolean) && Object.values(chaos).every((scenario) => scenario.pass);
  return {
    schemaVersion: 2,
    generatedAt,
    basis: "actual 2 Minute Drillers 19-round roster shape over the current executable unified board, with deterministic observed-ADP removals, explicitly uncalibrated Yahoo-rank fallback where ADP is absent, and 10% deterministic specialist stress thinning; this is offline policy, feasibility, and latency evidence only and does not enable real league 420010",
    accepted,
    simulations: simulations.length,
    seats: 12,
    seeds,
    validRosters,
    latency,
    policyChecks,
    lateRoundDistribution: lateRoundDistribution(simulations),
    openingDistribution: openingDistribution(simulations),
    rehearsals: { validReference: reference.validRoster, chaos },
    teams: simulations.map((simulation) => ({
      simulationId: simulation.simulationId,
      seat: simulation.seat,
      seed: simulation.seed,
      specialistUnavailableCount: simulation.specialistUnavailableCount,
      counts: simulation.counts,
      picks: simulation.picks,
    })),
  };
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
  const report = buildRehearsalReport({ boardSource, runnerSource, generatedAt: args["generated-at"] });
  await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output: args.output, accepted: report.accepted, simulations: report.simulations, validRosters: report.validRosters, recomputeP95Ms: report.latency.recomputeP95Ms, fallbackCount: report.latency.fallbackCount, chaosPass: Object.values(report.rehearsals.chaos).every((scenario) => scenario.pass) })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
