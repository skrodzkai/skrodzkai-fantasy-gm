import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import './yahoo-pick-ledger.js';
const {reconcile,status,readResults}=globalThis.SKRODZKaiPickLedger;
const leagueId='542830',options={leagueId,now:1000},seat=n=>Math.ceil(n/12)%2?(n-1)%12+1:12-(n-1)%12;
const rows=n=>Array.from({length:n},(_,i)=>({overall:i+1,yahooId:String(100+i),name:`Player ${i}`,teamName:`Team ${seat(i+1)}`}));
const observation=(n,extra={})=>({leagueId,season:2026,picks:rows(n),currentPick:n+1,...extra});
test('all-team snake ledger captures every pick, including 228 selections',()=>{
 let ledger=null;for(let n=0;n<=228;n++){ledger=reconcile(ledger,observation(n),options);assert.equal(ledger.lastConfirmed,n);assert.equal(ledger.status,n===228?'COMPLETE':'LIVE');}
 assert.equal(new Set(ledger.picks.map(x=>x.teamName)).size,12);
});
test('gap retains confirmations, full replay recovers and duplicate update is idempotent',()=>{
 const initial=reconcile(null,observation(3),options);
 const gap=reconcile(initial,observation(5,{picks:rows(5).filter(x=>x.overall!==4)}),options);
 assert.equal(gap.status,'GAP');assert.equal(gap.picks.length,3);
 const restored=reconcile(gap,observation(5),options);assert.equal(restored.status,'LIVE');
 assert.deepEqual(reconcile(restored,observation(5),options),restored);
});
test('duplicates, regressions, changed picks, wrong identity and snake mismatch fail closed',()=>{
 const initial=reconcile(null,observation(12),options);
 for(const bad of [observation(11),observation(13,{leagueId:'420010'}),observation(13,{season:2025}),observation(13,{picks:[...rows(12),rows(12)[0]]}),observation(13,{picks:rows(13).map((p,i)=>i===12?{...p,teamName:'Wrong team'}:p)}),observation(13,{picks:rows(13).map((p,i)=>i===0?{...p,yahooId:'999'}:p)})]){
  const next=reconcile(initial,bad,options);assert.equal(next.status,'GAP');assert.deepEqual(next.picks,initial.picks);
 }
});
test('refresh restores saved confirmations; missing room counter never claims live',()=>{
 const saved=JSON.parse(JSON.stringify(reconcile(null,observation(20),options)));
 assert.equal(status(saved,8000),'DISCONNECTED');
 const next=reconcile(saved,observation(22,{currentPick:null}),{...options,now:9000});assert.equal(status(next,9001),'SNAPSHOT');assert.equal(next.picks.length,22);
 assert.equal(reconcile(next,observation(22,{currentPick:24}),options).status,'GAP');
 assert.equal(status(reconcile(null,observation(228),options),999999),'COMPLETE');
});
test('observed Yahoo round table parser requires exact player IDs and offsets',()=>{
 const row=(offset,id,name)=>({querySelectorAll:()=>[{textContent:`${offset}.`},{textContent:name,querySelector:()=>({textContent:name,getAttribute:()=>`https://sports.yahoo.com/nfl/players/${id}`})},{textContent:`Team ${seat(12+offset)}`} ]});
 const table={querySelector:()=>({textContent:'Round 2'}),querySelectorAll:()=>[row(1,'101','Player One'),row(2,'102','Player Two')]};
 const parsed=readResults({querySelectorAll:()=>[table]},{leagueId});assert.deepEqual(parsed.picks.map(p=>p.overall),[13,14]);assert.deepEqual(parsed.picks.map(p=>p.yahooId),['101','102']);
 assert.throws(()=>readResults({querySelectorAll:()=>[]},{leagueId}));
});
test('background keeps leagues separate, prefers room observer, persists across restart, and never sends a Yahoo command',async()=>{
 const local={};let listener,now=10000;const opened=[];
 const storage={get:async key=>({[key]:local[key]}),set:async values=>Object.assign(local,values),setAccessLevel:async()=>{}};
 const chrome={storage:{local:storage,session:storage},runtime:{getURL:path=>'chrome-extension://fixture/'+path,getManifest:()=>({version:'0.17.0'}),onMessage:{addListener:fn=>{listener=fn;}}},windows:{onRemoved:{addListener(){}}},tabs:{onRemoved:{addListener(){}},create:async options=>opened.push(options),sendMessage:()=>{throw Error('Unexpected Yahoo command');}}};
 const context=vm.createContext({URL,Date:class extends Date{static now(){return now;}},SKRODZKaiPickLedger});
 vm.runInContext(await readFile(new URL('../extension/command-center-background.js',import.meta.url),'utf8'),context);context.SKRODZKaiCommandCenterBackground.register(chrome);
 const send=(message,sender)=>new Promise(resolve=>{if(listener(message,sender,resolve)===false)resolve({ok:false});});
 const results={url:'https://football.fantasysports.yahoo.com/f1/542830/draftresults',tab:{id:1}},room={url:'https://football.fantasysports.yahoo.com/draftclient/f1/542830/3',tab:{id:2}},key='skz.picks:542830:2026';
 assert.equal((await send({type:'draft_ledger',observation:observation(2,{currentPick:null})},results)).status,'SNAPSHOT');
 assert.equal((await send({type:'draft_ledger',observation:observation(3)},room)).status,'LIVE');
 assert.equal((await send({type:'draft_ledger',observation:observation(2)},results)).error,'other_observer_active');
 assert.equal(local[key].picks.length,3);
 await send({type:'draft_ledger',observation:observation(4,{leagueId:'420010'})},room);assert.equal(local[key].status,'GAP');assert.equal(local[key].picks.length,3);assert.equal(local['skz.picks:420010:2026'],undefined);
 context.SKRODZKaiCommandCenterBackground.register(chrome);await send({type:'draft_ledger',observation:observation(4)},room);assert.equal(local[key].lastConfirmed,4);
 await send({type:'draft_ledger_error',reason:'Disconnected'},room);assert.equal(local[key].status,'GAP');assert.equal(local[key].lastConfirmed,4);
 const popup={url:chrome.runtime.getURL('extension/command-center.html')};
 await send({type:'open_draft_desk',leagueId:'420010'},popup);await send({type:'open_draft_desk',leagueId:'542830'},popup);await send({type:'open_draft_desk',leagueId:'99'},popup);assert.equal(opened.length,2);assert(opened[0].url.includes('/420010/'));assert(opened[1].url.includes('/542830/'));
});
