import { fileURLToPath } from "node:url";
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
    playerLocksVerified: false, players: list,
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
    return { ...base, status, start, count, nextStart: list.length === count ? start + count : null, players: list };
  }
  const roster = parseRoster(await transport.get(`/team/${membership.teamKey}/roster;week=${settings.week}?format=json`), membership, settings.week);
  const pending = transactions(await transport.get(`/league/${membership.leagueKey}/transactions;types=waiver,pending_trade;team_key=${membership.teamKey};count=100?format=json`), membership);
  if (pending.length >= 100) fail("yahoo_pending_claims_incomplete");
  const completedRecent = transactions(await transport.get(`/league/${membership.leagueKey}/transactions;count=25?format=json`), membership);
  return { ...base, roster, pending, completedRecent, completedRecentLimit: 25 };
}

async function main(args) {
  const [command, arg] = args;
  let packet;
  if (command === "snapshot" && args.length === 1) {
    // No paging input.
  } else if (command === "candidates" && args.length === 2 && /^(FA|W):[0-9]+:[0-9]+$/.test(arg)) {
    const [status, start, count] = arg.split(":");
    packet = { status, start: Number(start), count: Number(count) };
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
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof Error && /^yahoo_/.test(error.message) ? error.message : "yahoo_operation_failed"}\n`);
    process.exitCode = 1;
  });
}
