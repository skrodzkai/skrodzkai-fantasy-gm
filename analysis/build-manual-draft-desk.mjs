import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export function validatePacket(p) {
  if (!p || !['420010','542830'].includes(p.leagueId) || !p.scoringModel || p.teams !== 12 || !Number.isInteger(p.rounds) || p.rounds < 1 || p.rounds > 30) throw Error('Explicit supported league, scoring model, and draft shape required.');
  if (!['PASS','FAIL','UNREVIEWED'].includes(p.health) || !Number.isFinite(Date.parse(p.observedAt)) || !Array.isArray(p.players) || !p.players.length || typeof p.notice !== 'string') throw Error('Missing data receipt.');
  if (p.health === 'PASS' && (!Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.expiresAt) <= Date.parse(p.observedAt))) throw Error('Passing data needs an explicit freshness deadline.');
  if (p.opponents != null) {
    if (!Array.isArray(p.opponents)) throw Error('Opponent cards must be an array.');
    const teams = new Set();
    for (const card of p.opponents) {
      if (!card || typeof card.teamId !== 'string' || !card.teamId || teams.has(card.teamId) || typeof card.teamName !== 'string' || !card.teamName || typeof card.managerId !== 'string' || !Array.isArray(card.seasons) || !card.seasons.length || !card.seasons.every(Number.isInteger) || new Set(card.seasons).size !== card.seasons.length || !Number.isInteger(card.rows) || card.rows < 0) throw Error('Invalid opponent identity or sample.');
      const recentSeasons = card.seasons.filter(year => year >= 2021 && year <= 2025).length;
      for (const [key,limit] of [['recentRound1',recentSeasons],['recentOpening',recentSeasons*4]]) {
        const counts = card[key];
        if (!counts || typeof counts !== 'object' || Array.isArray(counts) || !Object.values(counts).every(n => Number.isInteger(n) && n >= 0) || Object.values(counts).reduce((a,b)=>a+b,0) > limit) throw Error('Invalid opponent recent counts.');
      }
      if (!card.specialty || typeof card.specialty !== 'object') throw Error('Missing opponent timing evidence.');
      for (const position of ['QB','TE','DEF','IDP','K']) {
        const value = card.specialty[position];
        if (!value || (value.medianRound !== null && (!Number.isFinite(value.medianRound) || value.medianRound < 1)) || !Number.isInteger(value.draftedSeasons) || value.draftedSeasons < 0 || value.draftedSeasons > card.seasons.length || !Array.isArray(value.recent) || new Set(value.recent.map(x=>x.season)).size !== value.recent.length || !value.recent.every(x => card.seasons.includes(x.season) && x.season >= 2021 && x.season <= 2025 && (x.round === null || (Number.isInteger(x.round) && x.round >= 1)))) throw Error('Invalid opponent timing evidence.');
      }
      teams.add(card.teamId);
    }
  }
  const seen = new Set();
  for (const row of p.players) {
    if (!/^\d+$/.test(row.yahooId) || seen.has(row.yahooId) || typeof row.name !== 'string' || !Array.isArray(row.eligible) || !row.eligible.every(x => typeof x === 'string')) throw Error('Invalid or duplicate player identity.');
    for (const key of ['projection','vor','adpLow','adpHigh']) if (row[key] != null && (typeof row[key] !== 'number' || !Number.isFinite(row[key]))) throw Error(`Invalid ${key}.`);
    for (const key of ['position','team']) if (row[key] != null && typeof row[key] !== 'string') throw Error(`Invalid ${key}.`);
    if (row.bye != null && (!Number.isInteger(row.bye) || row.bye < 1 || row.bye > 18)) throw Error('Invalid bye.');
    if (row.injury != null && (typeof row.injury !== 'object' || Array.isArray(row.injury))) throw Error('Invalid injury.');
    seen.add(row.yahooId);
  }
  return {...p, players:p.players.map(row=>({...row,position:row.position??row.eligible[0]??'—',team:row.team??'—'})), boardId:createHash('sha256').update(JSON.stringify(p)).digest('hex')};
}
export async function renderDesk(input) {
  const packet = validatePacket(input);
  const [template, model, logo] = await Promise.all([
    readFile(new URL('./manual-draft-desk.html', import.meta.url),'utf8'),
    readFile(new URL('./manual-draft-model.mjs', import.meta.url),'utf8'),
    readFile(new URL('../extension/assets/skrodzkai-enterprises-blue.png', import.meta.url)),
  ]);
  // JSON is data, never HTML. Escape script terminators even in private source notes.
  return template.replace('/*MODEL*/', () => model.replace(/^export /gm,''))
    .replace('/*PACKET*/', () => JSON.stringify(packet).replaceAll('<','\\u003c'))
    .replace('__LOGO__', () => `data:image/png;base64,${logo.toString('base64')}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw Error('Usage: node analysis/build-manual-draft-desk.mjs packet.json output.html');
  await writeFile(output, await renderDesk(JSON.parse(await readFile(input,'utf8'))), {flag:'wx', mode:0o600});
  console.log(`Created offline desk: ${output}`);
}
