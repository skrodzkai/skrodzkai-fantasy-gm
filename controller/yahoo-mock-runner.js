(function installYahooMockRunner(root) {
  "use strict";

  const VERSION = "1.1.0";
  const GLOBAL_KEY = "__skrodzkaiYahooMockRunnerV1";
  const RECEIPT_KEY = "skrodzkai-yahoo-mock-runner-receipts-v1";
  const OFFENSE = ["QB", "RB", "WR", "TE"];
  const TEST_SPECIALISTS = ["K", "DEF", "D", "LB", "CB", "S"];
  const MATERIAL_EDGE_POINTS = 15;

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
    test_league_19_idp: Object.freeze({
      name: "test_league_19_idp",
      leagueId: "18599",
      urlTeamId: 12,
      teams: 12,
      rounds: 19,
      rosterTotal: 19,
      rosterSlots: Object.freeze([
        "QB", "WR", "WR", "RB", "RB", "W/R", "W/R/T", "K", "DEF",
        "D", "LB", "CB", "S", "BN", "BN", "BN", "BN", "BN", "BN",
      ]),
      offenseStarters: Object.freeze({ QB: 1, RB: 2, WR: 2, TE: 0, FLEX: 2 }),
      offenseMinimums: Object.freeze({ QB: 1, RB: 4, WR: 4, TE: 1 }),
      positionLimits: Object.freeze({ QB: 2, RB: 6, WR: 6, TE: 2, K: 1, DEF: 1, D: 1, LB: 1, CB: 1, S: 1 }),
      specialistPositions: Object.freeze(TEST_SPECIALISTS),
      specialistStartRound: 14,
      qualification: "verified-test-room",
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

  function specialistOrderForSeat(seat) {
    const opening = seat >= 5 && seat <= 8 ? ["DEF", "K"] : ["K", "DEF"];
    const idp = seat % 3 === 1 ? ["LB", "D", "S", "CB"] : seat % 3 === 2 ? ["D", "S", "LB", "CB"] : ["S", "CB", "D", "LB"];
    return [...opening, ...idp];
  }

  function allowedPositions(round, picks, config = CONFIGS.public_mock_15, seat = 1) {
    if (config.name === "test_league_19_idp") {
      if (round < 1 || round > config.rounds) return [];
      if (round >= config.specialistStartRound) {
        const counts = positionCounts(picks);
        const next = specialistOrderForSeat(seat).find((position) => (counts[position] ?? 0) < config.positionLimits[position]);
        return next ? [next] : [];
      }
      const counts = positionCounts(picks);
      const allowed = new Set(OFFENSE);
      for (const position of OFFENSE) if ((counts[position] ?? 0) >= config.positionLimits[position]) allowed.delete(position);
      if ((counts.QB ?? 0) >= 1 && round < 12) allowed.delete("QB");
      if ((counts.TE ?? 0) >= 1 && round < 13) allowed.delete("TE");
      const offensePicksRemaining = config.specialistStartRound - round;
      const shortages = OFFENSE.filter((position) => (counts[position] ?? 0) < config.offenseMinimums[position]);
      const shortagePicks = shortages.reduce((sum, position) => sum + config.offenseMinimums[position] - (counts[position] ?? 0), 0);
      if (shortagePicks >= offensePicksRemaining) {
        for (const position of OFFENSE) if (!shortages.includes(position)) allowed.delete(position);
      }
      if (!offenseComplete(counts, config)) {
        if ((counts.RB ?? 0) >= config.offenseStarters.RB + 2) allowed.delete("RB");
        if ((counts.WR ?? 0) >= config.offenseStarters.WR + 2) allowed.delete("WR");
      }
      return [...allowed];
    }
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

  function filterLabelForRound(round, picks = [], config = CONFIGS.public_mock_15, seat = 1) {
    if (config.name === "test_league_19_idp") {
      const position = allowedPositions(round, picks, config, seat)[0];
      return { K: "Kickers", DEF: "Team Defenses", D: "Defensive Players", LB: "Linebackers", CB: "Defensive Backs", S: "Defensive Backs" }[position] ?? "All Positions";
    }
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
      const position = normalize(player.position);
      const copy = {
        yahooId: player.yahooId == null ? "" : String(player.yahooId),
        name: String(player.name ?? ""),
        position,
        team: normalize(player.team),
        rank: Number(player.rank ?? index + 1),
      };
      if (!copy.yahooId) throw new Error(`board player ${index} requires a verified Yahoo ID`);
      if (!OFFENSE.includes(position) && !["K", "DEF", "D", "LB", "CB", "S"].includes(position)) {
        throw new Error(`board player ${index} has unsupported draft position`);
      }
      if (!Number.isFinite(copy.rank)) throw new Error(`board player ${index} has invalid rank`);
      if (OFFENSE.includes(position)) {
        const vor = Number(player.vor);
        const firstEndpoint = Number(player.adpLow ?? player.adp_low);
        const secondEndpoint = Number(player.adpHigh ?? player.adp_high);
        if (!Number.isFinite(vor)) throw new Error(`board player ${index} has invalid VORP`);
        if (!Number.isFinite(firstEndpoint) || !Number.isFinite(secondEndpoint)) {
          throw new Error(`board player ${index} requires a finite observed ADP range`);
        }
        copy.vor = vor;
        copy.adpEarliest = Math.min(firstEndpoint, secondEndpoint);
        copy.adpLatest = Math.max(firstEndpoint, secondEndpoint);
      } else if (Number.isFinite(Number(player.projection))) {
        copy.projection = Number(player.projection);
      }
      const key = boardKey(copy);
      if (seen.has(key)) throw new Error(`duplicate board player ${key}`);
      seen.add(key);
      return copy;
    });
  }

  function positionForConfirmedPick(board, confirmation) {
    const confirmed = board.find((player) => player.yahooId === String(confirmation?.yahooId ?? ""));
    if (!confirmed) throw new Error("confirmed pick is absent from the verified board");
    return confirmed.position;
  }

  function readAvailablePlayers(documentRef, controllerApi) {
    const runtime = controllerApi?.runtime;
    if (!runtime) throw new Error("Yahoo draft controller runtime helpers are unavailable");
    return [...documentRef.querySelectorAll("tr")]
      .map((row) => runtime.readPlayerRow(row))
      .filter(Boolean);
  }

  function overallPick(round, seat, teams = 12) {
    if (!Number.isInteger(round) || round < 1) throw new Error("round must be a positive integer");
    if (!Number.isInteger(seat) || seat < 1 || seat > teams) throw new Error("seat is outside the draft");
    return round % 2 === 1 ? (round - 1) * teams + seat : round * teams - seat + 1;
  }

  function turnWindow(round, seat, teams = 12, rounds = CONFIGS.public_mock_15.rounds) {
    const currentPick = overallPick(round, seat, teams);
    if (round >= rounds) {
      return { currentPick, nextPick: null, interveningOpponentPicks: null };
    }
    const nextPick = overallPick(round + 1, seat, teams);
    return { currentPick, nextPick, interveningOpponentPicks: nextPick - currentPick - 1 };
  }

  function survivalBucket(player, nextPick, interveningOpponentPicks) {
    if (interveningOpponentPicks === 0) return "certain_through_wrap";
    if (!Number.isFinite(nextPick)) return "terminal";
    if (player.adpLatest < nextPick) return "likely_gone";
    if (player.adpEarliest > nextPick) return "likely_there";
    return "ambiguous";
  }

  function byVorThenRank(left, right) {
    return right.vor - left.vor || left.rank - right.rank;
  }

  function compactPlayer(player) {
    if (!player) return null;
    return {
      yahooId: player.yahooId,
      position: player.position,
      rank: player.rank,
      vor: player.vor,
      adpEarliest: player.adpEarliest,
      adpLatest: player.adpLatest,
    };
  }

  function scorePositionLeaders({ round, seat, picks, pool, materialEdgePoints, config }) {
    const allowed = allowedPositions(round, picks, config, seat);
    const window = turnWindow(round, seat, config.teams, config.rounds);
    const counts = positionCounts(picks);
    const rbwrBefore = (counts.RB ?? 0) + (counts.WR ?? 0);
    const floorRequired = round <= 4 ? round - 1 : 0;
    const leaders = [];

    for (const position of allowed) {
      const candidates = pool.filter((player) => player.position === position);
      if (!candidates.length) continue;
      if (["DEF", "K", "D", "LB", "CB", "S"].includes(position)) {
        leaders.push({
          player: candidates.sort((left, right) => left.rank - right.rank)[0],
          comparator: null,
          bucket: "specialist",
          rawScore: 0,
          adjustedScore: 0,
        });
        continue;
      }

      candidates.sort(byVorThenRank);
      const player = candidates[0];
      if (round === 13) {
        leaders.push({
          player,
          comparator: null,
          bucket: "terminal_offense",
          rawScore: player.vor,
          adjustedScore: player.vor,
        });
        continue;
      }

      const bucket = survivalBucket(player, window.nextPick, window.interveningOpponentPicks);
      let comparator = player;
      if (!["certain_through_wrap", "likely_there"].includes(bucket)) {
        comparator = candidates.slice(1).find((candidate) =>
          survivalBucket(candidate, window.nextPick, window.interveningOpponentPicks) !== "likely_gone"
        );
        if (!comparator) {
          leaders.push({
            player,
            comparator: null,
            bucket: "position_unavailable_next_turn",
            rawScore: Math.max(0, player.vor),
            adjustedScore: Math.max(0, player.vor),
          });
          continue;
        }
      }
      const rawScore = Math.max(0, player.vor - comparator.vor);
      const adjustedScore = bucket === "likely_gone"
        ? rawScore
        : bucket === "ambiguous"
          ? Math.max(0, rawScore - materialEdgePoints)
          : 0;
      leaders.push({ player, comparator, bucket, rawScore, adjustedScore });
    }

    if (!leaders.length) throw new Error("no_position_leaders_available");
    const rbwrScores = leaders
      .filter((leader) => ["RB", "WR"].includes(leader.player.position))
      .map((leader) => leader.adjustedScore);
    const bestRbwrScore = rbwrScores.length ? Math.max(...rbwrScores) : null;

    for (const leader of leaders) {
      const isRbwr = ["RB", "WR"].includes(leader.player.position);
      const postPickRbwr = rbwrBefore + (isRbwr ? 1 : 0);
      const floorPass = postPickRbwr >= floorRequired;
      const floorException = round === 4 && !floorPass && !isRbwr && bestRbwrScore != null &&
        leader.adjustedScore >= bestRbwrScore + materialEdgePoints;
      leader.postPickRbwr = postPickRbwr;
      leader.floorRequired = floorRequired;
      leader.floorPass = floorPass;
      leader.floorException = floorException;
      leader.eligible = floorPass || floorException;
    }

    const ranked = leaders
      .filter((leader) => leader.eligible)
      .sort((left, right) =>
        right.adjustedScore - left.adjustedScore || left.player.rank - right.player.rank
      );
    if (!ranked.length) throw new Error("roster_floor_blocked_all_positions");
    return { window, leaders, ranked, bestRbwrScore, floorRequired, rbwrBefore };
  }

  function summarizeDecision(scored, chosen, materialEdgePoints) {
    return {
      currentPick: scored.window.currentPick,
      nextPick: scored.window.nextPick,
      interveningOpponentPicks: scored.window.interveningOpponentPicks,
      materialEdgePoints,
      rbwrBefore: scored.rbwrBefore,
      floorRequired: scored.floorRequired,
      bestRbwrScore: scored.bestRbwrScore,
      positionLeaders: scored.leaders.map((leader) => ({
        player: compactPlayer(leader.player),
        comparator: compactPlayer(leader.comparator),
        bucket: leader.bucket,
        rawScore: leader.rawScore,
        adjustedScore: leader.adjustedScore,
        postPickRbwr: leader.postPickRbwr,
        floorPass: leader.floorPass,
        floorException: leader.floorException,
        eligible: leader.eligible,
      })),
      chosenYahooId: chosen.player.yahooId,
    };
  }

  function buildDecisionLadder({
    round,
    seat,
    picks,
    board,
    availablePlayers,
    minimum = 5,
    materialEdgePoints = MATERIAL_EDGE_POINTS,
    config = CONFIGS.public_mock_15,
  }) {
    const allowed = new Set(allowedPositions(round, picks, config, seat));
    const used = new Set(Array.from(picks ?? [], boardKey));
    const availableById = new Map(
      Array.from(availablePlayers ?? [], (player) => [String(player.yahooId), player]),
    );
    let pool = board
      .filter((player) => allowed.has(player.position))
      .filter((player) => !used.has(boardKey(player)))
      .filter((player) => availableById.has(player.yahooId));
    if (pool.length < minimum) {
      throw new Error(`fewer_than_${minimum}_eligible_targets`);
    }

    const selected = [];
    let firstDecision = null;
    while (selected.length < minimum) {
      const scored = scorePositionLeaders({
        round,
        seat,
        picks,
        pool,
        materialEdgePoints,
        config,
      });
      const chosen = scored.ranked[0];
      if (!firstDecision) firstDecision = summarizeDecision(scored, chosen, materialEdgePoints);
      selected.push(chosen.player);
      pool = pool.filter((player) => player.yahooId !== chosen.player.yahooId);
    }

    const targets = selected.map((player) => ({
      yahooId: player.yahooId,
      name: availableById.get(player.yahooId).name,
      position: player.position,
      team: availableById.get(player.yahooId).team,
    }));
    firstDecision.targetYahooIds = targets.map((target) => target.yahooId);
    return { targets, decision: firstDecision };
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
    if (config.name === "test_league_19_idp") {
      return (
        picks.length === config.rounds &&
        offenseComplete(counts, config) &&
        OFFENSE.every((position) => (counts[position] ?? 0) >= config.offenseMinimums[position]) &&
        config.specialistPositions.every((position) => (counts[position] ?? 0) === 1) &&
        OFFENSE.every((position) => (counts[position] ?? 0) <= config.positionLimits[position])
      );
    }
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
    const executionMode = String(options.executionMode ?? "MOCK").toUpperCase();
    const qualified = config.qualification === "public-mock-only" && executionMode === "MOCK" ||
      config.qualification === "verified-test-room" && executionMode === "TEST";
    if (!qualified) {
      throw new Error("draft configuration is not qualified for this execution mode");
    }
    const expectedRoomId = String(options.expectedRoomId ?? "");
    const expectedSeat = Number(options.expectedSeat);
    const expectedUrlSeat = Number(options.expectedUrlSeat ?? expectedSeat);
    const observedTeamCount = Number(options.observedTeamCount);
    const observedRosterSlots = normalizeSlots(options.observedRosterSlots);
    const minimumFallbacks = Number(options.minimumFallbacks ?? 5);
    const pollMs = Number(options.pollMs ?? 25);
    const filterDeadlineMs = Number(options.filterDeadlineMs ?? 5000);
    const materialEdgePoints = MATERIAL_EDGE_POINTS;
    const board = validateBoard(options.board);
    if (!expectedRoomId || !Number.isInteger(expectedSeat) || expectedSeat < 1 || expectedSeat > config.teams) {
      throw new Error("expected room and seat are required");
    }
    if (!Number.isInteger(expectedUrlSeat) || expectedUrlSeat < 1) throw new Error("expected URL seat is required");
    if (config.leagueId && expectedRoomId !== config.leagueId) throw new Error("test league ID does not match verified configuration");
    if (config.urlTeamId && expectedUrlSeat !== config.urlTeamId) throw new Error("test team ID does not match verified configuration");
    if (observedTeamCount !== config.teams) throw new Error("draft room must contain exactly 12 teams");
    if (!sameSlots(observedRosterSlots, config.rosterSlots)) throw new Error(`draft roster shape does not match ${config.name}`);
    if (!Number.isInteger(minimumFallbacks) || minimumFallbacks < 5) throw new Error("minimumFallbacks must be at least 5");
    if (pollMs < 25 || filterDeadlineMs <= 0) {
      throw new Error("invalid runner timing configuration");
    }
    if (typeof controllerApi.runtime?.readOwnedTurn !== "function") {
      throw new Error("controller owned-turn runtime hook is required");
    }

    const room = controllerApi.runtime.parseRoom(locationRef.pathname);
    if (!room || room.roomId !== expectedRoomId || room.seat !== expectedUrlSeat) {
      throw new Error("draft room or URL team does not match the approved preflight");
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
        seat: expectedSeat,
        urlSeat: room.seat,
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
      options.onAlert?.({ state, failure, roomId: room.roomId, seat: expectedSeat });
      }
    }

    function delay(milliseconds) {
      return new Promise((resolve) => environment.setTimeout(resolve, milliseconds));
    }

    async function targetsAfterFilter(turn, label) {
      const startedAt = Date.now();
      let lastEligibilityError = null;
      setFilter(documentRef, environment, label);
      while (Date.now() - startedAt < filterDeadlineMs) {
        if (state !== "running") throw new Error("runner_not_running");
        try {
          const availablePlayers = readAvailablePlayers(documentRef, controllerApi);
          const resolved = buildDecisionLadder({
            round: turn.round,
            seat: expectedSeat,
            picks,
            board,
            availablePlayers,
            minimum: minimumFallbacks,
            materialEdgePoints,
            config,
          });
          return { ...resolved, filterReadyMs: Date.now() - startedAt };
        } catch (error) {
          if (!String(error?.message ?? error).startsWith("fewer_than_")) throw error;
          lastEligibilityError = String(error.message);
        }
        await delay(25);
      }
      throw new Error(lastEligibilityError ?? `position_filter_timeout:${label}`);
    }

    async function resolveOwnedTurn(turn) {
      if (state !== "running") return;
      const expectedRound = picks.length + 1;
      const expectedPick = overallPick(expectedRound, expectedSeat, config.teams);
      if (turn.round !== expectedRound || turn.pick !== expectedPick) {
        throw new Error(`owned_turn_mismatch:expected_R${expectedRound}P${expectedPick}:observed_${turn.label}`);
      }
      const filterLabel = filterLabelForRound(turn.round, picks, config, expectedSeat);
      const { targets, decision, filterReadyMs } = await targetsAfterFilter(turn, filterLabel);
      if (state !== "running") return;
      receipt("runner_turn_resolved", {
        turn: turn.label,
        filterLabel,
        filterReadyMs,
        targetCount: targets.length,
        allowedPositions: allowedPositions(turn.round, picks, config, expectedSeat),
        decision,
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
          expectedSeat: expectedUrlSeat,
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
      if (busy || state !== "running") return;
      if (!currentController) {
        const turn = controllerApi.runtime.readOwnedTurn(documentRef);
        if (!turn) return;
        busy = true;
        try {
          await resolveOwnedTurn(turn);
        } catch (error) {
          fail(String(error?.message ?? error));
        } finally {
          busy = false;
        }
        return;
      }

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
          position: positionForConfirmedPick(board, confirmation),
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
        expectedUrlSeat,
        observedTeamCount,
        observedRosterSlots,
        minimumFallbacks,
        materialEdgePoints,
        strategy: config.name === "test_league_19_idp" ? "13_offense_then_seat_rotated_verified_specialists" : "position_leader_dropoff_to_next_turn",
      });
      monitorId = environment.setInterval(advance, pollMs);
      advance();
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
      options.onAlert?.({ state, reason, roomId: room.roomId, seat: expectedSeat });
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
        seat: expectedSeat,
        urlSeat: room.seat,
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
      positionForConfirmedPick,
      overallPick,
      turnWindow,
      survivalBucket,
      scorePositionLeaders,
      buildDecisionLadder,
      validateCompletedRoster,
    },
  };
})(globalThis);
