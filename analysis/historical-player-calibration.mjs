import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { parseCsv } from "./opponent-calibration.mjs";
import { scoreIdpStatLine, scoreKickerStatLine, scoreOffenseStatLine } from "./player-intelligence.mjs";

const FIRST_SEASON = 2020;
const TRAINING_END = 2024;
const HOLDOUT_SEASON = 2025;
const LAST_WEEK = 17;
const CURRENT_SEASON_GAMES = 16;
const SIMULATION_DRAWS = 10_000;
const SIMULATION_SEED = 0x5a17c0de;
const ELIGIBLE_ROSTER_STATUSES = new Set(["ACT", "INA", "PUP", "RES", "SUS", "EXE", "RSN"]);
const OFFENSE_POSITIONS = new Set(["QB", "RB", "WR", "TE"]);
const IDP_POSITIONS = new Set(["DL", "LB", "DB"]);
const CALIBRATION_POSITIONS = Object.freeze(["QB", "RB", "WR", "TE", "K", "DL", "LB", "DB"]);
const BASELINE_GRID = Object.freeze({ decay: [0.5, 0.75, 1], shrinkGames: [4, 8, 12] });
export const HISTORICAL_STATS_REQUIRED_COLUMNS = Object.freeze([
  "player_id", "player_display_name", "season", "week", "season_type", "position", "team",
  "completions", "passing_yards", "passing_tds", "passing_interceptions", "rushing_yards", "rushing_tds",
  "receptions", "receiving_yards", "receiving_tds", "punt_return_yards", "kickoff_return_yards", "special_teams_tds",
  "passing_2pt_conversions", "rushing_2pt_conversions", "receiving_2pt_conversions", "fumbles_lost_total",
  "def_tackles_solo", "def_tackle_assists", "def_sacks", "def_interceptions", "def_fumbles_forced", "def_fumbles",
  "def_tds", "def_safeties", "def_pass_defended", "def_punt_blocks", "def_pat_blocks", "def_fg_blocks",
  "def_tackles_for_loss", "def_interception_yards", "fumble_recovery_yards_opp", "def_2pt_made",
  "fg_made", "pat_made", "pat_att",
]);
const HISTORICAL_ROSTER_REQUIRED_COLUMNS = Object.freeze(["season", "week", "game_type", "team", "position", "status", "full_name", "birth_date", "gsis_id", "pfr_id"]);
const HISTORICAL_SNAP_REQUIRED_COLUMNS = Object.freeze(["season", "week", "game_type", "pfr_player_id", "position", "offense_snaps", "defense_snaps", "st_snaps"]);
const SCHEDULE_REQUIRED_COLUMNS = Object.freeze(["season", "week", "game_type", "away_team", "home_team"]);

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function number(row, field) {
  return finite(row?.[field]) ? Number(row[field]) : 0;
}

function normalizePosition(value) {
  const position = String(value ?? "").toUpperCase();
  if (position === "FB") return "RB";
  if (["DE", "DT", "NT", "EDGE"].includes(position)) return "DL";
  if (["CB", "S", "FS", "SS"].includes(position)) return "DB";
  if (["ILB", "MLB", "OLB"].includes(position)) return "LB";
  return position;
}

function assertColumns(rows, required, label) {
  if (!rows.length) throw new Error(`${label} has no rows`);
  const missing = required.filter((field) => !Object.hasOwn(rows[0], field));
  if (missing.length) throw new Error(`${label} schema drift: missing ${missing.join(",")}`);
}

export function calibrationPosition(player) {
  const filters = new Set(player?.yahooEligibilityFilters ?? []);
  if (!filters.has("O")) {
    if (filters.has("LB")) return "LB";
    if (filters.has("CB") || filters.has("DB")) return "DB";
    if (filters.has("D")) return normalizePosition(player?.specialistPosition || player?.position);
  }
  return normalizePosition(player?.position);
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

function ageAtSeasonStart(birthDate, season) {
  if (!birthDate || !Number.isFinite(Date.parse(birthDate))) return null;
  return Math.floor((Date.UTC(season, 8, 1) - Date.parse(birthDate)) / (365.2425 * 86_400_000));
}

function ageBand(age) {
  if (!finite(age)) return "UNKNOWN";
  if (Number(age) <= 25) return "LE_25";
  if (Number(age) <= 29) return "26_29";
  return "GE_30";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function offenseStats(row) {
  return {
    passingCompletions: number(row, "completions"),
    passingYards: number(row, "passing_yards"),
    passingTouchdowns: number(row, "passing_tds"),
    interceptions: number(row, "passing_interceptions"),
    rushingYards: number(row, "rushing_yards"),
    rushingTouchdowns: number(row, "rushing_tds"),
    rushingHundredYardGames: number(row, "rushing_yards") >= 100 ? 1 : 0,
    receptions: number(row, "receptions"),
    receivingYards: number(row, "receiving_yards"),
    receivingTouchdowns: number(row, "receiving_tds"),
    receivingHundredYardGames: number(row, "receiving_yards") >= 100 ? 1 : 0,
    returnYards: number(row, "punt_return_yards") + number(row, "kickoff_return_yards"),
    returnTouchdowns: number(row, "special_teams_tds"),
    twoPointConversions: number(row, "passing_2pt_conversions") + number(row, "rushing_2pt_conversions") + number(row, "receiving_2pt_conversions"),
    fumblesLost: number(row, "fumbles_lost_total"),
    offensiveFumbleReturnTouchdowns: 0,
  };
}

function idpStats(row) {
  return {
    soloTackles: number(row, "def_tackles_solo"),
    assistedTackles: number(row, "def_tackle_assists"),
    sacks: number(row, "def_sacks"),
    interceptions: number(row, "def_interceptions"),
    forcedFumbles: number(row, "def_fumbles_forced"),
    fumbleRecoveries: number(row, "def_fumbles"),
    touchdowns: number(row, "def_tds"),
    safeties: number(row, "def_safeties"),
    passesDefended: number(row, "def_pass_defended"),
    blockedKicks: number(row, "def_punt_blocks") + number(row, "def_pat_blocks") + number(row, "def_fg_blocks"),
    tacklesForLoss: number(row, "def_tackles_for_loss"),
    turnoverReturnYards: number(row, "def_interception_yards") + number(row, "fumble_recovery_yards_opp"),
    extraPointReturns: number(row, "def_2pt_made"),
  };
}

function kickerStats(row) {
  return {
    fieldGoalsMade: number(row, "fg_made"),
    extraPointsMade: number(row, "pat_made"),
    extraPointsAttempted: number(row, "pat_att"),
  };
}

function hasNonzero(stats) {
  return Object.values(stats).some((value) => Number(value) !== 0);
}

export function scoreHistoricalStatRow(row) {
  const playerId = String(row?.player_id ?? "");
  const season = Number(row?.season);
  const week = Number(row?.week);
  const position = normalizePosition(row?.position);
  if (!playerId || !Number.isInteger(season) || !Number.isInteger(week) || week < 1 || week > LAST_WEEK || row?.season_type !== "REG") return [];
  const base = { playerId, season, week, name: row.player_display_name || row.player_name || playerId, team: row.team || null };
  const lanes = [];
  if (OFFENSE_POSITIONS.has(position)) {
    const stats = offenseStats(row);
    lanes.push({ ...base, position, scoringKind: "offense", points: scoreOffenseStatLine(stats), statEvidence: hasNonzero(stats) });
  }
  const defense = idpStats(row);
  if (IDP_POSITIONS.has(position)) {
    lanes.push({ ...base, position, scoringKind: "idp", points: scoreIdpStatLine(defense), statEvidence: hasNonzero(defense) });
  }
  if (position === "K") {
    const stats = kickerStats(row);
    lanes.push({ ...base, position, scoringKind: "kicker", points: scoreKickerStatLine(stats), statEvidence: hasNonzero(stats) });
  }
  return lanes;
}

function scheduleTeamWeeks(scheduleRows, season) {
  const result = new Set();
  for (const row of scheduleRows) {
    const week = Number(row.week);
    if (Number(row.season) !== season || row.game_type !== "REG" || !Number.isInteger(week) || week < 1 || week > LAST_WEEK) continue;
    result.add(`${row.away_team}|${week}`);
    result.add(`${row.home_team}|${week}`);
  }
  return result;
}

function uniqueCrosswalk(rosterRows) {
  const candidates = new Map();
  for (const row of rosterRows) {
    if (!row.pfr_id || !row.gsis_id) continue;
    if (!candidates.has(row.pfr_id)) candidates.set(row.pfr_id, new Set());
    candidates.get(row.pfr_id).add(row.gsis_id);
  }
  const crosswalk = new Map();
  const ambiguous = [];
  for (const [pfrId, ids] of candidates) {
    if (ids.size === 1) crosswalk.set(pfrId, [...ids][0]);
    else ambiguous.push(pfrId);
  }
  return { crosswalk, ambiguous: ambiguous.sort() };
}

function laneKey(playerId, position, week) {
  return `${playerId}|${position}|${week}`;
}

function playerWeekKey(playerId, week) {
  return `${playerId}|${week}`;
}

export function parseHistoricalSeason({ statsText, rosterText, snapText, scheduleRows, season }) {
  const allStatsRows = parseCsv(statsText);
  const allRosterRows = parseCsv(rosterText);
  const allSnapRows = parseCsv(snapText);
  assertColumns(allStatsRows, HISTORICAL_STATS_REQUIRED_COLUMNS, `stats ${season}`);
  assertColumns(allRosterRows, HISTORICAL_ROSTER_REQUIRED_COLUMNS, `weekly roster ${season}`);
  assertColumns(allSnapRows, HISTORICAL_SNAP_REQUIRED_COLUMNS, `snap counts ${season}`);
  assertColumns(scheduleRows, SCHEDULE_REQUIRED_COLUMNS, "schedule");
  const statsRows = allStatsRows.filter((row) => Number(row.season) === season);
  const rosterRows = allRosterRows.filter((row) => Number(row.season) === season && Number(row.week) <= LAST_WEEK && row.game_type === "REG");
  const snapRows = allSnapRows.filter((row) => Number(row.season) === season && Number(row.week) <= LAST_WEEK && row.game_type === "REG");
  const teamWeeks = scheduleTeamWeeks(scheduleRows, season);
  const { crosswalk, ambiguous } = uniqueCrosswalk(rosterRows);
  const identityByGsis = new Map();
  const eligibleWeeks = new Map();
  for (const row of rosterRows) {
    if (!row.gsis_id) continue;
    const current = identityByGsis.get(row.gsis_id) ?? {};
    identityByGsis.set(row.gsis_id, {
      playerId: row.gsis_id,
      name: row.full_name || current.name || row.gsis_id,
      position: normalizePosition(row.position || current.position),
      birthDate: row.birth_date || current.birthDate || null,
    });
    if (!ELIGIBLE_ROSTER_STATUSES.has(row.status) || !teamWeeks.has(`${row.team}|${Number(row.week)}`)) continue;
    if (!eligibleWeeks.has(row.gsis_id)) eligibleWeeks.set(row.gsis_id, new Set());
    eligibleWeeks.get(row.gsis_id).add(Number(row.week));
  }

  const globalAppearances = new Set();
  const laneAppearances = new Map();
  const unmatchedPfrIds = new Set();
  for (const row of snapRows) {
    const totalSnaps = number(row, "offense_snaps") + number(row, "defense_snaps") + number(row, "st_snaps");
    if (!(totalSnaps > 0)) continue;
    const playerId = crosswalk.get(row.pfr_player_id);
    if (!playerId) {
      if (row.pfr_player_id) unmatchedPfrIds.add(row.pfr_player_id);
      continue;
    }
    const week = Number(row.week);
    globalAppearances.add(playerWeekKey(playerId, week));
    const rawPosition = normalizePosition(row.position);
    const positions = [];
    if (number(row, "offense_snaps") > 0 && OFFENSE_POSITIONS.has(rawPosition)) positions.push(rawPosition);
    if (number(row, "defense_snaps") > 0 && IDP_POSITIONS.has(rawPosition)) positions.push(rawPosition);
    if (number(row, "st_snaps") > 0 && rawPosition === "K") positions.push("K");
    for (const position of new Set(positions)) {
      laneAppearances.set(laneKey(playerId, position, week), { playerId, season, week, position });
    }
  }

  const pointsByLane = new Map();
  for (const row of statsRows) {
    for (const lane of scoreHistoricalStatRow(row)) {
      const key = laneKey(lane.playerId, lane.position, lane.week);
      pointsByLane.set(key, lane);
      if (lane.statEvidence) {
        globalAppearances.add(playerWeekKey(lane.playerId, lane.week));
        laneAppearances.set(key, { playerId: lane.playerId, season, week: lane.week, position: lane.position });
      }
      if (!identityByGsis.has(lane.playerId)) {
        identityByGsis.set(lane.playerId, { playerId: lane.playerId, name: lane.name, position: lane.position, birthDate: null });
      }
    }
  }

  const weeklyScores = [...laneAppearances].map(([key, appearance]) => {
    const scored = pointsByLane.get(key);
    const identity = identityByGsis.get(appearance.playerId) ?? {};
    return {
      ...appearance,
      name: scored?.name ?? identity.name ?? appearance.playerId,
      team: scored?.team ?? null,
      points: scored?.points ?? 0,
      appearanceSource: scored?.statEvidence ? "STATS" : "SNAPS",
    };
  }).sort((left, right) => left.playerId.localeCompare(right.playerId) || left.position.localeCompare(right.position) || left.week - right.week);

  const playerSeasons = [...eligibleWeeks].map(([playerId, weeks]) => {
    const identity = identityByGsis.get(playerId) ?? {};
    const appearances = [...weeks].filter((week) => globalAppearances.has(playerWeekKey(playerId, week))).length;
    return {
      playerId,
      season,
      name: identity.name ?? playerId,
      position: normalizePosition(identity.position),
      age: ageAtSeasonStart(identity.birthDate, season),
      ageBand: ageBand(ageAtSeasonStart(identity.birthDate, season)),
      eligibleGames: weeks.size,
      appearances,
      equivalentGamesThroughWeek17: weeks.size ? appearances / weeks.size * CURRENT_SEASON_GAMES : 0,
    };
  }).filter((row) => CALIBRATION_POSITIONS.includes(row.position)).sort((left, right) => left.playerId.localeCompare(right.playerId));

  return {
    weeklyScores,
    playerSeasons,
    receipts: {
      season,
      statsRows: statsRows.length,
      rosterRows: rosterRows.length,
      snapRows: snapRows.length,
      weeklyScoreRows: weeklyScores.length,
      eligiblePlayerSeasons: playerSeasons.length,
      crosswalkIds: crosswalk.size,
      ambiguousPfrIds: ambiguous,
      unmatchedPfrIds: [...unmatchedPfrIds].sort(),
      weekHorizon: [1, LAST_WEEK],
    },
  };
}

function playerSeasonSummaries(weeklyScores) {
  const groups = new Map();
  for (const row of weeklyScores) {
    const key = `${row.season}|${row.playerId}|${row.position}`;
    if (!groups.has(key)) groups.set(key, { season: row.season, playerId: row.playerId, position: row.position, weeks: [] });
    groups.get(key).weeks.push(row.points);
  }
  return [...groups.values()].map((row) => ({
    ...row,
    appearances: row.weeks.length,
    seasonPoints: row.weeks.reduce((sum, value) => sum + value, 0),
    activeGameMean: mean(row.weeks),
  })).sort((left, right) => left.season - right.season || left.position.localeCompare(right.position) || left.playerId.localeCompare(right.playerId));
}

function positionPrior(summaries, targetSeason, position) {
  const eligible = summaries.filter((row) => row.season < targetSeason && row.position === position && row.appearances > 0);
  return quantile(eligible.map((row) => row.activeGameMean), 0.5) ?? 0;
}

function baselinePredictions(summaries, targetSeason, params) {
  const actual = summaries.filter((row) => row.season === targetSeason);
  const priors = new Map(CALIBRATION_POSITIONS.map((position) => [position, positionPrior(summaries, targetSeason, position)]));
  return actual.map((row) => {
    const history = summaries.filter((candidate) => candidate.playerId === row.playerId && candidate.position === row.position && candidate.season < targetSeason);
    const weightedGames = history.reduce((sum, candidate) => sum + candidate.appearances * params.decay ** Math.max(0, targetSeason - 1 - candidate.season), 0);
    const weightedPoints = history.reduce((sum, candidate) => sum + candidate.seasonPoints * params.decay ** Math.max(0, targetSeason - 1 - candidate.season), 0);
    const prior = priors.get(row.position) ?? 0;
    return {
      playerId: row.playerId,
      position: row.position,
      predictedActiveGameMean: (weightedPoints + prior * params.shrinkGames) / (weightedGames + params.shrinkGames),
      actualActiveGameMean: row.activeGameMean,
      actualSeasonPoints: row.seasonPoints,
      actualAppearances: row.appearances,
      historyGames: weightedGames,
      predictionBasis: weightedGames > 0 ? "PLAYER_HISTORY_SHRUNK_TO_POSITION" : "POSITION_PRIOR",
    };
  });
}

function mae(rows, predictedField, actualField) {
  return mean(rows.map((row) => Math.abs(Number(row[predictedField]) - Number(row[actualField]))));
}

function rank(values, valueField) {
  return [...values].sort((left, right) => Number(right[valueField]) - Number(left[valueField]) || left.playerId.localeCompare(right.playerId));
}

function spearman(rows, predictedField, actualField) {
  if (rows.length < 2) return null;
  const predicted = new Map(rank(rows, predictedField).map((row, index) => [row.playerId, index + 1]));
  const actual = new Map(rank(rows, actualField).map((row, index) => [row.playerId, index + 1]));
  const n = rows.length;
  const d2 = rows.reduce((sum, row) => sum + (predicted.get(row.playerId) - actual.get(row.playerId)) ** 2, 0);
  return 1 - 6 * d2 / (n * (n * n - 1));
}

function topHitRate(rows, predictedField, actualField, count) {
  const actual = new Set(rank(rows, actualField).slice(0, count).map((row) => row.playerId));
  const predicted = rank(rows, predictedField).slice(0, count);
  return actual.size ? predicted.filter((row) => actual.has(row.playerId)).length / Math.min(count, actual.size) : null;
}

function baselineMetrics(predictions) {
  const byPosition = {};
  for (const position of CALIBRATION_POSITIONS) {
    const rows = predictions.filter((row) => row.position === position);
    if (!rows.length) continue;
    byPosition[position] = {
      sampleCount: rows.length,
      activeGameMae: mae(rows, "predictedActiveGameMean", "actualActiveGameMean"),
      spearman: spearman(rows, "predictedActiveGameMean", "actualActiveGameMean"),
      topHitRate: Object.fromEntries([12, 24, 36].map((count) => [String(count), topHitRate(rows, "predictedActiveGameMean", "actualActiveGameMean", count)])),
    };
  }
  return {
    sampleCount: predictions.length,
    activeGameMae: mae(predictions, "predictedActiveGameMean", "actualActiveGameMean"),
    byPosition,
  };
}

function selectBaselineParameters(summaries) {
  const candidates = [];
  for (const decay of BASELINE_GRID.decay) {
    for (const shrinkGames of BASELINE_GRID.shrinkGames) {
      const predictions = baselinePredictions(summaries.filter((row) => row.season <= TRAINING_END), TRAINING_END, { decay, shrinkGames });
      candidates.push({ decay, shrinkGames, activeGameMae: baselineMetrics(predictions).activeGameMae });
    }
  }
  candidates.sort((left, right) => left.activeGameMae - right.activeGameMae || left.decay - right.decay || left.shrinkGames - right.shrinkGames);
  return {
    selectionTrainingSeasons: [FIRST_SEASON, TRAINING_END - 1],
    innerHoldoutSeason: TRAINING_END,
    frozenBeforeSeason: HOLDOUT_SEASON,
    grid: BASELINE_GRID,
    candidates,
    selected: { decay: candidates[0].decay, shrinkGames: candidates[0].shrinkGames },
  };
}

function availabilityCohorts(playerSeasons) {
  const cohorts = new Map();
  const add = (key, value) => {
    if (!cohorts.has(key)) cohorts.set(key, []);
    cohorts.get(key).push(value);
  };
  for (const row of playerSeasons.filter((entry) => entry.season <= TRAINING_END && entry.eligibleGames > 0)) {
    add(`${row.position}|${row.ageBand}`, row.equivalentGamesThroughWeek17);
    add(`${row.position}|ALL`, row.equivalentGamesThroughWeek17);
  }
  return cohorts;
}

function availabilityDistribution(cohorts, position, playerAgeBand) {
  const exact = cohorts.get(`${position}|${playerAgeBand}`) ?? [];
  const fallback = cohorts.get(`${position}|ALL`) ?? [];
  const values = exact.length >= 20 ? exact : fallback;
  return { values, basis: exact.length >= 20 ? "POSITION_AGE" : "POSITION", cohortSampleSize: values.length };
}

function historicalAvailabilityMean(playerSeasons, playerId, targetSeason) {
  const rows = playerSeasons.filter((row) => row.playerId === playerId && row.season < targetSeason && row.eligibleGames > 0);
  const eligible = rows.reduce((sum, row) => sum + row.eligibleGames, 0);
  const appearances = rows.reduce((sum, row) => sum + row.appearances, 0);
  return eligible ? { meanGames: appearances / eligible * CURRENT_SEASON_GAMES, eligibleGames: eligible } : null;
}

function shiftDistribution(values, targetMean) {
  const center = mean(values) ?? 0;
  const delta = targetMean - center;
  return values.map((value) => Math.max(0, Math.min(CURRENT_SEASON_GAMES, value + delta)));
}

function availabilityPrediction(playerSeasons, cohorts, row, targetSeason, historyEnabled) {
  const distribution = availabilityDistribution(cohorts, row.position, row.ageBand);
  const cohortMean = mean(distribution.values) ?? CURRENT_SEASON_GAMES;
  const history = historicalAvailabilityMean(playerSeasons, row.playerId, targetSeason);
  const historyWeight = history ? history.eligibleGames / (history.eligibleGames + CURRENT_SEASON_GAMES) : 0;
  const historyMean = historyEnabled && history ? history.meanGames * historyWeight + cohortMean * (1 - historyWeight) : cohortMean;
  const values = historyEnabled && history ? shiftDistribution(distribution.values, historyMean) : [...distribution.values];
  return {
    meanGames: mean(values),
    p20: quantile(values, 0.2),
    p50: quantile(values, 0.5),
    p80: quantile(values, 0.8),
    values,
    basis: historyEnabled && history ? `${distribution.basis}_PLUS_PLAYER_HISTORY` : distribution.basis,
    cohortSampleSize: distribution.cohortSampleSize,
    playerHistoryEligibleGames: history?.eligibleGames ?? 0,
  };
}

function fitAvailability(playerSeasons) {
  const cohorts = availabilityCohorts(playerSeasons);
  const holdout = playerSeasons.filter((row) => row.season === HOLDOUT_SEASON && row.eligibleGames > 0);
  const scored = holdout.map((row) => {
    const cohort = availabilityPrediction(playerSeasons.filter((entry) => entry.season <= TRAINING_END), cohorts, row, HOLDOUT_SEASON, false);
    const history = availabilityPrediction(playerSeasons.filter((entry) => entry.season <= TRAINING_END), cohorts, row, HOLDOUT_SEASON, true);
    return { ...row, actualGames: row.equivalentGamesThroughWeek17, cohortMean: cohort.meanGames, historyMean: history.meanGames };
  });
  const cohortMae = mae(scored, "cohortMean", "actualGames");
  const historyMae = mae(scored, "historyMean", "actualGames");
  const historyEnabled = historyMae < cohortMae;
  return {
    cohorts,
    gate: {
      holdoutConditioned: true,
      holdoutSeason: HOLDOUT_SEASON,
      sampleCount: scored.length,
      metric: "absolute predicted mean games minus actual games through Week 17",
      cohortMae,
      playerHistoryMae: historyMae,
      playerHistoryEnabled: historyEnabled,
      reason: historyEnabled ? "player_history_beats_position_age_cohort" : "player_history_does_not_beat_position_age_cohort",
    },
  };
}

function scoringBands(summaries) {
  const bands = {};
  for (const position of CALIBRATION_POSITIONS) {
    const values = summaries.filter((row) => row.season <= TRAINING_END && row.position === position && row.appearances >= 4 && row.activeGameMean > 0).map((row) => row.activeGameMean);
    bands[position] = { lowMaximum: quantile(values, 1 / 3), middleMaximum: quantile(values, 2 / 3), playerSeasons: values.length };
  }
  return bands;
}

function bandFor(meanPoints, thresholds) {
  if (!thresholds || !finite(meanPoints)) return null;
  if (meanPoints <= thresholds.lowMaximum) return "LOW";
  if (meanPoints <= thresholds.middleMaximum) return "MIDDLE";
  return "HIGH";
}

function outcomeModel(summaries, weeklyScores) {
  const bands = scoringBands(summaries);
  const summaryByKey = new Map(summaries.map((row) => [`${row.season}|${row.playerId}|${row.position}`, row]));
  const groups = new Map();
  for (const row of weeklyScores.filter((entry) => entry.season <= TRAINING_END)) {
    const summary = summaryByKey.get(`${row.season}|${row.playerId}|${row.position}`);
    if (!summary || summary.appearances < 4 || !(summary.activeGameMean > 0)) continue;
    const band = bandFor(summary.activeGameMean, bands[row.position]);
    const key = `${row.position}|${band}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.points / summary.activeGameMean);
  }
  const serialized = {};
  for (const [key, values] of groups) {
    const sorted = [...values].sort((left, right) => left - right);
    serialized[key] = { sampleCount: sorted.length, p20: quantile(sorted, 0.2), p80: quantile(sorted, 0.8), values: sorted };
  }
  return { bands, groups: serialized };
}

function pinball(actual, predicted, percentile) {
  const delta = actual - predicted;
  return delta >= 0 ? percentile * delta : (percentile - 1) * delta;
}

function intervalGateByPosition({ model, weeklyScores, predictions }) {
  const predictionByKey = new Map(predictions.map((row) => [`${row.playerId}|${row.position}`, row]));
  const result = {};
  for (const position of CALIBRATION_POSITIONS) {
    const rows = weeklyScores.filter((row) => row.season === HOLDOUT_SEASON && row.position === position).flatMap((row) => {
      const prediction = predictionByKey.get(`${row.playerId}|${row.position}`);
      if (!prediction) return [];
      const band = bandFor(prediction.predictedActiveGameMean, model.bands[position]);
      const distribution = model.groups[`${position}|${band}`];
      if (!distribution) return [];
      const low = distribution.p20 * prediction.predictedActiveGameMean;
      const high = distribution.p80 * prediction.predictedActiveGameMean;
      const flatLow = 0.7 * prediction.predictedActiveGameMean;
      const flatHigh = 1.3 * prediction.predictedActiveGameMean;
      return [{ actual: row.points, low, high, flatLow, flatHigh }];
    });
    const coverage = rows.length ? rows.filter((row) => row.actual >= row.low && row.actual <= row.high).length / rows.length : null;
    const calibratedPinball = rows.length ? mean(rows.map((row) => pinball(row.actual, row.low, 0.2) + pinball(row.actual, row.high, 0.8))) : null;
    const flatPinball = rows.length ? mean(rows.map((row) => pinball(row.actual, row.flatLow, 0.2) + pinball(row.actual, row.flatHigh, 0.8))) : null;
    result[position] = {
      sampleCount: rows.length,
      coverage,
      calibratedPinball,
      flatThirtyPercentPinball: flatPinball,
      pass: rows.length >= 40 && coverage >= 0.53 && coverage <= 0.67 && calibratedPinball < flatPinball,
    };
  }
  return result;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function stringSeed(value) {
  let hash = SIMULATION_SEED;
  for (const char of String(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function simulateSeasonRange({ meanPoints, multiplierValues, availabilityValues, key }) {
  if (!multiplierValues?.length || !availabilityValues?.length || !finite(meanPoints)) return null;
  const random = seededRandom(stringSeed(key));
  const totals = [];
  for (let draw = 0; draw < SIMULATION_DRAWS; draw += 1) {
    const games = Math.round(availabilityValues[Math.floor(random() * availabilityValues.length)]);
    let total = 0;
    for (let game = 0; game < games; game += 1) total += Number(meanPoints) * multiplierValues[Math.floor(random() * multiplierValues.length)];
    totals.push(total);
  }
  return { p20: quantile(totals, 0.2), p50: quantile(totals, 0.5), p80: quantile(totals, 0.8) };
}

function seasonRangeGates({ model, availability, playerSeasons, summaries, predictions }) {
  const seasonByKey = new Map(playerSeasons.filter((row) => row.season === HOLDOUT_SEASON).map((row) => [`${row.playerId}|${row.position}`, row]));
  const result = {};
  for (const position of CALIBRATION_POSITIONS) {
    const rows = predictions.filter((row) => row.position === position).flatMap((prediction) => {
      const actual = summaries.find((row) => row.season === HOLDOUT_SEASON && row.playerId === prediction.playerId && row.position === position);
      const availabilityRow = seasonByKey.get(`${prediction.playerId}|${position}`);
      if (!actual || !availabilityRow) return [];
      const predictedAvailability = availabilityPrediction(playerSeasons.filter((row) => row.season <= TRAINING_END), availability.cohorts, availabilityRow, HOLDOUT_SEASON, availability.gate.playerHistoryEnabled);
      const band = bandFor(prediction.predictedActiveGameMean, model.bands[position]);
      const multipliers = model.groups[`${position}|${band}`]?.values;
      const range = simulateSeasonRange({ meanPoints: prediction.predictedActiveGameMean, multiplierValues: multipliers, availabilityValues: predictedAvailability.values, key: `holdout|${prediction.playerId}|${position}` });
      return range ? [{ actual: actual.seasonPoints, ...range }] : [];
    });
    const coverage = rows.length ? rows.filter((row) => row.actual >= row.p20 && row.actual <= row.p80).length / rows.length : null;
    result[position] = { sampleCount: rows.length, coverage, pass: rows.length >= 20 && coverage >= 0.53 && coverage <= 0.67 };
  }
  return result;
}

function currentPlayerCalibrations({ board, playerSeasons, availability, model, intervalGates, seasonGates }) {
  const training = playerSeasons.filter((row) => row.season <= TRAINING_END);
  const rosterByGsis = new Map((board.currentRosterRows ?? []).filter((row) => row.gsis_id).map((row) => [String(row.gsis_id), row]));
  const gsisCounts = new Map();
  for (const player of board.players ?? []) if (player.gsisId) gsisCounts.set(String(player.gsisId), (gsisCounts.get(String(player.gsisId)) ?? 0) + 1);
  const positionsByGsis = new Map();
  for (const player of board.players ?? []) {
    if (!player.gsisId) continue;
    const gsisId = String(player.gsisId);
    if (!positionsByGsis.has(gsisId)) positionsByGsis.set(gsisId, new Set());
    positionsByGsis.get(gsisId).add(calibrationPosition(player));
  }
  const availabilityPositionByGsis = new Map([...positionsByGsis].map(([gsisId, positions]) => {
    const ordered = [...positions].sort((left, right) => CALIBRATION_POSITIONS.indexOf(left) - CALIBRATION_POSITIONS.indexOf(right));
    return [gsisId, ordered.find((position) => OFFENSE_POSITIONS.has(position)) ?? ordered[0]];
  }));
  const availabilityByGsis = new Map();
  const unmatchedYahooIdentities = [];
  const currentPlayers = (board.players ?? []).map((player) => {
    const yahooId = String(player.yahooId ?? player.playerId);
    const gsisId = player.gsisId ? String(player.gsisId) : null;
    const position = calibrationPosition(player);
    if (!gsisId) {
      unmatchedYahooIdentities.push({ yahooId, name: player.name, team: player.team, position, reason: "NO_EXACT_GSIS_ID" });
      return { yahooId, gsisId: null, position, status: "NO_EXACT_GSIS_ID", activeWeek: null, availability: null, season: null };
    }
    const roster = rosterByGsis.get(gsisId);
    if (!roster) {
      unmatchedYahooIdentities.push({ yahooId, name: player.name, team: player.team, position, gsisId, reason: "GSIS_NOT_ON_2026_ROSTER" });
      return { yahooId, gsisId, position, status: "GSIS_NOT_ON_2026_ROSTER", activeWeek: null, availability: null, season: null };
    }
    const identity = training.filter((row) => row.playerId === gsisId).sort((left, right) => right.season - left.season)[0];
    const age = ageAtSeasonStart(roster.birth_date, 2026);
    const historicalAge = finite(identity?.age) ? Number(identity.age) + (2026 - Number(identity.season)) : null;
    const availabilityPosition = availabilityPositionByGsis.get(gsisId) ?? position;
    if (!availabilityByGsis.has(gsisId)) {
      const descriptor = { playerId: gsisId, position: availabilityPosition, ageBand: ageBand(age ?? historicalAge) };
      availabilityByGsis.set(gsisId, availabilityPrediction(training, availability.cohorts, descriptor, 2026, availability.gate.playerHistoryEnabled));
    }
    const predictedAvailability = availabilityByGsis.get(gsisId);
    const meanPoints = finite(player.candidatePoints) && finite(player.expectedGames) && Number(player.expectedGames) > 0
      ? Number(player.candidatePoints) / Number(player.expectedGames)
      : finite(player.perGamePoints) ? Number(player.perGamePoints) : null;
    const band = bandFor(meanPoints, model.bands[position]);
    const distribution = model.groups[`${position}|${band}`];
    const activeGate = intervalGates[position]?.pass === true;
    const seasonGate = seasonGates[position]?.pass === true;
    const seasonRange = activeGate && seasonGate ? simulateSeasonRange({ meanPoints, multiplierValues: distribution?.values, availabilityValues: predictedAvailability.values, key: `2026|${gsisId}|${position}` }) : null;
    const status = !finite(meanPoints)
      ? "PROJECTION_ANCHOR_MISSING"
      : activeGate ? seasonGate ? "CALIBRATED" : "SEASON_RANGE_GATE_FAILED" : "ACTIVE_WEEK_GATE_FAILED";
    return {
      yahooId,
      gsisId,
      position,
      availabilityPosition,
      sharedGsisIdentity: (gsisCounts.get(gsisId) ?? 0) > 1,
      status,
      activeWeek: finite(meanPoints) && activeGate && distribution ? { p20: distribution.p20 * meanPoints, p80: distribution.p80 * meanPoints, scoringBand: band, sampleCount: distribution.sampleCount } : null,
      availability: { p20: predictedAvailability.p20, p50: predictedAvailability.p50, p80: predictedAvailability.p80, mean: predictedAvailability.meanGames, basis: predictedAvailability.basis, cohortSampleSize: predictedAvailability.cohortSampleSize, playerHistoryEligibleGames: predictedAvailability.playerHistoryEligibleGames },
      season: seasonRange,
    };
  });
  return { currentPlayers, unmatchedYahooIdentities: unmatchedYahooIdentities.sort((left, right) => left.yahooId.localeCompare(right.yahooId)) };
}

export function buildHistoricalCalibration({ weeklyScores, playerSeasons, board, generatedAt, sourceReceipts = [] }) {
  const summaries = playerSeasonSummaries(weeklyScores);
  const parameterSelection = selectBaselineParameters(summaries);
  const holdoutPredictions = baselinePredictions(summaries, HOLDOUT_SEASON, parameterSelection.selected);
  const availability = fitAvailability(playerSeasons);
  const holdoutAvailabilityByKey = new Map(playerSeasons.filter((row) => row.season === HOLDOUT_SEASON).map((row) => {
    const prediction = availabilityPrediction(playerSeasons.filter((entry) => entry.season <= TRAINING_END), availability.cohorts, row, HOLDOUT_SEASON, availability.gate.playerHistoryEnabled);
    return [`${row.playerId}|${row.position}`, prediction];
  }));
  for (const prediction of holdoutPredictions) {
    const available = holdoutAvailabilityByKey.get(`${prediction.playerId}|${prediction.position}`);
    prediction.predictedGames = available?.meanGames ?? CURRENT_SEASON_GAMES;
    prediction.predictedSeasonPoints = prediction.predictedActiveGameMean * prediction.predictedGames;
  }
  const model = outcomeModel(summaries, weeklyScores);
  const intervalGates = intervalGateByPosition({ model, weeklyScores, predictions: holdoutPredictions });
  const seasonGates = seasonRangeGates({ model, availability, playerSeasons, summaries, predictions: holdoutPredictions });
  const current = currentPlayerCalibrations({ board, playerSeasons, availability, model, intervalGates, seasonGates });
  const baseline = baselineMetrics(holdoutPredictions);
  baseline.seasonTotalMae = mae(holdoutPredictions, "predictedSeasonPoints", "actualSeasonPoints");
  return {
    schemaVersion: 1,
    generatedAt,
    posture: "research calibration only; no ranking or Yahoo mutation authority",
    trainingSeasons: [FIRST_SEASON, TRAINING_END],
    holdoutSeason: HOLDOUT_SEASON,
    weekHorizon: [1, LAST_WEEK],
    sourceReceipts,
    scoringReceipt: {
      exactLeagueScorers: ["offense", "idp", "kicker"],
      omittedHistoricalCategories: ["offensiveFumbleReturnTouchdowns"],
      returnMapping: "punt_return_yards plus kickoff_return_yards; special_teams_tds",
      appearanceRule: "positive snaps through exact same-season PFR-to-GSIS crosswalk, or nonzero scored stat evidence",
    },
    parameterSelection,
    challengerZero: { status: "HOLDOUT_SCORED", holdoutSeason: HOLDOUT_SEASON, ...baseline, predictions: holdoutPredictions },
    availability: { gate: availability.gate, cohortSummary: Object.fromEntries([...availability.cohorts].sort().map(([key, values]) => [key, { sampleCount: values.length, mean: mean(values), p20: quantile(values, 0.2), p50: quantile(values, 0.5), p80: quantile(values, 0.8) }])) },
    activeWeekOutcome: { gateByPosition: intervalGates, bands: model.bands, groups: Object.fromEntries(Object.entries(model.groups).map(([key, value]) => [key, { sampleCount: value.sampleCount, p20: value.p20, p80: value.p80 }])) },
    seasonOutcome: { simulationDraws: SIMULATION_DRAWS, seed: `0x${SIMULATION_SEED.toString(16)}`, assumption: "independent active-week outcome multipliers conditional on availability draw", gateByPosition: seasonGates },
    currentPlayers: current.currentPlayers,
    unmatchedYahooIdentities: current.unmatchedYahooIdentities,
  };
}

async function readWithReceipt(path, sourceUrl, checkedAt) {
  const file = await stat(path);
  const content = await readFile(path, "utf8");
  return { content, receipt: { path, sourceUrl, retrievedAt: file.mtime.toISOString(), checkedAt, bytes: Buffer.byteLength(content), sha256: sha256(content) } };
}

export async function buildHistoricalDatasetFromFiles({ statsPaths, rosterPaths, snapPaths, schedulePath, retrievedAt }) {
  if (statsPaths.length !== rosterPaths.length || statsPaths.length !== snapPaths.length) throw new Error("stats, roster, and snap path counts must match");
  const schedule = await readWithReceipt(schedulePath, "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv", retrievedAt);
  const scheduleRows = parseCsv(schedule.content);
  const weeklyScores = [];
  const playerSeasons = [];
  const seasonReceipts = [];
  const sourceReceipts = [schedule.receipt];
  for (let index = 0; index < statsPaths.length; index += 1) {
    const season = FIRST_SEASON + index;
    const [stats, roster, snaps] = await Promise.all([
      readWithReceipt(statsPaths[index], `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`, retrievedAt),
      readWithReceipt(rosterPaths[index], `https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_${season}.csv`, retrievedAt),
      readWithReceipt(snapPaths[index], `https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_${season}.csv`, retrievedAt),
    ]);
    const parsed = parseHistoricalSeason({ statsText: stats.content, rosterText: roster.content, snapText: snaps.content, scheduleRows, season });
    weeklyScores.push(...parsed.weeklyScores);
    playerSeasons.push(...parsed.playerSeasons);
    seasonReceipts.push(parsed.receipts);
    sourceReceipts.push(stats.receipt, roster.receipt, snaps.receipt);
  }
  return { weeklyScores, playerSeasons, seasonReceipts, sourceReceipts };
}

function args(argv) {
  return Object.fromEntries(argv.map((entry) => { const [key, ...value] = entry.replace(/^--/, "").split("="); return [key, value.join("=")]; }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const input = args(process.argv.slice(2));
  for (const key of ["stats", "rosters", "snaps", "schedule", "board", "output", "generated-at"]) if (!input[key]) throw new Error(`missing --${key}`);
  const board = JSON.parse(await readFile(input.board, "utf8"));
  if (input["current-roster"]) board.currentRosterRows = parseCsv(await readFile(input["current-roster"], "utf8"));
  const dataset = await buildHistoricalDatasetFromFiles({
    statsPaths: input.stats.split(","),
    rosterPaths: input.rosters.split(","),
    snapPaths: input.snaps.split(","),
    schedulePath: input.schedule,
    retrievedAt: input["generated-at"],
  });
  const output = buildHistoricalCalibration({ ...dataset, board, generatedAt: input["generated-at"] });
  output.seasonReceipts = dataset.seasonReceipts;
  await writeFile(input.output, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output: input.output, players: output.currentPlayers.length, unmatched: output.unmatchedYahooIdentities.length, baselineMae: output.challengerZero.activeGameMae })}\n`);
}
