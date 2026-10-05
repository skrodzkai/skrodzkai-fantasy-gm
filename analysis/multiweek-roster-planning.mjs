import { idpEligibility, idpGroup } from "./inseason-idp.mjs";

const finite = (value) => value != null && value !== "" && Number.isFinite(Number(value));
const time = (value) => typeof value === "string" ? Date.parse(value) : NaN;
const statusMap = { Q: "QUESTIONABLE", D: "DOUBTFUL", O: "OUT", "PUP-R": "PUP", "PUP-P": "PUP", "NFI-R": "NFI", "NFI-A": "NFI", SUSP: "SUSPENDED" };
const inactive = new Set(["OUT", "IR", "PUP", "NFI", "SUSPENDED", "DNP", "INACTIVE"]);
const accepted = new Set([...inactive, "QUESTIONABLE", "DOUBTFUL", "GTD", "HEALTHY", "ACTIVE", "PROBABLE"]);
const eligibility = (values) => [...new Set(values.flatMap((position) => {
  const p = String(position).toUpperCase();
  return [p === "DST" ? "DEF" : p === "PK" ? "K" : p, ...idpEligibility([p])];
}))];

// Rectangular Hungarian assignment: polynomial slot/player matching, including negative DST
// scores. Exact current-week locks pin one slot ID; bench locks cannot enter a current lineup.
export function strongestLegalLineup(roster, slots, week, currentWeek) {
  const rows = roster.filter((row) => finite(row.points[week]) && !(week === currentWeek && row.locked && row.slot === "BN"));
  if (rows.length < slots.length) return null;
  const pinned = new Map(week === currentWeek ? rows.filter((row) => row.locked && row.slot !== "BN" && row.slot !== "IR").map((row) => [row.slot, row.yahooId]) : []);
  const legal = (slot, row) => row.slot !== "IR" && slot.eligible.some((p) => row.eligible.includes(p)) &&
    (!pinned.has(slot.id) || pinned.get(slot.id) === row.yahooId) &&
    !(week === currentWeek && row.locked && row.slot !== "BN" && row.slot !== slot.id);
  const count = slots.length, columns = rows.length;
  const u = Array(count + 1).fill(0), v = Array(columns + 1).fill(0), assigned = Array(columns + 1).fill(0), way = Array(columns + 1).fill(0);
  for (let i = 1; i <= count; i += 1) {
    assigned[0] = i;
    let j0 = 0;
    const min = Array(columns + 1).fill(Infinity), used = Array(columns + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = assigned[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= columns; j += 1) if (!used[j]) {
        const cost = legal(slots[i0 - 1], rows[j - 1]) ? -Number(rows[j - 1].points[week]) : 1e12;
        const cur = cost - u[i0] - v[j];
        if (cur < min[j]) { min[j] = cur; way[j] = j0; }
        if (min[j] < delta) { delta = min[j]; j1 = j; }
      }
      for (let j = 0; j <= columns; j += 1) { if (used[j]) { u[assigned[j]] += delta; v[j] -= delta; } else min[j] -= delta; }
      j0 = j1;
    } while (assigned[j0] !== 0);
    do { const j1 = way[j0]; assigned[j0] = assigned[j1]; j0 = j1; } while (j0 !== 0);
  }
  const selected = [];
  for (let j = 1; j <= columns; j += 1) if (assigned[j]) {
    const slot = slots[assigned[j] - 1], row = rows[j - 1];
    if (!legal(slot, row)) return null;
    selected.push({ slot: slot.id, yahooId: row.yahooId, points: Number(row.points[week]) });
  }
  return { points: selected.reduce((sum, pick) => sum + pick.points, 0), selected };
}

/** Advisory only. The snapshot explicitly supplies Yahoo facts; no account/browser/transaction code. */
export function compareMultiweekRoster(report, snapshot, now = Date.now()) {
  const fail = (reason) => ({ disposition: "HOLD", reason, proposals: [], approvalRequired: true, executableNow: false });
  const weeks = report?.weeks;
  const currentWeek = report?.targetWeek;
  const expectedWeeks = Array.from({ length: Math.min(3, 19 - currentWeek) }, (_, i) => currentWeek + i);
  if (!Array.isArray(weeks) || !Number.isInteger(currentWeek) || currentWeek < 2 || currentWeek > 18 ||
      !Number.isInteger(report.season) || !Number.isFinite(time(report.generatedAt)) || time(report.generatedAt) > now ||
      weeks.map((r) => r.targetWeek).join() !== expectedWeeks.join() ||
      weeks.some((r) => r.season !== report.season || r.generatedAt !== report.generatedAt ||
        r.completedThroughWeek !== currentWeek - 1 || r.provenance?.schedule?.week !== r.targetWeek ||
        r.provenance?.schedule?.season !== report.season || !Array.isArray(r.players))) return fail("INVALID_MULTI_WEEK_REPORT");
  if (snapshot?.source !== "YAHOO_VERIFIED_READBACK" || snapshot.fullRosterVerified !== true || snapshot.availableVerified !== true ||
      snapshot.season !== report.season || snapshot.week !== currentWeek || String(snapshot.leagueId) !== "420010" || String(snapshot.teamId) !== "7" ||
      !Number.isFinite(time(snapshot.capturedAt)) || time(snapshot.capturedAt) < time(report.generatedAt) || time(snapshot.capturedAt) > now ||
      !Number.isFinite(time(snapshot.expiresAt)) || time(snapshot.expiresAt) <= now || time(snapshot.expiresAt) <= time(snapshot.capturedAt) ||
      !Array.isArray(snapshot.roster) || !snapshot.roster.length || !Array.isArray(snapshot.available) || !Array.isArray(snapshot.slots) || !snapshot.slots.length)
    return fail("INVALID_OR_STALE_FULL_YAHOO_SNAPSHOT");
  const slots = snapshot.slots;
  if (slots.some((slot) => !slot || typeof slot.id !== "string" || ["BN", "IR"].includes(slot.id) || !Array.isArray(slot.eligible) || !slot.eligible.length) ||
      new Set(slots.map((slot) => slot.id)).size !== slots.length) return fail("INVALID_EXACT_SLOT_CONTRACT");
  const models = weeks.map((r) => new Map(r.players.map((row) => [String(row.playerId), row])));
  if (weeks.some((r, i) => models[i].size !== r.players.length)) return fail("DUPLICATE_FORECAST_IDENTITY");
  const seenIds = new Set(), seenPhysical = new Set();
  const excludedCandidates = [], unknownReserves = [];
  function convert(item, available) {
    if (!item || !/^\d+$/.test(String(item.yahooId)) || seenIds.has(String(item.yahooId)) || !Array.isArray(item.eligible) || !item.eligible.length ||
        typeof item.locked !== "boolean" || !(item.injuryStatus === null || typeof item.injuryStatus === "string") ||
        item.ownership !== (available ? "UNOWNED" : "OWNED") || (!available && (typeof item.droppable !== "boolean" || ![...slots.map((s) => s.id), "BN", "IR"].includes(item.slot))) ||
        (available && (!["FA", "W"].includes(item.availability) || item.availability === "W" &&
          (!Number.isFinite(time(item.conditionalExpiresAt)) || time(item.conditionalExpiresAt) <= now || time(item.conditionalExpiresAt) <= time(snapshot.capturedAt)))))
      throw new Error("UNKNOWN_OR_DUPLICATE_YAHOO_FACTS");
    const injury = item.injuryStatus == null || item.injuryStatus === "" ? "HEALTHY" : statusMap[item.injuryStatus.toUpperCase()] ?? item.injuryStatus.toUpperCase();
    if (!accepted.has(injury)) throw new Error("UNKNOWN_YAHOO_INJURY_STATUS");
    const id = String(item.yahooId), rows = models.map((model) => model.get(id));
    seenIds.add(id);
    if (rows.some((row) => !row)) throw new Error("UNJOINED_EXACT_YAHOO_IDENTITY");
    const physical = rows[0].gsisId ? `g:${rows[0].gsisId}` : rows[0].sleeperId ? `s:${rows[0].sleeperId}` : `y:${id}`;
    if (seenPhysical.has(physical) || rows.some((row) => row.sleeperId !== rows[0].sleeperId || row.position !== rows[0].position))
      throw new Error("DUPLICATE_OR_CHANGED_PHYSICAL_IDENTITY");
    seenPhysical.add(physical);
    const points = Object.fromEntries(rows.map((row, i) => {
      const unavailable = inactive.has(injury) || row.bye === true || String(row.unrankableReason ?? "").startsWith("CONFIRMED_INACTIVE_");
      const statusChanged = !inactive.has(injury) && row.bye !== true && String(row.unrankableReason ?? "").startsWith("CONFIRMED_INACTIVE_");
      const scheduleKnown = row.scheduleStatus === "VERIFIED_BYE" && row.bye === true ||
        row.scheduleStatus === "VERIFIED_GAME" && Number.isFinite(time(row.kickoff));
      return [weeks[i].targetWeek, !scheduleKnown || statusChanged ? null : unavailable ? 0 :
        idpGroup(row.position) && row.idpModel?.roleContinuity === "UNVERIFIED_NO_TEAM_SNAP_ROWS" ? null :
        row.rankable && finite(row.weeklyExpectation) ? Number(row.weeklyExpectation) : null];
    }));
    return { ...item, yahooId: id, eligible: eligibility(item.eligible), points, name: rows[0].name,
      position: rows[0].position, slot: available ? "BN" : item.slot, injuryStatus: injury,
      idpModels: Object.fromEntries(rows.map((row, i) => [weeks[i].targetWeek, row.idpModel])),
      unavailable: Object.fromEntries(rows.map((row, i) => [weeks[i].targetWeek,
        inactive.has(injury) || row.bye === true || String(row.unrankableReason ?? "").startsWith("CONFIRMED_INACTIVE_")])) };
  }
  let roster, available;
  try {
    roster = snapshot.roster.map((item) => convert(item, false));
    available = [];
    for (const item of snapshot.available) {
      try { available.push(convert(item, true)); }
      catch (error) {
        if (error.message !== "UNJOINED_EXACT_YAHOO_IDENTITY") throw error;
        excludedCandidates.push({ yahooId: item.yahooId, reason: error.message });
      }
    }
  }
  catch (error) { return fail(error.message); }
  const occupied = roster.filter((r) => !["BN", "IR"].includes(r.slot));
  if (occupied.length !== slots.length || new Set(occupied.map((r) => r.slot)).size !== slots.length ||
      occupied.some((r) => !slots.find((s) => s.id === r.slot)?.eligible.some((p) => r.eligible.includes(p))) ||
      roster.some((r) => r.locked && r.slot === "IR")) return fail("UNKNOWN_OR_INCOMPLETE_CURRENT_LINEUP");
  if (occupied.some((r) => idpGroup(r.position) && r.idpModels[currentWeek]?.roleContinuity === "UNVERIFIED_NO_TEAM_SNAP_ROWS"))
    return fail("STARTER_IDP_ROLE_CONTINUITY_REQUIRES_REVIEW");
  if (occupied.some((r) => !finite(r.points[currentWeek]))) return fail("CURRENT_STARTER_FORECAST_UNKNOWN");
  const coverageReviews = [];
  if (snapshot.coverageRecords != null && !Array.isArray(snapshot.coverageRecords)) return fail("INVALID_TEMPORARY_COVERAGE_RECORD");
  for (const record of snapshot.coverageRecords ?? []) {
    if (!roster.some((r) => r.yahooId === record.temporaryYahooId) || !Array.isArray(record.coveredYahooIds) || !record.coveredYahooIds.length ||
        record.coveredYahooIds.some((id) => !roster.some((r) => r.yahooId === id)) || !Number.isFinite(time(record.reviewAt)) ||
        !Number.isFinite(time(record.expiresAt)) || time(record.reviewAt) > time(record.expiresAt)) return fail("INVALID_TEMPORARY_COVERAGE_RECORD");
    coverageReviews.push({ ...record, disposition: now >= Math.min(time(record.reviewAt), time(record.expiresAt)) ? "REVIEW_COVERAGE" : "COVERAGE_RETAINED_UNTIL_REVIEW",
      approvalRequired: true, executableNow: false, action: "REVIEW_ONLY_NO_AUTOMATIC_DROP" });
  }
  const targetWeeks = weeks.map((r) => r.targetWeek);
  const lineups = (rows) => targetWeeks.map((week) => ({ week, ...strongestLegalLineup(rows, slots, week, currentWeek) }));
  const baseline = lineups(roster);
  if (baseline.some((lineup) => !Array.isArray(lineup.selected))) return fail("NO_COMPLETE_KNOWN_HORIZON_LINEUP");
  for (const row of roster.filter((r) => r.slot === "BN" && targetWeeks.some((w) => !finite(r.points[w]))))
    unknownReserves.push({ yahooId: row.yahooId, reason: "RESERVE_FORECAST_UNKNOWN_EXCLUDED_FROM_MODELED_MATCHING" });
  const benchAudit = roster.filter((r) => ["BN", "IR"].includes(r.slot)).map((row) => {
    const without = lineups(roster.filter((r) => r.yahooId !== row.yahooId));
    return { yahooId: row.yahooId, position: row.position, name: row.name,
      weeklyStarterContribution: baseline.map((lineup, i) => ({ week: lineup.week,
        points: finite(row.points[lineup.week]) && without[i].selected ? lineup.points - without[i].points : null })),
      starterWeeks: baseline.filter((lineup) => lineup.selected.some((pick) => pick.yahooId === row.yahooId)).map((lineup) => lineup.week),
      unmodeledValue: "INJURY_INSURANCE_AND_UPSIDE_NOT_MODELED_ZERO_MARGINAL_IS_NOT_WORTHLESS", automaticDrop: false };
  });
  const alternatives = [];
  for (const add of available) {
    if (add.locked || inactive.has(add.injuryStatus) || targetWeeks.some((w) => !finite(add.points[w])) ||
        idpGroup(add.position) && targetWeeks.some((w) => add.idpModels[w]?.status !== "SNAP_ROLE_MODEL" || add.idpModels[w]?.roleContinuity === "UNVERIFIED_NO_TEAM_SNAP_ROWS")) {
      excludedCandidates.push({ yahooId: add.yahooId, reason: add.locked ? "LOCKED" : inactive.has(add.injuryStatus) ? "CONFIRMED_INACTIVE" :
        idpGroup(add.position) ? "ADD_IDP_ROLE_CONTINUITY_OR_FORECAST_REQUIRES_REVIEW" : "HORIZON_FORECAST_UNKNOWN" });
      continue;
    }
    for (const drop of roster.filter((r) => r.droppable && !r.locked && r.slot !== "IR" && targetWeeks.every((w) => finite(r.points[w])))) {
      const after = lineups([...roster.filter((r) => r.yahooId !== drop.yahooId), add]);
      if (after.some((lineup) => !lineup.selected)) continue;
      if (idpGroup(add.position) && after.some((lineup, i) => {
        if (!lineup.selected.some((pick) => pick.yahooId === add.yahooId)) return false;
        const displacedPick = baseline[i].selected.find((pick) => !lineup.selected.some((next) => next.yahooId === pick.yahooId));
        const displaced = roster.find((row) => row.yahooId === displacedPick?.yahooId);
        const oldRole = displaced?.idpModels[lineup.week], newRole = add.idpModels[lineup.week];
        return !displaced || !displaced.unavailable[lineup.week] && (!oldRole || oldRole.roleContinuity === "UNVERIFIED_NO_TEAM_SNAP_ROWS" ||
          !finite(oldRole.expectedSnaps) || !finite(oldRole.tacklePoints) || !finite(newRole.expectedSnaps) || !finite(newRole.tacklePoints) ||
          newRole.expectedSnaps <= oldRole.expectedSnaps || newRole.tacklePoints <= oldRole.tacklePoints);
      })) continue;
      const weeklyGains = after.map((lineup, i) => ({ week: lineup.week, starterPointGain: lineup.points - baseline[i].points }));
      alternatives.push({ addYahooId: add.yahooId, addName: add.name, addPosition: add.position,
        dropYahooId: drop.yahooId, dropName: drop.name, dropPosition: drop.position, weeklyGains,
        summedStarterPointGain: weeklyGains.reduce((sum, row) => sum + row.starterPointGain, 0),
        after: after.map((lineup, i) => ({ week: lineup.week, points: lineup.points,
          changes: lineup.selected.filter((pick) => baseline[i].selected.find((prior) => prior.slot === pick.slot)?.yahooId !== pick.yahooId) })),
        tradeoff: weeklyGains.some((r) => r.starterPointGain < 0) ? "HORIZON_GAIN_WITH_WEEKLY_STARTER_LOSS_REQUIRES_REVIEW" : "NO_MODELED_WEEKLY_STARTER_LOSS",
        dropCostLimit: "INJURY_INSURANCE_AND_UPSIDE_UNMODELED_NO_AUTOMATIC_DROP",
        defensePairYahooIds: [ ...roster.filter((r) => r.position === "DEF" && r.yahooId !== drop.yahooId), ...(add.position === "DEF" ? [add] : []) ].map((r) => r.yahooId),
        availability: add.availability, injuryStatus: add.injuryStatus, approvalRequired: true, executableNow: false,
        executionCondition: add.availability === "W" ? "FRESH_VERIFIED_FA_AFTER_RELEASE_AND_EXACT_APPROVAL" : "FRESH_VERIFIED_FA_AND_EXACT_APPROVAL",
        expiresAt: add.availability === "W" ? add.conditionalExpiresAt : snapshot.expiresAt,
        futureAvailability: "NOT_ASSUMED_PLAN_VALUES_CONDITION_ON_ACQUIRING_EXACT_ADD", legalConstraints: { exactEligibility: true, droppable: drop.droppable, dropLocked: drop.locked,
          currentLocksPinnedToExactSlot: true, futureLocksNotAssumed: true, snapshotExpiresAt: snapshot.expiresAt } });
    }
  }
  alternatives.sort((a, b) => b.summedStarterPointGain - a.summedStarterPointGain);
  const proposals = alternatives.flatMap((row, index) => row.summedStarterPointGain > 0 ? [index] : []);
  return { disposition: proposals.length ? "PROPOSE_FOR_EXACT_APPROVAL" : "HOLD", reason: proposals.length ? null : "NO_POSITIVE_MODELED_STARTER_GAIN",
    approvalRequired: true, executableNow: false, baseline, hold: { summedStarterPointGain: 0, approvalRequired: true, executableNow: false },
    proposals, alternatives, defenseAlternatives: alternatives.flatMap((row, index) => row.addPosition === "DEF" ? [index] : []),
    outputContract: "PROPOSAL_AND_DEFENSE_INDICES_INTO_ALTERNATIVES_AFTER_SLOT_CHANGES_FROM_BASELINE",
    benchAudit, coverageReviews, excludedCandidates, unknownReserves,
    forecastAssumptions: report.forecastAssumptions, snapshotCapturedAt: snapshot.capturedAt, snapshotExpiresAt: snapshot.expiresAt,
    limitation: "strongest legal lineup among known forecasts; unknown reserves disclosed, injury insurance/upside/recovery and future acquisition availability unmodeled; all comparisons are advisory" };
}
