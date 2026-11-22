import {RESERVED_ACCOUNTS} from '../../../core/src/specialist-boards';
import {COORDINATOR_ACCOUNT_PATTERN as ACCOUNT} from '../../../core/src/coordinator-accounts';
import {ARCHIVE_AFTER_MS,GOALS,NEW_EVIDENCE_MAX,finishedAt,provisionRefs,type CoordinatorState,type CoordTask,type Receipt,type TaskRecord} from './types';

const TASK_ID=/^[-a-z0-9]+$/;

export function validateTask(t:CoordTask){
 if(t.agent!==undefined&&!['codex','claude'].includes(t.agent))throw Error('invalid worker agent');
 if(t.resumeSource!==undefined&&(t.kind!=='build'||typeof t.resumeSource!=='string'||!/^[a-f0-9]{64}$/.test(t.resumeSource)))throw Error('invalid prepared source continuation');
 if(t.rule!==undefined&&(t.rule!=='next-band'||t.kind!=='run'))throw Error('invalid rule task');
 if(t.repairs!==undefined&&(!Array.isArray(t.repairs)||t.repairs.some(r=>!r||!ACCOUNT.test(r.account)||!Number.isFinite(r.endedAt)||r.endedAt<0)))throw Error('invalid exact recovery request');
 if(t.sessionRecovery!==undefined&&(t.kind!=='run'||t.launch&&t.launch!=='ordinary'||t.account!==t.sessionRecovery?.account
  ||!ACCOUNT.test(t.sessionRecovery.account)||RESERVED_ACCOUNTS.includes(t.sessionRecovery.account.toLowerCase())
  ||!t.repairs?.some(r=>r.account===t.sessionRecovery!.account&&r.endedAt===t.sessionRecovery!.endedAt)))throw Error('invalid authenticated session recovery authorization');
 if(!t||!/^[-a-z0-9]+$/.test(t.id)||!GOALS.includes(t.goal)||!['build','qualify','provision','run','review'].includes(t.kind)
  ||!Array.isArray(t.dependsOn)||!t.dependsOn.every(v=>typeof v==='string'&&TASK_ID.test(v))||!t.why?.trim()
  ||!Number.isFinite(t.priority)||t.priority<=0||t.priority>100||!Number.isFinite(t.estimatedMs)||t.estimatedMs<1
  ||(t.timeoutMs!==undefined&&(!Number.isSafeInteger(t.timeoutMs)||t.timeoutMs<1000||t.timeoutMs>86400000)))throw Error('invalid coordination task');
 if(t.kind!=='provision'&&!/^[-a-z0-9]+$/.test(t.capability??''))throw Error('task needs a registered capability');
 if(t.kind==='provision'&&(!t.role||t.role==='main'))throw Error('provision task needs an ordinary missing role');
 if(t.account!==undefined&&(typeof t.account!=='string'||!ACCOUNT.test(t.account)))throw Error('invalid account name');
 if(t.accountFrom!==undefined&&(typeof t.accountFrom!=='string'||!TASK_ID.test(t.accountFrom)))throw Error('invalid provision task reference');
 if(t.participants!==undefined&&(!Array.isArray(t.participants)||!t.participants.length||t.participants.some(n=>typeof n!=='string'||!(n.startsWith('@')?TASK_ID.test(n.slice(1)):ACCOUNT.test(n)))
  ||new Set(t.participants.map(n=>n.toLowerCase())).size!==t.participants.length))throw Error('invalid participants');
 if(t.replayAllow!==undefined&&(t.kind!=='build'||!Array.isArray(t.replayAllow)||t.replayAllow.length>16||t.replayAllow.some(a=>typeof a!=='string'||!/^[A-Za-z]{1,40}$/.test(a))))throw Error('invalid replay allowance');
 if(t.newEvidence!==undefined&&(t.kind!=='build'||typeof t.newEvidence!=='string'||!t.newEvidence.trim()||t.newEvidence.length>NEW_EVIDENCE_MAX))throw Error('invalid new evidence: newEvidence belongs to a build task only and is 1 to '+NEW_EVIDENCE_MAX+' characters (task '+t.id+', kind '+t.kind+')');
 if(t.args!==undefined&&(!Array.isArray(t.args)||t.args.some(a=>typeof a!=='string'||a.includes('\0'))))throw Error('invalid task args: args is an array of strings, for example ["18000"], not a count or a number (task '+t.id+')');
 if(t.acceptIndex!==undefined&&(!Number.isSafeInteger(t.acceptIndex)||t.acceptIndex<0||t.acceptIndex>=(t.participants?.length??1)))throw Error('invalid acceptance participant index');
 if(t.kind==='run'){
  if(Number(t.account!==undefined)+Number(t.accountFrom!==undefined)+Number(t.participants!==undefined)!==1)throw Error('run task needs one account binding');
  if(!t.accept||!Object.values(t.accept).some(v=>Array.isArray(v)?v.length:Object.keys(v??{}).length))throw Error('run task needs a useful effect');
 }
 for(const rows of [t.accept?.skills,t.accept?.bank,t.accept?.counters])for(const n of Object.values(rows??{}))if(!Number.isFinite(n)||n<=0)throw Error('invalid useful-effect target');
 if(t.env!==undefined){
  if(!t.env||typeof t.env!=='object'||Array.isArray(t.env)||Object.entries(t.env).some(([k,v])=>!/^[_a-z][_a-z0-9]*$/i.test(k)||typeof v!=='string'||v.includes('\0')))throw Error('invalid task env: env is an object of NAME:"string value" pairs, not a list of names (task '+t.id+')');
  if(Object.keys(t.env).some(k=>/PASSWORD|SECRET|TOKEN|HAGGIS_RUN|WORKER_RELEASE|DEMO_OK/i.test(k)))throw Error('credentials and launch authority do not belong in task input');
 }
}

export function addTasks(state:CoordinatorState,tasks:CoordTask[],now=Date.now()){
 if(!Array.isArray(tasks)||tasks.length>24)throw Error('invalid task batch');
 const all=new Map(state.tasks.map(r=>[r.spec.id,r.spec]));
 for(const task of tasks){validateTask(task);if(all.has(task.id))throw Error('task already exists: '+task.id);all.set(task.id,task);}
 // A finished task never runs again, so its own dependencies need not exist: compactState may archive them.
 const done=new Set<string>(state.tasks.filter(r=>r.status!=='pending'&&r.status!=='running').map(r=>r.spec.id)),active=new Set<string>();
 const visit=(id:string)=>{
  if(active.has(id))throw Error('dependency cycle: '+id);if(done.has(id))return;
  const task=all.get(id);if(!task)throw Error('missing dependency: '+id);active.add(id);
  for(const dep of [...task.dependsOn,...provisionRefs(task)])visit(dep);
  for(const ref of provisionRefs(task))if(all.get(ref)?.kind!=='provision')throw Error('account reference needs a provision task: '+ref);
  active.delete(id);done.add(id);
 };
 for(const task of tasks)visit(task.id);
 state.tasks.push(...tasks.map(spec=>({spec,status:'pending' as const,createdAt:now,attempts:0})));state.sequence++;
}

/** Preserve failed receipts while moving waiting consumers to an explicit replacement. */
export function replaceTasks(state:CoordinatorState,replacements:{from:string;to:string}[]){
 const records=new Map(state.tasks.map(r=>[r.spec.id,r]));
 for(const {from,to} of replacements){
  const old=records.get(from),next=records.get(to);
  // The planner reads this reason in its next prompt, so it names the one rule that the pair breaks.
  const fault=!old?'from is not a task in the queue':!next?'to is not a task in the queue or in this proposal: '+to:from===to?'from and to are the same task'
   :!['pending','failed','superseded'].includes(old.status)?'from is '+old.status+'; only a pending, failed or superseded task can be replaced'
   :next.status==='failed'||next.status==='superseded'?'to is '+next.status
   :old.spec.kind!==next.spec.kind?'kind differs: '+old.spec.kind+' and '+next.spec.kind:old.spec.kind==='provision'?'a provision task cannot be replaced'
   :old.spec.capability!==next.spec.capability?'capability differs: '+old.spec.capability+' and '+next.spec.capability
   :old.spec.goal!==next.spec.goal?'goal differs: '+old.spec.goal+' and '+next.spec.goal
   :JSON.stringify([old.spec.account,old.spec.accountFrom,old.spec.participants])!==JSON.stringify([next.spec.account,next.spec.accountFrom,next.spec.participants])?'account, accountFrom or participants differ':null;
  if(fault||!old||!next)throw Error('invalid task replacement: '+from+' ('+fault+')');
  for(const r of state.tasks.filter(r=>r.status==='pending'))r.spec.dependsOn=[...new Set(r.spec.dependsOn.map(id=>id===from?to:id))];
  if(old.status==='pending')old.status='superseded';old.supersededBy=to;
 }
 const done=new Set<string>(),active=new Set<string>();
 // Only open tasks run again, so only their dependencies must exist. compactState keeps the newest finished task of each
 // capability and kind, and that task's own dependencies may be archived.
 const visit = (id: string) => {
  if (active.has(id)) throw Error('replacement dependency cycle: ' + id);
  if (done.has(id)) return;
  const record = records.get(id);
  if (!record) throw Error('missing replacement dependency');
  if (record.status === 'pending' || record.status === 'running') {
   active.add(id);
   for (const dep of [...record.spec.dependsOn, ...provisionRefs(record.spec)]) visit(dep);
   active.delete(id);
  }
  done.add(id);
 };
 for(const r of state.tasks)visit(r.spec.id);
}

/** Remove old finished tasks from the state and return them, oldest first. Kept: open tasks, every task an open task
 * names (dependsOn, accountFrom, participants), and the newest finished task of each capability and kind, so
 * qualifications, the last build outcome and account bindings stay in the state. */
export function compactState(state:CoordinatorState,now:number,keepMs=ARCHIVE_AFTER_MS):TaskRecord[]{
 const open=state.tasks.filter(r=>r.status==='pending'||r.status==='running');
 const named=new Set(open.flatMap(r=>[...r.spec.dependsOn,...provisionRefs(r.spec)]));
 const newest=new Map<string,TaskRecord>();
 for(const r of state.tasks){if(r.status==='pending'||r.status==='running')continue;const key=`${r.spec.capability??''}\0${r.spec.kind}`;const held=newest.get(key);if(!held||finishedAt(r)>finishedAt(held))newest.set(key,r);}
 const keepers=new Set(newest.values());
 const archived=state.tasks.filter(r=>!(r.status==='pending'||r.status==='running')&&!named.has(r.spec.id)&&!keepers.has(r)&&now-finishedAt(r)>keepMs);
 if(!archived.length)return [];
 const gone=new Set(archived);state.tasks=state.tasks.filter(r=>!gone.has(r));
 return archived.sort((a,b)=>finishedAt(a)-finishedAt(b));
}

export function startTask(state:CoordinatorState,id:string,now:number,runId:string):TaskRecord{
 const record=state.tasks.find(r=>r.spec.id===id);if(!record||record.status!=='pending')throw Error('task is not pending');
 record.status='running';record.runId=runId;record.startedAt=now;record.attempts++;
 state.goals.find(g=>g.id===record.spec.goal)!.lastStartedAt=now;state.sequence++;return record;
}

// The review task for a build that delivered without waiting. It runs with the other model, on the published source.
function deferredReviewTask(build:CoordTask,agent:'codex'|'claude'|undefined,gate:string):CoordTask{
 return{id:build.id+'-review',goal:build.goal,kind:'review',dependsOn:[build.id],priority:90,estimatedMs:300000,capability:build.capability,
  agent:agent==='claude'?'codex':'claude',
  why:'Review of build '+build.id+', which delivered before review ('+gate+'). A rejection stops this capability\'s next runs until a repair build. Build work order: '+build.why.slice(0,1500)};
}

export function finishTask(state:CoordinatorState,receipt:Receipt):boolean{
 const record=state.tasks.find(r=>r.spec.id===receipt.taskId);
 if(!record||record.status!=='running'||record.runId!==receipt.runId||!Number.isFinite(receipt.at)||receipt.at<(record.startedAt??Infinity))return false;
 record.receipt=receipt;record.status=receipt.ok?'succeeded':'failed';
 if(receipt.ok){const goal=state.goals.find(g=>g.id===record.spec.goal)!;goal.lastSucceededAt=receipt.at;goal.completedTasks++;}
 // A build that delivered before review queues that review now (model-worker.ts reviewGate).
 if(receipt.ok&&record.spec.kind==='build'&&receipt.output?.review?.deferred===true&&!state.tasks.some(r=>r.spec.id===record.spec.id+'-review'))
  addTasks(state,[deferredReviewTask(record.spec,receipt.output.agent??record.agent,String(receipt.output.review.reason??''))],receipt.at);
 record.receiptSequence=state.latestReceiptSequence=++state.sequence;
 return true;
}
