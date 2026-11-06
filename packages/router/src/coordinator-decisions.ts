// Queue decisions that need no model call: when a planning round is due, which pending tasks can never start, which runs
// wait for a repair, and when the host has no disk left for new work. Each function reads state and returns a decision;
// the coordinator loop (coordinator-cli.ts) acts on it.
import {statfsSync} from 'node:fs';
import {finishedAt,provisionRefs,type CoordinatorState,type TaskRecord} from './coordinator';

// A planning round costs a 150 KB prompt and about two minutes of a subscription model.
export const IDLE_PLAN_MS=30*60*1000;
// Outcomes that land close together share one round.
export const PLAN_GAP_MS=5*60*1000;
// A pending task behind a dead root waits this long for the planner to replace the root, then retires.
export const DEAD_TASK_MS=24*60*60*1000;
// Below this free space on the checkout's volume the coordinator starts no planner and no task.
export const DISK_FLOOR_GB=2;

/** Delay before the next round after this many failed rounds in a row. */
export const planRetryMs=(failures:number)=>Math.min(IDLE_PLAN_MS,60000*2**Math.max(0,failures-1));

const open=(r:TaskRecord|undefined)=>r?.status==='pending'||r?.status==='running';
// A failed refresh does not end a run: refreshQualifications links a new one when the source changes.
const replaceable=(r:TaskRecord,id:string)=>r.spec.kind==='run'&&id.startsWith('refresh-'+r.spec.capability+'-');

/** Each pending task that can never start as queued, with its oldest dead prerequisite. */
export function deadRoots(state:CoordinatorState){
 const records=new Map(state.tasks.map(r=>[r.spec.id,r])),memo=new Map<string,{root:string;at:number}|null>();
 const visit=(record:TaskRecord):{root:string;at:number}|null=>{
  const id=record.spec.id;if(memo.has(id))return memo.get(id)!;
  memo.set(id,null);
  let found:{root:string;at:number}|null=null;
  for(const dep of [...record.spec.dependsOn,...provisionRefs(record.spec)]){
   if(replaceable(record,dep))continue;
   const next=records.get(dep);
   let candidate:{root:string;at:number}|null=null;
   if(!next)candidate={root:dep,at:0};
   else if(next.status==='failed'||next.status==='superseded')candidate={root:dep,at:finishedAt(next)};
   else if(next.status==='pending')candidate=visit(next);
   if(candidate&&(!found||candidate.at<found.at))found=candidate;
  }
  memo.set(id,found);return found;
 };
 const roots=new Map<string,{root:string;at:number}>();
 for(const r of state.tasks)if(r.status==='pending'){const found=visit(r);if(found)roots.set(r.spec.id,found);}
 return roots;
}
/** Retire ordinary pending tasks whose root has been dead for holdMs. Main and specialist launches stay for their owner. */
export function retireDeadTasks(state:CoordinatorState,now:number,holdMs=DEAD_TASK_MS){
 const roots=deadRoots(state),retired:{id:string;root:string}[]=[];
 for(const r of state.tasks){
  const dead=roots.get(r.spec.id);
  if(!dead||r.spec.launch&&r.spec.launch!=='ordinary'||now-Math.max(dead.at,r.createdAt)<holdMs)continue;
  r.status='superseded';r.supersededBy='dead-dependency:'+dead.root;retired.push({id:r.spec.id,root:dead.root});
 }
 if(retired.length)state.sequence++;
 return retired;
}

// A failed receipt always needs the planner. A success needs it only when nothing that can still run waits on the task.
function needsPlan(state:CoordinatorState,record:TaskRecord,dead:ReadonlyMap<string,unknown>){
 if(record.status==='failed')return true;
 return !state.tasks.some(r=>open(r)&&!dead.has(r.spec.id)&&[...r.spec.dependsOn,...provisionRefs(r.spec)].includes(record.spec.id));
}
// Receipts no plan has seen. A receipt that settles during a round is after that round's snapshot.
const unseen=(state:CoordinatorState)=>state.tasks.filter(r=>r.receipt&&(state.plannerReceiptSequence===undefined?r.receipt.at>state.lastPlanAt:(r.receiptSequence??0)>state.plannerReceiptSequence));
/** Why a planning round is due now, or null. */
export function plannerDue(state:CoordinatorState,now:number,intervalMs:number,requested:boolean):'request'|'retry'|'idle'|'outcome'|null{
 if(state.planner)return null;
 const since=now-state.lastPlanAt;
 if(requested)return since>1000?'request':null;
 if(state.planFailures)return since>=planRetryMs(state.planFailures)?'retry':null;
 if(since>Math.max(intervalMs,IDLE_PLAN_MS))return 'idle';
 if(since<PLAN_GAP_MS)return null;
 const fresh=unseen(state);
 if(!fresh.length)return null;
 const dead=deadRoots(state);
 return fresh.some(r=>needsPlan(state,r,dead))?'outcome':null;
}
/** Record the end of a planning round. */
export function finishPlan(state:CoordinatorState,now:number,accepted:boolean){
 state.lastPlanAt=now;delete state.planner;
 if(accepted)delete state.planFailures;else state.planFailures=(state.planFailures??0)+1;
}

/** The reason of the newest review of the current source, when it rejected. Same rule as rejectedReview (model-worker.ts). */
export function reviewHold(state:CoordinatorState,capability:string,source:()=>string):string|null{
 const reviews=state.tasks.filter(r=>r.spec.capability===capability&&r.receipt?.output?.evidence==='source-review');
 if(!reviews.some(r=>r.receipt!.output.review?.approved===false))return null;
 const current=source(),latest=reviews.filter(r=>r.receipt!.output.source===current).sort((a,b)=>b.receipt!.at-a.receipt!.at)[0];
 return latest?.receipt?.output.review?.approved===false?String(latest.receipt.output.review.reason):null;
}
export interface HeldRuns{capability:string;reason:string;runs:string[]}
/** Pending runs held by a rejected review, by capability. A source that cannot be read holds nothing: the worker reports it. */
export function heldRuns(state:CoordinatorState,source:(capability:string)=>string):HeldRuns[]{
 const by=new Map<string,string[]>();
 for(const r of state.tasks)if(r.status==='pending'&&r.spec.kind==='run'&&r.spec.capability)by.set(r.spec.capability,[...(by.get(r.spec.capability)??[]),r.spec.id]);
 return [...by].flatMap(([capability,runs])=>{
  try{const reason=reviewHold(state,capability,()=>source(capability));return reason===null?[]:[{capability,reason,runs}];}
  catch{return[];}
 });
}

/** Free space on the volume that holds path, in GiB. Null when the volume cannot be read. */
export function diskFreeGB(path:string,stat:(path:string)=>{bsize:number|bigint;bavail:number|bigint}=statfsSync):number|null{
 try{const s=stat(path);return Number(s.bsize)*Number(s.bavail)/2**30;}catch{return null;}
}
