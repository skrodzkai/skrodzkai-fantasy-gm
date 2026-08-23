import { overallPick, pickCoordinates } from "./opponent-window.mjs";

export const SPECIALIST_POSITIONS = Object.freeze(["K", "DEF", "D", "DB", "LB"]);
export const DRAFT_ROUNDS = 19;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function finite(value) {
  return Number.isFinite(Number(value));
}

function idOf(value) {
  if (value && typeof value === "object") return value.playerId ?? value.yahooId ?? value.id;
  return value;
}

function positionOf(value) {
  const position = String(value?.position ?? value?.slot ?? "").trim().toUpperCase();
  if (["DE", "DT", "NT", "DL"].includes(position)) return "D";
  if (["CB", "S", "FS", "SS"].includes(position)) return "DB";
  if (["ILB", "OLB"].includes(position)) return "LB";
  return position;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function entropy(probabilities) {
  const entries = Object.values(probabilities).filter((value) => value > 0);
  if (entries.length <= 1) return 0;
  return -entries.reduce((sum, probability) => sum + probability * Math.log(probability), 0) / Math.log(Object.keys(probabilities).length);
}

function exemptionFor(exemptions, metric) {
  return asArray(exemptions).find((exemption) => exemption?.metric === metric);
}

/**
 * Audit the supplied late-round simulation picks. The audit does not infer a
 * target mix; acceptance thresholds and any exemptions must be supplied by the
 * caller, with a reason and evidence for every exemption.
 */
export function auditLateRoundConcentration(records, options = {}) {
  const lateRound = Number(options.lateRound ?? 15);
  const minSamples = Number(options.minSamples ?? 1);
  const minSimulationCount = Number(options.minSimulationCount ?? 1);
  const maxConcentration = options.maxConcentration == null ? 0.75 : Number(options.maxConcentration);
  const minEntropy = options.minEntropy == null ? 0.5 : Number(options.minEntropy);
  const minPositionCoverage = Number(options.minPositionCoverage ?? 1);
  const maxRoundConcentration = options.maxRoundConcentration == null ? 0.85 : Number(options.maxRoundConcentration);
  const rows = [];
  const invalid = [];
  for (const record of asArray(records)) {
    const nested = Array.isArray(record?.picks);
    const picks = nested ? record.picks : [record];
    for (const pick of picks) {
      const round = Number(pick?.round);
      const position = positionOf(pick);
      if (!Number.isInteger(round) || round < lateRound || !position) continue;
      if (nested && !record.simulationId && !record.id) invalid.push("missing_simulation_id");
      rows.push({ simulationId: record.simulationId ?? record.id ?? pick.simulationId ?? null, round, position });
    }
  }
  const positions = Array.from(new Set([
    ...asArray(options.positions).map((value) => String(value).toUpperCase()),
    ...rows.map((row) => row.position),
  ])).sort();
  const counts = Object.fromEntries(positions.map((position) => [position, 0]));
  for (const row of rows) counts[row.position] += 1;
  const total = rows.length;
  const distribution = Object.fromEntries(positions.map((position) => [position, total ? counts[position] / total : 0]));
  const topShare = total ? Math.max(...Object.values(distribution)) : 0;
  const roundGroups = new Map();
  for (const row of rows) {
    if (!roundGroups.has(row.round)) roundGroups.set(row.round, []);
    roundGroups.get(row.round).push(row.position);
  }
  const perRoundConcentration = Object.fromEntries([...roundGroups].sort(([left], [right]) => left - right).map(([round, values]) => {
    const roundCounts = Object.fromEntries([...new Set(values)].map((position) => [position, values.filter((value) => value === position).length]));
    return [round, Math.max(...Object.values(roundCounts)) / values.length];
  }));
  const worstRoundConcentration = Object.keys(perRoundConcentration).length ? Math.max(...Object.values(perRoundConcentration)) : 0;
  const metricValues = {
    sampleCount: total,
    simulationCount: new Set(rows.map((row) => row.simulationId).filter(Boolean)).size,
    positionCoverage: positions.length ? Object.values(counts).filter((count) => count >= minSamples).length / positions.length : 0,
    concentration: topShare,
    maxRoundConcentration: worstRoundConcentration,
    perRoundConcentration,
    entropy: positions.length ? entropy(distribution) : 0,
  };
  const checks = [
    ["sampleCount", metricValues.sampleCount >= minSamples, `late_round_sample_count_below_${minSamples}`],
    ["simulationCount", metricValues.simulationCount >= minSimulationCount, `simulation_count_below_${minSimulationCount}`],
    ["positionCoverage", metricValues.positionCoverage >= minPositionCoverage, "late_round_position_coverage_below_threshold"],
    ["concentration", metricValues.concentration <= maxConcentration, "late_round_concentration_above_threshold"],
    ["roundConcentration", metricValues.maxRoundConcentration <= maxRoundConcentration, "late_round_round_concentration_above_threshold"],
    ["entropy", metricValues.entropy >= minEntropy, "late_round_entropy_below_threshold"],
  ];
  const violations = [...invalid];
  const acceptedExemptions = [];
  for (const [metric, passed, reason] of checks) {
    if (passed) continue;
    const exemption = exemptionFor(options.exemptions, metric);
    if (exemption?.reason && exemption?.evidence != null) {
      acceptedExemptions.push({ metric, reason: String(exemption.reason), evidence: exemption.evidence });
    } else {
      violations.push(reason);
    }
  }
  for (const exemption of asArray(options.exemptions)) {
    if (!exemption?.metric || !exemption?.reason || exemption.evidence == null) violations.push("invalid_exemption");
    else if (!checks.some(([metric]) => metric === exemption.metric)) violations.push(`unknown_exemption_${exemption.metric}`);
  }
  return {
    accepted: violations.length === 0,
    lateRound,
    metrics: metricValues,
    counts,
    distribution,
    thresholds: { minSamples, minSimulationCount, minPositionCoverage, maxConcentration, maxRoundConcentration, minEntropy },
    exemptions: acceptedExemptions,
    violations: Array.from(new Set(violations)),
  };
}

function specialistRows(rows, options = {}) {
  const excluded = new Set(asArray(options.excludeManagerIds ?? options.joeManagerIds).map(String));
  const result = [];
  for (const row of asArray(rows)) {
    const managerId = row?.managerId ?? row?.ownerId;
    if (managerId && (excluded.has(String(managerId)) || String(managerId).toLowerCase() === "joe")) continue;
    const position = positionOf(row);
    const season = row?.season ?? row?.draftSeason;
    const suppliedRound = Number(row?.round);
    const seat = Number(row?.seat ?? row?.draftSlot);
    const pick = Number(row?.overallPick ?? row?.overall ?? row?.pick);
    const overall = Number.isInteger(pick) && pick > 0 ? pick : (Number.isInteger(seat) && seat > 0 && Number.isInteger(suppliedRound) ? overallPick(suppliedRound, seat, options.teams ?? 12) : null);
    const round = Number.isInteger(suppliedRound) ? suppliedRound : (overall ? pickCoordinates(overall, options.teams ?? 12).round : null);
    if (!SPECIALIST_POSITIONS.includes(position) || !Number.isInteger(Number(season)) || !Number.isInteger(round) || round < 1 || round > DRAFT_ROUNDS) continue;
    if (!overall) continue;
    result.push({ season: String(season), position, overall });
  }
  return result;
}

function excludedSpecialistRows(rows, options = {}) {
  const excluded = new Set(asArray(options.excludeManagerIds ?? options.joeManagerIds).map(String));
  return asArray(rows).filter((row) => {
    const managerId = row?.managerId ?? row?.ownerId;
    return managerId && (excluded.has(String(managerId)) || String(managerId).toLowerCase() === "joe");
  });
}

export function exactSnakeWindow({ round, seat, teams = 12 } = {}) {
  const normalizedRound = Number(round);
  const normalizedSeat = Number(seat);
  const start = overallPick(normalizedRound, normalizedSeat, Number(teams));
  const end = normalizedRound < DRAFT_ROUNDS ? overallPick(normalizedRound + 1, normalizedSeat, Number(teams)) - 1 : start;
  return { round: normalizedRound, seat: normalizedSeat, overallPick: start, windowEnd: end, coordinates: pickCoordinates(start, Number(teams)) };
}

function survivalWindows(options = {}) {
  const teams = Number(options.teams ?? 12);
  const rounds = asArray(options.windows).length
    ? options.windows
    : asArray(options.targetRounds).length
      ? asArray(options.targetRounds).flatMap((round) => asArray(options.targetSeats).length ? options.targetSeats.map((seat) => ({ round, seat })) : [{ round, seat: 1 }])
      : Array.from({ length: DRAFT_ROUNDS - 13 }, (_, index) => ({ round: index + 14, seat: 1 }));
  return rounds.map((window) => exactSnakeWindow({ round: Number(window.round), seat: Number(window.seat ?? 1), teams }));
}

function firstPicks(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.season}|${row.position}`;
    groups.set(key, Math.min(groups.get(key) ?? Infinity, row.overall));
  }
  return groups;
}

/** Estimate specialist survival at exact snake windows from de-identified history. */
export function specialistSurvivalByWindow(rows, options = {}) {
  const filtered = specialistRows(rows, options);
  const groups = firstPicks(filtered);
  const seasons = Array.from(new Set(filtered.map((row) => row.season))).sort();
  const windows = survivalWindows(options);
  const byPosition = {};
  for (const position of SPECIALIST_POSITIONS) {
    const positionWindows = windows.map((window) => {
      const survived = seasons.filter((season) => (groups.get(`${season}|${position}`) ?? Infinity) >= window.overallPick).length;
      const sampleCount = seasons.length;
      return { ...window, sampleCount, survivedCount: survived, probability: sampleCount ? survived / sampleCount : null };
    });
    byPosition[position] = { position, windows: positionWindows };
  }
  return {
    teams: Number(options.teams ?? 12),
    excludedManagerCount: new Set(excludedSpecialistRows(rows, options).map((row) => String(row.managerId ?? row.ownerId))).size,
    excludedRows: excludedSpecialistRows(rows, options).length,
    inputRows: asArray(rows).length,
    includedRows: filtered.length,
    sampleDrafts: seasons.length,
    windows,
    positions: byPosition,
  };
}

function eventMetrics(events) {
  if (!events.length) return { sampleCount: 0, brier: null, logLoss: null, accuracy: null };
  const brier = events.reduce((sum, event) => sum + (event.probability - event.observed) ** 2, 0) / events.length;
  const logLoss = events.reduce((sum, event) => sum - Math.log(Math.max(1e-12, event.observed ? event.probability : 1 - event.probability)), 0) / events.length;
  return { sampleCount: events.length, brier, logLoss, accuracy: events.filter((event) => (event.probability >= 0.5) === Boolean(event.observed)).length / events.length };
}

/** Leave-one-season-out evaluation of specialist-window probabilities. */
export function backtestSpecialistSurvival(rows, options = {}) {
  const filtered = specialistRows(rows, options);
  const seasons = Array.from(new Set(filtered.map((row) => row.season))).sort();
  const holdout = options.holdoutSeason == null ? seasons.at(-1) : String(options.holdoutSeason);
  const training = filtered.filter((row) => row.season !== holdout);
  const test = filtered.filter((row) => row.season === holdout);
  const model = specialistSurvivalByWindow(training, options);
  const events = [];
  for (const position of SPECIALIST_POSITIONS) {
    const first = firstPicks(test).get(`${holdout}|${position}`) ?? Infinity;
    for (const window of model.windows) {
      const probability = model.positions[position].windows.find((candidate) => candidate.overallPick === window.overallPick)?.probability;
      if (probability != null) events.push({ position, overallPick: window.overallPick, probability, observed: first >= window.overallPick });
    }
  }
  return { holdoutSeason: holdout, trainingDrafts: new Set(training.map((row) => row.season)).size, events, metrics: eventMetrics(events) };
}

function rosterEntryId(entry) {
  return String(idOf(entry) ?? "");
}

/** Evaluate only roster facts supplied by the caller; no schedule or player projection is inferred. */
export function evaluateRosterConstraints(input = {}) {
  const roster = asArray(input.roster);
  const constraints = input.constraints ?? {};
  const violations = [];
  const byeCounts = {};
  for (const entry of roster) {
    if (entry?.byeWeek != null) byeCounts[String(entry.byeWeek)] = (byeCounts[String(entry.byeWeek)] ?? 0) + 1;
  }
  const byeLimit = Number(constraints.maxByeCollision ?? constraints.byeCollisionLimit ?? 2);
  for (const [week, count] of Object.entries(byeCounts)) if (count > byeLimit) violations.push(`bye_collision_week_${week}`);

  const weeks = {};
  for (const week of [15, 16, 17]) {
    const supplied = asArray(constraints.week15to17 ?? constraints.scheduleWeeks).find((entry) => Number(entry.week) === week);
    if (supplied && supplied.minGames != null) {
      const games = roster.reduce((sum, player) => sum + Number(player?.schedule?.[week]?.games ?? player?.weeks?.[week]?.games ?? 0), 0);
      weeks[week] = { games, minGames: Number(supplied.minGames) };
      if (games < Number(supplied.minGames)) violations.push(`week_${week}_schedule_below_minimum`);
    }
  }

  const ids = new Set(roster.map(rosterEntryId));
  const stacks = [];
  for (const stack of asArray(constraints.requiredStacks ?? constraints.stacks)) {
    const count = stack.team == null ? asArray(stack.playerIds).filter((id) => ids.has(String(id))).length : roster.filter((entry) => String(entry?.team ?? "") === String(stack.team)).length;
    const min = Number(stack.min ?? 2);
    stacks.push({ team: stack.team ?? null, count, min });
    if (count < min) violations.push(`stack_below_minimum_${stack.team ?? "players"}`);
  }

  const handcuffs = [];
  for (const pair of asArray(constraints.handcuffs)) {
    const starterPresent = ids.has(String(pair.starterId));
    const handcuffPresent = ids.has(String(pair.handcuffId));
    handcuffs.push({ starterPresent, handcuffPresent });
    if (starterPresent && !handcuffPresent) violations.push(`missing_handcuff_for_${String(pair.starterId)}`);
  }

  const optionality = constraints.benchOptionality ?? {};
  const requestedSlots = asArray(optionality.slots);
  const bench = roster.filter((entry) => entry?.starter === false || entry?.bench === true);
  const optionalBench = bench.filter((entry) => !requestedSlots.length || requestedSlots.includes(positionOf(entry)) || requestedSlots.some((slot) => asArray(entry?.covers).includes(slot)));
  const benchRequired = Number(optionality.required ?? 0);
  if (optionalBench.length < benchRequired) violations.push("bench_optionality_below_minimum");

  const tieBreak = rankBySuppliedTiebreak(input.candidates, constraints.tiebreaks ?? constraints.tiebreakOrder);
  return {
    ok: violations.length === 0,
    violations,
    metrics: { rosterCount: roster.length, byeCounts, weeks, stacks, handcuffCount: handcuffs.length, optionalBenchCount: optionalBench.length },
    tiebreak: tieBreak,
  };
}

export function rankBySuppliedTiebreak(candidates, tiebreaks = []) {
  const rows = asArray(candidates).map((candidate, index) => ({ candidate, index }));
  const rules = asArray(tiebreaks).map((rule) => typeof rule === "string" ? { field: rule, direction: "desc" } : rule).filter((rule) => rule?.field);
  rows.sort((left, right) => {
    for (const rule of rules) {
      const a = Number(left.candidate?.[rule.field]);
      const b = Number(right.candidate?.[rule.field]);
      if (a !== b && finite(a) && finite(b)) return (rule.direction === "asc" ? a - b : b - a);
      const asText = String(left.candidate?.[rule.field] ?? "");
      const bsText = String(right.candidate?.[rule.field] ?? "");
      if (asText !== bsText) return rule.direction === "asc" ? asText.localeCompare(bsText) : bsText.localeCompare(asText);
    }
    return left.index - right.index;
  });
  return rows.map((row) => row.candidate);
}

/** Build pseudonymous opponent-seat summaries with explicit evidence thresholds. */
export function buildOpponentSeatWarCards(records, options = {}) {
  const minSamples = Number(options.minSamples ?? 5);
  const minSupport = Number(options.minSupport ?? options.doNotActThreshold ?? 0.6);
  const groups = new Map();
  for (const record of asArray(records)) {
    const seat = Number(record?.seat ?? record?.draftSlot);
    const signal = String(record?.position ?? record?.action ?? record?.selection ?? "").toUpperCase();
    if (!Number.isInteger(seat) || seat < 1 || !signal) continue;
    if (!groups.has(seat)) groups.set(seat, []);
    groups.get(seat).push(signal);
  }
  const seats = Array.from(groups.keys()).sort((a, b) => a - b);
  return {
    thresholds: { minSamples, minSupport },
    cards: seats.map((seat) => {
      const signals = groups.get(seat);
      const counts = Object.fromEntries(Array.from(new Set(signals)).sort().map((signal) => [signal, signals.filter((value) => value === signal).length]));
      const rates = Object.fromEntries(Object.entries(counts).map(([signal, count]) => [signal, count / signals.length]));
      const topRate = Math.max(...Object.values(rates));
      return { seat, sampleCount: signals.length, counts, rates, doNotAct: signals.length < minSamples || topRate < minSupport };
    }),
  };
}

function fallbackConfig(input, round) {
  const configured = input.fallbacks ?? input.fallbackInjection ?? [];
  return asArray(configured).find((entry) => Number(entry?.round) === round) ?? (configured && !Array.isArray(configured) && configured[round] ? configured[round] : null);
}

/** Rehearse exactly 19 supplied picks, including intentional and measured fallbacks. */
export function rehearseExactRoster(input = {}) {
  const picks = asArray(input.picks);
  const shape = input.rosterShape ?? input.requiredRoster;
  const latencyBudgetMs = Number(input.latencyBudgetMs ?? 10_000);
  const errors = [];
  const receipts = [];
  const counts = {};
  const seen = new Set();
  if (!shape || typeof shape !== "object") errors.push("missing_roster_shape");
  if (picks.length !== DRAFT_ROUNDS) errors.push("exactly_19_picks_required");
  for (let index = 0; index < DRAFT_ROUNDS; index += 1) {
    const round = index + 1;
    const pick = picks[index];
    const receipt = { round, status: "rejected", fallbackInjected: false, latencyMs: pick?.latencyMs ?? null, latencyBudgetMs, latencyPass: false };
    if (!pick || Number(pick.round) !== round) {
      errors.push(`round_${round}_missing_or_out_of_order`);
      receipts.push(receipt);
      continue;
    }
    const playerId = idOf(pick);
    if (!playerId || seen.has(String(playerId))) errors.push(`round_${round}_duplicate_or_missing_player`);
    else seen.add(String(playerId));
    const fallback = fallbackConfig(input, round);
    if (fallback) {
      const expectedFallback = String(fallback.fallbackId ?? fallback.fallbackPlayerId ?? "");
      const injected = pick.fallbackInjected === true && String(playerId) === expectedFallback && fallback.primaryUnavailable === true;
      receipt.fallbackInjected = injected;
      if (!injected) errors.push(`round_${round}_fallback_not_intentional`);
    }
    receipt.latencyPass = finite(pick.latencyMs) && Number(pick.latencyMs) >= 0 && Number(pick.latencyMs) <= latencyBudgetMs;
    if (!receipt.latencyPass) errors.push(`round_${round}_latency_budget_missed`);
    const position = positionOf(pick);
    counts[position] = (counts[position] ?? 0) + 1;
    receipt.status = receipt.latencyPass && (!fallback || receipt.fallbackInjected) ? (receipt.fallbackInjected ? "fallback" : "accepted") : "rejected";
    receipts.push(receipt);
  }
  if (shape && typeof shape === "object") {
    const keys = new Set([...Object.keys(shape), ...Object.keys(counts)]);
    for (const key of keys) if (Number(counts[key] ?? 0) !== Number(shape[key] ?? 0)) errors.push(`roster_shape_mismatch_${key}`);
  }
  return { valid: errors.length === 0, status: errors.length === 0 ? "PASS" : "LOCKED", errors: Array.from(new Set(errors)), receipts, finalCounts: counts, exactRounds: picks.length === DRAFT_ROUNDS };
}

/** Reconcile local settings with an already-observed Yahoo snapshot; values are never returned. */
export function reconcileSettingsAndYahoo(input = {}) {
  const settings = input.settings ?? {};
  const yahoo = input.yahoo ?? {};
  const fields = asArray(input.identityFields).length ? input.identityFields : ["leagueKey", "teamKey", "seat"];
  const reasons = [];
  for (const field of fields) {
    const expected = settings[field];
    const observed = yahoo[field] ?? yahoo.identity?.[field];
    if (expected == null || observed == null) reasons.push(`missing_identity_${field}`);
    else if (String(expected) !== String(observed)) reasons.push(`identity_mismatch_${field}`);
  }
  if (settings.requireReadOnly !== false && yahoo.readOnly !== true) reasons.push("yahoo_read_only_contract_missing");
  const requested = asArray(input.requestedPlayerIds ?? settings.requestedPlayerIds);
  const eligible = new Set(asArray(yahoo.eligiblePlayerIds ?? yahoo.eligibility?.eligiblePlayerIds).map(String));
  const ineligible = requested.filter((id) => !eligible.has(String(id)));
  if (ineligible.length) reasons.push("requested_player_not_yahoo_eligible");
  return {
    ok: reasons.length === 0,
    status: reasons.length === 0 ? "READY" : "LOCKED",
    reasons: Array.from(new Set(reasons)),
    identityMatched: reasons.every((reason) => !reason.startsWith("missing_identity_") && !reason.startsWith("identity_mismatch_")),
    eligibility: { requestedCount: requested.length, eligibleCount: requested.length - ineligible.length, allEligible: ineligible.length === 0 },
  };
}

function executeChaosScenario(scenario) {
  if (scenario?.type === "missing_yahoo_identity") return reconcileSettingsAndYahoo(scenario.input);
  if (scenario?.type === "duplicate_pick") return rehearseExactRoster(scenario.input);
  if (scenario?.type === "late_latency") return rehearseExactRoster(scenario.input);
  return { status: "LOCKED", reason: "unsupported_chaos_scenario" };
}

/** Grade deterministic mock/chaos scenarios against supplied expected outputs. */
export function gradeChaosScenarios(scenarios) {
  const results = asArray(scenarios).map((scenario, index) => {
    const observed = executeChaosScenario(scenario);
    const expected = scenario?.expected ?? {};
    const matches = stableJson(observed) === stableJson(expected);
    const failClosed = observed?.status === "LOCKED" || observed?.valid === false;
    const pass = matches && (!scenario?.mustFailClosed || failClosed);
    return { id: scenario?.id ?? `scenario-${index + 1}`, pass, failClosed, observedStatus: observed?.status ?? null, expectedStatus: expected?.status ?? null };
  });
  return { pass: results.every((result) => result.pass), passed: results.filter((result) => result.pass).length, total: results.length, results };
}
