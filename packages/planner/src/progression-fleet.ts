import type {Assignment} from './autopilot';
import {chooseProgression,type ObservedAccount,type ProgressionMethod,type ProgressionDecision,type SelectionContext,type WorkIntent} from './progression';
import type {Step} from '../../core/src/chain-step';
import type {CatalogAccept} from './progression-catalog';

export interface FleetProgressionStock{holder:string;at:number;items:Record<number,number>;reservations?:Record<number,number>;delivery?:{ticks:number|null;basis:'measured'|'model';source:string;evidence:string}}
export interface FleetProgressionSupport{helper:string;opportunityTicks:number|null;deliveryTicks:number|null;resources?:string[]}
export interface FleetProgressionReservation{holder:string;consumer:string;item:number;count:number}
export interface FleetProgressionChange{account:string;from:string;method:string;intent:WorkIntent;step:Step;decision:ProgressionDecision;savedTicks:number;finishTicks:number;reservations:FleetProgressionReservation[];ready:boolean}
export interface FleetProgressionOptions{
 baseline:readonly Assignment[];accounts:readonly ObservedAccount[];intents:ReadonlyMap<string,WorkIntent>;
 methods:(intent:WorkIntent,account:ObservedAccount)=>readonly ProgressionMethod[];now:number;
 currentMethods?:ReadonlyMap<string,string>;busy?:ReadonlySet<string>;paused?:ReadonlySet<string>;protected?:ReadonlySet<string>;
 taken?:Readonly<Record<string,number>>;capacity?:Readonly<Record<string,number>>;
 resourcesFor?:(method:ProgressionMethod,account:ObservedAccount)=>readonly string[];
 switchingTicks?:(assignment:Assignment,method:ProgressionMethod,account:ObservedAccount)=>number|null;
 supportFor?:(method:ProgressionMethod,account:ObservedAccount)=>readonly FleetProgressionSupport[];
 stocks?:readonly FleetProgressionStock[];sourcesFor?:(account:string,method:string,item:number)=>readonly string[];
 stepFor?:(method:ProgressionMethod,units:number,intent:WorkIntent,account:ObservedAccount)=>Step;
 context?:Omit<SelectionContext,'now'|'requireQualification'>;maxCombinations?:number;maxCandidates?:number;
}
export interface FleetProgressionRequest{account:string;method:string;action:string;reason:string;holder?:string;item?:number;count?:number;consumer?:{work:Step;accept:CatalogAccept}}
export interface FleetProgressionResult{assignments:Assignment[];changes:FleetProgressionChange[];reservations:FleetProgressionReservation[];requests:FleetProgressionRequest[];gaps:string[];search:{visited:number;bound:number;exhausted:boolean}}
const key=(s:string)=>s.toLowerCase();
const valid=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const get=<T>(map:ReadonlyMap<string,T>|undefined,name:string)=>map?.get(key(name))??map?.get(name)??[...(map??[])].find(([k])=>key(k)===key(name))?.[1];
const has=(set:ReadonlySet<string>|undefined,name:string)=>!!set&&[...set].some(n=>key(n)===key(name));
type Choice={assignment:Assignment;account:ObservedAccount|null;intent:WorkIntent|null;methods:readonly ProgressionMethod[];decision:ProgressionDecision|null;method:string;step:Step|null;saving:number;finish:number;resources:string[];needs:Record<number,number>;support:readonly FleetProgressionSupport[];baseline:boolean};
function initialNeeds(decision:ProgressionDecision,methods:readonly ProgressionMethod[]):Record<number,number>{
 const net:Record<number,number>={},need:Record<number,number>={};
 for(const step of decision.path){
  const method=methods.find(m=>m.id===step.method);if(!method)continue;
  for(const [id,n]of Object.entries(method.requirements?.items??{}))need[Number(id)]=Math.max(need[Number(id)]??0,(net[Number(id)]??0)+n);
  for(const [id,n]of Object.entries(step.inputs)){net[Number(id)]=(net[Number(id)]??0)+n;need[Number(id)]=Math.max(need[Number(id)]??0,net[Number(id)]!);}
  for(const [id,n]of Object.entries(method.effects.items??{}))net[Number(id)]=(net[Number(id)]??0)-n*step.units;
 }
 return Object.fromEntries(Object.entries(need).filter(([,n])=>n>0));
}
/** Refine an existing allocation only when matched measured finite routes justify the complete change. */
export function selectProgressionFleet(o:FleetProgressionOptions):FleetProgressionResult{
 const bound=Math.max(1,Math.min(10000,Math.floor(o.maxCombinations??256))),requests:FleetProgressionRequest[]=[],requestedConsumers=new Set<string>(),gaps=['Fleet comparison is bounded and covers supplied finite intents and measured candidates only.'];
 const held=(name:string)=>has(o.busy,name)||has(o.paused,name)||has(o.protected,name);
 const accounts=new Map(o.accounts.map(a=>[key(a.account),a]));
 const fresh=(at:number)=>at>0&&at<=o.now&&o.now-at<=(o.context?.maxAgeMs??300000);
 const stock=new Map<string,FleetProgressionStock>();
 for(const a of o.accounts){const items:Record<number,number>={};for(const observation of [a.inventory,a.equipment,a.bank])if(observation&&fresh(observation.at))for(const [id,n]of Object.entries(observation.value))if(valid(n))items[Number(id)]=(items[Number(id)]??0)+n;
  stock.set(key(a.account),{holder:a.account,at:a.at,items,reservations:a.reservations});}
 for(const s of o.stocks??[])if(fresh(s.at))stock.set(key(s.holder),s);
 const sources=(a:string,m:string,id:number)=>[...(o.sourcesFor?.(a,m,id)??[a])].map(key).filter((s,i,all)=>all.indexOf(s)===i&&(s===key(a)||!held(s)));
 const available=(s:FleetProgressionStock,id:number)=>Math.max(0,(s.items[id]??0)-(s.reservations?.[id]??0));
 const groups:Choice[][]=[];
 for(const assignment of o.baseline){
  const a=accounts.get(key(assignment.account))??null,intent=get(o.intents,assignment.account)??null;
  const baseline:Choice={assignment,account:a,intent,methods:[],decision:null,method:get(o.currentMethods,assignment.account)??'',step:null,saving:0,finish:0,resources:[...assignment.resources],needs:{},support:[],baseline:true};
  const group=[baseline];groups.push(group);
  if(!a||!intent||!assignment.template||assignment.fund||assignment.send||a.clock?.protected||held(a.account))continue;
  const methods=o.methods(intent,a);baseline.methods=methods;
  const current=methods.find(m=>m.id===baseline.method)??methods.find(m=>m.step.script===assignment.template!.script&&JSON.stringify(m.step.args)===JSON.stringify(assignment.template!.args??[])&&Object.entries(m.step.env).every(([name,value])=>assignment.template!.env?.[name]===value));
  if(!current){requestedConsumers.add(key(a.account));requests.push({account:a.account,method:baseline.method||assignment.template.id,action:'measure',reason:'The existing finite assignment has no source/state-matched measured route for comparison.'});continue;}
  baseline.method=current.id;
  const context={...o.context,now:o.now,requireQualification:true};
  const currentDecision=chooseProgression(intent,a,[current],context);
  if(currentDecision.state==='observe'&&currentDecision.reason==='Fresh valid account skill observations are required.'){
   const accept:CatalogAccept|undefined=intent.kind==='train'?{skills:{[assignment.template.trains?.skill??intent.skill[0]!.toUpperCase()+intent.skill.slice(1)]:intent.targetLevel}}:intent.kind==='quest'?{quests:[intent.quest]}:intent.kind==='produce'||intent.kind==='acquire'?{bank:intent.items}:undefined;
   if(accept)requests.push({account:a.account,method:current.id,action:'observe',reason:currentDecision.reason,consumer:{work:{script:assignment.template.script,args:[...(assignment.template.args??[])],env:{...assignment.template.env}},accept}});
   continue;
  }
  if(currentDecision.state!=='execute'||currentDecision.basis!=='measured'||currentDecision.expectedTicks===null){
   requestedConsumers.add(key(a.account));
   requests.push({account:a.account,method:current.id,action:'measure',reason:'Baseline full finish time is not measured and qualified for this account state.'});
   for(const f of currentDecision.followUps)requests.push({account:a.account,method:f.method,action:f.state,reason:f.reason.join('; ')});continue;
  }
  baseline.decision=currentDecision;baseline.finish=currentDecision.expectedTicks;baseline.needs=initialNeeds(currentDecision,methods);
  let remaining=[...methods];
  for(let n=0;n<Math.max(1,Math.min(8,o.maxCandidates??3))&&remaining.length;n++){
   // These counts are an explicit delivery scenario. They never alter the real observation or authorize work before delivery.
   const incoming:Record<number,number>={};
   for(const s of stock.values())if(key(s.holder)!==key(a.account)&&!held(s.holder))for(const [id]of Object.entries(s.items))if(remaining.some(m=>sources(a.account,m.id,Number(id)).includes(key(s.holder))))incoming[Number(id)]=(incoming[Number(id)]??0)+available(s,Number(id));
   const bank=a.bank&&fresh(a.bank.at)?a.bank.value:{};
   const projected=Object.keys(incoming).length?{...a,bank:{at:o.now,value:Object.fromEntries([...new Set([...Object.keys(bank),...Object.keys(incoming)])].map(id=>[id,(bank[Number(id)]??0)+(incoming[Number(id)]??0)])),source:'explicit-delivery-scenario'}}:a;
   const decision=chooseProgression(intent,projected,remaining,context);
   for(const f of decision.followUps)requests.push({account:a.account,method:f.method,action:f.state,reason:f.reason.join('; ')});
   if(decision.state!=='execute'||!decision.selected||decision.expectedTicks===null)break;
   const first=remaining.find(m=>m.id===decision.selected)!;remaining=remaining.filter(m=>m.id!==decision.selected);
   if(decision.basis!=='measured'){requests.push({account:a.account,method:first.id,action:'measure',reason:'A modeled improvement requires matched whole-route measurements before it changes the fleet allocation.'});continue;}
   if(first.id===current.id)continue;
   const support=decision.path.flatMap(p=>{const m=methods.find(m=>m.id===p.method);return m?[...(o.supportFor?.(m,a)??[])]:[];});
   if(support.some(s=>held(s.helper)||!valid(s.opportunityTicks)||!valid(s.deliveryTicks))){requests.push({account:a.account,method:first.id,action:'measure',reason:'Helper opportunity/delivery cost is unknown or the helper has another owner.'});continue;}
   const switching=o.switchingTicks?.(assignment,first,a)??0;
   if(!valid(switching)){requests.push({account:a.account,method:first.id,action:'measure',reason:'Switching cost is unknown.'});continue;}
   const resources=[...new Set(decision.path.flatMap(p=>{const m=methods.find(m=>m.id===p.method);return m?[...(o.resourcesFor?.(m,a)??[])]:[];}).concat(support.flatMap(s=>[...(s.resources??[]),'helper:'+key(s.helper)])))];
   const finish=decision.expectedTicks+switching+support.reduce((total,s)=>total+s.opportunityTicks!+s.deliveryTicks!,0),saving=baseline.finish-finish;
   if(saving<=0)continue;
   group.push({assignment,account:a,intent,methods,decision,method:first.id,step:o.stepFor?.(first,decision.path[0]!.units,intent,a)??first.step,saving,finish,resources,needs:initialNeeds(decision,methods),support,baseline:false});
  }
  group.sort((a,b)=>b.saving-a.saving||a.method.localeCompare(b.method));
 }
 const baselineUsage:Record<string,number>={...o.taken};for(const a of o.baseline)for(const r of new Set(a.resources))baselineUsage[r]=(baselineUsage[r]??0)+1;
 const capacities=(r:string)=>Math.max(o.capacity?.[r]??1,baselineUsage[r]??0);
 function allocate(choices:readonly Choice[]):{reservations:FleetProgressionReservation[];delivery:Map<Choice,number>}|null{
  const usage:Record<string,number>={...o.taken},used:Record<string,number>={},reservations:FleetProgressionReservation[]=[],delivery=new Map<Choice,number>();
  for(const c of choices){for(const r of new Set(c.resources)){usage[r]=(usage[r]??0)+1;if(usage[r]!>capacities(r))return null;}
   const donors=new Set<string>();
   for(const [item,count]of Object.entries(c.needs)){
    const id=Number(item);let left=count;
    for(const holder of sources(c.assignment.account,c.method,id)){
     const s=stock.get(holder);if(!s||!fresh(s.at))continue;
     const stamp=holder+':'+id,take=Math.min(left,Math.max(0,available(s,id)-(used[stamp]??0)));if(take<=0)continue;
     if(holder!==key(c.assignment.account)){
      const d=s.delivery;if(!d||d.basis!=='measured'||!valid(d.ticks)||!d.source||!d.evidence){if(!c.baseline)requests.push({account:c.assignment.account,method:c.method,action:'measure',holder:s.holder,item:id,count:take,reason:'Price the existing owned transfer route before assuming a fleet speed gain.'});continue;}
      donors.add(holder);
     }
     used[stamp]=(used[stamp]??0)+take;left-=take;reservations.push({holder:s.holder,consumer:c.assignment.account,item:id,count:take});if(left<=1e-9)break;
    }
    if(left>1e-9)return null;
   }
   delivery.set(c,[...donors].reduce((n,h)=>n+stock.get(h)!.delivery!.ticks!,0));
  }
  return {reservations,delivery};
 }
 let best=groups.map(g=>g.find(c=>c.baseline)!),bestScore=0,bestAllocation=allocate(best),visited=0,exhausted=false;
 if(!bestAllocation)gaps.push('Baseline stock reservations need reconciliation; the existing assignments remain owned.');
 const walk=(index:number,chosen:Choice[])=>{
  if(visited>=bound){exhausted=true;return;}visited++;
  if(index===groups.length){const allocation=allocate(chosen);if(!allocation)return;const score=chosen.reduce((n,c)=>n+c.saving-(allocation.delivery.get(c)??0),0);
   if(score>bestScore){bestScore=score;best=[...chosen];bestAllocation=allocation;}return;}
  for(const c of groups[index]!){walk(index+1,[...chosen,c]);if(visited>=bound){exhausted=true;break;}}
 };
 walk(0,[]);
 const reservations=bestAllocation?.reservations??[],changes:FleetProgressionChange[]=[],assignments:Assignment[]=[];
 for(const c of best){
  if(c.baseline){assignments.push(c.assignment);continue;}
  const reserved=reservations.filter(r=>key(r.consumer)===key(c.assignment.account)),external=reserved.filter(r=>key(r.holder)!==key(c.assignment.account)),ready=external.length===0;
  const change:FleetProgressionChange={account:c.assignment.account,from:c.assignment.template!.id,method:c.method,intent:c.intent!,step:c.step!,decision:c.decision!,savedTicks:c.saving-(bestAllocation?.delivery.get(c)??0),finishTicks:c.finish+(bestAllocation?.delivery.get(c)??0),reservations:reserved,ready};changes.push(change);
  if(ready)assignments.push({...c.assignment,resources:c.resources,reason:c.assignment.reason+'; measured finite route '+c.method+' saves '+Math.round(change.savedTicks)+' ticks',template:{...c.assignment.template!,script:c.step!.script,args:c.step!.args,env:c.step!.env,worker:c.step!.script}});
  else{assignments.push(c.assignment);for(const r of external)requests.push({account:c.assignment.account,method:c.method,action:'transfer',holder:r.holder,item:r.item,count:r.count,reason:'Use the existing owned order path; training changes only after recipient stock is freshly observed.'});}
 }
 if(exhausted)gaps.push('Fleet allocation search bound reached; the retained feasible result is not an exhaustive optimum.');
 for(const request of requests)if(requestedConsumers.has(key(request.account))&&!request.consumer&&['observe','qualify','measure','acquire'].includes(request.action)){
  const assignment=o.baseline.find(a=>key(a.account)===key(request.account)),intent=get(o.intents,request.account),t=assignment?.template;
  if(!t||!intent||assignment?.fund||assignment?.send)continue;
  const accept:CatalogAccept|undefined=intent.kind==='train'?{skills:{[t.trains?.skill??intent.skill[0]!.toUpperCase()+intent.skill.slice(1)]:intent.targetLevel}}:intent.kind==='quest'?{quests:[intent.quest]}:intent.kind==='produce'||intent.kind==='acquire'?{bank:intent.items}:undefined;
  if(accept)request.consumer={work:{script:t.script,args:[...(t.args??[])],env:{...t.env}},accept};
 }
 const unique=new Map(requests.map(r=>[JSON.stringify(r),r]));
 return {assignments,changes,reservations,requests:[...unique.values()],gaps,search:{visited,bound,exhausted}};
}
export const optimiseProgressionAssignments=selectProgressionFleet;
