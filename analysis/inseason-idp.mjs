import { scoreIdpStatLine } from "./player-intelligence.mjs";
import { CONFIRMED_INACTIVE_STATUS } from "./weekly-roster-utility.mjs";

const GROUP = { DL: "DL", DE: "DL", DT: "DL", NT: "DL", EDGE: "DL", LB: "LB", ILB: "LB", OLB: "LB", MLB: "LB", DB: "DB", S: "DB", CB: "DB", SS: "DB", FS: "DB" };
export const idpGroup = (position) => GROUP[String(position ?? "").toUpperCase()] ?? null;
export const idpEligibility = (positions) => [...new Set((positions ?? []).map((position) => String(position).toUpperCase()).flatMap((position) => {
  if (position === "D") return ["D"];
  const group = idpGroup(position);
  return group ? [group, "D"] : [];
}))];

const hasNumber = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const numberOrZero = (value) => hasNumber(value) ? Number(value) : 0;

function candidateExclusion(item) {
  if (item?.locked === true) return "CANDIDATE_LOCKED";
  if (item?.injuryStatus !== null && typeof item?.injuryStatus !== "string") return "CANDIDATE_STATUS_UNKNOWN";
  const raw = String(item.injuryStatus ?? "").trim().toUpperCase();
  const status = ({ O: "OUT", "PUP-R": "PUP", "PUP-P": "PUP", "NFI-R": "NFI", "NFI-A": "NFI", SUSP: "SUSPENDED" })[raw] ?? raw;
  if (CONFIRMED_INACTIVE_STATUS.has(status)) return "CANDIDATE_CONFIRMED_INACTIVE";
  if (!["", "Q", "QUESTIONABLE", "D", "DOUBTFUL", "P", "PROBABLE", "HEALTHY", "ACTIVE"].includes(status)) return "CANDIDATE_STATUS_UNKNOWN";
  if (item.availability === "W" && (!Number.isFinite(Date.parse(item.conditionalExpiresAt)) || Date.parse(item.conditionalExpiresAt) <= Date.now())) return "WAIVER_CONDITION_EXPIRED_OR_MISSING";
  return null;
}

export function sleeperIdpLine(stats) {
  return {
    soloTackles: stats.idp_tkl_solo, assistedTackles: stats.idp_tkl_ast,
    sacks: stats.idp_sack, interceptions: stats.idp_int,
    forcedFumbles: stats.idp_ff, fumbleRecoveries: stats.idp_fum_rec,
    touchdowns: stats.idp_def_td, safeties: stats.idp_safe,
    passesDefended: stats.idp_pass_def, blockedKicks: stats.idp_blk_kick,
    tacklesForLoss: stats.idp_tkl_loss,
    turnoverReturnYards: numberOrZero(stats.idp_int_ret_yd) + numberOrZero(stats.idp_fum_ret_yd),
  };
}

// Sleeper omits zero fields. An absent player-week or absent def_snp is UNKNOWN; an explicit
// def_snp:0 with a valid team denominator is a measured zero role. Special teams alone never counts.
function defensiveWeek(stats) {
  if (!stats || !hasNumber(stats.def_snp) || !hasNumber(stats.tm_def_snp)) return null;
  const snaps = Number(stats.def_snp);
  const teamSnaps = Number(stats.tm_def_snp);
  if (snaps < 0 || teamSnaps <= 0 || snaps > teamSnaps) return null;
  const tackle = scoreIdpStatLine({ soloTackles: stats.idp_tkl_solo, assistedTackles: stats.idp_tkl_ast });
  const full = scoreIdpStatLine(sleeperIdpLine(stats));
  return { snaps, teamSnaps, share: snaps / teamSnaps, tackle, events: full - tackle };
}

/** Point-in-time pooled rates. One GSIS identity contributes once per completed week. */
export function buildIdpOpportunityModel(weekStatsList, playersMap, targetWeek) {
  if (!Number.isInteger(targetWeek) || targetWeek < 2 || targetWeek > 18) throw new Error("invalid targetWeek");
  if (!Array.isArray(weekStatsList) || weekStatsList.length !== targetWeek - 1 ||
      weekStatsList.some(({ week }, index) => week !== index + 1)) throw new Error("completed weeks must be exactly 1 through targetWeek-1");
  const groups = Object.fromEntries(["DL", "LB", "DB"].map((group) => [group, { snaps: 0, tackles: 0, events: 0, teamSnaps: [], playerWeeks: 0 }]));
  const byIdentity = new Map();
  const bySleeperId = new Map();
  const teamsPlayed = new Map();
  const coverage = { defensiveRows: 0, validDenominators: 0, missingDenominators: 0, duplicateAliases: 0 };
  for (const { week, stats } of weekStatsList) {
    const seen = new Set();
    const played = new Set();
    teamsPlayed.set(week, played);
    for (const [key, raw] of Object.entries(stats ?? {})) {
      if (!/^\d+$/.test(key)) continue;
      const entry = playersMap[key];
      if (entry?.team && hasNumber(raw?.tm_def_snp) && Number(raw.tm_def_snp) > 0) played.add(entry.team);
      const group = (entry?.fantasy_positions ?? []).map(idpGroup).find(Boolean) ?? idpGroup(entry?.position);
      if (!group) continue;
      if (!hasNumber(raw?.def_snp)) continue;
      coverage.defensiveRows += 1;
      const sample = defensiveWeek(raw);
      if (!sample) { coverage.missingDenominators += 1; continue; }
      coverage.validDenominators += 1;
      const identity = String(entry?.gsis_id || key);
      bySleeperId.set(key, identity);
      if (seen.has(identity)) { coverage.duplicateAliases += 1; continue; }
      seen.add(identity);
      const record = byIdentity.get(identity) ?? { group, team: entry.team ?? null, weeks: new Map() };
      record.weeks.set(week, sample);
      byIdentity.set(identity, record);
      const pooled = groups[group];
      pooled.snaps += sample.snaps;
      pooled.tackles += sample.tackle;
      pooled.events += sample.events;
      pooled.teamSnaps.push(sample.teamSnaps);
      pooled.playerWeeks += 1;
    }
  }
  const rates = Object.fromEntries(Object.entries(groups).map(([group, value]) => [group, {
    tacklePerSnap: value.snaps ? value.tackles / value.snaps : null,
    eventPerSnap: value.snaps ? value.events / value.snaps : null,
    equivalentSnaps: value.teamSnaps.length ? average(value.teamSnaps) : null,
    sampledSnaps: value.snaps, sampledPlayerWeeks: value.playerWeeks,
  }]));
  return { targetWeek, rates, coverage, teamsPlayed, byIdentity, bySleeperId };
}

/** The latest measured role drives workload. Individual splash events are diagnostic only. */
export function projectIdp(model, sleeperId) {
  const identity = model.bySleeperId.get(String(sleeperId));
  const record = identity ? model.byIdentity.get(identity) : null;
  if (!record) return { status: "NO_VALID_DEFENSIVE_SNAP_HISTORY", weeklyExpectation: null };
  const samples = [...record.weeks].sort(([a], [b]) => a - b);
  const latest = samples.at(-1);
  const latestPlayedWeek = record.team ? [...model.teamsPlayed].filter(([, teams]) => teams.has(record.team)).at(-1)?.[0] : null;
  const missingLatestTeamSnaps = !model.teamsPlayed.get(model.targetWeek - 1)?.has(record.team);
  const uncertainCarry = missingLatestTeamSnaps && latest[0] === model.targetWeek - 2;
  if (latest[0] !== latestPlayedWeek || (latest[0] !== model.targetWeek - 1 && !uncertainCarry))
    return { status: "LATEST_WEEK_ROLE_UNKNOWN", weeklyExpectation: null, validWeeks: samples.map(([week]) => week), latestPlayedWeek };
  const recent = samples.slice(-2).map(([, sample]) => sample);
  const previousShares = samples.slice(0, -1).map(([, sample]) => sample.share);
  // A 20 percentage point share move is a descriptive role-change flag, not a fitted threshold.
  const shareChange = previousShares.length ? latest[1].share - average(previousShares) : null;
  const roleChanging = shareChange != null && Math.abs(shareChange) >= 0.20;
  const expectedShare = roleChanging ? latest[1].share : average(recent.map((sample) => sample.share));
  const expectedSnaps = expectedShare * latest[1].teamSnaps;
  const pooled = model.rates[record.group];
  if (!pooled || pooled.tacklePerSnap == null || pooled.equivalentSnaps == null) return { status: "NO_GROUP_RATE", weeklyExpectation: null };
  const snaps = samples.reduce((sum, [, sample]) => sum + sample.snaps, 0);
  const tackles = samples.reduce((sum, [, sample]) => sum + sample.tackle, 0);
  // One observed team-game of group snaps is the explicit small-sample prior. Its size comes
  // from this capture; it is an uncalibrated smoothing choice, not a measured optimal weight.
  const tacklePerSnap = (tackles + pooled.tacklePerSnap * pooled.equivalentSnaps) / (snaps + pooled.equivalentSnaps);
  const tacklePoints = expectedSnaps * tacklePerSnap;
  const eventBaseline = expectedSnaps * pooled.eventPerSnap;
  const weeklyExpectation = tacklePoints + eventBaseline;
  return {
    status: "SNAP_ROLE_MODEL", group: record.group, validWeeks: samples.map(([week]) => week),
    latestPlayedWeek, roleContinuity: uncertainCarry ? "UNVERIFIED_NO_TEAM_SNAP_ROWS" : "LATEST_WEEK_MEASURED",
    latestShare: latest[1].share, expectedShare, expectedSnaps,
    latestTeamSnaps: latest[1].teamSnaps, shareChange, roleChanging,
    tacklePerSnap, groupTacklePerSnap: pooled.tacklePerSnap,
    tacklePoints, eventBaseline, observedEventPoints: samples.reduce((sum, [, sample]) => sum + sample.events, 0),
    weeklyExpectation, uncertainty: samples.length < 2 || roleChanging || uncertainCarry ? "HIGH" : "MODERATE_UNCALIBRATED",
    sampleSnaps: snaps, sampleGames: samples.length,
  };
}

function bestLineup(rows, slots) {
  let best = null;
  const locked = rows.filter((row) => row.locked && row.slot !== "BN").map((row) => row.yahooId);
  function search(index, used, points, selected) {
    if (index === slots.length) {
      if (locked.some((id) => !used.has(id))) return;
      if (!best || points > best.points) best = { points, selected: [...selected] };
      return;
    }
    const slot = slots[index];
    for (const row of rows) {
      if (used.has(row.yahooId) || !row.eligible.includes(slot) || row.points == null) continue;
      if (row.locked && row.slot !== slot) continue;
      used.add(row.yahooId); selected.push({ yahooId: row.yahooId, slot });
      search(index + 1, used, points + row.points, selected);
      selected.pop(); used.delete(row.yahooId);
    }
  }
  search(0, new Set(), 0, []);
  return best;
}

/** Strict Yahoo snapshot join. Never infer free agency from the model universe. */
export function compareIdpStreaming(rankings, snapshot) {
  const fail = (reason, excludedCandidates = []) => ({ disposition: "HOLD", reason, proposals: [], excludedCandidates, nextWeekCoverage: "VERIFIED_NEXT_WEEK_SCHEDULE_NOT_SUPPLIED" });
  if (snapshot?.season !== rankings.season || snapshot?.week !== rankings.targetWeek ||
      String(snapshot?.leagueId) !== "420010" || String(snapshot?.teamId) !== "7" ||
      snapshot?.source !== "YAHOO_VERIFIED_READBACK" ||
      !Number.isFinite(Date.parse(snapshot?.capturedAt)) || !Number.isFinite(Date.parse(snapshot?.expiresAt)) ||
      Date.parse(snapshot.expiresAt) <= Date.parse(snapshot.capturedAt) ||
      Date.parse(snapshot.capturedAt) > Date.now() || Date.parse(snapshot.expiresAt) <= Date.now() ||
      Date.parse(snapshot.capturedAt) < Date.parse(rankings.generatedAt) ||
      !Array.isArray(snapshot?.roster) ||
      !Array.isArray(snapshot?.available)) return fail("INVALID_OR_WRONG_PERIOD_YAHOO_SNAPSHOT");
  const model = new Map(rankings.players.filter((row) => idpGroup(row.position)).map((row) => [String(row.playerId), row]));
  const convert = (item, available) => {
    if (!item || !/^\d+$/.test(String(item.yahooId)) || !Array.isArray(item.eligible) ||
        (available ? !["FA", "W"].includes(item.availability) || typeof item.locked !== "boolean" ||
          !(item.injuryStatus === null || typeof item.injuryStatus === "string") :
          typeof item.droppable !== "boolean" || typeof item.locked !== "boolean")) return null;
    if (available && item.availability === "W" &&
        (!Number.isFinite(Date.parse(item.conditionalExpiresAt)) || Date.parse(item.conditionalExpiresAt) <= Date.now() ||
          Date.parse(item.conditionalExpiresAt) <= Date.parse(snapshot.capturedAt))) return null;
    const row = model.get(String(item.yahooId));
    if (!row) return null;
    const confirmedUnavailable = String(row.unrankableReason ?? "").startsWith("CONFIRMED_INACTIVE_") || row.unrankableReason === "TARGET_WEEK_BYE";
    return { ...item, yahooId: String(item.yahooId), eligible: idpEligibility(item.eligible),
      points: row.rankable ? row.weeklyExpectation : confirmedUnavailable ? 0 : null,
      confirmedUnavailable, evidence: row.idpModel ?? null,
      team: row.team, name: row.name, slot: available ? "BN" : item.slot, locked: available ? false : item.locked };
  };
  const roster = snapshot.roster.map((item) => convert(item, false));
  if (roster.some((row) => !row) || new Set(roster.map((row) => row.yahooId)).size !== roster.length) return fail("UNJOINED_OR_DUPLICATE_ROSTER_YAHOO_IDENTITY");
  const excludedCandidates = [];
  const available = [];
  for (const item of snapshot.available) {
    const exclusion = candidateExclusion(item);
    if (exclusion) {
      excludedCandidates.push({ yahooId: item?.yahooId ?? null, name: item?.name ?? null, reason: exclusion, uncertainty: null });
      continue;
    }
    const row = convert(item, true);
    if (row) available.push(row);
    else excludedCandidates.push({ yahooId: item?.yahooId ?? null, name: item?.name ?? null,
      reason: "UNJOINABLE_OR_INVALID_YAHOO_CANDIDATE", uncertainty: null });
  }
  if (new Set([...roster, ...available].map((row) => row.yahooId)).size !== roster.length + available.length) return fail("DUPLICATE_YAHOO_IDENTITY", excludedCandidates);
  const slots = snapshot.slots;
  if (!Array.isArray(slots) || slots.length !== 3 || [...slots].sort().join(",") !== "D,DB,LB" ||
      roster.some((row) => ![...slots, "BN"].includes(row.slot) || (row.locked && row.slot === "BN"))) return fail("UNKNOWN_LINEUP_OR_LOCK_STATE");
  if (roster.some((row) => row.slot !== "BN" && row.points == null)) return fail("STARTER_ROLE_OR_STATUS_UNKNOWN", excludedCandidates);
  if (roster.some((row) => row.slot !== "BN" && row.evidence?.roleContinuity === "UNVERIFIED_NO_TEAM_SNAP_ROWS"))
    return fail("STARTER_ROLE_CONTINUITY_REQUIRES_REVIEW", excludedCandidates);
  const baseline = bestLineup(roster, slots);
  if (!baseline) return fail("NO_COMPLETE_RANKABLE_IDP_LINEUP", excludedCandidates);
  const proposals = [];
  const heldCandidates = [];
  for (const add of available) {
    if (add.points == null || add.confirmedUnavailable || add.evidence?.status !== "SNAP_ROLE_MODEL" ||
        add.evidence.roleContinuity === "UNVERIFIED_NO_TEAM_SNAP_ROWS") {
      excludedCandidates.push({ yahooId: add.yahooId, name: add.name,
        reason: add.evidence?.roleContinuity === "UNVERIFIED_NO_TEAM_SNAP_ROWS" ? "ADD_ROLE_CONTINUITY_REQUIRES_REVIEW" : "ADD_ROLE_OR_STATUS_UNKNOWN",
        uncertainty: add.evidence?.uncertainty ?? null });
      continue;
    }
    let proposed = false;
    let bestGain = null;
    for (const drop of roster.filter((row) => row.droppable && !row.locked)) {
      const alternate = bestLineup([...roster.filter((row) => row.yahooId !== drop.yahooId), add], slots);
      if (!alternate || !alternate.selected.some((pick) => pick.yahooId === add.yahooId)) continue;
      const gain = alternate.points - baseline.points;
      bestGain = bestGain == null ? gain : Math.max(bestGain, gain);
      if (gain <= 0) continue;
      const displacedId = baseline.selected.find((pick) => !alternate.selected.some((next) => next.yahooId === pick.yahooId))?.yahooId;
      const displaced = roster.find((row) => row.yahooId === displacedId);
      if (!displaced) continue;
      // A positive score alone can be splash or small-sample noise. Require the added role and
      // tackle component to exceed the actual displaced starter's evidence too.
      if (!displaced.confirmedUnavailable && (!displaced.evidence || add.evidence.expectedSnaps <= displaced.evidence.expectedSnaps ||
          add.evidence.tacklePoints <= displaced.evidence.tacklePoints)) continue;
      proposed = true;
      proposals.push({ addYahooId: add.yahooId, addName: add.name, dropYahooId: drop.yahooId,
        dropName: drop.name, displacedYahooId: displaced.yahooId, displacedName: displaced.name, gain,
        before: baseline.selected, after: alternate.selected,
        evidence: { added: add.evidence, displaced: displaced.evidence, uncertainty: add.evidence.uncertainty },
        candidateInjuryStatus: add.injuryStatus,
        availability: add.availability === "W" ? "VERIFIED_W_AT_SNAPSHOT" : "VERIFIED_FA_AT_SNAPSHOT",
        executionCondition: add.availability === "W" ? "YAHOO_VERIFIED_FA_AFTER_WAIVER_RELEASE" : "YAHOO_VERIFIED_FA_AT_EXECUTION",
        executableNow: false, capturedAt: snapshot.capturedAt, snapshotExpiresAt: snapshot.expiresAt,
        expiresAt: add.availability === "W" ? add.conditionalExpiresAt : snapshot.expiresAt, approvalRequired: true });
    }
    if (!proposed) heldCandidates.push({ yahooId: add.yahooId, name: add.name, bestGain,
      uncertainty: add.evidence.uncertainty, reason: bestGain == null ? "NO_LEGAL_LINEUP_FIT" : bestGain <= 0 ? "NO_POSITIVE_LINEUP_GAIN" : "ROLE_OR_TACKLE_EDGE_UNSUPPORTED" });
  }
  proposals.sort((a, b) => b.gain - a.gain);
  return { disposition: proposals.length ? "PROPOSE_FOR_EXACT_APPROVAL" : "HOLD",
    ...(proposals.length ? {} : { reason: "NO_DEFENSIBLE_UNLOCKED_IDP_IMPROVEMENT" }),
    proposals, heldCandidates, excludedCandidates, nextWeekCoverage: "VERIFIED_NEXT_WEEK_SCHEDULE_NOT_SUPPLIED" };
}
