import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { LEAGUE_REPLACEMENT_RANKS } from "./build-v5-board.mjs";
import { buildPlayerBoard, scoreIdpStatLine, scoreKickerStatLine, scoreOffenseStatLine } from "./player-intelligence.mjs";
import { makeEspnClaySnapshot } from "./parse-espn-clay-projections.mjs";
import { makePublicProjectionSnapshot, parseCbsPositionHtml, parseFfcAdp, parseRazzballHtml } from "./parse-public-projections.mjs";
import { joinProjectionRowsToYahoo } from "./refresh-draft-prep.mjs";

const OFFENSE = new Set(["QB", "RB", "WR", "TE"]);
const IDP = new Set(["DL", "LB", "DB", "CB", "S", "D"]);
const ACCEPTED_OFFENSE_OMISSIONS = Object.freeze([
  "rushingHundredYardGames", "receivingHundredYardGames", "returnYards", "returnTouchdowns",
  "twoPointConversions", "fumblesLost", "offensiveFumbleReturnTouchdowns",
]);
const ACCEPTED_IDP_OMISSIONS = Object.freeze([
  "fumbleRecoveries", "touchdowns", "safeties", "blockedKicks", "turnoverReturnYards", "extraPointReturns",
]);

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function normalizePosition(value) {
  const position = String(value ?? "").toUpperCase();
  if (["DE", "DT", "NT", "EDGE"].includes(position)) return "DL";
  if (["FS", "SS"].includes(position)) return "S";
  if (["ILB", "OLB"].includes(position)) return "LB";
  return position;
}

function rankingPosition(player) {
  const filters = new Set(player.yahooEligibilityFilters ?? []);
  if (!filters.has("O")) {
    if (filters.has("LB")) return "LB";
    if (filters.has("CB")) return "CB";
    if (filters.has("DB")) return "DB";
    if (filters.has("D")) return "DL";
  }
  return normalizePosition(player.position);
}

function rowPerGame(row) {
  const games = Number(row.projectionGames ?? 17);
  if (!(games > 0)) return null;
  const points = row.scoringKind === "idp"
    ? scoreIdpStatLine(row.stats)
    : row.scoringKind === "kicker" ? scoreKickerStatLine(row.stats) : scoreOffenseStatLine(row.stats);
  return points / games;
}

function qualityGate({ snapshot, board, positions, minimumRows, topLimit = 200 }) {
  const eligibleTop = (board.players ?? [])
    .filter((player) => positions.has(normalizePosition(player.position)))
    .filter((player) => finite(player.overallRank) && Number(player.overallRank) <= topLimit);
  const joinedIds = new Set(snapshot.rows.filter((row) => row.playerId).map((row) => String(row.playerId)));
  const joinedTop = eligibleTop.filter((player) => joinedIds.has(String(player.yahooId ?? player.playerId)));
  const rowsByPosition = {};
  for (const row of snapshot.rows) {
    const position = normalizePosition(row.position);
    rowsByPosition[position] = (rowsByPosition[position] ?? 0) + 1;
  }
  const yahooPerGame = new Map((board.players ?? []).map((player) => [
    String(player.yahooId ?? player.playerId), Number(player.sourceFamilyPerGamePoints?.yahoo),
  ]));
  const gapRows = snapshot.rows.filter((row) => row.playerId).map((row) => {
    const yahoo = yahooPerGame.get(String(row.playerId));
    const external = rowPerGame(row);
    return Number.isFinite(yahoo) && Number.isFinite(external)
      ? { position: normalizePosition(row.position), gap: Math.abs(yahoo - external) }
      : null;
  }).filter(Boolean);
  const gaps = gapRows.map((row) => row.gap);
  const medianAbsoluteYahooGapPerGameByPosition = Object.fromEntries(
    [...new Set(gapRows.map((row) => row.position))].sort().map((position) => [position, median(gapRows.filter((row) => row.position === position).map((row) => row.gap))]),
  );
  const coverage = eligibleTop.length ? joinedTop.length / eligibleTop.length : 0;
  const missingMinimums = Object.entries(minimumRows).filter(([position, minimum]) => Number(rowsByPosition[position] ?? 0) < minimum).map(([position, minimum]) => `${position}:${rowsByPosition[position] ?? 0}<${minimum}`);
  const medianAbsoluteYahooGapPerGame = median(gaps);
  const reasons = [
    ...(coverage < 0.9 ? [`top-${topLimit} Yahoo-board join coverage ${(coverage * 100).toFixed(1)}% < 90%`] : []),
    ...missingMinimums,
    ...(!Number.isFinite(medianAbsoluteYahooGapPerGame) || medianAbsoluteYahooGapPerGame > 8 ? [`median absolute Yahoo gap ${medianAbsoluteYahooGapPerGame ?? "unavailable"} > 8 points/game`] : []),
    ...Object.entries(medianAbsoluteYahooGapPerGameByPosition).filter(([, gap]) => gap > 8).map(([position, gap]) => `${position} median absolute Yahoo gap ${gap.toFixed(2)} > 8 points/game`),
  ];
  return {
    pass: reasons.length === 0,
    reasons,
    topLimit,
    eligibleTop: eligibleTop.length,
    joinedTop: joinedTop.length,
    topCoverage: coverage,
    unjoinedTop: eligibleTop.filter((player) => !joinedIds.has(String(player.yahooId ?? player.playerId))).map((player) => ({ yahooId: String(player.yahooId ?? player.playerId), name: player.name, team: player.team, position: player.position, boardRank: player.overallRank })),
    rowsByPosition,
    medianAbsoluteYahooGapPerGame,
    medianAbsoluteYahooGapPerGameByPosition,
    comparisonCount: gaps.length,
  };
}

function projectionSource(snapshot, fresh) {
  return {
    sourceId: snapshot.manifest.sourceId,
    family: snapshot.manifest.sourceFamily,
    updatedAt: snapshot.manifest.sourceAsOf,
    maxAgeHours: 168,
    freshOverride: fresh,
    rows: snapshot.rows.filter((row) => row.playerId).map((row) => ({
      ...row,
      playerId: String(row.playerId),
      acceptedOmissions: row.scoringKind === "idp"
        ? ACCEPTED_IDP_OMISSIONS
        : row.scoringKind === "offense"
          ? ACCEPTED_OFFENSE_OMISSIONS
          : [],
    })),
  };
}

function scopeStatus(snapshot) {
  const scopes = {
    offense: { inputRows: 0, scorableRows: 0 },
    idp: { inputRows: 0, scorableRows: 0 },
    kicker: { inputRows: 0, scorableRows: 0 },
    teamDefense: { inputRows: 0, scorableRows: 0 },
  };
  for (const row of snapshot.rows) {
    const scope = row.scoringKind === "idp" ? "idp" : row.scoringKind === "kicker" ? "kicker" : row.scoringKind === "team-defense" ? "teamDefense" : "offense";
    const accepted = new Set(scope === "idp" ? ACCEPTED_IDP_OMISSIONS : scope === "offense" ? ACCEPTED_OFFENSE_OMISSIONS : []);
    const unaccepted = (row.omittedScoringCategories ?? []).filter((field) => !accepted.has(field));
    scopes[scope].inputRows += 1;
    if (!unaccepted.length && scope !== "teamDefense") scopes[scope].scorableRows += 1;
  }
  return Object.fromEntries(Object.entries(scopes).map(([scope, counts]) => [scope, {
    ...counts,
    status: counts.inputRows > 0 && counts.scorableRows === counts.inputRows
      ? "SCORABLE"
      : counts.scorableRows > 0
        ? "PARTIALLY_SCORABLE"
        : counts.inputRows > 0
          ? "DIAGNOSTIC_ONLY"
          : "NOT_PROVIDED",
    reason: scope === "teamDefense" && counts.inputRows
      ? "season aggregates cannot reconstruct weekly points-allowed buckets"
      : counts.scorableRows > 0 && counts.scorableRows < counts.inputRows
        ? "some rows omit one or more unaccepted league-scoring categories"
        : null,
  }]));
}

function trendByYahooId(trends, board) {
  const yahooBySleeper = new Map((board.players ?? []).filter((player) => player.sleeperId).map((player) => [String(player.sleeperId), String(player.yahooId ?? player.playerId)]));
  const result = new Map();
  for (const [kind, rows] of Object.entries(trends ?? {})) {
    for (const row of rows ?? []) {
      const yahooId = yahooBySleeper.get(String(row.player_id));
      if (!yahooId) continue;
      const current = result.get(yahooId) ?? {};
      current[kind] = Number(row.count ?? 0);
      result.set(yahooId, current);
    }
  }
  return result;
}

function csvCell(value) {
  const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function renderRankingCsv(players) {
  const fields = ["candidateRank", "previousRank", "yahooId", "name", "team", "position", "bye", "candidatePoints", "vorp", "yahooPerGame", "priorYahooPerGame", "espnPerGame", "cbsPerGame", "razzballPerGame", "ffcAdp", "rotoworldRank", "fantasyProsRank", "injuryStatus", "calibrationStatus", "activeWeekP20", "activeWeekP80", "availabilityP20", "availabilityP50", "availabilityP80", "seasonP20", "seasonP50", "seasonP80", "flags"];
  return `${[fields.join(","), ...players.map((player) => fields.map((field) => csvCell(player[field])).join(","))].join("\n")}\n`;
}

export function attachHistoricalCalibration(rankingPack, historicalCalibration = null) {
  const byYahooId = new Map((historicalCalibration?.currentPlayers ?? []).map((player) => [String(player.yahooId), player]));
  const players = (rankingPack.players ?? []).map((player) => {
    const calibration = byYahooId.get(String(player.yahooId)) ?? {
      yahooId: String(player.yahooId),
      gsisId: null,
      position: player.position,
      status: historicalCalibration ? "CALIBRATION_IDENTITY_MISSING" : "CALIBRATION_NOT_PROVIDED",
      activeWeek: null,
      availability: null,
      season: null,
    };
    return {
      ...player,
      calibrationStatus: calibration.status,
      activeWeekP20: calibration.activeWeek?.p20 ?? null,
      activeWeekP80: calibration.activeWeek?.p80 ?? null,
      availabilityP20: calibration.availability?.p20 ?? null,
      availabilityP50: calibration.availability?.p50 ?? null,
      availabilityP80: calibration.availability?.p80 ?? null,
      seasonP20: calibration.season?.p20 ?? null,
      seasonP50: calibration.season?.p50 ?? null,
      seasonP80: calibration.season?.p80 ?? null,
      historicalCalibration: {
        ...calibration,
        trainingSeasons: historicalCalibration?.trainingSeasons ?? null,
        holdoutSeason: historicalCalibration?.holdoutSeason ?? null,
      },
    };
  });
  const brief = rankingPack.astraModelBrief ?? {};
  const validation = historicalCalibration
    ? [...new Set(["2025 untouched challenger-zero holdout", ...(brief.validation ?? []), "2020-2024 weekly outcome and availability priors"])]
    : brief.validation ?? [];
  return {
    ...rankingPack,
    schemaVersion: 2,
    astraModelBrief: {
      ...brief,
      validation,
      ...(historicalCalibration ? { calibrationPolicy: "historical ranges are annotations only; failed position gates remain null and never alter projection, rank, VORP, or source-family values" } : {}),
    },
    players,
  };
}

export function buildRankingIntelligence({ board, snapshots, ffcRows = [], rankChallengers = [], sleeperTrends = {}, sleeperPlayersCurrent = {}, challengerReceipts = {}, historicalCalibration = null, generatedAt }) {
  const boardAgeHours = (Date.parse(generatedAt) - Date.parse(board.generatedAt)) / 3_600_000;
  const baseBoardReceipt = {
    generatedAt: board.generatedAt ?? null,
    ageHours: boardAgeHours,
    maximumAgeHours: 6,
    fresh: Number.isFinite(boardAgeHours) && boardAgeHours >= 0 && boardAgeHours <= 6,
  };
  const sourceGates = Object.fromEntries(snapshots.map((snapshot) => {
    const offenseOnly = snapshot.manifest.sourceId === "cbs-projections";
    const gate = qualityGate({
      snapshot,
      board,
      positions: offenseOnly ? OFFENSE : new Set([...OFFENSE, ...IDP]),
      minimumRows: { QB: 24, RB: 60, WR: 80, TE: 40 },
    });
    return [snapshot.manifest.sourceId, { ...gate, scopeStatus: scopeStatus(snapshot) }];
  }));
  const players = (board.players ?? []).map((player) => ({
    playerId: String(player.yahooId ?? player.playerId), name: player.name, team: player.team,
    position: rankingPosition(player), eligible: player.eligible, expectedGames: player.expectedGames ?? 17,
  }));
  const yahooSource = {
    sourceId: "yahoo-season-projection", family: "yahoo", updatedAt: board.generatedAt, maxAgeHours: 6,
    rows: (board.players ?? []).filter((player) => finite(player.sourceFamilyPerGamePoints?.yahoo)).map((player) => ({ playerId: String(player.yahooId ?? player.playerId), perGamePoints: Number(player.sourceFamilyPerGamePoints.yahoo) })),
  };
  const candidate = buildPlayerBoard({
    players,
    sources: [yahooSource, ...snapshots.map((snapshot) => projectionSource(snapshot, sourceGates[snapshot.manifest.sourceId].pass))],
    replacementRanks: { ...LEAGUE_REPLACEMENT_RANKS, CB: LEAGUE_REPLACEMENT_RANKS.DB, S: LEAGUE_REPLACEMENT_RANKS.DB, D: LEAGUE_REPLACEMENT_RANKS.DL },
    evidencePolicy: (player) => ({ minimumFreshFamilies: OFFENSE.has(player.position) || IDP.has(player.position) ? 2 : 1, requiredFamilies: ["yahoo"] }),
    asOf: generatedAt,
  });
  const candidateById = new Map(candidate.players.map((player) => [String(player.playerId), player]));
  const ffcJoin = new Map(ffcRows.filter((row) => row.playerId).map((row) => [String(row.playerId), row]));
  const challengerById = new Map();
  for (const row of rankChallengers.filter((row) => row.playerId)) {
    const entry = challengerById.get(String(row.playerId)) ?? {};
    entry[row.sourceId] = Number(row.rank);
    challengerById.set(String(row.playerId), entry);
  }
  const trends = trendByYahooId(sleeperTrends, board);
  const currentSleeperByYahoo = new Map((board.players ?? []).flatMap((player) => {
    if (!player.sleeperId) return [];
    const current = sleeperPlayersCurrent[String(player.sleeperId)];
    return current ? [[String(player.yahooId ?? player.playerId), current]] : [];
  }));
  const table = (board.players ?? []).map((previous) => {
    const yahooId = String(previous.yahooId ?? previous.playerId);
    const next = candidateById.get(yahooId);
    const market = ffcJoin.get(yahooId);
    const challenger = challengerById.get(yahooId) ?? {};
    const sourceValues = Object.values(next?.sourceFamilyPerGamePoints ?? {}).map(Number).filter(Number.isFinite);
    const priorYahooPerGame = finite(previous.sourceFamilyPerGamePoints?.yahoo) ? Number(previous.sourceFamilyPerGamePoints.yahoo) : null;
    const externalMedian = median(sourceValues);
    const flags = [];
    if (!next?.executable) flags.push("SCORING_EVIDENCE_UNVALIDATED");
    if (sourceValues.length >= 2 && Math.max(...sourceValues) - Math.min(...sourceValues) >= 5) flags.push("SOURCE_GAP");
    if (Number.isFinite(priorYahooPerGame) && Number.isFinite(externalMedian)) {
      const gap = Math.abs(priorYahooPerGame - externalMedian);
      if (gap >= 3 && gap / Math.max(1, Math.abs(priorYahooPerGame)) >= 0.35) flags.push("PRIOR_YAHOO_GAP");
    }
    if (finite(next?.overallRank) && finite(market?.adp) && Math.abs(Number(next.overallRank) - Number(market.adp)) >= 24) flags.push("FFC_MARKET_GAP");
    if (previous.injury?.draftAction && previous.injury.draftAction !== "CLEAR") flags.push("INJURY_REVIEW");
    const currentSleeper = currentSleeperByYahoo.get(yahooId);
    const currentSleeperInjuryStatus = currentSleeper?.injury_status || (currentSleeper?.status === "Active" ? "ACTIVE" : currentSleeper?.status ?? null);
    if (currentSleeperInjuryStatus && currentSleeperInjuryStatus !== previous.injury?.status && !(currentSleeperInjuryStatus === "ACTIVE" && previous.injury?.status === "CLEAR")) flags.push("SLEEPER_INJURY_STATUS_CHANGED");
    if ((trends.get(yahooId)?.drop ?? 0) >= 1000) flags.push("SLEEPER_TRENDING_DROP");
    if ((trends.get(yahooId)?.add ?? 0) >= 1000) flags.push("SLEEPER_TRENDING_ADD");
    for (const [sourceId, rank] of Object.entries(challenger)) {
      if (finite(next?.overallRank) && Math.abs(Number(next.overallRank) - rank) >= 24) flags.push(`${sourceId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_GAP`);
    }
    return {
      candidateRank: next?.overallRank ?? null,
      previousRank: previous.overallRank ?? null,
      yahooId,
      name: previous.name,
      team: previous.team,
      position: next?.position ?? previous.position,
      eligible: previous.eligible,
      bye: previous.bye ?? null,
      candidatePoints: next?.consensusPoints ?? null,
      vorp: next?.vorp ?? null,
      yahooPerGame: next?.sourceFamilyPerGamePoints?.yahoo ?? null,
      priorYahooPerGame,
      espnPerGame: next?.sourceFamilyPerGamePoints?.["espn-clay"] ?? null,
      cbsPerGame: next?.sourceFamilyPerGamePoints?.cbs ?? null,
      razzballPerGame: next?.sourceFamilyPerGamePoints?.razzball ?? null,
      ffcAdp: market?.adp ?? null,
      rotoworldRank: challenger["rotoworld-top-200"] ?? null,
      fantasyProsRank: challenger["fantasypros-manual"] ?? null,
      injuryStatus: previous.injury?.status ?? "UNKNOWN",
      injuryEvidence: previous.injury?.evidence ?? [],
      currentSleeperInjury: currentSleeper ? {
        status: currentSleeperInjuryStatus,
        bodyPart: currentSleeper.injury_body_part ?? null,
        practiceParticipation: currentSleeper.practice_participation ?? null,
        team: currentSleeper.team ?? null,
      } : null,
      sleeperTrend: trends.get(yahooId) ?? null,
      sourceFamilyPerGamePoints: next?.sourceFamilyPerGamePoints ?? {},
      scorableSourceFamilies: next?.scorableSourceFamilies ?? [],
      flags: [...new Set(flags)].sort(),
    };
  }).sort((left, right) => (left.candidateRank ?? Infinity) - (right.candidateRank ?? Infinity) || left.name.localeCompare(right.name));
  return attachHistoricalCalibration({
    schemaVersion: 1,
    generatedAt,
    posture: "research and draft preparation only; no Yahoo action authority",
    blendPolicy: "Yahoo plus gate-passing independent raw-stat families; equal-family mean for two and median for three or more; bounded omissions remain receipted",
    astraModelBrief: {
      objective: "rank 2026 players for expected starting-lineup value and replacement value under the exact 2 Minute Drillers scoring and roster rules",
      separateFeatures: ["football projection", "availability and injury", "acquisition cost and survival", "opponent pick probability"],
      forbiddenLeakage: "ADP, expert ranks, injuries, trends, and opponent behavior may challenge or constrain a decision but may not silently alter the underlying football projection",
      validation: ["source-family ablation", "2024-2025 weekly volatility priors", "Weeks 1-6 2026 MAE and rank correlation when outcomes exist", "pairwise source-error correlation", "challenger hit rate"],
      liveRequirement: "return five legal exact-Yahoo-ID choices in under one second and retain the static fallback ladder",
    },
    status: !baseBoardReceipt.fresh
      ? "YAHOO_REFRESH_REQUIRED"
      : Object.values(sourceGates).every((gate) => gate.pass) ? "PASS" : "CHALLENGER_GATES_FAILED",
    baseBoardReceipt,
    sourceGates,
    players: table,
    rawSources: snapshots,
    challengers: {
      ffcAdp: ffcRows,
      expertRanks: rankChallengers,
      sleeperTrends,
      currentSleeperInjuryCoverage: { matchedPlayers: currentSleeperByYahoo.size, boardPlayers: board.players?.length ?? 0 },
      receipts: challengerReceipts,
    },
  }, historicalCalibration);
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((entry) => { const [key, ...value] = entry.replace(/^--/, "").split("="); return [key, value.join("=")]; }));
  for (const key of ["board", "espn-text", "espn-pdf", "cbs-qb", "cbs-rb", "cbs-wr", "cbs-te", "razzball-offense", "razzball-idp", "razzball-k", "razzball-def", "ffc-adp", "overrides", "output", "generated-at", "espn-source-as-of", "cbs-source-as-of", "razzball-source-as-of"]) {
    if (!args[key]) throw new Error(`missing --${key}=...`);
  }
  const [board, espnText, espnPdf, overridesPacket, ffcPayload, trendAdds, trendDrops, sleeperPlayersCurrent, rankChallengers, historicalCalibration] = await Promise.all([
    readFile(args.board, "utf8").then(JSON.parse), readFile(args["espn-text"], "utf8"), readFile(args["espn-pdf"]),
    readFile(args.overrides, "utf8").then(JSON.parse), readFile(args["ffc-adp"], "utf8"),
    args["trends-add"] ? readFile(args["trends-add"], "utf8").then(JSON.parse) : [],
    args["trends-drop"] ? readFile(args["trends-drop"], "utf8").then(JSON.parse) : [],
    args["sleeper-players"] ? readFile(args["sleeper-players"], "utf8").then(JSON.parse) : {},
    args["rank-challengers"] ? readFile(args["rank-challengers"], "utf8").then(JSON.parse) : [],
    args["historical-calibration"] ? readFile(args["historical-calibration"], "utf8").then(JSON.parse) : null,
  ]);
  const identities = (board.players ?? []).map((player) => ({ yahooId: String(player.yahooId ?? player.playerId), name: player.name, team: player.team, position: rankingPosition(player) }));
  const join = (rows, sourceId, topLimit = null, teamPositionFallbacks = []) => joinProjectionRowsToYahoo({ rows, sleeperPlayers: {}, baselineRows: [], yahooRows: identities, sourceId, overrides: overridesPacket.overrides, topLimit, teamPositionFallbacks });
  const espnBase = makeEspnClaySnapshot({ text: espnText, pdfBytes: espnPdf, sourceAsOf: args["espn-source-as-of"], retrievedAt: args["generated-at"] });
  const espnJoined = join(espnBase.rows, "espn-mike-clay");
  espnBase.rows = espnJoined.rows;
  espnBase.identityReceipt = espnJoined.receipt;
  const cbsDocuments = {};
  const cbsRows = [];
  const cbsCoverage = {};
  for (const position of ["QB", "RB", "WR", "TE"]) {
    const html = await readFile(args[`cbs-${position.toLowerCase()}`], "utf8");
    cbsDocuments[position] = html;
    const parsed = parseCbsPositionHtml(html, position);
    cbsRows.push(...parsed.rows);
    cbsCoverage[position] = { rows: parsed.rows.length, rejected: parsed.rejected };
  }
  const cbsJoined = join(cbsRows, "cbs-projections");
  const cbsSnapshot = makePublicProjectionSnapshot({ sourceId: "cbs-projections", sourceFamily: "cbs", documents: cbsDocuments, sourceAsOf: args["cbs-source-as-of"], retrievedAt: args["generated-at"], rows: cbsJoined.rows, coverage: cbsCoverage, licenseUseNote: "Raw stat columns only; CBS fantasy points ignored; source page content not redistributed." });
  cbsSnapshot.identityReceipt = cbsJoined.receipt;
  const razzballDocuments = {};
  const razzballRows = [];
  const razzballCoverage = {};
  for (const kind of ["offense", "idp", "k", "def"]) {
    const html = await readFile(args[`razzball-${kind}`], "utf8");
    razzballDocuments[kind] = html;
    const parsed = parseRazzballHtml(html, kind);
    razzballRows.push(...parsed.rows);
    razzballCoverage[kind] = { rows: parsed.rows.length, rejected: parsed.rejected, headers: parsed.headers };
  }
  const razzballJoined = join(razzballRows, "razzball-projections");
  const razzballSnapshot = makePublicProjectionSnapshot({ sourceId: "razzball-projections", sourceFamily: "razzball", documents: razzballDocuments, sourceAsOf: args["razzball-source-as-of"], retrievedAt: args["generated-at"], rows: razzballJoined.rows, coverage: razzballCoverage, licenseUseNote: "Raw public projection fields only; source page content not redistributed." });
  razzballSnapshot.identityReceipt = razzballJoined.receipt;
  const ffcJoined = join(parseFfcAdp(ffcPayload), "ffc-adp", 200, ["DEF"]);
  const expertRankReceipts = {};
  const joinedChallengers = rankChallengers.flatMap((packet) => {
    const joined = join((packet.rows ?? []).map((row) => ({ ...row, rank: Number(row.rank), sourceRank: Number(row.rank) })), packet.sourceId, 200);
    expertRankReceipts[packet.sourceId] = { ...joined.receipt, observedAt: packet.observedAt, url: packet.url, captureMethod: packet.captureMethod ?? null, contentSha256: packet.contentSha256 ?? null };
    return joined.rows.map((row) => ({ ...row, sourceId: packet.sourceId, observedAt: packet.observedAt, url: packet.url }));
  });
  const output = buildRankingIntelligence({ board, snapshots: [espnBase, cbsSnapshot, razzballSnapshot], ffcRows: ffcJoined.rows, rankChallengers: joinedChallengers, sleeperTrends: { add: trendAdds, drop: trendDrops }, sleeperPlayersCurrent, challengerReceipts: { ffcAdp: ffcJoined.receipt, expertRanks: expertRankReceipts }, historicalCalibration, generatedAt: args["generated-at"] });
  await mkdir(dirname(args.output), { recursive: true });
  await Promise.all([
    writeFile(args.output, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 }),
    writeFile(args.output.replace(/\.json$/i, ".csv"), renderRankingCsv(output.players), { mode: 0o600 }),
    writeFile(args.output.replace(/astra-ranking-pack-v(\d+)\.json$/i, "public-projection-snapshots-v$1.json"), `${JSON.stringify([espnBase, cbsSnapshot, razzballSnapshot], null, 2)}\n`, { mode: 0o600 }),
  ]);
  process.stdout.write(`${JSON.stringify({ output: args.output, status: output.status, players: output.players.length, gates: Object.fromEntries(Object.entries(output.sourceGates).map(([id, gate]) => [id, { pass: gate.pass, coverage: gate.topCoverage }])) })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
}
