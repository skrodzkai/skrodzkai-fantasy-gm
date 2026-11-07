// Candidate-owned local journal. No automatic stale-lock recovery or production
// path default. A crash retains the exact writer lock for supervised reconciliation.
import * as fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
const check=(value,code)=>{if(!value)throw Error(code);};
const clone=value=>structuredClone(value);
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export const PHASE_STORE_MAX_REVISIONS=1000;
const MAX_RECORD_BYTES=1024*1024;
const record=(state,previous)=>JSON.stringify({revision:state.revision,previous,state,digest:digest(state)});
const fits=(state,bytes)=>state.revision<PHASE_STORE_MAX_REVISIONS&&Buffer.byteLength(bytes)<=MAX_RECORD_BYTES;
export const phaseRevisionFits=state=>fits(state,record(state,'0'.repeat(64)));
export function openPhaseStore(root,{initialize=false}={}) {
 const dir=fs.lstatSync(root);check(dir.isDirectory()&&!dir.isSymbolicLink()&&(dir.mode&0o077)===0,'STORE_DIRECTORY_INVALID');
 const files=fs.readdirSync(root);
 check(files.every(n=>/^(writer\.lock|[0-9]{6}\.json|\.[0-9]{6}\.[a-f0-9-]+\.tmp)$/.test(n)),'STORE_CONTENT_INVALID');
 check(initialize?files.length===0:files.some(n=>n==='000000.json'),'STORE_INITIALIZATION_REQUIRED');
 const lock=path.join(root,'writer.lock'),token=randomUUID();
 const fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,token);fs.fsyncSync(fd);
 const lockStat=fs.fstatSync(fd);let closed=false,poisoned=false,last=null;
 const directoryFd=fs.openSync(root,'r');fs.fsyncSync(directoryFd);
 function owns(){
  check(!closed&&!poisoned,'STORE_CLOSED_OR_POISONED');const d=fs.lstatSync(root);
  check(d.isDirectory()&&!d.isSymbolicLink()&&d.dev===dir.dev&&d.ino===dir.ino&&(d.mode&0o077)===0,'STORE_DIRECTORY_CHANGED');const s=fs.lstatSync(lock);
  check(!s.isSymbolicLink()&&s.ino===lockStat.ino&&s.dev===lockStat.dev&&fs.readFileSync(lock,'utf8')===token,'WRITER_CHANGED');
 }
 function load(){
  try {
   owns();const names=fs.readdirSync(root).filter(n=>n.endsWith('.json')).sort();let previous=null;
   for(let i=0;i<names.length;i++) {
    check(names[i]===`${String(i).padStart(6,'0')}.json`,'JOURNAL_GAP');
    const p=path.join(root,names[i]),st=fs.lstatSync(p);
    check(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&(st.mode&0o077)===0&&st.size<=MAX_RECORD_BYTES,'JOURNAL_FILE_INVALID');
    const bytes=fs.readFileSync(p,'utf8');let r;try{r=JSON.parse(bytes);}catch{throw Error('JOURNAL_TORN_OR_CORRUPT');}
    check(r.revision===i&&r.previous===(previous?digest(previous.bytes):null)&&r.state.revision===i&&r.digest===digest(r.state),'JOURNAL_INVALID');
    previous={bytes,state:r.state};
   }
   check(previous,'JOURNAL_EMPTY');
   if(last)check(previous.state.revision>=last.state.revision&&names[last.state.revision]&&
    fs.readFileSync(path.join(root,names[last.state.revision]),'utf8')===last.bytes,'JOURNAL_ROLLBACK');
   last=previous;return clone(previous.state);
  } catch(e){poisoned=true;throw e;}
 }
 function append(state,previous){
  owns();const p=path.join(root,`${String(state.revision).padStart(6,'0')}.json`);
  const bytes=record(state,previous);
  check(fits(state,bytes),'JOURNAL_CAPACITY');
  const temp=path.join(root,`.${String(state.revision).padStart(6,'0')}.${randomUUID()}.tmp`);
  let f;try {f=fs.openSync(temp,'wx',0o600);fs.writeFileSync(f,bytes);fs.fsyncSync(f);fs.closeSync(f);f=undefined;
   owns();check(!fs.existsSync(p),'REVISION_ALREADY_EXISTS');fs.renameSync(temp,p);fs.fsyncSync(directoryFd);
   check(fs.readFileSync(p,'utf8')===bytes,'JOURNAL_READBACK_FAILED');last={bytes,state:clone(state)};
  }catch(e){poisoned=true;throw e;}finally{if(f!==undefined)fs.closeSync(f);}
 }
 try {if(initialize)append({schema:1,revision:0,phase:'EMPTY'},null);else load();}
 catch(e){
  // A failed read-only open has never issued a call or appended a revision. Remove
  // only this invocation's fresh lock; preserve locks after uncertain initialization.
  if(!initialize){try{const s=fs.lstatSync(lock);if(s.ino===lockStat.ino&&s.dev===lockStat.dev&&fs.readFileSync(lock,'utf8')===token){fs.unlinkSync(lock);fs.fsyncSync(directoryFd);}}catch{}}
  fs.closeSync(fd);fs.closeSync(directoryFd);closed=true;throw e;
 }
 return Object.freeze({
  load,
  compareAndSwap(revision,next){const s=load();if(s.revision!==revision)return false;
   check(next.revision===revision+1,'REVISION_INVALID');append(clone(next),digest(last.bytes));return true;},
  close(){owns();load();fs.unlinkSync(lock);fs.fsyncSync(directoryFd);fs.closeSync(fd);fs.closeSync(directoryFd);closed=true;},
  abandon(){if(!closed){fs.closeSync(fd);fs.closeSync(directoryFd);closed=true;}} // Never removes a crash/uncertain lock.
 });
}
