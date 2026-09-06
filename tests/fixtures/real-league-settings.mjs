// Sanitized rendered Yahoo league-value/default columns, independently captured
// from /f1/420010/settings on 2026-09-05T23:24Z. No account or owner data.
export const realScoringRows = [
  ["Offense", "League Value", "Yahoo Default Value"],
  ["Completions\nYahoo Default", ".10", "0"], ["Passing Yards", "25 yards per point", ""],
  ["Passing Touchdowns\nYahoo Default", "6", "4"], ["Interceptions\nYahoo Default", "-2", "-1"],
  ["Rushing Yards", "10 yards per point; 2 points at 100 yards", ""], ["Rushing Touchdowns", "6", ""],
  ["Receptions\nYahoo Default", ".25", "0.5"], ["Receiving Yards", "10 yards per point; 2 points at 100 yards", ""],
  ["Receiving Touchdowns", "6", ""], ["Return Yards", "50 yards per point", "0"], ["Return Touchdowns", "6", ""],
  ["2-Point Conversions", "2", ""], ["Fumbles Lost", "-2", ""], ["Offensive Fumble Return TD", "6", ""],
  ["Kickers", "League Value", "Yahoo Default Value"],
  ["Field Goals 0-19 Yards", "3", ""], ["Field Goals 20-29 Yards", "3", ""], ["Field Goals 30-39 Yards", "3", ""],
  ["Field Goals 40-49 Yards\nYahoo Default", "3", "4"], ["Field Goals 50+ Yards\nYahoo Default", "3", "5"],
  ["Point After Attempt Made", "1", ""], ["Point After Attempt Missed\nYahoo Default", "-1", "0"],
  ["Defense/Special Teams", "League Value", "Yahoo Default Value"],
  ["Sack", "1", ""], ["Interception\nYahoo Default", "1", "2"], ["Fumble Recovery", "2", ""], ["Touchdown", "6", ""],
  ["Safety", "2", ""], ["Block Kick", "2", ""], ["Kickoff and Punt Return Touchdowns", "6", ""],
  ["Points Allowed 0 points", "10", ""], ["Points Allowed 1-6 points", "7", ""], ["Points Allowed 7-13 points", "4", ""],
  ["Points Allowed 14-20 points\nYahoo Default", "2", "1"], ["Points Allowed 21-27 points", "0", ""],
  ["Points Allowed 28-34 points", "-1", ""], ["Points Allowed 35+ points", "-4", ""], ["Extra Point Returned", "2", ""],
  ["Defensive Players", "League Value", "Yahoo Default Value"],
  ["Tackle Solo\nYahoo Default", ".5", "1"], ["Tackle Assist\nYahoo Default", ".25", "0.5"], ["Sack", "2", ""],
  ["Interception", "3", ""], ["Fumble Force", "2", ""], ["Fumble Recovery", "2", ""], ["Defensive Touchdown", "6", ""],
  ["Safety", "2", ""], ["Pass Defended", "1", ""], ["Block Kick", "2", ""], ["Tackles for Loss\nYahoo Default", "1", "0"],
  ["Turnover Return Yards", "10 yards per point", "0"], ["Extra Point Returned", "2", ""],
];

export function realSettingsTables(rows = realScoringRows) {
  return [{ querySelectorAll:() => rows.map((cells) => ({ querySelectorAll:() => cells.map((innerText) => ({ innerText })) })) }];
}
