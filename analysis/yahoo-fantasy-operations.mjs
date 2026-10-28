import { fileURLToPath } from "node:url";
import { lstat, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import process from "node:process";
import { createReleaseBrowser } from "./yahoo-release-browser.mjs";
import {
  TARGET, directField, findResources, findValues,
  refreshBoundAccess, parseMembership, yahooFantasyGet,
} from "./yahoo-fantasy-readonly.mjs";

const membershipPath = `/users;use_login=1/games;game_codes=nfl;seasons=2026/teams?format=json`;
const fail = code => { throw new Error(code); };
const value = (node, key) => {
  const found = findValues(node, key);
  return found.length === 1 ? found[0] : undefined;
};
const scalar = (node, key) => {
  const found = directField(node, key);
  return typeof found === "string" || typeof found === "number" ? String(found) : null;
};

// Require a present collection: a missing response must never mean "no claims"
// or "no candidates". Validate entries before resource helpers can deduplicate.
function collection(root, name, item) {
  const node = value(root, name);
  if (Array.isArray(node) && node.length === 0) return [];
  if (!node || typeof node !== "object" || Array.isArray(node)) fail(`yahoo_${name}_collection_missing`);
  const count = Number(node.count);
  const keys = Object.keys(node).filter(key => /^\d+$/.test(key));
  if (!Number.isSafeInteger(count) || count < 0 || keys.length !== count) fail(`yahoo_${name}_count_invalid`);
  return Array.from({ length: count }, (_, index) => {
    const entry = node[String(index)]?.[item];
    if (!entry || typeof entry !== "object") fail(`yahoo_${name}_entry_missing`);
    return entry;
  });
}

function exactResource(payload, field, expected) {
  const matches = findResources(payload?.fantasy_content, field)
    .filter(node => directField(node, field) === expected);
  if (matches.length !== 1) fail("yahoo_resource_identity_unverified");
  return matches[0];
}

function parseSettings(payload, membership) {
  const league = exactResource(payload, "league_key", membership.leagueKey);
  if (scalar(league, "game_code") !== TARGET.gameCode ||
      Number(scalar(league, "season")) !== TARGET.season ||
      scalar(league, "league_id") !== TARGET.leagueId) fail("yahoo_league_target_mismatch");
  const week = Number(scalar(league, "current_week"));
  if (!Number.isSafeInteger(week) || week < 1) fail("yahoo_current_week_unverified");
  const settings = value(league, "settings");
  if (!settings || typeof settings !== "object") fail("yahoo_settings_unverified");
  const rosterPositions = findValues(settings, "roster_position").map(node => {
    const position = scalar(node, "position");
    const rawCount = scalar(node, "count");
    const count = Number(rawCount);
    if (!position || rawCount === null || !Number.isSafeInteger(count) || count < 0) fail("yahoo_roster_positions_invalid");
    return { position, count };
  });
  if (!rosterPositions.length || new Set(rosterPositions.map(x => x.position)).size !== rosterPositions.length) fail("yahoo_roster_positions_invalid");
  return {
    leagueKey: membership.leagueKey, week, rosterPositions,
    rosterType: scalar(league, "roster_type"), editKey: scalar(league, "edit_key"),
    weeklyDeadline: scalar(league, "weekly_deadline"), cantCutList: scalar(settings, "cant_cut_list"),
    waiverType: scalar(settings, "waiver_type"),
    waiverRule: scalar(settings, "waiver_rule"),
    waiverTimeDays: scalar(settings, "waiver_time"),
    usesFaab: scalar(settings, "uses_faab"),
    maxAdds: scalar(settings, "max_adds"),
    maxWeeklyAdds: scalar(settings, "max_weekly_adds"),
    allowAddToIr: scalar(league, "allow_add_to_dl_extra_pos"),
    // Yahoo's waiver day/rule is not an exact release clock.
    verifiedReleaseTime: null,
  };
}

function parsePlayer(resource, gameKey) {
  const playerKey = scalar(resource, "player_key");
  if (!playerKey || !new RegExp(`^${gameKey}\\.p\\.[0-9]+$`).test(playerKey)) fail("yahoo_player_key_invalid");
  const name = directField(resource, "name")?.full;
  if (typeof name !== "string" || !name) fail("yahoo_player_name_missing");
  const selected = value(resource, "selected_position");
  const selectedWeek = scalar(selected, "week");
  const ownership = value(resource, "ownership");
  return {
    playerKey, name, displayPosition: scalar(resource, "display_position"),
    eligiblePositions: findValues(value(resource, "eligible_positions"), "position").map(String),
    selectedPosition: scalar(selected, "position"),
    selectedWeek: selectedWeek === null ? null : Number(selectedWeek),
    // Scoped to this exact player resource. Roster-level editability is insufficient.
    editable: scalar(resource, "is_editable"),
    status: scalar(resource, "status"),
    undroppable: scalar(resource, "is_undroppable"),
    ownership: scalar(ownership, "ownership_type"),
    ownerTeamKey: scalar(ownership, "owner_team_key"),
    waiverDate: scalar(ownership, "waiver_date"),
  };
}

function players(root, gameKey) {
  const list = collection(root, "players", "player").map(node => parsePlayer(node, gameKey));
  if (new Set(list.map(x => x.playerKey)).size !== list.length) fail("yahoo_player_duplicate");
  return list;
}

function parseRoster(payload, membership, week) {
  const team = exactResource(payload, "team_key", membership.teamKey);
  const roster = value(team, "roster");
  if (!roster || scalar(roster, "coverage_type") !== "week" ||
      Number(scalar(roster, "week")) !== week) fail("yahoo_roster_week_mismatch");
  const list = players(roster, membership.gameKey);
  if (!list.length || list.some(x => !x.selectedPosition || x.selectedWeek !== week)) fail("yahoo_roster_incomplete");
  return {
    teamKey: membership.teamKey, week, editable: scalar(roster, "is_editable"),
    playerLocksVerified: list.every(player => ["0", "1"].includes(player.editable)), players: list,
  };
}

function transactions(payload, membership) {
  const league = exactResource(payload, "league_key", membership.leagueKey);
  const list = collection(league, "transactions", "transaction").map(resource => {
    const transactionKey = scalar(resource, "transaction_key");
    const prefix = membership.leagueKey.replaceAll(".", "\\.");
    if (!transactionKey || !new RegExp(`^${prefix}\\.(?:tr\\.[0-9]+|w\\.c\\.[0-9]+_[0-9]+|pt\\.[0-9]+)$`).test(transactionKey)) fail("yahoo_transaction_target_mismatch");
    const playerNodes = value(resource, "players") === undefined ? [] : collection(resource, "players", "player");
    return {
      transactionKey, type: scalar(resource, "type"), status: scalar(resource, "status"),
      timestamp: scalar(resource, "timestamp"),
      players: playerNodes.map(player => {
        const playerKey = scalar(player, "player_key");
        if (!playerKey || !new RegExp(`^${membership.gameKey}\\.p\\.[0-9]+$`).test(playerKey)) fail("yahoo_player_key_invalid");
        const data = value(player, "transaction_data");
        return {
          playerKey, name: directField(player, "name")?.full ?? null,
          action: scalar(data, "type"), sourceType: scalar(data, "source_type"),
          sourceTeamKey: scalar(data, "source_team_key"),
          destinationTeamKey: scalar(data, "destination_team_key"),
        };
      }),
    };
  });
  if (new Set(list.map(x => x.transactionKey)).size !== list.length) fail("yahoo_transaction_duplicate");
  return list;
}

const targetFreshnessMs = 5 * 60 * 1000;
function validateTargetContext(packet, now = Date.now()) {
  const expiry = Date.parse(packet?.expiresAt);
  if (!Array.isArray(packet?.playerIds) || packet.playerIds.length < 1 || packet.playerIds.length > 25 ||
      packet.playerIds.some(id => typeof id !== "string" || !/^[1-9][0-9]*$/.test(id)) ||
      new Set(packet.playerIds).size !== packet.playerIds.length) fail("yahoo_target_ids_invalid");
  if (!Number.isSafeInteger(packet.expectedWeek) || packet.expectedWeek < 1 || packet.expectedWeek > 18)
    fail("yahoo_target_week_invalid");
  if (typeof packet.expiresAt !== "string" || !Number.isFinite(expiry) ||
      new Date(expiry).toISOString() !== packet.expiresAt || expiry <= now || expiry - now > targetFreshnessMs)
    fail("yahoo_target_expiry_invalid");
}

function targetPlayers(payload, membership, packet) {
  const leagueKeys = findValues(payload?.fantasy_content, "league_key");
  if (leagueKeys.length !== 1 || leagueKeys[0] !== membership.leagueKey) fail("yahoo_target_league_mismatch");
  const league = exactResource(payload, "league_key", membership.leagueKey);
  if (["game_code", "season", "league_id", "current_week"].some(field => findValues(league, field).length !== 1))
    fail("yahoo_target_period_mismatch");
  if (scalar(league, "game_code") !== TARGET.gameCode || Number(scalar(league, "season")) !== TARGET.season ||
      scalar(league, "league_id") !== TARGET.leagueId || Number(scalar(league, "current_week")) !== packet.expectedWeek)
    fail("yahoo_target_period_mismatch");
  const requested = new Set(packet.playerIds.map(id => `${membership.gameKey}.p.${id}`));
  const seen = new Set();
  const list = collection(league, "players", "player").map(resource => {
    const keys = findValues(resource, "player_key"), ids = findValues(resource, "player_id");
    const key = keys[0];
    if (keys.length !== 1 || !requested.has(key) || seen.has(key) || ids.length !== 1 ||
        String(ids[0]) !== key.split(".p.")[1]) fail("yahoo_target_player_identity_mismatch");
    // Yahoo may nest an owner's team (with its own name/status) in ownership.
    // Only direct player metadata describes this requested player's identity.
    const metadata = Array.isArray(resource) ? resource.flat(Infinity) : [resource];
    const metadataValues = field => metadata.filter(node => node && typeof node === "object" && Object.hasOwn(node, field)).map(node => node[field]);
    const names = metadataValues("name");
    if (names.length !== 1 || typeof names[0]?.full !== "string" || !names[0].full)
      fail("yahoo_target_player_identity_mismatch");
    seen.add(key);
    const ownerships = findValues(resource, "ownership");
    const ownership = ownerships[0];
    if (ownerships.length !== 1 || !ownership || typeof ownership !== "object" || Array.isArray(ownership))
      fail("yahoo_target_ownership_invalid");
    const field = (node, name, required = false) => {
      const values = findValues(node, name);
      if (values.length > 1 || required && values.length !== 1 ||
          values.length === 1 && (typeof values[0] !== "string" || !values[0])) fail("yahoo_target_ownership_invalid");
      return values[0] ?? null;
    };
    const type = field(ownership, "ownership_type", true);
    const ownerTeamKey = field(ownership, "owner_team_key");
    const ownerTeamId = field(ownership, "owner_team_id");
    const waiverDate = field(ownership, "waiver_date");
    if (waiverDate && (!/^\d{4}-\d{2}-\d{2}$/.test(waiverDate) ||
        !Number.isFinite(Date.parse(waiverDate)) || new Date(waiverDate).toISOString().slice(0, 10) !== waiverDate))
      fail("yahoo_target_ownership_invalid");
    if (!["freeagents", "waivers", "team"].includes(type) ||
        type === "team" && (!ownerTeamKey || !new RegExp(`^${membership.leagueKey.replaceAll(".", "\\.")}\\.t\\.[1-9][0-9]*$`).test(ownerTeamKey) || waiverDate) ||
        type !== "team" && (ownerTeamKey || ownerTeamId) || type === "freeagents" && waiverDate ||
        ownerTeamId && ownerTeamId !== ownerTeamKey?.split(".t.")[1])
      fail("yahoo_target_ownership_conflict");
    const player = parsePlayer(resource, membership.gameKey);
    // Status is a reported designation only; absence never clears health or locks.
    const statuses = metadataValues("status");
    if (statuses.length > 1 || statuses.length === 1 && (typeof statuses[0] !== "string" || !statuses[0]))
      fail("yahoo_target_status_invalid");
    const status = statuses[0] ?? null;
    return { playerKey: key, yahooId: String(ids[0]), name: player.name,
      displayPosition: player.displayPosition, eligiblePositions: player.eligiblePositions,
      ownership: type === "freeagents" ? "FA" : type === "waivers" ? "W" : "owned",
      ownerTeamKey, waiverDate, status };
  });
  if (seen.size !== requested.size) fail("yahoo_target_players_missing");
  return list;
}

function validateRequest(command, packet) {
  if (!["snapshot", "candidates", "targets"].includes(command)) fail("yahoo_readonly_command_required");
  if (command === "targets") validateTargetContext(packet);
  if (command === "candidates" && (!["FA", "W"].includes(packet?.status) ||
      !Number.isSafeInteger(packet?.start) || packet.start < 0 ||
      !Number.isSafeInteger(packet?.count) || packet.count < 1 || packet.count > 25 ||
      !Number.isSafeInteger(packet.start + packet.count))) fail("yahoo_page_invalid");
  if (command === "snapshot" && packet?.collectCandidates &&
      (!Number.isSafeInteger(packet.maximumPages) || packet.maximumPages < 2)) fail("yahoo_collection_bound_required");
}

export async function operate({ command, packet, transport }) {
  validateRequest(command, packet);
  const requestStartedAt = new Date().toISOString();
  if (!transport || typeof transport.get !== "function") fail("yahoo_transport_missing");
  if (typeof transport.expectedGuid !== "string" || !transport.expectedGuid.trim()) fail("yahoo_identity_binding_missing");
  const membership = parseMembership(await transport.get(membershipPath), transport.expectedGuid);
  const settings = parseSettings(await transport.get(`/league/${membership.leagueKey}/settings?format=json`), membership);
  if (command === "targets" && settings.week !== packet.expectedWeek) fail("yahoo_target_week_mismatch");
  const base = {
    verifiedAt: new Date().toISOString(), identityVerified: true, membershipVerified: true,
    target: TARGET, settings, apiReadOnly: true,
  };
  if (command === "targets") {
    validateTargetContext(packet);
    const keys = packet.playerIds.map(id => `${membership.gameKey}.p.${id}`).join(",");
    const ownershipRequestStartedAt = new Date().toISOString();
    const payload = await transport.get(`/league/${membership.leagueKey}/players;player_keys=${keys}/ownership?format=json`);
    const ownershipRequestCompletedAt = new Date().toISOString();
    const list = targetPlayers(payload, membership, packet);
    const requestCompletedAt = new Date().toISOString();
    if (Date.parse(requestCompletedAt) >= Date.parse(packet.expiresAt) ||
        Date.parse(requestCompletedAt) - Date.parse(requestStartedAt) > targetFreshnessMs) fail("yahoo_target_read_expired");
    return { ...base, verifiedAt: requestCompletedAt, requestStartedAt, requestCompletedAt,
      ownershipRequestStartedAt, ownershipRequestCompletedAt,
      expiresAt: packet.expiresAt, maximumAgeSeconds: targetFreshnessMs / 1000,
      expectedWeek: packet.expectedWeek, requestedPlayerIds: packet.playerIds, players: list,
      transactionReady: false, posture: "OWNERSHIP_READ_ONLY_FRESH_EXECUTION_PREFLIGHT_REQUIRED" };
  }
  if (command === "candidates") {
    const { status, start, count } = packet;
    const payload = await transport.get(`/league/${membership.leagueKey}/players;status=${status};start=${start};count=${count}/ownership?format=json`);
    const list = players(exactResource(payload, "league_key", membership.leagueKey), membership.gameKey);
    if (list.length > count || list.some(x => x.ownerTeamKey ||
        x.ownership !== (status === "FA" ? "freeagents" : "waivers"))) fail("yahoo_candidate_page_unverified");
    return { ...base, verifiedAt: new Date().toISOString(), status, start, count, nextStart: list.length === count ? start + count : null, players: list };
  }
  const roster = parseRoster(await transport.get(`/team/${membership.teamKey}/roster;week=${settings.week}?format=json`), membership, settings.week);
  const pending = transactions(await transport.get(`/league/${membership.leagueKey}/transactions;types=waiver,pending_trade;team_key=${membership.teamKey};count=100?format=json`), membership);
  if (pending.length >= 100) fail("yahoo_pending_claims_incomplete");
  const completedRecent = transactions(await transport.get(`/league/${membership.leagueKey}/transactions;count=25?format=json`), membership);
  const raw = { ...base, verifiedAt: new Date().toISOString(), roster, pending, completedRecent, completedRecentLimit: 25 };
  if (packet?.collectCandidates) {
    const pool = await collectCandidatePool({ maximumPages: packet.maximumPages,
      readPage: page => operate({ command: "candidates", packet: page, transport }) });
    return { ...raw, candidatePool: pool };
  }
  return raw;
}

/** Bounded exhaustive traversal through the EXISTING FA/W read operation/GET shape. */
export async function collectCandidatePool({ readPage, maximumPages }) {
  if (typeof readPage !== "function" || !Number.isSafeInteger(maximumPages) || maximumPages < 2) fail("yahoo_collection_bound_required");
  const pages = [], all = [], seen = new Set();
  let calls = 0, target, week, settings;
  for (const status of ["FA", "W"]) {
    let start = 0;
    do {
      if (calls >= maximumPages) fail("yahoo_candidate_collection_incomplete");
      const page = await readPage({ status, start, count: 25 });
      calls += 1;
      if (page?.apiReadOnly !== true || page.identityVerified !== true || page.membershipVerified !== true ||
          page.target?.season !== TARGET.season || page.target.leagueId !== TARGET.leagueId || page.target.teamId !== TARGET.teamId ||
          page.status !== status || page.start !== start || page.count !== 25 || !Array.isArray(page.players) || page.players.length > 25 ||
          !Number.isFinite(Date.parse(page.verifiedAt))) fail("yahoo_candidate_page_unverified");
      target ??= page.target; week ??= page.settings?.week; settings ??= JSON.stringify(page.settings);
      if (page.settings?.week !== week || JSON.stringify(page.settings) !== settings || JSON.stringify(page.target) !== JSON.stringify(target))
        fail("yahoo_candidate_settings_changed");
      const expectedNext = page.players.length === 25 ? start + 25 : null;
      if (page.nextStart !== expectedNext) fail("yahoo_candidate_pagination_gap");
      for (const player of page.players) {
        if (!player?.playerKey || seen.has(player.playerKey) || player.ownerTeamKey ||
            player.ownership !== (status === "FA" ? "freeagents" : "waivers")) fail("yahoo_candidate_duplicate_or_ownership_changed");
        seen.add(player.playerKey); all.push({ ...player, availability: status });
      }
      pages.push({ status, start, count: 25, returned: page.players.length, nextStart: page.nextStart, verifiedAt: page.verifiedAt });
      start = expectedNext;
    } while (start !== null);
  }
  return { target, week, settings: JSON.parse(settings), players: all, pages, complete: true,
    capturedAt: pages.at(-1).verifiedAt, earliestCapturedAt: pages[0].verifiedAt, apiReadOnly: true };
}

const slotEligibility = (position) => ({ "W/R/T": ["WR", "RB", "TE"], "W/R": ["WR", "RB"],
  "Q/W/R/T": ["QB", "WR", "RB", "TE"], D: ["DL", "LB", "DB", "D"], DB: ["DB", "S", "CB"],
  DL: ["DL", "DE", "DT"], LB: ["LB"], QB: ["QB"], RB: ["RB", "FB"], WR: ["WR"], TE: ["TE"], K: ["K"], DEF: ["DEF"] })[position];

/** Bridge read-only facts; missing facts stay null/HOLD. Supplements are exact verified readbacks. */
export function toPlannerSnapshot(raw, pool, { report, expiresAt, verifiedSupplement = null } = {}, now = Date.now()) {
  const holds = [], transactionHolds = [];
  // Snapshot freshness is bounded by the OLDEST read, never renewed by the final pool page.
  const capturedAt = raw?.verifiedAt;
  if (raw?.identityVerified !== true || raw.membershipVerified !== true || raw.apiReadOnly !== true ||
      raw.target?.season !== TARGET.season || raw.target.leagueId !== TARGET.leagueId || raw.target.teamId !== TARGET.teamId ||
      !Array.isArray(raw.roster?.players) || raw.roster.teamKey?.split(".t.").at(-1) !== TARGET.teamId ||
      !Number.isFinite(Date.parse(raw.verifiedAt)) || Date.parse(raw.verifiedAt) > now ||
      !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now || Date.parse(expiresAt) <= Date.parse(capturedAt))
    fail("yahoo_planner_readback_invalid");
  const supplement = verifiedSupplement;
  if (supplement && (supplement.source !== "YAHOO_VERIFIED_READBACK" || supplement.verified !== true ||
      supplement.season !== TARGET.season || String(supplement.leagueId) !== TARGET.leagueId || String(supplement.teamId) !== TARGET.teamId ||
      supplement.week !== raw.settings.week || !Number.isFinite(Date.parse(supplement.capturedAt)) ||
      Date.parse(supplement.capturedAt) < Date.parse(raw.verifiedAt) || Date.parse(supplement.capturedAt) > now ||
      !Number.isFinite(Date.parse(supplement.expiresAt)) || Date.parse(supplement.expiresAt) <= now || Date.parse(supplement.expiresAt) < Date.parse(expiresAt)))
    fail("yahoo_planner_supplement_invalid");
  const slots = [], idsByPosition = new Map();
  for (const { position, count } of raw.settings.rosterPositions) {
    if (["BN", "IR"].includes(position)) continue;
    const eligible = slotEligibility(position);
    if (!eligible) { holds.push(`UNKNOWN_SLOT_${position}`); continue; }
    const ids = Array.from({ length: count }, (_, i) => count === 1 ? position : `${position}${i + 1}`);
    idsByPosition.set(position, ids);
    for (const id of ids) slots.push({ id, eligible });
  }
  const usedSlots = new Map();
  const claimsKnown = Array.isArray(raw.pending);
  if (!claimsKnown || raw.pending.length) transactionHolds.push("PENDING_CLAIMS_OR_TRADE_REQUIRES_RECONCILIATION");
  let poolClocksVerified = Array.isArray(pool?.pages) && pool.pages.length >= 2 &&
    pool.earliestCapturedAt === pool.pages[0].verifiedAt && pool.capturedAt === pool.pages.at(-1).verifiedAt;
  let previousClock = Date.parse(raw.verifiedAt);
  const expectedStarts = { FA: 0, W: 0 }, terminal = new Set();
  for (const page of pool?.pages ?? []) {
    const stamp = Date.parse(page.verifiedAt);
    if (!Number.isFinite(stamp) || stamp < previousClock || stamp > now || !["FA", "W"].includes(page.status) ||
        terminal.has(page.status) || page.start !== expectedStarts[page.status] || page.count !== 25 ||
        !Number.isSafeInteger(page.returned) || page.returned < 0 || page.returned > 25 ||
        page.nextStart !== (page.returned === 25 ? page.start + 25 : null)) poolClocksVerified = false;
    previousClock = stamp;
    if (page.nextStart == null) terminal.add(page.status);
    else expectedStarts[page.status] = page.nextStart;
  }
  poolClocksVerified &&= terminal.has("FA") && terminal.has("W");
  const candidatePoolVerified = pool?.complete === true && pool.apiReadOnly === true && poolClocksVerified && Array.isArray(pool.players) && pool.week === raw.settings.week &&
    JSON.stringify(pool.target) === JSON.stringify(raw.target) && JSON.stringify(pool.settings) === JSON.stringify(raw.settings);
  if (!candidatePoolVerified) transactionHolds.push("FULL_FA_W_COLLECTION_UNVERIFIED");
  const extraPlayers = new Map((supplement?.players ?? []).map(player => [String(player.yahooId), player]));
  if (extraPlayers.size !== (supplement?.players ?? []).length) fail("yahoo_planner_supplement_duplicate");
  const excludedAvailable = [];
  const convert = (player, available) => {
    const yahooId = player.playerKey?.split(".p.").at(-1);
    if (!/^\d+$/.test(yahooId) || !Array.isArray(player.eligiblePositions) || !player.eligiblePositions.length) fail("yahoo_planner_player_invalid");
    const extra = extraPlayers.get(yahooId);
    const currentRow = report?.weeks?.find(week => week.targetWeek === raw.settings.week)?.players?.find(row => String(row.playerId) === yahooId);
    let locked = ["0", "1"].includes(player.editable) ? player.editable === "0" : null;
    let lockBasis = locked == null ? null : "EXACT_YAHOO_PLAYER_IS_EDITABLE";
    if (locked == null && typeof extra?.locked === "boolean" && typeof extra.lockBasis === "string" && extra.lockBasis) {
      locked = extra.locked; lockBasis = extra.lockBasis;
    }
    if (available && locked == null && raw.roster.editable === "1") {
      if (currentRow?.scheduleStatus === "VERIFIED_GAME" && Number.isFinite(Date.parse(currentRow.kickoff)) && Date.parse(currentRow.kickoff) > now) {
        locked = false; lockBasis = "FUTURE_VERIFIED_SAME_WEEK_KICKOFF_WITH_CURRENT_EDITABLE_ROSTER";
      }
    }
    if (locked == null && !available) holds.push(`PLAYER_LOCK_UNKNOWN_${yahooId}`);
    const position = player.selectedPosition;
    const occurrence = usedSlots.get(position) ?? 0;
    if (!available) usedSlots.set(position, occurrence + 1);
    const slot = available ? "BN" : ["BN", "IR"].includes(position) ? position : idsByPosition.get(position)?.[occurrence] ?? null;
    const dropSupported = !available && raw.roster.editable === "1" && player.editable === "1" && player.undroppable === "0" &&
      raw.settings.cantCutList === "none" && claimsKnown && raw.pending.length === 0 && slot !== "IR";
    const droppable = available ? null : dropSupported ? true : player.undroppable === "1" || slot === "IR" || locked === true ? false :
      typeof extra?.droppable === "boolean" && extra.dropBasis ? extra.droppable : null;
    if (!available && droppable == null) transactionHolds.push(`DROP_LEGALITY_UNKNOWN_${yahooId}`);
    // A verified current bye can be valued for future weeks without inventing a current
    // lineup-lock fact. This exact candidate is research only, never an approval proposal.
    const futureOnlyResearch = available && locked == null && currentRow?.scheduleStatus === "VERIFIED_BYE" && currentRow.bye === true;
    const conditionalExpiresAt = available && player.availability === "W" ? extra?.conditionalExpiresAt ?? expiresAt : null;
    if (available && (locked == null && !futureOnlyResearch || player.availability === "W" &&
        (!Number.isFinite(Date.parse(conditionalExpiresAt)) || Date.parse(conditionalExpiresAt) <= now))) {
      excludedAvailable.push({ yahooId, reason: locked == null ? "CANDIDATE_LINEUP_LOCK_UNKNOWN" : "WAIVER_CONDITION_EXPIRY_UNKNOWN" });
      return null;
    }
    return { yahooId, name: player.name, eligible: player.eligiblePositions, slot, ownership: available ? "UNOWNED" : "OWNED",
      injuryStatus: player.status, injuryMeaning: player.status == null ? "NO_YAHOO_DESIGNATION_NOT_OFFICIAL_CLEARANCE" : "YAHOO_DESIGNATION",
      locked, lockBasis, futureOnlyResearch, droppable, dropBasis: dropSupported ? "EDITABLE_PLAYER_UNDROPPABLE_0_NO_CANT_CUT_LIST_NO_PENDING_NON_IR_ADVISORY" : extra?.dropBasis ?? null,
      availability: available ? player.availability : null, conditionalExpiresAt, waiverDate: player.waiverDate };
  };
  const roster = raw.roster.players.map(player => convert(player, false));
  const available = candidatePoolVerified ? pool.players.map(player => convert(player, true)).filter(Boolean) : [];
  if (raw.settings.waiverType == null || raw.settings.waiverRule == null || raw.settings.usesFaab == null)
    transactionHolds.push("LEAGUE_ACQUISITION_RULES_UNKNOWN");
  // Absent fields, zero and negative sentinels have no inferred unlimited meaning. Remaining
  // acquisition capacity requires a separately verified league/team rule readback.
  if (supplement?.addCapacityVerified !== true || typeof supplement.addCapacityBasis !== "string" || !supplement.addCapacityBasis.trim())
    transactionHolds.push("LEAGUE_ADD_LIMIT_OR_REMAINING_CAPACITY_UNKNOWN");
  const result = { source: "YAHOO_VERIFIED_READBACK", season: TARGET.season, leagueId: TARGET.leagueId, teamId: TARGET.teamId,
    week: raw.settings.week, capturedAt, expiresAt, fullRosterVerified: true, availableVerified: candidatePoolVerified,
    slots, roster, available, excludedAvailable, planningHolds: [...new Set(holds)], transactionHolds,
    sourceFacts: { rosterCapturedAt: raw.verifiedAt,
      poolEarliestCapturedAt: pool?.earliestCapturedAt ?? null, poolPages: pool?.pages ?? null, settings: raw.settings,
      pendingVerified: claimsKnown, pending: raw.pending, supplementalReadback: supplement,
      repeatedSlotIds: "OCCURRENCE_IDS_WITHIN_EQUIVALENT_YAHOO_POSITION_SLOTS" },
    posture: "ADVISORY_CANDIDATE_NO_TRANSACTION_AUTHORITY_FRESH_EXECUTION_PREFLIGHT_REQUIRED" };
  if (report && (report.season !== result.season || report.targetWeek !== result.week)) fail("yahoo_planner_report_period_mismatch");
  return result;
}

// add:<id>:<slot> | drop:<id> | move:<id>:<slot> | keep:<id>, comma-separated, one token per player.
export function parseDeltaSpec(spec) {
  const changes = typeof spec === "string" && spec ? spec.split(",").map(token => {
    const match = /^(?:(add|move):([1-9][0-9]*):([A-Z/]+)|(drop|keep):([1-9][0-9]*))$/.exec(token);
    if (!match) fail("yahoo_delta_spec_invalid");
    return { kind: match[1] ?? match[4], id: match[2] ?? match[5], slot: match[3] ?? null };
  }) : fail("yahoo_delta_spec_invalid");
  if (new Set(changes.map(change => change.id)).size !== changes.length) fail("yahoo_delta_spec_invalid");
  return changes;
}

// Identity comes from the exact keys, not only from the saved verification flags.
function deltaRoster(raw, now) {
  const team = /^([1-9][0-9]*)\.l\.([0-9]+)\.t\.([0-9]+)$/.exec(raw?.roster?.teamKey ?? "");
  const verifiedMs = Date.parse(raw?.verifiedAt), week = raw?.settings?.week;
  if (raw?.apiReadOnly !== true || raw.identityVerified !== true || raw.membershipVerified !== true ||
      raw.target?.gameCode !== TARGET.gameCode || raw.target.season !== TARGET.season ||
      raw.target.leagueId !== TARGET.leagueId || raw.target.teamId !== TARGET.teamId ||
      !team || team[2] !== TARGET.leagueId || team[3] !== TARGET.teamId ||
      raw.settings.leagueKey !== `${team[1]}.l.${TARGET.leagueId}` ||
      !Number.isSafeInteger(week) || week < 1 || raw.roster.week !== week ||
      !Number.isFinite(verifiedMs) || new Date(verifiedMs).toISOString() !== raw.verifiedAt || verifiedMs > now ||
      !Array.isArray(raw.settings.rosterPositions) || !Array.isArray(raw.roster.players) || !raw.roster.players.length)
    fail("yahoo_delta_snapshot_invalid");
  const positions = new Map();
  for (const { position, count } of raw.settings.rosterPositions) {
    if (typeof position !== "string" || !position || positions.has(position) || !Number.isSafeInteger(count) || count < 0)
      fail("yahoo_delta_snapshot_invalid");
    positions.set(position, count);
  }
  const playerKey = new RegExp(`^${team[1]}\\.p\\.([1-9][0-9]*)$`), byId = new Map();
  for (const player of raw.roster.players) {
    const id = playerKey.exec(player?.playerKey ?? "")?.[1];
    if (!id || byId.has(id) || !positions.has(player.selectedPosition)) fail("yahoo_delta_snapshot_invalid");
    byId.set(id, player);
  }
  return { gameKey: team[1], teamKey: raw.roster.teamKey, week, verifiedMs, positions, byId };
}

/**
 * Offline comparison of two saved snapshots; every unlisted player must keep its exact slot.
 * PASS proves only that saved-roster comparison. It is not a preflight, freshness or execution clearance.
 */
export function verifyRosterDelta(before, after, changes, now = Date.now()) {
  const prior = deltaRoster(before, now), current = deltaRoster(after, now);
  const was = prior.byId, is = current.byId, listed = new Map(changes.map(change => [change.id, change]));
  const mismatches = [];
  if (prior.teamKey !== current.teamKey) mismatches.push("team_changed");
  if (prior.week !== current.week) mismatches.push("week_changed");
  if (current.verifiedMs <= prior.verifiedMs) mismatches.push("after_not_later");
  // FA-only release packages expect no claims; a missing collection is unknown, not empty.
  if (!Array.isArray(after.pending)) mismatches.push("pending_unknown");
  else if (after.pending.length) mismatches.push("pending_not_empty");
  for (const { kind, id, slot } of changes) {
    if (slot && !current.positions.has(slot)) { mismatches.push(`unknown_slot:${id}:${slot}`); continue; }
    const from = was.get(id)?.selectedPosition, to = is.get(id)?.selectedPosition;
    const ok = kind === "add" ? !was.has(id) && to === slot
      : kind === "drop" ? was.has(id) && !is.has(id)
      : kind === "move" ? was.has(id) && from !== slot && to === slot
      : was.has(id) && is.has(id) && from === to;
    if (!ok) mismatches.push(`${kind}_unverified:${id}:${from ?? "absent"}>${to ?? "absent"}`);
  }
  for (const id of new Set([...was.keys(), ...is.keys()])) {
    if (listed.has(id)) continue;
    if (!is.has(id)) mismatches.push(`unexpected_drop:${id}`);
    else if (!was.has(id)) mismatches.push(`unexpected_add:${id}`);
    else if (was.get(id).selectedPosition !== is.get(id).selectedPosition) mismatches.push(`unexpected_slot_change:${id}`);
  }
  // A server time is attributed only to one in-window transaction that matches this exact add.
  // Older or unmatched records are reported as uncorroborated, never as this change's receipt.
  const recent = Array.isArray(after.completedRecent) ? after.completedRecent : null;
  const drops = new Set(changes.filter(change => change.kind === "drop").map(change => change.id));
  const idOf = key => new RegExp(`^${current.gameKey}\\.p\\.([1-9][0-9]*)$`).exec(key ?? "")?.[1] ?? null;
  const windowStart = Math.floor(prior.verifiedMs / 1000), windowEnd = Math.floor(current.verifiedMs / 1000);
  const claimedDrops = new Set();
  const addTransactions = changes.filter(change => change.kind === "add").map(({ id }) => {
    if (!recent) return { id, corroboration: "UNKNOWN_RECENT_UNAVAILABLE" };
    const matches = recent.filter(transaction => Array.isArray(transaction?.players) && transaction.players.some(player =>
      idOf(player?.playerKey) === id && player.action === "add" && player.destinationTeamKey === current.teamKey));
    const seconds = transaction => /^[0-9]+$/.test(transaction.timestamp ?? "") ? Number(transaction.timestamp) : NaN;
    const inWindow = matches.filter(transaction => seconds(transaction) >= windowStart && seconds(transaction) <= windowEnd);
    const priorKeys = matches.filter(transaction => !inWindow.includes(transaction)).map(transaction => transaction.transactionKey ?? null);
    if (!inWindow.length) return { id, corroboration: priorKeys.length ? "UNCORROBORATED_PRIOR_RECORD_ONLY" : "UNCORROBORATED_NOT_IN_RECENT", priorKeys };
    const transaction = inWindow[0], adds = transaction.players.filter(player => player?.action === "add");
    const dropped = transaction.players.filter(player => player?.action === "drop");
    const reasons = [];
    if (inWindow.length > 1) reasons.push("ambiguous");
    if (!new RegExp(`^${current.gameKey}\\.l\\.${TARGET.leagueId}\\.tr\\.[0-9]+$`).test(transaction.transactionKey ?? "")) reasons.push("key");
    if (transaction.status !== "successful") reasons.push("status");
    if (adds.length !== 1 || adds[0].sourceType !== "freeagents") reasons.push("source");
    if (transaction.players.length !== adds.length + dropped.length) reasons.push("players");
    for (const player of dropped) {
      const dropId = idOf(player.playerKey);
      if (player.sourceTeamKey !== current.teamKey || !drops.has(dropId) || claimedDrops.has(dropId)) reasons.push("drop");
      claimedDrops.add(dropId);
    }
    if (reasons.length) {
      mismatches.push(`add_transaction_mismatch:${id}:${[...new Set(reasons)].join("+")}`);
      return { id, corroboration: "MISMATCH", transactionKey: transaction.transactionKey ?? null, priorKeys };
    }
    return { id, corroboration: "CORROBORATED", transactionKey: transaction.transactionKey, type: transaction.type,
      serverTime: new Date(seconds(transaction) * 1000).toISOString(), dropped: dropped.map(player => idOf(player.playerKey)), priorKeys };
  });
  // Every expected drop must be attributed to a corroborated add. While one is not, an add whose
  // transaction dropped nobody cannot claim it, so it is reported as unattributed with no server time.
  const unattributedDrops = [...drops].filter(dropId => !claimedDrops.has(dropId));
  if (unattributedDrops.length) for (const entry of addTransactions) {
    if (entry.corroboration !== "CORROBORATED" || entry.dropped.length) continue;
    entry.corroboration = "UNCORROBORATED_DROP_UNATTRIBUTED"; delete entry.serverTime;
  }
  const emptyStarterSlots = [...current.positions].filter(([position]) => !["BN", "IR"].includes(position))
    .flatMap(([position, count]) => Array(Math.max(0, count - [...is.values()].filter(player => player.selectedPosition === position).length)).fill(position));
  return { verdict: mismatches.length ? "FAIL" : "PASS", mismatches, week: current.week,
    beforeVerifiedAt: before.verifiedAt, afterVerifiedAt: after.verifiedAt, afterAgeSeconds: Math.round((now - current.verifiedMs) / 1000),
    playerCount: is.size, pendingCount: Array.isArray(after.pending) ? after.pending.length : null, emptyStarterSlots,
    players: changes.map(({ id }) => {
      const player = is.get(id);
      return player ? { id, name: player.name, slot: player.selectedPosition, editable: player.editable,
        undroppable: player.undroppable, status: player.status, eligible: player.eligiblePositions } : { id, slot: null };
    }),
    addTransactions, unattributedDrops, offline: true, posture: "SAVED_ROSTER_COMPARISON_ONLY_NOT_PREFLIGHT_OR_EXECUTION_CLEARANCE" };
}

// Offline bounded recovery protocol. The coordinator pins the canonical mounted
// ledger/anchor and records Joe's actual delegation BEFORE the initial attempt.
// No local packet/boolean creates approval; absent canonical records mean HOLD.
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const recoveryHold = reason => ({ verdict: "HOLD", reason, offline: true, transactionReady: false });
const isoClock = text => typeof text === "string" && Number.isFinite(Date.parse(text)) && new Date(text).toISOString() === text ? Date.parse(text) : NaN;
const recoveryMarker = "```yahoo-recovery-record\n";
// Observed Yahoo DEF identities use team links, not numeric player links.
// These exact public ID/name/slug triples cover this package; unknown DEFs HOLD.
const recoveryDefenseTeams = new Map([
  ["100020", { name: "Jets", slug: "ny-jets" }],
  ["100030", { name: "Jaguars", slug: "jacksonville" }],
]);
// Exact row boundaries come from snapshot indentation, not substring matches.
// Returns only identity-linked rows; extra/unknown identities remain visible to
// the one-to-one comparison rather than disappearing from the UI evidence.
export function parseRecoveryRosterRows(snapshot) {
  if (typeof snapshot !== "string") return null;
  const lines = snapshot.split("\n"), rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    const header = /^( *)- row(?: |:|$)/.exec(lines[i]);
    if (!header) continue;
    const indent = header[1].length;
    let end = i + 1;
    while (end < lines.length && lines[end].trim() && /^ */.exec(lines[end])[0].length > indent) end += 1;
    const blockLines = lines.slice(i, end), block = blockLines.join("\n");
    if (blockLines.slice(1).some(line => /^ *- row(?: |:|$)/.test(line))) return null;
    if (!/\/(?:nfl\/)?(?:players|teams)\//.test(block)) { i = end - 1; continue; }
    const links = [];
    for (let j = 0; j < blockLines.length - 1; j += 1) {
      const link = /^( *)- link ("(?:[^"\\]|\\.)*"):$/.exec(blockLines[j]);
      const url = /^( *)- \/url: (\S+)$/.exec(blockLines[j + 1]);
      if (link && url && url[1].length === link[1].length + 2 && /^https:\/\/sports\.yahoo\.com\/nfl\/(?:players|teams)\//.test(url[2])) {
        try { links.push({ name: JSON.parse(link[2]), url: url[2] }); } catch { return null; }
      }
    }
    const firstCellIndex = blockLines.findIndex(line => /^ */.exec(line)[0].length === indent + 2 && line.trimStart().startsWith("- cell"));
    let cellEnd = firstCellIndex + 1;
    while (cellEnd < blockLines.length && /^ */.exec(blockLines[cellEnd])[0].length > indent + 2) cellEnd += 1;
    rows.push({ block, links, firstCell: blockLines[firstCellIndex]?.trimStart(),
      slotChildren: firstCellIndex < 0 ? [] : blockLines.slice(firstCellIndex + 1, cellEnd).map(line => line.trimStart()) });
    i = end - 1;
  }
  return rows;
}

export const recoveryRecord = record => `${recoveryMarker}${JSON.stringify(record)}\n\x60\x60\x60\n`;

// Read only explicitly named regular evidence files. No directories, symlinks,
// secret-shaped names or automatic path repair/alternative reads.
async function recoveryBytes(path) {
  if (typeof path !== "string" || path.includes("\0") || /auth|credentials|secret/i.test(path))
    fail("yahoo_recovery_evidence_invalid");
  let current = resolve(path);
  while (true) {
    if ((await lstat(current)).isSymbolicLink()) fail("yahoo_recovery_evidence_invalid");
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  const info = await stat(path);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) fail("yahoo_recovery_evidence_invalid");
  return readFile(path);
}
async function recoveryFile(descriptor) {
  if (!/^[a-f0-9]{64}$/.test(descriptor?.sha256 ?? "")) fail("yahoo_recovery_evidence_invalid");
  const bytes = await recoveryBytes(descriptor.path);
  if (digest(bytes) !== descriptor.sha256) fail("yahoo_recovery_evidence_invalid");
  return bytes;
}

/** Evaluates saved evidence only; CHECK is required after normal anchored append.
 * The caller must supply the ORIGINAL job's trusted canonical path/anchor, never
 * an input-selected substitute or a freshly minted anchor after a conflict.
 */
export async function recoveryGate(packet, now = Date.now()) {
  const hold = reason => recoveryHold(reason);
  if (!["reserve", "check"].includes(packet?.phase) || !packet.rootId || !packet.jobId || !packet.executor ||
      !Number.isFinite(isoClock(packet.requestedAt)) || isoClock(packet.requestedAt) > now || now - isoClock(packet.requestedAt) > targetFreshnessMs)
    return hold("REQUEST_UNKNOWN");
  const anchor = packet.anchor;
  if (basename(anchor?.path ?? "") !== "decision-log.md" || basename(dirname(anchor?.path ?? "")) !== "operations" ||
      !Number.isSafeInteger(anchor?.bytes) || anchor.bytes < 1 || typeof anchor.lastLine !== "string") return hold("ANCHOR_UNKNOWN");
  // Check phase reads the exact appended image with the original prefix pin.
  const ledger = await recoveryFile({ path: anchor.path, sha256: packet.phase === "check" ? packet.reservedLedgerSha256 : anchor.sha256 });
  const prefix = ledger.subarray(0, anchor.bytes), text = prefix.toString("utf8");
  if (prefix.length !== anchor.bytes || digest(prefix) !== anchor.sha256 || !text.endsWith("\n") ||
      text.slice(0, -1).split("\n").at(-1) !== anchor.lastLine || packet.phase === "reserve" && ledger.length !== anchor.bytes)
    return hold("ANCHOR_CONFLICT");
  const records = [];
  for (const part of text.split(recoveryMarker).slice(1)) {
    const end = part.indexOf("\n```\n");
    if (end < 0) return hold("LEDGER_UNKNOWN");
    try { records.push(JSON.parse(part.slice(0, end))); } catch { return hold("LEDGER_UNKNOWN"); }
  }
  if (records.some(r => r.type === "RECOVERY_JOB_STOP" && r.jobId === packet.jobId)) return hold("JOB_STOPPED");
  const scoped = records.filter(r => r.rootId === packet.rootId);
  const roots = scoped.filter(r => r.type === "RECOVERY_DELEGATED");
  if (roots.length !== 1) return hold("DELEGATION_UNKNOWN");
  const root = roots[0], action = root.action;
  const actionKey = a => a?.kind === "add_drop" ? [a.kind, a.addId, a.dropId, a.slot]
    : a?.kind === "lineup_change" ? [a.kind, a.playerId, a.from, a.to] : null;
  if (records.some(r => r.jobId === packet.jobId && r.rootId !== packet.rootId && r.action &&
      same(actionKey(r.action), actionKey(action)))) return hold("ACTION_JOB_ALREADY_RECORDED");
  const conditions = ["stop", "access", "ownership", "claimsTrades", "retainedSlots", "dropSlotLegality", "eligibilityIRCapacityLimits", "officialHealthRole", "trigger", "individualLocks"];
  if (root.jobId !== packet.jobId || root.executor !== packet.executor || root.approvedBy !== "Joe" || root.status !== "DELEGATED_TO_MODELS" ||
      root.season !== TARGET.season || root.leagueId !== TARGET.leagueId || root.teamId !== TARGET.teamId ||
      !Number.isSafeInteger(root.week) || root.week < 1 || root.week > 18 || !root.id ||
      !root.approvalSource?.reference || !root.policyAdoptionReference || !root.policySha256 ||
      !Number.isFinite(isoClock(root.expiresAt)) || !Number.isFinite(isoClock(root.approvedAt)) || isoClock(root.approvedAt) > isoClock(packet.requestedAt) ||
      !Number.isSafeInteger(root.minimumCompletionAndVerificationMs) || root.minimumCompletionAndVerificationMs <= 0 ||
      root.recoveryBudget?.additional !== 1 || root.recoveryBudget?.total !== 2 ||
      root.recoveryBudget.attemptId !== `${root.rootId}-recovery-1` ||
      !same(packet.action, action) || !conditions.every(key => Object.hasOwn(root.conditions ?? {}, key) && root.conditions[key] != null && typeof root.conditions[key] !== "boolean"))
    return hold("DELEGATION_UNKNOWN");
  // No alternate option, clock extension, job/executor change, or implicit child budget.
  const stops = scoped.filter(r => r.type === "RECOVERY_INITIAL_STOP");
  const corrections = scoped.filter(r => r.type === "RECOVERY_CORRECTION_ADOPTED");
  if (scoped.some(r => !["RECOVERY_DELEGATED", "RECOVERY_INITIAL_STOP", "RECOVERY_CORRECTION_ADOPTED"].includes(r.type)))
    return hold("BUDGET_OR_TERMINAL_STATE");
  if (stops.length !== 1 || corrections.length !== 1) return hold("COUNTER_OR_CORRECTION_UNKNOWN");
  const stopped = stops[0], correction = corrections[0];
  if (stopped.jobId !== root.jobId || stopped.attemptId !== root.rootId || stopped.attempts !== 1 ||
      !/^[a-f0-9]{64}$/.test(stopped.factorySha256 ?? "") || stopped.recoveryUsed !== 0 || stopped.status !== "PRE_FINAL_TECHNICAL_STOP" ||
      isoClock(stopped.startedAt) < isoClock(root.approvedAt) || !Number.isFinite(isoClock(stopped.startedAt)))
    return hold("COUNTER_OR_TERMINAL_STATE");
  const evidence = packet.evidence;
  if (!evidence || !["approval", "policy", "baseline", "current", "trace", "ui", "preflight", "targets", "factory"].every(key => evidence[key]))
    return hold("EVIDENCE_UNKNOWN");
  const files = {};
  for (const key of Object.keys(evidence)) files[key] = await recoveryFile(evidence[key]);
  if (evidence.approval.sha256 !== root.approvalSource.sha256 || evidence.policy.sha256 !== root.policySha256 ||
      evidence.baseline.sha256 !== stopped.baselineSha256 || evidence.trace.sha256 !== stopped.traceSha256)
    return hold("EVIDENCE_BINDING_UNKNOWN");
  let baseline, current, trace, ui, preflight, targets;
  try { [baseline, current, trace, ui, preflight, targets] = ["baseline", "current", "trace", "ui", "preflight", "targets"].map(key => JSON.parse(files[key])); }
  catch { return hold("EVIDENCE_UNKNOWN"); }
  const fresh = stamp => Number.isFinite(isoClock(stamp)) && isoClock(stamp) <= isoClock(packet.requestedAt) && now - isoClock(stamp) <= targetFreshnessMs && isoClock(stamp) >= isoClock(trace.t1);
  if (trace.click !== null || trace.finalActionMayHaveOccurred !== false || trace.alarmCount !== 0 || !same(trace.alarms, []) ||
      trace.v !== stopped.factoryVersion || trace.t0 !== stopped.startedAt || !Number.isFinite(isoClock(trace.t1)) || isoClock(trace.t1) < isoClock(trace.t0) ||
      trace.err != null)
    return hold("NO_SUBMISSION_UNPROVED");
  const kind = action?.kind === "add_drop" ? "stage" : action?.kind === "lineup_change" ? "start" : null;
  const sequence = kind === "stage" ? ["stage.navigate", "stage.wait-form", "stage.snapshot-form", "stage.locate-drop", "stage.select-drop", "stage.wait-confirmation", "stage.snapshot-confirmation"]
    : ["start.navigate", "start.wait-source", "start.snapshot-source", "start.select-source", "start.wait-destination", "start.snapshot-destination"];
  const entries = trace.trace, last = entries?.at(-1);
  let clock = isoClock(trace.t0);
  if (!kind || !Array.isArray(entries) || entries.length < 2 || entries.length > sequence.length || entries.some((entry, i) => {
    const start = isoClock(entry.startedAt), end = isoClock(entry.finishedAt);
    const invalid = entry.name !== sequence[i] || !Number.isFinite(start) || !Number.isFinite(end) || start < clock || end < start || end > isoClock(trace.t1) ||
      entry.outcome !== "completed";
    clock = end; return invalid;
  })) return hold("TRACE_UNKNOWN");
  const failures = {
    STOP_DROP_ROW_NOT_EXACT: ["stage.locate-drop", "PRE_FINAL_LOCATOR_COUNT_MISMATCH"],
    STOP_CONFIRMATION_MISMATCH: ["stage.snapshot-confirmation", "PRE_FINAL_RENDER_MISMATCH"],
    STOP_SOURCE_NOT_ON_BN: ["start.snapshot-source", "PRE_FINAL_RENDER_MISMATCH"],
    STOP_DESTINATION_NOT_EXACT_EMPTY_SLOT: ["start.snapshot-destination", "PRE_FINAL_RENDER_MISMATCH"],
  };
  const leagueUrl = `https://football.fantasysports.yahoo.com/f1/${root.leagueId}/`;
  const teamUrl = `${leagueUrl}${root.teamId}`;
  if (typeof trace.url !== "string" || !(kind === "stage" ? trace.url.startsWith(leagueUrl)
      : trace.url === teamUrl || trace.url.startsWith(`${teamUrl}?`)) ||
      kind === "stage" && last.name === "stage.snapshot-confirmation" &&
        (typeof trace.confirmUrl !== "string" || !trace.confirmUrl.startsWith(leagueUrl)))
    return hold("TRACE_CONTEXT_UNKNOWN");
  const eligibleFailure = failures[trace.result];
  if (!eligibleFailure || !same([trace.failure?.operation, trace.failure?.category], eligibleFailure) ||
      last.name !== trace.failure.operation || trace.result === "STOP_DROP_ROW_NOT_EXACT" && (!Number.isSafeInteger(trace.dropRows) || trace.dropRows === 1))
    return hold("TRACE_UNKNOWN");
  if (correction.jobId !== root.jobId || correction.traceSha256 !== evidence.trace.sha256 || correction.failedOperation !== last.name ||
      !correction.diagnosis || !correction.defectReference || !correction.fixReference || !correction.reviewReference || !correction.adoptionReference ||
      correction.factorySha256 !== evidence.factory.sha256 || correction.factorySha256 === stopped.factorySha256 || !correction.factoryVersion || correction.factoryVersion === stopped.factoryVersion ||
      !files.factory.toString("utf8").includes(`export const RELEASE_BROWSER_VERSION = "${correction.factoryVersion}";`) ||
      !Number.isFinite(isoClock(correction.adoptedAt)) || isoClock(correction.adoptedAt) > isoClock(packet.requestedAt))
    return hold("REPAIR_ADOPTION_UNKNOWN");
  let prior, after, delta;
  try {
    prior = deltaRoster(baseline, now); after = deltaRoster(current, now);
    delta = verifyRosterDelta(baseline, current, [], now);
  } catch { return hold("SAVED_STATE_UNKNOWN"); }
  if (!fresh(current.verifiedAt) || isoClock(baseline.verifiedAt) > isoClock(trace.t0) || after.week !== root.week ||
      delta.verdict !== "PASS" || !same(baseline.pending, []) || !same(current.pending, []) || !Array.isArray(current.completedRecent))
    return hold("STATE_CHANGED_OR_UNKNOWN");
  const actionIds = kind === "stage" ? [action.addId, action.dropId] : [action.playerId];
  if (actionIds.some(id => !/^[1-9][0-9]*$/.test(id ?? "")) || actionIds.length !== new Set(actionIds).size ||
      current.completedRecent.some(t => !Array.isArray(t.players) || t.players.some(p => actionIds.some(id => p.playerKey === `${after.gameKey}.p.${id}`) &&
        (!/^[0-9]+$/.test(t.timestamp ?? "") || Number(t.timestamp) * 1000 >= prior.verifiedMs))))
    return hold("POSSIBLE_ACTION_OR_ID_UNKNOWN");
  // Validate the saved targets schema produced by the installed GET-only command.
  if (targets.apiReadOnly !== true || targets.identityVerified !== true || targets.membershipVerified !== true ||
      !same(targets.target, current.target) || targets.expectedWeek !== root.week || !fresh(targets.verifiedAt) ||
      !fresh(targets.requestCompletedAt) || !fresh(targets.ownershipRequestCompletedAt) ||
      !(isoClock(targets.expiresAt) > now) || targets.settings?.leagueKey !== current.settings.leagueKey || targets.settings?.week !== root.week ||
      !Array.isArray(targets.players) || new Set(targets.players.map(p => p.yahooId)).size !== targets.players.length)
    return hold("OWNERSHIP_UNKNOWN");
  const source = after.byId.get(kind === "stage" ? action.dropId : action.playerId);
  const target = targets.players.find(p => p.yahooId === (kind === "stage" ? action.addId : action.playerId));
  if (trace.leg !== (kind === "stage" ? action.addId : `start:${source?.name}`)) return hold("TRACE_LEG_CHANGED");
  if (!source || source.editable !== "1" || !target || target.playerKey !== `${after.gameKey}.p.${target.yahooId}` ||
      kind === "stage" && (action.slot !== "BN" || root.costMode !== "FA_ONLY_ZERO_COST" || target.ownership !== "FA" || target.ownerTeamKey !== null || target.waiverDate !== null ||
        after.byId.has(action.addId) || source.undroppable !== "0" || source.selectedPosition === "IR") ||
      kind === "start" && (action.from !== "BN" || source.selectedPosition !== action.from || target.ownership !== "owned" || target.ownerTeamKey !== after.teamKey ||
        !source.eligiblePositions?.includes(action.to) || !after.positions.has(action.to) ||
        [...after.byId.values()].filter(p => p.selectedPosition === action.to).length >= after.positions.get(action.to)))
    return hold("ACTION_PREFLIGHT_CHANGED");
  if (kind === "start") {
    const parents = records.filter(r => r.type === "RECOVERY_VERIFIED" && r.rootId === action.parentRootId);
    if (parents.length !== 1 || parents[0].jobId !== root.jobId || parents[0].snapshotSha256 !== evidence.baseline.sha256 ||
        parents[0].addedId !== action.playerId) return hold("PARENT_NOT_VERIFIED");
  }
  // Isolated UI supplies actual full snapshot lines plus one exact source row per
  // roster member. Cross-bind rows to the independently saved roster, not flags.
  const inspection = typeof ui.snapshot === "string" ? await createReleaseBrowser({
    tab: { playwright: { domSnapshot: async () => ui.snapshot }, url: async () => ui.url },
    league: root.leagueId, team: root.teamId, expires: root.expiresAt, waitMs: 1000,
  }).inspect() : null;
  const uiRows = parseRecoveryRosterRows(ui.snapshot);
  if (!fresh(ui.observedAt) || ui.method !== "isolated-supported-domSnapshot" || ui.url !== `https://football.fantasysports.yahoo.com/f1/${root.leagueId}/${root.teamId}` ||
      inspection?.result !== "INSPECTED_NO_ALARM" || !uiRows ||
      !Array.isArray(ui.rows) || ui.rows.length !== after.byId.size || uiRows.length !== after.byId.size ||
      new Set(ui.rows.map(r => r.id)).size !== after.byId.size || new Set(ui.rows.map(r => r.line)).size !== after.byId.size || ui.rows.some(row => {
        const player = after.byId.get(row.id), defense = recoveryDefenseTeams.get(row.id);
        const parsed = uiRows.find(candidate => candidate.block === row.line);
        if (!player || !parsed || row.slot !== player.selectedPosition) return true;
        const teamDefense = player.displayPosition === "DEF" || player.eligiblePositions?.includes("DEF");
        const primary = parsed.links[0];
        const identityLink = teamDefense ? defense && player.name === defense.name && primary?.name === defense.name &&
          primary.url === `https://sports.yahoo.com/nfl/teams/${defense.slug}/` && !/\/players\//.test(parsed.block)
          : primary?.name === player.name && primary.url === `https://sports.yahoo.com/nfl/players/${row.id}`;
        const control = `Click here to edit ${row.slot.replaceAll("/", "_")} ${player.name}`;
        const exactSlot = player.editable === "1" ? parsed.firstCell === `- cell "${control}":` &&
          parsed.slotChildren.includes(`- button "${control}": ${row.slot}`)
          : player.editable === "0" && parsed.firstCell === `- cell "${row.slot}":` && parsed.slotChildren.includes(`- generic: ${row.slot}`);
        return !identityLink || !exactSlot;
      })) return hold("UI_STATE_UNKNOWN");
  if (!fresh(preflight.observedAt) || preflight.jobId !== root.jobId || preflight.rootId !== root.rootId || preflight.executor !== root.executor ||
      preflight.snapshotSha256 !== evidence.current.sha256 || preflight.uiSha256 !== evidence.ui.sha256 || preflight.targetsSha256 !== evidence.targets.sha256 ||
      !Array.isArray(preflight.conditions) || preflight.conditions.length !== conditions.length ||
      new Set(preflight.conditions.map(c => c.key)).size !== conditions.length || preflight.conditions.some(c => !conditions.includes(c.key) ||
        !same(c.actual, root.conditions[c.key]) || typeof c.source !== "string" || !c.source.trim() || !fresh(c.verifiedAt))) return hold("PREFLIGHT_UNKNOWN");
  const locks = preflight.locks;
  const deadline = Math.min(isoClock(root.expiresAt), ...(Array.isArray(locks) ? locks.map(l => isoClock(l.at)) : [NaN]));
  if (!Array.isArray(locks) || locks.length !== actionIds.length || !same([...locks.map(l => l.id)].sort(), [...actionIds].sort()) ||
      !Number.isSafeInteger(preflight.completionAndVerificationMs) || preflight.completionAndVerificationMs < root.minimumCompletionAndVerificationMs ||
      !preflight.timingBasis || !Number.isFinite(deadline) || now + preflight.completionAndVerificationMs >= deadline)
    return hold("EXPIRED_LOCKED_OR_TIME_UNKNOWN");
  const reservation = { type: "RECOVERY_RESERVED", rootId: root.rootId, jobId: root.jobId, delegationId: root.id,
    predecessor: stopped.attemptId, attemptId: root.recoveryBudget.attemptId, executor: root.executor, recoveryUsed: 1, attempts: 2,
    expiresAt: root.expiresAt, reservedAt: packet.requestedAt, anchorSha256: anchor.sha256, action,
    evidence: Object.fromEntries(Object.keys(evidence).sort().map(key => [key, evidence[key].sha256])),
    failedOperation: last.name, factoryVersion: correction.factoryVersion, factorySha256: correction.factorySha256 };
  const event = recoveryRecord(reservation), expected = Buffer.concat([prefix, Buffer.from(event)]);
  if (packet.phase === "check" && !ledger.equals(expected)) return hold("RESERVATION_READBACK_INEXACT");
  return { verdict: packet.phase === "check" ? "RESERVED_READBACK_EXACT" : "RESERVATION_REQUIRED", offline: true, transactionReady: false,
    attemptId: reservation.attemptId, reservation, event, eventSha256: digest(event), reservedLedgerSha256: digest(expected),
    next: packet.phase === "check" ? "FRESH_EXACT_FACTORY_THEN_NORMAL_STAGE_LEDGER_SUBMIT_VERIFY" : "NORMAL_ANCHORED_APPEND_THEN_RECOVERY_GATE_CHECK_REQUIRED" };
}

// Only exact known codes may cross the CLI error boundary. Exception text is not
// safe merely because it starts with yahoo_ or resembles a system error code.
const operationCodes = new Set(`
  readonly_command_required output_path_invalid output_directory_missing output_directory_not_directory output_exists
  resource_identity_unverified league_target_mismatch current_week_unverified settings_unverified roster_positions_invalid
  player_key_invalid player_name_missing player_duplicate roster_week_mismatch roster_incomplete
  transaction_target_mismatch transaction_duplicate target_ids_invalid target_week_invalid target_expiry_invalid
  target_league_mismatch target_period_mismatch target_player_identity_mismatch target_ownership_invalid
  target_ownership_conflict target_status_invalid target_players_missing page_invalid collection_bound_required
  transport_missing identity_binding_missing target_week_mismatch target_read_expired candidate_page_unverified
  pending_claims_incomplete candidate_collection_incomplete candidate_settings_changed candidate_pagination_gap
  candidate_duplicate_or_ownership_changed planner_readback_invalid planner_supplement_invalid
  planner_supplement_duplicate planner_player_invalid planner_report_period_mismatch
  delta_spec_invalid delta_snapshot_invalid recovery_evidence_invalid
  identity_ambiguous target_game_membership_missing game_key_missing game_key_invalid target_team_ownership_missing
  identity_mismatch identity_missing refresh_identity_mismatch token_response_invalid access_token_missing
  refresh_token_missing client_id_missing client_secret_missing
  resource_path_invalid resource_origin_invalid resource_response_invalid keychain_field_invalid
`.trim().split(/\s+/).map(code => `yahoo_${code}`));
for (const collectionName of ["players", "transactions"]) {
  for (const suffix of ["collection_missing", "count_invalid", "entry_missing"])
    operationCodes.add(`yahoo_${collectionName}_${suffix}`);
}
const systemCodes = new Set([
  "ENOENT", "ENOTDIR", "EEXIST", "EACCES", "EPERM", "ENOSPC", "EDQUOT", "EROFS", "EIO", "EMFILE", "ENFILE",
  "EINVAL", "ENAMETOOLONG", "ELOOP", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
  "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);
function safeOperationCode(error) {
  const message = error?.message;
  if (operationCodes.has(message)) return message;
  if (typeof message !== "string") return "yahoo_operation_failed";
  if (/^yahoo_keychain_(?:read_failed|item_empty|item_too_long|write_failed):(?:client-id|client-secret|refresh-token|yahoo-guid)$/.test(message))
    return message;
  if (/^yahoo_token_request_failed:[1-5][0-9]{2}$/.test(message)) return message;
  const http = /^yahoo_resource_request_failed:([1-5][0-9]{2})(?::retry_after_(seconds|at)=(.+))?$/.exec(message);
  if (http && (!http[2] || ["429", "503"].includes(http[1]) && (
    http[2] === "seconds" && /^[0-9]{1,10}$/.test(http[3]) && String(Number(http[3])) === http[3] ||
    http[2] === "at" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(http[3]) &&
      Number.isFinite(Date.parse(http[3])) && new Date(http[3]).toISOString() === http[3]
  ))) return message;
  return "yahoo_operation_failed";
}

function writeStream(stream, text) {
  return new Promise((resolve, reject) => {
    const onError = error => reject(error);
    stream.once("error", onError);
    stream.write(text, error => {
      if (error) reject(error);
      else { stream.removeListener("error", onError); resolve(); }
    });
  });
}

/** The production argv/emit/error path; tests replace only I/O, never validation. */
export async function runCli(args, {
  refreshAccess = refreshBoundAccess, getResource = yahooFantasyGet, writeOutput = writeFile,
  stdout = text => writeStream(process.stdout, text), stderr = text => writeStream(process.stderr, text),
} = {}) {
  let stage = "input", accessStatus = "not_attempted", readStatus = "not_attempted";
  let persistence = "not_attempted", resourceRequests = 0;
  try {
    const outputs = args.filter(arg => arg.startsWith("--out="));
    if (outputs.length > 1 || outputs.some(arg => arg === "--out=" || arg.endsWith("/") || arg.includes("\0"))) fail("yahoo_output_path_invalid");
    const outputPath = outputs[0]?.slice(6);
    args = args.filter(arg => !arg.startsWith("--out="));
    const [command, arg] = args;
    let packet;
    if (command === "snapshot" && args.length === 1) {
      // No paging input.
    } else if (command === "candidates" && args.length === 2 && /^(FA|W):[0-9]+:[0-9]+$/.test(arg)) {
      const [status, start, count] = arg.split(":");
      packet = { status, start: Number(start), count: Number(count) };
    } else if (command === "snapshot" && args.length === 2 && /^all:[0-9]+$/.test(arg)) {
      packet = { collectCandidates: true, maximumPages: Number(arg.slice(4)) };
    } else if (command === "targets" && args.length === 4 && /^[1-9][0-9]*$/.test(args[2])) {
      packet = { playerIds: arg.split(","), expectedWeek: Number(args[2]), expiresAt: args[3] };
    } else if (command === "planner-input" && [4, 5].includes(args.length)) {
      // Offline bridge; file reads follow destination preflight below.
    } else if (command === "recovery-gate" && args.length === 2) {
      // Offline only; canonical/evidence reads follow destination preflight.
    } else if (command === "verify-delta" && args.length === 4) {
      packet = { changes: parseDeltaSpec(args[3]) };
    } else fail("yahoo_readonly_command_required");
    if (!["planner-input", "verify-delta", "recovery-gate"].includes(command)) validateRequest(command, packet);
    if (outputPath) {
      stage = "output_preflight";
      let parent;
      try { parent = await stat(dirname(outputPath)); }
      catch (error) {
        if (error?.code === "ENOENT") fail("yahoo_output_directory_missing");
        if (error?.code === "ENOTDIR") fail("yahoo_output_directory_not_directory");
        throw error;
      }
      if (!parent.isDirectory()) fail("yahoo_output_directory_not_directory");
      let exists = false;
      try { await lstat(outputPath); exists = true; }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (exists) fail("yahoo_output_exists");
    }
    let result;
    if (command === "recovery-gate") {
      stage = "input";
      const request = JSON.parse((await recoveryBytes(arg)).toString("utf8"));
      stage = "read_validation"; readStatus = "started";
      result = await recoveryGate(request);
    } else if (command === "planner-input") {
      stage = "input";
      const raw = JSON.parse(await readFile(arg, "utf8"));
      const report = JSON.parse(await readFile(args[2], "utf8"));
      const verifiedSupplement = args[4] ? JSON.parse(await readFile(args[4], "utf8")) : null;
      stage = "read_validation"; readStatus = "started";
      result = toPlannerSnapshot(raw, raw.candidatePool, { report, expiresAt: args[3], verifiedSupplement });
    } else if (command === "verify-delta") {
      stage = "input";
      const before = JSON.parse(await readFile(arg, "utf8"));
      const after = JSON.parse(await readFile(args[2], "utf8"));
      stage = "read_validation"; readStatus = "started";
      result = verifyRosterDelta(before, after, packet.changes);
    } else {
      // Access includes Keychain reads, token refresh and possible rotation storage.
      // Its internals are deliberately not inferred from a thrown exception.
      stage = "access"; accessStatus = "started";
      const access = await refreshAccess();
      accessStatus = "completed";
      stage = "read_validation"; readStatus = "started";
      result = await operate({ command, packet, transport: {
        expectedGuid: access.yahooGuid,
        get: path => { resourceRequests += 1; return getResource(path, access.accessToken); },
      } });
    }
    readStatus = "completed";
    stage = "output_write";
    // Serialize before exclusive create: serialization failure cannot reserve a name.
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (outputPath) {
      persistence = "incomplete";
      await writeOutput(outputPath, json, { mode: 0o600, flag: "wx" });
      persistence = "completed";
    }
    stage = "receipt";
    await stdout(outputPath ? `${JSON.stringify({ output: outputPath, apiReadOnly: true })}\n` : json);
    // A completed delta comparison that FAILs exits 2 so a chained shell step stops.
    return command === "verify-delta" && result.verdict !== "PASS" || command === "recovery-gate" && result.verdict === "HOLD" ? 2 : 0;
  } catch (error) {
    const diagnostic = {
      stage, code: safeOperationCode(error),
      errorType: ["Error", "TypeError", "RangeError", "SyntaxError", "AbortError"].includes(error?.name) ? error.name : "UNKNOWN",
      errorCode: systemCodes.has(error?.code) ? error.code : "UNKNOWN",
      causeCode: systemCodes.has(error?.cause?.code) ? error.cause.code : "UNKNOWN",
      accessStatus, readStatus, resourceRequests, persistence,
    };
    try { await stderr(`${JSON.stringify(diagnostic)}\n`); }
    catch { /* No alternate output or live call when diagnostic delivery fails. */ }
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
