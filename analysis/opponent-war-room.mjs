import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { parseHistory } from "./opponent-calibration.mjs";
import { estimatePositionPressure, turnsBeforeNextPick } from "./opponent-window.mjs";

const PHASES = Object.freeze(["opening", "core", "bench", "specialists"]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function topPositions(probabilities, limit = 3) {
  return Object.entries(probabilities ?? {})
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([position, probability]) => ({ position, probability }));
}

export function buildOpponentWarRoom({
  teams,
  calibration,
  managerMap,
  historyRows = [],
  joeManagerIds = ["joe"],
} = {}) {
  if (!calibration?.calibration?.enabled) throw new Error("opponent_calibration_not_enabled");
  const excluded = new Set(asArray(joeManagerIds).map(String));
  const currentTeams = asArray(teams);
  if (!currentTeams.length) throw new Error("current teams are required");
  const counts = new Map();
  for (const row of asArray(historyRows)) {
    const managerId = String(row.managerId ?? "");
    if (!managerId) continue;
    counts.set(managerId, (counts.get(managerId) ?? 0) + 1);
  }
  const cards = currentTeams
    .filter((team) => !excluded.has(String(team.managerId)))
    .map((team) => {
      const managerId = String(team.managerId ?? "");
      const profileId = managerMap?.[managerId] ?? null;
      const hasProfile = Boolean(profileId && calibration.profiles?.[profileId]);
      const phaseProbabilities = Object.fromEntries(PHASES.map((phase) => [
        phase,
        hasProfile ? calibration.profiles[profileId][phase] : calibration.room?.[phase],
      ]));
      if (PHASES.some((phase) => !phaseProbabilities[phase])) {
        throw new Error(`missing opponent probabilities for ${managerId || "unknown manager"}`);
      }
      return {
        seat: Number(team.seat),
        teamId: team.teamId == null ? null : String(team.teamId),
        teamName: String(team.teamName ?? ""),
        managerId,
        evidencePicks: counts.get(managerId) ?? 0,
        model: hasProfile ? "HELD_OUT_CLEARED_MANAGER_TIEBREAK" : "ROOM_PHASE_FALLBACK",
        topByPhase: Object.fromEntries(PHASES.map((phase) => [phase, topPositions(phaseProbabilities[phase])])),
      };
    })
    .sort((left, right) => left.seat - right.seat);
  return Object.freeze({
    calibration: calibration.calibration,
    policy: "position pressure may break a close value tier only; never predict an exact player",
    cards,
  });
}

export function buildOpponentSnakeWindow({ round, ourSeat, teams, calibration, managerMap }) {
  const seatManagers = Object.fromEntries(asArray(teams).map((team) => [String(team.seat), String(team.managerId ?? "")]));
  const turns = turnsBeforeNextPick({ round, ourSeat, seatManagers, teams: asArray(teams).length || 12, rounds: 19 });
  return estimatePositionPressure({ turns, calibration, managerMap });
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) args[argv[index]?.replace(/^--/, "")] = argv[index + 1];
  if (!args.calibration || !args.mapping || !args.teams || !args.history || !args.output) {
    throw new Error("usage: node analysis/opponent-war-room.mjs --calibration model.json --mapping private-map.json --teams teams.json --history league-history.csv --output war-room.json");
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = parseArgs(process.argv.slice(2));
  const calibration = JSON.parse(readFileSync(args.calibration, "utf8"));
  const { managerMap } = JSON.parse(readFileSync(args.mapping, "utf8"));
  const teams = JSON.parse(readFileSync(args.teams, "utf8"));
  const historyRows = parseHistory(readFileSync(args.history, "utf8"));
  const result = buildOpponentWarRoom({ teams, calibration, managerMap, historyRows, joeManagerIds: String(args["exclude-manager"] ?? "joe").split(",") });
  writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output: args.output, cards: result.cards.length })}\n`);
}

export { PHASES };
