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
    automaticEligible: player.automaticEligible === true,
    manualEligible: player.manualEligible === true,
    validationStatus: player.validationStatus ?? "MISSING_VALIDATION_STATUS",
    confidence: player.sourceFamilyCount >= 2 ? "MULTI_SOURCE" : "WITHHELD",
    bye: player.bye ?? null,
    omittedScoringCategories: Array.from(player.omittedScoringCategories ?? []),
    projectionBlendPolicy: player.projectionBlendPolicy ?? "unspecified",
    draftSignals: player.draftSignals ?? null,
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
    projection: finite(player.rankingPoints) ? Number(player.rankingPoints) : finite(player.consensusPoints) ? Number(player.consensusPoints) : null,
    rawProjection: finite(player.consensusPoints) ? Number(player.consensusPoints) : null,
    idpDecisionProjection: finite(player.idpDecisionPoints) ? Number(player.idpDecisionPoints) : null,
    perGamePoints: finite(player.rankingPerGamePoints) ? Number(player.rankingPerGamePoints) : finite(player.perGamePoints) ? Number(player.perGamePoints) : null,
    rawPerGamePoints: finite(player.perGamePoints) ? Number(player.perGamePoints) : null,
    expectedGamesThroughWeek17: finite(player.expectedGamesThroughWeek17) ? Number(player.expectedGamesThroughWeek17) : null,
    weeklyPoints: Array.isArray(player.weeklyPoints) ? player.weeklyPoints.map(Number) : null,
    rawWeeklyPoints: Array.isArray(player.rawWeeklyPoints) ? player.rawWeeklyPoints.map(Number) : null,
    weeklyAvailability: Array.isArray(player.weeklyAvailability) ? player.weeklyAvailability.map(Number) : null,
    outcomeLow: finite(player.rankingOutcomeLow) ? Number(player.rankingOutcomeLow) : finite(player.outcomeLow) ? Number(player.outcomeLow) : null,
    outcomeHigh: finite(player.rankingOutcomeHigh) ? Number(player.rankingOutcomeHigh) : finite(player.outcomeHigh) ? Number(player.outcomeHigh) : null,
    rawOutcomeLow: finite(player.rawOutcomeLow) ? Number(player.rawOutcomeLow) : finite(player.outcomeLow) ? Number(player.outcomeLow) : null,
    rawOutcomeHigh: finite(player.rawOutcomeHigh) ? Number(player.rawOutcomeHigh) : finite(player.outcomeHigh) ? Number(player.outcomeHigh) : null,
    uncertaintyStatus: player.uncertaintyStatus ?? "OUTCOME_INTERVAL_UNAVAILABLE",
    replacementPoints: finite(player.replacementPoints) ? Number(player.replacementPoints) : null,
    vor: finite(player.vorp) ? Number(player.vorp) : null,
    rawReplacementPoints: finite(player.rawReplacementPoints) ? Number(player.rawReplacementPoints) : null,
    rawVor: finite(player.rawVorp) ? Number(player.rawVorp) : null,
    eligible: Array.from(player.eligible ?? [positionOverride ?? player.position]),
    automaticEligible: player.automaticEligible === true,
    manualEligible: player.manualEligible === true,
    validationStatus: player.validationStatus ?? "MISSING_VALIDATION_STATUS",
    confidence,
    bye: player.bye ?? null,
    omittedScoringCategories: Array.from(player.omittedScoringCategories ?? []),
    projectionBlendPolicy: player.projectionBlendPolicy ?? "unspecified",
    idpProfile: player.idpProfile ?? null,
    idpModelStatus: player.idpModelStatus ?? "NOT_IDP",
    idpModelWarning: player.idpModelWarning ?? null,
    idpCalibrationHash: player.idpCalibrationHash ?? null,
    draftSignals: player.draftSignals ?? null,
  };
}

function specialistHealthClear(player) {
  return player.injury != null && player.injury.draftAction === "CLEAR" && player.injury.conflict !== true;
}

function specialistUsable(player) {
  return specialistHealthClear(player) && finite(player.consensusPoints) && Number(player.consensusPoints) > 0;
}

export function extensionBoardFromV5(board) {
  const offenseSource = board?.boards?.offense ?? [];
  const offense = offenseSource
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
  const byeEligible = players.filter((player) => player.automaticEligible || player.manualEligible);
  const playersWithBye = byeEligible.filter((player) => Number.isInteger(Number(player.bye)) && Number(player.bye) >= 1 && Number(player.bye) <= 17).length;
  const sourceByYahooId = new Map();
  for (const player of [offenseSource, ...Object.values(specialists)].flat()) {
    const yahooId = String(player?.yahooId ?? "");
    if (!yahooId) continue;
    const existing = sourceByYahooId.get(yahooId);
    if (!existing?.injury || player.injury) sourceByYahooId.set(yahooId, player);
  }
  const injuryChecked = byeEligible.filter((player) => {
    const injury = sourceByYahooId.get(player.yahooId)?.injury;
    return injury != null && Array.isArray(injury.evidence) && injury.evidence.some((entry) => entry?.fresh === true);
  });
  const injuryCheckedIds = new Set(injuryChecked.map((player) => player.yahooId));
  const injuryCoverage = {
    complete: byeEligible.length > 0 && injuryChecked.length === byeEligible.length,
    checkedPlayers: injuryChecked.length,
    expectedPlayers: byeEligible.length,
    uncheckedPlayerIds: byeEligible.filter((player) => !injuryCheckedIds.has(player.yahooId)).map((player) => player.yahooId),
    denominator: "automatic-or-manual-eligible players, including DEF",
    sourceCoverage: board.injuryCoverage ?? null,
  };
  const byeCoverage = {
    complete: byeEligible.length > 0 && playersWithBye === byeEligible.length,
    playersWithBye,
    playersTotal: byeEligible.length,
    denominator: "automatic-or-manual-eligible players, including DEF",
  };
  return {
    generatedAt: board.generatedAt,
    source: `free-source board: raw projections scored under exact league rules and equal-weighted per independent source family; IDP projection fields use the consensus-anchored decision score only when the global historical gate passes (${board?.projectionModel?.idpRanking?.status ?? "calibration unavailable"}); rawProjection preserves consensus; market/history are timing context only; injuries use source-specific freshness`,
    scoringModel: board.scoringModel,
    scoringSchemaHash: board.scoringSchemaHash ?? null,
    replacementBySlot: board.replacementBySlot ?? null,
    rawReplacementBySlot: board.rawReplacementBySlot ?? null,
    idpRanking: board?.projectionModel?.idpRanking ?? null,
    survivalCalibration: board.survivalCalibration ?? null,
    draftSignalOverlay: board.draftSignalOverlay ?? null,
    injuryCoverage,
    injuryFreshnessPolicy: board.injuryFreshnessPolicy ?? null,
    byeCoverage,
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
    scoringSchemaHash: board.scoringSchemaHash,
    replacementBySlot: board.replacementBySlot,
    rawReplacementBySlot: board.rawReplacementBySlot,
    idpRanking: board.idpRanking,
    survivalCalibration: board.survivalCalibration,
    draftSignalOverlay: board.draftSignalOverlay,
    injuryCoverage: board.injuryCoverage,
    injuryFreshnessPolicy: board.injuryFreshnessPolicy,
    byeCoverage: board.byeCoverage,
    players: board.players,
    defenses: board.defenses,
  };
  return `(function installYahooMockBoard(root) {\n  "use strict";\n\n  root.SKRODZKaiYahooMockBoard = Object.freeze(${JSON.stringify(runtimeBoard, null, 2)});\n})(globalThis);\n`;
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function renderOfflineBoardCsv(board) {
  const columns = ["value_rank", "name", "team", "position", "eligible", "projection", "vor", "bye", "yahoo_rank", "confidence", "automatic_eligible", "manual_eligible", "validation_status", "attention_required", "signal_warnings"];
  const rows = Array.from(board?.players ?? [])
    .sort((left, right) => Number(left.valueRank ?? Infinity) - Number(right.valueRank ?? Infinity) || Number(left.rank ?? Infinity) - Number(right.rank ?? Infinity) || String(left.yahooId).localeCompare(String(right.yahooId)))
    .map((player) => [
      player.valueRank,
      player.name,
      player.team,
      player.position,
      Array.from(player.eligible ?? []).join("/"),
      player.projection,
      player.vor,
      player.bye,
      player.yahooRank,
      player.confidence,
      player.automaticEligible,
      player.manualEligible,
      player.validationStatus,
      player.draftSignals?.attentionRequired === true,
      Array.from(player.draftSignals?.warnings ?? []).join(" | "),
    ].map(csvCell).join(","));
  return `${columns.join(",")}\n${rows.join("\n")}\n`;
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
  if (args["csv-output"]) await writeFile(args["csv-output"], renderOfflineBoardCsv(board), "utf8");
  process.stdout.write(`${JSON.stringify({ output: args.output, csvOutput: args["csv-output"] ?? null, offense: board.offense.length, kickers: board.kickers.length, defenses: board.defenses.length, idp: board.idp.length })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
