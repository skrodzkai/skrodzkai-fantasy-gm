// Offline reference only. No pick log, Yahoo adapter, execution queue, or network.
export const SCOUT_POSITIONS = ['QB','RB','WR','TE','DEF','IDP','K'];
export function opponentSummary(card) {
  const entries = Object.entries(card.recentRound1).sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]));
  const total = entries.reduce((n,[,count]) => n+count,0);
  if (!total) return {headline:'No recent first-round sample', detail:'No recent opening-round tendency is available.'};
  const leaders = entries.filter(([,count]) => count === entries[0][1]).map(([position]) => position);
  const headline = leaders.length > 1 ? `Mixed ${leaders.join(' / ')} openings` : `${leaders[0]} first in ${entries[0][1]} of ${total} recent drafts`;
  const detail = entries.map(([position,count]) => `${position} ${count}/${total}`).join(' · ');
  return {headline, detail};
}
export function seatAt(pick, teams = 12) {
  const round = Math.ceil(pick / teams), offset = (pick - 1) % teams;
  return round % 2 ? offset + 1 : teams - offset;
}
export function nextTurns(seat, pick, teams = 12, rounds = 19) {
  if (!Number.isInteger(seat) || seat < 1 || seat > teams) return [];
  return Array.from({length: teams * rounds}, (_, i) => i + 1)
    .filter(n => n >= pick && seatAt(n, teams) === seat);
}
export function validateOrder(value, packet) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid draft order.');
  const allowed = new Set(['ours', ...(packet.opponents||[]).map(c=>c.managerId)]), seen = new Set(), result = {};
  for (const [owner,seat] of Object.entries(value)) {
    if (!allowed.has(owner) || !Number.isInteger(seat) || seat < 1 || seat > packet.teams || seen.has(seat)) throw Error('Each assigned owner needs a unique snake seat, 1–12.');
    result[owner]=seat; seen.add(seat);
  }
  return result;
}
export function opponentBetween(card, order, round, packet) {
  const ours=order.ours, theirs=order[card.managerId];
  if (!ours || !theirs || round < 1 || round >= packet.rounds) return [];
  const turns=nextTurns(ours,1,packet.teams,packet.rounds);
  return nextTurns(theirs,turns[round-1]+1,packet.teams,packet.rounds).filter(pick=>pick<turns[round]);
}
// First selection per season; undrafted seasons are null and excluded from the median.
export function firstPickTiming(rows, managerId, seasons, position) {
  const sample=seasons.filter(year=>year>=2011 && year<=2025);
  const first=sample.map(season=>{
    const picks=rows.filter(r=>r.owner_id===managerId && Number(r.season)===season && (r.position===position || (position==='IDP' && ['LB','DB','DL'].includes(r.position)))).map(r=>Number(r.round));
    if (picks.some(n=>!Number.isInteger(n)||n<1||n>19)) throw Error('Invalid historical pick round.');
    return {season,round:picks.length?Math.min(...picks):null};
  });
  const values=first.map(x=>x.round).filter(n=>n!==null).sort((a,b)=>a-b), mid=Math.floor(values.length/2);
  return {medianRound:values.length?(values.length%2?values[mid]:(values[mid-1]+values[mid])/2):null,draftedSeasons:values.length,totalSeasons:sample.length,history:first,recent:first.filter(x=>x.season>=2021)};
}
export function boardReady(packet, now = Date.now()) {
  return packet.health === 'PASS' && Number.isFinite(Date.parse(packet.expiresAt)) && now < Date.parse(packet.expiresAt);
}
export function healthMarker(p) {
  const status=p.injury?.status;
  return status&&!['ACTIVE','CLEAR','NO_YAHOO_MARKER'].includes(status)?status:p.injury?.draftAction!=='CLEAR'?'CHECK':'';
}
export function injuryNotes(p) {
  const injury=p.injury;
  if (!injury) return 'Injury details unavailable. Availability has not been confirmed.';
  const evidence=injury.evidence??[];
  const news=evidence.filter(e=>['reported_news','team_official','nfl_official'].includes(e.sourceKind) && e.fresh===true && e.note)
    .sort((a,b)=>Date.parse(b.publishedAt??b.observedAt)-Date.parse(a.publishedAt??a.observedAt))[0];
  const lines=[];
  if(news){
    lines.push(`Latest researched update · ${news.publishedAt??`publication date unavailable; checked ${news.observedAt}`}`,news.note);
    if(news.reportedReturn)lines.push(`Reported timeline (not confirmed): ${news.reportedReturn}`);
    if(news.draftImpact)lines.push(`Draft takeaway (analysis): ${news.draftImpact}`);
  } else if(injury.draftAction!=='CLEAR') lines.push('No current researched update attached. The status flag alone does not establish severity or missed games.');
  lines.push(`\nFeed status: ${injury.status??'UNKNOWN'}`);
  const body=(injury.bodyParts??[]).filter(x=>!/^undisclosed$/i.test(x));
  if(body.length)lines.push(`Feed-reported area: ${body.join(', ')}`);
  lines.push(`Feed-reported return: ${(injury.reportedReturns??[]).join('; ')||'Not confirmed by these sources'}`);
  if(Number.isFinite(p.expectedGamesThroughWeek17))lines.push(`Points use ${p.expectedGamesThroughWeek17} expected games through Week 17 (bye excluded).`);
  lines.push(injury.roleUncertain
    ? 'Starting role unresolved: points withheld until the role is established. This is not an injury diagnosis.'
    : injury.availabilityStatus==='CONFLICT'
    ? 'Availability sources conflict: points withheld pending reconciliation.'
    : injury.availabilityStatus==='EXPLICIT'
    ? 'Availability adjustment: explicit reported estimate or missed weeks is applied.'
    : 'No researched injury-specific missed-game adjustment is applied. Source projections may already embed health or role assumptions; the news note does not change points.');
  if(injury.draftAction!=='CLEAR')lines.push('Automatic selection remains blocked.');
  for (const e of evidence) lines.push(`\n${e.sourceId??'Source'} · reported ${e.publishedAt??'date not supplied'} · checked ${e.observedAt??'Date unavailable'}${e.fresh===false?' · STALE':''}\n${[e.narrativeOnly?null:e.status,e.bodyPart,e.practice,e.reportedReturn,e.note].filter(Boolean).join(' · ')||'No narrative supplied.'}${e.sourceUrl?`\n${e.sourceUrl}`:''}`);
  if (!(injury.evidence?.length)) lines.push(`Last checked: ${injury.freshestAt??'Unavailable'}; source narrative unavailable.`);
  return lines.join('\n');
}
export function rankedPlayers(packet, {position='ALL', search='', sort='value', direction=null} = {}) {
  const query = search.trim().toLowerCase();
  const field={value:'vor',points:'projection',adp:'marketAdp',name:'name',position:'position',team:'team',bye:'bye',health:'health'}[sort]??'vor';
  const numeric=['vor','projection','marketAdp','bye'].includes(field),descending=direction?direction==='desc':['vor','projection'].includes(field);
  const value=p=>field==='health'?healthMarker(p):p[field];
  const missing=v=>v==null||v===''||(numeric&&!Number.isFinite(v));
  return packet.players.filter(p =>
    (position === 'ALL' || p.eligible.includes(position) || p.position === position || (position === 'FLEX' && [...p.eligible,p.position].some(x=>['WR','RB','TE'].includes(x))) || (position === 'DL' && p.eligible.some(x => ['DE','DT'].includes(x))) || (position === 'IDP' && p.eligible.some(x => ['D','DL','DE','DT','LB','DB','CB','S'].includes(x)))) &&
    `${p.name} ${p.team??''}`.toLowerCase().includes(query))
    .sort((a,b) => {const x=value(a),y=value(b),mx=missing(x),my=missing(y);if(mx!==my)return mx?1:-1;const order=mx?0:numeric?x-y:String(x).localeCompare(String(y));return (descending?-order:order)||a.yahooId.localeCompare(b.yahooId);});
}

export function timingWindow(card, position, limit=5) {
  const history=card.specialty[position].history??card.specialty[position].recent;
  const seasons=[...card.seasons].sort((a,b)=>b-a).slice(0,limit);
  const rows=seasons.map(season=>history.find(x=>x.season===season));
  if(rows.some(x=>!x))return {median:null,sample:0,missing:true};
  const values=rows.filter(x=>x.round!==null).map(x=>x.round).sort((a,b)=>a-b),m=Math.floor(values.length/2);
  return {median:values.length?(values.length%2?values[m]:(values[m-1]+values[m])/2):null,sample:values.length,missing:false};
}
export function historyWindows(card) {
  const max=card.seasons.length;
  return [...new Set([5,10,max].filter(n=>n<=max))].sort((a,b)=>a-b);
}
export function positionGroup(p) {
  return ['QB','RB','WR','TE','K','DEF'].includes(p.position)?p.position:'IDP';
}
// Display bands only: T1-T4 within 10% of each leader; T5 is the remaining depth.
// Fixed from the snapshot, never recomputed when a player is drafted. No score changes.
export function playerTiers(players) {
  const result=new Map();
  for(const pos of SCOUT_POSITIONS){
    const group=players.filter(p=>positionGroup(p)===pos&&Number.isFinite(p.projection)&&p.projection>0).sort((a,b)=>b.projection-a.projection||a.yahooId.localeCompare(b.yahooId));
    let tier=0,leader=0;
    for(const p of group){if(!tier||(tier<5&&p.projection<leader*.9)){tier++;leader=p.projection;}result.set(p.yahooId,{position:pos,tier});}
  }
  return result;
}
export function tierCounts(players, tiers, drafted=new Set()) {
  const cells=new Map();
  for(const p of players){const t=tiers.get(p.yahooId);if(!t)continue;const key=`${t.position}:${t.tier}`,cell=cells.get(key)??{...t,total:0,remaining:0};cell.total++;if(!drafted.has(p.yahooId))cell.remaining++;cells.set(key,cell);}
  return [...cells.values()];
}
export function playerWarnings(p) {
  const warnings=[];
  if(p.injury?.roleUncertain||p.validationStatus==='ROLE_UNCERTAIN')warnings.push({label:'ROLE',detail:'Starting role unresolved; review the player details.'});
  if(healthMarker(p))warnings.push({label:healthMarker(p),detail:'Health or availability needs review. Open the dated injury report.'});
  const rates=Object.values(p.sourceFamilyPerGamePoints??{}).filter(Number.isFinite);
  if(rates.length>=2){const low=Math.min(...rates),high=Math.max(...rates);if(high>0&&(high-low)/high>=.25)warnings.push({label:'SPLIT',detail:`Source per-game projections range ${low.toFixed(1)}–${high.toFixed(1)} (25%+ spread). Diagnostic only; no additional ranking penalty.`});}
  return warnings;
}
export function roundTargets(packet, seat, round, drafted=new Set()) {
  const pick=nextTurns(seat,1,packet.teams,packet.rounds)[round-1];
  if(!pick)return [];
  // ADP frames a plausible window, not a probability or an availability guarantee.
  const candidates=packet.players.filter(p=>!drafted.has(p.yahooId)&&Number.isFinite(p.vor)&&Number.isFinite(p.projection)&&p.manualEligible!==false);
  const timing=p=>Number.isFinite(p.marketAdp)?p.marketAdp:Number.isFinite(p.yahooRank)?p.yahooRank:null;
  const nearby=candidates.filter(p=>timing(p)!==null&&timing(p)>=Math.max(1,pick-packet.teams)&&timing(p)<=pick+packet.teams*2);
  return nearby.sort((a,b)=>b.vor-a.vor||a.yahooId.localeCompare(b.yahooId)).slice(0,5);
}
export function roundOpponents(packet,order,round) {
  const pick=nextTurns(order.ours,1,packet.teams,packet.rounds)[round-1];
  if(!pick)return {before:null,between:[]};
  const beforeSeat=pick>1?seatAt(pick-1,packet.teams):null;
  return {before:beforeSeat===order.ours?'BACK_TO_BACK':(packet.opponents??[]).find(c=>order[c.managerId]===beforeSeat)??null,
    between:(packet.opponents??[]).filter(c=>opponentBetween(c,order,round,packet).length)};
}
