import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {ObservedAccount,ProgressionMethod,WorkIntent} from './progression';
import {TRAINING_SKILLS,trainingTargets} from './progression';
import {parseStep,type Step} from '../../core/src/chain-step';
import {levelForXp,xpForLevel} from './curve';
import {rangedProgressionMethods} from './progression-ranged';

export const PROGRESSION_SKILLS=TRAINING_SKILLS;
export type CatalogIntent=WorkIntent['kind'];
export interface CatalogRoute{id:string;category:string;name:string;script:string;args:string[];env:Record<string,string>;intents:CatalogIntent[];skills:string[];description:string;discriminator?:{env?:Record<string,string>;args?:Record<number,string>}}
export type CatalogMethod=ProgressionMethod&{routeId:string;ladderIds:string[];sourceEntry?:string;members?:boolean|null;execution?:{bankJob?:Record<string,unknown>;outputPerUnit?:number;targetEnv?:string[];unitEnv?:string[];stockEnv?:string[];targetArg?:number;unitArg?:number;spendPerUnit?:number};maxBatch?:number;modelRates?:{skill:string;perLevel:(number|null)[]}};
export interface CatalogQuest{id:string;name:string;script:string;xp:Record<string,number>;source:string;requirements?:ProgressionMethod['requirements']}
export interface CatalogEntry{script:string;intents:CatalogIntent[];skills:string[];routeIds:string[];practiceOnly?:boolean}
export interface CatalogGap{method:string;action:'build'|'measure'|'inspect'|'acquire';reason:string;consumer:string;source?:string;capability?:string}
export interface ProgressionCatalog{version:1;generatedBy:string;skills:string[];routes:CatalogRoute[];methods:CatalogMethod[];quests:CatalogQuest[];entries:CatalogEntry[];buildLimits?:Record<string,Record<string,number>>;unmapped?:{id:string;skill:string;source:string;workers:string[]}[]}
export interface CatalogAccept{skills?:Record<string,number>;bank?:Record<number,number>;quests?:string[];counters?:Record<string,number>}
export interface CatalogOptions{extraMethods?:readonly ProgressionMethod[];now?:number;maxAgeMs?:number;sources?:Readonly<Record<string,string>>;qualifications?:Readonly<Record<string,NonNullable<ProgressionMethod['qualification']>>>}
const root=resolve(import.meta.dir,'../../..');
const key=(s:string)=>s.trim().toLowerCase().replace(/\s+/g,' ');
const whole=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const dated=(v:unknown,now:number):v is number=>whole(v)&&v>0&&v<=now;
const finiteLevel=(v:unknown):v is number=>whole(v)&&v>=1&&v<=99;
const scriptPath=(script:string)=>{const p=script.replace(/\\/g,'/'),at=Math.max(p.lastIndexOf('/scripts/'),p.lastIndexOf('/packages/'));return at>=0?p.slice(at+1):p.replace(/^\.\//,'');};

export function loadProgressionCatalog(base=root):ProgressionCatalog{
 const data=JSON.parse(readFileSync(resolve(base,'packages/planner/data/progression-routes.json'),'utf8'));
 if(data?.version!==1||!['skills','routes','methods','quests','entries'].every(k=>Array.isArray(data[k])))throw Error('invalid progression catalog');
 return data;
}

// Keep containers independent: a recent status cannot refresh its older bank, and noted items retain their exact ID.
export function accountFromStatus(account:string,status:any,now=Date.now()):ObservedAccount{
 if(!account.trim())throw Error('account identity required');
 const empty:ObservedAccount={account,at:0,skills:{},inventory:null,equipment:null,bank:null,quests:null};
 if(status===null||status===undefined)return empty;
 const identity=status.name??status.account;
 if(typeof identity!=='string'||key(identity)!==key(account))throw Error('account identity observation mismatch');
 const at=dated(status.at,now)?status.at:0;
 const countRows=(rows:unknown):Record<number,number>|null=>{
  if(!Array.isArray(rows))return null;
  const out:Record<number,number>={};
  for(const row of rows){const id=row?.id??row?.baseId,n=row?.count;if(!whole(id)||id<1||!whole(n))return null;const total=(out[id]??0)+n;if(!whole(total))return null;out[id]=total;}
  return out;
 };
 const observation=(rows:unknown,time:unknown,source:string)=>{const value=countRows(rows);return dated(time,now)&&at>0&&time<=at&&value!==null?{at:time,value,source}:null;};
 const skills:ObservedAccount['skills']={};
 if(at)for(const skill of Array.isArray(status.skills)?status.skills:[]){const name=typeof skill?.name==='string'?key(skill.name):'',level=skill?.baseLevel??skill?.level,xp=skill?.xp??skill?.experience;
  if(name&&finiteLevel(level)&&typeof xp==='number'&&Number.isFinite(xp)&&xp>=0)skills[name]={level,xp};
 }
 const questRows=Array.isArray(status.questJournal)?status.questJournal:status.quests;
 const quests:Record<string,true|false|null>={};
 if(at&&Array.isArray(questRows))for(const q of questRows){if(typeof q==='string')quests[key(q)]=true;else if(typeof q?.name==='string')quests[key(q.name)]=q.state==='complete'?true:q.state==='not started'||q.state==='in progress'||q.state==='started'?false:null;}
 const questAt=status.questsAt??at;
 const p=status.pos??status.player,x=p?.x??p?.worldX,z=p?.z??p?.worldZ,plane=p?.level;
 const facts:Record<string,true|false|null>={};
 for(const [fact,value]of Object.entries(status.facts??{}))if(value===true||value===false||value===null)facts[fact]=value;
 if(typeof status.members==='boolean')facts.members=status.members;
 else if(typeof status.isMembers==='boolean')facts.members=status.isMembers;
 const reservations:Record<number,number>={};
 for(const [id,n]of Object.entries(status.reservations??{}))if(whole(Number(id))&&Number(id)>0&&whole(n))reservations[Number(id)]=n;
 return{account,at,skills,
  inventory:observation(status.inventory,at,'status.inventory'),equipment:status.equipmentObserved===false?null:observation(status.equipment,at,'status.equipment'),
  bank:observation(status.bank,status.bankAt,'status.bank'),
  quests:at&&Array.isArray(questRows)&&dated(questAt,now)&&questAt<=at?{at:questAt,value:quests,source:'status.quests'}:null,
  ...(typeof status.server==='string'?{server:status.server}:{}),...(typeof status.role==='string'?{role:status.role}:{}),
  ...(typeof status.workRevision==='string'?{source:status.workRevision}:{}),
  ...(at&&whole(x)&&whole(z)&&whole(plane)&&plane<=3?{position:{at,value:{x,z,level:plane},source:'status.position'}}:{}),
  ...(whole(status.hp?.now)?{currentHP:status.hp.now}:{}),facts,reservations,
  ...(status.clock&&typeof status.clock.protected==='boolean'&&typeof status.clock.fresh==='boolean'&&typeof status.clock.authorized==='boolean'?{clock:status.clock}:{}),
  ...(status.build?.maxLevels?{build:{maxLevels:status.build.maxLevels}}:{}),
 };
}

function setting(env:Readonly<Record<string,string|undefined>>,args:readonly string[],name:string){return env[name]??args.find(a=>a.startsWith(name+'='))?.slice(name.length+1);}
function positiveItems(value:Record<number,number>|undefined){return value&&Object.keys(value).length&&Object.entries(value).every(([id,n])=>whole(Number(id))&&Number(id)>0&&whole(n)&&n>0)?value:null;}
function trainingIntent(targets:Record<string,number>):WorkIntent|null{
 const normalized=trainingTargets({kind:'train-all',targets});if(!normalized)return null;
 const entries=Object.entries(normalized);
 return entries.length===1?{kind:'train',skill:entries[0]![0],targetLevel:entries[0]![1]}:{kind:'train-all',targets:normalized};
}
const sameTargets=(a:WorkIntent,b:WorkIntent)=>JSON.stringify(Object.entries(trainingTargets(a)??{}).sort())===JSON.stringify(Object.entries(trainingTargets(b)??{}).sort());

export function matchingProgressionRoutes(script:string,args:readonly string[]=[],env:Readonly<Record<string,string|undefined>>={},catalog:ProgressionCatalog=loadProgressionCatalog()):CatalogRoute[]{
 script=scriptPath(script);
 if(script==='scripts/aio.ts'){
  const first=args[0],category=first&&['skiller','fighter','boss','pvp','quester','market','logistics'].includes(first)?first:args[1];
  return category?matchingProgressionRoutes('scripts/aio-'+category+'.ts',args.slice(category===first?1:2),env,catalog):[];
 }
 const wrapper=script.match(/^scripts\/aio-(skiller|fighter|boss|pvp|quester|market|logistics)\.ts$/)?.[1];
 if(wrapper){const name=wrapper==='skiller'?args.slice(0,2).join(':'):args[0];return catalog.routes.filter(r=>r.category===wrapper&&r.name===name);}
 return catalog.routes.filter(r=>{
  if(r.script!==script)return false;
  for(const [name,want]of Object.entries(r.discriminator?.env??{})){
   const got=setting(env,args,name)??(name==='TARGET'&&script==='scripts/gather-combat.ts'?args[1]:undefined);
   if(got!==want)return false;
  }
  return Object.entries(r.discriminator?.args??{}).every(([at,want])=>args[Number(at)]===want);
 });
}

// Declared finite output owns the intent. Side XP never changes a quest or item order into a trainer.
export function intentForEntry(script:string,args:readonly string[]=[],env:Readonly<Record<string,string|undefined>>={},accept?:CatalogAccept,catalog?:ProgressionCatalog):WorkIntent|null{
 script=scriptPath(script);
 const consumer=setting(env,args,'CONSUMER')??setting(env,args,'GOAL')??script;
 const requestedItems=positiveItems(accept?.bank);
 if(requestedItems)return{kind:'acquire',items:{...requestedItems},consumer};
 if(accept?.quests?.length===1&&accept.quests[0]?.trim())return{kind:'quest',quest:accept.quests[0]};
 const acceptedSkills=Object.entries(accept?.skills??{});
 if(script==='scripts/cannon-fight.ts'){
  const mode=setting(env,args,'MODE');
  if(mode==='buy'||mode==='reclaim')return{kind:'acquire',items:{6:1,8:1,10:1,12:1},consumer};
  if(mode!==undefined)return null;
  const text=setting(env,args,'STOP'),targets:Record<string,number>={};
  if(text!==undefined){
   for(const part of text.split(',')){
    const match=part.trim().match(/^([A-Za-z]+)=(\d+)$/);if(!match||Object.hasOwn(targets,key(match[1]!)))return null;
    targets[key(match[1]!)]=Number(match[2]);
   }
  }else targets[setting(env,args,'STOP_SKILL')??'Ranged']=Number(setting(env,args,'STOP_LEVEL')??99);
  const actual=trainingIntent(targets);if(!actual)return null;
  if(acceptedSkills.length){const declared=trainingIntent(accept!.skills!);return declared&&sameTargets(actual,declared)?declared:null;}
  return actual;
 }
 if(acceptedSkills.length)return trainingIntent(accept!.skills!);
 if(script==='scripts/aio.ts'){
  const category=args[0],entry=category&&['skiller','fighter','boss','pvp','quester','market','logistics'].includes(category)?category:args[1];
  if(entry)return intentForEntry('scripts/aio-'+entry+'.ts',args.slice(entry===category?1:2),env,accept,catalog);
 }
 if(script==='scripts/ranged-starter.ts')return{kind:'train',skill:'ranged',targetLevel:5};
 if(script==='scripts/generated/rcair.ts')return{kind:'service',objective:'craft current carried rune essence into air runes once',units:1};
 if(script==='scripts/gather-spawn.ts'){
  const id=Number(args[0]),count=Number(args[1]??27),ticks=Number(env.TICKS??6000);
  return whole(id)&&id>0&&whole(count)&&count>0&&Number.isFinite(ticks)&&ticks>0?{kind:'acquire',items:{[id]:count},consumer}:null;
 }
 if(script==='scripts/microbot-a-cannonballs.ts'){
  const bars=Number(args[0]??1),cap=Number(args[1]??1200),xp=Number(env.CANNON_XP_RATE??1),reserve=Number(env.CANNON_RESERVE??0);
  return whole(bars)&&bars>=1&&bars<=100000&&whole(cap)&&cap>=1&&cap<=10000&&whole(xp)&&xp>=1&&xp<=1000&&whole(reserve)?{kind:'produce',items:{2:bars*4},consumer}:null;
 }
 const trainerDefaults:Record<string,{skill:string;target:number;cap:number;minimumCap:number}>={
  'scripts/generated/fishing30.ts':{skill:'fishing',target:30,cap:3000,minimumCap:1},
  'scripts/generated/thieving60.ts':{skill:'thieving',target:60,cap:2500,minimumCap:240},
  'scripts/generated/woodcutting.ts':{skill:'woodcutting',target:45,cap:3000,minimumCap:1},
 };
 const trainer=trainerDefaults[script];if(trainer){const target=Number(env.TARGET??trainer.target),cap=Number(env.CAP??trainer.cap);return finiteLevel(target)&&whole(cap)&&cap>=trainer.minimumCap?{kind:'train',skill:trainer.skill,targetLevel:target}:null;}
 const trainingSkill=setting(env,args,'TRAIN_SKILL');
 let target=Number(setting(env,args,'TARGET_LEVEL'));
 if(script==='scripts/ranged-train.ts'){
  const number=(value:string|undefined,fallback:number)=>value===undefined||value===''?fallback:Number(value);
  target=number(args[0]??env.TARGET_LEVEL,10);const cap=number(args[1]??env.CAP,3000);
  return finiteLevel(target)&&target>=2&&whole(cap)&&cap>=800?{kind:'train',skill:'ranged',targetLevel:target}:null;
 }
 if(trainingSkill&&finiteLevel(target)&&PROGRESSION_SKILLS.includes(key(trainingSkill) as typeof PROGRESSION_SKILLS[number]))return{kind:'train',skill:key(trainingSkill),targetLevel:target};
 const data=catalog??(existsSync(resolve(root,'packages/planner/data/progression-routes.json'))?loadProgressionCatalog():undefined);
 if(script==='scripts/microbot-jewellery-trip.ts'){
  try{
   const order=args[0]?JSON.parse(readFileSync(args[0],'utf8')):{recipe:env.RECIPE,target:Number(env.TARGET),stringAmulet:env.STRING_AMULET==='1'};
   if(typeof order.recipe!=='string'||!whole(order.target)||order.target<1||order.target>10000)return null;
   const native=data?.methods.find(m=>{const job=m.execution?.bankJob;return!!job&&job.family==='jewellery'&&job.recipe===order.recipe;});
   let products=native&&Object.keys(native.effects.items??{});if(products?.length!==1)return null;
   if(order.stringAmulet){
    const id=Number(products[0]),stringers=data?.methods.filter(m=>{const job=m.execution?.bankJob;return!!job&&job.family==='inventory'&&typeof job.recipe==='string'&&job.recipe.startsWith('string-')&&!!m.inputs?.[id];})??[];
    if(stringers.length!==1)return null;products=Object.keys(stringers[0]!.effects.items??{});if(products.length!==1)return null;
   }
   return{kind:'produce',items:{[Number(products[0])]:order.target},consumer};
  }catch{return null;}
 }
 if(/^scripts\/aio-(?:skiller|fighter|boss|pvp|quester|market|logistics)\.ts$/.test(script)&&data){
  const matches=matchingProgressionRoutes(script,args,env,data);
  if(matches.length===1){const route=matches[0]!,skip=route.category==='skiller'?2:1,supplied=parseStep([route.script,...args.slice(skip).map(a=>JSON.stringify(a))].join(' '));
   if(route.script!==script)return intentForEntry(route.script,supplied.args.length?supplied.args:route.args,{...env,...route.env,...supplied.env},accept,data);
  }
 }
 const matching=data?.entries.find(e=>e.script===script),routes=data?.routes.filter(r=>r.script===script)??[];
 if(script==='scripts/buy-owned-ge-item.ts'){
  const item=Number(setting(env,args,'ITEM_ID')),quantity=Number(setting(env,args,'QUANTITY')),owned=Number(setting(env,args,'EXPECTED_OWNED')??0);
  if(whole(item)&&item>0&&whole(quantity)&&quantity>0&&whole(owned)&&whole(owned+quantity))return{kind:'acquire',items:{[item]:owned+quantity},consumer};
 }
 if(script==='scripts/shop-buyer.ts'){
  const count=Number(setting(env,args,'STOCK_TARGET')??setting(env,args,'MAX_ITEMS')),pattern=setting(env,args,'ITEMS');
  if(!whole(count)||count<1||!pattern)return null;
  let matches:CatalogMethod[]=[];
  try{const re=new RegExp(pattern,'i');matches=(data?.methods??[]).filter(m=>m.step.script===script&&m.step.args[0]===args[0]&&m.step.env.ITEMS&&re.test(m.step.env.ITEMS.replace(/^\^|\$$/g,'').replace(/\\(.)/g,'$1')));}catch{return null;}
  const ids=[...new Set(matches.flatMap(m=>Object.keys(m.effects.items??{})))];
  if(ids.length===1)return{kind:'acquire',items:{[Number(ids[0])]:count},consumer};
  return{kind:'service',objective:`finite shop order ${args[0]??'unknown'} ${pattern} stock ${count} for ${consumer}`};
 }
 if(['scripts/fleet-trade.ts','scripts/courier-handoff.ts'].includes(script)){
  const file=args.find(a=>a.endsWith('.json')&&!a.includes('='));return file?{kind:'service',objective:'finite owned order '+file}:null;
 }
 if(['scripts/microbot-production.ts','scripts/smelt-bars.ts'].includes(script)){
  const recipe=script==='scripts/microbot-production.ts'?args.find(a=>!a.includes('=')&&!/^\d+$/.test(a)):setting(env,args,'BAR_TYPE')??args[1];
  const maximum=Number(setting(env,args,'MAX_MAKE'));
  const method=data?.methods.find(m=>{const job=m.execution?.bankJob;return script==='scripts/microbot-production.ts'?!!job&&job.family==='inventory'&&job.recipe===recipe:m.step.script===script&&m.step.args[1]===recipe;});
  const items=method&&Object.fromEntries(Object.entries(method.effects.items??{}).map(([id,n])=>[id,n*maximum]));
  if(whole(maximum)&&maximum>0&&positiveItems(items))return{kind:'produce',items:items!,consumer};
 }
 if(script==='scripts/aio-skiller.ts'&&args[0]==='bank-job'){
  try{const raw=args[1]??'',job=JSON.parse(raw.startsWith('--job=')?decodeURIComponent(raw.slice(6)):readFileSync(raw,'utf8'));
   const method=data?.methods.find(m=>{const profile=m.execution?.bankJob;return!!profile&&profile.family===job.family&&profile.recipe===job.recipe;}),skill=method&&Object.keys(method.effects.xp??{})[0];
   if(skill&&finiteLevel(job.targetLevel))return{kind:'train',skill,targetLevel:job.targetLevel};
   const product=method&&Object.keys(method.effects.items??{})[0];if(product&&whole(job.target)&&job.target>0)return{kind:'produce',items:{[Number(product)]:job.target},consumer};
  }catch{return null;}
 }
 if(script==='scripts/aio-skiller.ts'&&args[0]&&finiteLevel(target))return PROGRESSION_SKILLS.includes(key(args[0]) as typeof PROGRESSION_SKILLS[number])?{kind:'train',skill:key(args[0]),targetLevel:target}:null;
 const quest=data?.quests.find(q=>q.script===script||script==='scripts/quest-sweep.ts'&&args.includes(q.id));
 if(quest)return{kind:'quest',quest:quest.name};
 const singleSkill=matching?.skills.length===1?matching.skills[0]:undefined;
 if(singleSkill&&matching?.intents.includes('train')){
  const positional=routes.find(r=>r.skills.includes(singleSkill))?.name;
  target=Number(setting(env,args,'TARGET_LEVEL')??setting(env,args,'TARGET')??(/agility|runecraft|prayer|alch/.test(positional??'')?args.find(a=>/^\d+$/.test(a)):undefined));
  if(finiteLevel(target))return{kind:'train',skill:singleSkill,targetLevel:target};
 }
 if(matching?.intents.includes('pvp'))return{kind:'pvp',objective:routes[0]?.id??script};
 if(matching?.intents.length===1&&matching.intents[0]==='observe')return{kind:'observe',objective:routes[0]?.id??script};
 if(matching?.intents.length===1&&matching.intents[0]==='service')return{kind:'service',objective:routes[0]?.id??script};
 return null;
}

function desiredUnits(intent:WorkIntent,account:ObservedAccount,method:ProgressionMethod):number{
 const targets=trainingTargets(intent);
 if(targets){
  return Math.max(1,...Object.entries(targets).map(([skill,target])=>{
   const effect=Object.entries(method.effects.xp??{}).find(([name])=>key(name)===skill)?.[1]??0;
   const have=Object.entries(account.skills).find(([name])=>key(name)===skill)?.[1].xp??0;
   return effect>0?Math.ceil((xpForLevel(target)-have)/effect):1;
  }));
 }
 if(intent.kind==='produce'||intent.kind==='acquire')return Math.max(1,...Object.entries(intent.items).flatMap(([id,n])=>method.effects.items?.[Number(id)]?[Math.ceil(n/method.effects.items[Number(id)]!)]:[]));
 return 1;
}
export function progressionStep(method:ProgressionMethod,units:number,intent:WorkIntent,account:ObservedAccount,catalog:ProgressionCatalog=loadProgressionCatalog()):Step{
 if(intent.kind==='train-all'){
  const targets=trainingTargets(intent);if(!targets||!whole(units)||units<1)throw Error('compound progression step needs finite observed targets and units');
  const boundary:Record<string,number>={};
  for(const [skill,target]of Object.entries(targets)){
   const own=Object.entries(account.skills).find(([name])=>key(name)===skill)?.[1];
   if(!own||!Number.isFinite(own.xp)||own.xp<0)throw Error('compound progression step needs an observed '+skill+' state');
   const gain=Object.entries(method.effects.xp??{}).find(([name])=>key(name)===skill)?.[1]??0;
   boundary[skill]=Math.min(target,levelForXp(own.xp+gain*units));
  }
  intent={kind:'train-all',targets:boundary};
 }
 const declaration=(method as CatalogMethod).execution?method as CatalogMethod:undefined;if(!declaration?.execution)return trainingStop(method.step,intent);
 const unitSized=!!(declaration.execution.bankJob||declaration.execution.unitEnv?.length||declaration.execution.stockEnv?.length||declaration.execution.unitArg!==undefined);
 const cap=Math.min(declaration.maxUnits??Infinity,declaration.maxBatch??(unitSized?1000:Infinity));
 if(!whole(units)||units<1||units>cap)throw Error('selected progression units exceed the executable batch');
 return materialize(declaration,intent,account,units).step;
}
function trainingStop(step:Step,intent:WorkIntent):Step{
 const targets=trainingTargets(intent);
 if(scriptPath(step.script)!=='scripts/cannon-fight.ts'||intent.kind!=='train-all'||!targets)return step;
 const {STOP_LEVEL:_level,STOP_SKILL:_skill,...env}=step.env;
 return{...step,env:{...env,STOP:Object.entries(targets).map(([skill,target])=>`${skill}=${target}`).join(',')}};
}
function materialize(method:CatalogMethod,intent:WorkIntent,account:ObservedAccount,requestedUnits?:number):ProgressionMethod{
 const unitSized=!!(method.execution?.bankJob||method.execution?.unitEnv?.length||method.execution?.stockEnv?.length||method.execution?.unitArg!==undefined);
 const cap=method.maxBatch??(unitSized?1000:Infinity);
 const targets=trainingTargets(intent),skill=Object.keys(method.effects.xp??{}).find(skill=>targets?.[key(skill)]!==undefined);
 const units=Math.min(cap,requestedUnits??desiredUnits(intent,account,method)),target=skill?targets?.[key(skill)]:undefined;
 const step:Step={script:method.step.script,args:[...method.step.args],env:{...method.step.env}};
 if(method.execution?.bankJob){const job={...method.execution.bankJob,target:units*(method.execution.outputPerUnit??1),batch:Math.min(Number(method.execution.bankJob.batch??13),units),...(target&&method.execution.bankJob.family==='cooking'?{targetLevel:target}:{})};
  step.args=['bank-job','--job='+encodeURIComponent(JSON.stringify(job))];
 }
 for(const name of method.execution?.targetEnv??[])if(target)step.env[name]=String(target);
 for(const name of method.execution?.unitEnv??[])step.env[name]=String(units);
 for(const name of method.execution?.stockEnv??[]){const id=Number(Object.keys(method.effects.items??{})[0]),owned=[account.inventory,account.equipment,account.bank].reduce((n,o)=>n+(o?.value[id]??0),0);step.env[name]=String(owned+units*(method.effects.items?.[id]??1));}
 if(target&&method.execution?.targetArg!==undefined)step.args[method.execution.targetArg]=String(target);
 if(method.execution?.unitArg!==undefined)step.args[method.execution.unitArg]=String(units);
 if(method.execution?.spendPerUnit){step.env.MAX_SPEND=String(Math.ceil(units*method.execution.spendPerUnit));step.env.FLOAT=String(Math.ceil(units*method.execution.spendPerUnit)+1000);}
 const level=method.modelRates&&Object.entries(account.skills).find(([skill])=>key(skill)===key(method.modelRates!.skill))?.[1].level;
 const rate=level&&method.modelRates?{...method.rate,unitsPerTick:method.modelRates.perLevel[level-1]??null}:method.rate;
 return{...method,step:trainingStop(step,intent),rate,...unitSized?{maxUnits:Math.min(method.maxUnits??Infinity,cap)}:{}};
}
export function progressionMethods(intent:WorkIntent,account:ObservedAccount,catalog:ProgressionCatalog=loadProgressionCatalog(),options:CatalogOptions={}):{methods:ProgressionMethod[];gaps:CatalogGap[]}{
 const all=new Map<string,ProgressionMethod>(catalog.methods.map(m=>[m.id,materialize(m,intent,account)]));
 const targets=trainingTargets(intent);
 if(targets?.ranged!==undefined)for(const method of rangedProgressionMethods(account,targets.ranged))all.set(method.id,materialize(method as CatalogMethod,intent,account));
 if((intent.kind==='acquire'||intent.kind==='produce')&&[849,888].some(id=>intent.items[id]))for(const method of rangedProgressionMethods(account,99,intent.items))if(Object.keys(method.effects.items??{}).some(id=>intent.items[Number(id)]))all.set(method.id,method);
 for(const method of options.extraMethods??[])all.set(method.id,method);
 const skills=new Set(Object.keys(targets??{})),items=new Set(intent.kind==='produce'||intent.kind==='acquire'?Object.keys(intent.items).map(Number):[]),quests=new Set(intent.kind==='quest'?[key(intent.quest)]:[]);
 const chosen=new Set<string>();
 for(let pass=0;pass<6;pass++){
  let grew=false;
  for(const method of all.values()){
   const useful=Object.keys(method.effects.xp??{}).some(s=>skills.has(key(s)))||Object.keys(method.effects.items??{}).some(id=>items.has(Number(id)))
    ||(method.effects.quests??[]).some(q=>quests.has(key(q)))||('objective' in intent&&method.effects.outcome===intent.objective);
   if(!useful||chosen.has(method.id))continue;chosen.add(method.id);grew=true;
   for(const id of Object.keys({...method.inputs,...method.requirements?.items}))items.add(Number(id));
   for(const skill of Object.keys(method.requirements?.levels??{}))if(!Object.entries(account.skills).some(([s,k])=>key(s)===key(skill)&&k.level>=method.requirements!.levels![skill]!))skills.add(key(skill));
   for(const q of method.requirements?.quests??[])quests.add(key(q));
  }
  if(!grew)break;
 }
 const gaps:CatalogGap[]=[],methods:ProgressionMethod[]=[];
 const consumer=intent.kind==='train'?`${intent.skill} ${intent.targetLevel}`:intent.kind==='train-all'?Object.entries(intent.targets).map(([skill,target])=>`${skill} ${target}`).join(', '):intent.kind==='quest'?intent.quest:'consumer' in intent?intent.consumer:intent.objective;
 for(const id of chosen){const original=all.get(id)!,source=options.sources?.[id]??options.sources?.[original.step.script]??original.source;
  const qualification=options.qualifications?.[id];
  const method={...original,source,...(qualification?.source===source?{qualification}: {})};
  if(qualification?.source!==source&&method.qualification?.source!==source)delete method.qualification;
  methods.push(method);
  if(method.rate.unitsPerTick===null||Object.values(method.costs).some(v=>v===null))gaps.push({method:id,action:'measure',consumer,source,reason:'Measure whole-job rate and unresolved setup, travel, acquisition or unlock time at this account state'});
  if(!method.qualification)gaps.push({method:id,action:'build',consumer,source,reason:'Qualify this executable adapter on matching source and account state bands'});
 }
 for(const missing of catalog.unmapped??[])if(skills.has(key(missing.skill)))gaps.push({method:missing.id,action:'build',consumer,source:missing.source,reason:'Native method has no exact executable adapter; source substring coverage is not qualification'});
 if(!methods.length)gaps.push({method:'consumer:'+consumer,action:'build',consumer,reason:'No executable catalog method serves the finite consumer'});
 return{methods,gaps};
}
export function catalogCoverage(catalog:ProgressionCatalog=loadProgressionCatalog()){
 const mappedSkills=[...new Set(catalog.methods.flatMap(m=>Object.keys(m.effects.xp??{}).map(key)))].sort();
 return{routes:catalog.routes.length,classified:catalog.routes.filter(r=>r.intents.length>0).length,skills:[...catalog.skills],mappedSkills,
  missingSkills:catalog.skills.filter(s=>!mappedSkills.includes(key(s))),methods:catalog.methods.length,qualified:catalog.methods.filter(m=>!!m.qualification).length,unmapped:catalog.unmapped?.length??0};
}
