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
    const banner = textLines(documentRef.body?.innerText).find((line) => /^YOUR TURN • ROUND \d+, PICK \d+$/.test(line));
    if (!String(documentRef.title ?? "").startsWith("YOUR TURN") || !banner) return null;
    const match = banner.match(/^YOUR TURN • ROUND (\d+), PICK (\d+)$/);
    return match ? { label: `R${match[1]}P${match[2]}`, round: Number(match[1]), pick: Number(match[2]) } : null;
  }

  function buttonText(button) {
    return String(button?.innerText ?? button?.textContent ?? "").trim();
  }

  function isAutodraftActive(documentRef) {
    return [...documentRef.querySelectorAll("button")].some((button) =>
      buttonText(button) === "Autodraft" && Boolean(button.querySelector('svg[data-icon="checkmark-default"]')),
    );
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
    const body = String(documentRef.body?.innerText ?? "");
    if (body.includes("Change Layout") && body.includes("Toggle between the default layout")) found.push("YAHOO LAYOUT TUTORIAL");
    return found;
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

  function boardHealthReceipt(boardData, now = Date.now(), maximumAgeMs = 24 * 60 * 60 * 1000) {
    const generatedAtMs = Date.parse(boardData?.generatedAt);
    const ageMs = Number.isFinite(generatedAtMs) ? now - generatedAtMs : null;
    return {
      generatedAt:boardData?.generatedAt ?? null,
      ageMs,
      maximumAgeMs,
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
    if (!health.injuryCoverageComplete || health.injuryPlayersTotal <= 0 || health.injuryPlayersChecked !== health.injuryPlayersTotal || health.injuryPlayersTotal !== health.byePlayersTotal) return "draft_board_injury_coverage_incomplete";
    if (!health.byeCoverageComplete || health.byePlayersTotal <= 0 || health.byePlayersWithBye !== health.byePlayersTotal) return "draft_board_bye_coverage_incomplete";
    return null;
  }

  root.SKRODZKaiYahooPageReaders = Object.freeze({
    normalize, textLines, parseRoom, parseRosterCount, parseRosterSlots, readOwnedTurn,
    buttonText, isAutodraftActive, isVisible, blockers, readPlayerRow, boardHealthReceipt, boardHealthGate,
  });
})(globalThis);
