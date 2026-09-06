import test from 'node:test';
import assert from 'node:assert/strict';
import {seatAt,nextTurns,validateState,recordPick,boardReady,availablePlayers,opponentSummary} from './manual-draft-model.mjs';
import {renderDesk,validatePacket} from './build-manual-draft-desk.mjs';
import vm from 'node:vm';
const input={leagueId:'420010',scoringModel:'fixture',teams:12,rounds:19,health:'FAIL',observedAt:'2026-09-06T05:00:00Z',notice:'Fixture, not current data',players:[{yahooId:'1',name:'One',eligible:['WR'],position:'WR',vor:10,projection:100},{yahooId:'2',name:'Two',eligible:['CB','WR'],position:'CB',vor:20,projection:90}]};
const packet=validatePacket(input), state={version:1,boardId:packet.boardId,seat:null,picks:[]};
const opponent={teamId:'sample',teamName:'Example Team',managerId:'Example Manager',seasons:[2021,2022,2023,2024,2025],rows:95,recentRound1:{RB:1,WR:4},recentOpening:{RB:7,TE:3,WR:10},specialty:Object.fromEntries(['QB','TE','DEF','IDP','K'].map(position=>[position,{medianRound:6,draftedSeasons:5,recent:[{season:2025,round:7}]}]))};
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
 assert(html.includes('id="opponentTeams"'));assert(html.includes('aria-controls'));assert(html.includes('aria-pressed'));assert(html.includes('aria-live="polite"'));assert(html.includes('Scout opponents'));
 assert(!html.includes('<pre id="opponents">'));assert(!html.includes("packet.opponentNotes"));assert(!html.includes('</script><img'));
 const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];new vm.Script(script);assert.equal(JSON.parse(script.match(/const packet = (.*);/)[1]).opponents[0].teamName,teamName);
});
test('snake endpoints, middle, and completion',()=>{assert.deepEqual([1,12,13,24,25,228].map(n=>seatAt(n)),[1,12,12,1,1,12]);assert.deepEqual(nextTurns(1,1).slice(0,3),[1,24,25]);assert.deepEqual(nextTurns(6,6).slice(0,3),[6,19,30]);assert.deepEqual(nextTurns(12,13).slice(0,3),[13,36,37]);assert.deepEqual(nextTurns(null,1),[]);assert.deepEqual(nextTurns(6,229),[]);});
test('log validation rejects duplicate, unknown, cross-board and invalid seat',()=>{for(const patch of [{picks:['1','1']},{picks:['999']},{boardId:'wrong'},{seat:0},{seat:13}])assert.throws(()=>validateState({...state,...patch},packet));assert.deepEqual(recordPick(state,'1',packet).picks,['1']);assert.equal(state.picks.length,0);});
test('value, position, dual eligibility, search and taken filters',()=>{assert.equal(availablePlayers(packet,state)[0].yahooId,'2');assert.equal(availablePlayers(packet,state,{sort:'points'})[0].yahooId,'1');assert.equal(availablePlayers(packet,state,{position:'WR'}).length,2);assert.equal(availablePlayers(packet,state,{position:'IDP'}).length,1);assert.equal(availablePlayers(packet,recordPick(state,'1',packet)).length,1);assert.equal(availablePlayers(packet,state,{search:'Two'}).length,1);});
test('freshness and build status independently gate recommendations',()=>{assert.equal(boardReady(packet),false);const pass={...packet,health:'PASS',expiresAt:'2026-09-06T11:00:00Z'};assert.equal(boardReady(pass,Date.parse('2026-09-06T06:00Z')),true);assert.equal(boardReady(pass,Date.parse(pass.expiresAt)),false);assert.equal(boardReady({...pass,expiresAt:null}),false);});
test('self-contained escaped HTML, real asset, no network or execution adapter',async()=>{const html=await renderDesk({...input,notice:'</script><img onerror=bad>'});assert(!html.includes('</script><img'));assert(html.includes('data:image/png;base64,'));assert(html.includes("connect-src 'none'"));assert(!html.includes('/*PACKET*/'));assert(!html.includes('/*MODEL*/'));assert(!/<script[^>]+src=|fetch\(|XMLHttpRequest|chrome\.runtime/.test(html));assert(html.includes('object-fit:contain'));});
test('unknown values are not invented; invalid numeric projections rejected',()=>{assert.throws(()=>validatePacket({...input,players:[{...input.players[0],projection:NaN}]}));assert.throws(()=>validatePacket({...input,health:'PASS'}));assert.throws(()=>validatePacket({...input,players:[input.players[0],input.players[0]]}));});
test('dollar replacement patterns and HTML terminators remain literal data',async()=>{const notice="$$ $& $` $' </script><img onerror=bad>";const html=await renderDesk({...input,notice});const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];new vm.Script(script);const literal=script.match(/const packet = (.*);/)[1];assert.equal(JSON.parse(literal).notice,notice);assert.equal((html.match(/<\/script>/g)||[]).length,1);});
