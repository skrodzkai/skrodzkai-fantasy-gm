(function(){
  'use strict';
  const clientId=location.pathname.match(/^\/draftclient\/f1\/([1-9]\d*)\/[1-9]\d*(?:\/|$)/)?.[1];
  const publicMock=clientId&&!['420010','542830','18599'].includes(clientId);
  const leagueId=publicMock?`mock:${clientId}`:location.pathname.match(/^\/(?:draftclient\/f1|f1)\/(420010|542830)(?:\/|$)/)?.[1];
  if(!leagueId)return;
  const api=globalThis.SKRODZKaiPickLedger,readers=globalThis.SKRODZKaiYahooPageReaders;
  const room=location.pathname.startsWith('/draftclient/');
  let busy=false,timer=null;
  async function observe(){
    if(busy)return;busy=true;
    try{
      if(publicMock){
        const observation=api.readMockResults(document,{leagueId});
        observation.currentPick=readers?.readCurrentPick(document)?.pick??null;
        const receipt=await chrome.runtime.sendMessage({type:'draft_ledger',observation});
        if(receipt?.status==='COMPLETE')clearInterval(timer);
        return;
      }
      const board=leagueId==='420010'?globalThis.SKRODZKaiYahooRealBoard:globalThis.SKRODZKaiYahooMockBoard;
      if(!board||String(board.leagueId)!==leagueId)throw Error('Matching league board unavailable');
      let doc=document;
      if(room){
        const response=await fetch(`${location.origin}/f1/${leagueId}/draftresults`,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(6000)});
        if(!response.ok||new URL(response.url).pathname!==`/f1/${leagueId}/draftresults`)throw Error('Yahoo results request failed');
        doc=new DOMParser().parseFromString(await response.text(),'text/html');
      }
      const selected=doc.querySelector('#yfa-draftresults-select option:checked')?.textContent??'';
      if(!/^2026 draft order$/.test(selected.trim()))throw Error('Results season not verified');
      const observation=api.resolveDefenses(api.readResults(doc,{leagueId}),board.players);
      const turn=readers?.readCurrentPick(document);
      // Yahoo's captured banner reads ROUND 18, PICK 214: pick is already overall.
      observation.currentPick=turn?.pick??null;
      const receipt=await chrome.runtime.sendMessage({type:'draft_ledger',observation});
      if(receipt?.status==='COMPLETE')clearInterval(timer);
    }catch(error){await chrome.runtime.sendMessage({type:'draft_ledger_error',leagueId,reason:String(error.message)}).catch(()=>clearInterval(timer));}
    finally{busy=false;}
  }
  if(room)timer=setInterval(observe,2000);void observe();
})();
