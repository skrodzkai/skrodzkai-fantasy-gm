import assert from "node:assert/strict";
import test from "node:test";

import { replayCapturedDraft, snakePicks } from "./captured-draft-replay.mjs";

test("reproduces slot-three snake timing", () => {
  assert.deepEqual(snakePicks({ teams: 12, seat: 3, rounds: 4 }), [3, 22, 27, 46]);
});

test("fails closed unless every captured-session contract is present", () => {
  const picks = snakePicks({ teams: 12, seat: 3, rounds: 19 });
  const table = picks.map((pick, index) => `| ${index + 1} | ${pick} | Player |`).join("\n");
  const required = "75-second clock generic `D` selection must precede every LB/CB/S selection owner intervened at the final moment No clean automated-draft claim is valid";
  const pass = replayCapturedDraft({ uiMap: { location: { pathname: "/draftclient/f1/18599/12" } }, postmortem: `${table}\n${required}`, decisionBudgetSeconds: 30 });
  assert.equal(pass.status, "PASS");
  assert.equal(pass.liveAutomationProven, false);
  assert.equal(pass.latencyMeasured, false);
  assert.equal(replayCapturedDraft({ uiMap: {}, postmortem: "", decisionBudgetSeconds: 30 }).status, "FAIL");
});
