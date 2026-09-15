import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { buildWeeklyProjectionReport, deriveOpportunityRates, opportunityExpectedPoints } from "./weekly-roster-utility.mjs";
import { scoreOffenseStatLine, scoreTeamDefenseStatLine, OFFENSE_SCORING } from "./player-intelligence.mjs";

// Public read-only Sleeper actuals. Registered source "sleeper" (injury_and_identity /
// weekly actuals cross-check). Season-scoped weekly box-score stats keyed by Sleeper id.
export const SLEEPER_STATS_URL = (season, week) =>
  `https://api.sleeper.app/v1/stats/nfl/regular/${season}/${week}`;

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function num(value) {
  return finite(value) ? Number(value) : 0;
}

// --- Sleeper -> exact league-schema stat lines. Field names never redefine scoring. ---

export function sleeperOffenseLine(stats) {
  return {
    passingCompletions: stats.pass_cmp,
    passingYards: stats.pass_yd,
    passingTouchdowns: stats.pass_td,
    interceptions: stats.pass_int,
    rushingYards: stats.rush_yd,
    rushingTouchdowns: stats.rush_td,
    rushingHundredYardGames: num(stats.rush_yd) >= 100 ? 1 : 0,
    receptions: stats.rec,
    receivingYards: stats.rec_yd,
    receivingTouchdowns: stats.rec_td,
    receivingHundredYardGames: num(stats.rec_yd) >= 100 ? 1 : 0,
    returnYards: num(stats.kr_yd) + num(stats.pr_yd),
    returnTouchdowns: num(stats.kr_td) + num(stats.pr_td),
    twoPointConversions: num(stats.pass_2pt) + num(stats.rush_2pt) + num(stats.rec_2pt),
    fumblesLost: stats.fum_lost,
  };
}

export function sleeperIdpLine(stats) {
  return {
    soloTackles: stats.idp_tkl_solo,
    assistedTackles: stats.idp_tkl_ast,
    sacks: stats.idp_sack,
    interceptions: stats.idp_int,
    forcedFumbles: stats.idp_ff,
    fumbleRecoveries: stats.idp_fum_rec,
    touchdowns: stats.idp_def_td,
    safeties: stats.idp_safe,
    passesDefended: stats.idp_pass_def,
    blockedKicks: stats.idp_blk_kick,
    tacklesForLoss: stats.idp_tkl_loss,
    turnoverReturnYards: num(stats.idp_int_ret_yd) + num(stats.idp_fum_ret_yd),
  };
}

export function sleeperKickerLine(stats) {
  return {
    fieldGoalsMade: stats.fgm,
    extraPointsMade: stats.xpm,
    // xpmiss is not published directly; derive misses from attempts vs makes.
    extraPointsMissed: Math.max(0, num(stats.xpa) - num(stats.xpm)),
  };
}

// Sleeper team-defense weekly box score -> exact league DST stat line. Team defenses are keyed in
// the Sleeper stats map by NFL team abbreviation (e.g. "NE"). The pointsAllowed* fields are
// Sleeper's own mutually-exclusive one-hot band flags, whose bands (0 / 1-6 / 7-13 / 14-20 /
// 21-27 / 28-34 / 35+) match the league bands exactly. Sleeper's generic team `td` total is
// deliberately NOT scored — only `def_td` (defensive TDs) and kick/punt return TDs are; Sleeper's
// own default DST score (`pts_std`) adds bonus categories the league does not use and is never read.
export function sleeperTeamDefenseLine(stats) {
  if (!stats || typeof stats !== "object") return null;
  return {
    sacks: num(stats.sack),
    interceptions: num(stats.int),
    fumbleRecoveries: num(stats.fum_rec) + num(stats.def_st_fum_rec),
    defensiveTouchdowns: num(stats.def_td) + num(stats.def_st_td),
    safeties: num(stats.safe),
    blockedKicks: num(stats.blk_kick),
    returnTouchdowns: num(stats.def_kr_td) + num(stats.def_pr_td),
    extraPointReturns: 0, // no distinct Sleeper field; scored 0 (did not occur), never fabricated
    pointsAllowed0: num(stats.pts_allow_0) > 0 ? 1 : 0,
    pointsAllowed1To6: num(stats.pts_allow_1_6) > 0 ? 1 : 0,
    pointsAllowed7To13: num(stats.pts_allow_7_13) > 0 ? 1 : 0,
    pointsAllowed14To20: num(stats.pts_allow_14_20) > 0 ? 1 : 0,
    pointsAllowed21To27: num(stats.pts_allow_21_27) > 0 ? 1 : 0,
    pointsAllowed28To34: num(stats.pts_allow_28_34) > 0 ? 1 : 0,
    pointsAllowed35Plus: num(stats.pts_allow_35p) > 0 ? 1 : 0,
  };
}

// Week-1 league-scored DST mean across every NFL team defense present in the capture (the full
// 32-team population). This is the shrinkage target for the one-game DST signal: derived from the
// actuals under the exact league rules, not fabricated, and independent of any Yahoo number. Team
// defenses are the abbreviation-keyed entries (e.g. "NE"); the "TEAM_*" duplicates and numeric
// player ids are skipped by requiring a pts_allow field.
export function teamDefenseWeek1LeagueMean(sleeperStats) {
  const scores = [];
  for (const [key, value] of Object.entries(sleeperStats ?? {})) {
    if (!/^[A-Z]{2,3}$/.test(key) || !value || value.pts_allow === undefined) continue;
    scores.push(scoreTeamDefenseStatLine(sleeperTeamDefenseLine(value)));
  }
  const mean = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null;
  return { mean, sampledTeams: scores.length };
}

const SLEEPER_ADAPTERS = {
  offense: sleeperOffenseLine,
  idp: sleeperIdpLine,
  kicker: sleeperKickerLine,
  teamdef: sleeperTeamDefenseLine,
};

export function week1LineFor(scoringKind, stats) {
  if (!stats || typeof stats !== "object") return null;
  const adapter = SLEEPER_ADAPTERS[String(scoringKind ?? "offense").toLowerCase()];
  return adapter ? adapter(stats) : null;
}

const OFFENSE_POSITIONS = new Set(["QB", "RB", "WR", "TE", "FB"]);

/**
 * Split a Sleeper Week-1 offense line into passing / rushing / receiving points under the exact
 * league scoring, plus an "other" remainder (returns, 2pt, fumbles) the opportunity model does
 * not attempt to explain, and the raw volume (dropbacks / carries / targets) behind each channel.
 * `passing + rushing + receiving + other` equals the full league-scored line by construction.
 */
export function offenseWeek1Channels(stats) {
  if (!stats || typeof stats !== "object") return null;
  const line = sleeperOffenseLine(stats);
  const full = scoreOffenseStatLine(line, OFFENSE_SCORING);
  const passing = scoreOffenseStatLine({
    passingCompletions: line.passingCompletions,
    passingYards: line.passingYards,
    passingTouchdowns: line.passingTouchdowns,
    interceptions: line.interceptions,
  }, OFFENSE_SCORING);
  const rushing = scoreOffenseStatLine({
    rushingYards: line.rushingYards,
    rushingTouchdowns: line.rushingTouchdowns,
    rushingHundredYardGames: line.rushingHundredYardGames,
  }, OFFENSE_SCORING);
  const receiving = scoreOffenseStatLine({
    receptions: line.receptions,
    receivingYards: line.receivingYards,
    receivingTouchdowns: line.receivingTouchdowns,
    receivingHundredYardGames: line.receivingHundredYardGames,
  }, OFFENSE_SCORING);
  return {
    line,
    full,
    passing,
    rushing,
    receiving,
    other: full - passing - rushing - receiving,
    passAttempts: num(stats.pass_att),
    carries: num(stats.rush_att),
    targets: num(stats.rec_tgt),
  };
}

/**
 * League-average points-per-opportunity by position, derived from the Week-1 actuals of the
 * board universe (every rostered/candidate offense player with a Sleeper Week-1 line). The rates
 * are computed from the same actuals we project — no external or fabricated constant.
 */
export function buildOpportunityRates(board, sleeperStats) {
  const lines = [];
  for (const player of board.players ?? []) {
    const position = String(player.position ?? "").toUpperCase();
    if (!OFFENSE_POSITIONS.has(position)) continue;
    const stats = player.sleeperId == null ? null : sleeperStats[String(player.sleeperId)];
    const channels = offenseWeek1Channels(stats);
    if (!channels) continue;
    lines.push({
      position,
      passAttempts: channels.passAttempts,
      carries: channels.carries,
      targets: channels.targets,
      passingPoints: channels.passing,
      rushingPoints: channels.rushing,
      receivingPoints: channels.receiving,
    });
  }
  return { rates: deriveOpportunityRates(lines), sampledPlayers: lines.length };
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// The Sleeper capture receipt records when the source was ACTUALLY acquired — never the report
// generation time. A live fetch stamps the real fetch instant and writes a sidecar receipt so a
// later offline replay can recover that same instant. An offline replay reads the sidecar receipt
// and requires its period/hash to match. Report generatedAt never flows into this receipt.
export async function loadSleeperWeek({ sleeperPath, season, week, capturedAt, outDir }) {
  if (sleeperPath) {
    const text = await readFile(sleeperPath, "utf8");
    const contentSha256 = sha256(text);
    let sidecar = null;
    try {
      sidecar = JSON.parse(await readFile(`${sleeperPath}.receipt.json`, "utf8"));
    } catch {
      sidecar = null;
    }
    if (!sidecar || sidecar.contentSha256 !== contentSha256 || !sidecar.retrievedAt) {
      throw new Error("offline replay requires a matching source capture receipt");
    }
    if (Number(sidecar.season) !== season || Number(sidecar.week) !== week) {
      throw new Error("source capture season/week does not match requested period");
    }
    {
      return {
        stats: JSON.parse(text),
        receipt: {
          sourceId: "sleeper", sourceFamily: "sleeper", season, week,
          retrievedFrom: sleeperPath, retrievedAt: sidecar.retrievedAt,
          contentSha256, captureMode: "OFFLINE_REPLAY_WITH_RECEIPT",
          url: sidecar.url ?? null,
        },
      };
    }
  }
  const url = SLEEPER_STATS_URL(season, week);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`sleeper fetch failed ${response.status} for ${url}`);
  const text = await response.text();
  const stats = JSON.parse(text);
  const contentSha256 = sha256(text);
  const sourcesDir = join(outDir, "sources");
  await mkdir(sourcesDir, { recursive: true });
  const capturePath = join(sourcesDir, `sleeper-${season}-week${week}-stats.json`);
  await writeFile(capturePath, text, { mode: 0o600 });
  const receipt = {
    sourceId: "sleeper", sourceFamily: "sleeper", season, week, url,
    retrievedAt: capturedAt, contentSha256, capturePath, captureMode: "LIVE_FETCH",
  };
  // Sidecar receipt so a later offline replay recovers the true capture instant.
  await writeFile(`${capturePath}.receipt.json`, `${JSON.stringify({ sourceId: "sleeper", season, week, url, retrievedAt: capturedAt, contentSha256 }, null, 2)}\n`, { mode: 0o600 });
  return { stats, receipt };
}

/**
 * Assemble the Week-N custom projection report from: the pre-season custom board (prior),
 * public Sleeper Week-(N-1) actuals scored under league rules (update), and the coordinator
 * comparison/context snapshot. Yahoo weekly numbers stay comparison-only.
 */
export async function buildWeeklyRefresh({
  rosterInputs,
  board,
  sleeperStats,
  opportunityRates,
  teamDefenseMean,
  week1Weight,
  opportunityShare,
  targetWeek,
  generatedAt,
  provenance,
}) {
  const boardById = new Map((board.players ?? []).map((player) => [String(player.yahooId), player]));
  const modelPlayers = [];
  const identityGaps = [];
  for (const input of rosterInputs.players ?? []) {
    const yahooId = String(input.yahooId);
    const boardPlayer = boardById.get(yahooId);
    if (!boardPlayer) {
      identityGaps.push({ yahooId, reason: "not found in prior board" });
      continue;
    }
    const scoringKind = String(input.scoringKind ?? "offense").toLowerCase();
    const isTeamDef = scoringKind === "teamdef";
    const sleeperId = boardPlayer.sleeperId == null ? null : String(boardPlayer.sleeperId);
    const stats = sleeperId ? sleeperStats[sleeperId] : null;
    // Team defenses: score the Week-1 DST line under the exact league rules. Offense/IDP/kicker use
    // their own adapters. Opportunity-anchored decomposition only applies to offense skill volume;
    // IDP/kicker/teamdef have no volume model and use the observed league-scored result directly.
    const week1StatLine = week1LineFor(scoringKind, stats);
    const channels = scoringKind === "offense" ? offenseWeek1Channels(stats) : null;
    const week1OpportunityPoints = channels && opportunityRates
      ? opportunityExpectedPoints({
          position: boardPlayer.position,
          passAttempts: channels.passAttempts,
          carries: channels.carries,
          targets: channels.targets,
          otherPoints: channels.other,
        }, opportunityRates)
      : null;
    // Team defenses have NO legitimate per-team custom prior: the draft board's DEF perGamePoints is
    // a single-source Yahoo season projection. Using it would substitute Yahoo as our model, so it is
    // excluded (kept only for transparency). Instead the noisy one-game DST signal is regressed toward
    // the Week-1 league DST mean (derived from the actuals, not fabricated) via the same week1Weight.
    const priorPerGame = isTeamDef
      ? (finite(teamDefenseMean) ? Number(teamDefenseMean) : null)
      : (finite(boardPlayer.perGamePoints) ? Number(boardPlayer.perGamePoints) : null);
    modelPlayers.push({
      playerId: yahooId,
      name: boardPlayer.name,
      position: boardPlayer.position,
      team: boardPlayer.team,
      group: input.group ?? null,
      opponent: input.opponent ?? null,
      priorPerGame,
      priorBasis: isTeamDef ? "WEEK1_LEAGUE_DST_MEAN" : "PRESEASON_MULTI_SOURCE_BLEND",
      excludedYahooSeasonPrior: isTeamDef && finite(boardPlayer.perGamePoints) ? Number(boardPlayer.perGamePoints) : null,
      scoringKind,
      week1StatLine,
      week1OpportunityPoints,
      week1Opportunity: channels
        ? { passAttempts: channels.passAttempts, carries: channels.carries, targets: channels.targets, otherPoints: Number(channels.other.toFixed(4)) }
        : null,
      week1SourceStatus: isTeamDef
        ? (stats ? "SLEEPER_WEEK1_DST_ACTUAL" : "NO_WEEK1_RECORD")
        : (stats ? "SLEEPER_WEEK1_ACTUAL" : "NO_WEEK1_RECORD"),
      availabilityStatus: input.availabilityStatus ?? null,
      availabilityProbability: input.availabilityProbability ?? null,
      yahooWeek2Projection: input.yahooWeek2Projection ?? null,
    });
  }

  const report = buildWeeklyProjectionReport({
    players: modelPlayers,
    week1Weight,
    opportunityShare,
    generatedAt,
    targetWeek,
    provenance,
  });

  // Re-attach group / opponent / week1 source status onto the projected rows for the report.
  const contextById = new Map(modelPlayers.map((player) => [player.playerId, player]));
  const players = report.players.map((row) => {
    const context = contextById.get(row.playerId) ?? {};
    return {
      ...row,
      group: context.group ?? null,
      week1SourceStatus: context.week1SourceStatus ?? null,
      week1Opportunity: context.week1Opportunity ?? null,
      priorBasis: context.priorBasis ?? null,
      excludedYahooSeasonPrior: context.excludedYahooSeasonPrior ?? null,
    };
  });
  return { ...report, players, identityGaps };
}

function renderMarkdown(report) {
  const money = (value) => (value == null ? "—" : Number(value).toFixed(2));
  const groups = [
    ["roster", "Roster (starters + bench)"],
    ["available-flex", "Available flex candidates"],
    ["available-def", "Available team defenses"],
  ];
  const week1 = report.provenance?.week1 ?? {};
  const lines = [];
  lines.push(`# SKRODZKai custom Week ${report.targetWeek} projection`);
  lines.push("");
  lines.push(`Report generated ${report.generatedAt}. ${report.posture}.`);
  lines.push("");
  lines.push("Custom number = pre-season multi-source prior updated by an OPPORTUNITY-anchored Week 1 signal.");
  lines.push(`Week-1 signal = ${report.opportunityShare} × opportunity expectation (volume valued at league-average points/opportunity) + ${(1 - report.opportunityShare).toFixed(2)} × observed league-scored result; then blended ${report.week1Weight} Week-1 / ${(1 - report.week1Weight).toFixed(2)} prior. Weights are documented, uncalibrated model choices. Yahoo column is comparison only.`);
  lines.push("");
  lines.push("Provenance:");
  lines.push(`- Prior: ${report.provenance?.prior?.path ?? "n/a"} (generatedAt ${report.provenance?.prior?.generatedAt ?? "n/a"})`);
  lines.push(`- Week 1 actuals: ${week1.sourceId ?? "n/a"} season ${week1.season ?? "?"} week ${week1.week ?? "?"} — capture ${week1.captureMode ?? "n/a"}, source retrievedAt ${week1.retrievedAt ?? (week1.captureObservedMtime ? `unknown (file mtime ${week1.captureObservedMtime})` : "n/a")}, sha256 ${String(week1.contentSha256 ?? "").slice(0, 12)}`);
  lines.push(`  (source acquisition time is recorded separately from report generation time and is never backdated to it)`);
  lines.push(`- Comparison/context: ${report.provenance?.comparison ?? "n/a"}`);
  const teamDef = report.provenance?.teamDefense ?? {};
  lines.push(`- Team defense: each defense's Week-1 DST line scored under the EXACT league DST rules, then regressed to the Week-1 league DST mean ${money(teamDef.week1LeagueMean)} across ${teamDef.sampledTeams ?? "?"} defenses; the draft-board single-source Yahoo DEF prior is EXCLUDED (${teamDef.priorBasis ?? "n/a"}). One-game defensive form, NOT a calibrated projection.`);
  lines.push("");
  lines.push("Coverage: " + Object.entries(report.coverage).map(([k, v]) => `${k}=${v}`).join(", "));
  lines.push("");
  lines.push("Unavailable inputs (not fabricated): Week 2 opponent-strength matchup factor held at neutral 1.0 — no Week-2 opponent-strength/implied-total source was captured, and one game cannot establish opponent strength. No 2026 weekly outcome calibration exists — the blend weights are documented, uncalibrated model choices. Team defenses have no legitimate per-team custom prior (draft-board DEF is a single-source Yahoo season projection, excluded); their Custom Wk2 is a one-game Week-1 DST form read regressed to the Week-1 league mean — see the team-defense sections.");
  lines.push("");
  for (const [group, title] of groups) {
    const rows = report.players.filter((row) => row.group === group);
    if (!rows.length) continue;
    lines.push(`## ${title}`);
    lines.push("");
    const available = [...rows].filter((row) => row.weeklyProjectionAvailable)
      .sort((a, b) => (b.weeklyExpectation ?? -1) - (a.weeklyExpectation ?? -1));
    const priorOnly = [...rows].filter((row) => !row.weeklyProjectionAvailable)
      .sort((a, b) => (b.priorPerGame ?? -1) - (a.priorPerGame ?? -1));
    if (group === "available-def") {
      const mean = money(report.provenance?.teamDefense?.week1LeagueMean);
      lines.push(`**Custom Wk2 for defenses = each team's Week-1 DST line scored under the EXACT league rules, regressed toward the`);
      lines.push(`Week-1 league DST mean (${mean}) at weight ${report.week1Weight}.** For DEF the "Prior/g" column IS that league mean (the`);
      lines.push("shrinkage target), NOT a per-team season prior — the draft-board Yahoo DEF projection is deliberately excluded from");
      lines.push("the custom number and appears only in the Yahoo Wk2 column. This is a ONE-GAME defensive-form comparison, high");
      lines.push("variance, with NO opponent matchup factor — a lean, not a calibrated Week-2 projection. Read the Patriots vs these");
      lines.push("available defenses on the Custom Wk2 column with that caveat.");
      lines.push("");
    }
    lines.push("| Player | Pos | Prior/g | Wk1 (league) | Wk1 signal | Custom Wk2 | Yahoo Wk2 | Δ vs Yahoo | Confidence | Notes |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    const flagsFor = (row) => {
      const flags = [];
      if (row.week1SourceStatus === "SLEEPER_WEEK1_DST_ACTUAL") flags.push("DST: Wk1 actual → regressed to Wk1 league mean; 1 game; no matchup");
      if (row.week1SourceStatus === "NO_WEEK1_RECORD") flags.push("no Wk1 record");
      if (row.availabilityBasis === "UNCERTAIN_FLAGGED_NO_DISCOUNT") flags.push(`${row.availabilityStatus.toLowerCase()} (flagged, no haircut)`);
      else if (row.availabilityProbability < 1) flags.push(`${row.availabilityStatus.toLowerCase()} x${row.availabilityProbability}`);
      return flags.join("; ");
    };
    for (const row of available) {
      lines.push(`| ${row.name} | ${row.position} | ${money(row.priorPerGame)} | ${money(row.week1Points)} | ${money(row.week1Signal)} | **${money(row.weeklyExpectation)}** | ${money(row.yahooWeek2Projection)} | ${money(row.deltaVsYahoo)} | ${row.confidence} | ${flagsFor(row)} |`);
    }
    for (const row of priorOnly) {
      lines.push(`| ${row.name} | ${row.position} | ${money(row.priorPerGame)} | ${money(row.week1Points)} | — | — unavailable | ${money(row.yahooWeek2Projection)} | — | ${row.confidence} | ${["weekly projection unavailable", flagsFor(row)].filter(Boolean).join("; ")} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  return Object.fromEntries(argv.map((entry) => {
    const [key, ...value] = entry.replace(/^--/, "").split("=");
    return [key, value.length ? value.join("=") : true];
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const key of ["roster", "board", "out"]) {
    if (!args[key]) throw new Error(`missing --${key}`);
  }
  const season = Number(args.season ?? 2026);
  const targetWeek = Number(args["target-week"] ?? 2);
  const sleeperWeek = Number(args["sleeper-week"] ?? targetWeek - 1);
  if (!Number.isInteger(season) || season < 2000 || !Number.isInteger(targetWeek) ||
      targetWeek < 2 || targetWeek > 17 || !Number.isInteger(sleeperWeek) ||
      sleeperWeek < 1 || sleeperWeek >= targetWeek) {
    throw new Error("observed source week must precede target week (2 through 17)");
  }
  const week1Weight = args["week1-weight"] != null ? Number(args["week1-weight"]) : undefined;
  const opportunityShare = args["opportunity-share"] != null ? Number(args["opportunity-share"]) : undefined;
  // Report generation time. Kept strictly separate from the source acquisition time: --generated-at
  // controls only this, and it never backdates the Sleeper capture receipt's retrievedAt.
  const generatedAt = args["generated-at"] ?? new Date().toISOString();
  // Real source-acquisition instant, used ONLY on a live fetch. Offline replay ignores it.
  const capturedAt = new Date().toISOString();

  const [rosterInputs, board] = await Promise.all([
    readFile(args.roster, "utf8").then(JSON.parse),
    readFile(args.board, "utf8").then(JSON.parse),
  ]);
  const { stats: sleeperStats, receipt } = await loadSleeperWeek({
    sleeperPath: args.sleeper || null,
    season,
    week: sleeperWeek,
    capturedAt,
    outDir: args.out,
  });

  const { rates: opportunityRates, sampledPlayers } = buildOpportunityRates(board, sleeperStats);
  const { mean: teamDefenseMean, sampledTeams: teamDefenseSampledTeams } = teamDefenseWeek1LeagueMean(sleeperStats);

  const provenance = {
    prior: { path: args.board, generatedAt: board.generatedAt ?? null, leagueId: board.leagueId ?? null, scoringModel: board.scoringModel ?? null, note: "pre-season custom multi-source per-game blend; legitimate prior, pre-Week1" },
    week1: receipt,
    comparison: `${args.roster} (${rosterInputs.sourceNote ?? "coordinator snapshot"})`,
    opportunityRates: {
      basis: `league-average points-per-opportunity by position, from Week-1 actuals of ${sampledPlayers} board-universe offense players (derived from actuals, not fabricated)`,
      ratesByPosition: opportunityRates.ratesByPosition,
      overall: opportunityRates.overall,
      minSample: opportunityRates.minSample,
    },
    teamDefense: {
      week1LeagueMean: teamDefenseMean,
      sampledTeams: teamDefenseSampledTeams,
      priorBasis: "REGRESSED_TO_WEEK1_LEAGUE_MEAN",
      scoringSource: "analysis/player-intelligence.mjs TEAM_DEFENSE_SCORING — exact league DST rules (Sack 1, INT 1, Fumble Recovery 2, Def TD 6, Safety 2, Block Kick 2, Kick/Punt Return TD 6, Extra Point Returned 2; Points Allowed 0/1-6/7-13/14-20/21-27/28-34/35+ = 10/7/4/2/0/-1/-4), authoritatively captured in tests/fixtures/real-league-settings.mjs",
      note: "no legitimate per-team custom prior exists for team defense: the draft board DEF perGamePoints is a single-source Yahoo season projection, EXCLUDED here to avoid substituting Yahoo as our model. Each defense's Week-1 DST line is scored under the exact league rules (Sleeper weekly buckets) and regressed toward the Week-1 league DST mean; one-game defensive-form comparison, uncalibrated, with NO matchup factor — not a calibrated Week-2 projection. Sleeper's generic team `td` total and its own default DST score are never used.",
    },
    matchup: {
      status: "UNSOURCED_NEUTRAL",
      note: "no Week-2 opponent-strength / implied-total source was captured, and one game cannot establish opponent strength; matchupFactor held at neutral 1.0 for every row. Opponent identity is recorded where the snapshot supplied it, with no quantitative adjustment.",
    },
  };

  const report = await buildWeeklyRefresh({
    rosterInputs,
    board,
    sleeperStats,
    opportunityRates,
    teamDefenseMean,
    week1Weight: week1Weight ?? undefined,
    opportunityShare: opportunityShare ?? undefined,
    targetWeek,
    generatedAt,
    provenance,
  });

  await mkdir(args.out, { recursive: true });
  const jsonPath = join(args.out, `week${targetWeek}-custom-projection.json`);
  const mdPath = join(args.out, `week${targetWeek}-custom-projection.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await writeFile(mdPath, `${renderMarkdown(report)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ jsonPath, mdPath, coverage: report.coverage, identityGaps: report.identityGaps.length })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exit(1);
  });
}
