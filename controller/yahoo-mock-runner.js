(function installYahooMockRunner(root) {
  "use strict";

  const VERSION = "2.1.0";
  const GLOBAL_KEY = "__skrodzkaiYahooMockRunnerV1";
  const RECEIPT_KEY = "skrodzkai-yahoo-mock-runner-receipts-v1";
  const OFFENSE = ["QB", "RB", "WR", "TE"];
  const TEST_SPECIALISTS = ["K", "DEF", "D", "LB", "CB", "S"];
  const FILTER_LABELS = Object.freeze({
    K: "Kickers",
    DEF: "Team Defenses",
    D: "Defensive Players",
    LB: "Linebackers",
    CB: "Defensive Backs",
    S: "Defensive Backs",
  });
  const DECISION_RECOMPUTE_BUDGET_MS = 100;
  const PANEL_BUDGET_MS = 250;
  const TURN_TO_CLICK_BUDGET_MS = 2000;
  const NEXT_TURN_COMPARISON_POOL = 6;
  const BYE_CONCENTRATION_LIMIT = 2;
  const QB2_SURVIVAL_CLIFF = 0.35;
  const NORMALIZED_VALUE_CACHE = new Map();
  const SURVIVAL_BUCKET_CACHE = new WeakMap();

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
      positionLimits: Object.freeze({ QB: 2, RB: 6, WR: 6, TE: 2, K: 1, DEF: 1, D: 4, LB: 4, CB: 4, S: 4 }),
      specialistPositions: Object.freeze(TEST_SPECIALISTS),
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
      offenseStarters: Object.freeze({ QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1 }),
      positionLimits: Object.freeze({ QB: 2, RB: 6, WR: 7, TE: 3, K: 1, DEF: 1, D: 3, LB: 3, CB: 3, S: 3 }),
      qualification: "unverified-real-room",
    }),
  });

  function normalize(value) {
    const raw = String(value ?? "");
    const cached = NORMALIZED_VALUE_CACHE.get(raw);
    if (cached !== undefined) return cached;
    const normalized = raw
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9/]+/g, " ")
      .trim()
      .toUpperCase();
    NORMALIZED_VALUE_CACHE.set(raw, normalized);
    return normalized;
  }

  function normalizedRosterSlotAccepts(eligible, normalizedSlot) {
    if (eligible.includes(normalizedSlot)) return true;
    if (normalizedSlot === "W/R") return eligible.some((position) => ["WR", "RB"].includes(position));
    if (normalizedSlot === "W/R/T") return eligible.some((position) => ["WR", "RB", "TE"].includes(position));
    if (normalizedSlot === "D") return eligible.some((position) => ["D", "DL", "DE", "DT", "LB", "DB", "CB", "S"].includes(position));
    if (normalizedSlot === "DB") return eligible.some((position) => ["DB", "CB", "S"].includes(position));
    if (normalizedSlot === "CB") return eligible.some((position) => ["DB", "CB"].includes(position));
    if (normalizedSlot === "S") return eligible.some((position) => ["DB", "S"].includes(position));
    return normalizedSlot === "BN";
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

  function rosterSlotAccepts(position, slot) {
    const eligible = Array.isArray(position) ? position.map(normalize) : [normalize(position)];
    const normalizedSlot = normalize(slot);
    return normalizedRosterSlotAccepts(eligible, normalizedSlot);
  }

  function allocateRosterSlots(picks, rosterSlots) {
    const roster = Array.from(rosterSlots ?? [], (slot) => ({ slot: normalize(slot), player: null }));
    for (const pick of Array.from(picks ?? [])) {
      const eligible = Array.from(pick.eligible ?? [pick.position], normalize);
      let index = roster.findIndex((entry) => !entry.player && entry.slot !== "BN" && normalizedRosterSlotAccepts(eligible, entry.slot));
      if (index < 0) index = roster.findIndex((entry) => !entry.player && entry.slot === "BN");
      if (index >= 0) roster[index].player = pick;
    }
    return roster;
  }

  function validateObservedTestRoster(observedSlots, picks) {
    const observed = Array.from(observedSlots ?? [], (entry) => ({
      slot: normalize(entry?.slot),
      yahooId: String(entry?.yahooId ?? ""),
      empty: entry?.empty === true,
    }));
    const expectedPicks = Array.from(picks ?? []);
    const pickById = new Map(expectedPicks.map((pick) => [String(pick.yahooId), pick]));
    const occupied = observed.filter((entry) => !entry.empty && entry.yahooId);
    if (occupied.length !== CONFIGS.test_league_19_idp.rosterTotal) return false;
    if (new Set(occupied.map((entry) => entry.yahooId)).size !== occupied.length) return false;
    if (occupied.some((entry) => !pickById.has(entry.yahooId))) return false;
    if (expectedPicks.some((pick) => !occupied.some((entry) => entry.yahooId === String(pick.yahooId)))) return false;

    for (const slot of ["D", "LB", "CB", "S"]) {
      const entry = observed.find((candidate) => candidate.slot === slot);
      const pick = pickById.get(entry?.yahooId ?? "");
      if (!entry || entry.empty || !normalizedRosterSlotAccepts(playerEligibility(pick), slot)) return false;
    }
    const specialistIds = new Set(expectedPicks
      .filter((pick) => ["D", "LB", "CB", "S"].includes(normalize(pick.position)))
      .map((pick) => String(pick.yahooId)));
    return !observed.some((entry) => entry.slot === "BN" && specialistIds.has(entry.yahooId));
  }

  function allowedPositions(round, picks, config = CONFIGS.public_mock_15, seat = 1) {
    void seat;
    if (round < 1 || round > config.rounds) return [];
    const counts = positionCounts(picks);
    return Object.entries(config.positionLimits)
      .filter(([position, limit]) => (counts[position] ?? 0) < limit)
      .map(([position]) => position);
  }

  function filterLabelForRound(round, picks = [], config = CONFIGS.public_mock_15, seat = 1) {
    void round; void picks; void config; void seat;
    return "All Positions";
  }

  function requiredTestFilterLabels() {
    return ["All Positions", ...new Set(TEST_SPECIALISTS.map((position) => FILTER_LABELS[position]))];
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
        rank: Number(player.valueRank ?? player.rank ?? index + 1),
        yahooRank: player.yahooRank == null || player.yahooRank === "" ? null : Number(player.yahooRank),
        projection: player.projection == null || player.projection === "" ? null : Number(player.projection),
        perGamePoints: player.perGamePoints == null || player.perGamePoints === "" ? null : Number(player.perGamePoints),
        expectedGamesThroughWeek17: player.expectedGamesThroughWeek17 == null || player.expectedGamesThroughWeek17 === "" ? null : Number(player.expectedGamesThroughWeek17),
        weeklyPoints: Array.isArray(player.weeklyPoints) ? player.weeklyPoints.map(Number) : null,
        weeklyAvailability: Array.isArray(player.weeklyAvailability) ? player.weeklyAvailability.map(Number) : null,
        outcomeLow: player.outcomeLow == null || player.outcomeLow === "" ? null : Number(player.outcomeLow),
        outcomeHigh: player.outcomeHigh == null || player.outcomeHigh === "" ? null : Number(player.outcomeHigh),
        uncertaintyStatus: String(player.uncertaintyStatus ?? "OUTCOME_INTERVAL_UNAVAILABLE"),
        bye: player.bye == null || player.bye === "" ? null : Number(player.bye),
        replacementPoints: player.replacementPoints == null || player.replacementPoints === "" ? null : Number(player.replacementPoints),
        eligible: [...new Set(Array.from(player.eligible ?? [position], normalize).filter(Boolean))],
        automaticEligible: player.automaticEligible === true,
        manualEligible: player.manualEligible === true,
        validationStatus: String(player.validationStatus ?? "MISSING_VALIDATION_STATUS"),
      };
      if (!copy.yahooId) throw new Error(`board player ${index} requires a verified Yahoo ID`);
      if (!OFFENSE.includes(position) && !["K", "DEF", "D", "LB", "CB", "S"].includes(position)) {
        throw new Error(`board player ${index} has unsupported draft position`);
      }
      if (!Number.isFinite(copy.rank)) throw new Error(`board player ${index} has invalid rank`);
      if (!Number.isFinite(copy.projection) && (copy.automaticEligible || copy.manualEligible)) {
        throw new Error(`board player ${index} has invalid league projection`);
      }
      if (copy.weeklyPoints && (copy.weeklyPoints.length !== 17 || copy.weeklyPoints.some((value) => !Number.isFinite(value) || value < 0))) {
        throw new Error(`board player ${index} has invalid weekly projection`);
      }
      if (copy.weeklyAvailability && (copy.weeklyAvailability.length !== 17 || copy.weeklyAvailability.some((value) => !Number.isFinite(value) || value < 0 || value > 1))) {
        throw new Error(`board player ${index} has invalid weekly availability`);
      }
      if (copy.bye !== null && (!Number.isInteger(copy.bye) || copy.bye < 1 || copy.bye > 17)) {
        throw new Error(`board player ${index} has invalid bye week`);
      }
      if (!copy.eligible.length) throw new Error(`board player ${index} requires Yahoo eligibility`);
      const vor = Number(player.vor);
      copy.vor = Number.isFinite(vor)
        ? vor
        : Number.isFinite(copy.replacementPoints)
          ? copy.projection - copy.replacementPoints
          : 0;
      const firstEndpoint = player.adpLow ?? player.adp_low;
      const secondEndpoint = player.adpHigh ?? player.adp_high;
      if (firstEndpoint !== null && firstEndpoint !== "" && secondEndpoint !== null && secondEndpoint !== "" &&
          Number.isFinite(Number(firstEndpoint)) && Number.isFinite(Number(secondEndpoint))) {
        copy.adpEarliest = Math.min(firstEndpoint, secondEndpoint);
        copy.adpLatest = Math.max(firstEndpoint, secondEndpoint);
        copy.marketMean = (copy.adpEarliest + copy.adpLatest) / 2;
        copy.marketStatus = "OBSERVED_RANGE_UNCALIBRATED";
      } else if (Number.isFinite(copy.yahooRank)) {
        copy.adpEarliest = null;
        copy.adpLatest = null;
        copy.marketMean = copy.yahooRank;
        copy.marketStatus = "YAHOO_PRESEASON_RANK_UNCALIBRATED";
      } else {
        copy.adpEarliest = null;
        copy.adpLatest = null;
        copy.marketMean = copy.rank;
        copy.marketStatus = "BOARD_RANK_FALLBACK_UNCALIBRATED";
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

  function playerEligibility(player) {
    const source = player?.eligible ?? [player?.position];
    if (Array.isArray(source) && source.length && source.every((position, index) =>
      Boolean(position) && typeof position === "string" && NORMALIZED_VALUE_CACHE.get(position) === position && source.indexOf(position) === index
    )) return source;
    return [...new Set(Array.from(source, normalize).filter(Boolean))];
  }

  function starterSlots(config) {
    return Array.from(config?.rosterSlots ?? [], normalize).filter((slot) => !["BN", "IR"].includes(slot));
  }

  function baselineForSlot(slot, replacementBySlot = {}) {
    const direct = Number(replacementBySlot?.[slot]);
    if (Number.isFinite(direct)) return direct;
    const accepted = Object.entries(replacementBySlot ?? {})
      .filter(([position, value]) => Number.isFinite(Number(value)) && rosterSlotAccepts([position], slot))
      .map(([, value]) => Number(value));
    return accepted.length ? Math.max(...accepted) : 0;
  }

  function maximumAssignment(picks, slots, edgeValue) {
    const players = Array.from(picks ?? []).filter((player) => playerEligibility(player).length);
    const source = 0;
    const playerStart = 1;
    const slotStart = playerStart + players.length;
    const sink = slotStart + slots.length;
    const graph = Array.from({ length: sink + 1 }, () => []);
    const addEdge = (from, to, capacity, cost) => {
      const forward = { to, capacity, cost, reverse: graph[to].length };
      const reverse = { to: from, capacity: 0, cost: -cost, reverse: graph[from].length };
      graph[from].push(forward);
      graph[to].push(reverse);
    };
    for (let playerIndex = 0; playerIndex < players.length; playerIndex += 1) {
      addEdge(source, playerStart + playerIndex, 1, 0);
      const eligible = playerEligibility(players[playerIndex]);
      for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
        if (!normalizedRosterSlotAccepts(eligible, slots[slotIndex])) continue;
        const value = Number(edgeValue(players[playerIndex], slots[slotIndex]));
        if (Number.isFinite(value) && value > 0) addEdge(playerStart + playerIndex, slotStart + slotIndex, 1, -value);
      }
    }
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) addEdge(slotStart + slotIndex, sink, 1, 0);

    let totalCost = 0;
    let count = 0;
    while (true) {
      const distance = new Float64Array(graph.length);
      distance.fill(Number.POSITIVE_INFINITY);
      distance[source] = 0;
      const previousNode = new Int32Array(graph.length).fill(-1);
      const previousEdge = new Int32Array(graph.length).fill(-1);
      const queued = new Uint8Array(graph.length);
      const queue = [source];
      queued[source] = 1;
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const node = queue[cursor];
        queued[node] = 0;
        for (let edgeIndex = 0; edgeIndex < graph[node].length; edgeIndex += 1) {
          const edge = graph[node][edgeIndex];
          if (edge.capacity <= 0 || distance[node] + edge.cost >= distance[edge.to] - 1e-9) continue;
          distance[edge.to] = distance[node] + edge.cost;
          previousNode[edge.to] = node;
          previousEdge[edge.to] = edgeIndex;
          if (!queued[edge.to]) {
            queued[edge.to] = 1;
            queue.push(edge.to);
          }
        }
      }
      if (!Number.isFinite(distance[sink]) || distance[sink] >= -1e-9) break;
      for (let node = sink; node !== source; node = previousNode[node]) {
        const edge = graph[previousNode[node]][previousEdge[node]];
        edge.capacity -= 1;
        graph[node][edge.reverse].capacity += 1;
      }
      totalCost += distance[sink];
      count += 1;
    }
    return { count, value: -totalCost };
  }

  function assignmentExclusionProfile(picks, slots, edgeValue) {
    const players = Array.from(picks ?? []);
    const parent = slots.map((_, index) => index);
    const find = (index) => {
      let root = index;
      while (parent[root] !== root) root = parent[root];
      while (parent[index] !== index) {
        const next = parent[index];
        parent[index] = root;
        index = next;
      }
      return root;
    };
    const union = (left, right) => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
    };
    for (const player of players) {
      const eligible = playerEligibility(player);
      const accepted = slots.map((slot, index) => normalizedRosterSlotAccepts(eligible, slot) ? index : -1).filter((index) => index >= 0);
      for (let index = 1; index < accepted.length; index += 1) union(accepted[0], accepted[index]);
    }
    const slotsByRoot = new Map();
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
      const root = find(slotIndex);
      if (!slotsByRoot.has(root)) slotsByRoot.set(root, []);
      slotsByRoot.get(root).push(slotIndex);
    }
    const components = [...slotsByRoot.values()].map((slotIndices) => {
      const localIndex = new Map(slotIndices.map((slotIndex, index) => [slotIndex, index]));
      const stateCount = 1 << slotIndices.length;
      let values = new Float64Array(stateCount);
      values.fill(Number.NEGATIVE_INFINITY);
      values[0] = 0;
      for (const player of players) {
        const eligible = playerEligibility(player);
        const edges = slotIndices.flatMap((slotIndex) => {
          if (!normalizedRosterSlotAccepts(eligible, slots[slotIndex])) return [];
          const value = Number(edgeValue(player, slots[slotIndex]));
          return Number.isFinite(value) && value > 0 ? [[1 << localIndex.get(slotIndex), value]] : [];
        });
        if (!edges.length) continue;
        const next = values.slice();
        for (let mask = 0; mask < stateCount; mask += 1) {
          const current = values[mask];
          if (!Number.isFinite(current)) continue;
          for (const [bit, value] of edges) {
            if (mask & bit) continue;
            const target = mask | bit;
            next[target] = Math.max(next[target], current + value);
          }
        }
        values = next;
      }
      const bestSubset = values.slice();
      for (let slotIndex = 0; slotIndex < slotIndices.length; slotIndex += 1) {
        const bit = 1 << slotIndex;
        for (let mask = 0; mask < stateCount; mask += 1) {
          if (mask & bit) bestSubset[mask] = Math.max(bestSubset[mask], bestSubset[mask ^ bit]);
        }
      }
      const fullMask = stateCount - 1;
      return { slotIndices, localIndex, bestSubset, fullMask, baseUtility: bestSubset[fullMask] };
    });
    const componentBySlot = new Map(components.flatMap((component) => component.slotIndices.map((slotIndex) => [slotIndex, component])));
    const baseUtility = components.reduce((sum, component) => sum + component.baseUtility, 0);
    const without = (slotIndices) => {
      const excludedByComponent = new Map();
      for (const slotIndex of slotIndices) {
        const component = componentBySlot.get(slotIndex);
        const localBit = 1 << component.localIndex.get(slotIndex);
        excludedByComponent.set(component, (excludedByComponent.get(component) ?? 0) | localBit);
      }
      let value = baseUtility;
      for (const [component, excluded] of excludedByComponent) {
        value += component.bestSubset[component.fullMask ^ excluded] - component.baseUtility;
      }
      return value;
    };
    return {
      baseUtility,
      utilityWithoutSlot: slots.map((_, slotIndex) => without([slotIndex])),
      utilityWithoutPair(left, right) {
        return without([left, right]);
      },
    };
  }

  function optimalRosterUtility(picks, config, replacementBySlot = {}) {
    const slots = starterSlots(config);
    const weekly = Array.from(picks ?? []).length > 0 && Array.from(picks ?? []).every((player) => Array.isArray(player.weeklyPoints) && player.weeklyPoints.length === 17);
    if (weekly) {
      return Array.from({ length: 17 }, (_, weekIndex) => maximumAssignment(picks, slots, (player, slot) => {
        const projection = Number(player.weeklyPoints[weekIndex]);
        return Number.isFinite(projection) ? Math.max(0, projection - baselineForSlot(slot, replacementBySlot) / 17) : 0;
      }).value).reduce((sum, value) => sum + value, 0);
    }
    return maximumAssignment(picks, slots, (player, slot) => {
      const projection = Number(player.projection);
      return Number.isFinite(projection) ? Math.max(0, projection - baselineForSlot(slot, replacementBySlot)) : 0;
    }).value;
  }

  function maximumFilledStarterSlots(picks, config) {
    const slots = starterSlots(config);
    return maximumAssignment(picks, slots, () => 1).count;
  }

  function rosterIdentityKey(player) {
    const name = normalize(player?.name);
    const team = normalize(player?.team);
    return name && team ? `${name}:${team}` : null;
  }

  function sameRosterIdentity(left, right) {
    const leftKey = rosterIdentityKey(left);
    return Boolean(leftKey && leftKey === rosterIdentityKey(right));
  }

  function alreadyRostered(player, picks) {
    return Array.from(picks ?? []).some((pick) => sameRosterIdentity(player, pick));
  }

  function withinPositionLimit(player, picks, config) {
    const counts = positionCounts(picks);
    const position = normalize(player.position);
    const limit = config.positionLimits[position];
    if (limit == null || (counts[position] ?? 0) >= limit) return false;
    const category = position === "K" ? "K" : position === "DEF" ? "DEF" : ["D", "LB", "CB", "S"].includes(position) ? "IDP" : null;
    if (!category) return true;
    const categorySlots = starterSlots(config).filter((slot) => category === "IDP"
      ? ["D", "DB", "LB", "CB", "S"].includes(slot)
      : slot === category
    );
    const categoryPicks = Array.from(picks ?? []).filter((pick) => {
      const drafted = normalize(pick.position);
      return category === "IDP" ? ["D", "LB", "CB", "S"].includes(drafted) : drafted === category;
    });
    const before = maximumAssignment(categoryPicks, categorySlots, () => 1).count;
    const after = maximumAssignment([...categoryPicks, player], categorySlots, () => 1).count;
    return after === before + 1;
  }

  function canCompleteRoster({ player, picks, config }) {
    if (!withinPositionLimit(player, picks, config)) return false;
    if (alreadyRostered(player, picks)) return false;
    const after = [...Array.from(picks ?? []), player];
    if (after.length > config.rounds) return false;
    const starters = starterSlots(config).length;
    const filled = maximumFilledStarterSlots(after, config);
    const picksRemaining = config.rounds - after.length;
    return starters - filled <= picksRemaining;
  }

  function survivalProbability(player, nextPick, runPressure = 0, survivalCalibration = null) {
    if (!Number.isFinite(nextPick)) return 0;
    const packet = survivalCalibration?.model ? survivalCalibration : null;
    if (packet?.calibration?.enabled && packet.model?.global?.values?.length) {
      const model = packet.model;
      const positionBucket = model.positions?.[normalize(player.position)];
      const bucket = packet.calibration.positionLayerEnabled === true && positionBucket?.sampleCount >= Number(model.minimumPositionSamples ?? 30)
        ? positionBucket
        : model.global;
      const pressure = Math.max(-2, Math.min(2, Number(runPressure) || 0));
      const threshold = Number(nextPick) - Number(player.marketMean ?? player.rank) + pressure * Number(bucket.scale ?? 3) * 0.25;
      let index = SURVIVAL_BUCKET_CACHE.get(bucket);
      if (!index) {
        const residuals = Float64Array.from(bucket.values, (row) => Number(row.residual));
        const suffixWeights = new Float64Array(bucket.values.length + 1);
        for (let cursor = bucket.values.length - 1; cursor >= 0; cursor -= 1) {
          suffixWeights[cursor] = suffixWeights[cursor + 1] + Number(bucket.values[cursor].weight);
        }
        index = { residuals, suffixWeights };
        SURVIVAL_BUCKET_CACHE.set(bucket, index);
      }
      let low = 0;
      let high = index.residuals.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (index.residuals[middle] < threshold) low = middle + 1;
        else high = middle;
      }
      const survivedWeight = index.suffixWeights[low];
      const totalWeight = index.suffixWeights[0];
      return Math.max(0.01, Math.min(0.99, (survivedWeight + 1) / (totalWeight + 2)));
    }
    const observedRange = Number.isFinite(player.adpEarliest) && Number.isFinite(player.adpLatest);
    const mean = observedRange ? (player.adpEarliest + player.adpLatest) / 2 : player.marketMean ?? player.rank;
    const spread = observedRange
      ? Math.max(3, (player.adpLatest - player.adpEarliest) / 3.29)
      : Math.max(6, mean * 0.12);
    const adjustedMean = mean - Math.max(-2, Math.min(2, Number(runPressure) || 0)) * spread * 0.5;
    return Math.max(0.01, Math.min(0.99, 1 / (1 + Math.exp((nextPick - adjustedMean) / spread))));
  }

  function runPressureFromAvailability(previousPlayers, currentPlayers, ownPicks = []) {
    const currentIds = new Set(Array.from(currentPlayers ?? [], (player) => String(player?.yahooId ?? "")));
    const ownIds = new Set(Array.from(ownPicks ?? [], (player) => String(player?.yahooId ?? "")));
    const counts = {};
    for (const player of previousPlayers ?? []) {
      const yahooId = String(player?.yahooId ?? "");
      if (!yahooId || currentIds.has(yahooId) || ownIds.has(yahooId)) continue;
      const position = normalize(player.position);
      if (!position) continue;
      counts[position] = (counts[position] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).map(([position, count]) => [
      position,
      Math.min(2, Math.max(0, (count - 1) / 2)),
    ]));
  }

  function compactPlayer(player) {
    if (!player) return null;
    return {
      yahooId: player.yahooId,
      name: player.name,
      position: player.position,
      team: player.team,
      rank: player.rank,
      vor: player.vor,
      projection: player.projection,
      expectedGamesThroughWeek17: player.expectedGamesThroughWeek17,
      uncertaintyStatus: player.uncertaintyStatus,
      eligible: player.eligible,
      adpEarliest: player.adpEarliest,
      adpLatest: player.adpLatest,
      yahooRank: player.yahooRank,
      marketMean: player.marketMean,
      marketStatus: player.marketStatus,
      bye: player.bye,
    };
  }

  function scoreCandidates({ round, seat, picks, pool, config, replacementBySlot, runPressureByPosition = {}, survivalCalibration = null }) {
    const startedAt = Date.now();
    const window = turnWindow(round, seat, config.teams, config.rounds);
    const slots = starterSlots(config);
    const weeklyMode = pool.length > 0 && pool.every((player) => Array.isArray(player.weeklyPoints) && player.weeklyPoints.length === 17) &&
      Array.from(picks ?? []).every((player) => Array.isArray(player.weeklyPoints) && player.weeklyPoints.length === 17);
    const periods = weeklyMode ? Array.from({ length: 17 }, (_, index) => index) : [null];
    const groupedPeriods = new Map();
    for (const period of periods) {
      const signature = period == null
        ? "SEASON"
        : JSON.stringify(Array.from(picks ?? [], (player) => player.weeklyPoints[period]));
      if (!groupedPeriods.has(signature)) groupedPeriods.set(signature, []);
      groupedPeriods.get(signature).push(period);
    }
    const periodContexts = [...groupedPeriods.values()].map((contextPeriods) => {
      const representativePeriod = contextPeriods[0];
      const valueForProjection = (projection, slot) => {
        const baseline = baselineForSlot(slot, replacementBySlot) / (representativePeriod == null ? 1 : 17);
        return Number.isFinite(projection) ? Math.max(0, projection - baseline) : 0;
      };
      const valueForSlot = (player, slot) => {
        const projection = Number(representativePeriod == null ? player.projection : player.weeklyPoints[representativePeriod]);
        return valueForProjection(projection, slot);
      };
      const profile = assignmentExclusionProfile(picks, slots, valueForSlot);
      return {
        periods: contextPeriods,
        valueForProjection,
        baseUtility: profile.baseUtility,
        utilityWithoutSlot: profile.utilityWithoutSlot,
        utilityWithoutPair: profile.utilityWithoutPair,
      };
    });
    const baseUtility = periodContexts.reduce((sum, context) => sum + context.baseUtility * context.periods.length, 0);
    const baseFilled = maximumFilledStarterSlots(picks, config);
    const filledWithoutSlot = slots.map((_, excludedIndex) =>
      maximumAssignment(picks, slots.filter((__, index) => index !== excludedIndex), () => 1).count
    );
    const remainingAfterCandidate = config.rounds - Array.from(picks ?? []).length - 1;
    const assignmentWithOne = (player, excludedValues, baseline) => {
      const eligible = playerEligibility(player);
      let result = baseline;
      for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
        if (normalizedRosterSlotAccepts(eligible, slots[slotIndex])) {
          result = Math.max(result, excludedValues[slotIndex] + 1);
        }
      }
      return result;
    };
    const entries = pool
      .filter((player) => player.automaticEligible !== false)
      .filter((player) => withinPositionLimit(player, picks, config))
      .filter((player) => slots.length - assignmentWithOne(player, filledWithoutSlot, baseFilled) <= remainingAfterCandidate)
      .map((player) => {
        const eligible = playerEligibility(player);
        const slotIndexes = slots.map((slot, index) => normalizedRosterSlotAccepts(eligible, slot) ? index : -1).filter((index) => index >= 0);
        const contextValueGroups = periodContexts.map((context) => {
          const byProjection = new Map();
          for (const period of context.periods) {
            const projection = Number(period == null ? player.projection : player.weeklyPoints[period]);
            const key = String(projection);
            let group = byProjection.get(key);
            if (!group) {
              group = {
                projection,
                count: 0,
                slotValues: slotIndexes.map((slotIndex) => context.valueForProjection(projection, slots[slotIndex])),
              };
              byProjection.set(key, group);
            }
            group.count += 1;
          }
          return { groups: [...byProjection.values()], byProjection };
        });
        const withCandidate = periodContexts.reduce((total, context, contextIndex) => {
          for (const group of contextValueGroups[contextIndex].groups) {
            let periodUtility = context.baseUtility;
            for (let eligibleIndex = 0; eligibleIndex < slotIndexes.length; eligibleIndex += 1) {
              const slotIndex = slotIndexes[eligibleIndex];
              periodUtility = Math.max(periodUtility, context.utilityWithoutSlot[slotIndex] + group.slotValues[eligibleIndex]);
            }
            total += periodUtility * group.count;
          }
          return total;
        }, 0);
        const marginalUtility = Math.max(0, withCandidate - baseUtility);
        const pressure = Math.max(...playerEligibility(player).map((position) => Number(runPressureByPosition[position] ?? 0)));
        return {
          player,
          marginalUtility,
          utilityAfter: withCandidate,
          slotIndexes,
          contextValueGroups,
          pAvailableNext: survivalProbability(player, window.nextPick, pressure, survivalCalibration),
          survivalStatus: survivalCalibration?.calibration?.enabled
            ? survivalCalibration.calibration.positionLayerEnabled
              ? "HELD_OUT_CALIBRATED_POSITION_RESIDUAL"
              : "HELD_OUT_CALIBRATED_ROOM_RESIDUAL"
            : player.marketStatus,
        };
      });
    const nextCandidates = entries
      .slice()
      .sort((left, right) => right.marginalUtility - left.marginalUtility || left.player.rank - right.player.rank)
      .slice(0, NEXT_TURN_COMPARISON_POOL);
    const filledWithoutPair = new Map();
    if (Number.isFinite(window.nextPick) && round + 1 >= config.rounds) {
      for (let left = 0; left < slots.length; left += 1) {
        for (let right = left + 1; right < slots.length; right += 1) {
          const remainingSlots = slots.filter((_, index) => index !== left && index !== right);
          const key = `${left}:${right}`;
          filledWithoutPair.set(key, maximumAssignment(picks, remainingSlots, () => 1).count);
        }
      }
    }
    const assignmentWithPair = (leftPlayer, rightPlayer, excludedValues, baseline) => {
      let result = baseline;
      const leftEligible = playerEligibility(leftPlayer);
      const rightEligible = playerEligibility(rightPlayer);
      for (let left = 0; left < slots.length; left += 1) {
        if (!normalizedRosterSlotAccepts(leftEligible, slots[left])) continue;
        for (let right = 0; right < slots.length; right += 1) {
          if (left === right || !normalizedRosterSlotAccepts(rightEligible, slots[right])) continue;
          const key = left < right ? `${left}:${right}` : `${right}:${left}`;
          result = Math.max(result, excludedValues.get(key) + 2);
        }
      }
      return result;
    };
    const utilityWithPair = (leftEntry, rightEntry) => {
      return periodContexts.reduce((total, context, contextIndex) => {
        const combinations = new Map();
        for (const period of context.periods) {
          const leftProjection = Number(period == null ? leftEntry.player.projection : leftEntry.player.weeklyPoints[period]);
          const rightProjection = Number(period == null ? rightEntry.player.projection : rightEntry.player.weeklyPoints[period]);
          const key = `${leftProjection}:${rightProjection}`;
          let combination = combinations.get(key);
          if (!combination) {
            combination = {
              count: 0,
              leftValues: leftEntry.contextValueGroups[contextIndex].byProjection.get(String(leftProjection)).slotValues,
              rightValues: rightEntry.contextValueGroups[contextIndex].byProjection.get(String(rightProjection)).slotValues,
            };
            combinations.set(key, combination);
          }
          combination.count += 1;
        }
        for (const combination of combinations.values()) {
          let periodUtility = context.baseUtility;
          for (let leftIndex = 0; leftIndex < leftEntry.slotIndexes.length; leftIndex += 1) {
            const left = leftEntry.slotIndexes[leftIndex];
            periodUtility = Math.max(periodUtility, context.utilityWithoutSlot[left] + combination.leftValues[leftIndex]);
            for (let rightIndex = 0; rightIndex < rightEntry.slotIndexes.length; rightIndex += 1) {
              const right = rightEntry.slotIndexes[rightIndex];
              if (left === right) continue;
              periodUtility = Math.max(periodUtility, context.utilityWithoutPair(left, right) + combination.leftValues[leftIndex] + combination.rightValues[rightIndex]);
            }
          }
          for (let rightIndex = 0; rightIndex < rightEntry.slotIndexes.length; rightIndex += 1) {
            const right = rightEntry.slotIndexes[rightIndex];
            periodUtility = Math.max(periodUtility, context.utilityWithoutSlot[right] + combination.rightValues[rightIndex]);
          }
          total += periodUtility * combination.count;
        }
        return total;
      }, 0);
    };
    const remainingAfterPair = config.rounds - Array.from(picks ?? []).length - 2;
    for (const entry of entries) {
      const alternatives = !Number.isFinite(window.nextPick) ? [] : nextCandidates
        .filter((candidate) => candidate !== entry)
        .filter((candidate) => withinPositionLimit(candidate.player, [...picks, entry.player], config))
        .filter((candidate) => round + 1 < config.rounds || slots.length - assignmentWithPair(entry.player, candidate.player, filledWithoutPair, Math.max(
          assignmentWithOne(entry.player, filledWithoutSlot, baseFilled),
          assignmentWithOne(candidate.player, filledWithoutSlot, baseFilled),
        )) <= remainingAfterPair)
        .map((candidate) => ({
          ...candidate,
          marginalAfterEntry: Math.max(0, utilityWithPair(entry, candidate) - entry.utilityAfter),
        }))
        .sort((left, right) => right.marginalAfterEntry - left.marginalAfterEntry || left.player.rank - right.player.rank);
      let noneBetter = 1;
      let expectedNextUtility = 0;
      for (const candidate of alternatives) {
        expectedNextUtility += noneBetter * candidate.pAvailableNext * candidate.marginalAfterEntry;
        noneBetter *= 1 - candidate.pAvailableNext;
      }
      entry.expectedNextUtility = Number.isFinite(window.nextPick) ? expectedNextUtility : 0;
      entry.costOfWaiting = Math.max(0, entry.marginalUtility - expectedNextUtility);
      entry.decisionScore = entry.marginalUtility + entry.expectedNextUtility;
    }
    const ranked = entries.sort((left, right) =>
      right.decisionScore - left.decisionScore ||
      right.marginalUtility - left.marginalUtility ||
      left.player.rank - right.player.rank
    );
    if (!ranked.length) throw new Error("no_legal_bpa_candidates");
    return { window, ranked, recomputeMs: Date.now() - startedAt, utilityModel: weeklyMode ? "WEEKLY_OPTIMAL_LINEUP_W1_17" : "SEASON_TOTAL_FALLBACK" };
  }

  function summarizeDecision(scored, selected, picks, fallbackUsed = false) {
    const chosen = selected[0];
    const quarterbacks = Array.from(picks ?? []).filter((pick) => normalize(pick.position) === "QB");
    const qbCandidate = selected.find((entry) => normalize(entry.player.position) === "QB") ?? null;
    let qb2 = { recommendation: "NO", reason: "starting quarterback not yet rostered" };
    if (quarterbacks.length >= 2) {
      qb2 = { recommendation: "NO", reason: "two quarterbacks are already rostered" };
    } else if (quarterbacks.length === 1 && qbCandidate) {
      const sameBye = quarterbacks[0].bye != null && qbCandidate.player.bye != null && Number(quarterbacks[0].bye) === Number(qbCandidate.player.bye);
      if (sameBye) qb2 = { recommendation: "NO", reason: `weekly-utility conflict: both quarterbacks have Week ${qbCandidate.player.bye} byes` };
      else if (qbCandidate.pAvailableNext <= QB2_SURVIVAL_CLIFF) qb2 = { recommendation: "YES", reason: `remaining-QB cliff: ${Math.round(qbCandidate.pAvailableNext * 100)}% next-turn survival` };
      else qb2 = { recommendation: "NO", reason: `not yet: ${Math.round(qbCandidate.pAvailableNext * 100)}% next-turn survival` };
    } else if (quarterbacks.length === 1) {
      qb2 = { recommendation: "NO", reason: "not yet: no quarterback is inside the current decision ladder" };
    }
    const byeCounts = [...Array.from(picks ?? []), chosen.player].reduce((counts, player) => {
      if (Number.isInteger(player.bye)) counts[player.bye] = (counts[player.bye] ?? 0) + 1;
      return counts;
    }, {});
    const concentratedBye = Object.entries(byeCounts)
      .filter(([, count]) => count > BYE_CONCENTRATION_LIMIT)
      .sort((left, right) => right[1] - left[1] || Number(left[0]) - Number(right[0]))[0] ?? null;
    return {
      currentPick: scored.window.currentPick,
      nextPick: scored.window.nextPick,
      interveningOpponentPicks: scored.window.interveningOpponentPicks,
      policy: "JOINT_BPA_ONE_TURN_VONA",
      utilityModel: scored.utilityModel,
      recomputeMs: scored.recomputeMs,
      fallbackUsed,
      latencyBudgetMs: DECISION_RECOMPUTE_BUDGET_MS,
      positionLeaders: selected.map((entry) => ({
        player: compactPlayer(entry.player),
        comparator: null,
        bucket: "probability_weighted_next_turn",
        rawScore: entry.marginalUtility,
        adjustedScore: entry.decisionScore,
        marginalUtility: entry.marginalUtility,
        expectedNextUtility: entry.expectedNextUtility,
        costOfWaiting: entry.costOfWaiting,
        pAvailableNext: entry.pAvailableNext,
        survivalStatus: entry.survivalStatus,
        valueReason: `league-scored BPA ${entry.marginalUtility.toFixed(1)} + next-turn option ${entry.expectedNextUtility.toFixed(1)}; wait cost ${entry.costOfWaiting.toFixed(1)}; market ${Number.isFinite(entry.player.yahooRank) ? `Y!${entry.player.yahooRank}` : entry.player.marketStatus}`,
        eligible: true,
      })),
      qb2,
      byeConcentration: concentratedBye
        ? { warning: true, week: Number(concentratedBye[0]), count: Number(concentratedBye[1]), limit: BYE_CONCENTRATION_LIMIT, reason: `Week ${concentratedBye[0]} would contain ${concentratedBye[1]} rostered players` }
        : { warning: false, week: null, count: 0, limit: BYE_CONCENTRATION_LIMIT, reason: "bye concentration remains within limit" },
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
    config = CONFIGS.public_mock_15,
    replacementBySlot = {},
    runPressureByPosition = {},
    survivalCalibration = null,
    recomputeBudgetMs = DECISION_RECOMPUTE_BUDGET_MS,
  }) {
    const requiredMinimum = round === config.rounds ? 1 : minimum;
    const used = new Set(Array.from(picks ?? [], boardKey));
    const usedIdentities = new Set(Array.from(picks ?? [], rosterIdentityKey).filter(Boolean));
    const availableById = new Map(
      Array.from(availablePlayers ?? [], (player) => [String(player.yahooId), player]),
    );
    let pool = board
      .filter((player) => !used.has(boardKey(player)))
      .filter((player) => !usedIdentities.has(rosterIdentityKey(player)))
      .filter((player) => availableById.has(player.yahooId));
    if (pool.length < requiredMinimum) {
      throw new Error(`fewer_than_${requiredMinimum}_eligible_targets`);
    }

    const scored = scoreCandidates({ round, seat, picks, pool, config, replacementBySlot, runPressureByPosition, survivalCalibration });
    const fallbackUsed = scored.recomputeMs > recomputeBudgetMs;
    const selected = (fallbackUsed
      ? scored.ranked.slice().sort((left, right) => left.player.rank - right.player.rank)
      : scored.ranked
    ).slice(0, minimum);
    if (selected.length < requiredMinimum) throw new Error(`fewer_than_${requiredMinimum}_legal_bpa_targets`);

    const targets = selected.map(({ player }) => ({
      yahooId: player.yahooId,
      name: availableById.get(player.yahooId).name,
      position: player.position,
      team: availableById.get(player.yahooId).team,
      eligible: player.eligible,
      projection: player.projection,
      perGamePoints: player.perGamePoints,
      expectedGamesThroughWeek17: player.expectedGamesThroughWeek17,
      weeklyPoints: player.weeklyPoints,
      weeklyAvailability: player.weeklyAvailability,
      outcomeLow: player.outcomeLow,
      outcomeHigh: player.outcomeHigh,
      uncertaintyStatus: player.uncertaintyStatus,
      bye: player.bye,
    }));
    const decision = summarizeDecision(scored, selected, picks, fallbackUsed);
    decision.targetYahooIds = targets.map((target) => target.yahooId);
    return { targets, decision };
  }

  function applyManualOverride({
    stage,
    roomId,
    seat,
    round,
    board,
    availablePlayers,
    baselineTargets,
    allowed,
    minimum = 5,
    picks = [],
    config = CONFIGS.public_mock_15,
  }) {
    const requiredMinimum = round === config.rounds ? 1 : minimum;
    const baseline = Array.from(baselineTargets ?? []);
    const untouched = (status = "none", reason = null) => ({
      targets: baseline,
      manualOverride: { status, reason, consume: Boolean(stage), expectedRound: Number(stage?.expectedRound) || null, targetYahooIds: [] },
    });
    if (!stage) return untouched();
    if (String(stage.roomId ?? "") !== String(roomId) || Number(stage.seat) !== Number(seat)) {
      return untouched("rejected", "manual_pin_room_or_seat_mismatch");
    }
    if (Number(stage.expectedRound) !== Number(round)) {
      return untouched("rejected", "manual_pin_round_mismatch");
    }

    void allowed;
    const boardById = new Map(Array.from(board ?? [], (player) => [String(player.yahooId), player]));
    const availableById = new Map(Array.from(availablePlayers ?? [], (player) => [String(player.yahooId), player]));
    const stagedIds = Array.from(stage.targets ?? [], (target) => String(target?.yahooId ?? "")).filter(Boolean);
    const chosenId = stagedIds.find((yahooId) => {
      const player = boardById.get(yahooId);
      return player && player.manualEligible !== false && availableById.has(yahooId) && canCompleteRoster({ player, picks, config });
    });
    if (!chosenId) return untouched("rejected", "manual_pin_unavailable_or_ineligible");

    const boardPlayer = boardById.get(chosenId);
    const livePlayer = availableById.get(chosenId);
    const pinned = {
      yahooId: chosenId,
      name: String(livePlayer.name ?? boardPlayer.name ?? ""),
      position: boardPlayer.position,
      team: String(livePlayer.team ?? boardPlayer.team ?? ""),
      eligible: boardPlayer.eligible,
      projection: boardPlayer.projection,
    };
    const targets = [pinned, ...baseline.filter((target) => String(target.yahooId) !== chosenId)];
    if (targets.length < requiredMinimum) throw new Error(`fewer_than_${requiredMinimum}_targets_after_manual_pin`);
    return {
      targets,
      manualOverride: {
        status: "applied",
        reason: null,
        consume: true,
        expectedRound: Number(stage.expectedRound),
        chosenYahooId: chosenId,
        targetYahooIds: stagedIds,
      },
    };
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
      maximumFilledStarterSlots(picks, config) === starterSlots(config).length &&
      Object.entries(config.positionLimits).every(([position, limit]) => (counts[position] ?? 0) <= limit)
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
    const selectionHoldMs = Number(options.selectionHoldMs ?? 1200);
    const replacementBySlot = options.replacementBySlot ?? {};
    const configuredRunPressure = options.runPressureByPosition ?? {};
    const survivalCalibration = options.survivalCalibration ?? null;
    const board = validateBoard(options.board);
    const readManualOverride = typeof options.readManualOverride === "function" ? options.readManualOverride : () => null;
    const consumeManualOverride = typeof options.consumeManualOverride === "function" ? options.consumeManualOverride : () => {};
    if (!expectedRoomId || !Number.isInteger(expectedSeat) || expectedSeat < 1 || expectedSeat > config.teams) {
      throw new Error("expected room and seat are required");
    }
    if (!Number.isInteger(expectedUrlSeat) || expectedUrlSeat < 1) throw new Error("expected URL seat is required");
    if (config.leagueId && expectedRoomId !== config.leagueId) throw new Error("test league ID does not match verified configuration");
    if (config.urlTeamId && expectedUrlSeat !== config.urlTeamId) throw new Error("test team ID does not match verified configuration");
    if (observedTeamCount !== config.teams) throw new Error("draft room must contain exactly 12 teams");
    if (!sameSlots(observedRosterSlots, config.rosterSlots)) throw new Error(`draft roster shape does not match ${config.name}`);
    if (!Number.isInteger(minimumFallbacks) || minimumFallbacks < 5) throw new Error("minimumFallbacks must be at least 5");
    if (pollMs < 25 || filterDeadlineMs <= 0 || selectionHoldMs < 0 || selectionHoldMs > 1500) {
      throw new Error("invalid runner timing configuration");
    }
    if (!replacementBySlot || typeof replacementBySlot !== "object" || !Object.keys(replacementBySlot).length) {
      throw new Error("joint replacement baselines are required");
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
    let pendingDecision = null;
    let activeTurnMetrics = null;
    let previousAvailablePlayers = board.slice();

    function liveRunPressure(availablePlayers) {
      const observed = runPressureFromAvailability(previousAvailablePlayers, availablePlayers, picks);
      return Object.fromEntries([...new Set([...Object.keys(configuredRunPressure), ...Object.keys(observed)])]
        .map((position) => [position, Math.max(Number(configuredRunPressure[position] ?? 0), Number(observed[position] ?? 0))]));
    }

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
          const runPressureByPosition = liveRunPressure(availablePlayers);
          const baseline = buildDecisionLadder({
            round: turn.round,
            seat: expectedSeat,
            picks,
            board,
            availablePlayers,
            minimum: minimumFallbacks,
            config,
            replacementBySlot,
            runPressureByPosition,
            survivalCalibration,
          });
          const { targets, manualOverride } = applyManualOverride({
            stage: readManualOverride(),
            roomId: expectedRoomId,
            seat: expectedSeat,
            round: turn.round,
            board,
            availablePlayers,
            baselineTargets: baseline.targets,
            allowed: allowedPositions(turn.round, picks, config, expectedSeat),
            minimum: minimumFallbacks,
            picks,
            config,
          });
          const decision = {
            ...baseline.decision,
            runPressureByPosition,
            baselineChosenYahooId: baseline.decision.chosenYahooId,
            chosenYahooId: targets[0].yahooId,
            targetYahooIds: targets.map((target) => target.yahooId),
            manualOverride: {
              status: manualOverride.status,
              reason: manualOverride.reason,
              chosenYahooId: manualOverride.chosenYahooId ?? null,
            },
          };
          previousAvailablePlayers = availablePlayers.slice();
          return { targets, decision, manualOverride, availablePlayers, filterReadyMs: Date.now() - startedAt };
        } catch (error) {
          if (!/^(fewer_than_|no_legal_bpa_candidates)/.test(String(error?.message ?? error))) throw error;
          lastEligibilityError = String(error.message);
        }
        await delay(25);
      }
      throw new Error(lastEligibilityError ?? `position_filter_timeout:${label}`);
    }

    function startPendingController(chosenYahooId = null, source = "baseline_timeout") {
      if (!pendingDecision || state !== "running") return false;
      const pending = pendingDecision;
      let targets = pending.targets;
      if (chosenYahooId) {
        const chosenId = String(chosenYahooId);
        const boardPlayer = board.find((player) => player.yahooId === chosenId);
        const livePlayer = pending.availablePlayers.find((player) => String(player.yahooId) === chosenId);
        if (!boardPlayer || !livePlayer || boardPlayer.manualEligible === false ||
            !canCompleteRoster({ player: boardPlayer, picks, config })) {
          receipt("runner_on_clock_choice_rejected", { turn: pending.turn.label, chosenYahooId: chosenId, reason: "unavailable_ineligible_or_roster_illegal", baselineRetained: true });
          return false;
        }
        const chosen = {
          yahooId: chosenId,
          name: String(livePlayer.name ?? boardPlayer.name),
          position: boardPlayer.position,
          team: String(livePlayer.team ?? boardPlayer.team),
          eligible: boardPlayer.eligible,
          projection: boardPlayer.projection,
        };
        targets = [chosen, ...targets.filter((target) => String(target.yahooId) !== chosenId)];
        receipt("runner_on_clock_choice_applied", { turn: pending.turn.label, chosenYahooId: chosenId, source, baselineFallbacks: pending.targets.map((target) => target.yahooId) });
      }
      pendingDecision = null;
      const elapsed = Date.now() - pending.detectedAt;
      if (elapsed >= TURN_TO_CLICK_BUDGET_MS) throw new Error("turn_to_click_budget_exhausted");
      const remainingSelectionBudget = TURN_TO_CLICK_BUDGET_MS - elapsed;
      const nextController = controllerApi.create(
        {
          targets,
          pollMs: 25,
          selectionDeadlineMs: remainingSelectionBudget,
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
        activeTurnMetrics = { turn: pending.turn.label, detectedAt: pending.detectedAt, controllerStartedAt: Date.now(), source };
        currentController = nextController.start();
      } catch (error) {
        nextController.stop("start_failed");
        throw error;
      }
      return true;
    }

    function chooseOnClock(yahooId, source = "operator") {
      try {
        return startPendingController(yahooId, source);
      } catch (error) {
        fail(String(error?.message ?? error));
        return false;
      }
    }

    async function resolveOwnedTurn(turn) {
      if (state !== "running") return;
      const detectedAt = Date.now();
      const expectedRound = picks.length + 1;
      const expectedPick = overallPick(expectedRound, expectedSeat, config.teams);
      if (turn.round !== expectedRound || turn.pick !== expectedPick) {
        throw new Error(`owned_turn_mismatch:expected_R${expectedRound}P${expectedPick}:observed_${turn.label}`);
      }
      const filterLabel = filterLabelForRound(turn.round, picks, config, expectedSeat);
      const { targets, decision, manualOverride, availablePlayers, filterReadyMs } = await targetsAfterFilter(turn, filterLabel);
      if (state !== "running") return;
      const panelReadyMs = Date.now() - detectedAt;
      receipt("runner_turn_resolved", {
        turn: turn.label,
        filterLabel,
        filterReadyMs,
        targetCount: targets.length,
        allowedPositions: allowedPositions(turn.round, picks, config, expectedSeat),
        panelReadyMs,
        panelBudgetMs: PANEL_BUDGET_MS,
        decision,
      });
      if (panelReadyMs >= PANEL_BUDGET_MS) throw new Error("panel_ready_budget_exhausted");
      if (manualOverride.consume) consumeManualOverride(manualOverride);
      pendingDecision = { turn, detectedAt, targets, decision, availablePlayers };
      if (manualOverride.status === "applied" || selectionHoldMs === 0) {
        startPendingController(null, manualOverride.status === "applied" ? "pre_staged_pin" : "baseline_immediate");
      } else {
        environment.setTimeout(() => {
          try { startPendingController(null, "baseline_timeout"); } catch (error) { fail(String(error?.message ?? error)); }
        }, selectionHoldMs);
      }
    }

    async function advance() {
      if (busy || state !== "running") return;
      if (!currentController) {
        if (pendingDecision) return;
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
        const boardPlayer = board.find((player) => player.yahooId === String(confirmation.yahooId));
        const turnDetectionToClickMs = (activeTurnMetrics?.controllerStartedAt - activeTurnMetrics?.detectedAt) + clicks[0].detectionToClickMs;
        const pick = {
          yahooId: confirmation.yahooId,
          name: boardPlayer?.name ?? confirmation.name,
          position: positionForConfirmedPick(board, confirmation),
          team: boardPlayer?.team ?? confirmation.team,
          eligible: boardPlayer?.eligible ?? [positionForConfirmedPick(board, confirmation)],
          projection: boardPlayer?.projection ?? null,
          perGamePoints: boardPlayer?.perGamePoints ?? null,
          expectedGamesThroughWeek17: boardPlayer?.expectedGamesThroughWeek17 ?? null,
          weeklyPoints: boardPlayer?.weeklyPoints ?? null,
          weeklyAvailability: boardPlayer?.weeklyAvailability ?? null,
          outcomeLow: boardPlayer?.outcomeLow ?? null,
          outcomeHigh: boardPlayer?.outcomeHigh ?? null,
          uncertaintyStatus: boardPlayer?.uncertaintyStatus ?? "OUTCOME_INTERVAL_UNAVAILABLE",
          bye: boardPlayer?.bye ?? null,
          turn: confirmation.turn,
          detectionToClickMs: clicks[0].detectionToClickMs,
          turnDetectionToClickMs,
          turnToClickBudgetMs: TURN_TO_CLICK_BUDGET_MS,
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
        activeTurnMetrics = null;

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
        throw new Error("draft roster changed after preflight");
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
        replacementBySlot,
        survivalCalibrationStatus: survivalCalibration?.calibration?.enabled
          ? survivalCalibration.calibration.positionLayerEnabled
            ? "HELD_OUT_CALIBRATED_POSITION_RESIDUAL"
            : "HELD_OUT_CALIBRATED_ROOM_RESIDUAL"
          : "UNCALIBRATED_MARKET_FALLBACK",
        selectionHoldMs,
        strategy: "weekly_optimal_lineup_utility_plus_probability_weighted_one_turn_vona",
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
      pendingDecision = null;
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
      pendingDecision = null;
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
        busy,
        failure,
        picks: picks.slice(),
        currentController: currentController?.getStatus?.() ?? null,
        pendingDecision: pendingDecision ? {
          turn: pendingDecision.turn.label,
          detectedAt: pendingDecision.detectedAt,
          deadlineAt: pendingDecision.detectedAt + selectionHoldMs,
          targetYahooIds: pendingDecision.targets.slice(0, 3).map((target) => target.yahooId),
        } : null,
      };
    }

    function exportReceipts() {
      return readReceipts().filter((entry) => entry.runId === runId);
    }

    const api = { start, halt, stop, chooseOnClock, getStatus, exportReceipts };
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
      requiredTestFilterLabels,
      validateBoard,
      positionForConfirmedPick,
      overallPick,
      turnWindow,
      survivalProbability,
      runPressureFromAvailability,
      optimalRosterUtility,
      maximumFilledStarterSlots,
      canCompleteRoster,
      sameRosterIdentity,
      summarizeDecision,
      scoreCandidates,
      buildDecisionLadder,
      applyManualOverride,
      validateCompletedRoster,
      rosterSlotAccepts,
      allocateRosterSlots,
      validateObservedTestRoster,
    },
  };
})(globalThis);
