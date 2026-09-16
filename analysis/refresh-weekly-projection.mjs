import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { buildWeeklyProjectionReport, deriveOpportunityRates, opportunityExpectedPoints, scoreWeeklyLeaguePoints, assignFullRanks } from "./weekly-roster-utility.mjs";
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
  let anyVolume = false;
  for (const { stats } of weekStatsList) {
    const line = stats ? stats[statsKey] : null;
    if (!line) continue;
    if (kind === "teamdef") {
      if (line.pts_allow === undefined) continue;
      games += 1;
      sumObserved += scoreTeamDefenseStatLine(sleeperTeamDefenseLine(line));
      anyVolume = true;
      continue;
    }
    games += 1;
    if (hasScoredVolume(line)) anyVolume = true;
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
    anyVolume,
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
    if (!sidecar || sidecar.contentSha256 !== contentSha256 || !sidecar.retrievedAt) {
      throw new Error(`offline replay requires a matching ${sourceId} capture receipt`);
    }
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

export function parseEspnSchedule(payload) {
  const byTeam = new Map();
  for (const event of payload.events ?? []) {
    const competition = (event.competitions ?? [])[0];
    if (!competition) continue;
    const kickoff = event.date ?? competition.date ?? null;
    const competitors = competition.competitors ?? [];
    if (competitors.length !== 2) continue;
    const sides = competitors.map((competitor) => ({
      team: normalizeTeam(competitor.team?.abbreviation),
      homeAway: competitor.homeAway ?? null,
    }));
    for (let index = 0; index < 2; index += 1) {
      const self = sides[index];
      const other = sides[1 - index];
      if (!self.team) continue;
      byTeam.set(self.team, { opponent: other.team, homeAway: self.homeAway, kickoff, gameId: event.id ?? null });
    }
  }
  return byTeam;
}

export async function loadSchedule({ schedulePath, season, week, capturedAt, outDir }) {
  const { payload, receipt } = await loadReceiptedJson({
    path: schedulePath || null, url: ESPN_SCOREBOARD_URL(season, week),
    sourceId: "espn-schedule", sourceFamily: "espn", season, week, capturedAt, outDir,
    captureName: `espn-schedule-${season}-week${week}.json`,
  });
  const byTeam = parseEspnSchedule(payload);
  return { byTeam, receipt: { ...receipt, gamesParsed: byTeam.size / 2 } };
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
    return { availabilityStatus: null, rawInjuryStatus: null, sleeperStatus: null, currentTeam: null };
  }
  const raw = entry.injury_status ?? null;
  let availabilityStatus = null;
  if (raw && SLEEPER_INJURY_STATUS_MAP[raw]) availabilityStatus = SLEEPER_INJURY_STATUS_MAP[raw];
  else if (!raw && entry.status === "Active") availabilityStatus = "HEALTHY";
  return {
    availabilityStatus,
    rawInjuryStatus: raw,
    sleeperStatus: entry.status ?? null,
    currentTeam: entry.team ? normalizeTeam(entry.team) : null,
  };
}

const FULL_CONTEXT_FIELDS = [
  "universe", "group", "sleeperId", "priorBasis", "excludedYahooSeasonPrior", "week1Opportunity",
  "completedGames", "week1SourceStatus", "bye", "kickoff", "homeAway", "boardTeam", "currentTeam",
  "rawInjuryStatus", "sleeperStatus",
];

/**
 * Assemble the full-universe weekly rankings: every board player (offense/K/IDP + 32 DEF) plus
 * relevant active players missing from the pre-season board, each scored under the exact league
 * rules, blended prior->current-form, then ranked overall and by position with explicit
 * unrankable reasons. Yahoo numbers remain comparison-only.
 */
export function buildFullWeeklyRankings({
  board,
  rosterInputs,
  weekStatsList,
  playersMap,
  schedule,
  opportunityRates,
  teamDefenseMean,
  week1Weight,
  opportunityShare,
  targetWeek,
  generatedAt,
  provenance,
}) {
  const rosterOverlay = new Map((rosterInputs?.players ?? []).map((player) => [String(player.yahooId), player]));
  const boardSleeperIds = new Set();
  const modelPlayers = [];
  const context = new Map();

  for (const player of board.players ?? []) {
    const playerId = player.yahooId != null ? String(player.yahooId) : (player.playerId != null ? String(player.playerId) : null);
    if (playerId == null) continue;
    if (player.sleeperId != null) boardSleeperIds.add(String(player.sleeperId));
    const position = String(player.position ?? "").toUpperCase();
    const scoringKind = scoringKindForPosition(position);
    const isTeamDef = scoringKind === "teamdef";
    const boardTeam = normalizeTeam(player.team);
    const statusInfo = isTeamDef
      ? { availabilityStatus: null, rawInjuryStatus: null, sleeperStatus: "Active", currentTeam: boardTeam }
      : currentPlayerStatus(player.sleeperId != null ? playersMap[String(player.sleeperId)] : null);
    // Prefer the current NFL team from the fresh identity feed (some board players changed teams
    // since the pre-season board) so opponent/kickoff/health are correct; DEF is its own team.
    const team = isTeamDef ? boardTeam : (statusInfo.currentTeam ?? boardTeam);
    const statsKey = isTeamDef ? team : (player.sleeperId != null ? String(player.sleeperId) : null);
    const signal = completedWeeksSignal({ scoringKind, position, statsKey }, weekStatsList, opportunityRates);
    const overlay = rosterOverlay.get(playerId) ?? null;
    const sched = team ? schedule.byTeam.get(team) ?? null : null;
    const onBye = Boolean(team) && !schedule.byTeam.has(team);
    const priorPerGame = isTeamDef
      ? (finite(teamDefenseMean) ? Number(teamDefenseMean) : null)
      : (finite(player.perGamePoints) ? Number(player.perGamePoints) : null);
    modelPlayers.push({
      playerId,
      name: player.name,
      position: player.position,
      team,
      opponent: sched?.opponent ?? overlay?.opponent ?? null,
      priorPerGame,
      scoringKind,
      week1Points: signal?.week1Points ?? null,
      week1OpportunityPoints: signal?.week1OpportunityPoints ?? null,
      availabilityStatus: onBye ? "BYE" : (statusInfo.availabilityStatus ?? null),
      yahooWeek2Projection: overlay?.yahooWeek2Projection ?? null,
    });
    context.set(playerId, {
      universe: "board",
      group: overlay?.group ?? null,
      sleeperId: player.sleeperId != null ? String(player.sleeperId) : null,
      priorBasis: isTeamDef ? "WEEK1_LEAGUE_DST_MEAN" : "PRESEASON_MULTI_SOURCE_BLEND",
      excludedYahooSeasonPrior: isTeamDef && finite(player.perGamePoints) ? Number(player.perGamePoints) : null,
      week1Opportunity: signal?.week1Opportunity ?? null,
      completedGames: signal?.games ?? 0,
      week1SourceStatus: signal ? (isTeamDef ? "SLEEPER_DST_ACTUAL" : "SLEEPER_ACTUAL") : "NO_COMPLETED_WEEK_RECORD",
      bye: onBye,
      kickoff: sched?.kickoff ?? null,
      homeAway: sched?.homeAway ?? null,
      boardTeam,
      currentTeam: statusInfo.currentTeam,
      rawInjuryStatus: statusInfo.rawInjuryStatus,
      sleeperStatus: statusInfo.sleeperStatus,
    });
  }

  // Relevant active players missing from the pre-season board: played a completed week, currently
  // rostered + active at a scored offense/K/IDP position, and not already on the board. Team
  // defenses are always the board's 32, never re-derived here.
  const seenMissing = new Set();
  let missingCount = 0;
  for (const { stats } of weekStatsList) {
    for (const key of Object.keys(stats ?? {})) {
      if (!/^[0-9]+$/.test(key) || boardSleeperIds.has(key) || seenMissing.has(key)) continue;
      const entry = playersMap[key];
      if (!entry || entry.active !== true || !entry.team) continue;
      const fantasyPositions = Array.isArray(entry.fantasy_positions) ? entry.fantasy_positions.map((pos) => String(pos).toUpperCase()) : [];
      const position = fantasyPositions.find((pos) => SCORED_POSITIONS.has(pos)) ?? String(entry.position ?? "").toUpperCase();
      if (!SCORED_POSITIONS.has(position)) continue;
      const scoringKind = scoringKindForPosition(position);
      if (scoringKind === "teamdef") continue;
      const signal = completedWeeksSignal({ scoringKind, position, statsKey: key }, weekStatsList, opportunityRates);
      if (!signal || !signal.anyVolume) continue;
      seenMissing.add(key);
      missingCount += 1;
      const team = normalizeTeam(entry.team);
      const sched = team ? schedule.byTeam.get(team) ?? null : null;
      const onBye = Boolean(team) && !schedule.byTeam.has(team);
      const statusInfo = currentPlayerStatus(entry);
      const playerId = `sleeper:${key}`;
      modelPlayers.push({
        playerId,
        name: entry.full_name ?? (`${entry.first_name ?? ""} ${entry.last_name ?? ""}`.trim() || playerId),
        position,
        team,
        opponent: sched?.opponent ?? null,
        priorPerGame: null,
        scoringKind,
        week1Points: signal.week1Points,
        week1OpportunityPoints: signal.week1OpportunityPoints,
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
  const ranked = assignFullRanks(report.players);
  const players = ranked.map((row) => {
    const ctx = context.get(row.playerId) ?? {};
    const merged = { ...row };
    for (const field of FULL_CONTEXT_FIELDS) merged[field] = ctx[field] ?? null;
    return merged;
  });

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
  const unrankableReasons = players.filter((row) => !row.rankable).reduce((counts, row) => {
    counts[row.unrankableReason] = (counts[row.unrankableReason] ?? 0) + 1;
    return counts;
  }, {});

  return {
    ...report,
    posture: "research projection only; no roster, Yahoo, or deployment authority",
    universe: {
      boardPlayers: (board.players ?? []).length,
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
      unrankableReasons,
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
    ${numCell(row.yahooWeek2Projection)}
    ${numCell(row.deltaVsYahoo)}
    ${(() => { const h = health(row); return `<td data-sort="${h}">${h}</td>`; })()}
    ${dataCell(row.confidence ?? "")}
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
  const rankedHeaders = ["Ovr", "PosRk", "Player", "Pos", "Team", "Opp", "Kickoff", "Custom", "Prior/g", "Form", "Yahoo*", "Δ vs Yahoo", "Health", "Confidence", "Gms", "Universe"];
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
  Matchup: opponent + kickoff are SOURCED from the actual schedule; NO opponent-strength factor is applied (held neutral 1.0) — not fabricated.
  Team defenses (${escapeHtml(teamDef.sampledTeamWeeks ?? "?")} team-weeks): Week-form DST scored under the exact league rules, regressed to the league DST mean ${money(teamDef.leagueMean)}; the Yahoo DEF season prior is EXCLUDED.
</div>
<div class="counts">
  Universe: <b>${report.universe.totalRows}</b> rows (<b>${report.universe.boardPlayers}</b> board + <b>${report.universe.missingActivePlayers}</b> relevant missing-active) —
  <b>${report.universe.rankableRows}</b> ranked, <b>${report.universe.totalRows - report.universe.rankableRows}</b> unrankable (reasons below).
  Team defenses: <b>${report.universe.defenseRows}</b>/32. Duplicate ids: <b>${report.audit.duplicateIdCount}</b>. Roster coverage gaps: <b>${report.audit.rosterCoverageMissing.length}</b>.
</div>
<input id="filter" type="text" placeholder="filter by player / team / position…">
<div class="section">
<table id="ranked"><caption>Ranked (${ranked.length}) — click a header to sort</caption>
<thead><tr>${rankedHeaders.map((h, i) => `<th class="${i === 0 || i >= 7 && i <= 11 || i === 14 ? "num" : ""}">${escapeHtml(h)}</th>`).join("")}</tr></thead>
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
  const { byTeam: scheduleByTeam, receipt: scheduleReceipt } = await loadSchedule({
    schedulePath: args.schedule || null, season, week: targetWeek, capturedAt, outDir: args.out,
  });

  const { rates: opportunityRates, sampledPlayers } = buildOpportunityRatesMultiWeek(board, weekStatsList);
  const { mean: teamDefenseMean, sampledTeamWeeks } = teamDefenseLeagueMeanMultiWeek(weekStatsList);

  const provenance = {
    prior: { path: args.board, generatedAt: board.generatedAt ?? null, leagueId: board.leagueId ?? null, scoringModel: board.scoringModel ?? null, note: "pre-season custom multi-source per-game blend; legitimate prior, pre-season" },
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
      note: "each defense's completed-week DST line is scored under the exact league rules and regressed toward the league DST mean; one-game (or few-game) defensive-form read, uncalibrated, with NO matchup factor.",
    },
    matchup: {
      status: "OPPONENT_SOURCED_STRENGTH_NEUTRAL",
      note: "opponent identity and kickoff are SOURCED from the actual NFL schedule (ESPN public scoreboard). No opponent-strength / implied-total factor is applied — matchupFactor held at neutral 1.0 for every row (not fabricated). Byes for the target week zero out affected players as a factual non-play.",
    },
    modelChoiceNote: "week1Weight and opportunityShare are documented, UNCALIBRATED model choices (no 2026 weekly-outcome calibration exists); this is a form-updated prior, explicitly distinguished from a calibrated projection.",
  };

  const rankings = buildFullWeeklyRankings({
    board,
    rosterInputs,
    weekStatsList,
    playersMap,
    schedule: { byTeam: scheduleByTeam },
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
