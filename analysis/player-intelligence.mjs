const OFFENSE_SCORING = Object.freeze({
  passingCompletions: 0.1,
  passingYards: 0.04,
  passingTouchdowns: 6,
  interceptions: -2,
  rushingYards: 0.1,
  rushingTouchdowns: 6,
  rushingHundredYardBonus: 2,
  receptions: 0.25,
  receivingYards: 0.1,
  receivingTouchdowns: 6,
  receivingHundredYardBonus: 2,
  returnYards: 0.02,
  returnTouchdowns: 6,
  twoPointConversions: 2,
  fumblesLost: -2,
  offensiveFumbleReturnTouchdowns: 6,
});

const REQUIRED_PLAYER_FIELDS = ["playerId", "name", "position"];

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

export function scoreOffenseStatLine(stats, scoring = OFFENSE_SCORING) {
  const rushingYards = finite(stats.rushingYards);
  const receivingYards = finite(stats.receivingYards);
  return (
    finite(stats.passingCompletions) * scoring.passingCompletions +
    finite(stats.passingYards) * scoring.passingYards +
    finite(stats.passingTouchdowns) * scoring.passingTouchdowns +
    finite(stats.interceptions) * scoring.interceptions +
    rushingYards * scoring.rushingYards +
    finite(stats.rushingTouchdowns) * scoring.rushingTouchdowns +
    (rushingYards >= 100 ? scoring.rushingHundredYardBonus : 0) +
    finite(stats.receptions) * scoring.receptions +
    receivingYards * scoring.receivingYards +
    finite(stats.receivingTouchdowns) * scoring.receivingTouchdowns +
    (receivingYards >= 100 ? scoring.receivingHundredYardBonus : 0) +
    finite(stats.returnYards) * scoring.returnYards +
    finite(stats.returnTouchdowns) * scoring.returnTouchdowns +
    finite(stats.twoPointConversions) * scoring.twoPointConversions +
    finite(stats.fumblesLost) * scoring.fumblesLost +
    finite(stats.offensiveFumbleReturnTouchdowns) *
      scoring.offensiveFumbleReturnTouchdowns
  );
}

function projectionPoints(row) {
  if (row?.leaguePoints !== null && row?.leaguePoints !== undefined && row?.leaguePoints !== "" && Number.isFinite(Number(row.leaguePoints))) {
    return Number(row.leaguePoints);
  }
  const stats = row?.stats;
  if (!stats || typeof stats !== "object") return null;
  const hasScoredStat = Object.keys(OFFENSE_SCORING).some(
    (key) => stats[key] !== null && stats[key] !== undefined && stats[key] !== "" && Number.isFinite(Number(stats[key])),
  );
  return hasScoredStat ? scoreOffenseStatLine(stats) : null;
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
  for (const source of sources) {
    const sourceId = String(source?.sourceId ?? "").trim();
    if (!sourceId) throw new Error("every source requires sourceId");
    const updatedAt = assertIsoDate(source.updatedAt, `source ${sourceId} updatedAt`);
    const ageHours = (now - updatedAt) / 3_600_000;
    const fresh = ageHours >= 0 && ageHours <= maxAgeHours;
    const weight = finite(source.weight, 1);
    if (weight <= 0) throw new Error(`source ${sourceId} weight must be positive`);
    const rows = Array.isArray(source.rows) ? source.rows : [];
    sourceReceipts.push({ sourceId, updatedAt: source.updatedAt, ageHours, fresh, rows: rows.length });
    if (!fresh) continue;
    for (const row of rows) {
      const playerId = String(row.playerId ?? "");
      if (!playerById.has(playerId)) continue;
      const points = projectionPoints(row);
      if (!Number.isFinite(points)) continue;
      const evidence = evidenceByPlayer.get(playerId) ?? [];
      evidence.push({ sourceId, points, weight, updatedAt: source.updatedAt });
      evidenceByPlayer.set(playerId, evidence);
    }
  }

  const board = players.map((player) => {
    const evidence = evidenceByPlayer.get(String(player.playerId)) ?? [];
    const points = evidence.map((row) => row.points);
    const consensus = evidence.length ? weightedMean(evidence) : null;
    return {
      ...player,
      consensusPoints: consensus,
      lowPoints: quantile(points, 0.25),
      highPoints: quantile(points, 0.75),
      sourceCount: evidence.length,
      sourceIds: evidence.map((row) => row.sourceId).sort(),
      executable: evidence.length >= minimumFreshSources,
      blockReason:
        evidence.length >= minimumFreshSources
          ? null
          : `requires ${minimumFreshSources} fresh projection sources; found ${evidence.length}`,
    };
  });

  const replacementByPosition = {};
  for (const [position, rankValue] of Object.entries(replacementRanks)) {
    const rank = Number(rankValue);
    if (!Number.isInteger(rank) || rank < 1) {
      throw new Error(`replacement rank for ${position} must be a positive integer`);
    }
    const eligible = board
      .filter((player) => player.position === position && player.consensusPoints !== null)
      .sort((left, right) => right.consensusPoints - left.consensusPoints);
    replacementByPosition[position] = eligible[Math.min(rank - 1, eligible.length - 1)]?.consensusPoints ?? null;
  }

  const ranked = board
    .map((player) => {
      const replacementPoints = replacementByPosition[player.position] ?? null;
      const vorp =
        player.consensusPoints === null || replacementPoints === null
          ? null
          : player.consensusPoints - replacementPoints;
      return { ...player, replacementPoints, vorp };
    })
    .sort((left, right) => {
      if (left.vorp === null) return 1;
      if (right.vorp === null) return -1;
      return right.vorp - left.vorp || left.name.localeCompare(right.name);
    })
    .map((player, index) => ({ ...player, overallRank: player.vorp === null ? null : index + 1 }));

  return Object.freeze({
    asOf,
    scoring: OFFENSE_SCORING,
    replacementRanks: { ...replacementRanks },
    replacementByPosition,
    sourceReceipts,
    players: ranked,
  });
}

export { OFFENSE_SCORING };
