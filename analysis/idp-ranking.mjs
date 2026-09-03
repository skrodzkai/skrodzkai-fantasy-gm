import { createHash } from "node:crypto";

export const IDP_POINT_BUCKET_FIELDS = Object.freeze({
  tackleFloor: Object.freeze(["soloTackles", "assistedTackles"]),
  stableDisruption: Object.freeze(["sacks", "passesDefended", "tacklesForLoss"]),
  volatileSplash: Object.freeze([
    "interceptions", "forcedFumbles", "fumbleRecoveries", "touchdowns", "safeties",
    "blockedKicks", "turnoverReturnYards", "extraPointReturns",
  ]),
});

const IDP_POSITIONS = new Set(["DL", "LB", "DB", "CB", "S"]);

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

export function physicalIdpPosition(value) {
  const position = String(value ?? "").toUpperCase();
  if (["DE", "DT", "NT", "EDGE", "D"].includes(position)) return "DL";
  if (["CB", "S", "FS", "SS"].includes(position)) return "DB";
  if (["ILB", "MLB", "OLB"].includes(position)) return "LB";
  return position;
}

export function validateIdpBucketCoverage(scoring) {
  const assignments = Object.values(IDP_POINT_BUCKET_FIELDS).flat();
  const scoringFields = Object.keys(scoring).sort();
  const duplicates = assignments.filter((field, index) => assignments.indexOf(field) !== index);
  const missing = scoringFields.filter((field) => !assignments.includes(field));
  const unknown = assignments.filter((field) => !Object.hasOwn(scoring, field));
  if (duplicates.length || missing.length || unknown.length) {
    throw new Error(`IDP bucket coverage mismatch: duplicates=${[...new Set(duplicates)].join(",")} missing=${missing.join(",")} unknown=${unknown.join(",")}`);
  }
  return true;
}

export function scoreIdpBuckets(stats, scoring) {
  validateIdpBucketCoverage(scoring);
  return Object.fromEntries(Object.entries(IDP_POINT_BUCKET_FIELDS).map(([bucket, fields]) => [
    bucket,
    fields.reduce((sum, field) => sum + (finite(stats?.[field]) ? Number(stats[field]) : 0) * Number(scoring[field]), 0),
  ]));
}

export function buildIdpSourceProfile({ stats, scoring, omittedScoringCategories = [], sourceId = null, projectionGames = null }) {
  validateIdpBucketCoverage(scoring);
  const omitted = new Set(omittedScoringCategories.map(String));
  const missingFields = Object.keys(scoring).filter((field) => !finite(stats?.[field]) && !omitted.has(field));
  if (!stats || typeof stats !== "object" || missingFields.length) {
    return {
      status: "INCOMPLETE_RAW_STAT_PROFILE",
      sourceId,
      missingFields,
      omittedScoringCategories: [...omitted].sort(),
    };
  }
  const bucketPoints = scoreIdpBuckets(stats, scoring);
  const totalPoints = Object.values(bucketPoints).reduce((sum, value) => sum + value, 0);
  if (!(totalPoints > 0)) {
    return {
      status: "NONPOSITIVE_RAW_STAT_PROFILE",
      sourceId,
      missingFields: [],
      omittedScoringCategories: [...omitted].sort(),
      bucketPoints,
      totalPoints,
    };
  }
  const totalTackles = (finite(stats.soloTackles) ? Number(stats.soloTackles) : 0) +
    (finite(stats.assistedTackles) ? Number(stats.assistedTackles) : 0);
  const projectedSnaps = finite(stats.snaps) && Number(stats.snaps) > 0 ? Number(stats.snaps) : null;
  const projectedGames = finite(projectionGames) && Number(projectionGames) > 0 ? Number(projectionGames) : null;
  return {
    status: "AVAILABLE",
    sourceId,
    missingFields: [],
    omittedScoringCategories: [...omitted].sort(),
    bucketPoints,
    bucketShares: Object.fromEntries(Object.entries(bucketPoints).map(([bucket, points]) => [bucket, points / totalPoints])),
    totalPoints,
    projectedSnaps,
    projectionGames: projectedGames,
    totalTackles,
    tacklesPer100Snaps: projectedSnaps ? totalTackles / projectedSnaps * 100 : null,
  };
}

export function combineIdpSourceProfiles(profiles) {
  const available = Array.from(profiles ?? []).filter((profile) => profile?.status === "AVAILABLE");
  if (!available.length) {
    return {
      status: "INCOMPLETE_RAW_STAT_PROFILE",
      rawFamilyCount: 0,
      sourceIds: [],
      warnings: ["NO_COMPLETE_INDEPENDENT_RAW_STAT_FAMILY"],
    };
  }
  const rawShares = Object.fromEntries(Object.keys(IDP_POINT_BUCKET_FIELDS).map((bucket) => [
    bucket,
    mean(available.map((profile) => Number(profile.bucketShares[bucket]))),
  ]));
  const shareTotal = Object.values(rawShares).reduce((sum, value) => sum + value, 0);
  const bucketShares = Object.fromEntries(Object.entries(rawShares).map(([bucket, value]) => [bucket, value / shareTotal]));
  const snaps = available.map((profile) => profile.projectedSnaps).filter(finite).map(Number);
  const games = available.map((profile) => profile.projectionGames).filter(finite).map(Number);
  const tackleRates = available.map((profile) => profile.tacklesPer100Snaps).filter(finite).map(Number);
  return {
    status: "AVAILABLE",
    rawFamilyCount: available.length,
    sourceIds: [...new Set(available.flatMap((profile) => profile.sourceIds ?? [profile.sourceId]).filter(Boolean))].sort(),
    bucketShares,
    projectedSnaps: mean(snaps),
    projectionGames: mean(games),
    tacklesPer100Snaps: mean(tackleRates),
    warnings: [],
  };
}

export function idpDecisionScore({ consensusPoints, profile, position, calibration }) {
  const rawPoints = finite(consensusPoints) ? Number(consensusPoints) : null;
  const physicalPosition = physicalIdpPosition(position);
  const positionParameters = calibration?.positionParameters?.[physicalPosition] ?? null;
  const globalPass = calibration?.globalGate?.pass === true;
  if (!IDP_POSITIONS.has(String(position ?? "").toUpperCase()) || rawPoints === null) {
    return { status: "NOT_IDP", points: rawPoints, scale: 1, physicalPosition };
  }
  if (!globalPass || !positionParameters) {
    return {
      status: "DIAGNOSTIC_ONLY_CALIBRATION_GATE_FAILED",
      points: rawPoints,
      scale: 1,
      physicalPosition,
      warning: "IDP_CALIBRATION_GLOBAL_GATE_NOT_PASS",
    };
  }
  if (profile?.status !== "AVAILABLE") {
    return {
      status: "DIAGNOSTIC_ONLY_PROFILE_INCOMPLETE",
      points: rawPoints,
      scale: 1,
      physicalPosition,
      warning: "NO_COMPLETE_INDEPENDENT_RAW_STAT_FAMILY",
    };
  }
  const shares = profile.bucketShares;
  const shareTotal = Object.values(shares).reduce((sum, value) => sum + Number(value), 0);
  if (!(shareTotal > 0)) {
    return {
      status: "DIAGNOSTIC_ONLY_PROFILE_INCOMPLETE",
      points: rawPoints,
      scale: 1,
      physicalPosition,
      warning: "NONPOSITIVE_IDP_COMPONENT_SHARE_TOTAL",
    };
  }
  const componentScale = (
    Number(shares.tackleFloor) + Number(shares.stableDisruption) +
    Number(positionParameters.volatileWeight) * Number(shares.volatileSplash)
  ) / shareTotal;
  const projectedSnapsPerGame = finite(profile.projectedSnaps) && finite(profile.projectionGames) && Number(profile.projectionGames) > 0
    ? Number(profile.projectedSnaps) / Number(profile.projectionGames)
    : null;
  const roleScale = projectedSnapsPerGame && finite(positionParameters.trainingSnapMean) && Number(positionParameters.trainingSnapMean) > 0
    ? clamp(projectedSnapsPerGame / Number(positionParameters.trainingSnapMean), 0.85, 1.15) ** Number(positionParameters.roleExponent)
    : 1;
  const scale = componentScale * roleScale;
  return {
    status: "ACTIVE",
    points: rawPoints * scale,
    scale,
    componentScale,
    roleScale,
    physicalPosition,
    warning: projectedSnapsPerGame ? null : "PROJECTED_SNAPS_UNAVAILABLE_ROLE_SCALE_NEUTRAL",
  };
}

export function idpCalibrationHash(calibration) {
  if (!calibration) return null;
  return createHash("sha256").update(JSON.stringify(calibration)).digest("hex");
}
