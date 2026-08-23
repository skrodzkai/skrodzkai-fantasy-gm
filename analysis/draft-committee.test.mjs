import assert from "node:assert/strict";
import test from "node:test";

import { mergeBallots, packetsFromReceipt, validateBallot } from "./draft-committee.mjs";

const receipt = {
  roomId: "room",
  seat: 7,
  status: { picks: [{ yahooId: "prior", name: "Prior", position: "RB", team: "A" }] },
  runnerReceipts: [{
    kind: "runner_turn_resolved",
    turn: "R2P18",
    decision: {
      nextPick: 31,
      interveningOpponentPicks: 12,
      chosenYahooId: "a",
      targetYahooIds: ["a", "b", "c"],
      positionLeaders: [
        { player: { yahooId: "a", position: "QB", rank: 1, vor: 100, adpEarliest: 2, adpLatest: 20 }, comparator: { yahooId: "q2", vor: 60 }, bucket: "ambiguous", rawScore: 40, adjustedScore: 25, floorPass: true, eligible: true },
        { player: { yahooId: "b", position: "RB", rank: 2, vor: 95, adpEarliest: 3, adpLatest: 15 }, comparator: { yahooId: "r2", vor: 75 }, bucket: "likely_gone", rawScore: 20, adjustedScore: 20, floorPass: true, eligible: true },
        { player: { yahooId: "c", position: "WR", rank: 3, vor: 90, adpEarliest: 4, adpLatest: 18 }, comparator: { yahooId: "w2", vor: 72 }, bucket: "likely_gone", rawScore: 18, adjustedScore: 18, floorPass: true, eligible: true },
      ],
    },
  }],
};

test("creates a compact packet with only pre-turn roster state", () => {
  const [packet] = packetsFromReceipt(receipt, [2]);
  assert.equal(packet.turn, "R2P18");
  assert.equal(packet.rosterBefore.length, 1);
  assert.deepEqual(packet.candidates.map((candidate) => candidate.yahooId), ["a", "b", "c"]);
  assert.match(packet.packetId, /^[a-f0-9]{64}$/);
});

test("preserves low-to-high ADP endpoints from the exported extension board", () => {
  const [packet] = packetsFromReceipt(receipt, [2], [
    { yahooId: "a", name: "A", position: "QB", adpLow: 4, adpHigh: 1 },
    { yahooId: "b", name: "B", position: "RB", adpLow: 8, adpHigh: 3 },
    { yahooId: "c", name: "C", position: "WR", adpLow: 9, adpHigh: 4 },
  ]);
  assert.equal(packet.candidates[0].adpEarliest, 1);
  assert.equal(packet.candidates[0].adpLatest, 4);
});

test("rejects stale, duplicate, unavailable, and undersized ballots", () => {
  const [packet] = packetsFromReceipt(receipt);
  assert.equal(validateBallot(packet, { packetId: "old", rankedYahooIds: ["a", "b", "c"] }).reason, "packet_mismatch");
  assert.equal(validateBallot(packet, { packetId: packet.packetId, rankedYahooIds: ["a", "a", "c"] }).reason, "duplicate_target");
  assert.equal(validateBallot(packet, { packetId: packet.packetId, rankedYahooIds: ["a", "b", "x"] }).reason, "unavailable_target");
  assert.equal(validateBallot(packet, { packetId: packet.packetId, rankedYahooIds: ["a", "b"] }).reason, "incomplete_target_ranking");
});

test("uses deterministic consensus only when both ballots beat the deadline", () => {
  const [packet] = packetsFromReceipt(receipt);
  const codex = { packetId: packet.packetId, rankedYahooIds: ["b", "a", "c"] };
  const fable = { packetId: packet.packetId, rankedYahooIds: ["a", "b", "c"] };
  const merged = mergeBallots(packet, codex, fable, {
    deadlineMs: 10_000,
    codexElapsedMs: 4_000,
    fableElapsedMs: 5_000,
  });
  assert.equal(merged.source, "committee");
  assert.equal(merged.rankedYahooIds[0], "a");
  const late = mergeBallots(packet, codex, { ...fable, elapsedMs: 1 }, {
    deadlineMs: 10_000,
    codexElapsedMs: 4_000,
    fableElapsedMs: 10_001,
  });
  assert.equal(late.source, "baseline");
  assert.equal(late.reason, "committee_deadline_missed");
  assert.equal(mergeBallots(packet, codex, fable, { deadlineMs: 10_000 }).reason, "invalid_latency");
});
