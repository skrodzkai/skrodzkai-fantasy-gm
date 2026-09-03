import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { extensionBoardFromV5, renderExtensionBoard, renderOfflineBoardCsv } from "./export-extension-board.mjs";

const controllerSource = await readFile(new URL("../controller/yahoo-mock-runner.js", import.meta.url), "utf8");

function validateWithController(players) {
  const context = { clearInterval, console, crypto, Date, Math, setInterval, setTimeout, SKRODZKaiYahooDraftController: {} };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(controllerSource, context);
  return context.SKRODZKaiYahooMockRunner._test.validateBoard(players);
}

function player(position, rank, overrides = {}) {
  return {
    yahooId: `${position}-${rank}`,
    name: `${position} ${rank}`,
    team: "TST",
    position,
    draftBoardRank: rank,
    specialistRank: rank,
    vorp: 200 - rank,
    marketAdpLow: rank + 3,
    marketAdpHigh: rank - 1,
    consensusPoints: 250 - rank,
    executable: true,
    manualEligible: true,
    sourceCount: 2,
    sourceFamilyCount: 2,
    sourceIds: ["yahoo-season-projection", "league-scored-history-market-baseline"],
    injury: { draftAction:"CLEAR", conflict:false, evidence:[{ fresh:true, sourceKind:"yahoo" }] },
    bye: 7,
    ...overrides,
  };
}

test("exports only executable offense while retaining explicitly labeled specialist uncertainty", () => {
  const offense = Array.from({ length: 101 }, (_, index) => player("RB", index + 1));
  offense[0].manualEligible = false;
  offense[1].marketAdpLow = null;
  offense.push(player("WR", 102));
  const board = extensionBoardFromV5({
    generatedAt: "2026-08-22T00:00:00Z",
    scoringModel: "test",
    injuryFreshnessPolicy: { default: 36, yahoo: 6 },
    replacementBySlot: { QB: 200, RB: 100, WR: 100, TE: 80, K: 70, DEF: 60, D: 50, DB: 45, LB: 48 },
    boards: { offense, specialists: {
      K: Array.from({ length: 12 }, (_, index) => player("K", index + 1, { sourceCount: 1, sourceFamilyCount: 1, sourceIds: ["yahoo-season-projection"] })),
      DEF: Array.from({ length: 32 }, (_, index) => player("DEF", index + 1, { sourceCount: 1, sourceFamilyCount: 1, sourceIds: ["yahoo-season-projection"] })),
      DL: [player("DL", 1)],
      LB: [player("LB", 1, {
        rankingPoints: 200,
        rankingPerGamePoints: 200 / 17,
        idpDecisionPoints: 200,
        idpModelStatus: "ACTIVE",
        idpCalibrationHash: "f".repeat(64),
        idpProfile: { status: "AVAILABLE", bucketShares: { tackleFloor: 0.8, stableDisruption: 0.15, volatileSplash: 0.05 } },
        rawWeeklyPoints: Array(17).fill(249 / 17),
        weeklyPoints: Array(17).fill(200 / 17),
        rawReplacementPoints: 100,
        rawVorp: 149,
      })],
      DB: [
        player("DB", 1, { yahooPosition: "CB" }),
        player("DB", 2, { yahooId: "WR-102", yahooPosition: "WR", eligible: ["WR", "CB", "DB", "D"] }),
        player("DB", 3, { yahooPosition: "DB", eligible: ["DB"] }),
        player("DB", 4, { yahooPosition: "S", injury: { draftAction: "BLOCK", conflict: true } }),
      ],
    } },
  });
  assert.equal(board.offense.length, 101);
  assert.equal(board.offense.some((entry) => entry.yahooId === "RB-1"), false);
  assert.equal(board.offense.some((entry) => entry.yahooId === "RB-2"), true);
  assert.equal(board.offense.find((entry) => entry.yahooId === "RB-2").adpLow, null);
  assert.equal(board.kickers[0].confidence, "YAHOO_ONLY");
  assert.equal(board.defenses.length, 32);
  assert.equal(board.idp.length, 4);
  const linebacker = board.idp.find((entry) => entry.yahooId === "LB-1");
  assert.equal(linebacker.projection, 200);
  assert.equal(linebacker.rawProjection, 249);
  assert.equal(linebacker.idpDecisionProjection, 200);
  assert.equal(linebacker.idpModelStatus, "ACTIVE");
  assert.equal(linebacker.rawWeeklyPoints.length, 17);
  assert.equal(linebacker.idpCalibrationHash, "f".repeat(64));
  assert.doesNotThrow(() => validateWithController(board.players));
  assert.equal(board.players.length > board.offense.length, true);
  assert.equal(board.players.find((entry) => entry.yahooId === "WR-102").position, "WR");
  assert.equal(board.replacementBySlot.D, 50);
  assert.deepEqual(board.injuryFreshnessPolicy, { default: 36, yahoo: 6 });
  assert.equal(board.byeCoverage.complete, true);
  assert.equal(board.injuryCoverage.complete, true);
  assert.equal(board.injuryCoverage.checkedPlayers, board.injuryCoverage.expectedPlayers);
  assert.equal(board.injuryCoverage.expectedPlayers, board.byeCoverage.playersTotal);
  assert.equal(board.byeCoverage.playersWithBye, board.byeCoverage.playersTotal);
  assert.match(board.byeCoverage.denominator, /including DEF/);
  assert.deepEqual(board.idp.slice(-2).map((entry) => entry.position), ["CB", "CB"]);
  assert.match(renderExtensionBoard(board), /SKRODZKaiYahooMockBoard/);
  assert.match(renderExtensionBoard(board), /"byeCoverage"/);
  const csv = renderOfflineBoardCsv(board);
  assert.match(csv, /^value_rank,name,team,position,eligible,projection,vor,bye,yahoo_rank,confidence,automatic_eligible,manual_eligible,validation_status,attention_required,signal_warnings/m);
  assert.match(csv, /RB 2,TST,RB/);
});

test("eligible-player injury coverage uses the bye denominator and missing evidence fails closed", () => {
  const offense = Array.from({ length: 100 }, (_, index) => player("RB", index + 1));
  offense[0].injury = null;
  const board = extensionBoardFromV5({
    generatedAt: "2026-08-27T00:00:00Z",
    boards: {
      offense,
      specialists: {
        K: Array.from({ length: 12 }, (_, index) => player("K", index + 1)),
        DEF: Array.from({ length: 32 }, (_, index) => player("DEF", index + 1)),
      },
    },
  });
  assert.equal(board.injuryCoverage.complete, false);
  assert.equal(board.injuryCoverage.expectedPlayers, board.byeCoverage.playersTotal);
  assert.equal(board.injuryCoverage.checkedPlayers, board.injuryCoverage.expectedPlayers - 1);
  assert.deepEqual(board.injuryCoverage.uncheckedPlayerIds, ["RB-1"]);
});

test("missing eligibility fields export fail closed", () => {
  const source = player("RB", 1, { automaticEligible: undefined, manualEligible: undefined, validationStatus: undefined });
  const compact = extensionBoardFromV5({
    generatedAt: "2026-08-22T00:00:00Z",
    boards: {
      offense: Array.from({ length: 100 }, (_, index) => player("RB", index + 1, index ? {} : source)),
      specialists: {
        K: Array.from({ length: 12 }, (_, index) => player("K", index + 1)),
        DEF: Array.from({ length: 32 }, (_, index) => player("DEF", index + 1)),
      },
    },
  });
  const exported = compact.offense.find((entry) => entry.yahooId === source.yahooId);
  assert.equal(exported.automaticEligible, false);
  assert.equal(exported.manualEligible, false);
  assert.equal(exported.validationStatus, "MISSING_VALIDATION_STATUS");
});
