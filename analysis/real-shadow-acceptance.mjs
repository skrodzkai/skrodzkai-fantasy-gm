import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { loadRuntime } from "./run-v5-rehearsals.mjs";

export async function loadDecisionEngine(runnerPath) {
  const source = await readFile(runnerPath, "utf8");
  const context = { clearInterval, console, crypto, Date, Event:class Event {}, Math, setInterval, setTimeout };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return {runner:context.SKRODZKaiYahooMockRunner,source,runnerSourceSha256:createHash("sha256").update(source).digest("hex")};
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] ?? null;
}

function counts(picks) {
  return picks.reduce((result, pick) => {
    const position = String(pick.position);
    result[position] = (result[position] ?? 0) + 1;
    return result;
  }, {});
}

export function runRealShadowAcceptance({ engine, boardSource, settingsSnapshot, seats = [1, 6, 12], decisionBudgetMs = engine?.runner?.decision?.recomputeBudgetMs }) {
  const runtime = loadRuntime(boardSource,engine.source,"REAL");
  if (engine.runnerSourceSha256 !== runtime.runnerSourceSha256) throw new Error("real_acceptance_runner_source_mismatch");
  const {boardData, boardSourceSha256, runnerSourceSha256, realExecutionEnabled} = runtime;
  const decision = runtime.runner.decision;
  const config = runtime.runner.configs.real_league_19_idp;
  if (!decision || !config) throw new Error("real shadow decision engine is unavailable");
  if (!Number.isFinite(decisionBudgetMs) || decisionBudgetMs <= 0) throw new Error("real shadow decision budget is unavailable");
  const idpPositions = Array.from(decision.IDP_POSITIONS ?? []);
  if (!idpPositions.length) throw new Error("real shadow IDP position contract is unavailable");
  if (!settingsSnapshot?.ready) throw new Error("real settings must be verified before stress acceptance");
  const board = decision.validateBoard(boardData?.players ?? boardData);
  const replacementBySlot = boardData?.replacementBySlot ?? {};
  const seatResults = [];

  for (const seat of seats) {
    let available = [...board];
    const picks = [];
    const latencies = [];
    const attachChecks = [];
    const opponentCategoryCounts = { K:0, DEF:0, IDP:0 };
    const opponentPositionCounts = {};
    let previousOverallPick = 0;
    for (let round = 1; round <= config.rounds; round += 1) {
      const ownOverallPick = decision.overallPick(round, seat, config.teams);
      const opponentPicks = ownOverallPick - previousOverallPick - 1;
      const rostered = new Set(picks.map((pick) => String(pick.yahooId)));
      const opponentIds = [];
      for (const player of opponentPicks > 0 ? available.filter((candidate) => !rostered.has(String(candidate.yahooId))).sort((left, right) => left.rank - right.rank) : []) {
        const position = String(player.position);
        const category = position === "K" ? "K" : position === "DEF" ? "DEF" : idpPositions.includes(position) ? "IDP" : null;
        const perTeamCategoryLimit = category === "IDP" ? Number(config.categoryLimits?.IDP) : Number(config.positionLimits[category]);
        const limit = category ? perTeamCategoryLimit * (config.teams - 1) : Infinity;
        if (category && opponentCategoryCounts[category] >= limit) continue;
        const positionLimit = Number(config.positionLimits[position] ?? 0) * (config.teams - 1);
        if (positionLimit > 0 && (opponentPositionCounts[position] ?? 0) >= positionLimit) continue;
        opponentIds.push(String(player.yahooId));
        if (category) opponentCategoryCounts[category] += 1;
        opponentPositionCounts[position] = (opponentPositionCounts[position] ?? 0) + 1;
        if (opponentIds.length === opponentPicks) break;
      }
      if (opponentIds.length !== opponentPicks) throw new Error(`seat ${seat} round ${round} cannot model ${opponentPicks} opponent picks`);
      const removed = new Set(opponentIds);
      available = available.filter((player) => !removed.has(String(player.yahooId)));

      const started = performance.now();
      let result;
      try {
        result = decision.buildDecisionLadder({
          round, seat, picks, board, availablePlayers:available,
          minimum:5, config, replacementBySlot, runPressureByPosition:{}, survivalCalibration:null,
        });
      } catch (error) {
        throw new Error(`seat ${seat} round ${round}: ${String(error?.message ?? error)}; counts ${JSON.stringify(counts(picks))}`);
      }
      const elapsedMs = performance.now() - started;
      latencies.push(elapsedMs);
      const chosen = board.find((player) => String(player.yahooId) === String(result.targets[0]?.yahooId));
      if (!chosen) throw new Error(`seat ${seat} round ${round} returned an unknown target`);
      picks.push(chosen);
      available = available.filter((player) => String(player.yahooId) !== String(chosen.yahooId));
      previousOverallPick = ownOverallPick;
      if ([6, 12].includes(round)) {
        const attached = decision.buildDecisionLadder({
          round:round + 1, seat, picks, board, availablePlayers:available,
          minimum:5, config, replacementBySlot, runPressureByPosition:{}, survivalCalibration:null,
        });
        attachChecks.push({ afterRound:round, targetCount:attached.targets.length, pass:attached.targets.length >= 5 });
      }
    }
    const positionCounts = counts(picks);
    const idpCount = idpPositions.reduce((sum, position) => sum + (positionCounts[position] ?? 0), 0);
    const maxMs = Math.max(...latencies);
    const legal = decision.validateCompletedRoster(picks, config) && idpCount <= 3 && (positionCounts.K ?? 0) <= 1 && (positionCounts.DEF ?? 0) <= 1;
    seatResults.push({
      seat, rounds:config.rounds, decisions:picks.length, legalRoster:legal,
      counts:positionCounts, idpCount, attachChecks,
      latencyMs:{ median:percentile(latencies, 0.5), p95:percentile(latencies, 0.95), max:maxMs, budget:decisionBudgetMs },
      pass:legal && maxMs <= decisionBudgetMs && attachChecks.every((check) => check.pass),
    });
  }

  const pass = config.name === "real_league_19_idp" && config.leagueId === "420010" && realExecutionEnabled === false && config.rounds === 19 && seatResults.every((result) => result.pass);
  return {
    schemaVersion:1,
    generatedAt:new Date().toISOString(),
    mode:"REAL SHADOW",
    realExecutionEnabled,
    runnerSourceSha256,
    boardSourceSha256,
    execution:false,
    clockSeconds:30,
    decisionBudgetMs,
    settingsVerified:true,
    configuration:config.name,
    qualification:config.qualification,
    status:pass ? "PASS" : "FAIL",
    seats:seatResults,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) args[argv[index].replace(/^--/, "")] = argv[index + 1];
  if (!args.runner || !args.board || !args.settings || !args.output) throw new Error("usage: node analysis/real-shadow-acceptance.mjs --runner runner.js --board yahoo-real-board.js --settings settings.json --output result.json");
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = parseArgs(process.argv.slice(2));
  const [engine, boardSource, settingsSnapshot] = await Promise.all([
    loadDecisionEngine(args.runner),
    readFile(args.board, "utf8"),
    readFile(args.settings, "utf8").then(JSON.parse),
  ]);
  const result = runRealShadowAcceptance({ engine, boardSource, settingsSnapshot });
  await writeFile(args.output, `${JSON.stringify(result, null, 2)}\n`, { mode:0o600 });
  process.stdout.write(`${JSON.stringify({ output:args.output, status:result.status })}\n`);
  if (result.status !== "PASS") process.exitCode = 1;
}
