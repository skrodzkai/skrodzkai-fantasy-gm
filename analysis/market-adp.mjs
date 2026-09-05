const TEAM_ALIASES = Object.freeze({ JAC: "JAX", WSH: "WAS", LA: "LAR" });

export function canonicalTeam(value) {
  const team = String(value ?? "").trim().toUpperCase();
  return TEAM_ALIASES[team] ?? team;
}

export function canonicalName(value, dropSuffix = false) {
  const normalized = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return dropSuffix ? normalized.replace(/\s+(jr|sr|ii|iii|iv|v)$/i, "") : normalized;
}

export function identityKey(name, team, dropSuffix = false) {
  return `${canonicalName(name, dropSuffix)}:${canonicalTeam(team)}`;
}

export function applyFreshAdpSnapshot(baselineRows, snapshot) {
  if (snapshot?.status !== "Success" || Number(snapshot?.meta?.teams) !== 12 || !Array.isArray(snapshot?.players) || snapshot.players.length < 150) {
    throw new Error("FFC ADP snapshot is incomplete or not a 12-team success payload");
  }
  const byIdentity = new Map();
  const ambiguous = new Set();
  const keyFor = (row) => {
    const position = String(row.position ?? "").toUpperCase().replace(/^PK$/, "K");
    return position === "DEF" ? `${canonicalTeam(row.team)}:DEF` : `${identityKey(row.name, row.team)}:${position}`;
  };
  for (const player of snapshot.players) {
    const key = keyFor(player);
    if (byIdentity.has(key)) { byIdentity.delete(key); ambiguous.add(key); }
    else if (!ambiguous.has(key)) byIdentity.set(key, player);
  }
  let joined = 0;
  const rows = Array.from(baselineRows ?? [], (row) => {
    const key = keyFor(row);
    const market = byIdentity.get(key);
    const matched = market?.adp != null && market.adp !== "" && Number.isFinite(Number(market.adp));
    if (matched) joined += 1;
    let payload = {};
    try { payload = row?.payload_json ? JSON.parse(row.payload_json) : {}; } catch { payload = {}; }
    return {
      ...row,
      adp:matched ? Number(market.adp) : null,
      adp_low:matched && market.low != null && market.low !== "" && Number.isFinite(Number(market.low)) ? Number(market.low) : null,
      adp_high:matched && market.high != null && market.high !== "" && Number.isFinite(Number(market.high)) ? Number(market.high) : null,
      payload_json:JSON.stringify({
        ...payload,
        adp:matched ? Number(market.adp) : null,
        adp_low:matched && market.low != null && market.low !== "" && Number.isFinite(Number(market.low)) ? Number(market.low) : null,
        adp_high:matched && market.high != null && market.high !== "" && Number.isFinite(Number(market.high)) ? Number(market.high) : null,
        adp_samples:matched && market.times_drafted != null && Number.isFinite(Number(market.times_drafted)) ? Number(market.times_drafted) : null,
        adp_source:matched ? "ffc-adp" : null,
      }),
    };
  });
  const minimumJoined = Array.from(baselineRows ?? []).length >= 150 ? 100 : 1;
  if (joined < minimumJoined) throw new Error(`FFC ADP identity coverage is too small: ${joined}`);
  return { rows, joined, unmatched:rows.length - joined, ambiguousIdentities:ambiguous.size };
}

export function adpSourceHealth(receipt, fileStat, asOf, options = {}) {
  const sourceAsOf = String(receipt.value?.meta?.end_date ?? "");
  const sourceDate = Date.parse(`${sourceAsOf}T23:59:59Z`);
  const observedAt = options.observedAt ?? fileStat.mtime.toISOString();
  const ageHours = (Date.parse(asOf) - Date.parse(observedAt)) / 3_600_000;
  const fresh = receipt.value?.status === "Success" && Number(receipt.value?.meta?.teams) === 12 &&
    Array.isArray(receipt.value?.players) && receipt.value.players.length >= 150 && Number.isFinite(sourceDate) &&
    Number.isFinite(ageHours) && ageHours >= 0 && ageHours <= 24;
  return {
    callerSupplied:true,
    fetched:false,
    sourceId:"ffc-adp",
    sourceAsOf,
    observedAt,
    ageHours,
    maximumAgeHours:24,
    rows:receipt.value?.players?.length ?? 0,
    fresh,
    contentSha256:receipt.contentSha256,
  };
}
