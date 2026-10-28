import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCli } from "./yahoo-fantasy-operations.mjs";
import { yahooFantasyGet } from "./yahoo-fantasy-readonly.mjs";
import { RELEASE_BROWSER_VERSION, createReleaseBrowser, releaseBrowserLoadSource } from "./yahoo-release-browser.mjs";

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

// Release browser functions, loaded from the exact generated REPL source against a mock tab.
// Pages are snapshot lines keyed by state; `after:<locator>` is the state a click leads to and
// `later:<state>` is what finishes rendering if the caller waits (as observed: the drop click returned
// before the confirmation rendered).
const BASE = "https://football.fantasysports.yahoo.com/f1/100200/", TEAM = `${BASE}3`, FUTURE = "2099-01-01T00:00:00.000Z";
const LB = { add: { id: "90001", name: "Avery Synthetic" }, drop: { name: "Blake Fixture" }, week: "Week 4" };
const BENCH = { add: { id: "90002", name: "Casey Example Jr." }, drop: { name: "Drew Placeholder" }, week: "Week 4" };
// Synthetic copy of the observed shape: ad iframe metadata holding escaped script source with "Error", then its child lines.
const AD = `- iframe [id="google_ads_iframe_/10000001/example/sports/fixture_top_0"] [name="1-0-1;100001;<!doctype html><html><head><script nonce=\\"c3ludGhldGlj\\">(new function _0a0b0c0d_e(){try{${"v".repeat(4000)}}catch(e){throw new Error(\\"ad limit\\")}})()</script></head></html>"]:`;
const ads = [AD, "- generic: Advertisement", AD.replace("fixture_top", "fixture_btm").replace("- iframe ", "- iframe [active] ")];
const addUrl = id => `${BASE}addplayer?apid=${id}`;
const roleKey = (role, name) => JSON.stringify({ role, opts: { name, exact: true }, filters: [] });
const dropKey = name => JSON.stringify({ role: "row", filters: [{ has: { role: "link", opts: { name, exact: true }, filters: [] } }], inner: ["button", { name: "—", exact: true }] });
const playerRow = (name, opponent = "Opponent") => [`- row "— ${name} ${opponent}":`, `  - link "${name}":`, '  - button "—"'];
const faForm = (n, rows = [...playerRow(LB.drop.name), ...playerRow(BENCH.drop.name)]) => ['- heading "Add Free Agent" [level=2]', `- heading "${n} Open player notes for ${n} Xyz - LB Sun 10:00 am vs Abc" [level=1]:`,
  '- heading "Select a player to drop" [level=4]', '- generic: "Waiver Priority: 2nd"', ...ads, ...rows];
const confirm = (a, d) => ['- heading "Add Free Agent" [level=2]', `- heading "${a} Open player notes for ${a} Xyz - LB" [level=1]:`,
  '- heading "Player to Drop Select another player" [level=4]:', "- strong: Week 4", `- button "Add ${a}, Drop ${d}"`, ...ads];
const success = (a, d) => [`- paragraph: You have successfully added ${a} and dropped ${d}`, ...ads];
const legPages = (L, extra = {}) => ({ [addUrl(L.add.id)]: faForm(L.add.name), [`after:${dropKey(L.drop.name)}`]: `confirm:${L.add.id}`,
  [`confirm:${L.add.id}`]: confirm(L.add.name, L.drop.name), [`after:${roleKey("button", `Add ${L.add.name}, Drop ${L.drop.name}`)}`]: `done:${L.add.id}`,
  [`done:${L.add.id}`]: success(L.add.name, L.drop.name), ...extra });
function browserTab(pages, deniedWaits = [], waitErrors = {}) {
  const log = []; let current = "start", waits = 0;
  const shown = chain => (pages[current] ?? []).some(x => chain.text === undefined ? x.startsWith(`- ${chain.role} "${chain.opts.name}"`)
    : chain.text instanceof RegExp ? chain.text.test(x.replace(/^- \w+: /, "")) : x.endsWith(`: ${chain.text}`));
  const rows = chain => {
    const groups = [];
    for (const line of pages[current] ?? []) {
      if (line.startsWith('- row "')) groups.push([line]);
      else if (line.startsWith("  ") && groups.length) groups.at(-1).push(line.trim());
    }
    return groups.filter(row => chain.filters.every(f => f.has
      ? row.includes(`- link "${f.has.opts.name}":`) : row.join(" ").includes(f.hasText)));
  };
  const locator = chain => ({
    toJSON: () => chain,
    count: async () => { log.push(["count", JSON.stringify(chain)]); return rows(chain).length; },
    filter: f => locator({ ...chain, filters: [...chain.filters, f.has ? { has: f.has.toJSON() } : f] }), getByRole: (role, opts) => locator({ ...chain, inner: [role, opts] }),
    first: () => locator(chain),
    waitFor: async () => { log.push(["wait"]);
      if (deniedWaits.includes(++waits)) throw new Error("PermissionDenied: browser tool access blocked by policy");
      if (waitErrors[waits]) { current = pages[`later:${current}`] ?? current; throw waitErrors[waits]; }
      current = pages[`later:${current}`] ?? current; if (!shown(chain)) throw Object.assign(new Error("Timeout 1000ms exceeded"), { name: "TimeoutError" }); },
    click: async () => { const key = JSON.stringify(chain); log.push(["click", key]);
      if (chain.role === "row" && (rows(chain).length !== 1 || !rows(chain)[0].includes(`- ${chain.inner[0]} "${chain.inner[1].name}"`)))
        throw new Error("strict mode violation or missing drop control");
      if (!pages[`after:${key}`]) throw new Error("locator.click: Timeout exceeded"); current = pages[`after:${key}`]; },
  });
  return { log,
    goto: async url => { log.push(["goto", url]); current = url; },
    url: async () => current.startsWith("http") ? current : current.startsWith("confirm") ? `${addUrl(current.slice(8))}&stage=2` : TEAM,
    playwright: { domSnapshot: async () => (pages[current] ?? []).join("\n"),
      getByRole: (role, opts) => locator({ role, opts, filters: [] }), getByText: text => locator({ text, filters: [] }) } };
}
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const loadRelease = (tab, expires = FUTURE) => new AsyncFunction("nodeRepl", "releaseTab", releaseBrowserLoadSource({
  binding: "hpv2", tab: "releaseTab", league: "100200", team: "3", expires, waitMs: 1000 }) + "return hpv2;")({ write() {} }, tab);
const finals = (tab, L) => tab.log.filter(x => x[0] === "click" && x[1] === roleKey("button", `Add ${L.add.name}, Drop ${L.drop.name}`)).length;
const clicks = tab => tab.log.filter(x => x[0] === "click").length;
// Every output keeps version, alarm evidence, final-action/click state and client timestamps.
const evidence = r => {
  assert.equal(r.v, RELEASE_BROWSER_VERSION); assert.ok(Number.isInteger(r.alarmCount) && Array.isArray(r.alarms));
  assert.equal(typeof r.finalActionMayHaveOccurred, "boolean"); assert.ok("click" in r);
  assert.ok(r.t0 <= r.t1 && !Number.isNaN(Date.parse(r.t0)) && !Number.isNaN(Date.parse(r.t1))); return r;
};

test("release browser source is versioned, self-contained and defines without navigating", async () => {
  const body = createReleaseBrowser.toString();
  assert.ok(!/\b(process|require|Buffer|globalThis|import|RELEASE_BROWSER_VERSION)\b/.test(body));
  assert.ok(body.includes(`"${RELEASE_BROWSER_VERSION}"`));
  const tab = browserTab({}), hp = await loadRelease(tab);
  assert.equal(hp.version, RELEASE_BROWSER_VERSION); assert.equal(tab.log.length, 0);
  for (const bad of [{ waitMs: 0 }, { expires: "2026-10-21T19:00Z" }, { tab: undefined }, { team: "07" }])
    assert.throws(() => createReleaseBrowser({ tab, league: "100200", team: "3", expires: FUTURE, waitMs: 1000, ...bad }), /release_browser_config_invalid/);
  assert.throws(() => releaseBrowserLoadSource({ binding: "a;b", tab: "releaseTab" }), /release_browser_binding_invalid/);
});

test("ad iframe metadata never alarms and an explicit success clicks the final button exactly once", async () => {
  const tab = browserTab({ ...legPages(LB), ...legPages(BENCH) }), hp = await loadRelease(tab);
  assert.equal(evidence(await hp.stage(LB)).result, "STAGED_NOT_SUBMITTED");
  const r = evidence(await hp.submit(LB, BENCH));
  assert.equal(r.result, "SUBMITTED_SUCCESS_TEXT"); assert.equal(r.alarmCount, 0); assert.equal(r.err, null); assert.equal(typeof r.click, "string");
  assert.deepEqual(r.lines, ["- paragraph: You have successfully added Avery Synthetic and dropped Blake Fixture"]);
  assert.equal(evidence(r.next).result, "STAGED_NOT_SUBMITTED"); assert.ok(r.next.t0 >= r.click); assert.equal(r.next.finalActionMayHaveOccurred, false);
  assert.equal(finals(tab, LB), 1); assert.equal(finals(tab, BENCH), 0);
  assert.equal(evidence(await hp.submit(LB, null)).result, "STOP_STAGE_STALE_OR_CHANGED_NOT_CLICKED"); assert.equal(finals(tab, LB), 1);
  const seen = evidence(await hp.inspect());
  assert.equal(seen.result, "INSPECTED_NO_ALARM"); assert.equal(seen.iframeMetadataLines, 2);
});

test("visible iframe content, unparsed iframe lines and top-level stop signals alarm before any final click", async () => {
  for (const signal of [[AD, "- paragraph: Error loading roster"], ['- iframe [id="frame"]: Something went wrong'],
    ['- iframe [name="1-0-45;<script>throw new Error(\\"x'], ["- paragraph: Transaction limit reached"], ["- alert: Your account is restricted"],
    ["- dialog: Verify it's you"], ['- alert: "Please sign in to continue"'], ["- paragraph: Too many requests. Try again later."]]) {
    const tab = browserTab({ ...legPages(LB), ...legPages(BENCH) }), hp = await loadRelease(tab);
    assert.equal((await hp.stage(LB)).result, "STAGED_NOT_SUBMITTED");
    tab.playwright.domSnapshot = async () => [...confirm(LB.add.name, LB.drop.name), ...signal].join("\n");
    const r = evidence(await hp.submit(LB, BENCH));
    assert.equal(r.result, "STOP_ALARM_NOT_CLICKED", signal.at(-1)); assert.equal(r.finalActionMayHaveOccurred, false);
    assert.deepEqual(r.alarms, [signal.at(-1).slice(0, 200)]); assert.equal(finals(tab, LB), 0);
    const after = evidence(await hp.stage(BENCH)); // a real stop signal halts every later write in this instance
    assert.equal(after.result, "STOP_HALTED_AFTER_PRIOR_ALARM_OR_ERROR"); assert.equal(tab.log.filter(x => x[0] === "goto").length, 1);
  }
  const tab = browserTab(legPages(LB, { [addUrl(LB.add.id)]: [...faForm(LB.add.name), "- alert: Daily add limit reached"] })), hp = await loadRelease(tab);
  assert.equal(evidence(await hp.stage(LB)).result, "STOP_ALARM_NOT_CLICKED"); assert.equal(clicks(tab), 0);
});

test("a delayed confirmation is awaited within the bound; errors during the wait stop without a final click", async () => {
  const pending = { [`after:${dropKey(LB.drop.name)}`]: "pending", pending: faForm(LB.add.name) };
  let tab = browserTab(legPages(LB, { ...pending, "later:pending": `confirm:${LB.add.id}` })), hp = await loadRelease(tab);
  let r = evidence(await hp.stage(LB));
  assert.equal(r.result, "STAGED_NOT_SUBMITTED"); assert.equal(clicks(tab), 1); assert.equal(r.waits.length, 2);
  tab = browserTab(legPages(LB, pending)); hp = await loadRelease(tab);
  r = evidence(await hp.stage(LB));
  assert.equal(r.result, "STOP_CONFIRMATION_MISMATCH"); assert.match(r.waits[1], /^timeout/);
  assert.equal(evidence(await hp.submit(LB, null)).result, "STOP_HALTED_AFTER_PRIOR_ALARM_OR_ERROR"); assert.equal(clicks(tab), 1);
  tab = browserTab(legPages(LB, { ...pending, "later:pending": "failed", failed: [...faForm(LB.add.name), "- alert: Something went wrong. Please try again later."] }));
  hp = await loadRelease(tab); r = evidence(await hp.stage(LB));
  assert.equal(r.result, "STOP_ALARM_NOT_CLICKED"); assert.equal(clicks(tab), 1);
  assert.equal((await hp.submit(LB, null)).result, "STOP_HALTED_AFTER_PRIOR_ALARM_OR_ERROR"); assert.equal(finals(tab, LB), 0);
  // The supported browser sometimes wraps its expected selector wait deadline in a generic Error.
  for (const message of ["Playwright selector deadline exceeded", "Error: Playwright selector deadline exceeded"]) {
    for (const [later, expected] of [[`confirm:${LB.add.id}`, "STAGED_NOT_SUBMITTED"], ["pending", "STOP_CONFIRMATION_MISMATCH"],
      ["failed", "STOP_ALARM_NOT_CLICKED"]]) {
      tab = browserTab(legPages(LB, { ...pending, "later:pending": later,
        failed: [...faForm(LB.add.name), "- alert: Daily add limit reached"] }), [], { 2: new Error(message) });
      hp = await loadRelease(tab); r = evidence(await hp.stage(LB));
      assert.equal(r.result, expected); assert.match(r.waits[1], /^timeout/); assert.equal(clicks(tab), 1); assert.equal(finals(tab, LB), 0);
    }
  }
  // Reproduce Matt Gay's opponent text colliding with the Jets DEF player name.
  const jets = { ...LB, drop: { name: "Jets" } };
  tab = browserTab(legPages(jets, { [addUrl(jets.add.id)]: faForm(jets.add.name,
    [...playerRow("Matt Gay", "@NY Jets"), ...playerRow("Jets", "Las Vegas")]) }));
  hp = await loadRelease(tab); r = evidence(await hp.stage(jets));
  assert.equal(r.result, "STAGED_NOT_SUBMITTED"); assert.equal(r.dropRows, 1); assert.equal(clicks(tab), 1); assert.equal(finals(tab, jets), 0);
  for (const [rows, count] of [[playerRow("Matt Gay", "@NY Jets"), 0], [playerRow("Jets Reserve"), 0],
    [[...playerRow("Jets"), ...playerRow("Jets")], 2]]) {
    tab = browserTab(legPages(jets, { [addUrl(jets.add.id)]: faForm(jets.add.name, rows) }));
    hp = await loadRelease(tab); r = evidence(await hp.stage(jets));
    assert.equal(r.result, "STOP_DROP_ROW_NOT_EXACT"); assert.equal(r.dropRows, count); assert.equal(clicks(tab), 0);
    assert.equal((await hp.submit(jets, null)).result, "STOP_HALTED_AFTER_PRIOR_ALARM_OR_ERROR"); assert.equal(clicks(tab), 0);
  }
  tab = browserTab({ [addUrl(LB.add.id)]: faForm(LB.add.name, playerRow(LB.drop.name).slice(0, -1)) }); hp = await loadRelease(tab); // exact row but missing button is a tool STOP
  r = evidence(await hp.stage(LB)); assert.equal(r.result, "STOP_TOOL_ERROR_NO_FINAL_ACTION"); assert.match(r.err, /missing drop control/); assert.equal(finals(tab, LB), 0);
});

test("expired, inexact, ambiguous or failed submissions never click or resubmit", async () => {
  let tab = browserTab(legPages(LB)), hp = await loadRelease(tab, "2026-01-01T00:00:00.000Z");
  await hp.stage(LB); let r = evidence(await hp.submit(LB, null));
  assert.equal(r.result, "STOP_EXPIRED_NOT_CLICKED"); assert.equal(r.click, null); assert.equal(finals(tab, LB), 0);
  for (const page of [[...confirm(LB.add.name, LB.drop.name), '- button "Add Avery Synthetic, Drop Drew Placeholder"'],
    confirm(LB.add.name, LB.drop.name).map(x => x.replace("Week 4", "Week 5")), [...confirm(LB.add.name, LB.drop.name), "- paragraph: Your claim will process Wednesday"]]) {
    tab = browserTab(legPages(LB, { [`confirm:${LB.add.id}`]: page })); hp = await loadRelease(tab);
    assert.equal(evidence(await hp.stage(LB)).result, "STOP_CONFIRMATION_MISMATCH");
    assert.equal((await hp.submit(LB, null)).result, "STOP_HALTED_AFTER_PRIOR_ALARM_OR_ERROR"); assert.equal(finals(tab, LB), 0);
  }
  for (const [done, expected] of [[["- paragraph: Your request is being processed"], "POSSIBLE_SUBMISSION_RECONCILE_READ_ONLY"],
    [[...success(LB.add.name, LB.drop.name), "- paragraph: Weekly add limit reached"], "STOP_ALARM_AFTER_CLICK_POSSIBLE_SUBMISSION"],
    [undefined, "POSSIBLE_SUBMISSION_RECONCILE_READ_ONLY"]]) {
    const pages = legPages(LB, { [`done:${LB.add.id}`]: done, ...legPages(BENCH) });
    if (!done) delete pages[`after:${roleKey("button", "Add Avery Synthetic, Drop Blake Fixture")}`]; // the click itself fails
    tab = browserTab(pages); hp = await loadRelease(tab); await hp.stage(LB);
    r = evidence(await hp.submit(LB, BENCH));
    assert.equal(r.result, expected); assert.equal(r.success, false); assert.equal(r.finalActionMayHaveOccurred, true); assert.equal(r.next, undefined);
    assert.equal(finals(tab, LB), 1); assert.equal(tab.log.filter(x => x[1] === addUrl(BENCH.add.id)).length, 0);
    assert.equal((await hp.stage(LB)).result, "STOP_HALTED_AFTER_PRIOR_ALARM_OR_ERROR");
    assert.equal((await hp.submit(LB, null)).result, "STOP_HALTED_AFTER_PRIOR_ALARM_OR_ERROR"); assert.equal(finals(tab, LB), 1);
  }
});

test("start awaits the exact destination and stops on alarm or expiry before the destination click", async () => {
  const src = roleKey("button", "Click here to edit BN Avery Synthetic"), dest = roleKey("button", "Click here to edit LB");
  const roster = ['- button "Click here to edit BN Avery Synthetic"', '- button "Click here to edit D Jordan Sample"', ...ads];
  const picked = ["- generic: The LB slot on your roster is empty.", '- button "Click here to edit LB"', '- button "Click here to edit D Jordan Sample"', ...ads];
  const pages = extra => ({ [TEAM]: roster, [`after:${src}`]: "picking", picking: roster, "later:picking": "picked", picked,
    [`after:${dest}`]: "saved", saved: ["- text: Moved", "- paragraph: All changes saved", ...ads], ...extra });
  let tab = browserTab(pages()), hp = await loadRelease(tab);
  let r = evidence(await hp.start({ name: "Avery Synthetic", slot: "LB" }, null));
  assert.equal(r.result, "DESTINATION_CLICKED_VERIFY_NEXT"); assert.deepEqual(r.saved, ["- text: Moved", "- paragraph: All changes saved"]);
  assert.deepEqual(tab.log.filter(x => x[0] === "click").map(x => x[1]), [src, dest]);
  tab = browserTab(pages({ picked: [...picked, "- alert: Lineup changes are not allowed"] })); hp = await loadRelease(tab);
  r = evidence(await hp.start({ name: "Avery Synthetic", slot: "LB" }, null)); assert.equal(r.result, "STOP_ALARM_NOT_CLICKED"); assert.equal(clicks(tab), 1);
  tab = browserTab(pages()); hp = await loadRelease(tab, "2026-01-01T00:00:00.000Z");
  r = evidence(await hp.start({ name: "Avery Synthetic", slot: "LB" }, null));
  assert.equal(r.result, "STOP_EXPIRED_NOT_CLICKED"); assert.equal(r.finalActionMayHaveOccurred, false); assert.equal(clicks(tab), 1);
});

test("a tool/permission denial during any bounded wait stops before further clicks and halts the instance", async () => {
  const final = roleKey("button", "Add Avery Synthetic, Drop Blake Fixture");
  for (const [denied, expected, clickCount] of [[[1], "STOP_TOOL_ERROR_NO_FINAL_ACTION", 0], [[2], "STOP_TOOL_ERROR_NO_FINAL_ACTION", 1]]) {
    const tab = browserTab(legPages(LB), denied), hp = await loadRelease(tab); // expected control stays visible
    const r = evidence(await hp.stage(LB));
    assert.equal(r.result, expected); assert.match(r.err, /^PermissionDenied: browser tool access blocked/); assert.equal(clicks(tab), clickCount);
    assert.equal((await hp.submit(LB, null)).result, "STOP_HALTED_AFTER_PRIOR_ALARM_OR_ERROR"); assert.equal(finals(tab, LB), 0);
  }
  for (const error of [new Error("PermissionDenied: Playwright selector deadline exceeded"),
    new Error("Browser Use encountered an error: Playwright selector deadline exceeded"), new Error("locator.click: Timeout exceeded"),
    Object.assign(new Error("browser tool access blocked by policy"), { name: "TimeoutError" })]) {
    const tab = browserTab(legPages(LB), [], { 2: error }), hp = await loadRelease(tab);
    const r = evidence(await hp.stage(LB));
    assert.equal(r.result, "STOP_TOOL_ERROR_NO_FINAL_ACTION"); assert.equal(r.err, error.message); assert.equal(clicks(tab), 1);
    assert.equal((await hp.submit(LB, null)).result, "STOP_HALTED_AFTER_PRIOR_ALARM_OR_ERROR"); assert.equal(finals(tab, LB), 0);
  }
  let tab = browserTab({ ...legPages(LB), ...legPages(BENCH) }, [3]), hp = await loadRelease(tab);
  assert.equal((await hp.stage(LB)).result, "STAGED_NOT_SUBMITTED");
  let r = evidence(await hp.submit(LB, BENCH)); // denied after the final click while the success text is visible
  assert.equal(r.result, "POSSIBLE_ACTION_RECONCILE_READ_ONLY"); assert.equal(r.finalActionMayHaveOccurred, true); assert.match(r.err, /PermissionDenied/);
  assert.equal(r.success, undefined); assert.equal(r.next, undefined); assert.equal(tab.log.filter(x => x[1] === final).length, 1);
  assert.equal(tab.log.filter(x => x[1] === addUrl(BENCH.add.id)).length, 0);
  assert.equal((await hp.stage(BENCH)).result, "STOP_HALTED_AFTER_PRIOR_ALARM_OR_ERROR");
  const src = roleKey("button", "Click here to edit BN Avery Synthetic"), dest = roleKey("button", "Click here to edit LB");
  const roster = ['- button "Click here to edit BN Avery Synthetic"'], picked = ["- generic: The LB slot on your roster is empty.", '- button "Click here to edit LB"'];
  const pages = { [TEAM]: roster, [`after:${src}`]: "picked", picked, [`after:${dest}`]: "saved", saved: ["- text: Moved"] };
  for (const [denied, expected, clickCount, mayHave] of [[[2], "STOP_TOOL_ERROR_NO_FINAL_ACTION", 1, false], [[3], "POSSIBLE_ACTION_RECONCILE_READ_ONLY", 2, true]]) {
    tab = browserTab(pages, denied); hp = await loadRelease(tab);
    r = evidence(await hp.start({ name: "Avery Synthetic", slot: "LB" }, LB));
    assert.equal(r.result, expected); assert.match(r.err, /PermissionDenied/); assert.equal(clicks(tab), clickCount);
    assert.equal(r.finalActionMayHaveOccurred, mayHave); assert.equal(r.next, undefined);
    assert.equal((await hp.start({ name: "Avery Synthetic", slot: "LB" }, null)).result, "STOP_HALTED_AFTER_PRIOR_ALARM_OR_ERROR"); assert.equal(clicks(tab), clickCount);
  }
});

// Bounded recovery protocol fixtures contain invented actions, names and decisions.
// They exercise the existing CLI and factory; no live access or separate runner.
const { createHash } = await import("node:crypto");
const { mkdir } = await import("node:fs/promises");
const { recoveryGate, recoveryRecord } = await import("./yahoo-fantasy-operations.mjs");
const hash = text => createHash("sha256").update(text).digest("hex");
function syntheticRosterRow(id, name, slot, teamSlug = null) {
  const control = `Click here to edit ${slot.replaceAll("/", "_")} ${name}`;
  const url = teamSlug ? `https://sports.yahoo.com/nfl/teams/${teamSlug}/` : `https://sports.yahoo.com/nfl/players/${id}`;
  return `    - row "${control} ${name}":\n      - cell "${control}":\n        - button "${control}": ${slot}\n      - cell "${name}":\n        - link "${name}":\n          - /url: ${url}`;
}
async function recoveryFixture() {
  const now = Date.now(), stamp = offset => new Date(now + offset).toISOString();
  const player = (id, name, selectedPosition) => ({ playerKey: `461.p.${id}`, name, selectedPosition,
    eligiblePositions: [selectedPosition === "BN" ? "LB" : selectedPosition], editable: "1", undroppable: "0" });
  const baseline = { apiReadOnly: true, identityVerified: true, membershipVerified: true,
    target: { gameCode: "nfl", season: 2026, leagueId: "420010", teamId: "7" }, verifiedAt: stamp(-70000),
    settings: { leagueKey, week: 4, rosterPositions: [{ position: "QB", count: 1 }, { position: "DEF", count: 1 }, { position: "LB", count: 1 }, { position: "BN", count: 6 }] },
    roster: { teamKey, week: 4, players: [player("90004", "Quarterback Synthetic", "QB"), player("90003", "Linebacker Fixture", "LB")] },
    pending: [], completedRecent: [] };
  const current = structuredClone(baseline); current.verifiedAt = stamp(-10000);
  const trace = { v: RELEASE_BROWSER_VERSION, leg: "90001", url: "https://football.fantasysports.yahoo.com/f1/420010/addplayer?apid=90001", t0: stamp(-60000), t1: stamp(-50000), click: null,
    finalActionMayHaveOccurred: false, alarmCount: 0, alarms: [], dropRows: 2, result: "STOP_DROP_ROW_NOT_EXACT",
    failure: { operation: "stage.locate-drop", category: "PRE_FINAL_LOCATOR_COUNT_MISMATCH" },
    trace: ["stage.navigate", "stage.wait-form", "stage.snapshot-form", "stage.locate-drop"].map(name =>
      ({ name, startedAt: stamp(-60000), finishedAt: stamp(-60000), outcome: "completed" })) };
  const ui = { observedAt: stamp(-9000), method: "isolated-supported-domSnapshot", url: `https://football.fantasysports.yahoo.com/f1/420010/7`,
    rows: current.roster.players.map(p => ({ id: p.playerKey.split(".").at(-1), slot: p.selectedPosition,
      line: syntheticRosterRow(p.playerKey.split(".").at(-1), p.name, p.selectedPosition) })) };
  ui.snapshot = ui.rows.map(r => r.line).join("\n");
  const conditions = Object.fromEntries(["stop", "access", "ownership", "claimsTrades", "retainedSlots", "dropSlotLegality", "eligibilityIRCapacityLimits", "officialHealthRole", "trigger", "individualLocks"].map(key => [key, `EXACT_CURRENT_${key}`]));
  const root = { type: "RECOVERY_DELEGATED", id: "synthetic-delegation", rootId: "synthetic-acquisition", jobId: "synthetic-job", executor: "sole-synthetic-executor",
    approvedBy: "Joe", status: "DELEGATED_TO_MODELS", season: 2026, leagueId: "420010", teamId: "7", week: 4,
    approvalSource: { reference: "synthetic-direct-user-decision" }, approvedAt: stamp(-120000), expiresAt: stamp(3600000),
    minimumCompletionAndVerificationMs: 60000, policyAdoptionReference: "synthetic-policy-adoption", costMode: "FA_ONLY_ZERO_COST",
    recoveryBudget: { additional: 1, total: 2, attemptId: "synthetic-acquisition-recovery-1" },
    action: { kind: "add_drop", addId: "90001", dropId: "90003", slot: "BN" }, conditions };
  const stopped = { type: "RECOVERY_INITIAL_STOP", rootId: root.rootId, jobId: root.jobId, attemptId: root.rootId,
    attempts: 1, recoveryUsed: 0, status: "PRE_FINAL_TECHNICAL_STOP", startedAt: trace.t0, factoryVersion: trace.v, factorySha256: hash("synthetic prior defective factory bytes") };
  const correction = { type: "RECOVERY_CORRECTION_ADOPTED", rootId: root.rootId, jobId: root.jobId,
    failedOperation: "stage.locate-drop", diagnosis: "synthetic duplicate row selector", defectReference: "synthetic-reproduction",
    fixReference: "synthetic-precise-selector-fix", reviewReference: "synthetic-candidate-review", adoptionReference: "synthetic-install-receipt", adoptedAt: stamp(-20000), factoryVersion: `${RELEASE_BROWSER_VERSION}-synthetic-corrected` };
  const targets = { apiReadOnly: true, identityVerified: true, membershipVerified: true, target: current.target, settings: current.settings,
    expectedWeek: 4, verifiedAt: stamp(-10000), requestCompletedAt: stamp(-10000), ownershipRequestCompletedAt: stamp(-10000), expiresAt: stamp(60000),
    players: [{ yahooId: "90001", playerKey: "461.p.90001", name: "Addition Example", ownership: "FA", ownerTeamKey: null, waiverDate: null }] };
  const preflight = { observedAt: stamp(-8000), jobId: root.jobId, rootId: root.rootId, executor: root.executor,
    conditions: Object.entries(conditions).map(([key, actual]) => ({ key, actual, source: `synthetic-official-${key}`, verifiedAt: stamp(-8000) })),
    locks: [{ id: "90001", at: stamp(3600000) }, { id: "90003", at: stamp(3600000) }],
    completionAndVerificationMs: 60000, timingBasis: "synthetic measured execution plus independent verification bound" };
  const f = { now, stamp, root, stopped, correction, baseline, current, trace, ui, targets, preflight, extra: [],
    approval: "Synthetic decision evidence; never a real approval transcript.\n", policy: "Synthetic adopted policy bytes.\n",
    factory: (await readFile(new URL("./yahoo-release-browser.mjs", import.meta.url), "utf8")).replaceAll(RELEASE_BROWSER_VERSION, correction.factoryVersion) };
  f.save = async () => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), "yahoo-recovery-")), operations = join(dir, "operations"); await mkdir(operations);
    const packet = { phase: "reserve", rootId: root.rootId, jobId: root.jobId, executor: root.executor, requestedAt: stamp(0), action: structuredClone(root.action), evidence: {} };
    for (const key of ["approval", "policy", "baseline", "current", "trace", "ui", "targets", "factory"]) {
      const bytes = typeof f[key] === "string" ? f[key] : JSON.stringify(f[key]);
      const path = join(dir, `${key}.txt`); await writeFile(path, bytes);
      packet.evidence[key] = { path, sha256: hash(bytes) };
    }
    root.approvalSource.sha256 = packet.evidence.approval.sha256; root.policySha256 = packet.evidence.policy.sha256;
    stopped.baselineSha256 = packet.evidence.baseline.sha256; stopped.traceSha256 = packet.evidence.trace.sha256;
    correction.traceSha256 = packet.evidence.trace.sha256; correction.factorySha256 = packet.evidence.factory.sha256;
    preflight.snapshotSha256 = packet.evidence.current.sha256; preflight.uiSha256 = packet.evidence.ui.sha256; preflight.targetsSha256 = packet.evidence.targets.sha256;
    const pf = JSON.stringify(preflight), pfPath = join(dir, "preflight.json"); await writeFile(pfPath, pf);
    packet.evidence.preflight = { path: pfPath, sha256: hash(pf) };
    const ledger = `# Synthetic canonical ledger\n${[root, stopped, correction, ...f.extra].map(recoveryRecord).join("")}`;
    const ledgerPath = join(operations, "decision-log.md"); await writeFile(ledgerPath, ledger);
    packet.anchor = { path: ledgerPath, sha256: hash(ledger), bytes: Buffer.byteLength(ledger), lastLine: "```" };
    return packet;
  };
  return f;
}
async function evaluateRecovery(change = () => {}) {
  const f = await recoveryFixture(); await change(f);
  const packet = await f.save(); return { f, packet, result: await recoveryGate(packet, f.now) };
}
function childRecovery(f) {
  f.root.rootId = "synthetic-child"; f.root.recoveryBudget.attemptId = "synthetic-child-recovery-1";
  f.root.action = { kind: "lineup_change", playerId: "90001", from: "BN", to: "LB", parentRootId: "synthetic-parent" };
  f.stopped.rootId = f.root.rootId; f.stopped.attemptId = f.root.rootId; f.correction.rootId = f.root.rootId; f.preflight.rootId = f.root.rootId;
  for (const snapshot of [f.baseline, f.current]) snapshot.roster.players[1] = { ...snapshot.roster.players[1], playerKey: "461.p.90001", name: "Addition Example", selectedPosition: "BN", eligiblePositions: ["LB"] };
  f.targets.players[0].ownership = "owned"; f.targets.players[0].ownerTeamKey = teamKey;
  f.ui.rows[1] = { id: "90001", slot: "BN", line: syntheticRosterRow("90001", "Addition Example", "BN") }; f.ui.snapshot = f.ui.rows.map(r => r.line).join("\n");
  f.trace.trace = ["start.navigate", "start.wait-source", "start.snapshot-source"].map(name => ({ name, startedAt: f.trace.t0, finishedAt: f.trace.t0, outcome: "completed" }));
  f.trace.result = "STOP_SOURCE_NOT_ON_BN"; f.trace.url = "https://football.fantasysports.yahoo.com/f1/420010/7"; f.trace.leg = "start:Addition Example";
  f.trace.failure = { operation: "start.snapshot-source", category: "PRE_FINAL_RENDER_MISMATCH" };
  f.correction.failedOperation = "start.snapshot-source"; f.preflight.locks = [{ id: "90001", at: f.stamp(3600000) }];
  f.extra.push({ type: "RECOVERY_VERIFIED", rootId: "synthetic-parent", jobId: f.root.jobId,
    snapshotSha256: hash(JSON.stringify(f.baseline)), addedId: "90001" });
}

// These are the 28 prepared acceptance cases, executed against the gate rather
// than a second test suite or a flags-only simulation.
const recoveryCases = [
  ["01 eligible pre-final stop requires exact reservation readback", null, "RESERVATION_REQUIRED"],
  ["02 player approval alone lacks exact delegation", f => { f.root.status = "APPROVED_BY_JOE"; }, "HOLD"],
  ["03 legacy failed attempt predates delegation", f => { f.stopped.startedAt = f.stamp(-180000); }, "HOLD"],
  ["04 reserved or consumed allowance has no third attempt", f => { f.extra.push({ type: "RECOVERY_RESERVED", rootId: f.root.rootId }); }, "HOLD"],
  ["05 missing conflicting unknown counter", f => { delete f.stopped.recoveryUsed; }, "HOLD"],
  ["06 changed executor or resumed job cannot reset budget", f => { f.stopped.jobId = "another-job"; }, "HOLD"],
  ["07 final click invoked even if roster unchanged", f => { f.trace.click = f.trace.t0; }, "HOLD"],
  ["08 unknown possible final action or trace conflict", f => { delete f.trace.finalActionMayHaveOccurred; }, "HOLD"],
  ["09 flags alone lack independently saved UI corroboration", f => { f.ui.rows = []; }, "HOLD"],
  ["10 acquired target must never be acquired again", f => { f.current.roster.players[1].playerKey = "461.p.90001"; }, "HOLD"],
  ["11 verified parent stays consumed while separately delegated child recovers", childRecovery, "RESERVATION_REQUIRED"],
  ["12 real denial owner prompt cannot recover", f => { f.trace.err = "PermissionDenied: MFA required"; }, "HOLD"],
  ["13 account rate limit remains stopped after Retry-After expires", f => { f.trace.err = "rate limit Retry-After expired"; }, "HOLD"],
  ["14 API read output validation failure excluded", f => { f.stopped.status = "API_OUTPUT_FAILED"; }, "HOLD"],
  ["15 canonical ledger failure never recovers", f => { f.extra.push({ type: "LEDGER_WRITE_FAILED", rootId: f.root.rootId }); }, "HOLD"],
  ["16 original expiry or lock passed", f => { f.root.expiresAt = f.stamp(-1); }, "HOLD"],
  ["17 insufficient execution and independent verification time", f => { f.preflight.completionAndVerificationMs = 3600000; }, "HOLD"],
  ["18 W other-owned unknown identity cannot convert FA authority", f => { f.targets.players[0].ownership = "W"; }, "HOLD"],
  ["19 changed claims slots health role trigger capacity retained facts", f => { f.preflight.conditions.find(c => c.key === "officialHealthRole").actual = "CHANGED"; }, "HOLD"],
  ["20 unresolved or unadopted correction", f => { delete f.correction.adoptionReference; }, "HOLD"],
  ["21 installed factory source/version unverified", f => { f.correction.factoryVersion = "unreviewed-version"; }, "HOLD"],
  ["22 unconfirmed child destination save never replayed", f => { childRecovery(f); f.trace.finalActionMayHaveOccurred = true; }, "HOLD"],
  ["23 failed second attempt spends allowance before any click", f => { f.extra.push({ type: "RECOVERY_RESULT", rootId: f.root.rootId, status: "PRE_FINAL_TECHNICAL_STOP" }); }, "HOLD"],
  ["24 technical failure cannot select approved alternative", f => { f.preflight.conditions.find(c => c.key === "trigger").actual = "TECHNICAL_FALLBACK"; }, "HOLD"],
  ["25 future package has no inherited recoveryBudget", f => { delete f.root.recoveryBudget; }, "HOLD"],
  ["26 PR repair approval alone is not adopted recovery delegation", f => { delete f.root.policyAdoptionReference; }, "HOLD"],
  ["27 exact separate correction adoption still needs all gates", f => { f.correction.adoptionReference = "synthetic-separate-reviewed-install"; }, "RESERVATION_REQUIRED"],
  ["28 cloud backstop or heartbeat cannot duplicate executor", f => { f.extra.push({ ...f.root, executor: "backstop" }); }, "HOLD"],
];
for (const [name, mutate, verdict] of recoveryCases) test(`bounded recovery ${name}`, async () => {
  const { result } = await evaluateRecovery(mutate ?? (() => {})); assert.equal(result.verdict, verdict, JSON.stringify(result));
  assert.equal(result.offline, true); assert.equal(result.transactionReady, false);
});

test("recovery reserve/check CLI never accesses Yahoo and exact appended bytes are mandatory", async () => {
  const { f, packet, result } = await evaluateRecovery();
  assert.equal(result.verdict, "RESERVATION_REQUIRED");
  const requestPath = join(dirnamePath(packet.anchor.path), "request.json");
  const h = harness(); await writeFile(requestPath, JSON.stringify(packet));
  assert.equal(await h.run(["recovery-gate", requestPath]), 0, h.errors.join(""));
  const fromCli = JSON.parse(h.output[0]); assert.equal(fromCli.event, result.event);
  assert.equal(h.accessCalls(), 0); assert.equal(h.calls.length, 0);
  packet.phase = "check"; packet.reservedLedgerSha256 = result.reservedLedgerSha256;
  const old = await readFile(packet.anchor.path); await writeFile(packet.anchor.path, Buffer.concat([old, Buffer.from(result.event)]));
  assert.equal((await recoveryGate(packet, f.now)).verdict, "RESERVED_READBACK_EXACT");
  // A duplicate reservation, trailing append or competing write is not exact readback.
  await writeFile(packet.anchor.path, Buffer.concat([old, Buffer.from(result.event + result.event)]));
  packet.reservedLedgerSha256 = hash(await readFile(packet.anchor.path));
  assert.equal((await recoveryGate(packet, f.now)).reason, "RESERVATION_READBACK_INEXACT");
  // Resume from the now-canonical reservation cannot mint a new budget/anchor.
  const changed = await readFile(packet.anchor.path); packet.phase = "reserve";
  packet.anchor = { ...packet.anchor, bytes: changed.length, sha256: hash(changed) };
  assert.equal((await recoveryGate(packet, f.now)).verdict, "HOLD");
});
const dirnamePath = path => join(path, "..");

test("recovery missing evidence hashes, secret-shaped inputs and hash drift fail sanitized without access", async () => {
  const { packet } = await evaluateRecovery();
  for (const patch of [p => { p.evidence.current.path = "/private/tmp/credentials-fixture"; }, p => { p.evidence.current.sha256 = "0".repeat(64); }]) {
    const input = structuredClone(packet); patch(input);
    const path = join(dirnamePath(packet.anchor.path), `packet-${Math.random()}.json`); await writeFile(path, JSON.stringify(input));
    const h = harness(); assert.equal(await h.run(["recovery-gate", path]), 1);
    assert.equal(h.failure().code, "yahoo_recovery_evidence_invalid"); assert.equal(h.accessCalls(), 0); assert.equal(h.calls.length, 0);
    assert.ok(!h.errors.join("").includes("credentials-fixture"));
  }
});

test("recovery shared budget rejects unknown counter conflicts and per-option reset attempts", async () => {
  for (const mutate of [f => { f.extra.push({ ...f.stopped, recoveryUsed: 0 }); }, f => { f.stopped.recoveryUsed = 1; },
    f => { f.extra.push({ type: "RECOVERY_RESERVED", rootId: f.root.rootId, jobId: "previous-native-session", option: "earlier-option" }); }]) {
    assert.equal((await evaluateRecovery(mutate)).result.verdict, "HOLD");
  }
});

test("recovery all material preflight facts, independent evidence and locks fail closed individually", async () => {
  const mutations = [
    f => { f.targets.players[0].ownership = "owned"; f.targets.players[0].ownerTeamKey = "461.l.420010.t.99"; },
    f => { f.targets.players[0].ownership = "UNKNOWN"; }, f => { f.targets.players[0].playerKey = "461.p.90099"; },
    f => { f.targets.verifiedAt = f.stamp(-600000); }, f => { f.current.pending = [{ type: "trade" }]; },
    f => { f.current.roster.players[0].selectedPosition = "BN"; }, f => { f.current.completedRecent = [{ players: [{ playerKey: "461.p.90001" }], timestamp: String(Math.floor(f.now / 1000)) }]; },
    f => { f.preflight.locks[0].at = f.stamp(-1); }, f => { f.preflight.locks[1].at = f.stamp(-1); },
    f => { f.preflight.completionAndVerificationMs = null; }, f => { f.preflight.completionAndVerificationMs = 1; }, f => { f.ui.observedAt = f.stamp(-600000); },
    f => { f.trace.trace = []; }, f => { f.trace.trace.push({ ...f.trace.trace.at(-1), name: "submit.final" }); },
    f => { f.trace.trace[1].outcome = "failed"; }, f => { f.stopped.status = "EXECUTION_FAILED"; },
    f => { f.stopped.status = "VERIFY_FAILED"; }, f => { f.stopped.status = "BLOCKED_OWNER_ACTION"; },
    f => { childRecovery(f); f.extra = []; }, f => { f.extra.push({ type: "RECOVERY_JOB_STOP", jobId: f.root.jobId, rootId: "other-action", reason: "ACCOUNT_RATE_LIMIT" }); }, f => { f.root.conditions.stop = true; }, f => { f.stopped.factorySha256 = hash(f.factory); }, f => { f.correction.factoryVersion = f.stopped.factoryVersion; },
    ...["claimsTrades", "retainedSlots", "dropSlotLegality", "eligibilityIRCapacityLimits", "officialHealthRole", "trigger", "individualLocks", "stop", "access", "ownership"].map(key => f => { f.preflight.conditions.find(c => c.key === key).actual = "UNKNOWN"; }),
  ];
  for (const mutate of mutations) assert.equal((await evaluateRecovery(mutate)).result.verdict, "HOLD");
});

test("factory trace records every pre-final stage operation and final invocation before tool call", async () => {
  const tab = browserTab(legPages(LB)), hp = await loadRelease(tab);
  const staged = await hp.stage(LB); assert.equal(staged.result, "STAGED_NOT_SUBMITTED");
  assert.deepEqual(staged.trace.map(t => t.name), ["stage.navigate", "stage.wait-form", "stage.snapshot-form", "stage.locate-drop", "stage.select-drop", "stage.wait-confirmation", "stage.snapshot-confirmation"]);
  assert.ok(staged.trace.every(t => t.outcome === "completed" && Date.parse(t.startedAt) <= Date.parse(t.finishedAt)));
  const submitted = await hp.submit(LB); assert.equal(submitted.trace[0].name, "submit.final"); assert.equal(submitted.finalActionMayHaveOccurred, true);
});

test("recovery saved UI reuses factory visible alarms rather than ad metadata", async () => {
  const accepted = await evaluateRecovery(f => { f.ui.snapshot += `\n${AD}`; });
  assert.equal(accepted.result.verdict, "RESERVATION_REQUIRED");
  const denied = await evaluateRecovery(f => { f.ui.snapshot += `${AD}\n  - generic: Access denied`; });
  assert.equal(denied.result.verdict, "HOLD");
});

function observedDefenseRows(f, defense = "Jets") {
  const [id, slug] = defense === "Jets" ? ["100020", "ny-jets"] : ["100030", "jacksonville"];
  for (const snapshot of [f.baseline, f.current]) {
    snapshot.roster.players[1] = { ...snapshot.roster.players[1], playerKey: `461.p.${id}`, name: defense, selectedPosition: "DEF", eligiblePositions: ["DEF"], displayPosition: "DEF" };
    snapshot.roster.players.push({ playerKey: "461.p.90005", name: "Matt Gay", selectedPosition: "BN", eligiblePositions: ["K"], displayPosition: "K", editable: "1", undroppable: "0" });
  }
  f.root.action.dropId = id; f.preflight.locks[1].id = id;
  f.ui.rows[1] = { id, slot: "DEF", line: syntheticRosterRow(id, defense, "DEF", slug) };
  f.ui.rows.push({ id: "90005", slot: "BN", line: `${syntheticRosterRow("90005", "Matt Gay", "BN")}\n        - link "Jets":\n          - /url: https://sports.yahoo.com/nfl/teams/ny-jets/` });
  f.ui.snapshot = f.ui.rows.map(row => row.line).join("\n");
}

test("recovery exact DEF team links support Jets/Jaguars without binding Matt Gay opponent text", async () => {
  for (const name of ["Jets", "Jaguars"]) {
    const accepted = await evaluateRecovery(f => observedDefenseRows(f, name));
    assert.equal(accepted.result.verdict, "RESERVATION_REQUIRED", JSON.stringify(accepted.result));
  }
  const wrongRow = await evaluateRecovery(f => { observedDefenseRows(f); f.ui.rows[1].line = f.ui.rows[2].line; });
  assert.equal(wrongRow.result.reason, "UI_STATE_UNKNOWN");
});

test("recovery DEF links require exact known ID/name/slug; no unknown or substring identity fallback", async () => {
  const changes = [
    f => { f.ui.rows[1].line = f.ui.rows[1].line.replace("ny-jets/", "ny-jets-other/"); },
    f => { f.ui.rows[1].line = f.ui.rows[1].line.replace("ny-jets/", "jacksonville/"); },
    f => { for (const s of [f.baseline, f.current]) s.roster.players[1].name = "Jets Other"; },
    f => { for (const s of [f.baseline, f.current]) s.roster.players[1].playerKey = "461.p.100099"; f.ui.rows[1].id = "100099"; f.root.action.dropId = "100099"; f.preflight.locks[1].id = "100099"; },
    f => { f.ui.rows[1].line = '- row "Jets" DEF /players/100020'; },
  ];
  for (const change of changes) {
    const { result } = await evaluateRecovery(f => { observedDefenseRows(f); change(f); f.ui.snapshot = f.ui.rows.map(row => row.line).join("\n"); });
    assert.equal(result.reason, "UI_STATE_UNKNOWN");
  }
});

test("factory emits structured pre-final locator/render failures and excludes thrown snapshot errors", async () => {
  const dup = [...playerRow(LB.drop.name), ...playerRow(LB.drop.name)];
  let tab = browserTab(legPages(LB, { [addUrl(LB.add.id)]: faForm(LB.add.name, dup) })), hp = await loadRelease(tab);
  let result = await hp.stage(LB);
  assert.deepEqual(result.failure, { operation: "stage.locate-drop", category: "PRE_FINAL_LOCATOR_COUNT_MISMATCH" });
  assert.ok(result.trace.every(entry => entry.outcome === "completed"));
  tab = browserTab({ [TEAM]: [] }); hp = await loadRelease(tab);
  result = await hp.start({ name: "Avery Synthetic", slot: "LB" });
  assert.deepEqual(result.failure, { operation: "start.snapshot-source", category: "PRE_FINAL_RENDER_MISMATCH" });
  tab = browserTab(legPages(LB)); tab.playwright.domSnapshot = async () => { throw new Error("Synthetic snapshot read/service failure"); }; hp = await loadRelease(tab);
  result = await hp.stage(LB);
  assert.deepEqual(result.failure, { operation: "stage.snapshot-form", category: "UNKNOWN_TOOL_FAILURE" });
  assert.equal(result.trace.at(-1).outcome, "failed"); assert.equal(result.finalActionMayHaveOccurred, false);
});

test("recovery excludes unknown snapshot/read/service exceptions without parsing error messages", async () => {
  for (const op of ["stage.wait-form", "stage.snapshot-form", "stage.select-drop", "stage.snapshot-confirmation"]) {
    const { result } = await evaluateRecovery(f => {
      const sequence = ["stage.navigate", "stage.wait-form", "stage.snapshot-form", "stage.locate-drop", "stage.select-drop", "stage.wait-confirmation", "stage.snapshot-confirmation"];
      f.trace.trace = sequence.slice(0, sequence.indexOf(op) + 1).map(name => ({ name, startedAt: f.trace.t0, finishedAt: f.trace.t0, outcome: name === op ? "failed" : "completed" }));
      f.trace.result = "STOP_TOOL_ERROR_NO_FINAL_ACTION";
      f.trace.failure = { operation: op, category: "UNKNOWN_TOOL_FAILURE" }; f.correction.failedOperation = op;
      // No error string at all: structured unknown failure remains ineligible.
      delete f.trace.err;
    });
    assert.equal(result.verdict, "HOLD");
  }
});

// Formal-review reproducers, adapted to the confirmed indented '- /url:' shape.
test("REPRO-A bench DEF cannot alias a bench player's opponent link or share its row", async () => {
  const { result } = await evaluateRecovery(f => {
    observedDefenseRows(f);
    for (const snapshot of [f.baseline, f.current]) snapshot.roster.players[1].selectedPosition = "BN";
    f.ui.rows[1] = { id: "100020", slot: "BN", line: f.ui.rows[2].line };
    f.ui.snapshot = [f.ui.rows[0].line, f.ui.rows[2].line].join("\n");
  });
  assert.equal(result.reason, "UI_STATE_UNKNOWN");
});

test("REPRO-B exact indented row boundaries cannot borrow the next row's slot", async () => {
  const { result } = await evaluateRecovery(f => {
    const span = `${syntheticRosterRow("90003", "Linebacker Fixture", "BN")}\n    - row "LB Empty":\n      - cell "LB"`;
    f.ui.rows[1].line = span;
    f.ui.snapshot = [f.ui.rows[0].line, span].join("\n");
  });
  assert.equal(result.reason, "UI_STATE_UNKNOWN");
});

test("REPRO-C redirected stage/start/confirmation traces never qualify as render failure", async () => {
  for (const mutate of [
    f => { childRecovery(f); f.trace.url = "https://login.yahoo.com/consent"; },
    f => { f.trace.url = "https://example.test/redirect"; },
    f => { childRecovery(f); f.trace.url = "https://football.fantasysports.yahoo.com/f1/420010/72"; },
    f => {
      f.trace.result = "STOP_CONFIRMATION_MISMATCH"; f.trace.confirmUrl = "https://login.yahoo.com/consent";
      f.trace.trace = ["stage.navigate", "stage.wait-form", "stage.snapshot-form", "stage.locate-drop", "stage.select-drop", "stage.wait-confirmation", "stage.snapshot-confirmation"].map(name => ({ name, startedAt: f.trace.t0, finishedAt: f.trace.t0, outcome: "completed" }));
      f.trace.failure = { operation: "stage.snapshot-confirmation", category: "PRE_FINAL_RENDER_MISMATCH" };
    },
  ]) assert.equal((await evaluateRecovery(mutate)).result.reason, "TRACE_CONTEXT_UNKNOWN");
});

test("REPRO-D same action/job under another root cannot reset budget, even with reordered action fields", async () => {
  for (const type of ["RECOVERY_DELEGATED", "RECOVERY_RESERVED", "RECOVERY_RESULT"]) {
    const { result } = await evaluateRecovery(f => {
      const action = { slot: f.root.action.slot, dropId: f.root.action.dropId, addId: f.root.action.addId, kind: f.root.action.kind };
      f.extra.push({ type, rootId: "earlier-alias-root", jobId: f.root.jobId, action, recoveryUsed: 1, status: "PRE_FINAL_TECHNICAL_STOP" });
    });
    assert.equal(result.reason, "ACTION_JOB_ALREADY_RECORDED");
  }
});

test("REPRO-E stage and child traces must identify the exact approved leg", async () => {
  for (const mutate of [f => { f.trace.leg = "99999"; }, f => { childRecovery(f); f.trace.leg = "start:Different Synthetic"; }])
    assert.equal((await evaluateRecovery(mutate)).result.reason, "TRACE_LEG_CHANGED");
});

test("REPRO-F every identity-linked UI row must match the saved roster one to one", async () => {
  const { result } = await evaluateRecovery(f => { f.ui.snapshot += `\n${syntheticRosterRow("90001", "Addition Example", "BN")}`; });
  assert.equal(result.reason, "UI_STATE_UNKNOWN");
});

test("confirmed editable row format supports slash-slot labels and missing controls HOLD", async () => {
  const accepted = await evaluateRecovery(f => {
    for (const snapshot of [f.baseline, f.current]) {
      snapshot.settings.rosterPositions.push({ position: "W/R/T", count: 1 });
      snapshot.roster.players[0].selectedPosition = "W/R/T";
    }
    f.ui.rows[0] = { id: "90004", slot: "W/R/T", line: syntheticRosterRow("90004", "Quarterback Synthetic", "W/R/T") };
    f.ui.snapshot = f.ui.rows.map(row => row.line).join("\n");
  });
  assert.equal(accepted.result.verdict, "RESERVATION_REQUIRED");
  const pending = await evaluateRecovery(f => {
    f.ui.rows[1].line = f.ui.rows[1].line.replace('        - button "Click here to edit LB Linebacker Fixture": LB\n', "");
    f.ui.snapshot = f.ui.rows.map(row => row.line).join("\n");
  });
  assert.equal(pending.result.reason, "UI_STATE_UNKNOWN");
});

test("all structured locator/render stops permanently halt old stage/submit/start without tool activity", async () => {
  const src = roleKey("button", "Click here to edit BN Avery Synthetic");
  const scenarios = [
    { pages: legPages(LB, { [addUrl(LB.add.id)]: faForm(LB.add.name, [...playerRow(LB.drop.name), ...playerRow(LB.drop.name)]) }), call: hp => hp.stage(LB), stop: "STOP_DROP_ROW_NOT_EXACT" },
    { pages: legPages(LB, { [`after:${dropKey(LB.drop.name)}`]: "pending", pending: faForm(LB.add.name) }), call: hp => hp.stage(LB), stop: "STOP_CONFIRMATION_MISMATCH" },
    { pages: { [TEAM]: [] }, call: hp => hp.start({ name: "Avery Synthetic", slot: "LB" }), stop: "STOP_SOURCE_NOT_ON_BN" },
    { pages: { [TEAM]: ['- button "Click here to edit BN Avery Synthetic"'], [`after:${src}`]: "picked", picked: [] }, call: hp => hp.start({ name: "Avery Synthetic", slot: "LB" }), stop: "STOP_DESTINATION_NOT_EXACT_EMPTY_SLOT" },
  ];
  for (const scenario of scenarios) {
    const tab = browserTab(scenario.pages), hp = await loadRelease(tab), stopped = await scenario.call(hp);
    assert.equal(stopped.result, scenario.stop); assert.ok(stopped.failure); const log = structuredClone(tab.log);
    for (const call of [() => hp.stage(LB), () => hp.submit(LB), () => hp.start({ name: "Avery Synthetic", slot: "LB" })]) {
      assert.equal((await call()).result, "STOP_HALTED_AFTER_PRIOR_ALARM_OR_ERROR"); assert.deepEqual(tab.log, log);
    }
  }
});

test("known locked retained row uses exact plain slot cell; source/drop remains editable", async () => {
  const locked = f => {
    for (const snapshot of [f.baseline, f.current]) snapshot.roster.players[0].editable = "0";
    f.ui.rows[0].line = f.ui.rows[0].line.replace('      - cell "Click here to edit QB Quarterback Synthetic":\n        - button "Click here to edit QB Quarterback Synthetic": QB', '      - cell "QB":\n        - generic: QB');
    f.ui.snapshot = f.ui.rows.map(row => row.line).join("\n");
  };
  assert.equal((await evaluateRecovery(locked)).result.verdict, "RESERVATION_REQUIRED");
  for (const change of [
    f => { f.ui.rows[0].line = f.ui.rows[0].line.replace('- generic: QB', '- generic: BN'); },
    f => { for (const snapshot of [f.baseline, f.current]) snapshot.roster.players[0].editable = "1"; },
    f => { for (const snapshot of [f.baseline, f.current]) snapshot.roster.players[1].editable = "0"; },
  ]) {
    const { result } = await evaluateRecovery(f => { locked(f); change(f); f.ui.snapshot = f.ui.rows.map(row => row.line).join("\n"); });
    assert.equal(result.verdict, "HOLD");
  }
});
