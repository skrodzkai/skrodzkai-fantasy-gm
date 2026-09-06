// Offline bookkeeping only. No Yahoo adapter, execution queue, or network access.
export function seatAt(pick, teams = 12) {
  const round = Math.ceil(pick / teams), offset = (pick - 1) % teams;
  return round % 2 ? offset + 1 : teams - offset;
}
export function nextTurns(seat, pick, teams = 12, rounds = 19) {
  if (!Number.isInteger(seat) || seat < 1 || seat > teams) return [];
  return Array.from({length: teams * rounds}, (_, i) => i + 1)
    .filter(n => n >= pick && seatAt(n, teams) === seat);
}
export function validateState(value, packet) {
  if (value?.version !== 1 || value.boardId !== packet.boardId || !Array.isArray(value.picks)) throw Error('This log belongs to a different board or format.');
  if (value.seat !== null && (!Number.isInteger(value.seat) || value.seat < 1 || value.seat > packet.teams)) throw Error('Invalid snake seat.');
  const ids = new Set(packet.players.map(p => p.yahooId)), seen = new Set();
  if (value.picks.length > packet.teams * packet.rounds) throw Error('Too many picks.');
  for (const id of value.picks) {
    if (typeof id !== 'string' || !ids.has(id) || seen.has(id)) throw Error('Unknown or duplicate player in log.');
    seen.add(id);
  }
  return {version:1, boardId:packet.boardId, seat:value.seat, picks:[...value.picks]};
}
export function recordPick(state, id, packet) {
  return validateState({...state, picks:[...state.picks, id]}, packet);
}
export function boardReady(packet, now = Date.now()) {
  return packet.health === 'PASS' && Number.isFinite(Date.parse(packet.expiresAt)) && now < Date.parse(packet.expiresAt);
}
export function availablePlayers(packet, state, {position='ALL', search='', sort='value'} = {}) {
  const taken = new Set(state.picks), query = search.trim().toLowerCase();
  const number = (p, key) => typeof p[key] === 'number' && Number.isFinite(p[key]) ? p[key] : -Infinity;
  return packet.players.filter(p => !taken.has(p.yahooId) &&
    (position === 'ALL' || p.eligible.includes(position) || p.position === position || (position === 'DL' && p.eligible.some(x => ['DE','DT'].includes(x))) || (position === 'IDP' && p.eligible.some(x => ['D','DL','DE','DT','LB','DB','CB','S'].includes(x)))) &&
    `${p.name} ${p.team??''}`.toLowerCase().includes(query))
    .sort((a,b) => number(b, sort === 'points' ? 'projection' : 'vor') - number(a, sort === 'points' ? 'projection' : 'vor') || number(b,'projection') - number(a,'projection') || a.yahooId.localeCompare(b.yahooId));
}
