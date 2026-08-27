import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildSnakeSeatPackets } from "./build-snake-seat-packets.mjs";

const room = Object.fromEntries(["opening", "core", "bench", "specialists"].map((phase) => [phase, {
  QB: 0.1, RB: 0.3, WR: 0.3, TE: 0.1, K: 0.05, DEF: 0.05, LB: 0.04, DB: 0.03, DL: 0.03,
}]));
const teams = Array.from({ length: 12 }, (_, seatIndex) => Array.from({ length: 2 }, (_, seedIndex) => ({
  simulationId: `seat-${seatIndex + 1}-seed-${seedIndex}`,
  seat: seatIndex + 1,
  seed: seedIndex,
  picks: Array.from({ length: 19 }, (_, roundIndex) => ({
    round: roundIndex + 1,
    position: roundIndex % 2 ? "WR" : "RB",
    ladder: Array.from({ length: 8 }, (_, targetIndex) => ({
      yahooId: `${roundIndex + 1}-${targetIndex + 1}`,
      name: `Player ${roundIndex + 1}-${targetIndex + 1}`,
      position: targetIndex % 2 ? "WR" : "RB",
      decisionScore: 100 - targetIndex,
      pAvailableNext: 0.5,
    })),
  })),
}))).flat();

test("builds 12 non-executable templates with bounded exact suggestions", () => {
  const result = buildSnakeSeatPackets({
    rehearsal: { accepted: true, teams },
    board: { players: [{ yahooId: "1-1", bye: 7, injury: { status: "CLEAR", draftAction: "CLEAR" }, sourceFamilies: ["yahoo", "espn-clay"], omittedScoringCategories: ["returnYards"] }] },
    opponentCalibration: { calibration: { enabled: true }, room, profiles: {} },
    generatedAt: "2026-08-26T20:00:00Z",
  });
  assert.equal(result.packets.length, 12);
  assert.equal(result.executionInput, false);
  assert.equal(result.packets[0].turns.length, 19);
  assert.equal(result.packets[0].turns[0].overallPick, 1);
  assert.equal(result.packets[11].turns[1].overallPick, 13);
  assert.equal(result.packets[0].turns[0].exactSuggestions.topThree.length, 3);
  assert.equal(result.packets[0].turns[3].exactSuggestions, null);
  assert.equal(result.packets[0].turns[0].exactSuggestions.topThree[0].bye, 7);
  assert.equal(result.packets.every((packet) => packet.managerBinding === null), true);
});

test("packet builder has no static path to Yahoo execution modules", async () => {
  const source = await readFile(new URL("./build-snake-seat-packets.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("../controller/"), false);
  assert.equal(source.includes("../extension/"), false);
  assert.equal(source.includes("420010"), false);
});
