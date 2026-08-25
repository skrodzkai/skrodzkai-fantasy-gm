import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildRehearsalReport } from "./run-v5-rehearsals.mjs";

const boardSource = await readFile(new URL("../extension/yahoo-mock-board.js", import.meta.url), "utf8");
const runnerSource = await readFile(new URL("../controller/yahoo-mock-runner.js", import.meta.url), "utf8");

test("rehearses the real league shape in every snake seat without enabling execution", () => {
  const report = buildRehearsalReport({ boardSource, runnerSource, generatedAt: "2026-08-23T00:00:00Z" });
  assert.equal(report.simulations, 60);
  assert.equal(report.validRosters, 60);
  assert.equal(report.accepted, true);
  assert.equal(Object.values(report.acceptanceGates).every(Boolean), true, JSON.stringify({ acceptanceGates: report.acceptanceGates, latency: report.latency }));
  assert.equal(report.rehearsals.validReference, true);
  assert.equal(report.latency.recomputeP95Ms < 100, true);
  assert.equal(Number.isInteger(report.latency.fallbackCount), true);
  assert.equal(report.latency.fallbackContract, "static verified value order");
  assert.equal(Object.values(report.policyChecks).every(Boolean), true);
  assert.equal(Object.values(report.rehearsals.chaos).every((scenario) => scenario.pass), true);
  assert.equal(report.teams.every((team) => team.picks.length === 19), true);
  assert.equal(report.teams.every((team) => team.specialistUnavailableCount > 0), true);
  assert.equal(new Set(report.teams.flatMap((team) => team.picks.map((pick) => `${team.simulationId}:${pick.yahooId}`))).size, 1140);
});
