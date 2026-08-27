import assert from "node:assert/strict";
import test from "node:test";

import { makeEspnClaySnapshot, parseEspnClayText, parseEspnClayTextWithCoverage } from "./parse-espn-clay-projections.mjs";
import { scoreOffenseStatLine } from "./player-intelligence.mjs";

// Exact excerpt shape from `pdftotext -layout` on ESPN's 2026-08-26 Mike Clay PDF.
const TEXT = `                     Quarterback Projections
    Quarterback        Team    Pos Rk FF Pt   G    P Att   Comp   P Yds   P TD   INT   Sk   Carry Ru Yds Ru TD
       Josh Allen       BUF       1    369    17   509      340   3946     26     12   36    116   580    12
          Running Back Projections (1/3)
      Running Back       Team    Pos Rk FF Pt   G    Carry   Ru Yds Ru TD Targ   Rec   Re Yd Re TD   Car%   Targ%
     Ashton Jeanty         LV       6    281    17    279     1128    7    87     65    496    2     67%     16%`;

test("parses raw offense stats and ignores ESPN fantasy-point totals", () => {
  const rows = parseEspnClayText(TEXT);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "Josh Allen");
  assert.equal(rows[0].stats.passingCompletions, 340);
  assert.equal("rushingHundredYardGames" in rows[0].stats, false);
  assert.ok(rows[0].omittedScoringCategories.includes("rushingHundredYardGames"));
  assert.equal(rows[1].stats.receptions, 65);
  assert.equal("receivingHundredYardGames" in rows[1].stats, false);
  assert.ok(rows[1].omittedScoringCategories.includes("fumblesLost"));
  assert.equal(rows[1].omittedScoringCategories.includes("passingYards"), false);
  assert.notEqual(scoreOffenseStatLine(rows[0].stats), 369);
});

test("receipts invalid numeric rows and filters zero-game projections", () => {
  const parsed = parseEspnClayTextWithCoverage(`${TEXT}\nZero Runner LV 99 0 0 0 0 0 0 0 0 0 0 0\nBroken QB BUF 2 200 17 300 200 3000 20 10 20 nope 200 3`);
  assert.equal(parsed.coverage.rejected.zeroProjectedGames, 1);
  assert.equal(parsed.coverage.rejected.invalidNumericRow, 1);
  assert.deepEqual(parsed.coverage.sections, ["QB", "RB"]);
});

test("rejects numeric rows whose stat relationships cannot be true", () => {
  const parsed = parseEspnClayTextWithCoverage(`${TEXT}\nImpossible Back LV 7 280 17 1 1000 7 10 20 496 2 67% 16%`);
  assert.equal(parsed.coverage.rejected.invalidStatRelation, 1);
  assert.equal(parsed.rows.some((row) => row.name === "Impossible Back"), false);
});

test("keeps suffix names by matching only valid NFL team codes", () => {
  const rows = parseEspnClayText(`${TEXT}\nKenneth Walker III KC 11 274 17 277 1239 9 60 48 376 2 67% 11%`);
  assert.equal(rows.at(-1).name, "Kenneth Walker III");
  assert.equal(rows.at(-1).team, "KC");
});

test("emits the strict free-source manifest and extraction receipt", () => {
  const snapshot = makeEspnClaySnapshot({
    text: TEXT,
    pdfBytes: Buffer.from("pdf"),
    sourceAsOf: "2026-08-19T17:54:25Z",
    retrievedAt: "2026-08-25T19:00:00Z",
    etag: "test-etag",
    extraction: { command: "pdftotext -layout", version: "test", textSha256: "b".repeat(64) },
  });
  assert.equal(snapshot.manifest.sourceFamily, "espn-clay");
  assert.match(snapshot.manifest.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.manifest.etag, "test-etag");
  assert.equal(snapshot.coverage.rejected.zeroProjectedGames, 0);
});
