(function installYahooMockExtension(root) {
  "use strict";

  const VERSION = "0.15.0";
  const GLOBAL_KEY = "__skrodzkaiYahooMockExtensionV1";
  const PREFLIGHT_KEY = "skrodzkai-yahoo-mock-extension-preflight-v1";
  const RECEIPT_KEY = "skrodzkai-yahoo-mock-extension-receipts-v1";
  const RUNNER_RECEIPT_KEY = "skrodzkai-yahoo-mock-runner-receipts-v1";
  const CONTROLLER_RECEIPT_KEY = "skrodzkai-yahoo-draft-controller-receipts-v1";
  const MANUAL_STAGE_KEY = "skrodzkai-yahoo-mock-manual-stage-v1";
  const TEST_SETTINGS_KEY = "skrodzkai-yahoo-test-settings-v1";
  const RELOAD_MARKER_KEY = "skrodzkai-runtime-reload-marker-v1";
  const RELOAD_MARKER_TTL_MS = 15000;
  const RELOAD_PAGE_DELAY_MS = 1500;
  const PREFLIGHT_TTL_MS = 30 * 60 * 1000;
  const BOARD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const BOARD_FUTURE_TOLERANCE_MS = 15 * 60 * 1000;
  const DISABLED_LEAGUE_ID = "420010";
  const TEST_LEAGUE_ID = "542830";
  const TEST_TEAM_ID = 3;
  const TEST_MINIMUM_TEAMS = 10;
  const TEST_MAXIMUM_TEAMS = 12;
  const PUBLIC_ROSTER_SLOTS = Object.freeze([
    "QB", "WR", "WR", "RB", "RB", "TE", "W/R/T", "K", "DEF",
    "BN", "BN", "BN", "BN", "BN", "BN",
  ]);
  const STARTER_SLOTS = Object.freeze(PUBLIC_ROSTER_SLOTS.slice(0, 9));
  const TEST_ROSTER_SLOTS = Object.freeze([
    "QB", "WR", "WR", "WR", "RB", "RB", "TE", "W/R/T", "W/R/T",
    "K", "DEF", "D", "D", "BN", "BN", "BN", "BN", "BN", "BN",
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

  function recommendationHotkeyPlayer(state, event) {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(String(event?.target?.tagName ?? "").toUpperCase())) return null;
    const index = Number(event?.key) - 1;
    if (index < 0 || index >= 3 || state?.context?.ownedTurn !== true) return null;
    return state?.recommendations?.[index] ?? null;
  }

  function ownedTurnFromRunnerStatus(status) {
    return Boolean(status?.pendingDecision);
  }

  function sameSlots(left, right) {
    const a = Array.from(left ?? [], normalize);
    const b = Array.from(right ?? [], normalize);
    return a.length === b.length && a.every((slot, index) => slot === b[index]);
  }

  function boardHealthReceipt(boardData, now = Date.now()) {
    return root.SKRODZKaiYahooPageReaders.boardHealthReceipt(boardData, now, BOARD_MAX_AGE_MS);
  }

  function boardHealthGate(boardData, now = Date.now()) {
    return root.SKRODZKaiYahooPageReaders.boardHealthGate(boardData, now, { maximumAgeMs:BOARD_MAX_AGE_MS, futureToleranceMs:BOARD_FUTURE_TOLERANCE_MS });
  }

  function requiredTestFilterLabels(environment = root) {
    const readLabels = environment.SKRODZKaiYahooMockRunner?._test?.requiredTestFilterLabels;
    if (typeof readLabels !== "function") throw new Error("runner_filter_contract_missing");
    return readLabels();
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
    const maximumTeams = Number(body.match(/Max Teams:\s*(\d+)/i)?.[1] ?? 0);
    const rosterSlots = parseRosterSlots(body);
    const errors = [];
    if (String(locationRef?.pathname ?? "") !== `/f1/${TEST_LEAGUE_ID}/settings`) errors.push("not_verified_test_settings");
    if (!body.includes("League Name:\tLeague Two")) errors.push("verified_test_league_missing");
    if (!body.includes("Draft Type:\tLive Standard Draft")) errors.push("verified_test_draft_type_mismatch");
    if (!/^Live Draft Pick Time:\s*1 Minute\s*$/im.test(body)) errors.push("verified_test_clock_mismatch");
    if (!/Passing Touchdowns\s+4\b/i.test(body)) errors.push("verified_test_passing_td_mismatch");
    if (!/Receptions(?:\s+Yahoo Default)?(?:\s+1)?\s+0\.5(?:\s|$)/i.test(body)) errors.push("verified_test_ppr_mismatch");
    if (maximumTeams !== TEST_MAXIMUM_TEAMS) errors.push("test_maximum_team_count_not_12");
    if (!sameSlots(rosterSlots, TEST_SETTINGS_ROSTER_SLOTS)) errors.push("test_roster_shape_mismatch");
    return { roomId: TEST_LEAGUE_ID, maximumTeams, rosterSlots, activeRosterSlots: rosterSlots.slice(0, TEST_ROSTER_SLOTS.length), errors, ready: errors.length === 0 };
  }

  function makeTestSettingsReceipt(snapshot, now = Date.now()) {
    if (!snapshot?.ready) throw new Error("verified test settings are not ready");
    return {
      version: VERSION,
      roomId: TEST_LEAGUE_ID,
      observedMaximumTeams: snapshot.maximumTeams,
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
      Number(receipt.observedMaximumTeams) === TEST_MAXIMUM_TEAMS &&
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

  function makePreflight(snapshot, now = Date.now(), boardData = root.SKRODZKaiYahooMockBoard) {
    if (!snapshot?.ready) throw new Error("public mock waiting-room preflight is not ready");
    const armRecord = {
      version: VERSION,
      mode: "public_mock_15",
      roomId: snapshot.roomId,
      seat: snapshot.seat,
      observedTeamCount: snapshot.teamCount,
      observedRosterSlots: snapshot.rosterSlots,
      armedAt: now,
      expiresAt: now + PREFLIGHT_TTL_MS,
      boardHealth: boardHealthReceipt(boardData, now),
    };
    const failure = validateDraftPreflight(armRecord, { roomId: snapshot.roomId, seat: snapshot.seat }, now, boardData);
    if (failure) throw new Error(failure);
    return armRecord;
  }

  function parseTestDraftHome(documentRef, locationRef, settingsReceipt = null, now = Date.now()) {
    const body = String(documentRef?.body?.innerText ?? "");
    const seatMatch = body.match(/^Your Draft Position:\s*(\d{1,2})(?:st|nd|rd|th)\s*$/im);
    const seat = seatMatch ? Number(seatMatch[1]) : null;
    const teamCount = Number(body.match(/^League Two\s*·\s*(\d+) Teams\s*·\s*19 Rounds\s*·\s*1 minute\s*$/im)?.[1] ?? 0);
    const errors = [];
    if (String(locationRef?.pathname ?? "") !== `/f1/${TEST_LEAGUE_ID}/draft`) errors.push("not_verified_test_draft_home");
    if (!Number.isInteger(teamCount) || teamCount < TEST_MINIMUM_TEAMS || teamCount > TEST_MAXIMUM_TEAMS) errors.push("verified_test_summary_mismatch");
    if (!/^SKRODZKai$/m.test(body)) errors.push("verified_test_team_missing");
    if (!validTestSettingsReceipt(settingsReceipt, now)) errors.push("verified_test_settings_preflight_required");
    if (!Number.isInteger(seat) || seat < 1 || seat > teamCount) errors.push("test_draft_slot_pending");
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

  function makeTestPreflight(snapshot, now = Date.now(), boardData = root.SKRODZKaiYahooMockBoard) {
    if (!snapshot?.ready) throw new Error("verified test draft preflight is not ready");
    const armRecord = {
      version: VERSION,
      mode: "test_league_19_idp",
      roomId: TEST_LEAGUE_ID,
      urlSeat: TEST_TEAM_ID,
      seat: snapshot.seat,
      observedTeamCount: snapshot.teamCount,
      observedRosterSlots: [...snapshot.rosterSlots],
      armedAt: now,
      expiresAt: now + 4 * 60 * 60 * 1000,
      boardHealth: boardHealthReceipt(boardData, now),
    };
    const failure = validateDraftPreflight(armRecord, { roomId: TEST_LEAGUE_ID, seat: TEST_TEAM_ID }, now, boardData);
    if (failure) throw new Error(failure);
    return armRecord;
  }

  function validateDraftPreflight(token, room, now = Date.now(), boardData = root.SKRODZKaiYahooMockBoard) {
    if (!token || !["public_mock_15", "test_league_19_idp"].includes(token.mode)) return "approved_draft_arm_required";
    if (token.version !== VERSION) return "draft_arm_version_mismatch";
    if (String(room?.roomId ?? token.roomId) === DISABLED_LEAGUE_ID) return "league_420010_hard_disabled";
    const boardFailure = boardHealthGate(boardData, now);
    if (boardFailure) return boardFailure;
    if (!Number.isFinite(token.expiresAt) || token.expiresAt <= now) return "draft_arm_expired";
    const expectedUrlSeat = token.mode === "test_league_19_idp" ? Number(token.urlSeat) : Number(token.seat);
    if (!room || String(token.roomId) !== String(room.roomId) || expectedUrlSeat !== Number(room.seat)) {
      return "draft_room_or_url_team_changed";
    }
    const observedTeamCount = Number(token.observedTeamCount);
    const validTeamCount = token.mode === "test_league_19_idp"
      ? Number.isInteger(observedTeamCount) && observedTeamCount >= TEST_MINIMUM_TEAMS && observedTeamCount <= TEST_MAXIMUM_TEAMS
      : observedTeamCount === 12;
    if (!validTeamCount) return token.mode === "test_league_19_idp" ? "draft_team_count_out_of_range" : "draft_team_count_not_12";
    if (!Number.isInteger(Number(token.seat)) || Number(token.seat) < 1 || Number(token.seat) > observedTeamCount) return "draft_slot_invalid";
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

  function validRuntimeAttestation(attestation) {
    return Boolean(
      attestation?.ok === true
      && String(attestation.version) === VERSION
      && /^[a-f0-9]{64}$/.test(String(attestation.digest ?? ""))
      && String(attestation.bootId ?? "").length >= 8
      && Number.isFinite(Number(attestation.bootedAt)),
    );
  }

  function makeReloadMarker(attestation, now = Date.now()) {
    if (!validRuntimeAttestation(attestation)) throw new Error("runtime_attestation_unavailable");
    return {
      requestedAt:now,
      expiresAt:now + RELOAD_MARKER_TTL_MS,
      version:attestation.version,
      digest:attestation.digest,
      bootId:attestation.bootId,
    };
  }

  function evaluateReloadMarker(marker, attestation, now = Date.now()) {
    if (!marker) return { status:"none" };
    if (!Number.isFinite(Number(marker.expiresAt)) || Number(marker.expiresAt) < now) return { status:"failed", reason:"previous Reload & Verify never completed" };
    if (!validRuntimeAttestation(attestation)) return { status:"failed", reason:"runtime attestation unavailable after reload" };
    if (String(marker.bootId ?? "") === String(attestation.bootId)) return { status:"failed", reason:"extension boot identity did not change" };
    return { status:"passed", reason:`v${attestation.version} · SHA ${attestation.digest.slice(0, 12)} · new load verified` };
  }

  function reloadRefusal(snapshot = {}) {
    const context = snapshot.context ?? {};
    if (context.armed) return "reload_refused_while_armed";
    if (context.ownedTurn) return "reload_refused_during_owned_turn";
    if (context.autodraft) return "reload_refused_while_autodraft_active";
    return null;
  }

  function writeReceipt(storage, details) {
    const receipts = readJson(storage, RECEIPT_KEY, []);
    const entry = { at: new Date().toISOString(), version: VERSION, ...details };
    receipts.push(entry);
    storage.setItem(RECEIPT_KEY, JSON.stringify(receipts.slice(-500)));
    return entry;
  }

  function refuseArmForBoardHealth(environment, rail, { kind, roomId, seat, urlSeat = seat, expectedRosterTotal }, error) {
    const failure = String(error?.message ?? error);
    writeReceipt(environment.localStorage, { kind, roomId, seat, urlSeat, failure, boardHealth: boardHealthReceipt(environment.SKRODZKaiYahooMockBoard) });
    rail.setWarnings(buildUiWarnings({
      room: { roomId, seat: urlSeat },
      armRecord: null,
      autodraft: false,
      roster: null,
      board: environment.SKRODZKaiYahooMockBoard?.players ?? [],
      boardData: environment.SKRODZKaiYahooMockBoard,
      expectedRosterTotal,
    }));
    rail.render("bad", "BOARD HEALTH LOCKED", failure);
    rail.addEvent("arm refused", failure);
    return null;
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
        ...match,
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
      const defenseRanks = Array.isArray(boardData.defenses)
        ? boardData.defenses
        : Array.from(boardData.players ?? []).filter((player) => normalize(player.position) === "DEF");
      const defenses = mergeDefenseBoard(availableDefenses, defenseRanks);
      const source = Array.isArray(boardData.players)
        ? boardData.players
        : [...boardData.offense, ...boardData.kickers, ...(boardData.idp ?? [])];
      const allowed = mode === "TEST"
        ? source
        : source.filter((player) => ["QB", "RB", "WR", "TE", "K", "DEF"].includes(normalize(player.position)));
      return [...new Map([...allowed.filter((player) => normalize(player.position) !== "DEF"), ...defenses]
        .map((player) => [String(player.yahooId), player])).values()];
    } finally {
      setFilter(documentRef, environment, "All Positions");
    }
  }

  function makeOperatorAttestation(input, now = new Date().toISOString()) {
    const value = String(input ?? "").trim();
    if (value === "NONE") {
      return { status:"none", source:"operator_attested", attestedAt:now, interventions:[] };
    }
    const intervention = value.match(/^INTERVENTION\s*:\s*(.+)$/i);
    if (intervention) {
      return {
        status:"intervention",
        source:"operator_attested",
        attestedAt:now,
        interventions:[{ kind:"prevented_autodraft", detail:intervention[1].trim() }],
      };
    }
    return { status:"missing", source:"operator_attestation_missing", attestedAt:null, interventions:[] };
  }

  function statusFromRunnerReceipts(receipts) {
    const completed = Array.from(receipts ?? []).filter((entry) => entry.kind === "runner_completed").at(-1);
    if (!completed?.runId) return null;
    const picks = Array.from(receipts ?? [])
      .filter((entry) => entry.runId === completed.runId && entry.kind === "runner_pick_confirmed")
      .sort((left, right) => Number(left.round) - Number(right.round))
      .map((entry) => entry.pick);
    return {
      runId: completed.runId,
      roomId: completed.roomId,
      seat: completed.seat,
      urlSeat: completed.urlSeat,
      state: "completed",
      picks,
    };
  }

  function buildExportPayload({ roomId, seat, urlSeat = seat, storage, runner, runtimeAttestation = null, operatorAttestation = null }) {
    const belongsToDraftSeat = (entry) => String(entry.roomId) === String(roomId) && Number(entry.seat) === Number(seat);
    const belongsToUrlSeat = (entry) => String(entry.roomId) === String(roomId) && Number(entry.seat) === Number(urlSeat);
    const runnerReceipts = readJson(storage, RUNNER_RECEIPT_KEY, []).filter(belongsToDraftSeat);
    return {
      exportedAt: new Date().toISOString(),
      extensionVersion: VERSION,
      roomId: String(roomId),
      seat: Number(seat),
      urlSeat: Number(urlSeat),
      runtimeAttestation: validRuntimeAttestation(runtimeAttestation) ? { ...runtimeAttestation } : null,
      operatorAttestation: operatorAttestation ?? makeOperatorAttestation(null),
      status: runner?.getStatus?.() ?? statusFromRunnerReceipts(runnerReceipts),
      extensionReceipts: readJson(storage, RECEIPT_KEY, []).filter(belongsToDraftSeat),
      runnerReceipts,
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
    rail.controls.export.onclick = async () => {
      const runtimeAttestation = await verifyCurrentExtensionVersion(environment, rail);
      if (!runtimeAttestation) return;
      const attestation = makeOperatorAttestation(environment.prompt?.(
        "Owner attestation required. Type NONE if Yahoo never required a rescue, or INTERVENTION: followed by a brief description if you prevented or replaced an automatic Yahoo selection.",
      ));
      const payload = buildExportPayload({
        roomId: room.roomId,
        seat: room.seat,
        urlSeat: room.urlSeat ?? room.seat,
        storage: environment.localStorage,
        runner: runner ?? environment[GLOBAL_KEY]?.runner ?? null,
        runtimeAttestation,
        operatorAttestation: attestation,
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
        .dock-readout .runtime-attestation { color:var(--cyan); font-size:8px; letter-spacing:.03em; }
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
        .board-row { display:grid; width:100%; grid-template-columns:28px minmax(0,1fr) 68px; gap:7px; padding:7px 4px; border:0; border-bottom:1px solid #17363a; text-align:left; background:transparent; }
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
          <div class="dock-readout"><strong data-dock-primary>SAFE · --:--</strong><span data-compact-status>MOCK · ROOM — · SEAT —</span><span data-dock-target>Waiting for Yahoo availability</span><span class="runtime-attestation" data-runtime-attestation>v${VERSION} · SHA PENDING · LOAD PENDING</span></div>
          <div class="dock-actions"><button class="reload" type="button" disabled>Reload & Verify</button><button class="expand" type="button">Open Center</button><button class="dock-kill danger" type="button" disabled>Kill</button></div>
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
              <section class="section"><div class="section-head"><span>Player override</span><small data-stage-count>BASELINE</small></div><div class="pin-state" data-pin-state>No override staged. The verified baseline will execute.</div><div class="search"><input data-search type="search" placeholder="Search full verified player pool" aria-label="Search verified Yahoo board" /></div><div class="manual-list" data-manual-list></div><div class="manual-note">Before our turn: stage a next-pick pin. On our turn: click a player or press 1, 2, or 3 during the bounded decision window. Invalid choices are receipted and the five-target baseline remains intact.</div><div class="manual-actions"><button class="warn" data-clear-pin type="button" disabled>Clear Pin</button><button class="primary" data-confirm type="button" disabled>Choose / Pin</button></div></section>
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
      stageCount: shadow.querySelector("[data-stage-count]"), pinState: shadow.querySelector("[data-pin-state]"), search: shadow.querySelector("[data-search]"), manualList: shadow.querySelector("[data-manual-list]"), clearPin: shadow.querySelector("[data-clear-pin]"), confirm: shadow.querySelector("[data-confirm]"), compact: shadow.querySelector("[data-compact-status]"), dockPrimary: shadow.querySelector("[data-dock-primary]"), dockTarget: shadow.querySelector("[data-dock-target]"), runtimeAttestation: shadow.querySelector("[data-runtime-attestation]"), modeLabel: shadow.querySelector(".mode"), modeChips: [...shadow.querySelectorAll(".mode-chip")],
    };
    const controls = { arm: shadow.querySelector(".arm"), halt: shadow.querySelector(".halt"), export: shadow.querySelector(".export"), dock: shadow.querySelector(".dock-kill"), expand: shadow.querySelector(".expand"), reload:shadow.querySelector(".reload") };
    const ui = { mode:"MOCK", kind:"", label:"LOCKED", detail:"Waiting for a verified draft room.", context:{}, roster:[], recommendations:[], board:[], between:{}, warnings:[], staged:[], pinned:null, pinOutcome:null, pinText:"No pin staged. Five verified fallbacks remain active.", pinLabel:"BASELINE", ladderState:"BASELINE READY", latestText:"No confirmed selection yet.", events:[], latestPickId:"", attestation:null, onManualConfirm:null, onManualClear:null, onOpen:null, onReload:null, locked:false, observers:[] };
    const redrawManual = () => {
      if (ui.locked) {
        data.manualList.innerHTML = `<div class="event">Use Reload & Verify to restore extension controls.</div>`;
        data.confirm.disabled = true;
        data.clearPin.disabled = true;
        data.search.disabled = true;
        return;
      }
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
    documentRef.addEventListener("keydown", (event) => {
      const player = recommendationHotkeyPlayer(ui, event);
      if (player && typeof ui.onManualConfirm === "function") {
        event.preventDefault();
        ui.onManualConfirm([player]);
      }
    });
    data.confirm.addEventListener("click", () => {
      if (typeof ui.onManualConfirm !== "function") return;
      const result = ui.onManualConfirm(ui.staged.slice());
      if (result !== false) { ui.staged = []; redrawManual(); }
    });
    data.clearPin.addEventListener("click", () => { if (typeof ui.onManualClear === "function" && ui.onManualClear() !== false) { ui.pinned = null; ui.pinOutcome = { status:"cleared", expectedRound:null, reason:"deterministic baseline active" }; redrawManual(); } });
    controls.expand.addEventListener("click", () => ui.onOpen?.());
    controls.dock.addEventListener("click", () => controls.halt.click());
    controls.reload.addEventListener("click", () => ui.onReload?.());
    const setStatus = (key, value, kind = "") => { if (!data.status[key]) return; data.status[key].textContent = value; data.status[key].className = `value ${kind}`.trim(); };
    const api = {
      controls,
      setMode(mode) { ui.mode = String(mode ?? "MOCK").toUpperCase(); if (data.modeLabel) data.modeLabel.textContent = `${ui.mode} / LOCAL`; for (const chip of data.modeChips) { const chipMode = String(chip.textContent ?? "").replace("⛔", "").trim(); chip.classList.toggle("active", chipMode === ui.mode); } },
      setAttestation(attestation = null) {
        ui.attestation = validRuntimeAttestation(attestation) ? { ...attestation } : null;
        data.runtimeAttestation.textContent = ui.attestation
          ? `v${ui.attestation.version} · SHA ${ui.attestation.digest.slice(0, 12)} · LOAD ${new Date(Number(ui.attestation.bootedAt)).toISOString()}`
          : `v${VERSION} · SHA UNAVAILABLE · LOAD UNVERIFIED`;
        controls.reload.disabled = !ui.attestation || !ui.onReload;
      },
      setReloadHandler(handler) { ui.onReload = typeof handler === "function" ? handler : null; controls.reload.disabled = !ui.attestation || !ui.onReload; },
      setReloadPending(pending) { controls.reload.disabled = Boolean(pending) || !ui.attestation || !ui.onReload; controls.reload.textContent = pending ? "Reloading…" : "Reload & Verify"; },
      render(kind, label, message) { ui.kind=kind; ui.label=label; ui.detail=message; rail.classList.remove("ok", "bad", "complete"); if (kind) rail.classList.add(kind); state.textContent = label; detail.textContent = message; },
      setExpanded(expanded = true) { if (expanded) ui.onOpen?.(); },
      setOpenHandler(handler) { ui.onOpen = typeof handler === "function" ? handler : null; },
      setContext(context = {}) {
        const roomId = String(context.roomId ?? "—");
        const autodraftState = context.autodraftState ?? (context.autodraft ? "ACTIVE" : "UNKNOWN");
        const autodraftLabel = autodraftState === "ACTIVE" ? "ON / BLOCKED" : autodraftState === "INACTIVE" ? "OFF / VERIFIED" : "UNKNOWN / BLOCKED";
        setStatus("league", context.league ?? (roomId === DISABLED_LEAGUE_ID ? "420010 BLOCKED" : "PUBLIC"), roomId === DISABLED_LEAGUE_ID ? "danger" : ""); setStatus("room", roomId); setStatus("seat", context.seat == null ? "—" : String(context.seat)); setStatus("turn", context.round == null ? "— / —" : `R${context.round} / P${context.pick ?? "—"}`); setStatus("clock", context.clock ?? "--:--"); setStatus("armed", context.armed ? "YES" : "NO", context.armed ? "accent" : "warn"); setStatus("autodraft", autodraftLabel, autodraftState === "INACTIVE" ? "" : "danger"); setStatus("kill", context.kill ? "ENGAGED" : "READY", context.kill ? "danger" : "");
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
        data.board.innerHTML = rows.slice(0, 6).map((player, index) => `<button type="button" data-live-choice="${player.yahooId}" class="board-row ${index === 0 ? "primary" : ""} ${player.manual ? "pinned" : ""}"><span class="rank">${player.manual ? "PIN" : index < 3 ? `${index + 1}` : `F${index}`}</span><div><div class="player">${player.name ?? `Yahoo ${player.yahooId}`} <em>${player.position ?? "—"} · ${player.team ?? "—"}</em></div><div class="reason">${player.reason ?? "verified local ladder"}</div></div><div class="metrics">${player.edge ?? "—"}<br><span class="dim">${player.confidence ?? "—"} · ${player.freshness ?? "—"}</span></div></button>`).join("") || `<div class="event">Ladder resolves on our owned turn after Yahoo availability is validated.</div>`;
        for (const button of data.board.querySelectorAll("[data-live-choice]")) button.addEventListener("click", () => {
          const player = rows.find((candidate) => String(candidate.yahooId) === String(button.dataset.liveChoice));
          if (player && typeof ui.onManualConfirm === "function") ui.onManualConfirm([player]);
        });
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
      setManualHandler(confirmHandler, clearHandler = null) { if (ui.locked) return; ui.onManualConfirm = confirmHandler; ui.onManualClear = clearHandler; },
      setPinned(stage = null) { ui.pinned = stage; if (stage) ui.pinOutcome = null; redrawManual(); },
      setPinOutcome(outcome = null) { ui.pinned = null; ui.pinOutcome = outcome; redrawManual(); },
      getManualStage() { return ui.staged.slice(); },
      isLocked() { return ui.locked; },
      trackObserver(observer) { if (observer?.disconnect) ui.observers.push(observer); },
      lock(reason = "Extension context changed. Use Reload & Verify before arming.", label = "EXTENSION RELOAD REQUIRED") {
        ui.locked = true;
        for (const observer of ui.observers) observer.disconnect();
        ui.observers = [];
        for (const [name, control] of Object.entries(controls)) if (name !== "reload") control.disabled = true;
        controls.reload.disabled = !ui.attestation || !ui.onReload;
        data.confirm.disabled = true;
        data.clearPin.disabled = true;
        data.search.disabled = true;
        ui.onManualConfirm = null;
        ui.onManualClear = null;
        ui.onOpen = null;
        redrawManual();
        api.setWarnings([{ severity:"danger", text:reason }]);
        api.render("bad", label, reason);
      },
      command(name, payload = null) {
        if (ui.locked) return false;
        if (name === "arm") { if (controls.arm.disabled) return false; controls.arm.click(); return true; }
        if (name === "kill") { if (controls.halt.disabled) return false; controls.halt.click(); return true; }
        if (name === "export") { if (controls.export.disabled) return false; controls.export.click(); return true; }
        if (name === "clear_pin" && typeof ui.onManualClear === "function") {
          const cleared = ui.onManualClear();
          if (cleared !== false) { ui.pinned = null; ui.pinOutcome = { status:"cleared", expectedRound:null, reason:"deterministic baseline active" }; redrawManual(); }
          return cleared;
        }
        if (name === "pin" && typeof ui.onManualConfirm === "function") return ui.onManualConfirm(Array.isArray(payload?.targets) ? payload.targets : []);
        return false;
      },
      getSnapshot() {
        return { version:VERSION, attestation:ui.attestation, mode:ui.mode, kind:ui.kind, label:ui.label, detail:ui.detail, context:ui.context, roster:ui.roster, recommendations:ui.recommendations, board:ui.board, between:ui.between, warnings:ui.warnings, events:ui.events, latestText:ui.latestText, ladderState:ui.ladderState, pinned:ui.pinned, pinOutcome:ui.pinOutcome, pinText:ui.pinText, pinLabel:ui.pinLabel, controls:{ arm:{ disabled:controls.arm.disabled, text:controls.arm.textContent }, halt:{ disabled:controls.halt.disabled, text:controls.halt.textContent }, export:{ disabled:controls.export.disabled, text:controls.export.textContent }, reload:{ disabled:controls.reload.disabled, text:controls.reload.textContent } } };
      },
    };
    api.setContext(); api.setRoster(PUBLIC_ROSTER_SLOTS.map((slot) => ({ slot }))); api.setRecommendations([]); api.setBetweenTurns(); api.setWarnings([]); api.setAttestation(null); redrawManual(); host._controlApi = api; return api;
  }

  function commandCenterRole(pathname = "") {
    if (/^\/draftclient\/f1\/\d+\/\d+\/?$/.test(pathname)) return "runner";
    if (pathname === "/f1/mock_waiting" || pathname === `/f1/${TEST_LEAGUE_ID}/draft` || pathname === `/f1/${TEST_LEAGUE_ID}/${TEST_TEAM_ID}`) return "arm-owner";
    return "observer";
  }

  function extensionContextFailureMessage() {
    return "Extension context changed. Use Reload & Verify on this Yahoo page before arming.";
  }

  function lockExtensionContext(environment, rail, error = null) {
    const active = environment[GLOBAL_KEY];
    if (active?.statusTimer != null) environment.clearInterval(active.statusTimer);
    if (active) active.statusTimer = null;
    try { active?.runner?.halt?.("extension_context_invalidated"); } catch { /* Visible lock remains authoritative. */ }
    const detail = extensionContextFailureMessage();
    rail.lock?.(detail);
    try {
      writeReceipt(environment.localStorage, {
        kind:"extension_context_invalidated",
        roomId:active?.room?.roomId ?? null,
        seat:active?.token?.seat ?? null,
        failure:error ? String(error?.message ?? error) : "extension_bridge_unavailable",
      });
    } catch { /* Visible lock remains authoritative when receipt storage is unavailable. */ }
    return detail;
  }

  async function requireCurrentExtensionVersion(environment) {
    const runtime = environment.chrome?.runtime ?? root.chrome?.runtime;
    if (!runtime?.sendMessage) throw new Error("extension_bridge_unavailable_reload_verify_required");
    let response;
    try {
      response = await runtime.sendMessage({ type:"version_handshake", version:VERSION });
    } catch {
      throw new Error("extension_context_invalidated_reload_verify_required");
    }
    if (!validRuntimeAttestation(response)) {
      throw new Error(`extension_version_mismatch:content_${VERSION}:background_${String(response?.version ?? "missing")}`);
    }
    return response;
  }

  async function requireRuntimeAttestationWithRetry(environment, attempts = 20, delayMs = 100) {
    let failure = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try { return await requireCurrentExtensionVersion(environment); }
      catch (error) { failure = error; }
      if (attempt + 1 < attempts) await new Promise((resolve) => environment.setTimeout(resolve, delayMs));
    }
    throw failure ?? new Error("runtime_attestation_unavailable");
  }

  async function verifyCurrentExtensionVersion(environment, rail, { retry = false } = {}) {
    try {
      const attestation = retry
        ? await requireRuntimeAttestationWithRetry(environment)
        : await requireCurrentExtensionVersion(environment);
      rail.setAttestation?.(attestation);
      return attestation;
    } catch (error) {
      rail.setAttestation?.(null);
      lockExtensionContext(environment, rail, error);
      return null;
    }
  }

  function sameRuntimeAttestation(left, right) {
    return validRuntimeAttestation(left) && validRuntimeAttestation(right) &&
      left.version === right.version && left.digest === right.digest &&
      left.bootId === right.bootId && Number(left.bootedAt) === Number(right.bootedAt);
  }

  function installReloadAndVerify(environment, rail) {
    if (commandCenterRole(environment.location?.pathname) === "runner") {
      rail.setReloadHandler?.(null);
      rail.controls.reload.disabled = true;
      rail.controls.reload.title = "Reload is disabled inside the live Yahoo draft client.";
      return;
    }
    rail.setReloadHandler?.(() => {
      const snapshot = rail.getSnapshot?.() ?? {};
      const refusal = reloadRefusal(snapshot);
      if (refusal) {
        rail.addEvent?.("reload refused", refusal);
        rail.render?.("bad", "RELOAD REFUSED", refusal);
        return false;
      }
      let marker;
      try {
        marker = makeReloadMarker(snapshot.attestation);
        environment.sessionStorage.setItem(RELOAD_MARKER_KEY, JSON.stringify(marker));
      } catch (error) {
        rail.addEvent?.("reload refused", String(error?.message ?? error));
        rail.render?.("bad", "RELOAD REFUSED", String(error?.message ?? error));
        return false;
      }
      rail.setReloadPending?.(true);
      const reloadTimer = environment.setTimeout(() => environment.location.reload(), RELOAD_PAGE_DELAY_MS);
      const beginReload = () => rail.lock?.("Reloading the extension and this Yahoo tab. Yahoo controls remain disabled until the new runtime attests.", "RELOAD VERIFYING");
      const runtime = environment.chrome?.runtime ?? root.chrome?.runtime;
      if (!runtime?.id || !runtime?.sendMessage) { beginReload(); return true; }
      try {
        const pending = runtime.sendMessage({ type:"reload_extension", marker:{ version:marker.version, digest:marker.digest, bootId:marker.bootId } });
        void Promise.resolve(pending).then((response) => {
          if (response?.ok !== false) { beginReload(); return; }
          environment.clearTimeout?.(reloadTimer);
          environment.sessionStorage.removeItem(RELOAD_MARKER_KEY);
          rail.setReloadPending?.(false);
          rail.addEvent?.("reload refused", String(response.error ?? "background reload refused"));
          rail.render?.("bad", "RELOAD REFUSED", String(response.error ?? "background reload refused"));
        }).catch(beginReload);
      } catch {
        // An invalidated bridge means Chrome already reloaded the extension; the page timer completes verification.
        beginReload();
      }
      return true;
    });
  }

  function attachCommandCenterBridge(environment, rail) {
    const runtime = environment.chrome?.runtime ?? root.chrome?.runtime;
    if (!runtime?.sendMessage || !runtime?.onMessage || typeof rail?.getSnapshot !== "function") {
      lockExtensionContext(environment, rail);
      return null;
    }
    const role = commandCenterRole(environment.location?.pathname);
    let boardHash = "";
    let snapshotHash = "";
    let timer = null;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer != null) environment.clearInterval(timer);
      timer = null;
      try { runtime.onMessage.removeListener(onMessage); } catch { /* Context may already be invalid. */ }
    };
    const invalidate = (error) => {
      stop();
      lockExtensionContext(environment, rail, error);
    };
    const send = (message) => {
      if (stopped) return null;
      try {
        const pending = runtime.sendMessage(message);
        void Promise.resolve(pending).then((response) => {
          if (message?.type === "state" && response?.ok === false) invalidate(new Error("runner_lease_conflict"));
        }).catch(invalidate);
        return pending;
      } catch (error) {
        invalidate(error);
        return null;
      }
    };
    const publish = () => {
      if (stopped) return;
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
      send({ type:"state", role, at:Date.now(), snapshot:snapshotChanged ? snapshot : undefined, board:role === "runner" && boardChanged ? board : undefined });
    };
    rail.setOpenHandler(() => send({ type:"open_command_center" }));
    const onMessage = (message, _sender, sendResponse) => {
      if (message?.type !== "command") return;
      const ok = rail.command(message.command, message.payload);
      publish();
      sendResponse({ ok:ok !== false });
    };
    runtime.onMessage.addListener(onMessage);
    publish();
    if (!stopped) timer = environment.setInterval(publish, 250);
    return { publish, stop };
  }

  async function waitForEmptyDraft(documentRef, controllerApi, environment, expectedRosterTotal = 15, executionMode = "MOCK", deadlineMs = 15000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < deadlineMs) {
      const roster = controllerApi.runtime.parseRosterCount(documentRef.body?.innerText);
      const labels = executionMode === "TEST"
        ? requiredTestFilterLabels(environment)
        : ["All Positions", "Team Defenses", "Kickers"];
      const filtersReady = labels
        .every((label) => findFilter(documentRef, label));
      if (roster?.filled === 0 && roster?.total === expectedRosterTotal && filtersReady) return roster;
      await new Promise((resolve) => environment.setTimeout(resolve, 50));
    }
    throw new Error(executionMode === "TEST" ? "empty_test_draft_not_ready" : "empty_public_mock_draft_not_ready");
  }

  function buildUiRoster(picks = [], rosterSlots = PUBLIC_ROSTER_SLOTS) {
    const allocate = root.SKRODZKaiYahooMockRunner?._test?.allocateRosterSlots;
    if (typeof allocate !== "function") throw new Error("runner_roster_allocator_missing");
    return allocate(picks, rosterSlots);
  }

  function parseFinalRosterDocument(documentRef, picks = []) {
    const byId = new Map(Array.from(picks, (pick) => [String(pick.yahooId), pick]));
    const rows = [];
    for (const row of documentRef.querySelectorAll("tr.editable")) {
      const cells = [...row.querySelectorAll("td")];
      const slot = normalize(cells[0]?.innerText);
      if (![...TEST_ROSTER_SLOTS, "BN"].includes(slot)) continue;
      const empty = row.classList?.contains?.("empty-position") || /\(EMPTY\)/i.test(String(cells[1]?.innerText ?? ""));
      if (empty) {
        rows.push({ slot, yahooId:null, name:null, empty:true });
        continue;
      }
      const link = row.querySelector('a[href*="/nfl/players/"], a[href*="/nfl/teams/"]');
      const href = String(link?.getAttribute?.("href") ?? "");
      const linkedId = href.match(/\/nfl\/players\/(\d+)/)?.[1] ?? "";
      const linkedName = String(link?.textContent ?? link?.innerText ?? "").trim();
      const matches = linkedId
        ? [byId.get(linkedId)].filter(Boolean)
        : Array.from(picks).filter((pick) => normalize(pick.name) === normalize(linkedName));
      if (matches.length !== 1) throw new Error(`final_roster_player_unmatched:${slot}:${linkedName || linkedId || "missing"}`);
      rows.push({ slot, yahooId:String(matches[0].yahooId), name:String(matches[0].name), empty:false });
    }
    if (!rows.length) throw new Error("final_roster_rows_missing");
    return rows;
  }

  function draftSignalLabel(player) {
    const specialist = player?.draftSignals?.specialist;
    const labels = [];
    if (specialist?.kind === "K") {
      if (Number.isFinite(specialist.teamOffenseRank)) labels.push(`K offense #${specialist.teamOffenseRank}`);
      if (Number.isFinite(specialist.week1ImpliedPoints)) labels.push(`W1 implied ${specialist.week1ImpliedPoints.toFixed(1)}`);
    }
    if (specialist?.kind === "DEF") {
      if (Number.isFinite(specialist.earlyScheduleRank)) labels.push(`DEF W1-4 #${specialist.earlyScheduleRank}`);
      if (Number.isFinite(specialist.week1OpponentImpliedPoints)) labels.push(`W1 opp ${specialist.week1OpponentImpliedPoints.toFixed(1)}`);
    }
    if (specialist?.kind === "IDP" && specialist.depthPosition) {
      labels.push(`depth ${specialist.depthPosition}${Number.isFinite(specialist.depthRank) ? ` #${specialist.depthRank}` : ""}`);
    }
    if (Array.isArray(player?.draftSignals?.market) && player.draftSignals.market.length) labels.push(`${player.draftSignals.market.length} market line${player.draftSignals.market.length === 1 ? "" : "s"}`);
    return labels.length ? ` · ${labels.join(" · ")}` : "";
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
        edge: Number.isFinite(adjusted) ? adjusted.toFixed(1) : "POLICY",
        confidence: player.confidence ?? "LOCAL_RULE",
        freshness: "TURN",
        reason: (manual
          ? "operator pin validated; baseline fallbacks retained"
          : leader
            ? leader.valueReason ?? `BPA ${Number(leader.marginalUtility ?? 0).toFixed(1)} · wait ${Number(leader.costOfWaiting ?? 0).toFixed(1)} · Pnext ${Math.round(Number(leader.pAvailableNext ?? 0) * 100)}%`
            : "verified local ladder; exact Yahoo ID") + draftSignalLabel(player),
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
      .filter((leader) => Number(leader.pAvailableNext) < 0.5)
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

  function buildUiWarnings({ room, armRecord, autodraft, roster, board, boardData = root.SKRODZKaiYahooMockBoard, decision = null, expectedRosterTotal = 15, now = Date.now() }) {
    const health = boardHealthReceipt(boardData, now);
    const healthFailure = boardHealthGate(boardData, now);
    const asOf = health.generatedAt ? new Date(health.generatedAt).toISOString() : "missing";
    const ageHours = Number.isFinite(health.ageMs) ? (health.ageMs / 3_600_000).toFixed(1) : "unknown";
    const signalOverlay = boardData?.draftSignalOverlay;
    const targetWarnings = Array.from(decision?.targetYahooIds ?? []).flatMap((yahooId) => {
      const player = Array.from(board ?? []).find((entry) => String(entry.yahooId) === String(yahooId));
      return Array.from(player?.draftSignals?.warnings ?? []).map((warning) => `${player.name || `Y!${yahooId}`}: ${warning}`);
    });
    const warnings = [
      { severity: healthFailure ? "danger" : "", text: `Data as-of ${asOf} · ${ageHours}h old${healthFailure ? ` · ${healthFailure}` : ""}` },
      { severity: health.injuryCoverageComplete ? "" : "danger", text: `Injury coverage: ${health.injuryCoverageComplete ? "COMPLETE" : "INCOMPLETE"}${health.injuryPlayersTotal ? ` · ${health.injuryPlayersChecked}/${health.injuryPlayersTotal}` : ""}` },
      { severity: health.byeCoverageComplete ? "" : "danger", text: `Bye coverage: ${health.byeCoverageComplete ? "COMPLETE" : "INCOMPLETE"} · ${health.byePlayersWithBye}/${health.byePlayersTotal}` },
      ...(signalOverlay ? [{ severity: signalOverlay.projectionUnchanged === true ? "" : "danger", text: `Ranking overlay: ${signalOverlay.projectionUnchanged === true ? "PROJECTION-SAFE" : "PROJECTION MUTATION DETECTED"} · role ${signalOverlay.roleAudit?.rosterMatched ?? 0}/${signalOverlay.roleAudit?.uniqueTargets ?? signalOverlay.roleAudit?.totalTargets ?? 0} · market ${signalOverlay.market?.coverageStatus ?? "UNKNOWN"}` }] : []),
      ...targetWarnings.slice(0, 4).map((text) => ({ severity: "danger", text })),
      ...(decision?.qb2 ? [{ text: `QB2 ${decision.qb2.recommendation}: ${decision.qb2.reason}` }] : []),
      ...(decision?.byeConcentration?.warning ? [{ severity: "danger", text: decision.byeConcentration.reason }] : []),
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
      if (rail.isLocked()) return false;
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
    rail.controls.arm.addEventListener("click", async () => {
      if (!await verifyCurrentExtensionVersion(environment, rail)) return;
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
        let armRecord;
        try {
          armRecord = makePreflight(snapshot, Date.now(), environment.SKRODZKaiYahooMockBoard);
        } catch (error) {
          refuseArmForBoardHealth(environment, rail, { kind: "mock_arm_refused", roomId: snapshot.roomId, seat: snapshot.seat, expectedRosterTotal: 15 }, error);
          return;
        }
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
      rail.trackObserver(observer);
      observer.observe(environment.document.body, { childList: true, subtree: true, characterData: true });
    }
  }

  function bootTestDraftHome(environment, rail) {
    rail.setMode("TEST");
    rail.setExpanded(true);
    rail.setBetweenTurns(buildUiOpponentWindow(null, "TEST"));
    rail.setRoster(TEST_ROSTER_SLOTS.map((slot) => ({ slot })));
    const update = () => {
      if (rail.isLocked()) return false;
      const settingsReceipt = readJson(environment.localStorage, TEST_SETTINGS_KEY, null);
      const snapshot = parseTestDraftHome(environment.document, environment.location, settingsReceipt);
      const armed = readJson(environment.sessionStorage, PREFLIGHT_KEY, null);
      const active = armed?.mode === "test_league_19_idp" && !validateDraftPreflight(armed, { roomId: TEST_LEAGUE_ID, seat: TEST_TEAM_ID });
      rail.setContext({ roomId: TEST_LEAGUE_ID, seat: snapshot.seat, league: "League Two", armed: Boolean(active), autodraft: false, kill: false });
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
      rail.render(active ? "ok" : "", active ? "TEST ARMED" : "READY TO ARM TEST", `League ${TEST_LEAGUE_ID} · draft slot ${snapshot.seat} · ${snapshot.teamCount} teams · 19 rounds`);
      rail.controls.arm.disabled = false;
      rail.controls.arm.textContent = active ? "DISARM" : "ARM TEST";
      return true;
    };
    rail.controls.arm.addEventListener("click", async () => {
      if (!await verifyCurrentExtensionVersion(environment, rail)) return;
      const settingsReceipt = readJson(environment.localStorage, TEST_SETTINGS_KEY, null);
      const snapshot = parseTestDraftHome(environment.document, environment.location, settingsReceipt);
      if (!snapshot.ready) return update();
      const active = readJson(environment.sessionStorage, PREFLIGHT_KEY, null);
      if (active?.mode === "test_league_19_idp" && !validateDraftPreflight(active, { roomId: TEST_LEAGUE_ID, seat: TEST_TEAM_ID })) {
        environment.sessionStorage.removeItem(PREFLIGHT_KEY);
        writeReceipt(environment.localStorage, { kind: "test_disarmed", roomId: TEST_LEAGUE_ID, seat: snapshot.seat, urlSeat: TEST_TEAM_ID });
        rail.addEvent("test disarmed", `league ${TEST_LEAGUE_ID} · draft slot ${snapshot.seat}`);
      } else {
        let armRecord;
        try {
          armRecord = makeTestPreflight(snapshot, Date.now(), environment.SKRODZKaiYahooMockBoard);
        } catch (error) {
          refuseArmForBoardHealth(environment, rail, { kind: "test_arm_refused", roomId: TEST_LEAGUE_ID, seat: snapshot.seat, urlSeat: TEST_TEAM_ID, expectedRosterTotal: 19 }, error);
          return;
        }
        environment.sessionStorage.setItem(PREFLIGHT_KEY, JSON.stringify(armRecord));
        writeReceipt(environment.localStorage, { kind: "test_armed", roomId: TEST_LEAGUE_ID, seat: snapshot.seat, urlSeat: TEST_TEAM_ID, expiresAt: armRecord.expiresAt });
        rail.addEvent("test armed", `league ${TEST_LEAGUE_ID} · draft slot ${snapshot.seat}`);
      }
      update();
    });
    if (!update() && environment.MutationObserver) {
      const observer = new environment.MutationObserver(() => { if (update()) observer.disconnect(); });
      rail.trackObserver(observer);
      observer.observe(environment.document.body, { childList: true, subtree: true, characterData: true });
    }
  }

  function bootTestSettings(environment, rail) {
    rail.setMode("TEST");
    rail.setBetweenTurns(buildUiOpponentWindow(null, "TEST"));
    rail.setRoster(TEST_ROSTER_SLOTS.map((slot) => ({ slot })));
    const update = () => {
      if (rail.isLocked()) return false;
      const snapshot = parseTestSettings(environment.document, environment.location);
      if (!snapshot.ready) {
        environment.localStorage.removeItem(TEST_SETTINGS_KEY);
        rail.setWarnings(snapshot.errors.map((text) => ({ severity: "danger", text })));
        rail.render("bad", "TEST SETTINGS LOCKED", snapshot.errors.join(" · "));
        return false;
      }
      const receipt = makeTestSettingsReceipt(snapshot);
      environment.localStorage.setItem(TEST_SETTINGS_KEY, JSON.stringify(receipt));
      rail.setContext({ roomId: TEST_LEAGUE_ID, league: "League Two", armed: false, autodraft: false, kill: false });
      rail.setWarnings([]);
      rail.render("ok", "TEST SETTINGS VERIFIED", "10-12 teams · 19 active roster slots · 3 IR · 60-second clock");
      rail.addEvent("test settings verified", `league ${TEST_LEAGUE_ID} · ${snapshot.rosterSlots.length} settings slots`);
      return true;
    };
    if (!update() && environment.MutationObserver) {
      const observer = new environment.MutationObserver(() => { if (update()) observer.disconnect(); });
      rail.trackObserver(observer);
      observer.observe(environment.document.body, { childList: true, subtree: true, characterData: true });
    }
  }

  function completedTestRun(storage) {
    const receipts = readJson(storage, RUNNER_RECEIPT_KEY, [])
      .filter((entry) => String(entry.roomId) === TEST_LEAGUE_ID);
    const completed = receipts.filter((entry) => entry.kind === "runner_completed").at(-1);
    if (!completed?.runId) return null;
    const picks = receipts
      .filter((entry) => entry.runId === completed.runId && entry.kind === "runner_pick_confirmed")
      .sort((left, right) => Number(left.round) - Number(right.round))
      .map((entry) => entry.pick);
    if (picks.length !== TEST_ROSTER_SLOTS.length) return null;
    return { completed, picks };
  }

  function bootTestTeamRoster(environment, rail) {
    rail.setMode("TEST");
    rail.setExpanded(true);
    const run = completedTestRun(environment.localStorage);
    if (!run) {
      rail.lock("A completed 19-pick TEST runner receipt is required before final roster readback.", "FINAL ROSTER LOCKED");
      return;
    }
    const update = () => {
      if (rail.isLocked()) return false;
      let finalRosterSlots;
      try {
        finalRosterSlots = parseFinalRosterDocument(environment.document, run.picks);
      } catch (error) {
        if (String(error?.message ?? error) !== "final_roster_rows_missing") throw error;
        rail.render("", "WAITING FOR FINAL ROSTER", "Yahoo has not rendered the roster rows yet.");
        return false;
      }
      const validate = environment.SKRODZKaiYahooMockRunner?._test?.validateObservedTestRoster;
      if (typeof validate !== "function") throw new Error("runner_final_roster_validator_missing");
      const valid = validate(finalRosterSlots, run.picks);
      const previous = readJson(environment.localStorage, RECEIPT_KEY, [])
        .filter((entry) => entry.kind === "final_roster_readback" && entry.runId === run.completed.runId);
      if (previous.length > 1 || previous.length === 1 && JSON.stringify(previous[0].finalRosterSlots) !== JSON.stringify(finalRosterSlots)) {
        rail.lock("Yahoo's roster changed after the first final-roster receipt. Preserve both states and do not grade this run.", "FINAL ROSTER LOCKED");
        return false;
      }
      if (!previous.length) {
        writeReceipt(environment.localStorage, {
          kind:"final_roster_readback",
          roomId:TEST_LEAGUE_ID,
          seat:Number(run.completed.seat),
          urlSeat:TEST_TEAM_ID,
          runId:run.completed.runId,
          valid,
          finalRosterSlots,
        });
      }
      const pickById = new Map(run.picks.map((pick) => [String(pick.yahooId), pick]));
      rail.setRoster(finalRosterSlots.map((entry) => ({ slot:entry.slot, player:entry.empty ? null : pickById.get(entry.yahooId) ?? null })));
      rail.setContext({ roomId:TEST_LEAGUE_ID, seat:Number(run.completed.seat), league:"League Two", armed:false, autodraft:false, kill:false });
      rail.setWarnings(valid ? [] : [{ severity:"danger", text:"Yahoo final slot occupancy does not satisfy the TEST roster contract." }]);
      rail.render(valid ? "complete" : "bad", valid ? "FINAL ROSTER VERIFIED" : "FINAL ROSTER LOCKED", valid ? "Observed Yahoo starter and bench slots match all 19 confirmed picks." : "Both generic D slots or IDP bench placement failed validation.");
      enableExport(environment, rail, { roomId:TEST_LEAGUE_ID, seat:Number(run.completed.seat), urlSeat:TEST_TEAM_ID });
      return true;
    };
    if (!update() && environment.MutationObserver && !rail.isLocked()) {
      const observer = new environment.MutationObserver(() => { if (update()) observer.disconnect(); });
      rail.trackObserver(observer);
      observer.observe(environment.document.body, { childList:true, subtree:true, characterData:true });
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
    if (!armRecord && room.roomId === TEST_LEAGUE_ID && Number(room.seat) === TEST_TEAM_ID) {
      rail.setMode("TEST");
      rail.setExpanded(true);
      rail.setRoster(TEST_ROSTER_SLOTS.map((slot) => ({ slot })));
      rail.setBetweenTurns(buildUiOpponentWindow(null, "TEST"));
      rail.setContext({ roomId: TEST_LEAGUE_ID, league: "League Two", armed: false, autodraft: controllerApi.runtime.isAutodraftActive(environment.document), kill: false });
      rail.controls.arm.disabled = true;
      rail.lock("Arm from the verified League Two draft-home page so the token binds Yahoo's exact live field size and snake slot.", "TEST PREFLIGHT LOCKED");
      writeReceipt(environment.localStorage, { kind: "extension_locked", roomId: TEST_LEAGUE_ID, seat: TEST_TEAM_ID, failure: "verified_test_draft_home_arm_required" });
      return;
    }
    const executionMode = armRecord?.mode === "test_league_19_idp" ? "TEST" : "MOCK";
    const mode = modeAllowlist({ mode: executionMode, leagueId: room.roomId });
    const draftSeat = executionMode === "TEST" ? Number(armRecord?.seat) : room.seat;
    const configName = executionMode === "TEST" ? "test_league_19_idp" : "public_mock_15";
    const expectedRosterTotal = executionMode === "TEST" ? 19 : 15;
    const rosterSlots = executionMode === "TEST" ? TEST_ROSTER_SLOTS : PUBLIC_ROSTER_SLOTS;
    const leagueLabel = executionMode === "TEST" ? "League Two" : room.roomId === DISABLED_LEAGUE_ID ? "420010 BLOCKED" : "PUBLIC";
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
      rail.setWarnings(buildUiWarnings({ room, armRecord: null, autodraft: controllerApi.runtime.isAutodraftActive(environment.document), roster: null, board: boardData.players, boardData, expectedRosterTotal }));
      rail.render("bad", "LOCKED", `${preflightError} · arm from the approved ${executionMode.toLowerCase()} preflight`);
      return;
    }
    rail.setContext({ roomId: room.roomId, seat: draftSeat, league: leagueLabel, armed: true, autodraft: controllerApi.runtime.isAutodraftActive(environment.document), kill: false });
    rail.render("", "VALIDATING", `Room ${room.roomId} · draft slot ${draftSeat}`);
    await waitForEmptyDraft(environment.document, controllerApi, environment, expectedRosterTotal, executionMode);
    const board = await prepareBoard(environment.document, environment, controllerApi, boardData, executionMode);
    rail.setBoard(board);
    rail.setRecommendations([], { fullBoard: board });
    rail.setWarnings(buildUiWarnings({ room, armRecord, autodraft: controllerApi.runtime.isAutodraftActive(environment.document), roster: { total: expectedRosterTotal }, board, boardData, expectedRosterTotal }));
    const runtimeAttestation = rail.getSnapshot().attestation;
    if (!validRuntimeAttestation(runtimeAttestation)) throw new Error("runtime_attestation_missing_before_runner_create");
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
      selectionHoldMs: 1200,
      replacementBySlot: boardData.replacementBySlot,
      survivalCalibration: boardData.survivalCalibration,
      runtimeAttestation,
      board,
      readManualOverride: () => readJson(environment.sessionStorage, MANUAL_STAGE_KEY, null),
      consumeManualOverride: (outcome) => {
        const stage = readJson(environment.sessionStorage, MANUAL_STAGE_KEY, null);
        environment.sessionStorage.removeItem(MANUAL_STAGE_KEY);
        rail.setPinOutcome(outcome);
        writeReceipt(environment.localStorage, { kind: `manual_pin_${outcome.status}`, roomId: room.roomId, seat: draftSeat, expectedRound: outcome.expectedRound, chosenYahooId: outcome.chosenYahooId ?? null, injury:outcome.injury ?? null, failure: outcome.reason ?? null, baselineRetained: outcome.status === "rejected" });
        const injuryWarning = outcome.injury?.draftAction === "REVIEW" ? ` · INJURY REVIEW: ${outcome.injury.status ?? "UNKNOWN"}` : "";
        rail.addEvent(`manual pin ${outcome.status}`, outcome.chosenYahooId ? `Y!${outcome.chosenYahooId} · R${outcome.expectedRound}${injuryWarning}` : `${outcome.reason ?? "not applied"} · ${stage?.targets?.length ?? 0} staged`);
      },
      onAlert: ({ state, failure, reason }) => rail.render("bad", state, failure?.code ?? reason ?? "runner stopped"),
    }, environment);
    environment[GLOBAL_KEY] = { runner, room, token: armRecord, statusTimer:null };
    rail.setManualHandler((targets) => {
      try {
        const status = runner.getStatus();
        if (status.state !== "created" && status.state !== "running") throw new Error("manual pin requires an active runner");
        const chosen = Array.from(targets ?? [])[0];
        if (status.pendingDecision) {
          if (!chosen?.yahooId) throw new Error("on-clock choice requires one exact Yahoo player");
          const applied = runner.chooseOnClock(chosen.yahooId, "command_center");
          writeReceipt(environment.localStorage, { kind: applied ? "on_clock_choice_applied" : "on_clock_choice_rejected", roomId: room.roomId, seat: draftSeat, expectedRound: status.picks.length + 1, chosenYahooId: String(chosen.yahooId), injury:chosen.injury ?? null, baselineRetained: !applied });
          rail.addEvent(applied ? "on-clock choice applied" : "on-clock choice rejected", `${chosen.name ?? `Y!${chosen.yahooId}`} · baseline ${applied ? "fallbacks retained" : "unchanged"}${chosen.injury?.draftAction === "REVIEW" ? ` · INJURY REVIEW: ${chosen.injury.status ?? "UNKNOWN"}` : ""}`);
          if (applied) rail.render("ok", "CHOICE LOCKED", `${chosen.name ?? `Y!${chosen.yahooId}`} · Yahoo click in progress`);
          return applied;
        }
        if (status.busy || status.currentController || controllerApi.runtime.readOwnedTurn(environment.document)) {
          throw new Error("owned-turn decision window is not ready; baseline remains active");
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
    rail.controls.dock.disabled = false;
    rail.controls.dock.textContent = "KILL";
    enableExport(environment, rail, receiptRoom, runner);
    rail.controls.halt.addEventListener("click", () => {
      runner.halt("operator_kill_switch");
      environment.sessionStorage.removeItem(PREFLIGHT_KEY);
      rail.addEvent("kill switch engaged", "runner halted; re-arm from a new waiting room");
      rail.setContext({ roomId: room.roomId, seat: draftSeat, league: leagueLabel, armed: false, autodraft: controllerApi.runtime.isAutodraftActive(environment.document), kill: true });
      rail.render("bad", "HALTED", "One-way kill switch engaged. Re-arm from a new waiting room.");
      rail.controls.halt.disabled = true;
      rail.controls.dock.disabled = true;
    });
    const startAttestation = await verifyCurrentExtensionVersion(environment, rail);
    if (!startAttestation) return;
    if (!sameRuntimeAttestation(runtimeAttestation, startAttestation)) throw new Error("runtime_attestation_changed_before_runner_start");
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
      const observedClock = controllerApi.runtime.readDraftClock(environment.document);
      const clock = observedClock?.label ?? "--:--";
      const clockVerified = Boolean(observedClock);
      const autodraftState = controllerApi.runtime.readAutodraftState(environment.document);
      const queueState = controllerApi.runtime.readQueueState(environment.document);
      const marker = JSON.stringify([status.state, status.picks.length, status.failure, status.pendingDecision?.targetYahooIds ?? null, turn?.label ?? null, clock, autodraftState, queueState]);
      if (marker === last) return;
      last = marker;
      const kind = status.state === "completed" ? "complete" : status.state === "running" ? "ok" : "bad";
      const roster = controllerApi.runtime.parseRosterCount(environment.document.body?.innerText);
      const decision = runner.exportReceipts().filter((entry) => entry.kind === "runner_turn_resolved").at(-1)?.decision ?? null;
      rail.setContext({ roomId: room.roomId, seat: draftSeat, league: leagueLabel, round: turn?.round, pick: turn?.pick, clock, clockVerified, ownedTurn: ownedTurnFromRunnerStatus(status), armed: true, autodraftState, queueState, kill: ["halted", "failed"].includes(status.state) });
      rail.setRoster(buildUiRoster(status.picks, rosterSlots), status.picks.at(-1));
      rail.setRecommendations(buildUiRecommendations(board, decision), { fullBoard: board, disagreement: status.failure?.code?.includes("mismatch") });
      rail.setBetweenTurns(buildUiOpponentWindow(decision, executionMode));
      rail.setWarnings(buildUiWarnings({ room, armRecord, autodraft:autodraftState === "ACTIVE", roster, board, boardData, decision, expectedRosterTotal }));
      rail.render(kind, status.state, `${status.picks.length}/${expectedRosterTotal} confirmed${status.failure ? ` · ${status.failure.code ?? status.failure}` : ""}`);
      if (["completed", "failed", "halted", "stopped"].includes(status.state)) {
        environment.clearInterval(statusTimer);
        environment.sessionStorage.removeItem(PREFLIGHT_KEY);
        environment.sessionStorage.removeItem(MANUAL_STAGE_KEY);
        rail.setPinned(null);
        rail.controls.halt.disabled = true;
        rail.controls.dock.disabled = true;
      }
    }, 100);
    environment[GLOBAL_KEY].statusTimer = statusTimer;
  }

  async function boot(environment = root) {
    if (!environment.document || !environment.location) return null;
    const rail = createRail(environment.document);
    installReloadAndVerify(environment, rail);
    attachCommandCenterBridge(environment, rail);
    try {
      const markerRaw = environment.sessionStorage.getItem(RELOAD_MARKER_KEY);
      const marker = markerRaw == null ? null : readJson(environment.sessionStorage, RELOAD_MARKER_KEY, { invalid:true });
      if (!await verifyCurrentExtensionVersion(environment, rail, { retry:Boolean(markerRaw) })) return rail;
      const reloadOutcome = evaluateReloadMarker(marker, rail.getSnapshot().attestation);
      if (reloadOutcome.status === "failed") {
        rail.lock(reloadOutcome.reason, "RELOAD VERIFY FAILED");
        return rail;
      }
      if (reloadOutcome.status === "passed") {
        environment.sessionStorage.removeItem(RELOAD_MARKER_KEY);
        rail.addEvent("reload verified", reloadOutcome.reason);
      }
      if (environment.location.pathname === "/f1/mock_waiting") {
        bootWaitingRoom(environment, rail);
      } else if (environment.location.pathname === `/f1/${TEST_LEAGUE_ID}/settings`) {
        bootTestSettings(environment, rail);
      } else if (environment.location.pathname === `/f1/${TEST_LEAGUE_ID}/draft`) {
        bootTestDraftHome(environment, rail);
      } else if (environment.location.pathname === `/f1/${TEST_LEAGUE_ID}/${TEST_TEAM_ID}`) {
        bootTestTeamRoster(environment, rail);
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
      boardHealthReceipt,
      boardHealthGate,
      refuseArmForBoardHealth,
      parseTestSettings,
      makeTestSettingsReceipt,
      validTestSettingsReceipt,
      parseTestDraftHome,
      requiredTestFilterLabels,
      parseFinalRosterDocument,
      makeTestPreflight,
      validateDraftPreflight,
      modeAllowlist,
      validateExactYahooTargets,
      stageManualTargets,
      mergeDefenseBoard,
      makeOperatorAttestation,
      statusFromRunnerReceipts,
      requireCurrentExtensionVersion,
      requireRuntimeAttestationWithRetry,
      validRuntimeAttestation,
      sameRuntimeAttestation,
      makeReloadMarker,
      evaluateReloadMarker,
      reloadRefusal,
      installReloadAndVerify,
      buildExportPayload,
      buildUiRoster,
      buildUiRecommendations,
      buildUiOpponentWindow,
      buildUiWarnings,
      recommendationHotkeyPlayer,
      ownedTurnFromRunnerStatus,
      commandCenterRole,
      attachCommandCenterBridge,
      publicRosterSlots: PUBLIC_ROSTER_SLOTS,
      testRosterSlots: TEST_ROSTER_SLOTS,
    },
  };

  if (root.document && root.location && !root[GLOBAL_KEY]) void boot(root);
})(globalThis);
