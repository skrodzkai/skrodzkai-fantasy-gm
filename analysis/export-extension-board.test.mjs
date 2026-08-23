import assert from "node:assert/strict";
import test from "node:test";

import { extensionBoardFromV5, renderExtensionBoard } from "./export-extension-board.mjs";

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
    sourceCount: 2,
    sourceIds: ["yahoo-season-projection", "league-scored-history-market-baseline"],
    ...overrides,
  };
}

test("exports only executable offense while retaining explicitly labeled specialist uncertainty", () => {
  const offense = Array.from({ length: 101 }, (_, index) => player("RB", index + 1));
  offense[0].executable = false;
  offense[1].marketAdpLow = null;
  offense.push(player("WR", 102));
  const board = extensionBoardFromV5({
    generatedAt: "2026-08-22T00:00:00Z",
    scoringModel: "test",
    boards: { offense, specialists: {
      K: Array.from({ length: 12 }, (_, index) => player("K", index + 1, { sourceCount: 1, sourceIds: ["yahoo-season-projection"] })),
      DEF: Array.from({ length: 32 }, (_, index) => player("DEF", index + 1, { sourceCount: 1, sourceIds: ["yahoo-season-projection"] })),
      DL: [player("DL", 1)],
      LB: [player("LB", 1)],
      DB: [
        player("DB", 1, { yahooPosition: "CB" }),
        player("DB", 2, { yahooPosition: "WR", eligible: ["WR", "CB", "DB", "D"] }),
        player("DB", 3, { yahooPosition: "DB", eligible: ["DB"] }),
        player("DB", 4, { yahooPosition: "S", injury: { draftAction: "BLOCK", conflict: true } }),
      ],
    } },
  });
  assert.equal(board.offense.length, 100);
  assert.equal(board.offense.some((entry) => entry.yahooId === "RB-1"), false);
  assert.equal(board.offense.some((entry) => entry.yahooId === "RB-2"), false);
  assert.equal(board.kickers[0].confidence, "YAHOO_ONLY");
  assert.equal(board.defenses.length, 32);
  assert.equal(board.idp.length, 4);
  assert.deepEqual(board.idp.slice(-2).map((entry) => entry.position), ["CB", "CB"]);
  assert.match(renderExtensionBoard(board), /SKRODZKaiYahooMockBoard/);
});
