import test from "node:test";
import assert from "node:assert/strict";

import { compileInjuryBoard } from "./injury-monitor.mjs";

test("official fresh OUT status excludes a player", () => {
  const result = compileInjuryBoard({
    asOf: "2026-08-22T12:00:00Z",
    reports: [
      {
        playerId: "p1",
        sourceId: "nfl-week-1",
        sourceKind: "nfl_official",
        observedAt: "2026-08-22T10:00:00Z",
        status: "Out",
        bodyPart: "knee",
      },
    ],
  });
  assert.equal(result.players[0].draftAction, "EXCLUDE");
  assert.equal(result.players[0].executable, false);
});

test("material source disagreement requires manual review", () => {
  const result = compileInjuryBoard({
    asOf: "2026-08-22T12:00:00Z",
    reports: [
      {
        playerId: "p1",
        sourceId: "club",
        sourceKind: "team_official",
        observedAt: "2026-08-22T10:00:00Z",
        status: "Active",
      },
      {
        playerId: "p1",
        sourceId: "yahoo",
        sourceKind: "yahoo",
        observedAt: "2026-08-22T11:00:00Z",
        status: "Doubtful",
      },
    ],
  });
  assert.equal(result.players[0].conflict, true);
  assert.equal(result.players[0].draftAction, "REVIEW");
  assert.match(result.players[0].blockReason, /conflict/);
});

test("stale evidence cannot silently clear a player", () => {
  const result = compileInjuryBoard({
    asOf: "2026-08-22T12:00:00Z",
    reports: [
      {
        playerId: "p1",
        sourceId: "old",
        sourceKind: "sleeper",
        observedAt: "2026-08-15T12:00:00Z",
        status: "Active",
      },
    ],
  });
  assert.equal(result.players[0].draftAction, "REVIEW");
  assert.match(result.players[0].blockReason, /no fresh/);
});

test("fresh consistent active evidence clears a player", () => {
  const result = compileInjuryBoard({
    asOf: "2026-08-22T12:00:00Z",
    reports: [
      {
        playerId: "p1",
        sourceId: "nfl",
        sourceKind: "nfl_official",
        observedAt: "2026-08-22T10:00:00Z",
        status: "Full",
      },
      {
        playerId: "p1",
        sourceId: "club",
        sourceKind: "team_official",
        observedAt: "2026-08-22T09:00:00Z",
        status: "Active",
      },
    ],
  });
  assert.equal(result.players[0].draftAction, "CLEAR");
  assert.equal(result.players[0].executable, true);
});

test("fresh but unknown evidence carries an explicit manual-review reason", () => {
  const result = compileInjuryBoard({
    asOf: "2026-08-22T12:00:00Z",
    reports: [
      {
        playerId: "p1",
        sourceId: "yahoo",
        sourceKind: "yahoo",
        observedAt: "2026-08-22T10:00:00Z",
        status: "UNKNOWN",
      },
    ],
  });
  assert.equal(result.players[0].draftAction, "REVIEW");
  assert.match(result.players[0].blockReason, /UNKNOWN/);
});
