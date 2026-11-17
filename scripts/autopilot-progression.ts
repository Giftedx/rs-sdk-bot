import type {Acct,Assignment,Template} from '../packages/planner/src/autopilot';
import {jobResources} from '../packages/planner/src/autopilot';
import {accountFromStatus,intentForEntry,loadProgressionCatalog,progressionStep,type CatalogAccept,type ProgressionCatalog} from '../packages/planner/src/progression-catalog';
import {evaluateProgressionWork} from '../packages/core/src/progression-session';
import {methodSupportsWork,type PolicyEvaluation,type WorkDescriptor} from '../packages/core/src/progression-policy';
import {selectProgressionFleet,type FleetProgressionOptions,type FleetProgressionResult} from '../packages/planner/src/progression-fleet';
import type {ObservedAccount,ProgressionMethod,WorkIntent} from '../packages/planner/src/progression';
import {levelForXp} from '../packages/planner/src/curve';

const key=(name:string)=>name.toLowerCase();
const entry=(file:string)=>file.replace(/\\/g,'/').replace(/^.*?\/(scripts|packages)\//,'$1/');
const workFor=(t:Template):WorkDescriptor=>({script:t.script,args:t.args??[],env:t.env??{}});
const held=(set:ReadonlySet<string>|undefined,name:string)=>!!set&&[...set].some(n=>key(n)===key(name));
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([name,v])=>[name,canonical(v)])):value;

export interface AutopilotProgressionOptions{
 now:number;observed:(account:string)=>any;catalog?:ProgressionCatalog;
 itemId:(name:string)=>number|undefined;itemName:(id:number)=>string|undefined;
 builds?:ReadonlyMap<string,Readonly<Record<string,number>>>;
 busy?:ReadonlySet<string>;paused?:ReadonlySet<string>;protected?:ReadonlySet<string>;
 jobs?:readonly any[];assignedAt?:ReadonlyMap<string,number>;
 taken?:Readonly<Record<string,number>>;capacity?:Readonly<Record<string,number>>;
 stocks?:FleetProgressionOptions['stocks'];sourcesFor?:FleetProgressionOptions['sourcesFor'];
 canTransfer?:(from:string,to:string)=>boolean;
 evaluate?:typeof evaluateProgressionWork;
}
interface AccountEvaluation{account:string;work:WorkDescriptor;accept?:CatalogAccept;intent:WorkIntent|null;evaluation:PolicyEvaluation;reason?:string}

/** Telemetry can narrow a claim only while the same source-bound session is active. */
export function executingProgressionMethod(job:any,status:any,now:number):string|undefined{
 const source=job?.env?.PROGRESSION_SOURCE??job?.env?.WORKER_RELEASE;
 let consumer:unknown=null;try{if(job?.env?.PROGRESSION_CONSUMER)consumer=JSON.parse(job.env.PROGRESSION_CONSUMER);}catch{return;}
 if(job?.enabled===false||typeof job?.account!=='string'||typeof job?.script!=='string'||typeof source!=='string'||!source
  ||status?.name?.toLowerCase()!==job.account.toLowerCase()||status.practice||status.server!=='rs-sdk-demo.fly.dev'||status.result
  ||!Number.isFinite(status.at)||status.at<=0||status.at>now||now-status.at>300000
  ||!Number.isFinite(status.started)||status.started<=0||status.started>status.at
  ||Number.isFinite(job.assignedAt)&&status.started<job.assignedAt
  ||typeof status.sessionAttemptId!=='string'||!status.sessionAttemptId
  ||job.sessionAttemptId&&status.sessionAttemptId!==job.sessionAttemptId
  ||typeof status.workEntry!=='string'||!status.workEntry.split(',').some((file:string)=>entry(file)===entry(job.script))
  ||status.workRevision!==source
  ||status.progression?.source!==source
  ||(status.progression?.boundMethod??null)!==(job.env?.PROGRESSION_METHOD??null)
  ||JSON.stringify(canonical(status.progression?.consumer??null))!==JSON.stringify(canonical(consumer))
  ||job.env?.COORDINATOR_RUN_ID&&status.coordinatorRunId!==job.env.COORDINATOR_RUN_ID)return;
 const method=status.progression?.executing;
 return typeof method==='string'&&method?method:undefined;
}

function acceptFor(t:Template,o:AutopilotProgressionOptions,c:ProgressionCatalog,status:any):CatalogAccept|undefined{
 if(t.stock){const id=o.itemId(t.stock.item);if(id)return{bank:{[id]:t.stock.to}};}
 if(t.quest)return{quests:[t.quest.name]};
 if(t.production){
  const id=o.itemId(t.production.output);if(!id)return;
  const a=accountFromStatus(status?.name??'',status,o.now),held=[a.inventory,a.equipment,a.bank].reduce((sum,container)=>sum+(container?.value[id]??0),0);
  return{bank:{[id]:held+t.production.maximum*t.production.outputPerUnit}};
 }
 const intent=intentForEntry(t.script,t.args??[],t.env??{},undefined,c);
 // A supply template may carry a skill stop condition. Its finite shop/order
 // remains the consumer instead of becoming an unrelated training assignment.
 if(intent&&(intent.kind==='acquire'||intent.kind==='produce'))return{bank:intent.items};
 if(intent&&intent.kind!=='train')return;
 if(t.trains)return{skills:{[t.trains.skill]:t.trains.to}};
 if(intent?.kind==='train')return{skills:{[intent.skill]:intent.targetLevel}};
}
function boundedAccept(accept:CatalogAccept|undefined,account:string,o:AutopilotProgressionOptions):CatalogAccept|undefined{
 if(!accept?.skills)return accept;
 const caps=o.builds?.get(key(account)),skills=Object.fromEntries(Object.entries(accept.skills).map(([skill,target])=>{
  const cap=Object.entries(caps??{}).find(([name])=>key(name)===key(skill))?.[1];return[skill,Math.min(target,cap??target)];
 }));return{...accept,skills};
}
function asConsumer(intent:WorkIntent|null,accept:CatalogAccept|undefined):CatalogAccept|undefined{
 if(accept)return accept;if(!intent)return;
 if(intent.kind==='train')return{skills:{[intent.skill]:intent.targetLevel}};
 if(intent.kind==='quest')return{quests:[intent.quest]};
 if(intent.kind==='produce'||intent.kind==='acquire')return{bank:intent.items};
}
function bind(t:Template,method:ProgressionMethod,intent:WorkIntent|null,accept?:CatalogAccept):Template{
 const consumer=asConsumer(intent,accept);
 return{...t,env:{...t.env,PROGRESSION_METHOD:method.id,PROGRESSION_SOURCE:method.source,...consumer?{PROGRESSION_CONSUMER:JSON.stringify(consumer)}:{}},
  resources:entry(t.script)==='scripts/ranged-train.ts'?jobResources({script:t.script,args:t.args,env:{...t.env,PROGRESSION_METHOD:method.id},resources:t.resources}):t.resources};
}
function declareConsumer(t:Template,intent:WorkIntent|null,accept?:CatalogAccept):Template{
 const consumer=asConsumer(intent,accept);if(!consumer)return t;
 const encoded=JSON.stringify(consumer);if(t.env?.PROGRESSION_CONSUMER===encoded)return t;
 return{...t,env:{...t.env,PROGRESSION_CONSUMER:encoded}};
}

/** Keep the existing allocator and orders; compare only their actual finite consumers. */
export function createAutopilotProgression(o:AutopilotProgressionOptions){
 const c=o.catalog??loadProgressionCatalog(),cache=new Map<string,AccountEvaluation>();
 const blocked=(account:string)=>held(o.busy,account)||held(o.paused,account)||held(o.protected,account);
 function evaluation(t:Template,name:string):AccountEvaluation{
  const work=workFor(t),status=o.observed(name);
  let accept:CatalogAccept|undefined,acceptFailure:string|undefined;
  try{accept=boundedAccept(acceptFor(t,o,c,status),name,o);}catch(error){acceptFailure=String(error);}
  const cacheKey=JSON.stringify([key(name),{...work,env:Object.fromEntries(Object.entries(work.env).filter(([name])=>!/^PROGRESSION_(METHOD|SOURCE|CONSUMER)$/.test(name)))},accept]);
  const previous=cache.get(cacheKey);if(previous)return previous;
  let result:AccountEvaluation;
  try{
   if(acceptFailure)throw Error(acceptFailure);
   if(t.stock&&!o.itemId(t.stock.item)||t.production&&!o.itemId(t.production.output))throw Error('finite consumer requires an exact native item identity');
   if(status?.name?.toLowerCase()!==key(name))throw Error('missing account-bound observation');
   const caps=o.builds?.get(key(name)),observed=caps?{...status,build:{maxLevels:{...caps}}}:status;
   const evaluated=(o.evaluate??evaluateProgressionWork)(work,observed,{now:o.now,catalog:c,accept,requireQualification:true});
   const account=evaluated.account??accountFromStatus(name,observed,o.now);if(caps)account.build={maxLevels:{...caps}};
   result={account:name,work,accept,intent:evaluated.intent,evaluation:{...evaluated,account}};
  }catch(error){result={account:name,work,accept,intent:null,evaluation:{supported:true,intent:null,decision:null},reason:String(error)};}
  cache.set(cacheKey,result);return result;
 }
 function activeMethod(t:Template,name:string,r:AccountEvaluation):{job:any;method:string}|undefined{
  const job=o.jobs?.find(j=>j?.account?.toLowerCase()===key(name)&&j.template===t.id);if(!job)return;
  const method=executingProgressionMethod({...job,assignedAt:o.assignedAt?.get(key(name))},o.observed(name),o.now);
  if(!method||job.env?.PROGRESSION_METHOD!==method||entry(job.script)!==entry(t.script))return;
  let consumer:unknown;try{consumer=JSON.parse(job.env.PROGRESSION_CONSUMER??'null');}catch{return;}
  if(JSON.stringify(canonical(consumer))!==JSON.stringify(canonical(asConsumer(r.intent,r.accept)??null)))return;
  return{job,method};
 }
 function selectedBound(t:Template,name:string):Template{
  if(blocked(name))return t;
  const r=evaluation(t,name),active=activeMethod(t,name,r);
  // This is the existing live mission, not a new admission from its depleted
  // snapshot. The immutable source/method/consumer echo must still match.
  if(active)return{...t,args:[...(active.job.args??[])],env:{...active.job.env},resources:jobResources(active.job)};
  const d=r.evaluation.decision,m=r.evaluation.methods?.find(m=>m.id===d?.selected);
  if(d?.state!=='execute'||!m||!methodSupportsWork(m.step,r.work))return declareConsumer(t,r.intent,r.accept);
  // requireQualification=true is evaluated on this fresh observation. The
  // current finite worker may be bound even when its rate remains a model.
  if(!m.qualification||m.qualification.source!==m.source)return declareConsumer(t,r.intent,r.accept);
  return bind(t,m,r.intent,r.accept);
 }
 function refine(baseline:readonly Assignment[]):FleetProgressionResult{
  const prepared=baseline.map(a=>{
   if(!a.template||a.fund||a.send||blocked(a.account))return a;
   const t=selectedBound(a.template,a.account);return t===a.template?a:{...a,template:t,resources:entry(t.script)==='scripts/ranged-train.ts'?t.resources??a.resources:a.resources};
  });
  const accounts:ObservedAccount[]=[],intents=new Map<string,WorkIntent>(),currentMethods=new Map<string,string>(),byAccount=new Map<string,AccountEvaluation>();
  for(const a of prepared){if(!a.template||a.fund||a.send||blocked(a.account))continue;
   const r=evaluation(a.template,a.account),account=r.evaluation.account;byAccount.set(key(a.account),r);if(!account||!r.intent)continue;
   accounts.push(account);intents.set(key(a.account),r.intent);
   const job=o.jobs?.find(j=>j?.account?.toLowerCase()===key(a.account)),executing=job&&executingProgressionMethod({...job,assignedAt:o.assignedAt?.get(key(a.account))},o.observed(a.account),o.now);
   const exact=r.evaluation.methods?.find(m=>m.id===(executing??a.template!.env?.PROGRESSION_METHOD))
    ??r.evaluation.methods?.find(m=>methodSupportsWork(m.step,r.work));
   if(exact)currentMethods.set(key(a.account),exact.id);
  }
  const methods=(_intent:WorkIntent,account:ObservedAccount)=>byAccount.get(key(account.account))?.evaluation.methods??[];
  const result=selectProgressionFleet({baseline:prepared,accounts,intents,methods,currentMethods,now:o.now,busy:o.busy,paused:o.paused,protected:o.protected,
   taken:o.taken,capacity:o.capacity,stocks:o.stocks,sourcesFor:o.sourcesFor,
   switchingTicks:(assignment,method)=>{const r=byAccount.get(key(assignment.account)),active=r&&assignment.template?activeMethod(assignment.template,assignment.account,r):undefined;return active&&active.method!==method.id?null:0;},
   resourcesFor:m=>jobResources({script:m.step.script,args:m.step.args,env:{...m.step.env,PROGRESSION_METHOD:m.id}}),
   stepFor:(m,units,intent,account)=>{
    const gain=intent.kind==='train'?Object.entries(m.effects.xp??{}).find(([name])=>key(name)===key(intent.skill))?.[1]??0:0;
    const from=intent.kind==='train'?Object.entries(account.skills).find(([name])=>key(name)===key(intent.skill))?.[1].xp??0:0;
    const boundary=intent.kind==='train'&&gain>0?{...intent,targetLevel:Math.min(intent.targetLevel,levelForXp(from+units*gain))}:intent;
    return progressionStep(m,units,boundary,account,c);
   }});
  result.assignments=result.assignments.map(a=>{
   const change=result.changes.find(x=>key(x.account)===key(a.account)),r=byAccount.get(key(a.account));
   if(a.template&&entry(a.template.script)==='scripts/ranged-train.ts'&&!(r&&activeMethod(a.template,a.account,r))&&result.requests.some(q=>key(q.account)===key(a.account)&&['observe','qualify','measure'].includes(q.action)&&Object.keys(q.consumer?.accept.skills??{}).length===1))return{...a,template:undefined,resources:[],reason:'Owned observation or qualification required for the selected finite consumer; coordinator request retained.'};
   if(change?.ready&&a.template){const m=r?.evaluation.methods?.find(m=>m.id===change.method);if(m){const t=bind({...a.template,resources:a.resources,repeats:false},m,r!.intent,r!.accept);return{...a,template:t,resources:t.resources??a.resources};}}
   if(!change||change.ready||!a.template)return a;
   const transfers=result.requests.filter(q=>key(q.account)===key(a.account)&&q.method===change.method&&q.action==='transfer'&&q.holder&&q.item&&q.count);
   // The existing layer starts one finite order at a time. Both parties must
   // already be free, and a projected stack never starts the training worker.
   const request=transfers.find(q=>o.canTransfer?.(q.holder!,a.account)&&!!o.itemName(q.item!));
   return request?{...a,send:{from:request.holder!,to:a.account,item:o.itemName(request.item!)!,count:request.count!,template:a.template.id}}:a;
  });
  for(const a of prepared){if(!a.template)continue;const r=byAccount.get(key(a.account));if(r?.reason)result.gaps.push(a.account+': '+r.reason);}
  return result;
 }
 return{templateFor:(t:Template,account:Acct)=>entry(t.script)==='scripts/ranged-train.ts'?selectedBound(t,account.name):t,refine,
  decisions:()=>[...cache.values()].map(r=>({account:r.account,entry:r.work.script,accept:r.accept,intent:r.intent,decision:r.evaluation.decision,reason:r.reason??r.evaluation.reason??null}))};
}
