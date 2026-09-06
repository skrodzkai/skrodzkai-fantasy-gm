(function installYahooRealShadow(root) {
  "use strict";

  const VERSION = "0.16.4";
  const LEAGUE_ID = "420010";
  const TEAM_ID = 7;
  const SETTINGS_KEY = "skz.realShadowSettings";
  const SCORING_IDENTITY = Object.freeze({ leagueId:LEAGUE_ID, scoringModel:"2-minute-drillers-2026", scoringSchemaHash:"97aac9f122786f0ae3b9bfaaecb69cd097dfb6dd70f2b5b8e7190435b6eedad8" });
  // Every enabled league-value row observed at /f1/420010/settings,
  // 2026-09-05T23:24Z. Yahoo's separate default column is never used.
  const SCORING_ROWS = Object.freeze({
    Offense:[
      ["Completions", ".10"], ["Passing Yards", "25 yards per point"], ["Passing Touchdowns", "6"], ["Interceptions", "-2"],
      ["Rushing Yards", "10 yards per point; 2 points at 100 yards"], ["Rushing Touchdowns", "6"], ["Receptions", ".25"],
      ["Receiving Yards", "10 yards per point; 2 points at 100 yards"], ["Receiving Touchdowns", "6"], ["Return Yards", "50 yards per point"],
      ["Return Touchdowns", "6"], ["2-Point Conversions", "2"], ["Fumbles Lost", "-2"], ["Offensive Fumble Return TD", "6"],
    ],
    Kickers:[
      ["Field Goals 0-19 Yards", "3"], ["Field Goals 20-29 Yards", "3"], ["Field Goals 30-39 Yards", "3"],
      ["Field Goals 40-49 Yards", "3"], ["Field Goals 50+ Yards", "3"], ["Point After Attempt Made", "1"], ["Point After Attempt Missed", "-1"],
    ],
    "Defense/Special Teams":[
      ["Sack", "1"], ["Interception", "1"], ["Fumble Recovery", "2"], ["Touchdown", "6"], ["Safety", "2"], ["Block Kick", "2"],
      ["Kickoff and Punt Return Touchdowns", "6"], ["Points Allowed 0 points", "10"], ["Points Allowed 1-6 points", "7"],
      ["Points Allowed 7-13 points", "4"], ["Points Allowed 14-20 points", "2"], ["Points Allowed 21-27 points", "0"],
      ["Points Allowed 28-34 points", "-1"], ["Points Allowed 35+ points", "-4"], ["Extra Point Returned", "2"],
    ],
    "Defensive Players":[
      ["Tackle Solo", ".5"], ["Tackle Assist", ".25"], ["Sack", "2"], ["Interception", "3"], ["Fumble Force", "2"],
      ["Fumble Recovery", "2"], ["Defensive Touchdown", "6"], ["Safety", "2"], ["Pass Defended", "1"], ["Block Kick", "2"],
      ["Tackles for Loss", "1"], ["Turnover Return Yards", "10 yards per point"], ["Extra Point Returned", "2"],
    ],
  });
  const EXPECTED_ROSTER = Object.freeze([
    "QB", "WR", "WR", "WR", "RB", "RB", "TE", "W/R/T", "K", "DEF",
    "D", "DB", "LB", "BN", "BN", "BN", "BN", "BN", "BN", "IR",
  ]);
  const readers = root.SKRODZKaiYahooPageReaders;
  if (!readers) throw new Error("real shadow readers must load first");

  function validRuntimeAttestation(attestation) {
    return Boolean(
      attestation?.ok === true
      && String(attestation.version) === VERSION
      && /^[a-f0-9]{64}$/.test(String(attestation.digest ?? ""))
      && String(attestation.bootId ?? "").length >= 8
      && Number.isFinite(Number(attestation.bootedAt)),
    );
  }

  async function readRuntimeAttestation(environment) {
    try {
      const response = await environment.chrome.runtime.sendMessage({ type:"version_handshake", version:VERSION });
      return validRuntimeAttestation(response) ? response : null;
    } catch {
      return null;
    }
  }

  function same(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  function parseSettings(documentRef, locationRef) {
    const body = readers.draftSurfaceText(documentRef);
    const rosterSlots = readers.parseRosterSlots(body);
    const teamCount = Number(body.match(/Max Teams:\s*(\d+)/i)?.[1] ?? 0);
    const errors = [];
    if (String(locationRef?.pathname ?? "") !== `/f1/${LEAGUE_ID}/settings`) errors.push("not_real_settings");
    if (!/League Name:\s*2 minute Drillers/i.test(body)) errors.push("real_league_identity_mismatch");
    if (!/Draft Type:\s*Live Standard Draft/i.test(body)) errors.push("real_draft_type_mismatch");
    if (!/Live Draft Pick Time:\s*30 Seconds/i.test(body)) errors.push("real_clock_mismatch");
    errors.push(...readers.scoringTableErrors(documentRef, SCORING_ROWS).map((error) => `real_${error}`));
    if (teamCount !== 12) errors.push("real_team_count_not_12");
    if (!same(rosterSlots, EXPECTED_ROSTER)) errors.push("real_roster_shape_mismatch");
    return { ...SCORING_IDENTITY, teamId:TEAM_ID, teamCount, rosterSlots, ready:errors.length === 0, errors };
  }

  function parseDraftSlot(bodyText) {
    const matches = [...String(bodyText ?? "").matchAll(/^Your Draft Position:\s*(\d{1,2})(?:st|nd|rd|th)?\s*$/gim)];
    const slot = matches.length === 1 ? Number(matches[0][1]) : null;
    return slot >= 1 && slot <= 12 ? slot : null;
  }

  function availablePlayers(documentRef, environment = root) {
    // Positive availability evidence only; no disabled/drafted/search-only rows.
    return readers.readAvailablePlayerRows(documentRef, environment);
  }

  function clientDraftSlot(documentRef) {
    const teams = [...documentRef.querySelectorAll('.ys-team[data-id]')];
    const ids = teams.map((team) => String(team.getAttribute("data-id")));
    const first = ids.slice(0, 12);
    if (new Set(first).size !== 12 || ids.length !== 12 * 19 || ids.some((id) => !/^[1-9]\d*$/.test(id))) return null;
    const snake = Array.from({ length:19 }, (_, round) => round % 2 ? [...first].reverse() : first).flat();
    if (!same(ids, snake)) return null;
    const index = first.indexOf(String(TEAM_ID));
    if (index < 0 || String(teams[index].textContent ?? "").trim() !== "You") return null;
    const textSlot = parseDraftSlot(readers.draftSurfaceText(documentRef));
    const titleSlot = Number(String(documentRef.title ?? "").match(/^You pick (\d{1,2})(?:st|nd|rd|th) \| Live NFL Draft \| Yahoo Fantasy Sports$/)?.[1] ?? 0);
    if ((textSlot != null && textSlot !== index + 1) || (titleSlot && titleSlot !== index + 1)) return null;
    return index + 1;
  }

  function settingsReceipt(snapshot, now = Date.now()) {
    if (!snapshot.ready) throw new Error("real settings are not verified");
    return { ...SCORING_IDENTITY, teamId:TEAM_ID, verifiedAt:now, expiresAt:now + 4 * 60 * 60 * 1000, rosterSlots:[...snapshot.rosterSlots] };
  }

  function validSettingsReceipt(receipt, now = Date.now()) {
    return Boolean(receipt && Object.entries(SCORING_IDENTITY).every(([key, value]) => receipt[key] === value) &&
      receipt.teamId === TEAM_ID && Number.isFinite(receipt.verifiedAt) && receipt.verifiedAt <= now &&
      receipt.expiresAt === receipt.verifiedAt + 4 * 60 * 60 * 1000 && receipt.expiresAt > now && same(receipt.rosterSlots ?? [], EXPECTED_ROSTER));
  }

  function boardHealth(boardData, now = Date.now()) {
    const receipt = readers.boardHealthReceipt(boardData, now);
    const binding = boardData?.replacementRoster;
    const error = !Object.entries(SCORING_IDENTITY).every(([key, value]) => boardData?.[key] === value)
      ? "real_board_scoring_identity_mismatch"
      : binding?.teamCount !== 12 || !same(binding?.rosterSlots ?? [], EXPECTED_ROSTER.filter((slot) => !["BN", "IR"].includes(slot)))
        ? "real_board_replacement_roster_mismatch"
        : readers.boardHealthGate(boardData, now);
    return {
      ready:error === null,
      error,
      generatedAt:receipt.generatedAt,
      ageHours:Number.isFinite(receipt.ageMs) ? receipt.ageMs / 3_600_000 : null,
    };
  }

  function buildSnapshot({ documentRef, locationRef, settings, boardData, attestation = null, now = Date.now(), environment = root }) {
    const body = readers.draftSurfaceText(documentRef);
    const pathname = String(locationRef?.pathname ?? "");
    const room = readers.parseRoom(pathname);
    const draftClient = room?.roomId === LEAGUE_ID && room.seat === TEAM_ID;
    const draftHome = pathname === `/f1/${LEAGUE_ID}/draft`;
    const settingsPage = pathname === `/f1/${LEAGUE_ID}/settings`;
    const roster = readers.parseRosterCount(body);
    const turnState = draftClient ? readers.readOwnedTurnState(documentRef) : null;
    const ownedTurn = turnState?.turn ?? null;
    const autodraftState = draftClient ? readers.readAutodraftState(documentRef) : "UNKNOWN";
    const autodraft = autodraftState === "ACTIVE";
    const players = draftClient ? availablePlayers(documentRef, environment) : [];
    const health = boardHealth(boardData, now);
    const verified = settingsPage ? parseSettings(documentRef, locationRef).ready : validSettingsReceipt(settings, now);
    const draftSlot = draftClient ? clientDraftSlot(documentRef) : parseDraftSlot(body);
    const warnings = [
      !verified && { severity:"danger", text:"REAL settings are not verified in this extension session." },
      !health.ready && { severity:"danger", text:`REAL player board locked: ${health.error}.` },
      !validRuntimeAttestation(attestation) && { severity:"danger", text:"Runtime attestation is unavailable; shadow remains locked." },
      autodraft && { severity:"danger", text:"Yahoo Autodraft appears active; shadow remains read-only." },
      draftClient && !roster && { severity:"danger", text:"Yahoo roster count is unreadable." },
      { severity:"info", text:"REAL SHADOW cannot arm, pin, filter, draft, or mutate Yahoo." },
    ].filter(Boolean);
    const ready = (settingsPage || draftHome || draftClient || pathname === `/f1/${LEAGUE_ID}/${TEAM_ID}`) && verified && health.ready && validRuntimeAttestation(attestation);
    let advice = null;
    let adviceError = null;
    let observedPicks = [];
    let unmodelledVisibleRows = 0;
    if (draftClient && ready) {
      try {
        const engine = root.SKRODZKaiYahooMockRunner?.decision;
        const config = root.SKRODZKaiYahooMockRunner?.configs.real_league_19_idp;
        if (!engine || !config) throw new Error("real_advisory_engine_unavailable");
        if (!draftSlot) throw new Error("real_draft_slot_unverified");
        if (turnState?.state === "INCONSISTENT") throw new Error("real_turn_signal_inconsistent");
        if (readers.blockers(documentRef, environment).length) throw new Error("real_yahoo_dialog_or_autopick_blocker");
        const identity = readers.readTeamRosterPlayerIds(documentRef, roster);
        if (!identity || identity.total !== 19) throw new Error("real_roster_identity_unreadable");
        const board = engine.validateBoard(boardData.players);
        observedPicks = identity.yahooIds.map((id) => {
          const player = board.find((candidate) => candidate.yahooId === id);
          if (!player) throw new Error(`real_roster_player_not_in_board:${id}`);
          return player;
        });
        if (observedPicks.length === 19) throw new Error("draft_complete");
        const round = observedPicks.length + 1;
        if (ownedTurn && (ownedTurn.round !== round || ownedTurn.pick !== engine.overallPick(round, draftSlot, 12))) throw new Error("real_turn_roster_mismatch");
        if (new Set(players.map((p) => p.yahooId)).size !== players.length) throw new Error("real_visible_identity_ambiguous");
        for (const row of players) {
          const player = board.find((candidate) => candidate.yahooId === row.yahooId);
          if (!player) { unmodelledVisibleRows += 1; continue; }
          // Yahoo IDs are canonical; draft rows abbreviate names and DEF rows
          // omit the team line. Neither observed format invents a new identity.
          if ((row.team && readers.normalize(player.team) !== readers.normalize(row.team)) ||
              (!row.team && row.position !== "DEF") ||
              !player.eligible.some((position) => readers.normalize(position) === readers.normalize(row.position))) throw new Error(`real_visible_player_mismatch:${row.yahooId}`);
          if (identity.yahooIds.includes(row.yahooId)) throw new Error("real_roster_available_overlap");
        }
        advice = engine.buildDecisionLadder({ round, seat:draftSlot, picks:observedPicks, board, availablePlayers:players, config,
          replacementBySlot:boardData.replacementBySlot, survivalCalibration:boardData.survivalCalibration, minimum:5 });
      } catch (error) { adviceError = String(error?.message ?? error); }
    }
    if (adviceError) warnings.unshift({ severity:adviceError === "draft_complete" ? "info" : "danger", text:`Advice withheld: ${adviceError}` });
    if (unmodelledVisibleRows) warnings.push({severity:"info",text:`${unmodelledVisibleRows} visible players lack a usable model and are not ranked.`});
    warnings.push({ severity:"info", text:"VISIBLE-POOL advice only: hidden/unloaded players are not evaluated. Roster names are observed; Yahoo slot assignments are not inferred. Manager cards and committee reviews are offline." });
    const recommendations = advice?.targets.map((player, index) => ({ ...player,
      reason:"VISIBLE POOL · league-scored lineup value + next-turn alternatives",
      edge:Number(advice.decision.positionLeaders[index]?.adjustedScore ?? 0).toFixed(1), confidence:"ADVISORY ONLY" })) ?? [];
    return {
      version:VERSION,
      attestation:validRuntimeAttestation(attestation) ? { ...attestation } : null,
      mode:"REAL SHADOW",
      kind:ready ? "neutral" : "bad",
      label:ready ? "REAL SHADOW · READ ONLY" : "REAL SHADOW LOCKED",
      detail:settingsPage ? (verified ? "Exact league settings verified. No Yahoo action is possible." : "Settings mismatch; inspect warnings.") : "Observation and local analysis only. Execution is hard-disabled.",
      context:{ league:"2 minute Drillers", roomId:LEAGUE_ID, teamId:TEAM_ID, seat:draftSlot ?? "PENDING", round:advice ? observedPicks.length + 1 : ownedTurn?.round ?? null, pick:ownedTurn?.pick ?? null, clock:"30s", clockVerified:verified, armed:false, autodraft, autodraftState, kill:false, ownedTurn:Boolean(ownedTurn) },
      roster:observedPicks.map((player) => ({ slot:"OBSERVED", player })), recommendations, board:[],
      between:{ currentPick:ownedTurn?.pick ?? null, nextPick:advice?.decision.nextPick ?? null,
        intervening:advice?.decision.interveningOpponentPicks ?? null, atRisk:[], managerNote:"Market timing and exact snake window; no live run-pressure, manager prediction or model committee." },
      warnings,
      events:[{ at:new Date(now).toISOString(), kind:"SHADOW", detail:`team ${TEAM_ID}; roster ${roster ? `${roster.filled}/${roster.total}` : "unreadable"}; available rows ${players.length}` }],
      latestText:"No Yahoo action taken. Listed roster is observed membership, not verified Yahoo slot placement.", ladderState:advice ? "VISIBLE POOL · READ ONLY" : "ADVICE WITHHELD", pinned:false, pinText:"Overrides are disabled in REAL SHADOW.", pinLabel:"DISABLED",
      controls:{ arm:{ disabled:true, text:"ARM DISABLED" }, halt:{ disabled:true, text:"NO EXECUTION" }, export:{ disabled:true, text:"EXPORT DISABLED" } },
      shadow:{ settingsVerified:verified, boardHealth:health, roster, availablePlayerCount:players.length, unmodelledVisibleRows, urlTeamId:draftClient ? room.seat : TEAM_ID, draftSlot, adviceError, decision:advice?.decision ?? null },
    };
  }

  function mount(snapshot, documentRef) {
    let rail = documentRef.getElementById("skrodzkai-real-shadow");
    if (!rail) {
      rail = documentRef.createElement("aside");
      rail.id = "skrodzkai-real-shadow";
      rail.setAttribute("style", "position:fixed;right:12px;bottom:12px;z-index:2147483647;width:340px;max-height:44vh;overflow:auto;padding:14px;border:1px solid #0a84ff;border-radius:10px;background:#05070bf2;color:#fff;font:12px/1.45 'SF Mono',monospace;box-shadow:0 14px 44px #000a");
      documentRef.body?.append(rail);
    }
    const warningText = snapshot.warnings.map((warning) => warning.text).join("\n");
    const runtimeText = snapshot.attestation
      ? `v${snapshot.attestation.version} · SHA ${snapshot.attestation.digest.slice(0, 12)} · LOAD ${new Date(Number(snapshot.attestation.bootedAt)).toISOString()}`
      : `v${VERSION} · SHA UNAVAILABLE · LOAD UNVERIFIED`;
    rail.style.whiteSpace = "pre-line";
    const adviceText = snapshot.recommendations.map((player, index) => `${index + 1}. ${player.name} · ${player.position} · ${player.edge}`).join("\n");
    rail.textContent = `SKRODZKai · REAL SHADOW\n${snapshot.label}\nRuntime ${runtimeText}\nTeam ${TEAM_ID} · draft slot ${snapshot.context.seat}\nSettings ${snapshot.shadow.settingsVerified ? "VERIFIED" : "LOCKED"} · Board ${snapshot.shadow.boardHealth.ready ? "FRESH" : "LOCKED"}\nRoster ${snapshot.shadow.roster ? `${snapshot.shadow.roster.filled}/${snapshot.shadow.roster.total}` : "—"} · Available ${snapshot.shadow.availablePlayerCount}\n\n${snapshot.ladderState}\n${adviceText}\n\n${warningText}`;
  }

  async function boot(environment = root) {
    const settingsPage = environment.location.pathname === `/f1/${LEAGUE_ID}/settings`;
    const stored = await environment.chrome.storage.session.get(SETTINGS_KEY);
    let receipt = stored[SETTINGS_KEY] ?? null;
    const refreshSettingsReceipt = async () => {
      if (!settingsPage) return;
      const observed = parseSettings(environment.document, environment.location);
      if (observed.ready) {
        if (!validSettingsReceipt(receipt)) {
          receipt = settingsReceipt(observed);
          await environment.chrome.storage.session.set({ [SETTINGS_KEY]:receipt });
        }
      } else if (receipt) {
        receipt = null;
        await environment.chrome.storage.session.remove(SETTINGS_KEY);
      }
    };
    await refreshSettingsReceipt();
    let attestation = await readRuntimeAttestation(environment);
    let snapshot = buildSnapshot({ documentRef:environment.document, locationRef:environment.location, settings:receipt, boardData:environment.SKRODZKaiYahooRealBoard, attestation, environment });
    mount(snapshot, environment.document);
    const publish = () => environment.chrome.runtime.sendMessage({ type:"state", role:"shadow", at:Date.now(), snapshot }).catch(() => undefined);
    publish();
    let refreshing = false;
    const timer = environment.setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void Promise.all([refreshSettingsReceipt(), readRuntimeAttestation(environment)]).then(([, nextAttestation]) => {
        attestation = nextAttestation;
        snapshot = buildSnapshot({ documentRef:environment.document, locationRef:environment.location, settings:receipt, boardData:environment.SKRODZKaiYahooRealBoard, attestation, environment });
        mount(snapshot, environment.document);
        publish();
      }).finally(() => { refreshing = false; });
    }, 1000);
    return { stop:() => environment.clearInterval(timer), getSnapshot:() => snapshot };
  }

  root.SKRODZKaiYahooRealShadow = { version:VERSION, boot, _test:{ parseSettings, parseDraftSlot, clientDraftSlot, availablePlayers, settingsReceipt, validSettingsReceipt, boardHealth, buildSnapshot, mount, validRuntimeAttestation, readRuntimeAttestation, scoringIdentity:SCORING_IDENTITY, scoringRows:SCORING_ROWS, expectedRoster:[...EXPECTED_ROSTER] } };
  if (root.document && root.location && root.chrome) void boot(root);
})(globalThis);
