import test from "node:test";
import assert from "node:assert/strict";

import { buildDraftWatchlist, compileInjuryBoard } from "./injury-monitor.mjs";

function report(overrides = {}) {
  return {
    playerId: "p1",
    sourceId: "source",
    sourceKind: "yahoo",
    observedAt: "2026-08-23T10:00:00Z",
    status: "UNKNOWN",
    ...overrides,
  };
}

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

test("holdout and role uncertainty stay on the compact manual watchlist", () => {
  const board = compileInjuryBoard({
    asOf: "2026-08-23T12:00:00Z",
    reports: [
      report({ playerId: "h", sourceId: "holdout", status: "CONTRACT_HOLDOUT" }),
      report({ playerId: "r", sourceId: "role", status: "ROLE_RISK" }),
      report({ playerId: "c", sourceId: "clear", status: "CLEAR" }),
    ],
  });
  assert.equal(board.players.find((player) => player.playerId === "h").draftAction, "REVIEW");
  assert.equal(board.players.find((player) => player.playerId === "r").draftAction, "REVIEW");
  assert.deepEqual(buildDraftWatchlist(board).map((player) => player.yahooId).sort(), ["h", "r"]);
});

test("a suspension needs a reported return to avoid automatic exclusion", () => {
  const missingReturn = compileInjuryBoard({
    asOf: "2026-08-23T12:00:00Z",
    reports: [report({ playerId: "s", sourceId: "suspension", status: "SUSPENSION" })],
  });
  assert.equal(missingReturn.players[0].draftAction, "EXCLUDE");
  const datedReturn = compileInjuryBoard({
    asOf: "2026-08-23T12:00:00Z",
    reports: [report({ playerId: "s", sourceId: "suspension", status: "SUSPENDED", reportedReturn: "Week 3" })],
  });
  assert.equal(datedReturn.players[0].draftAction, "REVIEW");
  assert.deepEqual(datedReturn.players[0].reportedReturns, ["Week 3"]);
});
