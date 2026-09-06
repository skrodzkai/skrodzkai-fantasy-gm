import assert from "node:assert/strict";
import test from "node:test";
import { parseYahooCapture } from "./yahoo-capture.mjs";

const row = {yahooId:"33994",name:"Kyler Gordon",team:"CHI",eligible:["CB"],identityComplete:true,statusText:"PUP-R",games:16,bye:5,projectedPoints:80,preseasonRank:990,actualRank:1010,rosteredPercent:0};
const capture = (changes={}) => parseYahooCapture({periodValue:"S_PS_2026",periodLabel:"Season (proj)",observedAt:"2026-09-06T01:00:00Z",rows:[row],...changes});
test("full-season capture rejects remaining games even with a misleading label", () => {
  assert.throws(() => capture({periodValue:"S_PSR_2026"}), /wrong_period/);
  assert.throws(() => capture({periodLabel:"Remaining Games (proj)"}), /wrong_period/);
});
test("complete status cells preserve PUP-R and unfamiliar markers; absent cells fail", () => {
  assert.equal(capture().players[0].injuryStatus,"PUP-R");
  for (const marker of ["UNRECOGNIZED STATUS", "PUP-R"]) assert.equal(capture({rows:[{...row,statusText:marker}]}).players[0].injuryStatus,marker);
  assert.equal(capture({rows:[{...row,statusText:""}]}).players[0].injuryStatus,null);
  for (const changes of [{statusText:undefined},{identityComplete:false}]) assert.throws(() => capture({rows:[{...row,...changes}]}),/identity_incomplete/);
});
test("actual and preseason ranks are independently observed, never substituted", () => {
  const p=capture().players[0]; assert.equal(p.yahooPreseasonRank,990); assert.equal(p.yahooActualRank,1010);
  assert.equal(capture({rows:[{...row,actualRank:"-"}]}).players[0].yahooActualRank,null);
  assert.throws(() => capture({rows:[{...row,actualRank:undefined}]}),/actual_rank/);
  assert.throws(() => capture({rows:[row,row]}),/identity_ambiguous/);
});
