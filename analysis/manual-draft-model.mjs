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
  return {medianRound:values.length?(values.length%2?values[mid]:(values[mid-1]+values[mid])/2):null,draftedSeasons:values.length,totalSeasons:sample.length,recent:first.filter(x=>x.season>=2021)};
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
