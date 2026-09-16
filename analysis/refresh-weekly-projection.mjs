import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { buildWeeklyProjectionReport, deriveOpportunityRates, opportunityExpectedPoints, scoreWeeklyLeaguePoints, assignFullRanks } from "./weekly-roster-utility.mjs";
import { scoreOffenseStatLine, scoreTeamDefenseStatLine, OFFENSE_SCORING } from "./player-intelligence.mjs";
import { scoreHistoricalStatRow } from "./historical-player-calibration.mjs";
import { parseCsv } from "./opponent-calibration.mjs";

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

// ============================================================================================
// Full-universe weekly rankings: the whole prior board (every offense/K/IDP + 32 DEF) PLUS
// relevant active players who are missing from the pre-season board, each ranked overall and by
// position. Generalizes the roster-shortlist path to every completed week (no hardcoded "Week 1")
// with a genuinely sourced schedule, current injury/team status, and stable-id dedupe.
// ============================================================================================

// ESPN uses WSH for Washington; the board and Sleeper use WAS (the only mismatch observed across
// all 32 teams). A couple of other historical aliases are normalized defensively.
const TEAM_ALIASES = Object.freeze({ WSH: "WAS", JAC: "JAX", LA: "LAR", SL: "LAR", OAK: "LV", SD: "LAC" });
export function normalizeTeam(team) {
  if (team == null || team === "") return null;
  const upper = String(team).toUpperCase();
  return TEAM_ALIASES[upper] ?? upper;
}

const IDP_POSITIONS = new Set(["DL", "LB", "DB", "S", "CB", "DE", "DT", "NT", "ILB", "OLB", "EDGE", "SS", "FS", "MLB"]);
const SCORED_POSITIONS = new Set([...OFFENSE_POSITIONS, "K", "PK", "DEF", "DST", ...IDP_POSITIONS]);

export function scoringKindForPosition(position) {
  const pos = String(position ?? "").toUpperCase();
  if (pos === "DEF" || pos === "DST") return "teamdef";
  if (pos === "K" || pos === "PK") return "kicker";
  if (IDP_POSITIONS.has(pos)) return "idp";
  return "offense";
}

// Coarse position group for name-based two-way dedupe: every IDP position collapses to "IDP" so a
// board entry listed as S dedupes against the same player the Sleeper feed lists as DB. Offense/K
// stay specific. Used ONLY for the last-resort name key when no shared id (gsis/sleeper/yahoo) links
// a board row lacking cross-ids to its Sleeper twin.
export function positionGroup(position) {
  const pos = String(position ?? "").toUpperCase();
  if (IDP_POSITIONS.has(pos)) return "IDP";
  return pos;
}

// True when a Sleeper weekly stat row shows any league-scored volume (offense touches/attempts,
// IDP defensive activity, or kicker attempts). Used to gate "relevant" missing players so the
// universe never balloons with 0-activity depth entries, while still surfacing anyone who played.
export function hasScoredVolume(stats) {
  if (!stats || typeof stats !== "object") return false;
  const volume = num(stats.pass_att) + num(stats.rush_att) + num(stats.rec_tgt) + num(stats.rec) +
    num(stats.idp_tkl_solo) + num(stats.idp_tkl_ast) + num(stats.idp_sack) + num(stats.idp_int) +
    num(stats.idp_ff) + num(stats.idp_fum_rec) + num(stats.idp_pass_def) + num(stats.idp_tkl_loss) +
    num(stats.fga) + num(stats.fgm) + num(stats.xpa) + num(stats.xpm);
  return volume > 0;
}

/**
 * A player's per-game current-form signal aggregated across every completed week. `statsKey` is
 * the Sleeper stat key — a numeric player id for offense/idp/kicker, or a team abbreviation for
 * teamdef. Offense volume (attempts/carries/targets) is valued at the league opportunity rates;
 * idp/kicker/teamdef use the observed league-scored result. Returns per-game averages so the same
 * blend works for any target week; null when the entity has no completed-week line at all.
 */
export function completedWeeksSignal({ scoringKind, position, statsKey }, weekStatsList, opportunityRates) {
  const kind = String(scoringKind ?? "offense").toLowerCase();
  if (statsKey == null) return null;
  let games = 0;
  let sumObserved = 0;
  let sumPassAtt = 0;
  let sumCarries = 0;
  let sumTargets = 0;
  let sumOther = 0;
  for (const { stats } of weekStatsList) {
    const line = stats ? stats[statsKey] : null;
    if (!line) continue;
    if (kind === "teamdef") {
      if (line.pts_allow === undefined) continue;
      games += 1;
      sumObserved += scoreTeamDefenseStatLine(sleeperTeamDefenseLine(line));
      continue;
    }
    // Distinguish an ABSENT actual (no meaningful game record) from a real zero: only a line with
    // scored volume counts as a played game. A player credited with an all-zero row (inactive /
    // no touches) is treated as having no completed-game record for this position, not a 0.
    if (!hasScoredVolume(line)) continue;
    games += 1;
    if (kind === "offense") {
      const channels = offenseWeek1Channels(line);
      sumObserved += channels.full;
      sumPassAtt += channels.passAttempts;
      sumCarries += channels.carries;
      sumTargets += channels.targets;
      sumOther += channels.other;
    } else {
      sumObserved += scoreWeeklyLeaguePoints(week1LineFor(kind, line), kind);
    }
  }
  if (games === 0) return null;
  const perGameObserved = sumObserved / games;
  const perGameOther = sumOther / games;
  const opportunityPoints = kind === "offense" && opportunityRates
    ? opportunityExpectedPoints({
        position,
        passAttempts: sumPassAtt / games,
        carries: sumCarries / games,
        targets: sumTargets / games,
        otherPoints: perGameOther,
      }, opportunityRates)
    : null;
  return {
    games,
    week1Points: perGameObserved,
    week1OpportunityPoints: opportunityPoints,
    week1Opportunity: kind === "offense"
      ? { passAttempts: sumPassAtt / games, carries: sumCarries / games, targets: sumTargets / games, otherPoints: Number(perGameOther.toFixed(4)) }
      : null,
  };
}

// League-average points-per-opportunity from the board-universe offense players across every
// completed week (per-player volume/points summed first, so multi-week rates stay stable).
export function buildOpportunityRatesMultiWeek(board, weekStatsList) {
  const perPlayer = new Map();
  for (const { stats } of weekStatsList) {
    for (const player of board.players ?? []) {
      const position = String(player.position ?? "").toUpperCase();
      if (!OFFENSE_POSITIONS.has(position) || player.sleeperId == null) continue;
      const channels = offenseWeek1Channels(stats[String(player.sleeperId)]);
      if (!channels) continue;
      const key = String(player.sleeperId);
      if (!perPlayer.has(key)) {
        perPlayer.set(key, { position, passAttempts: 0, carries: 0, targets: 0, passingPoints: 0, rushingPoints: 0, receivingPoints: 0 });
      }
      const aggregate = perPlayer.get(key);
      aggregate.passAttempts += channels.passAttempts;
      aggregate.carries += channels.carries;
      aggregate.targets += channels.targets;
      aggregate.passingPoints += channels.passing;
      aggregate.rushingPoints += channels.rushing;
      aggregate.receivingPoints += channels.receiving;
    }
  }
  const lines = [...perPlayer.values()];
  return { rates: deriveOpportunityRates(lines), sampledPlayers: lines.length };
}

// Per-game league DST mean across every team defense in every completed week (the DST shrinkage
// target). Derived from actuals under the exact league rules; the Yahoo DEF prior is never used.
export function teamDefenseLeagueMeanMultiWeek(weekStatsList) {
  const scores = [];
  for (const { stats } of weekStatsList) {
    for (const [key, value] of Object.entries(stats ?? {})) {
      if (!/^[A-Z]{2,3}$/.test(key) || !value || value.pts_allow === undefined) continue;
      scores.push(scoreTeamDefenseStatLine(sleeperTeamDefenseLine(value)));
    }
  }
  const mean = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null;
  return { mean, sampledTeamWeeks: scores.length };
}

// Generic receipted JSON loader (offline replay requires a matching sidecar; live fetch writes the
// capture + sidecar). Mirrors loadSleeperWeek's receipt discipline for the new sources.
// Verify an offline-replay sidecar binds the SAME source and period the caller requested — not just
// a matching hash/time — so a replay can never relabel one source/period as another. A null
// requested season/week is a wildcard (e.g. the season-scoped players map has no week).
export function assertReceiptPeriod(sidecar, { sourceId, season, week }) {
  if (!sidecar || sidecar.contentSha256 == null || !sidecar.retrievedAt) {
    throw new Error(`offline replay requires a matching ${sourceId} capture receipt`);
  }
  if (sidecar.sourceId != null && String(sidecar.sourceId) !== String(sourceId)) {
    throw new Error(`capture receipt sourceId ${sidecar.sourceId} does not match requested ${sourceId}`);
  }
  if (season != null && sidecar.season != null && Number(sidecar.season) !== Number(season)) {
    throw new Error(`${sourceId} capture receipt season ${sidecar.season} does not match requested ${season}`);
  }
  if (week != null && sidecar.week != null && Number(sidecar.week) !== Number(week)) {
    throw new Error(`${sourceId} capture receipt week ${sidecar.week} does not match requested ${week}`);
  }
}

async function loadReceiptedJson({ path, url, sourceId, sourceFamily, season, week, capturedAt, outDir, captureName }) {
  if (path) {
    const text = await readFile(path, "utf8");
    const contentSha256 = sha256(text);
    let sidecar = null;
    try {
      sidecar = JSON.parse(await readFile(`${path}.receipt.json`, "utf8"));
    } catch {
      sidecar = null;
    }
    if (!sidecar || sidecar.contentSha256 !== contentSha256) {
      throw new Error(`offline replay requires a matching ${sourceId} capture receipt`);
    }
    assertReceiptPeriod(sidecar, { sourceId, season, week });
    return {
      payload: JSON.parse(text),
      receipt: {
        sourceId, sourceFamily, season, week, retrievedFrom: path, retrievedAt: sidecar.retrievedAt,
        contentSha256, captureMode: "OFFLINE_REPLAY_WITH_RECEIPT", url: sidecar.url ?? null,
      },
    };
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${sourceId} fetch failed ${response.status} for ${url}`);
  const text = await response.text();
  const payload = JSON.parse(text);
  const contentSha256 = sha256(text);
  const sourcesDir = join(outDir, "sources");
  await mkdir(sourcesDir, { recursive: true });
  const capturePath = join(sourcesDir, captureName);
  await writeFile(capturePath, text, { mode: 0o600 });
  await writeFile(`${capturePath}.receipt.json`, `${JSON.stringify({ sourceId, season, week, url, retrievedAt: capturedAt, contentSha256 }, null, 2)}\n`, { mode: 0o600 });
  return {
    payload,
    receipt: { sourceId, sourceFamily, season, week, url, retrievedAt: capturedAt, contentSha256, capturePath, captureMode: "LIVE_FETCH" },
  };
}

// Public first-party NFL schedule (opponent + kickoff + byes) from the ESPN scoreboard feed. Used
// for opponent identity and kickoff ONLY — never a fabricated opponent-strength factor.
export const ESPN_SCOREBOARD_URL = (season, week) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${week}&dates=${season}`;

// A real regular-season NFL week has 13-16 games (fewer during bye weeks, never below 12). Below
// this a capture is partial/broken and its absent teams must NOT be read as byes.
const MIN_SCHEDULE_GAMES = 12;

/**
 * Parse AND verify an ESPN scoreboard payload against the requested season/week. Throws on a period
 * mismatch (wrong-year/week capture) so a mislabeled schedule can never silently drive matchups or
 * byes. Only events that themselves carry the requested regular-season period are counted; byes are
 * trusted (`byeTrusted`) only when enough valid games are present, otherwise absent teams are left
 * as UNKNOWN opponent rather than fabricated byes.
 */
export function verifySchedulePayload(payload, { season, week }) {
  const payloadSeason = Number(payload?.season?.year);
  const payloadWeek = Number(payload?.week?.number);
  if (Number.isFinite(payloadSeason) && payloadSeason !== Number(season)) {
    throw new Error(`schedule payload season ${payloadSeason} does not match requested ${season}`);
  }
  if (Number.isFinite(payloadWeek) && payloadWeek !== Number(week)) {
    throw new Error(`schedule payload week ${payloadWeek} does not match requested ${week}`);
  }
  const byTeam = new Map();
  let gamesParsed = 0;
  for (const event of payload?.events ?? []) {
    if (Number(event?.season?.year) !== Number(season) || Number(event?.week?.number) !== Number(week)) continue;
    const competition = (event.competitions ?? [])[0];
    if (!competition) continue;
    const competitors = competition.competitors ?? [];
    if (competitors.length !== 2) continue;
    const kickoff = event.date ?? competition.date ?? null;
    const sides = competitors.map((competitor) => ({
      team: normalizeTeam(competitor.team?.abbreviation),
      homeAway: competitor.homeAway ?? null,
    }));
    if (!sides[0].team || !sides[1].team) continue;
    gamesParsed += 1;
    for (let index = 0; index < 2; index += 1) {
      const self = sides[index];
      const other = sides[1 - index];
      byTeam.set(self.team, { opponent: other.team, homeAway: self.homeAway, kickoff, gameId: event.id ?? null });
    }
  }
  if (gamesParsed === 0) throw new Error(`schedule payload contained no games for ${season} week ${week}`);
  const byeTrusted = gamesParsed >= MIN_SCHEDULE_GAMES;
  return { season: Number(season), week: Number(week), byTeam, teamsPlaying: new Set(byTeam.keys()), gamesParsed, byeTrusted };
}

export async function loadSchedule({ schedulePath, season, week, capturedAt, outDir }) {
  const { payload, receipt } = await loadReceiptedJson({
    path: schedulePath || null, url: ESPN_SCOREBOARD_URL(season, week),
    sourceId: "espn-schedule", sourceFamily: "espn", season, week, capturedAt, outDir,
    captureName: `espn-schedule-${season}-week${week}.json`,
  });
  const parsed = verifySchedulePayload(payload, { season, week });
  return {
    byTeam: parsed.byTeam,
    teamsPlaying: parsed.teamsPlaying,
    byeTrusted: parsed.byeTrusted,
    receipt: { ...receipt, gamesParsed: parsed.gamesParsed, byeTrusted: parsed.byeTrusted },
  };
}

// ---- Sourced, point-in-time opponent (matchup) adjustment from real scored history ----
//
// Built ONLY from completed seasons strictly before the target (no leakage), using the EXACT league
// scorers (scoreHistoricalStatRow) and real opponent identity (nflverse opponent_team). It is an
// uncalibrated recency prior: magnitudes are shrunk toward neutral by sample size and clamped, and
// every choice is documented — this is a measured lean, NOT a validated calibration.

// League DST points-allowed band value under the EXACT league rules (mirrors TEAM_DEFENSE_SCORING).
export function pointsAllowedBandValue(points) {
  const p = Number(points);
  if (!Number.isFinite(p)) return 0;
  if (p <= 0) return 10;
  if (p <= 6) return 7;
  if (p <= 13) return 4;
  if (p <= 20) return 2;
  if (p <= 27) return 0;
  if (p <= 34) return -1;
  return -4;
}

// Shrink a raw ratio toward 1.0 by observed sample, then clamp. A team with few games barely moves;
// a full sample approaches its measured ratio but never beyond the clamp band.
export function shrinkFactorToOne(rawFactor, games, shrinkGames, clampLow, clampHigh) {
  if (!Number.isFinite(rawFactor) || !(games > 0)) return 1;
  const weight = games / (games + shrinkGames);
  const shrunk = 1 + (rawFactor - 1) * weight;
  return Math.min(clampHigh, Math.max(clampLow, shrunk));
}

const MATCHUP_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K"]);
const MATCHUP_IDP_POSITIONS = new Set(["LB", "DB", "DL", "S", "CB", "DE", "DT", "NT", "ILB", "OLB", "EDGE", "SS", "FS", "MLB"]);

/**
 * Build the opponent-matchup provider from historical nflverse player stats + game scores.
 * Offense/K points are attributed to the DEFENSE faced (opponent_team); IDP points to the OFFENSE
 * faced; DEF uses each offense's actual scoring distribution mapped to the exact league
 * points-allowed bands (the dominant DST component; sacks/turnovers are NOT opponent-adjusted —
 * stated as a specific limitation, not hidden).
 */
export function buildOpponentMatchup({ seasonTexts, gamesText, dstBaselineMean, shrinkGames = 17, clampLow = 0.85, clampHigh = 1.15, defClampLow = 0.75, defClampHigh = 1.25 }) {
  const teamGames = new Map();            // team -> distinct season|week count (games played)
  const offenseAllowed = new Map();       // defenseTeam -> { POS -> points sum }
  const idpAllowed = new Map();           // offenseTeam -> points sum
  const leagueByPos = {};                 // POS -> points sum
  let leagueIdp = 0;
  const seasonsUsed = [];

  // Games played per team (both sides of every regular-season game in the window).
  const gameRows = parseCsv(gamesText);
  const bandByOffense = new Map();        // offenseTeam -> { bandSum, games }
  let leagueBandSum = 0;
  let leagueBandGames = 0;
  const windowSeasons = new Set();
  for (const { season } of seasonTexts) windowSeasons.add(Number(season));
  for (const row of gameRows) {
    if (!windowSeasons.has(Number(row.season)) || row.game_type !== "REG") continue;
    const week = Number(row.week);
    if (!Number.isInteger(week) || week < 1 || week > 17) continue;
    const away = normalizeTeam(row.away_team);
    const home = normalizeTeam(row.home_team);
    const awayScore = Number(row.away_score);
    const homeScore = Number(row.home_score);
    if (!away || !home || !Number.isFinite(awayScore) || !Number.isFinite(homeScore)) continue;
    for (const team of [away, home]) teamGames.set(team, (teamGames.get(team) ?? 0) + 1);
    // Each offense's own scoring -> the band a defense earns holding them to it.
    for (const [team, scored] of [[away, awayScore], [home, homeScore]]) {
      const band = pointsAllowedBandValue(scored);
      const entry = bandByOffense.get(team) ?? { bandSum: 0, games: 0 };
      entry.bandSum += band;
      entry.games += 1;
      bandByOffense.set(team, entry);
      leagueBandSum += band;
      leagueBandGames += 1;
    }
  }

  for (const { season, text } of seasonTexts) {
    seasonsUsed.push(Number(season));
    for (const row of parseCsv(text)) {
      if (Number(row.season) !== Number(season) || row.season_type !== "REG") continue;
      const opponent = normalizeTeam(row.opponent_team);
      if (!opponent) continue;
      for (const lane of scoreHistoricalStatRow(row)) {
        if (lane.scoringKind === "offense" && MATCHUP_POSITIONS.has(lane.position)) {
          const bucket = offenseAllowed.get(opponent) ?? {};
          bucket[lane.position] = (bucket[lane.position] ?? 0) + lane.points;
          offenseAllowed.set(opponent, bucket);
          leagueByPos[lane.position] = (leagueByPos[lane.position] ?? 0) + lane.points;
        } else if (lane.scoringKind === "kicker") {
          const bucket = offenseAllowed.get(opponent) ?? {};
          bucket.K = (bucket.K ?? 0) + lane.points;
          offenseAllowed.set(opponent, bucket);
          leagueByPos.K = (leagueByPos.K ?? 0) + lane.points;
        } else if (lane.scoringKind === "idp") {
          idpAllowed.set(opponent, (idpAllowed.get(opponent) ?? 0) + lane.points);
          leagueIdp += lane.points;
        }
      }
    }
  }

  const totalTeamGames = [...teamGames.values()].reduce((sum, value) => sum + value, 0);
  const leaguePerGameByPos = {};
  for (const [pos, sum] of Object.entries(leagueByPos)) leaguePerGameByPos[pos] = totalTeamGames ? sum / totalTeamGames : 0;
  const leagueIdpPerGame = totalTeamGames ? leagueIdp / totalTeamGames : 0;
  const leagueBandMean = leagueBandGames ? leagueBandSum / leagueBandGames : 0;

  const offenseFactor = (defenseTeam, position) => {
    const team = normalizeTeam(defenseTeam);
    const pos = String(position ?? "").toUpperCase();
    const games = teamGames.get(team) ?? 0;
    const leaguePos = leaguePerGameByPos[pos];
    const allowed = offenseAllowed.get(team)?.[pos];
    if (!team || !(games > 0) || !leaguePos || allowed == null) return { factor: 1, supported: false };
    const raw = (allowed / games) / leaguePos;
    return { factor: shrinkFactorToOne(raw, games, shrinkGames, clampLow, clampHigh), supported: true, games };
  };
  const idpFactor = (offenseTeam) => {
    const team = normalizeTeam(offenseTeam);
    const games = teamGames.get(team) ?? 0;
    const allowed = idpAllowed.get(team);
    if (!team || !(games > 0) || !leagueIdpPerGame || allowed == null) return { factor: 1, supported: false };
    const raw = (allowed / games) / leagueIdpPerGame;
    return { factor: shrinkFactorToOne(raw, games, shrinkGames, clampLow, clampHigh), supported: true, games };
  };
  const defFactor = (offenseTeam) => {
    const team = normalizeTeam(offenseTeam);
    const entry = bandByOffense.get(team);
    if (!team || !entry || !(entry.games > 0) || !(dstBaselineMean > 0)) return { factor: 1, supported: false };
    const bandMean = entry.bandSum / entry.games;
    const raw = 1 + (bandMean - leagueBandMean) / dstBaselineMean;
    return { factor: shrinkFactorToOne(raw, entry.games, shrinkGames, defClampLow, defClampHigh), supported: true, games: entry.games, component: "POINTS_ALLOWED_BAND_ONLY" };
  };

  return {
    offenseFactor,
    idpFactor,
    defFactor,
    meta: {
      seasonsUsed: seasonsUsed.sort(),
      totalTeamGames,
      teamsCovered: teamGames.size,
      leaguePerGameByPos,
      leagueIdpPerGame,
      leagueBandMean,
      dstBaselineMean,
      shrinkGames,
      clamp: { offense: [clampLow, clampHigh], def: [defClampLow, defClampHigh] },
      basis: "opponent-adjusted fantasy points from real scored nflverse history under the EXACT league scorers; offense vs the DEFENSE faced, IDP vs the OFFENSE faced, DEF from the OFFENSE's actual scoring mapped to the exact league points-allowed bands. Point-in-time (completed prior seasons only, no leakage). UNCALIBRATED magnitude: shrunk toward neutral by sample and clamped.",
      limitations: "DEF matchup adjusts ONLY the points-allowed component (dominant DST driver); opponent-specific sack/turnover/return-TD propensity is NOT modeled (no per-team historical DST components in the available first-party files). IDP matchup is aggregate defender production allowed by the opponent offense, not per-IDP-position. Kicker matchup uses opponent-defense kicker points allowed. Not validated against 2026 outcomes.",
    },
  };
}

export async function loadSleeperPlayersMap({ playersPath, season, capturedAt, outDir }) {
  const { payload, receipt } = await loadReceiptedJson({
    path: playersPath || null, url: "https://api.sleeper.app/v1/players/nfl",
    sourceId: "sleeper-players", sourceFamily: "sleeper", season, week: null, capturedAt, outDir,
    captureName: `sleeper-players-nfl-${season}.json`,
  });
  return { players: payload, receipt };
}

// Current injury/team status from the fresh Sleeper players map. Only the GENUINELY confirmed-out
// designations (Out / IR / PUP / NFI / Sus) map to a factual zero, and Questionable / Doubtful map
// to uncertain flags the model surfaces WITHOUT inventing any probability. Ambiguous Sleeper codes
// (NA, DNR, COV) and any unrecognized string are preserved raw and left as assumed-active rather
// than guessed into a zero — NA in particular co-occurs with status=Active (e.g. Josh Jacobs).
const SLEEPER_INJURY_STATUS_MAP = Object.freeze({
  Out: "OUT", IR: "IR", PUP: "PUP", NFI: "NFI", Sus: "SUSPENDED", Suspended: "SUSPENDED",
  Doubtful: "DOUBTFUL", Questionable: "QUESTIONABLE",
});
export function currentPlayerStatus(entry) {
  if (!entry || typeof entry !== "object") {
    return { hasEntry: false, availabilityStatus: null, rawInjuryStatus: null, sleeperStatus: null, currentTeam: null, yahooId: null, gsisId: null };
  }
  const raw = entry.injury_status ?? null;
  let availabilityStatus = null;
  if (raw && SLEEPER_INJURY_STATUS_MAP[raw]) availabilityStatus = SLEEPER_INJURY_STATUS_MAP[raw];
  else if (!raw && entry.status === "Active") availabilityStatus = "HEALTHY";
  return {
    hasEntry: true,
    availabilityStatus,
    rawInjuryStatus: raw,
    sleeperStatus: entry.status ?? null,
    currentTeam: entry.team ? normalizeTeam(entry.team) : null,
    yahooId: entry.yahoo_id != null ? String(entry.yahoo_id) : null,
    gsisId: entry.gsis_id != null ? String(entry.gsis_id) : null,
  };
}

const FULL_CONTEXT_FIELDS = [
  "universe", "group", "sleeperId", "priorBasis", "excludedYahooSeasonPrior", "week1Opportunity",
  "completedGames", "week1SourceStatus", "bye", "kickoff", "homeAway", "boardTeam", "currentTeam",
  "rawInjuryStatus", "sleeperStatus", "matchupFactor", "matchupStatus", "matchupSupported",
];

function playerNameKey(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

// Resolve the sourced opponent-strength factor for a row from its scoring side. Offense/kicker use
// the DEFENSE faced; IDP the OFFENSE faced; DEF the OFFENSE's points-allowed band. Absent an
// opponent or historical support the factor is neutral 1.0 (labeled, not fabricated).
function resolveMatchup(matchupProvider, { scoringKind, opponent, position }) {
  if (!matchupProvider || !opponent) {
    return { factor: 1, supported: false, status: opponent ? "OPPONENT_KNOWN_NO_HISTORY" : "OPPONENT_UNKNOWN_NEUTRAL" };
  }
  const result = scoringKind === "teamdef" ? matchupProvider.defFactor(opponent)
    : scoringKind === "idp" ? matchupProvider.idpFactor(opponent)
      : matchupProvider.offenseFactor(opponent, position);
  const status = !result.supported ? "OPPONENT_KNOWN_NO_HISTORY"
    : scoringKind === "teamdef" ? "OPPONENT_SOURCED_DEF_POINTS_ALLOWED_ONLY"
      : scoringKind === "idp" ? "OPPONENT_SOURCED_IDP_AGGREGATE"
        : "OPPONENT_SOURCED_HISTORICAL";
  return { factor: finite(result.factor) ? Number(result.factor) : 1, supported: Boolean(result.supported), status };
}

/**
 * Assemble the full-universe weekly rankings: every board player (offense/K/IDP + 32 DEF) plus
 * relevant active players missing from the pre-season board, each scored under the exact league
 * rules, blended prior->current-form, adjusted by a SOURCED opponent-matchup factor, then ranked
 * overall and by position. Every row gets an explicit disposition: a healthy, rostered player with
 * only a preseason prior is ranked ON that prior (weak-evidence label), never dropped; confirmed
 * inactive / no current team / target-week bye / no evidence are surfaced with reasons. Yahoo
 * numbers remain comparison-only.
 */
export function buildFullWeeklyRankings({
  board,
  rosterInputs,
  weekStatsList,
  playersMap,
  schedule,
  matchupProvider = null,
  opportunityRates,
  teamDefenseMean,
  week1Weight,
  opportunityShare,
  targetWeek,
  generatedAt,
  provenance,
}) {
  const rosterOverlay = new Map((rosterInputs?.players ?? []).map((player) => [String(player.yahooId), player]));
  const byeTrusted = schedule.byeTrusted !== false;
  // Two-way dedupe keys: a board player must not reappear as a "missing" row under any of their
  // identities (Yahoo id, Sleeper id, gsis id, or normalized name+position).
  const boardKeys = new Set();
  const addKey = (namespace, value) => { if (value != null && value !== "") boardKeys.add(`${namespace}:${String(value).toUpperCase()}`); };
  const seenBoardIdentity = new Set();
  const modelPlayers = [];
  const context = new Map();

  for (const player of board.players ?? []) {
    const playerId = player.yahooId != null ? String(player.yahooId) : (player.playerId != null ? String(player.playerId) : null);
    if (playerId == null) continue;
    const position = String(player.position ?? "").toUpperCase();
    const scoringKind = scoringKindForPosition(position);
    const isTeamDef = scoringKind === "teamdef";
    // Drop a board-internal duplicate: the same NFL player carried under two Yahoo ids (a two-way
    // alias) is one row. Canonical identity is gsis id, else sleeper id (both are per-player).
    const canonicalIdentity = player.gsisId ? `G:${player.gsisId}` : (player.sleeperId != null && !isTeamDef ? `S:${player.sleeperId}` : null);
    if (canonicalIdentity && seenBoardIdentity.has(canonicalIdentity)) continue;
    if (canonicalIdentity) seenBoardIdentity.add(canonicalIdentity);
    addKey("YID", player.yahooId);
    addKey("SID", player.sleeperId);
    addKey("GID", player.gsisId);
    if (!isTeamDef) addKey("NP", `${playerNameKey(player.name)}|${positionGroup(position)}`);
    const boardTeam = normalizeTeam(player.team);
    const statusInfo = isTeamDef
      ? { hasEntry: true, availabilityStatus: null, rawInjuryStatus: null, sleeperStatus: "Active", currentTeam: boardTeam }
      : currentPlayerStatus(player.sleeperId != null ? playersMap[String(player.sleeperId)] : null);
    // Prefer the current NFL team from the fresh identity feed (some board players changed teams
    // since the pre-season board). A fresh entry with no team = free agent now -> no current team.
    const noCurrentTeam = !isTeamDef && statusInfo.hasEntry && !statusInfo.currentTeam;
    const team = isTeamDef ? boardTeam : (statusInfo.currentTeam ?? (statusInfo.hasEntry ? null : boardTeam));
    const statsKey = isTeamDef ? team : (player.sleeperId != null ? String(player.sleeperId) : null);
    const signal = completedWeeksSignal({ scoringKind, position, statsKey }, weekStatsList, opportunityRates);
    const overlay = rosterOverlay.get(playerId) ?? null;
    const sched = team ? schedule.byTeam.get(team) ?? null : null;
    const onBye = byeTrusted && Boolean(team) && !schedule.byTeam.has(team);
    const opponent = sched?.opponent ?? null;
    const matchup = resolveMatchup(matchupProvider, { scoringKind, opponent, position });
    // Prior = the board's availability-adjusted per-week expectation for the TARGET week
    // (weeklyPoints[week-1]); this is the board's intended weekly figure (its healthy-games model)
    // and, unlike the raw perGamePoints = consensusPoints / expectedGames rate, does not inflate
    // deep backups whose season points are divided by a tiny expected-games count (e.g. a backup QB
    // with 29.6 pts over 1 expected game would otherwise read 29.55/g). Falls back to perGamePoints
    // only when no weekly array is present. DEF uses the league DST mean.
    const boardWeekly = Array.isArray(player.weeklyPoints) ? player.weeklyPoints[targetWeek - 1] : undefined;
    const priorPerGame = isTeamDef
      ? (finite(teamDefenseMean) ? Number(teamDefenseMean) : null)
      : (finite(boardWeekly) ? Number(boardWeekly) : (finite(player.perGamePoints) ? Number(player.perGamePoints) : null));
    modelPlayers.push({
      playerId,
      name: player.name,
      position: player.position,
      team,
      opponent,
      priorPerGame,
      scoringKind,
      week1Points: signal?.week1Points ?? null,
      week1OpportunityPoints: signal?.week1OpportunityPoints ?? null,
      matchupFactor: matchup.factor,
      matchupStatus: matchup.status,
      availabilityStatus: onBye ? "BYE" : (statusInfo.availabilityStatus ?? null),
      yahooWeek2Projection: overlay?.yahooWeek2Projection ?? null,
    });
    context.set(playerId, {
      universe: "board",
      group: overlay?.group ?? null,
      sleeperId: player.sleeperId != null ? String(player.sleeperId) : null,
      priorBasis: isTeamDef ? "WEEK_LEAGUE_DST_MEAN" : (finite(boardWeekly) ? "PRESEASON_WEEKLY_EXPECTATION" : "PRESEASON_PER_GAME_FALLBACK"),
      excludedYahooSeasonPrior: isTeamDef && finite(player.perGamePoints) ? Number(player.perGamePoints) : null,
      week1Opportunity: signal?.week1Opportunity ?? null,
      completedGames: signal?.games ?? 0,
      week1SourceStatus: signal ? (isTeamDef ? "SLEEPER_DST_ACTUAL" : "SLEEPER_ACTUAL") : "NO_COMPLETED_WEEK_RECORD",
      bye: onBye,
      kickoff: sched?.kickoff ?? null,
      homeAway: sched?.homeAway ?? null,
      boardTeam,
      currentTeam: isTeamDef ? boardTeam : statusInfo.currentTeam,
      rawInjuryStatus: statusInfo.rawInjuryStatus,
      sleeperStatus: statusInfo.sleeperStatus,
      matchupFactor: matchup.factor,
      matchupStatus: matchup.status,
      matchupSupported: matchup.supported,
      noCurrentTeam,
    });
  }

  // Relevant active players missing from the pre-season board: played a completed week, currently
  // rostered + active at a scored offense/K/IDP position, and not already on the board under ANY
  // identity. Stable id prefers a known Yahoo id, else the Sleeper id. Team defenses stay the 32.
  const usedIds = new Set(modelPlayers.map((player) => player.playerId));
  const seenMissing = new Set();
  let missingCount = 0;
  for (const { stats } of weekStatsList) {
    for (const key of Object.keys(stats ?? {})) {
      if (!/^[0-9]+$/.test(key) || seenMissing.has(key)) continue;
      const entry = playersMap[key];
      if (!entry || entry.active !== true || !entry.team) continue;
      const fantasyPositions = Array.isArray(entry.fantasy_positions) ? entry.fantasy_positions.map((pos) => String(pos).toUpperCase()) : [];
      const position = fantasyPositions.find((pos) => SCORED_POSITIONS.has(pos)) ?? String(entry.position ?? "").toUpperCase();
      if (!SCORED_POSITIONS.has(position)) continue;
      const scoringKind = scoringKindForPosition(position);
      if (scoringKind === "teamdef") continue;
      // Two-way dedupe against the board under every shared identity.
      if (boardKeys.has(`SID:${key.toUpperCase()}`) ||
          (entry.yahoo_id != null && boardKeys.has(`YID:${String(entry.yahoo_id).toUpperCase()}`)) ||
          (entry.gsis_id != null && boardKeys.has(`GID:${String(entry.gsis_id).toUpperCase()}`)) ||
          boardKeys.has(`NP:${playerNameKey(entry.full_name).toUpperCase()}|${positionGroup(position)}`)) continue;
      const signal = completedWeeksSignal({ scoringKind, position, statsKey: key }, weekStatsList, opportunityRates);
      if (!signal) continue;
      seenMissing.add(key);
      missingCount += 1;
      const team = normalizeTeam(entry.team);
      const sched = team ? schedule.byTeam.get(team) ?? null : null;
      const onBye = byeTrusted && Boolean(team) && !schedule.byTeam.has(team);
      const opponent = sched?.opponent ?? null;
      const matchup = resolveMatchup(matchupProvider, { scoringKind, opponent, position });
      const statusInfo = currentPlayerStatus(entry);
      let playerId = entry.yahoo_id != null && !usedIds.has(String(entry.yahoo_id)) ? String(entry.yahoo_id) : `sleeper:${key}`;
      if (usedIds.has(playerId)) playerId = `sleeper:${key}`;
      usedIds.add(playerId);
      modelPlayers.push({
        playerId,
        name: entry.full_name ?? (`${entry.first_name ?? ""} ${entry.last_name ?? ""}`.trim() || playerId),
        position,
        team,
        opponent,
        priorPerGame: null,
        scoringKind,
        week1Points: signal.week1Points,
        week1OpportunityPoints: signal.week1OpportunityPoints,
        matchupFactor: matchup.factor,
        matchupStatus: matchup.status,
        availabilityStatus: onBye ? "BYE" : (statusInfo.availabilityStatus ?? null),
        yahooWeek2Projection: null,
      });
      context.set(playerId, {
        universe: "missing-active",
        group: null,
        sleeperId: key,
        priorBasis: "NONE_NO_PRESEASON_PRIOR",
        excludedYahooSeasonPrior: null,
        week1Opportunity: signal.week1Opportunity,
        completedGames: signal.games,
        week1SourceStatus: "SLEEPER_ACTUAL",
        bye: onBye,
        kickoff: sched?.kickoff ?? null,
        homeAway: sched?.homeAway ?? null,
        boardTeam: null,
        currentTeam: statusInfo.currentTeam,
        rawInjuryStatus: statusInfo.rawInjuryStatus,
        sleeperStatus: statusInfo.sleeperStatus,
        matchupFactor: matchup.factor,
        matchupStatus: matchup.status,
        matchupSupported: matchup.supported,
        noCurrentTeam: false,
      });
    }
  }

  const report = buildWeeklyProjectionReport({
    players: modelPlayers,
    week1Weight,
    opportunityShare,
    generatedAt,
    targetWeek,
    provenance,
  });

  // Disposition: turn each scored row into a final weekly number + a rank basis, or an explicit
  // unrankable reason. A healthy, rostered player with only a preseason prior is ranked ON that
  // prior (never manufacturing observed volume); confirmed-inactive / no-team / bye / no-evidence
  // are surfaced with reasons. Matchup + availability multiply the baseline for every ranked row.
  const disposed = report.players.map((row) => {
    const ctx = context.get(row.playerId) ?? {};
    const merged = { ...row };
    for (const field of FULL_CONTEXT_FIELDS) merged[field] = ctx[field] ?? null;
    const baseline = finite(row.weeklyBaseline) ? Number(row.weeklyBaseline) : null;
    const availability = finite(row.availabilityProbability) ? Number(row.availabilityProbability) : 1;
    const matchupFactor = finite(ctx.matchupFactor) ? Number(ctx.matchupFactor) : 1;
    let unrankableReason = null;
    let weeklyExpectation = null;
    let rankBasis = null;
    if (availability <= 0) {
      unrankableReason = `CONFIRMED_INACTIVE_${String(row.availabilityStatus ?? "INACTIVE").toUpperCase()}`;
    } else if (ctx.noCurrentTeam) {
      unrankableReason = "NO_CURRENT_TEAM";
    } else if (ctx.bye) {
      unrankableReason = "TARGET_WEEK_BYE";
    } else if (baseline == null) {
      unrankableReason = "NO_PRIOR_OR_COMPLETED_WEEK_ACTUAL";
    } else {
      weeklyExpectation = baseline * matchupFactor * availability;
      rankBasis = row.confidence === "PRIOR_AND_WEEK1" ? "PRIOR_AND_FORM"
        : row.confidence === "WEEK1_ONLY" ? "CURRENT_FORM_NO_PRIOR"
          : "PRIOR_ONLY_NO_ACTUAL";
    }
    merged.weeklyExpectation = weeklyExpectation;
    merged.deltaVsYahoo = finite(row.yahooWeek2Projection) && weeklyExpectation != null
      ? weeklyExpectation - Number(row.yahooWeek2Projection) : null;
    merged.rankBasis = rankBasis;
    merged.unrankableReason = unrankableReason;
    return merged;
  });
  const players = assignFullRanks(disposed);

  // Audit: identity gaps, duplicate ids, roster coverage, DEF count, per-position/coverage tallies.
  const boardYahoo = new Set((board.players ?? []).map((player) => String(player.yahooId)));
  const identityGaps = (rosterInputs?.players ?? [])
    .filter((player) => !boardYahoo.has(String(player.yahooId)))
    .map((player) => ({ yahooId: String(player.yahooId), reason: "not found in prior board" }));
  const idCounts = new Map();
  for (const row of players) idCounts.set(row.playerId, (idCounts.get(row.playerId) ?? 0) + 1);
  const duplicateIds = [...idCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  const presentIds = new Set(players.map((row) => row.playerId));
  const rosterCoverageMissing = (rosterInputs?.players ?? [])
    .filter((player) => player.group === "roster")
    .map((player) => String(player.yahooId))
    .filter((id) => !presentIds.has(id));
  const positionCounts = players.reduce((counts, row) => {
    const pos = String(row.position ?? "UNK").toUpperCase();
    counts[pos] = (counts[pos] ?? 0) + 1;
    return counts;
  }, {});
  const rankableCount = players.filter((row) => row.rankable).length;
  const rankBasisCounts = players.filter((row) => row.rankable).reduce((counts, row) => {
    counts[row.rankBasis] = (counts[row.rankBasis] ?? 0) + 1;
    return counts;
  }, {});
  const unrankableReasons = players.filter((row) => !row.rankable).reduce((counts, row) => {
    counts[row.unrankableReason] = (counts[row.unrankableReason] ?? 0) + 1;
    return counts;
  }, {});
  const matchupApplied = players.filter((row) => row.rankable && row.matchupSupported).length;

  return {
    ...report,
    posture: "research projection only; no roster, Yahoo, or deployment authority",
    universe: {
      boardPlayersInput: (board.players ?? []).length,
      boardPlayers: players.filter((row) => row.universe === "board").length,
      missingActivePlayers: missingCount,
      totalRows: players.length,
      rankableRows: rankableCount,
      defenseRows: positionCounts.DEF ?? 0,
    },
    audit: {
      duplicateIds,
      duplicateIdCount: duplicateIds.length,
      rosterCoverageMissing,
      defenseCount: positionCounts.DEF ?? 0,
      positionCounts,
      coverage: report.coverage,
      rankBasisCounts,
      unrankableReasons,
      matchupApplied,
      identityGapCount: identityGaps.length,
    },
    identityGaps,
    players,
  };
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

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]
  ));
}

/**
 * Plain, dependency-free, click-to-sort HTML for the full weekly rankings. Ranked rows first
 * (sortable on every column), then a separate table of unrankable rows with explicit reasons so
 * nothing is silently dropped. No framework, no webapp rebuild — a single static file.
 */
export function renderFullRankingsHtml(report) {
  const money = (value) => (value == null || value === "" || !Number.isFinite(Number(value)) ? "" : Number(value).toFixed(2));
  const kickoff = (value) => (value ? escapeHtml(String(value).replace("T", " ").replace("Z", " UTC")) : "");
  const health = (row) => {
    const raw = row.rawInjuryStatus ? ` (${row.rawInjuryStatus})` : "";
    return escapeHtml(`${row.availabilityStatus ?? row.sleeperStatus ?? "—"}${raw}`);
  };
  const week1 = report.provenance?.week1List ?? [];
  const teamDef = report.provenance?.teamDefense ?? {};
  const matchup = report.provenance?.matchup ?? {};
  const ranked = report.players.filter((row) => row.rankable);
  const unranked = report.players.filter((row) => !row.rankable);
  const dataCell = (value) => `<td data-sort="${escapeHtml(value)}">${escapeHtml(value)}</td>`;
  const numCell = (value) => `<td class="num" data-sort="${value == null ? -1e9 : Number(value)}">${money(value)}</td>`;
  const rankedRow = (row) => `<tr>
    <td class="num" data-sort="${row.overallRank}">${row.overallRank}</td>
    <td class="num" data-sort="${row.positionRank}">${row.position}${row.positionRank}</td>
    ${dataCell(row.name ?? "")}
    ${dataCell(row.position ?? "")}
    ${dataCell(row.team ?? "")}
    ${dataCell(`${row.opponent ? (row.homeAway === "away" ? "@" : "vs ") + row.opponent : ""}`)}
    <td data-sort="${escapeHtml(row.kickoff ?? "")}">${kickoff(row.kickoff)}</td>
    ${numCell(row.weeklyExpectation)}
    ${numCell(row.priorPerGame)}
    ${numCell(row.week1Signal)}
    <td class="num" data-sort="${row.matchupFactor == null ? 1 : Number(row.matchupFactor)}">${row.matchupFactor == null ? "" : Number(row.matchupFactor).toFixed(3)}${row.matchupSupported ? "" : "*"}</td>
    ${numCell(row.yahooWeek2Projection)}
    ${numCell(row.deltaVsYahoo)}
    ${(() => { const h = health(row); return `<td data-sort="${h}">${h}</td>`; })()}
    ${dataCell(row.rankBasis ?? row.confidence ?? "")}
    <td class="num" data-sort="${row.completedGames ?? 0}">${row.completedGames ?? 0}</td>
    ${dataCell(row.universe ?? "")}
  </tr>`;
  const unrankedRow = (row) => `<tr>
    ${dataCell(row.name ?? "")}
    ${dataCell(row.position ?? "")}
    ${dataCell(row.team ?? "")}
    ${dataCell(row.unrankableReason ?? "")}
    ${numCell(row.priorPerGame)}
    ${(() => { const h = health(row); return `<td data-sort="${h}">${h}</td>`; })()}
    ${dataCell(row.universe ?? "")}
  </tr>`;
  const rankedHeaders = ["Ovr", "PosRk", "Player", "Pos", "Team", "Opp", "Kickoff", "Custom", "Prior/g", "Form", "Matchup", "Yahoo*", "Δ vs Yahoo", "Health", "Basis", "Gms", "Universe"];
  const rankedNumCols = new Set([0, 1, 7, 8, 9, 10, 11, 12, 15]);
  const unrankedHeaders = ["Player", "Pos", "Team", "Reason", "Prior/g", "Health", "Universe"];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SKRODZKai full custom Week ${escapeHtml(report.targetWeek)} rankings</title>
<style>
  :root { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
  body { margin: 1.2rem; color: #16202c; background: #f7f9fc; }
  h1 { font-size: 1.3rem; margin: 0 0 .3rem; }
  .meta { color: #4a5666; font-size: .82rem; line-height: 1.4; max-width: 60rem; }
  .meta code { background: #eef2f8; padding: .05rem .3rem; border-radius: 3px; }
  .counts { margin: .6rem 0; font-size: .85rem; }
  .counts b { color: #0b3d91; }
  input#filter { margin: .5rem 0; padding: .4rem .6rem; width: 20rem; max-width: 90%; border: 1px solid #c3ccd8; border-radius: 5px; }
  table { border-collapse: collapse; width: 100%; background: #fff; font-size: .82rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  th, td { padding: .32rem .5rem; border-bottom: 1px solid #eef1f5; text-align: left; white-space: nowrap; }
  th { position: sticky; top: 0; background: #0b3d91; color: #fff; cursor: pointer; user-select: none; font-weight: 600; }
  th:hover { background: #135; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tbody tr:nth-child(even) { background: #fafbfe; }
  tbody tr:hover { background: #eef6ff; }
  .section { margin-top: 1.6rem; }
  caption { text-align: left; font-weight: 600; padding: .4rem 0; font-size: .95rem; }
</style></head>
<body>
<h1>SKRODZKai full custom Week ${escapeHtml(report.targetWeek)} rankings</h1>
<div class="meta">
  Generated ${escapeHtml(report.generatedAt)}. ${escapeHtml(report.posture)}.<br>
  Custom number = pre-season multi-source prior blended <code>${escapeHtml(report.week1Weight)}</code> completed-week form /
  <code>${(1 - report.week1Weight).toFixed(2)}</code> prior; the form signal is
  <code>${escapeHtml(report.opportunityShare)}</code> opportunity (volume valued at league-average points/opportunity) +
  <code>${(1 - report.opportunityShare).toFixed(2)}</code> observed league-scored result. Weights are documented, UNCALIBRATED
  model choices. <b>Yahoo* column is comparison only — never the custom output.</b><br>
  Prior board: <code>${escapeHtml(report.provenance?.prior?.path ?? "n/a")}</code> (generatedAt ${escapeHtml(report.provenance?.prior?.generatedAt ?? "n/a")}).
  Completed-week actuals: ${week1.map((w) => `Sleeper ${escapeHtml(w.season)} wk${escapeHtml(w.week)} (${escapeHtml(w.captureMode)}, retrievedAt ${escapeHtml(w.retrievedAt ?? "n/a")}, sha256 ${escapeHtml(String(w.contentSha256 ?? "").slice(0, 12))})`).join("; ")}.
  Schedule/opponent/kickoff: ${escapeHtml(report.provenance?.schedule?.sourceId ?? "n/a")} ${escapeHtml(report.provenance?.schedule?.captureMode ?? "")} (retrievedAt ${escapeHtml(report.provenance?.schedule?.retrievedAt ?? "n/a")}).
  Current injury/team status &amp; missing-player identity: ${escapeHtml(report.provenance?.identity?.sourceId ?? "n/a")} ${escapeHtml(report.provenance?.identity?.captureMode ?? "")} (retrievedAt ${escapeHtml(report.provenance?.identity?.retrievedAt ?? "n/a")}).<br>
  <b>Matchup (${escapeHtml(matchup.status ?? "n/a")}):</b> opponent + kickoff SOURCED from the actual schedule. ${matchup.seasonsUsed ? `Opponent-strength factor from real scored nflverse history (seasons ${escapeHtml((matchup.seasonsUsed ?? []).join(", "))}, ${escapeHtml(matchup.totalTeamGames ?? "?")} team-games) under the EXACT league scorers — offense vs the DEFENSE faced, IDP vs the OFFENSE faced, DEF from the OFFENSE's scoring mapped to the exact points-allowed bands; shrunk toward neutral by sample and clamped ${escapeHtml(JSON.stringify(matchup.clamp?.offense ?? []))}. A <code>*</code> on the Matchup cell = no historical support, held neutral. UNCALIBRATED to 2026. Limitation: ${escapeHtml(matchup.limitations ?? "")}` : "no matchup factor applied (neutral 1.0)."}<br>
  Team defenses (${escapeHtml(teamDef.sampledTeamWeeks ?? "?")} team-weeks): Week-form DST scored under the exact league rules, regressed to the league DST mean ${money(teamDef.leagueMean)} then opponent-offense matchup-adjusted; the Yahoo DEF season prior is EXCLUDED.
</div>
<div class="counts">
  Universe: <b>${report.universe.totalRows}</b> rows (<b>${report.universe.boardPlayers}</b> board + <b>${report.universe.missingActivePlayers}</b> relevant missing-active) —
  <b>${report.universe.rankableRows}</b> ranked, <b>${report.universe.totalRows - report.universe.rankableRows}</b> unrankable (reasons below).
  Team defenses: <b>${report.universe.defenseRows}</b>/32. Duplicate ids: <b>${report.audit.duplicateIdCount}</b>. Roster coverage gaps: <b>${report.audit.rosterCoverageMissing.length}</b>.
</div>
<input id="filter" type="text" placeholder="filter by player / team / position…">
<div class="section">
<table id="ranked"><caption>Ranked (${ranked.length}) — click a header to sort</caption>
<thead><tr>${rankedHeaders.map((h, i) => `<th class="${rankedNumCols.has(i) ? "num" : ""}">${escapeHtml(h)}</th>`).join("")}</tr></thead>
<tbody>${ranked.map(rankedRow).join("")}</tbody></table>
</div>
<div class="section">
<table id="unranked"><caption>Unrankable (${unranked.length}) — surfaced with reasons, never silently omitted</caption>
<thead><tr>${unrankedHeaders.map((h, i) => `<th class="${i === 4 ? "num" : ""}">${escapeHtml(h)}</th>`).join("")}</tr></thead>
<tbody>${unranked.map(unrankedRow).join("")}</tbody></table>
</div>
<script>
for (const table of document.querySelectorAll("table")) {
  const tbody = table.querySelector("tbody");
  table.querySelectorAll("th").forEach((th, index) => {
    let asc = true;
    th.addEventListener("click", () => {
      asc = !asc;
      const rows = [...tbody.querySelectorAll("tr")];
      rows.sort((a, b) => {
        const av = a.children[index].dataset.sort, bv = b.children[index].dataset.sort;
        const an = parseFloat(av), bn = parseFloat(bv);
        const numeric = !Number.isNaN(an) && !Number.isNaN(bn) && /^-?\\d/.test(av) && /^-?\\d/.test(bv);
        const cmp = numeric ? an - bn : String(av).localeCompare(String(bv));
        return asc ? cmp : -cmp;
      });
      rows.forEach((row) => tbody.appendChild(row));
    });
  });
}
const filter = document.getElementById("filter");
filter.addEventListener("input", () => {
  const q = filter.value.toLowerCase();
  for (const table of document.querySelectorAll("table")) {
    for (const row of table.querySelectorAll("tbody tr")) {
      row.style.display = row.textContent.toLowerCase().includes(q) ? "" : "none";
    }
  }
});
</script>
</body></html>`;
}

async function runFullRankings(args, { season, targetWeek, week1Weight, opportunityShare, generatedAt, capturedAt }) {
  // Completed weeks are every week before the target week — no hardcoded Week 1.
  const completedWeeks = Array.from({ length: targetWeek - 1 }, (_, index) => index + 1);
  const [rosterInputs, board] = await Promise.all([
    args.roster ? readFile(args.roster, "utf8").then(JSON.parse) : Promise.resolve({ players: [] }),
    readFile(args.board, "utf8").then(JSON.parse),
  ]);
  const weekStatsList = [];
  for (const week of completedWeeks) {
    const offlinePath = args[`sleeper-week${week}`] || (completedWeeks.length === 1 ? args.sleeper : null) || null;
    const { stats, receipt } = await loadSleeperWeek({ sleeperPath: offlinePath, season, week, capturedAt, outDir: args.out });
    weekStatsList.push({ week, stats, receipt });
  }
  const { players: playersMap, receipt: identityReceipt } = await loadSleeperPlayersMap({
    playersPath: args.players || null, season, capturedAt, outDir: args.out,
  });
  const { byTeam: scheduleByTeam, byeTrusted: scheduleByeTrusted, receipt: scheduleReceipt } = await loadSchedule({
    schedulePath: args.schedule || null, season, week: targetWeek, capturedAt, outDir: args.out,
  });

  const { rates: opportunityRates, sampledPlayers } = buildOpportunityRatesMultiWeek(board, weekStatsList);
  const { mean: teamDefenseMean, sampledTeamWeeks } = teamDefenseLeagueMeanMultiWeek(weekStatsList);

  // Sourced opponent-matchup adjustment from real scored history. Point-in-time: completed seasons
  // strictly before the target season (default the two most recent), so there is NO leakage.
  let matchupProvider = null;
  let matchupMeta = null;
  if (!args["no-matchup"]) {
    const matchupDir = args["matchup-dir"] || "/Volumes/TradingFloor/openclaw-disk-offload/fantasy-gm-2026/source-cache";
    const matchupSeasons = String(args["matchup-seasons"] ?? `${season - 2},${season - 1}`).split(",").map((value) => Number(value.trim())).filter(Number.isInteger);
    if (matchupSeasons.some((matchupSeason) => matchupSeason >= season)) {
      throw new Error("matchup seasons must be completed seasons strictly before the target season (no leakage)");
    }
    const seasonTexts = [];
    for (const matchupSeason of matchupSeasons) {
      const text = await readFile(join(matchupDir, `nflverse-player-stats-week-${matchupSeason}.csv`), "utf8");
      seasonTexts.push({ season: matchupSeason, text });
    }
    const gamesText = await readFile(join(matchupDir, "nflverse-games.csv"), "utf8");
    matchupProvider = buildOpponentMatchup({ seasonTexts, gamesText, dstBaselineMean: teamDefenseMean });
    matchupMeta = matchupProvider.meta;
  }

  const provenance = {
    prior: { path: args.board, generatedAt: board.generatedAt ?? null, leagueId: board.leagueId ?? null, scoringModel: board.scoringModel ?? null, note: "pre-season custom multi-source blend; the per-player prior is the board's availability-adjusted weekly expectation weeklyPoints[targetWeek] (its healthy-games model), falling back to perGamePoints only when no weekly array exists — this avoids inflating deep backups whose season points divide by a tiny expected-games count. DEF uses the league DST mean." },
    week1List: weekStatsList.map(({ receipt }) => receipt),
    schedule: scheduleReceipt,
    identity: identityReceipt,
    comparison: args.roster ? `${args.roster} (${rosterInputs.sourceNote ?? "coordinator snapshot"}; Yahoo numbers comparison-only; group labels are the coordinator snapshot's context, NOT current free-agent status)` : null,
    completedWeeks,
    opportunityRates: {
      basis: `league-average points-per-opportunity by position, from ${sampledPlayers} board-universe offense players across completed weeks ${completedWeeks.join(", ")} (derived from actuals, not fabricated)`,
      ratesByPosition: opportunityRates.ratesByPosition,
      overall: opportunityRates.overall,
      minSample: opportunityRates.minSample,
    },
    teamDefense: {
      leagueMean: teamDefenseMean,
      sampledTeamWeeks,
      priorBasis: "REGRESSED_TO_LEAGUE_DST_MEAN",
      scoringSource: "analysis/player-intelligence.mjs TEAM_DEFENSE_SCORING — exact league DST rules; the draft-board single-source Yahoo DEF prior is EXCLUDED (carried only as excludedYahooSeasonPrior).",
      note: "each defense's completed-week DST line is scored under the exact league rules and regressed toward the league DST mean, then adjusted by the opponent-offense matchup factor (see matchup).",
    },
    matchup: matchupMeta
      ? {
          status: "OPPONENT_SOURCED_HISTORICAL",
          source: `nflverse player stats seasons ${matchupMeta.seasonsUsed.join(", ")} + nflverse game scores (read-only source-cache); ${matchupMeta.totalTeamGames} team-games, ${matchupMeta.teamsCovered} teams`,
          ...matchupMeta,
          scheduleNote: "opponent identity and kickoff are SOURCED from the actual NFL schedule (ESPN public scoreboard); byes for the target week are trusted only when the schedule is complete.",
        }
      : {
          status: "MATCHUP_DISABLED_NEUTRAL",
          note: "matchup adjustment disabled (--no-matchup); opponent/kickoff still sourced from the schedule but every factor is neutral 1.0.",
        },
    modelChoiceNote: "week1Weight and opportunityShare are documented, UNCALIBRATED model choices (no 2026 weekly-outcome calibration exists); the opponent-matchup factor is a shrunk, clamped recency prior from real scored history, also UNCALIBRATED to 2026 outcomes. This is a sourced, form-and-matchup-updated prior, explicitly distinguished from a validated projection.",
  };

  const rankings = buildFullWeeklyRankings({
    board,
    rosterInputs,
    weekStatsList,
    playersMap,
    schedule: { byTeam: scheduleByTeam, byeTrusted: scheduleByeTrusted },
    matchupProvider,
    opportunityRates,
    teamDefenseMean,
    week1Weight: week1Weight ?? undefined,
    opportunityShare: opportunityShare ?? undefined,
    targetWeek,
    generatedAt,
    provenance,
  });

  await mkdir(args.out, { recursive: true });
  const jsonPath = join(args.out, `week${targetWeek}-full-rankings.json`);
  const htmlPath = join(args.out, `week${targetWeek}-full-rankings.html`);
  await writeFile(jsonPath, `${JSON.stringify(rankings, null, 2)}\n`, { mode: 0o600 });
  await writeFile(htmlPath, `${renderFullRankingsHtml(rankings)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    jsonPath, htmlPath, universe: rankings.universe, audit: rankings.audit,
  }, null, 2)}\n`);
}

function parseArgs(argv) {
  return Object.fromEntries(argv.map((entry) => {
    const [key, ...value] = entry.replace(/^--/, "").split("=");
    return [key, value.length ? value.join("=") : true];
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const requiredKeys = args.full ? ["board", "out"] : ["roster", "board", "out"];
  for (const key of requiredKeys) {
    if (!args[key]) throw new Error(`missing --${key}`);
  }
  const season = Number(args.season ?? 2026);
  const targetWeek = Number(args["target-week"] ?? 2);
  if (!Number.isInteger(season) || season < 2000 || !Number.isInteger(targetWeek) ||
      targetWeek < 2 || targetWeek > 17) {
    throw new Error("target week must be an integer 2 through 17");
  }
  const week1Weight = args["week1-weight"] != null ? Number(args["week1-weight"]) : undefined;
  const opportunityShare = args["opportunity-share"] != null ? Number(args["opportunity-share"]) : undefined;
  // Report generation time. Kept strictly separate from the source acquisition time: --generated-at
  // controls only this, and it never backdates a source capture receipt's retrievedAt.
  const generatedAt = args["generated-at"] ?? new Date().toISOString();
  // Real source-acquisition instant, used ONLY on a live fetch. Offline replay ignores it.
  const capturedAt = new Date().toISOString();

  if (args.full) {
    await runFullRankings(args, { season, targetWeek, week1Weight, opportunityShare, generatedAt, capturedAt });
    return;
  }

  const sleeperWeek = Number(args["sleeper-week"] ?? targetWeek - 1);
  if (!Number.isInteger(sleeperWeek) || sleeperWeek < 1 || sleeperWeek >= targetWeek) {
    throw new Error("observed source week must precede target week (2 through 17)");
  }

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
