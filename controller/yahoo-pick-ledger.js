(function(root){
  'use strict';
  const seatAt=(pick,teams)=>Math.ceil(pick/teams)%2?(pick-1)%teams+1:teams-(pick-1)%teams;
  function reconcile(previous, observation, {leagueId,season=2026,teams=12,rounds=19,now=Date.now()}={}) {
    const fail=reason=>({...previous,leagueId,season,status:'GAP',reason,checkedAt:now});
    if(!observation||observation.leagueId!==leagueId||observation.season!==season)return fail('League or season mismatch');
    if(!Array.isArray(observation.picks)||observation.picks.length>teams*rounds)return fail('Invalid pick count');
    const picks=[...observation.picks].sort((a,b)=>a.overall-b.overall),ids=new Set(),seats=new Map(),names=new Map();
    for(let i=0;i<picks.length;i++){
      const p=picks[i],seat=seatAt(i+1,teams);
      if(p.overall!==i+1||!/^\d+$/.test(p.yahooId)||ids.has(p.yahooId)||typeof p.teamName!=='string'||!p.teamName.trim())return fail('Missing, duplicate, or invalid selection');
      if((seats.has(seat)&&seats.get(seat)!==p.teamName)||(names.has(p.teamName)&&names.get(p.teamName)!==seat))return fail('Team / snake order mismatch');
      ids.add(p.yahooId);seats.set(seat,p.teamName);names.set(p.teamName,seat);
    }
    const old=previous?.leagueId===leagueId&&previous?.season===season?previous.picks??[]:[];
    if(picks.length<old.length)return fail('Results moved backwards');
    if(old.some((p,i)=>p.yahooId!==picks[i]?.yahooId||p.teamName!==picks[i]?.teamName))return fail('Previously confirmed selection changed');
    const current=observation.currentPick;
    if(current!=null&&(!Number.isInteger(current)||current<1||current>teams*rounds+1||picks.length!==current-1))return fail('Results have not caught up with the draft room');
    const complete=picks.length===teams*rounds;
    return {leagueId,season,picks,status:complete?'COMPLETE':current!=null?'LIVE':'SNAPSHOT',reason:complete?'All selections reconciled':current!=null?'Room and results agree':'Room pick counter not verified',checkedAt:now,lastConfirmed:picks.length};
  }
  function status(ledger,now=Date.now()) {
    if(!ledger)return 'OFFLINE';
    if(ledger.status==='COMPLETE')return 'COMPLETE';
    if(!Number.isFinite(ledger.checkedAt)||now-ledger.checkedAt>6000||now<ledger.checkedAt)return 'DISCONNECTED';
    return ledger.status;
  }
  // Exact observed Yahoo /draftresults table structure. No fuzzy player-name joins.
  function readResults(documentRef,{leagueId,season=2026,teams=12}={}) {
    const tables=[...documentRef.querySelectorAll('#drafttables table')];
    if(!tables.length)throw Error('Yahoo round results not present');
    const picks=[];
    for(const table of tables){
      const round=Number(table.querySelector('thead')?.textContent.trim().match(/^Round (\d+)$/)?.[1]);
      if(!Number.isInteger(round)||round<1)throw Error('Unrecognized round heading');
      for(const row of table.querySelectorAll('tbody tr')){
        const cells=[...row.querySelectorAll('td')];
        const offset=Number(cells[0]?.textContent.trim().match(/^(\d+)\.$/)?.[1]);
        const link=cells[1]?.querySelector('a.name'),url=link?.getAttribute('href')??'';
        const yahooId=url.match(/^https:\/\/sports\.yahoo\.com\/nfl\/players\/(\d+)\/?$/)?.[1];
        // DEF links use team slugs rather than player IDs; resolve explicitly upstream.
        const defense=url.match(/^https:\/\/sports\.yahoo\.com\/nfl\/teams\/([a-z-]+)\/?$/)?.[1];
        if(!link||(!yahooId&&!defense)||!Number.isInteger(offset)||offset<1||offset>teams||!cells[2]?.textContent.trim())throw Error('Unrecognized results row');
        picks.push({overall:(round-1)*teams+offset,yahooId:yahooId??null,defense: defense??null,name:link.textContent.trim(),teamName:cells[2].textContent.trim(),positionText:cells[1].textContent.trim()});
      }
    }
    return {leagueId,season,picks};
  }
  // Observed public mock Results > Round by Round, September 7, 2026.
  // Rows are newest-first and carry exact Yahoo IDs in the player cell.
  function readMockResults(documentRef,{leagueId,season=2026}={}) {
    if(!/^mock:[1-9]\d*$/.test(leagueId??''))throw Error('Explicit mock identity required');
    const tables=[...documentRef.querySelectorAll('table')].filter(table=>
      [...table.querySelectorAll('thead th')].map(cell=>cell.textContent.trim()).join('|')==='Pick|Player|Team');
    if(tables.length!==1)throw Error('Mock round results not present');
    const picks=[];
    for(const row of tables[0].querySelectorAll('tbody tr')){
      const cells=[...row.children];
      if(cells.length===1&&cells[0].tagName==='TH'&&/^ROUND \d+$/i.test(cells[0].textContent.trim()))continue;
      const overall=Number(cells[0]?.textContent.trim());
      const ids=[...new Set([...cells[1]?.querySelectorAll('[data-id]')??[]].map(e=>e.getAttribute('data-id')))];
      if(cells.length!==3||cells.some(c=>c.tagName!=='TD')||!Number.isInteger(overall)||overall<1||overall>180||ids.length!==1||!/^\d+$/.test(ids[0])||!cells[2].textContent.trim())throw Error('Unrecognized mock results row');
      picks.push({overall,yahooId:ids[0],name:cells[1].textContent.trim().split('\n')[0],teamName:cells[2].textContent.trim()});
    }
    return {leagueId,season,picks};
  }
  function resolveDefenses(observation,players){
    for(const pick of observation.picks)if(!pick.yahooId){
      // Yahoo's team link may display the nickname or city + nickname. Remove
      // only the exact city prefix carried by that link, never a fuzzy suffix.
      const normalize=root.SKRODZKaiYahooPageReaders.normalize;
      const city=normalize(pick.defense);
      const nickname=name=>{const value=normalize(name);return city&&value.startsWith(`${city} `)?value.slice(city.length+1):value;};
      const name=nickname(pick.name);
      const matches=players.filter(p=>p.position==='DEF'&&name&&nickname(p.name)===name);
      if(matches.length!==1||!/^\d+$/.test(matches[0].yahooId))throw Error(`Defense identity unresolved: ${pick.name} (${pick.defense})`);
      pick.yahooId=matches[0].yahooId;
    }
    return observation;
  }
  root.SKRODZKaiPickLedger={reconcile,status,readResults,readMockResults,resolveDefenses};
})(globalThis);
