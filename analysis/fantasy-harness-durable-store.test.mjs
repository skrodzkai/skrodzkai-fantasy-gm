import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {openHarnessStore} from './fantasy-harness-durable-store.mjs';
import {newLedger,scheduleFingerprint,claim,begin,finish,dispatchClaimed,recoverInterrupted,retryConfirmedNoEffect} from './fantasy-harness-ledger.mjs';
import {TARGET} from './yahoo-fantasy-readonly.mjs';
const owner='isolated-fixture-owner',fingerprint=scheduleFingerprint({schedule:'fixture-only',timezone:'UTC'});
const opts={owner,scheduleFingerprint:fingerprint};
const intent={season:TARGET.season,league:TARGET.leagueId,team:TARGET.teamId,week:9,before:[{id:'1',slot:'BN'},{id:'2',slot:'WR'}],after:[{id:'1',slot:'WR'},{id:'2',slot:'BN'}]};
const claimArgs={owner,fingerprint,scheduledFor:100,deadline:200,now:110,intent};
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
function root(t){const r=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'pr60-store-'));fs.chmodSync(r,0o700);t.after(()=>fs.rmSync(r,{recursive:true,force:true}));return r;}
async function claimed(store){const s=await store.load();assert.equal(await store.compareAndSwap(s.revision,claim(s,claimArgs)),true);}

test('real private journal persists ledger after clean close/reopen',async t=>{
 const r=root(t);let s=openHarnessStore(r,{...opts,initialize:true});await claimed(s);s.close();
 s=openHarnessStore(r,opts);try{assert.equal((await s.load()).jobs['100'].status,'Claimed');assert.equal(fs.statSync(path.join(r,'000000.json')).mode&0o777,0o600);}finally{s.close();}
});
test('atomic CAS permits only one concurrent dispatch',async t=>{
 const s=openHarnessStore(root(t),{...opts,initialize:true});try{await claimed(s);let calls=0;
 const results=await Promise.allSettled([1,2].map(()=>dispatchClaimed({store:s,owner,id:'100',clock:()=>110,adapter:{submit:async()=>{calls++;return {kind:'submitted'};}}})));
 assert.equal(calls,1);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal((await s.load()).jobs['100'].status,'Unknown');
 }finally{s.close();}
});
test('owner or schedule mismatch on reopen does not retain a fresh read-only lock',async t=>{
 const r=root(t);openHarnessStore(r,{...opts,initialize:true}).close();
 assert.throws(()=>openHarnessStore(r,{...opts,owner:'other'}),/store_binding_mismatch/);
 assert.equal(fs.existsSync(path.join(r,'writer.lock')),false);
 assert.throws(()=>openHarnessStore(r,{...opts,scheduleFingerprint:'0'.repeat(64)}),/store_binding_mismatch/);
 openHarnessStore(r,opts).close();
});
test('second process cannot acquire held writer lock',t=>{
 const r=root(t),s=openHarnessStore(r,{...opts,initialize:true});try{
 const code=`import {openHarnessStore} from ${JSON.stringify(new URL('./fantasy-harness-durable-store.mjs',import.meta.url).href)};openHarnessStore(process.argv[1],${JSON.stringify(opts)});`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code,r],{encoding:'utf8'});assert.notEqual(child.status,0);assert.match(child.stderr,/EEXIST/);
 }finally{s.close();}
});
test('abrupt exit after Running persistence retains exact journal and crash lock',t=>{
 const r=root(t);const mod=new URL('./fantasy-harness-durable-store.mjs',import.meta.url).href,ledger=new URL('./fantasy-harness-ledger.mjs',import.meta.url).href;
 const code=`import {openHarnessStore} from ${JSON.stringify(mod)};import {claim,dispatchClaimed} from ${JSON.stringify(ledger)};
 const s=openHarnessStore(process.argv[1],{...${JSON.stringify(opts)},initialize:true});const a=await s.load();await s.compareAndSwap(a.revision,claim(a,${JSON.stringify(claimArgs)}));
 await dispatchClaimed({store:s,owner:${JSON.stringify(owner)},id:'100',clock:()=>110,adapter:{submit:async()=>process.exit(23)}});`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code,r],{encoding:'utf8'});assert.equal(child.status,23);
 assert.ok(fs.existsSync(path.join(r,'writer.lock')));assert.throws(()=>openHarnessStore(r,opts),/EEXIST/);
 const latest=fs.readdirSync(r).filter(n=>n.endsWith('.json')).sort().at(-1);
 assert.equal(JSON.parse(fs.readFileSync(path.join(r,latest),'utf8')).state.ledger.jobs['100'].status,'Running');
});
test('clean restart does not automatically replay Running; explicit recovery makes Unknown',async t=>{
 const r=root(t);let s=openHarnessStore(r,{...opts,initialize:true});await claimed(s);let state=await s.load();await s.compareAndSwap(state.revision,begin(state,{owner,id:'100',now:110}));s.close();
 s=openHarnessStore(r,opts);try{let calls=0;await assert.rejects(dispatchClaimed({store:s,owner,id:'100',clock:()=>120,adapter:{submit:async()=>calls++}}),/not_dispatchable/);
 state=await s.load();assert.equal(await s.compareAndSwap(state.revision,recoverInterrupted(state)),true);assert.equal((await s.load()).jobs['100'].status,'Unknown');assert.equal(calls,0);
 }finally{s.close();}
});
test('unadopted same-ID retry cannot be committed through durable adapter',async t=>{
 const s=openHarnessStore(root(t),{...opts,initialize:true});try{await claimed(s);
 const done=await dispatchClaimed({store:s,owner,id:'100',clock:()=>110,adapter:{submit:async()=>({kind:'no_effect',stage:'before_submit',submissionStarted:false})}});assert.equal(done.status,'Failed');
 const a=await s.load();await assert.rejects(s.compareAndSwap(a.revision,retryConfirmedNoEffect(a,{owner,id:'100',now:120})),/same_id_retry_not_admitted/);
 assert.equal((await s.load()).jobs['100'].status,'Failed');
 }finally{s.close();}
});
test('corrupt persisted bytes fail on reopen without admitting a worker',t=>{
 const r=root(t);openHarnessStore(r,{...opts,initialize:true}).close();fs.appendFileSync(path.join(r,'000001.json'),'broken');
 assert.throws(()=>openHarnessStore(r,opts),/JOURNAL_TORN_OR_CORRUPT/);
});
test('reserve outcome capacity before dispatch at the real journal limit',async t=>{
 // Construct an explicitly synthetic valid hash chain near the actual store limit.
 const r=root(t);let previous=null;let state=claim(newLedger(opts),claimArgs);
 for(let revision=0;revision<=998;revision++){
  const s=revision===0?{schema:1,revision:0,phase:'EMPTY'}:{schema:'fantasy-harness-store-v1',revision,ledger:{...state,revision:revision-1}};
  const bytes=JSON.stringify({revision,previous,state:s,digest:hash(s)});fs.writeFileSync(path.join(r,`${String(revision).padStart(6,'0')}.json`),bytes,{mode:0o600});previous=hash(bytes);
 }
 const s=openHarnessStore(r,opts);try{let calls=0;await assert.rejects(dispatchClaimed({store:s,owner,id:'100',clock:()=>110,adapter:{submit:async()=>calls++}}),/store_capacity_before_dispatch/);
 assert.equal(calls,0);assert.equal((await s.load()).jobs['100'].status,'Claimed');
 }finally{s.close();}
});
