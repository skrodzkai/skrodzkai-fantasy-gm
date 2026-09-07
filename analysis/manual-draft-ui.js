const $=id=>document.getElementById(id),text=(tag,value,cls)=>{const el=document.createElement(tag);el.textContent=value;if(cls)el.className=cls;return el;},num=n=>Number.isFinite(n)?n.toFixed(1):'—';
const publicMock=packet.leagueId==='PUBLIC_MOCK';
if(publicMock){
 const room=new URLSearchParams(location.search).get('room');
 if(!/^[1-9]\d+$/.test(room??'')||['420010','542830','18599'].includes(room))throw Error('Explicit public mock room required.');
 packet.leagueId=`mock:${room}`;
}
const opponents=packet.opponents??[],key=`skrodzkai-draft-order:${packet.leagueId}:${packet.scoringModel}`,favKey=`skrodzkai-favorites:${packet.leagueId}:2026`;
let order=Object.create(null),selected=opponents[0]??null,sortKey='value',sortDirection='desc',favorites=new Set(),drafted=new Set(),ledger=null,historyLimit=5,tierFilter=null,selectedRound=1;
const tiers=playerTiers(packet.players),prebuilt=new Map();
for(let seat=1;seat<=packet.teams;seat++)prebuilt.set(seat,Array.from({length:packet.rounds},(_,i)=>roundTargets(packet,seat,i+1)));
function message(value){$('message').textContent=value;}
try{const saved=localStorage.getItem(key);if(saved)order=validateOrder(JSON.parse(saved),packet);const f=JSON.parse(localStorage.getItem(favKey)??'[]');if(!Array.isArray(f))throw Error();favorites=new Set(f.filter(id=>packet.players.some(p=>p.yahooId===id)));}catch{message('Saved preferences could not be read; verify your seat and favorites.');}
$('identity').textContent=publicMock?`Mock ${packet.leagueId.slice(5)} · reference rankings · live picks`:`${packet.leagueId==='420010'?'2 Minute Drillers':'League Two · TEST'} · ${packet.teams} teams · ${packet.rounds} rounds`;
$('snapshot').textContent=`Snapshot ${new Date(packet.observedAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}`;
function connectionStatus(){if(!ledger)return 'OFFLINE';if(ledger.status==='COMPLETE')return 'COMPLETE';return Date.now()-ledger.checkedAt>6000||Date.now()<ledger.checkedAt?'DISCONNECTED':ledger.status;}
function renderHealth(){
 const ready=boardReady(packet);$('health').textContent=ready?'Data review passed':packet.health==='PASS'?'Status check due':'Data review not passed';$('health').className=ready?'':'warn';$('health').title=packet.notice;
 const status=connectionStatus(),last=ledger?.lastConfirmed??0;
 $('connection').textContent=status==='OFFLINE'?'Offline reference':`${status} · last confirmed #${last}${status==='COMPLETE'?` · captured ${new Date(ledger.checkedAt).toLocaleString()}`:''}`;
 $('connection').className=status==='LIVE'?'connected':status==='COMPLETE'?'muted':'warn';
 $('connection').title=ledger?.reason??'This standalone file does not receive Yahoo picks. Open the live desk from the extension.';
 $('identity').title=`${$('snapshot').textContent} · ${$('health').textContent} · ${$('connection').textContent}`;
 $('feedNote').hidden=!ledger||status==='LIVE';
 $('feedNote').textContent=!ledger?'':status==='COMPLETE'?$('connection').textContent:`${status} · confirmed through pick #${last}`;
}
function applyDraftLedger(value){
 if(value&&(value.leagueId!==packet.leagueId||value.season!==2026)){message('Rejected picks from a different league or season.');return;}
 const next=new Set(value?.picks?.map(p=>p.yahooId)??[]),changed=next.size!==drafted.size||[...next].some(id=>!drafted.has(id));ledger=value;drafted=next;renderHealth();if(changed){renderBoard();renderTiers();renderStrategy();}
}
for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>{for(const b of document.querySelectorAll('[data-view]')){const active=b===button;b.setAttribute('aria-pressed',String(active));$(b.dataset.view).hidden=!active;}};
function toggleFavorite(p){if(favorites.has(p.yahooId))favorites.delete(p.yahooId);else favorites.add(p.yahooId);try{localStorage.setItem(favKey,JSON.stringify([...favorites]));}catch{message('Favorites saved for this tab only; browser storage unavailable.');}renderBoard();}
function renderBoard(){
 let players=rankedPlayers(packet,{position:$('position').value,search:$('search').value,sort:sortKey==='favorites'?'value':sortKey,direction:sortDirection});
 if(sortKey==='tier')players.sort((a,b)=>{const x=tiers.get(a.yahooId)?.tier,y=tiers.get(b.yahooId)?.tier;return x==null?(y==null?0:1):y==null?-1:(x-y)*(sortDirection==='asc'?1:-1);});
 if($('favoritesOnly').checked)players=players.filter(p=>favorites.has(p.yahooId));
 if($('hideDrafted').checked)players=players.filter(p=>!drafted.has(p.yahooId));
 if(tierFilter)players=players.filter(p=>{const t=tiers.get(p.yahooId);return t&&`${t.position}:${t.tier}`===tierFilter;});
 if(sortKey==='favorites')players.sort((a,b)=>(Number(favorites.has(b.yahooId))-Number(favorites.has(a.yahooId)))*(sortDirection==='desc'?1:-1));
 $('rows').textContent=`${players.length} shown · ${favorites.size} favorites`;
 for(const th of document.querySelectorAll('[data-sort]'))th.setAttribute('aria-sort',th.dataset.sort===sortKey?(sortDirection==='asc'?'ascending':'descending'):'none');
 $('players').replaceChildren(...players.map(p=>{
   const t=tiers.get(p.yahooId),row=text('tr','','tier-row');row.dataset.tier=String(t?.tier??0);
   if(drafted.has(p.yahooId)){row.classList.add('drafted');row.title='Confirmed drafted in Yahoo';}
   const star=text('button',favorites.has(p.yahooId)?'★':'☆','star');star.setAttribute('aria-label',`Favorite ${p.name}`);star.setAttribute('aria-pressed',String(favorites.has(p.yahooId)));star.onclick=()=>toggleFavorite(p);const favorite=text('td','');favorite.append(star);
   const name=text('td','','namecell'),button=text('button',p.name,'player');button.title=p.name;button.onclick=()=>showDetails(p);name.append(button);
   const health=text('td','','statuscell');for(const w of playerWarnings(p)){const badge=text('button',w.label,'badge');badge.title=w.detail;badge.onclick=()=>showDetails(p);health.append(badge);}
   row.append(favorite,name,text('td',p.position,'position'),text('td',t?`T${t.tier}`:'—','num'),text('td',p.team,'nfl'),health,text('td',num(p.vor),'num value'),text('td',num(p.projection),'num'),text('td',num(p.marketAdp),'num'),text('td',p.bye??'—','num'));return row;
 }));
}
function renderTiers(){
 const counts=tierCounts(packet.players,tiers,drafted),grid=$('tierGrid');grid.replaceChildren();
 for(const pos of SCOUT_POSITIONS){const column=text('div','','tier-column');column.append(text('strong',pos));for(const c of counts.filter(x=>x.position===pos).sort((a,b)=>a.tier-b.tier)){const b=text('button','','tier-box');b.dataset.tier=String(c.tier);if(c.remaining===1&&c.tier<5)b.classList.add('scarce');const id=`${pos}:${c.tier}`;b.setAttribute('aria-pressed',String(tierFilter===id));b.setAttribute('aria-label',`${pos} tier ${c.tier}: ${c.remaining} remaining`);b.title=`${c.remaining} of ${c.total} not recorded drafted; ${ledger?'check feed status':'snapshot only'}`;b.append(text('small',`TIER ${c.tier}`),text('strong',`${c.remaining}`));b.onclick=()=>{tierFilter=tierFilter===id?null:id;renderTiers();renderBoard();};column.append(b);}grid.append(column);}
 $('clearTier').hidden=!tierFilter;
}
$('clearTier').onclick=()=>{tierFilter=null;renderTiers();renderBoard();};
function showDetails(p){
 $('detailName').textContent=p.name;const panel=$('detailBody'),injury=injurySummary(p);
 panel.replaceChildren(text('p',`${p.team} · ${p.eligible.join(' / ')} · ${injury.status}`,'detail-meta'));
 const stats=text('div','','detail-stats');for(const [label,value]of [['Value +/−',num(p.vor)],['Points · W1–17',num(p.projection)],['ADP',num(p.marketAdp)],['Projected games · W1–17',injury.games??'—']]){const item=text('div','');item.append(text('small',label),text('strong',value));stats.append(item);}panel.append(stats);
 const comparison=text('table','','source-table'),head=text('thead',''),tr=text('tr','');for(const [label,tip]of [['Source','Only captured sources; derived position ranks use this board, not publisher rankings'],['Overall','SKRODZKai value rank or captured Yahoo published rank'],['Pos.','SKRODZKai value rank; external position ranks calculated from source projections within the captured board'],['Pts · W1–17','Source league-scored points per game × our projected games; not the publisher’s displayed season total']]){const th=text('th',label);th.title=tip;th.scope='col';tr.append(th);}head.append(tr);comparison.append(head);const body=text('tbody','');for(const entry of sourceComparison(packet,p)){const row=text('tr',''),label=text('td','');label.append(text('strong',entry.name),text('small',entry.basis));row.append(label,text('td',entry.overall??'—','num'),text('td',entry.position??'—','num'),text('td',num(entry.points),'num'));body.append(row);}comparison.append(body);panel.append(comparison);
 if(injury.clear)panel.append(text('p','No reported injury restriction.','injury-update'));
 else{
 if(injury.update){const update=text('p','','injury-update');update.append(text('small',`Latest report · ${injury.reportDate}`),text('span',injury.update));panel.append(update);}
 const facts=text('dl','','injury-facts');for(const [label,value]of [['Injury',injury.body],['Practice',injury.practice],['Games missed',injury.missed],...(injury.returnNote?[['Return',injury.returnNote]]:[])])facts.append(text('dt',label),text('dd',value));panel.append(facts,text('p',injury.impact,'injury-impact'));
 }
 const split=playerWarnings(p).find(w=>w.label==='SPLIT');if(split)panel.append(text('p',split.detail.split(' Diagnostic')[0],'injury-update'));
 if(p.idpModelWarning)panel.append(text('p','IDP estimate uses the Yahoo-based model; tackle-first calibration is unavailable.','injury-update'));
 if(!injury.clear&&injury.links.length){const sources=text('div','','detail-sources');injury.links.forEach((url,i)=>{const a=text('a',`Link ${i+1}`);a.href=url;a.target='_blank';a.rel='noopener noreferrer';sources.append(a);});panel.append(sources);}
 $('details').showModal();
}
function orderContext(card,round){
 if(!order.ours||!order[card.managerId])return 'Assign the actual draft order to add between-turn context.';
 const picks=opponentBetween(card,order,round,packet),windows=[];
 for(const pos of SCOUT_POSITIONS){const recent=card.specialty[pos].recent,rounds=new Set(picks.map(p=>Math.ceil(p/packet.teams))),hits=recent.filter(x=>x.round!==null&&rounds.has(x.round)).length;if(hits)windows.push(`${pos} ${hits}/${recent.length}`);}
 return `${card.teamName}: ${picks.length} selections before your next turn${picks.length?` (#${picks.join(', #')})`:''}.${windows.length?` Recent first-position picks in those rounds: ${windows.join(' · ')}.`:''}`;
}
function selectOpponent(card){
 selected=card;for(const b of $('opponentTeams').children)b.setAttribute('aria-pressed',String(b.dataset.teamId===card.teamId));
 const panel=$('opponentDetail');panel.replaceChildren(text('h3',card.teamName),text('p',`${card.managerId} · ${card.seasons.length} comparable drafts · ${order[card.managerId]?`Seat ${order[card.managerId]}`:'Seat unassigned'}`,'owner-meta'),text('p',card.summary?card.summary.join(' '):opponentSummary(card).headline,'owner-summary'));
 const choices=historyWindows(card);if(!choices.includes(historyLimit))historyLimit=choices[0];
 const controls=text('div','','history-controls');controls.append(text('strong','First pick at each position'));
 for(const n of choices){const b=text('button',String(n));b.setAttribute('aria-label',`Median across last ${n} drafts`);b.setAttribute('aria-pressed',String(n===historyLimit));b.onclick=()=>{historyLimit=n;selectOpponent(card);};controls.append(b);}panel.append(controls);
 const recent=[...card.seasons].sort((a,b)=>b-a).slice(0,5).reverse(),table=text('table','','scout-table'),head=text('thead',''),tr=text('tr','');
 for(const label of ['Position','Median',...recent.map(String)]){const th=text('th',label);th.scope='col';tr.append(th);}head.append(tr);table.append(head);const body=text('tbody','');
 for(const pos of SCOUT_POSITIONS){const summary=timingWindow(card,pos,historyLimit),row=text('tr','');row.append(text('td',pos),text('td',summary.missing?'Unavailable':summary.median===null?'—':`R${summary.median}`,'median num'));for(const year of recent){const value=(card.specialty[pos].history??card.specialty[pos].recent).find(x=>x.season===year);row.append(text('td',value?.round==null?'—':`R${value.round}`,'num'));}body.append(row);}table.append(body);const wrap=text('div','','scout-table-wrap');wrap.append(table);panel.append(wrap,text('p',orderContext(card,Number($('planningRound').value)),'order-context'));
}
function renderCards(){
 $('opponentTeams').replaceChildren(...opponents.map(card=>{const b=text('button','','team-card');b.dataset.teamId=card.teamId;b.setAttribute('aria-controls','opponentDetail');b.setAttribute('aria-pressed','false');b.append(text('small',`${card.managerId}${order[card.managerId]?` · Seat ${order[card.managerId]}`:''}`),text('strong',card.teamName),text('span',opponentSummary(card).headline));b.onclick=()=>selectOpponent(card);return b;}));
 if(selected)selectOpponent(selected);
}
for(let r=1;r<=packet.rounds;r++)$('planningRound').append(new Option(`R${r}`,r));$('planningRound').onchange=()=>{if(selected)selectOpponent(selected);};
for(const owner of [{managerId:'ours',teamName:'SKRODZKai'},...opponents]){const label=text('label','','order-field'),select=document.createElement('select');select.dataset.owner=owner.managerId;select.setAttribute('aria-label',`Snake seat for ${owner.teamName}`);select.append(new Option('Unassigned',''));for(let n=1;n<=packet.teams;n++)select.append(new Option(`Seat ${n}`,n));select.value=order[owner.managerId]??'';label.append(text('span',owner.teamName),select);$('orderFields').append(label);}
function renderStrategy(){
 const panel=$('strategy'),nav=$('roundNav');panel.replaceChildren();nav.replaceChildren();if(!order.ours){panel.append(text('p','Choose your seat above.','muted'));return;}
 for(let n=1;n<=packet.rounds;n++){const b=text('button',`R${n}`);b.setAttribute('aria-pressed',String(n===selectedRound));b.setAttribute('aria-label',`Round ${n}`);b.onclick=()=>{selectedRound=n;renderStrategy();};nav.append(b);}
 const round=selectedRound,turns=nextTurns(order.ours,1,packet.teams,packet.rounds),pick=turns[round-1],intel=roundOpponents(packet,order,round),title=text('div','','round-title');
 title.append(text('h3',`Round ${round} · Pick #${pick}`),text('span',round===packet.rounds?'Final pick':`${turns[round]-pick-1} picks until next turn`));panel.append(title);
 const before=intel.before;
 let context=before==='BACK_TO_BACK'?'Back-to-back picks':before?`Ahead: ${before.teamName}`:pick===1?'You pick first':'Ahead: seat unassigned';
 if(before&&before!=='BACK_TO_BACK'){
   const picks=Object.entries(round===1?before.recentRound1:Object.fromEntries(SCOUT_POSITIONS.map(pos=>[pos,before.specialty[pos].recent.filter(x=>x.round===round).length]))).filter(([,n])=>n>0).sort((a,b)=>b[1]-a[1]);
   if(picks.length){context+=` · ${round===1?'R1 history':'First-position history'}: ${picks.map(([pos,n])=>`${pos} ${n}`).join(' / ')}`;}
 }
 panel.append(text('p',context,'round-intel'));
 const targets=ledger?roundTargets(packet,order.ours,round,drafted):prebuilt.get(order.ours)[round-1],table=text('table','','target-table'),head=text('thead',''),headRow=text('tr','');
 for(const [label,cls]of [['#',''],['Player',''],['Pos',''],['Tier',''],['Value +/−','num'],['Points','num'],['ADP','num'],['Health','']]){const th=text('th',label,cls);th.scope='col';headRow.append(th);}head.append(headRow);table.append(head);const body=text('tbody','');
 targets.forEach((p,i)=>{const t=tiers.get(p.yahooId),row=text('tr','','tier-row');row.dataset.tier=String(t?.tier??0);const name=text('td',''),b=text('button',p.name,'player');b.onclick=()=>showDetails(p);name.append(b);const health=text('td','','statuscell');for(const w of playerWarnings(p)){const badge=text('button',w.label,'badge');badge.title=w.detail;badge.onclick=()=>showDetails(p);health.append(badge);}row.append(text('td',String(i+1),'num target-rank'),name,text('td',p.position,'position'),text('td',t?`T${t.tier}`:'—'),text('td',num(p.vor),'num value'),text('td',num(p.projection),'num'),text('td',num(p.marketAdp),'num'),health);body.append(row);});
 table.append(body);const wrap=text('div','','target-wrap');wrap.append(table);panel.append(wrap);
 if(targets.length<5)panel.append(text('p',`${targets.length} targets in range · see Player board for more`,'muted'));
}
function renderOrder(){
 $('orderSetup').hidden=Boolean(order.ours);$('orderStrip').hidden=!order.ours;const strip=$('orderStripList');strip.replaceChildren();
 for(const owner of [{managerId:'ours',teamName:'SKRODZKai'},...opponents].filter(o=>order[o.managerId]).sort((a,b)=>order[a.managerId]-order[b.managerId])){const item=text('span','');item.append(text('strong',`#${order[owner.managerId]}`),text('span',owner.teamName));strip.append(item);}
 if(Object.keys(order).length<packet.teams)strip.append(text('span',`${packet.teams-Object.keys(order).length} seats unassigned`,'muted'));
}
$('editOrder').onclick=()=>{for(const select of $('orderFields').querySelectorAll('select'))select.value=order[select.dataset.owner]??'';$('orderSetup').hidden=false;$('orderStrip').hidden=true;};
$('saveOrder').onclick=()=>{try{const candidate=Object.create(null);for(const select of $('orderFields').querySelectorAll('select'))if(select.value)candidate[select.dataset.owner]=Number(select.value);order=validateOrder(candidate,packet);message('');try{localStorage.setItem(key,JSON.stringify(order));$('orderStatus').textContent='Saved';}catch{message('Order saved in this tab only.');}renderOrder();renderCards();renderStrategy();}catch(e){message(e.message);}};
for(const [value,label]of Object.entries({favorites:'Favorites first',tier:'Positional tier',name:'Player name',position:'Position',team:'NFL team',health:'Health status',adp:'Average draft position',bye:'Bye week'}))$('sort').append(new Option(label,value));
for(const id of ['search','position','favoritesOnly','hideDrafted'])$(id).addEventListener('input',renderBoard);
$('sort').onchange=()=>{sortKey=$('sort').value;sortDirection=['value','points','favorites'].includes(sortKey)?'desc':'asc';renderBoard();};
for(const th of document.querySelectorAll('[data-sort]'))th.onclick=()=>{const next=th.dataset.sort;sortDirection=next===sortKey?(sortDirection==='asc'?'desc':'asc'):['value','points','favorites'].includes(next)?'desc':'asc';sortKey=next;$('sort').value=next;renderBoard();};
renderHealth();renderBoard();renderTiers();renderCards();renderOrder();renderStrategy();setInterval(renderHealth,1000);
