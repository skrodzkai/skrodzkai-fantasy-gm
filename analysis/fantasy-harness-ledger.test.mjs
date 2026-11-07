import test from 'node:test';
import assert from 'node:assert/strict';
import { TARGET } from './yahoo-fantasy-readonly.mjs';
const target = { season: TARGET.season, league: TARGET.leagueId, team: TARGET.teamId };
import { newLedger, scheduleFingerprint, claim, begin, finish, recoverInterrupted,
  postflight, retryConfirmedNoEffect, expireClaimed, handoffReadiness, dispatchClaimed } from './fantasy-harness-ledger.mjs';
const owner = 'fixture-owner', fingerprint = scheduleFingerprint({ schedule: 'unchanged-fixture', timezone: 'America/Los_Angeles' });
const intent = { ...target, week:8,
  before:[{id:'1',slot:'BN'},{id:'2',slot:'LB'}], after:[{id:'1',slot:'LB'},{id:'2',slot:'BN'}] };
const options = { owner, fingerprint, scheduledFor:100, deadline:200, now:100, intent };
const fresh = () => newLedger({ owner, scheduleFingerprint:fingerprint });
const claimed = () => claim(fresh(),options);
const running = () => begin(claimed(),{owner,id:'100',now:110});
const unknown = () => finish(running(),{owner,id:'100',outcome:{kind:'submitted'}});
const evidence = () => ({ source:'independent_read', observedAt:120, ...target,week:8,
  roster:intent.after, pendingClear:true, receiptConfirmed:true });
function memoryStore(state) {
  return { state:structuredClone(state), async load(){return structuredClone(this.state);},
    async compareAndSwap(revision,next){ if(this.state.revision !== revision)return false;
      this.state=structuredClone(next); return true; } };
}
test('stable exact schedule fingerprint; reordering roster does not evade action dedup',()=>{
  assert.equal(fingerprint,scheduleFingerprint({schedule:'unchanged-fixture',timezone:'America/Los_Angeles'}));
  let s=postflight(unknown(),{owner,id:'100',now:125,evidence:evidence()});
  assert.throws(()=>claim(s,{...options,scheduledFor:150,now:150,intent:{...intent,before:[...intent.before].reverse()}}),/duplicate_action/);
});
test('occurrence duplication, stale slots, early and expired wakes fail closed',()=>{
  assert.throws(()=>claim(claimed(),options),/duplicate_or_stale/);
  for(const now of [99,200])assert.throws(()=>claim(fresh(),{...options,now}),/outside_window/);
  const s=postflight(unknown(),{owner,id:'100',now:125,evidence:evidence()});
  assert.throws(()=>claim(s,{...options,scheduledFor:99}),/duplicate_or_stale/);
});
test('owner, target, schedule and player identity mismatch rejected',()=>{
  for(const changes of [{owner:'other'},{fingerprint:'0'.repeat(64)},{intent:{...intent,team:'not-the-target'}},
    {intent:{...intent,before:[{id:'1',slot:'BN'},{id:'1',slot:'LB'}]}}]) assert.throws(()=>claim(fresh(),{...options,...changes}));
});
test('crash recovery never requeues a Running effect; blocks later slots',()=>{
  const s=recoverInterrupted(running()); assert.equal(s.jobs['100'].status,'Unknown');
  assert.throws(()=>begin(s,{owner,id:'100',now:120}),/not_dispatchable/);
  assert.throws(()=>claim(s,{...options,scheduledFor:150,now:150}),/unresolved/);
  assert.equal(recoverInterrupted(claimed()).jobs['100'].status,'Claimed');
});
test('all uncertain effects, timeouts, invalid results and success text require postflight',()=>{
  for(const outcome of [undefined,{kind:'timeout'},{kind:'submitted'}, {exitCode:0},
    {kind:'no_effect',stage:'after_submit',submissionStarted:false},
    {kind:'no_effect',stage:'before_submit',submissionStarted:true}]) {
    const s=finish(running(),{owner,id:'100',outcome});assert.equal(s.jobs['100'].status,'Unknown');
    assert.throws(()=>retryConfirmedNoEffect(s,{owner,id:'100',now:120}),/retry_forbidden/);
  }
});
test('only confirmed pre-submit rejection can retry once within same window',()=>{
  const outcome={kind:'no_effect',stage:'before_submit',submissionStarted:false};
  let s=finish(running(),{owner,id:'100',outcome});
  assert.throws(()=>retryConfirmedNoEffect(s,{owner,id:'100',now:200}),/retry_forbidden/);
  s=retryConfirmedNoEffect(s,{owner,id:'100',now:120});
  s=begin(s,{owner,id:'100',now:120});s=finish(s,{owner,id:'100',outcome});
  assert.throws(()=>retryConfirmedNoEffect(s,{owner,id:'100',now:130}),/retry_forbidden/);
});
test('exact independent postflight succeeds; stale/wrong/pending/unconfirmed evidence does not',()=>{
  for(const delta of [{source:'executor'},{observedAt:105},{observedAt:130},{team:'not-the-target'},{week:9},
    {pendingClear:false},{receiptConfirmed:false},{roster:[{id:'1',slot:'LB'}]}])
    assert.throws(()=>postflight(unknown(),{owner,id:'100',now:125,evidence:{...evidence(),...delta}}),/postflight_unproven/);
  assert.throws(()=>postflight(unknown(),{owner,id:'100',now:70000,evidence:evidence()}),/postflight_unproven/);
  const s=postflight(unknown(),{owner,id:'100',now:125,evidence:evidence()});
  assert.equal(s.jobs['100'].status,'Succeeded');assert.equal(s.closedThrough,100);
});
test('expired unsubmitted claim closes without dispatch, no automatic catchup',()=>{
  const s=expireClaimed(claimed(),{owner,id:'100',now:200});
  assert.equal(s.jobs['100'].status,'Failed');
  assert.throws(()=>retryConfirmedNoEffect(s,{owner,id:'100',now:201}),/retry_forbidden/);
  assert.throws(()=>expireClaimed(running(),{owner,id:'100',now:200}),/not_expired_claim/);
});
test('handoff requires quiescent old owner, identical schedule, resolved work and future slot; does not activate',()=>{
  const opts={owner,fingerprint,oldOwnerQuiescent:true,nextScheduledFor:300,now:250};
  assert.deepEqual(handoffReadiness(fresh(),opts),{ready:true,blockers:[],changesSchedule:false,activatesOwner:false});
  for(const [s,delta] of [[unknown(),{}],[fresh(),{oldOwnerQuiescent:false}],
    [fresh(),{fingerprint:'0'.repeat(64)}],[fresh(),{nextScheduledFor:250}]]) assert.equal(handoffReadiness(s,{...opts,...delta}).ready,false);
});
test('persistence refusal/exception before dispatch never calls adapter',async()=>{
  for(const compareAndSwap of [async()=>false,async()=>{throw Error('disk');}]){
    let calls=0; const store=memoryStore(claimed());store.compareAndSwap=compareAndSwap;
    await assert.rejects(dispatchClaimed({store,adapter:{submit:async()=>{calls++;}},owner,id:'100',clock:()=>110}));
    assert.equal(calls,0);
  }
});
test('concurrent wake delivery submits at most once with atomic CAS',async()=>{
  const store=memoryStore(claimed());let calls=0;
  const adapter={submit:async()=>{calls++;assert.equal(store.state.jobs['100'].status,'Running');return {kind:'submitted'};}};
  const results=await Promise.allSettled([1,2].map(()=>dispatchClaimed({store,adapter,owner,id:'100',clock:()=>110})));
  assert.equal(calls,1);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(store.state.jobs['100'].status,'Unknown');
});
test('post-dispatch exception or completion persistence loss cannot resubmit',async()=>{
  for(const persistenceLost of [false,true]) {
    const store=memoryStore(claimed());const cas=store.compareAndSwap.bind(store);
    store.compareAndSwap=async(r,n)=>persistenceLost && r===2 ? false : cas(r,n);
    let calls=0;const adapter={submit:async()=>{calls++;throw Error('timeout');}};
    const result=dispatchClaimed({store,adapter,owner,id:'100',clock:()=>110});
    if(persistenceLost)await assert.rejects(result,/completion_commit/);else await result;
    store.state=recoverInterrupted(store.state);
    await assert.rejects(dispatchClaimed({store,adapter,owner,id:'100',clock:()=>120}),/not_dispatchable/);
    assert.equal(calls,1);assert.equal(store.state.jobs['100'].status,'Unknown');
  }
});
test('malformed and unsupported ledger cannot authorize a claim',()=>{
  for(const delta of [{schema:2},{revision:-1},{actions:{ghost:'100'}},{jobs:[]}])
    assert.throws(()=>claim({...fresh(),...delta},options));
});

test('fresh deadline check after durable commit prevents late effects',async()=>{
  for (const afterCommit of [200,250,109,NaN]) {
    const store=memoryStore(claimed()); let calls=0, ticks=0;
    const adapter={submit:async()=>{calls++;return {kind:'submitted'};}};
    const result=await dispatchClaimed({store,adapter,owner,id:'100',clock:()=>ticks++ ? afterCommit : 110});
    assert.equal(calls,0);assert.equal(result.status,'Failed');
    assert.equal(result.reason,'confirmed_no_submission');
  }
});

test('delayed load expires before commit; adapter receives immutable deadline binding',async()=>{
  const store=memoryStore(claimed());let calls=0;
  await assert.rejects(dispatchClaimed({store,adapter:{submit:async()=>calls++},owner,id:'100',clock:()=>200}),/not_dispatchable/);
  assert.equal(calls,0);assert.equal(store.state.jobs['100'].status,'Claimed');
  await dispatchClaimed({store,adapter:{submit:async(_intent,context)=>{
    assert.equal(context.deadline,200);assert.equal(context.occurrenceId,'100');
    assert.equal(context.actionId,store.state.jobs['100'].actionId);return {kind:'submitted'};
  }},owner,id:'100',clock:()=>110});
});
