// Candidate-owned persistence for the PR60 ledger. No default runtime path,
// scheduler, browser, native admission, credential access, or force-unlock API.
import {openPhaseStore, PHASE_STORE_MAX_REVISIONS} from './fantasy-phase-store.mjs';
import {newLedger, validateLedger} from './fantasy-harness-ledger.mjs';
const requireThat=(ok,code)=>{if(!ok)throw Error(code);};

export function openHarnessStore(root,{owner,scheduleFingerprint,initialize=false}={}) {
 const empty=newLedger({owner,scheduleFingerprint}); // validates the pinned binding
 const phase=openPhaseStore(root,{initialize});
 function envelope() {
  const s=phase.load();
  requireThat(s.schema==='fantasy-harness-store-v1'&&Object.keys(s).sort().join('|')==='ledger|revision|schema','store_schema_invalid');
  const ledger=validateLedger(s.ledger);
  requireThat(s.revision===ledger.revision+1,'store_revision_mismatch');
  requireThat(ledger.owner===owner&&ledger.scheduleFingerprint===scheduleFingerprint,'store_binding_mismatch');
  return {state:s,ledger};
 }
 try {
  if(initialize)requireThat(phase.compareAndSwap(0,{schema:'fantasy-harness-store-v1',revision:1,ledger:empty}),'store_initialization_not_confirmed');
  envelope();
 }catch(e){
  if(!initialize){try{phase.close();}catch{phase.abandon();}}else phase.abandon();
  throw e;
 }
 return Object.freeze({
  async load(){return envelope().ledger;},
  async compareAndSwap(revision,next){
   const {state,ledger}=envelope();
   if(revision!==ledger.revision)return false;
   const checked=validateLedger(next);
   requireThat(checked.revision===revision+1,'ledger_revision_invalid');
   requireThat(checked.owner===owner&&checked.scheduleFingerprint===scheduleFingerprint,'store_binding_mismatch');
   for(const [id,old] of Object.entries(ledger.jobs)) {
    const n=checked.jobs[id];
    requireThat(n&&n.actionId===old.actionId&&n.scheduledFor===old.scheduledFor&&n.deadline===old.deadline,'ledger_history_changed');
    requireThat(!(old.attempts>0&&n.status==='Claimed'),'same_id_retry_not_admitted');
   }
   const dispatching=Object.entries(checked.jobs).some(([id,j])=>j.status==='Running'&&ledger.jobs[id]?.status!=='Running');
   // Running commit and its outcome must both fit; don't discover exhaustion
   // only after a browser effect. The store has revisions 0..MAX-1.
   if(dispatching)requireThat(state.revision<=PHASE_STORE_MAX_REVISIONS-3,'store_capacity_before_dispatch');
   return phase.compareAndSwap(state.revision,{schema:state.schema,revision:state.revision+1,ledger:checked});
  },
  close(){phase.close();},
  abandon(){phase.abandon();}, // retains uncertain/crash locks, never force-unlocks
 });
}
