import assert from "node:assert/strict";
import test from "node:test";

import { evaluateTestDraftExport } from "./test-draft-acceptance.mjs";

const POSITIONS = ["QB", "QB", "RB", "RB", "RB", "RB", "RB", "WR", "WR", "WR", "WR", "WR", "TE", "K", "DEF", "D", "LB", "CB", "S"];

function iso(offsetMs) {
  return new Date(Date.parse("2026-08-23T19:00:00Z") + offsetMs).toISOString();
}

function overallPick(round, seat, teams = 12) {
  return round % 2 === 1 ? (round - 1) * teams + seat : round * teams - seat + 1;
}

function validPayload() {
  const roomId = "18599";
  const draftSlot = 6;
  const urlSeat = 12;
  const runnerRunId = "runner-1";
  const rosterSlots = ["QB", "WR", "WR", "RB", "RB", "W/R", "W/R/T", "K", "DEF", "D", "LB", "CB", "S", "BN", "BN", "BN", "BN", "BN", "BN"];
  const runnerReceipts = [{
    at: iso(0), runId: runnerRunId, roomId, seat: draftSlot, urlSeat, kind: "runner_started",
    configName: "test_league_19_idp", expectedRoomId: roomId, expectedSeat: draftSlot, expectedUrlSeat: urlSeat,
    observedTeamCount: 12, observedRosterSlots: rosterSlots,
  }];
  const controllerReceipts = [];
  const picks = [];
  for (let index = 0; index < 19; index += 1) {
    const round = index + 1;
    const yahooId = String(40_000 + round);
    const turn = `R${round}P${overallPick(round, draftSlot)}`;
    const pick = { yahooId, name: `Player ${round}`, position: POSITIONS[index], team: "BUF", turn, detectionToClickMs: 80, clickToConfirmationMs: 120 };
    picks.push(pick);
    runnerReceipts.push({
      at: iso(round * 1_000 - 200), runId: runnerRunId, roomId, seat: draftSlot, urlSeat, kind: "runner_turn_resolved", turn,
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
      rosterBefore: { filled: index, total: 19 }, detectionToClickMs: 80,
    });
    controllerReceipts.push({
      at: iso(round * 1_000), sessionId: controllerSessionId, roomId, seat: urlSeat, kind: "pick_confirmed", turn, yahooId,
      rosterBefore: { filled: index, total: 19 }, rosterAfter: { filled: round, total: 19 }, clickToConfirmationMs: 120,
    });
  }
  const counts = POSITIONS.reduce((result, position) => ({ ...result, [position]: (result[position] ?? 0) + 1 }), {});
  runnerReceipts.push({ at: iso(20_000), runId: runnerRunId, roomId, seat: draftSlot, urlSeat, kind: "runner_completed", picks: 19, counts });
  return {
    extensionVersion: "0.5.1",
    roomId,
    seat: draftSlot,
    urlSeat,
    status: { runId: runnerRunId, roomId, seat: draftSlot, urlSeat, state: "completed", picks: picks.map((pick) => ({ ...pick })) },
    runnerReceipts,
    controllerReceipts,
    extensionReceipts: [],
  };
}

test("accepts one exact completed TEST draft without inventing counterfactuals", () => {
  const result = evaluateTestDraftExport(validPayload());
  assert.equal(result.status, "PASS", JSON.stringify(result.errors));
  assert.equal(result.confirmedPicks, 19);
  assert.equal(result.maxObservedLatencyMs, 200);
  assert.equal(result.counterfactualScoring, "not_available_from_compact_receipts");
  assert.equal(result.picks.every((pick) => pick.decisionReplay === "MATCH" && pick.counterfactual === "not_available"), true);
});

test("locks when a recorded decision does not reproduce the chosen player", () => {
  const payload = validPayload();
  payload.runnerReceipts.find((entry) => entry.kind === "runner_turn_resolved").decision.positionLeaders[0].player.yahooId = "99999";
  const result = evaluateTestDraftExport(payload);
  assert.equal(result.status, "LOCKED");
  assert.ok(result.errors.includes("round_1_decision_replay_mismatch"));
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

test("locks on any runner failure, HALT, or Autodraft evidence", () => {
  const payload = validPayload();
  payload.runnerReceipts.splice(-1, 0, {
    at: iso(19_500), runId: "runner-1", roomId: "18599", seat: 6, urlSeat: 12,
    kind: "runner_failed", code: "autodraft_active_at_start",
  });
  const result = evaluateTestDraftExport(payload);
  assert.equal(result.status, "LOCKED");
  assert.ok(result.errors.includes("runner_failure_or_halt_observed"));
  assert.ok(result.errors.includes("autodraft_event_observed"));
});
