import assert from "node:assert/strict";
import test from "node:test";

import {
  estimatePositionPressure,
  overallPick,
  pickCoordinates,
  turnsBeforeNextPick,
} from "./opponent-window.mjs";

test("maps snake picks in both directions", () => {
  assert.equal(overallPick(1, 12), 12);
  assert.equal(overallPick(2, 12), 13);
  assert.equal(overallPick(2, 1), 24);
  assert.deepEqual(pickCoordinates(13), { overall: 13, round: 2, seat: 12 });
  assert.deepEqual(pickCoordinates(24), { overall: 24, round: 2, seat: 1 });
});

test("finds exact opponent windows for endpoint and middle seats", () => {
  assert.equal(turnsBeforeNextPick({ round: 1, ourSeat: 1 }).length, 22);
  assert.equal(turnsBeforeNextPick({ round: 1, ourSeat: 6 }).length, 12);
  assert.equal(turnsBeforeNextPick({ round: 1, ourSeat: 12 }).length, 0);
  assert.equal(turnsBeforeNextPick({ round: 2, ourSeat: 12 }).length, 22);
  assert.deepEqual(turnsBeforeNextPick({ round: 19, ourSeat: 6, rounds: 19 }), []);
});

test("uses a held-out-cleared manager profile and receipts room fallbacks", () => {
  const probabilities = { QB: 0.1, RB: 0.5, WR: 0.4, TE: 0, K: 0, DEF: 0, LB: 0, DB: 0, DL: 0 };
  const calibration = {
    room: { opening: probabilities },
    profiles: { "owner-a": { opening: { ...probabilities, QB: 0.5, RB: 0.1 } } },
  };
  const result = estimatePositionPressure({
    turns: [
      { overall: 2, round: 1, seat: 2, managerId: "alpha" },
      { overall: 3, round: 1, seat: 3 },
    ],
    calibration,
    managerMap: { alpha: "owner-a" },
  });
  assert.equal(result.coverage.profileTurns, 1);
  assert.equal(result.coverage.roomFallbackTurns, 1);
  assert.equal(result.positions.RB.expectedPicks, 0.6);
  assert.equal(result.positions.RB.probabilityAtLeastOne, 0.55);
  assert.equal(result.turns[0].profileId, "owner-a");
});
