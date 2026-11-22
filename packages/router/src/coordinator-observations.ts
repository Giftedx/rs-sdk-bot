import {RESERVED_ACCOUNTS} from '../../core/src/specialist-boards';
import {createHash} from 'node:crypto';
import {addTasks,boundAccounts,deadRoots,type CoordinatorState,type CoordTask} from './coordinator';
import {currentQualification,reviewApproved,retarget} from './coordinator-rules';
import {boundedSkillsObserver,boundedBankObserver,goalWork} from './goal-work';
import type {OwnerGoals} from './goal-scoreboard';
import type {FleetProgressionRequest} from '../../planner/src/progression-fleet';
import type {CoordinatorProgressionResult} from './coordinator-progression';

export const OBSERVATION_CONSUMER_PREFIX='progression-consumer-';
const normalized=(s:string)=>s.toLowerCase();
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export interface ObservationBridgeDeps{
 now:number;side:string;goals:OwnerGoals;statuses:readonly any[];
 /** A login attempt of the account began after the time, or that cannot be excluded (goal-work.ts bank validity). */
 loginAfter?:(account:string,at:number)=>boolean;
 allowed:(account:string)=>boolean;paused:(account:string)=>boolean;
 definition:(id:string)=>{id:string;entry:string;source:string};
 capabilityFor:(entry:string)=>string|null;
 /** Only an exact reviewed/current-qualified finite route may release a generated consumer. */
 prepare:(task:CoordTask,account:string,status:any)=>CoordTask|null;
 qualificationFor?:(task:CoordTask,account:string,status:any)=>CoordTask|null;
 needsEntryObservation?:(task:CoordTask,account:string,status:any)=>boolean;
}
export function generatedObservationConsumer(task:CoordTask){return task.id.startsWith(OBSERVATION_CONSUMER_PREFIX);}
export function observationConsumerHeld(task:CoordTask){return generatedObservationConsumer(task)&&(!task.env?.PROGRESSION_METHOD||!task.env.PROGRESSION_SOURCE);}
export function observationBudget(task:CoordTask,entry:string){
 const raw=task.env?.CAP??(entry==='scripts/ranged-train.ts'?task.args?.[1]:undefined),cap=raw===undefined?Infinity:Number(raw);
 return Math.min((task.timeoutMs??1200000)/400,raw!==undefined&&(!Number.isSafeInteger(cap)||cap<=0)?0:cap);
}
export function prepareObservationBand(task:CoordTask,status:any,entry:string,select:(task:CoordTask)=>CoordinatorProgressionResult,source:()=>string):CoordTask|null{
 const [skill,target]=Object.entries(task.accept?.skills??{})[0]??[],level=status?.skills?.find((s:any)=>normalized(s.name??'')===normalized(skill??''))?.level;
 if(!skill||!Number.isSafeInteger(target)||!Number.isSafeInteger(level))return null;
 for(let next=Math.min(target!,level+5);next>level;next--){
  const moved=retarget(task,skill,target!,next);if(!moved)continue;
  const trial={...task,...moved},chosen=select(trial),ticks=chosen.decision?.expectedTicks;
  if(chosen.action!=='continue'||chosen.capability!==task.capability||!chosen.stepAccept||chosen.route?.length!==1||ticks==null||ticks>observationBudget(task,entry))continue;
  return{...trial,estimatedMs:Math.max(1,Math.ceil(ticks*400)),env:{...trial.env,PROGRESSION_METHOD:chosen.decision!.selected!,PROGRESSION_SOURCE:source(),PROGRESSION_CONSUMER:JSON.stringify(chosen.stepAccept)},accept:chosen.stepAccept};
 }
 return null;
}
/** The coordinator owns these queue changes; request files never log an account in. */
export function applyObservationRequests(state:CoordinatorState,requests:readonly FleetProgressionRequest[],d:ObservationBridgeDeps){
 const added:CoordTask[]=[],linked:string[]=[],prepared:string[]=[],invalidated:string[]=[];
 const clearBinding=(task:CoordTask)=>{if(task.env?.PROGRESSION_METHOD||task.env?.PROGRESSION_SOURCE)invalidated.push(task.id);delete task.env?.PROGRESSION_METHOD;delete task.env?.PROGRESSION_SOURCE;};
 const depend=(task:CoordTask,id:string)=>{if(!task.dependsOn.includes(id)){task.dependsOn.push(id);linked.push(task.id);}};
 const entryOf=(cap:string)=>{try{return d.definition(cap).entry;}catch{return undefined;}};
 const statusOf=(name:string)=>d.statuses.filter(s=>s?.name?.toLowerCase()===normalized(name)&&!s.practice&&s.server==='rs-sdk-demo.fly.dev'&&Number.isFinite(s.at)&&s.at>0&&s.at<=d.now).sort((a,b)=>b.at-a.at)[0];
 const running=new Set(state.tasks.filter(r=>r.status==='running').flatMap(r=>boundAccounts(r.spec,state)??[]).map(normalized));
 const eligible=(name:string)=>/^[A-Za-z0-9]{1,12}$/.test(name)&&!RESERVED_ACCOUNTS.includes(normalized(name))&&d.allowed(name)&&!d.paused(name)&&!running.has(normalized(name));
 const fresh=(s:any,t:CoordTask)=>s&&d.now-s.at<300000&&Array.isArray(s.skills)&&Object.keys(t.accept?.skills??{}).every(skill=>s.skills.some((r:any)=>normalized(r.name??'')===normalized(skill)&&Number.isSafeInteger(r.level)&&r.level>=1&&r.level<=99&&Number.isFinite(r.xp)&&r.xp>=0));
 const freshBank=(s:any)=>s&&Number.isFinite(s.bankAt)&&s.bankAt>0&&s.bankAt<=s.at&&d.now-s.bankAt<300000&&Array.isArray(s.bank);
 const dependencies=(task:CoordTask)=>{
  const visit=[...task.dependsOn],seen=new Set<string>();
  while(visit.length){const id=visit.pop()!;if(seen.has(id))continue;seen.add(id);const row=state.tasks.find(r=>r.spec.id===id);if(row)visit.push(...row.spec.dependsOn);}
  return seen;
 };
 const qualification=(cap:string,goal:CoordTask['goal'],priority:number)=>{
  if(!reviewApproved(state,cap))return null;
  const source=d.definition(cap).source,current=currentQualification(state,cap,source);if(current)return current.spec.id;
  const id='refresh-'+cap+'-'+source.slice(0,16),old=state.tasks.find(r=>r.spec.id===id);
  if(old)return old.status==='pending'||old.status==='running'?id:null;
  const task:CoordTask={id,kind:'qualify',goal,capability:cap,dependsOn:[],priority:Math.min(100,priority),estimatedMs:240000,timeoutMs:1200000,why:'Current source qualification supports the linked finite observation consumer.'};
  addTasks(state,[task],d.now);added.push(task);return id;
 };
 const requestQualification=(consumer:CoordTask,account:string,status:any)=>{
  if(consumer.dependsOn.some(id=>{const r=state.tasks.find(r=>r.spec.id===id);return r?.spec.env?.PROGRESSION_ACCOUNT&&['pending','running'].includes(r.status);}))return;
  const q=d.qualificationFor?.(consumer,account,status);if(!q||q.kind!=='qualify'||q.capability!==consumer.capability||q.account!==account)return;
  const old=state.tasks.find(r=>r.spec.id===q.id);if(old){if(old.status==='pending'||old.status==='running'||old.status==='succeeded')depend(consumer,q.id);return;}
  addTasks(state,[q],d.now);added.push(q);depend(consumer,q.id);
 };
 function observe(consumer:CoordTask,account:string,status:any,bank=false){
  if(fresh(status,consumer)&&!bank)return true;
  const cap='owned-bank-observation',source=d.definition(cap).source;
  const matching=(t:CoordTask)=>(bank?boundedBankObserver:boundedSkillsObserver)(t,entryOf(t.capability!));
  if(bank&&freshBank(status)&&state.tasks.some(r=>r.status==='succeeded'&&matching(r.spec)&&r.spec.account?.toLowerCase()===normalized(account)&&r.runId===status?.coordinatorRunId&&r.spec.dependsOn.some(id=>state.tasks.find(q=>q.spec.id===id)?.receipt?.output?.delivery?.source===source)))return false;
  const existing=state.tasks.find(r=>['pending','running'].includes(r.status)&&r.spec.account?.toLowerCase()===normalized(account)&&matching(r.spec)&&(bank?r.spec.capability===cap:r.spec.dependsOn.some(id=>{const q=state.tasks.find(x=>x.spec.id===id);return q?.spec.capability===cap&&(!q.receipt||q.receipt.output?.delivery?.source===source);})));
  const id=existing?.spec.id??'progression-observe-'+normalized(account)+'-'+createHash('sha256').update(JSON.stringify([source,status?.at??0,bank])).digest('hex').slice(0,16);
  const old=state.tasks.find(r=>r.spec.id===id);if(old&&!['pending','running'].includes(old.status))return false;
  const observer:CoordTask=existing?.spec??{id,goal:consumer.goal,kind:'run',capability:cap,account,launch:'ordinary',dependsOn:[],priority:Math.min(100,consumer.priority+1),estimatedMs:30000,timeoutMs:120000,args:[],env:{REQUIRE_BANK:bank?'1':'0',LOOT_WATCH:'0',RANDOM_EVENTS:'0'},accept:bank?{counters:{bankObserved:1}}:{skills:{Hitpoints:1}},why:'Read current owned skills and location for '+consumer.id+' without travel or spending. Required bank data must come from the supported nearby entry; this is not acquired stock or game progress.'};
  // Validate the real same-account consumer before adding a qualifier or an observation.
  const candidate=structuredClone(state),row=candidate.tasks.find(r=>r.spec.id===consumer.id);
  if(!row)addTasks(candidate,[consumer],d.now);
  if(!candidate.tasks.some(r=>r.spec.id===id))addTasks(candidate,[observer],d.now);
  const target=candidate.tasks.find(r=>r.spec.id===consumer.id)!;target.spec.dependsOn=[...new Set([...target.spec.dependsOn,id])];
  if(goalWork(candidate,d.goals,d.statuses,d.now,{entryOf,loginAfter:d.loginAfter}).get(id)?.value!==.01)return false;
  const required=[...(bank?dependencies(consumer):consumer.dependsOn)].filter(id=>state.tasks.find(r=>r.spec.id===id)?.spec.kind==='qualify');
  const q=!existing||bank?qualification(cap,consumer.goal,consumer.priority+2):null;if((!existing||bank)&&!q)return false;
  if(!existing){observer.dependsOn=[...new Set([q!,...required])];addTasks(state,[observer],d.now);added.push(observer);}
  else if(bank)for(const id of [q!,...required])if(!dependencies(state.tasks.find(r=>r.spec.id===id)!.spec).has(observer.id))depend(observer,id);
  depend(consumer,id);return true;
 }
 // Resume the exact requested consumer only after its successful observer supplied fresh account state.
 for(const row of state.tasks.filter(r=>r.status==='pending'&&generatedObservationConsumer(r.spec))){
  if(deadRoots(state).has(row.spec.id))continue;
  const account=row.spec.account;if(!account||!eligible(account))continue;
  const status=statusOf(account);
  if(d.needsEntryObservation?.(row.spec,account,status)){
   clearBinding(row.spec);
   const qualifying=row.spec.dependsOn.some(id=>{const q=state.tasks.find(r=>r.spec.id===id);return q?.spec.env?.PROGRESSION_ACCOUNT&&['pending','running'].includes(q.status);});
   if(!qualifying)observe(row.spec,account,status,true);continue;
  }
  if(!fresh(status,row.spec)){
   clearBinding(row.spec);
   const qualifying=row.spec.dependsOn.some(id=>{const q=state.tasks.find(r=>r.spec.id===id);return q?.spec.kind==='qualify'&&q.spec.env?.PROGRESSION_ACCOUNT&&['pending','running'].includes(q.status);});
   if(!qualifying)observe(row.spec,account,status);continue;
  }
  const ready=d.prepare(structuredClone(row.spec),account,status);
  if(ready&&ready.id===row.spec.id&&ready.account===account&&ready.capability===row.spec.capability&&ready.dependsOn.every(id=>row.spec.dependsOn.includes(id))){if(JSON.stringify(ready)!==JSON.stringify(row.spec)){row.spec=ready;prepared.push(row.spec.id);}}
  else{clearBinding(row.spec);requestQualification(row.spec,account,status);}
 }
 const durable:FleetProgressionRequest[]=state.tasks.filter(r=>r.status==='succeeded'&&generatedObservationConsumer(r.spec)&&r.receipt?.ok&&r.receipt.output?.evidence==='live').flatMap(r=>{try{const consumer=JSON.parse(r.spec.env?.PROGRESSION_REQUEST??'null');return consumer?[{account:r.spec.account!,action:'observe',method:'continuation',reason:'Accepted finite band retains its original selected consumer.',consumer}]:[];}catch{return[];}});
 for(const request of [...requests,...durable]){
  if(!['observe','qualify','measure'].includes(request.action)||!request.consumer||!eligible(request.account))continue;
  const {work,accept}=request.consumer;
  if(!work||typeof work.script!=='string'||!Array.isArray(work.args)||work.args.some(a=>typeof a!=='string')||!work.env||Object.values(work.env).some(v=>typeof v!=='string')||!accept||Object.keys(accept.skills??{}).length!==1)continue;
  const target=Object.values(accept.skills!)[0];if(typeof target!=='number'||!Number.isSafeInteger(target)||target<2||target>99)continue;
  const cap=d.capabilityFor(work.script);if(!cap||!reviewApproved(state,cap))continue;
  const family=createHash('sha256').update(JSON.stringify(canonical([normalized(request.account),work,accept]))).digest('hex').slice(0,20),prefix=OBSERVATION_CONSUMER_PREFIX+family+'-';
  const familyRows=state.tasks.filter(r=>r.spec.id.startsWith(prefix));
  if(familyRows.some(r=>r.status==='failed')||familyRows.some(r=>r.status==='pending'||r.status==='running'))continue;
  // Another finite owner always wins over this standing planner request.
  if(state.tasks.some(r=>['pending','running'].includes(r.status)&&(boundAccounts(r.spec,state)??[]).some(n=>normalized(n)===normalized(request.account))&&!boundedSkillsObserver(r.spec,entryOf(r.spec.capability!))&&!boundedBankObserver(r.spec,entryOf(r.spec.capability!))))continue;
  const status=statusOf(request.account),id=prefix+(status?.at??0);
  const [skill,goal]=Object.entries(accept.skills!)[0]!,reached=status?.skills?.find((s:any)=>normalized(s.name??'')===normalized(skill))?.level;if(Number.isFinite(reached)&&reached>=goal)continue;
  if(state.tasks.some(r=>r.spec.id===id))continue;
  const consumer:CoordTask={id,goal:'skills',kind:'run',capability:cap,account:request.account,launch:'ordinary',dependsOn:[],priority:45,estimatedMs:240000,timeoutMs:1200000,args:[...work.args],env:{...work.env,LOOT_WATCH:'0',RANDOM_EVENTS:'0'},accept:structuredClone(accept),why:'Selected finite progression consumer from '+d.side+': '+JSON.stringify(accept)+'. The original selected work remains held until fresh observations and an exact qualified finite band fit its budget. No automatic retry follows a failed consumer.'};
  // Never copy a stale method/source assertion from a standing assignment.
  delete consumer.env!.PROGRESSION_METHOD;delete consumer.env!.PROGRESSION_SOURCE;consumer.env!.PROGRESSION_REQUEST=JSON.stringify(request.consumer);
  if(fresh(status,consumer)){const candidate=structuredClone(state);addTasks(candidate,[consumer],d.now);const value=goalWork(candidate,d.goals,d.statuses,d.now,{entryOf,loginAfter:d.loginAfter}).get(id)?.value;if(!(typeof value==='number'&&value>0))continue;}
  if(!observe(consumer,request.account,status,d.needsEntryObservation?.(consumer,request.account,status)??false))continue;
  const q=qualification(cap,consumer.goal,consumer.priority+1);if(!q)continue;consumer.dependsOn.push(q);
  if(fresh(status,consumer)){const ready=d.prepare(consumer,request.account,status);if(ready)Object.assign(consumer,ready);else requestQualification(consumer,request.account,status);}
  addTasks(state,[consumer],d.now);added.push(consumer);
 }
 // Authored useful consumers keep their exact work and receive only a prerequisite edge.
 const dead=deadRoots(state);
 for(const row of state.tasks.filter(r=>r.status==='pending'&&r.spec.kind==='run'&&!generatedObservationConsumer(r.spec)&&!r.spec.sessionRecovery&&!dead.has(r.spec.id))){
  const t=row.spec,names=boundAccounts(t,state),skills=Object.keys(t.accept?.skills??{}).length===1,bank=!skills&&Object.keys(t.accept?.bank??{}).length>0;
  if(t.launch&&t.launch!=='ordinary'||names?.length!==1||!eligible(names[0]!)||!skills&&!bank)continue;
  if(entryOf(t.capability!)==='scripts/aio-logistics.ts'&&(!t.args?.length||t.args[0]==='inspect'))continue;
  observe(t,names[0]!,statusOf(names[0]!),bank);
 }
 return{added,linked:[...new Set(linked)],prepared,invalidated:[...new Set(invalidated)]};
}
