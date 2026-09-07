const $=id=>document.getElementById(id),text=(tag,value,cls)=>{const el=document.createElement(tag);el.textContent=value;if(cls)el.className=cls;return el;},num=n=>Number.isFinite(n)?n.toFixed(1):'—';
const opponents=packet.opponents??[],key=`skrodzkai-draft-order:${packet.leagueId}:${packet.scoringModel}`,favKey=`skrodzkai-favorites:${packet.leagueId}:2026`;
let order=Object.create(null),selected=opponents[0]??null,sortKey='value',sortDirection='desc',favorites=new Set(),drafted=new Set(),ledger=null,historyLimit=5,tierFilter=null;
const tiers=playerTiers(packet.players),prebuilt=new Map();
for(let seat=1;seat<=packet.teams;seat++)prebuilt.set(seat,Array.from({length:packet.rounds},(_,i)=>roundTargets(packet,seat,i+1)));
function message(value){$('message').textContent=value;}
try{const saved=localStorage.getItem(key);if(saved)order=validateOrder(JSON.parse(saved),packet);const f=JSON.parse(localStorage.getItem(favKey)??'[]');if(!Array.isArray(f))throw Error();favorites=new Set(f.filter(id=>packet.players.some(p=>p.yahooId===id)));}catch{message('Saved preferences could not be read; verify your seat and favorites.');}
$('identity').textContent=`${packet.leagueId==='420010'?'2 Minute Drillers':'League Two · TEST'} · ${packet.teams} teams · ${packet.rounds} rounds`;
$('snapshot').textContent=`Snapshot ${new Date(packet.observedAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}`;
function connectionStatus(){if(!ledger)return 'OFFLINE';if(ledger.status==='COMPLETE')return 'COMPLETE';return Date.now()-ledger.checkedAt>6000||Date.now()<ledger.checkedAt?'DISCONNECTED':ledger.status;}
function renderHealth(){
 const ready=boardReady(packet);$('health').textContent=ready?'Data review passed':packet.health==='PASS'?'Status check due':'Data review not passed';$('health').className=ready?'':'warn';$('health').title=packet.notice;
 const status=connectionStatus(),last=ledger?.lastConfirmed??0;
 $('connection').textContent=status==='OFFLINE'?'Offline reference':`${status} · last confirmed #${last}${status==='COMPLETE'?` · captured ${new Date(ledger.checkedAt).toLocaleString()}`:''}`;
 $('connection').className=status==='LIVE'?'connected':status==='COMPLETE'?'muted':'warn';
 $('connection').title=ledger?.reason??'This standalone file does not receive Yahoo picks. Open the live desk from the extension.';
 $('feedNote').textContent=status==='LIVE'?'Availability reconciled with Yahoo.':status==='COMPLETE'?'Complete draft results received.':ledger?'Showing confirmed picks only; later picks may be missing. Live availability is not verified.':'Captured board — no live availability claim.';
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
   const t=tiers.get(p.yahooId),row=text('tr','','tier-row');row.dataset.tier=String(t?.tier??0);row.style.setProperty('--tier-alpha',t?.tier%2?'.075':'.025');
   if(drafted.has(p.yahooId)){row.classList.add('drafted');row.title='Confirmed drafted in Yahoo';}
   const star=text('button',favorites.has(p.yahooId)?'★':'☆','star');star.setAttribute('aria-label',`Favorite ${p.name}`);star.setAttribute('aria-pressed',String(favorites.has(p.yahooId)));star.onclick=()=>toggleFavorite(p);const favorite=text('td','');favorite.append(star);
   const name=text('td','','namecell'),button=text('button',p.name,'player');button.title=p.name;button.onclick=()=>showDetails(p);name.append(button);
   const health=text('td','','statuscell');for(const w of playerWarnings(p)){const badge=text('button',w.label,'badge');badge.title=w.detail;badge.onclick=()=>showDetails(p);health.append(badge);}
   row.append(favorite,name,text('td',p.position,'position'),text('td',t?`T${t.tier}`:'—','num'),text('td',p.team,'nfl'),health,text('td',num(p.vor),'num value'),text('td',num(p.projection),'num'),text('td',num(p.marketAdp),'num'),text('td',p.bye??'—','num'));return row;
 }));
}
function renderTiers(){
 const counts=tierCounts(packet.players,tiers,drafted),grid=$('tierGrid');grid.replaceChildren();
 for(const pos of SCOUT_POSITIONS){const column=text('div','','tier-column');column.append(text('strong',pos));for(const c of counts.filter(x=>x.position===pos).sort((a,b)=>a.tier-b.tier)){const b=text('button','','tier-box');const id=`${pos}:${c.tier}`;b.setAttribute('aria-pressed',String(tierFilter===id));b.title=`${c.remaining} of ${c.total} not recorded drafted; ${ledger?'check feed status':'snapshot only'}`;b.append(text('small',`TIER ${c.tier}`),text('strong',`${c.remaining}`));b.onclick=()=>{tierFilter=tierFilter===id?null:id;renderTiers();renderBoard();};column.append(b);}grid.append(column);}
 $('clearTier').hidden=!tierFilter;
}
$('clearTier').onclick=()=>{tierFilter=null;renderTiers();renderBoard();};
function showDetails(p){$('detailName').textContent=p.name;$('detailBody').textContent=`${p.team} · Eligible: ${p.eligible.join(', ')}\nValue above replacement: ${num(p.vor)}\nCustom points, weeks 1–17: ${num(p.projection)}\nFull-season source consensus: ${num(p.sourceSeasonProjection)}\nADP: ${num(p.marketAdp)} · Draft range: ${num(p.adpLow)}–${num(p.adpHigh)}\n${p.marketAdp==null?'No matched ADP in this feed.\n':''}\n${playerWarnings(p).map(w=>w.detail).join('\n')}\n${injuryNotes(p)}\n\nValidation: ${p.validationStatus??'UNREVIEWED'}\n${p.idpModelWarning??''}\n${p.notes??''}`;$('details').showModal();}
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
 panel.append(text('p',`Median across last ${historyLimit} drafts · latest five seasons shown · “—” means not drafted`,'inline-note'));
 const recent=[...card.seasons].sort((a,b)=>b-a).slice(0,5).reverse(),table=text('table','','scout-table'),head=text('thead',''),tr=text('tr','');
 for(const label of ['Position','Median',...recent.map(String)]){const th=text('th',label);th.scope='col';tr.append(th);}head.append(tr);table.append(head);const body=text('tbody','');
 for(const pos of SCOUT_POSITIONS){const summary=timingWindow(card,pos,historyLimit),row=text('tr','');row.append(text('td',pos),text('td',summary.missing?'Unavailable':summary.median===null?'—':`R${summary.median}`,'median num'));for(const year of recent){const value=(card.specialty[pos].history??card.specialty[pos].recent).find(x=>x.season===year);row.append(text('td',value?.round==null?'—':`R${value.round}`,'num'));}body.append(row);}table.append(body);const wrap=text('div','','scout-table-wrap');wrap.append(table);panel.append(wrap,text('p',orderContext(card,Number($('planningRound').value)),'order-context'));
}
function renderCards(){
 $('opponentCount').textContent=`${opponents.length} opponents`;
 $('opponentTeams').replaceChildren(...opponents.map(card=>{const b=text('button','','team-card');b.dataset.teamId=card.teamId;b.setAttribute('aria-controls','opponentDetail');b.setAttribute('aria-pressed','false');b.append(text('small',`${card.managerId}${order[card.managerId]?` · Seat ${order[card.managerId]}`:''}`),text('strong',card.teamName),text('span',opponentSummary(card).headline));b.onclick=()=>selectOpponent(card);return b;}));
 if(selected)selectOpponent(selected);
}
for(let r=1;r<=packet.rounds;r++)$('planningRound').append(new Option(`R${r}`,r));$('planningRound').onchange=()=>{if(selected)selectOpponent(selected);};
for(const owner of [{managerId:'ours',teamName:'SKRODZKai'},...opponents]){const label=text('label','','order-field'),select=document.createElement('select');select.dataset.owner=owner.managerId;select.setAttribute('aria-label',`Snake seat for ${owner.teamName}`);select.append(new Option('Unassigned',''));for(let n=1;n<=packet.teams;n++)select.append(new Option(`Seat ${n}`,n));select.value=order[owner.managerId]??'';label.append(text('span',owner.teamName),select);$('orderFields').append(label);}
function renderStrategy(){
 const panel=$('strategy');panel.replaceChildren();if(!order.ours){panel.append(text('p','Choose your snake seat to load its prebuilt round-by-round plan.','muted'));return;}
 panel.append(text('p',order.ours===1||order.ours===packet.teams?'Turn seat: evaluate each two-pick pair together; secure a scarce tier before the long wait.':'Middle seat: compare the best values at every turn; the wait alternates each round.'));
 panel.append(text('p','Five strongest values in a plausible ADP / Yahoo-rank window. Alternatives, not a scripted roster or a guarantee they survive. No fixed positions by round.','inline-note'));
 if(!boardReady(packet))panel.append(text('p','Data status check due. These are saved planning targets, not fresh live recommendations.','warn'));
 for(let round=1;round<=packet.rounds;round++){
   const pick=nextTurns(order.ours,1,packet.teams,packet.rounds)[round-1],intel=roundOpponents(packet,order,round),card=text('article','','round-card');card.append(text('h3',`Round ${round} · Pick #${pick}`));
   const before=intel.before;card.append(text('p',before==='BACK_TO_BACK'?'Your own back-to-back pick.':before?`Immediately ahead: ${before.teamName}. ${round===1?opponentSummary(before).detail:orderContext(before,round-1)}`:pick===1?'You open the draft.':'Manager ahead is unassigned.','round-intel'));
   if(intel.between.length){const pressure=SCOUT_POSITIONS.map(pos=>{const owners=intel.between.filter(c=>{const rounds=new Set(opponentBetween(c,order,round,packet).map(p=>Math.ceil(p/packet.teams)));return c.specialty[pos].recent.some(x=>x.round!==null&&rounds.has(x.round));});return owners.length?`${pos}: ${owners.length} managers`:null;}).filter(Boolean);card.append(text('p',`Before your next turn: ${intel.between.length} opponents.${pressure.length?` Historical first-position timing overlaps — ${pressure.join(' · ')}.`:''}`,'round-intel'));}
   const targets=ledger?roundTargets(packet,order.ours,round,drafted):prebuilt.get(order.ours)[round-1],list=text('ol','','target-list');
   for(const p of targets){const li=text('li',''),b=text('button',p.name,'target-player');b.onclick=()=>showDetails(p);li.append(b,text('span',`${p.position} · value ${num(p.vor)} · ${tiers.get(p.yahooId)?`T${tiers.get(p.yahooId).tier}`:'un-tiered'} · ${Number.isFinite(p.marketAdp)?`ADP ${num(p.marketAdp)}`:'Yahoo timing; ADP missing'}`),text('small',playerWarnings(p).map(w=>w.label).join(' · ')));list.append(li);}card.append(list);
   if(targets.length<5)card.append(text('p',`Only ${targets.length} eligible targets in this window. Use the full board for alternatives; missing evidence is not filled with guesses.`,'inline-note'));
   panel.append(card);
 }
}
$('saveOrder').onclick=()=>{try{const candidate=Object.create(null);for(const select of $('orderFields').querySelectorAll('select'))if(select.value)candidate[select.dataset.owner]=Number(select.value);order=validateOrder(candidate,packet);try{localStorage.setItem(key,JSON.stringify(order));$('orderStatus').textContent=Object.keys(order).length===packet.teams?'Complete order saved; plan updated':'Partial order saved; unassigned managers have no seat context';}catch{message('Order saved in this tab only.');}renderCards();renderStrategy();}catch(e){message(e.message);}};
for(const [value,label]of Object.entries({favorites:'Favorites first',tier:'Positional tier',name:'Player name',position:'Position',team:'NFL team',health:'Health status',adp:'Average draft position',bye:'Bye week'}))$('sort').append(new Option(label,value));
for(const id of ['search','position','favoritesOnly','hideDrafted'])$(id).addEventListener('input',renderBoard);
$('sort').onchange=()=>{sortKey=$('sort').value;sortDirection=['value','points','favorites'].includes(sortKey)?'desc':'asc';renderBoard();};
for(const th of document.querySelectorAll('[data-sort]'))th.onclick=()=>{const next=th.dataset.sort;sortDirection=next===sortKey?(sortDirection==='asc'?'desc':'asc'):['value','points','favorites'].includes(next)?'desc':'asc';sortKey=next;$('sort').value=next;renderBoard();};
renderHealth();renderBoard();renderTiers();renderCards();renderStrategy();setInterval(renderHealth,1000);
