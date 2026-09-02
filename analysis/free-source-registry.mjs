export const FREE_SOURCE_REGISTRY = Object.freeze([
  Object.freeze({
    id: "yahoo",
    sourceFamily: "yahoo",
    evidenceKind: "league_projection_and_market",
    role: "authoritative league settings, Yahoo player identity, availability, and market context",
    access: "official Yahoo Fantasy Sports API or currently visible signed-in Yahoo UI",
    cost: "free",
    constraints: "OAuth is required for private API data; never persist browser session state or credentials",
    maximumRefreshHours: 6,
    licenseUseNote: "Private league data; use only in Joe's local draft workflow.",
  }),
  Object.freeze({
    id: "espn-mike-clay",
    sourceFamily: "espn-clay",
    evidenceKind: "raw_stat_projection",
    role: "independent 2026 offense projection input scored locally under league rules",
    access: "public ESPN Mike Clay 2026 projections PDF",
    cost: "free",
    constraints: "ingest raw stat columns only; do not use ESPN fantasy-point totals or redistribute the source PDF",
    maximumRefreshHours: 168,
    maximumRetrievalHours: 24,
    licenseUseNote: "Retain only source receipt and locally derived values; do not republish the PDF.",
  }),
  Object.freeze({
    id: "nfl-official",
    sourceFamily: "nfl-official",
    evidenceKind: "injury_and_role",
    role: "official practice participation and game-status reports",
    access: "NFL injury reports and official club reports",
    cost: "free",
    constraints: "report only published facts; do not infer diagnosis or recovery dates",
    maximumRefreshHours: 24,
    licenseUseNote: "Quote sparingly and retain factual status receipts only.",
  }),
  Object.freeze({
    id: "nflverse",
    sourceFamily: "nflverse",
    evidenceKind: "historical_stats_and_identity",
    role: "historical player statistics, schedules, rosters, and cross-provider player identifiers",
    access: "public nflverse release artifacts",
    cost: "free",
    constraints: "code is open source; underlying NFL data remains governed by its owners' terms",
    maximumRefreshHours: 168,
    licenseUseNote: "Use attribution and preserve upstream terms metadata.",
  }),
  Object.freeze({
    id: "sleeper",
    sourceFamily: "sleeper",
    evidenceKind: "injury_and_identity",
    role: "secondary player identity, active status, practice participation, and injury-status cross-check",
    access: "public read-only Sleeper API",
    cost: "free for non-commercial use",
    constraints: "attribute Sleeper when published; cache the player map and fetch no more than daily",
    maximumRefreshHours: 24,
    licenseUseNote: "Attribute Sleeper and cache no more frequently than daily.",
  }),
  Object.freeze({
    id: "draftkings-public",
    sourceFamily: "sportsbook-market",
    evidenceKind: "market_challenger",
    role: "manual, non-authoritative season-prop disagreement signal",
    access: "currently visible public DraftKings Sportsbook pages; no undocumented API",
    cost: "free",
    constraints: "manual receipt only; selection-biased coverage never counts as projection evidence",
    maximumRefreshHours: 48,
    licenseUseNote: "Retain only a factual line, public URL, capture time, and derived disagreement flag.",
  }),
  Object.freeze({
    id: "fanduel-public",
    sourceFamily: "sportsbook-market",
    evidenceKind: "market_challenger",
    role: "manual, non-authoritative season-prop disagreement signal",
    access: "currently visible public FanDuel Sportsbook pages; no undocumented API",
    cost: "free",
    constraints: "manual receipt only; selection-biased coverage never counts as projection evidence",
    maximumRefreshHours: 48,
    licenseUseNote: "Retain only a factual line, public URL, capture time, and derived disagreement flag.",
  }),
]);

export function validateSourceSnapshot(snapshot, asOf) {
  const now = Date.parse(asOf);
  if (!Number.isFinite(now)) throw new Error("asOf must be an ISO date");
  const registryById = new Map(FREE_SOURCE_REGISTRY.map((source) => [source.id, source]));
  return snapshot.map((entry) => {
    const policy = registryById.get(entry.sourceId);
    if (!policy) throw new Error(`unregistered source ${entry.sourceId}`);
    const sourceFamily = String(entry.sourceFamily ?? "");
    if (sourceFamily !== policy.sourceFamily) throw new Error(`${entry.sourceId} sourceFamily must be ${policy.sourceFamily}`);
    for (const field of ["snapshotId", "sourceAsOf", "retrievedAt", "gamesBasis", "projectionPeriod", "licenseUseNote"]) {
      if (!String(entry[field] ?? "").trim()) throw new Error(`${entry.sourceId} ${field} is required`);
    }
    if (!/^[a-f0-9]{64}$/.test(String(entry.contentSha256 ?? ""))) throw new Error(`${entry.sourceId} contentSha256 must be lowercase sha256`);
    const observed = Date.parse(entry.sourceAsOf);
    if (!Number.isFinite(observed)) throw new Error(`${entry.sourceId} sourceAsOf must be an ISO date`);
    const retrieved = Date.parse(entry.retrievedAt);
    if (!Number.isFinite(retrieved)) throw new Error(`${entry.sourceId} retrievedAt must be an ISO date`);
    const ageHours = (now - observed) / 3_600_000;
    const retrievalAgeHours = (now - retrieved) / 3_600_000;
    const maximumRetrievalHours = policy.maximumRetrievalHours ?? policy.maximumRefreshHours;
    const sourceFresh = ageHours >= 0 && ageHours <= policy.maximumRefreshHours;
    const retrievalFresh = retrievalAgeHours >= 0 && retrievalAgeHours <= maximumRetrievalHours;
    return {
      sourceId: entry.sourceId,
      sourceFamily,
      observedAt: entry.sourceAsOf,
      ageHours,
      retrievalAgeHours,
      maximumSourceAgeHours: policy.maximumRefreshHours,
      maximumRetrievalHours,
      sourceFresh,
      retrievalFresh,
      fresh: sourceFresh && retrievalFresh,
      role: policy.role,
    };
  });
}
