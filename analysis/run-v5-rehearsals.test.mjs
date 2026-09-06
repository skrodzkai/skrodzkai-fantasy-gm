import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildRehearsalReport, chooseOpponentPlayer, loadRuntime, replayRunnerLoop } from "./run-v5-rehearsals.mjs";

const boardSource = await readFile(new URL("../extension/yahoo-mock-board.js", import.meta.url), "utf8");
const runnerSource = await readFile(new URL("../controller/yahoo-mock-runner.js", import.meta.url), "utf8");

test("opponents can select our manual-only stars but obey their own roster completion", () => {
  const { runner } = loadRuntime(boardSource, runnerSource);
  const config = { ...runner.configs.public_mock_15, rounds:2, rosterSlots:["QB", "WR"], positionLimits:{QB:2,WR:2} };
  const make = (id, position, automaticEligible) => ({ yahooId:id, name:`Player ${id}`, team:"BUF", position, eligible:[position], rank:Number(id), projection:100, manualEligible:true, automaticEligible });
  const [qb, manual, wr] = runner.decision.validateBoard([make("1","QB",true), make("2","QB",false), make("3","WR",true)]);
  assert.equal(chooseOpponentPlayer({ marketOrder:[manual, qb, wr], drafted:[], picks:[], config, helpers:runner._test }).yahooId, manual.yahooId);
  assert.equal(chooseOpponentPlayer({ marketOrder:[manual, wr], drafted:[qb], picks:[qb], config, helpers:runner._test }).yahooId, wr.yahooId);
  const ourDecision = runner.decision.buildDecisionLadder({ round:1, seat:1, picks:[], board:[manual, qb, wr], availablePlayers:[manual, qb, wr], config, minimum:1 });
  assert.ok(ourDecision.targets.every((p) => p.yahooId !== manual.yahooId));
});

test("current bundled board completes the 30-second rehearsal with two fresh families", () => {
  const report = buildRehearsalReport({ boardSource, runnerSource, generatedAt: "2026-08-27T03:37:20Z" });
  assert.equal(report.accepted, true);
  assert.equal(report.policyChecks.realLeagueExecutionDisabled, true);
  assert.equal(report.policyChecks.scoringSchemaReceipted, true);
  assert.equal(report.policyChecks.minimumThreeRunningBacks, true);
  assert.equal(report.policyChecks.rosterConstructionVaries, true);
  assert.equal(report.policyChecks.thirdTightEndNotDeterministic, true);
  assert.equal(report.policyChecks.opponentRostersValid, true);
  assert.ok(report.teams.every((team) => team.opponents.length === 11 && team.opponents.every((opponent) => opponent.validRoster && opponent.picks.length === 19)));
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
