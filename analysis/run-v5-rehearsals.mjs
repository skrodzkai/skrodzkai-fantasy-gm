import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

import {
  auditLateRoundConcentration,
  reconcileSettingsAndYahoo,
  rehearseExactRoster,
} from "./draft-readiness.mjs";

function loadRuntime(boardSource, runnerSource) {
  const context = { console, crypto, Date, Math, setInterval, setTimeout, clearInterval };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(boardSource, context);
  vm.runInContext(runnerSource, context);
  return {
    board: [
      ...context.SKRODZKaiYahooMockBoard.offense,
      ...context.SKRODZKaiYahooMockBoard.kickers,
      ...context.SKRODZKaiYahooMockBoard.defenses,
      ...context.SKRODZKaiYahooMockBoard.idp,
    ],
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
  if (!Number.isFinite(low) || !Number.isFinite(high)) return Infinity;
  const earliest = Math.min(low, high);
  const latest = Math.max(low, high);
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
    const removeCount = Math.min(Math.max(0, candidates.length - 5), Math.floor(candidates.length * 0.2));
    for (const player of candidates.slice(0, removeCount)) unavailable.add(player.yahooId);
  }
  return unavailable;
}

function simulateOne({ board, helpers, config, seat, seed }) {
  const validated = helpers.validateBoard(board);
  const unavailableSpecialists = thinnedSpecialistIds(validated, seed);
  const picks = [];
  for (let round = 1; round <= config.rounds; round += 1) {
    const currentPick = helpers.overallPick(round, seat, config.teams);
    const opponentPicksBeforeTurn = Math.max(0, currentPick - round);
    const offenseCandidates = validated
      .filter((player) => ["QB", "RB", "WR", "TE"].includes(player.position))
      .filter((player) => !picks.some((pick) => pick.yahooId === player.yahooId));
    const boundedOpponentRemovals = Math.min(opponentPicksBeforeTurn, Math.max(0, offenseCandidates.length - 36));
    const draftedByOpponents = new Set(
      offenseCandidates
        .sort((left, right) => sampledMarketPick(left, seed) - sampledMarketPick(right, seed) || left.rank - right.rank)
        .slice(0, boundedOpponentRemovals)
        .map((player) => player.yahooId),
    );
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
      });
    } catch (error) {
      const allowed = helpers.allowedPositions(round, picks, config, seat);
      const visible = Object.fromEntries(allowed.map((position) => [position, availablePlayers.filter((player) => player.position === position).length]));
      throw new Error(`seat_${seat}_seed_${seed}_round_${round}:${String(error?.message ?? error)}:${JSON.stringify({ allowed, visible, counts: rosterShape(picks) })}`);
    }
    const selected = decision.targets[0];
    picks.push({ ...selected, round, latencyMs: 1 + Math.round(sampleUnit(seed + round, selected.yahooId) * 4) });
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
  const { board, runner } = loadRuntime(boardSource, runnerSource);
  const config = runner.configs.test_league_19_idp;
  const helpers = runner._test;
  const simulations = Array.from({ length: 12 }, (_, index) => index + 1)
    .flatMap((seat) => seeds.map((seed) => simulateOne({ board, helpers, config, seat, seed })));
  const concentration = auditLateRoundConcentration(simulations, {
    lateRound: 14,
    positions: ["K", "DEF", "D", "LB", "DB"],
    minSamples: simulations.length,
    minSimulationCount: simulations.length,
    minPositionCoverage: 1,
    maxConcentration: 0.34,
    maxRoundConcentration: 0.67,
    minEntropy: 0.95,
  });
  const reference = simulations[0];
  const shape = rosterShape(reference.picks);
  const duplicatePicks = reference.picks.map((pick) => ({ ...pick }));
  duplicatePicks[1].yahooId = duplicatePicks[0].yahooId;
  const latePicks = reference.picks.map((pick) => ({ ...pick }));
  latePicks[0].latencyMs = 11;
  const identityChaos = reconcileSettingsAndYahoo({
    settings: { leagueKey: "18599", teamKey: "12", seat: reference.seat, requireReadOnly: true },
    yahoo: { leagueKey: "18599", teamKey: "wrong", seat: reference.seat, readOnly: true, eligiblePlayerIds: [] },
  });
  const chaos = {
    wrongTeamIdentity: { pass: identityChaos.status === "LOCKED", observed: identityChaos },
    duplicatePick: { pass: rehearseExactRoster({ picks: duplicatePicks, rosterShape: shape, latencyBudgetMs: 10 }).status === "LOCKED" },
    lateDecision: { pass: rehearseExactRoster({ picks: latePicks, rosterShape: shape, latencyBudgetMs: 10 }).status === "LOCKED" },
  };
  return {
    schemaVersion: 1,
    generatedAt,
    basis: "current executable board with deterministic ADP-range offense removals, a 36-player offense reserve, and deterministic 20% specialist thinning while retaining at least five fallbacks per required slot; this tests ladder/roster mechanics, not actual opponent selections; specialists remain policy-timing tests, not projection-edge claims",
    simulations: simulations.length,
    seats: 12,
    seeds,
    validRosters: simulations.filter((simulation) => simulation.validRoster).length,
    concentration,
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
  process.stdout.write(`${JSON.stringify({ output: args.output, simulations: report.simulations, validRosters: report.validRosters, concentrationPass: report.concentration.accepted, chaosPass: Object.values(report.rehearsals.chaos).every((scenario) => scenario.pass) })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
