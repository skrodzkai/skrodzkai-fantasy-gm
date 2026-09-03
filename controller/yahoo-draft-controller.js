(function installYahooDraftController(root) {
  "use strict";

  const VERSION = "1.1.3";
  const GLOBAL_KEY = "__skrodzkaiYahooDraftControllerV1";
  const RECEIPT_KEY = "skrodzkai-yahoo-draft-controller-receipts-v1";
  const readers = root.SKRODZKaiYahooPageReaders;
  if (!readers) throw new Error("SKRODZKai Yahoo page readers must load before the controller");
  const {
    normalize, parseRoom, parseRosterCount, readOwnedTurn, buttonText,
    readAutodraftState, isAutodraftActive, readQueueState, readDraftClock,
    blockers, readPlayerRow,
  } = readers;

  function targetKey(target) {
    return target.yahooId
      ? `ID:${String(target.yahooId)}`
      : `NPT:${normalize(target.name)}:${normalize(target.position)}:${normalize(target.team)}`;
  }

  function matchesTarget(player, target) {
    if (target.yahooId) return player.yahooId === String(target.yahooId);
    return (
      normalize(player.name) === normalize(target.name) &&
      player.position === normalize(target.position) &&
      player.team === normalize(target.team)
    );
  }

  function findTargetRows(documentRef, target) {
    return [...documentRef.querySelectorAll("tr")]
      .map(readPlayerRow)
      .filter(Boolean)
      .filter((player) => matchesTarget(player, target));
  }

  function findDraftButtons(rootRef) {
    return [...rootRef.querySelectorAll("button")].filter(
      (button) => buttonText(button) === "Draft" && !button.disabled,
    );
  }

  function validateTargets(targets) {
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new Error("targets must be a nonempty ordered array");
    }
    const seen = new Set();
    return targets.map((target, index) => {
      if (!target || typeof target !== "object") throw new Error(`target ${index} is invalid`);
      const copy = {
        yahooId: target.yahooId == null ? "" : String(target.yahooId),
        name: String(target.name ?? ""),
        position: normalize(target.position),
        team: normalize(target.team),
      };
      if (!copy.yahooId && (!copy.name || !copy.position || !copy.team)) {
        throw new Error(`target ${index} requires yahooId or exact Yahoo name, position, and team`);
      }
      const key = targetKey(copy);
      if (seen.has(key)) throw new Error(`duplicate target ${key}`);
      seen.add(key);
      return copy;
    });
  }

  function create(options = {}, environment = root) {
    const documentRef = environment.document;
    const locationRef = environment.location;
    const storage = environment.localStorage;
    if (!documentRef || !locationRef || !storage) throw new Error("browser document, location, and localStorage are required");
    if (["created", "running"].includes(environment[GLOBAL_KEY]?.getStatus?.().state)) {
      throw new Error("another Yahoo draft controller is already running");
    }

    const room = parseRoom(locationRef.pathname);
    if (!room) throw new Error("controller must be created on a Yahoo NFL draftclient room");
    const expectedRoomId = options.expectedRoomId == null ? room.roomId : String(options.expectedRoomId);
    const expectedSeat = options.expectedSeat == null ? room.seat : Number(options.expectedSeat);
    const expectedRosterTotal = options.expectedRosterTotal == null ? null : Number(options.expectedRosterTotal);
    const failureAction = String(options.failureAction ?? "mock_lobby");
    if (room.roomId !== expectedRoomId || room.seat !== expectedSeat) {
      throw new Error("draft room or seat does not match the approved preflight");
    }
    if (expectedRosterTotal != null && (!Number.isInteger(expectedRosterTotal) || expectedRosterTotal <= 0)) {
      throw new Error("expectedRosterTotal must be a positive integer");
    }
    if (!new Set(["mock_lobby", "stay"]).has(failureAction)) {
      throw new Error("failureAction must be mock_lobby or stay");
    }
    const targets = validateTargets(options.targets);
    const pollMs = Number(options.pollMs ?? 50);
    const selectionDeadlineMs = Number(options.selectionDeadlineMs ?? 5000);
    const confirmationDeadlineMs = Number(options.confirmationDeadlineMs ?? 5000);
    const minimumAvailableTargets = Number(options.minimumAvailableTargets ?? 1);
    const maxConfirmedPicks = Number(options.maxConfirmedPicks ?? Number.MAX_SAFE_INTEGER);
    if (
      pollMs < 25 ||
      selectionDeadlineMs <= 0 ||
      confirmationDeadlineMs <= 0 ||
      !Number.isInteger(minimumAvailableTargets) ||
      minimumAvailableTargets <= 0 ||
      !Number.isInteger(maxConfirmedPicks) ||
      maxConfirmedPicks <= 0
    ) {
      throw new Error("invalid timing configuration");
    }

    const sessionId = environment.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const usedTargets = new Set();
    let intervalId = null;
    let busy = false;
    let state = "created";
    let failure = null;
    let confirmedPicks = 0;
    let lastTurn = null;

    function timestamp() {
      return new Date().toISOString();
    }

    function readReceipts() {
      const parsed = JSON.parse(storage.getItem(RECEIPT_KEY) ?? "[]");
      if (!Array.isArray(parsed)) throw new Error("receipt storage is not an array");
      return parsed;
    }

    function receipt(kind, details = {}) {
      const receipts = readReceipts();
      receipts.push({
        at: timestamp(),
        version: VERSION,
        sessionId,
        roomId: room.roomId,
        seat: room.seat,
        kind,
        ...details,
      });
      storage.setItem(RECEIPT_KEY, JSON.stringify(receipts.slice(-5000)));
    }

    function stopInterval() {
      if (intervalId != null) environment.clearInterval(intervalId);
      intervalId = null;
    }

    function fail(code, details = {}) {
      if (state === "failed" || state === "stopped") return;
      failure = { code, ...details };
      state = "failed";
      stopInterval();
      try {
        receipt("controller_failed", failure);
      } catch (error) {
        failure.receiptError = String(error?.message ?? error);
      } finally {
        if (failureAction === "mock_lobby" && code !== "room_changed" && typeof locationRef.assign === "function") {
          locationRef.assign("/f1/mock_lobby");
        }
      }
    }

    function delay(milliseconds) {
      return new Promise((resolve) => environment.setTimeout(resolve, milliseconds));
    }

    function assertSafeTurn(turn, rosterBefore) {
      const currentRoom = parseRoom(locationRef.pathname);
      if (!currentRoom || currentRoom.roomId !== room.roomId || currentRoom.seat !== room.seat) {
        throw new Error("room_changed");
      }
      const autodraftState = readAutodraftState(documentRef);
      if (autodraftState === "ACTIVE") throw new Error("autodraft_active");
      if (autodraftState !== "INACTIVE") throw new Error("autodraft_state_unknown");
      if (readQueueState(documentRef) !== "EMPTY") throw new Error("yahoo_queue_not_empty_or_unknown");
      const activeBlockers = blockers(documentRef, environment);
      if (activeBlockers.length) throw new Error(`blocking_ui:${activeBlockers.join("|")}`);
      const currentTurn = readOwnedTurn(documentRef);
      if (!currentTurn || currentTurn.label !== turn.label) throw new Error("owned_turn_changed");
      const rosterNow = parseRosterCount(documentRef.body?.innerText);
      if (!rosterNow || rosterNow.filled !== rosterBefore.filled || rosterNow.total !== rosterBefore.total) {
        throw new Error("roster_changed_before_click");
      }
    }

    async function handleOwnedTurn(turn) {
      const detectedAt = Date.now();
      const rosterBefore = parseRosterCount(documentRef.body?.innerText);
      if (!rosterBefore) throw new Error("roster_count_missing");
      const selections = [];

      assertSafeTurn(turn, rosterBefore);
      const players = [...documentRef.querySelectorAll("tr")]
        .map(readPlayerRow)
        .filter(Boolean);
      const playersById = new Map();
      const playersByIdentity = new Map();
      for (const player of players) {
        const idKey = `ID:${player.yahooId}`;
        const identityKey = targetKey(player);
        playersById.set(idKey, [...(playersById.get(idKey) ?? []), player]);
        playersByIdentity.set(identityKey, [...(playersByIdentity.get(identityKey) ?? []), player]);
      }

      for (const target of targets) {
        const key = targetKey(target);
        if (usedTargets.has(key)) continue;
        const matches = target.yahooId
          ? playersById.get(key) ?? []
          : playersByIdentity.get(key) ?? [];
        if (matches.length > 1) throw new Error(`ambiguous_target:${key}`);
        if (matches.length === 0) continue;
        const draftButtons = findDraftButtons(matches[0].row);
        if (draftButtons.length > 1) throw new Error("ambiguous_draft_button");
        if (draftButtons.length === 0) continue;
        selections.push({ target, key, player: matches[0], draftButton: draftButtons[0] });
        if (selections.length >= minimumAvailableTargets) break;
      }

      if (selections.length < minimumAvailableTargets) {
        throw new Error(`fewer_than_${minimumAvailableTargets}_approved_targets_available`);
      }
      const selection = selections[0];
      if (Date.now() - detectedAt > selectionDeadlineMs) throw new Error("selection_deadline_exceeded");
      assertSafeTurn(turn, rosterBefore);
      receipt("draft_click", {
        turn: turn.label,
        yahooId: selection.player.yahooId,
        name: selection.player.name,
        position: selection.player.position,
        team: selection.player.team,
        rosterBefore,
        autodraftState: readAutodraftState(documentRef),
        queueState: readQueueState(documentRef),
        clockAtClick: readDraftClock(documentRef),
        detectionToClickMs: Date.now() - detectedAt,
      });
      selection.draftButton.click();

      const confirmationStart = Date.now();
      let sawRosterIncrement = false;
      while (Date.now() - confirmationStart < confirmationDeadlineMs) {
        await delay(25);
        if (state !== "running") return;
        const autodraftState = readAutodraftState(documentRef);
        if (autodraftState === "ACTIVE") throw new Error("autodraft_activated_after_click");
        if (autodraftState !== "INACTIVE") throw new Error("autodraft_state_unknown_after_click");
        if (readQueueState(documentRef) !== "EMPTY") throw new Error("yahoo_queue_changed_after_click");
        const rosterAfter = parseRosterCount(documentRef.body?.innerText);
        if (rosterAfter && rosterAfter.filled !== rosterBefore.filled) {
          if (rosterAfter.filled !== rosterBefore.filled + 1 || rosterAfter.total !== rosterBefore.total) {
            throw new Error("unexpected_roster_transition");
          }
          sawRosterIncrement = true;
          const turnNow = readOwnedTurn(documentRef);
          if (turnNow?.label === turn.label) continue;
          usedTargets.add(selection.key);
          confirmedPicks += 1;
          lastTurn = turn.label;
          receipt("pick_confirmed", {
            turn: turn.label,
            yahooId: selection.player.yahooId,
            name: selection.player.name,
            position: selection.player.position,
            team: selection.player.team,
            rosterBefore,
            rosterAfter,
            clickToConfirmationMs: Date.now() - confirmationStart,
          });
          if (confirmedPicks >= maxConfirmedPicks) {
            stopInterval();
            state = "completed";
          }
          return;
        }
      }
      throw new Error(sawRosterIncrement ? "turn_did_not_advance" : "pick_confirmation_timeout");
    }

    async function tick() {
      if (state !== "running" || busy) return;
      try {
        const currentRoom = parseRoom(locationRef.pathname);
        if (!currentRoom || currentRoom.roomId !== room.roomId || currentRoom.seat !== room.seat) {
          return fail("room_changed");
        }
        const autodraftState = readAutodraftState(documentRef);
        if (autodraftState === "ACTIVE") return fail("autodraft_active");
        if (autodraftState !== "INACTIVE") return fail("autodraft_state_unknown");
        if (readQueueState(documentRef) !== "EMPTY") return fail("yahoo_queue_not_empty_or_unknown");
        const activeBlockers = blockers(documentRef, environment);
        if (activeBlockers.length) return fail("blocking_ui", { blockers: activeBlockers });
        const turn = readOwnedTurn(documentRef);
        if (!turn || turn.label === lastTurn) return;
        busy = true;
        await handleOwnedTurn(turn);
      } catch (error) {
        fail(String(error?.message ?? error));
      } finally {
        busy = false;
      }
    }

    function start() {
      if (state !== "created") throw new Error(`cannot start controller from ${state}`);
      if (environment[GLOBAL_KEY] !== api) throw new Error("controller registration changed before start");
      const probeKey = `${RECEIPT_KEY}-probe`;
      storage.setItem(probeKey, "ok");
      if (storage.getItem(probeKey) !== "ok") throw new Error("receipt storage probe failed");
      storage.removeItem(probeKey);
      const autodraftState = readAutodraftState(documentRef);
      if (autodraftState === "ACTIVE") throw new Error("Autodraft is active at start");
      if (autodraftState !== "INACTIVE") throw new Error("Autodraft state is unknown at start");
      const queueState = readQueueState(documentRef);
      if (queueState !== "EMPTY") throw new Error("Yahoo queue must be visibly empty at start");
      const activeBlockers = blockers(documentRef, environment);
      if (activeBlockers.length) throw new Error(`blocking UI at start: ${activeBlockers.join("|")}`);
      const roster = parseRosterCount(documentRef.body?.innerText);
      if (expectedRosterTotal != null && (!roster || roster.total !== expectedRosterTotal)) {
        throw new Error("roster total does not match the approved preflight");
      }
      state = "running";
      receipt("controller_started", {
        targetCount: targets.length,
        pollMs,
        selectionDeadlineMs,
        confirmationDeadlineMs,
        expectedRoomId,
        expectedSeat,
        expectedRosterTotal,
        failureAction,
        minimumAvailableTargets,
        maxConfirmedPicks,
        autodraftState,
        queueState,
      });
      intervalId = environment.setInterval(tick, pollMs);
      tick();
      return api;
    }

    function stop(reason = "operator_stop") {
      if (state === "stopped" || state === "failed") return;
      stopInterval();
      state = "stopped";
      receipt("controller_stopped", { reason, confirmedPicks });
    }

    function getStatus() {
      return { version: VERSION, sessionId, roomId: room.roomId, seat: room.seat, state, failure, confirmedPicks, lastTurn };
    }

    function exportReceipts() {
      return readReceipts().filter((entry) => entry.sessionId === sessionId);
    }

    const api = { start, stop, getStatus, exportReceipts };
    environment[GLOBAL_KEY] = api;
    return api;
  }

  root.SKRODZKaiYahooDraftController = {
    version: VERSION,
    create,
    receiptKey: RECEIPT_KEY,
    runtime: {
      parseRoom,
      parseRosterCount,
      readOwnedTurn,
      readAutodraftState,
      isAutodraftActive,
      readQueueState,
      readDraftClock,
      readPlayerRow,
    },
    _test: {
      normalize,
      parseRoom,
      parseRosterCount,
      readOwnedTurn,
      readAutodraftState,
      isAutodraftActive,
      readQueueState,
      readDraftClock,
      readPlayerRow,
      matchesTarget,
      findTargetRows,
      findDraftButtons,
      validateTargets,
    },
  };
})(globalThis);
