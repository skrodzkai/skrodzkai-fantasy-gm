import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

import { buildDraftWatchlist, compileInjuryBoard } from "./injury-monitor.mjs";
import { buildPlayerBoard, IDP_SCORING, OFFENSE_SCORING } from "./player-intelligence.mjs";
import { buildWeeklyProjectionProfile, expectedGamesFromInjury } from "./weekly-roster-utility.mjs";
import { FREE_SOURCE_REGISTRY, validateSourceSnapshot } from "./free-source-registry.mjs";

export const LEAGUE_REPLACEMENT_RANKS = Object.freeze({
  QB: 12,
  RB: 30,
  WR: 42,
  TE: 14,
  K: 12,
  DEF: 12,
  DL: 18,
  LB: 24,
  DB: 18,
});

export const LEAGUE_STARTER_SLOTS = Object.freeze([
  "QB", "WR", "WR", "WR", "RB", "RB", "TE", "W/R/T", "K", "DEF", "D", "DB", "LB",
]);

export const SCORING_SCHEMA_HASH = createHash("sha256")
  .update(JSON.stringify({ offense: OFFENSE_SCORING, idp: IDP_SCORING }))
  .digest("hex");

const YAHOO_STATUS = Object.freeze({
  Q: "QUESTIONABLE",
  D: "DOUBTFUL",
  O: "OUT",
  IR: "IR",
  PUP: "PUP",
  NFI: "NFI",
  NA: "UNKNOWN",
});

const ACCEPTED_OFFENSE_OMISSIONS = Object.freeze([
  "rushingHundredYardGames", "receivingHundredYardGames", "returnYards",
  "returnTouchdowns", "twoPointConversions", "fumblesLost",
  "offensiveFumbleReturnTouchdowns",
]);
const ACCEPTED_IDP_OMISSIONS = Object.freeze([
  "fumbleRecoveries", "touchdowns", "safeties", "blockedKicks",
  "turnoverReturnYards", "extraPointReturns",
]);

function parsePayload(row) {
  if (!row?.payload_json) return {};
  try {
    return JSON.parse(row.payload_json);
  } catch {
    return {};
  }
}

function normalizePosition(value) {
  const position = String(value ?? "").toUpperCase();
  if (["DE", "DT", "NT"].includes(position)) return "DL";
  if (["FS", "SS"].includes(position)) return "S";
  if (["ILB", "OLB"].includes(position)) return "LB";
  return position;
}

function identityKey(name, team) {
  return `${String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")}:${String(team ?? "").toUpperCase()}`;
}

function hasFiniteProjection(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function requireObservedAt(snapshot, label) {
  const observedAt = snapshot?.observedAt;
  if (!observedAt || !Number.isFinite(Date.parse(observedAt))) {
    throw new Error(`${label}.observedAt must be an ISO date`);
  }
  return observedAt;
}

function flattenYahooRows(offenseSnapshot, specialistSnapshot, eligibilitySnapshot = null) {
  const byId = new Map();
  const filterMembership = new Map();
  const add = (row, filter) => {
    if (!row?.yahooId) return;
    const yahooId = String(row.yahooId);
    if (!byId.has(yahooId)) {
      byId.set(yahooId, { ...row, yahooId });
    }
    const filters = filterMembership.get(yahooId) ?? new Set();
    filters.add(filter);
    filterMembership.set(yahooId, filters);
  };
  for (const row of offenseSnapshot?.players ?? []) add(row, "O");
  for (const [filter, rows] of Object.entries(specialistSnapshot?.positions ?? {})) {
    for (const row of rows) add(row, filter);
  }
  for (const row of eligibilitySnapshot?.players ?? []) add({ ...row, yahooProjectedPoints: null }, eligibilitySnapshot.positionFilter ?? "ELIGIBILITY");
  return {
    rows: [...byId.values()],
    filterMembership: new Map(
      [...filterMembership].map(([playerId, filters]) => [playerId, [...filters].sort()]),
    ),
  };
}

function buildSleeperByYahooId(sleeperPlayers, baselineRows, yahooRows) {
  const byYahooId = new Map();
  const yahooIdsByIdentity = new Map();
  for (const row of yahooRows ?? []) {
    const key = identityKey(row.name, row.team);
    const ids = yahooIdsByIdentity.get(key) ?? new Set();
    ids.add(String(row.yahooId));
    yahooIdsByIdentity.set(key, ids);
  }
  const yahooBySleeperId = new Map();
  for (const row of baselineRows ?? []) {
    if (!row?.sleeper_id) continue;
    const identityIds = yahooIdsByIdentity.get(identityKey(row.name, row.team));
    const yahooId = row.yahoo_id || (identityIds?.size === 1 ? [...identityIds][0] : null);
    if (yahooId) yahooBySleeperId.set(String(row.sleeper_id), String(yahooId));
  }
  for (const [recordId, player] of Object.entries(sleeperPlayers ?? {})) {
    const yahooId = player?.yahoo_id ?? yahooBySleeperId.get(String(player?.player_id ?? recordId));
    if (yahooId !== null && yahooId !== undefined) byYahooId.set(String(yahooId), player);
  }
  return byYahooId;
}

export function assembleV5Board({
  baselineRows,
  offenseSnapshot,
  specialistSnapshot,
  sleeperPlayers,
  eligibilitySnapshot = null,
  asOf,
  sleeperObservedAt,
  externalInjuryReports = [],
  projectionSnapshots = [],
  survivalCalibration = null,
  replacementRoster = { teamCount: 12, rosterSlots: LEAGUE_STARTER_SLOTS },
}) {
  const offenseObservedAt = requireObservedAt(offenseSnapshot, "offenseSnapshot");
  const specialistObservedAt = requireObservedAt(specialistSnapshot, "specialistSnapshot");
  const eligibilityObservedAt = eligibilitySnapshot
    ? requireObservedAt(eligibilitySnapshot, "eligibilitySnapshot")
    : null;
  const baselineByYahooId = new Map(
    baselineRows
      .filter((row) => row.yahoo_id)
      .map((row) => [String(row.yahoo_id), { ...row, payload: parsePayload(row) }]),
  );
  const baselineByIdentity = new Map(
    baselineRows
      .filter((row) => row.name && row.team)
      .map((row) => [identityKey(row.name, row.team), { ...row, payload: parsePayload(row) }]),
  );
  const playerIdByIdentity = new Map();
  const ambiguousIdentities = new Set();
  const { rows: yahooRows, filterMembership } = flattenYahooRows(
    offenseSnapshot,
    specialistSnapshot,
    eligibilitySnapshot,
  );
  const eligibilityByYahooId = new Map(
    (eligibilitySnapshot?.players ?? []).map((player) => [String(player.yahooId), player]),
  );
  const sleeperByYahooId = buildSleeperByYahooId(sleeperPlayers, baselineRows, yahooRows);
  const offenseIds = new Set((offenseSnapshot.players ?? []).map((player) => String(player.yahooId)));
  const specialistIds = new Set(
    Object.values(specialistSnapshot.positions ?? {}).flat().map((player) => String(player.yahooId)),
  );
  const offenseIdentities = new Set((offenseSnapshot.players ?? []).map((player) => identityKey(player.name, player.team)));
  const splitDualRoleIdentities = new Set(
    Object.values(specialistSnapshot.positions ?? {}).flat()
      .map((player) => identityKey(player.name, player.team))
      .filter((identity) => offenseIdentities.has(identity)),
  );

  const baselineForYahooRow = (row) => baselineByYahooId.get(String(row.yahooId)) ??
    baselineByIdentity.get(identityKey(row.name, row.team));

  const players = yahooRows.map((row) => {
    const baseline = baselineForYahooRow(row);
    const observedEligibility = eligibilityByYahooId.get(String(row.yahooId));
    const yahooFilters = filterMembership.get(String(row.yahooId)) ?? [];
    const splitHunter = String(row.name ?? "").toLowerCase() === "travis hunter";
    const filterPosition = ["K", "DEF", "LB", "CB", "DB", "D"].find((candidate) => yahooFilters.includes(candidate));
    const rowPosition = normalizePosition(row.position);
    const position = normalizePosition(
      !yahooFilters.includes("O") && ["DL", "LB", "DB", "CB", "S"].includes(rowPosition)
        ? rowPosition
        : !yahooFilters.includes("O") && filterPosition
          ? filterPosition === "D" ? "DL" : filterPosition
          : row.position || baseline?.position || (splitHunter ? (offenseIds.has(String(row.yahooId)) ? "WR" : "CB") : null),
    );
    const specialistPosition = baseline?.payload?.specialist_qualified
      ? normalizePosition(baseline.payload.specialist?.draft_position)
      : null;
    const eligible = [...new Set([
      ...(observedEligibility?.eligible ?? []),
      ...(baseline?.payload?.eligible ?? []),
      position,
      specialistPosition,
    ].map(normalizePosition).filter(Boolean))];
    const player = {
      playerId: String(row.yahooId),
      yahooId: String(row.yahooId),
      gsisId: baseline?.gsis_id || null,
      sleeperId: baseline?.sleeper_id || null,
      name: baseline?.name || row.name,
      team: baseline?.team || row.team || (splitHunter ? "JAX" : null),
      position,
      specialistPosition,
      yahooPosition: String(row.position ?? position).toUpperCase(),
      yahooEligibilityFilters: yahooFilters,
      eligible,
      bye: row.bye,
      yahooPreseasonRank: row.yahooPreseasonRank,
      yahooRosteredPercent: row.rosteredPercent,
      marketAdp: baseline?.adp ?? null,
      marketAdpLow: baseline?.adp_low ?? null,
      marketAdpHigh: baseline?.adp_high ?? null,
      marketAdpSamples: baseline?.payload?.adp_samples ?? null,
    };
    const identity = identityKey(player.name, player.team);
    const existingId = playerIdByIdentity.get(identity);
    if (existingId && existingId !== player.playerId) {
      playerIdByIdentity.delete(identity);
      ambiguousIdentities.add(identity);
    } else if (!ambiguousIdentities.has(identity)) {
      playerIdByIdentity.set(identity, player.playerId);
    }
    return player;
  });

  const yahooOffenseSource = {
    sourceId: "yahoo-season-projection",
    family: "yahoo",
    maxAgeHours: 6,
    updatedAt: offenseObservedAt,
    weight: 1,
    projectionGames: 17,
    rows: yahooRows
      .filter((row) => offenseIds.has(String(row.yahooId)))
      .filter((row) => hasFiniteProjection(row.yahooProjectedPoints))
      .map((row) => ({ playerId: String(row.yahooId), leaguePoints: row.yahooProjectedPoints })),
  };
  const yahooSpecialistSource = {
    sourceId: "yahoo-specialist-season-projection",
    family: "yahoo",
    maxAgeHours: 6,
    updatedAt: specialistObservedAt,
    weight: 1,
    projectionGames: 17,
    rows: yahooRows
      .filter((row) => !offenseIds.has(String(row.yahooId)) && specialistIds.has(String(row.yahooId)))
      .filter((row) => hasFiniteProjection(row.yahooProjectedPoints))
      .map((row) => ({ playerId: String(row.yahooId), leaguePoints: row.yahooProjectedPoints })),
  };
  const registryById = new Map(FREE_SOURCE_REGISTRY.map((source) => [source.id, source]));
  const projectionHealth = validateSourceSnapshot(projectionSnapshots.map((snapshot) => snapshot.manifest), asOf);
  const externalProjectionSources = projectionSnapshots
    .filter((snapshot) => snapshot.manifest.productionEligible !== false)
    .map((snapshot) => {
    const index = projectionSnapshots.indexOf(snapshot);
    const policy = registryById.get(snapshot.manifest.sourceId);
    if (policy?.evidenceKind !== "raw_stat_projection") {
      throw new Error(`${snapshot.manifest.sourceId} cannot count as raw-stat projection evidence`);
    }
    return {
      sourceId: snapshot.manifest.sourceId,
      family: policy.sourceFamily,
      maxAgeHours: policy.maximumRefreshHours,
      updatedAt: snapshot.manifest.sourceAsOf,
      freshOverride: projectionHealth[index]?.fresh === true,
      weight: 1,
      inputRows: snapshot.rows.length,
      rows: snapshot.rows
        .filter((row) => ["QB", "RB", "WR", "TE", "K", "DL", "LB", "DB", "CB", "S"].includes(normalizePosition(row.position)))
        .filter((row) => !hasFiniteProjection(row.projectionGames) || Number(row.projectionGames) > 0)
        .map((row) => ({
          ...row,
          playerId: row.playerId ?? null,
          acceptedOmissions: row.scoringKind === "idp"
            ? ACCEPTED_IDP_OMISSIONS
            : row.scoringKind === "offense"
              ? ACCEPTED_OFFENSE_OMISSIONS
              : [],
        }))
        .filter((row) => row.playerId),
    };
  });

  const projectionBoard = buildPlayerBoard({
    players,
    sources: [yahooOffenseSource, yahooSpecialistSource, ...externalProjectionSources],
    replacementRanks: LEAGUE_REPLACEMENT_RANKS,
    asOf,
    evidencePolicy: (player) => ({
      minimumFreshFamilies: ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "CB", "S"].includes(player.position) ? 2 : 1,
      requiredFamilies: ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "CB", "S"].includes(player.position) ? ["yahoo"] : [],
    }),
    replacementRoster,
    idpCalibration: survivalCalibration?.idpRanking ?? null,
  });

  const reports = Array.from(externalInjuryReports ?? []);
  for (const yahoo of yahooRows) {
    const yahooObservedAt = offenseIds.has(String(yahoo.yahooId))
      ? offenseObservedAt
      : specialistIds.has(String(yahoo.yahooId))
        ? specialistObservedAt
        : eligibilityObservedAt;
    reports.push({
      playerId: String(yahoo.yahooId),
      sourceId: "yahoo-player-list",
      sourceKind: "yahoo",
      observedAt: yahooObservedAt,
      status: YAHOO_STATUS[yahoo.injuryStatus] ?? (yahoo.injuryStatus ? "UNKNOWN" : "CLEAR"),
      note: yahoo.injuryStatus ? `Yahoo marker ${yahoo.injuryStatus}` : null,
    });
    const sleeper = sleeperByYahooId.get(String(yahoo.yahooId));
    if (sleeper) {
      reports.push({
        playerId: String(yahoo.yahooId),
        sourceId: "sleeper-player-map",
        sourceKind: "sleeper",
        observedAt: sleeperObservedAt,
        status: sleeper.injury_status || (sleeper.status === "Active" ? "ACTIVE" : "UNKNOWN"),
        bodyPart: sleeper.injury_body_part || null,
        practice: sleeper.practice_participation || null,
      });
    }
  }
  const injuryBoard = compileInjuryBoard({
    reports,
    asOf,
    maxAgeHoursBySourceKind: { yahoo: 6, sleeper: 24, nfl_official: 24, team_official: 24 },
    expectedPlayerIds: yahooRows.map((player) => String(player.yahooId)),
  });
  const injuryByPlayer = new Map(injuryBoard.players.map((player) => [player.playerId, player]));

  const combined = projectionBoard.players.map((player) => {
    const injury = injuryByPlayer.get(player.playerId) ?? {
      status: "UNKNOWN",
      draftAction: "REVIEW",
      executable: false,
      blockReason: "no injury evidence",
      conflict: false,
      evidence: [],
    };
    const dualRole = ["41787", "99001", "99002"].includes(String(player.yahooId)) ||
      String(player.name ?? "").toLowerCase() === "travis hunter" ||
      splitDualRoleIdentities.has(identityKey(player.name, player.team)) ||
      (player.eligible.some((position) => ["QB", "RB", "WR", "TE"].includes(position)) &&
      player.eligible.some((position) => ["DL", "LB", "DB", "CB", "S", "D"].includes(position)));
    const expectedGamesThroughWeek17 = expectedGamesFromInjury(injury);
    const projectionGames = Number(player.expectedGames);
    const hasOutcomeRate = Number.isFinite(projectionGames) && projectionGames > 0;
    const rawWeeklyProfile = Number.isFinite(Number(player.perGamePoints)) && expectedGamesThroughWeek17 != null
      ? buildWeeklyProjectionProfile({
          perGamePoints: Number(player.perGamePoints),
          byeWeek: player.bye,
          expectedGamesThroughWeek17,
          unavailableWeeks: injury.unavailableWeeks,
          perGameOutcomeLow: hasOutcomeRate && hasFiniteProjection(player.outcomeLow) ? Number(player.outcomeLow) / projectionGames : null,
          perGameOutcomeHigh: hasOutcomeRate && hasFiniteProjection(player.outcomeHigh) ? Number(player.outcomeHigh) / projectionGames : null,
        })
      : null;
    const weeklyProfile = Number.isFinite(Number(player.rankingPerGamePoints)) && expectedGamesThroughWeek17 != null
      ? buildWeeklyProjectionProfile({
          perGamePoints: Number(player.rankingPerGamePoints),
          byeWeek: player.bye,
          expectedGamesThroughWeek17,
          unavailableWeeks: injury.unavailableWeeks,
          perGameOutcomeLow: hasOutcomeRate && hasFiniteProjection(player.rankingOutcomeLow) ? Number(player.rankingOutcomeLow) / projectionGames : null,
          perGameOutcomeHigh: hasOutcomeRate && hasFiniteProjection(player.rankingOutcomeHigh) ? Number(player.rankingOutcomeHigh) / projectionGames : null,
        })
      : null;
    const projectionUsable = Number.isFinite(Number(player.rankingPoints)) && weeklyProfile != null;
    const offensePosition = player.eligible.some((position) => ["QB", "RB", "WR", "TE"].includes(position));
    const specialistPosition = player.eligible.some((position) => ["K", "DEF", "DL", "LB", "DB", "CB", "S", "D"].includes(position));
    const yahooOnlyLateSpecialist = !offensePosition && player.eligible.some((position) => ["K", "DEF"].includes(position)) && player.sourceFamilies.includes("yahoo") && player.scorableSourceFamilyCount === 1;
    const executable = projectionUsable && injury.executable && (player.executable || yahooOnlyLateSpecialist);
    const manualEligible = projectionUsable && injury.executable;
    const validationStatus = dualRole
      ? "DUAL_ROLE_SCORING_UNVERIFIED"
      : yahooOnlyLateSpecialist
          ? "UNVALIDATED_SPECIALIST_PROJECTION"
          : player.executable
            ? "EXECUTABLE"
            : player.sourceFamilyCount === 1
              ? "UNVALIDATED_SINGLE_SOURCE_PROJECTION"
              : "NO_FRESH_PROJECTION";
    return {
      ...player,
      injury,
      expectedGamesThroughWeek17,
      weeklyPoints: weeklyProfile?.weeklyPoints ?? null,
      rawWeeklyPoints: rawWeeklyProfile?.weeklyPoints ?? null,
      weeklyAvailability: weeklyProfile?.availabilityProbability ?? null,
      weeklyOutcomeLow: weeklyProfile?.weeklyOutcomeLow ?? null,
      weeklyOutcomeHigh: weeklyProfile?.weeklyOutcomeHigh ?? null,
      weeklyUncertaintyStatus: weeklyProfile?.uncertaintyStatus ?? "WEEKLY_PROFILE_WITHHELD",
      executable,
      blockReason: executable ? null : [player.blockReason, injury.blockReason].filter(Boolean).join("; "),
      automaticEligible: executable && !dualRole,
      manualEligible,
      validationStatus,
      draftPhase: "UNIFIED",
    };
  });

  const offense = combined
    .filter((player) => player.eligible.some((position) => ["QB", "RB", "WR", "TE"].includes(position)))
    .sort((left, right) => (right.vorp ?? -Infinity) - (left.vorp ?? -Infinity))
    .map((player, index) => ({ ...player, draftBoardRank: player.vorp === null ? null : index + 1 }));
  const specialists = Object.fromEntries(
    ["K", "DEF", "DL", "LB", "DB"].map((position) => [
      position,
      combined
        .filter((player) => {
          if (position === "DL") return player.eligible.some((eligible) => ["DL", "D"].includes(eligible));
          if (position === "DB") return player.eligible.some((eligible) => ["DB", "CB", "S"].includes(eligible));
          return player.eligible.includes(position);
        })
        .sort((left, right) => {
          if (["K", "DEF"].includes(position)) {
            const leftRank = hasFiniteProjection(left.yahooPreseasonRank) ? Number(left.yahooPreseasonRank) : Infinity;
            const rightRank = hasFiniteProjection(right.yahooPreseasonRank) ? Number(right.yahooPreseasonRank) : Infinity;
            return leftRank - rightRank || (right.consensusPoints ?? -Infinity) - (left.consensusPoints ?? -Infinity);
          }
          return (right.rankingPoints ?? -Infinity) - (left.rankingPoints ?? -Infinity);
        })
        .map((player, index) => ({ ...player, specialistRank: player.rankingPoints === null ? null : index + 1 })),
    ]),
  );
  const projectionGapByPosition = Object.fromEntries(
    ["QB", "RB", "WR", "TE"].map((position) => {
      const gaps = combined
        .filter((player) => player.position === position)
        .map((player) => {
          const yahoo = player.sourceFamilyPerGamePoints?.yahoo;
          const external = Object.entries(player.sourceFamilyPerGamePoints ?? {})
            .filter(([family]) => family !== "yahoo")
            .map(([, points]) => Number(points));
          return Number.isFinite(Number(yahoo)) && external.length
            ? Number(yahoo) - external.reduce((sum, value) => sum + value, 0) / external.length
            : null;
        })
        .filter(Number.isFinite);
      return [position, { sampleCount: gaps.length, medianYahooMinusExternalPerGame: median(gaps) }];
    }),
  );

  return Object.freeze({
    schemaVersion: 2,
    generatedAt: asOf,
    leagueId: "420010",
    scoringModel: "2-minute-drillers-2026",
    scoringSchemaHash: SCORING_SCHEMA_HASH,
    replacementRanks: LEAGUE_REPLACEMENT_RANKS,
    replacementBySlot: projectionBoard.replacementBySlot,
    rawReplacementBySlot: projectionBoard.rawReplacementBySlot,
    replacementRankBasis: "joint maximum-weight allocation of every 2 Minute Drillers starter slot",
    specialistRankingBasis: { K: "Yahoo preseason rank; Razzball raw-stat total is a diagnostic challenger", DEF: "Yahoo preseason rank; season aggregates cannot reconstruct weekly scoring", DL: "global-gated IDP decision score, otherwise exact-scored source-family consensus", LB: "global-gated IDP decision score, otherwise exact-scored source-family consensus", DB: "global-gated IDP decision score, otherwise exact-scored source-family consensus" },
    sources: projectionBoard.sourceReceipts,
    snapshotReceipts: {
      yahooOffenseObservedAt: offenseObservedAt,
      yahooSpecialistObservedAt: specialistObservedAt,
      yahooEligibilityObservedAt: eligibilityObservedAt,
    },
    injuryWatchlist: buildDraftWatchlist(injuryBoard),
    injuryCoverage: injuryBoard.coverage,
    injuryFreshnessPolicy: injuryBoard.freshnessPolicyHours,
    projectionModel: {
      sourceNormalization: "Yahoo league projection plus independent raw-stat projection families scored locally; market, identity, injury, and history never count as projection evidence",
      fantasyWeeks: "1-17",
      weeklyBonuses: "weekly events; never season-thresholded",
      outcomeIntervals: "calibrated inputs only; source disagreement remains diagnostic",
      idpRanking: survivalCalibration?.idpRanking
        ? {
            status: survivalCalibration.idpRanking.status,
            globalGate: survivalCalibration.idpRanking.globalGate,
            preregistrationHash: survivalCalibration.idpRanking.preregistrationHash,
          }
        : { status: "DIAGNOSTIC_ONLY_CALIBRATION_UNAVAILABLE", globalGate: { pass: false }, preregistrationHash: null },
      sourceGapByPosition: projectionGapByPosition,
    },
    survivalCalibration,
    eligibilityEvidence: specialistSnapshot.eligibilityEvidence ?? {},
    identityEvidence: { ambiguousNameTeamKeys: [...ambiguousIdentities].sort() },
    players: combined,
    boards: { unified: combined, offense, specialists },
  });
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((entry) => {
      const [key, ...value] = entry.split("=");
      return [key.replace(/^--/, ""), value.join("=")];
    }),
  );
  const required = ["baseline", "offense", "specialists", "sleeper", "output", "as-of", "sleeper-observed-at"];
  for (const key of required) {
    if (!args[key]) throw new Error(`missing --${key}=...`);
  }
  const [baselineRows, offenseSnapshot, specialistSnapshot, sleeperPlayers, eligibilitySnapshot, externalInjuryReports, survivalCalibration, projectionSnapshots] = await Promise.all([
    readFile(args.baseline, "utf8").then(JSON.parse),
    readFile(args.offense, "utf8").then(JSON.parse),
    readFile(args.specialists, "utf8").then(JSON.parse),
    readFile(args.sleeper, "utf8").then(JSON.parse),
    args.eligibility ? readFile(args.eligibility, "utf8").then(JSON.parse) : null,
    args.injuries ? readFile(args.injuries, "utf8").then(JSON.parse) : [],
    args.survival ? readFile(args.survival, "utf8").then(JSON.parse) : null,
    args.projections ? readFile(args.projections, "utf8").then(JSON.parse).then((value) => Array.isArray(value) ? value : [value]) : [],
  ]);
  const board = assembleV5Board({
    baselineRows,
    offenseSnapshot,
    specialistSnapshot,
    sleeperPlayers,
    eligibilitySnapshot,
    asOf: args["as-of"],
    sleeperObservedAt: args["sleeper-observed-at"],
    externalInjuryReports,
    survivalCalibration,
    projectionSnapshots,
  });
  await writeFile(args.output, `${JSON.stringify(board, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({ output: args.output, players: board.players.length, executable: board.players.filter((player) => player.automaticEligible).length })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
