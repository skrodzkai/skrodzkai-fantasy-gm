import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCalibration,
  draftPhase,
  parseCsv,
  parseHistory,
  predictPosition,
  trainPositionModel,
} from "./opponent-calibration.mjs";

test("parses quoted CSV fields without losing commas", () => {
  const rows = parseCsv('season,manager_id,team_name\n2025,owner-a,"Team, The"\n');
  assert.deepEqual(rows, [{ season: "2025", manager_id: "owner-a", team_name: "Team, The" }]);
});

test("parses the observed league history column names", () => {
  const rows = parseHistory("season,owner_id,draft_slot,overall_pick,round,position\n2025,owner-a,6,6,1,QB\n");
  assert.deepEqual(rows, [{
    season: 2025,
    managerId: "owner-a",
    draftSlot: 6,
    pick: 6,
    round: 1,
    position: "QB",
  }]);
});

test("uses four draft phases aligned to the 19-round room", () => {
  assert.equal(draftPhase(4), "opening");
  assert.equal(draftPhase(5), "core");
  assert.equal(draftPhase(10), "bench");
  assert.equal(draftPhase(15), "specialists");
});

test("shrinks stable manager preferences toward the room prior", () => {
  const rows = [];
  for (let season = 2020; season <= 2024; season += 1) {
    for (let round = 1; round <= 4; round += 1) {
      rows.push({ season, managerId: "qb-owner", round, position: round === 1 ? "QB" : "WR" });
      rows.push({ season, managerId: "rb-owner", round, position: "RB" });
    }
  }
  const model = trainPositionModel(rows, { decay: 1, shrinkage: 4, maxSeason: 2024 });
  const qbOwner = predictPosition(model, "qb-owner", 2);
  const rbOwner = predictPosition(model, "rb-owner", 2);
  assert.ok(qbOwner.QB > rbOwner.QB);
  assert.ok(rbOwner.RB > qbOwner.RB);
  assert.deepEqual(predictPosition(model, "unknown", 2), model.roomProbabilities.opening);
});

test("builds pseudonymous profiles and keeps the raw mapping separate", () => {
  const header = "season,manager_id,draft_slot,pick,round,position\n";
  const lines = [];
  for (let season = 2018; season <= 2025; season += 1) {
    for (const [manager, position, slot] of [["alpha", "QB", 1], ["beta", "RB", 2], ["gamma", "WR", 3]]) {
      for (let round = 1; round <= 19; round += 1) {
        lines.push(`${season},${manager},${slot},${(round - 1) * 3 + slot},${round},${round <= 4 ? position : "WR"}`);
      }
    }
  }
  const rows = parseHistory(header + lines.join("\n") + "\n");
  const result = buildCalibration(rows, {
    validationSeasons: [2023, 2024],
    testSeason: 2025,
    decays: [1],
    shrinkages: [1],
    bootstrapSamples: 200,
    excludeManagerIds: ["gamma"],
  });
  assert.equal(result.calibration.events, 38);
  assert.ok(Object.keys(result.profiles).every((key) => /^owner-[a-f0-9]{10}$/.test(key)));
  assert.equal(result.profiles.alpha, undefined);
  assert.equal(result.managerMap.gamma, undefined);
  assert.match(result.managerMap.alpha, /^owner-/);
  assert.equal(result.calibration.excludedManagers, 1);
  assert.equal(result.calibration.excludedRows, 152);
});

test("excluded manager history does not influence the opponent room prior", () => {
  const opponentRows = [];
  for (const season of [2021, 2022, 2023, 2024, 2025]) {
    opponentRows.push({ season, managerId: "alpha", round: 1, position: "RB" });
    opponentRows.push({ season, managerId: "beta", round: 1, position: "WR" });
  }
  const joeRows = Array.from({ length: 40 }, (_, index) => ({
    season: 2021 + (index % 5),
    managerId: "joe",
    round: 1,
    position: "QB",
  }));
  const options = {
    validationSeasons: [2023, 2024],
    testSeason: 2025,
    decays: [1],
    shrinkages: [4],
    bootstrapSamples: 100,
  };
  const withoutJoe = buildCalibration(opponentRows, options);
  const excludedJoe = buildCalibration([...opponentRows, ...joeRows], {
    ...options,
    excludeManagerIds: ["joe"],
  });
  assert.deepEqual(excludedJoe.room, withoutJoe.room);
  const { excludedManagers: ignoredManagerCount, excludedRows: ignoredRowCount, ...excludedMetrics } = excludedJoe.calibration;
  const { excludedManagers: baselineManagerCount, excludedRows: baselineRowCount, ...baselineMetrics } = withoutJoe.calibration;
  assert.deepEqual(excludedMetrics, baselineMetrics);
  assert.equal(ignoredManagerCount, 1);
  assert.equal(ignoredRowCount, 40);
  assert.equal(baselineManagerCount, 0);
  assert.equal(baselineRowCount, 0);
});
