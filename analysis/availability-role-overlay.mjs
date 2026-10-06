import { assignFullRanks } from "./weekly-roster-utility.mjs";
import { offensePointsForVolume } from "./offense-role-projection.mjs";

const channels = ["passAttempts", "carries", "targets"];
const finite = (value) => value != null && value !== "" && Number.isFinite(Number(value));
const clock = (value) => typeof value === "string" ? Date.parse(value) : NaN;
const absent = new Set(["OUT", "IR", "PUP", "NFI", "SUSPENDED", "INACTIVE"]);
const statuses = new Set([...absent, "ACTIVE", "QUESTIONABLE", "DOUBTFUL", "RESTRICTED", "UNKNOWN"]);

function validEvidence(evidence, baseTime, now) {
  let url;
  try { url = new URL(evidence?.sourceUrl); } catch { return false; }
  return evidence?.source === "NFL_OFFICIAL_VERIFIED_READBACK" && evidence.verified === true &&
    url.protocol === "https:" && !url.username && !url.password &&
    Number.isFinite(clock(evidence.capturedAt)) && clock(evidence.capturedAt) >= baseTime && clock(evidence.capturedAt) <= now &&
    Number.isFinite(clock(evidence.expiresAt)) && clock(evidence.expiresAt) > now && clock(evidence.expiresAt) > clock(evidence.capturedAt);
}

/** Apply one target-week official readback to an immutable saved multiweek base. No fetches. */
export function applyAvailabilityRoleOverlay(base, input, now = Date.now(), scenario = null) {
  if (scenario != null && !["current-role", "unavailable"].includes(scenario)) throw new Error("INVALID_AVAILABILITY_SCENARIO");
  if (!Number.isInteger(base?.season) || !Number.isInteger(base?.targetWeek) || !Array.isArray(base.weeks) ||
      !Number.isFinite(clock(base.generatedAt)) || clock(base.generatedAt) > now || base.availabilityOverlay ||
      input?.season !== base.season || input?.week !== base.targetWeek || !Array.isArray(input.facts) ||
      !validEvidence(input, clock(base.generatedAt), now)) throw new Error("INVALID_OR_STALE_OFFICIAL_OVERLAY");
  const current = base.weeks.find((week) => week.targetWeek === base.targetWeek);
  if (!current || !Array.isArray(current.players)) throw new Error("INVALID_OFFICIAL_OVERLAY_BASE");
  const rows = new Map(current.players.map((row) => [String(row.playerId), row]));
  if (rows.size !== current.players.length) throw new Error("DUPLICATE_OFFICIAL_OVERLAY_BASE_IDENTITY");
  const facts = new Map();
  for (const fact of input.facts) {
    const id = String(fact?.playerId);
    if (!/^\d+$/.test(id) || facts.has(id) || !rows.has(id) || !statuses.has(fact.status) ||
        !validEvidence(fact, clock(base.generatedAt), now) || clock(fact.capturedAt) > clock(input.capturedAt) ||
        clock(fact.expiresAt) > clock(input.expiresAt)) throw new Error("INVALID_OFFICIAL_PLAYER_FACT");
    if (fact.workload != null) {
      const w = fact.workload;
      if (!validEvidence(w, clock(base.generatedAt), now) || clock(w.capturedAt) > clock(input.capturedAt) ||
          clock(w.expiresAt) > clock(input.expiresAt) || w.kind !== "OFFICIAL_QUANTIFIED_WORKLOAD" ||
          typeof w.support !== "string" || !w.support.trim() ||
          channels.some((channel) => !finite(w.expectedVolume?.[channel]) || Number(w.expectedVolume[channel]) < 0) ||
          rows.get(id).scoringKind !== "offense" || !["ACTIVE", "RESTRICTED"].includes(fact.status))
        throw new Error("UNSUPPORTED_NUMERIC_WORKLOAD_OVERLAY");
    }
    facts.set(id, fact);
  }
  const changed = current.players.map((row) => {
    const fact = facts.get(String(row.playerId));
    if (!fact) return row;
    const unavailable = absent.has(fact.status);
    const uncertain = ["QUESTIONABLE", "DOUBTFUL", "RESTRICTED", "UNKNOWN"].includes(fact.status);
    const fullStarter = row.offenseModel?.conditionalFullStart;
    const useFullStarter = Boolean(fullStarter && !unavailable &&
      (uncertain && scenario === "current-role" || fact.status === "ACTIVE" && fact.fullStarterRoleVerified === true));
    const components = useFullStarter ? fullStarter.weeklyExpectation :
      row.offenseModel ? row.offenseModel.weeklyExpectation : row.idpModel ? row.idpModel.weeklyExpectation :
        row.specialTeamsModel ? row.specialTeamsModel.weeklyExpectation : row.weeklyBaseline;
    const conditional = finite(components) ? Number(components) * Number(row.matchupFactor ?? 1) : null;
    let points = unavailable || row.bye ? 0 : uncertain ? null : conditional;
    let reason = unavailable ? `CONFIRMED_INACTIVE_${fact.status}` : uncertain ? `OFFICIAL_${fact.status}_SCENARIO_REQUIRES_REVIEW` :
      points == null ? "CURRENT_ROLE_COMPONENTS_UNKNOWN" : null;
    if (uncertain && scenario) {
      points = scenario === "unavailable" ? 0 : conditional;
      reason = points == null ? "SCENARIO_CURRENT_ROLE_UNKNOWN" : null;
    }
    if (fact.replacementRole === true && !unavailable && !fact.workload && scenario !== "unavailable") {
      points = null; reason = "REPLACEMENT_WORKLOAD_UNKNOWN_NO_SUPPORTED_ALLOCATION";
    }
    if (fact.workload && !(uncertain && scenario === "unavailable")) {
      points = offensePointsForVolume(row.offenseModel, fact.workload.expectedVolume);
      points = points == null ? null : points * Number(row.matchupFactor ?? 1);
      reason = points == null ? "OFFENSE_ROLE_COMPONENTS_UNAVAILABLE" : null;
    }
    if (row.bye) { points = 0; reason = "TARGET_WEEK_BYE"; }
    if (row.scheduleStatus === "UNKNOWN") { points = null; reason = "TARGET_WEEK_SCHEDULE_UNKNOWN"; }
    return { ...row, weeklyExpectation: points, rankable: points != null && !unavailable && !row.bye,
      weeklyProjectionAvailable: points != null && !unavailable && !row.bye,
      unrankableReason: reason, availabilityStatus: fact.status,
      availabilityProbability: unavailable ? 0 : uncertain && (scenario || !fact.workload) ? null : 1,
      availabilityBasis: "OFFICIAL_TARGET_WEEK_OVERLAY", officialAvailability: { ...fact },
      restoredFullStarter: useFullStarter,
      availabilityScenarios: uncertain ? { conditionalCurrentRolePoints: conditional, unavailablePoints: 0,
        expectedPoints: null, probability: null, limitation: "no generic Q/D/restriction haircut or assumed recovery" } : null,
      offenseModel: row.offenseModel && (fact.workload || unavailable || uncertain && scenario === "unavailable") ? { ...row.offenseModel,
        expectedVolume: unavailable || uncertain && scenario === "unavailable" ? Object.fromEntries(channels.map((channel) => [channel, 0])) : { ...fact.workload.expectedVolume },
        weeklyExpectation: unavailable || uncertain && scenario === "unavailable" ? 0 : offensePointsForVolume(row.offenseModel, fact.workload.expectedVolume) } : useFullStarter ? { ...fullStarter, status: "CURRENT_OFFENSIVE_ROLE" } : row.offenseModel,
      rankBasis: scenario && uncertain ? "CONDITIONAL_AVAILABILITY_SCENARIO" : fact.workload ? "OFFICIAL_SUPPORTED_WORKLOAD_OVERLAY" : "OFFICIAL_AVAILABILITY_OVERLAY",
      notes: [...row.notes ?? [], `official ${fact.status}; retrieved ${fact.capturedAt}; expires ${fact.expiresAt}; ${fact.workload ? fact.workload.support : "no teammate workload redistributed"}`] };
  });
  const changedById = new Map(changed.map(row => [String(row.playerId), row]));
  const transfers = [], seenTransfers = new Set(), heldRecipients = new Set();
  if (input.redistributions != null && !Array.isArray(input.redistributions)) throw new Error("INVALID_WORKLOAD_TRANSFER_REQUEST");
  for (const request of input.redistributions ?? []) {
    const donorId = String(request.donorPlayerId), donor = rows.get(donorId), donorFact = facts.get(donorId);
    const channel = request.channel, key = `${donorId}:${channel}`;
    const uncertainDonor = ["QUESTIONABLE", "DOUBTFUL", "RESTRICTED", "UNKNOWN"].includes(donorFact?.status);
    if (!donor || !donorFact || !(absent.has(donorFact.status) || uncertainDonor) || !channels.includes(channel) || seenTransfers.has(key) ||
        !Array.isArray(request.recipientPlayerIds) || !request.recipientPlayerIds.length ||
        new Set(request.recipientPlayerIds.map(String)).size !== request.recipientPlayerIds.length)
      throw new Error("UNSUPPORTED_WORKLOAD_TRANSFER_REQUEST");
    seenTransfers.add(key);
    if (uncertainDonor && scenario !== "unavailable") {
      transfers.push({ donorPlayerId: donorId, channel, status: "CONDITIONAL_UNAVAILABLE_SCENARIO_ONLY_NO_EXPECTED_TRANSFER",
        vacatedOpportunity: null, allocations: [], unassignedOpportunity: null });
      continue;
    }
    const recipients = request.recipientPlayerIds.map(String).map(id => rows.get(id));
    if (recipients.some(row => !row || row.playerId === donorId || row.team !== donor.team || row.scoringKind !== "offense" ||
        facts.get(String(row.playerId))?.status !== "ACTIVE" || facts.get(String(row.playerId))?.workload))
      throw new Error("BENEFICIARY_ROLE_OR_OFFICIAL_AVAILABILITY_UNVERIFIED");
    const vacated = donor.offenseModel?.expectedVolume?.[channel], budget = donor.offenseModel?.teamBudget?.[channel];
    const denominator = finite(budget) && finite(vacated) ? Number(budget) - Number(vacated) : null;
    let transferred = 0;
    const allocations = [];
    for (const recipient of recipients) {
      const id = String(recipient.playerId), row = changedById.get(id), measured = recipient.offenseModel;
      const volume = measured?.expectedVolume?.[channel];
      const supported = finite(vacated) && Number(vacated) > 0 && denominator > 0 && finite(volume) && Number(volume) > 0 &&
        measured.status === "CURRENT_OFFENSIVE_ROLE" && measured.roleContinuity === "LATEST_WEEK_MEASURED" &&
        (channel !== "passAttempts" || recipient.position === "QB" && measured.starterWorkloadObserved === true);
      if (!supported) {
        heldRecipients.add(id);
        row.weeklyExpectation = null; row.rankable = false; row.weeklyProjectionAvailable = false;
        row.unrankableReason = "BENEFICIARY_WORKLOAD_UNKNOWN_NO_MEASURED_ROLE";
        allocations.push({ playerId: id, status: "HOLD", transferredOpportunity: null });
        continue;
      }
      const gain = Number(vacated) * Number(volume) / denominator;
      transferred += gain;
      row.offenseModel = { ...row.offenseModel, expectedVolume: { ...row.offenseModel.expectedVolume,
        [channel]: row.offenseModel.expectedVolume[channel] + gain } };
      row.offenseModel.weeklyExpectation = offensePointsForVolume(row.offenseModel, row.offenseModel.expectedVolume);
      row.weeklyBaseline = row.offenseModel.weeklyExpectation;
      row.weeklyExpectation = row.weeklyBaseline == null ? null : row.weeklyBaseline * Number(row.matchupFactor ?? 1);
      row.rankable = !heldRecipients.has(id) && row.weeklyExpectation != null && !row.bye && row.scheduleStatus === "VERIFIED_GAME";
      row.weeklyProjectionAvailable = row.rankable;
      if (!row.rankable) row.weeklyExpectation = null;
      row.unrankableReason = heldRecipients.has(id) ? "BENEFICIARY_WORKLOAD_UNKNOWN_NO_MEASURED_ROLE" : row.rankable ? null : "BENEFICIARY_SCHEDULE_OR_ROLE_UNKNOWN";
      row.rankBasis = "MEASURED_SHARE_INJURY_TRANSFER_ESTIMATE";
      row.notes = [...row.notes, `uncalibrated ${channel} transfer estimate ${gain.toFixed(3)} from absent/scenario-absent ${donorId}; measured share of budget excluding this donor only; other donor shares and unknown opportunities remain unallocated; no depth-rank/equal split boost`];
      allocations.push({ playerId: id, status: "MODEL_ESTIMATE_UNCALIBRATED", measuredOpportunity: volume, transferredOpportunity: gain });
    }
    if (finite(vacated) && transferred > Number(vacated) + 1e-8) throw new Error("TRANSFER_EXCEEDS_VACATED_OPPORTUNITY");
    transfers.push({ donorPlayerId: donorId, channel, vacatedOpportunity: vacated ?? null, allocations,
      unassignedOpportunity: finite(vacated) ? Number(vacated) - transferred : null,
      basis: "official or conditional-scenario donor absence plus recipients' measured opportunity divided by team budget minus this donor only; deliberately conservative with multiple donors; unknown and unassigned opportunity retained" });
  }
  // Validate known allocations against the fixed team budget. Unknown players stay in the
  // unknown bucket and receive no modeled transfer; they are never asserted to have zero role.
  for (const fact of facts.values()) if (fact.workload || changedById.get(String(fact.playerId))?.restoredFullStarter) {
    const player = rows.get(String(fact.playerId));
    const budget = player.offenseModel?.teamBudget;
    if (!budget) throw new Error("TEAM_OPPORTUNITY_BUDGET_UNKNOWN");
    const teamRows = changed.filter((row) => row.team === player.team && row.scoringKind === "offense");
    for (const channel of channels) {
      const total = teamRows.reduce((sum, row) => sum + (absent.has(row.availabilityStatus) || !finite(row.offenseModel?.expectedVolume?.[channel]) ? 0 : Number(row.offenseModel.expectedVolume[channel])), 0);
      if (!finite(budget[channel]) || total > Number(budget[channel]) + 1e-8) throw new Error("TEAM_WORKLOAD_NOT_CONSERVED");
    }
  }
  for (const transfer of transfers) {
    const donor = rows.get(transfer.donorPlayerId);
    for (const channel of channels) {
      const team = changed.filter(row => row.team === donor.team && row.scoringKind === "offense");
      const knownTotal = team.reduce((sum, row) => sum + (finite(row.offenseModel?.expectedVolume?.[channel]) ? Number(row.offenseModel.expectedVolume[channel]) : 0), 0);
      const budget = donor.offenseModel?.teamBudget?.[channel];
      if (finite(budget) && knownTotal > Number(budget) + 1e-8) throw new Error("TEAM_WORKLOAD_NOT_CONSERVED");
    }
  }
  const overlay = { source: input.source, capturedAt: input.capturedAt,
    expiresAt: input.expiresAt, baseGeneratedAt: base.generatedAt, targetWeek: base.targetWeek,
    affectedPlayerIds: [...facts.keys()], facts: input.facts, transfers,
    futureWeeks: "UNCHANGED_BASE_ASSUMPTIONS_NO_RECOVERY_INFERRED", originalPreserved: true };
  const weeks = base.weeks.map((week) => week === current ? { ...week, players: assignFullRanks(changed),
    availabilityOverlay: overlay } : week);
  return { ...base, weeks, availabilityOverlay: overlay, availabilityScenario: scenario ? {
    mode: scenario, playerIds: input.facts.filter(fact => ["QUESTIONABLE", "DOUBTFUL", "RESTRICTED", "UNKNOWN"].includes(fact.status)).map(fact => String(fact.playerId)),
    probability: null, expectedForecast: false, officialStatusesPreserved: true,
    reviewCondition: "compare current-role and unavailable scenarios together; review only, no transaction approval" } : null };
}
