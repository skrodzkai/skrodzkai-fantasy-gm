import test from "node:test";
import assert from "node:assert/strict";

import { FREE_SOURCE_REGISTRY, validateSourceSnapshot } from "./free-source-registry.mjs";

test("registry contains only zero-cost declared sources", () => {
  assert.ok(FREE_SOURCE_REGISTRY.length >= 4);
  assert.ok(FREE_SOURCE_REGISTRY.every((source) => source.cost.toLowerCase().includes("free")));
});

test("source snapshots report freshness without silently substituting a fallback", () => {
  const result = validateSourceSnapshot(
    [
      { sourceId: "yahoo", observedAt: "2026-08-22T10:00:00Z" },
      { sourceId: "nflverse", observedAt: "2026-08-01T10:00:00Z" },
    ],
    "2026-08-22T12:00:00Z",
  );
  assert.equal(result[0].fresh, true);
  assert.equal(result[1].fresh, false);
});
