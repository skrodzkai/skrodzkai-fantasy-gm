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
export function rankedPlayers(packet, {position='ALL', search='', sort='value'} = {}) {
  const query = search.trim().toLowerCase();
  const number = (p, key) => typeof p[key] === 'number' && Number.isFinite(p[key]) ? p[key] : -Infinity;
  return packet.players.filter(p =>
    (position === 'ALL' || p.eligible.includes(position) || p.position === position || (position === 'FLEX' && [...p.eligible,p.position].some(x=>['WR','RB','TE'].includes(x))) || (position === 'DL' && p.eligible.some(x => ['DE','DT'].includes(x))) || (position === 'IDP' && p.eligible.some(x => ['D','DL','DE','DT','LB','DB','CB','S'].includes(x)))) &&
    `${p.name} ${p.team??''}`.toLowerCase().includes(query))
    .sort((a,b) => number(b, sort === 'points' ? 'projection' : 'vor') - number(a, sort === 'points' ? 'projection' : 'vor') || number(b,'projection') - number(a,'projection') || a.yahooId.localeCompare(b.yahooId));
}
