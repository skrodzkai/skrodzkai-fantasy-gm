import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { SCORING_SCHEMA_HASH } from "./build-v5-board.mjs";
import { boardMovers, buildHealth, byeCoverage, discoverPreviousPassingBoard, fetchEspnClayPdf, joinEspnRowsToYahoo, loadOrFetchSleeper, publishSuccessfulRun, refreshDraftPrep, renderBoardMovementMarkdown, writeSleeperCache } from "./refresh-draft-prep.mjs";

function response(bytes, headers = {}) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: true,
    status: 200,
    headers: { get: (key) => normalized.get(String(key).toLowerCase()) ?? null },
    arrayBuffer: async () => bytes,
  };
}

test("fetches the ESPN PDF once and receipts publisher and retrieval timestamps separately", async () => {
  let calls = 0;
  const bytes = Buffer.alloc(100_001, 1);
  const result = await fetchEspnClayPdf({
    retrievedAt: "2026-08-26T20:00:00Z",
    fetchImpl: async () => {
      calls += 1;
      return response(bytes, { "content-type": "application/pdf", "last-modified": "Wed, 26 Aug 2026 17:30:59 GMT", etag: "test" });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.sourceAsOf, "2026-08-26T17:30:59.000Z");
  assert.equal(result.retrievedAt, "2026-08-26T20:00:00.000Z");
  assert.equal(result.etag, "test");
});

test("joins through deterministic exact and unique suffixless identities only", () => {
  const joined = joinEspnRowsToYahoo({
    rows: [
      { name: "James Cook", team: "BUF", position: "RB" },
      { name: "Quarter Back", team: "JAC", position: "QB" },
      { name: "Same Name", team: "NYJ", position: "WR" },
      { name: "Yahoo Only", team: "DAL", position: "TE" },
    ],
    sleeperPlayers: {
      one: { yahoo_id: "1", full_name: "James Cook III", team: "BUF" },
      two: { yahoo_id: "2", full_name: "Quarter Back", team: "JAX" },
      three: { yahoo_id: "3", full_name: "Same Name", team: "NYJ" },
      four: { yahoo_id: "4", full_name: "Same Name", team: "NYJ" },
    },
    baselineRows: [],
    yahooRows: [{ yahooId: "5", name: "Yahoo Only", team: "DAL" }],
  });
  assert.deepEqual(joined.rows.map((row) => row.playerId ?? null), ["1", "2", null, "5"]);
  assert.equal(joined.receipt.fuzzyMatching, false);
  assert.ok(joined.receipt.ambiguousExactKeys >= 1);
});

test("reuses a current Sleeper cache without a second request", async () => {
  const root = await mkdtemp(join(tmpdir(), "sleeper-cache-test-"));
  const cachePath = join(root, "sleeper.json");
  await writeFile(cachePath, JSON.stringify({
    manifest: { sourceId: "sleeper", retrievedAt: "2026-08-26T10:00:00Z" },
    players: { one: { full_name: "Player" } },
  }));
  const result = await loadOrFetchSleeper({
    cachePath,
    retrievedAt: "2026-08-26T20:00:00Z",
    fetchImpl: async () => { throw new Error("unexpected fetch"); },
  });
  assert.equal(result.reused, true);
});

test("writes a fetched Sleeper snapshot back to the daily cache atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "sleeper-cache-write-test-"));
  const cachePath = join(root, "sleeper.json");
  const snapshot = { manifest: { sourceId: "sleeper", retrievedAt: "2026-08-26T20:00:00Z" }, players: { one: { full_name: "Player" } } };
  assert.equal(await writeSleeperCache(cachePath, snapshot), true);
  assert.deepEqual(JSON.parse(await readFile(cachePath, "utf8")), snapshot);
  assert.deepEqual(await readdir(root), ["sleeper.json"]);
});

test("discovers only the newest prior PASS board and reports rank, projection, injury, eligibility, and bye movement", async () => {
  const root = await mkdtemp(join(tmpdir(), "draft-prep-v14-prior-test-"));
  const failed = join(root, "draft-prep-v14-20260828T120000000Z");
  const passed = join(root, "draft-prep-v13-20260828T110000000Z");
  await Promise.all([mkdir(failed), mkdir(passed)]);
  await Promise.all([
    writeFile(join(failed, "nightly-health.json"), JSON.stringify({ status:"FAIL" })),
    writeFile(join(failed, "player-board-v14.json"), JSON.stringify({ players:[{ yahooId:"bad" }] })),
    writeFile(join(passed, "nightly-health.json"), JSON.stringify({ status:"PASS", generatedAt:"2026-08-28T11:00:00Z" })),
    writeFile(join(passed, "player-board-v13.json"), JSON.stringify({ players:[{ yahooId:"1", name:"Player", position:"RB", overallRank:10, consensusPoints:200, bye:7, automaticEligible:true, manualEligible:true, validationStatus:"EXECUTABLE", injury:{ status:"CLEAR", draftAction:"CLEAR" } }] })),
  ]);
  const prior = await discoverPreviousPassingBoard(root);
  assert.match(prior.receipt.boardPath, /player-board-v13\.json$/);
  const board = { generatedAt:"2026-08-28T12:00:00Z", injuryWatchlist:[{ yahooId:"1", status:"QUESTIONABLE", draftAction:"REVIEW", primarySourceId:"team-report" }], players:[{ yahooId:"1", name:"Player", position:"RB", overallRank:7, consensusPoints:210, bye:8, automaticEligible:false, manualEligible:true, validationStatus:"INJURY_REVIEW", injury:{ status:"QUESTIONABLE", draftAction:"REVIEW" } }] };
  const movement = boardMovers(board, prior.board, prior.receipt);
  assert.equal(movement.changedPlayers, 1);
  assert.equal(movement.changes[0].rankDelta, 3);
  assert.equal(movement.changes[0].projectionDelta, 10);
  assert.equal(movement.changes[0].before.draftAction, "CLEAR");
  assert.equal(movement.changes[0].after.bye, 8);
  const markdown = renderBoardMovementMarkdown(board, movement);
  assert.match(markdown, /CLEAR → REVIEW/);
  assert.match(markdown, /\| Player \| QUESTIONABLE \| REVIEW \| team-report \|/);
});

test("publishes the complete v14 artifact set with one atomic rename", async () => {
  const root = await mkdtemp(join(tmpdir(), "draft-prep-v13-publish-test-"));
  const staging = await mkdtemp(join(root, ".staging-"));
  await mkdir(join(staging, "source-snapshots"));
  await writeFile(join(staging, "source-snapshots", "source.json"), "{}\n");
  const finalPath = join(root, "final");
  await publishSuccessfulRun({
    staging,
    finalPath,
    board: { players: [] },
    extensionSource: "globalThis.board = {};\n",
    offlineBoardCsv: "value_rank,name\n1,Player\n",
    readiness: { status: "PASS" },
    rehearsal: { accepted: true },
    packets: { packets: Array.from({ length: 12 }) },
    opponentWarRoom: { cards:Array.from({ length:11 }) },
    movementMarkdown: "# movement\n",
    realShadowAcceptance: { status:"PASS" },
    health: { status: "PASS" },
  });
  assert.deepEqual((await readdir(finalPath)).sort(), [
    "board-movement-v14.md",
    "draft-readiness-v14.json",
    "nightly-health.json",
    "opponent-war-room-v14.json",
    "player-board-v14.json",
    "real-shadow-acceptance-v14.json",
    "rehearsal-30s-v14.json",
    "source-snapshots",
    "yahoo-mock-board-v14.csv",
    "yahoo-mock-board-v14.js",
  ]);
  await assert.rejects(() => readdir(staging), { code: "ENOENT" });
});

test("health reasons fail closed on eligible-player injury or bye gaps", () => {
  const players = [
    { yahooId:"1", position:"QB", automaticEligible:true, manualEligible:true, bye:7 },
    { yahooId:"2", position:"DEF", automaticEligible:true, manualEligible:true, bye:null },
    { yahooId:"3", position:"WR", automaticEligible:false, manualEligible:false, bye:null },
  ];
  assert.deepEqual(byeCoverage(players), {
    complete:false, playersWithBye:1, playersTotal:2, denominator:"automatic-or-manual-eligible players, including DEF",
  });
  const health = buildHealth({
    generatedAt:"2026-08-27T18:00:00Z",
    clock:{ fresh:true },
    board:{ players, injuryCoverage:{ complete:false } },
  });
  assert.equal(health.status, "FAIL");
  assert.ok(health.reasons.includes("injury_coverage_incomplete"));
  assert.ok(health.reasons.includes("bye_coverage_incomplete"));
  assert.equal(health.byes.playersTotal, 2);
});

test("stale caller-supplied Yahoo inputs publish a health-only failure atomically", async () => {
  const now = new Date();
  const allowedRoot = await mkdtemp(join(tmpdir(), "draft-prep-v13-test-"));
  const outputParent = join(allowedRoot, "runs");
  await mkdir(outputParent);
  const writeJson = async (name, value) => {
    const path = join(allowedRoot, name);
    await writeFile(path, JSON.stringify(value));
    return path;
  };
  const baselinePath = await writeJson("baseline.json", []);
  const stale = {
    leagueId: "420010",
    scoringModel: "2-minute-drillers-2026",
    scoringSchemaHash: SCORING_SCHEMA_HASH,
    observedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000).toISOString(),
    players: [],
    positions: {},
  };
  const yahooOffensePath = await writeJson("offense.json", stale);
  const yahooSpecialistsPath = await writeJson("specialists.json", stale);
  const yahooEligibilityPath = await writeJson("eligibility.json", stale);
  const historyPath = join(allowedRoot, "history.csv");
  const calibrationPath = await writeJson("calibration.json", {});
  const runnerPath = join(allowedRoot, "runner.js");
  await Promise.all([writeFile(historyPath, ""), writeFile(runnerPath, "")]);
  await assert.rejects(() => refreshDraftPrep({
    generatedAt: now.toISOString(),
    outputParent,
    allowedOutputRoot: allowedRoot,
    baselinePath,
    yahooOffensePath,
    yahooSpecialistsPath,
    yahooEligibilityPath,
    historyPath,
    opponentCalibrationPath: calibrationPath,
    runnerPath,
    fetchImpl: async () => { throw new Error("unexpected fetch"); },
  }), /caller-supplied Yahoo snapshots are stale/);
  const runs = await readdir(outputParent);
  assert.equal(runs.length, 1);
  const files = await readdir(join(outputParent, runs[0]));
  assert.deepEqual(files, ["nightly-health.json"]);
  const health = JSON.parse(await readFile(join(outputParent, runs[0], "nightly-health.json"), "utf8"));
  assert.equal(health.status, "FAIL");
  assert.match(health.reasons[0], /caller-supplied Yahoo snapshots are stale/);
});

test("a caller-supplied generatedAt cannot make old evidence look current", async () => {
  const allowedRoot = await mkdtemp(join(tmpdir(), "draft-prep-v13-clock-test-"));
  const outputParent = join(allowedRoot, "runs");
  await mkdir(outputParent);
  await assert.rejects(() => refreshDraftPrep({
    generatedAt: "2026-08-20T00:00:00Z",
    outputParent,
    allowedOutputRoot: allowedRoot,
  }), /differs from wall clock/);
  const [run] = await readdir(outputParent);
  const health = JSON.parse(await readFile(join(outputParent, run, "nightly-health.json"), "utf8"));
  assert.equal(health.status, "FAIL");
  assert.equal(health.clock.fresh, false);
  assert.ok(Math.abs(health.clock.generatedAtSkewMinutes) > 15);
});

test("Yahoo projections must declare the real league and scoring schema", async () => {
  const generatedAt = new Date().toISOString();
  const allowedRoot = await mkdtemp(join(tmpdir(), "draft-prep-v13-yahoo-receipt-test-"));
  const outputParent = join(allowedRoot, "runs");
  await mkdir(outputParent);
  const writeJson = async (name, value) => {
    const path = join(allowedRoot, name);
    await writeFile(path, JSON.stringify(value));
    return path;
  };
  const wrongLeague = { leagueId: "18599", scoringModel: "test", scoringSchemaHash: "0".repeat(64), observedAt: generatedAt };
  const shared = {
    generatedAt,
    outputParent,
    allowedOutputRoot: allowedRoot,
    baselinePath: await writeJson("baseline.json", []),
    yahooOffensePath: await writeJson("offense.json", wrongLeague),
    yahooSpecialistsPath: await writeJson("specialists.json", wrongLeague),
    yahooEligibilityPath: await writeJson("eligibility.json", wrongLeague),
    historyPath: join(allowedRoot, "history.csv"),
    opponentCalibrationPath: await writeJson("calibration.json", {}),
    runnerPath: join(allowedRoot, "runner.js"),
  };
  await Promise.all([writeFile(shared.historyPath, ""), writeFile(shared.runnerPath, "")]);
  await assert.rejects(() => refreshDraftPrep(shared), /must declare Yahoo league 420010/);
});

test("a short parsed ESPN snapshot leaves only a health receipt", async () => {
  const generatedAt = new Date().toISOString();
  const allowedRoot = await mkdtemp(join(tmpdir(), "draft-prep-v13-coverage-test-"));
  const outputParent = join(allowedRoot, "runs");
  await mkdir(outputParent);
  const writeJson = async (name, value) => {
    const path = join(allowedRoot, name);
    await writeFile(path, JSON.stringify(value));
    return path;
  };
  const yahoo = {
    leagueId: "420010",
    scoringModel: "2-minute-drillers-2026",
    scoringSchemaHash: SCORING_SCHEMA_HASH,
    observedAt: generatedAt,
    players: [],
    positions: {},
  };
  const historyPath = join(allowedRoot, "history.csv");
  const runnerPath = join(allowedRoot, "runner.js");
  const baselinePath = await writeJson("baseline.json", []);
  const yahooOffensePath = await writeJson("offense.json", yahoo);
  const yahooSpecialistsPath = await writeJson("specialists.json", yahoo);
  const yahooEligibilityPath = await writeJson("eligibility.json", yahoo);
  const opponentCalibrationPath = await writeJson("calibration.json", {});
  await Promise.all([writeFile(historyPath, ""), writeFile(runnerPath, "")]);
  await assert.rejects(() => refreshDraftPrep({
    generatedAt,
    outputParent,
    allowedOutputRoot: allowedRoot,
    baselinePath,
    yahooOffensePath,
    yahooSpecialistsPath,
    yahooEligibilityPath,
    historyPath,
    opponentCalibrationPath,
    runnerPath,
    fetchImpl: async () => response(Buffer.alloc(100_001, 1), { "content-type": "application/pdf", "last-modified": new Date(Date.parse(generatedAt) - 60_000).toUTCString() }),
    extractPdf: async () => ({
      text: "Quarterback Projections\nQuarterback Team Pos Rk FF Pt G P Att Comp P Yds P TD INT Sk Carry Ru Yds Ru TD\nJosh Allen BUF 1 369 17 509 340 3946 26 12 36 116 580 12",
      receipt: { command: "pdftotext -layout", version: "test", textSha256: "b".repeat(64) },
    }),
  }), /ESPN coverage incomplete/);
  const [run] = await readdir(outputParent);
  assert.deepEqual(await readdir(join(outputParent, run)), ["nightly-health.json"]);
});

test("refresh command has no static import path to Yahoo execution modules", async () => {
  const source = await readFile(new URL("./refresh-draft-prep.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("../controller/"), false);
  assert.equal(source.includes("../extension/"), false);
  assert.equal(source.includes("options.now"), false);
});
