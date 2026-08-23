(function installYahooMockExtension(root) {
  "use strict";

  const VERSION = "0.1.0";
  const GLOBAL_KEY = "__skrodzkaiYahooMockExtensionV1";
  const PREFLIGHT_KEY = "skrodzkai-yahoo-mock-extension-preflight-v1";
  const RECEIPT_KEY = "skrodzkai-yahoo-mock-extension-receipts-v1";
  const RUNNER_RECEIPT_KEY = "skrodzkai-yahoo-mock-runner-receipts-v1";
  const CONTROLLER_RECEIPT_KEY = "skrodzkai-yahoo-draft-controller-receipts-v1";
  const PREFLIGHT_TTL_MS = 30 * 60 * 1000;
  const PUBLIC_ROSTER_SLOTS = Object.freeze([
    "QB", "WR", "WR", "RB", "RB", "TE", "W/R/T", "K", "DEF",
    "BN", "BN", "BN", "BN", "BN", "BN",
  ]);
  const STARTER_SLOTS = Object.freeze(PUBLIC_ROSTER_SLOTS.slice(0, 9));

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
    const heading = lines.findIndex((line) => normalize(line) === "ROSTER POSITIONS");
    const raw = lines.slice(heading + 1).find(Boolean) ?? "";
    const starters = raw.split(",").map((slot) => normalize(slot)).filter(Boolean);
    if (sameSlots(starters, STARTER_SLOTS)) return [...starters, ...Array(6).fill("BN")];
    return starters;
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

  function validateDraftPreflight(token, room, now = Date.now()) {
    if (!token || token.mode !== "public_mock_15") return "mock_waiting_room_arm_required";
    if (!Number.isFinite(token.expiresAt) || token.expiresAt <= now) return "mock_arm_expired";
    if (!room || String(token.roomId) !== String(room.roomId) || Number(token.seat) !== Number(room.seat)) {
      return "mock_room_or_seat_changed";
    }
    if (Number(token.observedTeamCount) !== 12) return "mock_team_count_not_12";
    if (!sameSlots(token.observedRosterSlots, PUBLIC_ROSTER_SLOTS)) return "mock_roster_shape_mismatch";
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

  async function prepareBoard(documentRef, environment, controllerApi, boardData) {
    try {
      const availableDefenses = await readPosition(
        documentRef,
        environment,
        controllerApi,
        "Team Defenses",
        "DEF",
      );
      const defenses = mergeDefenseBoard(availableDefenses, boardData.defenses);
      return [...boardData.offense, ...boardData.kickers, ...defenses];
    } finally {
      setFilter(documentRef, environment, "All Positions");
    }
  }

  function buildExportPayload({ roomId, seat, storage, runner }) {
    const belongsToRoom = (entry) => String(entry.roomId) === String(roomId) && Number(entry.seat) === Number(seat);
    return {
      exportedAt: new Date().toISOString(),
      extensionVersion: VERSION,
      roomId: String(roomId),
      seat: Number(seat),
      status: runner?.getStatus?.() ?? null,
      extensionReceipts: readJson(storage, RECEIPT_KEY, []).filter(belongsToRoom),
      runnerReceipts: readJson(storage, RUNNER_RECEIPT_KEY, []).filter(belongsToRoom),
      controllerReceipts: readJson(storage, CONTROLLER_RECEIPT_KEY, []).filter(belongsToRoom),
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
        .rail { position: fixed; right: 14px; bottom: 14px; z-index: 2147483647; width: 286px; box-sizing: border-box; color: #eafcff; background: #061115; border: 1px solid #19d3e6; box-shadow: 0 14px 44px rgba(0,0,0,.42); font-family: "Avenir Next Condensed", "DIN Condensed", "Futura", sans-serif; letter-spacing: .035em; }
        .cap { display: flex; align-items: center; justify-content: space-between; padding: 9px 11px 8px; border-bottom: 1px solid rgba(25,211,230,.35); background: linear-gradient(90deg, rgba(25,211,230,.13), transparent 72%); }
        .brand { font-size: 13px; font-weight: 800; letter-spacing: .13em; }
        .mode { color: #6ff2ff; font: 700 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
        .body { padding: 11px; }
        .state { color: #ffffff; font: 800 15px/1.15 "Avenir Next Condensed", "DIN Condensed", sans-serif; text-transform: uppercase; }
        .detail { min-height: 30px; margin-top: 6px; color: #9eb8bd; font: 500 10px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
        .meter { height: 2px; margin: 10px 0; background: #173239; overflow: hidden; }
        .meter::after { content: ""; display: block; width: 34%; height: 100%; background: #19d3e6; box-shadow: 0 0 12px #19d3e6; animation: scan 1.8s ease-in-out infinite alternate; }
        @keyframes scan { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
        .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
        button { appearance: none; border: 1px solid #31525a; border-radius: 0; padding: 8px 7px; color: #cae8ed; background: transparent; cursor: pointer; font: 800 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .06em; text-transform: uppercase; }
        button.primary { border-color: #19d3e6; color: #061115; background: #19d3e6; }
        button.danger { border-color: #ff6b6b; color: #ff9393; }
        button:disabled { cursor: not-allowed; opacity: .35; }
        .ok .state { color: #6ff2ff; }
        .bad .state { color: #ff9393; }
        .complete .state { color: #d9ff78; }
      </style>
      <section class="rail">
        <header class="cap"><span class="brand">SKRODZKai</span><span class="mode">MOCK / LOCAL</span></header>
        <div class="body">
          <div class="state">LOCKED</div>
          <div class="detail">Waiting for a verified public mock.</div>
          <div class="meter"></div>
          <div class="actions">
            <button class="primary arm" type="button" disabled>ARM MOCK</button>
            <button class="danger halt" type="button" disabled>HALT</button>
            <button class="export" type="button" disabled>EXPORT</button>
          </div>
        </div>
      </section>`;
    documentRef.documentElement.appendChild(host);
    const rail = shadow.querySelector(".rail");
    const state = shadow.querySelector(".state");
    const detail = shadow.querySelector(".detail");
    const controls = {
      arm: shadow.querySelector(".arm"),
      halt: shadow.querySelector(".halt"),
      export: shadow.querySelector(".export"),
    };
    const api = {
      controls,
      render(kind, label, message) {
        rail.className = `rail ${kind ?? ""}`.trim();
        state.textContent = label;
        detail.textContent = message;
      },
    };
    host._controlApi = api;
    return api;
  }

  async function waitForEmptyDraft(documentRef, controllerApi, environment, deadlineMs = 15000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < deadlineMs) {
      const roster = controllerApi.runtime.parseRosterCount(documentRef.body?.innerText);
      const filtersReady = ["All Positions", "Team Defenses", "Kickers"]
        .every((label) => findFilter(documentRef, label));
      if (roster?.filled === 0 && roster?.total === 15 && filtersReady) return roster;
      await new Promise((resolve) => environment.setTimeout(resolve, 50));
    }
    throw new Error("empty_public_mock_draft_not_ready");
  }

  function bootWaitingRoom(environment, rail) {
    const update = () => {
      const snapshot = parseWaitingRoom(environment.document, environment.location);
      const armed = readJson(environment.sessionStorage, PREFLIGHT_KEY, null);
      const active = armed && !validateDraftPreflight(armed, { roomId: snapshot.roomId, seat: snapshot.seat });
      if (!snapshot.ready) {
        rail.render("bad", "PREFLIGHT FAILED", snapshot.errors.join(" · "));
        rail.controls.arm.disabled = true;
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
      } else {
        const armRecord = makePreflight(snapshot);
        environment.sessionStorage.setItem(PREFLIGHT_KEY, JSON.stringify(armRecord));
        writeReceipt(environment.localStorage, { kind: "mock_armed", roomId: snapshot.roomId, seat: snapshot.seat, expiresAt: armRecord.expiresAt });
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

  async function bootDraft(environment, rail) {
    const controllerApi = environment.SKRODZKaiYahooDraftController;
    const runnerApi = environment.SKRODZKaiYahooMockRunner;
    const boardData = environment.SKRODZKaiYahooMockBoard;
    if (!controllerApi || !runnerApi || !boardData) throw new Error("extension_dependencies_missing");
    const room = controllerApi.runtime.parseRoom(environment.location.pathname);
    if (!room) throw new Error("public_mock_draft_room_missing");
    enableExport(environment, rail, room);
    const armRecord = readJson(environment.sessionStorage, PREFLIGHT_KEY, null);
    const preflightError = validateDraftPreflight(armRecord, room);
    if (preflightError) {
      writeReceipt(environment.localStorage, { kind: "extension_locked", roomId: room.roomId, seat: room.seat, failure: preflightError });
      rail.render("bad", "LOCKED", `${preflightError} · arm from Yahoo's public mock waiting room`);
      return;
    }
    rail.render("", "VALIDATING", `Room ${room.roomId} · seat ${room.seat}`);
    await waitForEmptyDraft(environment.document, controllerApi, environment);
    const board = await prepareBoard(environment.document, environment, controllerApi, boardData);
    const runner = runnerApi.create({
      configName: "public_mock_15",
      expectedRoomId: room.roomId,
      expectedSeat: room.seat,
      observedTeamCount: armRecord.observedTeamCount,
      observedRosterSlots: armRecord.observedRosterSlots,
      minimumFallbacks: 5,
      pollMs: 25,
      filterDeadlineMs: 5000,
      board,
      onAlert: ({ state, failure, reason }) => rail.render("bad", state, failure?.code ?? reason ?? "runner stopped"),
    }, environment);
    environment[GLOBAL_KEY] = { runner, room, token: armRecord };
    rail.controls.halt.disabled = false;
    enableExport(environment, rail, room, runner);
    rail.controls.halt.addEventListener("click", () => {
      runner.halt("operator_kill_switch");
      environment.sessionStorage.removeItem(PREFLIGHT_KEY);
      rail.render("bad", "HALTED", "One-way kill switch engaged. Re-arm from a new waiting room.");
      rail.controls.halt.disabled = true;
    });
    runner.start();
    if (runner.getStatus().state !== "running") {
      rail.controls.halt.disabled = true;
      environment.sessionStorage.removeItem(PREFLIGHT_KEY);
      return;
    }
    writeReceipt(environment.localStorage, { kind: "page_local_runner_started", roomId: room.roomId, seat: room.seat, boardPlayers: board.length });
    rail.render("ok", "RUNNING", `Room ${room.roomId} · seat ${room.seat} · 0/15 confirmed`);
    let last = "";
    const statusTimer = environment.setInterval(() => {
      const status = runner.getStatus();
      const marker = JSON.stringify([status.state, status.picks.length, status.failure]);
      if (marker === last) return;
      last = marker;
      const kind = status.state === "completed" ? "complete" : status.state === "running" ? "ok" : "bad";
      rail.render(kind, status.state, `${status.picks.length}/15 confirmed${status.failure ? ` · ${status.failure.code ?? status.failure}` : ""}`);
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
      validateDraftPreflight,
      mergeDefenseBoard,
      buildExportPayload,
      publicRosterSlots: PUBLIC_ROSTER_SLOTS,
    },
  };

  if (root.document && root.location && !root[GLOBAL_KEY]) void boot(root);
})(globalThis);
