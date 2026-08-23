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
    vor: Number(player.vorp),
    adpLow: Number(player.marketAdpLow),
    adpHigh: Number(player.marketAdpHigh),
    projection: Number(player.consensusPoints),
    confidence: player.sourceCount >= 2 ? "MULTI_SOURCE" : "WITHHELD",
    bye: player.bye ?? null,
  };
}

function compactSpecialist(player, positionOverride = null) {
  const sourceIds = new Set(player.sourceIds ?? []);
  const confidence = player.sourceCount >= 2
    ? "MULTI_SOURCE"
    : sourceIds.has("yahoo-season-projection")
      ? "YAHOO_ONLY"
      : sourceIds.has("league-scored-history-market-baseline")
        ? "HISTORY_ONLY"
        : "ELIGIBILITY_ONLY";
  return {
    yahooId: String(player.yahooId),
    name: player.name,
    team: player.team,
    position: positionOverride ?? player.yahooPosition ?? player.position,
    rank: player.specialistRank,
    projection: finite(player.consensusPoints) ? Number(player.consensusPoints) : null,
    confidence,
    bye: player.bye ?? null,
  };
}

function specialistHealthClear(player) {
  return player.injury == null || (player.injury.draftAction === "CLEAR" && player.injury.conflict !== true);
}

export function extensionBoardFromV5(board) {
  const offense = (board?.boards?.offense ?? [])
    .filter((player) => player.executable)
    .filter((player) => finite(player.vorp) && finite(player.marketAdpLow) && finite(player.marketAdpHigh))
    .map(compactOffense);
  const specialists = board?.boards?.specialists ?? {};
  const kickers = (specialists.K ?? []).filter(specialistHealthClear).map((player) => compactSpecialist(player, "K"));
  const defenses = (specialists.DEF ?? []).filter(specialistHealthClear).map((player) => compactSpecialist(player, "DEF"));
  const idp = ["DL", "LB", "DB"].flatMap((bucket) => (specialists[bucket] ?? []).filter(specialistHealthClear).flatMap((player) => {
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
  return {
    generatedAt: board.generatedAt,
    source: "v5 free-source board: Yahoo projections plus league-scored history/market baseline; injuries cross-checked with Yahoo and Sleeper",
    scoringModel: board.scoringModel,
    offense,
    kickers,
    defenses,
    idp,
  };
}

export function renderExtensionBoard(board) {
  return `(function installYahooMockBoard(root) {\n  "use strict";\n\n  root.SKRODZKaiYahooMockBoard = Object.freeze(${JSON.stringify(board, null, 2)});\n})(globalThis);\n`;
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
