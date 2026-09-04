import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { parseCsv } from "./opponent-calibration.mjs";

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function normalizePosition(value) {
  const position = String(value ?? "").toUpperCase();
  if (["DE", "DT", "NT"].includes(position)) return "DL";
  if (["CB", "S", "FS", "SS"].includes(position)) return "DB";
  if (["ILB", "OLB"].includes(position)) return "LB";
  return position;
}

export function parseMarketHistory(text) {
  return parseCsv(text).map((row) => ({
    season: Number(row.season),
    managerId: String(row.owner_id ?? row.manager_id ?? ""),
    position: normalizePosition(row.position),
    pick: Number(row.overall_pick ?? row.pick),
    marketAdp: Number(row.market_adp),
    yahooRank: finite(row.yahoo_rank) ? Number(row.yahoo_rank) : null,
    staticBpaRank: finite(row.static_bpa_rank) ? Number(row.static_bpa_rank) : null,
  })).filter((row) =>
    Number.isInteger(row.season) && row.managerId && row.position &&
    finite(row.pick) && row.pick > 0 && finite(row.marketAdp) && row.marketAdp > 0
  );
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function residualBucket(rows, maxSeason, decay) {
  const values = rows.map((row) => ({
    residual: row.pick - row.marketAdp,
    weight: decay ** Math.max(0, maxSeason - row.season),
  })).sort((left, right) => left.residual - right.residual);
  const center = median(values.map((row) => row.residual)) ?? 0;
  const scale = Math.max(3, median(values.map((row) => Math.abs(row.residual - center))) ?? 3);
  return { sampleCount: values.length, scale, values };
}

export function trainSurvivalModel(rows, options = {}) {
  const decay = Number(options.decay ?? 0.95);
  const minimumPositionSamples = Number(options.minimumPositionSamples ?? 30);
  const maxSeason = Number(options.maxSeason ?? Math.max(...rows.map((row) => row.season)));
  const global = residualBucket(rows, maxSeason, decay);
  const positions = {};
  for (const position of new Set(rows.map((row) => row.position))) {
    positions[position] = residualBucket(rows.filter((row) => row.position === position), maxSeason, decay);
  }
  return { decay, maxSeason, minimumPositionSamples, global, positions };
}

function bucketProbability(bucket, threshold) {
  const survivedWeight = bucket.values.reduce((sum, row) => sum + (row.residual >= threshold ? row.weight : 0), 0);
  const totalWeight = bucket.values.reduce((sum, row) => sum + row.weight, 0);
  return (survivedWeight + 1) / (totalWeight + 2);
}

export function calibratedSurvivalProbability(model, { position, marketMean, nextPick, runPressure = 0, roomOnly = false } = {}) {
  if (!model?.global?.values?.length) throw new Error("survival model is empty");
  if (!finite(marketMean) || !finite(nextPick)) throw new Error("marketMean and nextPick are required");
  const normalizedPosition = normalizePosition(position);
  const positionBucket = model.positions?.[normalizedPosition];
  const bucket = !roomOnly && positionBucket?.sampleCount >= model.minimumPositionSamples
    ? positionBucket
    : model.global;
  const pressure = Math.max(-2, Math.min(2, Number(runPressure) || 0));
  const threshold = Number(nextPick) - Number(marketMean) + pressure * bucket.scale * 0.25;
  return Math.max(0.01, Math.min(0.99, bucketProbability(bucket, threshold)));
}

function metrics(events, key) {
  if (!events.length) return { sampleCount: 0, brier: null, logLoss: null, accuracy: null };
  return {
    sampleCount: events.length,
    brier: events.reduce((sum, event) => sum + (event[key] - event.observed) ** 2, 0) / events.length,
    logLoss: events.reduce((sum, event) => sum - Math.log(Math.max(1e-12, event.observed ? event[key] : 1 - event[key])), 0) / events.length,
    accuracy: events.filter((event) => (event[key] >= 0.5) === Boolean(event.observed)).length / events.length,
  };
}

function seededRandom(seed = 0x6d2b79f5) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function clusteredImprovementInterval(events, samples = 3000) {
  const groups = new Map();
  for (const event of events) {
    if (!groups.has(event.managerId)) groups.set(event.managerId, []);
    groups.get(event.managerId).push((event.roomResidualBaseline - event.observed) ** 2 - (event.calibrated - event.observed) ** 2);
  }
  const managers = [...groups.keys()];
  if (managers.length < 2) return [null, null];
  const random = seededRandom();
  const results = [];
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
    results.push(total / count);
  }
  results.sort((left, right) => left - right);
  return [results[Math.floor(samples * 0.025)], results[Math.floor(samples * 0.975)]];
}

export function evaluateSurvivalCalibration(rows, options = {}) {
  const holdoutSeason = Number(options.holdoutSeason ?? Math.max(...rows.map((row) => row.season)));
  const excluded = new Set(Array.from(options.excludeManagerIds ?? [], String));
  const training = rows.filter((row) => row.season < holdoutSeason && !excluded.has(row.managerId));
  const holdout = rows.filter((row) => row.season === holdoutSeason && !excluded.has(row.managerId));
  if (!training.length || !holdout.length) throw new Error(`insufficient_history_for_${holdoutSeason}`);
  const model = trainSurvivalModel(training, { ...options, maxSeason: holdoutSeason - 1 });
  const offsets = Array.from(options.thresholdOffsets ?? [-12, 0, 12], Number);
  const events = holdout.flatMap((row) => offsets.map((offset) => {
    const nextPick = Math.max(1, Math.round(row.marketAdp + offset));
    return {
      managerId: row.managerId,
      position: row.position,
      nextPick,
      observed: row.pick >= nextPick ? 1 : 0,
      calibrated: calibratedSurvivalProbability(model, { position: row.position, marketMean: row.marketAdp, nextPick }),
      roomResidualBaseline: calibratedSurvivalProbability(model, { position: row.position, marketMean: row.marketAdp, nextPick, roomOnly: true }),
    };
  }));
  const calibrated = metrics(events, "calibrated");
  const roomResidualBaseline = metrics(events, "roomResidualBaseline");
  const interval = clusteredImprovementInterval(events, Number(options.bootstrapSamples ?? 3000));
  const meanImprovement = roomResidualBaseline.brier - calibrated.brier;
  const positionLayerEnabled = meanImprovement > 0 && interval[0] != null && interval[0] > 0;
  const publicAdpSurvivalBenchmark = false;
  const enabled = positionLayerEnabled && publicAdpSurvivalBenchmark;
  return {
    calibration: {
      enabled,
      reason: enabled
        ? "room_survival_enabled_all_benchmarks_cleared"
        : "room_survival_disabled_without_positive_public_adp_benchmark",
      positionLayerEnabled,
      holdoutSeason,
      trainingRows: training.length,
      holdoutRows: holdout.length,
      events: events.length,
      roomResidualBaseline,
      calibrated,
      meanBrierImprovement: meanImprovement,
      clustered95Interval: interval,
      excludedManagers: new Set(rows.filter((row) => excluded.has(row.managerId)).map((row) => row.managerId)).size,
      excludedRows: rows.filter((row) => excluded.has(row.managerId)).length,
      comparisonCoverage: {
        publicMarketAdpInput: true,
        roomResidualBaseline: true,
        publicAdpSurvivalBenchmark,
        yahooPreDraftRank: holdout.some((row) => row.yahooRank != null),
        staticBpa: holdout.some((row) => row.staticBpaRank != null),
        unavailableReason: "a standalone public-ADP survival benchmark and historical point-in-time Yahoo/static-BPA ranks were not captured",
      },
    },
    model,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) args[argv[index]?.replace(/^--/, "")] = argv[index + 1];
  if (!args.input || !args.output || !args["exclude-manager"]) {
    throw new Error("usage: node analysis/draft-survival-calibration.mjs --input draft-picks.csv --output survival.json --exclude-manager owner-id");
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = parseArgs(process.argv.slice(2));
  const rows = parseMarketHistory(readFileSync(args.input, "utf8"));
  const result = evaluateSurvivalCalibration(rows, { excludeManagerIds: args["exclude-manager"].split(",").filter(Boolean) });
  writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(result.calibration)}\n`);
}
