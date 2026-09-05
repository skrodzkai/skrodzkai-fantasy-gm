// Sanitized scoring-table values observed via Yahoo settings UI, 2026-09-05.
// Includes the distinct Yahoo-default column to detect wrong-column parsing.
export const scoringRows = [
  ["Offense", "League Value", "Yahoo Default Value"],
  ["Passing Yards", "25 yards per point"], ["Passing Touchdowns", "4"], ["Interceptions", "-1"],
  ["Rushing Yards", "10 yards per point"], ["Rushing Touchdowns", "6"], ["Receptions", "0.5"],
  ["Receiving Yards", "10 yards per point"], ["Receiving Touchdowns", "6"], ["Return Touchdowns", "6"],
  ["2-Point Conversions", "2"], ["Fumbles Lost", "-2"], ["Offensive Fumble Return TD", "6"],
  ["Kickers", "League Value", "Yahoo Default Value"],
  ["Field Goals 0-19 Yards", "3"], ["Field Goals 20-29 Yards", "3"], ["Field Goals 30-39 Yards", "3"],
  ["Field Goals 40-49 Yards", "4"], ["Field Goals 50+ Yards", "5"], ["Point After Attempt Made", "1"],
  ["Defense/Special Teams", "League Value", "Yahoo Default Value"],
  ["Sack", "1"], ["Interception", "2"], ["Fumble Recovery", "2"], ["Touchdown", "6"], ["Safety", "2"],
  ["Block Kick", "2"], ["Kickoff and Punt Return Touchdowns", "6"], ["Points Allowed 0 points", "10"],
  ["Points Allowed 1-6 points", "7"], ["Points Allowed 7-13 points", "4"], ["Points Allowed 14-20 points", "1"],
  ["Points Allowed 21-27 points", "0"], ["Points Allowed 28-34 points", "-1"], ["Points Allowed 35+ points", "-4"],
  ["Extra Point Returned", "2"],
  ["Defensive Players", "League Value", "Yahoo Default Value"],
  ["Tackle Solo\nYahoo Default", "0.5", "1"], ["Tackle Assist\nYahoo Default", "0.25", "0.5"],
  ["Sack", "2"], ["Interception", "3"], ["Fumble Force", "2"], ["Fumble Recovery", "2"],
  ["Defensive Touchdown", "6"], ["Safety", "2"], ["Pass Defended\nYahoo Default", "0.25", "1"],
  ["Block Kick", "2"], ["Tackles for Loss\nYahoo Default", ".25", "0"],
  ["Turnover Return Yards", "25 yards per point", "0"], ["Extra Point Returned", "2"],
];

export function withScoringTable(document, rows = scoringRows) {
  return { ...document, querySelectorAll:(selector) => selector === "table" ? [{
    querySelectorAll:() => rows.map((cells) => ({ querySelectorAll:() => cells.map((innerText) => ({ innerText })) })),
  }] : [] };
}
