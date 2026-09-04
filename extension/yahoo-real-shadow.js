(function installYahooRealShadow(root) {
  "use strict";

  const VERSION = "0.16.0";
  const LEAGUE_ID = "420010";
  const TEAM_ID = 7;
  const SETTINGS_KEY = "skz.realShadowSettings";
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
    const body = String(documentRef?.body?.innerText ?? "");
    const rosterSlots = readers.parseRosterSlots(body);
    const teamCount = Number(body.match(/Max Teams:\s*(\d+)/i)?.[1] ?? 0);
    const errors = [];
    if (String(locationRef?.pathname ?? "") !== `/f1/${LEAGUE_ID}/settings`) errors.push("not_real_settings");
    if (!/League Name:\s*2 minute Drillers/i.test(body)) errors.push("real_league_identity_mismatch");
    if (!/Draft Type:\s*Live Standard Draft/i.test(body)) errors.push("real_draft_type_mismatch");
    if (!/Live Draft Pick Time:\s*30 Seconds/i.test(body)) errors.push("real_clock_mismatch");
    if (!/Passing Touchdowns(?:\s+Yahoo Default)?\s+6(?!\.\d)(?:\s|$)/i.test(body)) errors.push("real_passing_td_mismatch");
    if (!/Receptions(?:\s+Yahoo Default)?\s+0?\.25(?:\s|$)/i.test(body)) errors.push("real_reception_scoring_mismatch");
    if (teamCount !== 12) errors.push("real_team_count_not_12");
    if (!same(rosterSlots, EXPECTED_ROSTER)) errors.push("real_roster_shape_mismatch");
    return { leagueId:LEAGUE_ID, teamId:TEAM_ID, teamCount, rosterSlots, ready:errors.length === 0, errors };
  }

  function parseDraftSlot(bodyText) {
    const match = String(bodyText ?? "").match(/Your Draft Position:\s*(\d+)(?:st|nd|rd|th)?/i);
    return match ? Number(match[1]) : null;
  }

  function availablePlayers(documentRef) {
    return [...documentRef.querySelectorAll("tr")].map(readers.readPlayerRow).filter(Boolean);
  }

  function settingsReceipt(snapshot, now = Date.now()) {
    if (!snapshot.ready) throw new Error("real settings are not verified");
    return { leagueId:LEAGUE_ID, teamId:TEAM_ID, verifiedAt:now, expiresAt:now + 4 * 60 * 60 * 1000, rosterSlots:[...snapshot.rosterSlots] };
  }

  function validSettingsReceipt(receipt, now = Date.now()) {
    return Boolean(receipt && receipt.leagueId === LEAGUE_ID && receipt.teamId === TEAM_ID && Number(receipt.expiresAt) > now && same(receipt.rosterSlots ?? [], EXPECTED_ROSTER));
  }

  function boardHealth(boardData, now = Date.now()) {
    const receipt = readers.boardHealthReceipt(boardData, now);
    const error = readers.boardHealthGate(boardData, now);
    return {
      ready:error === null,
      error,
      generatedAt:receipt.generatedAt,
      ageHours:Number.isFinite(receipt.ageMs) ? receipt.ageMs / 3_600_000 : null,
    };
  }

  function buildSnapshot({ documentRef, locationRef, settings, boardData, attestation = null, now = Date.now() }) {
    const body = String(documentRef?.body?.innerText ?? "");
    const pathname = String(locationRef?.pathname ?? "");
    const room = readers.parseRoom(pathname);
    const draftClient = room?.roomId === LEAGUE_ID && room.seat === TEAM_ID;
    const draftHome = pathname === `/f1/${LEAGUE_ID}/draft`;
    const settingsPage = pathname === `/f1/${LEAGUE_ID}/settings`;
    const roster = readers.parseRosterCount(body);
    const ownedTurn = draftClient ? readers.readOwnedTurn(documentRef) : null;
    const autodraft = draftClient ? readers.isAutodraftActive(documentRef) : false;
    const players = draftClient ? availablePlayers(documentRef) : [];
    const health = boardHealth(boardData, now);
    const verified = settingsPage ? parseSettings(documentRef, locationRef).ready : validSettingsReceipt(settings, now);
    const draftSlot = parseDraftSlot(body);
    const warnings = [
      !verified && { severity:"danger", text:"REAL settings are not verified in this extension session." },
      !health.ready && { severity:"danger", text:"Player board is stale or missing injury/bye coverage." },
      !validRuntimeAttestation(attestation) && { severity:"danger", text:"Runtime attestation is unavailable; shadow remains locked." },
      autodraft && { severity:"danger", text:"Yahoo Autodraft appears active; shadow remains read-only." },
      draftClient && !roster && { severity:"danger", text:"Yahoo roster count is unreadable." },
      { severity:"info", text:"REAL SHADOW cannot arm, pin, filter, draft, or mutate Yahoo." },
    ].filter(Boolean);
    const ready = (settingsPage || draftHome || draftClient || pathname === `/f1/${LEAGUE_ID}/${TEAM_ID}`) && verified && health.ready && validRuntimeAttestation(attestation);
    return {
      version:VERSION,
      attestation:validRuntimeAttestation(attestation) ? { ...attestation } : null,
      mode:"REAL SHADOW",
      kind:ready ? "neutral" : "bad",
      label:ready ? "REAL SHADOW · READ ONLY" : "REAL SHADOW LOCKED",
      detail:settingsPage ? (verified ? "Exact league settings verified. No Yahoo action is possible." : "Settings mismatch; inspect warnings.") : "Observation and local analysis only. Execution is hard-disabled.",
      context:{ league:"2 minute Drillers", roomId:LEAGUE_ID, teamId:TEAM_ID, seat:draftSlot ?? "PENDING", round:ownedTurn?.round ?? null, pick:ownedTurn?.pick ?? null, clock:"30s", clockVerified:verified, armed:false, autodraft, kill:false, ownedTurn:Boolean(ownedTurn) },
      roster:[], recommendations:[], board:[], between:{ currentPick:ownedTurn?.pick ?? null, nextPick:null, intervening:null, atRisk:[], managerNote:"Opponent cards are descriptive and display-only; they never change BPA." },
      warnings,
      events:[{ at:new Date(now).toISOString(), kind:"SHADOW", detail:`team ${TEAM_ID}; roster ${roster ? `${roster.filled}/${roster.total}` : "unreadable"}; available rows ${players.length}` }],
      latestText:"No Yahoo action taken.", ladderState:"READ ONLY", pinned:false, pinText:"Overrides are disabled in REAL SHADOW.", pinLabel:"DISABLED",
      controls:{ arm:{ disabled:true, text:"ARM DISABLED" }, halt:{ disabled:true, text:"NO EXECUTION" }, export:{ disabled:true, text:"EXPORT DISABLED" } },
      shadow:{ settingsVerified:verified, boardHealth:health, roster, availablePlayerCount:players.length, urlTeamId:draftClient ? room.seat : TEAM_ID, draftSlot },
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
    rail.textContent = `SKRODZKai · REAL SHADOW\n${snapshot.label}\nRuntime ${runtimeText}\nTeam ${TEAM_ID} · draft slot ${snapshot.context.seat}\nSettings ${snapshot.shadow.settingsVerified ? "VERIFIED" : "LOCKED"} · Board ${snapshot.shadow.boardHealth.ready ? "FRESH" : "LOCKED"}\nRoster ${snapshot.shadow.roster ? `${snapshot.shadow.roster.filled}/${snapshot.shadow.roster.total}` : "—"} · Available ${snapshot.shadow.availablePlayerCount}\n\n${warningText}`;
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
    let snapshot = buildSnapshot({ documentRef:environment.document, locationRef:environment.location, settings:receipt, boardData:environment.SKRODZKaiYahooMockBoard, attestation });
    mount(snapshot, environment.document);
    const publish = () => environment.chrome.runtime.sendMessage({ type:"state", role:"shadow", at:Date.now(), snapshot }).catch(() => undefined);
    publish();
    let refreshing = false;
    const timer = environment.setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void Promise.all([refreshSettingsReceipt(), readRuntimeAttestation(environment)]).then(([, nextAttestation]) => {
        attestation = nextAttestation;
        snapshot = buildSnapshot({ documentRef:environment.document, locationRef:environment.location, settings:receipt, boardData:environment.SKRODZKaiYahooMockBoard, attestation });
        mount(snapshot, environment.document);
        publish();
      }).finally(() => { refreshing = false; });
    }, 1000);
    return { stop:() => environment.clearInterval(timer), getSnapshot:() => snapshot };
  }

  root.SKRODZKaiYahooRealShadow = { version:VERSION, boot, _test:{ parseSettings, parseDraftSlot, availablePlayers, settingsReceipt, validSettingsReceipt, boardHealth, buildSnapshot, validRuntimeAttestation, readRuntimeAttestation, expectedRoster:[...EXPECTED_ROSTER] } };
  if (root.document && root.location && root.chrome) void boot(root);
})(globalThis);
