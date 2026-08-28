import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { estimatePositionPressure, overallPick, turnsBeforeNextPick } from "./opponent-window.mjs";

const EARLY_EXACT_TURNS = 3;

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function phase(round) {
  if (round <= 4) return "opening";
  if (round <= 9) return "core";
  if (round <= 14) return "bench";
  return "specialists";
}

function suggestionConsensus(simulations, round, playerById) {
  const candidates = new Map();
  for (const simulation of simulations) {
    const pick = simulation.picks.find((entry) => Number(entry.round) === round);
    for (const target of pick?.ladder ?? []) {
      const id = String(target.yahooId);
      const row = candidates.get(id) ?? {
        yahooId: id,
        name: target.name,
        position: target.position,
        appearances: 0,
        decisionScoreTotal: 0,
        decisionScoreSamples: 0,
        simulatedSurvivalTotal: 0,
        simulatedSurvivalSamples: 0,
      };
      row.appearances += 1;
      if (finite(target.decisionScore)) {
        row.decisionScoreTotal += Number(target.decisionScore);
        row.decisionScoreSamples += 1;
      }
      if (finite(target.pAvailableNext)) {
        row.simulatedSurvivalTotal += Number(target.pAvailableNext);
        row.simulatedSurvivalSamples += 1;
      }
      candidates.set(id, row);
    }
  }
  return [...candidates.values()]
    .map((candidate) => {
      const player = playerById.get(candidate.yahooId) ?? {};
      return {
        yahooId: candidate.yahooId,
        name: candidate.name,
        position: candidate.position,
        appearanceRate: candidate.appearances / simulations.length,
        meanDecisionScore: candidate.decisionScoreSamples ? candidate.decisionScoreTotal / candidate.decisionScoreSamples : null,
        simulatedSurvival: candidate.simulatedSurvivalSamples ? candidate.simulatedSurvivalTotal / candidate.simulatedSurvivalSamples : null,
        injuryStatus: player.injury?.status ?? "UNKNOWN",
        injuryAction: player.injury?.draftAction ?? "REVIEW",
        bye: player.bye ?? null,
        sourceFamilies: player.sourceFamilies ?? [],
        omittedScoringCategories: player.omittedScoringCategories ?? [],
      };
    })
    .sort((left, right) => right.appearanceRate - left.appearanceRate || (right.meanDecisionScore ?? -Infinity) - (left.meanDecisionScore ?? -Infinity) || left.yahooId.localeCompare(right.yahooId))
    .slice(0, 8);
}

function positionContingency(simulations, round) {
  const counts = {};
  for (const simulation of simulations) {
    const position = simulation.picks.find((entry) => Number(entry.round) === round)?.position;
    if (position) counts[position] = (counts[position] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([position, count]) => ({ position, simulationRate: count / simulations.length }))
    .sort((left, right) => right.simulationRate - left.simulationRate || left.position.localeCompare(right.position));
}

function normalizedPressure(pressure) {
  const result = {};
  for (const [position, value] of Object.entries(pressure.positions ?? {})) {
    const key = position === "DL" ? "D" : position;
    const current = result[key] ?? { expectedPicks: 0, probabilityAtLeastOne: 0 };
    current.expectedPicks += Number(value.expectedPicks ?? 0);
    current.probabilityAtLeastOne = 1 - (1 - current.probabilityAtLeastOne) * (1 - Number(value.probabilityAtLeastOne ?? 0));
    result[key] = current;
  }
  return result;
}

export function buildSnakeSeatPackets({ rehearsal, board, opponentCalibration, generatedAt }) {
  if (rehearsal?.accepted !== true) throw new Error("accepted rehearsal is required");
  if (!opponentCalibration?.calibration?.enabled) throw new Error("enabled opponent calibration is required");
  const teams = rehearsal.teams ?? [];
  const seats = [...new Set(teams.map((team) => Number(team.seat)))].sort((left, right) => left - right);
  if (seats.length !== 12 || seats[0] !== 1 || seats.at(-1) !== 12) throw new Error("rehearsal must cover all 12 seats");
  const playerById = new Map((board?.players ?? []).map((player) => [String(player.yahooId ?? player.playerId), player]));
  return {
    schemaVersion: 1,
    generatedAt,
    executionInput: false,
    managerBinding: null,
    policy: "display-only snapshot-time preparation; never feed these estimates into BPA, VONA, survival, or Yahoo execution",
    packets: seats.map((seat) => {
      const simulations = teams.filter((team) => Number(team.seat) === seat);
      return {
        seat,
        managerBinding: null,
        executionInput: false,
        simulationCount: simulations.length,
        turns: Array.from({ length: 19 }, (_, index) => {
          const round = index + 1;
          const between = turnsBeforeNextPick({ round, ourSeat: seat, teams: 12, rounds: 19 });
          const pressure = estimatePositionPressure({ turns: between, calibration: opponentCalibration, managerMap: {} });
          const exactSuggestions = round <= EARLY_EXACT_TURNS
            ? suggestionConsensus(simulations, round, playerById)
            : null;
          return {
            round,
            phase: phase(round),
            overallPick: overallPick(round, seat, 12),
            nextOverallPick: round < 19 ? overallPick(round + 1, seat, 12) : null,
            interveningOpponentPicks: between.length,
            pressureBasis: "descriptive room-phase fallback; manager-specific seat binding unavailable before draft order",
            positionRunPressure: normalizedPressure(pressure),
            exactSuggestions: exactSuggestions
              ? { topThree: exactSuggestions.slice(0, 3), fallbacks: exactSuggestions.slice(3, 8), source: `${simulations.length}-seed simulation consensus` }
              : null,
            positionContingency: positionContingency(simulations, round),
            instruction: "display only; recompute the deterministic live ladder from actual Yahoo availability",
          };
        }),
      };
    }),
  };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((entry) => {
    const [key, ...value] = entry.replace(/^--/, "").split("=");
    return [key, value.join("=")];
  }));
  for (const key of ["rehearsal", "board", "calibration", "output", "generated-at"]) if (!args[key]) throw new Error(`missing --${key}=...`);
  const [rehearsal, board, opponentCalibration] = await Promise.all([
    readFile(args.rehearsal, "utf8").then(JSON.parse),
    readFile(args.board, "utf8").then(JSON.parse),
    readFile(args.calibration, "utf8").then(JSON.parse),
  ]);
  const packets = buildSnakeSeatPackets({ rehearsal, board, opponentCalibration, generatedAt: args["generated-at"] });
  await writeFile(args.output, `${JSON.stringify(packets, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output: args.output, packets: packets.packets.length })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
