import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { scoreOffenseStatLine, scoreIdpStatLine, scoreKickerStatLine } from "./player-intelligence.mjs";

import { assembleV5Board } from "./build-v5-board.mjs";

const testContract = globalThis.SKRODZKaiYahooMockRunner.configs.test_league_19_idp;

test("observed TEST scoring is fingerprinted and never inherits REAL QB, IDP, or kicker rules", () => {
  const rules = testContract.scoringRules;
  assert.equal(createHash("sha256").update(JSON.stringify(rules)).digest("hex"), testContract.expectedScoring.scoringSchemaHash);
  for (const [label, display, , points] of Object.values(testContract.scoringSettingsRows).flat()) {
    const yards = display.match(/^(\d+) yards per point$/);
    assert.equal(points, yards ? 1 / Number(yards[1]) : Number(display), `${label}: displayed Yahoo value must equal scoring coefficient`);
  }
  const qb = { passingCompletions:300, passingYards:4000, passingTouchdowns:30, interceptions:10 };
  assert.equal(scoreOffenseStatLine(qb, rules.offense), 270);
  assert.equal(scoreOffenseStatLine(qb), 350);
  const receiver = { receptions:100, receivingYards:1200, receivingTouchdowns:8, receivingHundredYardGames:5 };
  assert.equal(scoreOffenseStatLine(receiver, rules.offense), 218);
  assert.equal(scoreOffenseStatLine(receiver), 203);
  const defender = { soloTackles:100, assistedTackles:40, passesDefended:12, tacklesForLoss:8, turnoverReturnYards:50 };
  assert.equal(scoreIdpStatLine(defender, rules.idp), 67);
  assert.equal(scoreIdpStatLine(defender), 85);
  assert.ok(Number.isNaN(scoreKickerStatLine({ fieldGoalsMade:30, extraPointsMade:40 }, rules.kicker)), "aggregate FG counts cannot invent distance buckets");
  assert.equal(scoreKickerStatLine({ fieldGoals0To19:0, fieldGoals20To29:10, fieldGoals30To39:10, fieldGoals40To49:5, fieldGoals50Plus:5, extraPointsMade:40 }, rules.kicker), 145);
});

test("board preserves source expiry and the exact replacement calculation field", () => {
  const binding={teamCount:10,rosterSlots:["QB"]};
  const board=fixture({replacementRoster:binding,offenseSnapshot:{observedAt:"2026-08-22T10:00:00Z",
    players:Array.from({length:10},(_,i)=>({yahooId:String(i+1),name:`Quarterback ${i}`,team:"BUF",position:"QB",yahooProjectedPoints:400-i,injuryStatus:null}))}});
  assert.deepEqual(board.replacementRoster,binding);
  assert.deepEqual(board.sourceExpirations.find(s=>s.sourceId==="yahoo-season-projection"),
    {sourceId:"yahoo-season-projection",observedAt:"2026-08-22T10:00:00Z",maxAgeHours:6});
  assert.ok(board.sourceExpirations.some(s=>s.sourceId==="yahoo-player-list"&&s.maxAgeHours===6));
});

test("TEST builder rejects REAL snapshots and rescores independent raw statistics under TEST rules", () => {
  assert.throws(() => fixture({ leagueId:"542830" }), /projection scoring identity mismatch/);
  const identity = testContract.expectedScoring;
  const inputs = {
    leagueId:"542830",
    offenseSnapshot:{ ...identity, observedAt:"2026-08-22T10:00:00Z", players:[{ yahooId:"1", name:"Quarterback", team:"BUF", position:"QB", yahooProjectedPoints:250, yahooPreseasonRank:4, injuryStatus:null, bye:7 }] },
    specialistSnapshot:{ ...identity, observedAt:"2026-08-22T10:01:00Z", positions:{} },
    projectionSnapshots:[{
      manifest:{ snapshotId:"test-espn", sourceId:"espn-mike-clay", sourceFamily:"espn-clay", sourceAsOf:"2026-08-22T11:00:00Z", retrievedAt:"2026-08-22T11:10:00Z", contentSha256:"a".repeat(64), gamesBasis:"17", projectionPeriod:"2026", licenseUseNote:"synthetic regression" },
      rows:[{ playerId:"1", name:"Quarterback", position:"QB", team:"BUF", projectionGames:17, scoringKind:"offense", leaguePoints:9999, perGamePoints:9999, stats:{ passingCompletions:300, passingYards:4000, passingTouchdowns:30, interceptions:10 } }],
    }],
  };
  const board = fixture(inputs);
  assert.equal(board.leagueId, "542830");
  assert.equal(board.scoringSchemaHash, identity.scoringSchemaHash);
  assert.equal(board.players[0].consensusPoints, 260);
  assert.equal(board.players[0].automaticEligible, true);
  assert.equal(board.survivalCalibration, null);
  assert.equal(board.projectionModel.idpRanking.globalGate.pass, false);
  for (const key of Object.keys(identity)) {
    assert.throws(() => fixture({ ...inputs, specialistSnapshot:{ ...inputs.specialistSnapshot, [key]:"wrong" } }), /projection scoring identity mismatch/);
  }
  assert.equal(fixture({ ...inputs, asOf:"2026-08-23T12:00:00Z" }).players[0].automaticEligible, false, "stale TEST data is not executable");
});

function fixture(overrides = {}) {
  return assembleV5Board({
    asOf: "2026-08-22T12:00:00Z",
    baselineObservedAt: "2026-08-21T12:00:00Z",
    sleeperObservedAt: "2026-08-22T10:05:00Z",
    baselineRows: [
      {
        yahoo_id: "1",
        name: "Quarterback",
        team: "BUF",
        position: "QB",
        projection: 400,
        gsis_id: "g1",
        sleeper_id: "s1",
        payload_json: JSON.stringify({ eligible: ["QB"] }),
      },
    ],
    offenseSnapshot: {
      observedAt: "2026-08-22T10:00:00Z",
      players: [
        {
          yahooId: "1",
          name: "Quarterback",
          team: "BUF",
          position: "QB",
          yahooProjectedPoints: 420,
          yahooPreseasonRank: 4,
          rosteredPercent: 100,
          injuryStatus: null,
        },
      ],
    },
    specialistSnapshot: { observedAt: "2026-08-22T10:01:00Z", positions: {}, eligibilityEvidence: {} },
    sleeperPlayers: { s1: { yahoo_id: 1, status: "Active", injury_status: null } },
    eligibilitySnapshot: null,
    replacementRoster: null,
    ...overrides,
  });
}

test("CLI cannot backdate ADP and health freshness with a historical as-of", () => {
  const args = ["baseline", "offense", "specialists", "sleeper", "output", "sleeper-observed-at", "adp", "adp-observed-at", "team-count"].map((key) => `--${key}=unused`);
  const result = spawnSync(process.execPath, [new URL("./build-v5-board.mjs", import.meta.url).pathname, ...args, "--as-of=2000-01-01T00:00:00Z"], { encoding:"utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /as-of must match the build wall clock/);
});

test("Yahoo reserve PUP flag cannot be treated as an unknown health badge", () => {
  const board = fixture({ sleeperPlayers:{}, offenseSnapshot:{ observedAt:"2026-08-22T10:00:00Z", players:[{ yahooId:"1", name:"Quarterback", team:"BUF", position:"QB", yahooProjectedPoints:250, games:10, injuryStatus:"PUP-R", bye:7 }] } });
  assert.equal(board.players[0].injury.status, "PUP");
  assert.equal(board.players[0].injury.draftAction, "EXCLUDE");
  assert.equal(board.players[0].validationStatus, "INJURY_EXCLUDED");
  assert.equal(board.players[0].automaticEligible, false);
  assert.equal(board.players[0].manualEligible, false);
});

test("keeps history and market data out of projection evidence", () => {
  const board = fixture();
  assert.equal(board.players[0].consensusPoints, 420);
  assert.deepEqual(board.players[0].sourceIds, ["yahoo-season-projection"]);
  assert.equal(board.players[0].automaticEligible, false);
  assert.equal(board.players[0].manualEligible, true);
  assert.equal(board.players[0].validationStatus, "UNVALIDATED_SINGLE_SOURCE_PROJECTION");
  assert.equal(board.boards.offense[0].draftBoardRank, 1);
  assert.deepEqual(board.injuryFreshnessPolicy, {
    default: 36,
    yahoo: 6,
    sleeper: 24,
    nfl_official: 24,
    team_official: 24,
  });
});

test("validates offense only with two fresh independent projection families", () => {
  const board = fixture({ projectionSnapshots: [{
    manifest: {
      snapshotId: "espn-clay-test", sourceId: "espn-mike-clay", sourceFamily: "espn-clay",
      sourceAsOf: "2026-08-22T11:00:00Z", retrievedAt: "2026-08-22T11:10:00Z",
      contentSha256: "a".repeat(64), gamesBasis: "17", projectionPeriod: "2026", licenseUseNote: "test",
    },
    rows: [{ playerId: "1", name: "Quarterback", team: "BUF", position: "QB", projectionGames: 17, stats: { passingCompletions: 300, passingYards: 4000, passingTouchdowns: 30, interceptions: 10 } }],
  }] });
  assert.equal(board.players[0].sourceFamilyCount, 2);
  assert.equal(board.players[0].automaticEligible, true);
  assert.equal(board.players[0].validationStatus, "EXECUTABLE");
});

test("rejects identity or injury feeds as projection evidence", () => {
  assert.throws(() => fixture({ projectionSnapshots: [{
    manifest: {
      snapshotId: "sleeper-test", sourceId: "sleeper", sourceFamily: "sleeper",
      sourceAsOf: "2026-08-22T11:00:00Z", retrievedAt: "2026-08-22T11:10:00Z",
      contentSha256: "c".repeat(64), gamesBasis: "identity", projectionPeriod: "2026", licenseUseNote: "test",
    },
    rows: [],
  }] }), /cannot count as raw-stat projection evidence/);
});

test("K and DEF use current Yahoo preseason rank rather than projection order", () => {
  const board = fixture({
    baselineRows: [
      { yahoo_id: "10", name: "Kicker A", team: "A", position: "K", projection: 100 },
      { yahoo_id: "11", name: "Kicker B", team: "B", position: "K", projection: 150 },
    ],
    offenseSnapshot: { observedAt: "2026-08-22T10:00:00Z", players: [] },
    specialistSnapshot: { observedAt: "2026-08-22T10:01:00Z", positions: { K: [
      { yahooId: "10", name: "Kicker A", team: "A", position: "K", yahooProjectedPoints: 100, yahooPreseasonRank: 20 },
      { yahooId: "11", name: "Kicker B", team: "B", position: "K", yahooProjectedPoints: 150, yahooPreseasonRank: 40 },
    ] }, eligibilityEvidence: {} },
    sleeperPlayers: {
      a: { yahoo_id: 10, status: "Active", injury_status: null },
      b: { yahoo_id: 11, status: "Active", injury_status: null },
    },
  });
  assert.deepEqual(board.boards.specialists.K.map((player) => player.yahooId), ["10", "11"]);
  assert.match(board.specialistRankingBasis.K, /Yahoo preseason rank/);
  assert.ok(board.boards.specialists.K.every((player) => player.validationStatus === "UNVALIDATED_SPECIALIST_PROJECTION"));
  assert.ok(board.boards.specialists.K.every((player) => player.automaticEligible === true));
});

test("Yahoo injury markers block automatic use even when projection evidence is complete", () => {
  const board = fixture({
    offenseSnapshot: {
      observedAt: "2026-08-22T10:00:00Z",
      players: [
        {
          yahooId: "1",
          name: "Quarterback",
          team: "BUF",
          position: "QB",
          yahooProjectedPoints: 420,
          injuryStatus: "Q",
        },
      ],
    },
    sleeperPlayers: { s1: { yahoo_id: 1, status: "Active", injury_status: null } },
  });
  assert.equal(board.players[0].executable, false);
  assert.equal(board.players[0].injury.conflict, true);
});

test("uses the baseline Sleeper ID when the current Sleeper record omits its Yahoo ID", () => {
  const board = fixture({
    baselineRows: [{
      yahoo_id:"", sleeper_id:"s1", name:"Quarterback", team:"BUF", position:"QB",
      payload_json:JSON.stringify({ eligible:["QB"] }),
    }],
    sleeperPlayers: {
      s1: { player_id:"s1", yahoo_id:null, status:"Active", injury_status:"Questionable", injury_body_part:"Knee" },
    },
  });
  assert.equal(board.players[0].injury.status, "QUESTIONABLE");
  assert.equal(board.players[0].injury.evidence.some((entry) => entry.sourceId === "sleeper-player-map"), true);
  assert.equal(board.players[0].injury.bodyParts.includes("Knee"), true);
  assert.equal(board.players[0].automaticEligible, false);
});

test("fresh non-conflicting injury review remains manual-only", () => {
  const board = fixture({
    offenseSnapshot: {
      observedAt:"2026-08-22T10:00:00Z",
      players:[{ yahooId:"1", name:"Quarterback", team:"BUF", position:"QB", yahooProjectedPoints:420, injuryStatus:"Q" }],
    },
    sleeperPlayers:{ s1:{ yahoo_id:1, status:"Active", injury_status:"Questionable", injury_body_part:"Knee" } },
    projectionSnapshots:[{
      manifest:{ snapshotId:"espn-clay-test", sourceId:"espn-mike-clay", sourceFamily:"espn-clay", sourceAsOf:"2026-08-22T11:00:00Z", retrievedAt:"2026-08-22T11:10:00Z", contentSha256:"a".repeat(64), gamesBasis:"17", projectionPeriod:"2026", licenseUseNote:"test" },
      rows:[{ playerId:"1", name:"Quarterback", team:"BUF", position:"QB", projectionGames:17, stats:{ passingCompletions:300, passingYards:4000, passingTouchdowns:30, interceptions:10 } }],
    }],
  });
  assert.equal(board.players[0].injury.draftAction, "REVIEW");
  assert.equal(board.players[0].injury.conflict, false);
  assert.equal(board.players[0].automaticEligible, false);
  assert.equal(board.players[0].manualEligible, true);
  assert.equal(board.players[0].validationStatus, "INJURY_REVIEW");
});

test("filter membership preserves dual-role Yahoo eligibility evidence", () => {
  const board = fixture({
    specialistSnapshot: {
      observedAt: "2026-08-22T10:01:00Z",
      eligibilityEvidence: { travisHunterInDbFilter: true },
      positions: { DB: [{ yahooId: "1", name: "Quarterback", position: "QB", yahooProjectedPoints: 420 }] },
    },
  });
  assert.deepEqual(board.players[0].yahooEligibilityFilters, ["DB", "O"]);
  assert.equal(board.eligibilityEvidence.travisHunterInDbFilter, true);
});

test("an old Hunter baseline cannot restore defensive eligibility absent current Yahoo tokens", () => {
  const board = fixture({
    baselineRows: [{
      yahoo_id: "",
      name: "Travis Hunter",
      team: "JAX",
      position: "WR",
      projection: 100,
      payload_json: JSON.stringify({
        eligible: ["WR", "W/R/T", "CB", "DB", "D"],
        specialist_qualified: true,
        specialist: { draft_position: "DB" },
      }),
    }],
    offenseSnapshot: {
      observedAt: "2026-08-22T10:00:00Z",
      players: [{ yahooId: "41787", name: "Travis Hunter", team: "JAX", position: "WR", yahooProjectedPoints: 92 }],
    },
    specialistSnapshot: {
      observedAt: "2026-08-22T10:01:00Z",
      eligibilityEvidence: { travisHunterInDbFilter: true },
      positions: { DB: [{ yahooId: "41787", name: "Travis Hunter", team: "JAX", position: "WR", yahooProjectedPoints: 92 }] },
    },
    sleeperPlayers: {},
  });
  assert.equal(board.players[0].position, "WR");
  assert.equal(board.players[0].yahooPosition, "WR");
  assert.equal(board.players[0].sourceCount, 1);
  assert.deepEqual(board.players[0].eligible, ["WR"]);
  assert.equal(board.players[0].automaticEligible, false);
  assert.equal(board.players[0].manualEligible, true);
  assert.equal(board.players[0].validationStatus, "DUAL_ROLE_SCORING_UNVERIFIED");
  assert.equal(board.boards.specialists.DB.length, 0);
});

test("current Yahoo eligibility excludes every baseline slot channel and uses current team", () => {
  const board = fixture({
    baselineRows:[{ yahoo_id:"1", name:"Quarterback", team:"OLD", position:"QB", payload_json:JSON.stringify({ eligible:["QB", "DB"], specialist_qualified:true, specialist:{ draft_position:"DB" } }) }],
    offenseSnapshot:{ observedAt:"2026-08-22T10:00:00Z", players:[{ yahooId:"1", name:"Quarterback", team:"BUF", yahooProjectedPoints:160, injuryStatus:null, bye:7 }] },
    eligibilitySnapshot:{ observedAt:"2026-08-22T10:00:00Z", players:[{ yahooId:"1", eligible:["WR"] }] },
  });
  assert.deepEqual(board.players[0].eligible, ["WR"]);
  assert.equal(board.players[0].position, "WR");
  assert.equal(board.players[0].team, "BUF");
  assert.equal(board.players[0].specialistPosition, null);
});

test("Yahoo projected games normalize rates without granting reduced-game players a full season", () => {
  for (const games of [16, 6]) {
    const board = fixture({ offenseSnapshot:{ observedAt:"2026-08-22T10:00:00Z", players:[{ yahooId:"1", name:"Quarterback", team:"BUF", position:"QB", games, yahooProjectedPoints:games * 20, injuryStatus:null, bye:7 }] } });
    const player = board.players[0];
    assert.equal(player.sourceFamilyPerGamePoints.yahoo, 20);
    assert.equal(player.expectedGamesThroughWeek17, games);
    if (games === 6) {
      assert.equal(player.automaticEligible, false);
      assert.equal(player.validationStatus, "UNVALIDATED_SINGLE_SOURCE_PROJECTION", "games cap does not clear the independent projection gate");
    }
  }
});

test("CLEAR reduced-game players remain discounted but eligible; actual injury restrictions remain", () => {
  for (const injuryStatus of [null, "Q", "IR"]) {
    const board = fixture({
      offenseSnapshot:{ observedAt:"2026-08-22T10:00:00Z", players:[{ yahooId:"1", name:"Quarterback", team:"BUF", position:"QB", games:15, yahooProjectedPoints:300, injuryStatus, bye:7 }] },
      sleeperPlayers:{},
      projectionSnapshots:[{
        manifest:{ snapshotId:"reduced-games", sourceId:"espn-mike-clay", sourceFamily:"espn-clay", sourceAsOf:"2026-08-22T11:00:00Z", retrievedAt:"2026-08-22T11:10:00Z", contentSha256:"a".repeat(64), gamesBasis:"17", projectionPeriod:"2026", licenseUseNote:"regression" },
        rows:[{ playerId:"1", name:"Quarterback", position:"QB", team:"BUF", projectionGames:17, scoringKind:"offense", stats:{ passingYards:4000, passingTouchdowns:30, passingCompletions:300, interceptions:10 } }],
      }],
    });
    const player = board.players[0];
    assert.equal(player.automaticEligible, injuryStatus === null);
    if (injuryStatus === null) {
      assert.equal(player.injury.draftAction, "CLEAR");
      assert.equal(player.expectedGamesThroughWeek17, 15);
      assert.ok(Math.abs(player.weeklyPoints.reduce((a, b) => a + b, 0) - player.rankingPerGamePoints * 15) < 1e-8);
      assert.equal(player.weeklyPoints[6], 0);
    }
  }
});

test("invalid Yahoo games are diagnosed per row; only an explicit snapshot basis resolves null games", () => {
  for (const games of [0, null, 18]) {
    const snapshot = { observedAt:"2026-08-22T10:00:00Z", players:[{ yahooId:"1", name:"Quarterback", team:"BUF", position:"QB", games, yahooProjectedPoints:160, bye:7 }] };
    const board = fixture({ offenseSnapshot:snapshot });
    assert.equal(board.players[0].automaticEligible, false);
    assert.ok(board.projectionDiagnostics.excludedRows.some((row) => row.playerId === "1"));
    if (games === null) assert.equal(fixture({ offenseSnapshot:{ ...snapshot, projectionGames:17 } }).players[0].sourceFamilyPerGamePoints.yahoo, 160 / 17);
  }
});

test("an external 18-game row is diagnosed and excluded without crashing the board", () => {
  const board = fixture({ projectionSnapshots:[{
    manifest:{ snapshotId:"bad-games", sourceId:"espn-mike-clay", sourceFamily:"espn-clay", sourceAsOf:"2026-08-22T11:00:00Z", retrievedAt:"2026-08-22T11:10:00Z", contentSha256:"a".repeat(64), gamesBasis:"18", projectionPeriod:"2026", licenseUseNote:"test" },
    rows:[{ playerId:"1", position:"QB", projectionGames:18, stats:{ passingYards:4000 } }],
  }] });
  assert.equal(board.players[0].sourceFamilyCount, 1);
  assert.equal(board.projectionDiagnostics.excludedRows[0].games, 18);
});

test("split Yahoo Travis Hunter identities remain manual-only", () => {
  const board = fixture({
    baselineRows: [],
    offenseSnapshot: {
      observedAt: "2026-08-22T10:00:00Z",
      players: [{ yahooId: "99001", name: "Travis Hunter", team: "JAX", position: "WR", yahooProjectedPoints: 90 }],
    },
    specialistSnapshot: {
      observedAt: "2026-08-22T10:01:00Z",
      positions: { DB: [{ yahooId: "99002", name: "Travis Hunter", team: "JAX", position: "CB", yahooProjectedPoints: 90 }] },
      eligibilityEvidence: {},
    },
    sleeperPlayers: {},
  });
  const hunters = board.players.filter((player) => player.name === "Travis Hunter");
  assert.deepEqual(hunters.map((player) => player.yahooId).sort(), ["99001", "99002"]);
  assert.deepEqual(hunters.map((player) => player.position).sort(), ["CB", "WR"]);
  assert.ok(hunters.every((player) => player.automaticEligible === false));
  assert.ok(hunters.every((player) => player.validationStatus === "DUAL_ROLE_SCORING_UNVERIFIED"));
});

test("same-name players on different teams do not collide as dual-role identities", () => {
  const board = fixture({
    baselineRows: [
      { yahoo_id: "32692", name: "Justin Jefferson", team: "MIN", position: "WR", projection: 300, payload_json: JSON.stringify({ eligible: ["WR"] }) },
      { yahoo_id: "42774", name: "Justin Jefferson", team: "CLE", position: "LB", projection: 100, payload_json: JSON.stringify({ eligible: ["LB", "D"] }) },
    ],
    offenseSnapshot: {
      observedAt: "2026-08-22T10:00:00Z",
      players: [{ yahooId: "32692", name: "Justin Jefferson", team: "MIN", position: "WR", yahooProjectedPoints: 300 }],
    },
    specialistSnapshot: {
      observedAt: "2026-08-22T10:01:00Z",
      positions: { LB: [{ yahooId: "42774", name: "Justin Jefferson", team: "CLE", position: "LB", yahooProjectedPoints: 100 }] },
      eligibilityEvidence: {},
    },
    sleeperPlayers: {},
  });
  const receiver = board.players.find((player) => player.yahooId === "32692");
  const linebacker = board.players.find((player) => player.yahooId === "42774");
  assert.equal(receiver.validationStatus, "UNVALIDATED_SINGLE_SOURCE_PROJECTION");
  assert.equal(linebacker.validationStatus, "UNVALIDATED_SINGLE_SOURCE_PROJECTION");
  assert.equal(linebacker.automaticEligible, false);
});

test("a lone current Travis Hunter identity remains manual-only with two fresh families", () => {
  const board = fixture({
    baselineRows: [],
    offenseSnapshot: {
      observedAt: "2026-08-22T10:00:00Z",
      players: [{ yahooId: "99001", name: "Travis Hunter", team: "JAX", position: "WR", yahooProjectedPoints: 90 }],
    },
    projectionSnapshots: [{
      manifest: {
        snapshotId: "espn-clay-hunter", sourceId: "espn-mike-clay", sourceFamily: "espn-clay",
        sourceAsOf: "2026-08-22T11:00:00Z", retrievedAt: "2026-08-22T11:10:00Z",
        contentSha256: "b".repeat(64), gamesBasis: "17", projectionPeriod: "2026", licenseUseNote: "test",
      },
      rows: [{ playerId: "99001", name: "Travis Hunter", team: "JAX", position: "WR", projectionGames: 17, stats: { receptions: 50, receivingYards: 700, receivingTouchdowns: 5, receivingHundredYardGames: 0, rushingHundredYardGames: 0 } }],
    }],
    specialistSnapshot: { observedAt: "2026-08-22T10:01:00Z", positions: {}, eligibilityEvidence: {} },
    sleeperPlayers: {},
  });
  assert.equal(board.players[0].sourceFamilyCount, 2);
  assert.equal(board.players[0].automaticEligible, false);
  assert.equal(board.players[0].manualEligible, true);
  assert.equal(board.players[0].validationStatus, "DUAL_ROLE_SCORING_UNVERIFIED");
});

test("league-specific eligibility adds unprojected CB fallbacks without inventing points", () => {
  const board = fixture({
    eligibilitySnapshot: {
      observedAt: "2026-08-22T10:02:00Z",
      positionFilter: "CB",
      players: [{ yahooId: "2", name: "Corner", team: "BUF", position: "CB", eligible: ["CB"] }],
    },
  });
  const corner = board.players.find((player) => player.yahooId === "2");
  assert.equal(corner.position, "CB");
  assert.deepEqual(corner.eligible, ["CB"]);
  assert.equal(corner.consensusPoints, null);
  assert.equal(corner.executable, false);
  assert.equal(corner.yahooEligibilityFilters.includes("CB"), true);
});

test("receipts every Yahoo snapshot timestamp and rejects missing eligibility evidence time", () => {
  const board = fixture({
    eligibilitySnapshot: {
      observedAt: "2026-08-22T10:02:00Z",
      positionFilter: "CB",
      players: [],
    },
  });
  assert.deepEqual(board.snapshotReceipts, {
    yahooOffenseObservedAt: "2026-08-22T10:00:00Z",
    yahooSpecialistObservedAt: "2026-08-22T10:01:00Z",
    yahooEligibilityObservedAt: "2026-08-22T10:02:00Z",
  });
  assert.throws(() => fixture({ eligibilitySnapshot: { positionFilter: "CB", players: [] } }), /eligibilitySnapshot\.observedAt/);
  assert.throws(() => fixture({ specialistSnapshot: { positions: {}, eligibilityEvidence: {} } }), /specialistSnapshot\.observedAt/);
});

test("a stale specialist snapshot cannot borrow the offense timestamp", () => {
  const board = fixture({
    baselineRows: [{ yahoo_id: "10", name: "Kicker", team: "BUF", position: "K", projection: 100 }],
    offenseSnapshot: { observedAt: "2026-08-22T10:00:00Z", players: [] },
    specialistSnapshot: {
      observedAt: "2026-08-01T10:00:00Z",
      positions: { K: [{ yahooId: "10", name: "Kicker", team: "BUF", position: "K", yahooProjectedPoints: 100, yahooPreseasonRank: 1 }] },
      eligibilityEvidence: {},
    },
    sleeperPlayers: { k: { yahoo_id: 10, status: "Active", injury_status: null } },
  });
  const kicker = board.players.find((player) => player.yahooId === "10");
  assert.equal(kicker.executable, false);
  assert.match(kicker.blockReason, /requires 1 scorable projection families|no fresh injury evidence/);
});

test("an offense row keeps its own projection and injury timestamp when it also appears in a stale specialist filter", () => {
  const board = fixture({
    offenseSnapshot: {
      observedAt: "2026-08-22T10:00:00Z",
      players: [{ yahooId: "1", name: "Quarterback", team: "BUF", position: "QB", yahooProjectedPoints: 420, injuryStatus: null }],
    },
    specialistSnapshot: {
      observedAt: "2026-08-01T10:00:00Z",
      positions: { DB: [{ yahooId: "1", name: "Quarterback", team: "BUF", position: "QB", yahooProjectedPoints: 1, injuryStatus: "O" }] },
      eligibilityEvidence: {},
    },
  });
  const player = board.players[0];
  assert.equal(player.consensusPoints, 420);
  assert.equal(player.injury.evidence.find((entry) => entry.sourceId === "yahoo-player-list").observedAt, "2026-08-22T10:00:00Z");
  assert.equal(player.injury.draftAction, "CLEAR");
  assert.equal(player.injury.evidence.find((entry) => entry.sourceId === "yahoo-player-list").status, "CLEAR");
  assert.deepEqual(player.yahooEligibilityFilters, ["DB", "O"]);
});

test("emits the compact injury watchlist in the board artifact", () => {
  const board = fixture({
    offenseSnapshot: {
      observedAt: "2026-08-22T10:00:00Z",
      players: [{ yahooId: "1", name: "Quarterback", team: "BUF", position: "QB", yahooProjectedPoints: 420, injuryStatus: "Q" }],
    },
  });
  assert.deepEqual(board.injuryWatchlist.map((player) => player.yahooId), ["1"]);
  assert.equal(board.injuryWatchlist[0].draftAction, "REVIEW");
});

test("passes a globally approved IDP calibration through ranking and weekly fields", () => {
  const stats = {
    soloTackles: 0, assistedTackles: 0, sacks: 0, interceptions: 0,
    forcedFumbles: 0, fumbleRecoveries: 0, touchdowns: 10, safeties: 0,
    passesDefended: 0, blockedKicks: 0, tacklesForLoss: 0,
    turnoverReturnYards: 0, extraPointReturns: 0, snaps: 900,
  };
  const board = fixture({
    baselineRows: [{ yahoo_id: "2", name: "Linebacker", team: "BUF", position: "LB", gsis_id: "g2", sleeper_id: "s2", payload_json: JSON.stringify({ eligible: ["LB", "D"] }) }],
    offenseSnapshot: { observedAt: "2026-08-22T10:00:00Z", players: [] },
    specialistSnapshot: { observedAt: "2026-08-22T10:01:00Z", positions: { LB: [{ yahooId: "2", name: "Linebacker", team: "BUF", position: "LB", yahooProjectedPoints: 60, bye: 7 }] }, eligibilityEvidence: {} },
    sleeperPlayers: { s2: { yahoo_id: 2, status: "Active", injury_status: null } },
    projectionSnapshots: [{
      manifest: {
        snapshotId: "razzball-idp-test", sourceId: "razzball-projections", sourceFamily: "razzball",
        sourceAsOf: "2026-08-22T11:00:00Z", retrievedAt: "2026-08-22T11:10:00Z",
        contentSha256: "d".repeat(64), gamesBasis: "17", projectionPeriod: "2026", licenseUseNote: "test",
      },
      rows: [{ playerId: "2", name: "Linebacker", team: "BUF", position: "LB", scoringKind: "idp", projectionGames: 17, stats }],
    }],
    survivalCalibration: {
      idpRanking: {
        status: "ACTIVE",
        globalGate: { pass: true },
        preregistrationHash: "e".repeat(64),
        positionParameters: { LB: { volatileWeight: 0.25, roleExponent: 0, trainingSnapMean: 50 } },
      },
    },
  });
  const linebacker = board.players[0];
  assert.equal(linebacker.consensusPoints, 60);
  assert.equal(linebacker.rankingPoints, 15);
  assert.equal(linebacker.idpModelStatus, "ACTIVE");
  const rawWeeklyTotal = linebacker.rawWeeklyPoints.reduce((sum, value) => sum + value, 0);
  const decisionWeeklyTotal = linebacker.weeklyPoints.reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(decisionWeeklyTotal / rawWeeklyTotal - 0.25) < 1e-12);
  assert.equal(board.projectionModel.idpRanking.globalGate.pass, true);
});
