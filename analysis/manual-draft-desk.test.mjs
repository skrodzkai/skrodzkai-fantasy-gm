import test from 'node:test';
import assert from 'node:assert/strict';
import {seatAt,nextTurns,validateOrder,opponentBetween,firstPickTiming,SCOUT_POSITIONS,boardReady,rankedPlayers,opponentSummary,injuryNotes} from './manual-draft-model.mjs';
import {renderDesk,validatePacket} from './build-manual-draft-desk.mjs';
import vm from 'node:vm';
const input={leagueId:'420010',scoringModel:'fixture',teams:12,rounds:19,health:'FAIL',observedAt:'2026-09-06T05:00:00Z',notice:'Fixture, not current data',players:[{yahooId:'1',name:'One',eligible:['WR'],position:'WR',vor:10,projection:100},{yahooId:'2',name:'Two',eligible:['CB','WR'],position:'CB',vor:20,projection:90}]};
const packet=validatePacket(input);
test('researched injury note leads with latest published facts and honest point impact',()=>{
 const base={sourceId:'reporter',sourceKind:'reported_news',sourceUrl:'https://example.com/report',narrativeOnly:true,observedAt:'2026-09-06T23:00Z',publishedAt:'2026-09-06',fresh:true,note:'Psoas soreness; coach expects Week 1.',reportedReturn:'Week 1 expected, not confirmed.',draftImpact:'Keep on shortlist; check final participation.'};
 const note=injuryNotes({expectedGamesThroughWeek17:15,injury:{status:'QUESTIONABLE',draftAction:'REVIEW',availabilityStatus:'UNSPECIFIED',evidence:[base,{...base,publishedAt:'2026-09-01',note:'Older update'},{...base,publishedAt:'2026-09-05',fresh:false,note:'Stale update'}]}});
 assert(note.startsWith('Latest researched update · 2026-09-06\nPsoas'));
 for(const fact of ['analysis','15 expected games','does not change points','Automatic selection remains blocked','STALE'])assert(note.includes(fact));
 const stale=injuryNotes({injury:{status:'QUESTIONABLE',draftAction:'REVIEW',evidence:[{...base,fresh:false}]}});assert(!stale.startsWith('Latest researched update'));
 const undated=injuryNotes({injury:{bodyParts:['Knee'],reportedReturns:['Week 2'],evidence:[{...base,publishedAt:null}]}});
 for(const fact of ['publication date unavailable','Knee','Week 2','Reported timeline (not confirmed)'])assert(undated.includes(fact));
 for(const injury of [{roleUncertain:true},{availabilityStatus:'CONFLICT'}]){
   const withheld=injuryNotes({injury:{...injury,evidence:[base]}});assert(withheld.includes('points withheld'));assert(!withheld.includes('does not change points'));
 }
});
test('all eight columns sort both ways, with missing numeric values always last',async()=>{
 const a={yahooId:'1',name:'Alpha',position:'QB',team:'BUF',projection:10,vor:2,marketAdp:3,bye:4,injury:{status:'DOUBTFUL',draftAction:'REVIEW'}},b={yahooId:'2',name:'Beta',position:'WR',team:'NYJ',projection:20,vor:4,marketAdp:6,bye:8,injury:{status:'QUESTIONABLE',draftAction:'REVIEW'}};
 for(const sort of ['name','position','team','health','points','value','adp','bye']){
  const p={players:[b,a]};assert.equal(rankedPlayers(p,{sort,direction:'asc'})[0].yahooId,'1',sort);assert.equal(rankedPlayers(p,{sort,direction:'desc'})[0].yahooId,'2',sort);
 }
 for(const sort of ['points','value','adp','bye'])for(const direction of ['asc','desc'])assert.equal(rankedPlayers({players:[{yahooId:'3',name:'Missing'},a,b]},{sort,direction}).at(-1).yahooId,'3');
 const html=await renderDesk(input);for(const key of ['name','position','team','health','points','value','adp','bye'])assert(html.includes(`data-sort="${key}"`));assert(html.includes('aria-sort'));assert(html.includes("sortDirection==='asc'?'desc':'asc'"));
});
test('injury notes retain dated source facts without inventing a return',()=>{
 const note=injuryNotes({injury:{status:'QUESTIONABLE',draftAction:'REVIEW',bodyParts:['Biceps'],reportedReturns:[],evidence:[{sourceId:'sleeper',observedAt:'2026-09-06T12:00Z',status:'QUESTIONABLE',bodyPart:'Biceps',practice:'Limited',fresh:true}]}});
 for(const fact of ['Biceps','Limited','sleeper','2026-09-06T12:00Z','Not confirmed'])assert(note.includes(fact));assert(!note.includes('Ready for Week 1'));
 assert(injuryNotes({}).includes('unavailable'));
});
const opponent={teamId:'sample',teamName:'Example Team',managerId:'Example Manager',seasons:[2021,2022,2023,2024,2025],rows:95,recentRound1:{RB:1,WR:4},recentOpening:{RB:7,TE:3,WR:10},specialty:Object.fromEntries(SCOUT_POSITIONS.map(position=>[position,{medianRound:6,draftedSeasons:5,recent:[{season:2025,round:7}]}]))};
test('opponent summaries preserve actual sample, ties and absent evidence',()=>{
 assert.deepEqual(opponentSummary(opponent),{headline:'WR first in 4 of 5 recent drafts',detail:'WR 4/5 · RB 1/5'});
 assert.equal(opponentSummary({...opponent,recentRound1:{WR:2,RB:2}}).headline,'Mixed RB / WR openings');
 assert.equal(opponentSummary({...opponent,recentRound1:{QB:1}}).headline,'QB first in 1 of 1 recent drafts');
 assert.equal(opponentSummary({...opponent,recentRound1:{}}).headline,'No recent first-round sample');
});
test('opponent evidence rejects duplicated identities and impossible sample counts',()=>{
 assert.equal(validatePacket({...input,opponents:[opponent]}).opponents.length,1);
 assert.doesNotThrow(()=>validatePacket({...input,opponents:[{...opponent,specialty:{...opponent.specialty,DEF:{medianRound:null,draftedSeasons:0,recent:[{season:2025,round:null}]}}}]}));
 for(const opponents of [[opponent,opponent],[{...opponent,recentRound1:{WR:6}}],[{...opponent,recentOpening:{WR:21}}],[{...opponent,recentRound1:{WR:-1}}],[{...opponent,specialty:{}}],[{...opponent,seasons:[2025,2025]}]])assert.throws(()=>validatePacket({...input,opponents}));
});
test('scouting uses team buttons and separate details, never the raw Markdown dump',async()=>{
 const teamName="</script><img onerror=bad> $&",html=await renderDesk({...input,opponents:[{...opponent,teamName}],opponentNotes:'RAW_REPORT_SENTINEL'});
 assert(html.includes('id="opponentTeams"'));assert(html.includes('aria-controls'));assert(html.includes('aria-pressed'));assert(html.includes('aria-live="polite"'));assert(html.includes('Opponent scouting'));
 assert(!html.includes('<pre id="opponents">'));assert(!html.includes("packet.opponentNotes"));assert(!html.includes('</script><img'));
 const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];new vm.Script(script);assert.equal(JSON.parse(script.match(/const packet = (.*);/)[1]).opponents[0].teamName,teamName);
});
test('snake endpoints, middle, and completion',()=>{assert.deepEqual([1,12,13,24,25,228].map(n=>seatAt(n)),[1,12,12,1,1,12]);assert.deepEqual(nextTurns(1,1).slice(0,3),[1,24,25]);assert.deepEqual(nextTurns(6,6).slice(0,3),[6,19,30]);assert.deepEqual(nextTurns(12,13).slice(0,3),[13,36,37]);assert.deepEqual(nextTurns(null,1),[]);assert.deepEqual(nextTurns(6,229),[]);});
test('one-time owner-linked order rejects duplicates and unknown or invalid seats',()=>{
 const p={...packet,opponents:[opponent]};for(const value of [null,[],{ours:0},{ours:13},{ours:1,'Example Manager':1},{unknown:5},{ours:'1'}])assert.throws(()=>validateOrder(value,p));
 assert.deepEqual(validateOrder({},p),{});assert.deepEqual(validateOrder({ours:4,'Example Manager':12},p),{ours:4,'Example Manager':12});
});
test('opponent pick windows honor snake reversal and consecutive endpoint turns',()=>{
 const p={...packet,opponents:[opponent]};assert.deepEqual(opponentBetween(opponent,{ours:1,'Example Manager':12},1,p),[12,13]);assert.deepEqual(opponentBetween(opponent,{ours:1,'Example Manager':12},2,p),[]);
 assert.deepEqual(opponentBetween(opponent,{ours:6,'Example Manager':5},1,p),[]);assert.deepEqual(opponentBetween(opponent,{ours:6,'Example Manager':5},2,p),[20,29]);
 assert.deepEqual(opponentBetween(opponent,{ours:6},1,p),[]);assert.deepEqual(opponentBetween(opponent,{ours:6,'Example Manager':5},19,p),[]);
 for(let seat=1;seat<=12;seat++){const turns=nextTurns(seat,1);assert.equal(turns.length,19);assert(turns.every(pick=>seatAt(pick)===seat));}
});
test('value, combined non-QB offense, dual eligibility and search filters',()=>{
 const p={...packet,players:[...packet.players,...['QB','RB','TE','K','DEF','LB'].map((pos,i)=>({yahooId:String(i+3),name:pos,position:pos,eligible:[pos],projection:50,vor:0}))]};
 assert.equal(rankedPlayers(p)[0].yahooId,'2');assert.equal(rankedPlayers(p,{sort:'points'})[0].yahooId,'1');assert.equal(rankedPlayers(p,{position:'WR'}).length,2);assert.equal(rankedPlayers(p,{position:'IDP'}).length,2);assert.deepEqual(rankedPlayers(p,{position:'FLEX'}).map(x=>x.position),['CB','WR','RB','TE']);assert.equal(rankedPlayers(p,{search:'Two'}).length,1);
});
test('RB and WR first-pick medians use stable owners, one pick per year and null not zero',()=>{
 const row=(season,round,position='RB',owner_id='owner')=>({season:String(season),round:String(round),position,owner_id});
 const rows=[row(2010,1),row(2021,2),row(2021,7),row(2022,4),row(2023,8,'WR'),row(2024,1,'WR'),row(2022,1,'RB','other'),row(2025,13,'LB'),row(2025,12,'DB')];
 const rb=firstPickTiming(rows,'owner',[2010,2021,2022,2023,2024,2025],'RB');assert.equal(rb.medianRound,3);assert.equal(rb.draftedSeasons,2);assert.equal(rb.totalSeasons,5);assert.equal(rb.recent[2].round,null);
 assert.equal(firstPickTiming(rows,'owner',[2021,2022,2023,2024,2025],'WR').medianRound,4.5);assert.equal(firstPickTiming(rows,'owner',[2025],'IDP').medianRound,12);assert.equal(firstPickTiming(rows,'owner',[2025],'TE').medianRound,null);
 assert.throws(()=>firstPickTiming([row(2025,0)],'owner',[2025],'RB'));
});
test('freshness and build status independently gate recommendations',()=>{assert.equal(boardReady(packet),false);const pass={...packet,health:'PASS',expiresAt:'2026-09-06T11:00:00Z'};assert.equal(boardReady(pass,Date.parse('2026-09-06T06:00Z')),true);assert.equal(boardReady(pass,Date.parse(pass.expiresAt)),false);assert.equal(boardReady({...pass,expiresAt:null}),false);});
test('self-contained escaped HTML, app-shell wordmark, no network or pick bookkeeping',async()=>{const html=await renderDesk({...input,notice:'</script><img onerror=bad>'});assert(!html.includes('</script><img'));assert(html.includes('SKRODZK<span>ai</span>'));assert(html.includes('#29b6ff'));assert(html.includes("connect-src 'none'"));assert(!html.includes('/*PACKET*/'));assert(!html.includes('/*MODEL*/'));assert(!/<script[^>]+src=|fetch\(|XMLHttpRequest|chrome\.runtime/.test(html));for(const removed of ['Your board. Your decisions.','Sources & data limits','id="roster"','id="log"','id="undo"','id="confirmPick"','recordPick','Taken','__LOGO__'])assert(!html.includes(removed),removed);assert(html.includes('height:32px'));assert(html.includes('WR / RB / TE'));});
test('unknown values are not invented; invalid numeric projections rejected',()=>{assert.throws(()=>validatePacket({...input,players:[{...input.players[0],projection:NaN}]}));assert.throws(()=>validatePacket({...input,health:'PASS'}));assert.throws(()=>validatePacket({...input,players:[input.players[0],input.players[0]]}));});
test('dollar replacement patterns and HTML terminators remain literal data',async()=>{const notice="$$ $& $` $' </script><img onerror=bad>";const html=await renderDesk({...input,notice});const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];new vm.Script(script);const literal=script.match(/const packet = (.*);/)[1];assert.equal(JSON.parse(literal).notice,notice);assert.equal((html.match(/<\/script>/g)||[]).length,1);});
