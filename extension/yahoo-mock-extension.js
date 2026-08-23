(function installYahooMockExtension(root) {
  "use strict";

  const VERSION = "0.6.2";
  const GLOBAL_KEY = "__skrodzkaiYahooMockExtensionV1";
  const PREFLIGHT_KEY = "skrodzkai-yahoo-mock-extension-preflight-v1";
  const RECEIPT_KEY = "skrodzkai-yahoo-mock-extension-receipts-v1";
  const RUNNER_RECEIPT_KEY = "skrodzkai-yahoo-mock-runner-receipts-v1";
  const CONTROLLER_RECEIPT_KEY = "skrodzkai-yahoo-draft-controller-receipts-v1";
  const MANUAL_STAGE_KEY = "skrodzkai-yahoo-mock-manual-stage-v1";
  const TEST_SETTINGS_KEY = "skrodzkai-yahoo-test-settings-v1";
  const PREFLIGHT_TTL_MS = 30 * 60 * 1000;
  const DISABLED_LEAGUE_ID = "420010";
  const TEST_LEAGUE_ID = "18599";
  const TEST_TEAM_ID = 12;
  const PUBLIC_ROSTER_SLOTS = Object.freeze([
    "QB", "WR", "WR", "RB", "RB", "TE", "W/R/T", "K", "DEF",
    "BN", "BN", "BN", "BN", "BN", "BN",
  ]);
  const STARTER_SLOTS = Object.freeze(PUBLIC_ROSTER_SLOTS.slice(0, 9));
  const TEST_ROSTER_SLOTS = Object.freeze([
    "QB", "WR", "WR", "RB", "RB", "W/R", "W/R/T", "K", "DEF",
    "D", "LB", "CB", "S", "BN", "BN", "BN", "BN", "BN", "BN",
  ]);
  const TEST_SETTINGS_ROSTER_SLOTS = Object.freeze([...TEST_ROSTER_SLOTS, "IR", "IR", "IR"]);
  const TEST_FILTER_LABELS = Object.freeze([
    "Kickers", "Team Defenses", "Defensive Players", "Linebackers", "Cornerbacks", "Safeties",
  ]);

  function modeAllowlist({ mode = "MOCK", leagueId = "" } = {}) {
    const normalizedMode = String(mode ?? "").trim().toUpperCase();
    const normalizedLeague = String(leagueId ?? "").trim();
    if (normalizedMode === "REAL") return { allowed: false, reason: "REAL mode is hard-disabled" };
    if (normalizedLeague === DISABLED_LEAGUE_ID) {
      return { allowed: false, reason: `league ${DISABLED_LEAGUE_ID} is hard-disabled` };
    }
    if (!["MOCK", "TEST"].includes(normalizedMode)) {
      return { allowed: false, reason: "mode is not allowlisted" };
    }
    return { allowed: true, mode: normalizedMode, leagueId: normalizedLeague };
  }

  function validateExactYahooTargets(targets) {
    if (!Array.isArray(targets) || targets.length === 0) throw new Error("manual stage requires at least one target");
    const seen = new Set();
    return targets.map((target, index) => {
      const yahooId = String(target?.yahooId ?? "").trim();
      if (!/^\d+$/.test(yahooId)) throw new Error(`manual target ${index} requires an exact Yahoo ID`);
      if (seen.has(yahooId)) throw new Error(`manual target ${yahooId} is duplicated`);
      seen.add(yahooId);
      return {
        yahooId,
        name: String(target?.name ?? ""),
        position: normalize(target?.position),
        team: normalize(target?.team),
      };
    });
  }

  function stageManualTargets(storage, targets, room, now = new Date().toISOString()) {
    const staged = validateExactYahooTargets(targets);
    const stage = { at: now, roomId: String(room?.roomId ?? ""), seat: Number(room?.seat), expectedRound: Number(room?.expectedRound), targets: staged };
    if (!stage.roomId || !Number.isInteger(stage.seat) || !Number.isInteger(stage.expectedRound) || stage.expectedRound < 1) {
      throw new Error("manual pin requires exact room, seat, and next round");
    }
    storage.setItem(MANUAL_STAGE_KEY, JSON.stringify(stage));
    return stage;
  }

  function normalize(value) {
    return String(value ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9/]+/g, " ")
      .trim()
      .toUpperCase();
  }

  function sameSlots(left, right) {
    const a = Array.from(left ?? [], normalize);
    const b = Array.from(right ?? [], normalize);
    return a.length === b.length && a.every((slot, index) => slot === b[index]);
  }

  function parseSequentialTeamCount(bodyText) {
    let best = 0;
    for (const line of String(bodyText ?? "").split("\n")) {
      const tokens = line.trim().split(/\s+/).filter(Boolean);
      for (let start = 0; start < tokens.length; start += 1) {
        if (tokens[start] !== "1") continue;
        let count = 1;
        while (tokens[start + count] === String(count + 1)) count += 1;
        best = Math.max(best, count);
      }
    }
    return best;
  }

  function parseRosterSlots(bodyText) {
    const lines = String(bodyText ?? "").split("\n").map((line) => line.trim());
    const heading = lines.findIndex((line) => normalize(line).startsWith("ROSTER POSITIONS"));
    if (heading < 0) return [];
    const inline = lines[heading].replaceAll("\u00a0", " ").match(/^Roster\s+Positions\s*[:\t]\s*(.+)$/i)?.[1];
    const raw = inline ?? lines.slice(heading + 1).find(Boolean) ?? "";
    const starters = raw.split(",").map((slot) => normalize(slot)).filter(Boolean);
    if (sameSlots(starters, STARTER_SLOTS)) return [...starters, ...Array(6).fill("BN")];
    return starters;
  }

  function parseTestSettings(documentRef, locationRef) {
    const body = String(documentRef?.body?.innerText ?? "");
    const teamCount = Number(body.match(/Max Teams:\s*(\d+)/i)?.[1] ?? 0);
    const rosterSlots = parseRosterSlots(body);
    const errors = [];
    if (String(locationRef?.pathname ?? "") !== `/f1/${TEST_LEAGUE_ID}/settings`) errors.push("not_verified_test_settings");
    if (!body.includes("League Name:\tHORSE COLLAR #2")) errors.push("verified_test_league_missing");
    if (!body.includes("Draft Type:\tLive Standard Draft")) errors.push("verified_test_draft_type_mismatch");
    if (!body.includes("Live Draft Pick Time:\t1 Minute, 15 Seconds")) errors.push("verified_test_clock_mismatch");
    if (!/Passing Touchdowns\s+4\b/i.test(body)) errors.push("verified_test_passing_td_mismatch");
    if (!/Receptions(?:\s+Yahoo Default)?\s+1(?:\s|$)/i.test(body)) errors.push("verified_test_ppr_mismatch");
    if (teamCount !== 12) errors.push("test_team_count_not_12");
    if (!sameSlots(rosterSlots, TEST_SETTINGS_ROSTER_SLOTS)) errors.push("test_roster_shape_mismatch");
    return { roomId: TEST_LEAGUE_ID, teamCount, rosterSlots, activeRosterSlots: rosterSlots.slice(0, TEST_ROSTER_SLOTS.length), errors, ready: errors.length === 0 };
  }

  function makeTestSettingsReceipt(snapshot, now = Date.now()) {
    if (!snapshot?.ready) throw new Error("verified test settings are not ready");
    return {
      version: VERSION,
      roomId: TEST_LEAGUE_ID,
      observedTeamCount: snapshot.teamCount,
      observedRosterSlots: [...snapshot.activeRosterSlots],
      observedFullRosterSlots: [...snapshot.rosterSlots],
      verifiedAt: now,
      expiresAt: now + 4 * 60 * 60 * 1000,
    };
  }

  function validTestSettingsReceipt(receipt, now = Date.now()) {
    return Boolean(
      receipt &&
      receipt.roomId === TEST_LEAGUE_ID &&
      Number(receipt.observedTeamCount) === 12 &&
      Number(receipt.expiresAt) > now &&
      sameSlots(receipt.observedRosterSlots, TEST_ROSTER_SLOTS) &&
      sameSlots(receipt.observedFullRosterSlots, TEST_SETTINGS_ROSTER_SLOTS)
    );
  }

  function parseWaitingRoom(documentRef, locationRef) {
    const body = String(documentRef?.body?.innerText ?? "");
    const params = new URLSearchParams(String(locationRef?.search ?? ""));
    const roomId = String(params.get("mlid") ?? "");
    const seatMatch = body.match(/You will draft\s+(\d+)(?:st|nd|rd|th)\b/i);
    const seat = seatMatch ? Number(seatMatch[1]) : null;
    const teamCount = parseSequentialTeamCount(body);
    const rosterSlots = parseRosterSlots(body);
    const errors = [];
    if (String(locationRef?.pathname ?? "") !== "/f1/mock_waiting") errors.push("not_public_mock_waiting_room");
    if (!/^\d+$/.test(roomId)) errors.push("mock_room_id_missing");
    if (!Number.isInteger(seat) || seat < 1 || seat > 12) errors.push("mock_seat_missing");
    if (teamCount !== 12) errors.push("mock_team_count_not_12");
    if (!sameSlots(rosterSlots, PUBLIC_ROSTER_SLOTS)) errors.push("mock_roster_shape_mismatch");
    if (roomId === DISABLED_LEAGUE_ID) errors.push("league_420010_hard_disabled");
    return { roomId, seat, teamCount, rosterSlots, errors, ready: errors.length === 0 };
  }

  function makePreflight(snapshot, now = Date.now()) {
    if (!snapshot?.ready) throw new Error("public mock waiting-room preflight is not ready");
    return {
      version: VERSION,
      mode: "public_mock_15",
      roomId: snapshot.roomId,
      seat: snapshot.seat,
      observedTeamCount: snapshot.teamCount,
      observedRosterSlots: snapshot.rosterSlots,
      armedAt: now,
      expiresAt: now + PREFLIGHT_TTL_MS,
    };
  }

  function parseTestDraftHome(documentRef, locationRef, settingsReceipt = null, now = Date.now()) {
    const body = String(documentRef?.body?.innerText ?? "");
    const seatMatch = body.match(/^Your Draft Position:\s*(\d{1,2})(?:st|nd|rd|th)\s*$/im);
    const seat = seatMatch ? Number(seatMatch[1]) : null;
    const teamCount = Number(body.match(/HORSE COLLAR #2\s*·\s*(\d+) Teams\s*·\s*19 Rounds\s*·\s*1 minute 15 seconds/i)?.[1] ?? 0);
    const errors = [];
    if (String(locationRef?.pathname ?? "") !== `/f1/${TEST_LEAGUE_ID}/draft`) errors.push("not_verified_test_draft_home");
    if (teamCount !== 12) errors.push("verified_test_summary_mismatch");
    if (!/^SKRODZKai$/m.test(body)) errors.push("verified_test_team_missing");
    if (!validTestSettingsReceipt(settingsReceipt, now)) errors.push("verified_test_settings_preflight_required");
    if (!Number.isInteger(seat) || seat < 1 || seat > 12) errors.push("test_draft_slot_pending");
    return {
      roomId: TEST_LEAGUE_ID,
      urlSeat: TEST_TEAM_ID,
      seat,
      teamCount,
      rosterSlots: validTestSettingsReceipt(settingsReceipt, now) ? [...settingsReceipt.observedRosterSlots] : [],
      errors,
      ready: errors.length === 0,
    };
  }

  function makeTestPreflight(snapshot, now = Date.now()) {
    if (!snapshot?.ready) throw new Error("verified test draft preflight is not ready");
    return {
      version: VERSION,
      mode: "test_league_19_idp",
      roomId: TEST_LEAGUE_ID,
      urlSeat: TEST_TEAM_ID,
      seat: snapshot.seat,
      observedTeamCount: snapshot.teamCount,
      observedRosterSlots: [...snapshot.rosterSlots],
      armedAt: now,
      expiresAt: now + 4 * 60 * 60 * 1000,
    };
  }

  function parseTestDraftClient(documentRef, locationRef, settingsReceipt = null, now = Date.now()) {
    const body = String(documentRef?.body?.innerText ?? "");
    const path = String(locationRef?.pathname ?? "");
    const pathMatch = path.match(/^\/draftclient\/f1\/(\d+)\/(\d+)\/?$/);
    const seatMatch = body.match(/YOUR TURN\s*-\s*(\d+)(?:ST|ND|RD|TH)\s+PICK/i);
    const rosterMatch = body.match(/YOUR TEAM\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\)/i);
    const seat = seatMatch ? Number(seatMatch[1]) : null;
    const filled = rosterMatch ? Number(rosterMatch[1]) : null;
    const total = rosterMatch ? Number(rosterMatch[2]) : null;
    const missingFilters = TEST_FILTER_LABELS.filter((label) => !findFilter(documentRef, label));
    const errors = [];
    if (!pathMatch || pathMatch[1] !== TEST_LEAGUE_ID || Number(pathMatch[2]) !== TEST_TEAM_ID) errors.push("test_draftclient_identity_mismatch");
    if (!/HORSE COLLAR #2/i.test(body)) errors.push("verified_test_league_missing");
    if (!validTestSettingsReceipt(settingsReceipt, now)) errors.push("verified_test_settings_preflight_required");
    if (!Number.isInteger(seat) || seat < 1 || seat > 12) errors.push("test_draft_slot_missing");
    if (filled !== 0 || total !== TEST_ROSTER_SLOTS.length) errors.push("test_draft_roster_not_empty");
    if (missingFilters.length) errors.push(`test_specialist_filters_missing:${missingFilters.join(",")}`);
    return {
      roomId: TEST_LEAGUE_ID,
      urlSeat: TEST_TEAM_ID,
      seat,
      teamCount: validTestSettingsReceipt(settingsReceipt, now) ? Number(settingsReceipt.observedTeamCount) : 0,
      rosterSlots: validTestSettingsReceipt(settingsReceipt, now) ? [...settingsReceipt.observedRosterSlots] : [],
      missingFilters,
      errors,
      ready: errors.length === 0,
    };
  }

  function validateDraftPreflight(token, room, now = Date.now()) {
    if (!token || !["public_mock_15", "test_league_19_idp"].includes(token.mode)) return "approved_draft_arm_required";
    if (String(room?.roomId ?? token.roomId) === DISABLED_LEAGUE_ID) return "league_420010_hard_disabled";
    if (!Number.isFinite(token.expiresAt) || token.expiresAt <= now) return "draft_arm_expired";
    const expectedUrlSeat = token.mode === "test_league_19_idp" ? Number(token.urlSeat) : Number(token.seat);
    if (!room || String(token.roomId) !== String(room.roomId) || expectedUrlSeat !== Number(room.seat)) {
      return "draft_room_or_url_team_changed";
    }
    if (!Number.isInteger(Number(token.seat)) || Number(token.seat) < 1 || Number(token.seat) > 12) return "draft_slot_invalid";
    if (Number(token.observedTeamCount) !== 12) return "draft_team_count_not_12";
    const expectedRoster = token.mode === "test_league_19_idp" ? TEST_ROSTER_SLOTS : PUBLIC_ROSTER_SLOTS;
    if (!sameSlots(token.observedRosterSlots, expectedRoster)) return "draft_roster_shape_mismatch";
    if (token.mode === "test_league_19_idp" && (String(token.roomId) !== TEST_LEAGUE_ID || Number(token.urlSeat) !== TEST_TEAM_ID)) return "test_identity_mismatch";
    return null;
  }

  function readJson(storage, key, fallback) {
    try {
      const parsed = JSON.parse(storage.getItem(key) ?? "null");
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  function writeReceipt(storage, details) {
    const receipts = readJson(storage, RECEIPT_KEY, []);
    const entry = { at: new Date().toISOString(), version: VERSION, ...details };
    receipts.push(entry);
    storage.setItem(RECEIPT_KEY, JSON.stringify(receipts.slice(-500)));
    return entry;
  }

  function findFilter(documentRef, label) {
    for (const select of documentRef.querySelectorAll("select")) {
      const options = [...(select.options ?? select.querySelectorAll?.("option") ?? [])];
      const option = options.find((candidate) => String(candidate.textContent ?? candidate.innerText ?? "").trim() === label);
      if (option) return { select, option };
    }
    return null;
  }

  function setFilter(documentRef, environment, label) {
    const match = findFilter(documentRef, label);
    if (!match) throw new Error(`position_filter_missing:${label}`);
    match.select.value = String(match.option.value ?? "");
    match.select.dispatchEvent(new environment.Event("input", { bubbles: true }));
    match.select.dispatchEvent(new environment.Event("change", { bubbles: true }));
  }

  function readAvailablePlayers(documentRef, controllerApi) {
    return [...documentRef.querySelectorAll("tr")]
      .map((row) => controllerApi.runtime.readPlayerRow(row))
      .filter(Boolean);
  }

  async function readPosition(documentRef, environment, controllerApi, label, position, deadlineMs = 5000) {
    setFilter(documentRef, environment, label);
    const startedAt = Date.now();
    while (Date.now() - startedAt < deadlineMs) {
      const players = readAvailablePlayers(documentRef, controllerApi)
        .filter((player) => player.position === position);
      if (players.length >= 5) return players;
      await new Promise((resolve) => environment.setTimeout(resolve, 25));
    }
    throw new Error(`specialist_filter_timeout:${label}`);
  }

  function mergeDefenseBoard(availableDefenses, defenseRanks) {
    const rankByTeam = new Map(Array.from(defenseRanks ?? [], (defense) => [normalize(defense.team), defense]));
    const ranked = [];
    for (const player of availableDefenses ?? []) {
      const match = rankByTeam.get(normalize(player.team)) ??
        Array.from(defenseRanks ?? []).find((defense) => normalize(player.name).includes(normalize(defense.name)));
      if (!match) continue;
      ranked.push({
        yahooId: String(player.yahooId),
        name: player.name,
        team: player.team,
        position: "DEF",
        rank: Number(match.rank),
      });
    }
    ranked.sort((left, right) => left.rank - right.rank);
    if (ranked.length < 5) throw new Error("fewer_than_5_verified_defenses");
    return ranked;
  }

  async function prepareBoard(documentRef, environment, controllerApi, boardData, mode = "MOCK") {
    try {
      const availableDefenses = await readPosition(
        documentRef,
        environment,
        controllerApi,
        "Team Defenses",
        "DEF",
      );
      const defenses = mergeDefenseBoard(availableDefenses, boardData.defenses);
      return mode === "TEST"
        ? [...boardData.offense, ...boardData.kickers, ...defenses, ...(boardData.idp ?? [])]
        : [...boardData.offense, ...boardData.kickers, ...defenses];
    } finally {
      setFilter(documentRef, environment, "All Positions");
    }
  }

  function buildExportPayload({ roomId, seat, urlSeat = seat, storage, runner }) {
    const belongsToDraftSeat = (entry) => String(entry.roomId) === String(roomId) && Number(entry.seat) === Number(seat);
    const belongsToUrlSeat = (entry) => String(entry.roomId) === String(roomId) && Number(entry.seat) === Number(urlSeat);
    return {
      exportedAt: new Date().toISOString(),
      extensionVersion: VERSION,
      roomId: String(roomId),
      seat: Number(seat),
      urlSeat: Number(urlSeat),
      status: runner?.getStatus?.() ?? null,
      extensionReceipts: readJson(storage, RECEIPT_KEY, []).filter(belongsToDraftSeat),
      runnerReceipts: readJson(storage, RUNNER_RECEIPT_KEY, []).filter(belongsToDraftSeat),
      controllerReceipts: readJson(storage, CONTROLLER_RECEIPT_KEY, []).filter(belongsToUrlSeat),
    };
  }

  function downloadJson(environment, filename, payload) {
    const blob = new environment.Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = environment.URL.createObjectURL(blob);
    const link = environment.document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    environment.setTimeout(() => environment.URL.revokeObjectURL(url), 0);
  }

  function enableExport(environment, rail, room, runner = null) {
    if (!room) return;
    rail.controls.export.disabled = false;
    rail.controls.export.onclick = () => {
      const payload = buildExportPayload({
        roomId: room.roomId,
        seat: room.seat,
        urlSeat: room.urlSeat ?? room.seat,
        storage: environment.localStorage,
        runner: runner ?? environment[GLOBAL_KEY]?.runner ?? null,
      });
      downloadJson(environment, `skrodzkai-mock-${room.roomId}-seat-${room.seat}.json`, payload);
    };
  }

  function createRail(documentRef) {
    const existing = documentRef.getElementById("skrodzkai-yahoo-mock-control");
    if (existing?._controlApi) return existing._controlApi;
    const host = documentRef.createElement("aside");
    host.id = "skrodzkai-yahoo-mock-control";
    host.setAttribute("aria-label", "SKRODZKai Yahoo draft command center");
    if (/^\/draftclient\//.test(String(root.location?.pathname ?? ""))) host.setAttribute("data-draftclient", "true");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; --ink:#05070b; --panel:#0b1016; --panel-2:#111923; --line:rgba(255,255,255,.10); --cyan:#63d9ff; --blue-accent:#0a84ff; --red:#ff453a; --muted:#98989d; --white:#ffffff; }
        * { box-sizing: border-box; }
        .rail { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: min(380px, calc(100vw - 32px)); overflow: hidden; color: #fff; background: radial-gradient(circle at 12% 0, rgba(10,132,255,.18), transparent 34%), linear-gradient(180deg,#070b11,#05070b); border: 1px solid rgba(10,132,255,.62); border-radius: 10px; box-shadow: 0 18px 54px rgba(0,0,0,.58), inset 0 1px rgba(255,255,255,.05); font: 600 12px/1.35 "Avenir Next", "SF Pro Text", "Helvetica Neue", sans-serif; letter-spacing: .01em; }
        :host([data-draftclient]) .rail { top:72px; bottom:auto; }
        .rail.expanded,.rail.collapsed { width:min(380px,calc(100vw - 32px)); }
        .rail.collapsed .body, .rail.collapsed .mode-strip, .rail.collapsed .cap-meta, .rail.collapsed .brand-lockup { display: none; }
        .compact-status { display: none; color: var(--blue-accent); font: 900 8px/1 ui-monospace, SFMono-Regular, Menlo, monospace; writing-mode: vertical-rl; letter-spacing: .08em; }
        .rail.collapsed .compact-status { display: block; }
        .cap { min-height: 68px; display: grid; grid-template-columns: 48px minmax(0,1fr) auto; align-items: center; gap: 10px; padding: 9px; border-bottom: 1px solid var(--line); background: rgba(5,8,13,.94); }
        .brand-lockup { display: flex; align-items: center; min-width: 0; }
        .brand-image { width:46px; height:46px; object-fit:cover; object-position:center; border-radius:8px; }
        .dock-readout { min-width:0; }
        .dock-readout strong { display:block; overflow:hidden; color:var(--cyan); font:700 14px/1.15 "SF Mono",ui-monospace,monospace; text-overflow:ellipsis; white-space:nowrap; }
        .dock-readout span { display:block; margin-top:4px; overflow:hidden; color:var(--muted); font:700 11px/1.2 "SF Mono",ui-monospace,monospace; text-overflow:ellipsis; white-space:nowrap; }
        .dock-actions { display:grid; gap:6px; }
        .dock-actions button { min-width:70px; padding:7px 6px; font-size:10px; }
        .globe { position: relative; width: 34px; height: 34px; flex: 0 0 34px; border: 2px solid var(--cyan); border-radius: 50%; box-shadow: 0 0 18px rgba(69,230,223,.24); overflow: hidden; }
        .globe::before { content:""; position:absolute; inset:5px 9px; border-left:1px solid var(--cyan); border-right:1px solid var(--cyan); border-radius:50%; }
        .globe::after { content:""; position:absolute; left:2px; right:2px; top:15px; border-top:1px solid var(--cyan); box-shadow:0 -7px rgba(69,230,223,.45), 0 7px rgba(69,230,223,.45); }
        .brand { color: var(--white); font-size: 16px; font-weight: 900; letter-spacing: .13em; white-space: nowrap; }
        .brand i { color: var(--cyan); font-style: normal; }
        .subbrand { margin-top: 1px; color: var(--blue-accent); font: 900 8px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .18em; }
        .cap-meta { display: flex; align-items: center; gap: 6px; }
        .mode { color: var(--blue-accent); font: 900 8px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .1em; }
        .mode-strip { display: grid; grid-template-columns: repeat(3, 1fr); border-bottom: 1px solid var(--line); background: rgba(3,10,12,.75); }
        .mode-chip { padding: 6px 4px; color: #5f7d81; text-align: center; font: 900 8px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .14em; }
        .mode-chip.active { color: var(--ink); background: var(--blue-accent); }
        .mode-chip.blocked { color: #bd6262; text-decoration: line-through; }
        .body,.mode-strip { display:none !important; }
        .status { display: grid; grid-template-columns: repeat(4, 1fr); border-bottom: 1px solid var(--line); }
        .expanded .status { grid-template-columns: repeat(8, 1fr); }
        .stat { min-width: 0; padding: 8px 9px 7px; border-right: 1px solid var(--line); }
        .stat:last-child { border-right: 0; }
        .label { display: block; color: var(--muted); font: 900 7px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; }
        .value { display: block; margin-top: 5px; overflow: hidden; color: var(--white); font: 900 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
        .value.accent { color: var(--cyan); } .value.warn { color: var(--blue-accent); } .value.danger { color: var(--red); }
        .overview { position: relative; padding: 9px 11px 10px; border-bottom: 1px solid var(--line); background: linear-gradient(90deg, rgba(69,230,223,.07), transparent 55%); }
        .state { color: var(--white); font: 900 18px/.95 "Avenir Next Condensed", "DIN Condensed", sans-serif; letter-spacing: .08em; text-transform: uppercase; }
        .detail { min-height: 15px; margin-top: 4px; color: #8da9ad; font: 700 9px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
        .meter { position:absolute; left:0; right:0; bottom:0; height:2px; background:#17373a; overflow:hidden; }
        .meter::after { content:""; display:block; width:28%; height:100%; background:var(--cyan); box-shadow:0 0 12px var(--cyan); animation:scan 1.6s ease-in-out infinite alternate; }
        @keyframes scan { from { transform:translateX(-100%); } to { transform:translateX(380%); } }
        .command-grid { display:grid; grid-template-columns:1fr; }
        .expanded .command-grid { grid-template-columns: 235px minmax(360px, 1fr) 275px; }
        .stack { min-width:0; border-right:1px solid var(--line); }
        .stack:last-child { border-right:0; }
        .section { border-bottom:1px solid var(--line); background:rgba(8,20,23,.64); }
        .section-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 9px 6px; color:#8ec0c2; font:900 8px/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.14em; text-transform:uppercase; }
        .section-head small { color:#55777b; font-size:7px; letter-spacing:.06em; text-align:right; }
        .roster,.board,.between,.warnings { padding:0 9px 9px; }
        .roster { display:grid; grid-template-columns:repeat(3,1fr); gap:2px 8px; }
        .expanded .roster { grid-template-columns:repeat(2,1fr); }
        .slot { display:flex; justify-content:space-between; gap:4px; padding:4px 0; border-bottom:1px dotted #214246; color:#7d999d; font:900 8px/1 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .slot b { max-width:76%; overflow:hidden; color:#dff8f3; text-overflow:ellipsis; white-space:nowrap; }
        .slot.open b { color:#49666a; }
        .composition { display:flex; gap:5px; flex-wrap:wrap; padding:0 9px 9px; }
        .pill { padding:3px 5px; border:1px solid #24484c; color:#8ca8ab; font:900 7px/1 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .pill b { color:var(--cyan); }
        .board-row { display:grid; grid-template-columns:28px minmax(0,1fr) 68px; gap:7px; padding:7px 4px; border-bottom:1px solid #17363a; }
        .board-row.primary { padding-left:7px; border-left:3px solid var(--blue-accent); background:linear-gradient(90deg,rgba(10,132,255,.12),transparent 74%); }
        .board-row.pinned { border-left-color:var(--cyan); background:linear-gradient(90deg,rgba(69,230,223,.14),transparent 74%); }
        .rank { color:#678c90; font:900 9px/1 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .primary .rank { color:var(--blue-accent); } .pinned .rank { color:var(--cyan); }
        .player { overflow:hidden; color:var(--white); font-size:12px; font-weight:900; letter-spacing:.02em; text-overflow:ellipsis; white-space:nowrap; }
        .player em { color:#759397; font-style:normal; font:800 8px/1 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .reason { margin-top:3px; overflow:hidden; color:#759397; font:700 8px/1.25 ui-monospace,SFMono-Regular,Menlo,monospace; text-overflow:ellipsis; white-space:nowrap; }
        .metrics { color:var(--cyan); text-align:right; font:900 8px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .metrics .dim { color:#667f83; }
        .search { display:flex; gap:5px; padding:0 9px 7px; }
        input { min-width:0; flex:1; padding:7px 8px; border:1px solid #28565a; border-radius:0; outline:none; color:var(--white); background:#071416; font:800 9px ui-monospace,SFMono-Regular,Menlo,monospace; }
        input:focus { border-color:var(--cyan); box-shadow:0 0 0 1px rgba(69,230,223,.16); }
        .pin-state { margin:0 9px 7px; padding:7px 8px; border-left:2px solid var(--blue-accent); color:#a9c0c2; background:rgba(10,132,255,.06); font:800 8px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .pin-state.live { border-left-color:var(--cyan); color:var(--white); background:rgba(69,230,223,.08); }
        .manual-list { max-height:108px; overflow:auto; padding:0 9px 6px; }
        .manual-row { display:flex; align-items:center; gap:5px; padding:3px 0; border-bottom:1px dotted #1b3e41; }
        .manual-row button { flex:1; padding:5px 4px; border:0; text-align:left; }
        .manual-row small { color:#678589; font:800 7px ui-monospace,SFMono-Regular,Menlo,monospace; }
        .manual-note { padding:0 9px 7px; color:#667f83; font:700 7px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .manual-actions,.actions { display:flex; gap:5px; padding:0 9px 9px; }
        button { appearance:none; border:1px solid #315b5e; border-radius:0; padding:6px 8px; color:#c7e4e5; background:transparent; cursor:pointer; font:900 8px/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.08em; text-transform:uppercase; }
        button:hover:not(:disabled) { border-color:var(--cyan); color:var(--cyan); }
        button.primary { border-color:var(--cyan); color:var(--ink); background:var(--cyan); }
        button.danger { border-color:#b94f54; color:#ff9292; } button.warn { border-color:var(--blue-accent); color:var(--blue-accent); }
        button:disabled { cursor:not-allowed; opacity:.32; }
        .manual-actions button,.actions button { flex:1; }
        .window-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:4px; margin-bottom:7px; }
        .window-cell { padding:6px 5px; border:1px solid #244348; text-align:center; }
        .window-cell span { display:block; color:#658589; font:800 7px/1 ui-monospace,SFMono-Regular,Menlo,monospace; text-transform:uppercase; }
        .window-cell b { display:block; margin-top:4px; color:var(--blue-accent); font:900 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .pressure { padding:3px 0; color:#a7bec0; font:700 8px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .pressure b { color:var(--blue-accent); }
        .manager-note { margin-top:5px; padding:6px 7px; border:1px dashed #2c5559; color:#66878a; font:800 7px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .event-log { max-height:106px; overflow:auto; padding:0 9px 9px; }
        .event { padding:3px 0; color:#6f8c90; font:700 7px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .event b { color:#b7d2d3; }
        .warning { padding:3px 0; color:var(--blue-accent); font:800 7px/1.25 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .warning.danger { color:var(--red); }
        .actions { position:sticky; bottom:0; padding:9px; border-top:1px solid var(--line); background:rgba(4,13,15,.97); }
        .ok .state { color:var(--cyan); } .bad .state { color:var(--red); } .complete .state { color:#d9ff78; }
        @media (max-width:760px) { .rail.expanded { width:calc(100vw - 28px); } .expanded .command-grid { grid-template-columns:1fr; } .expanded .status { grid-template-columns:repeat(4,1fr); } .stack { border-right:0; } }
        @media (prefers-reduced-motion:reduce) { .rail { transition:none; } .meter::after { animation:none; } }
      </style>
      <section class="rail">
        <header class="cap">
          <div class="brand-lockup"><img class="brand-image" src="${root.chrome?.runtime?.getURL?.("extension/assets/skrodzkai-globe-mark.png") ?? ""}" alt="SKRODZKai" /></div>
          <div class="dock-readout"><strong data-dock-primary>SAFE · --:--</strong><span data-compact-status>MOCK · ROOM — · SEAT —</span><span data-dock-target>Waiting for Yahoo availability</span></div>
          <div class="dock-actions"><button class="expand" type="button">Open Center</button><button class="dock-kill danger" type="button">Kill</button></div>
        </header>
        <div class="mode-strip"><span class="mode-chip active">MOCK</span><span class="mode-chip">TEST</span><span class="mode-chip blocked">REAL ⛔</span></div>
        <div class="body">
          <div class="status">
            <div class="stat"><span class="label">League</span><span class="value" data-status="league">PUBLIC</span></div><div class="stat"><span class="label">Room</span><span class="value" data-status="room">—</span></div><div class="stat"><span class="label">Seat</span><span class="value" data-status="seat">—</span></div><div class="stat"><span class="label">Round / Pick</span><span class="value accent" data-status="turn">— / —</span></div>
            <div class="stat"><span class="label">Clock</span><span class="value" data-status="clock">--:--</span></div><div class="stat"><span class="label">Armed</span><span class="value" data-status="armed">NO</span></div><div class="stat"><span class="label">Autodraft</span><span class="value danger" data-status="autodraft">OFF</span></div><div class="stat"><span class="label">Kill switch</span><span class="value danger" data-status="kill">READY</span></div>
          </div>
          <section class="overview"><div class="state">LOCKED</div><div class="detail">Waiting for a verified draft room.</div><div class="meter"></div></section>
          <div class="command-grid">
            <div class="stack">
              <section class="section"><div class="section-head"><span>Our roster</span><small><span data-roster-count>0 / 15</span></small></div><div class="roster" data-roster></div><div class="composition" data-composition></div></section>
              <section class="section"><div class="section-head"><span>Latest confirmation</span><small>Yahoo readback</small></div><div class="pin-state" data-latest-pick>—</div></section>
            </div>
            <div class="stack">
              <section class="section"><div class="section-head"><span>Decision ladder</span><small data-disagreement>BASELINE READY</small></div><div class="board" data-board></div></section>
              <section class="section"><div class="section-head"><span>Next-pick override</span><small data-stage-count>BASELINE</small></div><div class="pin-state" data-pin-state>No pin staged. The verified baseline will execute.</div><div class="search"><input data-search type="search" placeholder="Search player, team, position, or exact Yahoo ID" aria-label="Search verified Yahoo board" /></div><div class="manual-list" data-manual-list></div><div class="manual-note">Set before our clock. Yahoo must expose the player row at execution; deep or paginated pins may reject. Any invalid pin is receipted and the five-target baseline executes immediately.</div><div class="manual-actions"><button class="warn" data-clear-pin type="button" disabled>Clear Pin</button><button class="primary" data-confirm type="button" disabled>Pin Next Pick</button></div></section>
            </div>
            <div class="stack">
              <section class="section"><div class="section-head"><span>Opponent window</span><small>Snake + survival</small></div><div class="between" data-between><div class="pressure">No owned turn validated.</div></div></section>
              <section class="section"><div class="section-head"><span>Warnings</span><small data-warning-count>0</small></div><div class="warnings" data-warnings><div class="warning">No active warnings.</div></div></section>
              <section class="section"><div class="section-head"><span>Decision receipts</span><small>Local only</small></div><div class="event-log" data-events><div class="event">— <b>command center initialized</b></div></div></section>
            </div>
          </div>
          <div class="actions"><button class="primary arm" type="button" disabled>ARM MOCK</button><button class="danger halt" type="button" disabled>KILL SWITCH</button><button class="export" type="button" disabled>EXPORT RECEIPTS</button></div>
        </div>
      </section>`;
    documentRef.documentElement.appendChild(host);
    const rail = shadow.querySelector(".rail");
    const state = shadow.querySelector(".state");
    const detail = shadow.querySelector(".detail");
    const data = {
      status: Object.fromEntries([...shadow.querySelectorAll("[data-status]")].map((node) => [node.dataset.status, node])),
      roster: shadow.querySelector("[data-roster]"), rosterCount: shadow.querySelector("[data-roster-count]"), composition: shadow.querySelector("[data-composition]"), latestPick: shadow.querySelector("[data-latest-pick]"),
      board: shadow.querySelector("[data-board]"), between: shadow.querySelector("[data-between]"), warnings: shadow.querySelector("[data-warnings]"), warningCount: shadow.querySelector("[data-warning-count]"), events: shadow.querySelector("[data-events]"), disagreement: shadow.querySelector("[data-disagreement]"),
      stageCount: shadow.querySelector("[data-stage-count]"), pinState: shadow.querySelector("[data-pin-state]"), search: shadow.querySelector("[data-search]"), manualList: shadow.querySelector("[data-manual-list]"), clearPin: shadow.querySelector("[data-clear-pin]"), confirm: shadow.querySelector("[data-confirm]"), compact: shadow.querySelector("[data-compact-status]"), dockPrimary: shadow.querySelector("[data-dock-primary]"), dockTarget: shadow.querySelector("[data-dock-target]"), modeLabel: shadow.querySelector(".mode"), modeChips: [...shadow.querySelectorAll(".mode-chip")],
    };
    const controls = { arm: shadow.querySelector(".arm"), halt: shadow.querySelector(".halt"), export: shadow.querySelector(".export") };
    const ui = { mode:"MOCK", kind:"", label:"LOCKED", detail:"Waiting for a verified draft room.", context:{}, roster:[], recommendations:[], board:[], between:{}, warnings:[], staged:[], pinned:null, pinOutcome:null, pinText:"No pin staged. Five verified fallbacks remain active.", pinLabel:"BASELINE", ladderState:"BASELINE READY", latestText:"No confirmed selection yet.", events:[], latestPickId:"", onManualConfirm:null, onManualClear:null, onOpen:null };
    const redrawManual = () => {
      const query = String(data.search.value ?? "").trim().toUpperCase();
      const matches = ui.board.filter((player) => `${player.name} ${player.position} ${player.team} ${player.yahooId}`.toUpperCase().includes(query)).slice(0, 10);
      data.manualList.innerHTML = matches.map((player) => `<div class="manual-row"><button type="button" data-stage-id="${player.yahooId}">${player.name} <small>${player.position} · ${player.team} · Y!${player.yahooId}</small></button></div>`).join("") || `<div class="event">No verified Yahoo IDs match.</div>`;
      for (const button of data.manualList.querySelectorAll("[data-stage-id]")) button.addEventListener("click", () => {
        const player = ui.board.find((candidate) => String(candidate.yahooId) === String(button.dataset.stageId));
        if (!player || ui.staged.some((candidate) => String(candidate.yahooId) === String(player.yahooId))) return;
        ui.staged.push({ yahooId:String(player.yahooId), name:String(player.name ?? ""), position:String(player.position ?? ""), team:String(player.team ?? "") });
        redrawManual();
      });
      data.manualList.insertAdjacentHTML("afterbegin", ui.staged.map((player, index) => `<div class="manual-row"><button type="button" data-remove-stage="${player.yahooId}">${index + 1}. ${player.name || `Yahoo ${player.yahooId}`} <small>${player.position} · Y!${player.yahooId} · click to remove</small></button></div>`).join(""));
      for (const button of data.manualList.querySelectorAll("[data-remove-stage]")) button.addEventListener("click", () => { ui.staged = ui.staged.filter((player) => String(player.yahooId) !== String(button.dataset.removeStage)); redrawManual(); });
      data.confirm.disabled = ui.staged.length === 0;
      data.clearPin.disabled = !ui.pinned;
      data.stageCount.textContent = ui.pinned ? `PINNED R${ui.pinned.expectedRound}` : ui.staged.length ? `${ui.staged.length} SELECTED` : ui.pinOutcome ? ui.pinOutcome.status.toUpperCase() : "BASELINE";
      data.pinState.className = `pin-state ${ui.pinned || ui.pinOutcome?.status === "applied" ? "live" : ""}`.trim();
      data.pinState.textContent = ui.pinned
        ? `Round ${ui.pinned.expectedRound}: ${ui.pinned.targets.map((player) => player.name || `Y!${player.yahooId}`).join(" → ")}`
        : ui.pinOutcome
          ? `${ui.pinOutcome.status.toUpperCase()} R${ui.pinOutcome.expectedRound ?? "—"}: ${ui.pinOutcome.chosenYahooId ? `Y!${ui.pinOutcome.chosenYahooId}` : ui.pinOutcome.reason ?? "baseline retained"}`
          : "No pin staged. The verified baseline will execute.";
      ui.pinLabel = data.stageCount.textContent;
      ui.pinText = data.pinState.textContent;
    };
    data.search.addEventListener("input", redrawManual);
    data.confirm.addEventListener("click", () => {
      if (typeof ui.onManualConfirm !== "function") return;
      const result = ui.onManualConfirm(ui.staged.slice());
      if (result !== false) { ui.staged = []; redrawManual(); }
    });
    data.clearPin.addEventListener("click", () => { if (typeof ui.onManualClear === "function" && ui.onManualClear() !== false) { ui.pinned = null; ui.pinOutcome = { status:"cleared", expectedRound:null, reason:"deterministic baseline active" }; redrawManual(); } });
    shadow.querySelector(".expand").addEventListener("click", () => ui.onOpen?.());
    shadow.querySelector(".dock-kill").addEventListener("click", () => controls.halt.click());
    const setStatus = (key, value, kind = "") => { if (!data.status[key]) return; data.status[key].textContent = value; data.status[key].className = `value ${kind}`.trim(); };
    const api = {
      controls,
      setMode(mode) { ui.mode = String(mode ?? "MOCK").toUpperCase(); if (data.modeLabel) data.modeLabel.textContent = `${ui.mode} / LOCAL`; for (const chip of data.modeChips) { const chipMode = String(chip.textContent ?? "").replace("⛔", "").trim(); chip.classList.toggle("active", chipMode === ui.mode); } },
      render(kind, label, message) { ui.kind=kind; ui.label=label; ui.detail=message; rail.classList.remove("ok", "bad", "complete"); if (kind) rail.classList.add(kind); state.textContent = label; detail.textContent = message; },
      setExpanded(expanded = true) { if (expanded) ui.onOpen?.(); },
      setOpenHandler(handler) { ui.onOpen = typeof handler === "function" ? handler : null; },
      setContext(context = {}) {
        const roomId = String(context.roomId ?? "—");
        setStatus("league", context.league ?? (roomId === DISABLED_LEAGUE_ID ? "420010 BLOCKED" : "PUBLIC"), roomId === DISABLED_LEAGUE_ID ? "danger" : ""); setStatus("room", roomId); setStatus("seat", context.seat == null ? "—" : String(context.seat)); setStatus("turn", context.round == null ? "— / —" : `R${context.round} / P${context.pick ?? "—"}`); setStatus("clock", context.clock ?? "--:--"); setStatus("armed", context.armed ? "YES" : "NO", context.armed ? "accent" : "warn"); setStatus("autodraft", context.autodraft ? "ON / BLOCKED" : "OFF", context.autodraft ? "danger" : ""); setStatus("kill", context.kill ? "ENGAGED" : "READY", context.kill ? "danger" : "");
        ui.context = { ...context, roomId };
        data.dockPrimary.textContent = `${context.kill ? "KILL" : context.armed ? "ARMED" : "SAFE"} · ${context.clock ?? "--:--"}`;
        data.compact.textContent = `${ui.mode} · ${roomId} · S${context.seat ?? "—"} · ${context.round == null ? "—" : `R${context.round}P${context.pick ?? "—"}`}`;
      },
      setRoster(roster = [], latest = null) {
        ui.roster = Array.isArray(roster) ? roster : []; data.roster.innerHTML = ui.roster.map((slot) => `<div class="slot ${slot.player ? "filled" : "open"}"><span>${slot.slot}</span><b>${slot.player?.name ?? "OPEN"}</b></div>`).join("") || `<div class="event">Roster readback unavailable.</div>`; data.rosterCount.textContent = `${ui.roster.filter((slot) => slot.player).length} / ${ui.roster.length || 15}`;
        const counts = ui.roster.filter((slot) => slot.player).reduce((map, slot) => { const position = normalize(slot.player.position); map[position] = (map[position] ?? 0) + 1; return map; }, {}); data.composition.innerHTML = ["QB","RB","WR","TE","K","DEF","IDP"].map((position) => `<span class="pill">${position} <b>${position === "IDP" ? (counts.D ?? 0) + (counts.LB ?? 0) + (counts.CB ?? 0) + (counts.S ?? 0) : counts[position] ?? 0}</b></span>`).join("");
        ui.latestText = latest ? `${latest.name ?? `Y!${latest.yahooId}`} · ${latest.position ?? "—"} · ${latest.detectionToClickMs ?? "—"}ms` : "No confirmed selection yet."; data.latestPick.textContent = ui.latestText; const latestId = String(latest?.yahooId ?? ""); if (latest && latestId !== ui.latestPickId) { ui.latestPickId = latestId; api.addEvent("pick confirmed", `${latest.name ?? "Yahoo ID " + latest.yahooId} · ${latest.position ?? "—"}`); }
      },
      setRecommendations(recommendations = [], meta = {}) {
        if (Array.isArray(meta.fullBoard)) ui.board = meta.fullBoard; const rows = Array.isArray(recommendations) ? recommendations : []; ui.recommendations = rows;
        data.board.innerHTML = rows.slice(0, 6).map((player, index) => `<div class="board-row ${index === 0 ? "primary" : ""} ${player.manual ? "pinned" : ""}"><span class="rank">${player.manual ? "PIN" : index === 0 ? "GO" : `F${index}`}</span><div><div class="player">${player.name ?? `Yahoo ${player.yahooId}`} <em>${player.position ?? "—"} · ${player.team ?? "—"}</em></div><div class="reason">${player.reason ?? "verified local ladder"}</div></div><div class="metrics">${player.edge ?? "—"}<br><span class="dim">${player.confidence ?? "—"} · ${player.freshness ?? "—"}</span></div></div>`).join("") || `<div class="event">Ladder resolves on our owned turn after Yahoo availability is validated.</div>`;
        const manual = rows[0]?.manual; ui.ladderState = meta.disagreement ? "MODEL DISAGREEMENT" : manual ? "MANUAL PIN APPLIED" : "BASELINE READY"; data.disagreement.textContent = ui.ladderState; data.disagreement.className = meta.disagreement ? "danger" : ""; data.dockTarget.textContent = rows[0] ? `${rows[0].name ?? `Y!${rows[0].yahooId}`} · ${rows[0].position ?? "—"}` : "Waiting for Yahoo availability"; redrawManual();
      },
      setBetweenTurns(info = {}) {
        ui.between = info;
        const atRisk = Array.isArray(info.atRisk) && info.atRisk.length ? info.atRisk.join(", ") : "Targets withheld until Yahoo availability is read.";
        data.between.innerHTML = `<div class="window-grid"><div class="window-cell"><span>Current</span><b>${info.currentPick ?? "—"}</b></div><div class="window-cell"><span>Next ours</span><b>${info.nextPick ?? "—"}</b></div><div class="window-cell"><span>Between</span><b>${info.intervening ?? "—"}</b></div></div><div class="pressure"><b>At risk:</b> ${atRisk}</div><div class="manager-note">${info.managerNote ?? "PUBLIC MOCK · room behavior only; historical 2 Minute Drillers manager profiles are not applicable."}</div>`;
      },
      setWarnings(warnings = []) { const list = Array.isArray(warnings) ? warnings.filter(Boolean) : []; ui.warnings=list; data.warningCount.textContent = String(list.length); data.warnings.innerHTML = list.length ? list.map((warning) => `<div class="warning ${warning.severity === "danger" ? "danger" : ""}">⚠ ${warning.text ?? warning}</div>`).join("") : `<div class="warning">No active warnings.</div>`; },
      addEvent(kind, detailText = "") { ui.events.unshift({ at:new Date().toLocaleTimeString([], { hour:"2-digit", minute:"2-digit", second:"2-digit" }), kind, detail:detailText }); ui.events = ui.events.slice(0, 18); data.events.innerHTML = ui.events.map((event) => `<div class="event">${event.at} <b>${event.kind}</b>${event.detail ? ` · ${event.detail}` : ""}</div>`).join(""); },
      setBoard(board = []) { ui.board = Array.isArray(board) ? board : []; redrawManual(); },
      setManualHandler(confirmHandler, clearHandler = null) { ui.onManualConfirm = confirmHandler; ui.onManualClear = clearHandler; },
      setPinned(stage = null) { ui.pinned = stage; if (stage) ui.pinOutcome = null; redrawManual(); },
      setPinOutcome(outcome = null) { ui.pinned = null; ui.pinOutcome = outcome; redrawManual(); },
      getManualStage() { return ui.staged.slice(); },
      command(name, payload = null) {
        if (name === "arm") { controls.arm.click(); return true; }
        if (name === "kill") { controls.halt.click(); return true; }
        if (name === "export") { controls.export.click(); return true; }
        if (name === "clear_pin" && typeof ui.onManualClear === "function") {
          const cleared = ui.onManualClear();
          if (cleared !== false) { ui.pinned = null; ui.pinOutcome = { status:"cleared", expectedRound:null, reason:"deterministic baseline active" }; redrawManual(); }
          return cleared;
        }
        if (name === "pin" && typeof ui.onManualConfirm === "function") return ui.onManualConfirm(Array.isArray(payload?.targets) ? payload.targets : []);
        return false;
      },
      getSnapshot() {
        return { version:VERSION, mode:ui.mode, kind:ui.kind, label:ui.label, detail:ui.detail, context:ui.context, roster:ui.roster, recommendations:ui.recommendations, board:ui.board, between:ui.between, warnings:ui.warnings, events:ui.events, latestText:ui.latestText, ladderState:ui.ladderState, pinned:ui.pinned, pinOutcome:ui.pinOutcome, pinText:ui.pinText, pinLabel:ui.pinLabel, controls:{ arm:{ disabled:controls.arm.disabled, text:controls.arm.textContent }, halt:{ disabled:controls.halt.disabled, text:controls.halt.textContent }, export:{ disabled:controls.export.disabled, text:controls.export.textContent } } };
      },
    };
    api.setContext(); api.setRoster(PUBLIC_ROSTER_SLOTS.map((slot) => ({ slot }))); api.setRecommendations([]); api.setBetweenTurns(); api.setWarnings([]); redrawManual(); host._controlApi = api; return api;
  }

  function commandCenterRole(pathname = "") {
    if (/^\/draftclient\/f1\/\d+\/\d+\/?$/.test(pathname)) return "runner";
    if (pathname === "/f1/mock_waiting" || pathname === `/f1/${TEST_LEAGUE_ID}/draft`) return "arm-owner";
    return "observer";
  }

  function attachCommandCenterBridge(environment, rail) {
    const runtime = environment.chrome?.runtime ?? root.chrome?.runtime;
    if (!runtime?.sendMessage || !runtime?.onMessage || typeof rail?.getSnapshot !== "function") return null;
    const role = commandCenterRole(environment.location?.pathname);
    let boardHash = "";
    let snapshotHash = "";
    const publish = () => {
      const full = rail.getSnapshot();
      const board = Array.isArray(full.board) ? full.board : [];
      const nextBoardHash = JSON.stringify(board);
      const { board: omittedBoard, ...snapshot } = full;
      void omittedBoard;
      const boardChanged = nextBoardHash !== boardHash;
      const nextSnapshotHash = JSON.stringify(snapshot);
      const snapshotChanged = nextSnapshotHash !== snapshotHash;
      if (boardChanged) boardHash = nextBoardHash;
      if (snapshotChanged) snapshotHash = nextSnapshotHash;
      void runtime.sendMessage({ type:"state", role, at:Date.now(), snapshot:snapshotChanged ? snapshot : undefined, board:role === "runner" && boardChanged ? board : undefined });
    };
    rail.setOpenHandler(() => void runtime.sendMessage({ type:"open_command_center" }));
    const onMessage = (message, _sender, sendResponse) => {
      if (message?.type !== "command") return;
      const ok = rail.command(message.command, message.payload);
      publish();
      sendResponse({ ok:ok !== false });
    };
    runtime.onMessage.addListener(onMessage);
    publish();
    const timer = environment.setInterval(publish, 250);
    return { publish, stop() { environment.clearInterval(timer); runtime.onMessage.removeListener(onMessage); } };
  }

  async function waitForEmptyDraft(documentRef, controllerApi, environment, expectedRosterTotal = 15, executionMode = "MOCK", deadlineMs = 15000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < deadlineMs) {
      const roster = controllerApi.runtime.parseRosterCount(documentRef.body?.innerText);
      const labels = executionMode === "TEST"
        ? ["All Positions", ...TEST_FILTER_LABELS]
        : ["All Positions", "Team Defenses", "Kickers"];
      const filtersReady = labels
        .every((label) => findFilter(documentRef, label));
      if (roster?.filled === 0 && roster?.total === expectedRosterTotal && filtersReady) return roster;
      await new Promise((resolve) => environment.setTimeout(resolve, 50));
    }
    throw new Error(executionMode === "TEST" ? "empty_test_draft_not_ready" : "empty_public_mock_draft_not_ready");
  }

  function fitsRosterSlot(position, slot) {
    if (slot === position) return true;
    if (slot === "W/R") return ["WR", "RB"].includes(position);
    if (slot === "W/R/T") return ["WR", "RB", "TE"].includes(position);
    return slot === "BN";
  }

  function buildUiRoster(picks = [], rosterSlots = PUBLIC_ROSTER_SLOTS) {
    const roster = Array.from(rosterSlots, (slot) => ({ slot, player: null }));
    for (const pick of Array.from(picks)) {
      const position = normalize(pick.position);
      let index = roster.findIndex((entry) => !entry.player && entry.slot !== "BN" && fitsRosterSlot(position, entry.slot));
      if (index < 0) index = roster.findIndex((entry) => !entry.player && entry.slot === "BN");
      if (index >= 0) roster[index].player = pick;
    }
    return roster;
  }

  function buildUiRecommendations(board = [], decision = null) {
    if (!Array.isArray(decision?.targetYahooIds)) return [];
    const byId = new Map(Array.from(board, (player) => [String(player.yahooId), player]));
    const leaders = new Map(Array.from(decision.positionLeaders ?? [], (leader) => [String(leader.player?.yahooId), leader]));
    return decision.targetYahooIds.flatMap((yahooId) => {
      const player = byId.get(String(yahooId));
      if (!player) return [];
      const leader = leaders.get(String(yahooId));
      const adjusted = Number(leader?.adjustedScore);
      const manual = decision.manualOverride?.status === "applied" && String(decision.manualOverride?.chosenYahooId) === String(yahooId);
      return [{
        ...player,
        manual,
        edge: Number.isFinite(adjusted) ? `+${adjusted.toFixed(1)}` : "POLICY",
        confidence: player.confidence ?? "LOCAL_RULE",
        freshness: "TURN",
        reason: manual ? "operator pin validated; baseline fallbacks retained" : `${leader?.bucket ?? "verified ladder"}; exact Yahoo ID`,
      }];
    });
  }

  function buildUiOpponentWindow(decision = null, executionMode = "MOCK") {
    if (!decision) return {
      currentPick: "—",
      nextPick: "—",
      intervening: "—",
      atRisk: [],
      managerNote: executionMode === "TEST" ? "TEST ROOM · 2 Minute Drillers manager histories do not apply to these opponents." : "PUBLIC MOCK · room behavior only; historical manager profiles are not applicable.",
    };
    const atRisk = Array.from(decision.positionLeaders ?? [])
      .filter((leader) => ["likely_gone", "ambiguous"].includes(leader.bucket))
      .slice(0, 4)
      .map((leader) => `${leader.player?.name ?? "unknown"} (${leader.player?.position ?? "—"})`);
    return {
      currentPick: decision.currentPick ?? "—",
      nextPick: decision.nextPick ?? "—",
      intervening: decision.interveningOpponentPicks ?? "—",
      atRisk,
      managerNote: executionMode === "TEST" ? "TEST ROOM · live snake pressure only; 2 Minute Drillers owner models are intentionally withheld." : "PUBLIC MOCK · live snake pressure only.",
    };
  }

  function buildUiWarnings({ room, armRecord, autodraft, roster, board, expectedRosterTotal = 15 }) {
    const warnings = [
      { text: "Injury status: not live-validated; verify before setting a next-pick pin." },
      { text: "Freshness: local board snapshot only; no remote refresh path." },
      { text: "Eligibility / bye: Yahoo row readback remains authoritative." },
    ];
    if (autodraft) warnings.unshift({ severity: "danger", text: "Autodraft is active: execution is fail-closed." });
    if (!armRecord) warnings.unshift({ severity: "danger", text: "Roster mismatch or missing arm token: locked." });
    if (room?.roomId === DISABLED_LEAGUE_ID) warnings.unshift({ severity: "danger", text: "League 420010 is hard-disabled." });
    if (!roster || roster.total !== expectedRosterTotal) warnings.push({ severity: "danger", text: `Roster mismatch: expected ${expectedRosterTotal} slots.` });
    if (!Array.isArray(board) || board.length < 6) warnings.push({ text: "Recommendation board has fewer than six verified entries." });
    return warnings;
  }

  function bootWaitingRoom(environment, rail) {
    const update = () => {
      const snapshot = parseWaitingRoom(environment.document, environment.location);
      const armed = readJson(environment.sessionStorage, PREFLIGHT_KEY, null);
      const active = armed && !validateDraftPreflight(armed, { roomId: snapshot.roomId, seat: snapshot.seat });
      rail.setContext({ roomId: snapshot.roomId || "—", seat: snapshot.seat, league: snapshot.roomId === DISABLED_LEAGUE_ID ? "420010 BLOCKED" : "PUBLIC", armed: Boolean(active), autodraft: false, kill: false });
      rail.setWarnings(snapshot.errors.includes("league_420010_hard_disabled") ? [{ severity: "danger", text: "League 420010 is hard-disabled; no arm or draft action is permitted." }] : []);
      if (!snapshot.ready) {
        rail.render("bad", "PREFLIGHT FAILED", snapshot.errors.join(" · "));
        rail.controls.arm.disabled = true;
        rail.addEvent("preflight blocked", snapshot.errors.join(" · "));
        return false;
      }
      rail.render(active ? "ok" : "", active ? "ARMED" : "READY TO ARM", `Room ${snapshot.roomId} · seat ${snapshot.seat} · 12 teams · 15 rounds`);
      rail.controls.arm.disabled = false;
      rail.controls.arm.textContent = active ? "DISARM" : "ARM MOCK";
      return true;
    };
    rail.controls.arm.addEventListener("click", () => {
      const snapshot = parseWaitingRoom(environment.document, environment.location);
      if (!snapshot.ready) {
        update();
        return;
      }
      const active = readJson(environment.sessionStorage, PREFLIGHT_KEY, null);
      if (active && !validateDraftPreflight(active, { roomId: snapshot.roomId, seat: snapshot.seat })) {
        environment.sessionStorage.removeItem(PREFLIGHT_KEY);
        writeReceipt(environment.localStorage, { kind: "mock_disarmed", roomId: snapshot.roomId, seat: snapshot.seat });
        rail.addEvent("mock disarmed", `room ${snapshot.roomId} · seat ${snapshot.seat}`);
      } else {
        const armRecord = makePreflight(snapshot);
        environment.sessionStorage.setItem(PREFLIGHT_KEY, JSON.stringify(armRecord));
        writeReceipt(environment.localStorage, { kind: "mock_armed", roomId: snapshot.roomId, seat: snapshot.seat, expiresAt: armRecord.expiresAt });
        rail.addEvent("mock armed", `room ${snapshot.roomId} · seat ${snapshot.seat}`);
      }
      update();
    });
    if (!update() && environment.MutationObserver) {
      const observer = new environment.MutationObserver(() => {
        if (update()) observer.disconnect();
      });
      observer.observe(environment.document.body, { childList: true, subtree: true, characterData: true });
    }
  }

  function bootTestDraftHome(environment, rail) {
    rail.setMode("TEST");
    rail.setExpanded(true);
    rail.setBetweenTurns(buildUiOpponentWindow(null, "TEST"));
    rail.setRoster(TEST_ROSTER_SLOTS.map((slot) => ({ slot })));
    const update = () => {
      const settingsReceipt = readJson(environment.localStorage, TEST_SETTINGS_KEY, null);
      const snapshot = parseTestDraftHome(environment.document, environment.location, settingsReceipt);
      const armed = readJson(environment.sessionStorage, PREFLIGHT_KEY, null);
      const active = armed?.mode === "test_league_19_idp" && !validateDraftPreflight(armed, { roomId: TEST_LEAGUE_ID, seat: TEST_TEAM_ID });
      rail.setContext({ roomId: TEST_LEAGUE_ID, seat: snapshot.seat, league: "HORSE COLLAR #2", armed: Boolean(active), autodraft: false, kill: false });
      rail.setWarnings(snapshot.errors.map((reason) => ({
        severity: reason === "test_draft_slot_pending" ? "" : "danger",
        text: reason === "test_draft_slot_pending" ? "Draft slot publishes 30 minutes before start; execution remains locked." : reason,
      })));
      if (!snapshot.ready) {
        rail.render("", "TEST SLOT PENDING", "Draft order is published 30 minutes before the draft; execution remains locked.");
        rail.controls.arm.disabled = true;
        rail.controls.arm.textContent = "ARM TEST";
        return false;
      }
      rail.render(active ? "ok" : "", active ? "TEST ARMED" : "READY TO ARM TEST", `League ${TEST_LEAGUE_ID} · draft slot ${snapshot.seat} · 12 teams · 19 rounds`);
      rail.controls.arm.disabled = false;
      rail.controls.arm.textContent = active ? "DISARM" : "ARM TEST";
      return true;
    };
    rail.controls.arm.addEventListener("click", () => {
      const settingsReceipt = readJson(environment.localStorage, TEST_SETTINGS_KEY, null);
      const snapshot = parseTestDraftHome(environment.document, environment.location, settingsReceipt);
      if (!snapshot.ready) return update();
      const active = readJson(environment.sessionStorage, PREFLIGHT_KEY, null);
      if (active?.mode === "test_league_19_idp" && !validateDraftPreflight(active, { roomId: TEST_LEAGUE_ID, seat: TEST_TEAM_ID })) {
        environment.sessionStorage.removeItem(PREFLIGHT_KEY);
        writeReceipt(environment.localStorage, { kind: "test_disarmed", roomId: TEST_LEAGUE_ID, seat: snapshot.seat, urlSeat: TEST_TEAM_ID });
        rail.addEvent("test disarmed", `league ${TEST_LEAGUE_ID} · draft slot ${snapshot.seat}`);
      } else {
        const armRecord = makeTestPreflight(snapshot);
        environment.sessionStorage.setItem(PREFLIGHT_KEY, JSON.stringify(armRecord));
        writeReceipt(environment.localStorage, { kind: "test_armed", roomId: TEST_LEAGUE_ID, seat: snapshot.seat, urlSeat: TEST_TEAM_ID, expiresAt: armRecord.expiresAt });
        rail.addEvent("test armed", `league ${TEST_LEAGUE_ID} · draft slot ${snapshot.seat}`);
      }
      update();
    });
    if (!update() && environment.MutationObserver) {
      const observer = new environment.MutationObserver(() => { if (update()) observer.disconnect(); });
      observer.observe(environment.document.body, { childList: true, subtree: true, characterData: true });
    }
  }

  function bootTestSettings(environment, rail) {
    rail.setMode("TEST");
    rail.setBetweenTurns(buildUiOpponentWindow(null, "TEST"));
    rail.setRoster(TEST_ROSTER_SLOTS.map((slot) => ({ slot })));
    const update = () => {
      const snapshot = parseTestSettings(environment.document, environment.location);
      if (!snapshot.ready) {
        environment.localStorage.removeItem(TEST_SETTINGS_KEY);
        rail.setWarnings(snapshot.errors.map((text) => ({ severity: "danger", text })));
        rail.render("bad", "TEST SETTINGS LOCKED", snapshot.errors.join(" · "));
        return false;
      }
      const receipt = makeTestSettingsReceipt(snapshot);
      environment.localStorage.setItem(TEST_SETTINGS_KEY, JSON.stringify(receipt));
      rail.setContext({ roomId: TEST_LEAGUE_ID, league: "HORSE COLLAR #2", armed: false, autodraft: false, kill: false });
      rail.setWarnings([]);
      rail.render("ok", "TEST SETTINGS VERIFIED", "12 teams · 19 active roster slots · 3 IR · 75-second clock");
      rail.addEvent("test settings verified", `league ${TEST_LEAGUE_ID} · ${snapshot.rosterSlots.length} settings slots`);
      return true;
    };
    if (!update() && environment.MutationObserver) {
      const observer = new environment.MutationObserver(() => { if (update()) observer.disconnect(); });
      observer.observe(environment.document.body, { childList: true, subtree: true, characterData: true });
    }
  }

  async function bootDraft(environment, rail) {
    const controllerApi = environment.SKRODZKaiYahooDraftController;
    const runnerApi = environment.SKRODZKaiYahooMockRunner;
    const boardData = environment.SKRODZKaiYahooMockBoard;
    if (!controllerApi || !runnerApi || !boardData) throw new Error("extension_dependencies_missing");
    const room = controllerApi.runtime.parseRoom(environment.location.pathname);
    if (!room) throw new Error("draft_room_missing");
    let armRecord = readJson(environment.sessionStorage, PREFLIGHT_KEY, null);
    if (!armRecord && room.roomId === TEST_LEAGUE_ID && Number(room.seat) === TEST_TEAM_ID) {
      rail.setMode("TEST");
      rail.setExpanded(true);
      rail.setRoster(TEST_ROSTER_SLOTS.map((slot) => ({ slot })));
      rail.setBetweenTurns(buildUiOpponentWindow(null, "TEST"));
      const update = () => {
        const settingsReceipt = readJson(environment.localStorage, TEST_SETTINGS_KEY, null);
        const snapshot = parseTestDraftClient(environment.document, environment.location, settingsReceipt);
        const autodraft = controllerApi.runtime.isAutodraftActive(environment.document);
        rail.setContext({ roomId: TEST_LEAGUE_ID, seat: snapshot.seat, league: "HORSE COLLAR #2", armed: false, autodraft, kill: false });
        rail.setWarnings([
          ...snapshot.errors.map((text) => ({ severity: "danger", text })),
          ...(autodraft ? [{ severity: "danger", text: "Autodraft is active: execution is fail-closed." }] : []),
        ]);
        rail.controls.arm.textContent = "ARM TEST";
        if (!snapshot.ready || autodraft) {
          rail.render("bad", "TEST PREFLIGHT LOCKED", [...snapshot.errors, ...(autodraft ? ["autodraft_active"] : [])].join(" · "));
          rail.controls.arm.disabled = true;
          return false;
        }
        rail.render("ok", "READY TO ARM TEST", `League ${TEST_LEAGUE_ID} · draft slot ${snapshot.seat} · 12 teams · 19 rounds`);
        rail.controls.arm.disabled = false;
        return true;
      };
      rail.controls.arm.addEventListener("click", () => {
        const fresh = parseTestDraftClient(environment.document, environment.location, readJson(environment.localStorage, TEST_SETTINGS_KEY, null));
        const currentAutodraft = controllerApi.runtime.isAutodraftActive(environment.document);
        if (!fresh.ready || currentAutodraft) {
          rail.setWarnings([
            ...fresh.errors.map((text) => ({ severity: "danger", text })),
            ...(currentAutodraft ? [{ severity: "danger", text: "Autodraft is active: execution is fail-closed." }] : []),
          ]);
          rail.render("bad", "TEST PREFLIGHT LOCKED", [...fresh.errors, ...(currentAutodraft ? ["autodraft_active"] : [])].join(" · "));
          return;
        }
        armRecord = makeTestPreflight(fresh);
        environment.sessionStorage.setItem(PREFLIGHT_KEY, JSON.stringify(armRecord));
        writeReceipt(environment.localStorage, { kind: "test_armed_from_draftclient", roomId: TEST_LEAGUE_ID, seat: fresh.seat, urlSeat: TEST_TEAM_ID, expiresAt: armRecord.expiresAt });
        rail.addEvent("test armed", `league ${TEST_LEAGUE_ID} · draft slot ${fresh.seat}`);
        environment.location.reload();
      });
      if (!update() && environment.MutationObserver) {
        const observer = new environment.MutationObserver(() => { if (update()) observer.disconnect(); });
        observer.observe(environment.document.body, { childList: true, subtree: true, characterData: true });
      }
      return;
    }
    const executionMode = armRecord?.mode === "test_league_19_idp" ? "TEST" : "MOCK";
    const mode = modeAllowlist({ mode: executionMode, leagueId: room.roomId });
    const draftSeat = executionMode === "TEST" ? Number(armRecord?.seat) : room.seat;
    const configName = executionMode === "TEST" ? "test_league_19_idp" : "public_mock_15";
    const expectedRosterTotal = executionMode === "TEST" ? 19 : 15;
    const rosterSlots = executionMode === "TEST" ? TEST_ROSTER_SLOTS : PUBLIC_ROSTER_SLOTS;
    const leagueLabel = executionMode === "TEST" ? "HORSE COLLAR #2" : room.roomId === DISABLED_LEAGUE_ID ? "420010 BLOCKED" : "PUBLIC";
    const receiptRoom = { roomId: room.roomId, seat: draftSeat, urlSeat: room.seat };
    rail.setMode(executionMode);
    rail.setExpanded(true);
    rail.setRoster(rosterSlots.map((slot) => ({ slot })));
    rail.setContext({ roomId: room.roomId, seat: draftSeat, league: leagueLabel, armed: false, autodraft: controllerApi.runtime.isAutodraftActive(environment.document), kill: false });
    if (!mode.allowed) {
      rail.setWarnings([{ severity: "danger", text: mode.reason }]);
      rail.render("bad", "LOCKED", mode.reason);
      writeReceipt(environment.localStorage, { kind: "extension_locked", roomId: room.roomId, seat: room.seat, failure: mode.reason });
      return;
    }
    enableExport(environment, rail, receiptRoom);
    const preflightError = validateDraftPreflight(armRecord, room);
    if (preflightError) {
      writeReceipt(environment.localStorage, { kind: "extension_locked", roomId: room.roomId, seat: room.seat, failure: preflightError });
      rail.setWarnings(buildUiWarnings({ room, armRecord: null, autodraft: controllerApi.runtime.isAutodraftActive(environment.document), roster: null, board: boardData.offense, expectedRosterTotal }));
      rail.render("bad", "LOCKED", `${preflightError} · arm from the approved ${executionMode.toLowerCase()} preflight`);
      return;
    }
    rail.setContext({ roomId: room.roomId, seat: draftSeat, league: leagueLabel, armed: true, autodraft: controllerApi.runtime.isAutodraftActive(environment.document), kill: false });
    rail.render("", "VALIDATING", `Room ${room.roomId} · draft slot ${draftSeat}`);
    await waitForEmptyDraft(environment.document, controllerApi, environment, expectedRosterTotal, executionMode);
    const board = await prepareBoard(environment.document, environment, controllerApi, boardData, executionMode);
    rail.setBoard(board);
    rail.setRecommendations([], { fullBoard: board });
    rail.setWarnings(buildUiWarnings({ room, armRecord, autodraft: controllerApi.runtime.isAutodraftActive(environment.document), roster: { total: expectedRosterTotal }, board, expectedRosterTotal }));
    const runner = runnerApi.create({
      configName,
      executionMode,
      expectedRoomId: room.roomId,
      expectedSeat: draftSeat,
      expectedUrlSeat: room.seat,
      observedTeamCount: armRecord.observedTeamCount,
      observedRosterSlots: armRecord.observedRosterSlots,
      minimumFallbacks: 5,
      pollMs: 25,
      filterDeadlineMs: 5000,
      board,
      readManualOverride: () => readJson(environment.sessionStorage, MANUAL_STAGE_KEY, null),
      consumeManualOverride: (outcome) => {
        const stage = readJson(environment.sessionStorage, MANUAL_STAGE_KEY, null);
        environment.sessionStorage.removeItem(MANUAL_STAGE_KEY);
        rail.setPinOutcome(outcome);
        writeReceipt(environment.localStorage, { kind: `manual_pin_${outcome.status}`, roomId: room.roomId, seat: draftSeat, expectedRound: outcome.expectedRound, chosenYahooId: outcome.chosenYahooId ?? null, failure: outcome.reason ?? null });
        rail.addEvent(`manual pin ${outcome.status}`, outcome.chosenYahooId ? `Y!${outcome.chosenYahooId} · R${outcome.expectedRound}` : `${outcome.reason ?? "not applied"} · ${stage?.targets?.length ?? 0} staged`);
      },
      onAlert: ({ state, failure, reason }) => rail.render("bad", state, failure?.code ?? reason ?? "runner stopped"),
    }, environment);
    environment[GLOBAL_KEY] = { runner, room, token: armRecord };
    rail.setManualHandler((targets) => {
      try {
        const status = runner.getStatus();
        if (status.state !== "created" && status.state !== "running") throw new Error("manual pin requires an active runner");
        if (status.busy || status.currentController || controllerApi.runtime.readOwnedTurn(environment.document)) {
          throw new Error("manual pin must be set before our clock starts");
        }
        const expectedRound = status.picks.length + 1;
        const stage = stageManualTargets(environment.sessionStorage, targets, { ...receiptRoom, expectedRound });
        writeReceipt(environment.localStorage, { kind: "manual_pin_staged", roomId: room.roomId, seat: draftSeat, expectedRound, targetYahooIds: stage.targets.map((target) => target.yahooId) });
        rail.setPinned(stage);
        rail.addEvent("next pick pinned", `R${expectedRound} · ${stage.targets.map((target) => `Y!${target.yahooId}`).join(" → ")}`);
        rail.render("ok", "NEXT PICK PINNED", `Round ${expectedRound} · conditional priority with five verified baseline fallbacks`);
        return true;
      } catch (error) {
        rail.addEvent("manual pin rejected", String(error?.message ?? error));
        rail.render("bad", "PIN REJECTED", String(error?.message ?? error));
        return false;
      }
    }, () => {
      const stage = readJson(environment.sessionStorage, MANUAL_STAGE_KEY, null);
      environment.sessionStorage.removeItem(MANUAL_STAGE_KEY);
      writeReceipt(environment.localStorage, { kind: "manual_pin_cleared", roomId: room.roomId, seat: draftSeat, expectedRound: stage?.expectedRound ?? null });
      rail.addEvent("manual pin cleared", stage ? `R${stage.expectedRound}` : "no active pin");
      rail.render("ok", "BASELINE ACTIVE", "Operator pin cleared; deterministic ladder remains armed.");
      return true;
    });
    const existingPin = readJson(environment.sessionStorage, MANUAL_STAGE_KEY, null);
    if (existingPin?.roomId === room.roomId && Number(existingPin.seat) === draftSeat) rail.setPinned(existingPin);
    rail.controls.halt.disabled = false;
    enableExport(environment, rail, receiptRoom, runner);
    rail.controls.halt.addEventListener("click", () => {
      runner.halt("operator_kill_switch");
      environment.sessionStorage.removeItem(PREFLIGHT_KEY);
      rail.addEvent("kill switch engaged", "runner halted; re-arm from a new waiting room");
      rail.setContext({ roomId: room.roomId, seat: draftSeat, league: leagueLabel, armed: false, autodraft: controllerApi.runtime.isAutodraftActive(environment.document), kill: true });
      rail.render("bad", "HALTED", "One-way kill switch engaged. Re-arm from a new waiting room.");
      rail.controls.halt.disabled = true;
    });
    runner.start();
    if (runner.getStatus().state !== "running") {
      rail.controls.halt.disabled = true;
      environment.sessionStorage.removeItem(PREFLIGHT_KEY);
      return;
    }
    writeReceipt(environment.localStorage, { kind: "page_local_runner_started", roomId: room.roomId, seat: draftSeat, urlSeat: room.seat, boardPlayers: board.length, executionMode });
    rail.addEvent("runner started", `room ${room.roomId} · draft slot ${draftSeat}`);
    rail.render("ok", "RUNNING", `Room ${room.roomId} · draft slot ${draftSeat} · 0/${expectedRosterTotal} confirmed`);
    let last = "";
    const statusTimer = environment.setInterval(() => {
      const status = runner.getStatus();
      const turn = controllerApi.runtime.readOwnedTurn(environment.document);
      const clock = "--:--";
      const clockVerified = false;
      const autodraft = controllerApi.runtime.isAutodraftActive(environment.document);
      const marker = JSON.stringify([status.state, status.picks.length, status.failure, turn?.label ?? null, clock, autodraft]);
      if (marker === last) return;
      last = marker;
      const kind = status.state === "completed" ? "complete" : status.state === "running" ? "ok" : "bad";
      const roster = controllerApi.runtime.parseRosterCount(environment.document.body?.innerText);
      const decision = runner.exportReceipts().filter((entry) => entry.kind === "runner_turn_resolved").at(-1)?.decision ?? null;
      rail.setContext({ roomId: room.roomId, seat: draftSeat, league: leagueLabel, round: turn?.round, pick: turn?.pick, clock, clockVerified, armed: true, autodraft, kill: ["halted", "failed"].includes(status.state) });
      rail.setRoster(buildUiRoster(status.picks, rosterSlots), status.picks.at(-1));
      rail.setRecommendations(buildUiRecommendations(board, decision), { fullBoard: board, disagreement: status.failure?.code?.includes("mismatch") });
      rail.setBetweenTurns(buildUiOpponentWindow(decision, executionMode));
      rail.setWarnings(buildUiWarnings({ room, armRecord, autodraft, roster, board, expectedRosterTotal }));
      rail.render(kind, status.state, `${status.picks.length}/${expectedRosterTotal} confirmed${status.failure ? ` · ${status.failure.code ?? status.failure}` : ""}`);
      if (["completed", "failed", "halted", "stopped"].includes(status.state)) {
        environment.clearInterval(statusTimer);
        environment.sessionStorage.removeItem(PREFLIGHT_KEY);
        environment.sessionStorage.removeItem(MANUAL_STAGE_KEY);
        rail.setPinned(null);
        rail.controls.halt.disabled = true;
      }
    }, 100);
  }

  async function boot(environment = root) {
    if (!environment.document || !environment.location) return null;
    const rail = createRail(environment.document);
    attachCommandCenterBridge(environment, rail);
    try {
      if (environment.location.pathname === "/f1/mock_waiting") {
        bootWaitingRoom(environment, rail);
      } else if (environment.location.pathname === `/f1/${TEST_LEAGUE_ID}/settings`) {
        bootTestSettings(environment, rail);
      } else if (environment.location.pathname === `/f1/${TEST_LEAGUE_ID}/draft`) {
        bootTestDraftHome(environment, rail);
      } else if (/^\/draftclient\/f1\/\d+\/\d+\/?$/.test(environment.location.pathname)) {
        await bootDraft(environment, rail);
      }
    } catch (error) {
      rail.render("bad", "FAILED CLOSED", String(error?.message ?? error));
      try {
        const match = String(environment.location.pathname ?? "").match(/^\/draftclient\/f1\/(\d+)\/(\d+)\/?$/);
        const room = match ? { roomId: match[1], seat: Number(match[2]) } : null;
        writeReceipt(environment.localStorage, {
          kind: "extension_failed",
          roomId: room?.roomId,
          seat: room?.seat,
          failure: String(error?.message ?? error),
        });
        enableExport(environment, rail, room);
      } catch {
        // The visible failure remains authoritative when receipt storage is unavailable.
      }
    }
    return rail;
  }

  root.SKRODZKaiYahooMockExtension = {
    version: VERSION,
    boot,
    _test: {
      normalize,
      sameSlots,
      parseSequentialTeamCount,
      parseRosterSlots,
      parseWaitingRoom,
      makePreflight,
      parseTestSettings,
      makeTestSettingsReceipt,
      validTestSettingsReceipt,
      parseTestDraftHome,
      parseTestDraftClient,
      makeTestPreflight,
      validateDraftPreflight,
      modeAllowlist,
      validateExactYahooTargets,
      stageManualTargets,
      mergeDefenseBoard,
      buildExportPayload,
      buildUiRoster,
      buildUiRecommendations,
      buildUiOpponentWindow,
      commandCenterRole,
      attachCommandCenterBridge,
      publicRosterSlots: PUBLIC_ROSTER_SLOTS,
      testRosterSlots: TEST_ROSTER_SLOTS,
    },
  };

  if (root.document && root.location && !root[GLOBAL_KEY]) void boot(root);
})(globalThis);
