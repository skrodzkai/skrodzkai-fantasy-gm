export function snakePicks({ teams, seat, rounds }) {
  return Array.from({ length: rounds }, (_, index) => {
    const round = index + 1;
    return (round - 1) * teams + (round % 2 ? seat : teams - seat + 1);
  });
}

export function replayCapturedDraft({ uiMap, postmortem, clockSeconds = 30 }) {
  const expected = snakePicks({ teams: 12, seat: 3, rounds: 19 });
  const safePath = uiMap?.location?.pathname === "/draftclient/f1/18599/12";
  const capturedAllPicks = expected.every((pick) => new RegExp(`\\|\\s*\\d+\\s*\\|\\s*${pick}\\s*\\|`).test(postmortem));
  const genericDRegression = postmortem.includes("generic `D` selection must precede every LB/CB/S selection");
  const nearAutodraftReceipt = postmortem.includes("owner intervened at the final moment");
  const noCleanAutomationClaim = postmortem.includes("No clean automated-draft claim is valid");
  const sanitized = JSON.stringify(uiMap).match(/token|cookie|authorization|password/gi) == null;
  const gates = {
    exactYahooSurface: safePath,
    nineteenSnakePicks: capturedAllPicks,
    genericDFirstRegressionPresent: genericDRegression,
    nearAutodraftFailClosed: nearAutodraftReceipt,
    liveAutomationGapPreserved: noCleanAutomationClaim,
    sanitizedCapture: sanitized,
    thirtySecondDecisionBudget: clockSeconds === 30,
  };
  return {
    schemaVersion: 1,
    clockSeconds,
    ownedOverallPicks: expected,
    status: Object.values(gates).every(Boolean) ? "PASS" : "FAIL",
    gates,
    liveAutomationProven: false,
    provenFallback: "OWNER_MANUAL_RECOVERY",
  };
}
