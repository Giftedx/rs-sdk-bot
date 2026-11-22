import {boundAccounts,provisionRefs,type CoordinatorState,type CoordTask,type TaskRecord} from './types';
import {deadRoots,dependencyMet,preparedProvisionClaims} from './dependencies';
import {buildHeld,buildOverlap,lastBuildOutcome} from './builds';

const exclusive=(kind:CoordTask['kind'])=>kind==='build'||kind==='qualify';

export function fleetExpansion(s:{limit:number;demand:number;freeGB:number;reserveGB:number;cpu:number|null;tickMs:number|null;stalled:boolean;usefulResults:number;now:number;lastExpandedAt:number;step?:number}){
 if(!Number.isSafeInteger(s.limit)||s.limit<1||!Number.isSafeInteger(s.demand)||s.demand<=s.limit||s.stalled||s.usefulResults<2
  ||!Number.isFinite(s.reserveGB)||s.reserveGB<0||!Number.isFinite(s.freeGB)||s.freeGB<s.reserveGB+4||s.cpu===null||!Number.isFinite(s.cpu)||s.cpu<0||s.cpu>.85||s.tickMs===null||!Number.isFinite(s.tickMs)||s.tickMs<=0||s.tickMs>800
  ||s.now-s.lastExpandedAt<600000)return s.limit;
 return Math.min(s.demand,s.limit+4);
}

// isolatedBuilds: builds author and prove in their own workspace (build-workspace.ts), so builds and live runs overlap.
// Only a publish into the main checkout needs a drained fleet: publishPending holds new live starts until it lands.
export function chooseTask(state:CoordinatorState,now:number,resources:{sourceReady?:boolean;nativeReady?:boolean;liveLimit?:number;developmentLimit?:number;preferLive?:boolean;focusCapability?:string;isolatedBuilds?:boolean;publishPending?:boolean;publishing?:string;ownedFiles?:(capability:string)=>readonly string[];runHeld?:(task:CoordTask)=>boolean;provisionRunHeld?:(task:CoordTask,records:ReadonlyMap<string,TaskRecord>)=>boolean;goalValue?:(task:CoordTask)=>number|null}={}):CoordTask|null{
 const records=new Map(state.tasks.map(r=>[r.spec.id,r])),running=state.tasks.filter(r=>r.status==='running');
 const busyBuilds=[...new Set([...running.filter(r=>r.spec.kind==='build'&&r.spec.capability).map(r=>r.spec.capability!),...(resources.publishing?[resources.publishing]:[])])];
 const focusCaps=new Set<string>(),visited=new Set<string>();
 const includeFocus=(id:string)=>{
  if(visited.has(id))return;visited.add(id);const record=records.get(id);if(!record)return;
  if(record.spec.capability)focusCaps.add(record.spec.capability);
  for(const dependency of [...record.spec.dependsOn,...provisionRefs(record.spec)])includeFocus(dependency);
 };
 if(resources.focusCapability){
  focusCaps.add(resources.focusCapability);
  for(const record of state.tasks)if(['pending','running'].includes(record.status)&&record.spec.capability===resources.focusCapability)includeFocus(record.spec.id);
 }
 const values=new Map<string,number|null>();
 const goalValue=(task:CoordTask)=>{
  if(!values.has(task.id)){
   const value=resources.goalValue?.(task)??null;
   values.set(task.id,typeof value==='number'&&Number.isFinite(value)&&value>0?value:null);
  }
  return values.get(task.id)??null;
 };
 const pending=state.tasks.filter(r=>r.status==='pending'&&[...r.spec.dependsOn,...provisionRefs(r.spec)].every(id=>dependencyMet(r.spec,records.get(id),records))
  &&(!resources.goalValue||goalValue(r.spec)!==null));
 if(!pending.length)return null;
 const dead=deadRoots(state,records),consumerCounts=new Map<string,number>(),liveDependencies=new Set<string>();
 for(const r of state.tasks){
  if(r.status!=='pending'||dead.has(r.spec.id))continue;
  for(const id of new Set([...r.spec.dependsOn,...provisionRefs(r.spec)])){
   consumerCounts.set(id,(consumerCounts.get(id)??0)+1);
   if(r.spec.kind==='run')liveDependencies.add(id);
  }
 }
 const provisionClaims=preparedProvisionClaims(state,records,dead,
  task=>(task.participants?.length??1)>(resources.liveLimit??Infinity)||!!resources.runHeld?.(task)||!!resources.provisionRunHeld?.(task,records));
 const sourceReady=resources.sourceReady??resources.nativeReady;
 const canBuild=(r:TaskRecord)=>{const prior=lastBuildOutcome(state,r.spec.capability!);return sourceReady!==false&&!buildHeld(state,r.spec,now)&&!(prior?.hostDeferred===true&&prior.sourcePrepared===true&&resources.nativeReady===false)&&!(resources.isolatedBuilds&&buildOverlap(r.spec.capability!,busyBuilds,resources.ownedFiles));};
 const buildWaiting=pending.some(r=>r.spec.kind==='build'&&canBuild(r)&&(!resources.focusCapability||focusCaps.has(r.spec.capability!)));
 // Give a freshly qualified capability one finite consumer before another
 // build invalidates it. The runtime still verifies source/review/admission.
 const lastLiveStartByCapability=new Map<string,number>();
 for(const r of state.tasks){
  const capability=r.spec.capability;
  if(r.spec.kind==='run'&&capability&&r.startedAt!==undefined){
   lastLiveStartByCapability.set(capability,Math.max(lastLiveStartByCapability.get(capability)??0,r.startedAt));
  }
 }
 const productionWindow=new Set(pending.filter(r=>r.spec.kind==='run'&&r.spec.dependsOn.some(id=>{
  const dep=records.get(id);return !!dep&&dep.spec.capability===r.spec.capability&&dep.receipt?.output?.delivery?.ok&&(dep.receipt.at??0)>(lastLiveStartByCapability.get(r.spec.capability!)??0);
 })).map(r=>r.spec.id));
 const activeNames=new Set<string>();
 let liveSlotsLeft=resources.liveLimit??Infinity;
 for(const {spec} of running){
  if(spec.kind==='run'){
   liveSlotsLeft-=spec.participants?.length??1;
   for(const name of boundAccounts(spec,state)??[])activeNames.add(name.toLowerCase());
  }else if(spec.kind==='provision')liveSlotsLeft--;
 }
 // An isolated build changes the main checkout only when it publishes, so a qualification for a waiting live run
 // goes ahead of builds and of another focus; the run normally ends before that publish.
 const liveQualifies=new Set(resources.isolatedBuilds?pending.filter(r=>r.spec.kind==='qualify'&&liveDependencies.has(r.spec.id)).map(r=>r.spec.id):[]);
 const ready=pending.filter(r=>{
  // Unrelated native proofs would expire at the next focused source repair.
  // Leave them queued until the focused capability reaches its live consumer.
  const liveQualify=liveQualifies.has(r.spec.id);
  // With isolated builds a focus only orders work; other capabilities still build in the free slots.
  if(!resources.isolatedBuilds&&!liveQualify&&resources.focusCapability&&['build','qualify'].includes(r.spec.kind)&&!focusCaps.has(r.spec.capability!))return false;
  if(r.spec.kind==='qualify'&&buildWaiting&&!liveQualify)return false;
  if(r.spec.kind!=='run'&&running.filter(a=>a.spec.kind!=='run').length>=(resources.developmentLimit??Infinity))return false;
  if(r.spec.kind==='build'&&!canBuild(r)||r.spec.kind==='qualify'&&resources.nativeReady===false)return false;
  // Isolated builds author apart and delivery-cli gives native checks one practice turn each, so development tasks
  // overlap up to developmentLimit; without isolation they share the main checkout one at a time.
  if(!resources.isolatedBuilds&&exclusive(r.spec.kind)&&running.some(a=>exclusive(a.spec.kind)))return false;
  if(r.spec.kind==='build'&&running.some(a=>(a.spec.kind==='run'&&!resources.isolatedBuilds)||a.spec.kind==='provision'))return false;
  if(r.spec.kind==='provision'&&!provisionClaims.has(r.spec.id))return false;
  if(r.spec.kind==='provision'&&running.some(a=>a.spec.kind==='provision'))return false;
  if(r.spec.kind==='provision'&&running.some(a=>a.spec.kind==='build'))return false;
  if(r.spec.kind==='provision'&&liveSlotsLeft<1)return false;
  if(r.spec.kind==='run'){
   if(resources.isolatedBuilds){if(resources.publishPending)return false;}
   else if(buildWaiting&&!resources.preferLive&&!productionWindow.has(r.spec.id)||running.some(a=>a.spec.kind==='build'))return false;
   const names=boundAccounts(r.spec,state);
   if(!names?.length||names.length>liveSlotsLeft||names.some(n=>activeNames.has(n.toLowerCase())))return false;
   if(resources.runHeld?.(r.spec))return false;
  }
  return true;
 });
 const score=(r:TaskRecord)=>{
  const goal=state.goals.find(g=>g.id===r.spec.goal)!;
  const consumers=consumerCounts.get(r.spec.id)??0;
  return r.spec.priority*(1+consumers)/Math.max(1,r.spec.estimatedMs/60000)
   +Math.min(20,Math.max(0,now-Math.max(goal.lastStartedAt,r.createdAt))/300000);
 };
 const consumers=ready.filter(r=>resources.preferLive?r.spec.kind==='run':productionWindow.has(r.spec.id));
 const focused=ready.filter(r=>r.spec.capability===resources.focusCapability||liveQualifies.has(r.spec.id));
 const candidates=focused.length&&!resources.isolatedBuilds?focused:(buildWaiting||resources.preferLive)&&consumers.length?consumers:ready;
 const ordered=(r:TaskRecord)=>resources.isolatedBuilds&&focused.includes(r)?1:0;
 if(resources.goalValue)return candidates.sort((a,b)=>(goalValue(b.spec)!/b.spec.estimatedMs)-(goalValue(a.spec)!/a.spec.estimatedMs)
  ||ordered(b)-ordered(a)||score(b)-score(a)||a.createdAt-b.createdAt||a.spec.id.localeCompare(b.spec.id))[0]?.spec??null;
 const overdue=candidates.filter(r=>now-state.goals.find(g=>g.id===r.spec.goal)!.lastStartedAt>=30*60000);
 const pool=overdue.length?overdue:candidates;
 return pool.sort((a,b)=>ordered(b)-ordered(a)||(overdue.length?state.goals.find(g=>g.id===a.spec.goal)!.lastStartedAt-state.goals.find(g=>g.id===b.spec.goal)!.lastStartedAt:0)
  ||score(b)-score(a)||a.createdAt-b.createdAt||a.spec.id.localeCompare(b.spec.id))[0]?.spec??null;
}

export function buildWorkOrder(task:CoordTask,dependencies:Record<string,unknown>,directory:string){
 return `Capability: ${task.capability}\nClaimed task: ${task.id}\nWork order: ${task.why}\nOwned run directory: ${directory}\ninput.json there holds the complete task and the receipts of finished tasks. It is often over 1 MB, too large for one Read: Grep it for a task id or a key, or Read it with offset and limit. Preserve before/ snapshots.\nDependency outcomes: ${JSON.stringify(Object.fromEntries(task.dependsOn.map(id=>[id,dependencies[id]??{missing:true}])))}\nFinish the named repair and consumer, not just the generic capability goal.`;
}
