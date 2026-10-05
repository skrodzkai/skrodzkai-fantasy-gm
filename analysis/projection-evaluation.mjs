import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function quantile(values, percentile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values) {
  return quantile(values, 0.5);
}

function combine(values) {
  const clean = values.map(Number).filter(Number.isFinite);
  if (!clean.length) return null;
  return clean.length >= 3 ? median(clean) : mean(clean);
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function rankByPosition(rows, valueField) {
  const ranks = new Map();
  const positions = new Set(rows.map((row) => row.position));
  for (const position of positions) {
    const sorted = rows.filter((row) => row.position === position && finite(row[valueField]))
      .sort((left, right) => Number(right[valueField]) - Number(left[valueField]) || String(left.yahooId).localeCompare(String(right.yahooId)));
    sorted.forEach((row, index) => ranks.set(`${row.yahooId}|${position}`, index + 1));
  }
  return ranks;
}

function pearson(pairs) {
  if (pairs.length < 3) return null;
  const xMean = mean(pairs.map((pair) => pair[0]));
  const yMean = mean(pairs.map((pair) => pair[1]));
  let numerator = 0;
  let xSquare = 0;
  let ySquare = 0;
  for (const [x, y] of pairs) {
    numerator += (x - xMean) * (y - yMean);
    xSquare += (x - xMean) ** 2;
    ySquare += (y - yMean) ** 2;
  }
  return xSquare > 0 && ySquare > 0 ? numerator / Math.sqrt(xSquare * ySquare) : null;
}

function spearman(rows) {
  if (rows.length < 2) return null;
  const predicted = new Map([...rows].sort((left, right) => right.predicted - left.predicted || left.playerId.localeCompare(right.playerId)).map((row, index) => [row.playerId, index + 1]));
  const actual = new Map([...rows].sort((left, right) => right.actual - left.actual || left.playerId.localeCompare(right.playerId)).map((row, index) => [row.playerId, index + 1]));
  const d2 = rows.reduce((sum, row) => sum + (predicted.get(row.playerId) - actual.get(row.playerId)) ** 2, 0);
  return 1 - 6 * d2 / (rows.length * (rows.length ** 2 - 1));
}

function topHitRate(rows, count) {
  const actual = new Set([...rows].sort((left, right) => right.actual - left.actual || left.playerId.localeCompare(right.playerId)).slice(0, count).map((row) => row.playerId));
  const predicted = [...rows].sort((left, right) => right.predicted - left.predicted || left.playerId.localeCompare(right.playerId)).slice(0, count);
  return actual.size ? predicted.filter((row) => actual.has(row.playerId)).length / Math.min(count, actual.size) : null;
}

function normalizedForwardSnapshots(rankingPack) {
  const sourceAsOf = new Map((rankingPack.rawSources ?? []).map((snapshot) => [snapshot.manifest?.sourceFamily, snapshot.manifest?.sourceAsOf]));
  sourceAsOf.set("yahoo", rankingPack.baseBoardReceipt?.generatedAt ?? rankingPack.generatedAt);
  const families = new Set((rankingPack.players ?? []).flatMap((player) => Object.keys(player.sourceFamilyPerGamePoints ?? {})));
  if ((rankingPack.players ?? []).some((player) => finite(player.priorYahooPerGame))) families.add("yahoo");
  return [...families].sort().map((sourceFamily) => ({
    manifest: { sourceId: sourceFamily, sourceFamily, sourceAsOf: sourceAsOf.get(sourceFamily) ?? rankingPack.generatedAt },
    rows: (rankingPack.players ?? []).flatMap((player) => {
      const value = sourceFamily === "yahoo" ? player.priorYahooPerGame : player.sourceFamilyPerGamePoints?.[sourceFamily];
      return finite(value) ? [{ playerId: String(player.yahooId), position: player.position, perGamePoints: Number(value) }] : [];
    }),
  }));
}

export function scorePublisherOutcomes({ snapshots, outcomes, periodStart }) {
  for (const snapshot of snapshots) validatePrePeriodSnapshot(snapshot, periodStart);
  const cleanOutcomes = outcomes.filter((row) => finite(row.points) && Number(row.week) >= 1 && Number(row.week) <= 17 && row.appeared !== false);
  const actualByPlayer = new Map();
  for (const row of cleanOutcomes) {
    const key = `${row.playerId ?? row.yahooId}|${row.position}`;
    if (!actualByPlayer.has(key)) actualByPlayer.set(key, []);
    actualByPlayer.get(key).push(Number(row.points));
  }
  const errorsBySourceWeek = new Map();
  const bySource = {};
  for (const snapshot of snapshots) {
    const sourceId = snapshot.manifest.sourceId;
    const predictions = new Map((snapshot.rows ?? []).filter((row) => finite(row.perGamePoints)).map((row) => [`${row.playerId ?? row.yahooId}|${row.position}`, Number(row.perGamePoints)]));
    const weekly = cleanOutcomes.flatMap((row) => {
      const key = `${row.playerId ?? row.yahooId}|${row.position}`;
      const predicted = predictions.get(key);
      return Number.isFinite(predicted) ? [{ key: `${key}|${row.week}`, playerId: String(row.playerId ?? row.yahooId), position: row.position, predicted, actual: Number(row.points) }] : [];
    });
    errorsBySourceWeek.set(sourceId, new Map(weekly.map((row) => [row.key, row.predicted - row.actual])));
    const playerRows = [...actualByPlayer].flatMap(([key, values]) => {
      const predicted = predictions.get(key);
      const [playerId, position] = key.split("|");
      return Number.isFinite(predicted) ? [{ playerId, position, predicted, actual: mean(values) }] : [];
    });
    const byPosition = {};
    for (const position of [...new Set(playerRows.map((row) => row.position))].sort()) {
      const rows = playerRows.filter((row) => row.position === position);
      const weeks = weekly.filter((row) => row.position === position);
      byPosition[position] = {
        playerCount: rows.length,
        playerWeeks: weeks.length,
        weeklyMae: mean(weeks.map((row) => Math.abs(row.predicted - row.actual))),
        spearman: spearman(rows),
        topHitRate: Object.fromEntries([12, 24, 36].map((count) => [String(count), topHitRate(rows, count)])),
      };
    }
    bySource[sourceId] = { sourceAsOf: snapshot.manifest.sourceAsOf, byPosition };
  }
  const pairwiseSourceErrorCorrelation = {};
  const sourceIds = [...errorsBySourceWeek.keys()].sort();
  for (let left = 0; left < sourceIds.length; left += 1) {
    for (let right = left + 1; right < sourceIds.length; right += 1) {
      const leftErrors = errorsBySourceWeek.get(sourceIds[left]);
      const rightErrors = errorsBySourceWeek.get(sourceIds[right]);
      const pairs = [...leftErrors].flatMap(([key, value]) => rightErrors.has(key) ? [[value, rightErrors.get(key)]] : []);
      pairwiseSourceErrorCorrelation[`${sourceIds[left]}|${sourceIds[right]}`] = { commonPlayerWeeks: pairs.length, correlation: pearson(pairs) };
    }
  }
  return { status: "SCORED", periodStart, outcomeRows: cleanOutcomes.length, bySource, pairwiseSourceErrorCorrelation };
}

export function validatePrePeriodSnapshot(snapshot, periodStart) {
  const sourceAsOf = Date.parse(snapshot?.manifest?.sourceAsOf);
  const start = Date.parse(periodStart);
  if (!Number.isFinite(sourceAsOf) || !Number.isFinite(start)) throw new Error("snapshot and period start require ISO timestamps");
  if (sourceAsOf >= start) throw new Error(`${snapshot.manifest.sourceId ?? "snapshot"} is not point-in-time evidence for ${periodStart}`);
  return true;
}

export function currentSourceAblations(players) {
  const families = [...new Set(players.flatMap((player) => Object.keys(player.sourceFamilyPerGamePoints ?? {})))].sort();
  const baselineRows = players.map((player) => ({
    yahooId: String(player.yahooId),
    position: player.position,
    baseline: combine(Object.values(player.sourceFamilyPerGamePoints ?? {})),
  }));
  const baselineRanks = rankByPosition(baselineRows, "baseline");
  return Object.fromEntries(families.map((excludedFamily) => {
    const rows = players.map((player) => {
      const values = Object.entries(player.sourceFamilyPerGamePoints ?? {}).filter(([family]) => family !== excludedFamily).map(([, value]) => value);
      return { yahooId: String(player.yahooId), position: player.position, ablated: combine(values) };
    });
    const ablatedRanks = rankByPosition(rows, "ablated");
    const movements = rows.flatMap((row) => {
      const key = `${row.yahooId}|${row.position}`;
      const before = baselineRanks.get(key);
      const after = ablatedRanks.get(key);
      return before && after ? [{ yahooId: row.yahooId, position: row.position, before, after, movement: after - before }] : [];
    });
    const absolute = movements.map((row) => Math.abs(row.movement));
    return [excludedFamily, {
      comparedPlayers: movements.length,
      medianAbsoluteRankMovement: median(absolute),
      p90AbsoluteRankMovement: quantile(absolute, 0.9),
      maximumAbsoluteRankMovement: absolute.length ? Math.max(...absolute) : null,
      topMovers: movements.sort((left, right) => Math.abs(right.movement) - Math.abs(left.movement) || left.yahooId.localeCompare(right.yahooId)).slice(0, 20),
    }];
  }));
}

export function currentSourceDisagreement(players) {
  const families = [...new Set(players.flatMap((player) => Object.keys(player.sourceFamilyPerGamePoints ?? {})))].sort();
  const result = {};
  for (let leftIndex = 0; leftIndex < families.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < families.length; rightIndex += 1) {
      const leftFamily = families[leftIndex];
      const rightFamily = families[rightIndex];
      const pairs = players.flatMap((player) => {
        const left = Number(player.sourceFamilyPerGamePoints?.[leftFamily]);
        const right = Number(player.sourceFamilyPerGamePoints?.[rightFamily]);
        const center = median(Object.values(player.sourceFamilyPerGamePoints ?? {}).map(Number).filter(Number.isFinite));
        return Number.isFinite(left) && Number.isFinite(right) && Number.isFinite(center) ? [[left - center, right - center]] : [];
      });
      result[`${leftFamily}|${rightFamily}`] = { commonPlayers: pairs.length, residualCorrelation: pearson(pairs) };
    }
  }
  return result;
}

export function buildProjectionEvaluation({ rankingPack, historicalCalibration, generatedAt, historicalPublisherSnapshots = [], publisherOutcomes = [], evaluationPeriodStart = "2026-09-09T00:00:00Z" }) {
  for (const snapshot of historicalPublisherSnapshots) validatePrePeriodSnapshot(snapshot, evaluationPeriodStart);
  const forwardSnapshots = normalizedForwardSnapshots(rankingPack);
  const hasOutcomes = historicalPublisherSnapshots.length > 0 && publisherOutcomes.length > 0;
  return {
    schemaVersion: 1,
    generatedAt,
    posture: "research evaluation only; no ranking or Yahoo mutation authority",
    forwardSnapshotReceipt: {
      evaluationPeriodStart,
      frozenAt: generatedAt,
      intendedUse: "future outcome scoring only; not retrospective accuracy evidence",
      snapshots: forwardSnapshots.map((snapshot) => ({
        sourceId: snapshot.manifest?.sourceId ?? null,
        sourceFamily: snapshot.manifest?.sourceFamily ?? null,
        sourceAsOf: snapshot.manifest?.sourceAsOf ?? null,
        rows: snapshot.rows?.length ?? 0,
        sha256: sha256Json(snapshot),
      })),
    },
    challengerZero: historicalCalibration.challengerZero,
    currentSensitivity: {
      interpretation: "rank movement and residual correlation describe current-source sensitivity, not historical accuracy",
      sourceAblations: currentSourceAblations(rankingPack.players ?? []),
      sourceDisagreement: currentSourceDisagreement(rankingPack.players ?? []),
    },
    publisherAccuracy: hasOutcomes
      ? scorePublisherOutcomes({ snapshots: historicalPublisherSnapshots, outcomes: publisherOutcomes, periodStart: evaluationPeriodStart })
      : { status: "FORWARD_EVIDENCE_PENDING", acceptedSnapshots: historicalPublisherSnapshots.length, reason: "no complete point-in-time snapshot plus subsequent outcome pair exists", prohibitedClaim: "current 2026 snapshots cannot establish retrospective publisher accuracy" },
    learnedWeightGate: {
      enabled: false,
      reason: "requires forward 2026 outcomes and held-out improvement over equal-family voting plus challenger zero",
      requiredMetrics: ["active-game MAE", "season-total MAE", "Spearman rank correlation", "top-12/24/36 hit rate", "pairwise source-error correlation"],
    },
  };
}

function args(argv) {
  return Object.fromEntries(argv.map((entry) => { const [key, ...value] = entry.replace(/^--/, "").split("="); return [key, value.join("=")]; }));
}

// Later actuals are explicit league-scored, completed-period artifacts. Evaluation never tunes
// weights or replaces a forecast with a recomputation after kickoff.
export function evaluateWeeklyForecasts(forecasts, actualReports) {
  const excluded = [], evaluated = [];
  if (!Array.isArray(forecasts) || !forecasts.length) return { status: "NOT_EVALUATED", reason: "NO_PRIOR_SAVED_FORECAST", byPosition: {}, evaluated: [], excluded: [] };
  const seen = new Set();
  for (const forecast of forecasts) {
    const generated = Date.parse(forecast.generatedAt);
    const actual = (actualReports ?? []).find((r) => r.season === forecast.season && r.week === forecast.targetWeek);
    const sourceValid = (receipt, sourceId, season, week) => receipt?.sourceId === sourceId && receipt.season === season && receipt.week === week &&
      /^[a-f0-9]{64}$/.test(receipt.contentSha256 ?? "") && Number.isFinite(Date.parse(receipt.retrievedAt));
    if (!Number.isInteger(forecast.season) || !Number.isInteger(forecast.targetWeek) || !Number.isFinite(generated) || generated > Date.now() ||
        !Number.isInteger(forecast.completedThroughWeek) || forecast.completedThroughWeek >= forecast.targetWeek ||
        !actual || actual.completed !== true || actual.scoringSource !== "analysis/player-intelligence.mjs" ||
        !sourceValid(actual.receipts?.actuals, "sleeper", forecast.season, forecast.targetWeek) ||
        !sourceValid(actual.receipts?.completedSchedule, "espn-schedule", forecast.season, forecast.targetWeek) ||
        actual.completedVerifiedAt !== actual.receipts.completedSchedule.retrievedAt || actual.retrievedAt !== actual.receipts.actuals.retrievedAt ||
        Date.parse(actual.retrievedAt) > Date.now() ||
        Date.parse(actual.retrievedAt) < Date.parse(actual.completedVerifiedAt) ||
        !sourceValid(forecast.provenance?.schedule, "espn-schedule", forecast.season, forecast.targetWeek) ||
        Date.parse(forecast.provenance.schedule.retrievedAt) > generated ||
        !Array.isArray(forecast.players) || !Array.isArray(actual.players) ||
        (forecast.provenance?.week1List ?? []).length !== forecast.completedThroughWeek ||
        (forecast.provenance?.week1List ?? []).some((receipt, i) => !sourceValid(receipt, "sleeper", forecast.season, i + 1) || Date.parse(receipt.retrievedAt) > generated)) {
      excluded.push({ week: forecast.targetWeek, reason: "UNVERIFIED_FORECAST_OR_LATER_COMPLETED_ACTUAL_PERIOD" }); continue;
    }
    const actualById = new Map(actual.players.map((row) => [String(row.playerId), row]));
    if (actualById.size !== actual.players.length || new Set(forecast.players.map((r) => String(r.playerId))).size !== forecast.players.length) {
      excluded.push({ week: forecast.targetWeek, reason: "DUPLICATE_IDENTITY" }); continue;
    }
    for (const row of forecast.players) {
      if (!row.rankable || !finite(row.weeklyExpectation)) continue;
      const observed = actualById.get(String(row.playerId)), kickoff = Date.parse(row.kickoff);
      const key = `${forecast.season}|${forecast.targetWeek}|${row.playerId}`;
      if (!observed) {
        const unresolved = actual.unresolvedPlayers?.find((item) => String(item.playerId) === String(row.playerId) &&
          item.sleeperId === row.sleeperId && item.position === row.position);
        excluded.push({ playerId: row.playerId, position: row.position, week: forecast.targetWeek,
          reason: unresolved?.reason === "NO_PARTICIPATION_ROW_UNRESOLVED" ? unresolved.reason : "IDENTITY_TIMING_OR_ACTUAL_UNVERIFIED" });
        continue;
      }
      if (!observed || !Number.isFinite(kickoff) || generated >= kickoff || Date.parse(actual.completedVerifiedAt) <= kickoff || observed.kickoff !== row.kickoff ||
          observed.position !== row.position || !row.sleeperId && row.position !== "DEF" ||
          observed.sleeperId !== row.sleeperId || !finite(observed.actualPoints) || seen.has(key)) {
        excluded.push({ playerId: row.playerId, position: row.position, week: forecast.targetWeek, reason: "IDENTITY_TIMING_OR_ACTUAL_UNVERIFIED" }); continue;
      }
      seen.add(key);
      const yahooBeforeKickoff = Number.isFinite(Date.parse(row.yahooComparisonCapturedAt)) &&
        Date.parse(row.yahooComparisonCapturedAt) <= generated && Date.parse(row.yahooComparisonCapturedAt) < kickoff;
      evaluated.push({ playerId: key, position: row.position, week: forecast.targetWeek, predicted: Number(row.weeklyExpectation),
        actual: Number(observed.actualPoints), naive: finite(row.naiveBaseline) ? Number(row.naiveBaseline) : null,
        yahoo: yahooBeforeKickoff && finite(row.yahooWeek2Projection) ? Number(row.yahooWeek2Projection) : null });
    }
  }
  const metrics = (rows, field) => {
    const valid = rows.filter((r) => finite(r[field]));
    const ranks = (key) => {
      const sorted = [...valid].sort((a, b) => b[key] - a[key]), result = new Map();
      for (let i = 0; i < sorted.length;) {
        let end = i + 1; while (end < sorted.length && sorted[end][key] === sorted[i][key]) end += 1;
        for (let j = i; j < end; j += 1) result.set(sorted[j].playerId, (i + 1 + end) / 2);
        i = end;
      }
      return result;
    };
    const predictedRanks = ranks(field), actualRanks = ranks("actual");
    return { sample: valid.length, mae: mean(valid.map((r) => Math.abs(r[field] - r.actual))),
      spearman: pearson(valid.map((r) => [predictedRanks.get(r.playerId), actualRanks.get(r.playerId)])) };
  };
  const byPosition = Object.fromEntries([...new Set(evaluated.map((r) => r.position))].map((position) => {
    const rows = evaluated.filter((r) => r.position === position);
    const paired = (field) => {
      const common = rows.filter((row) => finite(row[field]));
      const forecast = metrics(common, "predicted"), comparator = metrics(common, field);
      return { sample: common.length, forecast, comparator,
        forecastMinusComparatorMae: forecast.mae == null ? null : forecast.mae - comparator.mae };
    };
    return [position, { forecast: metrics(rows, "predicted"), naiveCompletedGameMean: metrics(rows, "naive"),
      yahooTimestampedComparison: metrics(rows, "yahoo"), totalsScope: "AVAILABLE_PER_METHOD_UNPAIRED",
      pairedComparisons: { naiveCompletedGameMean: paired("naive"), yahooTimestampedComparison: paired("yahoo") } }];
  }));
  const exclusionsByPosition = {};
  for (const row of excluded) {
    const position = row.position ?? "UNKNOWN", counts = exclusionsByPosition[position] ??= {};
    counts[row.reason] = (counts[row.reason] ?? 0) + 1;
  }
  return { status: evaluated.length ? "EVALUATED_REPORT_ONLY" : "NOT_EVALUATED", byPosition, evaluated, excluded,
    exclusionsByPosition, absencePolicy: "MISSING_PARTICIPATION_REMAINS_UNRESOLVED_NEVER_ZERO",
    tuning: "DISABLED", acceptance: "PENDING_FORWARD_FORECAST_ACCEPTANCE_NO_PREDICTIVE_IMPROVEMENT_CLAIM" };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const input = args(process.argv.slice(2));
  for (const key of ["ranking-pack", "calibration", "output", "generated-at"]) if (!input[key]) throw new Error(`missing --${key}`);
  const [rankingPack, historicalCalibration] = await Promise.all([
    readFile(input["ranking-pack"], "utf8").then(JSON.parse),
    readFile(input.calibration, "utf8").then(JSON.parse),
  ]);
  const output = buildProjectionEvaluation({ rankingPack, historicalCalibration, generatedAt: input["generated-at"] });
  await writeFile(input.output, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output: input.output, publisherAccuracy: output.publisherAccuracy.status, baselineMae: output.challengerZero.activeGameMae })}\n`);
}
