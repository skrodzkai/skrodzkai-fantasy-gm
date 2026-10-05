import { KICKER_SCORING, TEAM_DEFENSE_SCORING, scoreTeamDefenseStatLine } from "./player-intelligence.mjs";

const number = (value) => value != null && value !== "" && Number.isFinite(Number(value));
const n = (value) => number(value) ? Number(value) : 0;
const mean = (rows, field) => rows.length ? rows.reduce((sum, row) => sum + row[field], 0) / rows.length : null;
const smooth = (rows, pool, field) => (rows.reduce((sum, row) => sum + row[field], 0) + mean(pool, field)) / (rows.length + 1);

// Sleeper participating box scores omit zero-valued event keys. This adapter convention applies
// only after positive game/attempt/snap evidence (K), or measured pts_allow (DEF), never to no row.
export function buildSpecialTeamsModel(weekStatsList, playersMap, historicalSchedules = new Map()) {
  const kickers = new Map();
  const kickerIds = new Map();
  const defenses = new Map();
  const kPool = [];
  const dPool = [];
  const exposures = new Map();
  for (const { week, stats } of weekStatsList) {
    const seenKickers = new Set();
    for (const [id, raw] of Object.entries(stats ?? {})) {
      const entry = playersMap[id];
      if (["K", "PK"].includes(entry?.position) &&
          (n(raw.gp) > 0 || n(raw.st_snp) > 0 || n(raw.fga) + n(raw.xpa) > 0)) {
        if (["fga", "fgm", "xpa", "xpm"].some((field) => raw[field] != null && (!number(raw[field]) || Number(raw[field]) < 0))) continue;
        const row = { week, fga: n(raw.fga), fgm: n(raw.fgm), xpa: n(raw.xpa), xpm: n(raw.xpm) };
        if (row.fgm > row.fga || row.xpm > row.xpa) continue;
        const identity = String(entry.gsis_id || id);
        kickerIds.set(id, identity);
        if (seenKickers.has(identity)) continue;
        seenKickers.add(identity);
        kickers.set(identity, [...(kickers.get(identity) ?? []), row]);
        kPool.push(row);
      }
      if (!/^[A-Z]{2,3}$/.test(id) || !number(raw.pts_allow)) continue;
      if (["pts_allow", "sack", "int", "fum_rec", "def_st_fum_rec", "def_td", "def_st_td", "safe", "blk_kick", "def_kr_td", "def_pr_td"]
        .some((field) => raw[field] != null && (!number(raw[field]) || Number(raw[field]) < 0))) continue;
      const pa = Number(raw.pts_allow);
      const paField = pa <= 0 ? "pointsAllowed0" : pa <= 6 ? "pointsAllowed1To6" : pa <= 13 ? "pointsAllowed7To13" :
        pa <= 20 ? "pointsAllowed14To20" : pa <= 27 ? "pointsAllowed21To27" : pa <= 34 ? "pointsAllowed28To34" : "pointsAllowed35Plus";
      const row = { week, sacks: n(raw.sack) * TEAM_DEFENSE_SCORING.sacks,
        interceptions: n(raw.int) * TEAM_DEFENSE_SCORING.interceptions,
        fumbles: (n(raw.fum_rec) + n(raw.def_st_fum_rec)) * TEAM_DEFENSE_SCORING.fumbleRecoveries,
        pointsAllowed: scoreTeamDefenseStatLine({ [paField]: 1 }),
        rare: scoreTeamDefenseStatLine({ defensiveTouchdowns: n(raw.def_td) + n(raw.def_st_td),
          safeties: n(raw.safe), blockedKicks: n(raw.blk_kick), returnTouchdowns: n(raw.def_kr_td) + n(raw.def_pr_td) }) };
      defenses.set(id, [...(defenses.get(id) ?? []), row]);
      dPool.push(row);
      const opponent = historicalSchedules.get(week)?.byTeam.get(id)?.opponent;
      if (opponent) exposures.set(opponent, [...(exposures.get(opponent) ?? []), row]);
    }
  }
  return { kickers, kickerIds, defenses, kPool, dPool, exposures, completedWeeks: weekStatsList.map(({ week }) => week),
    basis: "current-season components; one pooled observed game smoothing, UNCALIBRATED; participating Sleeper box scores omit zero event keys",
    limitations: "DEF extra-point returns have no distinct supported field and are unmodeled; opponent exposure requires verified completed schedule join; K own-team FG/PAT opportunities are measured attempts, drives and future offense changes unmodeled" };
}

export function projectSpecialTeams(model, { kind, statsKey, opponent }) {
  const rows = kind === "kicker" ? model.kickers.get(model.kickerIds.get(String(statsKey))) : model.defenses.get(String(statsKey));
  const pool = kind === "kicker" ? model.kPool : model.dPool;
  if (!rows?.length || !pool.length) return { status: "NO_SUPPORTED_CURRENT_SEASON_COMPONENTS", weeklyExpectation: null };
  let components;
  let opponentSampleGames = 0;
  if (kind === "kicker") {
    const total = (list, field) => list.reduce((sum, row) => sum + row[field], 0);
    const fgPoolAttempts = total(pool, "fga");
    const xpPoolAttempts = total(pool, "xpa");
    if (!fgPoolAttempts || !xpPoolAttempts) return { status: "NO_KICKER_ATTEMPT_RATE", weeklyExpectation: null };
    const fgOpportunity = smooth(rows, pool, "fga");
    const patOpportunity = smooth(rows, pool, "xpa");
    const fgPriorAttempts = mean(pool, "fga");
    const xpPriorAttempts = mean(pool, "xpa");
    const fgRate = (total(rows, "fgm") + total(pool, "fgm") / fgPoolAttempts * fgPriorAttempts) / (total(rows, "fga") + fgPriorAttempts);
    const xpRate = (total(rows, "xpm") + total(pool, "xpm") / xpPoolAttempts * xpPriorAttempts) / (total(rows, "xpa") + xpPriorAttempts);
    components = { fieldGoalPoints: fgOpportunity * fgRate * KICKER_SCORING.fieldGoalsMade,
      extraPointPoints: patOpportunity * xpRate * KICKER_SCORING.extraPointsMade,
      missedExtraPointPoints: patOpportunity * (1 - xpRate) * KICKER_SCORING.extraPointsMissed };
    return { status: "CURRENT_SEASON_COMPONENTS", weeklyExpectation: Object.values(components).reduce((a, b) => a + b, 0),
      components, sampleGames: rows.length, fgOpportunity, patOpportunity, fgRate, xpRate,
      opportunityBasis: "measured own-team FG/PAT attempts; no distance tiers under league scorer", opponentSampleGames,
      opponentStatus: "K_OPPONENT_EFFECT_UNMODELED", basis: model.basis, limitations: model.limitations };
  }
  components = Object.fromEntries(["sacks", "interceptions", "fumbles", "pointsAllowed"].map((field) => [field, smooth(rows, pool, field)]));
  const exposure = model.exposures.get(opponent);
  if (exposure?.length) {
    opponentSampleGames = exposure.length;
    // Independent own-defense and opponent-offense observations each shrink by one observed
    // pooled game. Equal averaging is a disclosed uncalibrated choice, not a fitted multiplier.
    for (const field of ["sacks", "interceptions", "fumbles", "pointsAllowed"])
      components[field] = (components[field] + smooth(exposure, pool, field)) / 2;
  }
  components.rareScoresPooled = mean(pool, "rare");
  return { status: "CURRENT_SEASON_COMPONENTS", weeklyExpectation: Object.values(components).reduce((a, b) => a + b, 0),
    components, sampleGames: rows.length, pooledGames: pool.length, opponentSampleGames,
    opponentStatus: opponentSampleGames ? "VERIFIED_COMPLETED_SCHEDULE_EXPOSURE" : "OPPONENT_EXPOSURE_UNKNOWN_OWN_AND_POOL_ONLY",
    basis: model.basis, limitations: model.limitations };
}
