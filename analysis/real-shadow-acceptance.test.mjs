import assert from "node:assert/strict";
import test from "node:test";

import { loadDecisionEngine, runRealShadowAcceptance } from "./real-shadow-acceptance.mjs";

const engine = await loadDecisionEngine(new URL("../controller/yahoo-mock-runner.js", import.meta.url));

function candidate(position, index, rank) {
  const eligible = position === "LB" ? ["LB", "D"] : position === "CB" ? ["CB", "DB", "D"] : position === "S" ? ["S", "DB", "D"] : [position];
  return {
    yahooId:`${position}-${index}`, name:`${position} ${index}`, position, team:"TST", rank,
    projection:1000 - rank, replacementPoints:40, eligible,
    automaticEligible:true, manualEligible:true, validationStatus:"EXECUTABLE",
  };
}

function boardData() {
  let rank = 1;
  const players = [];
  for (const position of ["QB", "RB", "WR", "TE", "K", "DEF", "D", "LB", "CB", "S"]) {
    const total = ["QB", "RB", "WR", "TE"].includes(position) ? 120 : 48;
    for (let index = 1; index <= total; index += 1) players.push(candidate(position, index, rank++));
  }
  return { players, replacementBySlot:{ QB:100, RB:80, WR:80, TE:70, "W/R/T":80, K:30, DEF:30, D:25, DB:25, LB:25 } };
}

test("passes isolated 19-round real-roster decision stress at snake seats 1, 6, and 12", () => {
  assert.deepEqual([...engine.decision.IDP_POSITIONS], ["D", "LB", "CB", "S"]);
  const result = runRealShadowAcceptance({ engine, boardData:boardData(), settingsSnapshot:{ ready:true }, decisionBudgetMs:2_000 });
  assert.equal(result.status, "PASS");
  assert.equal(result.execution, false);
  assert.equal(result.clockSeconds, 30);
  assert.deepEqual(result.seats.map((seat) => seat.decisions), [19, 19, 19]);
  assert.ok(result.seats.every((seat) => seat.idpCount <= 3 && (seat.counts.K ?? 0) <= 1 && (seat.counts.DEF ?? 0) <= 1));
  assert.ok(result.seats.every((seat) => seat.attachChecks.every((check) => check.pass)));
});

test("refuses acceptance without verified real settings", () => {
  assert.throws(() => runRealShadowAcceptance({ engine, boardData:boardData(), settingsSnapshot:{ ready:false } }), /settings must be verified/);
});
