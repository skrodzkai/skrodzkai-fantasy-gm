import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {SCOUT_POSITIONS} from './manual-draft-model.mjs';

export function validatePacket(p) {
  if (!p || !['420010','542830'].includes(p.leagueId) || !p.scoringModel || p.teams !== 12 || !Number.isInteger(p.rounds) || p.rounds < 1 || p.rounds > 30) throw Error('Explicit supported league, scoring model, and draft shape required.');
  if (!['PASS','FAIL','UNREVIEWED'].includes(p.health) || !Number.isFinite(Date.parse(p.observedAt)) || !Array.isArray(p.players) || !p.players.length || typeof p.notice !== 'string') throw Error('Missing data receipt.');
  if (p.health === 'PASS' && (!Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.expiresAt) <= Date.parse(p.observedAt))) throw Error('Passing data needs an explicit freshness deadline.');
  if (p.opponents != null) {
    if (!Array.isArray(p.opponents)) throw Error('Opponent cards must be an array.');
    const teams = new Set(), managers = new Set();
    for (const card of p.opponents) {
      if (!card || typeof card.teamId !== 'string' || !card.teamId || teams.has(card.teamId) || typeof card.teamName !== 'string' || !card.teamName || typeof card.managerId !== 'string' || !Array.isArray(card.seasons) || !card.seasons.length || !card.seasons.every(Number.isInteger) || new Set(card.seasons).size !== card.seasons.length || !Number.isInteger(card.rows) || card.rows < 0) throw Error('Invalid opponent identity or sample.');
      const recentSeasons = card.seasons.filter(year => year >= 2021 && year <= 2025).length;
      if (!card.managerId || card.managerId==='ours' || managers.has(card.managerId)) throw Error('Duplicate or invalid opponent owner.');
      if (card.summary != null && (!Array.isArray(card.summary) || card.summary.length<3 || card.summary.length>4 || !card.summary.every(x=>typeof x==='string' && x.trim()))) throw Error('Opponent summary must contain three or four sentences.');
      for (const [key,limit] of [['recentRound1',recentSeasons],['recentOpening',recentSeasons*4]]) {
        const counts = card[key];
        if (!counts || typeof counts !== 'object' || Array.isArray(counts) || !Object.values(counts).every(n => Number.isInteger(n) && n >= 0) || Object.values(counts).reduce((a,b)=>a+b,0) > limit) throw Error('Invalid opponent recent counts.');
      }
      if (!card.specialty || typeof card.specialty !== 'object') throw Error('Missing opponent timing evidence.');
      for (const position of SCOUT_POSITIONS) {
        const value = card.specialty[position];
        if (!value || (value.medianRound !== null && (!Number.isFinite(value.medianRound) || value.medianRound < 1)) || !Number.isInteger(value.draftedSeasons) || value.draftedSeasons < 0 || value.draftedSeasons > card.seasons.length || !Array.isArray(value.recent) || new Set(value.recent.map(x=>x.season)).size !== value.recent.length || !value.recent.every(x => card.seasons.includes(x.season) && x.season >= 2021 && x.season <= 2025 && (x.round === null || (Number.isInteger(x.round) && x.round >= 1)))) throw Error('Invalid opponent timing evidence.');
        if (value.history != null && (!Array.isArray(value.history) || value.history.length !== card.seasons.length || new Set(value.history.map(x=>x.season)).size !== value.history.length || !value.history.every(x=>card.seasons.includes(x.season) && (x.round === null || (Number.isInteger(x.round) && x.round >= 1 && x.round <= p.rounds))))) throw Error('Invalid full opponent timing history.');
      }
      teams.add(card.teamId);
      managers.add(card.managerId);
    }
  }
  const seen = new Set();
  for (const row of p.players) {
    if (!/^\d+$/.test(row.yahooId) || seen.has(row.yahooId) || typeof row.name !== 'string' || !Array.isArray(row.eligible) || !row.eligible.every(x => typeof x === 'string')) throw Error('Invalid or duplicate player identity.');
    for (const key of ['projection','vor','marketAdp','adpLow','adpHigh']) if (row[key] != null && (typeof row[key] !== 'number' || !Number.isFinite(row[key]))) throw Error(`Invalid ${key}.`);
    for (const key of ['position','team']) if (row[key] != null && typeof row[key] !== 'string') throw Error(`Invalid ${key}.`);
    if (row.bye != null && (!Number.isInteger(row.bye) || row.bye < 1 || row.bye > 18)) throw Error('Invalid bye.');
    if (row.injury != null && (typeof row.injury !== 'object' || Array.isArray(row.injury))) throw Error('Invalid injury.');
    if (row.sourceFamilyPerGamePoints != null && (typeof row.sourceFamilyPerGamePoints !== 'object' || Array.isArray(row.sourceFamilyPerGamePoints) || !Object.values(row.sourceFamilyPerGamePoints).every(Number.isFinite))) throw Error('Invalid source disagreement evidence.');
    seen.add(row.yahooId);
  }
  return {...p, players:p.players.map(row=>({...row,position:row.position??row.eligible[0]??'—',team:row.team??'—'})), boardId:createHash('sha256').update(JSON.stringify(p)).digest('hex')};
}
export async function renderDesk(input) {
  const packet = validatePacket(input);
  const [template, model, ui] = await Promise.all([
    readFile(new URL('./manual-draft-desk.html', import.meta.url),'utf8'),
    readFile(new URL('./manual-draft-model.mjs', import.meta.url),'utf8'),
    readFile(new URL('./manual-draft-ui.js', import.meta.url),'utf8'),
  ]);
  // JSON is data, never HTML. Escape script terminators even in private source notes.
  let fonts='';
  for(const [file,family,weight] of [['dm-sans-regular.ttf','DM Sans',400],['dm-sans-bold.ttf','DM Sans',700],['jetbrains-mono-regular.ttf','JetBrains Mono',400],['jetbrains-mono-semibold.ttf','JetBrains Mono',600]]){
    const bytes=await readFile(new URL('./fonts/'+file,import.meta.url));
    fonts+=`@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;src:url(data:font/ttf;base64,${bytes.toString('base64')}) format('truetype');font-display:swap}\n`;
  }
  return template.replace('/*FONTS*/',()=>fonts).replace('/*UI*/',()=>ui).replace('/*MODEL*/', () => model.replace(/^export /gm,''))
    .replace('/*PACKET*/', () => JSON.stringify(packet).replaceAll('<','\\u003c'));
}
// Same UI, packaged behind extension CSP. Generated private data never enters Git.
export async function renderExtensionDesk(input,outputDirectory,{replace=false}={}){
  const offline=await renderDesk(input);
  const script=offline.match(/<script>([\s\S]*?)<\/script>/)[1];
  const bridge=await readFile(new URL('../extension/draft-desk-bridge.js',import.meta.url),'utf8');
  const html=offline.replace("script-src 'unsafe-inline'","script-src 'self'").replace(/<script>[\s\S]*?<\/script>/,'<script src="desk.js"></script>');
  await mkdir(outputDirectory,{recursive:true});
  await writeFile(new URL('desk.js',pathToFileURL(outputDirectory+'/')),script+'\n'+bridge,{mode:0o600,flag:replace?'w':'wx'});
  await writeFile(new URL('index.html',pathToFileURL(outputDirectory+'/')),html,{mode:0o600,flag:replace?'w':'wx'});
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output, extensionDirectory] = process.argv.slice(2);
  if (!input || !output) throw Error('Usage: node analysis/build-manual-draft-desk.mjs packet.json output.html | packet.json --extension output-directory');
  if(output==='--extension'){
    if(!extensionDirectory)throw Error('Extension output directory required.');
    await renderExtensionDesk(JSON.parse(await readFile(input,'utf8')),extensionDirectory);
    console.log(`Created private extension desk: ${extensionDirectory}`);
  }else{
  if(extensionDirectory)throw Error('Unexpected output argument.');
  await writeFile(output, await renderDesk(JSON.parse(await readFile(input,'utf8'))), {flag:'wx', mode:0o600});
  console.log(`Created offline desk: ${output}`);
  }
}
