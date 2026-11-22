import type {CoordinatorState,CoordTask} from './types';

export function lastBuildOutcome(state:CoordinatorState,capability:string){
 return state.tasks.filter(r=>r.spec.kind==='build'&&r.spec.capability===capability&&r.receipt&&r.receipt.output!=null)
  .sort((a,b)=>b.receipt!.at-a.receipt!.at)[0]?.receipt?.output;
}

// Prepared source skips authoring only. The executor reruns delivery and the applicable review before publication.
export function preparedNativeDelivery(state:CoordinatorState,capability:string,source:string,resumeSource?:string){
 if(resumeSource!==undefined&&resumeSource!==source)return null;
 const output=lastBuildOutcome(state,capability);
 if(output?.hostDeferred===true&&output.sourcePrepared===true&&output.delivery?.hostDeferred===true&&!output.delivery.diagnostic&&output.delivery.source===source)return output.delivery;
 if(resumeSource!==source)return null;
 return state.tasks.filter(r=>r.spec.kind==='build'&&r.spec.capability===capability&&r.receipt)
  .sort((a,b)=>b.receipt!.at-a.receipt!.at)
  .map(r=>r.receipt!.output?.delivery)
  .find(d=>d?.ok===true&&d.stage==='delivered'&&d.evidence==='native'&&!d.diagnostic&&d.source===source)??null;
}

// Consecutive failed builds of one capability, newest first. A focus that keeps failing starves every other lane:
// a shark-supply-order focus held all development 11.2 h through 19 failed builds (research/bot-host.md "Isolated build workspaces").
export const FOCUS_FAILURE_LIMIT=3;
const finishedBuilds=(state:CoordinatorState,capability:string)=>state.tasks.filter(r=>r.spec.kind==='build'&&r.spec.capability===capability&&r.receipt&&(r.status==='failed'||r.status==='succeeded')).sort((a,b)=>(b.receipt!.at??0)-(a.receipt!.at??0));
export function failedBuildStreak(state:CoordinatorState,capability:string):number{
 let n=0;for(const r of finishedBuilds(state,capability)){if(r.status!=='failed')break;n++;}return n;
}

// Two failed builds in a row with one fault (build-fault.ts) mean the repair did not reach it, so the next author pass
// would repeat it. The capability's builds wait BUILD_HOLD_MS after the last failure; other lanes keep running.
export const BUILD_HOLD_MS=24*60*60*1000;
export function repeatedBuildFault(state:CoordinatorState,capability:string){
 const builds=finishedBuilds(state,capability),fault=builds[0]?.status==='failed'?builds[0].receipt!.output?.buildFault:undefined;
 if(typeof fault!=='string')return null;
 let count=0;for(const r of builds){if(r.status!=='failed'||r.receipt!.output?.buildFault!==fault)break;count++;}
 return count>=2?{capability,fault,builds:count,at:builds[0]!.receipt!.at}:null;
}

// A build that names new evidence passes the first hold only: a third matching failure waits out the time.
export function buildHeld(state:CoordinatorState,task:CoordTask,now:number){
 const repeat=repeatedBuildFault(state,task.capability!);
 return !!repeat&&now-repeat.at<BUILD_HOLD_MS&&!(task.newEvidence&&repeat.builds===2);
}

export function heldBuilds(state:CoordinatorState,now:number){
 const capabilities=new Set(state.tasks.filter(r=>r.spec.kind==='build'&&r.spec.capability).map(r=>r.spec.capability!));
 return [...capabilities].flatMap(c=>{const repeat=repeatedBuildFault(state,c);return repeat&&now-repeat.at<BUILD_HOLD_MS?[repeat]:[];});
}

export function activeBuildFocus(state:CoordinatorState):{capability:string;since:number}|null{
 const record=state.tasks.find(r=>r.status==='running'&&r.spec.kind==='build'&&r.spec.capability&&failedBuildStreak(state,r.spec.capability)<FOCUS_FAILURE_LIMIT);
 return record?{capability:record.spec.capability!,since:record.startedAt??record.createdAt}:null;
}

// Builds that would publish the same file. Two builds of one capability share one workspace, so they always overlap;
// other capabilities overlap when their owned files (`ownedFiles`) share a path. A publish that waits (`publishing`)
// counts as a running build. A build that starts beside an overlapping one fails at publish and loses its work.
export function buildOverlap(capability:string,busy:readonly string[],ownedFiles?:(capability:string)=>readonly string[]):string|null{
 if(busy.includes(capability))return capability;
 if(!ownedFiles)return null;
 let mine:readonly string[];try{mine=ownedFiles(capability);}catch{return null;}
 for(const other of busy){let theirs:readonly string[];try{theirs=ownedFiles(other);}catch{continue;}if(mine.some(f=>theirs.includes(f)))return other;}
 return null;
}
