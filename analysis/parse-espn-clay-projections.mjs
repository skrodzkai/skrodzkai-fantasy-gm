import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const TEAM = Object.freeze({ BLT: "BAL", HST: "HOU", CLV: "CLE", ARZ: "ARI" });
const NFL_TEAM_CODES = new Set([
  "ARI", "ARZ", "ATL", "BAL", "BLT", "BUF", "CAR", "CHI", "CIN", "CLE", "CLV", "DAL", "DEN", "DET",
  "GB", "HOU", "HST", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG", "NYJ",
  "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS",
]);
const SECTION = Object.freeze({
  "Quarterback Projections": "QB",
  "Running Back Projections": "RB",
  "Wide Receiver Projections": "WR",
  "Tight End Projections": "TE",
  "Interior Defensive Line Projections": "DL",
  "Edge Rusher Projections": "DL",
  "Off-ball Linebacker Projections": "LB",
  "Cornerback Projections": "CB",
  "Safety Projections": "S",
});
const POSITIONS = Object.freeze([...new Set(Object.values(SECTION))]);
const IDP_POSITIONS = new Set(["DL", "LB", "CB", "S"]);
const APPLICABLE_SCORING = Object.freeze({
  QB: ["passingCompletions", "passingYards", "passingTouchdowns", "interceptions", "rushingYards", "rushingTouchdowns", "rushingHundredYardGames", "twoPointConversions", "fumblesLost", "returnYards", "returnTouchdowns", "offensiveFumbleReturnTouchdowns"],
  RB: ["rushingYards", "rushingTouchdowns", "rushingHundredYardGames", "receptions", "receivingYards", "receivingTouchdowns", "receivingHundredYardGames", "twoPointConversions", "fumblesLost", "returnYards", "returnTouchdowns", "offensiveFumbleReturnTouchdowns"],
  WR: ["rushingYards", "rushingTouchdowns", "rushingHundredYardGames", "receptions", "receivingYards", "receivingTouchdowns", "receivingHundredYardGames", "twoPointConversions", "fumblesLost", "returnYards", "returnTouchdowns", "offensiveFumbleReturnTouchdowns"],
  TE: ["rushingYards", "rushingTouchdowns", "rushingHundredYardGames", "receptions", "receivingYards", "receivingTouchdowns", "receivingHundredYardGames", "twoPointConversions", "fumblesLost", "returnYards", "returnTouchdowns", "offensiveFumbleReturnTouchdowns"],
  DL: ["soloTackles", "assistedTackles", "sacks", "interceptions", "forcedFumbles", "fumbleRecoveries", "touchdowns", "safeties", "passesDefended", "blockedKicks", "tacklesForLoss", "turnoverReturnYards", "extraPointReturns"],
  LB: ["soloTackles", "assistedTackles", "sacks", "interceptions", "forcedFumbles", "fumbleRecoveries", "touchdowns", "safeties", "passesDefended", "blockedKicks", "tacklesForLoss", "turnoverReturnYards", "extraPointReturns"],
  CB: ["soloTackles", "assistedTackles", "sacks", "interceptions", "forcedFumbles", "fumbleRecoveries", "touchdowns", "safeties", "passesDefended", "blockedKicks", "tacklesForLoss", "turnoverReturnYards", "extraPointReturns"],
  S: ["soloTackles", "assistedTackles", "sacks", "interceptions", "forcedFumbles", "fumbleRecoveries", "touchdowns", "safeties", "passesDefended", "blockedKicks", "tacklesForLoss", "turnoverReturnYards", "extraPointReturns"],
});

function number(value) {
  return Number(String(value).replaceAll(",", ""));
}

function isNumber(value) {
  return /^-?\d+(?:\.\d+)?$/.test(String(value ?? "").replaceAll(",", ""));
}

function validStatRelations(position, stats) {
  if (Object.values(stats).some((value) => !Number.isFinite(value) || value < 0)) return false;
  if (IDP_POSITIONS.has(position)) {
    return stats.soloTackles <= stats.totalTackles &&
      stats.assistedTackles <= stats.totalTackles &&
      Math.abs(stats.soloTackles + stats.assistedTackles - stats.totalTackles) <= 2;
  }
  if (position === "QB") {
    return stats.passingCompletions <= stats.passingAttempts &&
      stats.passingTouchdowns <= stats.passingCompletions &&
      stats.rushingTouchdowns <= stats.rushingAttempts &&
      stats.passingYards <= stats.passingAttempts * 100 &&
      stats.rushingYards <= stats.rushingAttempts * 100;
  }
  return stats.receptions <= stats.targets &&
    stats.receivingTouchdowns <= stats.receptions &&
    stats.rushingTouchdowns <= stats.rushingAttempts &&
    stats.rushingYards <= stats.rushingAttempts * 100 &&
    stats.receivingYards <= stats.targets * 100;
}

function omittedScoringCategories(position, stats) {
  return APPLICABLE_SCORING[position].filter((field) => !(field in stats));
}

export function parseEspnClayTextWithCoverage(text) {
  let position = null;
  const rows = [];
  const sections = new Set();
  const rejected = { invalidNumericRow: 0, invalidStatRelation: 0, zeroProjectedGames: 0 };
  for (const rawLine of String(text).split(/\r?\n/)) {
    const heading = Object.entries(SECTION).find(([label]) => rawLine.includes(label));
    if (heading) {
      position = heading[1];
      sections.add(position);
    }
    if (!position || /Team\s+Pos Rk/.test(rawLine)) continue;
    const columns = rawLine.trim().split(/\s+/);
    const teamIndex = columns.findIndex((value, index) => NFL_TEAM_CODES.has(value) && index > 0);
    if (teamIndex < 1) continue;
    const values = columns.slice(teamIndex + 1);
    const numericIndexes = position === "QB"
      ? [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11]
      : IDP_POSITIONS.has(position)
        ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
      : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const minimumColumns = IDP_POSITIONS.has(position) ? 10 : 12;
    if (values.length < minimumColumns || numericIndexes.some((index) => !isNumber(values[index]))) {
      rejected.invalidNumericRow += 1;
      continue;
    }
    const name = columns.slice(0, teamIndex).join(" ");
    const team = TEAM[columns[teamIndex]] ?? columns[teamIndex];
    const games = IDP_POSITIONS.has(position) ? 17 : number(values[2]);
    if (!(games > 0)) {
      rejected.zeroProjectedGames += 1;
      continue;
    }
    const stats = position === "QB"
      ? {
          passingAttempts: number(values[3]),
          passingCompletions: number(values[4]),
          passingYards: number(values[5]),
          passingTouchdowns: number(values[6]),
          interceptions: number(values[7]),
          rushingAttempts: number(values[9]),
          rushingYards: number(values[10]),
          rushingTouchdowns: number(values[11]),
        }
      : IDP_POSITIONS.has(position)
        ? {
            snaps: number(values[2]),
            totalTackles: number(values[3]),
            soloTackles: number(values[4]),
            assistedTackles: number(values[5]),
            tacklesForLoss: number(values[6]),
            sacks: number(values[7]),
            interceptions: number(values[8]),
            forcedFumbles: number(values[9]),
          }
        : {
          rushingAttempts: number(values[3]),
          rushingYards: number(values[4]),
          rushingTouchdowns: number(values[5]),
          targets: number(values[6]),
          receptions: number(values[7]),
          receivingYards: number(values[8]),
          receivingTouchdowns: number(values[9]),
        };
    if (!validStatRelations(position, stats)) {
      rejected.invalidStatRelation += 1;
      continue;
    }
    rows.push({
      name,
      team,
      position,
      projectionGames: games,
      scoringKind: IDP_POSITIONS.has(position) ? "idp" : "offense",
      stats,
      omittedScoringCategories: omittedScoringCategories(position, stats),
    });
  }
  return {
    rows,
    coverage: {
      sections: [...sections].sort(),
      rowsByPosition: Object.fromEntries(POSITIONS.map((value) => [value, rows.filter((row) => row.position === value).length])),
      rejected,
      scoringCategoriesByPosition: Object.fromEntries(POSITIONS.map((value) => {
        const parsed = [...new Set(rows.filter((row) => row.position === value).flatMap((row) => Object.keys(row.stats)))].sort();
        return [value, { parsed, omitted: APPLICABLE_SCORING[value].filter((field) => !parsed.includes(field)) }];
      })),
    },
  };
}

export function parseEspnClayText(text) {
  return parseEspnClayTextWithCoverage(text).rows;
}

export function makeEspnClaySnapshot({ text, pdfBytes, sourceAsOf, retrievedAt, etag = null, extraction = null }) {
  const parsed = parseEspnClayTextWithCoverage(text);
  return {
    manifest: {
      snapshotId: `espn-clay-2026-${sourceAsOf.slice(0, 10)}`,
      sourceId: "espn-mike-clay",
      sourceFamily: "espn-clay",
      sourceAsOf,
      retrievedAt,
      contentSha256: createHash("sha256").update(pdfBytes).digest("hex"),
      gamesBasis: "player-specific projected games for offense; ESPN's 17-game projection basis for IDP",
      projectionPeriod: "2026 regular season",
      licenseUseNote: "Raw offense and IDP stat columns only; ESPN fantasy-point totals are ignored and the PDF is not redistributed.",
      etag: etag || null,
      extraction,
    },
    coverage: parsed.coverage,
    rows: parsed.rows,
  };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((entry) => {
    const [key, ...value] = entry.replace(/^--/, "").split("=");
    return [key, value.join("=")];
  }));
  for (const key of ["pdf", "text", "output", "source-as-of", "retrieved-at"]) {
    if (!args[key]) throw new Error(`missing --${key}=...`);
  }
  const [pdfBytes, text] = await Promise.all([readFile(args.pdf), readFile(args.text, "utf8")]);
  const snapshot = makeEspnClaySnapshot({ pdfBytes, text, sourceAsOf: args["source-as-of"], retrievedAt: args["retrieved-at"] });
  await writeFile(args.output, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output: args.output, rows: snapshot.rows.length })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
