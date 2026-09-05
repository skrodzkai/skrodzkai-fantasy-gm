(function installYahooPageReaders(root) {
  "use strict";

  const POSITIONS = new Set([
    "QB", "RB", "WR", "TE", "K", "DEF",
    "D", "DL", "DE", "DT", "NT", "LB", "ILB", "OLB",
    "DB", "CB", "S", "FS", "SS",
  ]);

  function normalize(value) {
    return String(value ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9/]+/g, " ")
      .trim()
      .toUpperCase();
  }

  function textLines(value) {
    return String(value ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  }

  const NON_DRAFT_TEXT_SELECTOR = '[contenteditable="true"],[role="log"],[aria-label*="chat" i],[class*="chat" i],[id*="chat" i]';

  function draftSurfaceText(documentRef) {
    let value = String(documentRef.body?.innerText ?? "");
    for (const element of documentRef.querySelectorAll?.(NON_DRAFT_TEXT_SELECTOR) ?? []) {
      const excluded = String(element?.innerText ?? "").trim();
      if (excluded) value = value.replace(excluded, "");
    }
    return value;
  }

  function parseRoom(pathname) {
    const match = String(pathname ?? "").match(/^\/draftclient\/f1\/(\d+)\/(\d+)\/?$/);
    return match ? { roomId: match[1], seat: Number(match[2]) } : null;
  }

  function parseRosterCount(bodyText) {
    const match = String(bodyText ?? "").match(/YOUR TEAM \((\d+)\/(\d+)\)/);
    return match ? { filled: Number(match[1]), total: Number(match[2]) } : null;
  }

  function parseRosterSlots(bodyText) {
    const lines = String(bodyText ?? "").split("\n").map((line) => line.trim());
    const heading = lines.findIndex((line) => normalize(line).startsWith("ROSTER POSITIONS"));
    if (heading < 0) return [];
    const inline = lines[heading].replaceAll("\u00a0", " ").match(/^Roster\s+Positions\s*[:\t]\s*(.+)$/i)?.[1];
    return String(inline ?? lines.slice(heading + 1).find(Boolean) ?? "")
      .split(",").map((slot) => normalize(slot).replaceAll(" ", "")).filter(Boolean);
  }

  function readOwnedTurn(documentRef) {
    const banner = textLines(draftSurfaceText(documentRef)).find((line) => /^YOUR TURN • ROUND \d+, PICK \d+$/.test(line));
    if (!String(documentRef.title ?? "").startsWith("YOUR TURN") || !banner) return null;
    const match = banner.match(/^YOUR TURN • ROUND (\d+), PICK (\d+)$/);
    return match ? { label: `R${match[1]}P${match[2]}`, round: Number(match[1]), pick: Number(match[2]) } : null;
  }

  function readOwnedTurnState(documentRef) {
    const titleOwned = String(documentRef.title ?? "").startsWith("YOUR TURN");
    const banners = textLines(draftSurfaceText(documentRef))
      .filter((line) => /^YOUR TURN • ROUND \d+, PICK \d+$/.test(line));
    if (titleOwned && banners.length === 1) return { state:"OWNED", turn:readOwnedTurn(documentRef) };
    if (!titleOwned && banners.length === 0) return { state:"OFF_TURN", turn:null };
    return { state:"INCONSISTENT", turn:null, titleOwned, bannerCount:banners.length };
  }

  function buttonText(button) {
    return String(button?.innerText ?? button?.textContent ?? "").trim();
  }

  function readAutodraftState(documentRef) {
    const controls = [...documentRef.querySelectorAll("button")]
      .filter((button) => buttonText(button) === "Autodraft");
    if (controls.length !== 1) return "UNKNOWN";
    return controls[0].querySelector('svg[data-icon="checkmark-default"]') ? "ACTIVE" : "INACTIVE";
  }

  function isAutodraftActive(documentRef) {
    return readAutodraftState(documentRef) === "ACTIVE";
  }

  function readQueueState(documentRef) {
    const body = normalize(draftSurfaceText(documentRef));
    if (body.includes("YOUR QUEUE IS EMPTY")) return "EMPTY";
    if (body.includes("QUEUE") || body.includes("AUTODRAFT WILL PICK FROM QUEUE")) return "NONEMPTY_OR_UNKNOWN";
    return "UNKNOWN";
  }

  function readDraftClock(documentRef) {
    const matches = textLines(draftSurfaceText(documentRef))
      .map((line) => line.match(/^(\d{1,2}):(\d{2})$/))
      .filter(Boolean)
      .filter((match) => Number(match[2]) < 60)
      .map((match) => ({ label:match[0], seconds:Number(match[1]) * 60 + Number(match[2]) }))
      .filter((clock) => Number.isInteger(clock.seconds) && clock.seconds >= 0);
    return matches.length === 1 ? matches[0] : null;
  }

  function isVisible(element, rootRef) {
    if (!element || element.hidden || element.getAttribute?.("aria-hidden") === "true") return false;
    const style = rootRef.getComputedStyle?.(element);
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    return typeof element.getClientRects === "function" ? element.getClientRects().length > 0 : true;
  }

  function blockers(documentRef, rootRef) {
    const found = [...documentRef.querySelectorAll('[role="dialog"]')]
      .filter((element) => isVisible(element, rootRef))
      .map((element) => normalize(element.innerText).slice(0, 120));
    const body = draftSurfaceText(documentRef);
    if (body.includes("Change Layout") && body.includes("Toggle between the default layout")) found.push("YAHOO LAYOUT TUTORIAL");
    const normalizedBody = normalize(body);
    if (/PREPARING (YOUR )?SELECTION|SELECTION (IS )?BEING PREPARED/.test(normalizedBody)) found.push("YAHOO PREPARING SELECTION");
    if (/YOU (HAVE BEEN|WERE) SET TO AUTODRAFT|INACTIVITY.*AUTODRAFT/.test(normalizedBody)) found.push("YAHOO INACTIVITY AUTODRAFT");
    if (/AUTOMATIC (PICK|SELECTION) IN PROGRESS|DEFAULT (PICK|SELECTION) IN PROGRESS/.test(normalizedBody)) found.push("YAHOO AUTOMATIC SELECTION");
    return found;
  }

  function readRosterCount(documentRef) {
    return parseRosterCount(draftSurfaceText(documentRef));
  }

  function readAvailablePlayerRows(documentRef, rootRef) {
    return [...documentRef.querySelectorAll("tr")]
      .map(readPlayerRow)
      .filter(Boolean)
      .filter((player) => isVisible(player.row, rootRef) && isVisible(player.player, rootRef))
      .filter((player) => [...player.row.querySelectorAll("button")]
        .filter((button) => buttonText(button) === "Draft" && !button.disabled && isVisible(button, rootRef)).length === 1);
  }

  function readDiscoveryRows(documentRef, rootRef) {
    return [...documentRef.querySelectorAll("tr")].map(readPlayerRow).filter(Boolean)
      .filter((player) => isVisible(player.row, rootRef) && isVisible(player.player, rootRef));
  }

  function readProjectedOrder(documentRef, players) {
    const header = documentRef.querySelector('th[data-id="values:projected:points"]');
    if (!header || normalize(header.innerText ?? header.textContent) !== "PROJ PTS") return null;
    const headers = [...(header.parentElement?.querySelectorAll("th") ?? [])];
    const column = headers.indexOf(header);
    if (column < 0) return null;
    const values = players.map((player) => {
      const text = String(player.row.querySelectorAll("td")[column]?.textContent ?? "").trim().replace(/,/g, "");
      return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : null;
    });
    const numeric = values.filter((value) => value != null);
    const trailingMissing = values.every((value, index) => value == null || !values.slice(0, index).includes(null));
    return { header, values, descending:numeric.length >= 5 && trailingMissing && numeric.every((value, index) => index === 0 || value <= numeric[index - 1]) };
  }

  function readPlayerRow(row) {
    const player = row.querySelector(".ys-player[data-id]");
    if (!player) return null;
    const lines = textLines(player.innerText);
    const positionIndex = lines.findIndex((line) => POSITIONS.has(normalize(line)));
    if (positionIndex < 1) return null;
    const titledImage = player.querySelector("img[title]");
    const position = normalize(lines[positionIndex]);
    const nextLine = lines[positionIndex + 1] ?? "";
    return {
      yahooId: String(player.getAttribute("data-id") ?? ""),
      name: String(titledImage?.getAttribute("title") ?? lines[0]),
      position,
      team: /^BYE\s+\d+$/i.test(nextLine) ? "" : normalize(nextLine),
      player,
      row,
    };
  }

  function readTeamRosterPlayerIds(documentRef, expectedRoster = null) {
    const roster = expectedRoster ?? readRosterCount(documentRef);
    if (!roster || !Number.isInteger(roster.filled) || roster.filled < 0 || !Number.isInteger(roster.total) || roster.total <= 0) return null;
    if (roster.filled === 0) return { ...roster, yahooIds:[] };
    const headingPattern = new RegExp(`^YOUR TEAM ${roster.filled}/${roster.total}$`);
    const headings = [...documentRef.querySelectorAll("h1,h2,h3,h4,h5,h6,div,span")]
      .filter((element) => textLines(element?.innerText).some((line) => headingPattern.test(normalize(line))));
    const candidates = [];
    for (const heading of headings) {
      let node = heading;
      for (let depth = 0; node && depth <= 8; depth += 1, node = node.parentElement) {
        const playerNodes = [...(node.querySelectorAll?.(".ys-player[data-id]") ?? [])];
        const yahooIds = [...new Set(playerNodes.map((player) => String(player.getAttribute?.("data-id") ?? "")).filter(Boolean))];
        if (yahooIds.length === roster.filled && playerNodes.length === roster.filled) {
          candidates.push({ yahooIds, depth, textLength:String(node.innerText ?? "").length });
          break;
        }
      }
    }
    if (!candidates.length) return null;
    candidates.sort((left, right) => left.textLength - right.textLength || left.depth - right.depth);
    return { ...roster, yahooIds:candidates[0].yahooIds };
  }

  function boardHealthReceipt(boardData, now = Date.now(), maximumAgeMs = 24 * 60 * 60 * 1000) {
    const generatedAtMs = Date.parse(boardData?.generatedAt);
    const ageMs = Number.isFinite(generatedAtMs) ? now - generatedAtMs : null;
    return {
      generatedAt:boardData?.generatedAt ?? null,
      ageMs,
      maximumAgeMs,
      marketAdpObservedAt:boardData?.marketAdpReceipt?.observedAt ?? null,
      marketAdpSourceAsOf:boardData?.marketAdpReceipt?.sourceAsOf ?? null,
      marketAdpRows:Number(boardData?.marketAdpReceipt?.rows ?? 0),
      injuryCoverageComplete:boardData?.injuryCoverage?.complete === true,
      injuryPlayersChecked:Number(boardData?.injuryCoverage?.checkedPlayers ?? 0),
      injuryPlayersTotal:Number(boardData?.injuryCoverage?.expectedPlayers ?? boardData?.injuryCoverage?.totalPlayers ?? boardData?.injuryCoverage?.playersTotal ?? 0),
      byeCoverageComplete:boardData?.byeCoverage?.complete === true,
      byePlayersWithBye:Number(boardData?.byeCoverage?.playersWithBye ?? 0),
      byePlayersTotal:Number(boardData?.byeCoverage?.playersTotal ?? 0),
    };
  }

  function boardHealthGate(boardData, now = Date.now(), { maximumAgeMs = 24 * 60 * 60 * 1000, futureToleranceMs = 15 * 60 * 1000 } = {}) {
    if (!boardData || typeof boardData !== "object") return "draft_board_missing";
    const health = boardHealthReceipt(boardData, now, maximumAgeMs);
    if (!Number.isFinite(health.ageMs)) return "draft_board_timestamp_missing";
    if (health.ageMs < -futureToleranceMs) return "draft_board_timestamp_in_future";
    if (health.ageMs > maximumAgeMs) return "draft_board_stale_over_24h";
    const adpAgeMs = now - Date.parse(health.marketAdpObservedAt);
    if (!Number.isFinite(adpAgeMs) || adpAgeMs < -futureToleranceMs || adpAgeMs > maximumAgeMs || health.marketAdpRows < 150) return "draft_board_adp_stale_or_missing";
    if (!health.injuryCoverageComplete || health.injuryPlayersTotal <= 0 || health.injuryPlayersChecked !== health.injuryPlayersTotal || health.injuryPlayersTotal !== health.byePlayersTotal) return "draft_board_injury_coverage_incomplete";
    if (!health.byeCoverageComplete || health.byePlayersTotal <= 0 || health.byePlayersWithBye !== health.byePlayersTotal) return "draft_board_bye_coverage_incomplete";
    return null;
  }

  root.SKRODZKaiYahooPageReaders = Object.freeze({
    normalize, textLines, draftSurfaceText, parseRoom, parseRosterCount, readRosterCount, parseRosterSlots, readOwnedTurn, readOwnedTurnState,
    buttonText, readAutodraftState, isAutodraftActive, readQueueState, readDraftClock,
    isVisible, blockers, readPlayerRow, readAvailablePlayerRows, readDiscoveryRows, readProjectedOrder, readTeamRosterPlayerIds, boardHealthReceipt, boardHealthGate,
  });
})(globalThis);
