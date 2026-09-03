import { createHash } from "node:crypto";

const OFFENSE_FIELDS = Object.freeze([
  "passingCompletions", "passingYards", "passingTouchdowns", "interceptions",
  "rushingYards", "rushingTouchdowns", "rushingHundredYardGames", "receptions",
  "receivingYards", "receivingTouchdowns", "receivingHundredYardGames",
  "returnYards", "returnTouchdowns", "twoPointConversions", "fumblesLost",
  "offensiveFumbleReturnTouchdowns",
]);
const OFFENSE_APPLICABLE = Object.freeze({
  QB: ["passingCompletions", "passingYards", "passingTouchdowns", "interceptions", "rushingYards", "rushingTouchdowns", "rushingHundredYardGames", "returnYards", "returnTouchdowns", "twoPointConversions", "fumblesLost", "offensiveFumbleReturnTouchdowns"],
  RB: ["rushingYards", "rushingTouchdowns", "rushingHundredYardGames", "receptions", "receivingYards", "receivingTouchdowns", "receivingHundredYardGames", "returnYards", "returnTouchdowns", "twoPointConversions", "fumblesLost", "offensiveFumbleReturnTouchdowns"],
  WR: ["rushingYards", "rushingTouchdowns", "rushingHundredYardGames", "receptions", "receivingYards", "receivingTouchdowns", "receivingHundredYardGames", "returnYards", "returnTouchdowns", "twoPointConversions", "fumblesLost", "offensiveFumbleReturnTouchdowns"],
  TE: ["rushingYards", "rushingTouchdowns", "rushingHundredYardGames", "receptions", "receivingYards", "receivingTouchdowns", "receivingHundredYardGames", "returnYards", "returnTouchdowns", "twoPointConversions", "fumblesLost", "offensiveFumbleReturnTouchdowns"],
});
const IDP_FIELDS = Object.freeze([
  "soloTackles", "assistedTackles", "sacks", "interceptions", "forcedFumbles",
  "fumbleRecoveries", "touchdowns", "safeties", "passesDefended", "blockedKicks",
  "tacklesForLoss", "turnoverReturnYards", "extraPointReturns",
]);
const CBS_POSITION_FIELDS = Object.freeze({
  QB: ["games", "passingAttempts", "passingCompletions", "passingYards", null, "passingTouchdowns", "interceptions", null, "rushingAttempts", "rushingYards", null, "rushingTouchdowns", "fumblesLost"],
  RB: ["games", "rushingAttempts", "rushingYards", null, "rushingTouchdowns", "targets", "receptions", "receivingYards", null, null, "receivingTouchdowns", "fumblesLost"],
  WR: ["games", "targets", "receptions", "receivingYards", null, null, "receivingTouchdowns", "rushingAttempts", "rushingYards", null, "rushingTouchdowns", "fumblesLost"],
  TE: ["games", "targets", "receptions", "receivingYards", null, null, "receivingTouchdowns", "fumblesLost"],
});

function decode(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&nbsp;", " ")
    .replace(/\s+/g, " ")
    .trim();
}

function numeric(value) {
  const normalized = String(value ?? "").replaceAll(",", "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function omitted(applicable, stats) {
  return applicable.filter((field) => !Object.hasOwn(stats, field));
}

function hashDocuments(documents) {
  const hash = createHash("sha256");
  for (const [key, value] of Object.entries(documents).sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(`${key}\0${value}\0`);
  }
  return hash.digest("hex");
}

export function parseCbsPositionHtml(html, expectedPosition) {
  const position = String(expectedPosition ?? "").toUpperCase();
  const fields = CBS_POSITION_FIELDS[position];
  if (!fields) throw new Error(`unsupported CBS position ${position}`);
  const rows = [];
  const rejected = { malformedIdentity: 0, malformedStats: 0 };
  const rowMatches = String(html).matchAll(/<tr class="TableBase-bodyTr">([\s\S]*?)<\/tr>/g);
  for (const match of rowMatches) {
    const body = match[1];
    const long = body.match(/CellPlayerName--long([\s\S]*?)<\/td>/);
    const name = decode(long?.[1].match(/<a[^>]*>([\s\S]*?)<\/a>/)?.[1]);
    const parsedPosition = decode(long?.[1].match(/CellPlayerName-position">([\s\S]*?)<\/span>/)?.[1]).toUpperCase();
    const team = decode(long?.[1].match(/CellPlayerName-team">([\s\S]*?)<\/span>/)?.[1]).toUpperCase();
    if (!name || !team || parsedPosition !== position) {
      rejected.malformedIdentity += 1;
      continue;
    }
    const cells = [...body.matchAll(/<td class="TableBase-bodyTd[\s\S]*?">([\s\S]*?)<\/td>/g)]
      .slice(1)
      .map((cell) => numeric(decode(cell[1])));
    if (cells.length < fields.length || fields.some((field, index) => field && cells[index] === null)) {
      rejected.malformedStats += 1;
      continue;
    }
    const stats = Object.fromEntries(fields.flatMap((field, index) => field ? [[field, cells[index]]] : []));
    const projectionGames = stats.games;
    delete stats.games;
    rows.push({
      name,
      team,
      position,
      projectionGames,
      scoringKind: "offense",
      stats,
      omittedScoringCategories: omitted(OFFENSE_APPLICABLE[position], stats),
    });
  }
  return { rows, rejected };
}

function firstRazzballTable(html) {
  const table = String(html).match(/<table id="neorazzstatstable"[\s\S]*?<\/table>/i)?.[0];
  if (!table) throw new Error("Razzball projection table not found");
  const headers = [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((match) => decode(match[1]));
  const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => decode(cell[1])))
    .filter((cells) => cells.length);
  return { headers, rows };
}

function rowObject(headers, cells) {
  return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
}

export function parseRazzballHtml(html, kind) {
  const normalizedKind = String(kind ?? "").toLowerCase();
  const { headers, rows: tableRows } = firstRazzballTable(html);
  const rejected = { malformedIdentity: 0, malformedStats: 0 };
  const rows = [];
  for (const cells of tableRows) {
    const row = rowObject(headers, cells);
    const team = String(row.Team ?? "").toUpperCase();
    const name = normalizedKind === "def" ? team : row.Name;
    const position = normalizedKind === "def" ? "DEF" : String(row.Pos ?? (normalizedKind === "k" ? "K" : "")).toUpperCase();
    if (!name || !team || !position) {
      rejected.malformedIdentity += 1;
      continue;
    }
    let stats;
    let scoringKind;
    if (normalizedKind === "offense") {
      scoringKind = "offense";
      stats = {
        passingCompletions: numeric(row.Cmp), passingAttempts: numeric(row.Att), passingYards: numeric(row["Pass Yds"]),
        passingTouchdowns: numeric(row["Pass TD"]), interceptions: numeric(row.Int), rushingAttempts: numeric(row.Rush),
        rushingYards: numeric(row["Rush Yds"]), rushingTouchdowns: numeric(row["Run TD"]), targets: numeric(row.Tgt),
        receptions: numeric(row.Rec), receivingYards: numeric(row["Rec Yds"]), receivingTouchdowns: numeric(row["Rec TD"]),
      };
    } else if (normalizedKind === "idp") {
      scoringKind = "idp";
      stats = {
        snaps: numeric(row.Snaps), totalTackles: numeric(row.Tackles), soloTackles: numeric(row["Tackles Solo"]),
        assistedTackles: numeric(row["Tackles Ast"]), tacklesForLoss: numeric(row.TFL), sacks: numeric(row.Sacks),
        passesDefended: numeric(row["Pass Def"]), interceptions: numeric(row.Ints), forcedFumbles: numeric(row["Fum Forc"]),
        fumbleRecoveries: numeric(row["Fum Rec"]), safeties: numeric(row.Saf), touchdowns: numeric(row["TD Ret"]),
        turnoverReturnYards: numeric(row["Ret Yds"]),
      };
    } else if (normalizedKind === "k") {
      scoringKind = "kicker";
      stats = { fieldGoalsMade: numeric(row.FG), fieldGoalsAttempted: numeric(row.FGA), extraPointsMade: numeric(row.XP), extraPointsAttempted: numeric(row.XPA) };
    } else if (normalizedKind === "def") {
      scoringKind = "team-defense";
      stats = {
        sacks: numeric(row.Sck), interceptions: numeric(row.Int), forcedFumbles: numeric(row["Fum For"]),
        fumbleRecoveries: numeric(row.Fum), safeties: numeric(row.Saf), returnTouchdowns: numeric(row["TD Ret"]),
        returnYards: numeric(row["Ret Yds"]), pointsAllowed: numeric(row.Points), yardsAllowed: numeric(row.Yards),
      };
    } else {
      throw new Error(`unsupported Razzball kind ${kind}`);
    }
    if (Object.values(stats).some((value) => value === null)) {
      rejected.malformedStats += 1;
      continue;
    }
    const applicable = scoringKind === "offense" ? OFFENSE_FIELDS : scoringKind === "idp" ? IDP_FIELDS : [];
    rows.push({
      name,
      team,
      position,
      detailedPosition: row["Pos Det"] || null,
      projectionGames: numeric(row.Games) ?? 17,
      scoringKind,
      stats,
      omittedScoringCategories: omitted(applicable, stats),
    });
  }
  return { rows, headers, rejected };
}

export function makePublicProjectionSnapshot({ sourceId, sourceFamily, documents, sourceAsOf, retrievedAt, rows, coverage, licenseUseNote }) {
  return {
    manifest: {
      snapshotId: `${sourceId}-2026-${sourceAsOf.slice(0, 10)}`,
      sourceId,
      sourceFamily,
      sourceAsOf,
      retrievedAt,
      contentSha256: hashDocuments(documents),
      gamesBasis: "player-specific games when supplied; otherwise 17-game regular season",
      projectionPeriod: "2026 regular season",
      licenseUseNote,
    },
    coverage,
    rows,
  };
}

export function parseFfcAdp(payload) {
  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
  const players = Array.isArray(parsed?.players) ? parsed.players : [];
  return players.map((row, index) => ({
    sourceRank: index + 1,
    name: String(row.name ?? "").trim(),
    team: String(row.team ?? "").toUpperCase(),
    position: String(row.position ?? "").toUpperCase() === "PK" ? "K" : String(row.position ?? "").toUpperCase(),
    adp: numeric(row.adp),
    minimumPick: numeric(row.min_pick),
    maximumPick: numeric(row.max_pick),
    timesDrafted: numeric(row.times_drafted),
  })).filter((row) => row.name && row.team && row.position && row.adp !== null);
}
