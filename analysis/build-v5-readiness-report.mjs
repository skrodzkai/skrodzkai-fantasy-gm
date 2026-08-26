import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { parseHistory } from "./opponent-calibration.mjs";
import {
  backtestSpecialistSurvival,
  buildOpponentSeatWarCards,
  specialistSurvivalByWindow,
} from "./draft-readiness.mjs";

function countsBy(rows, field) {
  const counts = {};
  for (const row of rows) counts[row[field]] = (counts[row[field]] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function compactCalibration(calibration) {
  const result = calibration?.calibration ?? {};
  return {
    enabled: result.enabled === true,
    reason: result.reason ?? "missing_calibration",
    testSeason: result.testSeason ?? null,
    events: result.events ?? 0,
    baselineBrier: result.baseline?.brier ?? null,
    calibratedBrier: result.calibrated?.brier ?? null,
    meanBrierImprovement: result.meanBrierImprovement ?? null,
    clustered95Interval: result.clustered95Interval ?? null,
    excludedManagers: result.excludedManagers ?? null,
    excludedRows: result.excludedRows ?? null,
    permittedUse: result.enabled === true
      ? "within-tier position-pressure tiebreak only"
      : "descriptive room structure only",
  };
}

export function buildV5ReadinessReport({
  historyRows,
  playerBoard,
  opponentCalibration,
  generatedAt,
  excludedManagerIds = ["joe"],
}) {
  const excluded = new Set(excludedManagerIds.map(String));
  const opponentRows = historyRows.filter((row) => !excluded.has(String(row.managerId)));
  const excludedRows = historyRows.length - opponentRows.length;
  if (!excludedRows) throw new Error("required Joe history exclusion was not observed");
  const seasons = [...new Set(historyRows.map((row) => row.season))].sort((left, right) => left - right);
  const windows = Array.from({ length: 6 }, (_, roundOffset) =>
    Array.from({ length: 12 }, (_, seatOffset) => ({ round: roundOffset + 14, seat: seatOffset + 1 })),
  ).flat();
  const specialistSurvival = specialistSurvivalByWindow(historyRows, {
    teams: 12,
    windows,
    excludeManagerIds: excludedManagerIds,
  });
  const specialistBacktest = backtestSpecialistSurvival(historyRows, {
    teams: 12,
    windows,
    excludeManagerIds: excludedManagerIds,
    holdoutSeason: seasons.at(-1),
  });
  const currentLeagueSeatRows = opponentRows.filter((row) => Number(row.draftSlot) >= 1 && Number(row.draftSlot) <= 12);
  const warCards = buildOpponentSeatWarCards(currentLeagueSeatRows, { minSamples: 100, minSupport: 0.4 });
  const boardPlayers = playerBoard?.players ?? [];
  const boardPositions = countsBy(boardPlayers, "position");
  const executablePositions = countsBy(boardPlayers.filter((player) => player.executable), "position");
  const hunter = boardPlayers.find((player) => ["41787", "99001", "99002"].includes(String(player.yahooId)));
  return {
    schemaVersion: 1,
    generatedAt,
    posture: "draft-prep-only; no real-league execution authority",
    historicalCoverage: {
      rows: historyRows.length,
      opponentRows: opponentRows.length,
      excludedJoeRows: excludedRows,
      seasons,
      seasonCount: seasons.length,
      managerCount: new Set(historyRows.map((row) => row.managerId)).size,
      positionCounts: countsBy(historyRows, "position"),
    },
    opponentCalibration: compactCalibration(opponentCalibration),
    roomPositionRates: opponentCalibration?.room ?? {},
    seatWarCards: warCards,
    specialistSurvival,
    specialistBacktest,
    playerBoard: {
      generatedAt: playerBoard?.generatedAt ?? null,
      scoringModel: playerBoard?.scoringModel ?? null,
      players: boardPlayers.length,
      executable: boardPlayers.filter((player) => player.executable).length,
      positions: boardPositions,
      executablePositions,
      sources: playerBoard?.sources ?? [],
      replacementRanks: playerBoard?.replacementRanks ?? {},
      travisHunter: hunter ? {
        yahooId: hunter.yahooId,
        draftPosition: hunter.position,
        yahooDisplayedPosition: hunter.yahooPosition,
        eligibilityFilters: hunter.yahooEligibilityFilters,
        eligible: hunter.eligible,
        projection: hunter.consensusPoints,
        executable: hunter.executable,
      } : null,
    },
    guardrails: {
      kForecast: "UNVERIFIED; use current Yahoo rank and historical timing only",
      defenseForecast: "UNVERIFIED; require dated matchup evidence for any early move",
      injuryRule: "fresh conflicting or adverse evidence blocks automated use",
      opponentRule: "manager model may break a within-tier tie only; never override player value",
      identityRule: "exact Yahoo ID and current eligibility are required",
    },
  };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((entry) => {
    const [key, ...value] = entry.split("=");
    return [key.replace(/^--/, ""), value.join("=")];
  }));
  for (const required of ["history", "board", "calibration", "output", "generated-at"]) {
    if (!args[required]) throw new Error(`missing --${required}=...`);
  }
  const [historyText, playerBoard, opponentCalibration] = await Promise.all([
    readFile(args.history, "utf8"),
    readFile(args.board, "utf8").then(JSON.parse),
    readFile(args.calibration, "utf8").then(JSON.parse),
  ]);
  const report = buildV5ReadinessReport({
    historyRows: parseHistory(historyText),
    playerBoard,
    opponentCalibration,
    generatedAt: args["generated-at"],
    excludedManagerIds: (args["exclude-manager"] ?? "joe").split(",").filter(Boolean),
  });
  await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output: args.output, rows: report.historicalCoverage.rows, seasons: report.historicalCoverage.seasonCount, players: report.playerBoard.players })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
