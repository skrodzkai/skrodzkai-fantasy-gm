import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const POSITIONS = Object.freeze(["QB", "RB", "WR", "TE", "K", "DEF", "LB", "DB", "DL"]);

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

export function parseHistory(text) {
  return parseCsv(text)
    .map((row) => ({
      season: Number(row.season),
      managerId: row.manager_id || row.owner_id,
      draftSlot: Number(row.draft_slot),
      pick: Number(row.pick || row.overall_pick),
      round: Number(row.round),
      position: row.position,
    }))
    .filter((row) =>
      Number.isInteger(row.season) &&
      row.managerId &&
      Number.isInteger(row.round) &&
      row.round >= 1 &&
      row.round <= 19 &&
      POSITIONS.includes(row.position)
    );
}

export function draftPhase(round) {
  if (round <= 4) return "opening";
  if (round <= 9) return "core";
  if (round <= 14) return "bench";
  return "specialists";
}

function emptyCounts() {
  return Object.fromEntries(POSITIONS.map((position) => [position, 0]));
}

function addCount(table, key, position, weight) {
  if (!table.has(key)) table.set(key, { total: 0, counts: emptyCounts() });
  const entry = table.get(key);
  entry.total += weight;
  entry.counts[position] += weight;
}

function normalize(counts, total) {
  if (!(total > 0)) return Object.fromEntries(POSITIONS.map((position) => [position, 1 / POSITIONS.length]));
  return Object.fromEntries(POSITIONS.map((position) => [position, counts[position] / total]));
}

export function trainPositionModel(rows, options = {}) {
  const decay = options.decay ?? 0.85;
  const shrinkage = options.shrinkage ?? 16;
  const maxSeason = options.maxSeason ?? Math.max(...rows.map((row) => row.season));
  const room = new Map();
  const managers = new Map();
  for (const row of rows) {
    const phase = draftPhase(row.round);
    const weight = decay ** Math.max(0, maxSeason - row.season);
    addCount(room, phase, row.position, weight);
    addCount(managers, `${row.managerId}|${phase}`, row.position, weight);
  }
  const roomProbabilities = Object.fromEntries(
    ["opening", "core", "bench", "specialists"].map((phase) => {
      const entry = room.get(phase) ?? { total: 0, counts: emptyCounts() };
      return [phase, normalize(entry.counts, entry.total)];
    }),
  );
  return { decay, shrinkage, maxSeason, room, managers, roomProbabilities };
}

export function predictPosition(model, managerId, round) {
  const phase = draftPhase(round);
  const room = model.roomProbabilities[phase];
  const manager = model.managers.get(`${managerId}|${phase}`);
  if (!manager || !(manager.total > 0)) return room;
  const denominator = manager.total + model.shrinkage;
  return Object.fromEntries(POSITIONS.map((position) => [
    position,
    (manager.counts[position] + model.shrinkage * room[position]) / denominator,
  ]));
}

function eventLoss(probabilities, observed) {
  let brier = 0;
  for (const position of POSITIONS) {
    const target = position === observed ? 1 : 0;
    brier += (probabilities[position] - target) ** 2;
  }
  return {
    brier,
    logLoss: -Math.log(Math.max(1e-12, probabilities[observed])),
    correct: POSITIONS.reduce((best, position) => probabilities[position] > probabilities[best] ? position : best, POSITIONS[0]) === observed,
  };
}

export function evaluateHeldOut(rows, heldOutSeason, options = {}) {
  const excluded = new Set(options.excludeManagerIds ?? []);
  const training = rows.filter((row) => row.season < heldOutSeason && !excluded.has(row.managerId));
  const test = rows.filter((row) => row.season === heldOutSeason && !excluded.has(row.managerId));
  if (!training.length || !test.length) throw new Error(`insufficient_history_for_${heldOutSeason}`);
  const model = trainPositionModel(training, { ...options, maxSeason: heldOutSeason - 1 });
  const events = test.map((row) => {
    const phase = draftPhase(row.round);
    const baseline = eventLoss(model.roomProbabilities[phase], row.position);
    const calibrated = eventLoss(predictPosition(model, row.managerId, row.round), row.position);
    return { managerId: row.managerId, baseline, calibrated, improvement: baseline.brier - calibrated.brier };
  });
  const mean = (field, lane) => events.reduce((sum, event) => sum + event[lane][field], 0) / events.length;
  return {
    season: heldOutSeason,
    events,
    baseline: { brier: mean("brier", "baseline"), logLoss: mean("logLoss", "baseline"), accuracy: events.filter((event) => event.baseline.correct).length / events.length },
    calibrated: { brier: mean("brier", "calibrated"), logLoss: mean("logLoss", "calibrated"), accuracy: events.filter((event) => event.calibrated.correct).length / events.length },
  };
}

function seededRandom(seed = 0x5f3759df) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function clusteredImprovementInterval(events, samples = 5000) {
  const groups = new Map();
  for (const event of events) {
    if (!groups.has(event.managerId)) groups.set(event.managerId, []);
    groups.get(event.managerId).push(event.improvement);
  }
  const managers = Array.from(groups.keys());
  if (managers.length < 2) return [null, null];
  const random = seededRandom();
  const improvements = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    let count = 0;
    for (let index = 0; index < managers.length; index += 1) {
      const manager = managers[Math.floor(random() * managers.length)];
      for (const value of groups.get(manager)) {
        total += value;
        count += 1;
      }
    }
    improvements.push(total / count);
  }
  improvements.sort((left, right) => left - right);
  return [improvements[Math.floor(samples * 0.025)], improvements[Math.floor(samples * 0.975)]];
}

export function selectParameters(rows, options = {}) {
  const validationSeasons = options.validationSeasons ?? [2023, 2024];
  const decays = options.decays ?? [0.65, 0.75, 0.85, 0.95, 1];
  const shrinkages = options.shrinkages ?? [4, 8, 16, 32, 64];
  const candidates = [];
  for (const decay of decays) {
    for (const shrinkage of shrinkages) {
      const evaluations = validationSeasons.map((season) => evaluateHeldOut(rows, season, { ...options, decay, shrinkage }));
      candidates.push({
        decay,
        shrinkage,
        brier: evaluations.reduce((sum, evaluation) => sum + evaluation.calibrated.brier, 0) / evaluations.length,
      });
    }
  }
  candidates.sort((left, right) => left.brier - right.brier || right.shrinkage - left.shrinkage || right.decay - left.decay);
  return candidates[0];
}

function profileId() {
  return `owner-${randomBytes(5).toString("hex")}`;
}

export function buildCalibration(rows, options = {}) {
  const excludedManagers = new Set(options.excludeManagerIds ?? []);
  const opponentRows = rows.filter((row) => !excludedManagers.has(row.managerId));
  const excludedRows = rows.length - opponentRows.length;
  const parameters = selectParameters(opponentRows, options);
  const heldOut = evaluateHeldOut(opponentRows, options.testSeason ?? 2025, { ...options, ...parameters });
  const interval = clusteredImprovementInterval(heldOut.events, options.bootstrapSamples ?? 5000);
  const meanImprovement = heldOut.baseline.brier - heldOut.calibrated.brier;
  const enabled = meanImprovement > 0 && interval[0] != null && interval[0] > 0;
  const model = trainPositionModel(opponentRows, {
    ...parameters,
    maxSeason: Math.max(...opponentRows.map((row) => row.season)),
  });
  const managerIds = Array.from(new Set(opponentRows.map((row) => row.managerId))).sort();
  const profiles = {};
  const managerMap = {};
  for (const managerId of managerIds) {
    const id = profileId(managerId);
    managerMap[managerId] = id;
    profiles[id] = Object.fromEntries(["opening", "core", "bench", "specialists"].map((phase) => {
      const sampleRound = { opening: 2, core: 6, bench: 12, specialists: 17 }[phase];
      return [phase, predictPosition(model, managerId, sampleRound)];
    }));
  }
  return {
    calibration: {
      enabled,
      reason: enabled ? "manager_position_model_cleared_held_out_gate" : "manager_position_model_failed_held_out_gate",
      validationSeasons: options.validationSeasons ?? [2023, 2024],
      testSeason: options.testSeason ?? 2025,
      parameters,
      events: heldOut.events.length,
      baseline: heldOut.baseline,
      calibrated: heldOut.calibrated,
      meanBrierImprovement: meanImprovement,
      clustered95Interval: interval,
      excludedManagers: new Set(rows.filter((row) => excludedManagers.has(row.managerId)).map((row) => row.managerId)).size,
      excludedRows,
    },
    room: model.roomProbabilities,
    profiles,
    managerMap,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) args[argv[index]?.replace(/^--/, "")] = argv[index + 1];
  if (!args.input || !args.output || !args.mapping || !args["exclude-manager"]) {
    throw new Error("usage: node analysis/opponent-calibration.mjs --input history.csv --output calibration.json --mapping private-map.json --exclude-manager owner-id");
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = parseArgs(process.argv.slice(2));
  const rows = parseHistory(readFileSync(args.input, "utf8"));
  const excludeManagerIds = args["exclude-manager"].split(",").filter(Boolean);
  if (!rows.some((row) => excludeManagerIds.includes(row.managerId))) {
    throw new Error("required_excluded_manager_not_found_in_history");
  }
  const result = buildCalibration(rows, {
    excludeManagerIds,
  });
  const sanitized = { ...result, managerMap: undefined };
  writeFileSync(args.output, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(args.mapping, `${JSON.stringify({ managerMap: result.managerMap }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(result.calibration)}\n`);
}
