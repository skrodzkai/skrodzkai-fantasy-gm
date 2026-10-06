import { OFFENSE_SCORING } from "./player-intelligence.mjs";

const finite = (value) => value != null && value !== "" && Number.isFinite(Number(value));
const n = (value) => finite(value) ? Number(value) : 0;
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const channels = ["passAttempts", "carries", "targets"];
const positions = new Set(["QB", "RB", "WR", "TE", "FB"]);

// Separate repeatable yardage/completion/reception efficiency from TDs, turnovers and
// threshold bonuses. Rare events use the pooled position rate, never a player's hot TD run.
function offenseSample(raw) {
  const s = OFFENSE_SCORING;
  return {
    volume: { passAttempts: n(raw.pass_att), carries: n(raw.rush_att), targets: n(raw.rec_tgt) },
    stable: {
      passAttempts: n(raw.pass_cmp) * s.passingCompletions + n(raw.pass_yd) * s.passingYards,
      carries: n(raw.rush_yd) * s.rushingYards,
      targets: n(raw.rec) * s.receptions + n(raw.rec_yd) * s.receivingYards,
    },
    events: {
      passAttempts: n(raw.pass_td) * s.passingTouchdowns + n(raw.pass_int) * s.interceptions,
      carries: n(raw.rush_td) * s.rushingTouchdowns + (n(raw.rush_yd) >= 100 ? s.rushingHundredYardGames : 0),
      targets: n(raw.rec_td) * s.receivingTouchdowns + (n(raw.rec_yd) >= 100 ? s.receivingHundredYardGames : 0),
    },
    other: (n(raw.kr_yd) + n(raw.pr_yd)) * s.returnYards + (n(raw.kr_td) + n(raw.pr_td)) * s.returnTouchdowns +
      (n(raw.pass_2pt) + n(raw.rush_2pt) + n(raw.rec_2pt)) * s.twoPointConversions + n(raw.fum_lost) * s.fumblesLost,
    snaps: finite(raw.off_snp) ? Number(raw.off_snp) : null,
    teamSnaps: finite(raw.tm_off_snp) ? Number(raw.tm_off_snp) : null,
    started: n(raw.gs) === 1,
  };
}

/** Current completed-season opportunity evidence. One physical identity per player-week. */
export function buildOffenseRoleModel(weekStatsList, playersMap, completedThroughWeek) {
  if (!Number.isInteger(completedThroughWeek) || completedThroughWeek < 1 ||
      weekStatsList.length !== completedThroughWeek || weekStatsList.some((row, i) => row.week !== i + 1))
    throw new Error("offense completed weeks must be exactly 1 through cutoff");
  const records = new Map(), teams = new Map(), pools = new Map();
  let excludedTeamHistoryRows = 0;
  for (const { week, stats } of weekStatsList) {
    // Historical rows have no NFL-team field. Current team plus a conflicting team-snap
    // denominator is insufficient to assign history after a trade. Use the measured modal
    // denominator and exclude conflicts explicitly, rather than pooling them into a new team.
    const denominators = new Map();
    for (const [key, raw] of Object.entries(stats ?? {})) {
      const entry = playersMap[key];
      if (!/^\d+$/.test(key) || !entry?.team || !positions.has(entry.position) || !finite(raw.tm_off_snp) || Number(raw.tm_off_snp) <= 0) continue;
      const counts = denominators.get(entry.team) ?? new Map();
      counts.set(Number(raw.tm_off_snp), (counts.get(Number(raw.tm_off_snp)) ?? 0) + 1);
      denominators.set(entry.team, counts);
    }
    const teamDenominator = new Map([...denominators].map(([team, counts]) => {
      const ranked = [...counts].sort((a, b) => b[1] - a[1]);
      return [team, ranked[0][1] === ranked[1]?.[1] ? null : ranked[0][0]];
    }));
    const seen = new Set();
    for (const [key, raw] of Object.entries(stats ?? {})) {
      const entry = playersMap[key], position = String(entry?.position ?? "").toUpperCase();
      if (!/^\d+$/.test(key) || !entry?.team || !positions.has(position)) continue;
      const identity = String(entry.gsis_id || key);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const sample = offenseSample(raw);
      if (!finite(sample.teamSnaps) || sample.teamSnaps <= 0) continue;
      if (teamDenominator.get(entry.team) !== sample.teamSnaps) {
        excludedTeamHistoryRows += 1;
        const record = records.get(identity) ?? { position, team: entry.team, weeks: new Map(), sleeperIds: [] };
        record.sleeperIds.push(key); record.teamHistoryAmbiguous = true; records.set(identity, record);
        continue;
      }
      const teamKey = `${entry.team}:${week}`;
      const team = teams.get(teamKey) ?? { week, team: entry.team, teamSnaps: sample.teamSnaps,
        volume: Object.fromEntries(channels.map((channel) => [channel, 0])) };
      for (const channel of channels) team.volume[channel] += sample.volume[channel];
      teams.set(teamKey, team);
      const record = records.get(identity) ?? { position, team: entry.team, weeks: new Map(), sleeperIds: [] };
      record.sleeperIds.push(key);
      // Missing off_snp is UNKNOWN, not a measured zero. Still counts toward team volume.
      if (finite(sample.snaps) && sample.snaps >= 0 && sample.snaps <= sample.teamSnaps) record.weeks.set(week, sample);
      records.set(identity, record);
      if (!finite(sample.snaps) || sample.snaps <= 0) continue;
      const pooled = pools.get(position) ?? { other: 0, games: 0,
        channels: Object.fromEntries(channels.map((channel) => [channel, { volume: 0, stable: 0, events: 0, games: 0 }])) };
      pooled.other += sample.other;
      pooled.games += 1;
      for (const channel of channels) if (sample.volume[channel] > 0) {
        const c = pooled.channels[channel];
        c.volume += sample.volume[channel]; c.stable += sample.stable[channel]; c.events += sample.events[channel]; c.games += 1;
      }
      pools.set(position, pooled);
    }
  }
  const rates = Object.fromEntries([...pools].map(([position, pool]) => [position, {
    otherPerGame: pool.other / pool.games,
    channels: Object.fromEntries(channels.map((channel) => {
      const c = pool.channels[channel];
      return [channel, { stableRate: c.volume ? c.stable / c.volume : null,
        eventRate: c.volume ? c.events / c.volume : null, equivalentVolume: c.games ? c.volume / c.games : null,
        sampleVolume: c.volume, sampledPlayerWeeks: c.games }];
    })),
  }]));
  const bySleeperId = new Map();
  for (const record of records.values()) for (const id of record.sleeperIds) bySleeperId.set(id, record);
  return { completedThroughWeek, bySleeperId, teams, rates, excludedTeamHistoryRows,
    basis: "recent measured team-opportunity shares; yardage efficiency shrunk by one pooled player-game; TD/turnover/bonus rates pooled by position; no preseason points anchor",
    limitations: "uncalibrated; current identity team maps historical rows, so trades require review; current role carried forward, no injury recovery forecast; no numeric workload inferred from depth rank" };
}

export function offensePointsForVolume(model, volume) {
  if (!model?.channelRates || channels.some((channel) => !finite(volume?.[channel]) || Number(volume[channel]) < 0)) return null;
  let points = n(model.otherBaseline);
  for (const channel of channels) {
    const rate = model.channelRates[channel];
    if (Number(volume[channel]) > 0 && !finite(rate)) return null;
    points += Number(volume[channel]) * n(rate);
  }
  return points;
}

export function projectOffenseRole(model, sleeperId, { depthChartOrder = null } = {}) {
  const record = model.bySleeperId.get(String(sleeperId));
  const unknown = (status, extra = {}) => ({ status, weeklyExpectation: null, ...extra });
  if (!record || !record.weeks.size) return unknown("NO_MEASURED_OFFENSIVE_ROLE");
  if (record.teamHistoryAmbiguous) return unknown("HISTORICAL_TEAM_ROLE_REQUIRES_REVIEW");
  const samples = [...record.weeks].sort(([a], [b]) => a - b);
  const latestTeamWeek = [...model.teams.values()].filter((row) => row.team === record.team).at(-1)?.week;
  const latest = samples.at(-1);
  if (latest[0] !== latestTeamWeek) return unknown("LATEST_OFFENSIVE_ROLE_UNKNOWN");
  const continuity = latest[0] === model.completedThroughWeek ? "LATEST_WEEK_MEASURED" : "UNVERIFIED_NO_LATEST_TEAM_GAME";
  if (latest[0] < model.completedThroughWeek - 1) return unknown("LATEST_OFFENSIVE_ROLE_UNKNOWN");
  const share = latest[1].snaps / latest[1].teamSnaps;
  const previous = samples.slice(0, -1).map(([, row]) => row.snaps / row.teamSnaps);
  const shareChange = previous.length ? share - mean(previous) : null;
  const roleChanging = shareChange != null && Math.abs(shareChange) >= 0.20;
  // An announced/depth-chart replacement cannot be valued as a starter from relief snaps.
  const starterObserved = samples.some(([, row]) => row.snaps / row.teamSnaps >= 0.80 && row.volume.passAttempts > 0);
  if (record.position === "QB" && !starterObserved)
    return unknown("REPLACEMENT_STARTER_WORKLOAD_UNKNOWN", { latestShare: share, roleChanging, roleContinuity: continuity });
  const recent = roleChanging ? samples.slice(-1) : samples.slice(-2);
  const recentTeams = [...model.teams.values()].filter((row) => row.team === record.team);
  const teamBudget = Object.fromEntries(channels.map((channel) => [channel, mean(recentTeams.map((row) => row.volume[channel]))]));
  const expectedVolume = Object.fromEntries(channels.map((channel) => [channel, teamBudget[channel] * mean(recent.map(([week, row]) => {
    const total = model.teams.get(`${record.team}:${week}`).volume[channel];
    return total > 0 ? row.volume[channel] / total : 0;
  }))]));
  // Different role-change windows must never create extra team opportunities. Normalize only
  // over measured teammates; absent/unknown player rows receive no manufactured allocation.
  const teamShares = Object.fromEntries(channels.map((channel) => [channel, 0]));
  for (const teammate of new Set(model.bySleeperId.values())) {
    if (teammate.team !== record.team || !teammate.weeks.has(latestTeamWeek)) continue;
    const rows = [...teammate.weeks].sort(([a], [b]) => a - b), last = rows.at(-1)[1];
    const prior = rows.slice(0, -1).map(([, row]) => row.snaps / row.teamSnaps);
    const changing = prior.length > 0 && Math.abs(last.snaps / last.teamSnaps - mean(prior)) >= 0.20;
    const window = rows.slice(changing ? -1 : -2);
    for (const channel of channels) teamShares[channel] += mean(window.map(([week, row]) => {
      const total = model.teams.get(`${record.team}:${week}`).volume[channel];
      return total > 0 ? row.volume[channel] / total : 0;
    }));
  }
  const teamConservationFactor = Object.fromEntries(channels.map((channel) => [channel, 1 / Math.max(1, teamShares[channel])]));
  for (const channel of channels) expectedVolume[channel] *= teamConservationFactor[channel];
  const pool = model.rates[record.position];
  if (!pool) return unknown("NO_OFFENSE_POSITION_RATE");
  const channelRates = {}, stableRates = {}, eventRates = {};
  for (const channel of channels) {
    const pooled = pool.channels[channel];
    const volume = samples.reduce((sum, [, row]) => sum + row.volume[channel], 0);
    const stable = samples.reduce((sum, [, row]) => sum + row.stable[channel], 0);
    stableRates[channel] = pooled.stableRate == null ? null :
      (stable + pooled.stableRate * pooled.equivalentVolume) / (volume + pooled.equivalentVolume);
    eventRates[channel] = pooled.eventRate;
    channelRates[channel] = stableRates[channel] == null ? null : stableRates[channel] + eventRates[channel];
  }
  const result = { status: "CURRENT_OFFENSIVE_ROLE", expectedVolume, teamBudget, teamConservationFactor, channelRates, stableRates, eventRates,
    otherBaseline: pool.otherPerGame, latestShare: share, shareChange, roleChanging, roleContinuity: continuity,
    validWeeks: samples.map(([week]) => week), roleWeeks: recent.map(([week]) => week), sampleGames: samples.length,
    starterWorkloadObserved: record.position !== "QB" || starterObserved,
    currentPartialQbRole: record.position === "QB" && share < 0.80,
    uncertainty: roleChanging || recent.length < 2 || continuity !== "LATEST_WEEK_MEASURED" ? "HIGH" : "MODERATE_UNCALIBRATED",
    basis: model.basis, limitations: model.limitations };
  result.weeklyExpectation = offensePointsForVolume(result, expectedVolume);
  if (result.weeklyExpectation == null) result.status = "NO_OFFENSE_CHANNEL_RATE";
  if (record.position === "QB" && depthChartOrder === 1 && share < 0.80 && starterObserved) {
    const fullStarts = samples.filter(([, row]) => row.snaps / row.teamSnaps >= 0.80 && row.volume.passAttempts > 0).slice(-2);
    const fullVolume = Object.fromEntries(channels.map(channel => [channel, teamBudget[channel] * mean(fullStarts.map(([week, row]) => {
      const total = model.teams.get(`${record.team}:${week}`).volume[channel];
      return total > 0 ? row.volume[channel] / total : 0;
    }))]));
    result.conditionalFullStart = { ...result, expectedVolume: fullVolume,
      roleWeeks: fullStarts.map(([week]) => week), weeklyExpectation: offensePointsForVolume(result, fullVolume),
      basis: "conditional full-starter scenario using previously measured full offensive games; requires fresh clearance/role review, no recovery probability" };
    result.partialRoleExpectation = result.weeklyExpectation;
    result.weeklyExpectation = null;
    result.status = "PARTIAL_QB_STARTER_ROLE_REQUIRES_AVAILABILITY_REVIEW";
    result.uncertainty = "HIGH";
  }
  return result;
}
