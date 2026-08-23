export const FREE_SOURCE_REGISTRY = Object.freeze([
  Object.freeze({
    id: "yahoo",
    role: "authoritative league settings, Yahoo player identity, availability, and market context",
    access: "official Yahoo Fantasy Sports API or currently visible signed-in Yahoo UI",
    cost: "free",
    constraints: "OAuth is required for private API data; never persist browser session state or credentials",
    maximumRefreshHours: 6,
  }),
  Object.freeze({
    id: "nfl-official",
    role: "official practice participation and game-status reports",
    access: "NFL injury reports and official club reports",
    cost: "free",
    constraints: "report only published facts; do not infer diagnosis or recovery dates",
    maximumRefreshHours: 24,
  }),
  Object.freeze({
    id: "nflverse",
    role: "historical player statistics, schedules, rosters, and cross-provider player identifiers",
    access: "public nflverse release artifacts",
    cost: "free",
    constraints: "code is open source; underlying NFL data remains governed by its owners' terms",
    maximumRefreshHours: 168,
  }),
  Object.freeze({
    id: "sleeper",
    role: "secondary player identity, active status, practice participation, and injury-status cross-check",
    access: "public read-only Sleeper API",
    cost: "free for non-commercial use",
    constraints: "attribute Sleeper when published; cache the player map and fetch no more than daily",
    maximumRefreshHours: 24,
  }),
]);

export function validateSourceSnapshot(snapshot, asOf) {
  const now = Date.parse(asOf);
  if (!Number.isFinite(now)) throw new Error("asOf must be an ISO date");
  const registryById = new Map(FREE_SOURCE_REGISTRY.map((source) => [source.id, source]));
  return snapshot.map((entry) => {
    const policy = registryById.get(entry.sourceId);
    if (!policy) throw new Error(`unregistered source ${entry.sourceId}`);
    const observed = Date.parse(entry.observedAt);
    if (!Number.isFinite(observed)) throw new Error(`${entry.sourceId} observedAt must be an ISO date`);
    const ageHours = (now - observed) / 3_600_000;
    return {
      sourceId: entry.sourceId,
      observedAt: entry.observedAt,
      ageHours,
      fresh: ageHours >= 0 && ageHours <= policy.maximumRefreshHours,
      role: policy.role,
    };
  });
}
