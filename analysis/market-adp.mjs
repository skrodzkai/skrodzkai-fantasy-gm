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
  for (const player of snapshot.players) {
    const key = `${identityKey(player.name, player.team)}:${String(player.position ?? "").toUpperCase()}`;
    if (byIdentity.has(key)) { byIdentity.delete(key); ambiguous.add(key); }
    else if (!ambiguous.has(key)) byIdentity.set(key, player);
  }
  let joined = 0;
  const rows = Array.from(baselineRows ?? [], (row) => {
    const key = `${identityKey(row.name, row.team)}:${String(row.position ?? "").toUpperCase()}`;
    const market = byIdentity.get(key);
    if (!market || !Number.isFinite(Number(market.adp))) return row;
    joined += 1;
    let payload = {};
    try { payload = row?.payload_json ? JSON.parse(row.payload_json) : {}; } catch { payload = {}; }
    return {
      ...row,
      adp:Number(market.adp),
      adp_low:Number.isFinite(Number(market.low)) ? Number(market.low) : row.adp_low,
      adp_high:Number.isFinite(Number(market.high)) ? Number(market.high) : row.adp_high,
      payload_json:JSON.stringify({
        ...payload,
        adp:Number(market.adp),
        adp_low:Number.isFinite(Number(market.low)) ? Number(market.low) : payload.adp_low,
        adp_high:Number.isFinite(Number(market.high)) ? Number(market.high) : payload.adp_high,
        adp_samples:Number.isFinite(Number(market.times_drafted)) ? Number(market.times_drafted) : payload.adp_samples,
        adp_source:"ffc-adp",
      }),
    };
  });
  const minimumJoined = Array.from(baselineRows ?? []).length >= 150 ? 100 : 1;
  if (joined < minimumJoined) throw new Error(`FFC ADP identity coverage is too small: ${joined}`);
  return { rows, joined, ambiguousIdentities:ambiguous.size };
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

