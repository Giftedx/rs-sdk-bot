import type {CoordTask,Effect} from './coordinator';
import type {Step} from '../../core/src/chain-step';
import type {ObservedAccount,ProgressionMethod,ProgressionDecision,StateBand,WorkIntent} from '../../planner/src/progression';
import type {ProgressionCatalog} from '../../planner/src/progression-catalog';
import {accountFromStatus,intentForEntry,progressionMethods,progressionStep} from '../../planner/src/progression-catalog';
import {chooseProgression} from '../../planner/src/progression';
import {methodSupportsWork} from '../../core/src/progression-policy';
import {levelForXp} from '../../planner/src/curve';
export interface CoordinatorMethodBinding{capability:string;methodId:string;source:string;qualification:{source:string;bands:StateBand[]};reviewed:boolean}
export interface CoordinatorProgressionOptions{
 task:CoordTask;entry:string;status:any;now:number;catalog?:ProgressionCatalog;
 observed?:ObservedAccount;
 methods?:(intent:WorkIntent,account:ObservedAccount)=>readonly ProgressionMethod[];
 bindingFor?:(method:ProgressionMethod,account:ObservedAccount)=>CoordinatorMethodBinding|null;
 paused?:boolean;protected?:boolean;maxAgeMs?:number;
}
export interface CoordinatorProgressionResult{
 action:'continue'|'handoff'|'measure'|'observe'|'complete'|'blocked';intent:WorkIntent|null;step:Step|null;
 capability:string|null;decision:ProgressionDecision|null;stepAccept:Effect|null;consumer:Effect|null;
 requests:{method:string;action:string;reason:string}[];reason:string;
 route?:{capability:string;step:Step;accept:Effect}[];
}
const key=(s:string)=>s.trim().toLowerCase();
function immediateAcceptance(method:ProgressionMethod,units:number,account:ObservedAccount,task:CoordTask,now:number,maxAgeMs:number):Effect|null{
 if(method.effects.quests?.length)return{quests:[...method.effects.quests]};
 if(Object.keys(method.effects.items??{}).length){
  const bank:Record<string,number>={};
  for(const [id,n]of Object.entries(method.effects.items??{})){
   const owned=[account.inventory,account.equipment,account.bank].reduce((sum,o)=>sum+(o&&o.at>0&&o.at<=now&&now-o.at<=maxAgeMs?(o.value[Number(id)]??0):0),0);
   bank[id]=Math.ceil(owned+n*units-(method.inputs?.[Number(id)]??0)*units);
  }
  return Object.values(bank).some(n=>n<=0)?null:{bank};
 }
 const skills:Record<string,number>={};
 for(const [skill,xp]of Object.entries(method.effects.xp??{})){
  const observed=Object.entries(account.skills).find(([name])=>key(name)===key(skill));if(!observed)continue;
  const level=levelForXp(observed[1].xp+xp*units);if(level<=observed[1].level)continue;
  const name=Object.keys(task.accept?.skills??{}).find(name=>key(name)===key(skill))??observed[0];skills[name]=level;
 }
 return Object.keys(skills).length?{skills}:null;
}
/** Decide a finite chain's next worker without granting source qualification or account ownership. */
export function evaluateCoordinatorProgression(o:CoordinatorProgressionOptions):CoordinatorProgressionResult{
 const base:CoordinatorProgressionResult={action:'blocked',intent:null,step:null,capability:null,decision:null,stepAccept:null,consumer:o.task.accept??null,requests:[],reason:'No exact finite progression consumer is mapped.'};
 if(o.paused||o.protected||o.task.launch==='main'||o.task.launch==='specialist'||o.task.participants?.length)return {...base,reason:'The account or composed/scored assignment keeps its existing owner.'};
 if(o.task.kind!=='run')return {...base,reason:'Only a finite gameplay run has a progression continuation.'};
 const accept=o.task.accept,dimensions=[Object.keys(accept?.skills??{}).length>0,Object.keys(accept?.bank??{}).length>0,!!accept?.quests?.length,Object.keys(accept?.counters??{}).length>0].filter(Boolean).length;
 if(dimensions>1||Object.keys(accept?.skills??{}).length>1||((accept?.quests?.length??0)>1)||Object.keys(accept?.counters??{}).length)return {...base,reason:'An authored multi-goal consumer needs an exact compound route; it is not rewritten as a single trainer.'};
 const intent=intentForEntry(o.entry,o.task.args??[],o.task.env??{},accept,o.catalog);
 if(!intent)return base;
 base.intent=intent;
 const account=o.observed??accountFromStatus(o.task.account??o.status?.name??'unknown',o.status,o.now),requests:CoordinatorProgressionResult['requests']=[];
 let listed:readonly ProgressionMethod[];
 try{listed=o.methods?.(intent,account)??progressionMethods(intent,account,o.catalog,{now:o.now}).methods;}
 catch(error){return {...base,action:'measure',reason:'Progression route discovery requires repair: '+String(error)};}
 const bindings=new Map<string,CoordinatorMethodBinding>();
 const methods=listed.map(method=>{
  const binding=o.bindingFor?.(method,account),{qualification:_unbound,...withoutProof}=method;
  if(!binding||binding.methodId!==method.id||!binding.capability||!binding.reviewed||binding.source!==binding.qualification.source||!binding.qualification.bands.length){
   requests.push({method:method.id,action:binding&&!binding.reviewed?'review':'qualify',reason:'This exact method needs an existing reviewed capability and matching source/state-band qualification.'});return withoutProof;
  }
  bindings.set(method.id,binding);return {...withoutProof,source:binding.source,qualification:binding.qualification};
 });
 const work={script:o.entry,args:o.task.args??[],env:o.task.env??{}},current=methods.find(m=>methodSupportsWork(m.step,work));
 const decision=chooseProgression(intent,account,methods,{now:o.now,maxAgeMs:o.maxAgeMs,requireQualification:true,currentMethod:current?.id,maxSearchNodes:256,maxDepth:6});
 base.decision=decision;
 requests.push(...decision.followUps.map(f=>({method:f.method,action:f.state,reason:f.reason.join('; ')})));
 base.requests=[...new Map(requests.map(r=>[JSON.stringify(r),r])).values()];
 if(decision.state==='complete')return {...base,action:'complete',reason:decision.reason};
 if(decision.state!=='execute'||!decision.selected||!decision.path[0])return {...base,action:decision.state==='observe'?'observe':'measure',reason:decision.reason};
 const first=methods.find(m=>m.id===decision.selected),binding=bindings.get(decision.selected);
 if(!first||!binding)return {...base,action:'measure',reason:'Selected route has no exact existing-capability binding.'};
 const route:NonNullable<CoordinatorProgressionResult['route']>=[];
 let projected:ObservedAccount={...account,skills:{...account.skills}};
 for(const segment of decision.path){
  const method=methods.find(m=>m.id===segment.method),mapped=bindings.get(segment.method);if(!method||!mapped)return {...base,action:'measure',reason:'Every finite path step needs its own exact capability binding.'};
  const accept=immediateAcceptance(method,segment.units,projected,o.task,o.now,o.maxAgeMs??300000);
  if(!accept)return {...base,action:'measure',reason:'The selected immediate step needs a finite acceptance adapter before continuation.'};
  let stepIntent:WorkIntent=intent;
  if(intent.kind==='train'){
   const target=Object.entries(accept.skills??{}).find(([skill])=>key(skill)===key(intent.skill));
   if(target)stepIntent={kind:'train',skill:target[0],targetLevel:target[1]};
  }
  const step=progressionStep(method,segment.units,stepIntent,projected,o.catalog);
  route.push({capability:mapped.capability,step,accept});
  const skills={...projected.skills};for(const [skill,gain]of Object.entries(method.effects.xp??{})){
   const name=Object.keys(skills).find(name=>key(name)===key(skill))??skill,xp=(skills[name]?.xp??0)+gain*segment.units;skills[name]={xp,level:levelForXp(xp)};
  }
  const stock:Record<number,number>={};for(const container of [projected.inventory,projected.equipment,projected.bank])if(container&&container.at>0&&container.at<=o.now&&o.now-container.at<=(o.maxAgeMs??300000))for(const [id,n]of Object.entries(container.value))stock[Number(id)]=(stock[Number(id)]??0)+n;
  for(const [id,n]of Object.entries(segment.inputs))stock[Number(id)]=Math.max(0,(stock[Number(id)]??0)-n);
  for(const [id,n]of Object.entries(method.effects.items??{}))stock[Number(id)]=(stock[Number(id)]??0)+n*segment.units;
  projected={...projected,skills,inventory:{at:o.now,value:{}},equipment:{at:o.now,value:{}},bank:{at:o.now,value:stock,source:'planned finite effects'},quests:{at:o.now,value:{...projected.quests?.value,...Object.fromEntries((method.effects.quests??[]).map(q=>[key(q),true]))}}};
 }
 const {step,accept:stepAccept}=route[0]!;
 const supported=methodSupportsWork(step,work)&&binding.capability===o.task.capability;
 return {...base,action:supported?'continue':'handoff',step,stepAccept,route,capability:binding.capability,
  reason:supported?'The next finite band uses the supported current method.':'The selected finite step maps to an existing qualified capability; retain its original consumer chain.'};
}
