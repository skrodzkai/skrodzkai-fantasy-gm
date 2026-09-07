import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {historyWindows,timingWindow,playerTiers,tierCounts,playerWarnings,roundTargets,roundOpponents,sourceComparison,injurySummary} from './manual-draft-model.mjs';
import {renderDesk,renderExtensionDesk,validatePacket} from './build-manual-draft-desk.mjs';
const players=Array.from({length:250},(_,i)=>({yahooId:String(i+1),name:`Player ${i}`,position:['QB','RB','WR','TE','K','DEF','LB'][i%7],eligible:[['QB','RB','WR','TE','K','DEF','LB'][i%7]],projection:500-i,vor:250-i,marketAdp:i+1,manualEligible:true}));
const packet={leagueId:'420010',scoringModel:'fixture',teams:12,rounds:19,health:'FAIL',observedAt:'2026-09-06T12:00Z',notice:'Synthetic QA',players};
test('source comparison separates published ranks from derived projections without changing rankings',()=>{
 const a={yahooId:'1',position:'RB',eligible:['RB'],manualEligible:true,vor:100,projection:200,expectedGamesThroughWeek17:16,yahooRank:7,sourceFamilyPerGamePoints:{yahoo:10,'espn-clay':12,cbs:11}},b={...a,yahooId:'2',vor:110,projection:210,sourceFamilyPerGamePoints:{yahoo:11,'espn-clay':10}},c={...a,yahooId:'3',manualEligible:false,vor:1000,sourceFamilyPerGamePoints:{yahoo:10}},p={players:[a,b,c]},before=JSON.stringify(p);
 const rows=sourceComparison(p,a);assert.deepEqual(rows.map(x=>x.name),['SKRODZKai','Yahoo','ESPN / Mike Clay','CBS']);assert.equal(rows[0].overall,2);assert.equal(rows[0].position,2);assert.equal(rows[1].overall,7);assert.equal(rows[1].position,2);assert.equal(rows[1].points,160);assert.equal(rows[2].overall,null);assert.equal(rows[2].position,1);assert.equal(rows[2].points,192);assert.equal(JSON.stringify(p),before);
 const absent=sourceComparison(p,{yahooId:'9',position:'RB',eligible:['RB'],vor:null,projection:null});assert.equal(absent.length,1);assert.equal(absent[0].overall,null);
 assert.equal(sourceComparison({players:[a]},{...a,expectedGamesThroughWeek17:null})[1].points,null);assert.equal(sourceComparison({players:[a]},a).some(x=>x.name==='Rotoworld'),false);
});
test('only genuinely clear injury state gets a one-line popup',()=>{
 const clear={status:'ACTIVE',draftAction:'CLEAR',availabilityStatus:'UNSPECIFIED'};assert.equal(injurySummary({injury:clear}).clear,true);
 for(const change of [{status:'QUESTIONABLE'},{draftAction:'REVIEW'},{conflict:true},{roleUncertain:true},{availabilityStatus:'EXPLICIT'},{bodyParts:['Knee']}])assert.equal(injurySummary({injury:{...clear,...change}}).clear,false);
 assert.equal(injurySummary({}).clear,false);
});
test('median sample windows use actual maximum, exclude nulls, and reveal absent history',()=>{
 const card={seasons:Array.from({length:15},(_,i)=>2011+i),specialty:{QB:{history:Array.from({length:15},(_,i)=>({season:2011+i,round:i<10?1:8})),recent:[]}}};
 assert.deepEqual(historyWindows(card),[5,10,15]);assert.equal(timingWindow(card,'QB',5).median,8);assert.equal(timingWindow(card,'QB',10).median,4.5);assert.equal(timingWindow(card,'QB',15).median,1);
 assert.deepEqual(historyWindows({...card,seasons:[2023,2024,2025]}),[3]);
 assert.equal(timingWindow({...card,specialty:{QB:{recent:[]}}},'QB',10).missing,true);
});
test('tier membership never moves after picks, counters count each player once',()=>{
 const tiers=playerTiers(players),before=JSON.stringify([...tiers]);const counts=tierCounts(players,tiers,new Set(['1','2']));
 assert.equal(counts.reduce((n,c)=>n+c.remaining,0),248);assert.equal(JSON.stringify([...tiers]),before);
 assert(!playerTiers([{yahooId:'x',position:'QB',projection:null}]).has('x'));
 assert([...tiers.values()].every(t=>t.tier>=1&&t.tier<=5));
});
test('source disagreement metadata rejects invented nonnumeric values',()=>{
 assert.throws(()=>validatePacket({...packet,players:[{...players[0],sourceFamilyPerGamePoints:{source:'20'}}]}));
});

// Lightweight element fixture exercises the shipped handlers, not a browser or live proof.
class Element {
 constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes={};this.value='';this.checked=false;this.style={setProperty(){}};this.className='';this.classList={add:c=>{this.className+=' '+c;}};}
 set textContent(value){this.label=String(value);this.children=[];}
 get textContent(){return (this.label??'')+this.children.map(x=>x.textContent).join('');}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this.label='';this.children=children;}
 setAttribute(k,v){this.attributes[k]=v;}
 addEventListener(k,fn){this['on'+k]=fn;}
 querySelectorAll(selector){return this.children.flatMap(c=>[...(c.tagName.toLowerCase()===selector?[c]:[]),...c.querySelectorAll(selector)]);}
 showModal(){this.open=true;}
}
test('shipped UI favorites, grey rows, hide, reload, tabs and order handlers work together',async()=>{
 const sample={teamId:'2',teamName:'Example',managerId:'opponent',seasons:[2021,2022,2023,2024,2025],rows:95,recentRound1:{WR:5},recentOpening:{WR:10,RB:10},specialty:Object.fromEntries(['QB','RB','WR','TE','DEF','IDP','K'].map(pos=>[pos,{medianRound:3,draftedSeasons:5,recent:[2021,2022,2023,2024,2025].map(season=>({season,round:3})),history:[2021,2022,2023,2024,2025].map(season=>({season,round:3}))}]))};
 const html=await renderDesk({...packet,opponents:[sample]}),script=html.match(/<script>([\s\S]*?)<\/script>/)[1],saved=new Map();
 function boot(){const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Element()]));elements.get('position').value='ALL';elements.get('planningRound').value='1';
 const views=['board','scouting','order'].map(view=>{const b=new Element('button');b.dataset.view=view;return b;}),headers=['favorites','tier','points'].map(sort=>{const b=new Element('th');b.dataset.sort=sort;return b;});
 const context=vm.createContext({document:{getElementById:id=>elements.get(id),createElement:tag=>new Element(tag),querySelectorAll:selector=>selector==='[data-view]'?views:headers},Option:function(label,value){const el=new Element('option');el.textContent=label;el.value=value;return el;},localStorage:{getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v)},setInterval(){}});vm.runInContext(script,context);return {elements,views,headers,context};}
 const ui=boot(),rows=ui.elements.get('players');assert.equal(rows.children.length,250);
 rows.children[1].children[0].children[0].onclick();ui.elements.get('favoritesOnly').checked=true;ui.elements.get('favoritesOnly').oninput();assert.equal(rows.children.length,1);
 ui.elements.get('favoritesOnly').checked=false;ui.elements.get('favoritesOnly').oninput();
 ui.headers[0].onclick();assert.equal(rows.children[0].children[0].children[0].attributes['aria-pressed'],'true');
 vm.runInContext("applyDraftLedger({leagueId:'420010',season:2026,status:'SNAPSHOT',checkedAt:Date.now(),lastConfirmed:1,picks:[{yahooId:'1'}]})",ui.context);
 assert(rows.children.some(r=>r.className.includes('drafted')));const sameRow=rows.children[0];vm.runInContext("applyDraftLedger(ledger)",ui.context);assert.equal(rows.children[0],sameRow,'heartbeat must not rebuild interactive rows');
 ui.elements.get('hideDrafted').checked=true;ui.elements.get('hideDrafted').oninput();assert.equal(rows.children.length,249);
 const fields=ui.elements.get('orderFields').querySelectorAll('select');fields[0].value='6';fields[1].value='5';ui.elements.get('saveOrder').onclick();assert.equal(ui.elements.get('roundNav').children.length,19);assert.equal(ui.elements.get('strategy').querySelectorAll('table').length,1);assert.match(ui.elements.get('strategy').textContent,/Round 1 · Pick #6/);
 assert.equal(ui.elements.get('orderSetup').hidden,true);assert.equal(ui.elements.get('orderStrip').hidden,false);ui.elements.get('roundNav').children[1].onclick();assert.match(ui.elements.get('strategy').textContent,/Round 2 · Pick #19/);assert(!ui.elements.get('strategy').textContent.includes('Round 1 ·'));
 ui.elements.get('editOrder').onclick();assert.equal(ui.elements.get('orderSetup').hidden,false);fields[1].value='6';ui.elements.get('saveOrder').onclick();assert(ui.elements.get('message').textContent.length>0);assert.equal(ui.elements.get('orderSetup').hidden,false);fields[1].value='5';ui.elements.get('saveOrder').onclick();assert.equal(ui.elements.get('message').textContent,'');
 ui.views[1].onclick();assert.equal(ui.elements.get('scouting').hidden,false);assert.equal(ui.elements.get('board').hidden,true);
 ui.headers[1].onclick();assert.equal(ui.headers[1].attributes['aria-sort'],'ascending');
 const reload=boot();reload.elements.get('favoritesOnly').checked=true;reload.elements.get('favoritesOnly').oninput();assert.equal(reload.elements.get('players').children.length,1);assert.equal(reload.elements.get('roundNav').children.length,19);assert.equal(reload.elements.get('orderSetup').hidden,true);assert.equal(reload.elements.get('feedNote').hidden,true);
 reload.elements.get('players').children[0].children[1].children[0].onclick();assert.equal(reload.elements.get('details').open,true);assert.match(reload.elements.get('detailBody').textContent,/Games missedUnknown/);assert(!reload.elements.get('detailBody').textContent.includes('Validation:'));
 vm.runInContext("applyDraftLedger({leagueId:'420010',season:2026,status:'LIVE',checkedAt:Date.now(),lastConfirmed:1,picks:packet.players.filter(p=>p.position==='QB').slice(0,-1).map(p=>({yahooId:p.yahooId}))})",reload.context);
 const boxes=reload.elements.get('tierGrid').querySelectorAll('button'),scarce=boxes.filter(b=>b.className.includes('scarce'));assert(scarce.length>0);assert(scarce.every(b=>b.children[1].textContent==='1'));assert(boxes.every(b=>/^[1-5]$/.test(b.dataset.tier)));
 assert(reload.elements.get('players').children.every(row=>/^[1-5]$/.test(row.dataset.tier)));
 let cleared=false,confirmed=false;
 reload.context.chrome={storage:{local:{get:async()=>({'skz.picks:420010:2026':{leagueId:'420010',season:2026,status:'COMPLETE',checkedAt:1,lastConfirmed:228,picks:[{yahooId:'1'}]}}),remove:async key=>{assert.equal(key,'skz.picks:420010:2026');cleared=true;}},onChanged:{addListener(){}}}};
 reload.context.confirm=()=>confirmed;
 vm.runInContext(await readFile(new URL('../extension/draft-desk-bridge.js',import.meta.url),'utf8'),reload.context);await new Promise(resolve=>setImmediate(resolve));
 assert.match(reload.elements.get('connection').textContent,/COMPLETE.*captured/);assert.equal(reload.elements.get('connection').className,'muted');
 await reload.elements.get('clearCapture').onclick();assert.equal(cleared,false);confirmed=true;await reload.elements.get('clearCapture').onclick();assert.equal(cleared,true);assert.equal(reload.elements.get('connection').textContent,'Offline reference');
});
test('compact visual contract: shared tier colors, centered scouting, controls adjacent to board',async()=>{
 const html=await renderDesk(packet),markup=html.split('</style>')[1].split('<script>')[0];
 assert(markup.indexOf('id="tierGrid"')<markup.indexOf('id="search"'));assert(markup.indexOf('id="hideDrafted"')<markup.indexOf('class="board-table"'));
 for(const [tier,rgb]of [[1,'65,192,132'],[2,'41,182,255'],[3,'228,197,68'],[4,'232,143,59'],[5,'225,89,105']])assert(html.includes(`[data-tier="${tier}"]{--tier-rgb:${rgb}}`));
 assert(html.includes('.tier-box.scarce{border-color:var(--red)'));assert(html.includes('.scout-table th,.scout-table td{text-align:center'));assert(html.includes('.scout-table td:nth-child(even)'));assert(html.includes('.board-table td:not(.namecell){width:1%}'));
 for(const removed of ['class="receipt"','class="round-card"','<pre','Captured board — no live availability claim.','Five strongest values in a plausible','Data status check due. These are saved'])assert(!html.includes(removed),removed);
 assert(!html.includes('opponentCount'));assert(markup.indexOf('class="scout-layout"')<markup.indexOf('class="section-heading"'));
 assert(html.includes('.scout-detail{grid-column:2;grid-row:1 / span 2;'));assert(html.includes('.scout-table td{height:38px}'));assert(html.includes('.scout-detail{grid-column:1;grid-row:auto;'));
});
test('12 seats by 19 rounds produce five value-ordered alternatives without blocked or drafted players',()=>{
 for(let seat=1;seat<=12;seat++)for(let round=1;round<=19;round++){const targets=roundTargets(packet,seat,round);assert.equal(targets.length,5);assert(targets.every((p,i)=>i===0||targets[i-1].vor>=p.vor));}
 const ids=new Set(roundTargets(packet,6,1).map(p=>p.yahooId));assert(roundTargets(packet,6,1,ids).every(p=>!ids.has(p.yahooId)));
 assert(roundTargets({...packet,players:players.map(p=>({...p,manualEligible:false}))},6,1).length===0);
});
test('warnings explain disagreement without any bye overlap penalty',()=>{
 const warnings=playerWarnings({bye:7,sourceFamilyPerGamePoints:{a:10,b:20},injury:{status:'ACTIVE',draftAction:'CLEAR'}});assert.deepEqual(warnings.map(x=>x.label),['SPLIT']);
 assert.deepEqual(playerWarnings({bye:7,injury:{status:'ACTIVE',draftAction:'CLEAR'}}),[]);
});
test('predecessor switches sides at snake turns and preserves back-to-back context',()=>{
 const a={managerId:'a'},b={managerId:'b'},p={...packet,opponents:[a,b]};assert.equal(roundOpponents(p,{ours:6,a:5,b:7},1).before,a);assert.equal(roundOpponents(p,{ours:6,a:5,b:7},2).before,b);assert.equal(roundOpponents(p,{ours:12},2).before,'BACK_TO_BACK');
});
test('offline fonts are embedded; extension copy has external script and no unsafe inline script',async()=>{
 const html=await renderDesk(packet);assert(html.includes('data:font/ttf;base64,'));assert(html.includes("font-family:'JetBrains Mono'"));assert(!html.includes('<details'));
 const dir=await mkdtemp(join(tmpdir(),'draft-desk-qa-'));
 try{await renderExtensionDesk(packet,dir);const ext=await readFile(join(dir,'index.html'),'utf8'),script=await readFile(join(dir,'desk.js'),'utf8');assert(ext.includes("script-src 'self'"));assert(!ext.includes('<script>'));new vm.Script(script);assert(script.includes('chrome.storage.local.get'));assert(!script.includes("type:'command'"));}finally{await rm(dir,{recursive:true});}
});
test('extension CLI builds private assets and refuses implicit overwrite',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'draft-desk-cli-'));
 try{const input=join(dir,'packet.json'),output=join(dir,'extension');await writeFile(input,JSON.stringify(packet));const cli=new URL('./build-manual-draft-desk.mjs',import.meta.url).pathname;
 execFileSync(process.execPath,[cli,input,'--extension',output]);assert((await readFile(join(output,'index.html'),'utf8')).includes('src="desk.js"'));
 assert.throws(()=>execFileSync(process.execPath,[cli,input,'--extension',output],{stdio:'pipe'}),/EEXIST/);
 }finally{await rm(dir,{recursive:true});}
});
