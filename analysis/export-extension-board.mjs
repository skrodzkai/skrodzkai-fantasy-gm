import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function compactOffense(player) {
  return {
    yahooId: String(player.yahooId),
    name: player.name,
    team: player.team,
    position: player.position,
    rank: player.draftBoardRank,
    valueRank: player.overallRank,
    yahooRank: finite(player.yahooPreseasonRank) ? Number(player.yahooPreseasonRank) : null,
    vor: Number(player.vorp),
    adpLow: finite(player.marketAdpLow) ? Number(player.marketAdpLow) : null,
    adpHigh: finite(player.marketAdpHigh) ? Number(player.marketAdpHigh) : null,
    projection: Number(player.consensusPoints),
    perGamePoints: finite(player.perGamePoints) ? Number(player.perGamePoints) : null,
    expectedGamesThroughWeek17: finite(player.expectedGamesThroughWeek17) ? Number(player.expectedGamesThroughWeek17) : null,
    weeklyPoints: Array.isArray(player.weeklyPoints) ? player.weeklyPoints.map(Number) : null,
    weeklyAvailability: Array.isArray(player.weeklyAvailability) ? player.weeklyAvailability.map(Number) : null,
    outcomeLow: finite(player.outcomeLow) ? Number(player.outcomeLow) : null,
    outcomeHigh: finite(player.outcomeHigh) ? Number(player.outcomeHigh) : null,
    uncertaintyStatus: player.uncertaintyStatus ?? "OUTCOME_INTERVAL_UNAVAILABLE",
    replacementPoints: finite(player.replacementPoints) ? Number(player.replacementPoints) : null,
    eligible: Array.from(player.eligible ?? [player.position]),
    automaticEligible: player.automaticEligible !== false,
    manualEligible: player.manualEligible !== false,
    validationStatus: player.validationStatus ?? "EXECUTABLE",
    confidence: player.sourceFamilyCount >= 2 ? "MULTI_SOURCE" : "WITHHELD",
    bye: player.bye ?? null,
  };
}

function compactSpecialist(player, positionOverride = null) {
  const sourceIds = new Set(player.sourceIds ?? []);
  const confidence = player.sourceFamilyCount >= 2
    ? "MULTI_SOURCE"
    : sourceIds.has("yahoo-season-projection") || sourceIds.has("yahoo-specialist-season-projection")
      ? "YAHOO_ONLY"
      : "ELIGIBILITY_ONLY";
  return {
    yahooId: String(player.yahooId),
    name: player.name,
    team: player.team,
    position: positionOverride ?? player.yahooPosition ?? player.position,
    rank: player.specialistRank,
    valueRank: player.overallRank,
    yahooRank: finite(player.yahooPreseasonRank) ? Number(player.yahooPreseasonRank) : null,
    adpLow: finite(player.marketAdpLow) ? Number(player.marketAdpLow) : null,
    adpHigh: finite(player.marketAdpHigh) ? Number(player.marketAdpHigh) : null,
    projection: finite(player.consensusPoints) ? Number(player.consensusPoints) : null,
    perGamePoints: finite(player.perGamePoints) ? Number(player.perGamePoints) : null,
    expectedGamesThroughWeek17: finite(player.expectedGamesThroughWeek17) ? Number(player.expectedGamesThroughWeek17) : null,
    weeklyPoints: Array.isArray(player.weeklyPoints) ? player.weeklyPoints.map(Number) : null,
    weeklyAvailability: Array.isArray(player.weeklyAvailability) ? player.weeklyAvailability.map(Number) : null,
    outcomeLow: finite(player.outcomeLow) ? Number(player.outcomeLow) : null,
    outcomeHigh: finite(player.outcomeHigh) ? Number(player.outcomeHigh) : null,
    uncertaintyStatus: player.uncertaintyStatus ?? "OUTCOME_INTERVAL_UNAVAILABLE",
    replacementPoints: finite(player.replacementPoints) ? Number(player.replacementPoints) : null,
    vor: finite(player.vorp) ? Number(player.vorp) : null,
    eligible: Array.from(player.eligible ?? [positionOverride ?? player.position]),
    automaticEligible: player.automaticEligible !== false,
    manualEligible: player.manualEligible !== false,
    validationStatus: player.validationStatus ?? "EXECUTABLE",
    confidence,
    bye: player.bye ?? null,
  };
}

function specialistHealthClear(player) {
  return player.injury == null || (player.injury.draftAction === "CLEAR" && player.injury.conflict !== true);
}

function specialistUsable(player) {
  return specialistHealthClear(player) && finite(player.consensusPoints) && Number(player.consensusPoints) > 0;
}

export function extensionBoardFromV5(board) {
  const offense = (board?.boards?.offense ?? [])
    .filter((player) => player.manualEligible !== false)
    .filter((player) => finite(player.vorp))
    .map(compactOffense);
  const specialists = board?.boards?.specialists ?? {};
  const kickers = (specialists.K ?? []).filter(specialistUsable).map((player) => compactSpecialist(player, "K"));
  const defenses = (specialists.DEF ?? []).filter(specialistUsable).map((player) => compactSpecialist(player, "DEF"));
  const idp = ["DL", "LB", "DB"].flatMap((bucket) => (specialists[bucket] ?? []).filter(specialistUsable).flatMap((player) => {
    const yahooPosition = String(player.yahooPosition ?? "").toUpperCase();
    const eligible = new Set(Array.from(player.eligible ?? [], (position) => String(position).toUpperCase()));
    let position = bucket;
    if (bucket === "DL") position = "D";
    if (bucket === "DB") {
      position = ["CB", "S"].includes(yahooPosition)
        ? yahooPosition
        : eligible.has("CB")
          ? "CB"
          : eligible.has("S")
            ? "S"
            : null;
    }
    return position ? [compactSpecialist(player, position)] : [];
  }));
  if (offense.length < 100) throw new Error(`extension offense board too small: ${offense.length}`);
  if (kickers.length < 12) throw new Error(`extension kicker board too small: ${kickers.length}`);
  if (defenses.length !== 32) throw new Error(`extension defense board must contain 32 teams: ${defenses.length}`);
  const playerByYahooId = new Map();
  const positionPriority = (position) => ["QB", "RB", "WR", "TE"].includes(position)
    ? 4
    : ["K", "DEF"].includes(position)
      ? 3
      : ["LB", "CB", "S"].includes(position)
        ? 2
        : 1;
  for (const player of [...offense, ...kickers, ...defenses, ...idp]) {
    const existing = playerByYahooId.get(player.yahooId);
    if (!existing || positionPriority(player.position) > positionPriority(existing.position)) {
      playerByYahooId.set(player.yahooId, player);
    }
  }
  const players = [...playerByYahooId.values()];
  return {
    generatedAt: board.generatedAt,
    source: "free-source board: raw projections scored under exact league rules and equal-weighted per independent source family; market/history are timing context only; injuries use source-specific freshness",
    scoringModel: board.scoringModel,
    replacementBySlot: board.replacementBySlot ?? null,
    survivalCalibration: board.survivalCalibration ?? null,
    injuryCoverage: board.injuryCoverage ?? null,
    players,
    offense,
    kickers,
    defenses,
    idp,
  };
}

export function renderExtensionBoard(board) {
  const runtimeBoard = {
    generatedAt: board.generatedAt,
    source: board.source,
    scoringModel: board.scoringModel,
    replacementBySlot: board.replacementBySlot,
    survivalCalibration: board.survivalCalibration,
    injuryCoverage: board.injuryCoverage,
    players: board.players,
    defenses: board.defenses,
  };
  return `(function installYahooMockBoard(root) {\n  "use strict";\n\n  root.SKRODZKaiYahooMockBoard = Object.freeze(${JSON.stringify(runtimeBoard, null, 2)});\n})(globalThis);\n`;
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((entry) => {
    const [key, ...value] = entry.split("=");
    return [key.replace(/^--/, ""), value.join("=")];
  }));
  if (!args.input || !args.output) throw new Error("usage: node analysis/export-extension-board.mjs --input=board.json --output=extension/yahoo-mock-board.js");
  const source = JSON.parse(await readFile(args.input, "utf8"));
  const board = extensionBoardFromV5(source);
  await writeFile(args.output, renderExtensionBoard(board), "utf8");
  process.stdout.write(`${JSON.stringify({ output: args.output, offense: board.offense.length, kickers: board.kickers.length, defenses: board.defenses.length, idp: board.idp.length })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
