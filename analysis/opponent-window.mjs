import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const POSITION_KEYS = Object.freeze(["QB", "RB", "WR", "TE", "K", "DEF", "LB", "DB", "DL"]);

export function overallPick(round, seat, teams = 12) {
  if (!Number.isInteger(round) || round < 1) throw new Error("round must be a positive integer");
  if (!Number.isInteger(seat) || seat < 1 || seat > teams) throw new Error("seat is outside the draft");
  return round % 2 === 1 ? (round - 1) * teams + seat : round * teams - seat + 1;
}

export function pickCoordinates(overall, teams = 12) {
  if (!Number.isInteger(overall) || overall < 1) throw new Error("overall pick must be positive");
  const round = Math.floor((overall - 1) / teams) + 1;
  const roundPick = ((overall - 1) % teams) + 1;
  const seat = round % 2 === 1 ? roundPick : teams - roundPick + 1;
  return { overall, round, seat };
}

export function turnsBeforeNextPick({ round, ourSeat, seatManagers = {}, teams = 12, rounds = 19 }) {
  if (!Number.isInteger(rounds) || rounds < 1 || round > rounds) throw new Error("round is outside the draft");
  if (round === rounds) return [];
  const current = overallPick(round, ourSeat, teams);
  const next = overallPick(round + 1, ourSeat, teams);
  const turns = [];
  for (let overall = current + 1; overall < next; overall += 1) {
    const coordinates = pickCoordinates(overall, teams);
    turns.push({ ...coordinates, managerId: seatManagers[String(coordinates.seat)] ?? null });
  }
  return turns;
}

function phaseForRound(round) {
  if (round <= 4) return "opening";
  if (round <= 9) return "core";
  if (round <= 14) return "bench";
  return "specialists";
}

export function estimatePositionPressure({ turns, calibration, managerMap = {} }) {
  const output = Object.fromEntries(POSITION_KEYS.map((position) => [position, {
    expectedPicks: 0,
    probabilityAtLeastOne: 0,
  }]));
  let profileTurns = 0;
  let roomFallbackTurns = 0;
  const remaining = Object.fromEntries(POSITION_KEYS.map((position) => [position, 1]));
  const resolvedTurns = turns.map((turn) => {
    const phase = phaseForRound(turn.round);
    const profileId = turn.managerId ? managerMap[turn.managerId] : null;
    const probabilities = calibration.profiles?.[profileId]?.[phase] ?? calibration.room?.[phase];
    if (!probabilities) throw new Error(`missing_probabilities_for_${phase}`);
    if (profileId && calibration.profiles?.[profileId]) profileTurns += 1;
    else roomFallbackTurns += 1;
    for (const position of POSITION_KEYS) {
      const probability = Number(probabilities[position] ?? 0);
      output[position].expectedPicks += probability;
      remaining[position] *= 1 - probability;
    }
    return { overall: turn.overall, round: turn.round, seat: turn.seat, profileId, phase };
  });
  for (const position of POSITION_KEYS) {
    output[position].probabilityAtLeastOne = 1 - remaining[position];
  }
  return { turns: resolvedTurns, coverage: { profileTurns, roomFallbackTurns }, positions: output };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) args[argv[index]?.replace(/^--/, "")] = argv[index + 1];
  if (!args.calibration || !args.mapping || !args.seats || !args.round || !args["our-seat"] || !args.output) {
    throw new Error("usage: node analysis/opponent-window.mjs --calibration model.json --mapping private-map.json --seats seats.json --round N --our-seat N --output window.json");
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = parseArgs(process.argv.slice(2));
  const calibration = JSON.parse(readFileSync(args.calibration, "utf8"));
  if (!calibration.calibration?.enabled) throw new Error("opponent_calibration_not_enabled");
  const { managerMap } = JSON.parse(readFileSync(args.mapping, "utf8"));
  const seatManagers = JSON.parse(readFileSync(args.seats, "utf8"));
  const turns = turnsBeforeNextPick({
    round: Number(args.round),
    ourSeat: Number(args["our-seat"]),
    seatManagers,
    rounds: Number(args.rounds ?? 19),
  });
  const result = estimatePositionPressure({ turns, calibration, managerMap });
  writeFileSync(args.output, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    round: Number(args.round),
    ourSeat: Number(args["our-seat"]),
    rounds: Number(args.rounds ?? 19),
    ...result,
  }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ turns: turns.length, coverage: result.coverage })}\n`);
}
