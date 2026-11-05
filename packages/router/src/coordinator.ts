// Durable orchestration above the existing author, delivery and swarm paths.
// Task counts are coordination metrics, never percentages of game completion.
export const GOALS=['wealth','skills','quests','gear','specialists','main24'] as const;
export type GoalId=typeof GOALS[number];
export type Effect={skills?:Record<string,number>;bank?:Record<string,number>;quests?:string[];counters?:Record<string,number>};
export interface CoordTask {
 id:string;goal:GoalId;kind:'build'|'qualify'|'provision'|'run'|'review';dependsOn:string[];
 priority:number;estimatedMs:number;why:string;capability?:string;
 account?:string;accountFrom?:string;role?:string;env?:Record<string,string>;
 participants?:string[];args?:string[];acceptIndex?:number;
 accept?:Effect;timeoutMs?:number;
 launch?:'ordinary'|'specialist'|'main';
 repairs?:{account:string;endedAt:number}[];
 sessionRecovery?:{account:string;endedAt:number};
 agent?:'codex'|'claude';
 // Explicit continuation only: rerun delivery and review without changing this exact prepared source.
 resumeSource?:string;
 // Build only: command types whose replay difference is this build's stated change (model-worker.ts reviewGate).
 replayAllow?:string[];
 // Build only: the observation this build has that the failed builds lacked. It passes one repeated-fault hold.
 newEvidence?:string;
 /** Set when a deterministic rule (coordinator-rules.ts) created the task. */
 rule?:'next-band';
}
export interface Receipt {taskId:string;runId:string;ok:boolean;at:number;output:any;error?:string}
export interface TaskRecord {
 spec:CoordTask;status:'pending'|'running'|'succeeded'|'failed'|'superseded';createdAt:number;attempts:number;supersededBy?:string;
 runId?:string;startedAt?:number;pid?:number;receipt?:Receipt;
 agent?:'codex'|'claude';
}
export interface CoordinatorState {
 version:1;sequence:number;tasks:TaskRecord[];
 goals:{id:GoalId;lastStartedAt:number;lastSucceededAt:number;completedTasks:number}[];
 planner?:{runId:string;startedAt:number;pid?:number;agent?:'codex'|'claude'};lastPlanAt:number;lastPlanReason:string;
 latestReceiptSequence?:number; plannerReceiptSequence?:number;
}
export function fleetExpansion(s:{limit:number;demand:number;freeGB:number;reserveGB:number;cpu:number|null;tickMs:number|null;stalled:boolean;usefulResults:number;now:number;lastExpandedAt:number;step?:number}){
 if(!Number.isSafeInteger(s.limit)||s.limit<1||!Number.isSafeInteger(s.demand)||s.demand<=s.limit||s.stalled||s.usefulResults<2
  ||!Number.isFinite(s.reserveGB)||s.reserveGB<0||!Number.isFinite(s.freeGB)||s.freeGB<s.reserveGB+4||s.cpu===null||!Number.isFinite(s.cpu)||s.cpu<0||s.cpu>.85||s.tickMs===null||!Number.isFinite(s.tickMs)||s.tickMs<=0||s.tickMs>800
  ||s.now-s.lastExpandedAt<600000)return s.limit;
 return Math.min(s.demand,s.limit+4);
}
/** Preserve failed receipts while moving waiting consumers to an explicit replacement. */
export function replaceTasks(state:CoordinatorState,replacements:{from:string;to:string}[]){
 const records=new Map(state.tasks.map(r=>[r.spec.id,r]));
 for(const {from,to} of replacements){
  const old=records.get(from),next=records.get(to);
  if(!old||!next||from===to||!['pending','failed','superseded'].includes(old.status)||next.status==='failed'||next.status==='superseded'
   ||old.spec.kind!==next.spec.kind||old.spec.kind==='provision'||old.spec.capability!==next.spec.capability||old.spec.goal!==next.spec.goal
   ||JSON.stringify([old.spec.account,old.spec.accountFrom,old.spec.participants])!==JSON.stringify([next.spec.account,next.spec.accountFrom,next.spec.participants]))throw Error('invalid task replacement: '+from);
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

/** Qualify demanded capabilities only. Old failed refreshes must not poison new consumers. */
export function qualificationDemand(state:CoordinatorState){
 const records=new Map(state.tasks.map(r=>[r.spec.id,r]));
 return state.tasks.filter(r=>r.status==='pending'&&r.spec.kind==='run'&&[...r.spec.dependsOn.filter(id=>!id.startsWith('refresh-'+r.spec.capability+'-')),...provisionRefs(r.spec)].every(id=>records.get(id)?.status==='succeeded'));
}
export function refreshQualifications(state:CoordinatorState,fingerprints:Record<string,string>){
 const runs=state.tasks.filter(r=>r.status==='pending'&&r.spec.kind==='run');
 const demand=qualificationDemand(state);
 for(const [cap,source] of Object.entries(fingerprints)){
  const consumers=runs.filter(r=>r.spec.capability===cap);if(!consumers.length)continue;
  const proved=state.tasks.findLast(r=>r.status==='succeeded'&&r.spec.capability===cap&&r.receipt?.output?.delivery?.ok&&r.receipt.output.delivery.source===source);
  const id=proved?.spec.id??`refresh-${cap}-${source.slice(0,16)}`;
  const dormant=state.tasks.find(r=>r.spec.id===id);
  if(!proved&&dormant?.status==='superseded'&&dormant.attempts===0&&!dormant.receipt){dormant.status='pending';delete dormant.supersededBy;}
  if(!state.tasks.some(r=>r.spec.id===id))addTasks(state,[{id,goal:consumers[0]!.spec.goal,kind:'qualify',capability:cap,dependsOn:[],priority:15,estimatedMs:240000,why:'Refresh current source for a waiting live consumer'}]);
  for(const run of consumers)run.spec.dependsOn=[...new Set([...run.spec.dependsOn.filter(dep=>!dep.startsWith('refresh-'+cap+'-')),id])];
  for(const child of state.tasks.filter(r=>r.status==='pending'&&r.spec.id!==id))child.spec.dependsOn=[...new Set(child.spec.dependsOn.map(dep=>dep.startsWith('refresh-'+cap+'-')?id:dep))];
  for(const old of state.tasks.filter(r=>r.status==='pending'&&r.spec.kind==='qualify'&&r.spec.id.startsWith('refresh-'+cap+'-')&&r.spec.id!==id)){old.status='superseded';old.supersededBy=id;}
 }
 // No consumer means no reason to spend a native slot. History is retained.
 for(const r of state.tasks.filter(r=>r.status==='pending'&&r.spec.kind==='qualify'&&r.spec.id.startsWith('refresh-')))
  if(!demand.some(run=>run.spec.capability===r.spec.capability)&&!state.tasks.some(child=>child.status==='pending'&&child.spec.kind!=='run'&&child.spec.dependsOn.includes(r.spec.id)))r.status='superseded';
}

export function buildWorkOrder(task:CoordTask,dependencies:Record<string,unknown>,directory:string){
 return `Capability: ${task.capability}\nClaimed task: ${task.id}\nWork order: ${task.why}\nOwned run directory: ${directory}\nRead input.json there for the complete task and dependency receipts. Preserve before/ snapshots.\nDependency outcomes: ${JSON.stringify(Object.fromEntries(task.dependsOn.map(id=>[id,dependencies[id]??{missing:true}])))}\nFinish the named repair and consumer, not just the generic capability goal.`;
}
export function initialState():CoordinatorState{
 return{version:1,sequence:0,tasks:[],goals:GOALS.map(id=>({id,lastStartedAt:0,lastSucceededAt:0,completedTasks:0})),lastPlanAt:0,lastPlanReason:'bootstrap'};
}
const ACCOUNT=/^[A-Za-z0-9_ -]{1,12}$/;
const TASK_ID=/^[-a-z0-9]+$/;
export function provisionRefs(task:CoordTask):string[]{
 return [...(task.accountFrom?[task.accountFrom]:[]),...(task.participants??[]).filter(n=>n.startsWith('@')).map(n=>n.slice(1))];
}
export function validateTask(t:CoordTask){
 if(t.agent!==undefined&&!['codex','claude'].includes(t.agent))throw Error('invalid worker agent');
 if(t.resumeSource!==undefined&&(t.kind!=='build'||typeof t.resumeSource!=='string'||!/^[a-f0-9]{64}$/.test(t.resumeSource)))throw Error('invalid prepared source continuation');
 if(t.rule!==undefined&&(t.rule!=='next-band'||t.kind!=='run'))throw Error('invalid rule task');
 if(t.repairs!==undefined&&(!Array.isArray(t.repairs)||t.repairs.some(r=>!r||!ACCOUNT.test(r.account)||!Number.isFinite(r.endedAt)||r.endedAt<0)))throw Error('invalid exact recovery request');
 if(t.sessionRecovery!==undefined&&(t.kind!=='run'||t.launch&&t.launch!=='ordinary'||t.account!==t.sessionRecovery?.account
  ||!ACCOUNT.test(t.sessionRecovery.account)||['haggis','shaftshooter','polevaulter'].includes(t.sessionRecovery.account.toLowerCase())
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
 if(t.newEvidence!==undefined&&(t.kind!=='build'||typeof t.newEvidence!=='string'||!t.newEvidence.trim()||t.newEvidence.length>500))throw Error('invalid new evidence');
 if(t.args!==undefined&&(!Array.isArray(t.args)||t.args.some(a=>typeof a!=='string'||a.includes('\0'))))throw Error('invalid task args');
 if(t.acceptIndex!==undefined&&(!Number.isSafeInteger(t.acceptIndex)||t.acceptIndex<0||t.acceptIndex>=(t.participants?.length??1)))throw Error('invalid acceptance participant index');
 if(t.kind==='run'){
  if(Number(t.account!==undefined)+Number(t.accountFrom!==undefined)+Number(t.participants!==undefined)!==1)throw Error('run task needs one account binding');
  if(!t.accept||!Object.values(t.accept).some(v=>Array.isArray(v)?v.length:Object.keys(v??{}).length))throw Error('run task needs a useful effect');
 }
 for(const rows of [t.accept?.skills,t.accept?.bank,t.accept?.counters])for(const n of Object.values(rows??{}))if(!Number.isFinite(n)||n<=0)throw Error('invalid useful-effect target');
 if(t.env!==undefined){
  if(!t.env||typeof t.env!=='object'||Array.isArray(t.env)||Object.entries(t.env).some(([k,v])=>!/^[_a-z][_a-z0-9]*$/i.test(k)||typeof v!=='string'||v.includes('\0')))throw Error('invalid task env');
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
const exclusive=(kind:CoordTask['kind'])=>kind==='build'||kind==='qualify';
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
/** Null means a referenced identity is unproved, invalid, or aliases another participant. */
export function boundAccounts(task:CoordTask,state:CoordinatorState):string[]|null{
 const bindings=task.participants??(task.accountFrom?['@'+task.accountFrom]:task.account?[task.account]:[]);
 const names:string[]=[];
 for(const binding of bindings){
  const record=binding.startsWith('@')?state.tasks.find(r=>r.spec.id===binding.slice(1)):undefined;
  const name=binding.startsWith('@')?(record?.status==='succeeded'&&record.receipt?.ok?record.receipt.output?.account:undefined):binding;
  if(typeof name!=='string'||!ACCOUNT.test(name))return null;
  names.push(name);
 }
 return new Set(names.map(n=>n.toLowerCase())).size===names.length?names:null;
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
// isolatedBuilds: builds author and prove in their own workspace (build-workspace.ts), so builds and live runs overlap.
// Only a publish into the main checkout needs a drained fleet: publishPending holds new live starts until it lands.
export function chooseTask(state:CoordinatorState,now:number,resources:{sourceReady?:boolean;nativeReady?:boolean;liveLimit?:number;developmentLimit?:number;preferLive?:boolean;focusCapability?:string;isolatedBuilds?:boolean;publishPending?:boolean;publishing?:string;ownedFiles?:(capability:string)=>readonly string[]}={}):CoordTask|null{
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
 const pending=state.tasks.filter(r=>r.status==='pending'&&[...r.spec.dependsOn,...provisionRefs(r.spec)].every(id=>records.get(id)?.status==='succeeded'));
 const sourceReady=resources.sourceReady??resources.nativeReady;
 const canBuild=(r:TaskRecord)=>{const prior=lastBuildOutcome(state,r.spec.capability!);return sourceReady!==false&&!buildHeld(state,r.spec,now)&&!(prior?.hostDeferred===true&&prior.sourcePrepared===true&&resources.nativeReady===false)&&!(resources.isolatedBuilds&&buildOverlap(r.spec.capability!,busyBuilds,resources.ownedFiles));};
 const buildWaiting=pending.some(r=>r.spec.kind==='build'&&canBuild(r)&&(!resources.focusCapability||focusCaps.has(r.spec.capability!)));
 // Give a freshly qualified capability one finite consumer before another
 // build invalidates it. The runtime still verifies source/review/admission.
 const lastLiveStart=Math.max(0,...state.tasks.filter(r=>r.spec.kind==='run').map(r=>r.startedAt??0));
 const productionWindow=new Set(pending.filter(r=>r.spec.kind==='run'&&r.spec.dependsOn.some(id=>{
  const dep=records.get(id);return !!dep&&dep.spec.capability===r.spec.capability&&dep.receipt?.output?.delivery?.ok&&(dep.receipt.at??0)>lastLiveStart;
 })).map(r=>r.spec.id));
 const activeNames=new Set(running.filter(r=>r.spec.kind==='run').flatMap(r=>boundAccounts(r.spec,state)??[]).map(n=>n.toLowerCase()));
 // An isolated build changes the main checkout only when it publishes, so a qualification for a waiting live run
 // goes ahead of builds and of another focus; the run normally ends before that publish.
 const liveQualifies=new Set(resources.isolatedBuilds?pending.filter(r=>r.spec.kind==='qualify'&&state.tasks.some(p=>p.status==='pending'&&p.spec.kind==='run'&&p.spec.dependsOn.includes(r.spec.id))).map(r=>r.spec.id):[]);
 const ready=pending.filter(r=>{
  // Unrelated native proofs would expire at the next focused source repair.
  // Leave them queued until the focused capability reaches its live consumer.
  const liveQualify=liveQualifies.has(r.spec.id);
  // With isolated builds a focus only orders work; other capabilities still build in the free slots.
  if(!resources.isolatedBuilds&&!liveQualify&&resources.focusCapability&&['build','qualify'].includes(r.spec.kind)&&!focusCaps.has(r.spec.capability!))return false;
  if(r.spec.kind==='qualify'&&buildWaiting&&!liveQualify)return false;
  if(r.spec.kind==='run'&&running.filter(a=>a.spec.kind==='run').length>=(resources.liveLimit??Infinity))return false;
  if(r.spec.kind!=='run'&&running.filter(a=>a.spec.kind!=='run').length>=(resources.developmentLimit??Infinity))return false;
  if(r.spec.kind==='build'&&!canBuild(r)||r.spec.kind==='qualify'&&resources.nativeReady===false)return false;
  // Isolated builds author apart and delivery-cli gives native checks one practice turn each, so development tasks
  // overlap up to developmentLimit; without isolation they share the main checkout one at a time.
  if(!resources.isolatedBuilds&&exclusive(r.spec.kind)&&running.some(a=>exclusive(a.spec.kind)))return false;
  if(r.spec.kind==='build'&&running.some(a=>(a.spec.kind==='run'&&!resources.isolatedBuilds)||a.spec.kind==='provision'))return false;
  if(r.spec.kind==='provision'&&running.some(a=>a.spec.kind==='provision'))return false;
  if(r.spec.kind==='provision'&&running.some(a=>a.spec.kind==='build'))return false;
  if(r.spec.kind==='provision'&&new Set(running.filter(a=>a.spec.kind==='run').flatMap(a=>boundAccounts(a.spec,state)??[])).size>=(resources.liveLimit??Infinity))return false;
  if(r.spec.kind==='run'){
   if(resources.isolatedBuilds){if(resources.publishPending)return false;}
   else if(buildWaiting&&!resources.preferLive&&!productionWindow.has(r.spec.id)||running.some(a=>a.spec.kind==='build'))return false;
   const names=boundAccounts(r.spec,state);
   if(!names?.length||names.some(n=>activeNames.has(n.toLowerCase())))return false;
  }
  return true;
 });
 const score=(r:TaskRecord)=>{
  const goal=state.goals.find(g=>g.id===r.spec.goal)!;
  const consumers=state.tasks.filter(t=>t.status==='pending'&&t.spec.dependsOn.includes(r.spec.id)).length;
  return r.spec.priority*(1+consumers)/Math.max(1,r.spec.estimatedMs/60000)
   +Math.min(20,Math.max(0,now-Math.max(goal.lastStartedAt,r.createdAt))/300000);
 };
 const consumers=ready.filter(r=>resources.preferLive?r.spec.kind==='run':productionWindow.has(r.spec.id));
 const focused=ready.filter(r=>r.spec.capability===resources.focusCapability||liveQualifies.has(r.spec.id));
 const candidates=focused.length&&!resources.isolatedBuilds?focused:(buildWaiting||resources.preferLive)&&consumers.length?consumers:ready;
 const ordered=(r:TaskRecord)=>resources.isolatedBuilds&&focused.includes(r)?1:0;
 const overdue=candidates.filter(r=>now-state.goals.find(g=>g.id===r.spec.goal)!.lastStartedAt>=30*60000);
 const pool=overdue.length?overdue:candidates;
 return pool.sort((a,b)=>ordered(b)-ordered(a)||(overdue.length?state.goals.find(g=>g.id===a.spec.goal)!.lastStartedAt-state.goals.find(g=>g.id===b.spec.goal)!.lastStartedAt:0)
  ||score(b)-score(a)||a.createdAt-b.createdAt||a.spec.id.localeCompare(b.spec.id))[0]?.spec??null;
}
// Finished tasks older than this leave state.json for the archive. Their receipts hold most of the file's bytes.
export const ARCHIVE_AFTER_MS=2*24*60*60*1000;
export const finishedAt=(r:TaskRecord)=>r.receipt?.at??r.startedAt??r.createdAt;
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
export function deferredReviewTask(build:CoordTask,agent:'codex'|'claude'|undefined,gate:string):CoordTask{
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
 state.latestReceiptSequence=++state.sequence;
 return true;
}
type LiveStatusContext={account:string;goal:string;source:string;startedAt:number;now:number;runId?:string};

function matchesLiveStatus(s:any,ctx:LiveStatusContext):boolean{
 return typeof s?.name==='string'&&s.name.toLowerCase()===ctx.account.toLowerCase()
  &&s.server==='rs-sdk-demo.fly.dev'&&!s.practice
  &&(ctx.runId?s.coordinatorRunId===ctx.runId:s.goal===ctx.goal)&&s.workRevision===ctx.source
  &&Number.isFinite(s.at)&&s.at>=ctx.startedAt&&s.at<=ctx.now&&ctx.now-s.at<=300000
  &&Number.isFinite(s.started)&&s.started>=ctx.startedAt;
}

export function boundedWorkerEndMessage(end:{at:number;reason:string},status:any,ctx:LiveStatusContext):string{
 const message='bounded worker ended: '+end.reason;
 if(!ctx.runId||!matchesLiveStatus(status,ctx)||status.at>end.at||typeof status.result!=='string')return message;
 const result=status.result.split(/\r?\n/,1)[0]!.slice(0,160);
 return /^(?:ok|fail)(?:\s|$)/.test(result)?message+' | worker result: '+result:message;
}

export function acceptStatus(task:CoordTask,s:any,ctx:LiveStatusContext):boolean{
 if(!matchesLiveStatus(s,ctx)||!/^ok(?:\s|$)/.test(s.result??''))return false;
 for(const [name,n]of Object.entries(task.accept?.skills??{}))if(!s.skills?.some((v:any)=>v.name===name&&Number.isFinite(v.level)&&v.level>=n))return false;
 for(const [id,n]of Object.entries(task.accept?.bank??{})){
  if(!Number.isFinite(s.bankAt)||s.bankAt<ctx.startedAt||s.bankAt>s.at||!Array.isArray(s.bank))return false;
  if(s.bank.filter((v:any)=>(v.baseId??v.id)===Number(id)&&Number.isFinite(v.count)).reduce((v:number,i:any)=>v+i.count,0)<n)return false;
 }
 for(const [key,n]of Object.entries(task.accept?.counters??{}))if(!Number.isFinite(s.counters?.[key])||s.counters[key]<n)return false;
 for(const name of task.accept?.quests??[])if(!s.quests?.some((q:any)=>q.name===name&&q.state==='complete'))return false;
 return true;
}
