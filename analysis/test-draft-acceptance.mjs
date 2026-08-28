import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { rehearseExactRoster } from "./draft-readiness.mjs";
import "../controller/yahoo-mock-runner.js";

const TEST_CONFIG = globalThis.SKRODZKaiYahooMockRunner.configs.test_league_19_idp;
const TEST_VALIDATOR = globalThis.SKRODZKaiYahooMockRunner._test.validateCompletedRoster;
const TEST_OVERALL_PICK = globalThis.SKRODZKaiYahooMockRunner._test.overallPick;
const TEST_SAME_SLOTS = globalThis.SKRODZKaiYahooMockRunner._test.sameSlots;
const TEST_OBSERVED_ROSTER_VALIDATOR = globalThis.SKRODZKaiYahooMockRunner._test.validateObservedTestRoster;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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
  const ranked = asArray(decision?.positionLeaders)
    .filter((leader) => leader?.eligible === true && leader?.player?.yahooId)
    .sort((left, right) =>
      Number(right.adjustedScore) - Number(left.adjustedScore) ||
      Number(left.player.rank) - Number(right.player.rank),
    );
  const expectedYahooId = manual
    ? String(decision?.manualOverride?.chosenYahooId ?? "") || null
    : ranked[0]?.player?.yahooId == null ? null : String(ranked[0].player.yahooId);
  const chosenYahooId = decision?.chosenYahooId == null ? null : String(decision.chosenYahooId);
  return {
    consistent: expectedYahooId !== null && expectedYahooId === chosenYahooId,
    expectedYahooId,
    chosenYahooId,
    manualOverride: manual,
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

export function evaluateTestDraftExport(payload, options = {}) {
  const expectedRoomId = String(TEST_CONFIG.leagueId);
  const expectedUrlSeat = Number(TEST_CONFIG.urlTeamId);
  const latencyBudgetMs = Number(options.latencyBudgetMs ?? 15_000);
  const errors = [];
  const runnerReceipts = asArray(payload?.runnerReceipts);
  const controllerReceipts = asArray(payload?.controllerReceipts);
  const extensionReceipts = asArray(payload?.extensionReceipts);

  if (String(payload?.roomId ?? "") !== expectedRoomId) errors.push("test_room_identity_mismatch");
  if (Number(payload?.urlSeat) !== expectedUrlSeat) errors.push("test_url_team_identity_mismatch");
  if (!Number.isInteger(Number(payload?.seat)) || Number(payload.seat) < 1 || Number(payload.seat) > TEST_CONFIG.teams) {
    errors.push("test_draft_slot_invalid");
  }
  if (payload?.status?.state !== "completed") errors.push("exported_runner_status_not_completed");
  if (asArray(payload?.status?.picks).length !== TEST_CONFIG.rounds) errors.push("exported_status_pick_count_mismatch");
  if (payload?.extensionVersion !== "0.10.0") errors.push("extension_version_mismatch");
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
  if (completed.length !== 1 || Number(completed[0]?.picks) !== TEST_CONFIG.rounds) errors.push("runner_completed_receipt_contract_failed");
  if (runReceipts.some((entry) =>
    String(entry.roomId) !== expectedRoomId ||
    Number(entry.seat) !== Number(payload?.seat) ||
    Number(entry.urlSeat) !== expectedUrlSeat
  )) errors.push("runner_receipt_identity_mismatch");
  if (
    started[0]?.configName !== TEST_CONFIG.name ||
    String(started[0]?.expectedRoomId) !== expectedRoomId ||
    Number(started[0]?.expectedSeat) !== Number(payload?.seat) ||
    Number(started[0]?.expectedUrlSeat) !== expectedUrlSeat ||
    Number(started[0]?.observedTeamCount) !== TEST_CONFIG.teams ||
    !TEST_SAME_SLOTS(started[0]?.observedRosterSlots, TEST_CONFIG.rosterSlots)
  ) errors.push("runner_started_test_config_mismatch");
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
    decisionsByTurn.set(turn, entry.decision);
  }
  if (pickReceipts.length !== TEST_CONFIG.rounds) errors.push("exactly_19_runner_pick_receipts_required");
  if (decisionsByTurn.size !== TEST_CONFIG.rounds) errors.push("exactly_19_runner_decisions_required");

  const picks = pickReceipts.map((receipt) => ({
    round: Number(receipt.round),
    playerId: String(receipt.pick?.yahooId ?? ""),
    yahooId: String(receipt.pick?.yahooId ?? ""),
    name: String(receipt.pick?.name ?? ""),
    position: String(receipt.pick?.position ?? ""),
    team: String(receipt.pick?.team ?? ""),
    turn: String(receipt.pick?.turn ?? ""),
    latencyMs: Number(receipt.pick?.detectionToClickMs) + Number(receipt.pick?.clickToConfirmationMs),
    decision: decisionsByTurn.get(String(receipt.pick?.turn ?? "")) ?? null,
  }));
  picks.forEach((pick, index) => {
    const round = index + 1;
    if (pick.round !== round) errors.push(`round_${round}_runner_round_mismatch`);
    const expectedTurn = `R${round}P${TEST_OVERALL_PICK(round, Number(payload?.seat), TEST_CONFIG.teams)}`;
    if (pick.turn !== expectedTurn) errors.push(`round_${round}_snake_turn_mismatch`);
  });
  const statusPickIds = asArray(payload?.status?.picks).map((pick) => String(pick?.yahooId ?? ""));
  if (statusPickIds.some((yahooId, index) => yahooId !== picks[index]?.yahooId)) errors.push("exported_status_runner_pick_mismatch");
  const rehearsal = rehearseExactRoster({
    picks,
    rosterShape: normalizedReceiptCounts(completed[0]?.counts),
    latencyBudgetMs,
  });
  if (!rehearsal.valid) errors.push(...rehearsal.errors);
  if (!TEST_VALIDATOR(picks, TEST_CONFIG)) errors.push("test_roster_policy_failed");
  if (!sameCounts(completed[0]?.counts, countsByPosition(picks))) errors.push("runner_completed_counts_mismatch");

  const finalRosterReceipts = extensionReceipts.filter((entry) =>
    entry.kind === "final_roster_readback" && entry.runId === selectedRun.runId
  );
  if (finalRosterReceipts.length !== 1) {
    errors.push(finalRosterReceipts.length ? "ambiguous_final_roster_readback" : "final_roster_readback_missing");
  } else if (
    finalRosterReceipts[0].valid !== true ||
    !TEST_OBSERVED_ROSTER_VALIDATOR(finalRosterReceipts[0].finalRosterSlots, picks)
  ) {
    errors.push("final_roster_slot_occupancy_failed");
  }

  const replays = picks.map((pick, index) => {
    const replay = replayDecision(pick.decision);
    if (!replay.consistent) errors.push(`round_${index + 1}_decision_replay_mismatch`);
    const targets = asArray(pick.decision?.targetYahooIds).map(String);
    const targetIndex = targets.indexOf(pick.yahooId);
    if (targetIndex < 0) errors.push(`round_${index + 1}_confirmed_pick_absent_from_target_ladder`);
    return { ...replay, targetIndex };
  });

  const startTime = timestamp(started[0]?.at);
  const completionTime = timestamp(completed[0]?.at);
  if (startTime === null || completionTime === null || completionTime < startTime) errors.push("runner_time_window_invalid");
  const pairs = startTime === null || completionTime === null
    ? []
    : controllerPairs(controllerReceipts, startTime, completionTime);
  if (pairs.length !== TEST_CONFIG.rounds) errors.push("exactly_19_controller_pick_runs_required");
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
    if (String(click.roomId) !== expectedRoomId || String(confirmation.roomId) !== expectedRoomId) errors.push(`round_${index + 1}_controller_room_mismatch`);
    if (Number(click.seat) !== expectedUrlSeat || Number(confirmation.seat) !== expectedUrlSeat) errors.push(`round_${index + 1}_controller_url_team_mismatch`);
    if (String(click.yahooId) !== pick.yahooId || String(confirmation.yahooId) !== pick.yahooId) errors.push(`round_${index + 1}_controller_player_mismatch`);
    if (String(click.turn) !== pick.turn || String(confirmation.turn) !== pick.turn) errors.push(`round_${index + 1}_controller_turn_mismatch`);
    if (Number(click.rosterBefore?.filled) !== index || Number(confirmation.rosterAfter?.filled) !== index + 1) errors.push(`round_${index + 1}_controller_roster_transition_mismatch`);
  }

  return {
    schemaVersion: 1,
    status: errors.length ? "LOCKED" : "PASS",
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    roomId: String(payload?.roomId ?? ""),
    draftSlot: Number(payload?.seat),
    urlTeamId: Number(payload?.urlSeat),
    extensionVersion: payload?.extensionVersion ?? null,
    operatorAttestation: operatorAttestation?.status ?? "missing",
    runnerRunId: selectedRun.runId,
    confirmedPicks: picks.length,
    latencyBudgetMs,
    maxObservedLatencyMs: picks.length ? Math.max(...picks.map((pick) => pick.latencyMs)) : null,
    fallbackPicks: replays.filter((replay) => replay.targetIndex > 0).length,
    counterfactualScoring: "not_available_from_compact_receipts",
    finalCounts: countsByPosition(picks),
    picks: picks.map((pick, index) => ({
      round: pick.round,
      yahooId: pick.yahooId,
      name: pick.name,
      position: pick.position,
      team: pick.team,
      latencyMs: pick.latencyMs,
      targetIndex: replays[index]?.targetIndex ?? -1,
      decisionReplay: replays[index]?.consistent === true ? "MATCH" : "MISMATCH",
      counterfactual: "not_available",
    })),
  };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((entry) => {
    const [key, ...value] = entry.split("=");
    return [key.replace(/^--/, ""), value.join("=")];
  }));
  if (!args.input || !args.output) throw new Error("usage: node analysis/test-draft-acceptance.mjs --input=export.json --output=report.json");
  const payload = JSON.parse(await readFile(args.input, "utf8"));
  const result = evaluateTestDraftExport(payload, {
    latencyBudgetMs: args["latency-budget-ms"] == null ? undefined : Number(args["latency-budget-ms"]),
  });
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
