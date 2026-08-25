const STATUS_PRIORITY = Object.freeze({
  IR: 6,
  PUP: 6,
  NFI: 6,
  SUSPENDED: 5,
  OUT: 5,
  DOUBTFUL: 4,
  HOLDOUT: 3,
  QUESTIONABLE: 3,
  ROLE_UNCERTAIN: 2,
  LIMITED: 2,
  FULL: 1,
  ACTIVE: 1,
  CLEAR: 0,
  UNKNOWN: 0,
});

const SOURCE_PRIORITY = Object.freeze({
  nfl_official: 4,
  team_official: 3,
  yahoo: 2,
  sleeper: 1,
});

function normalizeStatus(value) {
  const status = String(value ?? "UNKNOWN")
    .trim()
    .toUpperCase()
    .replaceAll("/", "_")
    .replaceAll(" ", "_");
  if (status === "RESERVE_INJURED") return "IR";
  if (status === "PHYSICALLY_UNABLE_TO_PERFORM") return "PUP";
  if (status === "NON_FOOTBALL_INJURY") return "NFI";
  if (status === "SUSPENSION") return "SUSPENDED";
  if (["HOLD_OUT", "CONTRACT_HOLDOUT"].includes(status)) return "HOLDOUT";
  if (["ROLE_CHANGE", "ROLE_RISK"].includes(status)) return "ROLE_UNCERTAIN";
  if (status === "DNP" || status === "DID_NOT_PRACTICE") return "QUESTIONABLE";
  return Object.hasOwn(STATUS_PRIORITY, status) ? status : "UNKNOWN";
}

function parseTimestamp(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be an ISO date`);
  return timestamp;
}

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function normalizeUnavailableWeeks(value, sourceId) {
  const weeks = [...new Set(Array.from(value ?? [], Number))].sort((left, right) => left - right);
  if (weeks.some((week) => !Number.isInteger(week) || week < 1 || week > 17)) {
    throw new Error(`report ${sourceId} unavailableWeeks must contain weeks 1 through 17`);
  }
  return weeks;
}

export function compileInjuryBoard({ reports, asOf, maxAgeHours = 36, expectedPlayerIds = [] }) {
  const now = parseTimestamp(asOf, "asOf");
  if (!Array.isArray(reports)) throw new Error("reports must be an array");
  const grouped = new Map();

  for (const report of reports) {
    const playerId = String(report?.playerId ?? "").trim();
    const sourceId = String(report?.sourceId ?? "").trim();
    const sourceKind = String(report?.sourceKind ?? "").trim();
    if (!playerId || !sourceId || !Object.hasOwn(SOURCE_PRIORITY, sourceKind)) {
      throw new Error("every injury report requires playerId, sourceId, and a supported sourceKind");
    }
    const observedAt = parseTimestamp(report.observedAt, `report ${sourceId} observedAt`);
    const ageHours = (now - observedAt) / 3_600_000;
    const normalized = {
      playerId,
      sourceId,
      sourceKind,
      sourcePriority: SOURCE_PRIORITY[sourceKind],
      observedAt: report.observedAt,
      ageHours,
      fresh: ageHours >= 0 && ageHours <= maxAgeHours,
      status: normalizeStatus(report.status),
      bodyPart: report.bodyPart ? String(report.bodyPart) : null,
      practice: report.practice ? String(report.practice) : null,
      reportedReturn: report.reportedReturn ? String(report.reportedReturn) : null,
      expectedGamesThroughWeek17: finite(report.expectedGamesThroughWeek17)
        ? Number(report.expectedGamesThroughWeek17)
        : null,
      unavailableWeeks: normalizeUnavailableWeeks(report.unavailableWeeks, sourceId),
      note: report.note ? String(report.note) : null,
    };
    if (normalized.expectedGamesThroughWeek17 != null &&
        (normalized.expectedGamesThroughWeek17 < 0 || normalized.expectedGamesThroughWeek17 > 16)) {
      throw new Error(`report ${sourceId} expectedGamesThroughWeek17 must be between 0 and 16`);
    }
    const playerReports = grouped.get(playerId) ?? [];
    playerReports.push(normalized);
    grouped.set(playerId, playerReports);
  }

  const players = [...grouped.entries()].map(([playerId, playerReports]) => {
    const freshReports = playerReports.filter((report) => report.fresh);
    const ordered = [...freshReports].sort(
      (left, right) =>
        right.sourcePriority - left.sourcePriority ||
        Date.parse(right.observedAt) - Date.parse(left.observedAt),
    );
    const primary = ordered[0] ?? null;
    const freshStatuses = [...new Set(freshReports.map((report) => report.status))];
    const severityValues = freshStatuses.map((status) => STATUS_PRIORITY[status]);
    const statusConflict =
      severityValues.length > 1 && Math.max(...severityValues) - Math.min(...severityValues) >= 2;
    const gamesValues = freshReports
      .map((report) => report.expectedGamesThroughWeek17)
      .filter((value) => value != null);
    const availabilityConflict = gamesValues.length > 1 && Math.max(...gamesValues) - Math.min(...gamesValues) > 1;
    const conflict = statusConflict || availabilityConflict;
    const worstStatus = freshStatuses.sort(
      (left, right) => STATUS_PRIORITY[right] - STATUS_PRIORITY[left],
    )[0] ?? "UNKNOWN";

    let draftAction = "REVIEW";
    let blockReason = null;
    if (freshReports.length === 0) {
      blockReason = "no fresh injury evidence";
    } else if (conflict) {
      blockReason = "material source conflict";
    } else if (["IR", "PUP", "NFI", "OUT"].includes(worstStatus)) {
      draftAction = "EXCLUDE";
      blockReason = `status ${worstStatus}`;
    } else if (worstStatus === "SUSPENDED") {
      const hasReportedReturn = freshReports.some((report) => report.status === "SUSPENDED" && report.reportedReturn);
      if (hasReportedReturn) blockReason = "manual availability decision required for SUSPENDED";
      else {
        draftAction = "EXCLUDE";
        blockReason = "status SUSPENDED without a reported return";
      }
    } else if (["DOUBTFUL", "HOLDOUT", "QUESTIONABLE", "ROLE_UNCERTAIN", "LIMITED"].includes(worstStatus)) {
      blockReason = `manual health decision required for ${worstStatus}`;
    } else if (["ACTIVE", "FULL", "CLEAR"].includes(worstStatus)) {
      draftAction = "CLEAR";
    } else {
      blockReason = `manual health decision required for ${worstStatus}`;
    }

    return {
      playerId,
      status: worstStatus,
      draftAction,
      executable: draftAction === "CLEAR",
      blockReason,
      conflict,
      primarySourceId: primary?.sourceId ?? null,
      freshestAt: ordered[0]?.observedAt ?? null,
      bodyParts: [...new Set(freshReports.map((report) => report.bodyPart).filter(Boolean))],
      reportedReturns: [...new Set(freshReports.map((report) => report.reportedReturn).filter(Boolean))],
      expectedGamesThroughWeek17: conflict
        ? null
        : ordered.find((report) => report.expectedGamesThroughWeek17 != null)?.expectedGamesThroughWeek17 ?? null,
      unavailableWeeks: conflict
        ? []
        : ordered.find((report) => report.unavailableWeeks.length)?.unavailableWeeks ?? [],
      availabilityStatus: conflict
        ? "CONFLICT"
        : ordered.some((report) => report.expectedGamesThroughWeek17 != null || report.unavailableWeeks.length)
          ? "EXPLICIT"
          : "UNSPECIFIED",
      evidence: playerReports.sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt)),
    };
  });

  const expectedIds = [...new Set(Array.from(expectedPlayerIds ?? [], String).filter(Boolean))];
  const present = new Set(players.map((player) => player.playerId));
  for (const playerId of expectedIds) {
    if (present.has(playerId)) continue;
    players.push({
      playerId,
      status: "UNKNOWN",
      draftAction: "REVIEW",
      executable: false,
      blockReason: "no injury evidence",
      conflict: false,
      primarySourceId: null,
      freshestAt: null,
      bodyParts: [],
      reportedReturns: [],
      expectedGamesThroughWeek17: null,
      unavailableWeeks: [],
      availabilityStatus: "UNSPECIFIED",
      evidence: [],
    });
  }

  const expectedSet = new Set(expectedIds);
  const freshChecked = new Set(players
    .filter((player) => player.evidence.some((report) => report.fresh))
    .map((player) => player.playerId)
    .filter((playerId) => expectedSet.size === 0 || expectedSet.has(playerId)));
  const sourceKinds = Object.keys(SOURCE_PRIORITY);
  const bySourceKind = Object.fromEntries(sourceKinds.map((sourceKind) => {
    const checked = new Set();
    for (const player of players) {
      if (player.evidence.some((report) => report.fresh && report.sourceKind === sourceKind)) checked.add(player.playerId);
    }
    return [sourceKind, {
      checkedPlayers: expectedSet.size ? [...checked].filter((playerId) => expectedSet.has(playerId)).length : checked.size,
      freshReports: players.reduce((sum, player) => sum + player.evidence.filter((report) => report.fresh && report.sourceKind === sourceKind).length, 0),
    }];
  }));
  const uncheckedPlayerIds = expectedIds.filter((playerId) => !freshChecked.has(playerId));

  return Object.freeze({
    asOf,
    maxAgeHours,
    coverage: {
      expectedPlayers: expectedIds.length,
      checkedPlayers: freshChecked.size,
      complete: expectedIds.length === 0 || uncheckedPlayerIds.length === 0,
      uncheckedPlayerIds,
      bySourceKind,
    },
    players,
  });
}

export function buildDraftWatchlist(injuryBoard) {
  const players = injuryBoard?.players;
  if (!Array.isArray(players)) throw new Error("injuryBoard.players must be an array");
  return players
    .filter((player) => player.draftAction !== "CLEAR")
    .map((player) => ({
      yahooId: String(player.playerId),
      status: player.status,
      draftAction: player.draftAction,
      blockReason: player.blockReason,
      freshestAt: player.freshestAt,
      primarySourceId: player.primarySourceId,
      expectedGamesThroughWeek17: player.expectedGamesThroughWeek17,
      unavailableWeeks: player.unavailableWeeks,
    }));
}

export { SOURCE_PRIORITY, STATUS_PRIORITY };
