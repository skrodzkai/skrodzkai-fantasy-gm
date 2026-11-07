import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {openHarnessStore} from './fantasy-harness-durable-store.mjs';
import {newLedger,scheduleFingerprint,claim,begin,finish,dispatchClaimed,recoverInterrupted,retryConfirmedNoEffect,postflight} from './fantasy-harness-ledger.mjs';
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
 const child=spawnSync(process.execPath,['--input-type=module','-e',code,r],{encoding:'utf8',timeout:5000});assert.notEqual(child.status,0);assert.match(child.stderr,/EEXIST/);
 }finally{s.close();}
});
test('abrupt exit after Submitting persistence retains Running and the crash lock',t=>{
 const r=root(t);const mod=new URL('./fantasy-harness-durable-store.mjs',import.meta.url).href,ledger=new URL('./fantasy-harness-ledger.mjs',import.meta.url).href;
 const code=`import {openHarnessStore} from ${JSON.stringify(mod)};import {claim,dispatchClaimed} from ${JSON.stringify(ledger)};
 const s=openHarnessStore(process.argv[1],{...${JSON.stringify(opts)},initialize:true});const a=await s.load();await s.compareAndSwap(a.revision,claim(a,${JSON.stringify(claimArgs)}));
 await dispatchClaimed({store:s,owner:${JSON.stringify(owner)},id:'100',clock:()=>110,adapter:{submit:async(_intent,context)=>{
 const a=s.attemptsFor(context),key=context.occurrenceId+'/'+context.actionId;
 if(!a.reserve(key)||!a.markSubmitting(key))process.exit(24);
 process.exit(23);
 }}});`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code,r],{encoding:'utf8',timeout:5000});assert.equal(child.status,23);
 assert.ok(fs.existsSync(path.join(r,'writer.lock')));assert.throws(()=>openHarnessStore(r,opts),/EEXIST/);
 const state=latest(r);
 assert.equal(state.ledger.jobs['100'].status,'Running');
 assert.deepEqual(Object.values(state.attempts),['Submitting']);
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
function latest(root) {
 const file=fs.readdirSync(root).filter(name=>name.endsWith('.json')).sort().at(-1);
 return JSON.parse(fs.readFileSync(path.join(root,file),'utf8')).state;
}

function bindingFor(job) {
 return {deadline:job.deadline,occurrenceId:job.id,actionId:job.actionId};
}

test('attempt states survive clean reopen and cannot be reused or resumed',async t=>{
 for(const marker of ['Reserved','Submitting','Released']) {
  await t.test(marker,async t=>{
   const r=root(t);
   let s=openHarnessStore(r,{...opts,initialize:true});
   await claimed(s);
   const before=await s.load(), id='100';
   const context=bindingFor(before.jobs[id]), key=id+'/'+context.actionId;
   assert.equal(s.attemptsFor(context).reserve(key),false);
   const running=begin(before,{owner,id,now:110});
   assert.equal(await s.compareAndSwap(before.revision,running),true);
   assert.equal(s.attemptsFor({...context,deadline:201}).reserve(key),false);
   assert.equal(s.attemptsFor({...context,actionId:'0'.repeat(64)}).reserve(id+'/'+'0'.repeat(64)),false);
   assert.equal(s.attemptsFor({...context,occurrenceId:'999'}).reserve('999/'+context.actionId),false);
   const attempts=s.attemptsFor(context);
   assert.equal(attempts.reserve('wrong'),false);
   assert.equal(attempts.reserve(key),true);
   if(marker==='Submitting') {
    assert.equal(attempts.markSubmitting(key),true);
    assert.equal(attempts.isSubmitting(),true);
    assert.equal(attempts.release(key),false);
    const noEffect=finish(running,{owner,id,outcome:{kind:'no_effect',stage:'before_submit',submissionStarted:false}});
    await assert.rejects(s.compareAndSwap(running.revision,noEffect),/no_submission_not_confirmed/);
   }
   if(marker==='Released') {
    assert.equal(attempts.release(key),true);
    assert.equal(attempts.markSubmitting(key),false);
   }
   assert.deepEqual(await s.load(),running);
   s.close();
   s=openHarnessStore(r,opts);
   try {
    assert.equal(latest(r).attempts[key],marker);
    const reopened=s.attemptsFor(context);
    assert.equal(reopened.reserve(key),false);
    assert.equal(reopened.markSubmitting(key),false);
    assert.equal(reopened.release(key),false);
    assert.equal(reopened.isSubmitting(),false);
    assert.equal(await s.compareAndSwap(running.revision,recoverInterrupted(running)),true);
    assert.equal(latest(r).attempts[key],marker);
    assert.equal((await s.load()).jobs[id].status,'Unknown');
    assert.equal(await s.compareAndSwap(running.revision,recoverInterrupted(running)),false);
   } finally {s.close();}
  });
 }
});

function record(state,previous) {
 return JSON.stringify({revision:state.revision,previous,state,digest:hash(state)});
}

function seed(root,lastRevision,ledger,schema='fantasy-harness-store-v2') {
 let previous=null;
 for(let revision=0;revision<=lastRevision;revision++){
  const state=revision===0?{schema:1,revision:0,phase:'EMPTY'}:{
   schema,revision,ledger:{...ledger,revision:revision-1},...(schema.endsWith('-v2')?{attempts:{}}:{}),
  };
  const bytes=record(state,previous);
  fs.writeFileSync(path.join(root,`${String(revision).padStart(6,'0')}.json`),bytes,{mode:0o600});
  previous=hash(bytes);
 }
}

function independentSuccess(unknown) {
 const evidence={source:'independent_read',observedAt:110,season:intent.season,league:intent.league,team:intent.team,
  week:intent.week,roster:intent.after,pendingClear:true,receiptConfirmed:true};
 return postflight(unknown,{owner,id:'100',evidence,now:110});
}

async function completeInterrupted(store) {
 const before=await store.load(),id='100';
 const running=begin(before,{owner,id,now:110});
 assert.equal(await store.compareAndSwap(before.revision,running),true);
 const context=bindingFor(running.jobs[id]),key=id+'/'+context.actionId;
 const attempts=store.attemptsFor(context);
 assert.equal(attempts.reserve(key),true);
 assert.equal(attempts.markSubmitting(key),true);
 const unknown=recoverInterrupted(running);
 assert.equal(await store.compareAndSwap(running.revision,unknown),true);
 assert.equal(await store.compareAndSwap(unknown.revision,independentSuccess(unknown)),true);
}

async function expectDispatchCapacityRejection(store) {
 let calls=0;
 await assert.rejects(dispatchClaimed({store,owner,id:'100',clock:()=>110,adapter:{submit:async()=>calls++}}),
  /store_capacity_before_dispatch/);
 assert.equal(calls,0);
 assert.equal((await store.load()).jobs['100'].status,'Claimed');
}

test('predecessor schema is rejected without retaining a fresh read-only writer lock',t=>{
 const r=root(t);
 seed(r,1,newLedger(opts),'fantasy-harness-store-v1');
 assert.throws(()=>openHarnessStore(r,opts),/store_schema_invalid/);
 assert.equal(fs.existsSync(path.join(r,'writer.lock')),false);
});

test('reserve all five writes through independent postflight at the real journal revision limit',async t=>{
 const ledger=claim(newLedger(opts),claimArgs);
 const fitting=root(t),full=root(t);
 seed(fitting,994,ledger);
 seed(full,995,ledger);
 const s=openHarnessStore(fitting,opts);
 try {
  await completeInterrupted(s);
  assert.equal(latest(fitting).revision,999);
  assert.equal(latest(fitting).ledger.jobs['100'].status,'Succeeded');
 } finally {s.close();}
 const blocked=openHarnessStore(full,opts);
 try {await expectDispatchCapacityRejection(blocked);} finally {blocked.close();}
});

test('reserve the serialized postflight record at the real journal byte limit',async t=>{
 const limit=1024*1024;
 for(const excess of [0,1]) {
  const r=root(t),s=openHarnessStore(r,{...opts,initialize:true});
  try {
   const empty=await s.load(),claimed=claim(empty,claimArgs);
   claimed.jobs['100'].fixturePadding='';
   const completion=independentSuccess(recoverInterrupted(begin(claimed,{owner,id:'100',now:110})));
   const key='100/'+completion.jobs['100'].actionId;
   const terminalRecord={schema:'fantasy-harness-store-v2',revision:7,ledger:completion,attempts:{[key]:'Submitting'}};
   const baseline=Buffer.byteLength(record(terminalRecord,'0'.repeat(64)));
   claimed.jobs['100'].fixturePadding='x'.repeat(limit-baseline+excess);
   assert.equal(await s.compareAndSwap(empty.revision,claimed),true);
   if(excess) await expectDispatchCapacityRejection(s);
   else {
    await completeInterrupted(s);
    assert.equal(fs.statSync(path.join(r,'000007.json')).size,limit);
   }
  } finally {s.close();}
 }
});
