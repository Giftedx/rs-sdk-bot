import {provisionRefs,type CoordinatorState,type TaskRecord} from './types';
import {addTasks} from './tasks';
import {dependencyMet} from './dependencies';
import {buildOverlap} from './builds';

/** Qualify demanded capabilities only. Old failed refreshes must not poison new consumers. */
function qualificationTimedOut(dep:TaskRecord):boolean{
 const out=dep.receipt?.output,delivery=out?.delivery,reason=delivery?.reason??out?.reason;
 if(reason==='check timed out')return true;
 const checks=[...(Array.isArray(delivery?.checks)?delivery.checks:[]),...(Array.isArray(out?.checks)?out.checks:[])];
 return checks.some((c:any)=>c?.timedOut===true);
}

function replaceableQualification(run:TaskRecord,dep:TaskRecord|undefined,cap:string,source:string|undefined,proved:TaskRecord|undefined):boolean{
 if(!dep)return false;
 if(dep.spec.id.startsWith('refresh-'+cap+'-'))return true;
 if(dep.spec.kind!=='qualify'||dep.spec.capability!==cap)return false;
 if(dep.status!=='failed'&&dep.status!=='superseded')return false;
 if(proved)return true;
 if(run.spec.sessionRecovery&&qualificationTimedOut(dep))return true;
 return source!==undefined&&dep.receipt?.output?.delivery?.source!==source;
}

export function qualificationDemand(state:CoordinatorState){
 const records=new Map(state.tasks.map(r=>[r.spec.id,r]));
 return state.tasks.filter(r=>r.status==='pending'&&r.spec.kind==='run'&&[...r.spec.dependsOn.filter(id=>{
  if(id.startsWith('refresh-'+r.spec.capability+'-'))return false;
  const dep=records.get(id);
  return !(r.spec.sessionRecovery&&dep?.spec.kind==='qualify'&&dep.spec.capability===r.spec.capability&&(dep.status==='failed'||dep.status==='superseded')&&qualificationTimedOut(dep));
 }),...provisionRefs(r.spec)].every(id=>dependencyMet(r.spec,records.get(id),records)));
}

// Isolated builds only hold proofs whose capability or owned files they can change.
export function qualificationRefreshCapabilities(state:CoordinatorState,ownedFiles:(capability:string)=>readonly string[]):string[]{
 const building=state.tasks.filter(r=>r.status==='running'&&r.spec.kind==='build').map(r=>r.spec.capability!);
 return [...new Set(qualificationDemand(state).map(r=>r.spec.capability!))].filter(cap=>!buildOverlap(cap,building,ownedFiles));
}

export function refreshQualifications(state:CoordinatorState,fingerprints:Record<string,string>){
 const runs=state.tasks.filter(r=>r.status==='pending'&&r.spec.kind==='run');
 const records=new Map(state.tasks.map(r=>[r.spec.id,r]));
 for(const [cap,source] of Object.entries(fingerprints)){
  const consumers=runs.filter(r=>r.spec.capability===cap);if(!consumers.length)continue;
  const proved=state.tasks.findLast(r=>r.status==='succeeded'&&r.spec.capability===cap&&r.receipt?.output?.delivery?.ok&&r.receipt.output.delivery.source===source);
  const id=proved?.spec.id??`refresh-${cap}-${source.slice(0,16)}`;
  const dormant=state.tasks.find(r=>r.spec.id===id);
  if(!proved&&dormant?.status==='superseded'&&dormant.attempts===0&&!dormant.receipt){dormant.status='pending';delete dormant.supersededBy;}
  if(!state.tasks.some(r=>r.spec.id===id)){
   addTasks(state,[{id,goal:consumers[0]!.spec.goal,kind:'qualify',capability:cap,dependsOn:[],priority:15,estimatedMs:240000,why:'Refresh current source for a waiting live consumer'}]);
   records.set(id,state.tasks[state.tasks.length-1]!);
  }
  for(const run of consumers)run.spec.dependsOn=[...new Set([...run.spec.dependsOn.filter(dep=>!replaceableQualification(run,records.get(dep),cap,source,proved)),id])];
  for(const child of state.tasks.filter(r=>r.status==='pending'&&r.spec.id!==id))child.spec.dependsOn=[...new Set(child.spec.dependsOn.map(dep=>dep.startsWith('refresh-'+cap+'-')?id:dep))];
  for(const old of state.tasks.filter(r=>r.status==='pending'&&r.spec.kind==='qualify'&&r.spec.id.startsWith('refresh-'+cap+'-')&&r.spec.id!==id)){old.status='superseded';old.supersededBy=id;}
 }
 // Recompute demand after rewiring consumers so newly linked refresh tasks are not marked superseded immediately.
 const demand=qualificationDemand(state);
 // No consumer means no reason to spend a native slot. History is retained.
 for(const r of state.tasks.filter(r=>r.status==='pending'&&r.spec.kind==='qualify'&&r.spec.id.startsWith('refresh-')))
  if(!demand.some(run=>run.spec.capability===r.spec.capability)&&!state.tasks.some(child=>child.status==='pending'&&child.spec.kind!=='run'&&child.spec.dependsOn.includes(r.spec.id)))r.status='superseded';
}
