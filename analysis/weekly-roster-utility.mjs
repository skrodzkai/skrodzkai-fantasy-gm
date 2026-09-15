import {
  scoreOffenseStatLine,
  scoreIdpStatLine,
  scoreKickerStatLine,
  OFFENSE_SCORING,
  IDP_SCORING,
  KICKER_SCORING,
} from "./player-intelligence.mjs";

const FIRST_WEEK = 1;
const LAST_WEEK = 17;

// Total weight given to the Week-1 signal versus the pre-season prior. Single-game NFL
// fantasy outcomes have low week-to-week autocorrelation, so the multi-source pre-season
// prior stays the dominant signal after one game. Documented MODEL CHOICE, not calibrated
// to 2026 weekly outcomes (none exist yet).
const DEFAULT_WEEK1_WEIGHT = 0.25;

// Within the Week-1 signal, the share carried by the OPPORTUNITY expectation (volume valued
// at league-average points-per-opportunity) versus the player's OBSERVED efficiency/TD
// result. Volume (carries, targets, dropbacks) is more stable game-to-game than one game's
// per-touch efficiency and touchdowns, so opportunity is favored. Documented MODEL CHOICE,
// uncalibrated. opportunityShare=1 fully regresses single-game efficiency to league average;
// 0 reverts to the rejected raw-points update.
const DEFAULT_OPPORTUNITY_SHARE = 0.6;

// A position channel needs at least this much league-wide Week-1 volume before its own
// points-per-opportunity rate is trusted; below it, the channel falls back to the all-position
// rate so a thin sample never produces an unstable multiplier.
const MIN_OPPORTUNITY_SAMPLE = 40;

// Availability is NOT discounted by a generic status haircut. A confirmed-inactive status is a
// factual zero (the player will not play); every uncertain status (QUESTIONABLE / DOUBTFUL) is
// surfaced as a flag but carries NO numeric discount, because the pre-season prior already
// assumes availability and there is no player-specific evidence to justify a second discount.
// An explicit availabilityProbability (player-specific evidence) is the only path to a haircut.
const CONFIRMED_INACTIVE_STATUS = Object.freeze(
  new Set(["OUT", "IR", "PUP", "NFI", "SUSPENDED", "BYE", "DNP", "INACTIVE"]),
);
const UNCERTAIN_STATUS = Object.freeze(new Set(["QUESTIONABLE", "DOUBTFUL", "GTD"]));
const ASSUMED_ACTIVE_STATUS = Object.freeze(new Set(["HEALTHY", "ACTIVE", "PROBABLE"]));

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function clampProbability(value) {
  return Math.max(0, Math.min(1, Number(value)));
}

function weekList() {
  return Array.from({ length: LAST_WEEK }, (_, index) => index + FIRST_WEEK);
}

export function buildWeeklyProjectionProfile({
  perGamePoints,
  byeWeek = null,
  expectedGamesThroughWeek17 = null,
  unavailableWeeks = [],
  weeklyAvailability = {},
  perGameOutcomeLow = null,
  perGameOutcomeHigh = null,
} = {}) {
  if (!finite(perGamePoints) || Number(perGamePoints) < 0) {
    throw new Error("perGamePoints must be a nonnegative finite number");
  }
  const normalizedBye = finite(byeWeek) ? Number(byeWeek) : null;
  if (normalizedBye != null && (!Number.isInteger(normalizedBye) || normalizedBye < FIRST_WEEK || normalizedBye > LAST_WEEK)) {
    throw new Error("byeWeek must be between 1 and 17");
  }
  const unavailable = new Set(Array.from(unavailableWeeks ?? [], Number));
  if ([...unavailable].some((week) => !Number.isInteger(week) || week < FIRST_WEEK || week > LAST_WEEK)) {
    throw new Error("unavailableWeeks must contain weeks 1 through 17");
  }
  const activeWeeks = weekList().filter((week) => week !== normalizedBye);
  const supplied = new Map();
  for (const [weekValue, probabilityValue] of Object.entries(weeklyAvailability ?? {})) {
    const week = Number(weekValue);
    if (!Number.isInteger(week) || week < FIRST_WEEK || week > LAST_WEEK || !finite(probabilityValue)) {
      throw new Error("weeklyAvailability requires finite probabilities for weeks 1 through 17");
    }
    supplied.set(week, clampProbability(probabilityValue));
  }
  const maximumGames = activeWeeks.length;
  const expectedGames = expectedGamesThroughWeek17 == null
    ? maximumGames
    : Number(expectedGamesThroughWeek17);
  if (!Number.isFinite(expectedGames) || expectedGames < 0 || expectedGames > maximumGames) {
    throw new Error(`expectedGamesThroughWeek17 must be between 0 and ${maximumGames}`);
  }
  const fixedProbability = activeWeeks.reduce((sum, week) => {
    if (unavailable.has(week)) return sum;
    return sum + (supplied.get(week) ?? 0);
  }, 0);
  if (fixedProbability > expectedGames + 1e-9) {
    throw new Error("weeklyAvailability exceeds expectedGamesThroughWeek17");
  }
  const unresolvedWeeks = activeWeeks.filter((week) => !unavailable.has(week) && !supplied.has(week));
  const remainingProbability = Math.max(0, expectedGames - fixedProbability);
  const defaultAvailability = unresolvedWeeks.length
    ? clampProbability(remainingProbability / unresolvedWeeks.length)
    : 0;
  const availabilityProbability = weekList().map((week) => {
    if (week === normalizedBye || unavailable.has(week)) return 0;
    return supplied.has(week) ? supplied.get(week) : defaultAvailability;
  });
  const weeklyPoints = availabilityProbability.map((probability) => Number(perGamePoints) * probability);
  const calibratedOutcome = finite(perGameOutcomeLow) && finite(perGameOutcomeHigh) &&
    Number(perGameOutcomeLow) <= Number(perGameOutcomeHigh);
  return Object.freeze({
    weeks: weekList(),
    byeWeek: normalizedBye,
    expectedGamesThroughWeek17: availabilityProbability.reduce((sum, value) => sum + value, 0),
    availabilityProbability,
    weeklyPoints,
    weeklyOutcomeLow: calibratedOutcome
      ? availabilityProbability.map((probability) => Number(perGameOutcomeLow) * probability)
      : null,
    weeklyOutcomeHigh: calibratedOutcome
      ? availabilityProbability.map((probability) => Number(perGameOutcomeHigh) * probability)
      : null,
    uncertaintyStatus: calibratedOutcome ? "CALIBRATED_WEEKLY_OUTCOME_INTERVAL" : "WEEKLY_OUTCOME_INTERVAL_UNAVAILABLE",
  });
}

export function expectedGamesFromInjury(injury, maximumGames = 16) {
  if (!injury || typeof injury !== "object") return null;
  if (finite(injury.expectedGamesThroughWeek17)) {
    const games = Number(injury.expectedGamesThroughWeek17);
    return games >= 0 && games <= maximumGames ? games : null;
  }
  if (injury.draftAction === "EXCLUDE") return 0;
  if (injury.draftAction === "CLEAR") return maximumGames;
  return null;
}

// --- In-season custom weekly projection: prior -> Week 1 update -> weekly expectation ---
//
// Pure and source-agnostic. Scoring is imported from player-intelligence.mjs and never
// redefined here, so the exact league rules stay authoritative. Yahoo weekly projections
// are carried only as a comparison field; they never feed the custom number.

const SCORERS = {
  offense: (line, scoring) => scoreOffenseStatLine(line, scoring.offense),
  idp: (line, scoring) => scoreIdpStatLine(line, scoring.idp),
  kicker: (line, scoring) => scoreKickerStatLine(line, scoring.kicker),
};

/**
 * Score a single Week 1 (or any single game) league-schema stat line under the exact
 * league rules. `scoringKind` selects the offense / idp / kicker scorer.
 */
export function scoreWeeklyLeaguePoints(statLine, scoringKind = "offense", scoring = {
  offense: OFFENSE_SCORING,
  idp: IDP_SCORING,
  kicker: KICKER_SCORING,
}) {
  const kind = String(scoringKind ?? "offense").toLowerCase();
  const scorer = SCORERS[kind];
  if (!scorer) throw new Error(`unsupported scoringKind ${scoringKind}`);
  return scorer(statLine ?? {}, scoring);
}

/**
 * League-average points-per-opportunity, by offense channel and position, computed from the
 * Week-1 actuals themselves (no external constant). Each `line` supplies a player's Week-1
 * volume (passAttempts / carries / targets) and the exact league-scored points that volume
 * produced in each channel (passingPoints / rushingPoints / receivingPoints). A position
 * channel with less than MIN_OPPORTUNITY_SAMPLE league-wide volume falls back to the
 * all-position rate so a thin sample never yields an unstable multiplier.
 */
export function deriveOpportunityRates(lines) {
  const channels = ["pass", "rush", "rec"];
  const volumeKey = { pass: "passAttempts", rush: "carries", rec: "targets" };
  const pointsKey = { pass: "passingPoints", rush: "rushingPoints", rec: "receivingPoints" };
  const overall = { pass: { volume: 0, points: 0 }, rush: { volume: 0, points: 0 }, rec: { volume: 0, points: 0 } };
  const byPosition = new Map();
  const sampleByPosition = {};
  for (const line of Array.isArray(lines) ? lines : []) {
    const position = String(line?.position ?? "").toUpperCase();
    if (!position) continue;
    if (!byPosition.has(position)) {
      byPosition.set(position, { pass: { volume: 0, points: 0 }, rush: { volume: 0, points: 0 }, rec: { volume: 0, points: 0 } });
    }
    const bucket = byPosition.get(position);
    for (const channel of channels) {
      const volume = finite(line?.[volumeKey[channel]]) ? Number(line[volumeKey[channel]]) : 0;
      const points = finite(line?.[pointsKey[channel]]) ? Number(line[pointsKey[channel]]) : 0;
      bucket[channel].volume += volume;
      bucket[channel].points += points;
      overall[channel].volume += volume;
      overall[channel].points += points;
    }
  }
  const rate = (bucket) => (bucket.volume > 0 ? bucket.points / bucket.volume : 0);
  const overallRates = { pass: rate(overall.pass), rush: rate(overall.rush), rec: rate(overall.rec) };
  const ratesByPosition = {};
  for (const [position, bucket] of byPosition) {
    ratesByPosition[position] = {};
    sampleByPosition[position] = {};
    for (const channel of channels) {
      const trusted = bucket[channel].volume >= MIN_OPPORTUNITY_SAMPLE;
      ratesByPosition[position][channel] = trusted ? rate(bucket[channel]) : overallRates[channel];
      sampleByPosition[position][channel] = { volume: bucket[channel].volume, trusted };
    }
  }
  return Object.freeze({ ratesByPosition, overall: overallRates, sampleByPosition, minSample: MIN_OPPORTUNITY_SAMPLE });
}

/**
 * A player's opportunity-expected Week-1 points: their observed Week-1 volume valued at the
 * league-average rate for their position, plus any non-volume observed points (returns, 2pt,
 * fumbles) which the opportunity model does not attempt to explain. This is the sustainable,
 * TD-and-efficiency-regressed side of the Week-1 signal.
 */
export function opportunityExpectedPoints({ position, passAttempts = 0, carries = 0, targets = 0, otherPoints = 0 } = {}, rates) {
  if (!rates || typeof rates !== "object") return null;
  const pos = String(position ?? "").toUpperCase();
  const channel = rates.ratesByPosition?.[pos] ?? rates.overall ?? { pass: 0, rush: 0, rec: 0 };
  const overall = rates.overall ?? { pass: 0, rush: 0, rec: 0 };
  const pass = finite(passAttempts) ? Number(passAttempts) : 0;
  const rush = finite(carries) ? Number(carries) : 0;
  const rec = finite(targets) ? Number(targets) : 0;
  const other = finite(otherPoints) ? Number(otherPoints) : 0;
  return pass * (channel.pass ?? overall.pass ?? 0)
    + rush * (channel.rush ?? overall.rush ?? 0)
    + rec * (channel.rec ?? overall.rec ?? 0)
    + other;
}

/**
 * Availability resolution. A confirmed-inactive status is a factual zero. An uncertain status
 * (QUESTIONABLE / DOUBTFUL) is FLAGGED but never discounted: the pre-season prior already
 * assumes the player is active, so a generic status haircut would double-count uncertainty
 * without any player-specific evidence. Only an explicit availabilityProbability discounts.
 */
function resolveAvailability(availabilityProbability, availabilityStatus) {
  if (finite(availabilityProbability)) {
    return {
      availabilityProbability: clampProbability(availabilityProbability),
      availabilityStatus: availabilityStatus ? String(availabilityStatus).toUpperCase() : "EXPLICIT_PROBABILITY",
      availabilityBasis: "PLAYER_SPECIFIC_PROBABILITY",
    };
  }
  if (availabilityStatus != null && String(availabilityStatus).trim()) {
    const status = String(availabilityStatus).toUpperCase();
    if (CONFIRMED_INACTIVE_STATUS.has(status)) {
      return { availabilityProbability: 0, availabilityStatus: status, availabilityBasis: "CONFIRMED_INACTIVE" };
    }
    if (UNCERTAIN_STATUS.has(status)) {
      return { availabilityProbability: 1, availabilityStatus: status, availabilityBasis: "UNCERTAIN_FLAGGED_NO_DISCOUNT" };
    }
    if (ASSUMED_ACTIVE_STATUS.has(status)) {
      return { availabilityProbability: 1, availabilityStatus: status, availabilityBasis: "ASSUMED_ACTIVE" };
    }
    throw new Error(`unknown availabilityStatus ${availabilityStatus}`);
  }
  return { availabilityProbability: 1, availabilityStatus: "ASSUMED_ACTIVE", availabilityBasis: "ASSUMED_ACTIVE" };
}

/**
 * Build one player's transparent weekly projection. Every input is optional; missing prior or
 * Week 1 evidence is reported as a flag and lowers confidence rather than being silently
 * substituted.
 *
 * The Week-1 signal is opportunity-anchored: when a `week1OpportunityPoints` expectation
 * (volume valued at league-average points-per-opportunity) is supplied alongside the observed
 * `week1Points`, the signal is `opportunityShare * opportunity + (1 - opportunityShare) *
 * observed`, so carries / targets / dropbacks drive the number while single-game efficiency and
 * touchdown luck are regressed. `weeklyBaseline = week1Weight * week1Signal + (1 - week1Weight)
 * * prior`. `weeklyExpectation = weeklyBaseline * matchupFactor * availability`, and is reported
 * ONLY when current-week evidence exists (PRIOR_AND_WEEK1 / WEEK1_ONLY); a prior-only row keeps
 * its prior separate and exposes no weekly projection.
 */
export function buildWeeklyPlayerProjection({
  playerId = null,
  name = null,
  position = null,
  team = null,
  opponent = null,
  priorPerGame = null,
  week1StatLine = null,
  week1Points = null,
  week1OpportunityPoints = null,
  scoringKind = "offense",
  week1Weight = DEFAULT_WEEK1_WEIGHT,
  opportunityShare = DEFAULT_OPPORTUNITY_SHARE,
  matchupFactor = 1,
  matchupStatus = "OPPONENT_KNOWN_STRENGTH_UNSOURCED",
  availabilityProbability = null,
  availabilityStatus = null,
  yahooWeek2Projection = null,
  scoring = { offense: OFFENSE_SCORING, idp: IDP_SCORING, kicker: KICKER_SCORING },
} = {}) {
  if (!finite(week1Weight) || Number(week1Weight) < 0 || Number(week1Weight) > 1) {
    throw new Error("week1Weight must be between 0 and 1");
  }
  if (!finite(opportunityShare) || Number(opportunityShare) < 0 || Number(opportunityShare) > 1) {
    throw new Error("opportunityShare must be between 0 and 1");
  }
  if (!finite(matchupFactor) || Number(matchupFactor) <= 0) {
    throw new Error("matchupFactor must be a positive finite number");
  }
  if (priorPerGame != null && (!finite(priorPerGame) || Number(priorPerGame) < 0)) {
    throw new Error("priorPerGame must be a nonnegative finite number when provided");
  }

  const prior = finite(priorPerGame) ? Number(priorPerGame) : null;
  let week1Observed = finite(week1Points) ? Number(week1Points) : null;
  if (week1Observed == null && week1StatLine && typeof week1StatLine === "object") {
    week1Observed = scoreWeeklyLeaguePoints(week1StatLine, scoringKind, scoring);
  }
  const week1Opportunity = finite(week1OpportunityPoints) ? Number(week1OpportunityPoints) : null;

  // Opportunity-anchored Week-1 signal: volume-valued expectation blended with observed result.
  let week1Signal = null;
  let week1SignalBasis = null;
  if (week1Observed != null && week1Opportunity != null) {
    week1Signal = Number(opportunityShare) * week1Opportunity + (1 - Number(opportunityShare)) * week1Observed;
    week1SignalBasis = "OPPORTUNITY_AND_EFFICIENCY";
  } else if (week1Observed != null) {
    week1Signal = week1Observed;
    week1SignalBasis = "OBSERVED_ONLY_NO_OPPORTUNITY_MODEL";
  }

  const missingInputs = [];
  let weeklyBaseline = null;
  let confidence = "INSUFFICIENT";
  let priorShrinkageApplied = false;
  if (prior != null && week1Signal != null) {
    weeklyBaseline = Number(week1Weight) * week1Signal + (1 - Number(week1Weight)) * prior;
    confidence = "PRIOR_AND_WEEK1";
    priorShrinkageApplied = true;
  } else if (prior != null) {
    weeklyBaseline = prior;
    confidence = "PRIOR_ONLY";
    missingInputs.push("week1_actuals");
  } else if (week1Signal != null) {
    weeklyBaseline = week1Signal;
    confidence = "WEEK1_ONLY";
    missingInputs.push("prior_per_game");
  } else {
    missingInputs.push("prior_per_game", "week1_actuals");
  }
  if (confidence === "PRIOR_AND_WEEK1" && week1Opportunity == null) {
    missingInputs.push("week1_opportunity");
  }

  const availability = resolveAvailability(availabilityProbability, availabilityStatus);
  const factor = Number(matchupFactor);
  // A weekly projection is reported ONLY when current-week evidence exists. A prior-only row
  // (e.g. a team defense whose Week-1 buckets are unreconstructed) exposes NO weekly number;
  // its prior is kept separate so a stale draft rate is never presented as a Week-2 projection.
  const weeklyProjectionAvailable = confidence === "PRIOR_AND_WEEK1" || confidence === "WEEK1_ONLY";
  const weeklyExpectation = weeklyProjectionAvailable && weeklyBaseline != null
    ? weeklyBaseline * factor * availability.availabilityProbability
    : null;

  const yahoo = finite(yahooWeek2Projection) ? Number(yahooWeek2Projection) : null;
  const notes = [];
  if (confidence === "PRIOR_ONLY") {
    notes.push("PRIOR_ONLY: no current-week evidence; weekly projection UNAVAILABLE; priorPerGame shown for reference only, NOT a Week-2 projection");
  }
  if (confidence === "INSUFFICIENT") {
    notes.push("INSUFFICIENT: neither a prior nor Week-1 evidence; no projection");
  }
  if (week1SignalBasis === "OBSERVED_ONLY_NO_OPPORTUNITY_MODEL" && weeklyProjectionAvailable) {
    notes.push("no opportunity decomposition for this player; Week-1 signal is the observed league-scored result (efficiency/TD not regressed)");
  }
  if (matchupStatus === "OPPONENT_KNOWN_STRENGTH_UNSOURCED") {
    notes.push("matchup strength unsourced; opponent identity recorded but no quantitative adjustment applied");
  }
  if (availability.availabilityBasis === "UNCERTAIN_FLAGGED_NO_DISCOUNT") {
    notes.push(`availability ${availability.availabilityStatus} flagged; NO generic haircut (prior already assumes availability; player-specific probability required to discount)`);
  }
  if (availability.availabilityProbability < 1) {
    notes.push(`availability discount applied (${availability.availabilityStatus}, basis ${availability.availabilityBasis})`);
  }

  return Object.freeze({
    playerId: playerId == null ? null : String(playerId),
    name,
    position,
    team,
    opponent,
    priorPerGame: prior,
    week1Points: week1Observed,
    week1OpportunityPoints: week1Opportunity,
    week1Signal,
    week1SignalBasis,
    week1StatLine: week1StatLine ?? null,
    week1Weight: Number(week1Weight),
    opportunityShare: Number(opportunityShare),
    priorShrinkageApplied,
    weeklyBaseline,
    weeklyProjectionAvailable,
    matchupFactor: factor,
    matchupStatus,
    availabilityProbability: availability.availabilityProbability,
    availabilityStatus: availability.availabilityStatus,
    availabilityBasis: availability.availabilityBasis,
    weeklyExpectation,
    yahooWeek2Projection: yahoo,
    deltaVsYahoo: yahoo == null || weeklyExpectation == null ? null : weeklyExpectation - yahoo,
    confidence,
    missingInputs,
    notes,
  });
}

/**
 * Map a roster/candidate list through the weekly projection model and return a structured
 * report with provenance and coverage counts. Pure; the CLI supplies the assembled inputs.
 */
export function buildWeeklyProjectionReport({
  players,
  week1Weight = DEFAULT_WEEK1_WEIGHT,
  opportunityShare = DEFAULT_OPPORTUNITY_SHARE,
  generatedAt = null,
  targetWeek = null,
  provenance = null,
  scoring = { offense: OFFENSE_SCORING, idp: IDP_SCORING, kicker: KICKER_SCORING },
} = {}) {
  if (!Array.isArray(players) || players.length === 0) {
    throw new Error("players must be a nonempty array");
  }
  const projections = players.map((player) => buildWeeklyPlayerProjection({ ...player, week1Weight, opportunityShare, scoring }));
  const coverage = projections.reduce((counts, row) => {
    counts[row.confidence] = (counts[row.confidence] ?? 0) + 1;
    return counts;
  }, {});
  return Object.freeze({
    schemaVersion: 2,
    generatedAt,
    targetWeek,
    posture: "research projection only; no roster, Yahoo, or deployment authority",
    week1Weight: Number(week1Weight),
    opportunityShare: Number(opportunityShare),
    modelChoices: Object.freeze({
      week1Weight: Number(week1Weight),
      week1WeightRationale:
        "single-game fantasy outcomes have low week-to-week autocorrelation; the multi-source pre-season prior stays dominant after one game; uncalibrated model choice",
      opportunityShare: Number(opportunityShare),
      opportunityRationale:
        "the Week-1 signal is opportunity-anchored: volume (carries/targets/dropbacks) valued at league-average points-per-opportunity, blended with observed efficiency; opportunity is favored because volume is more stable game-to-game than one game's efficiency/TDs; league rates are derived from the Week-1 actuals themselves, not fabricated; uncalibrated blend weight",
      availability:
        "no generic status haircut; confirmed-inactive statuses are a factual zero; QUESTIONABLE/DOUBTFUL are flagged but NOT discounted because the prior already assumes availability and no player-specific evidence justifies a second discount; only an explicit availabilityProbability discounts",
      matchup: "neutral (1.0) unless a quantitative opponent-strength source is supplied; one game cannot establish opponent strength",
      priorOnly: "a prior-only row (e.g. team defenses with unreconstructed Week-1 buckets) exposes NO weekly projection; its prior is kept separate and never presented as a Week-2 number",
      scoringSource: "analysis/player-intelligence.mjs OFFENSE/IDP/KICKER scoring (league-authoritative, not redefined)",
    }),
    coverage,
    provenance,
    players: projections,
  });
}

export {
  FIRST_WEEK,
  LAST_WEEK,
  DEFAULT_WEEK1_WEIGHT,
  DEFAULT_OPPORTUNITY_SHARE,
  MIN_OPPORTUNITY_SAMPLE,
  CONFIRMED_INACTIVE_STATUS,
  UNCERTAIN_STATUS,
};
