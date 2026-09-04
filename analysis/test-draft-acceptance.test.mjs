import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePublicMockExport, evaluateTestDraftExport } from "./test-draft-acceptance.mjs";
import "../controller/yahoo-mock-runner.js";

const TEST_ALLOCATOR = globalThis.SKRODZKaiYahooMockRunner._test.allocateRosterSlots;
const RUNNER_HELPERS = globalThis.SKRODZKaiYahooMockRunner._test;
const TEST_CONFIG = globalThis.SKRODZKaiYahooMockRunner.configs.test_league_19_idp;
const RUNTIME_ATTESTATION = Object.freeze({ ok:true, version:"0.16.0", digest:"a".repeat(64), bootId:"boot-12345678", bootedAt:1 });

const POSITIONS = ["QB", "QB", "RB", "RB", "RB", "RB", "RB", "WR", "WR", "WR", "WR", "WR", "WR", "TE", "K", "DEF", "TE", "D", "LB"];
const PUBLIC_POSITIONS = ["RB", "WR", "QB", "WR", "RB", "DEF", "TE", "WR", "K", "RB", "WR", "WR", "WR", "RB", "RB"];

function iso(offsetMs) {
  return new Date(Date.parse("2026-08-23T19:00:00Z") + offsetMs).toISOString();
}

function overallPick(round, seat, teams = 12) {
  return round % 2 === 1 ? (round - 1) * teams + seat : round * teams - seat + 1;
}

function validPayload() {
  const roomId = "542830";
  const draftSlot = 6;
  const urlSeat = 3;
  const teamCount = 10;
  const runnerRunId = "runner-1";
  const rosterSlots = ["QB", "WR", "WR", "WR", "RB", "RB", "TE", "W/R/T", "W/R/T", "K", "DEF", "D", "D", "BN", "BN", "BN", "BN", "BN", "BN"];
  const runnerReceipts = [{
    at: iso(0), runId: runnerRunId, roomId, seat: draftSlot, urlSeat, kind: "runner_started",
    configName: "test_league_19_idp", expectedRoomId: roomId, expectedSeat: draftSlot, expectedUrlSeat: urlSeat,
    observedTeamCount: teamCount, observedRosterSlots: rosterSlots, runtimeAttestation:RUNTIME_ATTESTATION,
    autodraftState:"INACTIVE", queueState:"EMPTY",
  }];
  const controllerReceipts = [];
  const picks = [];
  for (let index = 0; index < 19; index += 1) {
    const round = index + 1;
    const yahooId = String(40_000 + round);
    const turn = `R${round}P${overallPick(round, draftSlot, teamCount)}`;
    const pick = { yahooId, name: `Player ${round}`, position: POSITIONS[index], team: "BUF", turn, detectionToClickMs: 80, turnDetectionToClickMs:120, turnToClickBudgetMs:2000, clickToConfirmationMs: 120, clockAtDecision:{ label:"00:59", seconds:59 } };
    picks.push(pick);
    runnerReceipts.push({
      at: iso(round * 1_000 - 200), runId: runnerRunId, roomId, seat: draftSlot, urlSeat, kind: "runner_turn_resolved", turn,
      panelReadyMs:10, panelBudgetMs:250, clockAtDecision:{ label:"00:59", seconds:59 },
      decision: {
        chosenYahooId: yahooId,
        targetYahooIds: [yahooId, String(50_000 + round), String(60_000 + round), String(70_000 + round), String(80_000 + round)],
        positionLeaders: [{ player: { yahooId, rank: round }, eligible: true, adjustedScore: 10 }],
      },
    });
    runnerReceipts.push({ at: iso(round * 1_000), runId: runnerRunId, roomId, seat: draftSlot, urlSeat, kind: "runner_pick_confirmed", round, pick });
    const controllerSessionId = `controller-${round}`;
    controllerReceipts.push({
      at: iso(round * 1_000 - 100), sessionId: controllerSessionId, roomId, seat: urlSeat, kind: "draft_click", turn, yahooId,
      rosterBefore: { filled: index, total: 19 }, detectionToClickMs: 80, autodraftState:"INACTIVE", queueState:"EMPTY", clockAtClick:{ label:"00:59", seconds:59 },
    });
    controllerReceipts.push({
      at: iso(round * 1_000), sessionId: controllerSessionId, roomId, seat: urlSeat, kind: "pick_confirmed", turn, yahooId,
      rosterBefore: { filled: index, total: 19 }, rosterAfter: { filled: round, total: 19 }, rosterYahooIds:picks.map((entry) => entry.yahooId), clickToConfirmationMs: 120,
    });
  }
  const counts = POSITIONS.reduce((result, position) => ({ ...result, [position]: (result[position] ?? 0) + 1 }), {});
  runnerReceipts.push({ at: iso(20_000), runId: runnerRunId, roomId, seat: draftSlot, urlSeat, kind: "runner_completed", picks: 19, counts });
  const finalRosterSlots = TEST_ALLOCATOR(picks, rosterSlots).map((entry) => ({
    slot:entry.slot,
    yahooId:entry.player?.yahooId ?? null,
    name:entry.player?.name ?? null,
    empty:!entry.player,
  }));
  return {
    extensionVersion: "0.16.0",
    runtimeAttestation:RUNTIME_ATTESTATION,
    roomId,
    seat: draftSlot,
    urlSeat,
    operatorAttestation: { status:"none", source:"operator_attested", attestedAt:iso(21_000), interventions:[] },
    status: { runId: runnerRunId, roomId, seat: draftSlot, urlSeat, state: "completed", picks: picks.map((pick) => ({ ...pick })) },
    runnerReceipts,
    controllerReceipts,
    extensionReceipts: [{ at:iso(20_500), version:"0.16.0", roomId, seat:draftSlot, urlSeat, runId:runnerRunId, kind:"final_roster_readback", valid:true, finalRosterSlots }],
  };
}

function validPublicPayload() {
  const roomId = "10085328";
  const seat = 4;
  const runId = "public-runner-1";
  const rosterSlots = ["QB", "WR", "WR", "RB", "RB", "TE", "W/R/T", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN"];
  const runnerReceipts = [{
    at:iso(0), runId, roomId, seat, urlSeat:seat, kind:"runner_started",
    configName:"public_mock_15", expectedRoomId:roomId, expectedSeat:seat, expectedUrlSeat:seat,
    observedTeamCount:12, observedRosterSlots:rosterSlots, runtimeAttestation:RUNTIME_ATTESTATION,
    autodraftState:"INACTIVE", queueState:"EMPTY",
  }];
  const controllerReceipts = [];
  const picks = [];
  for (let index = 0; index < PUBLIC_POSITIONS.length; index += 1) {
    const round = index + 1;
    const yahooId = String(60_000 + round);
    const turn = `R${round}P${overallPick(round, seat)}`;
    const pick = { yahooId, name:`Public Player ${round}`, position:PUBLIC_POSITIONS[index], team:"BUF", turn, detectionToClickMs:80, turnDetectionToClickMs:120, turnToClickBudgetMs:2000, clickToConfirmationMs:120, clockAtDecision:{ label:"00:59", seconds:59 } };
    picks.push(pick);
    runnerReceipts.push({
      at:iso(round * 1_000 - 200), runId, roomId, seat, urlSeat:seat, kind:"runner_turn_resolved", turn,
      panelReadyMs:10, panelBudgetMs:250, clockAtDecision:{ label:"00:59", seconds:59 },
      decision:{
        chosenYahooId:yahooId,
        targetYahooIds:[yahooId, String(70_000 + round), String(80_000 + round), String(90_000 + round), String(100_000 + round)],
        positionLeaders:[{ player:{ yahooId, rank:round }, eligible:true, adjustedScore:10 }],
        ...(round === 2 ? { manualOverride:{ status:"applied", chosenYahooId:yahooId } } : {}),
      },
    });
    runnerReceipts.push({ at:iso(round * 1_000), runId, roomId, seat, urlSeat:seat, kind:"runner_pick_confirmed", round, pick });
    const sessionId = `public-controller-${round}`;
    controllerReceipts.push({
      at:iso(round * 1_000 - 100), sessionId, roomId, seat, kind:"draft_click", turn, yahooId,
      rosterBefore:{ filled:index, total:15 }, detectionToClickMs:80, autodraftState:"INACTIVE", queueState:"EMPTY", clockAtClick:{ label:"00:59", seconds:59 },
    });
    controllerReceipts.push({
      at:iso(round * 1_000), sessionId, roomId, seat, kind:"pick_confirmed", turn, yahooId,
      rosterBefore:{ filled:index, total:15 }, rosterAfter:{ filled:round, total:15 }, rosterYahooIds:picks.map((entry) => entry.yahooId), clickToConfirmationMs:120,
    });
  }
  const counts = PUBLIC_POSITIONS.reduce((result, position) => ({ ...result, [position]:(result[position] ?? 0) + 1 }), {});
  runnerReceipts.push({ at:iso(16_000), runId, roomId, seat, urlSeat:seat, kind:"runner_completed", picks:15, counts });
  return {
    extensionVersion:"0.16.0",
    runtimeAttestation:RUNTIME_ATTESTATION,
    roomId,
    seat,
    urlSeat:seat,
    operatorAttestation:{ status:"none", source:"operator_attested", attestedAt:iso(17_000), interventions:[] },
    status:{ runId, roomId, seat, urlSeat:seat, state:"completed", picks:picks.map((pick) => ({ ...pick })) },
    runnerReceipts,
    controllerReceipts,
    extensionReceipts:[
      { at:iso(1_000), version:"0.16.0", roomId, seat, kind:"manual_pin_staged", expectedRound:2, targetYahooIds:[picks[1].yahooId] },
      { at:iso(2_000), version:"0.16.0", roomId, seat, kind:"manual_pin_applied", expectedRound:2, chosenYahooId:picks[1].yahooId, failure:null },
    ],
  };
}

function runtimeFallbackDecision() {
  const positions = ["RB", "WR", "QB", "TE", "RB", "WR"];
  const ids = ["40001", "50001", "60001", "70001", "80001", "90001"];
  const board = RUNNER_HELPERS.validateBoard(ids.map((yahooId, index) => ({
    yahooId,
    name:`Fallback ${index + 1}`,
    team:"BUF",
    position:positions[index],
    eligible:[positions[index]],
    rank:index + 1,
    projection:300 - index * 10,
    automaticEligible:true,
    manualEligible:true,
    validationStatus:"EXECUTABLE",
  })));
  return RUNNER_HELPERS.buildDecisionLadder({
    round:1,
    seat:6,
    picks:[],
    board,
    availablePlayers:board,
    minimum:5,
    config:{ ...TEST_CONFIG, teams:10 },
    replacementBySlot:{ QB:200, RB:100, WR:100, TE:80, K:70, DEF:60, D:50, LB:48, DB:45, CB:45, S:45 },
  }).decision;
}

test("accepts one exact completed TEST draft without inventing counterfactuals", () => {
  const result = evaluateTestDraftExport(validPayload());
  assert.equal(result.status, "PASS", JSON.stringify(result.errors));
  assert.equal(result.confirmedPicks, 19);
  assert.equal(result.maxObservedLatencyMs, 200);
  assert.equal(result.counterfactualScoring, "not_available_from_compact_receipts");
  assert.equal(result.picks.every((pick) => pick.decisionReplay === "MATCH" && pick.counterfactual === "not_available"), true);
});

test("accepts a public mock only under the explicit public contract", () => {
  const result = evaluatePublicMockExport(validPublicPayload(), { requireManualOverride:true });
  assert.equal(result.status, "PUBLIC_MOCK_PASS", JSON.stringify(result.errors));
  assert.equal(result.acceptanceScope, "PUBLIC_MOCK_EXECUTION_ONLY");
  assert.equal(result.confirmedPicks, 15);
  assert.equal(result.finalRosterReadback, "NOT_AVAILABLE_ON_PUBLIC_MOCK_SURFACE");
  assert.deepEqual(result.manualOverride, { required:true, claimedDecisions:1, stagedReceipts:1, appliedReceipts:1, rejectedReceipts:0, rejectedRequired:false });
});

test("League Two TEST acceptance stays strict for a public mock export", () => {
  const result = evaluateTestDraftExport(validPublicPayload());
  assert.equal(result.status, "LOCKED");
  assert.ok(result.errors.includes("test_room_identity_mismatch"));
  assert.ok(result.errors.includes("final_roster_readback_missing"));
});

test("public mock acceptance requires the requested manual-override evidence", () => {
  const payload = validPublicPayload();
  payload.extensionReceipts = [];
  const result = evaluatePublicMockExport(payload, { requireManualOverride:true });
  assert.equal(result.status, "LOCKED");
  assert.ok(result.errors.includes("manual_override_staged_receipt_contract_failed"));
  assert.ok(result.errors.includes("manual_override_applied_receipt_contract_failed"));
});

test("public mock acceptance derives receipt requirements from an applied override claim", () => {
  const payload = validPublicPayload();
  payload.extensionReceipts = [];
  const result = evaluatePublicMockExport(payload);
  assert.equal(result.status, "LOCKED");
  assert.ok(result.errors.includes("manual_override_staged_receipt_contract_failed"));
  assert.ok(result.errors.includes("manual_override_applied_receipt_contract_failed"));
});

test("public mock acceptance does not bind stale manual receipts to the selected run", () => {
  const payload = validPublicPayload();
  for (const receipt of payload.extensionReceipts) receipt.at = iso(-1_000);
  const result = evaluatePublicMockExport(payload);
  assert.equal(result.status, "LOCKED");
  assert.ok(result.errors.includes("manual_override_staged_receipt_contract_failed"));
  assert.ok(result.errors.includes("manual_override_applied_receipt_contract_failed"));
});

test("public mock acceptance rejects fabricated final-roster readback evidence", () => {
  const payload = validPublicPayload();
  payload.extensionReceipts.push({
    at:iso(16_500), version:"0.16.0", roomId:payload.roomId, seat:payload.seat,
    runId:"different-run", kind:"final_roster_readback", valid:true, finalRosterSlots:[],
  });
  const result = evaluatePublicMockExport(payload, { requireManualOverride:true });
  assert.equal(result.status, "LOCKED");
  assert.ok(result.errors.includes("unexpected_public_mock_final_roster_readback"));
});

test("public mock acceptance rejects the real league identity", () => {
  const payload = validPublicPayload();
  payload.roomId = "420010";
  for (const receipt of [...payload.runnerReceipts, ...payload.controllerReceipts, ...payload.extensionReceipts]) receipt.roomId = "420010";
  payload.status.roomId = "420010";
  const result = evaluatePublicMockExport(payload, { requireManualOverride:true });
  assert.equal(result.status, "LOCKED");
  assert.ok(result.errors.includes("public_mock_room_identity_invalid"));
});

test("locks when a recorded decision does not reproduce the chosen player", () => {
  const payload = validPayload();
  payload.runnerReceipts.find((entry) => entry.kind === "runner_turn_resolved").decision.positionLeaders[0].player.yahooId = "99999";
  const result = evaluateTestDraftExport(payload);
  assert.equal(result.status, "LOCKED");
  assert.ok(result.errors.includes("round_1_decision_replay_mismatch"));
});

test("acceptance locks any runtime decision fallback", () => {
  const payload = validPayload();
  const receipt = payload.runnerReceipts.find((entry) => entry.kind === "runner_turn_resolved");
  receipt.decision = runtimeFallbackDecision();
  receipt.decision.fallbackUsed = true;
  const result = evaluateTestDraftExport(payload);
  assert.equal(result.status, "LOCKED");
  assert.ok(result.errors.includes("round_1_decision_fallback_forbidden"));
  assert.equal(result.fallbackPicks, 1);
  assert.equal(result.picks[0].replayMode, "STATIC_BOARD_FALLBACK");
});

test("fallback replay locks when the first static target does not match the confirmed choice", () => {
  const payload = validPayload();
  const decision = payload.runnerReceipts.find((entry) => entry.kind === "runner_turn_resolved").decision;
  decision.fallbackUsed = true;
  decision.positionLeaders = [
    { player:{ yahooId:"49998", rank:1 }, eligible:true, adjustedScore:5 },
    { player:{ yahooId:decision.chosenYahooId, rank:2 }, eligible:true, adjustedScore:500 },
  ];
  const result = evaluateTestDraftExport(payload);
  assert.equal(result.status, "LOCKED");
  assert.ok(result.errors.includes("round_1_decision_replay_mismatch"));
});

test("acceptance replays an applied manual pin against its receipted Yahoo ID", () => {
  const payload = validPayload();
  const oldId = payload.status.picks[0].yahooId;
  const pinnedId = "49999";
  payload.status.picks[0] = { ...payload.status.picks[0], yahooId:pinnedId, name:"Pinned Player" };
  const turn = payload.runnerReceipts.find((entry) => entry.kind === "runner_turn_resolved" && entry.turn === "R1P6");
  turn.decision.chosenYahooId = pinnedId;
  turn.decision.targetYahooIds[0] = pinnedId;
  turn.decision.manualOverride = { status:"applied", chosenYahooId:pinnedId };
  const pick = payload.runnerReceipts.find((entry) => entry.kind === "runner_pick_confirmed" && entry.round === 1);
  pick.pick = { ...pick.pick, yahooId:pinnedId, name:"Pinned Player" };
  for (const entry of payload.controllerReceipts) {
    if (entry.turn === "R1P6") entry.yahooId = pinnedId;
    if (Array.isArray(entry.rosterYahooIds)) entry.rosterYahooIds = entry.rosterYahooIds.map((yahooId) => yahooId === oldId ? pinnedId : yahooId);
  }
  const rosterEntry = payload.extensionReceipts[0].finalRosterSlots.find((entry) => entry.yahooId === oldId);
  rosterEntry.yahooId = pinnedId;
  rosterEntry.name = "Pinned Player";
  payload.extensionReceipts.push(
    { at:iso(100), version:"0.16.0", roomId:payload.roomId, seat:payload.seat, kind:"manual_pin_staged", expectedRound:1, targetYahooIds:[pinnedId] },
    { at:iso(200), version:"0.16.0", roomId:payload.roomId, seat:payload.seat, kind:"manual_pin_applied", expectedRound:1, chosenYahooId:pinnedId, failure:null },
  );
  const result = evaluateTestDraftExport(payload);
  assert.equal(result.status, "PASS", JSON.stringify(result.errors));
  assert.equal(result.picks[0].decisionReplay, "MATCH");
});

test("TEST acceptance requires one rejected pre-staged player to retain the baseline", () => {
  const payload = validPayload();
  const alreadyDrafted = payload.status.picks[0].yahooId;
  payload.extensionReceipts.push(
    { at:iso(1_100), version:"0.16.0", roomId:payload.roomId, seat:payload.seat, kind:"manual_pin_staged", expectedRound:2, targetYahooIds:[alreadyDrafted] },
    { at:iso(1_800), version:"0.16.0", roomId:payload.roomId, seat:payload.seat, kind:"manual_pin_rejected", expectedRound:2, chosenYahooId:null, failure:"manual_pin_unavailable_or_ineligible", baselineRetained:true },
  );
  const accepted = evaluateTestDraftExport(payload, { requireRejectedOverride:true });
  assert.equal(accepted.status, "PASS", JSON.stringify(accepted.errors));
  assert.equal(accepted.manualOverride.rejectedReceipts, 1);

  payload.extensionReceipts.at(-1).baselineRetained = false;
  const locked = evaluateTestDraftExport(payload, { requireRejectedOverride:true });
  assert.equal(locked.status, "LOCKED");
  assert.ok(locked.errors.includes("manual_override_rejection_receipt_invalid"));
});

test("locks missing runtime, Autodraft, queue, clock, and two-second evidence", () => {
  const payload = validPayload();
  payload.runtimeAttestation = null;
  const started = payload.runnerReceipts[0];
  started.autodraftState = "UNKNOWN";
  started.queueState = "NONEMPTY_OR_UNKNOWN";
  const decision = payload.runnerReceipts.find((entry) => entry.kind === "runner_turn_resolved");
  decision.panelReadyMs = 250;
  decision.clockAtDecision = null;
  const pick = payload.runnerReceipts.find((entry) => entry.kind === "runner_pick_confirmed");
  pick.pick.turnDetectionToClickMs = 2000;
  pick.pick.clockAtDecision = null;
  const click = payload.controllerReceipts.find((entry) => entry.kind === "draft_click");
  click.autodraftState = "UNKNOWN";
  click.queueState = "NONEMPTY_OR_UNKNOWN";
  click.clockAtClick = null;
  const result = evaluateTestDraftExport(payload);
  assert.equal(result.status, "LOCKED");
  for (const error of [
    "runtime_attestation_missing_or_invalid", "runner_started_autodraft_not_verified_off",
    "runner_started_queue_not_verified_empty", "turn_R1P6_panel_ready_budget_missed",
    "round_1_turn_to_click_budget_missed", "round_1_controller_autodraft_not_verified_off",
    "round_1_controller_queue_not_verified_empty", "round_1_controller_clock_evidence_missing_or_invalid",
  ]) assert.ok(result.errors.includes(error), error);
});

test("locks when exported status picks disagree with the runner receipts", () => {
  const payload = validPayload();
  payload.status.picks[0].yahooId = "99999";
  const result = evaluateTestDraftExport(payload);
  assert.equal(result.status, "LOCKED");
  assert.ok(result.errors.includes("exported_status_runner_pick_mismatch"));
});

test("locks runner receipt identity, TEST config, and snake-turn drift", () => {
  const payload = validPayload();
  payload.runnerReceipts[0].configName = "public_mock_15";
  payload.runnerReceipts.find((entry) => entry.kind === "runner_pick_confirmed").pick.turn = "R1P1";
  payload.runnerReceipts.find((entry) => entry.kind === "runner_turn_resolved").roomId = "99999";
  const result = evaluateTestDraftExport(payload);
  assert.equal(result.status, "LOCKED");
  assert.ok(result.errors.includes("runner_receipt_identity_mismatch"));
  assert.ok(result.errors.includes("runner_started_test_config_mismatch"));
  assert.ok(result.errors.includes("round_1_snake_turn_mismatch"));
});

test("locks on the controller URL-team identity or receipt-pair contract", () => {
  const payload = validPayload();
  payload.controllerReceipts[0].seat = 6;
  payload.controllerReceipts.pop();
  const result = evaluateTestDraftExport(payload);
  assert.equal(result.status, "LOCKED");
  assert.ok(result.errors.includes("round_1_controller_url_team_mismatch"));
  assert.ok(result.errors.some((error) => error.includes("controller_receipt_contract_failed")));
});

test("locks instead of throwing when the draft slot exceeds the observed field", () => {
  const payload = validPayload();
  payload.seat = 11;
  const result = evaluateTestDraftExport(payload);
  assert.equal(result.status, "LOCKED");
  assert.ok(result.errors.includes("test_draft_slot_exceeds_observed_team_count"));
});

test("locks on any runner failure, HALT, or Autodraft evidence", () => {
  const payload = validPayload();
  payload.runnerReceipts.splice(-1, 0, {
    at: iso(19_500), runId: "runner-1", roomId: "542830", seat: 6, urlSeat: 3,
    kind: "runner_failed", code: "autodraft_active_at_start",
  });
  const result = evaluateTestDraftExport(payload);
  assert.equal(result.status, "LOCKED");
  assert.ok(result.errors.includes("runner_failure_or_halt_observed"));
  assert.ok(result.errors.includes("autodraft_event_observed"));
});

test("locks when owner intervention prevented Yahoo Autodraft even without a completed auto-selection", () => {
  const payload = validPayload();
  payload.operatorAttestation = {
    status:"intervention",
    source:"operator_attested",
    attestedAt:iso(21_000),
    interventions:[{ kind:"prevented_autodraft", detail:"prevented Yahoo from taking Chase" }],
  };
  const result = evaluateTestDraftExport(payload);
  assert.equal(result.status, "LOCKED");
  assert.ok(result.errors.includes("owner_intervention_prevented_autodraft"));
});

test("locks when owner-intervention evidence is missing", () => {
  const payload = validPayload();
  delete payload.operatorAttestation;
  const result = evaluateTestDraftExport(payload);
  assert.equal(result.status, "LOCKED");
  assert.ok(result.errors.includes("owner_intervention_evidence_missing"));
});

test("locks an IDP displaced from a generic D slot to the bench", () => {
  const payload = validPayload();
  const receipt = payload.extensionReceipts[0];
  const dPick = payload.status.picks.find((pick) => pick.position === "D");
  const dSlot = receipt.finalRosterSlots.find((entry) => entry.slot === "D" && entry.yahooId === dPick.yahooId);
  const bench = receipt.finalRosterSlots.find((entry) => entry.slot === "BN");
  dSlot.yahooId = bench.yahooId;
  dSlot.name = bench.name;
  bench.yahooId = dPick.yahooId;
  bench.name = dPick.name;
  receipt.valid = false;
  const result = evaluateTestDraftExport(payload);
  assert.equal(result.status, "LOCKED");
  assert.ok(result.errors.includes("final_roster_slot_occupancy_failed"));
});
