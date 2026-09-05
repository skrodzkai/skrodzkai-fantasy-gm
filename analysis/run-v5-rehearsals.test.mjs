import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildRehearsalReport, loadRuntime, replayRunnerLoop } from "./run-v5-rehearsals.mjs";

const boardSource = await readFile(new URL("../extension/yahoo-mock-board.js", import.meta.url), "utf8");
const runnerSource = await readFile(new URL("../controller/yahoo-mock-runner.js", import.meta.url), "utf8");

test("current bundled board completes the 30-second rehearsal with two fresh families", () => {
  const report = buildRehearsalReport({ boardSource, runnerSource, generatedAt: "2026-08-27T03:37:20Z" });
  assert.equal(report.accepted, true);
  assert.equal(report.policyChecks.realLeagueExecutionDisabled, true);
  assert.equal(report.policyChecks.scoringSchemaReceipted, true);
  assert.equal(report.policyChecks.minimumThreeRunningBacks, true);
  assert.equal(report.policyChecks.rosterConstructionVaries, true);
  assert.equal(report.policyChecks.thirdTightEndNotDeterministic, true);
  assert.ok(report.latency.recomputeMaxMs < report.latency.ownedTurnBudgetMs);
});

test("offline runtime exposes no browser or network globals and receipts runner hash", () => {
  const runtime = loadRuntime(boardSource, runnerSource);
  assert.deepEqual(runtime.forbiddenVmGlobals, []);
  assert.match(runtime.runnerSourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(runtime.runner.configs.real_league_19_idp.qualification, "unverified-real-room");
});

test("offline runner-loop cannot promote a REAL board into TEST-scored execution", async () => {
  const replay = await replayRunnerLoop({ boardSource, runnerSource, seat: 6 });
  assert.equal(replay.evidenceClass, "OFFLINE_RUNNER_LOOP_REPLAY");
  assert.equal(replay.yahooLiveDraft, false);
  assert.equal(replay.yahooTestLeagueCleanAutomationPass, false);
  assert.equal(replay.accepted, false);
  assert.equal(replay.status, "LOCKED");
  assert.equal(replay.failure, "test_board_scoring_identity_mismatch");
  assert.equal(replay.completion, null);
});
