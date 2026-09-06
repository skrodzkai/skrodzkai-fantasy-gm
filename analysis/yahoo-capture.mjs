// Pure normalization of explicitly observed rendered cells. No network/browser access.
export function parseYahooCapture({ periodValue, periodLabel, observedAt, rows }) {
  if (periodValue !== "S_PS_2026" || periodLabel !== "Season (proj)") throw new Error("yahoo_capture_wrong_period");
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error("yahoo_capture_observation_time_missing");
  if (!Array.isArray(rows) || !rows.length) throw new Error("yahoo_capture_rows_missing");
  const seen = new Set();
  const numeric = (value, label) => {
    if (value === "-" || value === null) return null;
    if (value === undefined || value === "" || !Number.isFinite(Number(value))) throw new Error(`yahoo_capture_unreadable_${label}`);
    return Number(value);
  };
  const players = rows.map((row) => {
    const yahooId = String(row.yahooId ?? "");
    if (!/^\d+$/.test(yahooId) || seen.has(yahooId)) throw new Error("yahoo_capture_identity_ambiguous");
    seen.add(yahooId);
    if (row.identityComplete !== true || !row.name?.trim() || !row.team?.trim() || !row.eligible?.length ||
        typeof row.statusText !== "string") throw new Error(`yahoo_capture_identity_incomplete:${yahooId}`);
    // Empty is affirmative absence only after the caller read the entire status cell.
    // Preserve unfamiliar and hyphenated markers; downstream UNKNOWN is non-executable.
    return { yahooId, name:row.name.trim(), team:row.team.trim(), eligible:[...row.eligible],
      injuryStatus:row.statusText.trim() || null,
      games:numeric(row.games,"games"), bye:numeric(row.bye,"bye"),
      yahooProjectedPoints:numeric(row.projectedPoints,"points"),
      yahooPreseasonRank:numeric(row.preseasonRank,"preseason_rank"),
      yahooActualRank:numeric(row.actualRank,"actual_rank"),
      rosteredPercent:numeric(row.rosteredPercent,"rostered_percent") };
  });
  return { observedAt, statFilter:periodValue, statLabel:periodLabel, players };
}
