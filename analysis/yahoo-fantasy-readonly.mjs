import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export const TARGET = Object.freeze({
  gameCode: "nfl",
  season: 2026,
  leagueId: "420010",
  teamId: "7",
});

export const REDIRECT_URI = "https://localhost:8765/callback";
export const AUTHORIZATION_ENDPOINT = "https://api.login.yahoo.com/oauth2/request_auth";
export const TOKEN_ENDPOINT = "https://api.login.yahoo.com/oauth2/get_token";
export const FANTASY_API_BASE = "https://fantasysports.yahooapis.com/fantasy/v2";
const OWNED_TEAM_PATH = `/users;use_login=1/games;game_codes=${TARGET.gameCode};seasons=${TARGET.season}/teams?format=json`;

const KEYCHAIN_SERVICE = "com.skrodzkai.fantasy.yahoo";
const KEYCHAIN_FIELDS = Object.freeze({
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
  yahooGuid: "yahoo-guid",
});
const SECURITY = "/usr/bin/security";
const OWNED_TEAM_IDENTITY_PREFIX = "owned-team:";

function fail(code) {
  throw new Error(code);
}

function requireText(value, code) {
  if (typeof value !== "string" || value.length === 0) fail(code);
  return value;
}

function constantTimeEqual(left, right) {
  const leftBytes = Buffer.from(String(left));
  const rightBytes = Buffer.from(String(right));
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function buildAuthorizationUrl({ clientId, state }) {
  requireText(clientId, "yahoo_client_id_missing");
  requireText(state, "yahoo_state_missing");
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("language", "en-us");
  return url.toString();
}

export function parseCallbackUrl(value, expectedState) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    fail("yahoo_callback_url_invalid");
  }
  const expected = new URL(REDIRECT_URI);
  if (
    url.protocol !== expected.protocol ||
    url.hostname !== expected.hostname ||
    url.port !== expected.port ||
    url.pathname !== expected.pathname ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) fail("yahoo_callback_url_mismatch");
  const safeError = url.searchParams.get("error")?.replace(/[^a-z0-9_-]/gi, "_");
  if (safeError) fail(`yahoo_authorization_denied:${safeError}`);
  if (url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("code").length !== 1) {
    fail("yahoo_callback_parameter_ambiguous");
  }
  const state = requireText(url.searchParams.get("state"), "yahoo_callback_state_missing");
  if (!constantTimeEqual(state, expectedState)) fail("yahoo_callback_state_mismatch");
  return requireText(url.searchParams.get("code"), "yahoo_callback_code_missing");
}

async function yahooTokenRequest({ clientId, clientSecret, body, fetchImpl = fetch }) {
  requireText(clientId, "yahoo_client_id_missing");
  requireText(clientSecret, "yahoo_client_secret_missing");
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
    redirect: "error",
  });
  if (!response.ok) fail(`yahoo_token_request_failed:${response.status}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    fail("yahoo_token_response_invalid");
  }
  const accessToken = requireText(payload.access_token, "yahoo_access_token_missing");
  const refreshToken = requireText(payload.refresh_token, "yahoo_refresh_token_missing");
  return {
    accessToken,
    refreshToken,
    yahooGuid: typeof payload.xoauth_yahoo_guid === "string" ? payload.xoauth_yahoo_guid : null,
  };
}

export function exchangeAuthorizationCode({ clientId, clientSecret, code, fetchImpl = fetch }) {
  return yahooTokenRequest({
    clientId,
    clientSecret,
    fetchImpl,
    body: {
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      code: requireText(code, "yahoo_authorization_code_missing"),
    },
  });
}

export function refreshAccessToken({ clientId, clientSecret, refreshToken, fetchImpl = fetch }) {
  return yahooTokenRequest({
    clientId,
    clientSecret,
    fetchImpl,
    body: {
      grant_type: "refresh_token",
      redirect_uri: REDIRECT_URI,
      refresh_token: requireText(refreshToken, "yahoo_refresh_token_missing"),
    },
  });
}

function directField(resource, key) {
  if (Array.isArray(resource)) {
    for (const item of resource) {
      if (item && typeof item === "object" && !Array.isArray(item) && Object.hasOwn(item, key)) return item[key];
      if (Array.isArray(item)) {
        const value = directField(item, key);
        if (value !== undefined) return value;
      }
    }
  } else if (resource && typeof resource === "object" && Object.hasOwn(resource, key)) {
    return resource[key];
  }
  return undefined;
}

function collectResourceCandidates(node, key, output) {
  if (Array.isArray(node)) {
    if (directField(node, key) !== undefined) output.push(node);
    for (const item of node) collectResourceCandidates(item, key, output);
  } else if (node && typeof node === "object") {
    for (const value of Object.values(node)) collectResourceCandidates(value, key, output);
  }
}

function findResources(node, key) {
  const candidates = [];
  collectResourceCandidates(node, key, candidates);
  const resources = new Map();
  for (const candidate of candidates) {
    const value = directField(candidate, key);
    const size = JSON.stringify(candidate).length;
    if (!resources.has(value) || resources.get(value).size < size) resources.set(value, { candidate, size });
  }
  return [...resources.values()].map(({ candidate }) => candidate);
}

function findValues(node, key, output = []) {
  if (Array.isArray(node)) {
    for (const item of node) findValues(item, key, output);
  } else if (node && typeof node === "object") {
    for (const [name, value] of Object.entries(node)) {
      if (name === key) output.push(value);
      findValues(value, key, output);
    }
  }
  return output;
}

function numberedEntries(collection) {
  if (!collection || typeof collection !== "object" || Array.isArray(collection)) return [];
  return Object.entries(collection)
    .filter(([key]) => /^\d+$/.test(key))
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, value]) => value);
}

export function parseMembership(payload, expectedGuid) {
  const users = payload?.fantasy_content?.users;
  const userEntries = numberedEntries(users);
  if (userEntries.length !== 1 || Number(users?.count) !== 1) fail("yahoo_identity_ambiguous");
  const user = userEntries[0]?.user;
  const observedGuidValue = directField(user, "guid");
  const observedGuid = typeof observedGuidValue === "string" && observedGuidValue.length > 0
    ? observedGuidValue
    : null;

  const gameResources = findResources(user, "game_key");
  const gameMatches = gameResources.filter((resource) => {
    return directField(resource, "code") === TARGET.gameCode && Number(directField(resource, "season")) === TARGET.season;
  });
  if (gameMatches.length !== 1) fail("yahoo_target_game_membership_missing");
  const gameKey = requireText(directField(gameMatches[0], "game_key"), "yahoo_game_key_missing");
  if (!/^\d+$/.test(gameKey)) fail("yahoo_game_key_invalid");
  const leagueKey = `${gameKey}.l.${TARGET.leagueId}`;
  const teamKey = `${leagueKey}.t.${TARGET.teamId}`;
  const teamResources = findResources(gameMatches[0], "team_key");
  if (!teamResources.some((resource) => directField(resource, "team_key") === teamKey)) {
    fail("yahoo_target_team_ownership_missing");
  }

  const ownedTeamIdentity = `${OWNED_TEAM_IDENTITY_PREFIX}${teamKey}`;
  if (expectedGuid) {
    if (expectedGuid.startsWith(OWNED_TEAM_IDENTITY_PREFIX)) {
      if (!constantTimeEqual(expectedGuid, ownedTeamIdentity)) fail("yahoo_identity_mismatch");
    } else {
      if (!observedGuid) fail("yahoo_identity_missing");
      if (!constantTimeEqual(observedGuid, expectedGuid)) fail("yahoo_identity_mismatch");
    }
  }
  return {
    gameKey,
    leagueKey,
    teamKey,
    observedGuid,
    identityBinding: observedGuid || ownedTeamIdentity,
  };
}

function normalizePlayer(resource) {
  const playerKey = requireText(directField(resource, "player_key"), "yahoo_roster_player_key_missing");
  const name = directField(resource, "name");
  const fullName = name && typeof name === "object" ? name.full : null;
  const selected = findValues(resource, "selected_position")[0];
  const selectedPosition = directField(selected, "position");
  return {
    playerKey,
    name: requireText(fullName, `yahoo_roster_player_name_missing:${playerKey}`),
    displayPosition: requireText(directField(resource, "display_position"), `yahoo_roster_position_missing:${playerKey}`),
    selectedPosition: requireText(selectedPosition, `yahoo_roster_slot_missing:${playerKey}`),
    status: directField(resource, "status") || null,
  };
}

export function parseRoster(payload, expectedTeamKey) {
  const teamResources = findResources(payload?.fantasy_content, "team_key");
  const team = teamResources.find((resource) => directField(resource, "team_key") === expectedTeamKey);
  if (!team) fail("yahoo_roster_team_mismatch");
  const playerResources = findResources(team, "player_key");
  if (playerResources.length === 0) fail("yahoo_roster_empty");
  const players = playerResources.map(normalizePlayer);
  if (new Set(players.map(({ playerKey }) => playerKey)).size !== players.length) fail("yahoo_roster_player_duplicate");
  return players;
}

async function yahooFantasyGet(path, accessToken, fetchImpl = fetch) {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("..")) fail("yahoo_resource_path_invalid");
  const url = new URL(`${FANTASY_API_BASE}${path}`);
  if (url.origin !== new URL(FANTASY_API_BASE).origin) fail("yahoo_resource_origin_invalid");
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${requireText(accessToken, "yahoo_access_token_missing")}` },
    redirect: "error",
  });
  if (!response.ok) fail(`yahoo_resource_request_failed:${response.status}`);
  try {
    return await response.json();
  } catch {
    fail("yahoo_resource_response_invalid");
  }
}

export async function fetchVerifiedRoster({ accessToken, expectedGuid, fetchImpl = fetch }) {
  const membershipPayload = await yahooFantasyGet(OWNED_TEAM_PATH, accessToken, fetchImpl);
  const membership = parseMembership(membershipPayload, expectedGuid);
  const rosterPayload = await yahooFantasyGet(`/team/${membership.teamKey}/roster?format=json`, accessToken, fetchImpl);
  const players = parseRoster(rosterPayload, membership.teamKey);
  return {
    verifiedAt: new Date().toISOString(),
    identityVerified: true,
    membershipVerified: true,
    season: TARGET.season,
    leagueId: TARGET.leagueId,
    teamId: TARGET.teamId,
    leagueKey: membership.leagueKey,
    teamKey: membership.teamKey,
    playerCount: players.length,
    players,
  };
}

async function readKeychain(field) {
  if (!Object.values(KEYCHAIN_FIELDS).includes(field)) fail("yahoo_keychain_field_invalid");
  try {
    const { stdout } = await execFileAsync(SECURITY, [
      "find-generic-password", "-a", field, "-s", KEYCHAIN_SERVICE, "-w",
    ], { encoding: "utf8", maxBuffer: 64 * 1024 });
    return requireText(stdout.replace(/\r?\n$/, ""), `yahoo_keychain_item_empty:${field}`);
  } catch {
    fail(`yahoo_keychain_read_failed:${field}`);
  }
}

async function writeKeychain(field, value) {
  if (!Object.values(KEYCHAIN_FIELDS).includes(field)) fail("yahoo_keychain_field_invalid");
  requireText(value, `yahoo_keychain_item_empty:${field}`);
  // security's trailing -w uses getpass twice on /dev/tty, not this pipe.
  // Its documented interactive mode accepts one command on private stdin.
  // Hex is transport encoding (not encryption); it prevents command injection.
  const command = `add-generic-password -U -a ${field} -s ${KEYCHAIN_SERVICE} -T "" -X ${Buffer.from(value, "utf8").toString("hex")}\n`;
  // Apple's interactive reader has a 4096-byte buffer; never allow truncation.
  if (Buffer.byteLength(command) >= 4096) fail(`yahoo_keychain_item_too_long:${field}`);
  await new Promise((resolve, reject) => {
    const child = spawn(SECURITY, ["-i"], { stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", () => reject(new Error(`yahoo_keychain_write_failed:${field}`)));
    child.stdin.once("error", () => reject(new Error(`yahoo_keychain_write_failed:${field}`)));
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`yahoo_keychain_write_failed:${field}`)));
    child.stdin.end(command);
  });
}

async function readHiddenLine(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    fail("yahoo_hidden_input_requires_tty");
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  try {
    return await new Promise((resolve, reject) => {
      const onData = (chunk) => {
        for (const character of chunk.toString("utf8")) {
          if (character === "\u0003") {
            cleanup();
            reject(new Error("yahoo_enrollment_cancelled"));
            return;
          }
          if (character === "\r" || character === "\n") {
            cleanup();
            resolve(value);
            return;
          }
          if (character === "\u007f") value = value.slice(0, -1);
          else value += character;
        }
      };
      const cleanup = () => {
        process.stdin.off("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
      };
      process.stdin.on("data", onData);
    });
  } finally {
    if (process.stdin.isRaw) process.stdin.setRawMode(false);
  }
}

async function enroll({ fetchImpl = fetch } = {}) {
  const clientId = await readKeychain(KEYCHAIN_FIELDS.clientId);
  const clientSecret = await readKeychain(KEYCHAIN_FIELDS.clientSecret);
  const state = randomBytes(32).toString("base64url");
  process.stdout.write("Open this Yahoo authorization URL in the owner-controlled browser.\n");
  process.stdout.write(`${buildAuthorizationUrl({ clientId, state })}\n`);
  process.stdout.write("The registered HTTPS localhost redirect has no listener; a browser connection error is expected.\n");
  const callbackUrl = await readHiddenLine("Paste the complete redirect URL (input hidden): ");
  const code = parseCallbackUrl(callbackUrl, state);
  const tokens = await exchangeAuthorizationCode({ clientId, clientSecret, code, fetchImpl });
  const membershipPayload = await yahooFantasyGet(OWNED_TEAM_PATH, tokens.accessToken, fetchImpl);
  const membership = parseMembership(membershipPayload);
  if (tokens.yahooGuid && membership.observedGuid && !constantTimeEqual(tokens.yahooGuid, membership.observedGuid)) {
    fail("yahoo_token_identity_mismatch");
  }
  const yahooGuid = membership.identityBinding;
  await writeKeychain(KEYCHAIN_FIELDS.yahooGuid, yahooGuid);
  await writeKeychain(KEYCHAIN_FIELDS.refreshToken, tokens.refreshToken);
  process.stdout.write(`${JSON.stringify({ status: "enrolled", identityBound: true, keychainService: KEYCHAIN_SERVICE, redirectUri: REDIRECT_URI })}\n`);
}

async function roster({ fetchImpl = fetch } = {}) {
  const clientId = await readKeychain(KEYCHAIN_FIELDS.clientId);
  const clientSecret = await readKeychain(KEYCHAIN_FIELDS.clientSecret);
  const refreshToken = await readKeychain(KEYCHAIN_FIELDS.refreshToken);
  const yahooGuid = await readKeychain(KEYCHAIN_FIELDS.yahooGuid);
  const tokens = await refreshAccessToken({ clientId, clientSecret, refreshToken, fetchImpl });
  if (
    tokens.yahooGuid &&
    !yahooGuid.startsWith(OWNED_TEAM_IDENTITY_PREFIX) &&
    !constantTimeEqual(tokens.yahooGuid, yahooGuid)
  ) fail("yahoo_refresh_identity_mismatch");
  if (!constantTimeEqual(tokens.refreshToken, refreshToken)) {
    await writeKeychain(KEYCHAIN_FIELDS.refreshToken, tokens.refreshToken);
  }
  const result = await fetchVerifiedRoster({ accessToken: tokens.accessToken, expectedGuid: yahooGuid, fetchImpl });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function usage() {
  return [
    "Usage:",
    "  node analysis/yahoo-fantasy-readonly.mjs enroll",
    "  node analysis/yahoo-fantasy-readonly.mjs roster",
  ].join("\n");
}

async function main(args) {
  if (args.length !== 1) fail("yahoo_command_invalid");
  if (args[0] === "enroll") return enroll();
  if (args[0] === "roster") return roster();
  fail("yahoo_command_invalid");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "yahoo_connector_failed"}\n${usage()}\n`);
    process.exitCode = 1;
  });
}
