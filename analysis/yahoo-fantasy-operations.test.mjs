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
  assert.equal(evidence(await hp.submit(LB, null)).result, "STOP_STAGE_STALE_OR_CHANGED_NOT_CLICKED"); assert.equal(clicks(tab), 1);
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
    assert.equal((await hp.submit(jets, null)).result, "STOP_STAGE_STALE_OR_CHANGED_NOT_CLICKED"); assert.equal(clicks(tab), 0);
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
    assert.equal((await hp.submit(LB, null)).result, "STOP_STAGE_STALE_OR_CHANGED_NOT_CLICKED"); assert.equal(finals(tab, LB), 0);
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
