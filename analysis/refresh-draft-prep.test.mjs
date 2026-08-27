import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { fetchEspnClayPdf, joinEspnRowsToYahoo, loadOrFetchSleeper, refreshDraftPrep } from "./refresh-draft-prep.mjs";

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
    ],
    sleeperPlayers: {
      one: { yahoo_id: "1", full_name: "James Cook III", team: "BUF" },
      two: { yahoo_id: "2", full_name: "Quarter Back", team: "JAX" },
      three: { yahoo_id: "3", full_name: "Same Name", team: "NYJ" },
      four: { yahoo_id: "4", full_name: "Same Name", team: "NYJ" },
    },
    baselineRows: [],
  });
  assert.deepEqual(joined.rows.map((row) => row.playerId ?? null), ["1", "2", null]);
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

test("stale caller-supplied Yahoo inputs publish a health-only failure atomically", async () => {
  const allowedRoot = await mkdtemp(join(tmpdir(), "draft-prep-v11-test-"));
  const outputParent = join(allowedRoot, "runs");
  await mkdir(outputParent);
  const writeJson = async (name, value) => {
    const path = join(allowedRoot, name);
    await writeFile(path, JSON.stringify(value));
    return path;
  };
  const baselinePath = await writeJson("baseline.json", []);
  const stale = { observedAt: "2026-08-20T00:00:00Z", players: [], positions: {} };
  const yahooOffensePath = await writeJson("offense.json", stale);
  const yahooSpecialistsPath = await writeJson("specialists.json", stale);
  const yahooEligibilityPath = await writeJson("eligibility.json", stale);
  const historyPath = join(allowedRoot, "history.csv");
  const calibrationPath = await writeJson("calibration.json", {});
  const runnerPath = join(allowedRoot, "runner.js");
  await Promise.all([writeFile(historyPath, ""), writeFile(runnerPath, "")]);
  await assert.rejects(() => refreshDraftPrep({
    generatedAt: "2026-08-26T20:00:00Z",
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

test("refresh command has no static import path to Yahoo execution modules", async () => {
  const source = await readFile(new URL("./refresh-draft-prep.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("../controller/"), false);
  assert.equal(source.includes("../extension/"), false);
});
