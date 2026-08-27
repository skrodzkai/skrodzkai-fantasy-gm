import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { OFFENSE_SCORING } from "./player-intelligence.mjs";

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
});

function number(value) {
  return Number(String(value).replaceAll(",", ""));
}

function isNumber(value) {
  return /^-?\d+(?:\.\d+)?$/.test(String(value ?? "").replaceAll(",", ""));
}

export function parseEspnClayTextWithCoverage(text) {
  let position = null;
  const rows = [];
  const sections = new Set();
  const rejected = { invalidNumericRow: 0, zeroProjectedGames: 0 };
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
      : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    if (values.length < 12 || numericIndexes.some((index) => !isNumber(values[index]))) {
      rejected.invalidNumericRow += 1;
      continue;
    }
    const name = columns.slice(0, teamIndex).join(" ");
    const team = TEAM[columns[teamIndex]] ?? columns[teamIndex];
    const games = number(values[2]);
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
      : {
          rushingAttempts: number(values[3]),
          rushingYards: number(values[4]),
          rushingTouchdowns: number(values[5]),
          targets: number(values[6]),
          receptions: number(values[7]),
          receivingYards: number(values[8]),
          receivingTouchdowns: number(values[9]),
        };
    rows.push({
      name,
      team,
      position,
      projectionGames: games,
      stats,
      omittedScoringCategories: Object.keys(OFFENSE_SCORING).filter((field) => !(field in stats)),
    });
  }
  return {
    rows,
    coverage: {
      sections: [...sections].sort(),
      rowsByPosition: Object.fromEntries(Object.values(SECTION).map((value) => [value, rows.filter((row) => row.position === value).length])),
      rejected,
      scoringCategoriesByPosition: Object.fromEntries(Object.values(SECTION).map((value) => {
        const parsed = [...new Set(rows.filter((row) => row.position === value).flatMap((row) => Object.keys(row.stats)))].sort();
        return [value, { parsed, omitted: Object.keys(OFFENSE_SCORING).filter((field) => !parsed.includes(field)) }];
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
      gamesBasis: "player-specific projected games, maximum 17",
      projectionPeriod: "2026 regular season",
      licenseUseNote: "Raw stat columns only; ESPN fantasy-point totals are ignored and the PDF is not redistributed.",
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
