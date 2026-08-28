import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { assembleV5Board, SCORING_SCHEMA_HASH } from "./build-v5-board.mjs";
import { buildV5ReadinessReport } from "./build-v5-readiness-report.mjs";
import { buildSnakeSeatPackets } from "./build-snake-seat-packets.mjs";
import { extensionBoardFromV5, renderExtensionBoard } from "./export-extension-board.mjs";
import { validateSourceSnapshot } from "./free-source-registry.mjs";
import { parseHistory } from "./opponent-calibration.mjs";
import { makeEspnClaySnapshot } from "./parse-espn-clay-projections.mjs";
import { buildRehearsalReport } from "./run-v5-rehearsals.mjs";

const execFile = promisify(execFileCallback);

export const ESPN_CLAY_URL = "https://g.espncdn.com/s/ffldraftkit/26/NFLDK2026_CS_ClayProjections2026.pdf";
export const SLEEPER_PLAYERS_URL = "https://api.sleeper.app/v1/players/nfl";
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

export function joinEspnRowsToYahoo({ rows, sleeperPlayers, baselineRows, yahooRows = [] }) {
  const identities = [
    ...yahooRows.map((row) => ({ yahooId: row.yahooId, name: row.name, team: row.team })),
    ...(baselineRows ?? []).map((row) => ({ yahooId: row.yahoo_id, name: row.name, team: row.team })),
    ...Object.values(sleeperPlayers ?? {}).map((row) => ({ yahooId: row.yahoo_id, name: row.full_name, team: row.team })),
  ];
  const exact = uniqueIdentityMap(identities, false);
  const suffixless = uniqueIdentityMap(identities, true);
  const matchedByPosition = {};
  const unmatchedByPosition = {};
  const joined = rows.map((row) => {
    const exactId = exact.values.get(identityKey(row.name, row.team, false));
    const suffixId = suffixless.values.get(identityKey(row.name, row.team, true));
    const playerId = exactId ?? suffixId ?? null;
    const bucket = playerId ? matchedByPosition : unmatchedByPosition;
    bucket[row.position] = (bucket[row.position] ?? 0) + 1;
    return playerId ? { ...row, playerId } : row;
  });
  return {
    rows: joined,
    receipt: {
      matchedByPosition,
      unmatchedByPosition,
      ambiguousExactKeys: exact.ambiguous.size,
      ambiguousSuffixlessKeys: suffixless.ambiguous.size,
      fuzzyMatching: false,
    },
  };
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

function boardMovers(currentBoard, priorBoard) {
  if (!priorBoard) return { movers: null, reason: "no-prior" };
  const previous = new Map((priorBoard.players ?? []).map((player) => [String(player.yahooId ?? player.playerId), Number(player.overallRank)]));
  const movers = (currentBoard.players ?? [])
    .map((player) => ({
      yahooId: String(player.yahooId ?? player.playerId),
      name: player.name,
      previousOverallRank: previous.get(String(player.yahooId ?? player.playerId)) ?? null,
      currentOverallRank: Number(player.overallRank),
    }))
    .filter((row) => Number.isFinite(row.previousOverallRank) && row.previousOverallRank > 0 && Number.isFinite(row.currentOverallRank) && row.currentOverallRank > 0)
    .map((row) => ({ ...row, rankDelta: row.previousOverallRank - row.currentOverallRank }))
    .filter((row) => row.rankDelta !== 0)
    .sort((left, right) => Math.abs(right.rankDelta) - Math.abs(left.rankDelta) || left.yahooId.localeCompare(right.yahooId))
    .slice(0, 50);
  return { movers, rankField: "overallRank" };
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

export function buildHealth({ generatedAt, clock, yahoo, espnHealth, sleeperHealth, sleeperReused, board, priorBoard, rehearsal, packets, identityReceipt, failure = null }) {
  const automatic = (board?.players ?? []).filter((player) => player.automaticEligible === true);
  const byes = byeCoverage(board?.players);
  const reasons = [
    ...Object.entries(yahoo ?? {}).filter(([, value]) => !value.fresh).map(([key]) => `stale_or_missing_yahoo_${key}`),
    ...(espnHealth && !espnHealth.fresh ? ["stale_espn_projection_family"] : []),
    ...(sleeperHealth && !sleeperHealth.fresh ? ["stale_sleeper_identity_injury_map"] : []),
    ...(rehearsal && rehearsal.accepted !== true ? ["rehearsal_not_accepted"] : []),
    ...(packets && packets.packets?.length !== 12 ? ["twelve_seat_packets_missing"] : []),
    ...(clock && !clock.fresh ? ["generated_at_wall_clock_skew"] : []),
    ...(board && board.injuryCoverage?.complete !== true ? ["injury_coverage_incomplete"] : []),
    ...(board && byes.complete !== true ? ["bye_coverage_incomplete"] : []),
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
    boardMovement: board ? boardMovers(board, priorBoard) : { movers: null, reason: "board-not-built" },
    projectionBias: board?.projectionModel?.sourceGapByPosition ?? null,
    rehearsal: rehearsal ? { accepted: rehearsal.accepted, latency: rehearsal.latency, runnerSourceSha256: rehearsal.runnerSourceSha256, scoringSchemaHash: rehearsal.scoringSchemaHash } : null,
    seatPackets: packets ? { count: packets.packets?.length ?? 0, executionInput: packets.executionInput } : null,
    realLeagueExecutionDisabled: rehearsal?.policyChecks?.realLeagueExecutionDisabled === true,
  };
}

function finalDirectoryName(generatedAt) {
  return `draft-prep-v11-${generatedAt.replace(/[-:.]/g, "")}`;
}

async function ensureOutputParent(outputParent, allowedOutputRoot) {
  const [parent, allowed] = await Promise.all([realpath(outputParent), realpath(allowedOutputRoot)]);
  if (parent !== allowed && !parent.startsWith(`${allowed}${sep}`)) throw new Error(`output parent must resolve under ${allowed}`);
  return parent;
}

export async function publishSuccessfulRun({ staging, finalPath, board, extensionSource, readiness, rehearsal, packets, health }) {
  await Promise.all([
    writeFile(join(staging, "player-board-v11.json"), `${JSON.stringify(board, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(staging, "yahoo-mock-board-v11.js"), extensionSource, { mode: 0o600 }),
    writeFile(join(staging, "draft-readiness-v11.json"), `${JSON.stringify(readiness, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(staging, "rehearsal-30s-v11.json"), `${JSON.stringify(rehearsal, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(staging, "snake-seat-packets-v11.json"), `${JSON.stringify(packets, null, 2)}\n`, { mode: 0o600 }),
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
  const staging = await mkdtemp(join(outputParent, `.draft-prep-v11-${randomUUID()}-`));
  let health;
  try {
    if (!clock.fresh) throw new Error(`generatedAt differs from wall clock by ${clock.generatedAtSkewMinutes.toFixed(2)} minutes`);
    const [baseline, yahooOffense, yahooSpecialists, yahooEligibility, historyText, opponentCalibration, priorBoard, externalInjuries, survivalCalibration, runnerSource] = await Promise.all([
      readJsonReceipt(options.baselinePath),
      readJsonReceipt(options.yahooOffensePath),
      readJsonReceipt(options.yahooSpecialistsPath),
      readJsonReceipt(options.yahooEligibilityPath),
      readFile(options.historyPath, "utf8"),
      readFile(options.opponentCalibrationPath, "utf8").then(JSON.parse),
      options.previousBoardPath ? readFile(options.previousBoardPath, "utf8").then(JSON.parse) : null,
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

    await Promise.all([
      writeFile(join(sourceDirectory, "espn-clay-2026.json"), `${JSON.stringify(espnSnapshot, null, 2)}\n`, { mode: 0o600 }),
      writeFile(join(sourceDirectory, "sleeper-players.json"), `${JSON.stringify(sleeper.snapshot, null, 2)}\n`, { mode: 0o600 }),
    ]);

    const board = assembleV5Board({
      baselineRows: baseline.value,
      offenseSnapshot: yahooOffense.value,
      specialistSnapshot: yahooSpecialists.value,
      eligibilitySnapshot: yahooEligibility.value,
      sleeperPlayers: sleeper.snapshot.players,
      sleeperObservedAt: sleeper.snapshot.manifest.sourceAsOf,
      externalInjuryReports: externalInjuries,
      projectionSnapshots: [espnSnapshot],
      survivalCalibration,
      asOf: clock.wallClockAt,
    });
    const extensionBoard = extensionBoardFromV5(board);
    const extensionSource = renderExtensionBoard(extensionBoard);
    const readiness = buildV5ReadinessReport({
      historyRows: parseHistory(historyText),
      playerBoard: board,
      opponentCalibration,
      generatedAt: clock.wallClockAt,
      excludedManagerIds: ["joe"],
    });
    const rehearsal = buildRehearsalReport({ boardSource: extensionSource, runnerSource, generatedAt: clock.wallClockAt });
    const packets = buildSnakeSeatPackets({ rehearsal, board, opponentCalibration, generatedAt: clock.wallClockAt });
    health = buildHealth({ generatedAt: clock.wallClockAt, clock, yahoo, espnHealth, sleeperHealth, sleeperReused: sleeper.reused, board, priorBoard, rehearsal, packets, identityReceipt: joined.receipt });
    if (health.status !== "PASS") throw new Error(health.reasons.join("; "));
    if (!sleeper.reused) await writeSleeperCache(options.sleeperCachePath, sleeper.snapshot);

    await publishSuccessfulRun({ staging, finalPath, board, extensionSource, readiness, rehearsal, packets, health });
    return { finalPath, health };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    const failedStaging = await mkdtemp(join(outputParent, `.draft-prep-v11-failed-${randomUUID()}-`));
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
  const required = ["generated-at", "output-parent", "baseline", "yahoo-offense", "yahoo-specialists", "yahoo-eligibility", "history", "opponent-calibration", "runner"];
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
    previousBoardPath: args["previous-board"] ?? null,
    externalInjuriesPath: args.injuries ?? null,
    survivalCalibrationPath: args.survival ?? null,
    sleeperCachePath: args["sleeper-cache"] ?? null,
    runnerPath: args.runner,
  });
  process.stdout.write(`${JSON.stringify({ output: result.finalPath, status: result.health.status })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
