import test from "node:test";
import assert from "node:assert/strict";

import { FREE_SOURCE_REGISTRY, validateSourceSnapshot } from "./free-source-registry.mjs";

test("registry contains only zero-cost declared sources", () => {
  assert.ok(FREE_SOURCE_REGISTRY.length >= 4);
  assert.ok(FREE_SOURCE_REGISTRY.every((source) => ["free", "free-manual", "free-noncommercial"].includes(source.cost)));
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

test("ESPN publisher age and local retrieval cadence are independent gates", () => {
  const manifest = {
    sourceId: "espn-mike-clay", sourceFamily: "espn-clay",
    sourceAsOf: "2026-08-20T12:00:00Z", retrievedAt: "2026-08-26T10:00:00Z",
    snapshotId: "espn-test", contentSha256: "b".repeat(64), gamesBasis: "17",
    projectionPeriod: "2026", licenseUseNote: "test",
  };
  const fresh = validateSourceSnapshot([manifest], "2026-08-26T12:00:00Z")[0];
  assert.equal(fresh.sourceFresh, true);
  assert.equal(fresh.retrievalFresh, true);
  assert.equal(fresh.fresh, true);
  const staleRetrieval = validateSourceSnapshot([{ ...manifest, retrievedAt: "2026-08-25T10:00:00Z" }], "2026-08-26T12:00:00Z")[0];
  assert.equal(staleRetrieval.sourceFresh, true);
  assert.equal(staleRetrieval.retrievalFresh, false);
  assert.equal(staleRetrieval.fresh, false);
});
