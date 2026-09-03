import { createHash } from "node:crypto";

const OFFENSE = new Set(["QB", "RB", "WR", "TE"]);
const IDP = new Set(["DL", "LB", "DB", "CB", "S", "D"]);
const DEFENSIVE_DEPTH_POSITIONS = new Set(["DL", "DE", "DT", "NT", "LB", "ILB", "OLB", "DB", "CB", "S", "FS", "SS"]);
const MARKET_HOSTS = Object.freeze({
  draftkings: "sportsbook.draftkings.com",
  fanduel: "sportsbook.fanduel.com",
});
const MARKET_STATS = Object.freeze({
  season_pass_attempts: "passingAttempts",
  season_pass_completions: "passingCompletions",
  season_pass_yards: "passingYards",
  season_pass_touchdowns: "passingTouchdowns",
  season_interceptions: "interceptions",
  season_rush_attempts: "rushingAttempts",
  season_rush_yards: "rushingYards",
  season_rush_touchdowns: "rushingTouchdowns",
  season_receptions: "receptions",
  season_receiving_yards: "receivingYards",
  season_receiving_touchdowns: "receivingTouchdowns",
});
const TEAM_ALIASES = Object.freeze({ JAC: "JAX", LA: "LAR", WSH: "WAS" });
const ROLE_SOURCES = new Set(["nfl_official", "team_official", "nflverse", "sleeper", "yahoo", "rotoworld-news"]);
const ROLE_SOURCE_HOSTS = Object.freeze({ "rotoworld-news": "www.nbcsports.com" });

function canonicalTeam(value) {
  const team = String(value ?? "").trim().toUpperCase();
  return TEAM_ALIASES[team] ?? team;
}

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function iso(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO date`);
  return new Date(parsed).toISOString();
}

function checkedUrl(value, label, expectedHost = null) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${label} must use https`);
  if (expectedHost && parsed.hostname !== expectedHost) throw new Error(`${label} must use ${expectedHost}`);
  return parsed.toString();
}

export function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error("CSV row has an unterminated quote");
  cells.push(cell);
  return cells;
}

function csvRecords(text) {
  const lines = String(text ?? "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error("CSV input must contain a header and at least one row");
  const header = parseCsvLine(lines[0]);
  const records = [];
  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line);
    if (values.length !== header.length) throw new Error(`CSV row has ${values.length} columns; expected ${header.length}`);
    records.push(Object.fromEntries(header.map((key, index) => [key, values[index]])));
  }
  return records;
}

export function parseNflverseDepthCharts(text) {
  const allRows = csvRecords(text);
  const observedAt = allRows
    .map((row) => iso(row.dt, "depth chart dt"))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  const rows = allRows.filter((row) => iso(row.dt, "depth chart dt") === observedAt);
  return { observedAt, rows };
}

export function parseNflverseRosters(text) {
  const rows = csvRecords(text).filter((row) => Number(row.season) === 2026);
  if (!rows.length) throw new Error("nflverse roster has no 2026 rows");
  return rows;
}

export function parseNflverseSchedule(text) {
  const rows = csvRecords(text)
    .filter((row) => Number(row.season) === 2026 && row.game_type === "REG" && Number(row.week) >= 1 && Number(row.week) <= 4);
  if (rows.length !== 64) throw new Error(`nflverse schedule must contain 64 Weeks 1-4 games; found ${rows.length}`);
  return rows;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function projectionHash(board) {
  const projectionRows = Array.from(board?.players ?? [])
    .map((player) => ({
      yahooId: String(player.yahooId),
      consensusPoints: player.consensusPoints ?? null,
      perGamePoints: player.perGamePoints ?? null,
      weeklyPoints: player.weeklyPoints ?? null,
      sourceIds: player.sourceIds ?? [],
    }))
    .sort((left, right) => left.yahooId.localeCompare(right.yahooId));
  return sha256(JSON.stringify(projectionRows));
}

function sourceReceipt({ sourceId, sourceUrl, sourceAsOf, sourceAsOfBasis, retrievedAt, checkedAt, content }) {
  const observed = iso(sourceAsOf, `${sourceId} sourceAsOf`);
  const retrieved = iso(retrievedAt, `${sourceId} retrievedAt`);
  const checked = iso(checkedAt, `${sourceId} checkedAt`);
  const ageHours = (Date.parse(checked) - Date.parse(observed)) / 3_600_000;
  return {
    sourceId,
    sourceUrl: checkedUrl(sourceUrl, `${sourceId} sourceUrl`),
    sourceAsOf: observed,
    sourceAsOfBasis,
    retrievedAt: retrieved,
    checkedAt: checked,
    ageHours,
    fresh: ageHours >= 0 && ageHours <= 168,
    contentSha256: sha256(content),
  };
}

function topRoleAuditPlayers(board) {
  const offense = Array.from(board?.boards?.offense ?? [])
    .filter((player) => OFFENSE.has(String(player.position).toUpperCase()))
    .sort((left, right) => Number(left.draftBoardRank ?? Infinity) - Number(right.draftBoardRank ?? Infinity))
    .slice(0, 150);
  const seen = new Set();
  const idp = ["DL", "LB", "DB"]
    .flatMap((position) => board?.boards?.specialists?.[position] ?? [])
    .filter((player) => {
      const yahooId = String(player.yahooId);
      if (seen.has(yahooId)) return false;
      seen.add(yahooId);
      return true;
    })
    .sort((left, right) => Number(right.consensusPoints ?? -Infinity) - Number(left.consensusPoints ?? -Infinity))
    .slice(0, 40);
  return { offense, idp, all: [...offense, ...idp] };
}

function rosterMaps(rows) {
  const byYahoo = new Map();
  const byGsis = new Map();
  const byNameTeam = new Map();
  const ambiguousNameTeam = new Set();
  for (const row of rows) {
    if (row.yahoo_id) byYahoo.set(String(row.yahoo_id), row);
    if (row.gsis_id) byGsis.set(String(row.gsis_id), row);
    const key = `${String(row.full_name ?? "").trim().toLowerCase()}|${canonicalTeam(row.team)}`;
    if (key.startsWith("|")) continue;
    if (byNameTeam.has(key)) {
      byNameTeam.delete(key);
      ambiguousNameTeam.add(key);
    } else if (!ambiguousNameTeam.has(key)) {
      byNameTeam.set(key, row);
    }
  }
  return { byYahoo, byGsis, byNameTeam };
}

function depthMap(rows) {
  const byGsis = new Map();
  for (const row of rows) {
    if (!row.gsis_id) continue;
    const values = byGsis.get(String(row.gsis_id)) ?? [];
    values.push(row);
    byGsis.set(String(row.gsis_id), values);
  }
  return byGsis;
}

function selectDepthRow(player, rows = []) {
  const eligibility = new Set([player.position, player.yahooPosition, ...(player.eligible ?? [])].map((value) => String(value ?? "").toUpperCase()));
  const idpEligible = [...eligibility].some((position) => IDP.has(position));
  const relevant = rows.filter((row) => {
    const position = String(row.pos_abb || row.pos_name || "").toUpperCase();
    const group = String(row.pos_grp || "").toUpperCase();
    const defensive = !group.includes("SPECIAL") && (/(^|\s)D($|\s)/.test(group) || DEFENSIVE_DEPTH_POSITIONS.has(position) || /^(L|R)?(DE|DT|CB|OLB)$/.test(position));
    return idpEligible ? defensive : eligibility.has(position);
  });
  return relevant.sort((left, right) => Number(left.pos_rank ?? Infinity) - Number(right.pos_rank ?? Infinity))[0] ?? null;
}

function roleAudit(board, rosters, depthCharts) {
  const targets = topRoleAuditPlayers(board);
  const roster = rosterMaps(rosters);
  const depth = depthMap(depthCharts);
  const byYahooId = new Map();
  for (const player of targets.all) {
    const yahooId = String(player.yahooId);
    const yahooRosterRow = roster.byYahoo.get(yahooId) ?? null;
    const gsisRosterRow = player.gsisId ? roster.byGsis.get(String(player.gsisId)) ?? null : null;
    const exactNameTeamRow = roster.byNameTeam.get(`${String(player.name ?? "").trim().toLowerCase()}|${canonicalTeam(player.team)}`) ?? null;
    const rosterRow = yahooRosterRow ?? gsisRosterRow ?? exactNameTeamRow;
    const gsisId = rosterRow?.gsis_id || player.gsisId || null;
    const depthRow = gsisId ? selectDepthRow(player, depth.get(String(gsisId))) : null;
    const warnings = [];
    if (!rosterRow) warnings.push("CURRENT_ROSTER_UNMATCHED");
    if (rosterRow?.status && rosterRow.status !== "ACT") warnings.push(`ROSTER_${rosterRow.status}`);
    if (rosterRow?.team && canonicalTeam(rosterRow.team) !== canonicalTeam(player.team)) warnings.push(`TEAM_CHANGED_TO_${canonicalTeam(rosterRow.team)}`);
    if (!depthRow) warnings.push("CURRENT_DEPTH_CHART_UNMATCHED");
    const role = {
      audited: true,
      rosterMatched: Boolean(rosterRow),
      rosterMatchMethod: yahooRosterRow ? "YAHOO_ID" : gsisRosterRow ? "GSIS_ID" : exactNameTeamRow ? "EXACT_NAME_TEAM_UNIQUE" : null,
      depthChartMatched: Boolean(depthRow),
      rosterStatus: rosterRow?.status || null,
      rosterTeam: rosterRow?.team ? canonicalTeam(rosterRow.team) : null,
      depthPosition: depthRow?.pos_abb || depthRow?.pos_name || null,
      depthRank: finite(depthRow?.pos_rank) ? Number(depthRow.pos_rank) : null,
      depthSlot: finite(depthRow?.pos_slot) ? Number(depthRow.pos_slot) : null,
      warnings,
    };
    byYahooId.set(yahooId, role);
  }
  const values = [...byYahooId.values()];
  return {
    byYahooId,
    summary: {
      offenseTargets: targets.offense.length,
      idpTargets: targets.idp.length,
      totalTargets: targets.all.length,
      uniqueTargets: values.length,
      overlappingEligibleTargets: targets.all.length - values.length,
      rosterMatched: values.filter((entry) => entry.rosterMatched).length,
      depthChartMatched: values.filter((entry) => entry.depthChartMatched).length,
      targetsWithWarnings: values.filter((entry) => entry.warnings.length).length,
      rosterCoverageComplete: values.length > 0 && values.every((entry) => entry.rosterMatched),
      depthChartCoverageComplete: values.length > 0 && values.every((entry) => entry.depthChartMatched),
    },
  };
}

function teamOffenseContext(board) {
  const limits = { QB: 1, RB: 2, WR: 3, TE: 1 };
  const byTeamPosition = new Map();
  for (const player of board?.boards?.offense ?? []) {
    const team = canonicalTeam(player.team);
    const position = String(player.position).toUpperCase();
    if (!team || !limits[position] || !finite(player.consensusPoints)) continue;
    const key = `${team}:${position}`;
    const rows = byTeamPosition.get(key) ?? [];
    rows.push(Number(player.consensusPoints));
    byTeamPosition.set(key, rows);
  }
  const scores = new Map();
  for (const [key, projections] of byTeamPosition) {
    const [team, position] = key.split(":");
    projections.sort((left, right) => right - left);
    scores.set(team, (scores.get(team) ?? 0) + projections.slice(0, limits[position]).reduce((sum, value) => sum + value, 0));
  }
  const ranked = [...scores].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  return new Map(ranked.map(([team, score], index) => [team, { teamOffenseScore: score, teamOffenseRank: index + 1 }]));
}

function scheduleContext(schedule, offenseContext) {
  const byTeam = new Map();
  const add = (team, opponent, week, impliedPoints, opponentImpliedPoints) => {
    const rows = byTeam.get(team) ?? [];
    rows.push({ week, opponent, impliedPoints, opponentImpliedPoints, opponentOffenseScore: offenseContext.get(opponent)?.teamOffenseScore ?? null });
    byTeam.set(team, rows);
  };
  for (const game of schedule) {
    const away = canonicalTeam(game.away_team);
    const home = canonicalTeam(game.home_team);
    const week = Number(game.week);
    const total = finite(game.total_line) ? Number(game.total_line) : null;
    const homeEdge = finite(game.spread_line) ? Number(game.spread_line) : null;
    const homeImplied = total !== null && homeEdge !== null ? total / 2 + homeEdge / 2 : null;
    const awayImplied = total !== null && homeEdge !== null ? total / 2 - homeEdge / 2 : null;
    add(away, home, week, awayImplied, homeImplied);
    add(home, away, week, homeImplied, awayImplied);
  }
  const contexts = new Map();
  for (const [team, rows] of byTeam) {
    rows.sort((left, right) => left.week - right.week);
    const opponentScores = rows.map((row) => row.opponentOffenseScore).filter(finite).map(Number);
    contexts.set(team, {
      scheduleWeeks: rows.map((row) => ({ week: row.week, opponent: row.opponent })),
      scheduleComplete: rows.length === 4,
      averageOpponentOffenseScore: opponentScores.length === 4 ? opponentScores.reduce((sum, value) => sum + value, 0) / 4 : null,
      week1ImpliedPoints: rows.find((row) => row.week === 1)?.impliedPoints ?? null,
      week1OpponentImpliedPoints: rows.find((row) => row.week === 1)?.opponentImpliedPoints ?? null,
    });
  }
  const defenseRanks = [...contexts]
    .filter(([, context]) => finite(context.averageOpponentOffenseScore))
    .sort((left, right) => left[1].averageOpponentOffenseScore - right[1].averageOpponentOffenseScore || left[0].localeCompare(right[0]));
  for (let index = 0; index < defenseRanks.length; index += 1) defenseRanks[index][1].earlyScheduleRank = index + 1;
  return contexts;
}

function validateMarketOverlay(packet, asOf) {
  const now = Date.parse(asOf);
  const sourcesChecked = Array.from(packet?.sourcesChecked ?? []).map((entry, index) => {
    const sourceId = String(entry.sourceId ?? "").toLowerCase();
    const host = MARKET_HOSTS[sourceId];
    if (!host) throw new Error(`market source check ${index} has unsupported sourceId`);
    const capturedAt = iso(entry.capturedAt, `market source check ${index} capturedAt`);
    const ageHours = (now - Date.parse(capturedAt)) / 3_600_000;
    if (ageHours < 0 || ageHours > 48) throw new Error(`market source check ${index} is stale or future-dated`);
    return {
      sourceId,
      sourceUrl: checkedUrl(entry.sourceUrl, `market source check ${index} sourceUrl`, host),
      capturedAt,
      status: String(entry.status ?? "NO_ELIGIBLE_LINES_CAPTURED"),
      note: entry.note ? String(entry.note) : null,
    };
  });
  const entries = Array.from(packet?.entries ?? []).map((entry, index) => {
    const sourceId = String(entry.sourceId ?? "").toLowerCase();
    const host = MARKET_HOSTS[sourceId];
    if (!host) throw new Error(`market entry ${index} has unsupported sourceId`);
    const marketType = String(entry.marketType ?? "");
    if (!MARKET_STATS[marketType]) throw new Error(`market entry ${index} has unsupported marketType`);
    if (!/^\d+$/.test(String(entry.yahooId ?? ""))) throw new Error(`market entry ${index} requires an exact Yahoo ID`);
    if (!finite(entry.lineValue) || Number(entry.lineValue) < 0) throw new Error(`market entry ${index} requires a nonnegative lineValue`);
    const capturedAt = iso(entry.capturedAt, `market entry ${index} capturedAt`);
    const ageHours = (now - Date.parse(capturedAt)) / 3_600_000;
    return {
      yahooId: String(entry.yahooId),
      sourceId,
      sourceUrl: checkedUrl(entry.sourceUrl, `market entry ${index} sourceUrl`, host),
      marketType,
      lineValue: Number(entry.lineValue),
      overOdds: finite(entry.overOdds) ? Number(entry.overOdds) : null,
      underOdds: finite(entry.underOdds) ? Number(entry.underOdds) : null,
      capturedAt,
      ageHours,
      fresh: ageHours >= 0 && ageHours <= 48,
    };
  });
  if (entries.length && !sourcesChecked.length) throw new Error("market entries require at least one source check receipt");
  return { sourcesChecked, entries };
}

function marketSignals(packet, projectionSnapshots, asOf) {
  const validated = validateMarketOverlay(packet, asOf);
  const rawStats = new Map();
  for (const snapshot of projectionSnapshots ?? []) {
    for (const row of snapshot?.rows ?? []) {
      if (row.playerId && row.stats) rawStats.set(String(row.playerId), row.stats);
    }
  }
  const byYahooId = new Map();
  for (const entry of validated.entries) {
    const statKey = MARKET_STATS[entry.marketType];
    const anchor = rawStats.get(entry.yahooId)?.[statKey];
    const differenceRatio = finite(anchor) && Number(anchor) !== 0 ? (entry.lineValue - Number(anchor)) / Math.abs(Number(anchor)) : null;
    const flag = entry.fresh && finite(differenceRatio) && Math.abs(differenceRatio) >= 0.15
      ? differenceRatio > 0 ? "MARKET_ABOVE_ESPN_ANCHOR" : "MARKET_BELOW_ESPN_ANCHOR"
      : null;
    const row = { ...entry, anchorSource: "espn-clay", anchorValue: finite(anchor) ? Number(anchor) : null, differenceRatio, flag };
    const rows = byYahooId.get(entry.yahooId) ?? [];
    rows.push(row);
    byYahooId.set(entry.yahooId, rows);
  }
  return {
    byYahooId,
    summary: {
      policy: "NON_AUTHORITATIVE_CHALLENGER_ONLY",
      sourceChecks: validated.sourcesChecked,
      lineCount: validated.entries.length,
      freshLineCount: validated.entries.filter((entry) => entry.fresh).length,
      playerCoverage: byYahooId.size,
      flaggedPlayers: [...byYahooId.values()].filter((entries) => entries.some((entry) => entry.flag)).length,
      coverageStatus: validated.entries.length ? "PARTIAL_SELECTION_BIASED_COVERAGE" : "NO_ELIGIBLE_LINES_CAPTURED",
    },
  };
}

function manualRoleFindings(packet, asOf) {
  const now = Date.parse(asOf);
  const byYahooId = new Map();
  for (const [index, entry] of Array.from(packet?.roleFindings ?? []).entries()) {
    const sourceId = String(entry.sourceId ?? "");
    if (!ROLE_SOURCES.has(sourceId)) throw new Error(`role finding ${index} has unsupported sourceId`);
    if (!/^\d+$/.test(String(entry.yahooId ?? ""))) throw new Error(`role finding ${index} requires an exact Yahoo ID`);
    const observedAt = iso(entry.observedAt, `role finding ${index} observedAt`);
    const ageHours = (now - Date.parse(observedAt)) / 3_600_000;
    if (ageHours < 0 || ageHours > 168) throw new Error(`role finding ${index} is stale or future-dated`);
    const severity = String(entry.severity ?? "WATCH").toUpperCase();
    if (!["INFO", "WATCH", "BLOCK"].includes(severity)) throw new Error(`role finding ${index} has unsupported severity`);
    const finding = {
      yahooId: String(entry.yahooId),
      sourceId,
      sourceUrl: checkedUrl(entry.sourceUrl, `role finding ${index} sourceUrl`, ROLE_SOURCE_HOSTS[sourceId] ?? null),
      observedAt,
      severity,
      summary: String(entry.summary ?? "").trim(),
      projectionFamilyStale: entry.projectionFamilyStale ? String(entry.projectionFamilyStale) : null,
    };
    if (!finding.summary) throw new Error(`role finding ${index} requires a summary`);
    const rows = byYahooId.get(finding.yahooId) ?? [];
    rows.push(finding);
    byYahooId.set(finding.yahooId, rows);
  }
  return byYahooId;
}

export function enrichBoardWithDraftSignals({
  board,
  projectionSnapshots = [],
  depthChartCsv,
  rosterCsv,
  scheduleCsv,
  marketOverlay = { entries: [], sourcesChecked: [], roleFindings: [] },
  asOf,
  sourceRetrievedAt = {},
  sourceUrls = {},
}) {
  const beforeHash = projectionHash(board);
  const depth = parseNflverseDepthCharts(depthChartCsv);
  const rosters = parseNflverseRosters(rosterCsv);
  const schedule = parseNflverseSchedule(scheduleCsv);
  const receipts = [
    sourceReceipt({ sourceId: "nflverse-depth-charts", sourceUrl: sourceUrls.depthCharts, sourceAsOf: depth.observedAt, sourceAsOfBasis: "latest-dataset-observation", retrievedAt: sourceRetrievedAt.depthCharts, checkedAt: asOf, content: depthChartCsv }),
    sourceReceipt({ sourceId: "nflverse-rosters", sourceUrl: sourceUrls.rosters, sourceAsOf: sourceRetrievedAt.rosters, sourceAsOfBasis: "local-file-mtime-no-publisher-timestamp", retrievedAt: sourceRetrievedAt.rosters, checkedAt: asOf, content: rosterCsv }),
    sourceReceipt({ sourceId: "nflverse-schedule", sourceUrl: sourceUrls.schedule, sourceAsOf: sourceRetrievedAt.schedule, sourceAsOfBasis: "local-file-mtime-no-publisher-timestamp", retrievedAt: sourceRetrievedAt.schedule, checkedAt: asOf, content: scheduleCsv }),
  ];
  const roles = roleAudit(board, rosters, depth.rows);
  const offenseContext = teamOffenseContext(board);
  const schedules = scheduleContext(schedule, offenseContext);
  const markets = marketSignals(marketOverlay, projectionSnapshots, asOf);
  const manualFindings = manualRoleFindings(marketOverlay, asOf);

  const transform = (player) => {
    const yahooId = String(player.yahooId);
    const role = roles.byYahooId.get(yahooId) ?? null;
    const market = markets.byYahooId.get(yahooId) ?? null;
    const manual = manualFindings.get(yahooId) ?? [];
    const team = canonicalTeam(player.team);
    const warnings = [
      ...(role?.warnings ?? []),
      ...manual.filter((entry) => entry.severity !== "INFO").map((entry) => `${entry.severity}:${entry.summary}`),
      ...(market ?? []).filter((entry) => entry.flag).map((entry) => `${entry.flag}:${entry.marketType}`),
    ];
    let specialist = null;
    const position = String(player.position ?? "").toUpperCase();
    const eligiblePositions = new Set([position, player.yahooPosition, ...(player.eligible ?? [])].map((entry) => String(entry ?? "").toUpperCase()));
    if (position === "K") specialist = { kind: "K", ...offenseContext.get(team), week1ImpliedPoints: schedules.get(team)?.week1ImpliedPoints ?? null };
    if (position === "DEF") specialist = { kind: "DEF", ...schedules.get(team) };
    if ([...eligiblePositions].some((entry) => IDP.has(entry))) specialist = { kind: "IDP", depthPosition: role?.depthPosition ?? null, depthRank: role?.depthRank ?? null, depthSlot: role?.depthSlot ?? null };
    if (specialist?.kind === "K" && Number(specialist.teamOffenseRank) > 24) warnings.push("K_OFFENSE_CONTEXT_BOTTOM_QUARTILE");
    if (specialist?.kind === "DEF" && Number(specialist.earlyScheduleRank) > 24) warnings.push("DEF_EARLY_SCHEDULE_BOTTOM_QUARTILE");
    if (specialist?.kind === "IDP" && Number(specialist.depthRank) > 1) warnings.push("IDP_NOT_FIRST_ON_CURRENT_DEPTH_CHART");
    return {
      ...player,
      draftSignals: {
        attentionRequired: warnings.length > 0,
        warnings,
        role,
        manualRoleFindings: manual,
        market,
        specialist,
      },
    };
  };
  const players = (board.players ?? []).map(transform);
  const unifiedById = new Map(players.map((player) => [String(player.yahooId), player]));
  const enrichList = (list) => list.map((player) => ({ ...player, draftSignals: unifiedById.get(String(player.yahooId))?.draftSignals ?? transform(player).draftSignals }));
  const enriched = {
    ...board,
    players,
    boards: {
      ...board.boards,
      unified: enrichList(board.boards?.unified ?? []),
      offense: enrichList(board.boards?.offense ?? []),
      specialists: Object.fromEntries(Object.entries(board.boards?.specialists ?? {}).map(([position, list]) => [position, enrichList(list)])),
    },
  };
  const afterHash = projectionHash(enriched);
  enriched.draftSignalOverlay = {
    policy: "signals may warn or break ties; they never mutate league-scored projections",
    generatedAt: iso(asOf, "asOf"),
    projectionHashBefore: beforeHash,
    projectionHashAfter: afterHash,
    projectionUnchanged: beforeHash === afterHash,
    sourceReceipts: receipts,
    roleAudit: roles.summary,
    market: markets.summary,
    specialistContext: {
      teamOffenseCoverage: offenseContext.size,
      scheduleTeamCoverage: schedules.size,
      scheduleWeeks: "1-4",
      scheduleComplete: schedules.size === 32 && [...schedules.values()].every((entry) => entry.scheduleComplete),
    },
  };
  return Object.freeze(enriched);
}
