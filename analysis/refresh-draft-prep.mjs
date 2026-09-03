import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { assembleV5Board, SCORING_SCHEMA_HASH } from "./build-v5-board.mjs";
import { buildV5ReadinessReport } from "./build-v5-readiness-report.mjs";
import { buildSnakeSeatPackets } from "./build-snake-seat-packets.mjs";
import { enrichBoardWithDraftSignals } from "./draft-signal-overlay.mjs";
import { extensionBoardFromV5, renderExtensionBoard, renderOfflineBoardCsv } from "./export-extension-board.mjs";
import { validateSourceSnapshot } from "./free-source-registry.mjs";
import { parseHistory } from "./opponent-calibration.mjs";
import { buildOpponentWarRoom } from "./opponent-war-room.mjs";
import { makeEspnClaySnapshot } from "./parse-espn-clay-projections.mjs";
import { loadDecisionEngine, runRealShadowAcceptance } from "./real-shadow-acceptance.mjs";
import { buildRehearsalReport } from "./run-v5-rehearsals.mjs";

const execFile = promisify(execFileCallback);

export const ESPN_CLAY_URL = "https://g.espncdn.com/s/ffldraftkit/26/NFLDK2026_CS_ClayProjections2026.pdf";
export const SLEEPER_PLAYERS_URL = "https://api.sleeper.app/v1/players/nfl";
export const NFLVERSE_DEPTH_CHARTS_URL = "https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_2026.csv";
export const NFLVERSE_ROSTERS_URL = "https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_2026.csv";
export const NFLVERSE_SCHEDULE_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";
const USER_AGENT = "SKRODZKai-Fantasy-GM/1.0 (personal draft research; one request per source per run)";
const POSITION_MINIMUMS = Object.freeze({ QB: 24, RB: 60, WR: 80, TE: 40 });
const TEAM_ALIASES = Object.freeze({ JAC: "JAX", WSH: "WAS", LA: "LAR" });
const YAHOO_LEAGUE_ID = "420010";
const SCORING_MODEL = "2-minute-drillers-2026";
const GENERATED_AT_MAX_SKEW_MINUTES = 15;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalTeam(value) {
  const team = String(value ?? "").trim().toUpperCase();
  return TEAM_ALIASES[team] ?? team;
}

function canonicalName(value, dropSuffix = false) {
  const normalized = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return dropSuffix ? normalized.replace(/\s+(jr|sr|ii|iii|iv|v)$/i, "") : normalized;
}

function identityKey(name, team, dropSuffix = false) {
  return `${canonicalName(name, dropSuffix)}:${canonicalTeam(team)}`;
}

function overrideIdentityKey(name, team, position) {
  return `${identityKey(name, team, false)}:${String(position ?? "").toUpperCase()}`;
}

function uniqueIdentityMap(rows, dropSuffix = false) {
  const values = new Map();
  const ambiguous = new Set();
  for (const row of rows) {
    const yahooId = row.yahooId ?? row.yahoo_id;
    if (yahooId === null || yahooId === undefined || !row.name || !row.team) continue;
    const key = identityKey(row.name, row.team, dropSuffix);
    const existing = values.get(key);
    if (existing && existing !== String(yahooId)) {
      values.delete(key);
      ambiguous.add(key);
    } else if (!ambiguous.has(key)) {
      values.set(key, String(yahooId));
    }
  }
  return { values, ambiguous };
}

export function joinProjectionRowsToYahoo({ rows, sleeperPlayers, baselineRows, yahooRows = [], sourceId = null, overrides = [], topLimit = null, teamPositionFallbacks = [] }) {
  const identities = [
    ...yahooRows.map((row) => ({ yahooId: row.yahooId, name: row.name, team: row.team, position: row.position })),
    ...(baselineRows ?? []).map((row) => ({ yahooId: row.yahoo_id, name: row.name, team: row.team, position: row.position })),
    ...Object.values(sleeperPlayers ?? {}).map((row) => ({ yahooId: row.yahoo_id, name: row.full_name, team: row.team, position: row.position || row.fantasy_positions?.[0] })),
  ];
  const exact = uniqueIdentityMap(identities, false);
  const suffixless = uniqueIdentityMap(identities, true);
  const allowedTeamPositions = new Set(teamPositionFallbacks.map((value) => String(value).toUpperCase()));
  const teamPosition = uniqueIdentityMap(
    identities.filter((row) => allowedTeamPositions.has(String(row.position ?? "").toUpperCase())).map((row) => ({ ...row, name: String(row.position).toUpperCase() })),
    false,
  );
  const knownYahooIds = new Set(identities.map((row) => row.yahooId).filter((value) => value !== null && value !== undefined).map(String));
  const overrideMap = new Map();
  for (const override of overrides ?? []) {
    if (sourceId && override.sourceId !== sourceId) continue;
    const yahooId = String(override.yahooId ?? "");
    if (!knownYahooIds.has(yahooId)) throw new Error(`identity override references unknown Yahoo ID ${yahooId}`);
    const key = overrideIdentityKey(override.name, override.team, override.position);
    if (!override.name || !override.team || !override.position) throw new Error("identity override requires name, team, and position");
    if (overrideMap.has(key)) throw new Error(`duplicate identity override ${key}`);
    overrideMap.set(key, yahooId);
  }
  const matchedByPosition = {};
  const unmatchedByPosition = {};
  const matchedByMethod = { override: 0, exact: 0, suffixless: 0, teamPosition: 0 };
  const joined = rows.map((row, index) => {
    const overrideId = overrideMap.get(overrideIdentityKey(row.name, row.team, row.position));
    const exactId = exact.values.get(identityKey(row.name, row.team, false));
    const suffixId = suffixless.values.get(identityKey(row.name, row.team, true));
    const teamPositionId = allowedTeamPositions.has(String(row.position ?? "").toUpperCase())
      ? teamPosition.values.get(identityKey(String(row.position).toUpperCase(), row.team, false))
      : null;
    const playerId = overrideId ?? exactId ?? suffixId ?? teamPositionId ?? null;
    if (overrideId) matchedByMethod.override += 1;
    else if (exactId) matchedByMethod.exact += 1;
    else if (suffixId) matchedByMethod.suffixless += 1;
    else if (teamPositionId) matchedByMethod.teamPosition += 1;
    const bucket = playerId ? matchedByPosition : unmatchedByPosition;
    bucket[row.position] = (bucket[row.position] ?? 0) + 1;
    return playerId ? { ...row, playerId, sourceRank: row.sourceRank ?? index + 1 } : { ...row, sourceRank: row.sourceRank ?? index + 1 };
  });
  const topRows = Number.isInteger(topLimit) && topLimit > 0
    ? joined.filter((row) => Number(row.sourceRank) <= topLimit)
    : [];
  const unjoinedTop = topRows.filter((row) => !row.playerId).map((row) => ({ sourceRank: row.sourceRank, name: row.name, team: row.team, position: row.position }));
  return {
    rows: joined,
    receipt: {
      sourceId,
      matchedByPosition,
      unmatchedByPosition,
      matchedByMethod,
      ambiguousExactKeys: exact.ambiguous.size,
      ambiguousSuffixlessKeys: suffixless.ambiguous.size,
      fuzzyMatching: false,
      topLimit,
      topCoverage: topRows.length ? (topRows.length - unjoinedTop.length) / topRows.length : null,
      unjoinedTop,
    },
  };
}

export function joinEspnRowsToYahoo(options) {
  return joinProjectionRowsToYahoo(options);
}

function requireFreshIso(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a dated value`);
  return new Date(parsed).toISOString();
}

function buildClockReceipt(generatedAt) {
  const wallClockDate = new Date();
  if (!Number.isFinite(wallClockDate.getTime())) throw new Error("wall clock must be a dated value");
  const wallClockAt = wallClockDate.toISOString();
  const generatedAtSkewMinutes = (Date.parse(generatedAt) - Date.parse(wallClockAt)) / 60_000;
  return {
    wallClockAt,
    generatedAtSkewMinutes,
    maximumAbsoluteSkewMinutes: GENERATED_AT_MAX_SKEW_MINUTES,
    fresh: Math.abs(generatedAtSkewMinutes) <= GENERATED_AT_MAX_SKEW_MINUTES,
  };
}

async function fetchBytes(fetchImpl, url, expectedType) {
  const response = await fetchImpl(url, { headers: { "user-agent": USER_AGENT } });
  if (!response?.ok) throw new Error(`${url} returned HTTP ${response?.status ?? "unknown"}`);
  const contentType = String(response.headers?.get?.("content-type") ?? "").toLowerCase();
  if (!contentType.includes(expectedType)) throw new Error(`${url} returned unexpected content type ${contentType || "missing"}`);
  return { response, bytes: Buffer.from(await response.arrayBuffer()) };
}

export async function fetchEspnClayPdf({ fetchImpl = fetch, retrievedAt }) {
  const { response, bytes } = await fetchBytes(fetchImpl, ESPN_CLAY_URL, "application/pdf");
  const lastModified = requireFreshIso(response.headers.get("last-modified"), "ESPN Last-Modified");
  if (bytes.length < 100_000) throw new Error(`ESPN PDF is unexpectedly small: ${bytes.length} bytes`);
  return {
    bytes,
    sourceAsOf: lastModified,
    retrievedAt: requireFreshIso(retrievedAt, "retrievedAt"),
    etag: response.headers.get("etag") || null,
  };
}

function validSleeperCache(snapshot, asOf) {
  const ageHours = (Date.parse(asOf) - Date.parse(snapshot?.manifest?.retrievedAt)) / 3_600_000;
  return snapshot?.manifest?.sourceId === "sleeper" && ageHours >= 0 && ageHours <= 24 && snapshot.players && typeof snapshot.players === "object";
}

export async function loadOrFetchSleeper({ fetchImpl = fetch, cachePath = null, retrievedAt }) {
  if (cachePath) {
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8"));
      if (validSleeperCache(cached, retrievedAt)) return { snapshot: cached, reused: true };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const { bytes } = await fetchBytes(fetchImpl, SLEEPER_PLAYERS_URL, "application/json");
  const players = JSON.parse(bytes.toString("utf8"));
  const timestamp = requireFreshIso(retrievedAt, "retrievedAt");
  return {
    reused: false,
    snapshot: {
      manifest: {
        snapshotId: `sleeper-players-${timestamp.slice(0, 10)}`,
        sourceId: "sleeper",
        sourceFamily: "sleeper",
        sourceAsOf: timestamp,
        retrievedAt: timestamp,
        contentSha256: sha256(bytes),
        gamesBasis: "current NFL player identity and injury map",
        projectionPeriod: "2026 season",
        licenseUseNote: "Sleeper public read-only API; cached no more frequently than daily.",
      },
      players,
    },
  };
}

export async function writeSleeperCache(cachePath, snapshot) {
  if (!cachePath) return false;
  const stagingPath = `${cachePath}.tmp-${randomUUID()}`;
  await writeFile(stagingPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  await rename(stagingPath, cachePath);
  return true;
}

export async function extractPdfLayout({ pdfPath, textPath }) {
  const version = await execFile("pdftotext", ["-v"]);
  await execFile("pdftotext", ["-layout", pdfPath, textPath]);
  const text = await readFile(textPath, "utf8");
  return {
    text,
    receipt: {
      command: "pdftotext -layout",
      version: String(version.stderr || version.stdout).trim().split("\n")[0],
      textSha256: sha256(text),
    },
  };
}

function validateEspnCoverage(snapshot) {
  const missingSections = Object.keys(POSITION_MINIMUMS).filter((position) => !snapshot.coverage.sections.includes(position));
  const shortPositions = Object.entries(POSITION_MINIMUMS)
    .filter(([position, minimum]) => Number(snapshot.coverage.rowsByPosition[position] ?? 0) < minimum)
    .map(([position, minimum]) => `${position}:${snapshot.coverage.rowsByPosition[position] ?? 0}<${minimum}`);
  if (missingSections.length || shortPositions.length) throw new Error(`ESPN coverage incomplete: ${[...missingSections, ...shortPositions].join(",")}`);
}

async function readJsonReceipt(path) {
  const text = await readFile(path, "utf8");
  return { path, text, value: JSON.parse(text), contentSha256: sha256(text) };
}

function observedHealth(receipt, asOf, maximumAgeHours) {
  const observedAt = receipt.value?.observedAt;
  const ageHours = (Date.parse(asOf) - Date.parse(observedAt)) / 3_600_000;
  return {
    callerSupplied: true,
    fetched: false,
    observedAt: observedAt ?? null,
    ageHours,
    maximumAgeHours,
    fresh: Number.isFinite(ageHours) && ageHours >= 0 && ageHours <= maximumAgeHours,
    contentSha256: receipt.contentSha256,
  };
}

function yahooSourceHealth(receipt, asOf, label) {
  const value = receipt.value ?? {};
  if (String(value.leagueId ?? "") !== YAHOO_LEAGUE_ID) throw new Error(`${label} must declare Yahoo league ${YAHOO_LEAGUE_ID}`);
  if (value.scoringModel !== SCORING_MODEL) throw new Error(`${label} must declare scoring model ${SCORING_MODEL}`);
  if (value.scoringSchemaHash !== SCORING_SCHEMA_HASH) throw new Error(`${label} scoring schema hash does not match the current league model`);
  return {
    ...observedHealth(receipt, asOf, 6),
    leagueId: YAHOO_LEAGUE_ID,
    scoringModel: SCORING_MODEL,
    scoringSchemaHash: SCORING_SCHEMA_HASH,
  };
}

function playerState(player) {
  const numberOrNull = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
  return {
    rank:numberOrNull(player.overallRank),
    projection:numberOrNull(player.consensusPoints),
    injuryStatus:String(player.injury?.status ?? "UNKNOWN"),
    draftAction:String(player.injury?.draftAction ?? "UNKNOWN"),
    automaticEligible:player.automaticEligible === true,
    manualEligible:player.manualEligible === true,
    validationStatus:String(player.validationStatus ?? "UNKNOWN"),
    bye:Number.isInteger(Number(player.bye)) ? Number(player.bye) : null,
  };
}

export function boardMovers(currentBoard, priorBoard, priorReceipt = null) {
  if (!priorBoard) return { changes:[], priorReceipt, reason:"no-prior-passing-board" };
  const previous = new Map((priorBoard.players ?? []).map((player) => [String(player.yahooId ?? player.playerId), { player, state:playerState(player) }]));
  const currentIds = new Set();
  const changes = [];
  for (const player of currentBoard.players ?? []) {
    const yahooId = String(player.yahooId ?? player.playerId);
    currentIds.add(yahooId);
    const before = previous.get(yahooId);
    const after = playerState(player);
    if (!before) {
      changes.push({ yahooId, name:player.name, position:player.position, kind:"ADDED", before:null, after });
      continue;
    }
    const rankDelta = Number.isFinite(before.state.rank) && Number.isFinite(after.rank) ? before.state.rank - after.rank : null;
    const projectionDelta = Number.isFinite(before.state.projection) && Number.isFinite(after.projection) ? after.projection - before.state.projection : null;
    const changed = (rankDelta ?? 0) !== 0 || Math.abs(projectionDelta ?? 0) >= 0.01 ||
      before.state.injuryStatus !== after.injuryStatus || before.state.draftAction !== after.draftAction ||
      before.state.automaticEligible !== after.automaticEligible || before.state.manualEligible !== after.manualEligible ||
      before.state.validationStatus !== after.validationStatus || before.state.bye !== after.bye;
    if (changed) changes.push({ yahooId, name:player.name, position:player.position, kind:"CHANGED", rankDelta, projectionDelta, before:before.state, after });
  }
  for (const [yahooId, before] of previous) {
    if (!currentIds.has(yahooId)) changes.push({ yahooId, name:before.player.name, position:before.player.position, kind:"REMOVED", before:before.state, after:null });
  }
  changes.sort((left, right) => {
    const leftSignal = Math.abs(left.rankDelta ?? 0) + (left.before?.draftAction !== left.after?.draftAction ? 1000 : 0) + (left.kind === "CHANGED" ? 0 : 500);
    const rightSignal = Math.abs(right.rankDelta ?? 0) + (right.before?.draftAction !== right.after?.draftAction ? 1000 : 0) + (right.kind === "CHANGED" ? 0 : 500);
    return rightSignal - leftSignal || left.yahooId.localeCompare(right.yahooId);
  });
  return { priorReceipt, changes, changedPlayers:changes.length, rankField:"overallRank", projectionField:"consensusPoints" };
}

export function renderBoardMovementMarkdown(board, movement) {
  const top = (board.players ?? []).filter((player) => player.overallRank !== null && player.overallRank !== undefined && player.overallRank !== "" && Number.isFinite(Number(player.overallRank))).sort((left, right) => left.overallRank - right.overallRank).slice(0, 30);
  const playerById = new Map((board.players ?? []).map((player) => [String(player.yahooId ?? player.playerId), player]));
  const watch = (board.injuryWatchlist ?? []).slice(0, 30).map((entry) => ({
    ...entry,
    name:playerById.get(String(entry.yahooId ?? entry.playerId))?.name ?? null,
  }));
  const lines = [
    "# Draft Board Movement v15", "", `Generated: ${board.generatedAt}`, `Prior passing board: ${movement.priorReceipt?.boardPath ?? "none"}`, "",
    "## Top 30", "", "| Rank | Player | Pos | Projection | Bye | Injury action |", "| ---: | --- | --- | ---: | ---: | --- |",
    ...top.map((player) => `| ${player.overallRank} | ${player.name} | ${player.position} | ${Number(player.consensusPoints).toFixed(2)} | ${player.bye ?? "—"} | ${player.injury?.draftAction ?? "UNKNOWN"} |`),
    "", "## Material movement", "", "| Player | Pos | Change | Rank delta | Projection delta | Injury | Eligibility |", "| --- | --- | --- | ---: | ---: | --- | --- |",
    ...movement.changes.slice(0, 75).map((change) => `| ${change.name} | ${change.position} | ${change.kind} | ${change.rankDelta ?? "—"} | ${Number.isFinite(change.projectionDelta) ? change.projectionDelta.toFixed(2) : "—"} | ${change.before?.draftAction ?? "—"} → ${change.after?.draftAction ?? "—"} | ${change.before?.validationStatus ?? "—"} → ${change.after?.validationStatus ?? "—"} |`),
    "", "## Injury watch", "", "| Player | Status | Draft action | Evidence |", "| --- | --- | --- | --- |",
    ...watch.map((entry) => `| ${entry.name ?? entry.playerId} | ${entry.status ?? "UNKNOWN"} | ${entry.draftAction ?? "UNKNOWN"} | ${entry.primarySourceId ?? "—"} |`),
    "", "## Ranking signals", "",
    `- Projection columns unchanged: ${board.draftSignalOverlay?.projectionUnchanged === true ? "YES" : "NO OR UNAVAILABLE"}`,
    `- Role audit: ${board.draftSignalOverlay?.roleAudit?.rosterMatched ?? 0}/${board.draftSignalOverlay?.roleAudit?.uniqueTargets ?? 0} unique current rosters; ${board.draftSignalOverlay?.roleAudit?.depthChartMatched ?? 0}/${board.draftSignalOverlay?.roleAudit?.uniqueTargets ?? 0} unique current depth charts (${board.draftSignalOverlay?.roleAudit?.offenseTargets ?? 0} offense + ${board.draftSignalOverlay?.roleAudit?.idpTargets ?? 0} IDP, ${board.draftSignalOverlay?.roleAudit?.overlappingEligibleTargets ?? 0} overlaps)`,
    `- Sportsbook challenger: ${board.draftSignalOverlay?.market?.coverageStatus ?? "UNAVAILABLE"}; ${board.draftSignalOverlay?.market?.flaggedPlayers ?? 0} flagged players`,
    `- DEF schedule context complete: ${board.draftSignalOverlay?.specialistContext?.scheduleComplete === true ? "YES" : "NO"}`, "",
  ];
  return `${lines.join("\n")}\n`;
}

export async function discoverPreviousPassingBoard(outputParent, excludedFinalPath = null) {
  const entries = await readdir(outputParent, { withFileTypes:true });
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name:entry.name, timestamp:entry.name.match(/^draft-prep-v(?:11|13|14|15)-(\d{8}T\d{9}Z)$/)?.[1] ?? null }))
    .filter((entry) => entry.timestamp)
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .map((entry) => entry.name);
  for (const name of candidates) {
    const directory = join(outputParent, name);
    if (directory === excludedFinalPath) continue;
    try {
      const health = JSON.parse(await readFile(join(directory, "nightly-health.json"), "utf8"));
      if (health.status !== "PASS") continue;
      for (const filename of ["player-board-v15.json", "player-board-v14.json", "player-board-v13.json", "player-board-v11.json"]) {
        try {
          const boardPath = join(directory, filename);
          const board = JSON.parse(await readFile(boardPath, "utf8"));
          return { board, receipt:{ runDirectory:directory, boardPath, generatedAt:health.generatedAt ?? board.generatedAt ?? null, healthStatus:"PASS" } };
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { board:null, receipt:null };
}

function countsByPosition(players) {
  const counts = {};
  for (const player of players) counts[player.position] = (counts[player.position] ?? 0) + 1;
  return counts;
}

export function byeCoverage(players) {
  const eligible = Array.from(players ?? []).filter((player) => player.automaticEligible === true || player.manualEligible === true);
  const playersWithBye = eligible.filter((player) => Number.isInteger(Number(player.bye)) && Number(player.bye) >= 1 && Number(player.bye) <= 17).length;
  return {
    complete: eligible.length > 0 && playersWithBye === eligible.length,
    playersWithBye,
    playersTotal: eligible.length,
    denominator: "automatic-or-manual-eligible players, including DEF",
  };
}

export function buildHealth({ generatedAt, clock, yahoo, espnHealth, sleeperHealth, sleeperReused, board, movement, rehearsal, packets, opponentWarRoom, realShadowAcceptance, identityReceipt, draftSignals = null, failure = null }) {
  const automatic = (board?.players ?? []).filter((player) => player.automaticEligible === true);
  const byes = byeCoverage(board?.players);
  const reasons = [
    ...Object.entries(yahoo ?? {}).filter(([, value]) => !value.fresh).map(([key]) => `stale_or_missing_yahoo_${key}`),
    ...(espnHealth && !espnHealth.fresh ? ["stale_espn_projection_family"] : []),
    ...(sleeperHealth && !sleeperHealth.fresh ? ["stale_sleeper_identity_injury_map"] : []),
    ...(rehearsal && rehearsal.accepted !== true ? ["rehearsal_not_accepted"] : []),
    ...(packets && packets.packets?.length !== 12 ? ["twelve_seat_packets_missing"] : []),
    ...(opponentWarRoom && opponentWarRoom.cards?.length !== 11 ? ["eleven_current_opponent_cards_missing"] : []),
    ...(realShadowAcceptance && realShadowAcceptance.status !== "PASS" ? ["real_shadow_acceptance_failed"] : []),
    ...(clock && !clock.fresh ? ["generated_at_wall_clock_skew"] : []),
    ...(board && board.injuryCoverage?.complete !== true ? ["injury_coverage_incomplete"] : []),
    ...(board && byes.complete !== true ? ["bye_coverage_incomplete"] : []),
    ...(!draftSignals && !failure ? ["draft_signal_overlay_missing"] : []),
    ...(draftSignals && draftSignals.projectionUnchanged !== true ? ["draft_signal_overlay_mutated_projections"] : []),
    ...(draftSignals && draftSignals.roleAudit?.offenseTargets !== 150 ? ["top_150_offense_role_audit_missing"] : []),
    ...(draftSignals && draftSignals.roleAudit?.idpTargets !== 40 ? ["top_40_idp_role_audit_missing"] : []),
    ...(draftSignals && draftSignals.roleAudit?.rosterCoverageComplete !== true ? ["current_roster_audit_incomplete"] : []),
    ...(draftSignals && draftSignals.roleAudit?.depthChartCoverageComplete !== true ? ["current_depth_chart_audit_incomplete"] : []),
    ...(draftSignals && draftSignals.specialistContext?.scheduleComplete !== true ? ["weeks_1_4_schedule_context_incomplete"] : []),
    ...(draftSignals && draftSignals.sourceReceipts?.some((receipt) => receipt.fresh !== true) ? ["stale_nflverse_ranking_context"] : []),
    ...(failure ? [String(failure)] : []),
  ];
  return {
    schemaVersion: 1,
    generatedAt,
    status: reasons.length ? "FAIL" : "PASS",
    posture: "preparation-only; no Yahoo action or real-league execution authority",
    reasons,
    clock: clock ?? null,
    sources: { yahoo, espn: espnHealth ?? null, sleeper: sleeperHealth ? { ...sleeperHealth, reusedSameDayCache: sleeperReused } : null },
    identity: identityReceipt ?? null,
    injuries: board?.injuryCoverage ?? null,
    eligibility: {
      automaticEligibleByPosition: countsByPosition(automatic),
      automaticEligibleTotal: automatic.length,
      ambiguousNameTeamKeys: board?.identityEvidence?.ambiguousNameTeamKeys ?? [],
    },
    byes: { source: "caller-supplied Yahoo player snapshots", ...byes },
    boardMovement: movement ?? { changes:[], reason:"board-not-built" },
    projectionBias: board?.projectionModel?.sourceGapByPosition ?? null,
    draftSignals,
    rehearsal: rehearsal ? { accepted: rehearsal.accepted, latency: rehearsal.latency, runnerSourceSha256: rehearsal.runnerSourceSha256, scoringSchemaHash: rehearsal.scoringSchemaHash } : null,
    seatPackets: packets ? { count: packets.packets?.length ?? 0, executionInput: packets.executionInput } : null,
    opponentWarRoom: opponentWarRoom ? { cardCount:opponentWarRoom.cards?.length ?? 0, policy:opponentWarRoom.policy } : null,
    realShadowAcceptance: realShadowAcceptance ? { status:realShadowAcceptance.status, seats:realShadowAcceptance.seats?.map((seat) => ({ seat:seat.seat, pass:seat.pass, latencyMs:seat.latencyMs })) } : null,
    realLeagueExecutionDisabled: rehearsal?.policyChecks?.realLeagueExecutionDisabled === true,
  };
}

function finalDirectoryName(generatedAt) {
  return `draft-prep-v15-${generatedAt.replace(/[-:.]/g, "")}`;
}

async function ensureOutputParent(outputParent, allowedOutputRoot) {
  const [parent, allowed] = await Promise.all([realpath(outputParent), realpath(allowedOutputRoot)]);
  if (parent !== allowed && !parent.startsWith(`${allowed}${sep}`)) throw new Error(`output parent must resolve under ${allowed}`);
  return parent;
}

export async function publishSuccessfulRun({ staging, finalPath, board, extensionSource, offlineBoardCsv, readiness, rehearsal, packets, opponentWarRoom, movementMarkdown, realShadowAcceptance, health }) {
  await Promise.all([
    writeFile(join(staging, "player-board-v15.json"), `${JSON.stringify(board, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(staging, "draft-signals-v15.json"), `${JSON.stringify(board.draftSignalOverlay ?? null, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(staging, "yahoo-mock-board-v15.js"), extensionSource, { mode: 0o600 }),
    writeFile(join(staging, "yahoo-mock-board-v15.csv"), offlineBoardCsv, { mode: 0o600 }),
    writeFile(join(staging, "draft-readiness-v15.json"), `${JSON.stringify(readiness, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(staging, "rehearsal-30s-v15.json"), `${JSON.stringify(rehearsal, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(staging, "opponent-war-room-v15.json"), `${JSON.stringify({ ...opponentWarRoom, seatPackets:packets.packets }, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(staging, "board-movement-v15.md"), movementMarkdown, { mode: 0o600 }),
    writeFile(join(staging, "real-shadow-acceptance-v15.json"), `${JSON.stringify(realShadowAcceptance, null, 2)}\n`, { mode: 0o600 }),
  ]);
  await writeFile(join(staging, "nightly-health.json"), `${JSON.stringify(health, null, 2)}\n`, { mode: 0o600 });
  await rename(staging, finalPath);
}

export async function refreshDraftPrep(options) {
  const generatedAt = requireFreshIso(options.generatedAt, "generatedAt");
  const clock = buildClockReceipt(generatedAt);
  const outputParent = await ensureOutputParent(options.outputParent, options.allowedOutputRoot ?? "/Volumes/TradingFloor");
  const finalPath = join(outputParent, finalDirectoryName(generatedAt));
  try {
    await access(finalPath);
    throw new Error(`output already exists: ${finalPath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const staging = await mkdtemp(join(outputParent, `.draft-prep-v15-${randomUUID()}-`));
  let health;
  try {
    if (!clock.fresh) throw new Error(`generatedAt differs from wall clock by ${clock.generatedAtSkewMinutes.toFixed(2)} minutes`);
    const prior = await discoverPreviousPassingBoard(outputParent, finalPath);
    const [baseline, yahooOffense, yahooSpecialists, yahooEligibility, historyText, opponentCalibration, externalInjuries, survivalCalibration, runnerSource] = await Promise.all([
      readJsonReceipt(options.baselinePath),
      readJsonReceipt(options.yahooOffensePath),
      readJsonReceipt(options.yahooSpecialistsPath),
      readJsonReceipt(options.yahooEligibilityPath),
      readFile(options.historyPath, "utf8"),
      readFile(options.opponentCalibrationPath, "utf8").then(JSON.parse),
      options.externalInjuriesPath ? readFile(options.externalInjuriesPath, "utf8").then(JSON.parse) : [],
      options.survivalCalibrationPath ? readFile(options.survivalCalibrationPath, "utf8").then(JSON.parse) : null,
      readFile(options.runnerPath, "utf8"),
    ]);
    const yahoo = {
      offense: yahooSourceHealth(yahooOffense, clock.wallClockAt, "Yahoo offense snapshot"),
      specialists: yahooSourceHealth(yahooSpecialists, clock.wallClockAt, "Yahoo specialist snapshot"),
      eligibility: yahooSourceHealth(yahooEligibility, clock.wallClockAt, "Yahoo eligibility snapshot"),
    };
    if (Object.values(yahoo).some((receipt) => !receipt.fresh)) throw new Error("caller-supplied Yahoo snapshots are stale or missing observedAt");
    const sourceDirectory = join(staging, "source-snapshots");
    await mkdir(sourceDirectory);
    const espnPdf = await fetchEspnClayPdf({ fetchImpl: options.fetchImpl, retrievedAt: clock.wallClockAt });
    const pdfPath = join(sourceDirectory, "espn-clay-2026.pdf");
    const textPath = join(sourceDirectory, "espn-clay-2026.txt");
    await writeFile(pdfPath, espnPdf.bytes, { mode: 0o600 });
    const extraction = await (options.extractPdf ?? extractPdfLayout)({ pdfPath, textPath });
    const espnSnapshot = makeEspnClaySnapshot({ ...espnPdf, text: extraction.text, pdfBytes: espnPdf.bytes, extraction: extraction.receipt });
    validateEspnCoverage(espnSnapshot);

    const sleeper = await loadOrFetchSleeper({ fetchImpl: options.fetchImpl, cachePath: options.sleeperCachePath, retrievedAt: clock.wallClockAt });
    const joined = joinEspnRowsToYahoo({ rows: espnSnapshot.rows, sleeperPlayers: sleeper.snapshot.players, baselineRows: baseline.value, yahooRows: yahooOffense.value.players ?? [] });
    espnSnapshot.rows = joined.rows;
    espnSnapshot.identityReceipt = joined.receipt;
    const [espnHealth, sleeperHealth] = validateSourceSnapshot([espnSnapshot.manifest, sleeper.snapshot.manifest], clock.wallClockAt);
    if (!espnHealth.fresh || !sleeperHealth.fresh) throw new Error("public source freshness gate failed");
    const additionalProjectionSnapshots = options.additionalProjectionPath
      ? await readFile(options.additionalProjectionPath, "utf8").then(JSON.parse).then((value) => {
          if (!Array.isArray(value)) throw new Error("additional projection packet must be an array");
          return value.filter((snapshot) => snapshot.manifest?.sourceId !== "espn-mike-clay");
        })
      : [];
    const additionalProjectionHealth = validateSourceSnapshot(additionalProjectionSnapshots.map((snapshot) => snapshot.manifest), clock.wallClockAt);
    if (additionalProjectionHealth.some((receipt) => receipt.fresh !== true)) throw new Error("additional public projection freshness gate failed");
    const projectionSnapshots = [espnSnapshot, ...additionalProjectionSnapshots];

    await Promise.all([
      writeFile(join(sourceDirectory, "espn-clay-2026.json"), `${JSON.stringify(espnSnapshot, null, 2)}\n`, { mode: 0o600 }),
      writeFile(join(sourceDirectory, "sleeper-players.json"), `${JSON.stringify(sleeper.snapshot, null, 2)}\n`, { mode: 0o600 }),
    ]);

    let board = assembleV5Board({
      baselineRows: baseline.value,
      offenseSnapshot: yahooOffense.value,
      specialistSnapshot: yahooSpecialists.value,
      eligibilitySnapshot: yahooEligibility.value,
      sleeperPlayers: sleeper.snapshot.players,
      sleeperObservedAt: sleeper.snapshot.manifest.sourceAsOf,
      externalInjuryReports: externalInjuries,
      projectionSnapshots,
      survivalCalibration,
      asOf: clock.wallClockAt,
    });
    const rankingContextPaths = [options.nflverseDepthPath, options.nflverseRosterPath, options.nflverseSchedulePath];
    if (rankingContextPaths.some(Boolean) && !rankingContextPaths.every(Boolean)) throw new Error("all nflverse ranking-context paths are required together");
    if (rankingContextPaths.every(Boolean)) {
      const [depthChartCsv, rosterCsv, scheduleCsv, marketOverlay, depthChartFile, rosterFile, scheduleFile] = await Promise.all([
        readFile(options.nflverseDepthPath, "utf8"),
        readFile(options.nflverseRosterPath, "utf8"),
        readFile(options.nflverseSchedulePath, "utf8"),
        options.marketOverlayPath ? readFile(options.marketOverlayPath, "utf8").then(JSON.parse) : { entries:[], sourcesChecked:[], roleFindings:[] },
        stat(options.nflverseDepthPath),
        stat(options.nflverseRosterPath),
        stat(options.nflverseSchedulePath),
      ]);
      board = enrichBoardWithDraftSignals({
        board,
        projectionSnapshots,
        depthChartCsv,
        rosterCsv,
        scheduleCsv,
        marketOverlay,
        asOf:clock.wallClockAt,
        sourceRetrievedAt:{ depthCharts:depthChartFile.mtime.toISOString(), rosters:rosterFile.mtime.toISOString(), schedule:scheduleFile.mtime.toISOString() },
        sourceUrls:{ depthCharts:NFLVERSE_DEPTH_CHARTS_URL, rosters:NFLVERSE_ROSTERS_URL, schedule:NFLVERSE_SCHEDULE_URL },
      });
    }
    const extensionBoard = extensionBoardFromV5(board);
    const extensionSource = renderExtensionBoard(extensionBoard);
    const offlineBoardCsv = renderOfflineBoardCsv(extensionBoard);
    const historyRows = parseHistory(historyText);
    const readiness = buildV5ReadinessReport({
      historyRows,
      playerBoard: board,
      opponentCalibration,
      generatedAt: clock.wallClockAt,
      excludedManagerIds: ["joe"],
    });
    const rehearsal = buildRehearsalReport({ boardSource: extensionSource, runnerSource, generatedAt: clock.wallClockAt });
    const packets = buildSnakeSeatPackets({ rehearsal, board, opponentCalibration, generatedAt: clock.wallClockAt });
    const [teams, managerMapPacket, realSettings] = await Promise.all([
      readFile(options.teamsPath, "utf8").then(JSON.parse),
      readFile(options.managerMapPath, "utf8").then(JSON.parse),
      readFile(options.realSettingsPath, "utf8").then(JSON.parse),
    ]);
    const opponentWarRoom = buildOpponentWarRoom({ teams, calibration:opponentCalibration, managerMap:managerMapPacket.managerMap, historyRows, joeManagerIds:["joe"] });
    const movement = boardMovers(board, prior.board, prior.receipt);
    const movementMarkdown = renderBoardMovementMarkdown(board, movement);
    const engine = await loadDecisionEngine(options.runnerPath);
    const realShadowAcceptance = runRealShadowAcceptance({ engine, boardData:extensionBoard, settingsSnapshot:realSettings });
    health = buildHealth({ generatedAt: clock.wallClockAt, clock, yahoo, espnHealth, sleeperHealth, sleeperReused: sleeper.reused, board, movement, rehearsal, packets, opponentWarRoom, realShadowAcceptance, identityReceipt: joined.receipt, draftSignals: board.draftSignalOverlay ?? null });
    if (health.status !== "PASS") throw new Error(health.reasons.join("; "));
    if (!sleeper.reused) await writeSleeperCache(options.sleeperCachePath, sleeper.snapshot);

    await publishSuccessfulRun({ staging, finalPath, board, extensionSource, offlineBoardCsv, readiness, rehearsal, packets, opponentWarRoom, movementMarkdown, realShadowAcceptance, health });
    return { finalPath, health };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    const failedStaging = await mkdtemp(join(outputParent, `.draft-prep-v15-failed-${randomUUID()}-`));
    health = buildHealth({ generatedAt, clock, failure: String(error?.message ?? error) });
    await writeFile(join(failedStaging, "nightly-health.json"), `${JSON.stringify(health, null, 2)}\n`, { mode: 0o600 });
    try {
      await rename(failedStaging, finalPath);
    } catch (publishError) {
      const failure = new Error(`draft prep refresh failed: ${health.reasons.join("; ")}; health receipt remains at ${failedStaging}; publish failed: ${String(publishError?.message ?? publishError)}`, { cause: error });
      failure.finalPath = failedStaging;
      throw failure;
    }
    const failure = new Error(`draft prep refresh failed: ${health.reasons.join("; ")}`);
    failure.finalPath = finalPath;
    throw failure;
  }
}

function parseArgs(argv) {
  const args = {};
  for (const entry of argv) {
    const [key, ...value] = entry.replace(/^--/, "").split("=");
    args[key] = value.join("=");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const required = ["generated-at", "output-parent", "baseline", "yahoo-offense", "yahoo-specialists", "yahoo-eligibility", "history", "opponent-calibration", "teams", "manager-map", "real-settings", "runner", "nflverse-depth", "nflverse-roster", "nflverse-schedule", "market-overlay"];
  for (const key of required) if (!args[key]) throw new Error(`missing --${key}=...`);
  const result = await refreshDraftPrep({
    generatedAt: args["generated-at"],
    outputParent: args["output-parent"],
    baselinePath: args.baseline,
    yahooOffensePath: args["yahoo-offense"],
    yahooSpecialistsPath: args["yahoo-specialists"],
    yahooEligibilityPath: args["yahoo-eligibility"],
    historyPath: args.history,
    opponentCalibrationPath: args["opponent-calibration"],
    teamsPath: args.teams,
    managerMapPath: args["manager-map"],
    realSettingsPath: args["real-settings"],
    externalInjuriesPath: args.injuries ?? null,
    survivalCalibrationPath: args.survival ?? null,
    sleeperCachePath: args["sleeper-cache"] ?? null,
    runnerPath: args.runner,
    nflverseDepthPath: args["nflverse-depth"],
    nflverseRosterPath: args["nflverse-roster"],
    nflverseSchedulePath: args["nflverse-schedule"],
    marketOverlayPath: args["market-overlay"],
    additionalProjectionPath: args["additional-projections"] ?? null,
  });
  process.stdout.write(`${JSON.stringify({ output: result.finalPath, status: result.health.status })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
