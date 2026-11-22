import {finishedAt,provisionRefs,type CoordinatorState,type CoordTask,type TaskRecord} from './types';

// Session recoveries share one repair slot, so they queue as a chain: each recovery run depends on the one before it.
// That earlier recovery is an order, not a proof: once it ended (succeeded, failed or superseded), the next recovery
// may start, so one failed account never strands the accounts behind it. Every other dependency must still succeed.
export const orderOnlyDependency=(task:CoordTask,dep:TaskRecord|undefined):boolean=>!!dep&&task.kind==='run'&&!!task.sessionRecovery
 &&dep.spec.kind==='run'&&!!dep.spec.sessionRecovery&&(dep.status==='succeeded'||dep.status==='failed'||dep.status==='superseded');

// A recovery run gains one qualification of its capability for each relink, and it needs only one that passed: the run
// checks the freshness of the qualification when it starts. So its qualifications of that capability count as one group:
// a failed one is covered once another passed and none is still pending (a pending one may be the newer one it needs).
// `alive` (deadRoots): the failed one does not make the run dead while another passed or may still pass.
const qualificationGroup=(task:CoordTask,dep:TaskRecord|undefined,records:ReadonlyMap<string,TaskRecord>):TaskRecord[]|null=>{
 if(!dep||task.kind!=='run'||!task.sessionRecovery||dep.spec.kind!=='qualify'||dep.spec.capability!==task.capability||(dep.status!=='failed'&&dep.status!=='superseded'))return null;
 return task.dependsOn.map(id=>records.get(id)).filter((r):r is TaskRecord=>!!r&&r.spec.kind==='qualify'&&r.spec.capability===task.capability);
};
const unsettled=(r:TaskRecord)=>r.status==='pending'||r.status==='running';
export const coveredQualification=(task:CoordTask,dep:TaskRecord|undefined,records:ReadonlyMap<string,TaskRecord>):boolean=>{
 const group=qualificationGroup(task,dep,records);
 return !!group&&group.some(r=>r.status==='succeeded')&&!group.some(unsettled);
};
const aliveQualification=(task:CoordTask,dep:TaskRecord|undefined,records:ReadonlyMap<string,TaskRecord>):boolean=>{
 const group=qualificationGroup(task,dep,records);
 return !!group&&group.some(r=>r.status==='succeeded'||unsettled(r));
};
export const dependencyMet=(task:CoordTask,dep:TaskRecord|undefined,records?:ReadonlyMap<string,TaskRecord>):boolean=>
 dep?.status==='succeeded'||orderOnlyDependency(task,dep)||(!!records&&coveredQualification(task,dep,records));

// True when a run has no passed qualification of its capability on the current source among its dependencies: the
// worker would refuse it at once ("fresh same-capability native qualification required", coordinator-worker.ts). The
// refresh that adds such a qualification waits on a related build, so the dispatcher holds such a run instead of
// starting it. `source` null (no fingerprint) holds it too.
export function needsFreshQualification(task:CoordTask,records:ReadonlyMap<string,TaskRecord>,source:string|null):boolean{
 if(task.kind!=='run')return false;
 if(source===null)return true;
 return !task.dependsOn.some(id=>{const d=records.get(id)?.receipt?.output?.delivery;return d?.ok===true&&d.id===task.capability&&d.source===source;});
}

// All session recoveries share one repair slot (coordinator-live.ts requestLiveRecovery waits 15 s for it), and two at
// once fail as "recovery repair slot timed out". Separate recovery chains no longer wait on each other's failures
// (orderOnlyDependency), so the dispatcher starts a recovery run only while no other recovery run is running.
export const recoverySlotBusy=(task:CoordTask,tasks:readonly TaskRecord[]):boolean=>
 task.kind==='run'&&!!task.sessionRecovery&&tasks.some(r=>r.status==='running'&&r.spec.kind==='run'&&!!r.spec.sessionRecovery&&r.spec.id!==task.id);

/** Each pending task that can never start as queued, with its oldest dead prerequisite. */
export function deadRoots(state:CoordinatorState,records:ReadonlyMap<string,TaskRecord>=new Map(state.tasks.map(r=>[r.spec.id,r]))){
 const memo=new Map<string,{root:string;at:number}|null>();
 const visit=(record:TaskRecord):{root:string;at:number}|null=>{
  const id=record.spec.id;if(memo.has(id))return memo.get(id)!;
  memo.set(id,null);
  let found:{root:string;at:number}|null=null;
  for(const dep of [...record.spec.dependsOn,...provisionRefs(record.spec)]){
   // A failed refresh can be replaced when a new source needs qualification, so a run waits behind it. A session
   // recovery does not wait: the recoveries behind it start only when it ends (orderOnlyDependency). Its failed
   // refresh is a dead root until a new source links a new refresh (refreshQualifications).
   if(record.spec.kind==='run'&&dep.startsWith('refresh-'+record.spec.capability+'-')&&!(record.spec.sessionRecovery&&records.get(dep)?.status==='failed'))continue;
   const next=records.get(dep);
   let candidate:{root:string;at:number}|null=null;
   if(!next)candidate={root:dep,at:0};
   else if((next.status==='failed'||next.status==='superseded')&&!orderOnlyDependency(record.spec,next)&&!aliveQualification(record.spec,next,records))candidate={root:dep,at:finishedAt(next)};
   else if(next.status==='pending')candidate=visit(next);
   if(candidate&&(!found||candidate.at<found.at))found=candidate;
  }
  memo.set(id,found);return found;
 };
 const roots=new Map<string,{root:string;at:number}>();
 for(const r of state.tasks)if(r.status==='pending'){const found=visit(r);if(found)roots.set(r.spec.id,found);}
 return roots;
}

export function preparedProvisionRuns(state:CoordinatorState,records:ReadonlyMap<string,TaskRecord>,
 dead=deadRoots(state,records),runHeld?:(task:CoordTask)=>boolean):Set<string>{
 const runs=new Set<string>();
 for(const {spec,status} of state.tasks){
  if(status!=='pending'||spec.kind!=='run'||dead.has(spec.id))continue;
  const refs=provisionRefs(spec);
  // A composed first job can wait on several account claims. Its other prerequisites must have passed.
  if(refs.length&&spec.dependsOn.every(id=>refs.includes(id)||records.get(id)?.status==='succeeded')
   &&refs.every(id=>records.get(id)?.spec.dependsOn.every(dep=>refs.includes(dep)||records.get(dep)?.status==='succeeded'))
   &&!runHeld?.(spec))runs.add(spec.id);
 }
 return runs;
}

export function preparedProvisionClaims(state:CoordinatorState,records:ReadonlyMap<string,TaskRecord>,
 dead=deadRoots(state,records),runHeld?:(task:CoordTask)=>boolean):Set<string>{
 const claims=new Set<string>();
 for(const run of preparedProvisionRuns(state,records,dead,runHeld)){
  for(const id of provisionRefs(records.get(run)!.spec)){
   const claim=records.get(id);
   if(claim?.status==='pending'&&claim.spec.dependsOn.every(dep=>records.get(dep)?.status==='succeeded'))claims.add(id);
  }
 }
 return claims;
}
