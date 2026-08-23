import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildRehearsalReport } from "./run-v5-rehearsals.mjs";

const boardSource = await readFile(new URL("../extension/yahoo-mock-board.js", import.meta.url), "utf8");
const runnerSource = await readFile(new URL("../controller/yahoo-mock-runner.js", import.meta.url), "utf8");

test("rehearses every snake seat with valid 19-player rosters and fail-closed chaos", () => {
  const report = buildRehearsalReport({ boardSource, runnerSource, generatedAt: "2026-08-23T00:00:00Z", seeds: [2026] });
  assert.equal(report.simulations, 12);
  assert.equal(report.validRosters, 12);
  assert.equal(report.rehearsals.validReference, true);
  assert.equal(report.concentration.accepted, true);
  assert.equal(report.concentration.metrics.maxRoundConcentration <= 0.67, true);
  assert.equal(Object.values(report.rehearsals.chaos).every((scenario) => scenario.pass), true);
  assert.equal(report.teams.every((team) => team.picks.length === 19), true);
  assert.equal(report.teams.every((team) => team.specialistUnavailableCount > 0), true);
  assert.equal(new Set(report.teams.flatMap((team) => team.picks.map((pick) => `${team.simulationId}:${pick.yahooId}`))).size, 228);
});
