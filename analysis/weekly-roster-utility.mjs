const FIRST_WEEK = 1;
const LAST_WEEK = 17;

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

export { FIRST_WEEK, LAST_WEEK };
