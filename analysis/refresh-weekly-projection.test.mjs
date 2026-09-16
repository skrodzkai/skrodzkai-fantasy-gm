import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReceiptPeriod,
  verifySchedulePayload,
  pointsAllowedBandValue,
  shrinkFactorToOne,
  buildOpponentMatchup,
  currentPlayerStatus,
  completedWeeksSignal,
} from "./refresh-weekly-projection.mjs";

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
