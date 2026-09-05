import {
  buildIdpSourceProfile,
  combineIdpSourceProfiles,
  idpCalibrationHash,
  idpDecisionScore,
} from "./idp-ranking.mjs";

export const OFFENSE_SCORING = Object.freeze({
  passingCompletions: 0.1,
  passingYards: 0.04,
  passingTouchdowns: 6,
  interceptions: -2,
  rushingYards: 0.1,
  rushingTouchdowns: 6,
  rushingHundredYardGames: 2,
  receptions: 0.25,
  receivingYards: 0.1,
  receivingTouchdowns: 6,
  receivingHundredYardGames: 2,
  returnYards: 0.02,
  returnTouchdowns: 6,
  twoPointConversions: 2,
  fumblesLost: -2,
  offensiveFumbleReturnTouchdowns: 6,
});

export const IDP_SCORING = Object.freeze({
  soloTackles: 0.5,
  assistedTackles: 0.25,
  sacks: 2,
  interceptions: 3,
  forcedFumbles: 2,
  fumbleRecoveries: 2,
  touchdowns: 6,
  safeties: 2,
  passesDefended: 1,
  blockedKicks: 2,
  tacklesForLoss: 1,
  turnoverReturnYards: 0.1,
  extraPointReturns: 2,
});

export const KICKER_SCORING = Object.freeze({
  fieldGoalsMade: 3,
  extraPointsMade: 1,
  extraPointsMissed: -1,
});

const REQUIRED_PLAYER_FIELDS = ["playerId", "name", "position"];
const DEFAULT_PROJECTION_GAMES = 17;

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function assertIsoDate(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} must be an ISO date`);
  }
  return timestamp;
}

function quantile(values, percentile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function weightedMean(rows) {
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  if (totalWeight <= 0) throw new Error("projection weights must total more than zero");
  return rows.reduce((sum, row) => sum + row.points * row.weight, 0) / totalWeight;
}

function median(values) {
  return quantile(values, 0.5);
}

export function scoreOffenseStatLine(stats, scoring = OFFENSE_SCORING) {
  return Object.entries(scoring).reduce((points, [field, value]) => points + finite(stats?.[field]) * value, 0);
}

export function scoreWeeklyOffenseStatLines(weeks, scoring = OFFENSE_SCORING) {
  if (!Array.isArray(weeks)) throw new Error("weeks must be an array");
  return weeks.reduce((sum, stats) => sum + scoreOffenseStatLine(stats ?? {}, scoring), 0);
}

export function scoreIdpStatLine(stats, scoring = IDP_SCORING) {
  return Object.entries(scoring).reduce(
    (points, [field, value]) => points + finite(stats?.[field]) * value,
    0,
  );
}

export function scoreKickerStatLine(stats, scoring = KICKER_SCORING) {
  if (!("fieldGoalsMade" in scoring)) {
    if (Object.keys(scoring).some((field) => !hasFinite(stats?.[field]))) return NaN;
    return Object.entries(scoring).reduce((points, [field, value]) => points + Number(stats[field]) * value, 0);
  }
  const missedExtraPoints = finite(stats?.extraPointsMissed, Math.max(0, finite(stats?.extraPointsAttempted) - finite(stats?.extraPointsMade)));
  return finite(stats?.fieldGoalsMade) * scoring.fieldGoalsMade +
    finite(stats?.extraPointsMade) * scoring.extraPointsMade +
    missedExtraPoints * scoring.extraPointsMissed;
}

function normalizePosition(value) {
  const position = String(value ?? "").toUpperCase();
  if (["DE", "DT", "NT"].includes(position)) return "DL";
  if (["FS", "SS"].includes(position)) return "S";
  if (["ILB", "OLB"].includes(position)) return "LB";
  return position;
}

function eligibilityFor(player) {
  const eligible = Array.from(player?.eligible ?? [], normalizePosition).filter(Boolean);
  const primary = normalizePosition(player?.position);
  return [...new Set([...eligible, primary].filter(Boolean))];
}

function slotAccepts(slot, eligible) {
  const normalizedSlot = normalizePosition(slot);
  const positions = new Set(Array.from(eligible ?? [], normalizePosition));
  if (positions.has(normalizedSlot)) return true;
  if (normalizedSlot === "W/R") return positions.has("WR") || positions.has("RB");
  if (normalizedSlot === "W/R/T") return positions.has("WR") || positions.has("RB") || positions.has("TE");
  if (normalizedSlot === "D") return ["DL", "LB", "DB", "CB", "S", "D"].some((position) => positions.has(position));
  if (normalizedSlot === "DB") return ["DB", "CB", "S"].some((position) => positions.has(position));
  if (normalizedSlot === "CB") return positions.has("CB") || positions.has("DB");
  if (normalizedSlot === "S") return positions.has("S") || positions.has("DB");
  return false;
}

function addFlowEdge(graph, from, to, capacity, cost, metadata = null) {
  const forward = { to, reverse: graph[to].length, capacity, cost, metadata, initialCapacity: capacity };
  const reverse = { to: from, reverse: graph[from].length, capacity: 0, cost: -cost, metadata: null, initialCapacity: 0 };
  graph[from].push(forward);
  graph[to].push(reverse);
}

/**
 * Jointly fills every league starter slot. Residual edges allow an already
 * assigned multi-position player to move when that produces a better global
 * allocation, so W/R/T and D are not estimated as independent rank cutoffs.
 */
export function deriveJointReplacementLevels({ players, teamCount, rosterSlots, pointsField = "consensusPoints" }) {
  if (!Number.isInteger(teamCount) || teamCount < 2) throw new Error("teamCount must be an integer of at least two");
  const slotCounts = Array.from(rosterSlots ?? []).reduce((counts, rawSlot) => {
    const slot = normalizePosition(rawSlot);
    if (!slot || ["BN", "IR"].includes(slot)) return counts;
    counts[slot] = (counts[slot] ?? 0) + teamCount;
    return counts;
  }, {});
  if (!Object.keys(slotCounts).length) throw new Error("rosterSlots must include at least one starter slot");

  const eligiblePlayers = Array.from(players ?? [])
    .filter((player) => Number.isFinite(Number(player[pointsField])))
    .map((player) => ({ ...player, eligible: eligibilityFor(player), points: Number(player[pointsField]) }))
    .filter((player) => Object.keys(slotCounts).some((slot) => slotAccepts(slot, player.eligible)));
  const slotNames = Object.keys(slotCounts);
  const source = 0;
  const firstPlayer = 1;
  const firstSlot = firstPlayer + eligiblePlayers.length;
  const sink = firstSlot + slotNames.length;
  const graph = Array.from({ length: sink + 1 }, () => []);
  eligiblePlayers.forEach((player, index) => {
    const playerNode = firstPlayer + index;
    addFlowEdge(graph, source, playerNode, 1, -player.points);
    slotNames.forEach((slot, slotIndex) => {
      if (slotAccepts(slot, player.eligible)) {
        addFlowEdge(graph, playerNode, firstSlot + slotIndex, 1, 0, { playerId: String(player.playerId), slot, points: player.points });
      }
    });
  });
  slotNames.forEach((slot, index) => addFlowEdge(graph, firstSlot + index, sink, slotCounts[slot], 0));

  const requestedFlow = Object.values(slotCounts).reduce((sum, count) => sum + count, 0);
  let flow = 0;
  while (flow < requestedFlow) {
    const distance = Array(graph.length).fill(Infinity);
    const parentNode = Array(graph.length).fill(-1);
    const parentEdge = Array(graph.length).fill(-1);
    distance[source] = 0;
    for (let pass = 0; pass < graph.length - 1; pass += 1) {
      let changed = false;
      for (let node = 0; node < graph.length; node += 1) {
        if (!Number.isFinite(distance[node])) continue;
        graph[node].forEach((edge, edgeIndex) => {
          if (edge.capacity <= 0 || distance[node] + edge.cost >= distance[edge.to]) return;
          distance[edge.to] = distance[node] + edge.cost;
          parentNode[edge.to] = node;
          parentEdge[edge.to] = edgeIndex;
          changed = true;
        });
      }
      if (!changed) break;
    }
    if (parentNode[sink] < 0) break;
    for (let node = sink; node !== source; node = parentNode[node]) {
      const edge = graph[parentNode[node]][parentEdge[node]];
      edge.capacity -= 1;
      graph[node][edge.reverse].capacity += 1;
    }
    flow += 1;
  }
  if (flow !== requestedFlow) throw new Error(`joint replacement allocation filled ${flow} of ${requestedFlow} starter slots`);

  const assignments = [];
  eligiblePlayers.forEach((_player, index) => {
    for (const edge of graph[firstPlayer + index]) {
      if (edge.metadata && edge.initialCapacity === 1 && edge.capacity === 0) assignments.push(edge.metadata);
    }
  });
  const replacementBySlot = {};
  for (const slot of slotNames) {
    const points = assignments.filter((entry) => entry.slot === slot).map((entry) => entry.points);
    replacementBySlot[slot] = points.length ? Math.min(...points) : null;
  }
  if (replacementBySlot.DB != null) {
    replacementBySlot.CB ??= replacementBySlot.DB;
    replacementBySlot.S ??= replacementBySlot.DB;
  }
  return Object.freeze({ replacementBySlot, assignments, slotCounts });
}

function projectionPoints(row, rules) {
  const scoringKind = String(row?.scoringKind ?? "offense").toLowerCase();
  if (!["offense", "idp", "kicker"].includes(scoringKind)) return null;
  if (row?.leaguePoints !== null && row?.leaguePoints !== undefined && row?.leaguePoints !== "" && Number.isFinite(Number(row.leaguePoints))) {
    return Number(row.leaguePoints);
  }
  const stats = row?.stats;
  if (Array.isArray(row?.weeklyStats)) return scoringKind === "offense" ? scoreWeeklyOffenseStatLines(row.weeklyStats, rules.offense) : null;
  if (!stats || typeof stats !== "object") return null;
  const scoring = rules[scoringKind];
  const hasScoredStat = Object.keys(scoring).some(
    (key) => stats[key] !== null && stats[key] !== undefined && stats[key] !== "" && Number.isFinite(Number(stats[key])),
  );
  return hasScoredStat
    ? scoringKind === "idp" ? scoreIdpStatLine(stats, scoring) : scoringKind === "kicker" ? scoreKickerStatLine(stats, scoring) : scoreOffenseStatLine(stats, scoring)
    : null;
}

function hasFinite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function projectionPerGame(row, source, scoring) {
  if (hasFinite(row?.perGamePoints)) return Number(row.perGamePoints);
  const seasonPoints = projectionPoints(row, scoring);
  if (!Number.isFinite(seasonPoints)) return null;
  const games = hasFinite(row?.projectionGames)
    ? Number(row.projectionGames)
    : hasFinite(row?.expectedGames)
      ? Number(row.expectedGames)
      : hasFinite(source?.projectionGames)
        ? Number(source.projectionGames)
        : DEFAULT_PROJECTION_GAMES;
  if (!(games > 0 && games <= DEFAULT_PROJECTION_GAMES)) {
    throw new Error(`projection games must be between 1 and ${DEFAULT_PROJECTION_GAMES}`);
  }
  return seasonPoints / games;
}

export function deriveReplacementRanks({
  teamCount,
  starters,
  flexSlots = 0,
  flexShares = {},
  benchSlots = 0,
  benchShares = {},
}) {
  if (!Number.isInteger(teamCount) || teamCount < 2) {
    throw new Error("teamCount must be an integer of at least two");
  }
  const positions = new Set([
    ...Object.keys(starters ?? {}),
    ...Object.keys(flexShares),
    ...Object.keys(benchShares),
  ]);
  const rankByPosition = {};
  const assumptions = {};
  for (const position of positions) {
    const direct = teamCount * finite(starters?.[position]);
    const flex = teamCount * flexSlots * finite(flexShares[position]);
    const bench = teamCount * benchSlots * finite(benchShares[position]);
    rankByPosition[position] = Math.max(1, Math.ceil(direct + flex + bench));
    assumptions[position] = { direct, flex, bench };
  }
  return Object.freeze({ rankByPosition, assumptions });
}

export function buildPlayerBoard({
  players,
  sources,
  replacementRanks,
  asOf,
  maxAgeHours = 72,
  minimumFreshSources = 2,
  evidencePolicy = null,
  replacementRoster = null,
  idpCalibration = null,
  scoring = { offense:OFFENSE_SCORING, idp:IDP_SCORING, kicker:KICKER_SCORING },
}) {
  const now = assertIsoDate(asOf, "asOf");
  if (!Array.isArray(players) || players.length === 0) {
    throw new Error("players must be a nonempty array");
  }
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("sources must be a nonempty array");
  }
  if (!replacementRanks || typeof replacementRanks !== "object") {
    throw new Error("replacementRanks are required and must be explicit");
  }

  const playerById = new Map();
  for (const player of players) {
    for (const field of REQUIRED_PLAYER_FIELDS) {
      if (!String(player?.[field] ?? "").trim()) {
        throw new Error(`player ${field} is required`);
      }
    }
    if (playerById.has(String(player.playerId))) {
      throw new Error(`duplicate playerId ${player.playerId}`);
    }
    playerById.set(String(player.playerId), player);
  }

  const evidenceByPlayer = new Map();
  const sourceReceipts = [];
  const seenSourceIds = new Set();
  for (const source of sources) {
    const sourceId = String(source?.sourceId ?? "").trim();
    if (!sourceId) throw new Error("every source requires sourceId");
    if (seenSourceIds.has(sourceId)) throw new Error(`duplicate sourceId ${sourceId}`);
    seenSourceIds.add(sourceId);
    const family = String(source?.family ?? sourceId).trim();
    if (!family) throw new Error(`source ${sourceId} requires family`);
    const updatedAt = assertIsoDate(source.updatedAt, `source ${sourceId} updatedAt`);
    const ageHours = (now - updatedAt) / 3_600_000;
    const sourceMaxAgeHours = finite(source.maxAgeHours, maxAgeHours);
    if (!(sourceMaxAgeHours > 0)) throw new Error(`source ${sourceId} maxAgeHours must be positive`);
    const fresh = source.freshOverride !== false && ageHours >= 0 && ageHours <= sourceMaxAgeHours;
    const weight = finite(source.weight, 1);
    if (weight <= 0) throw new Error(`source ${sourceId} weight must be positive`);
    const rows = Array.isArray(source.rows) ? source.rows : [];
    const sourceAcceptedOmissions = new Set(
      Array.isArray(source.acceptedOmissions) ? source.acceptedOmissions.map(String) : [],
    );
    sourceReceipts.push({
      sourceId,
      family,
      updatedAt: source.updatedAt,
      ageHours,
      maxAgeHours: sourceMaxAgeHours,
      fresh,
      freshnessOverride: source.freshOverride ?? null,
      inputRows: finite(source.inputRows, rows.length),
      joinedRows: rows.length,
    });
    if (!fresh) continue;
    for (const row of rows) {
      const playerId = String(row.playerId ?? "");
      if (!playerById.has(playerId)) continue;
      const perGamePoints = projectionPerGame(row, source, scoring);
      if (!Number.isFinite(perGamePoints)) continue;
      const evidence = evidenceByPlayer.get(playerId) ?? [];
      const omissions = Array.isArray(row.omittedScoringCategories)
        ? [...new Set(row.omittedScoringCategories.map(String))].sort()
        : [];
      const acceptedOmissions = new Set(
        Array.isArray(row.acceptedOmissions) ? row.acceptedOmissions.map(String) : sourceAcceptedOmissions,
      );
      evidence.push({
        sourceId,
        family,
        scoringKind: String(row?.scoringKind ?? "offense").toLowerCase(),
        perGamePoints,
        weight,
        updatedAt: source.updatedAt,
        omittedScoringCategories: omissions,
        acceptedOmittedScoringCategories: omissions.filter((field) => acceptedOmissions.has(field)),
        unacceptedOmittedScoringCategories: omissions.filter((field) => !acceptedOmissions.has(field)),
        idpProfile: String(row?.scoringKind ?? "").toLowerCase() === "idp"
          ? buildIdpSourceProfile({
              stats: row.stats,
              scoring: scoring.idp,
              omittedScoringCategories: omissions,
              sourceId,
              projectionGames: row.projectionGames ?? source.projectionGames ?? null,
            })
          : null,
      });
      evidenceByPlayer.set(playerId, evidence);
    }
  }

  const calibrationHash = idpCalibrationHash(idpCalibration);
  const board = players.map((player) => {
    const evidence = evidenceByPlayer.get(String(player.playerId)) ?? [];
    const expectedGames = hasFinite(player.expectedGames)
      ? Number(player.expectedGames)
      : DEFAULT_PROJECTION_GAMES;
    if (!(expectedGames >= 0 && expectedGames <= DEFAULT_PROJECTION_GAMES)) {
      throw new Error(`player ${player.playerId} expectedGames must be between 0 and ${DEFAULT_PROJECTION_GAMES}`);
    }
    const familyEvidence = [...Map.groupBy(evidence, (row) => row.family)].map(([family, rows]) => {
      const rawProfiles = rows.map((row) => row.idpProfile).filter(Boolean);
      return {
        family,
        sourceIds: rows.map((row) => row.sourceId).sort(),
        perGamePoints: weightedMean(rows.map((row) => ({ ...row, points: row.perGamePoints }))),
        weight: 1,
        omittedScoringCategories: [...new Set(rows.flatMap((row) => row.omittedScoringCategories))].sort(),
        acceptedOmittedScoringCategories: [...new Set(rows.flatMap((row) => row.acceptedOmittedScoringCategories))].sort(),
        unacceptedOmittedScoringCategories: [...new Set(rows.flatMap((row) => row.unacceptedOmittedScoringCategories))].sort(),
        idpProfile: rawProfiles.length ? combineIdpSourceProfiles(rawProfiles) : null,
      };
    });
    const policy = evidencePolicy
      ? evidencePolicy(player)
      : { minimumFreshFamilies: minimumFreshSources };
    const minimumFreshFamilies = Number(policy?.minimumFreshFamilies ?? minimumFreshSources);
    if (!Number.isInteger(minimumFreshFamilies) || minimumFreshFamilies < 1) {
      throw new Error(`player ${player.playerId} minimumFreshFamilies must be a positive integer`);
    }
    const requiredFamilies = [...new Set((policy?.requiredFamilies ?? []).map(String))].sort();
    const scoringEvidence = familyEvidence.filter((row) => row.unacceptedOmittedScoringCategories.length === 0);
    const presentFamilies = new Set(scoringEvidence.map((row) => row.family));
    const missingRequiredFamilies = requiredFamilies.filter((family) => !presentFamilies.has(family));
    const projectionBlendPolicy = scoringEvidence.length >= 3
      ? "equal-family-median; only families with no unaccepted scoring omissions"
      : "equal-family-mean; only families with no unaccepted scoring omissions";
    const normalizedEvidence = familyEvidence.map((row) => ({
      ...row,
      points: row.perGamePoints * expectedGames,
    }));
    const points = normalizedEvidence.map((row) => row.points);
    const perGamePoints = scoringEvidence.length
      ? scoringEvidence.length >= 3
        ? median(scoringEvidence.map((row) => row.perGamePoints))
        : weightedMean(scoringEvidence.map((row) => ({ ...row, points: row.perGamePoints })))
      : null;
    const consensus = perGamePoints == null ? null : perGamePoints * expectedGames;
    const calibratedOutcome = player.outcomeCalibrated === true &&
      hasFinite(player.outcomeLow) && hasFinite(player.outcomeHigh) &&
      Number(player.outcomeLow) <= Number(player.outcomeHigh);
    const executable = scoringEvidence.length >= minimumFreshFamilies && missingRequiredFamilies.length === 0;
    const omittedScoringCategories = [...new Set(familyEvidence.flatMap((row) => row.omittedScoringCategories))].sort();
    const idpProfile = combineIdpSourceProfiles(scoringEvidence.map((row) => row.idpProfile).filter(Boolean));
    const idpDecision = idpDecisionScore({
      consensusPoints: consensus,
      profile: idpProfile,
      position: player.position,
      calibration: idpCalibration,
    });
    const rankingPoints = idpDecision.points;
    return {
      ...player,
      consensusPoints: consensus,
      perGamePoints,
      rankingPoints,
      rankingPerGamePoints: rankingPoints == null || expectedGames === 0 ? null : rankingPoints / expectedGames,
      idpProfile,
      idpDecisionPoints: idpDecision.points,
      idpDecisionScale: idpDecision.scale,
      idpModelStatus: idpDecision.status,
      idpModelWarning: idpDecision.warning ?? null,
      idpCalibrationHash: calibrationHash,
      expectedGames,
      sourceSpreadLow: quantile(points, 0.25),
      sourceSpreadHigh: quantile(points, 0.75),
      sourceDisagreementStatus: familyEvidence.length >= 2 ? "AVAILABLE_DIAGNOSTIC_ONLY" : "INSUFFICIENT_SOURCES",
      outcomeLow: calibratedOutcome ? Number(player.outcomeLow) : null,
      outcomeHigh: calibratedOutcome ? Number(player.outcomeHigh) : null,
      rawOutcomeLow: calibratedOutcome ? Number(player.outcomeLow) : null,
      rawOutcomeHigh: calibratedOutcome ? Number(player.outcomeHigh) : null,
      rankingOutcomeLow: calibratedOutcome ? Number(player.outcomeLow) * idpDecision.scale : null,
      rankingOutcomeHigh: calibratedOutcome ? Number(player.outcomeHigh) * idpDecision.scale : null,
      uncertaintyStatus: calibratedOutcome ? "CALIBRATED_OUTCOME_INTERVAL" : "OUTCOME_INTERVAL_UNAVAILABLE",
      sourceCount: evidence.length,
      sourceIds: evidence.map((row) => row.sourceId).sort(),
      sourceFamilyCount: familyEvidence.length,
      sourceFamilies: familyEvidence.map((row) => row.family).sort(),
      scorableSourceFamilyCount: scoringEvidence.length,
      scorableSourceFamilies: scoringEvidence.map((row) => row.family).sort(),
      sourceFamilyPerGamePoints: Object.fromEntries(
        familyEvidence.map((row) => [row.family, row.perGamePoints]),
      ),
      projectionBlendPolicy,
      requiredFreshFamilies: minimumFreshFamilies,
      requiredSourceFamilies: requiredFamilies,
      missingRequiredSourceFamilies: missingRequiredFamilies,
      omittedScoringCategories,
      unacceptedOmittedScoringCategories: [...new Set(familyEvidence.flatMap((row) => row.unacceptedOmittedScoringCategories))].sort(),
      executable,
      evidenceStatus: executable
        ? "VALIDATED"
        : missingRequiredFamilies.length
          ? "MISSING_REQUIRED_PROJECTION_FAMILY"
        : scoringEvidence.length === 1
          ? "UNVALIDATED_SINGLE_SOURCE_PROJECTION"
          : "NO_FRESH_PROJECTION",
      blockReason:
        executable
          ? null
          : missingRequiredFamilies.length
            ? `requires source families ${requiredFamilies.join(", ")}; missing ${missingRequiredFamilies.join(", ")}`
            : `requires ${minimumFreshFamilies} scorable projection families; found ${scoringEvidence.length}`,
    };
  });

  const replacementByPosition = {};
  const rawReplacementByPosition = {};
  for (const [position, rankValue] of Object.entries(replacementRanks)) {
    const rank = Number(rankValue);
    if (!Number.isInteger(rank) || rank < 1) {
      throw new Error(`replacement rank for ${position} must be a positive integer`);
    }
    const eligible = board
      .filter((player) => player.position === position && player.rankingPoints !== null)
      .sort((left, right) => right.rankingPoints - left.rankingPoints);
    const rawEligible = board
      .filter((player) => player.position === position && player.consensusPoints !== null)
      .sort((left, right) => right.consensusPoints - left.consensusPoints);
    replacementByPosition[position] = eligible[Math.min(rank - 1, eligible.length - 1)]?.rankingPoints ?? null;
    rawReplacementByPosition[position] = rawEligible[Math.min(rank - 1, rawEligible.length - 1)]?.consensusPoints ?? null;
  }

  const joint = replacementRoster
    ? deriveJointReplacementLevels({ players: board, ...replacementRoster, pointsField: "rankingPoints" })
    : null;
  const rawJoint = replacementRoster
    ? deriveJointReplacementLevels({ players: board, ...replacementRoster, pointsField: "consensusPoints" })
    : null;
  const ranked = board
    .map((player) => {
      const jointBaselines = joint
        ? Object.entries(joint.replacementBySlot)
            .filter(([slot, points]) => points != null && slotAccepts(slot, eligibilityFor(player)))
            .map(([, points]) => points)
        : [];
      const replacementPoints = jointBaselines.length
        ? Math.min(...jointBaselines)
        : replacementByPosition[player.position] ?? null;
      const rawJointBaselines = rawJoint
        ? Object.entries(rawJoint.replacementBySlot)
            .filter(([slot, points]) => points != null && slotAccepts(slot, eligibilityFor(player)))
            .map(([, points]) => points)
        : [];
      const rawReplacementPoints = rawJointBaselines.length
        ? Math.min(...rawJointBaselines)
        : rawReplacementByPosition[player.position] ?? null;
      const vorp =
        player.rankingPoints === null || replacementPoints === null
          ? null
          : player.rankingPoints - replacementPoints;
      const rawVorp = player.consensusPoints === null || rawReplacementPoints === null
        ? null
        : player.consensusPoints - rawReplacementPoints;
      return { ...player, replacementPoints, vorp, rawReplacementPoints, rawVorp };
    })
    .sort((left, right) => {
      if (left.vorp === null) return 1;
      if (right.vorp === null) return -1;
      return right.vorp - left.vorp || left.name.localeCompare(right.name);
    })
    .map((player, index) => ({ ...player, overallRank: player.vorp === null ? null : index + 1 }));

  return Object.freeze({
    asOf,
    scoring: scoring.offense,
    replacementRanks: { ...replacementRanks },
    replacementByPosition,
    rawReplacementByPosition,
    replacementBySlot: joint?.replacementBySlot ?? null,
    rawReplacementBySlot: rawJoint?.replacementBySlot ?? null,
    replacementAllocation: joint?.assignments ?? null,
    sourceReceipts,
    players: ranked,
  });
}
