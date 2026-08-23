import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { compileInjuryBoard } from "./injury-monitor.mjs";
import { buildPlayerBoard } from "./player-intelligence.mjs";

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

const YAHOO_STATUS = Object.freeze({
  Q: "QUESTIONABLE",
  D: "DOUBTFUL",
  O: "OUT",
  IR: "IR",
  PUP: "PUP",
  NFI: "NFI",
  NA: "UNKNOWN",
});

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
  if (["CB", "S", "FS", "SS"].includes(position)) return "DB";
  if (["ILB", "OLB"].includes(position)) return "LB";
  return position;
}

function identityKey(name, team) {
  return `${String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")}:${String(team ?? "").toUpperCase()}`;
}

function hasFiniteProjection(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function flattenYahooRows(offenseSnapshot, specialistSnapshot, eligibilitySnapshot = null) {
  const byId = new Map();
  const filterMembership = new Map();
  const add = (row, filter) => {
    if (!row?.yahooId) return;
    const yahooId = String(row.yahooId);
    if (!byId.has(yahooId) || row.yahooProjectedPoints !== null) {
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

function buildSleeperByYahooId(sleeperPlayers) {
  const byYahooId = new Map();
  for (const player of Object.values(sleeperPlayers ?? {})) {
    if (player?.yahoo_id !== null && player?.yahoo_id !== undefined) {
      byYahooId.set(String(player.yahoo_id), player);
    }
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
  baselineObservedAt,
  sleeperObservedAt,
}) {
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
  const { rows: yahooRows, filterMembership } = flattenYahooRows(
    offenseSnapshot,
    specialistSnapshot,
    eligibilitySnapshot,
  );
  const eligibilityByYahooId = new Map(
    (eligibilitySnapshot?.players ?? []).map((player) => [String(player.yahooId), player]),
  );
  const sleeperByYahooId = buildSleeperByYahooId(sleeperPlayers);

  const baselineForYahooRow = (row) => baselineByYahooId.get(String(row.yahooId)) ??
    baselineByIdentity.get(identityKey(row.name, row.team));

  const players = yahooRows.map((row) => {
    const baseline = baselineForYahooRow(row);
    const observedEligibility = eligibilityByYahooId.get(String(row.yahooId));
    const yahooFilters = filterMembership.get(String(row.yahooId)) ?? [];
    const eligibilityOnlyCb = observedEligibility?.eligible?.includes("CB") && yahooFilters.length === 1 && yahooFilters[0] === "CB";
    const dualRolePosition = baseline?.payload?.specialist_qualified && yahooFilters.includes("DB")
      ? baseline.payload.specialist?.draft_position
      : eligibilityOnlyCb
        ? "DB"
        : null;
    const position = normalizePosition(dualRolePosition || baseline?.position || row.position);
    return {
      playerId: String(row.yahooId),
      yahooId: String(row.yahooId),
      gsisId: baseline?.gsis_id || null,
      sleeperId: baseline?.sleeper_id || null,
      name: baseline?.name || row.name,
      team: baseline?.team || row.team,
      position,
      yahooPosition: String(row.position ?? position).toUpperCase(),
      yahooEligibilityFilters: yahooFilters,
      eligible: observedEligibility?.eligible ?? baseline?.payload?.eligible ?? [position],
      bye: row.bye,
      yahooPreseasonRank: row.yahooPreseasonRank,
      yahooRosteredPercent: row.rosteredPercent,
      marketAdp: baseline?.adp ?? null,
      marketAdpLow: baseline?.adp_low ?? null,
      marketAdpHigh: baseline?.adp_high ?? null,
      marketAdpSamples: baseline?.payload?.adp_samples ?? null,
    };
  });

  const yahooSource = {
    sourceId: "yahoo-season-projection",
    updatedAt: offenseSnapshot.observedAt,
    weight: 0.65,
    rows: yahooRows
      .filter((row) => hasFiniteProjection(row.yahooProjectedPoints))
      .map((row) => ({ playerId: String(row.yahooId), leaguePoints: row.yahooProjectedPoints })),
  };
  const baselineSource = {
    sourceId: "league-scored-history-market-baseline",
    updatedAt: baselineObservedAt,
    weight: 0.35,
    rows: yahooRows
      .map((row) => ({ row, baseline: baselineForYahooRow(row) }))
      .filter(({ baseline }) => hasFiniteProjection(baseline?.projection))
      .map(({ row, baseline }) => ({ playerId: String(row.yahooId), leaguePoints: baseline.projection })),
  };

  const projectionBoard = buildPlayerBoard({
    players,
    sources: [yahooSource, baselineSource],
    replacementRanks: LEAGUE_REPLACEMENT_RANKS,
    asOf,
    maxAgeHours: 96,
    minimumFreshSources: 2,
  });

  const reports = [];
  for (const yahoo of yahooRows) {
    reports.push({
      playerId: String(yahoo.yahooId),
      sourceId: "yahoo-player-list",
      sourceKind: "yahoo",
      observedAt: offenseSnapshot.observedAt,
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
  const injuryBoard = compileInjuryBoard({ reports, asOf, maxAgeHours: 96 });
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
    const executable = player.executable && injury.executable;
    const specialist = ["K", "DEF", "DL", "LB", "DB"].includes(player.position);
    return {
      ...player,
      injury,
      executable,
      blockReason: executable ? null : [player.blockReason, injury.blockReason].filter(Boolean).join("; "),
      draftPhase: specialist ? "SPECIALIST_ONLY" : "OFFENSE",
    };
  });

  const offense = combined
    .filter((player) => player.draftPhase === "OFFENSE")
    .sort((left, right) => (right.vorp ?? -Infinity) - (left.vorp ?? -Infinity))
    .map((player, index) => ({ ...player, draftBoardRank: player.vorp === null ? null : index + 1 }));
  const specialists = Object.fromEntries(
    ["K", "DEF", "DL", "LB", "DB"].map((position) => [
      position,
      combined
        .filter((player) => player.position === position)
        .sort((left, right) => {
          if (["K", "DEF"].includes(position)) {
            const leftRank = hasFiniteProjection(left.yahooPreseasonRank) ? Number(left.yahooPreseasonRank) : Infinity;
            const rightRank = hasFiniteProjection(right.yahooPreseasonRank) ? Number(right.yahooPreseasonRank) : Infinity;
            return leftRank - rightRank || (right.consensusPoints ?? -Infinity) - (left.consensusPoints ?? -Infinity);
          }
          return (right.consensusPoints ?? -Infinity) - (left.consensusPoints ?? -Infinity);
        })
        .map((player, index) => ({ ...player, specialistRank: player.consensusPoints === null ? null : index + 1 })),
    ]),
  );

  return Object.freeze({
    schemaVersion: 1,
    generatedAt: asOf,
    leagueId: "420010",
    scoringModel: "2-minute-drillers-2026",
    replacementRanks: LEAGUE_REPLACEMENT_RANKS,
    replacementRankBasis: "2-minute-drillers real-league 2026 roster assumptions",
    specialistRankingBasis: { K: "Yahoo preseason rank", DEF: "Yahoo preseason rank", DL: "league-scored consensus", LB: "league-scored consensus", DB: "league-scored consensus" },
    sources: projectionBoard.sourceReceipts,
    eligibilityEvidence: specialistSnapshot.eligibilityEvidence ?? {},
    players: combined,
    boards: { offense, specialists },
  });
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((entry) => {
      const [key, ...value] = entry.split("=");
      return [key.replace(/^--/, ""), value.join("=")];
    }),
  );
  const required = ["baseline", "offense", "specialists", "sleeper", "output", "as-of", "baseline-observed-at", "sleeper-observed-at"];
  for (const key of required) {
    if (!args[key]) throw new Error(`missing --${key}=...`);
  }
  const [baselineRows, offenseSnapshot, specialistSnapshot, sleeperPlayers, eligibilitySnapshot] = await Promise.all([
    readFile(args.baseline, "utf8").then(JSON.parse),
    readFile(args.offense, "utf8").then(JSON.parse),
    readFile(args.specialists, "utf8").then(JSON.parse),
    readFile(args.sleeper, "utf8").then(JSON.parse),
    args.eligibility ? readFile(args.eligibility, "utf8").then(JSON.parse) : null,
  ]);
  const board = assembleV5Board({
    baselineRows,
    offenseSnapshot,
    specialistSnapshot,
    sleeperPlayers,
    eligibilitySnapshot,
    asOf: args["as-of"],
    baselineObservedAt: args["baseline-observed-at"],
    sleeperObservedAt: args["sleeper-observed-at"],
  });
  await writeFile(args.output, `${JSON.stringify(board, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({ output: args.output, players: board.players.length, executable: board.players.filter((player) => player.executable).length })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
