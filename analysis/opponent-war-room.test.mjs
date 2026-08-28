import assert from "node:assert/strict";
import test from "node:test";

import { buildOpponentSnakeWindow, buildOpponentWarRoom } from "./opponent-war-room.mjs";

const room = { QB: 0.1, RB: 0.4, WR: 0.4, TE: 0.1, K: 0, DEF: 0, LB: 0, DB: 0, DL: 0 };
const qb = { ...room, QB: 0.5, RB: 0.2, WR: 0.2 };
const calibration = {
  calibration: { enabled: true, reason: "held_out" },
  room: { opening: room, core: room, bench: room, specialists: room },
  profiles: { "owner-a": { opening: qb, core: qb, bench: room, specialists: room } },
};

test("builds one evidence-bounded card per opponent and excludes Joe", () => {
  const teams = [
    { seat: 1, teamId: 1, teamName: "Alpha", managerId: "alpha" },
    { seat: 2, teamId: 2, teamName: "SKRODZKai", managerId: "joe" },
    { seat: 3, teamId: 3, teamName: "Unknown", managerId: "new" },
  ];
  const result = buildOpponentWarRoom({
    teams,
    calibration,
    managerMap: { alpha: "owner-a" },
    historyRows: [{ managerId: "alpha" }, { managerId: "alpha" }],
  });
  assert.equal(result.cards.length, 2);
  assert.equal(result.cards[0].modelLabel, "HELD_OUT_CLEARED_MANAGER_DESCRIPTION");
  assert.equal(result.cards[0].topByPhase.opening[0].position, "QB");
  assert.equal(result.cards[0].sampleCount, 2);
  assert.equal(result.cards[0].phaseDistribution.opening.QB, 0.5);
  assert.equal(result.cards[1].modelLabel, "ROOM_PHASE_DESCRIPTION");
  assert.match(result.policy, /display-only/);
});

test("maps exact snake turns to the managers selecting before us", () => {
  const teams = Array.from({ length: 12 }, (_, index) => ({ seat: index + 1, managerId: index === 1 ? "alpha" : `m${index + 1}` }));
  const result = buildOpponentSnakeWindow({ round: 1, ourSeat: 1, teams, calibration, managerMap: { alpha: "owner-a" } });
  assert.equal(result.turns.length, 22);
  assert.equal(result.coverage.profileTurns, 2);
  assert.equal(result.coverage.roomFallbackTurns, 20);
  assert.ok(result.positions.QB.expectedPicks > 2.2);
});
