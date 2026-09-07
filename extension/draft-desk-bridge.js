// Extension-owned private dashboard only; no external messaging or Yahoo commands.
const ledgerKey=`skz.picks:${packet.leagueId}:2026`;
const applyStored=stored=>applyDraftLedger(stored[ledgerKey]??null);
void chrome.storage.local.get(ledgerKey).then(applyStored).catch(()=>message('Pick storage unavailable; offline board retained.'));
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes[ledgerKey])applyDraftLedger(changes[ledgerKey].newValue??null);});
