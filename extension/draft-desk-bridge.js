// Extension-owned private dashboard only; no external messaging or Yahoo commands.
const ledgerKey=`skz.picks:${packet.leagueId}:2026`;
const applyStored=stored=>applyDraftLedger(stored[ledgerKey]??null);
void chrome.storage.local.get(ledgerKey).then(applyStored).catch(()=>message('Pick storage unavailable; offline board retained.'));
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes[ledgerKey])applyDraftLedger(changes[ledgerKey].newValue??null);});
const clearCapture=document.getElementById('clearCapture');clearCapture.hidden=false;
clearCapture.onclick=async()=>{
 if(!confirm(`Clear locally captured picks for league ${packet.leagueId}? This does not undo any Yahoo picks.`))return;
 try{await chrome.storage.local.remove(ledgerKey);applyDraftLedger(null);message('Local capture cleared. Reload the Yahoo room to observe its current results.');}
 catch{message('Could not clear local capture; confirmed picks retained.');}
};
