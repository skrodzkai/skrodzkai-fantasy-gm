import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildRehearsalReport } from "./run-v5-rehearsals.mjs";

const boardSource = await readFile(new URL("../extension/yahoo-mock-board.js", import.meta.url), "utf8");
const runnerSource = await readFile(new URL("../controller/yahoo-mock-runner.js", import.meta.url), "utf8");

test("current bundled board fails closed while offense lacks two fresh families", () => {
  assert.throws(
    () => buildRehearsalReport({ boardSource, runnerSource, generatedAt: "2026-08-25T23:40:00Z" }),
    /no_legal_bpa_candidates/,
  );
});
