import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { rehearseExactRoster } from "./draft-readiness.mjs";
import "../controller/yahoo-mock-runner.js";

const TEST_CONFIG = globalThis.SKRODZKaiYahooMockRunner.configs.test_league_19_idp;
const PUBLIC_CONFIG = globalThis.SKRODZKaiYahooMockRunner.configs.public_mock_15;
const ROSTER_VALIDATOR = globalThis.SKRODZKaiYahooMockRunner._test.validateCompletedRoster;
const TEST_OVERALL_PICK = globalThis.SKRODZKaiYahooMockRunner._test.overallPick;
const TEST_SAME_SLOTS = globalThis.SKRODZKaiYahooMockRunner._test.sameSlots;
const TEST_OBSERVED_ROSTER_VALIDATOR = globalThis.SKRODZKaiYahooMockRunner._test.validateObservedTestRoster;
const EXTENSION_VERSION = "0.16.3";
const PANEL_BUDGET_MS = globalThis.SKRODZKaiYahooMockRunner.decision.panelBudgetMs;
const TURN_TO_CLICK_BUDGET_MS = 2000;

const CONTRACTS = Object.freeze({
  league_two_test_19_idp: Object.freeze({
    name: "league_two_test_19_idp",
    config: TEST_CONFIG,
    expectedRoomId: String(TEST_CONFIG.leagueId),
    expectedUrlSeat: Number(TEST_CONFIG.urlTeamId),
    requireFinalRosterReadback: true,
    passStatus: "PASS",
    scope: "LEAGUE_TWO_TEST_ACCEPTANCE",
  }),
  public_mock_15: Object.freeze({
    name: "public_mock_15",
    config: PUBLIC_CONFIG,
    requireFinalRosterReadback: false,
    passStatus: "PUBLIC_MOCK_PASS",
    scope: "PUBLIC_MOCK_EXECUTION_ONLY",
  }),
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validRuntimeAttestation(value) {
  return value?.ok === true &&
    value.version === EXTENSION_VERSION &&
    /^[a-f0-9]{64}$/.test(String(value.digest ?? "")) &&
    String(value.bootId ?? "").length >= 8 &&
    Number.isFinite(Number(value.bootedAt));
}

function sameRuntimeAttestation(left, right) {
  return validRuntimeAttestation(left) && validRuntimeAttestation(right) &&
    left.version === right.version && left.digest === right.digest &&
    left.bootId === right.bootId && Number(left.bootedAt) === Number(right.bootedAt);
}

function validClock(value, maximumSeconds = 300, minimumSeconds = 1) {
  const match = String(value?.label ?? "").match(/^(\d{1,2}):(\d{2})$/);
  const seconds = Number(value?.seconds);
  return Boolean(match) && Number(match[2]) < 60 && Number.isInteger(seconds) &&
    seconds === Number(match[1]) * 60 + Number(match[2]) && seconds >= minimumSeconds && seconds <= maximumSeconds;
}

function countsByPosition(picks) {
  const counts = {};
  for (const pick of picks) counts[pick.position] = (counts[pick.position] ?? 0) + 1;
  return counts;
}

function sameCounts(left, right) {
  if (!left || typeof left !== "object" || !right || typeof right !== "object") return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => Number(left[key] ?? 0) === Number(right[key] ?? 0));
}

function auditPublicMockPicks(picks, latencyBudgetMs) {
  const errors = [];
  const seen = new Set();
  for (let index = 0; index < picks.length; index += 1) {
    const round = index + 1;
    const pick = picks[index];
    if (!pick.yahooId || seen.has(pick.yahooId)) errors.push(`round_${round}_duplicate_or_missing_player`);
    else seen.add(pick.yahooId);
    if (!Number.isFinite(pick.latencyMs) || pick.latencyMs < 0 || pick.latencyMs > latencyBudgetMs) {
      errors.push(`round_${round}_latency_budget_missed`);
    }
  }
  return { valid: errors.length === 0, errors };
}

function acceptanceContract(payload, requested = "league_two_test_19_idp") {
  const base = CONTRACTS[requested];
  if (!base) throw new Error(`unknown acceptance contract: ${requested}`);
  if (base.name !== "public_mock_15") return base;
  return {
    ...base,
    expectedRoomId: String(payload?.roomId ?? ""),
    expectedUrlSeat: Number(payload?.seat),
  };
}

function normalizedReceiptCounts(counts) {
  const normalized = {};
  for (const [position, count] of Object.entries(counts ?? {})) {
    const key = ["CB", "S", "FS", "SS"].includes(position)
      ? "DB"
      : ["DE", "DT", "NT", "DL"].includes(position)
        ? "D"
        : ["ILB", "OLB"].includes(position)
          ? "LB"
          : position;
    normalized[key] = (normalized[key] ?? 0) + Number(count);
  }
  return normalized;
}

function completedRunnerRun(receipts, errors) {
  const groups = new Map();
  for (const receipt of receipts) {
    if (!receipt?.runId) continue;
    const group = groups.get(receipt.runId) ?? [];
    group.push(receipt);
    groups.set(receipt.runId, group);
  }
  const completed = [...groups.entries()].filter(([, entries]) =>
    entries.some((entry) => entry.kind === "runner_completed"),
  );
  if (completed.length !== 1) {
    errors.push(completed.length ? "ambiguous_completed_runner_run" : "completed_runner_run_missing");
    return { runId: null, receipts: [] };
  }
  return { runId: completed[0][0], receipts: completed[0][1] };
}

function replayDecision(decision) {
  const manual = decision?.manualOverride?.status === "applied";
  const fallbackUsed = decision?.fallbackUsed === true;
  const eligible = asArray(decision?.positionLeaders)
    .filter((leader) => leader?.eligible === true && leader?.player?.yahooId)
  const ranked = eligible.slice().sort((left, right) =>
      Number(right.adjustedScore) - Number(left.adjustedScore) ||
      Number(left.player.rank) - Number(right.player.rank),
    );
  const staticFallback = eligible.slice().sort((left, right) => Number(left.player.rank) - Number(right.player.rank));
  const expectedYahooId = manual
    ? String(decision?.manualOverride?.chosenYahooId ?? "") || null
    : fallbackUsed
      ? staticFallback[0]?.player?.yahooId == null ? null : String(staticFallback[0].player.yahooId)
      : ranked[0]?.player?.yahooId == null ? null : String(ranked[0].player.yahooId);
  const chosenYahooId = decision?.chosenYahooId == null ? null : String(decision.chosenYahooId);
  const targetYahooId = decision?.targetYahooIds?.[0] == null ? null : String(decision.targetYahooIds[0]);
  return {
    consistent: expectedYahooId !== null && expectedYahooId === chosenYahooId && (!fallbackUsed || targetYahooId === expectedYahooId),
    expectedYahooId,
    chosenYahooId,
    manualOverride: manual,
    fallbackUsed,
    replayMode: manual ? "MANUAL_OVERRIDE" : fallbackUsed ? "STATIC_BOARD_FALLBACK" : "DECISION_SCORE",
    counterfactual: "not_available",
  };
}

function controllerPairs(receipts, startedAt, completedAt) {
  const relevant = receipts.filter((entry) => {
    const at = timestamp(entry?.at);
    return at !== null && at >= startedAt && at <= completedAt;
  });
  const groups = new Map();
  for (const entry of relevant) {
    if (!entry?.sessionId) continue;
    const group = groups.get(entry.sessionId) ?? [];
    group.push(entry);
    groups.set(entry.sessionId, group);
  }
  return [...groups.entries()]
    .map(([sessionId, entries]) => ({
      sessionId,
      clicks: entries.filter((entry) => entry.kind === "draft_click"),
      confirmations: entries.filter((entry) => entry.kind === "pick_confirmed"),
      failures: entries.filter((entry) => entry.kind === "controller_failed"),
    }))
    .filter((group) => group.clicks.length || group.confirmations.length || group.failures.length)
    .sort((left, right) =>
      timestamp(left.clicks[0]?.at ?? left.confirmations[0]?.at ?? left.failures[0]?.at) -
      timestamp(right.clicks[0]?.at ?? right.confirmations[0]?.at ?? right.failures[0]?.at),
    );
}

function evaluateDraftExport(payload, options = {}) {
  const contract = acceptanceContract(payload, options.contract);
  const config = contract.config;
  const expectedRoomId = contract.expectedRoomId;
  const expectedUrlSeat = contract.expectedUrlSeat;
  const publicMock = contract.name === "public_mock_15";
  const latencyBudgetMs = Number(options.latencyBudgetMs ?? 15_000);
  const errors = [];
  const runnerReceipts = asArray(payload?.runnerReceipts);
  const controllerReceipts = asArray(payload?.controllerReceipts);
  const extensionReceipts = asArray(payload?.extensionReceipts);

  if (publicMock) {
    if (!/^\d+$/.test(expectedRoomId) || [String(TEST_CONFIG.leagueId), "420010"].includes(expectedRoomId)) {
      errors.push("public_mock_room_identity_invalid");
    }
    if (Number(payload?.urlSeat) !== Number(payload?.seat)) errors.push("public_mock_url_seat_mismatch");
  } else {
    if (String(payload?.roomId ?? "") !== expectedRoomId) errors.push("test_room_identity_mismatch");
    if (Number(payload?.urlSeat) !== expectedUrlSeat) errors.push("test_url_team_identity_mismatch");
  }
  const maximumTeams = publicMock ? config.teams : config.maximumTeams;
  if (!Number.isInteger(Number(payload?.seat)) || Number(payload.seat) < 1 || Number(payload.seat) > maximumTeams) {
    errors.push(publicMock ? "public_mock_draft_slot_invalid" : "test_draft_slot_invalid");
  }
  if (payload?.status?.state !== "completed") errors.push("exported_runner_status_not_completed");
  if (asArray(payload?.status?.picks).length !== config.rounds) errors.push("exported_status_pick_count_mismatch");
  if (payload?.extensionVersion !== EXTENSION_VERSION) errors.push("extension_version_mismatch");
  const runtimeAttestation = payload?.runtimeAttestation;
  if (!validRuntimeAttestation(runtimeAttestation)) errors.push("runtime_attestation_missing_or_invalid");
  const operatorAttestation = payload?.operatorAttestation;
  if (operatorAttestation?.status === "intervention") {
    if (
      operatorAttestation.source !== "operator_attested" ||
      !timestamp(operatorAttestation.attestedAt) ||
      !asArray(operatorAttestation.interventions).some((entry) => entry?.kind === "prevented_autodraft")
    ) errors.push("owner_intervention_evidence_malformed");
    errors.push("owner_intervention_prevented_autodraft");
  } else if (
    operatorAttestation?.status !== "none" ||
    operatorAttestation.source !== "operator_attested" ||
    !timestamp(operatorAttestation.attestedAt) ||
    asArray(operatorAttestation.interventions).length !== 0
  ) {
    errors.push("owner_intervention_evidence_missing");
  }

  const selectedRun = completedRunnerRun(runnerReceipts, errors);
  const runReceipts = selectedRun.receipts.sort((left, right) => timestamp(left.at) - timestamp(right.at));
  const started = runReceipts.filter((entry) => entry.kind === "runner_started");
  const completed = runReceipts.filter((entry) => entry.kind === "runner_completed");
  const failures = runReceipts.filter((entry) => ["runner_failed", "runner_halted", "runner_stopped"].includes(entry.kind));
  if (started.length !== 1) errors.push("runner_started_receipt_contract_failed");
  if (completed.length !== 1 || Number(completed[0]?.picks) !== config.rounds) errors.push("runner_completed_receipt_contract_failed");
  if (runReceipts.some((entry) =>
    String(entry.roomId) !== expectedRoomId ||
    Number(entry.seat) !== Number(payload?.seat) ||
    Number(entry.urlSeat) !== expectedUrlSeat
  )) errors.push("runner_receipt_identity_mismatch");
  const observedTeamCount = Number(started[0]?.observedTeamCount);
  const validObservedTeamCount = publicMock
    ? observedTeamCount === config.teams
    : Number.isInteger(observedTeamCount) && observedTeamCount >= config.minimumTeams && observedTeamCount <= config.maximumTeams;
  const seatFitsObservedField = validObservedTeamCount && Number.isInteger(Number(payload?.seat)) && Number(payload.seat) >= 1 && Number(payload.seat) <= observedTeamCount;
  if (!seatFitsObservedField) errors.push(publicMock ? "public_mock_seat_exceeds_observed_team_count" : "test_draft_slot_exceeds_observed_team_count");
  if (
    started[0]?.configName !== config.name ||
    String(started[0]?.expectedRoomId) !== expectedRoomId ||
    Number(started[0]?.expectedSeat) !== Number(payload?.seat) ||
    Number(started[0]?.expectedUrlSeat) !== expectedUrlSeat ||
    !validObservedTeamCount ||
    !TEST_SAME_SLOTS(started[0]?.observedRosterSlots, config.rosterSlots)
  ) errors.push(publicMock ? "runner_started_public_mock_config_mismatch" : "runner_started_test_config_mismatch");
  if (!sameRuntimeAttestation(started[0]?.runtimeAttestation, runtimeAttestation)) errors.push("runner_runtime_attestation_mismatch");
  if (started[0]?.autodraftState !== "INACTIVE") errors.push("runner_started_autodraft_not_verified_off");
  if (started[0]?.queueState !== "EMPTY") errors.push("runner_started_queue_not_verified_empty");
  if (
    payload?.status?.runId !== selectedRun.runId ||
    String(payload?.status?.roomId) !== expectedRoomId ||
    Number(payload?.status?.seat) !== Number(payload?.seat) ||
    Number(payload?.status?.urlSeat) !== expectedUrlSeat
  ) errors.push("exported_runner_status_identity_mismatch");
  if (failures.length) errors.push("runner_failure_or_halt_observed");
  if (runReceipts.some((entry) => /autodraft/i.test(`${entry.kind} ${entry.code ?? ""}`))) errors.push("autodraft_event_observed");

  const pickReceipts = runReceipts
    .filter((entry) => entry.kind === "runner_pick_confirmed")
    .sort((left, right) => Number(left.round) - Number(right.round));
  const decisionsByTurn = new Map();
  for (const entry of runReceipts.filter((receipt) => receipt.kind === "runner_turn_resolved")) {
    const turn = String(entry.turn ?? "");
    if (decisionsByTurn.has(turn)) errors.push(`duplicate_runner_decision:${turn}`);
    decisionsByTurn.set(turn, entry);
    if (!Number.isFinite(Number(entry.panelReadyMs)) || Number(entry.panelReadyMs) < 0 || Number(entry.panelReadyMs) >= PANEL_BUDGET_MS) {
      errors.push(`turn_${turn || "unknown"}_panel_ready_budget_missed`);
    }
    if (Number(entry.panelBudgetMs) !== PANEL_BUDGET_MS) errors.push(`turn_${turn || "unknown"}_panel_budget_contract_failed`);
    if (!validClock(entry.clockAtDecision, publicMock ? 300 : 60, 5)) errors.push(`turn_${turn || "unknown"}_clock_evidence_missing_or_invalid`);
  }
  if (pickReceipts.length !== config.rounds) errors.push(`exactly_${config.rounds}_runner_pick_receipts_required`);
  if (decisionsByTurn.size !== config.rounds) errors.push(`exactly_${config.rounds}_runner_decisions_required`);

  const picks = pickReceipts.map((receipt) => ({
    round: Number(receipt.round),
    playerId: String(receipt.pick?.yahooId ?? ""),
    yahooId: String(receipt.pick?.yahooId ?? ""),
    name: String(receipt.pick?.name ?? ""),
    position: String(receipt.pick?.position ?? ""),
    team: String(receipt.pick?.team ?? ""),
    turn: String(receipt.pick?.turn ?? ""),
    latencyMs: Number(receipt.pick?.detectionToClickMs) + Number(receipt.pick?.clickToConfirmationMs),
    turnDetectionToClickMs: Number(receipt.pick?.turnDetectionToClickMs),
    turnToClickBudgetMs: Number(receipt.pick?.turnToClickBudgetMs),
    clockAtDecision: receipt.pick?.clockAtDecision ?? null,
    decision: decisionsByTurn.get(String(receipt.pick?.turn ?? ""))?.decision ?? null,
  }));
  picks.forEach((pick, index) => {
    const round = index + 1;
    if (pick.round !== round) errors.push(`round_${round}_runner_round_mismatch`);
    if (!Number.isFinite(pick.turnDetectionToClickMs) || pick.turnDetectionToClickMs < 0 || pick.turnDetectionToClickMs >= TURN_TO_CLICK_BUDGET_MS) {
      errors.push(`round_${round}_turn_to_click_budget_missed`);
    }
    if (pick.turnToClickBudgetMs !== TURN_TO_CLICK_BUDGET_MS) errors.push(`round_${round}_turn_to_click_budget_contract_failed`);
    if (!validClock(pick.clockAtDecision, publicMock ? 300 : 60, 5)) errors.push(`round_${round}_clock_evidence_missing_or_invalid`);
    if (seatFitsObservedField) {
      const expectedTurn = `R${round}P${TEST_OVERALL_PICK(round, Number(payload?.seat), observedTeamCount)}`;
      if (pick.turn !== expectedTurn) errors.push(`round_${round}_snake_turn_mismatch`);
    }
  });
  const statusPickIds = asArray(payload?.status?.picks).map((pick) => String(pick?.yahooId ?? ""));
  if (statusPickIds.some((yahooId, index) => yahooId !== picks[index]?.yahooId)) errors.push("exported_status_runner_pick_mismatch");
  const rosterShape = normalizedReceiptCounts(completed[0]?.counts);
  const rehearsal = publicMock
    ? auditPublicMockPicks(picks, latencyBudgetMs)
    : rehearseExactRoster({ picks, rosterShape, latencyBudgetMs });
  if (!rehearsal.valid) errors.push(...rehearsal.errors);
  if (!ROSTER_VALIDATOR(picks, config)) errors.push(publicMock ? "public_mock_roster_policy_failed" : "test_roster_policy_failed");
  if (!sameCounts(completed[0]?.counts, countsByPosition(picks))) errors.push("runner_completed_counts_mismatch");

  const allFinalRosterReceipts = extensionReceipts.filter((entry) => entry.kind === "final_roster_readback");
  const finalRosterReceipts = allFinalRosterReceipts.filter((entry) =>
    entry.kind === "final_roster_readback" && entry.runId === selectedRun.runId
  );
  if (contract.requireFinalRosterReadback) {
    if (finalRosterReceipts.length !== 1) {
      errors.push(finalRosterReceipts.length ? "ambiguous_final_roster_readback" : "final_roster_readback_missing");
    } else if (
      finalRosterReceipts[0].valid !== true ||
      !TEST_OBSERVED_ROSTER_VALIDATOR(finalRosterReceipts[0].finalRosterSlots, picks)
    ) {
      errors.push("final_roster_slot_occupancy_failed");
    }
  } else if (allFinalRosterReceipts.length) {
    errors.push("unexpected_public_mock_final_roster_readback");
  }

  const onClockChoices = runReceipts.filter((entry) => entry.kind === "runner_on_clock_choice_applied");
  if (onClockChoices.some((entry) => !picks.some((pick) => pick.turn === entry.turn))) errors.push("on_clock_choice_unknown_turn");
  const replays = picks.map((pick, index) => {
    const replay = replayDecision(pick.decision);
    if (replay.fallbackUsed) errors.push(`round_${index + 1}_decision_fallback_forbidden`);
    if (!replay.consistent) errors.push(`round_${index + 1}_decision_replay_mismatch`);
    const targets = asArray(pick.decision?.targetYahooIds).map(String);
    const targetIndex = targets.indexOf(pick.yahooId);
    const choices = onClockChoices.filter((entry) => entry.turn === pick.turn);
    if (choices.length && pick.decision?.manualOverride?.status === "applied") errors.push(`round_${index + 1}_conflicting_override_receipts`);
    const choice = choices[0];
    const decisionAt = timestamp(decisionsByTurn.get(pick.turn)?.at);
    const choiceAt = timestamp(choice?.at);
    const onClockOverride = choices.length === 1 && String(choice.chosenYahooId) === pick.yahooId &&
      String(choice.source ?? "").length > 0 && decisionAt !== null && choiceAt !== null && choiceAt >= decisionAt &&
      JSON.stringify(asArray(choice.baselineFallbacks).map(String)) === JSON.stringify(targets);
    if (choices.length && !onClockOverride) errors.push(`round_${index + 1}_on_clock_choice_invalid`);
    if (targetIndex < 0 && !onClockOverride) errors.push(`round_${index + 1}_confirmed_pick_absent_from_target_ladder`);
    if (pick.yahooId !== replay.chosenYahooId && !onClockOverride) errors.push(`round_${index + 1}_unintended_selection`);
    return { ...replay, targetIndex, onClockOverride, choiceAt, replayMode:onClockOverride ? "ON_CLOCK_OVERRIDE" : replay.replayMode };
  });

  const startTime = timestamp(started[0]?.at);
  const completionTime = timestamp(completed[0]?.at);
  if (startTime === null || completionTime === null || completionTime < startTime) errors.push("runner_time_window_invalid");
  const inSelectedRun = (entry) => {
    const at = timestamp(entry?.at);
    return startTime !== null && completionTime !== null && at !== null && at >= startTime && at <= completionTime;
  };
  const stagedPins = extensionReceipts.filter((entry) => entry.kind === "manual_pin_staged" && inSelectedRun(entry));
  const appliedPins = extensionReceipts.filter((entry) => entry.kind === "manual_pin_applied" && inSelectedRun(entry));
  const rejectedPins = extensionReceipts.filter((entry) => entry.kind === "manual_pin_rejected" && inSelectedRun(entry));
  const overrideClaims = picks.filter((pick) => pick.decision?.manualOverride?.status === "applied");
  const manualEvidenceRequired = options.requireManualOverride === true || options.requireRejectedOverride === true ||
    overrideClaims.length > 0 || stagedPins.length > 0 || appliedPins.length > 0 || rejectedPins.length > 0;
  if (manualEvidenceRequired) {
    if (options.requireManualOverride === true && overrideClaims.length !== 1) errors.push("manual_override_decision_contract_failed");
    if (options.requireRejectedOverride === true && rejectedPins.length !== 1) errors.push("manual_override_rejection_contract_failed");
    if (stagedPins.length !== overrideClaims.length + rejectedPins.length) errors.push("manual_override_staged_receipt_contract_failed");
    if (appliedPins.length !== overrideClaims.length) errors.push("manual_override_applied_receipt_contract_failed");
    for (const pick of overrideClaims) {
      const round = Number(pick.round);
      const yahooId = String(pick.decision.manualOverride.chosenYahooId ?? "");
      const staged = stagedPins.filter((entry) =>
        Number(entry.expectedRound) === round && String(entry.targetYahooIds?.[0] ?? "") === yahooId
      );
      const applied = appliedPins.filter((entry) =>
        Number(entry.expectedRound) === round && String(entry.chosenYahooId ?? "") === yahooId
      );
      if (staged.length !== 1 || applied.length !== 1) {
        errors.push("manual_override_receipt_identity_mismatch");
        continue;
      }
      if (
        String(staged[0].roomId) !== expectedRoomId || Number(staged[0].seat) !== Number(payload?.seat) ||
        String(applied[0].roomId) !== expectedRoomId || Number(applied[0].seat) !== Number(payload?.seat) ||
        applied[0].failure != null || String(pick.decision.manualOverride.chosenYahooId ?? "") !== yahooId
      ) errors.push("manual_override_receipt_identity_mismatch");
    }
    for (const rejected of rejectedPins) {
      const expectedRound = Number(rejected.expectedRound);
      const staged = stagedPins.filter((entry) => Number(entry.expectedRound) === expectedRound);
      const stagedTarget = String(staged[0]?.targetYahooIds?.[0] ?? "");
      const provesAlreadyDrafted = picks.some((pick) => pick.round < expectedRound && pick.yahooId === stagedTarget);
      if (
        !Number.isInteger(expectedRound) || staged.length !== 1 || rejected.baselineRetained !== true ||
        !String(rejected.failure ?? "").trim() ||
        String(rejected.roomId) !== expectedRoomId || Number(rejected.seat) !== Number(payload?.seat) ||
        overrideClaims.some((pick) => pick.round === expectedRound) ||
        (options.requireRejectedOverride === true && (rejected.failure !== "manual_pin_unavailable_or_ineligible" || !provesAlreadyDrafted))
      ) errors.push("manual_override_rejection_receipt_invalid");
    }
  }

  const pairs = startTime === null || completionTime === null
    ? []
    : controllerPairs(controllerReceipts, startTime, completionTime);
  if (pairs.length !== config.rounds) errors.push(`exactly_${config.rounds}_controller_pick_runs_required`);
  if (controllerReceipts.some((entry) => /autodraft/i.test(`${entry.kind} ${entry.code ?? ""}`))) errors.push("controller_autodraft_event_observed");
  for (let index = 0; index < Math.min(pairs.length, picks.length); index += 1) {
    const pair = pairs[index];
    const pick = picks[index];
    if (pair.clicks.length !== 1 || pair.confirmations.length !== 1 || pair.failures.length) {
      errors.push(`round_${index + 1}_controller_receipt_contract_failed`);
      continue;
    }
    const click = pair.clicks[0];
    const confirmation = pair.confirmations[0];
    if (replays[index]?.onClockOverride && (timestamp(click.at) === null || replays[index].choiceAt > timestamp(click.at))) {
      errors.push(`round_${index + 1}_on_clock_choice_after_click`);
    }
    if (String(click.roomId) !== expectedRoomId || String(confirmation.roomId) !== expectedRoomId) errors.push(`round_${index + 1}_controller_room_mismatch`);
    if (Number(click.seat) !== expectedUrlSeat || Number(confirmation.seat) !== expectedUrlSeat) errors.push(`round_${index + 1}_controller_url_team_mismatch`);
    if (String(click.yahooId) !== pick.yahooId || String(confirmation.yahooId) !== pick.yahooId) errors.push(`round_${index + 1}_controller_player_mismatch`);
    if (String(click.turn) !== pick.turn || String(confirmation.turn) !== pick.turn) errors.push(`round_${index + 1}_controller_turn_mismatch`);
    if (Number(click.rosterBefore?.filled) !== index || Number(confirmation.rosterAfter?.filled) !== index + 1) errors.push(`round_${index + 1}_controller_roster_transition_mismatch`);
    const rosterYahooIds = asArray(confirmation.rosterYahooIds).map(String);
    if (rosterYahooIds.length !== index + 1 || new Set(rosterYahooIds).size !== rosterYahooIds.length || !rosterYahooIds.includes(pick.yahooId)) {
      errors.push(`round_${index + 1}_controller_exact_roster_identity_missing`);
    }
    if (click.autodraftState !== "INACTIVE") errors.push(`round_${index + 1}_controller_autodraft_not_verified_off`);
    if (click.queueState !== "EMPTY") errors.push(`round_${index + 1}_controller_queue_not_verified_empty`);
    if (!validClock(click.clockAtClick, publicMock ? 300 : 60, 2)) errors.push(`round_${index + 1}_controller_clock_evidence_missing_or_invalid`);
  }

  if (!publicMock) {
    const kDef = picks.filter((pick) => ["K", "DEF"].includes(pick.position));
    const idp = picks.filter((pick) => ["D", "LB", "CB", "S"].includes(pick.position));
    if (kDef.some((pick) => pick.round < 15) || kDef.filter((pick) => pick.round <= 16).length !== 2) errors.push("test_specialist_k_def_timing_failed");
    if (idp.some((pick) => pick.round < 17)) errors.push("test_specialist_idp_timing_failed");
  }

  return {
    schemaVersion: 1,
    contract: contract.name,
    acceptanceScope: contract.scope,
    status: errors.length ? "LOCKED" : contract.passStatus,
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    roomId: String(payload?.roomId ?? ""),
    draftSlot: Number(payload?.seat),
    urlTeamId: Number(payload?.urlSeat),
    observedTeamCount,
    extensionVersion: payload?.extensionVersion ?? null,
    runtimeAttestation: validRuntimeAttestation(runtimeAttestation) ? "VERIFIED" : "MISSING_OR_INVALID",
    operatorAttestation: operatorAttestation?.status ?? "missing",
    runnerRunId: selectedRun.runId,
    confirmedPicks: picks.length,
    latencyBudgetMs,
    maxObservedLatencyMs: picks.length ? Math.max(...picks.map((pick) => pick.latencyMs)) : null,
    fallbackPicks: replays.filter((replay) => replay.fallbackUsed && !replay.manualOverride).length,
    fallbackDecisions: replays.filter((replay) => replay.fallbackUsed).length,
    finalRosterReadback: contract.requireFinalRosterReadback
      ? finalRosterReceipts.length === 1 ? "VERIFIED" : "MISSING_OR_AMBIGUOUS"
      : "NOT_AVAILABLE_ON_PUBLIC_MOCK_SURFACE",
    manualOverride: {
      required: options.requireManualOverride === true,
      claimedDecisions: overrideClaims.length,
      stagedReceipts: stagedPins.length,
      appliedReceipts: appliedPins.length,
      rejectedReceipts: rejectedPins.length,
      rejectedRequired: options.requireRejectedOverride === true,
    },
    counterfactualScoring: "not_available_from_compact_receipts",
    finalCounts: countsByPosition(picks),
    picks: picks.map((pick, index) => ({
      round: pick.round,
      yahooId: pick.yahooId,
      name: pick.name,
      position: pick.position,
      team: pick.team,
      latencyMs: pick.latencyMs,
      turnDetectionToClickMs: pick.turnDetectionToClickMs,
      clockAtDecision: pick.clockAtDecision,
      targetIndex: replays[index]?.targetIndex ?? -1,
      decisionReplay: replays[index]?.consistent === true ? "MATCH" : "MISMATCH",
      replayMode: replays[index]?.replayMode ?? null,
      fallbackUsed: replays[index]?.fallbackUsed === true,
      counterfactual: "not_available",
    })),
  };
}

export function evaluateTestDraftExport(payload, options = {}) {
  return evaluateDraftExport(payload, { ...options, contract: "league_two_test_19_idp" });
}

export function evaluatePublicMockExport(payload, options = {}) {
  return evaluateDraftExport(payload, { ...options, contract: "public_mock_15" });
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((entry) => {
    const [key, ...value] = entry.split("=");
    return [key.replace(/^--/, ""), value.join("=")];
  }));
  if (!args.input || !args.output) throw new Error("usage: node analysis/test-draft-acceptance.mjs --input=export.json --output=report.json [--contract=league_two_test_19_idp|public_mock_15] [--require-manual-override=true|false] [--require-rejected-override=true|false]");
  const contract = args.contract ?? "league_two_test_19_idp";
  if (!CONTRACTS[contract]) throw new Error(`unknown acceptance contract: ${contract}`);
  if (args["require-manual-override"] != null && !["true", "false"].includes(args["require-manual-override"])) {
    throw new Error("--require-manual-override must be true or false");
  }
  if (args["require-rejected-override"] != null && !["true", "false"].includes(args["require-rejected-override"])) {
    throw new Error("--require-rejected-override must be true or false");
  }
  const inputText = await readFile(args.input, "utf8");
  const payload = JSON.parse(inputText);
  const result = evaluateDraftExport(payload, {
    contract,
    latencyBudgetMs: args["latency-budget-ms"] == null ? undefined : Number(args["latency-budget-ms"]),
    requireManualOverride: args["require-manual-override"] === "true",
    requireRejectedOverride: args["require-rejected-override"] === "true",
  });
  result.inputSha256 = createHash("sha256").update(inputText).digest("hex");
  await writeFile(args.output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output: args.output, status: result.status, picks: result.confirmedPicks })}\n`);
  if (!result.valid) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
