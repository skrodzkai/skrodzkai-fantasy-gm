import assert from "node:assert/strict";
import test from "node:test";
import { buildSpecialTeamsModel, projectSpecialTeams } from "./special-teams-projection.mjs";
import { buildMultiweekRankings, buildForecastActualReports, renderMarkdown, renderFullRankingsHtml } from "./refresh-weekly-projection.mjs";

import {
  assertReceiptPeriod,
  verifySchedulePayload,
  pointsAllowedBandValue,
  shrinkFactorToOne,
  buildOpponentMatchup,
  currentPlayerStatus,
  completedWeeksSignal,
  buildFullWeeklyRankings,
} from "./refresh-weekly-projection.mjs";

test("K/DEF current-season components pool zero games, shrink by sample and require participation", () => {
  const players = { "1": { position: "K" }, "2": { position: "K" }, "3": { position: "K" } };
  const schedule = new Map([[1, { byTeam: new Map([["NE", { opponent: "BUF" }], ["BUF", { opponent: "NE" }]]) }]]);
  const sample = [{ week: 1, stats: { "1": { gp: 1, fga: 2, fgm: 2, xpa: 2, xpm: 1 }, "2": { gp: 1 },
    "3": { gms_active: 1 }, NE: { pts_allow: 14, pts_allow_14_20: 1, sack: 4, def_td: 1 }, BUF: { pts_allow: 35, pts_allow_35p: 1 } } }];
  const model = buildSpecialTeamsModel(sample, players, schedule);
  assert.equal(model.kPool.length, 2);
  assert.equal(projectSpecialTeams(model, { kind: "kicker", statsKey: "3" }).weeklyExpectation, null);
  assert.equal(projectSpecialTeams(model, { kind: "kicker", statsKey: "missing" }).weeklyExpectation, null);
  const k = projectSpecialTeams(model, { kind: "kicker", statsKey: "1" });
  assert.equal(k.components.fieldGoalPoints, 4.5);
  assert.equal(k.components.extraPointPoints, 0.75);
  assert.equal(k.components.missedExtraPointPoints, -0.75);
  assert.equal(k.weeklyExpectation, 4.5);
  const d = projectSpecialTeams(model, { kind: "teamdef", statsKey: "NE", opponent: "BUF" });
  assert.equal(d.components.rareScoresPooled, 3); // six-point rare TD averaged across BOTH games
  assert.equal(d.opponentSampleGames, 1);
  assert.equal(d.opponentStatus, "VERIFIED_COMPLETED_SCHEDULE_EXPOSURE");
  assert.equal(projectSpecialTeams(model, { kind: "teamdef", statsKey: "NE", opponent: "NO" }).opponentSampleGames, 0);
  const more = buildSpecialTeamsModel([...sample, { week: 2, stats: { NE: { pts_allow: 14, sack: 4 }, BUF: { pts_allow: 35 } } }], players);
  assert.ok(projectSpecialTeams(more, { kind: "teamdef", statsKey: "NE" }).components.sacks >
    projectSpecialTeams(model, { kind: "teamdef", statsKey: "NE" }).components.sacks);
  assert.equal(buildSpecialTeamsModel([{ week: 1, stats: { NE: { pts_allow: 7, sack: -1 }, "1": { gp: 1, fga: "bad" } } }], players).dPool.length, 0);
  const full = buildFullWeeklyRankings({ board: { players: [
    { yahooId: "1", sleeperId: "1", position: "K", name: "Kicker", team: "NE", perGamePoints: 100, weeklyPoints: [100, 100], scorableSourceFamilyCount: 2 },
    { yahooId: "10", position: "DEF", name: "Defense", team: "NE", perGamePoints: 100, weeklyPoints: [100, 100] }] },
    rosterInputs: { players: [] }, weekStatsList: sample, playersMap: { ...players, "1": { position: "K", team: "NE", status: "Active", depth_chart_order: 1 } },
    schedule: { byTeam: new Map([["NE", { opponent: "BUF", kickoff: "2026-09-20T17:00:00Z" }]]), byeTrusted: false },
    opportunityRates: null, teamDefenseMean: 99, specialTeamsModel: model, targetWeek: 2, generatedAt: "2026-09-16T00:00:00Z",
    provenance: { season: 2026, matchup: { seasonsUsed: [2025] } } });
  for (const row of full.players.filter((row) => row.playerId === "1" || row.playerId === "10")) {
    assert.equal(row.rankBasis, "CURRENT_SEASON_COMPONENTS");
    assert.equal(row.priorBasis, "CURRENT_SEASON_COMPONENTS");
    assert.equal(row.priorPerGame, null);
    assert.equal(row.priorShrinkageApplied, false);
    assert.equal(row.matchupFactor, 1);
    assert.equal(row.weeklyExpectation, row.specialTeamsModel.weeklyExpectation);
  }
  assert.equal(full.players.find((row) => row.playerId === "1").naiveBaseline, 6);
  assert.equal(full.players.find((row) => row.playerId === "10").naiveBaseline, 12);
  assert.doesNotThrow(() => renderMarkdown(full));
  assert.equal(full.audit.matchupApplied, 0);
  assert.equal(full.audit.defenseOpponentExposureApplied, 1);
  const html = renderFullRankingsHtml(full);
  assert.match(html, /for offense only/);
  assert.doesNotMatch(html, /for offense\/K\/DEF only/);
  assert.match(html, /current-components/);
  assert.doesNotMatch(html, /dst-mean/);
});

test("multiweek forecasts reuse one cutoff, preserve current injury assumptions and cap at week 18", () => {
  const board = { players: [{ yahooId: "1", sleeperId: "1", name: "Back", position: "RB", team: "NE", perGamePoints: 12,
    weeklyPoints: Array(18).fill(12), scorableSourceFamilyCount: 2 }] };
  const schedules = new Map([4, 5, 6].map((week) => [week, { byTeam: new Map([["NE", { opponent: "BUF", kickoff: `2026-10-${week + 1}T17:00:00Z` }]]),
    byeTrusted: false, receipt: { season: 2026, week } }]));
  const input = { board, rosterInputs: { players: [] }, playersMap: { "1": { position: "RB", team: "NE", status: "Active", active: true, injury_status: "Out" } },
    weekStatsList: [1, 2, 3].map((week) => ({ week, stats: { "1": { gp: 1, rush_att: 10, rush_yd: 50 } } })),
    opportunityRates: null, teamDefenseMean: null, generatedAt: "2026-10-01T00:00:00Z", provenance: { season: 2026 } };
  const report = buildMultiweekRankings({ ...input, targetWeek: 4, schedules });
  assert.deepEqual(report.weeks.map((r) => r.targetWeek), [4, 5, 6]);
  assert.deepEqual(report.weeks.map((r) => r.completedThroughWeek), [3, 3, 3]);
  assert.ok(report.weeks.every((r) => r.players[0].unrankableReason === "CONFIRMED_INACTIVE_OUT"));
  const byeSchedules = new Map(schedules);
  byeSchedules.set(4, { ...schedules.get(4), byTeam: new Map(), byeTeams: new Set(["NE"]) });
  byeSchedules.set(5, { ...schedules.get(5), byTeam: new Map(), byeTeams: new Set() });
  const byeReport = buildMultiweekRankings({ ...input, playersMap: { "1": { ...input.playersMap["1"], injury_status: null } }, targetWeek: 4, schedules: byeSchedules });
  assert.equal(byeReport.weeks[0].players[0].scheduleStatus, "VERIFIED_BYE");
  assert.equal(byeReport.weeks[1].players[0].scheduleStatus, "UNKNOWN");
  assert.equal(byeReport.weeks[1].players[0].weeklyExpectation, null);
  assert.throws(() => buildMultiweekRankings({ ...input, targetWeek: 4, schedules: new Map([[4, schedules.get(4)]]) }), /missing verified schedule/);
  const final = buildMultiweekRankings({ ...input, targetWeek: 18, weekStatsList: Array.from({ length: 17 }, (_, i) => ({ week: i + 1, stats: {} })),
    schedules: new Map([[18, { ...schedules.get(4), receipt: { season: 2026, week: 18 } }]]) });
  assert.deepEqual(final.weeks.map((r) => r.targetWeek), [18]);
  const actual = buildForecastActualReports([{ season: 2026, targetWeek: 1, players: ["1", "2"].map((id) => ({ playerId: id, sleeperId: id, position: "RB", team: "NE", kickoff: "kick" })) }],
    [{ week: 1, stats: { "1": { gp: 1, rush_yd: 100 } }, receipt: { retrievedAt: "later" } }],
    new Map([[1, { byTeam: new Map([["NE", { completed: true, kickoff: "kick" }]]), receipt: { retrievedAt: "final" } }]]), 2026);
  assert.equal(actual[0].players[0].actualPoints, 12); // exact 100-yard bonus under league scorer
  assert.deepEqual(actual[0].unresolvedPlayers, [{ playerId: "2", sleeperId: "2", position: "RB", reason: "NO_PARTICIPATION_ROW_UNRESOLVED" }]);
});

test("assertReceiptPeriod binds source and period, rejecting a relabeled capture", () => {
  const good = { sourceId: "espn-schedule", season: 2026, week: 2, retrievedAt: "2026-09-16T00:00:00Z", contentSha256: "abc" };
  assert.doesNotThrow(() => assertReceiptPeriod(good, { sourceId: "espn-schedule", season: 2026, week: 2 }));
  // Wrong week / season / source each throw — a replay cannot relabel one period as another.
  assert.throws(() => assertReceiptPeriod(good, { sourceId: "espn-schedule", season: 2026, week: 3 }), /week/);
  assert.throws(() => assertReceiptPeriod(good, { sourceId: "espn-schedule", season: 2025, week: 2 }), /season/);
  assert.throws(() => assertReceiptPeriod(good, { sourceId: "sleeper", season: 2026, week: 2 }), /sourceId/);
  // A season-scoped source (null week in sidecar) is a wildcard on week.
  const seasonScoped = { sourceId: "sleeper-players", season: 2026, week: null, retrievedAt: "t", contentSha256: "x" };
  assert.doesNotThrow(() => assertReceiptPeriod(seasonScoped, { sourceId: "sleeper-players", season: 2026, week: null }));
  assert.throws(() => assertReceiptPeriod({ contentSha256: null }, { sourceId: "x", season: 2026, week: 1 }), /matching/);
  // A receipt MISSING the requested source/period bindings is rejected, not silently accepted.
  assert.throws(() => assertReceiptPeriod({ contentSha256: "abc", retrievedAt: "2026-09-16" }, { sourceId: "espn-schedule", season: 2026, week: 2 }), /sourceId/);
  assert.throws(() => assertReceiptPeriod({ contentSha256: "abc", retrievedAt: "t", sourceId: "espn-schedule" }, { sourceId: "espn-schedule", season: 2026, week: 2 }), /season/);
  assert.throws(() => assertReceiptPeriod({ contentSha256: "abc", retrievedAt: "t", sourceId: "espn-schedule", season: 2026 }, { sourceId: "espn-schedule", season: 2026, week: 2 }), /week/);
});

function scheduleEvents(count, { season = 2026, week = 2 } = {}) {
  const teams = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH", "III", "JJJ", "KKK", "LLL", "MMM", "NNN", "OOO", "PPP", "QQQ", "RRR", "SSS", "TTT", "UUU", "VVV", "WWW", "XXX", "YYY", "ZZZ", "A1A", "B1B", "C1C", "D1D", "E1E", "F1F"];
  const events = [];
  for (let i = 0; i < count; i += 1) {
    events.push({
      id: String(i), date: "2026-09-20T17:00Z", season: { year: season, type: 2 }, week: { number: week },
      competitions: [{ competitors: [
        { team: { abbreviation: teams[i * 2] }, homeAway: "home" },
        { team: { abbreviation: teams[i * 2 + 1] }, homeAway: "away" },
      ] }],
    });
  }
  return { season: { year: season, type: 2 }, week: { number: week }, events };
}

test("verifySchedulePayload rejects a wrong-period or preseason capture", () => {
  const payload = scheduleEvents(13, { week: 3 });
  assert.throws(() => verifySchedulePayload(payload, { season: 2026, week: 2 }), /week/);
  assert.throws(() => verifySchedulePayload(scheduleEvents(13, { season: 2025 }), { season: 2026, week: 2 }), /season/);
  assert.throws(() => verifySchedulePayload({ season: { year: 2026, type: 1 }, week: { number: 2 }, events: [] }, { season: 2026, week: 2 }), /season type/);
  assert.throws(() => verifySchedulePayload({ season: { year: 2026 }, week: { number: 2 }, events: [] }, { season: 2026, week: 2 }), /no games/);
});

test("verifySchedulePayload trusts byes ONLY when all 32 teams are present", () => {
  // A full 16-game week = 32 teams present -> complete -> byes trustable.
  const full = verifySchedulePayload(scheduleEvents(16), { season: 2026, week: 2 });
  assert.equal(full.gamesParsed, 16);
  assert.equal(full.teamsPlayingCount, 32);
  assert.equal(full.byeTrusted, true);
  assert.equal(full.byTeam.get("AAA").opponent, "BBB");
  assert.equal(full.byTeam.get("BBB").homeAway, "away");
  // A 14-game capture (28 teams) or a 12-of-16 truncation cannot be proven complete: a game count
  // alone never proves the schedule -> byes NOT trusted, absent teams stay UNKNOWN.
  const fourteen = verifySchedulePayload(scheduleEvents(14), { season: 2026, week: 2 });
  assert.equal(fourteen.teamsPlayingCount, 28);
  assert.equal(fourteen.byeTrusted, false);
  const partial = verifySchedulePayload(scheduleEvents(3), { season: 2026, week: 2 });
  assert.equal(partial.gamesParsed, 3);
  assert.equal(partial.byeTrusted, false);
});

test("pointsAllowedBandValue matches the exact league DST bands", () => {
  assert.equal(pointsAllowedBandValue(0), 10);
  assert.equal(pointsAllowedBandValue(6), 7);
  assert.equal(pointsAllowedBandValue(13), 4);
  assert.equal(pointsAllowedBandValue(20), 2);
  assert.equal(pointsAllowedBandValue(27), 0);
  assert.equal(pointsAllowedBandValue(34), -1);
  assert.equal(pointsAllowedBandValue(35), -4);
});

test("shrinkFactorToOne shrinks by sample and clamps", () => {
  assert.equal(shrinkFactorToOne(1.5, 0, 10, 0.85, 1.15), 1); // no games -> neutral
  // 10 games, K=10 -> weight 0.5 -> 1 + 0.5*0.5 = 1.25, clamped to 1.15.
  assert.equal(shrinkFactorToOne(1.5, 10, 10, 0.85, 1.15), 1.15);
  // Small deviation stays inside the band and is shrunk toward 1.
  const modest = shrinkFactorToOne(1.1, 10, 10, 0.85, 1.15);
  assert.ok(modest > 1 && modest < 1.1);
});

const MATCHUP_HEADER = "player_id,player_display_name,position,season,week,season_type,team,opponent_team,rushing_yards,rushing_tds";
function statsCsv(rows) {
  return [MATCHUP_HEADER, ...rows.map((r) => `${r.id},${r.name},${r.pos},${r.season},${r.week},REG,${r.team},${r.opp},${r.ry ?? 0},${r.rtd ?? 0}`)].join("\n");
}
const GAMES_HEADER = "game_id,season,game_type,week,away_team,away_score,home_team,home_score";
function gamesCsv(rows) {
  return [GAMES_HEADER, ...rows.map((r) => `${r.id},${r.season},REG,${r.week},${r.away},${r.as},${r.home},${r.hs}`)].join("\n");
}

test("buildOpponentMatchup produces a measured, shrunk factor and flags unsupported opponents", () => {
  // RB rushes for a lot vs defense SOFT and little vs defense HARD, across many weeks.
  const rows = [];
  for (let week = 1; week <= 17; week += 1) {
    rows.push({ id: "rb1", name: "Back", pos: "RB", season: 2025, week, team: "OFF", opp: "SOFT", ry: 150, rtd: 1 });
    rows.push({ id: "rb2", name: "Back2", pos: "RB", season: 2025, week, team: "OFF2", opp: "HARD", ry: 10, rtd: 0 });
  }
  const games = [];
  for (let week = 1; week <= 17; week += 1) {
    games.push({ id: `g${week}`, season: 2025, week, away: "OFF", as: 30, home: "SOFT", hs: 3 });
    games.push({ id: `h${week}`, season: 2025, week, away: "OFF2", as: 3, home: "HARD", hs: 30 });
  }
  const provider = buildOpponentMatchup({
    seasonTexts: [{ season: 2025, text: statsCsv(rows) }],
    gamesText: gamesCsv(games),
    dstBaselineMean: 6,
  });
  const soft = provider.offenseFactor("SOFT", "RB");
  const hard = provider.offenseFactor("HARD", "RB");
  assert.equal(soft.supported, true);
  assert.equal(hard.supported, true);
  assert.ok(soft.factor > 1, `SOFT should boost RBs, got ${soft.factor}`);
  assert.ok(hard.factor < 1, `HARD should suppress RBs, got ${hard.factor}`);
  // An unknown opponent is neutral and flagged unsupported (never fabricated).
  const unknown = provider.offenseFactor("ZZZ", "RB");
  assert.equal(unknown.supported, false);
  assert.equal(unknown.factor, 1);
  // DEF matchup: a defense facing OFF2 (which scores only 3/gm) earns a better points-allowed band.
  const vsWeakOffense = provider.defFactor("OFF2");
  assert.equal(vsWeakOffense.supported, true);
  assert.ok(vsWeakOffense.factor > 1, `DEF vs a 3-pt offense should be favorable, got ${vsWeakOffense.factor}`);
  assert.equal(provider.meta.seasonsUsed[0], 2025);
});

test("full offense requires measured role: starter, backup, missing identity and source families cannot restore preseason points", () => {
  const board = { players: [
    // Depth-chart starter alone cannot restore a preseason healthy/full-role rate.
    { yahooId: "cmc", sleeperId: "s_cmc", gsisId: "g_cmc", name: "Star RB", position: "RB", team: "SF", perGamePoints: 17.10, weeklyPoints: [16.03, 16.03], scorableSourceFamilyCount: 4 },
    // Backup's role-limited preseason rate is diagnostic only.
    { yahooId: "mar", sleeperId: "s_mar", gsisId: "g_mar", name: "Backup QB", position: "QB", team: "WAS", perGamePoints: 1.95, weeklyPoints: [0.12, 0.12], scorableSourceFamilyCount: 3 },
    // Unknown current role cannot consume the role-limited preseason rate either.
    { yahooId: "beck", sleeperId: null, gsisId: "g_beck", name: "No Entry QB", position: "QB", team: "CLE", perGamePoints: 12.94, weeklyPoints: [3.23, 3.23], scorableSourceFamilyCount: 3 },
    // Single scorable family -> prior gated (dropped); no actual -> unrankable.
    { yahooId: "solo", sleeperId: "s_solo", gsisId: "g_solo", name: "Yahoo Only", position: "WR", team: "BUF", perGamePoints: 10, weeklyPoints: [9, 9], scorableSourceFamilyCount: 1 },
  ] };
  const playersMap = {
    s_cmc: { full_name: "Star RB", team: "SF", position: "RB", status: "Active", active: true, depth_chart_order: 1 },
    s_mar: { full_name: "Backup QB", team: "WAS", position: "QB", status: "Active", active: true, depth_chart_order: 2 },
    s_solo: { full_name: "Yahoo Only", team: "BUF", position: "WR", status: "Active", active: true, depth_chart_order: 1 },
  };
  const schedule = {
    byTeam: new Map([
      ["SF", { opponent: "MIA", homeAway: "home", kickoff: "t" }],
      ["WAS", { opponent: "DAL", homeAway: "away", kickoff: "t" }],
      ["CLE", { opponent: "BAL", homeAway: "home", kickoff: "t" }],
      ["BUF", { opponent: "NYJ", homeAway: "home", kickoff: "t" }],
    ]),
    byeTrusted: false,
  };
  const rankings = buildFullWeeklyRankings({
    board, rosterInputs: { players: [] }, weekStatsList: [{ week: 1, stats: {} }],
    playersMap, schedule, matchupProvider: null, opportunityRates: null,
    teamDefenseMean: 5, targetWeek: 2, generatedAt: "t", provenance: {},
  });
  const byId = Object.fromEntries(rankings.players.map((p) => [p.playerId, p]));
  for (const id of ["cmc", "mar", "beck", "solo"]) {
    assert.equal(byId[id].priorPerGame, null);
    assert.equal(byId[id].priorBasis, "CURRENT_OFFENSIVE_ROLE");
    assert.equal(byId[id].rankable, false);
    assert.equal(byId[id].unrankableReason, "NO_MEASURED_OFFENSIVE_ROLE");
  }
  assert.equal(byId.cmc.currentStarter, true);
  assert.equal(byId.mar.roleLimitedPrior, 0.12); // retained diagnostic, never consumed
});

test("full offense does not substitute a conditional prior or box-score-only form for missing measured snaps", () => {
  const board = { players: [
    // Penix: multi-family, fresh depth 2 (backup), perGame 10.02, NO weeklyPoints[wk2] -> no prior.
    { yahooId: "penix", sleeperId: "1001", gsisId: "g_penix", name: "Backup Elect", position: "QB", team: "ATL", perGamePoints: 10.02294, weeklyPoints: [5.0], scorableSourceFamilyCount: 3 },
    // Rush: multi-family, no current depth entry, perGame 8.457, no weeklyPoints array -> no prior.
    { yahooId: "rush", sleeperId: "1002", gsisId: "g_rush", name: "Journeyman QB", position: "QB", team: "BAL", perGamePoints: 8.45735, scorableSourceFamilyCount: 3 },
  ] };
  const playersMap = {
    "1001": { full_name: "Backup Elect", team: "ATL", position: "QB", status: "Active", active: true, depth_chart_order: 2 },
    "1002": { full_name: "Journeyman QB", team: "BAL", position: "QB", status: "Active", active: true, depth_chart_order: null },
  };
  const schedule = { byTeam: new Map([["ATL", { opponent: "CAR", homeAway: "home", kickoff: "t" }], ["BAL", { opponent: "CLE", homeAway: "away", kickoff: "t" }]]), byeTrusted: false };
  // No form -> no prior substitution -> explicitly unrankable with the distinct missing-role reason.
  const noForm = buildFullWeeklyRankings({ board, rosterInputs: { players: [] }, weekStatsList: [{ week: 1, stats: {} }], playersMap, schedule, matchupProvider: null, opportunityRates: null, teamDefenseMean: 5, targetWeek: 2, generatedAt: "t", provenance: {} });
  const byId = Object.fromEntries(noForm.players.map((p) => [p.playerId, p]));
  for (const id of ["penix", "rush"]) {
    assert.equal(byId[id].priorPerGame ?? null, null, `${id} must NOT substitute perGamePoints as a prior`);
    assert.equal(byId[id].priorBasis, "CURRENT_OFFENSIVE_ROLE");
    assert.equal(byId[id].rankable, false);
    assert.equal(byId[id].unrankableReason, "NO_MEASURED_OFFENSIVE_ROLE");
  }
  assert.equal(noForm.audit.unrankableReasons.NO_MEASURED_OFFENSIVE_ROLE, 2);
  // Box-score-only form without a measured snap denominator is still unknown role.
  const actual = { gp: 1, tm_off_snp: 60, pass_att: 30, pass_yd: 250, pass_td: 2, rush_att: 2, rush_yd: 5 };
  const formInput = { board, rosterInputs: { players: [] }, playersMap, schedule, matchupProvider: null, opportunityRates: null, teamDefenseMean: 5, targetWeek: 2, generatedAt: "t", provenance: {} };
  const withForm = buildFullWeeklyRankings({ ...formInput, weekStatsList: [{ week: 1, stats: { "1001": actual } }] });
  const p2 = withForm.players.find((p) => p.playerId === "penix");
  assert.equal(p2.priorPerGame ?? null, null);
  assert.equal(p2.rankable, false);
  assert.equal(p2.unrankableReason, "NO_MEASURED_OFFENSIVE_ROLE");
  assert.equal(p2.weeklyExpectation, null);
  // Numeric Sleeper identity and present team denominator reach the actual missing-off_snp
  // branch. The identical box score WITH measured full snaps is a known-role projection.
  const measured = buildFullWeeklyRankings({ ...formInput, weekStatsList: [{ week: 1, stats: { "1001": { ...actual, off_snp: 55 } } }] });
  assert.equal(measured.players.find(p => p.playerId === "penix").rankable, true);
  assert.ok(measured.players.find(p => p.playerId === "penix").weeklyExpectation > 0);
});

test("IDP weekly ranking uses measured role and pooled rate rather than preseason points or special teams", () => {
  const board = { players: [
    { yahooId: "gated", sleeperId: "100", gsisId: "g100", name: "Gated LB", position: "ILB", team: "AAA", perGamePoints: 30, weeklyPoints: [30, 30], scorableSourceFamilyCount: 1 },
    { yahooId: "trusted", sleeperId: "101", gsisId: "g101", name: "Trusted LB", position: "LB", team: "AAA", perGamePoints: 6, weeklyPoints: [6, 6], scorableSourceFamilyCount: 2 },
    { yahooId: "zero", sleeperId: "102", gsisId: "g102", name: "Zero OLB", position: "OLB", team: "AAA", scorableSourceFamilyCount: 0 },
    { yahooId: "special", sleeperId: "103", gsisId: "g103", name: "Special Only", position: "LB", team: "AAA", scorableSourceFamilyCount: 0 },
  ] };
  const playersMap = Object.fromEntries([
    ["100", "ILB", "g100"], ["101", "LB", "g101"], ["102", "OLB", "g102"],
    ["103", "LB", "g103"], ["104", "EDGE", "g104"], ["105", "SS", "g105"],
    ["106", "MLB", "g106"], ["107", "ILB", "g100"],
  ].map(([id, position, gsis_id]) => [id, { full_name: `Player ${id}`, team: "AAA", active: true, status: "Active", position, fantasy_positions: [position], gsis_id }]));
  const weekStatsList = [{ week: 1, stats: {
    100: { def_snp: 40, tm_def_snp: 60, idp_tkl_solo: 20 }, // 10 points
    101: { def_snp: 40, tm_def_snp: 60, idp_tkl_solo: 4 }, // 2 points
    102: { def_snp: 20, tm_def_snp: 60 }, // real defensive zero
    103: { gp: 1, st_snp: 10 }, // no defensive actual
    104: { def_snp: 30, tm_def_snp: 60, idp_tkl_solo: 10 }, // DL, not LB
    105: { def_snp: 30, tm_def_snp: 60, idp_tkl_solo: 2 }, // DB, not LB
    106: { def_snp: 30, tm_def_snp: 60, idp_tkl_solo: 2 }, // added LB, 1 point
    107: { def_snp: 40, tm_def_snp: 60, idp_tkl_solo: 20 }, // duplicate gsis identity, excluded
    200: { gp: 1, rush_att: 5, rush_yd: 50 }, // non-IDP, excluded
  } }];
  const rankings = buildFullWeeklyRankings({
    board, rosterInputs: { players: [] }, weekStatsList, playersMap,
    schedule: { byTeam: new Map([["AAA", { opponent: "BBB", kickoff: "t" }]]), byeTrusted: false },
    matchupProvider: null, opportunityRates: null, teamDefenseMean: 5,
    targetWeek: 2, generatedAt: "t", provenance: {},
  });
  const byId = Object.fromEntries(rankings.players.map((row) => [row.playerId, row]));
  assert.equal(byId.gated.priorGated, true);
  assert.equal(byId.gated.priorBasis, "CURRENT_DEFENSIVE_ROLE");
  assert.equal(byId.gated.priorPerGame, null);
  assert.equal(byId.gated.rankBasis, "IDP_CURRENT_SNAP_ROLE");
  assert.equal(byId.trusted.priorPerGame, null);
  assert.equal(byId.trusted.priorBasis, "CURRENT_DEFENSIVE_ROLE");
  assert.equal(byId.trusted.rankBasis, "IDP_CURRENT_SNAP_ROLE");
  assert.ok(byId.gated.weeklyExpectation > byId.trusted.weeklyExpectation);
  assert.equal(byId.zero.idpModel.observedEventPoints, 0);
  assert.equal(byId.zero.idpModel.latestShare, 1 / 3);
  assert.equal(byId.special.rankable, false);
  assert.equal(byId.special.unrankableReason, "NO_VALID_DEFENSIVE_SNAP_HISTORY");
  const added = byId["sleeper:106"];
  assert.equal(added.universe, "missing-active");
  assert.equal(added.rankBasis, "IDP_CURRENT_SNAP_ROLE");
  assert.equal(rankings.provenance.idpOpportunity.groups.LB.sampledPlayerWeeks, 4);
  assert.equal(rankings.provenance.idpOpportunity.coverage.duplicateAliases, 1);
});

test("currentPlayerStatus flags confirmed-out injuries but never invents a probability", () => {
  assert.deepEqual(currentPlayerStatus(null), { hasEntry: false, availabilityStatus: null, rawInjuryStatus: null, sleeperStatus: null, currentTeam: null, yahooId: null, gsisId: null });
  assert.equal(currentPlayerStatus({ injury_status: "IR", status: "Inactive", team: "NE" }).availabilityStatus, "IR");
  assert.equal(currentPlayerStatus({ injury_status: "Questionable", status: "Active", team: "NE" }).availabilityStatus, "QUESTIONABLE");
  // Ambiguous NA co-occurs with Active -> not zeroed, raw preserved.
  const na = currentPlayerStatus({ injury_status: "NA", status: "Active", team: "GB", yahoo_id: 5 });
  assert.equal(na.availabilityStatus, null);
  assert.equal(na.rawInjuryStatus, "NA");
  assert.equal(na.yahooId, "5");
  // Healthy active with no flag.
  assert.equal(currentPlayerStatus({ status: "Active", team: "BUF" }).availabilityStatus, "HEALTHY");
});

test("completedWeeksSignal distinguishes an absent actual from a real zero and counts participation/returns", () => {
  const rates = { ratesByPosition: {}, overall: { pass: 0, rush: 1, rec: 1 } };
  // No row / no participation -> ABSENT (null), not a zero.
  const absent = completedWeeksSignal({ scoringKind: "offense", position: "RB", statsKey: "9" }, [{ stats: { 9: { rush_att: 0, rush_yd: 0 } } }], rates);
  assert.equal(absent, null);
  // Participation with an empty box score (off_snp>0, gp 1) is a REAL zero: game counts, points 0, not produced.
  const playedZero = completedWeeksSignal({ scoringKind: "offense", position: "WR", statsKey: "9" }, [{ stats: { 9: { gp: 1, off_snp: 32 } } }], rates);
  assert.ok(playedZero && playedZero.games === 1);
  assert.equal(playedZero.week1Points, 0);
  assert.equal(playedZero.produced, false);
  // A returner with kick/punt return yards PRODUCED points (returns score) and is not dropped.
  const returner = completedWeeksSignal({ scoringKind: "offense", position: "WR", statsKey: "9" }, [{ stats: { 9: { st_snp: 6, kr: 3, kr_yd: 82, pr: 2, pr_yd: 10 } } }], rates);
  assert.ok(returner && returner.games === 1 && returner.produced === true);
  assert.ok(returner.week1Points > 0);
});
