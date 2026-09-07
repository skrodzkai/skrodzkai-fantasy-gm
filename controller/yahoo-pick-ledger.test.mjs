import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import './yahoo-pick-ledger.js';
import './yahoo-page-readers.js';
const {reconcile,status,readResults}=globalThis.SKRODZKaiPickLedger;
const leagueId='542830',options={leagueId,now:1000},seat=n=>Math.ceil(n/12)%2?(n-1)%12+1:12-(n-1)%12;
const rows=n=>Array.from({length:n},(_,i)=>({overall:i+1,yahooId:String(100+i),name:`Player ${i}`,teamName:`Team ${seat(i+1)}`}));
const observation=(n,extra={})=>({leagueId,season:2026,picks:rows(n),currentPick:n+1,...extra});
test('public mock observed newest-first rows use exact IDs and reject ambiguous identities',()=>{
 const cell=(text,ids=[])=>({tagName:'TD',textContent:text,querySelectorAll:()=>ids.map(id=>({getAttribute:()=>id}))});
 const row=(n,id,name)=>({children:[cell(String(n)),cell(name,[id,id]),cell(n===1?'Nolan':'Abner')]});
 const captured=[{children:[{tagName:'TH',textContent:'Round 1'}]},row(2,'40055','B. Robinson'),row(1,'40059','J. Gibbs')];
 const table={querySelectorAll:selector=>selector==='thead th'?['Pick','Player','Team'].map(textContent=>({textContent})):captured};
 const doc={querySelectorAll:()=>[table]};
 const parsed=SKRODZKaiPickLedger.readMockResults(doc,{leagueId:'mock:10976187'});
 const ledger=reconcile(null,{...parsed,currentPick:3},{leagueId:'mock:10976187',rounds:15});
 assert.equal(ledger.status,'LIVE');assert.deepEqual(ledger.picks.map(p=>p.yahooId),['40059','40055']);
 captured[1].children[1]=cell('B. Robinson',['40055','40059']);
 assert.throws(()=>SKRODZKaiPickLedger.readMockResults(doc,{leagueId:'mock:10976187'}),/Unrecognized/);
 assert.throws(()=>SKRODZKaiPickLedger.readMockResults(doc,{leagueId:'420010'}),/mock identity/);
 assert.throws(()=>SKRODZKaiPickLedger.readMockResults({querySelectorAll:()=>[]},{leagueId:'mock:10976187'}),/not present/);
});
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
test('captured ROUND 18, PICK 214 banner is already overall, not a within-round offset',()=>{
 const turn=globalThis.SKRODZKaiYahooPageReaders.readOwnedTurn({title:'YOUR TURN',body:{innerText:'YOUR TURN • ROUND 18, PICK 214'},querySelectorAll:()=>[]});
 assert.equal(turn.round,18);assert.equal(turn.pick,214);
 assert.equal(reconcile(null,observation(213,{currentPick:turn.pick}),options).status,'LIVE');
 assert.equal(reconcile(null,observation(213,{currentPick:(turn.round-1)*12+turn.pick}),options).status,'GAP');
});
test('observed DEF slug parses and resolves exactly; missing or duplicate names identify the failure',()=>{
 const cells=[{textContent:'8.'},{textContent:'Texans (Hou - DEF)',querySelector:()=>({textContent:'Texans',getAttribute:()=> 'https://sports.yahoo.com/nfl/teams/houston/'})},{textContent:'Example team'}];
 const doc={querySelectorAll:()=>[{querySelector:()=>({textContent:'Round 10'}),querySelectorAll:()=>[{querySelectorAll:()=>cells}]}]};
 const parsed=readResults(doc,{leagueId});assert.equal(parsed.picks[0].defense,'houston');assert.equal(parsed.picks[0].overall,116);
 const match={position:'DEF',name:'Texans',yahooId:'100034'};
 assert.equal(SKRODZKaiPickLedger.resolveDefenses(structuredClone(parsed),[match]).picks[0].yahooId,'100034');
 for(const players of [[],[match,match]])assert.throws(()=>SKRODZKaiPickLedger.resolveDefenses(structuredClone(parsed),players),/Texans \(houston\)/);
});

test('DEF identity accepts only exact normalized nickname/city-prefix aliases and keeps canonical Yahoo IDs',()=>{
 const resolve=(name,players)=>SKRODZKaiPickLedger.resolveDefenses({picks:[{yahooId:null,defense:'houston',name}]},players).picks[0].yahooId;
 const row={position:'DEF',name:'Texans',yahooId:'100034'};
 for(const name of ['TEXANS',' Texans ','Houston Texans','Houston—Texans'])assert.equal(resolve(name,[row]),'100034');
 assert.equal(resolve('Texans',[{...row,name:'Houston Texans'}]),'100034');
 for(const name of ['Texans II','Not Texans','Dallas Texans'])assert.throws(()=>resolve(name,[row]),/unresolved/);
 for(const players of [[],[row,row],[{...row,yahooId:'DEF:houston'}],[{...row,position:'WR'}]])assert.throws(()=>resolve('Texans',players),/unresolved/);
});

test('off-turn counter uses captured header text, rejects ambiguity and does not confer turn ownership',()=>{
 const readers=globalThis.SKRODZKaiYahooPageReaders;
 const doc=body=>({title:'Live NFL Draft',body:{innerText:body},querySelectorAll:()=>[]});
 for(const [body,round,pick]of [["Opponent's Pick • You're up in 2 Picks • Round 19, Pick 217",19,217],["Opponent's Pick • You're up in 1 Picks • Round 18, Pick 213",18,213],['YOUR TURN • ROUND 18, PICK 214',18,214]]) {
   const d=doc(body);assert.deepEqual(readers.readCurrentPick(d),{round,pick});assert.equal(readers.readOwnedTurn(d),null);
 }
 for(const body of ['Round 1, Pick 0','Round 18, Pick 3','Round 20, Pick 229','Round 1, Pick 1\nRound 1, Pick 2','Round 1, Pick 1\nRound 1, Pick 1','No counter'])assert.equal(readers.readCurrentPick(doc(body)),null,body);
 const chat='Chat says • Round 1, Pick 2',d=doc(`Round 1, Pick 1\n${chat}`);d.querySelectorAll=()=>[{innerText:chat}];
 assert.equal(readers.readCurrentPick(d).pick,1);
});

test('room observer survives a competing tab lease and stops only after complete capture',async()=>{
 let tick,cleared=0;const received=[],replies=[{ok:false,error:'other_observer_active'},{ok:true,status:'LIVE'},{ok:true,status:'COMPLETE'}];
 const document={title:'Live NFL Draft',body:{innerText:"Opponent's Pick • You're up in 2 Picks • Round 1, Pick 4"},querySelectorAll:()=>[]};
 const context=vm.createContext({document,location:{pathname:'/draftclient/f1/542830/3',origin:'https://football.fantasysports.yahoo.com'},URL,AbortSignal,
   SKRODZKaiYahooMockBoard:{leagueId:'542830',players:[]},SKRODZKaiYahooPageReaders:globalThis.SKRODZKaiYahooPageReaders,
   SKRODZKaiPickLedger:{readResults:()=>observation(3),resolveDefenses:x=>x},
   DOMParser:class{parseFromString(){return{querySelector:()=>({textContent:'2026 draft order'})};}},
   fetch:async()=>({ok:true,url:'https://football.fantasysports.yahoo.com/f1/542830/draftresults',text:async()=>''}),
   setInterval:fn=>{tick=fn;return 1;},clearInterval:()=>{cleared++;},
   chrome:{runtime:{sendMessage:async m=>{received.push(m);return replies.shift();}}}});
 vm.runInContext(await readFile(new URL('../extension/draft-pick-observer.js',import.meta.url),'utf8'),context);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(cleared,0);assert.equal(received[0].observation.currentPick,4);
 await tick();assert.equal(cleared,0);assert.equal(received.length,2);
 await tick();assert.equal(cleared,1);assert.equal(received.length,3);
 assert.ok(received.every(m=>m.type==='draft_ledger'));
});

test('public observer reads visible history without fetching and reports missing history as a gap',async()=>{
 let tick,missing=false;const sent=[];
 const context=vm.createContext({document:{},location:{pathname:'/draftclient/f1/10976187/3',origin:'https://football.fantasysports.yahoo.com'},
  SKRODZKaiYahooPageReaders:{readCurrentPick:()=>({pick:3})},
  SKRODZKaiPickLedger:{readMockResults:(_doc,{leagueId})=>{if(missing)throw Error('Mock round results not present');return{leagueId,season:2026,picks:rows(2)};}},
  fetch:()=>{throw Error('Public observer must not fetch league endpoints');},
  setInterval:fn=>{tick=fn;return 1;},clearInterval:()=>{},
  chrome:{runtime:{sendMessage:async message=>{sent.push(message);return{status:'LIVE'};}}}});
 vm.runInContext(await readFile(new URL('../extension/draft-pick-observer.js',import.meta.url),'utf8'),context);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(sent[0].observation.leagueId,'mock:10976187');assert.equal(sent[0].observation.currentPick,3);
 missing=true;await tick();assert.equal(sent[1].type,'draft_ledger_error');assert.equal(sent[1].leagueId,'mock:10976187');
});
test('background keeps leagues separate, prefers room observer, persists across restart, and never sends a Yahoo command',async()=>{
 const local={};let listener,now=10000;const opened=[];
 const storage={get:async key=>({[key]:local[key]}),set:async values=>Object.assign(local,values),setAccessLevel:async()=>{}};
 const chrome={storage:{local:storage,session:storage},runtime:{getURL:path=>'chrome-extension://fixture/'+path,getManifest:()=>({version:'0.17.0'}),onMessage:{addListener:fn=>{listener=fn;}}},windows:{onRemoved:{addListener(){}}},tabs:{onRemoved:{addListener(){}},create:async options=>opened.push(options),sendMessage:()=>{throw Error('Unexpected Yahoo command');}}};
 const ledgerSource=await readFile(new URL('./yahoo-pick-ledger.js',import.meta.url),'utf8'),imports=[];
 let missingDesk=false;
 const context=vm.createContext({URL,Date:class extends Date{static now(){return now;}},fetch:async()=>({ok:!missingDesk,arrayBuffer:async()=>new ArrayBuffer(0)}),importScripts:path=>{imports.push(path);assert.equal(path,'../controller/yahoo-pick-ledger.js');vm.runInContext(ledgerSource,context);}});
 vm.runInContext(await readFile(new URL('../extension/command-center-background.js',import.meta.url),'utf8'),context);context.SKRODZKaiCommandCenterBackground.register(chrome);
 assert.deepEqual(imports,['../controller/yahoo-pick-ledger.js']);
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
 assert.match((await send({type:'open_draft_desk',leagueId:''},popup)).error,/league page/);
 missingDesk=true;assert.equal((await send({type:'open_draft_desk',leagueId:'420010'},popup)).ok,false);assert.equal(opened.length,2);
 missingDesk=false;
 const mockId='10974223',mockKey=`skz.picks:mock:${mockId}:2026`,waiting={url:`https://football.fantasysports.yahoo.com/f1/mock_waiting?mlid=${mockId}`,tab:{id:3}},mockRoom={url:`https://football.fantasysports.yahoo.com/draftclient/f1/${mockId}/12`,tab:{id:3}};
 const mockObservation={...observation(3),leagueId:`mock:${mockId}`};
 assert.equal((await send({type:'draft_ledger',observation:mockObservation},mockRoom)).ok,false);
 assert.equal((await send({type:'open_draft_desk',leagueId:mockId},popup)).ok,false);
 await send({type:'state',role:'arm-owner',at:now,snapshot:{mode:'UNKNOWN',context:{roomId:mockId,seat:12}}},waiting);
 assert.equal(local[`skz.mockFeed:${mockId}`],undefined);
 await send({type:'state',role:'arm-owner',at:now,snapshot:{mode:'MOCK',context:{roomId:mockId,seat:12}}},waiting);
 assert.equal(local[`skz.mockFeed:${mockId}`].rounds,15);
 assert.equal((await send({type:'draft_ledger',observation:mockObservation},{...mockRoom,url:mockRoom.url.replace('/12','/11')})).ok,false);
 assert.equal((await send({type:'draft_ledger',observation:mockObservation},mockRoom)).status,'LIVE');
 assert.equal(local[mockKey].lastConfirmed,3);assert.equal(local[key].lastConfirmed,4);assert.equal(local['skz.picks:420010:2026'],undefined);
 assert.equal((await send({type:'open_draft_desk',leagueId:mockId},popup)).ok,true);assert(opened.at(-1).url.endsWith(`/mock/index.html?room=${mockId}`));
 assert.equal((await send({type:'draft_ledger',observation:{...observation(180),leagueId:`mock:${mockId}`}},mockRoom)).status,'COMPLETE');
 const another={...mockRoom,url:mockRoom.url.replace(mockId,'10979999')};
 assert.equal((await send({type:'draft_ledger',observation:mockObservation},another)).ok,false);assert.equal(local['skz.picks:mock:10979999:2026'],undefined);
});
