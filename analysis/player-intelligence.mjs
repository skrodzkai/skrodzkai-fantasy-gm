const OFFENSE_SCORING = Object.freeze({
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

const IDP_SCORING = Object.freeze({
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
  const rushingHundredYardGames = stats.rushingHundredYardGames == null
    ? (rushingYards >= 100 ? 1 : 0)
    : finite(stats.rushingHundredYardGames);
  const receivingHundredYardGames = stats.receivingHundredYardGames == null
    ? (receivingYards >= 100 ? 1 : 0)
    : finite(stats.receivingHundredYardGames);
  return (
    finite(stats.passingCompletions) * scoring.passingCompletions +
    finite(stats.passingYards) * scoring.passingYards +
    finite(stats.passingTouchdowns) * scoring.passingTouchdowns +
    finite(stats.interceptions) * scoring.interceptions +
    rushingYards * scoring.rushingYards +
    finite(stats.rushingTouchdowns) * scoring.rushingTouchdowns +
    rushingHundredYardGames * scoring.rushingHundredYardGames +
    finite(stats.receptions) * scoring.receptions +
    receivingYards * scoring.receivingYards +
    finite(stats.receivingTouchdowns) * scoring.receivingTouchdowns +
    receivingHundredYardGames * scoring.receivingHundredYardGames +
    finite(stats.returnYards) * scoring.returnYards +
    finite(stats.returnTouchdowns) * scoring.returnTouchdowns +
    finite(stats.twoPointConversions) * scoring.twoPointConversions +
    finite(stats.fumblesLost) * scoring.fumblesLost +
    finite(stats.offensiveFumbleReturnTouchdowns) *
      scoring.offensiveFumbleReturnTouchdowns
  );
}

export function scoreIdpStatLine(stats, scoring = IDP_SCORING) {
  return Object.entries(scoring).reduce(
    (points, [field, value]) => points + finite(stats?.[field]) * value,
    0,
  );
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
export function deriveJointReplacementLevels({ players, teamCount, rosterSlots }) {
  if (!Number.isInteger(teamCount) || teamCount < 2) throw new Error("teamCount must be an integer of at least two");
  const slotCounts = Array.from(rosterSlots ?? []).reduce((counts, rawSlot) => {
    const slot = normalizePosition(rawSlot);
    if (!slot || ["BN", "IR"].includes(slot)) return counts;
    counts[slot] = (counts[slot] ?? 0) + teamCount;
    return counts;
  }, {});
  if (!Object.keys(slotCounts).length) throw new Error("rosterSlots must include at least one starter slot");

  const eligiblePlayers = Array.from(players ?? [])
    .filter((player) => Number.isFinite(Number(player.consensusPoints)))
    .map((player) => ({ ...player, eligible: eligibilityFor(player), points: Number(player.consensusPoints) }))
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
  replacementRoster = null,
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
      sourceSpreadLow: quantile(points, 0.25),
      sourceSpreadHigh: quantile(points, 0.75),
      uncertaintyStatus: "SOURCE_DISAGREEMENT_ONLY",
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

  const joint = replacementRoster
    ? deriveJointReplacementLevels({ players: board, ...replacementRoster })
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
    replacementBySlot: joint?.replacementBySlot ?? null,
    replacementAllocation: joint?.assignments ?? null,
    sourceReceipts,
    players: ranked,
  });
}

export { IDP_SCORING, OFFENSE_SCORING };
