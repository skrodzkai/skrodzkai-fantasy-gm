import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
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

function validateRequest(command, packet) {
  if (!["snapshot", "candidates"].includes(command)) fail("yahoo_readonly_command_required");
  if (command === "candidates" && (!["FA", "W"].includes(packet?.status) ||
      !Number.isSafeInteger(packet?.start) || packet.start < 0 ||
      !Number.isSafeInteger(packet?.count) || packet.count < 1 || packet.count > 25 ||
      !Number.isSafeInteger(packet.start + packet.count))) fail("yahoo_page_invalid");
  if (command === "snapshot" && packet?.collectCandidates &&
      (!Number.isSafeInteger(packet.maximumPages) || packet.maximumPages < 2)) fail("yahoo_collection_bound_required");
}

export async function operate({ command, packet, transport }) {
  validateRequest(command, packet);
  if (!transport || typeof transport.get !== "function") fail("yahoo_transport_missing");
  if (typeof transport.expectedGuid !== "string" || !transport.expectedGuid.trim()) fail("yahoo_identity_binding_missing");
  const membership = parseMembership(await transport.get(membershipPath), transport.expectedGuid);
  const settings = parseSettings(await transport.get(`/league/${membership.leagueKey}/settings?format=json`), membership);
  const base = {
    verifiedAt: new Date().toISOString(), identityVerified: true, membershipVerified: true,
    target: TARGET, settings, apiReadOnly: true,
  };
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

async function main(args) {
  const outputs = args.filter(arg => arg.startsWith("--out="));
  if (outputs.length > 1 || outputs.some(arg => arg === "--out=")) fail("yahoo_output_path_invalid");
  const outputPath = outputs[0]?.slice(6);
  args = args.filter(arg => !arg.startsWith("--out="));
  const emit = async result => {
    if (outputPath) {
      await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      process.stdout.write(`${JSON.stringify({ output: outputPath, apiReadOnly: true })}\n`);
    } else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  };
  const [command, arg] = args;
  let packet;
  if (command === "snapshot" && args.length === 1) {
    // No paging input.
  } else if (command === "candidates" && args.length === 2 && /^(FA|W):[0-9]+:[0-9]+$/.test(arg)) {
    const [status, start, count] = arg.split(":");
    packet = { status, start: Number(start), count: Number(count) };
  } else if (command === "snapshot" && args.length === 2 && /^all:[0-9]+$/.test(arg)) {
    packet = { collectCandidates: true, maximumPages: Number(arg.slice(4)) };
  } else if (command === "planner-input" && [4, 5].includes(args.length)) {
    // Offline bridge. Validate/read facts without accessing Keychain or network.
    const raw = JSON.parse(await readFile(arg, "utf8"));
    const report = JSON.parse(await readFile(args[2], "utf8"));
    const verifiedSupplement = args[4] ? JSON.parse(await readFile(args[4], "utf8")) : null;
    const result = toPlannerSnapshot(raw, raw.candidatePool, { report, expiresAt: args[3], verifiedSupplement });
    await emit(result);
    return;
  } else fail("yahoo_readonly_command_required");
  // Validate before accessing Keychain, not only inside the read operation.
  validateRequest(command, packet);
  const access = await refreshBoundAccess();
  const result = await operate({
    command, packet,
    transport: {
      expectedGuid: access.yahooGuid,
      get: path => yahooFantasyGet(path, access.accessToken),
    },
  });
  await emit(result);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof Error && /^yahoo_/.test(error.message) ? error.message : "yahoo_operation_failed"}\n`);
    process.exitCode = 1;
  });
}
