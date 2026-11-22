import {NEW_EVIDENCE_MAX,deadRoots,heldBuilds,provisionRefs,usefulLiveReceipt,type CoordinatorState,type CoordTask,type TaskRecord} from '../coordinator';
import {PROOF_TIMING} from '../build-fault';
import type {HeldRuns} from '../coordinator-decisions';

export function parseModelObject(text:string):any{
 const trimmed=text.trim(),fence=trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
 return JSON.parse(fence?fence[1]!:trimmed);
}

// The prompt carries each task's decision fields and the start of its work order; the full spec, receipts and logs stay
// in .practice/coordinator/state.json and runs/<runId>/ (full specs made the prompt 450,000 characters; research/bot-host.md "Isolated build workspaces").
export const clip=(text:unknown,n:number)=>typeof text==='string'&&text.length>n?text.slice(0,n)+'...':text;
export function receiptOutputReason(receipt:TaskRecord['receipt']){
 const output=receipt?.output;
 return output?.error??output?.review?.reason??output?.delivery?.reason??output?.diagnostic?.reason;
}
export function receiptBuildEvidence(output:any){
 const failedCheck=output?.delivery?.failedCheck??output?.diagnostic?.failedCheck;
 const fault=output?.buildFault;
 const hostDeferred=output?.hostDeferred===true,sourcePrepared=output?.sourcePrepared===true;
 const delivery=output?.delivery,source=delivery?.source;
 const resumable=hostDeferred&&sourcePrepared&&delivery?.hostDeferred===true&&!delivery.diagnostic
  &&typeof source==='string'&&/^[0-9a-f]{64}$/.test(source);
 return{
  ...(typeof failedCheck==='string'?{failedCheck}:{}),
  ...(typeof fault==='string'&&!PROOF_TIMING.test(fault.split(': ',2)[1]??'')?{buildFault:clip(fault,240)}:{}),
  ...(hostDeferred?{hostDeferred,sourcePrepared}:{}),
  ...(output?.hostInterrupted==='memory-floor'?{hostInterrupted:'memory-floor'}:{}),
  ...(resumable?{resumeSource:source}:{}),
 };
}

export function queueFacts(state:CoordinatorState,held:readonly HeldRuns[]=[],now=Date.now()){
 const records=new Map(state.tasks.map(r=>[r.spec.id,r]));
 const active=state.tasks.filter(r=>r.status==='pending'||r.status==='running');
 const dependencies = new Map(active.map(({spec}) => [
  spec.id, [...new Set([...spec.dependsOn, ...provisionRefs(spec)])],
 ]));
 const seen=new Set<string>();
 const shared=new Map<string,number>();
 for(const ids of dependencies.values())for(const id of ids){
  if(seen.has(id)&&!shared.has(id))shared.set(id,shared.size);
  seen.add(id);
 }

 const rootsByTask = new Map<string, Set<string>>();
 function terminalRoots(id: string): Set<string> {
  const cached = rootsByTask.get(id);
  if (cached) return cached;
  const roots = new Set<string>();
  rootsByTask.set(id, roots);
  const record = records.get(id);
  if (!record || record.status === 'failed' || record.status === 'superseded') {
   roots.add(id);
  } else {
   for (const dep of dependencies.get(id) ?? []) {
    for (const root of terminalRoots(dep)) roots.add(root);
   }
  }
  return roots;
 }

 const dependencyReadiness = {satisfied: 0, waiting: 0, blocked: 0};
 const rootCounts = new Map<string, {pendingTasks: number; pendingRuns: number; dependencySatisfiedTasksIfFixed: number; dependencySatisfiedRunsIfFixed: number}>();
 const blocked = [];
 for (const {spec, status} of active) {
  if (status !== 'pending') continue;
  const unmet = dependencies.get(spec.id)!.filter(id => records.get(id)?.status !== 'succeeded');
  const roots = terminalRoots(spec.id);
  dependencyReadiness[roots.size ? 'blocked' : unmet.length ? 'waiting' : 'satisfied']++;
  for (const id of roots) {
   const count = rootCounts.get(id) ?? {pendingTasks: 0, pendingRuns: 0, dependencySatisfiedTasksIfFixed: 0, dependencySatisfiedRunsIfFixed: 0};
   count.pendingTasks++;
   if (spec.kind === 'run') count.pendingRuns++;
   if (unmet.length === 1 && unmet[0] === id) {
    count.dependencySatisfiedTasksIfFixed++;
    if (spec.kind === 'run') count.dependencySatisfiedRunsIfFixed++;
   }
   rootCounts.set(id, count);
  }
  if (unmet.length) blocked.push({id: spec.id, goal: spec.goal, capability: spec.capability,
   dependencies: unmet.map(id => ({
    id, status: records.get(id)?.status ?? 'missing', replacement: records.get(id)?.supersededBy,
   })),
  });
 }

 const rootBlockers = [...rootCounts].map(([id, count]) => {
  const record = records.get(id);
  const receipt = record?.receipt;
  const reason = receipt?.error??receiptOutputReason(receipt);
  return {id, status: record?.status ?? 'missing', runId: record?.runId, replacement: record?.supersededBy, ...count,
   ...(receipt ? {receipt:{at:receipt.at,...(typeof reason==='string'?{error:clip(reason,240)}:{}),...receiptBuildEvidence(receipt.output)}} : {})};
 }).sort((a, b) => b.pendingRuns - a.pendingRuns || b.pendingTasks - a.pendingTasks || a.id.localeCompare(b.id));

 return{lastUsefulLiveAt:state.tasks.reduce((latest,r)=>Math.max(latest,usefulLiveReceipt(r,now)?.at??0),0),
  dependencyReadiness, rootBlockers, blocked,
  heldBuilds:heldBuilds(state,now),
  heldRuns:held.map(h=>({...h,reason:clip(h.reason,240)})),
  sharedDependencyIds:[...shared.keys()],
  active:active.map(({spec,status})=>{
   const {dependsOn,...task}=briefSpec(spec);
   return{spec:task,status,dependencyRefs:dependencies.get(spec.id)!.map(id=>shared.get(id)??id)};
  })};
}

// The planner names an ended job by account and time. From the launch signature it needs only the script and the
// coordinator run, so the argument and environment lists stay in .practice/swarm-deaths.json.
export function briefEnded(ended:Record<string,any>){
 return Object.fromEntries(Object.entries(ended??{}).map(([account,end])=>{
  const {revision,...rest}=end??{};let script:unknown,runId:unknown;
  try{const r=JSON.parse(revision??'');if(Array.isArray(r)){script=r[0];runId=(Array.isArray(r[3])?r[3]:[]).find((e:any)=>Array.isArray(e)&&e[0]==='COORDINATOR_RUN_ID')?.[1];}}catch{/* no launch signature */}
  return[account,{...rest,...(typeof script==='string'?{script}:{}),...(typeof runId==='string'?{runId}:{})}];
 }));
}

export function briefSpec(spec:CoordTask){
 const {why,env,args,...rest}=spec as any;
 // envKeys and argCount are not task fields. A brief under the names env and args reads as the schema, and a planner
 // that copies it returns env as a list and args as a number.
 return{...rest,why:clip(why,200),...(env?{envKeys:Object.keys(env)}:{}),...(args?{argCount:args.length}:{})};
}

// A field fault in a model task that has one safe repair. A whole proposal is refused for one fault, so each repair
// here keeps the other tasks of that proposal.
export function repairModelTask(task:any){
 if(!task||typeof task!=='object'||Array.isArray(task))return task;
 let t=task;
 const evidence=t.newEvidence;
 if(t.kind==='build'&&typeof t.why==='string'&&t.why.trim()&&typeof evidence==='string'&&evidence.length>NEW_EVIDENCE_MAX&&evidence.trim()){
  // The build work order keeps the full observation. The hold check reads the short field.
  t={...t,newEvidence:evidence.trim().slice(0,NEW_EVIDENCE_MAX-1)+'…',why:t.why.includes(evidence)?t.why:t.why+'\n\nNew evidence\n'+evidence};
 }else if(t.kind!=='build'&&evidence!==undefined){
  // Only a build reads newEvidence (buildHeld). On another kind the text is an observation, and why is its home.
  const {newEvidence:_,...rest}=t,text=typeof evidence==='string'?evidence.trim():'';
  t=text&&typeof rest.why==='string'&&!rest.why.includes(text)?{...rest,why:rest.why+'\n\nObservation\n'+text}:rest;
 }
 if(Array.isArray(t.args)&&t.args.some((a:unknown)=>typeof a==='number'&&Number.isFinite(a)))t={...t,args:t.args.map((a:unknown)=>typeof a==='number'&&Number.isFinite(a)?String(a):a)};
 if(t.env===null){const {env:_,...rest}=t;t=rest;}
 return t;
}
