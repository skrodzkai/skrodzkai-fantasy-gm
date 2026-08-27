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

function pressureFromRecentPicks(recentPicks) {
  const counts = rosterShape(recentPicks);
  return Object.fromEntries(Object.entries(counts).map(([position, count]) => [position, Math.min(2, Math.max(-2, (count - 1) / 2))]));
}

function simulateOne({ board, helpers, config, replacementBySlot, survivalCalibration, seat, seed }) {
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
      .filter((player) => player.automaticEligible === true)
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
        survivalCalibration,
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
  const { board, replacementBySlot, survivalCalibration, scoringSchemaHash, runnerSourceSha256, coldStartMs, forbiddenVmGlobals, runner } = loadRuntime(boardSource, runnerSource);
  const config = runner.configs.real_league_19_idp;
  const helpers = runner._test;
  if (!replacementBySlot || !Object.keys(replacementBySlot).length) throw new Error("extension board is missing joint replacement baselines");
  const simulations = Array.from({ length: 12 }, (_, index) => index + 1)
    .flatMap((seat) => seeds.map((seed) => simulateOne({ board, helpers, config, replacementBySlot, survivalCalibration, seat, seed })));
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
    recomputeBudgetMs: 100,
    fallbackCount: simulations.flatMap((simulation) => simulation.picks).filter((pick) => pick.fallbackUsed).length,
    fallbackContract: "static verified value order",
  };
  const allowedFirst = helpers.allowedPositions(1, [], config, 1);
  const allowedLast = helpers.allowedPositions(config.rounds, [], config, 12);
  const policyChecks = {
    allPositionFilterEveryRound: helpers.filterLabelForRound(1, [], config, 1) === "All Positions" && helpers.filterLabelForRound(config.rounds, [], config, 12) === "All Positions",
    noRoundDependentPositionGate: JSON.stringify(allowedFirst) === JSON.stringify(allowedLast),
    weeklyUtilityEveryRound: simulations.every((simulation) => simulation.picks.every((pick) => pick.utilityModel === "WEEKLY_OPTIMAL_LINEUP_W1_17")),
    jointReplacementBaselinesPresent: Object.keys(replacementBySlot).length >= 10,
    dualRoleNeverAutoSelected: simulations.every((simulation) => simulation.picks.every((pick) => pick.name !== "Travis Hunter" && !["41787", "99001", "99002"].includes(String(pick.yahooId)))),
    realLeagueExecutionDisabled: config.qualification === "unverified-real-room",
    vmExecutionGlobalsAbsent: forbiddenVmGlobals.length === 0,
    scoringSchemaReceipted: /^[a-f0-9]{64}$/.test(String(scoringSchemaHash ?? "")),
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
    policyChecks: Object.values(policyChecks).every(Boolean),
    chaosChecks: Object.values(chaos).every((scenario) => scenario.pass),
  };
  const accepted = Object.values(acceptanceGates).every(Boolean);
  return {
    schemaVersion: 3,
    generatedAt,
    basis: "actual 2 Minute Drillers 19-round roster shape over the current executable unified board, with deterministic observed-ADP removals, explicitly uncalibrated Yahoo-rank fallback where ADP is absent, and 10% deterministic specialist stress thinning; this is offline policy, feasibility, and latency evidence only and does not enable real league 420010",
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

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("runner_loop_replay_timeout");
}

function runnerLoopEnvironment(runtime, seat) {
  const config = runtime.runner.configs.test_league_19_idp;
  const validated = runtime.runner._test.validateBoard(runtime.board);
  const state = { filled: 0 };
  const select = { value: "all", options: [{ value: "all", textContent: "All Positions" }], dispatchEvent() {} };
  const rows = ["QB", "RB", "WR", "TE", "K", "DEF", "D", "LB", "CB", "S"]
    .flatMap((position) => validated.filter((player) => player.position === position && player.automaticEligible !== false).slice(0, 12))
    .map((player) => ({ player }));
  const body = {};
  Object.defineProperty(body, "innerText", { get: () => `${state.filled} / ${config.rosterTotal}` });
  const document = {
    body,
    querySelectorAll(selector) {
      if (selector === "select") return [select];
      if (selector === "tr") return rows;
      return [];
    },
  };
  const runtimeHooks = {
    parseRoom: () => ({ roomId: "18599", seat: 12 }),
    parseRosterCount: () => ({ filled: state.filled, total: config.rosterTotal }),
    isAutodraftActive: () => false,
    readOwnedTurn: () => {
      if (state.filled >= config.rounds) return null;
      const round = state.filled + 1;
      const pick = runtime.runner._test.overallPick(round, seat, config.teams);
      return { label: `R${round}P${pick}`, round, pick };
    },
    readPlayerRow: (row) => row.player,
  };
  const controllerApi = {
    runtime: runtimeHooks,
    create(options) {
      const receipts = [];
      let controllerState = "created";
      let confirmedPicks = 0;
      return {
        start() {
          const target = options.targets[0];
          const turn = runtimeHooks.readOwnedTurn();
          controllerState = "running";
          state.filled += 1;
          confirmedPicks = 1;
          receipts.push({ kind: "draft_click", yahooId: target.yahooId, detectionToClickMs: 1 });
          receipts.push({
            kind: "pick_confirmed",
            yahooId: target.yahooId,
            name: target.name,
            team: target.team,
            turn: turn.label,
            clickToConfirmationMs: 1,
            rosterAfter: { filled: state.filled, total: config.rosterTotal },
          });
          return this;
        },
        stop() { controllerState = "stopped"; },
        getStatus() { return { state: controllerState, confirmedPicks }; },
        exportReceipts() { return receipts.slice(); },
      };
    },
  };
  const environment = {
    Event: class Event { constructor(type) { this.type = type; } },
    clearInterval,
    crypto,
    document,
    location: { pathname: "/draftclient/f1/18599/12" },
    localStorage: memoryStorage(),
    setInterval,
    setTimeout,
    SKRODZKaiYahooDraftController: controllerApi,
  };
  return { config, environment };
}

function createReplayRunner(runtime, seat, selectionHoldMs) {
  const { config, environment } = runnerLoopEnvironment(runtime, seat);
  const runner = runtime.runner.create({
    configName: "test_league_19_idp",
    executionMode: "TEST",
    expectedRoomId: "18599",
    expectedSeat: seat,
    expectedUrlSeat: 12,
    observedTeamCount: 12,
    observedRosterSlots: config.rosterSlots,
    minimumFallbacks: 5,
    pollMs: 25,
    filterDeadlineMs: 500,
    selectionHoldMs,
    replacementBySlot: runtime.replacementBySlot,
    survivalCalibration: runtime.survivalCalibration,
    board: runtime.board,
  }, environment);
  return { runner };
}

export async function replayRunnerLoop({ boardSource, runnerSource, seat = 6 }) {
  const runtime = loadRuntime(boardSource, runnerSource);
  const completion = createReplayRunner(runtime, seat, 100);
  completion.runner.start();
  let overrideApplied = false;
  await waitFor(() => {
    const status = completion.runner.getStatus();
    if (!overrideApplied && status.pendingDecision?.targetYahooIds?.length > 1) {
      overrideApplied = completion.runner.chooseOnClock(status.pendingDecision.targetYahooIds[1], "replay_operator_override");
    }
    if (["failed", "halted", "stopped"].includes(status.state)) throw new Error(`runner_loop_completion_${status.state}:${status.failure?.code ?? "unknown"}`);
    return status.state === "completed" ? status : null;
  });
  const completionReceipts = completion.runner.exportReceipts();
  const turnReceipts = completionReceipts.filter((entry) => entry.kind === "runner_turn_resolved");
  const failureCodes = completionReceipts
    .filter((entry) => entry.kind === "runner_failed")
    .map((entry) => entry.code ?? entry.failure ?? "runner_failed");
  const forbiddenFailures = ["panel_ready_budget_exhausted", "turn_to_click_budget_exhausted", "position_filter_timeout"];

  const kill = createReplayRunner(runtime, seat, 100);
  kill.runner.start();
  await waitFor(() => kill.runner.getStatus().pendingDecision);
  kill.runner.halt("replay_kill_switch");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const killReceipts = kill.runner.exportReceipts();
  const killReceipt = killReceipts.find((entry) => entry.kind === "runner_halted") ?? null;

  const acceptance = {
    completedNineteenTurns: completion.runner.getStatus().state === "completed" && completion.runner.getStatus().picks.length === 19 && turnReceipts.length === 19,
    onClockOverrideApplied: completionReceipts.filter((entry) => entry.kind === "runner_on_clock_choice_applied").length === 1,
    everyPanelReadyUnder250ms: turnReceipts.every((entry) => entry.panelBudgetMs === 250 && entry.panelReadyMs < entry.panelBudgetMs),
    everyRecommendationUnder100ms: turnReceipts.every((entry) => entry.decision?.recomputeMs < 100),
    zeroFallbacks: turnReceipts.every((entry) => entry.decision?.fallbackUsed === false),
    zeroTimeoutOrFailureReceipts: failureCodes.length === 0 && !completionReceipts.some((entry) => forbiddenFailures.some((code) => String(entry.code ?? entry.failure ?? "").includes(code))),
    killDuringDecisionWindow: killReceipt?.reason === "replay_kill_switch" && killReceipt?.picks === 0,
    killProducedNoClick: killReceipt?.draftClicks === 0 && killReceipt?.pickConfirmations === 0,
    realLeagueExecutionDisabled: runtime.runner.configs.real_league_19_idp.qualification === "unverified-real-room",
  };
  return {
    schemaVersion: 1,
    evidenceClass: "OFFLINE_RUNNER_LOOP_REPLAY",
    clockBasis: "real-league 30s assumption stressed through the TEST 19-round runner contract",
    yahooLiveDraft: false,
    yahooTestLeagueCleanAutomationPass: false,
    roomIdentityUsedByHarness: { leagueId: "18599", yahooTeamId: 12, draftSeat: seat },
    accepted: Object.values(acceptance).every(Boolean),
    acceptance,
    completion: {
      state: completion.runner.getStatus().state,
      picks: completion.runner.getStatus().picks.length,
      overrideApplied,
      maxPanelReadyMs: turnReceipts.length ? Math.max(...turnReceipts.map((entry) => entry.panelReadyMs)) : null,
      maxRecomputeMs: turnReceipts.length ? Math.max(...turnReceipts.map((entry) => entry.decision?.recomputeMs ?? Infinity)) : null,
      turns: turnReceipts.map((entry) => ({ turn: entry.turn, panelReadyMs: entry.panelReadyMs, panelBudgetMs: entry.panelBudgetMs, recomputeMs: entry.decision?.recomputeMs, fallbackUsed: entry.decision?.fallbackUsed })),
      failureCodes,
    },
    kill: killReceipt,
    receipts: { completion: completionReceipts, kill: killReceipts },
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
