import test from "node:test";
import assert from "node:assert/strict";

import { FREE_SOURCE_REGISTRY, validateSourceSnapshot } from "./free-source-registry.mjs";

test("registry contains only zero-cost declared sources", () => {
  assert.ok(FREE_SOURCE_REGISTRY.length >= 4);
  assert.ok(FREE_SOURCE_REGISTRY.every((source) => source.cost.toLowerCase().includes("free")));
});

test("source snapshots require a provenance manifest and report freshness", () => {
  const manifest = (sourceId, sourceFamily, sourceAsOf) => ({
    sourceId, sourceFamily, sourceAsOf, retrievedAt: sourceAsOf, snapshotId: `${sourceId}-test`,
    contentSha256: "a".repeat(64), gamesBasis: "test", projectionPeriod: "2026", licenseUseNote: "test",
  });
  const result = validateSourceSnapshot(
    [
      manifest("yahoo", "yahoo", "2026-08-22T10:00:00Z"),
      manifest("nflverse", "nflverse", "2026-08-01T10:00:00Z"),
    ],
    "2026-08-22T12:00:00Z",
  );
  assert.equal(result[0].fresh, true);
  assert.equal(result[1].fresh, false);
});
