(function installYahooMockExtension(root) {
  "use strict";

  const VERSION = "0.5.1";
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
    const stage = { at: now, roomId: String(room?.roomId ?? ""), seat: Number(room?.seat), targets: staged };
    if (!stage.roomId || !Number.isInteger(stage.seat)) throw new Error("manual stage room binding is required");
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
    if (!body.includes("Chef Joe")) errors.push("verified_test_team_missing");
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
    host.setAttribute("aria-label", "SKRODZKai Yahoo mock draft control");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .rail { position: fixed; right: 14px; bottom: 14px; z-index: 2147483647; width: 400px; min-width: 360px; max-width: 460px; max-height: calc(100vh - 28px); box-sizing: border-box; overflow: hidden; color: #d9eef0; background: #071215; border: 1px solid #1bd0dc; box-shadow: 0 18px 54px rgba(0,0,0,.55); font: 500 11px/1.3 "Avenir Next Condensed", "DIN Condensed", "Futura", sans-serif; letter-spacing: .025em; resize: horizontal; }
        .rail.collapsed { width: 56px; min-width: 56px; resize: none; }
        .rail.collapsed .body, .rail.collapsed .mode-strip, .rail.collapsed .cap-meta { display: none; }
        .compact-status { display: none; color: #f5b942; font: 900 8px/1 ui-monospace, SFMono-Regular, Menlo, monospace; writing-mode: vertical-rl; text-orientation: mixed; letter-spacing: .05em; }
        .rail.collapsed .compact-status { display: block; }
        .cap { display: flex; align-items: center; justify-content: space-between; min-height: 34px; padding: 7px 9px; border-bottom: 1px solid #16373a; background: linear-gradient(100deg, #12363a, #091619 68%); }
        .brand { color: #f1f8f7; font-size: 14px; font-weight: 900; letter-spacing: .16em; white-space: nowrap; }
        .cap-meta { display: flex; align-items: center; gap: 7px; }
        .mode { color: #f5b942; font: 900 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .12em; }
        .collapse { width: 24px; padding: 5px 0; color: #75e9eb; border-color: #28656a; }
        .mode-strip { display: grid; grid-template-columns: repeat(3, 1fr); border-bottom: 1px solid #16373a; }
        .mode-chip { padding: 5px 4px; color: #6f9295; text-align: center; font: 900 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; }
        .mode-chip.active { color: #071215; background: #f5b942; }
        .mode-chip.blocked { color: #e56767; text-decoration: line-through; }
        .body { display: grid; grid-template-rows: auto auto auto auto auto auto; max-height: calc(100vh - 96px); overflow: auto; scrollbar-color: #2b5d61 #071215; }
        .status { display: grid; grid-template-columns: repeat(4, 1fr); border-bottom: 1px solid #16373a; }
        .stat { min-width: 0; padding: 7px 8px 6px; border-right: 1px solid #16373a; }
        .stat:nth-child(4n) { border-right: 0; }
        .label { display: block; color: #6f9295; font: 800 8px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .1em; text-transform: uppercase; }
        .value { display: block; margin-top: 4px; overflow: hidden; color: #f4fbfa; font: 900 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
        .value.accent { color: #6ff0df; }
        .value.warn { color: #f5b942; }
        .value.danger { color: #ff7474; }
        .section { border-bottom: 1px solid #16373a; }
        .section-head { display: flex; align-items: center; justify-content: space-between; padding: 7px 9px 5px; color: #83b9bc; font: 900 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; }
        .section-head small { color: #55777b; font-size: 8px; letter-spacing: .04em; }
        .state { padding: 0 9px 4px; color: #ffffff; font: 900 15px/1.1 "Avenir Next Condensed", "DIN Condensed", sans-serif; letter-spacing: .08em; text-transform: uppercase; }
        .detail { min-height: 18px; padding: 0 9px 7px; color: #9eb8bd; font: 500 9px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
        .meter { height: 2px; margin: 0 9px 7px; background: #17373a; overflow: hidden; }
        .meter::after { content: ""; display: block; width: 34%; height: 100%; background: #19d3e6; box-shadow: 0 0 12px #19d3e6; animation: scan 1.8s ease-in-out infinite alternate; }
        @keyframes scan { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
        .roster, .board, .events, .between, .warnings { padding: 0 9px 8px; }
        .roster { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px 8px; }
        .slot { display: flex; justify-content: space-between; gap: 3px; padding: 3px 0; border-bottom: 1px dotted #1b3e41; color: #91aaac; font: 800 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
        .slot b { color: #dff8f3; font-weight: 900; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .slot.open b { color: #668488; }
        .board-row { display: grid; grid-template-columns: 17px minmax(0, 1fr) 52px; gap: 5px; padding: 5px 0; border-bottom: 1px solid #183b3e; }
        .board-row.primary { border-left: 2px solid #f5b942; padding-left: 5px; background: rgba(245,185,66,.06); }
        .rank { color: #6b969a; font: 900 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
        .player { overflow: hidden; color: #e7f5f3; font-weight: 900; text-overflow: ellipsis; white-space: nowrap; }
        .player em { color: #6f9295; font-style: normal; font-size: 9px; font-weight: 700; }
        .reason { margin-top: 2px; overflow: hidden; color: #77999c; font: 500 8px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
        .metrics { color: #6ff0df; text-align: right; font: 800 8px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; }
        .metrics .dim { color: #789396; }
        .search { display: flex; gap: 4px; padding: 0 9px 6px; }
        input { min-width: 0; flex: 1; padding: 6px 7px; border: 1px solid #28565a; border-radius: 0; outline: none; color: #e7f5f3; background: #0a1b1e; font: 700 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
        input:focus { border-color: #6ff0df; }
        .manual-list { max-height: 86px; overflow: auto; padding: 0 9px 5px; }
        .manual-row { display: flex; align-items: center; gap: 5px; padding: 4px 0; border-bottom: 1px dotted #1b3e41; }
        .manual-row button { flex: 1; padding: 4px; border: 0; text-align: left; }
        .manual-row small { color: #6f9295; font: 700 8px ui-monospace, SFMono-Regular, Menlo, monospace; }
        .manual-actions, .actions { display: flex; gap: 5px; padding: 0 9px 8px; }
        button { appearance: none; border: 1px solid #315b5e; border-radius: 0; padding: 6px 7px; color: #c7e4e5; background: transparent; cursor: pointer; font: 900 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .06em; text-transform: uppercase; }
        button:hover:not(:disabled) { border-color: #6ff0df; color: #6ff0df; }
        button.primary { border-color: #19d3e6; color: #071215; background: #19d3e6; }
        button.danger { border-color: #ff6b6b; color: #ff9393; }
        button.warn { border-color: #f5b942; color: #f5b942; }
        button:disabled { cursor: not-allowed; opacity: .35; }
        .manual-actions button, .actions button { flex: 1; }
        .event-log { max-height: 74px; overflow: auto; padding: 0 9px 8px; }
        .event { padding: 2px 0; color: #789396; font: 700 8px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace; }
        .event b { color: #b6d6d8; }
        .warning { padding: 3px 0; color: #f5b942; font: 800 8px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; }
        .warning.danger { color: #ff7474; }
        .pressure { color: #b6d6d8; font: 700 9px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; }
        .pressure b { color: #f5b942; }
        .ok .state { color: #6ff0df; }
        .bad .state { color: #ff9393; }
        .complete .state { color: #d9ff78; }
        @media (prefers-reduced-motion: reduce) { .meter::after { animation: none; } }
      </style>
      <section class="rail">
        <header class="cap"><span class="brand">SKRODZKai // WAR ROOM</span><span class="compact-status" data-compact-status>MOCK · PUBLIC · — · — · --:-- · SAFE</span><span class="cap-meta"><span class="mode">MOCK / LOCAL</span><button class="collapse" type="button" aria-label="Collapse war room">−</button></span></header>
        <div class="mode-strip"><span class="mode-chip active">MOCK</span><span class="mode-chip">TEST</span><span class="mode-chip blocked">REAL ⛔</span></div>
        <div class="body">
          <div class="status">
            <div class="stat"><span class="label">League</span><span class="value" data-status="league">PUBLIC</span></div>
            <div class="stat"><span class="label">Room</span><span class="value" data-status="room">—</span></div>
            <div class="stat"><span class="label">Seat</span><span class="value" data-status="seat">—</span></div>
            <div class="stat"><span class="label">Round / Pick</span><span class="value accent" data-status="turn">— / —</span></div>
            <div class="stat"><span class="label">Clock</span><span class="value" data-status="clock">--:--</span></div>
            <div class="stat"><span class="label">Armed</span><span class="value" data-status="armed">NO</span></div>
            <div class="stat"><span class="label">Autodraft</span><span class="value danger" data-status="autodraft">OFF</span></div>
            <div class="stat"><span class="label">Kill switch</span><span class="value danger" data-status="kill">READY</span></div>
          </div>
          <section class="section overview"><div class="state">LOCKED</div><div class="detail">Waiting for a verified public mock.</div><div class="meter"></div></section>
          <section class="section"><div class="section-head"><span>Roster / latest pick</span><small><span data-roster-count>0 / 15</span> · <span data-latest-pick>—</span></small></div><div class="roster" data-roster></div></section>
          <section class="section"><div class="section-head"><span>Recommendation board</span><small data-disagreement>MODEL ALIGNED</small></div><div class="board" data-board></div></section>
          <section class="section"><div class="section-head"><span>Between turns</span><small>PRESSURE / SURVIVAL</small></div><div class="between" data-between><div class="pressure">No owned turn validated.</div></div></section>
          <section class="section"><div class="section-head"><span>Manual override / stage only</span><small data-stage-count>0 STAGED</small></div><div class="search"><input data-search type="search" placeholder="Search board; exact Yahoo ID only" aria-label="Search Yahoo board" /></div><div class="manual-list" data-manual-list></div><div class="manual-actions"><button data-up type="button" disabled>↑</button><button data-down type="button" disabled>↓</button><button class="warn" data-pause type="button">PAUSE</button><button class="primary" data-confirm type="button" disabled>STAGE PICK</button></div></section>
          <section class="section"><div class="section-head"><span>Warnings</span><small data-warning-count>0</small></div><div class="warnings" data-warnings><div class="warning">No active warnings.</div></div></section>
          <section class="section"><div class="section-head"><span>Event log</span><small>LOCAL RECEIPTS</small></div><div class="event-log" data-events><div class="event">— <b>war room initialized</b></div></div></section>
          <div class="actions"><button class="primary arm" type="button" disabled>ARM MOCK</button><button class="danger halt" type="button" disabled>KILL SWITCH</button><button class="export" type="button" disabled>EXPORT</button></div>
        </div>
      </section>`;
    documentRef.documentElement.appendChild(host);
    const rail = shadow.querySelector(".rail");
    const state = shadow.querySelector(".state");
    const detail = shadow.querySelector(".detail");
    const data = {
      status: Object.fromEntries([...shadow.querySelectorAll("[data-status]")].map((node) => [node.dataset.status, node])),
      roster: shadow.querySelector("[data-roster]"),
      rosterCount: shadow.querySelector("[data-roster-count]"),
      latestPick: shadow.querySelector("[data-latest-pick]"),
      board: shadow.querySelector("[data-board]"),
      between: shadow.querySelector("[data-between]"),
      warnings: shadow.querySelector("[data-warnings]"),
      warningCount: shadow.querySelector("[data-warning-count]"),
      events: shadow.querySelector("[data-events]"),
      disagreement: shadow.querySelector("[data-disagreement]"),
      stageCount: shadow.querySelector("[data-stage-count]"),
      search: shadow.querySelector("[data-search]"),
      manualList: shadow.querySelector("[data-manual-list]"),
      up: shadow.querySelector("[data-up]"),
      down: shadow.querySelector("[data-down]"),
      pause: shadow.querySelector("[data-pause]"),
      confirm: shadow.querySelector("[data-confirm]"),
      compact: shadow.querySelector("[data-compact-status]"),
      modeLabel: shadow.querySelector(".mode"),
      modeChips: [...shadow.querySelectorAll(".mode-chip")],
    };
    const controls = {
      arm: shadow.querySelector(".arm"),
      halt: shadow.querySelector(".halt"),
      export: shadow.querySelector(".export"),
    };
    const ui = { mode: "MOCK", roster: [], board: [], staged: [], events: [], paused: false, latestPickId: "", onManualConfirm: null };
    const redrawManual = () => {
      const query = String(data.search.value ?? "").trim().toUpperCase();
      const matches = ui.board.filter((player) => `${player.name} ${player.position} ${player.team} ${player.yahooId}`.toUpperCase().includes(query)).slice(0, 12);
      data.manualList.innerHTML = matches.map((player) => `<div class="manual-row"><button type="button" data-stage-id="${player.yahooId}">${player.name} <small>${player.position} · ${player.team} · Y!${player.yahooId}</small></button></div>`).join("") || `<div class="event">No verified Yahoo IDs match.</div>`;
      for (const button of data.manualList.querySelectorAll("[data-stage-id]")) button.addEventListener("click", () => {
        const player = ui.board.find((candidate) => String(candidate.yahooId) === String(button.dataset.stageId));
        if (!player || ui.staged.some((candidate) => String(candidate.yahooId) === String(player.yahooId))) return;
        ui.staged.push({ yahooId: String(player.yahooId), name: String(player.name ?? ""), position: String(player.position ?? ""), team: String(player.team ?? "") });
        redrawManual();
      });
      data.stageCount.textContent = `${ui.staged.length} STAGED${ui.paused ? " · PAUSED" : ""}`;
      data.confirm.disabled = ui.staged.length === 0 || ui.paused;
      data.up.disabled = ui.staged.length < 2;
      data.down.disabled = ui.staged.length < 2;
      data.manualList.insertAdjacentHTML("afterbegin", ui.staged.map((player, index) => `<div class="manual-row"><button type="button" data-remove-stage="${player.yahooId}">${index + 1}. ${player.name || `Yahoo ${player.yahooId}`} <small>${player.position} · Y!${player.yahooId}</small></button></div>`).join(""));
      for (const button of data.manualList.querySelectorAll("[data-remove-stage]")) button.addEventListener("click", () => {
        ui.staged = ui.staged.filter((player) => String(player.yahooId) !== String(button.dataset.removeStage));
        redrawManual();
      });
    };
    data.search.addEventListener("input", redrawManual);
    data.up.addEventListener("click", () => { if (ui.staged.length > 1) [ui.staged[0], ui.staged[1]] = [ui.staged[1], ui.staged[0]]; redrawManual(); });
    data.down.addEventListener("click", () => { if (ui.staged.length > 1) [ui.staged[ui.staged.length - 1], ui.staged[ui.staged.length - 2]] = [ui.staged[ui.staged.length - 2], ui.staged[ui.staged.length - 1]]; redrawManual(); });
    data.pause.addEventListener("click", () => { ui.paused = !ui.paused; data.pause.textContent = ui.paused ? "RESUME" : "PAUSE"; redrawManual(); });
    data.confirm.addEventListener("click", () => { if (typeof ui.onManualConfirm === "function") ui.onManualConfirm(ui.staged.slice()); });
    shadow.querySelector(".collapse").addEventListener("click", () => { rail.classList.toggle("collapsed"); });
    const setStatus = (key, value, kind = "") => { if (!data.status[key]) return; data.status[key].textContent = value; data.status[key].className = `value ${kind}`.trim(); };
    const api = {
      controls,
      setMode(mode) {
        ui.mode = String(mode ?? "MOCK").toUpperCase();
        data.modeLabel.textContent = `${ui.mode} / LOCAL`;
        for (const chip of data.modeChips) {
          const chipMode = String(chip.textContent ?? "").replace("⛔", "").trim();
          chip.classList.toggle("active", chipMode === ui.mode);
        }
      },
      render(kind, label, message) {
        rail.className = `rail ${kind ?? ""}`.trim();
        state.textContent = label;
        detail.textContent = message;
      },
      setContext(context = {}) {
        const roomId = String(context.roomId ?? "—");
        setStatus("league", context.league ?? (roomId === DISABLED_LEAGUE_ID ? `420010 BLOCKED` : "PUBLIC"), roomId === DISABLED_LEAGUE_ID ? "danger" : "");
        setStatus("room", roomId);
        setStatus("seat", context.seat == null ? "—" : String(context.seat));
        setStatus("turn", context.round == null ? "— / —" : `R${context.round} / P${context.pick ?? "—"}`);
        setStatus("clock", context.clock ?? "--:--");
        setStatus("armed", context.armed ? "YES" : "NO", context.armed ? "accent" : "warn");
        setStatus("autodraft", context.autodraft ? "ON / BLOCKED" : "OFF", context.autodraft ? "danger" : "");
        setStatus("kill", context.kill ? "ENGAGED" : "READY", context.kill ? "danger" : "");
        data.compact.textContent = `${ui.mode} · ${context.league ?? "PUBLIC"} · ${roomId} · S${context.seat ?? "—"} · ${context.round == null ? "—" : `R${context.round}P${context.pick ?? "—"}`} · ${context.clock ?? "--:--"} · ${context.kill ? "KILL" : context.armed ? "ARMED" : "SAFE"}`;
      },
      setRoster(roster = [], latest = null) {
        ui.roster = Array.isArray(roster) ? roster : [];
        data.roster.innerHTML = ui.roster.map((slot) => `<div class="slot ${slot.player ? "filled" : "open"}"><span>${slot.slot}</span><b>${slot.player?.name ?? "OPEN"}</b></div>`).join("") || `<div class="event">Roster readback unavailable.</div>`;
        data.rosterCount.textContent = `${ui.roster.filter((slot) => slot.player).length} / ${ui.roster.length || 15}`;
        data.latestPick.textContent = latest ? `${latest.name ?? `Y!${latest.yahooId}`}` : "—";
        const latestId = String(latest?.yahooId ?? "");
        if (latest && latestId !== ui.latestPickId) {
          ui.latestPickId = latestId;
          api.addEvent("pick confirmed", `${latest.name ?? "Yahoo ID " + latest.yahooId} · ${latest.position ?? "—"}`);
        }
      },
      setRecommendations(recommendations = [], meta = {}) {
        if (Array.isArray(meta.fullBoard)) ui.board = meta.fullBoard;
        const rows = Array.isArray(recommendations) ? recommendations : [];
        data.board.innerHTML = rows.slice(0, 6).map((player, index) => `<div class="board-row ${index === 0 ? "primary" : ""}"><span class="rank">${index === 0 ? "P" : index}</span><div><div class="player">${player.name ?? `Yahoo ${player.yahooId}`} <em>${player.position ?? "—"} · ${player.team ?? "—"}</em></div><div class="reason">${player.reason ?? "verified local ladder"}</div></div><div class="metrics">${player.edge ?? "—"}<br /><span class="dim">${player.confidence ?? "—"} · ${player.freshness ?? "—"}</span></div></div>`).join("") || `<div class="event">No recommendation until turn and eligibility are validated.</div>`;
        data.disagreement.textContent = meta.disagreement ? "MODEL DISAGREEMENT" : "MODEL ALIGNED";
        data.disagreement.className = meta.disagreement ? "danger" : "";
        redrawManual();
      },
      setBetweenTurns(info = {}) {
        const pressure = String(info.pressure ?? "No owned turn validated.");
        const atRisk = Array.isArray(info.atRisk) && info.atRisk.length ? `At risk: ${info.atRisk.join(", ")}.` : "At risk: targets withheld until Yahoo availability is read.";
        data.between.innerHTML = `<div class="pressure"><b>Expected pressure:</b> ${pressure}</div><div class="pressure"><b>${atRisk}</b></div>`;
      },
      setWarnings(warnings = []) {
        const list = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
        data.warningCount.textContent = String(list.length);
        data.warnings.innerHTML = list.length ? list.map((warning) => `<div class="warning ${warning.severity === "danger" ? "danger" : ""}">⚠ ${warning.text ?? warning}</div>`).join("") : `<div class="warning">No active warnings.</div>`;
      },
      addEvent(kind, detailText = "") {
        ui.events.unshift({ at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }), kind, detail: detailText });
        ui.events = ui.events.slice(0, 18);
        data.events.innerHTML = ui.events.map((event) => `<div class="event">${event.at} <b>${event.kind}</b>${event.detail ? ` · ${event.detail}` : ""}</div>`).join("");
      },
      setBoard(board = []) { ui.board = Array.isArray(board) ? board : []; redrawManual(); },
      setManualHandler(handler) { ui.onManualConfirm = handler; },
      getManualStage() { return ui.staged.slice(); },
    };
    api.setContext();
    api.setRoster(PUBLIC_ROSTER_SLOTS.map((slot) => ({ slot })));
    api.setRecommendations([]);
    api.setWarnings([]);
    redrawManual();
    host._controlApi = api;
    return api;
  }

  async function waitForEmptyDraft(documentRef, controllerApi, environment, expectedRosterTotal = 15, deadlineMs = 15000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < deadlineMs) {
      const roster = controllerApi.runtime.parseRosterCount(documentRef.body?.innerText);
      const filtersReady = ["All Positions", "Team Defenses", "Kickers"]
        .every((label) => findFilter(documentRef, label));
      if (roster?.filled === 0 && roster?.total === expectedRosterTotal && filtersReady) return roster;
      await new Promise((resolve) => environment.setTimeout(resolve, 50));
    }
    throw new Error("empty_public_mock_draft_not_ready");
  }

  function uiOverallPick(round, seat, teams = 12) {
    return round % 2 === 1 ? (round - 1) * teams + seat : round * teams - seat + 1;
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
      return [{
        ...player,
        edge: Number.isFinite(adjusted) ? `+${adjusted.toFixed(1)}` : "POLICY",
        confidence: player.confidence ?? "LOCAL_RULE",
        freshness: "TURN",
        reason: `${leader?.bucket ?? "verified ladder"}; exact Yahoo ID`,
      }];
    });
  }

  function buildUiWarnings({ room, armRecord, autodraft, roster, board, expectedRosterTotal = 15 }) {
    const warnings = [
      { text: "Injury status: not live-validated; verify before any manual stage." },
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
    rail.setRoster(TEST_ROSTER_SLOTS.map((slot) => ({ slot })));
    const update = () => {
      const settingsReceipt = readJson(environment.sessionStorage, TEST_SETTINGS_KEY, null);
      const snapshot = parseTestDraftHome(environment.document, environment.location, settingsReceipt);
      const armed = readJson(environment.sessionStorage, PREFLIGHT_KEY, null);
      const active = armed?.mode === "test_league_19_idp" && !validateDraftPreflight(armed, { roomId: TEST_LEAGUE_ID, seat: TEST_TEAM_ID });
      rail.setContext({ roomId: TEST_LEAGUE_ID, seat: snapshot.seat, league: "HORSE COLLAR #2", armed: Boolean(active), autodraft: false, kill: false });
      rail.setWarnings(snapshot.errors.map((reason) => ({ severity: reason === "test_draft_slot_pending" ? "" : "danger", text: reason })));
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
      const settingsReceipt = readJson(environment.sessionStorage, TEST_SETTINGS_KEY, null);
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
    rail.setRoster(TEST_ROSTER_SLOTS.map((slot) => ({ slot })));
    const update = () => {
      const snapshot = parseTestSettings(environment.document, environment.location);
      if (!snapshot.ready) {
        environment.sessionStorage.removeItem(TEST_SETTINGS_KEY);
        rail.setWarnings(snapshot.errors.map((text) => ({ severity: "danger", text })));
        rail.render("bad", "TEST SETTINGS LOCKED", snapshot.errors.join(" · "));
        return false;
      }
      const receipt = makeTestSettingsReceipt(snapshot);
      environment.sessionStorage.setItem(TEST_SETTINGS_KEY, JSON.stringify(receipt));
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
    const armRecord = readJson(environment.sessionStorage, PREFLIGHT_KEY, null);
    const executionMode = armRecord?.mode === "test_league_19_idp" ? "TEST" : "MOCK";
    const mode = modeAllowlist({ mode: executionMode, leagueId: room.roomId });
    const draftSeat = executionMode === "TEST" ? Number(armRecord?.seat) : room.seat;
    const configName = executionMode === "TEST" ? "test_league_19_idp" : "public_mock_15";
    const expectedRosterTotal = executionMode === "TEST" ? 19 : 15;
    const rosterSlots = executionMode === "TEST" ? TEST_ROSTER_SLOTS : PUBLIC_ROSTER_SLOTS;
    const leagueLabel = executionMode === "TEST" ? "HORSE COLLAR #2" : room.roomId === DISABLED_LEAGUE_ID ? "420010 BLOCKED" : "PUBLIC";
    const receiptRoom = { roomId: room.roomId, seat: draftSeat, urlSeat: room.seat };
    rail.setMode(executionMode);
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
    await waitForEmptyDraft(environment.document, controllerApi, environment, expectedRosterTotal);
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
      onAlert: ({ state, failure, reason }) => rail.render("bad", state, failure?.code ?? reason ?? "runner stopped"),
    }, environment);
    environment[GLOBAL_KEY] = { runner, room, token: armRecord };
    rail.setManualHandler((targets) => {
      try {
        const stage = stageManualTargets(environment.sessionStorage, targets, receiptRoom);
        writeReceipt(environment.localStorage, { kind: "manual_targets_staged", roomId: room.roomId, seat: draftSeat, targetYahooIds: stage.targets.map((target) => target.yahooId) });
        rail.addEvent("manual targets staged", stage.targets.map((target) => `Y!${target.yahooId}`).join(", "));
        rail.render("ok", "STAGED ONLY", `${stage.targets.length} exact Yahoo ID${stage.targets.length === 1 ? "" : "s"} queued; click safety unchanged`);
      } catch (error) {
        rail.addEvent("manual stage rejected", String(error?.message ?? error));
        rail.render("bad", "STAGE REJECTED", String(error?.message ?? error));
      }
    });
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
      const marker = JSON.stringify([status.state, status.picks.length, status.failure]);
      if (marker === last) return;
      last = marker;
      const kind = status.state === "completed" ? "complete" : status.state === "running" ? "ok" : "bad";
      const turn = controllerApi.runtime.readOwnedTurn(environment.document);
      const roster = controllerApi.runtime.parseRosterCount(environment.document.body?.innerText);
      const autodraft = controllerApi.runtime.isAutodraftActive(environment.document);
      const decision = runner.exportReceipts().filter((entry) => entry.kind === "runner_turn_resolved").at(-1)?.decision ?? null;
      rail.setContext({ roomId: room.roomId, seat: draftSeat, league: leagueLabel, round: turn?.round, pick: turn?.pick, clock: (String(environment.document.body?.innerText ?? "").match(/\b\d{1,2}:\d{2}\b/) ?? ["--:--"])[0], armed: true, autodraft, kill: ["halted", "failed"].includes(status.state) });
      rail.setRoster(buildUiRoster(status.picks, rosterSlots), status.picks.at(-1));
      rail.setRecommendations(buildUiRecommendations(board, decision), { fullBoard: board, disagreement: status.failure?.code?.includes("mismatch") });
      rail.setBetweenTurns({ pressure: turn ? `next owned pick ${uiOverallPick(turn.round + 1, draftSeat)}; positional pressure is directional only` : "waiting for Yahoo-owned turn", atRisk: status.picks.length ? ["unvalidated targets withheld"] : [] });
      rail.setWarnings(buildUiWarnings({ room, armRecord, autodraft, roster, board, expectedRosterTotal }));
      rail.render(kind, status.state, `${status.picks.length}/${expectedRosterTotal} confirmed${status.failure ? ` · ${status.failure.code ?? status.failure}` : ""}`);
      if (["completed", "failed", "halted", "stopped"].includes(status.state)) {
        environment.clearInterval(statusTimer);
        environment.sessionStorage.removeItem(PREFLIGHT_KEY);
        rail.controls.halt.disabled = true;
      }
    }, 100);
  }

  async function boot(environment = root) {
    if (!environment.document || !environment.location) return null;
    const rail = createRail(environment.document);
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
      makeTestPreflight,
      validateDraftPreflight,
      modeAllowlist,
      validateExactYahooTargets,
      stageManualTargets,
      mergeDefenseBoard,
      buildExportPayload,
      buildUiRoster,
      buildUiRecommendations,
      publicRosterSlots: PUBLIC_ROSTER_SLOTS,
      testRosterSlots: TEST_ROSTER_SLOTS,
    },
  };

  if (root.document && root.location && !root[GLOBAL_KEY]) void boot(root);
})(globalThis);
