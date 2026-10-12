import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCli } from "./yahoo-fantasy-operations.mjs";
import { yahooFantasyGet } from "./yahoo-fantasy-readonly.mjs";

const cli = fileURLToPath(new URL("./yahoo-fantasy-operations.mjs", import.meta.url));
const execFileAsync = promisify(execFile);
const leagueKey = "461.l.420010", teamKey = `${leagueKey}.t.7`;
const wrap = resource => ({ fantasy_content: Object.fromEntries(Object.entries(resource)
  .map(([name, value]) => [name, ["league", "team"].includes(name) ? [value] : value])) });
const responses = () => [
  wrap({ users: { count: 1, 0: { user: { guid: "synthetic-guid", games: { game: [{
    game_key: "461", code: "nfl", season: "2026", teams: { team: [{ team_key: teamKey }] },
  }] } } } } }),
  wrap({ league: { league_key: leagueKey, league_id: "420010", game_code: "nfl", season: "2026", current_week: "6",
    settings: { roster_positions: { roster_position: { position: "QB", count: "1" } }, cant_cut_list: "none",
      waiver_type: "R", waiver_rule: "game", uses_faab: "0" } } }),
  wrap({ team: { team_key: teamKey, roster: { coverage_type: "week", week: "6", is_editable: "1",
    players: { count: 1, 0: { player: { player_key: "461.p.1", name: { full: "Synthetic QB" },
      eligible_positions: { position: "QB" }, selected_position: { position: "QB", week: "6" },
      is_editable: "1", is_undroppable: "0" } } } } } }),
  wrap({ league: { league_key: leagueKey, transactions: { count: 0 } } }),
  wrap({ league: { league_key: leagueKey, transactions: { count: 0 } } }),
];
function harness(overrides = {}) {
  const payloads = responses(), calls = [], output = [], errors = [];
  let accessCalls = 0;
  const dependencies = {
    refreshAccess: async () => { accessCalls += 1; return { yahooGuid: "synthetic-guid", accessToken: "test" }; },
    getResource: async (path, token) => {
      assert.equal(token, "test");
      calls.push(path);
      assert.ok(payloads.length, "no repeated read sequence");
      return payloads.shift();
    },
    stdout: text => { output.push(text); }, stderr: text => { errors.push(text); },
    ...overrides,
  };
  return { calls, output, errors, dependencies, accessCalls: () => accessCalls,
    run: args => runCli(args, dependencies), failure: () => JSON.parse(errors.join("")) };
}
const directory = () => mkdtemp(join(tmpdir(), "yahoo-operations-"));

test("argument validation precedes output preparation and access", async () => {
  for (const args of [["snapshot", "--out="], ["snapshot", "--out=/tmp/x/"], ["snapshot", "--out=a", "--out=b"], ["candidates", "FA:0:99"], ["unknown"]]) {
    const h = harness();
    assert.equal(await h.run(args), 1);
    assert.equal(h.failure().stage, "input");
    assert.equal(h.failure().accessStatus, "not_attempted");
    assert.equal(h.accessCalls(), 0); assert.equal(h.calls.length, 0);
  }
});

test("missing/non-directory parent and existing/dangling target stop before access", async () => {
  const dir = await directory(), existing = join(dir, "existing"), dangling = join(dir, "dangling");
  await writeFile(existing, "preserve these bytes");
  await symlink(join(dir, "absent"), dangling);
  for (const [path, code] of [
    [join(dir, "missing", "snapshot.json"), "yahoo_output_directory_missing"],
    [join(existing, "snapshot.json"), "yahoo_output_directory_not_directory"],
    [join(existing, "child", "snapshot.json"), "yahoo_output_directory_not_directory"],
    [existing, "yahoo_output_exists"], [dangling, "yahoo_output_exists"], [dir, "yahoo_output_exists"],
  ]) {
    const h = harness();
    assert.equal(await h.run(["snapshot", `--out=${path}`]), 1);
    assert.equal(h.failure().code, code); assert.equal(h.failure().stage, "output_preflight");
    assert.equal(h.failure().accessStatus, "not_attempted");
    assert.equal(h.failure().readStatus, "not_attempted");
    assert.equal(h.failure().persistence, "not_attempted");
    assert.equal(h.failure().resourceRequests, 0); assert.equal(h.accessCalls(), 0);
    assert.equal(h.calls.length, 0); assert.deepEqual(h.output, []);
  }
  assert.equal(await readFile(existing, "utf8"), "preserve these bytes");
  await assert.rejects(stat(join(dir, "missing")), { code: "ENOENT" });
});

test("real normalization persists private JSON and emits its compatible receipt once", async () => {
  const path = join(await directory(), "snapshot.json"), h = harness();
  assert.equal(await h.run(["snapshot", `--out=${path}`]), 0, h.errors.join(""));
  const raw = JSON.parse(await readFile(path, "utf8"));
  assert.equal(raw.identityVerified, true); assert.equal(raw.membershipVerified, true);
  assert.deepEqual(raw.target, { gameCode: "nfl", season: 2026, leagueId: "420010", teamId: "7" });
  assert.equal(raw.settings.week, 6); assert.equal(raw.roster.players[0].name, "Synthetic QB");
  assert.equal(raw.roster.playerLocksVerified, true); assert.deepEqual(raw.pending, []);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(h.output, [`${JSON.stringify({ output: path, apiReadOnly: true })}\n`]);
  assert.equal(h.accessCalls(), 1); assert.equal(h.calls.length, 5); assert.deepEqual(h.errors, []);
  assert.match(h.calls[0], /^\/users;use_login=1/); assert.match(h.calls[2], /roster;week=6/);
});

test("exclusive create refuses a race and preserves the other writer's bytes", async () => {
  const path = join(await directory(), "snapshot.json"), h = harness();
  const original = h.dependencies.refreshAccess;
  h.dependencies.refreshAccess = async () => { await writeFile(path, "racing bytes"); return original(); };
  assert.equal(await h.run(["snapshot", `--out=${path}`]), 1);
  assert.equal(await readFile(path, "utf8"), "racing bytes");
  assert.equal(h.failure().stage, "output_write"); assert.equal(h.failure().errorCode, "EEXIST");
  assert.equal(h.failure().readStatus, "completed"); assert.equal(h.failure().persistence, "incomplete");
  assert.equal(h.accessCalls(), 1); assert.equal(h.calls.length, 5); assert.deepEqual(h.output, []);
});

test("post-read write rejection emits no success and never repeats access", async () => {
  const path = join(await directory(), "snapshot.json");
  const h = harness({ writeOutput: async (destination, json, options) => {
    assert.equal(destination, path); assert.equal(JSON.parse(json).apiReadOnly, true);
    assert.deepEqual(options, { mode: 0o600, flag: "wx" });
    throw Object.assign(new Error("private filesystem path"), { code: "ENOSPC" });
  } });
  assert.equal(await h.run(["snapshot", `--out=${path}`]), 1);
  assert.equal(h.failure().stage, "output_write"); assert.equal(h.failure().errorCode, "ENOSPC");
  assert.equal(h.failure().persistence, "incomplete"); assert.equal(h.failure().readStatus, "completed");
  assert.equal(h.accessCalls(), 1); assert.equal(h.calls.length, 5); assert.deepEqual(h.output, []);
  await assert.rejects(stat(path), { code: "ENOENT" });
});

test("access and GET rejection retain only known direct/cause categories", async () => {
  const access = harness({ refreshAccess: async () => {
    throw new TypeError("fetch failed with private token", { cause: { code: "ENOTFOUND" } });
  } });
  assert.equal(await access.run(["snapshot"]), 1);
  assert.equal(access.failure().stage, "access"); assert.equal(access.failure().accessStatus, "started");
  assert.equal(access.failure().readStatus, "not_attempted"); assert.equal(access.failure().causeCode, "ENOTFOUND");
  assert.equal(access.calls.length, 0);
  let gets = 0;
  const read = harness({ getResource: async () => {
    gets += 1; throw Object.assign(new TypeError("private URL", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }), { code: "ECONNRESET" });
  } });
  assert.equal(await read.run(["snapshot"]), 1);
  assert.equal(read.failure().stage, "read_validation"); assert.equal(read.failure().accessStatus, "completed");
  assert.equal(read.failure().resourceRequests, 1); assert.equal(read.failure().errorCode, "ECONNRESET");
  assert.equal(read.failure().causeCode, "UND_ERR_CONNECT_TIMEOUT"); assert.equal(read.accessCalls(), 1); assert.equal(gets, 1);
});

test("recognized current HTTP/Retry-After codes survive without a retry", async () => {
  for (const [status, retry, expected] of [
    [401, null, "yahoo_resource_request_failed:401"],
    [429, "30", "yahoo_resource_request_failed:429:retry_after_seconds=30"],
    [503, "Mon, 12 Oct 2026 19:00:00 GMT", "yahoo_resource_request_failed:503:retry_after_at=2026-10-12T19:00:00.000Z"],
  ]) {
    let fetchCalls = 0;
    const h = harness({ getResource: (path, token) => yahooFantasyGet(path, token, async () => {
      fetchCalls += 1; return { ok: false, status, headers: { get: () => retry } };
    }) });
    assert.equal(await h.run(["snapshot"]), 1); assert.equal(h.failure().code, expected);
    assert.equal(h.failure().stage, "read_validation"); assert.equal(fetchCalls, 1);
  }
  for (const code of ["yahoo_token_request_failed:401", "yahoo_keychain_read_failed:refresh-token", "yahoo_keychain_write_failed:refresh-token"]) {
    const h = harness({ refreshAccess: async () => { throw new Error(code); } });
    assert.equal(await h.run(["snapshot"]), 1); assert.equal(h.failure().code, code); assert.equal(h.failure().stage, "access");
  }
});

test("validation failures are not diagnosed as filesystem or access failures", async () => {
  const h = harness({ getResource: async () => ({ fantasy_content: {} }) });
  assert.equal(await h.run(["snapshot"]), 1);
  assert.equal(h.failure().code, "yahoo_identity_ambiguous"); assert.equal(h.failure().stage, "read_validation");
  assert.equal(h.failure().resourceRequests, 1); assert.equal(h.failure().persistence, "not_attempted");
});

test("message, name, code, cause and forged Yahoo/Retry-After secrets never cross stderr", async () => {
  const sentinel = "PRIVATE_SENTINEL";
  for (const message of [sentinel, `yahoo_${sentinel}`, `yahoo_output_exists:${sentinel}`,
    `yahoo_keychain_read_failed:${sentinel}`, `yahoo_resource_request_failed:429:retry_after_seconds=${sentinel}`,
    `yahoo_resource_request_failed:503:retry_after_at=2026-99-12T19:00:00.000Z`,
    `yahoo_resource_request_failed:401:retry_after_seconds=30`]) {
    const error = Object.assign(new Error(message, { cause: { code: sentinel, message: sentinel, body: sentinel } }),
      { name: sentinel, code: sentinel, stack: sentinel, path: sentinel, body: sentinel });
    const h = harness({ refreshAccess: async () => { throw error; } });
    assert.equal(await h.run(["snapshot"]), 1);
    assert.equal(h.failure().code, "yahoo_operation_failed"); assert.equal(h.failure().errorType, "UNKNOWN");
    assert.equal(h.failure().errorCode, "UNKNOWN"); assert.equal(h.failure().causeCode, "UNKNOWN");
    assert.ok(!h.errors.join("").includes(sentinel)); assert.deepEqual(h.output, []);
  }
});

test("serialization failure precedes opening the output file", async t => {
  const path = join(await directory(), "snapshot.json"), h = harness();
  const stringify = JSON.stringify;
  t.mock.method(JSON, "stringify", (value, ...args) => {
    if (value?.apiReadOnly && value.roster) throw new TypeError("PRIVATE_SERIALIZATION_SENTINEL");
    return stringify(value, ...args);
  });
  assert.equal(await h.run(["snapshot", `--out=${path}`]), 1);
  assert.equal(h.failure().stage, "output_write"); assert.equal(h.failure().persistence, "not_attempted");
  assert.equal(h.failure().readStatus, "completed"); assert.equal(h.failure().errorType, "TypeError");
  await assert.rejects(stat(path), { code: "ENOENT" }); assert.deepEqual(h.output, []);
  assert.ok(!h.errors.join("").includes("PRIVATE_SERIALIZATION_SENTINEL"));
});

test("receipt failure preserves the completed artifact for local reconciliation", async () => {
  const path = join(await directory(), "snapshot.json");
  const h = harness({ stdout: () => { throw Object.assign(new Error("private stream context"), { code: "EPIPE" }); } });
  assert.equal(await h.run(["snapshot", `--out=${path}`]), 1);
  assert.equal(JSON.parse(await readFile(path, "utf8")).apiReadOnly, true);
  assert.equal(h.failure().stage, "receipt"); assert.equal(h.failure().persistence, "completed");
  assert.equal(h.failure().errorCode, "EPIPE"); assert.equal(h.accessCalls(), 1); assert.equal(h.calls.length, 5);
});

test("the actual subprocess runs planner-input offline and reports local failure stages", async () => {
  const dir = await directory(), snapshot = join(dir, "raw.json"), report = join(dir, "report.json"), output = join(dir, "planner.json");
  const h = harness();
  assert.equal(await h.run(["snapshot", `--out=${snapshot}`]), 0);
  await writeFile(report, JSON.stringify({ season: 2026, targetWeek: 6, weeks: [] }));
  const expires = new Date(Date.now() + 300_000).toISOString();
  const args = [cli, "planner-input", snapshot, report, expires];
  const result = await execFileAsync(process.execPath, [...args, `--out=${output}`]);
  assert.deepEqual(JSON.parse(result.stdout), { output, apiReadOnly: true }); assert.equal(result.stderr, "");
  const planner = JSON.parse(await readFile(output, "utf8"));
  assert.equal(planner.source, "YAHOO_VERIFIED_READBACK"); assert.equal(planner.week, 6);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(execFileAsync(process.execPath, [...args, `--out=${join(dir, "missing", "out.json")}`]), error => {
    const failure = JSON.parse(error.stderr);
    assert.equal(failure.stage, "output_preflight"); assert.equal(failure.accessStatus, "not_attempted");
    assert.equal(failure.code, "yahoo_output_directory_missing"); return error.code === 1;
  });
  await writeFile(report, "{ invalid PRIVATE_INPUT_SENTINEL");
  await assert.rejects(execFileAsync(process.execPath, [...args, `--out=${join(dir, "invalid.json")}`]), error => {
    const failure = JSON.parse(error.stderr);
    assert.equal(failure.stage, "input"); assert.equal(failure.errorType, "SyntaxError");
    assert.equal(failure.accessStatus, "not_attempted"); assert.equal(failure.resourceRequests, 0);
    assert.ok(!error.stderr.includes("PRIVATE_INPUT_SENTINEL")); return error.code === 1;
  });
});
