// Release-window browser functions for approved FA-only add/drop legs and child starts.
// createReleaseBrowser runs inside the supported persistent browser REPL from its own source
// text (releaseBrowserLoadSource), so its body must stay self-contained: no imports, Node
// globals or references to anything else in this module. All site interaction goes through
// the bound tab's goto/url and playwright domSnapshot/semantic locators.

export const RELEASE_BROWSER_VERSION = "yahoo-release-browser-2026-10-28.2";

export function createReleaseBrowser(config) {
  const VERSION = "yahoo-release-browser-2026-10-28.2";
  const { tab: T, league, team, expires: EXPIRES, waitMs: WAIT } = config ?? {};
  if (!T?.playwright || !/^[1-9][0-9]*$/.test(league ?? "") || !/^[1-9][0-9]*$/.test(team ?? "") ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(EXPIRES ?? "") || Number.isNaN(Date.parse(EXPIRES)) ||
      !Number.isSafeInteger(WAIT) || WAIT < 1000 || WAIT > 30000) throw new Error("release_browser_config_invalid");
  const PW = T.playwright, BASE = `https://football.fantasysports.yahoo.com/f1/${league}/`, TEAM = `${BASE}${team}`;
  const now = () => new Date().toISOString();
  const expired = () => Date.now() >= Date.parse(EXPIRES);
  const lines = async () => (await PW.domSnapshot()).split("\n").map(x => x.trim());
  // An iframe's own snapshot line carries only element metadata (`[id="…"] [name="…"]`; ad frames
  // put script source in name). Its rendered body follows as separate child lines, checked like
  // any other line. Only a line that parses exactly as that metadata form is reduced to its
  // trailing inline text; any other iframe line stays whole, so an unexpected shape still alarms.
  const IFRAME = /^- iframe((?: \[[a-z][a-z-]*(?:="(?:[^"\\]|\\.)*")?\])*)(?::(.*))?$/;
  const visible = x => { if (!x.startsWith("- iframe")) return x; const m = IFRAME.exec(x); return m ? (m[2] ?? "").trim() : x; };
  // Actual stop signals anywhere in the FULL snapshot, detected before any filtering or slicing.
  // Ordinary navigation/footer links are not signals; every other visible line is.
  const ALARM = /\blimit\b|\blimits\b|maximum (number of )?(adds|moves|transactions)|access denied|\bdenied\b|not (allowed|permitted|authorized)|\bforbidden\b|too many requests|try again later|temporarily (blocked|unavailable)|\brestrict(ed|ion)\b|\bsuspended\b|account (is )?locked|sign[ -]?in (is )?required|please sign in|sign in to continue|session (has )?expired|\bpassword\b|verification code|two-step|verify (it'?s|it is) you|\bcaptcha\b|unusual activity|\berror\b|something went wrong|unable to|could not be|cannot be (added|dropped|moved)|can't be (added|dropped|moved)|no longer available/i;
  const alarmCheck = (r, s) => {
    const hit = s.filter(x => !x.startsWith("- link ") && ALARM.test(visible(x)));
    r.alarmCount += hit.length; r.alarms = [...r.alarms, ...hit.map(x => x.slice(0, 200))].slice(0, 8); return hit.length > 0;
  };
  const claimish = s => s.filter(x => { const v = visible(x);
    return /waiver|claim|faab|\bbid\b/i.test(v) && !/^- generic: "?Waiver Priority: \d+(st|nd|rd|th)"?$/.test(v); }).map(x => x.slice(0, 200));
  // Bounded wait for one specific expected control or text. It decides nothing: every decision
  // is made from a fresh full snapshot taken after it returns or times out. Only Playwright's
  // TimeoutError or the exact selector-deadline wrapper is a wait result; other rejections propagate to
  // run(), which stops before any further click and halts the instance.
  const settle = async (r, locator) => {
    const t = Date.now();
    try { await locator.first().waitFor({ state: "visible", timeoutMs: WAIT }); r.waits.push(Date.now() - t); }
    catch (e) {
      const message = String(e?.message ?? e);
      if (/permission|denied|forbidden|blocked|restriction|not authorized|tool access/i.test(message) ||
          (e?.name !== "TimeoutError" && !/^(?:Error: )?Playwright selector deadline exceeded$/.test(message))) throw e;
      r.waits.push(`timeout ${Date.now() - t}`);
    }
  };
  const begin = leg => ({ v: VERSION, leg, t0: now(), alarmCount: 0, alarms: [], click: null, finalActionMayHaveOccurred: false, waits: [], trace: [] });
  // The saved ordered trace identifies the precise failing operation. Mutation entry
  // is recorded before invoking the tool, including rejected/uncertain clicks.
  const operation = async (r, name, body) => {
    const entry = { name, startedAt: now(), outcome: "started" }; r.trace.push(entry);
    try { const result = await body(); entry.outcome = "completed"; return result; }
    catch (error) { entry.outcome = "failed"; throw error; }
    finally { entry.finishedAt = now(); }
  };
  const stop = (r, result) => {
    const locatorMismatch = result === "STOP_DROP_ROW_NOT_EXACT";
    const renderMismatch = ["STOP_CONFIRMATION_MISMATCH", "STOP_SOURCE_NOT_ON_BN", "STOP_DESTINATION_NOT_EXACT_EMPTY_SLOT"].includes(result);
    if (locatorMismatch || renderMismatch) r.failure = {
      operation: r.trace.at(-1)?.name ?? null,
      category: locatorMismatch ? "PRE_FINAL_LOCATOR_COUNT_MISMATCH" : "PRE_FINAL_RENDER_MISMATCH",
    };
    r.result = result; r.t1 = now();
  };
  let last = null; // the one staged confirmation submit() may click; consumed by any stage/submit/start
  let halted = null; // any alarm, tool error or unconfirmed final action stops every later write here
  async function run(r, body, readOnly) {
    if (halted && !readOnly) { r.halted = halted; stop(r, "STOP_HALTED_AFTER_PRIOR_ALARM_OR_ERROR"); return r; }
    try { await body(r); } catch (e) {
      r.err = String(e?.message ?? e).slice(0, 160);
      r.failure = { operation: r.trace.at(-1)?.name ?? null, category: "UNKNOWN_TOOL_FAILURE" };
      stop(r, r.finalActionMayHaveOccurred ? "POSSIBLE_ACTION_RECONCILE_READ_ONLY" : "STOP_TOOL_ERROR_NO_FINAL_ACTION");
    }
    if (r.failure || r.alarmCount || r.err || /^(STOP_ALARM|POSSIBLE_)/.test(r.result)) halted ??= { leg: r.leg, result: r.result, t1: r.t1 };
    return r;
  }
  // Read-only: the current page's alarm evidence, without navigation or click.
  function inspect() {
    return run(begin("inspect"), async r => {
      const s = await lines(); r.url = await T.url();
      r.iframeMetadataLines = s.filter(x => x.startsWith("- iframe") && visible(x) !== x).length;
      stop(r, alarmCheck(r, s) ? "STOP_ALARM_OBSERVED" : "INSPECTED_NO_ALARM");
    }, true);
  }
  // Fresh goto, exact FA form, select only the exact drop, verify the exact confirmation. Never clicks the final button.
  function stage(L) {
    last = null;
    return run(begin(L.add.id), async r => {
      const final = `Add ${L.add.name}, Drop ${L.drop.name}`;
      await operation(r, "stage.navigate", () => T.goto(`${BASE}addplayer?apid=${L.add.id}`));
      await operation(r, "stage.wait-form", () => settle(r, PW.getByRole("heading", { name: "Add Free Agent", exact: true })));
      let s = await operation(r, "stage.snapshot-form", lines); r.url = await T.url();
      if (alarmCheck(r, s)) return stop(r, "STOP_ALARM_NOT_CLICKED");
      r.bad = claimish(s);
      if (!r.url.startsWith(BASE) || !s.includes('- heading "Add Free Agent" [level=2]') || !s.some(x => x.startsWith(`- heading "${L.add.name} `)) || r.bad.length) {
        r.form = s.filter(x => x.startsWith("- heading ")).slice(0, 8); return stop(r, "STOP_NOT_EXACT_FA_ADD_FORM");
      }
      // Opponent text can contain another roster player's name (Matt Gay @NY Jets).
      // Bind the row to its exact player link, and never choose first() from ambiguous rows.
      const dropRow = PW.getByRole("row").filter({ has: PW.getByRole("link", { name: L.drop.name, exact: true }) });
      r.dropRows = await operation(r, "stage.locate-drop", () => dropRow.count());
      if (r.dropRows !== 1) return stop(r, "STOP_DROP_ROW_NOT_EXACT");
      await operation(r, "stage.select-drop", () => dropRow.getByRole("button", { name: "—", exact: true }).click());
      await operation(r, "stage.wait-confirmation", () => settle(r, PW.getByRole("button", { name: final, exact: true })));
      s = await operation(r, "stage.snapshot-confirmation", lines); r.confirmUrl = await T.url();
      if (alarmCheck(r, s)) return stop(r, "STOP_ALARM_NOT_CLICKED");
      r.bad = claimish(s);
      r.buttons = s.filter(x => x.startsWith('- button "Add ')); r.week = s.filter(x => x.startsWith("- strong: Week"));
      const exact = r.confirmUrl.startsWith(BASE) && r.buttons.length === 1 && r.buttons[0].startsWith(`- button "${final}"`) &&
        r.week.length === 1 && r.week[0] === `- strong: ${L.week}` && s.some(x => x.startsWith('- heading "Player to Drop')) && !r.bad.length;
      if (exact) last = { leg: L.add.id, url: r.confirmUrl };
      stop(r, exact ? "STAGED_NOT_SUBMITTED" : "STOP_CONFIRMATION_MISMATCH");
    });
  }
  // Revalidates that the open page is exactly the last STAGED confirmation for this leg with no alarm, checks expiry,
  // clicks it once, then stages the NEXT leg fresh only after explicit success with no alarm.
  function submit(L, next) {
    const staged = last; last = null;
    return run({ ...begin(L.add.id), err: null }, async r => {
      const final = `Add ${L.add.name}, Drop ${L.drop.name}`, done = `You have successfully added ${L.add.name} and dropped ${L.drop.name}`;
      let s = await lines(); r.url = await T.url();
      if (alarmCheck(r, s)) return stop(r, "STOP_ALARM_NOT_CLICKED");
      const exact = staged?.leg === L.add.id && r.url === staged.url && r.url.startsWith(BASE) && s.filter(x => x.startsWith('- button "Add ')).length === 1 &&
        s.some(x => x.startsWith(`- button "${final}"`)) && s.filter(x => x.startsWith("- strong: Week")).join() === `- strong: ${L.week}` && !claimish(s).length;
      if (!exact) return stop(r, "STOP_STAGE_STALE_OR_CHANGED_NOT_CLICKED");
      if (expired()) return stop(r, "STOP_EXPIRED_NOT_CLICKED");
      r.click = now(); r.finalActionMayHaveOccurred = true;
      try { await operation(r, "submit.final", () => PW.getByRole("button", { name: final, exact: true }).click()); } catch (e) { r.err = String(e?.message ?? e).slice(0, 160); }
      await settle(r, PW.getByText(done, { exact: true }));
      s = await lines(); r.t1 = now();
      const alarmed = alarmCheck(r, s), shown = s.includes(`- paragraph: ${done}`);
      r.success = !r.err && !alarmed && shown;
      r.lines = [...(shown ? [`- paragraph: ${done}`] : []), ...r.alarms];
      r.result = alarmed ? "STOP_ALARM_AFTER_CLICK_POSSIBLE_SUBMISSION" : r.success ? "SUBMITTED_SUCCESS_TEXT" : "POSSIBLE_SUBMISSION_RECONCILE_READ_ONLY";
      if (r.success && next) r.next = await stage(next);
    });
  }
  // Fresh team page, exact BN source, exactly one exact empty destination, expiry, one destination click; optional next stage.
  function start(P, next) {
    last = null;
    return run(begin(`start:${P.name}`), async r => {
      const src = `Click here to edit BN ${P.name}`, dest = `Click here to edit ${P.slot}`;
      await operation(r, "start.navigate", () => T.goto(TEAM));
      await operation(r, "start.wait-source", () => settle(r, PW.getByRole("button", { name: src, exact: true })));
      let s = await operation(r, "start.snapshot-source", lines); r.url = await T.url();
      if (alarmCheck(r, s)) return stop(r, "STOP_ALARM_NOT_CLICKED");
      if (!r.url.startsWith(TEAM) || !s.some(x => x.startsWith(`- button "${src}"`))) return stop(r, "STOP_SOURCE_NOT_ON_BN");
      await operation(r, "start.select-source", () => PW.getByRole("button", { name: src, exact: true }).click());
      await operation(r, "start.wait-destination", () => settle(r, PW.getByRole("button", { name: dest, exact: true })));
      s = await operation(r, "start.snapshot-destination", lines);
      if (alarmCheck(r, s)) return stop(r, "STOP_ALARM_NOT_CLICKED");
      r.dest = s.filter(x => x.startsWith(`- button "${dest}"`));
      r.empty = s.filter(x => /^- generic: The .+ slot on your roster is empty\.$/.test(x));
      if (r.dest.length !== 1 || !r.empty.includes(`- generic: The ${P.slot} slot on your roster is empty.`)) return stop(r, "STOP_DESTINATION_NOT_EXACT_EMPTY_SLOT");
      if (expired()) return stop(r, "STOP_EXPIRED_NOT_CLICKED");
      r.click = now(); r.finalActionMayHaveOccurred = true;
      try { await operation(r, "start.final", () => PW.getByRole("button", { name: dest, exact: true }).click()); } catch (e) { r.err = String(e?.message ?? e).slice(0, 160); }
      await settle(r, PW.getByText(/^(Moved|All changes saved)/));
      s = await lines(); r.t1 = now();
      const alarmed = alarmCheck(r, s);
      r.saved = s.filter(x => /^- (text|paragraph|generic): (Moved|All changes saved)/.test(x)).slice(0, 4);
      r.result = alarmed ? "STOP_ALARM_AFTER_CLICK_POSSIBLE_SAVE" : r.err ? "POSSIBLE_SAVE_RECONCILE_READ_ONLY" : "DESTINATION_CLICKED_VERIFY_NEXT";
      if (!alarmed && !r.err && next && r.saved.length) r.next = await stage(next);
    });
  }
  return { version: VERSION, inspect, stage, submit, start };
}

// Exact text to paste into the persistent browser REPL: binds `binding` to a factory instance
// for the already-verified tab variable `tab`. Defines functions only; no navigation or click.
export function releaseBrowserLoadSource({ binding, tab, league, team, expires, waitMs }) {
  const name = /^[A-Za-z_$][\w$]*$/;
  if (!name.test(binding ?? "") || !name.test(tab ?? "")) throw new Error("release_browser_binding_invalid");
  const config = `{ tab: ${tab}, league: ${JSON.stringify(league)}, team: ${JSON.stringify(team)}, expires: ${JSON.stringify(expires)}, waitMs: ${JSON.stringify(waitMs)} }`;
  return `var ${binding} = (${createReleaseBrowser.toString()})(${config});\nnodeRepl.write(JSON.stringify({ loaded: ${binding}.version }));\n`;
}
