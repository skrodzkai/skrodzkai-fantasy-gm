(function installYahooMockRunner(root) {
  "use strict";

  const VERSION = "1.0.1";
  const GLOBAL_KEY = "__skrodzkaiYahooMockRunnerV1";
  const RECEIPT_KEY = "skrodzkai-yahoo-mock-runner-receipts-v1";
  const OFFENSE = ["QB", "RB", "WR", "TE"];

  const CONFIGS = Object.freeze({
    public_mock_15: Object.freeze({
      name: "public_mock_15",
      teams: 12,
      rounds: 15,
      rosterTotal: 15,
      rosterSlots: Object.freeze([
        "QB", "WR", "WR", "RB", "RB", "TE", "W/R/T", "K", "DEF",
        "BN", "BN", "BN", "BN", "BN", "BN",
      ]),
      offenseStarters: Object.freeze({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 }),
      positionLimits: Object.freeze({ QB: 1, RB: 5, WR: 6, TE: 1, K: 1, DEF: 1 }),
      qualification: "public-mock-only",
    }),
    real_league_19_idp: Object.freeze({
      name: "real_league_19_idp",
      teams: 12,
      rounds: 19,
      rosterTotal: 19,
      rosterSlots: Object.freeze([
        "QB", "WR", "WR", "WR", "RB", "RB", "TE", "W/R/T", "K", "DEF",
        "D", "DB", "LB", "BN", "BN", "BN", "BN", "BN", "BN",
      ]),
      qualification: "unverified-real-room",
    }),
  });

  function normalize(value) {
    return String(value ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9/]+/g, " ")
      .trim()
      .toUpperCase();
  }

  function normalizeSlots(slots) {
    return Array.from(slots ?? [], normalize);
  }

  function sameSlots(actual, expected) {
    const left = normalizeSlots(actual);
    const right = normalizeSlots(expected);
    return left.length === right.length && left.every((slot, index) => slot === right[index]);
  }

  function positionCounts(picks) {
    return Array.from(picks ?? []).reduce((counts, pick) => {
      const position = normalize(pick.position);
      counts[position] = (counts[position] ?? 0) + 1;
      return counts;
    }, {});
  }

  function offenseComplete(counts, config = CONFIGS.public_mock_15) {
    const starters = config.offenseStarters;
    return (
      (counts.QB ?? 0) >= starters.QB &&
      (counts.RB ?? 0) >= starters.RB &&
      (counts.WR ?? 0) >= starters.WR &&
      (counts.TE ?? 0) >= starters.TE &&
      (counts.RB ?? 0) + (counts.WR ?? 0) >= starters.RB + starters.WR + starters.FLEX
    );
  }

  function allowedPositions(round, picks, config = CONFIGS.public_mock_15) {
    if (config.name !== "public_mock_15") return [];
    if (round === 14) return ["DEF"];
    if (round === 15) return ["K"];
    if (round < 1 || round > 13) return [];

    const counts = positionCounts(picks);
    const allowed = new Set(OFFENSE);
    if ((counts.QB ?? 0) >= config.positionLimits.QB) allowed.delete("QB");
    if ((counts.TE ?? 0) >= config.positionLimits.TE) allowed.delete("TE");
    if ((counts.RB ?? 0) >= config.positionLimits.RB) allowed.delete("RB");
    if ((counts.WR ?? 0) >= config.positionLimits.WR) allowed.delete("WR");

    if (!offenseComplete(counts, config)) {
      if ((counts.RB ?? 0) >= config.offenseStarters.RB + 1) allowed.delete("RB");
      if ((counts.WR ?? 0) >= config.offenseStarters.WR + 1) allowed.delete("WR");
    }
    return [...allowed];
  }

  function filterLabelForRound(round) {
    if (round === 14) return "Team Defenses";
    if (round === 15) return "Kickers";
    return "All Positions";
  }

  function boardKey(player) {
    return `ID:${String(player.yahooId)}`;
  }

  function validateBoard(board) {
    if (!Array.isArray(board) || board.length === 0) throw new Error("board must be a nonempty ranked array");
    const seen = new Set();
    return board.map((player, index) => {
      const copy = {
        yahooId: player.yahooId == null ? "" : String(player.yahooId),
        name: String(player.name ?? ""),
        position: normalize(player.position),
        team: normalize(player.team),
        rank: Number(player.rank ?? index + 1),
      };
      if (!copy.yahooId) throw new Error(`board player ${index} requires a verified Yahoo ID`);
      if (!OFFENSE.includes(copy.position) && !["K", "DEF"].includes(copy.position)) {
        throw new Error(`board player ${index} has unsupported public-mock position`);
      }
      if (!Number.isFinite(copy.rank)) throw new Error(`board player ${index} has invalid rank`);
      const key = boardKey(copy);
      if (seen.has(key)) throw new Error(`duplicate board player ${key}`);
      seen.add(key);
      return copy;
    });
  }

  function readAvailablePlayers(documentRef, controllerApi) {
    const runtime = controllerApi?.runtime;
    if (!runtime) throw new Error("Yahoo draft controller runtime helpers are unavailable");
    return [...documentRef.querySelectorAll("tr")]
      .map((row) => runtime.readPlayerRow(row))
      .filter(Boolean);
  }

  function buildTargets({ round, picks, board, availablePlayers, minimum = 5, config = CONFIGS.public_mock_15 }) {
    const allowed = new Set(allowedPositions(round, picks, config));
    const used = new Set(Array.from(picks ?? [], boardKey));
    const availableById = new Map(
      Array.from(availablePlayers ?? [], (player) => [String(player.yahooId), player]),
    );
    const targets = board
      .filter((player) => allowed.has(player.position))
      .filter((player) => !used.has(boardKey(player)))
      .filter((player) => availableById.has(player.yahooId))
      .sort((left, right) => left.rank - right.rank)
      .map((player) => ({
        yahooId: player.yahooId,
        name: availableById.get(player.yahooId).name,
        position: player.position,
        team: availableById.get(player.yahooId).team,
      }));
    if (targets.length < minimum) {
      throw new Error(`fewer_than_${minimum}_eligible_targets`);
    }
    return targets;
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
    const value = String(match.option.value ?? "");
    if (String(match.select.value ?? "") !== value) {
      match.select.value = value;
      const EventCtor = environment.Event;
      match.select.dispatchEvent(new EventCtor("input", { bubbles: true }));
      match.select.dispatchEvent(new EventCtor("change", { bubbles: true }));
    }
  }

  function validateCompletedRoster(picks, config = CONFIGS.public_mock_15) {
    const counts = positionCounts(picks);
    return (
      picks.length === config.rounds &&
      offenseComplete(counts, config) &&
      (counts.QB ?? 0) === 1 &&
      (counts.TE ?? 0) === 1 &&
      (counts.DEF ?? 0) === 1 &&
      (counts.K ?? 0) === 1 &&
      (counts.RB ?? 0) <= config.positionLimits.RB &&
      (counts.WR ?? 0) <= config.positionLimits.WR
    );
  }

  function create(options = {}, environment = root) {
    const controllerApi = environment.SKRODZKaiYahooDraftController;
    const documentRef = environment.document;
    const locationRef = environment.location;
    const storage = environment.localStorage;
    if (!controllerApi || !documentRef || !locationRef || !storage) {
      throw new Error("controller, browser document, location, and localStorage are required");
    }
    if (["created", "running"].includes(environment[GLOBAL_KEY]?.getStatus?.().state)) {
      throw new Error("another Yahoo mock runner is already active");
    }

    const config = CONFIGS[options.configName ?? "public_mock_15"];
    if (!config) throw new Error("unknown roster configuration");
    if (config.qualification !== "public-mock-only") {
      throw new Error("real league configuration is not qualified for execution");
    }
    const expectedRoomId = String(options.expectedRoomId ?? "");
    const expectedSeat = Number(options.expectedSeat);
    const observedTeamCount = Number(options.observedTeamCount);
    const observedRosterSlots = normalizeSlots(options.observedRosterSlots);
    const minimumFallbacks = Number(options.minimumFallbacks ?? 5);
    const pollMs = Number(options.pollMs ?? 25);
    const filterDeadlineMs = Number(options.filterDeadlineMs ?? 5000);
    const board = validateBoard(options.board);
    if (!expectedRoomId || !Number.isInteger(expectedSeat) || expectedSeat < 1 || expectedSeat > config.teams) {
      throw new Error("expected room and seat are required");
    }
    if (observedTeamCount !== config.teams) throw new Error("mock room must contain exactly 12 teams");
    if (!sameSlots(observedRosterSlots, config.rosterSlots)) throw new Error("mock roster shape does not match public_mock_15");
    if (!Number.isInteger(minimumFallbacks) || minimumFallbacks < 5) throw new Error("minimumFallbacks must be at least 5");
    if (pollMs < 25 || filterDeadlineMs <= 0) throw new Error("invalid runner timing configuration");

    const room = controllerApi.runtime.parseRoom(locationRef.pathname);
    if (!room || room.roomId !== expectedRoomId || room.seat !== expectedSeat) {
      throw new Error("draft room or seat does not match the mock preflight");
    }
    const rosterAtCreate = controllerApi.runtime.parseRosterCount(documentRef.body?.innerText);
    if (!rosterAtCreate || rosterAtCreate.total !== config.rosterTotal || rosterAtCreate.filled !== 0) {
      throw new Error("mock must begin with the expected empty roster");
    }

    const runId = environment.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const picks = [];
    let monitorId = null;
    let currentController = null;
    let state = "created";
    let failure = null;
    let busy = false;

    function readReceipts() {
      const parsed = JSON.parse(storage.getItem(RECEIPT_KEY) ?? "[]");
      if (!Array.isArray(parsed)) throw new Error("runner receipt storage is not an array");
      return parsed;
    }

    function receipt(kind, details = {}) {
      const receipts = readReceipts();
      const entry = {
        at: new Date().toISOString(),
        version: VERSION,
        runId,
        roomId: room.roomId,
        seat: room.seat,
        kind,
        ...details,
      };
      receipts.push(entry);
      storage.setItem(RECEIPT_KEY, JSON.stringify(receipts.slice(-5000)));
      return entry;
    }

    function stopMonitor() {
      if (monitorId != null) environment.clearInterval(monitorId);
      monitorId = null;
    }

    function fail(code, details = {}) {
      if (["failed", "completed", "halted", "stopped"].includes(state)) return;
      failure = { code, ...details };
      state = "failed";
      stopMonitor();
      try {
        currentController?.stop?.("runner_failed");
      } catch (error) {
        failure.stopError = String(error?.message ?? error);
      }
      try {
        receipt("runner_failed", failure);
      } catch (error) {
        failure.receiptError = String(error?.message ?? error);
      } finally {
        options.onAlert?.({ state, failure, roomId: room.roomId, seat: room.seat });
      }
    }

    function delay(milliseconds) {
      return new Promise((resolve) => environment.setTimeout(resolve, milliseconds));
    }

    async function targetsAfterFilter(round, label) {
      const startedAt = Date.now();
      let lastEligibilityError = null;
      setFilter(documentRef, environment, label);
      while (Date.now() - startedAt < filterDeadlineMs) {
        if (state !== "running") throw new Error("runner_not_running");
        try {
          const availablePlayers = readAvailablePlayers(documentRef, controllerApi);
          const targets = buildTargets({
            round,
            picks,
            board,
            availablePlayers,
            minimum: minimumFallbacks,
            config,
          });
          return { targets, filterReadyMs: Date.now() - startedAt };
        } catch (error) {
          if (!String(error?.message ?? error).startsWith("fewer_than_")) throw error;
          lastEligibilityError = String(error.message);
        }
        await delay(25);
      }
      throw new Error(lastEligibilityError ?? `position_filter_timeout:${label}`);
    }

    async function armRound() {
      if (state !== "running") return;
      const round = picks.length + 1;
      const filterLabel = filterLabelForRound(round);
      const { targets, filterReadyMs } = await targetsAfterFilter(round, filterLabel);
      if (state !== "running") return;
      receipt("runner_round_armed", {
        round,
        filterLabel,
        filterReadyMs,
        targetCount: targets.length,
        allowedPositions: allowedPositions(round, picks, config),
      });
      const nextController = controllerApi.create(
        {
          targets,
          pollMs: 50,
          selectionDeadlineMs: 10000,
          confirmationDeadlineMs: 5000,
          minimumAvailableTargets: minimumFallbacks,
          maxConfirmedPicks: 1,
          expectedRoomId,
          expectedSeat,
          expectedRosterTotal: config.rosterTotal,
          failureAction: "stay",
        },
        environment,
      );
      try {
        currentController = nextController.start();
      } catch (error) {
        nextController.stop("start_failed");
        throw error;
      }
    }

    async function advance() {
      if (busy || state !== "running" || !currentController) return;
      const status = currentController.getStatus();
      if (status.state === "failed") return fail("pick_controller_failed", { controllerFailure: status.failure });
      if (status.confirmedPicks > 1) return fail("pick_count_contract_failed", { confirmedPicks: status.confirmedPicks });
      if (status.confirmedPicks < 1) return;
      busy = true;
      try {
        const controllerReceipts = currentController.exportReceipts();
        const clicks = controllerReceipts.filter((entry) => entry.kind === "draft_click");
        const confirmations = controllerReceipts.filter((entry) => entry.kind === "pick_confirmed");
        if (clicks.length !== 1 || confirmations.length !== 1) throw new Error("pick_receipt_contract_failed");
        const confirmation = confirmations[0];
        const pick = {
          yahooId: confirmation.yahooId,
          name: confirmation.name,
          position: confirmation.position,
          team: confirmation.team,
          turn: confirmation.turn,
          detectionToClickMs: clicks[0].detectionToClickMs,
          clickToConfirmationMs: confirmation.clickToConfirmationMs,
        };
        picks.push(pick);
        if (
          confirmation.rosterAfter?.filled !== picks.length ||
          confirmation.rosterAfter?.total !== config.rosterTotal
        ) {
          throw new Error("roster_drift");
        }
        receipt("runner_pick_confirmed", { round: picks.length, pick });
        currentController.stop("round_complete");
        currentController = null;

        if (picks.length === config.rounds) {
          const roster = controllerApi.runtime.parseRosterCount(documentRef.body?.innerText);
          if (!roster || roster.filled !== config.rosterTotal || roster.total !== config.rosterTotal) {
            throw new Error("completed_roster_readback_failed");
          }
          if (!validateCompletedRoster(picks, config)) throw new Error("completed_roster_policy_failed");
          state = "completed";
          stopMonitor();
          receipt("runner_completed", { picks: picks.length, counts: positionCounts(picks) });
          return;
        }
        await armRound();
      } catch (error) {
        fail(String(error?.message ?? error));
      } finally {
        busy = false;
      }
    }

    function start() {
      if (state !== "created") throw new Error(`cannot start runner from ${state}`);
      const probeKey = `${RECEIPT_KEY}-probe`;
      storage.setItem(probeKey, "ok");
      if (storage.getItem(probeKey) !== "ok") throw new Error("runner receipt storage probe failed");
      storage.removeItem(probeKey);
      const rosterAtStart = controllerApi.runtime.parseRosterCount(documentRef.body?.innerText);
      if (!rosterAtStart || rosterAtStart.filled !== 0 || rosterAtStart.total !== config.rosterTotal) {
        throw new Error("mock roster changed after preflight");
      }
      if (controllerApi.runtime.isAutodraftActive(documentRef)) {
        fail("autodraft_active_at_start");
        return api;
      }
      state = "running";
      receipt("runner_started", {
        configName: config.name,
        expectedRoomId,
        expectedSeat,
        observedTeamCount,
        observedRosterSlots,
        minimumFallbacks,
      });
      monitorId = environment.setInterval(advance, pollMs);
      armRound().catch((error) => fail(String(error?.message ?? error)));
      return api;
    }

    function halt(reason = "kill_switch") {
      if (["halted", "failed", "completed", "stopped"].includes(state)) return api;
      if (state !== "running") return api;
      if (controllerApi.runtime.isAutodraftActive(documentRef)) return fail("autodraft_active_at_halt");
      const controllerStatus = currentController?.getStatus?.() ?? null;
      let controllerReceipts = [];
      try {
        controllerReceipts = currentController?.exportReceipts?.() ?? [];
      } catch {
        controllerReceipts = [];
      }
      stopMonitor();
      let stopError = null;
      try {
        currentController?.stop?.(reason);
      } catch (error) {
        stopError = String(error?.message ?? error);
      }
      currentController = null;
      state = "halted";
      receipt("runner_halted", {
        reason,
        picks: picks.length,
        autodraftActive: false,
        controllerStatus,
        stopError,
        draftClicks: controllerReceipts.filter((entry) => entry.kind === "draft_click").length,
        pickConfirmations: controllerReceipts.filter((entry) => entry.kind === "pick_confirmed").length,
      });
      options.onAlert?.({ state, reason, roomId: room.roomId, seat: room.seat });
      return api;
    }

    function stop(reason = "operator_stop") {
      if (["completed", "failed", "halted", "stopped"].includes(state)) return;
      stopMonitor();
      currentController?.stop?.(reason);
      currentController = null;
      state = "stopped";
      receipt("runner_stopped", { reason, picks: picks.length });
    }

    function getStatus() {
      return {
        version: VERSION,
        runId,
        roomId: room.roomId,
        seat: room.seat,
        state,
        failure,
        picks: picks.slice(),
        currentController: currentController?.getStatus?.() ?? null,
      };
    }

    function exportReceipts() {
      return readReceipts().filter((entry) => entry.runId === runId);
    }

    const api = { start, halt, stop, getStatus, exportReceipts };
    environment[GLOBAL_KEY] = api;
    return api;
  }

  root.SKRODZKaiYahooMockRunner = {
    version: VERSION,
    configs: CONFIGS,
    create,
    receiptKey: RECEIPT_KEY,
    _test: {
      normalizeSlots,
      sameSlots,
      positionCounts,
      offenseComplete,
      allowedPositions,
      filterLabelForRound,
      validateBoard,
      buildTargets,
      validateCompletedRoster,
    },
  };
})(globalThis);
