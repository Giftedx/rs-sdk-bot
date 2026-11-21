import type {ConditionalMeasuredSample,Observation,ObservedAccount,ProgressionAdmission,ProgressionAlternative,ProgressionDecision,ProgressionMethod,ProgressionPathStep,Requirement,SelectionContext,StateBand,Truth,WorkIntent} from '../../core/src/progression-adapter';
import {requirements} from './requirements';
import {createHash} from 'node:crypto';
import {levelForXp,xpForLevel} from './curve';

export type {ConditionalMeasuredSample,Observation,ObservedAccount,ProgressionAdmission,ProgressionAlternative,ProgressionDecision,ProgressionMethod,ProgressionPathStep,SelectionContext,StateBand,WorkIntent};
export const TRAINING_SKILLS=['attack','defence','strength','hitpoints','ranged','prayer','magic','cooking','woodcutting','fletching','fishing','firemaking','crafting','smithing','mining','herblore','agility','thieving','runecraft'] as const;
/** Read all training targets without changing the serialized single-skill intent. Invalid targets stay unknown. */
export function trainingTargets(intent:WorkIntent):Record<string,number>|null{
 if(intent.kind!=='train'&&intent.kind!=='train-all')return null;
 const raw=intent.kind==='train'?{[intent.skill]:intent.targetLevel}:intent.targets;
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||!Object.keys(raw).length)return null;
 const targets:Record<string,number>={};
 for(const [name,target]of Object.entries(raw)){
  const skill=name.trim().toLowerCase();
  if(!TRAINING_SKILLS.includes(skill as typeof TRAINING_SKILLS[number])||Object.hasOwn(targets,skill)||!Number.isSafeInteger(target)||target<1||target>99)return null;
  targets[skill]=target;
 }
 return targets;
}

const key=(s:string)=>s.toLowerCase().replace(/\s+/g,' ').trim();
const entries=(v:Record<string,number>|undefined)=>Object.entries(v??{});
const positive=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>0;
const nonnegative=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
function canonical(v:unknown):unknown{
 if(Array.isArray(v))return v.map(canonical);
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)]));
 return v;
}
const stable=(v:unknown)=>JSON.stringify(canonical(v));
const fresh=(o:{at:number}|null|undefined,c:SelectionContext)=>!!o&&positive(o.at)&&o.at<=c.now&&c.now-o.at<=(c.maxAgeMs??300000);
/** A fingerprint binds observations, intent, candidate source/rates and whether each observation is still fresh. */
export function progressionFingerprint(intent:WorkIntent,account:ObservedAccount,methods:readonly ProgressionMethod[],context:SelectionContext):string{
 const {now,...policy}=context;
 return createHash('sha256').update(stable({intent,account,methods:[...methods].sort((a,b)=>a.id.localeCompare(b.id)),policy,
  fresh:[account,account.inventory,account.equipment,account.bank,account.quests,account.position].map(o=>fresh(o,context))})).digest('hex');
}
type SearchState={xp:Record<string,number>;items:Record<number,number>;quests:Record<string,Truth>;outcomes:Record<string,number>;used:string[];ticks:number;path:ProgressionPathStep[];model:boolean};
function skillXp(s:SearchState,name:string){return s.xp[key(name)];}
function goalDone(intent:WorkIntent,s:SearchState):boolean{
 if(intent.kind==='train'||intent.kind==='train-all'){
  const targets=trainingTargets(intent);return !!targets&&entries(targets).every(([skill,target])=>(skillXp(s,skill)??-1)>=xpForLevel(target));
 }
 if(intent.kind==='produce'||intent.kind==='acquire')return entries(intent.items).every(([id,n])=>(s.items[Number(id)]??0)>=n);
 if(intent.kind==='quest')return s.quests[key(intent.quest)]===true;
 return (s.outcomes[intent.objective]??0)>=(intent.units??1);
}
function primaryUnits(intent:WorkIntent,m:ProgressionMethod,s:SearchState):number{
 if(intent.kind==='train'||intent.kind==='train-all'){
  return Math.max(0,...entries(trainingTargets(intent)??{}).map(([skill,target])=>{
   const gain=entries(m.effects.xp).find(([name])=>key(name)===key(skill))?.[1]??0;
   return gain>0?Math.ceil(Math.max(0,xpForLevel(target)-(skillXp(s,skill)??0))/gain):0;
  }));
 }
 if(intent.kind==='produce'||intent.kind==='acquire'){
  const needs=entries(intent.items).filter(([id,n])=>(s.items[Number(id)]??0)<n);
  const supplied=needs.filter(([id])=>positive(m.effects.items?.[Number(id)]));
  return supplied.length?Math.max(...supplied.map(([id,n])=>Math.ceil((n-(s.items[Number(id)]??0))/m.effects.items![Number(id)]!))):0;
 }
 if(intent.kind==='quest')return m.effects.quests?.some(q=>key(q)===key(intent.quest))&&s.quests[key(intent.quest)]!==true?1:0;
 return m.effects.outcome===intent.objective?Math.max(0,(intent.units??1)-(s.outcomes[intent.objective]??0)):0;
}
function relevantMethods(intent:WorkIntent,methods:readonly ProgressionMethod[],initial:SearchState){
 const relevant=new Set(methods.filter(m=>primaryUnits(intent,m,initial)>0));
 for(let round=0;round<methods.length;round++){
  const before=relevant.size;
  for(const m of methods)if(!relevant.has(m)&&[...relevant].some(target=>
   entries(target.requirements?.levels).some(([skill])=>entries(m.effects.xp).some(([gain])=>key(gain)===key(skill)))||
   [...entries(target.requirements?.items),...entries(target.inputs)].some(([id])=>positive(m.effects.items?.[Number(id)]))||
   target.requirements?.quests?.some(q=>m.effects.quests?.some(gain=>key(gain)===key(q)))))relevant.add(m);
  if(relevant.size===before)break;
 }
 return [...relevant].sort((a,b)=>a.id.localeCompare(b.id));
}
function bandUnits(b:StateBand,m:ProgressionMethod,s:SearchState):number{
 let cap=Infinity;
 for(const [skill,range]of Object.entries(b.levels??{}))if(range.max!==undefined&&range.max<99){
  const gain=entries(m.effects.xp).find(([name])=>key(name)===key(skill))?.[1]??0;
  if(gain>0)cap=Math.min(cap,Math.max(1,Math.ceil((xpForLevel(range.max+1)-(skillXp(s,skill)??0))/gain)));
 }
 for(const [skill,proved]of Object.entries(b.gainXp??{})){
  const gain=entries(m.effects.xp).find(([name])=>key(name)===key(skill))?.[1]??0;
  if(gain>0)cap=Math.min(cap,Math.max(1,Math.floor(Math.max(0,proved)/gain)));
 }
 return cap;
}
function unitsFor(intent:WorkIntent,m:ProgressionMethod,s:SearchState,methods:readonly ProgressionMethod[],account:ObservedAccount,context:SelectionContext):number[]{
 const choices=new Set<number>(),add=(n:number)=>{if(positive(n))choices.add(Math.ceil(n));};
 add(primaryUnits(intent,m,s));
 if(intent.kind==='train-all')for(const [skill,target]of entries(trainingTargets(intent)??{})){
  const gain=entries(m.effects.xp).find(([name])=>key(name)===skill)?.[1]??0;
  if(gain>0)add((xpForLevel(target)-(skillXp(s,skill)??0))/gain);
 }
 for(const target of methods){
  for(const [skill,level]of entries(target.requirements?.levels)){
   const gain=entries(m.effects.xp).find(([name])=>key(name)===key(skill))?.[1]??0;
   if(gain>0)add((xpForLevel(level)-(skillXp(s,skill)??0))/gain);
  }
  for(const [id,n]of entries(target.requirements?.items))if(positive(m.effects.items?.[Number(id)]))add((n-(s.items[Number(id)]??0))/m.effects.items![Number(id)]!);
  // A finite producer stages the inputs its consumer needs for this goal, not an arbitrary stockpile.
  const work=primaryUnits(intent,target,s)||1;
  for(const [id,n]of entries(target.inputs))if(positive(m.effects.items?.[Number(id)]))add((n*work-(s.items[Number(id)]??0))/m.effects.items![Number(id)]!);
  if(target.requirements?.quests?.some(q=>s.quests[key(q)]!==true&&m.effects.quests?.some(gain=>key(gain)===key(q))))add(1);
 }
 const once=m.repeatable===false||!!m.effects.quests?.length;
 let cap=m.maxUnits??Infinity;
 if(m.rate.conditions)cap=Math.min(cap,bandUnits(m.rate.conditions,m,s));
 if(m.qualification){const matching=m.qualification.bands.filter(b=>qualificationReasons(b,m,s,account,context,intent).length===0);if(matching.length)cap=Math.min(cap,Math.max(...matching.map(b=>bandUnits(b,m,s))));}
 if(m.rate.basis==='measured'&&m.rate.samples?.length){const matching=m.rate.samples.filter(sample=>sample.source===m.source&&bandReasons(sample.conditions,s,account,context).length===0);if(matching.length)cap=Math.min(cap,Math.max(...matching.map(sample=>bandUnits(sample.conditions,m,s))));}
 return [...choices].map(n=>once?1:Math.min(n,cap)).filter((n,i,all)=>all.indexOf(n)===i).sort((a,b)=>a-b);
}
function bandReasons(b:StateBand,s:SearchState,a:ObservedAccount,c:SelectionContext):string[]{
 const reasons:string[]=[];
 for(const [name,range]of Object.entries(b.levels??{})){
  const xp=skillXp(s,name),level=xp===undefined?undefined:levelForXp(xp);
  if(level===undefined||range.min!==undefined&&level<range.min||range.max!==undefined&&level>range.max)reasons.push('level band '+name);
 }
 // A step makes one whole level at least (the worker's target is a level). When the proved XP does not reach the
 // next level from here, no step fits inside the proof.
 for(const [name,proved]of Object.entries(b.gainXp??{})){
  const xp=skillXp(s,name),level=xp===undefined?undefined:levelForXp(xp);
  if(xp===undefined||level===undefined||level<99&&xpForLevel(level+1)-xp>proved)reasons.push('gain band '+name);
 }
 for(const [id,n]of entries(b.items))if((s.items[Number(id)]??0)<n)reasons.push('item band '+id);
 for(const q of b.quests??[])if(s.quests[key(q)]!==true)reasons.push('quest band '+q);
 if(b.server&&b.server!==a.server)reasons.push('server band');
 if(b.loadout?.some(id=>!fresh(a.equipment,c)||(a.equipment!.value[id]??0)<1))reasons.push('loadout band');
 if(b.maxCrowding!==undefined&&(c.crowding===undefined||c.crowding>b.maxCrowding))reasons.push('crowding band');
 return reasons;
}
function qualificationReasons(b:StateBand,m:ProgressionMethod,s:SearchState,a:ObservedAccount,c:SelectionContext,intent:WorkIntent):string[]{
 const kit=(b.kit??[]).filter(id=>!(m.requirements?.items&&Object.hasOwn(m.requirements.items,id))).map(id=>'kit band '+id);
 return[...kit,...stateReasons(b,m,s,a,c,intent)];
}
function stateReasons(b:StateBand,m:ProgressionMethod,s:SearchState,a:ObservedAccount,c:SelectionContext,intent:WorkIntent):string[]{
 const admitted=c.admitted;
 if(!admitted||admitted.method!==m.id||admitted.source!==m.source||stable(admitted.intent)!==stable(intent)||key(admitted.account.account)!==key(a.account)||admitted.account.server!==a.server)return bandReasons(b,s,a,c);
 // A successful entry bound the stock available at admission. A spent arrow is not a failed entry fact.
 // Live skill, worn-kit, quest, server, method requirements and input checks continue to use the current state.
 const items:Record<number,number>={},entry=admitted.account;
 for(const observation of [entry.inventory,entry.equipment,entry.bank])if(observation&&positive(observation.at)&&positive(entry.at)&&observation.at<=entry.at&&entry.at<=c.now&&entry.at-observation.at<=(c.maxAgeMs??300000))for(const [id,n]of entries(observation.value))if(nonnegative(n))items[Number(id)]=(items[Number(id)]??0)+n;
 for(const [id,n]of entries(entry.reservations))items[Number(id)]=Math.max(0,(items[Number(id)]??0)-Math.max(0,n));
 return bandReasons(b,{...s,items},a,c);
}
function inspect(m:ProgressionMethod,s:SearchState,a:ObservedAccount,c:SelectionContext,unknownStock:boolean,intent:WorkIntent):ProgressionAlternative{
 const reasons:string[]=[],req=m.requirements;
 let state:ProgressionAlternative['state']='ready';
 const hold=(next:ProgressionAlternative['state'],why:string)=>{reasons.push(why);if(state==='ready'||next==='observe'||next==='blocked')state=next;};
 if(!m.id||!m.source||!m.step?.script||!Object.values(m.effects.xp??{}).every(nonnegative)||!Object.values(m.effects.items??{}).every(nonnegative)||!Object.values(m.inputs??{}).every(positive))hold('blocked','invalid finite method definition');
 for(const [skill,n]of entries(req?.levels)){
  const xp=skillXp(s,skill);if(xp===undefined)hold('observe','level unknown: '+skill);
  else if(levelForXp(xp)<n)hold('acquire','unlock level: '+skill+' '+n);
 }
 for(const [skill]of entries(a.build?.maxLevels))if(entries(m.effects.xp).some(([name,gain])=>key(name)===key(skill)&&gain>0)&&skillXp(s,skill)===undefined)hold('observe','build skill unknown: '+skill);
 for(const q of req?.quests??[])if(s.quests[key(q)]!==true)hold(s.quests[key(q)]===false?'acquire':'observe','quest prerequisite: '+q);
 for(const [id,n]of entries(req?.items))if((s.items[Number(id)]??0)<n)hold(unknownStock?'observe':'acquire','required stock: '+id+' '+n);
 if(req?.facts){const result=requirements({...c.requirementGraph,__progression:req.facts},a.facts??{},['__progression']).__progression!;if(result.state!==true)hold(result.state===null?'observe':'acquire',result.blockers.join(', '));}
 if(m.rate.conditions){const mismatches=bandReasons(m.rate.conditions,s,a,c);if(mismatches.length)hold('measure','rate conditions: '+mismatches.join(', '));}
 const qualification=m.qualification;
 if(qualification&&(qualification.source!==m.source||!qualification.bands.some(b=>qualificationReasons(b,m,s,a,c,intent).length===0)))hold('qualify','qualification source or state band does not match');
 else if(c.requireQualification&&!qualification)hold('qualify','qualification missing for this method and state');
 if(!positive(m.rate.unitsPerTick)||m.rate.basis==='unknown'||!m.rate.evidence?.trim())hold('measure','work rate unknown');
 if(m.rate.basis==='measured'&&m.rate.samples?.length&&!m.rate.samples.some(sample=>sample.source===m.source&&positive(sample.units)&&positive(sample.ticks)&&sample.evidence.trim()&&bandReasons(sample.conditions,s,a,c).length===0))hold('measure','no matching measured sample');
 const continuing=c.continuing&&c.currentMethod===m.id&&!s.path.length||s.path.at(-1)?.method===m.id;
 if(!continuing&&[m.costs.setupTicks,m.costs.travelTicks,m.costs.acquisitionTicks,m.costs.unlockTicks].some(n=>!nonnegative(n)))hold('measure','preparation cost unknown');
 if(m.costs.resupply&&(!positive(m.costs.resupply.everyUnits)||!nonnegative(m.costs.resupply.ticks)))hold('measure','resupply cost unknown');
 return {method:m.id,state,ticks:null,reason:reasons};
}
/** Bounded comparison of supplied methods. It does not assert that an uncatalogued route cannot be faster. */
export function chooseProgression(intent:WorkIntent,account:ObservedAccount,methods:readonly ProgressionMethod[],context:SelectionContext):ProgressionDecision{
 const bound=Math.max(1,Math.min(10000,Math.floor(context.maxSearchNodes??512))),depth=Math.max(1,Math.min(20,Math.floor(context.maxDepth??6)));
 const base:ProgressionDecision={state:'blocked',selected:null,step:null,path:[],expectedTicks:null,basis:'unknown',alternatives:[],followUps:[],stateFingerprint:progressionFingerprint(intent,account,methods,context),reason:'No supported finite route reaches this goal.',gaps:['Comparison covers supplied candidates only.'],search:{nodes:0,bound,depth,exhausted:false}};
 const targets=trainingTargets(intent),training=intent.kind==='train'||intent.kind==='train-all';
 if(!fresh(account,context)||!positive(context.now)||training&&(!targets||!account.skills||!Object.keys(targets).every(skill=>Object.entries(account.skills).some(([name,v])=>key(name)===skill&&Number.isSafeInteger(v.level)&&v.level>=1&&v.level<=99&&nonnegative(v.xp)))))return {...base,state:'observe',reason:'Fresh valid account skill observations are required.'};
 if(account.clock?.protected&&!account.clock.authorized&&intent.kind!=='observe')return {...base,reason:'Protected account clock requires its authorized launch.'};
 if(targets&&Object.entries(account.build?.maxLevels??{}).some(([skill,maximum])=>targets[key(skill)]!==undefined&&targets[key(skill)]!>maximum))return {...base,reason:'Finite training goal exceeds the account build ceiling.'};
 const items:Record<number,number>={},containers=[account.inventory,account.equipment,account.bank];
 for(const o of containers)if(fresh(o,context))for(const [id,n]of entries(o!.value))if(nonnegative(n))items[Number(id)]=(items[Number(id)]??0)+n;
 for(const [id,n]of entries(account.reservations))items[Number(id)]=Math.max(0,(items[Number(id)]??0)-Math.max(0,n));
 const initial:SearchState={xp:Object.fromEntries(Object.entries(account.skills).filter(([,s])=>nonnegative(s.xp)).map(([skill,s])=>[key(skill),s.xp])),items,
  quests:fresh(account.quests,context)?Object.fromEntries(Object.entries(account.quests!.value).map(([q,v])=>[key(q),v])):{},outcomes:{},used:[],ticks:0,path:[],model:false};
 if(goalDone(intent,initial))return {...base,state:'complete',expectedTicks:0,reason:'Observed account state already meets the finite goal.'};
 const relevant=relevantMethods(intent,methods,initial),unknownStock=containers.some(o=>!fresh(o,context));
 base.alternatives=relevant.map(m=>inspect(m,initial,account,context,unknownStock,intent));
 const follow=new Map(base.alternatives.filter(a=>a.state!=='ready').map(a=>[a.method,a]));
 const queue:SearchState[]=[initial],seen=new Map<string,number>();let best:SearchState|undefined,cut=false;
 while(queue.length&&base.search.nodes<bound){
  queue.sort((a,b)=>a.ticks-b.ticks||a.path.map(s=>s.method).join('/').localeCompare(b.path.map(s=>s.method).join('/')));
  const state=queue.shift()!;base.search.nodes++;
  if(goalDone(intent,state)){best=state;break;}
  if(state.path.length>=depth){cut=true;continue;}
  for(const m of relevant){
   if((m.repeatable===false||m.effects.quests?.length)&&state.used.includes(m.id))continue;
   const check=inspect(m,state,account,context,unknownStock,intent);if(check.state!=='ready')continue;
   for(const units of unitsFor(intent,m,state,relevant,account,context)){
    const consumed=Object.fromEntries(entries(m.inputs).map(([id,n])=>[id,n*units]));
    if(entries(consumed).some(([id,n])=>(state.items[Number(id)]??0)+1e-9<n)){
     follow.set(m.id,{method:m.id,state:unknownStock?'observe':'acquire',ticks:null,reason:['Finite inputs do not cover '+units+' work units after reservations.']});continue;
    }
    const xp={...state.xp};for(const [skill,n]of entries(m.effects.xp))xp[key(skill)]=(xp[key(skill)]??0)+n*units;
    if(entries(account.build?.maxLevels).some(([skill,max])=>levelForXp(xp[key(skill)]??0)>max)){
     follow.set(m.id,{method:m.id,state:'blocked',ticks:null,reason:['Side XP would exceed the account build.']});continue;
    }
    const nextItems={...state.items};for(const [id,n]of entries(consumed))nextItems[Number(id)]=(nextItems[Number(id)]??0)-n;
    for(const [id,n]of entries(m.effects.items))nextItems[Number(id)]=(nextItems[Number(id)]??0)+n*units;
    const continuing=context.continuing&&context.currentMethod===m.id&&!state.path.length||state.path.at(-1)?.method===m.id;
    const setup=continuing?0:m.costs.setupTicks!+m.costs.travelTicks!+m.costs.acquisitionTicks!+m.costs.unlockTicks!;
    const resupply=m.costs.resupply?Math.max(0,Math.ceil(units/m.costs.resupply.everyUnits)-1)*m.costs.resupply.ticks!:0;
    const ticks=setup+units/m.rate.unitsPerTick!+resupply;
    if(!nonnegative(ticks))continue;
    const costProof=m.costs.measured,costsMeasured=!!costProof&&costProof.source===m.source&&!!costProof.evidence.trim()&&(!costProof.conditions||bandReasons(costProof.conditions,state,account,context).length===0);
    const modeledCost=setup+resupply>0&&!costsMeasured;
    if(modeledCost)follow.set(m.id,{method:m.id,state:'measure',ticks:null,reason:['Source/state-matched preparation and resupply timing is required for a measured whole-route comparison.']});
    const next:SearchState={xp,items:nextItems,quests:{...state.quests,...Object.fromEntries((m.effects.quests??[]).map(q=>[key(q),true]))},
     outcomes:{...state.outcomes,...(m.effects.outcome?{[m.effects.outcome]:(state.outcomes[m.effects.outcome]??0)+units}:{})},used:[...state.used,m.id],ticks:state.ticks+ticks,
     path:[...state.path,{method:m.id,step:m.step,units,ticks,inputs:consumed}],model:state.model||m.rate.basis!=='measured'||modeledCost};
    // Preserve a finite ready route if a large catalog exhausts the search budget before that node is popped.
    if(goalDone(intent,next)&&(!best||next.ticks<best.ticks))best=next;
    const stamp=stable({xp:next.xp,items:next.items,quests:next.quests,outcomes:next.outcomes,used:[...new Set(next.used)].sort(),last:m.id});
    if((seen.get(stamp)??Infinity)<=next.ticks)continue;seen.set(stamp,next.ticks);queue.push(next);
   }
  }
 }
 base.search.exhausted=cut||queue.length>0&&base.search.nodes>=bound;
 if(base.search.exhausted)base.gaps.push('Search bound reached; no claim of exhaustive optimality.');
 base.followUps=[...follow.values()].sort((a,b)=>a.method.localeCompare(b.method)).map(({method,state,reason})=>({method,state,reason}));
 if(best){const first=best.path[0]!;return {...base,state:'execute',selected:first.method,step:first.step,path:best.path,expectedTicks:best.ticks,basis:best.model?'model':'measured',reason:'Lowest total expected ticks among the finite supplied routes reached by this search.'};}
 const next=base.followUps.find(f=>f.state==='observe')??base.followUps.find(f=>f.state==='acquire')??base.followUps.find(f=>f.state==='qualify')??base.followUps.find(f=>f.state==='measure');
 const pending=next?.state;
 return {...base,state:pending==='observe'||pending==='acquire'||pending==='qualify'||pending==='measure'?pending:'blocked',reason:next?next.reason.join('; '):base.reason};
}
