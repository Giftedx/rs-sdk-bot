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

// openBot removes a leading actor name: the donor retains [receiver, amount],
// while the receiver retains [donor, receiver, amount]. The worker supplies the
// same exact participant pair for both; ownership and bank reserves stay its guards.
function coinTransferIntent(args:readonly string[],env:Readonly<Record<string,string|undefined>>):WorkIntent|null{
 const account=(s:unknown):s is string=>typeof s==='string'&&s.trim()===s&&/^[A-Za-z0-9_ -]{1,12}$/.test(s)&&!/^(main|haggis)$/i.test(s);
 const pair=(v:unknown):v is [string,string]=>Array.isArray(v)&&v.length===2&&v.every(account)&&key(v[0])!==key(v[1]);
 let participants:[string,string]|undefined;
 if(env.COORDINATOR_PARTICIPANTS!==undefined){try{const parsed:unknown=JSON.parse(env.COORDINATOR_PARTICIPANTS);if(!pair(parsed))return null;participants=parsed;}catch{return null;}}
 let from:string,to:string,amountText:string,options:readonly string[];
 if(account(args[0])&&account(args[1])&&/^\d+$/.test(args[2]??'')){
  from=args[0]!;to=args[1]!;amountText=args[2]!;options=args.slice(3);
  if(!pair([from,to])||participants&&(key(from)!==key(participants[0])||key(to)!==key(participants[1])))return null;
 }else if(participants&&key(args[0]??'')===key(participants[1])&&/^\d+$/.test(args[1]??'')){
  [from,to]=participants;amountText=args[1]!;options=args.slice(2);
 }else return null;
 const amount=Number(amountText);
 if(!whole(amount)||amount<1||amount>2147483647)return null;
 const values:Record<string,number>={reserve:0,'bank-x':3185,'bank-z':3436,'request-ms':30000,'timeout-ms':240000,'grace-ms':45000},seen=new Set<string>();
 for(const option of options){
  const match=/^--(reserve|bank-x|bank-z|approach-ms|request-ms|timeout-ms|grace-ms)=(\d+)$/.exec(option);
  if(!match||seen.has(match[1]!))return null;
  const value=Number(match[2]);if(!whole(value))return null;seen.add(match[1]!);values[match[1]!]=value;
 }
 if(values.reserve!>2147483647||!['bank-x','bank-z'].every(k=>values[k]!>0&&values[k]!<16384)
  ||values['approach-ms']!==undefined&&(values['approach-ms']!<1000||values['approach-ms']!>1800000)
  ||values['request-ms']!<1000||values['request-ms']!>60000||values['timeout-ms']!<values['request-ms']!||values['timeout-ms']!>600000
  ||values['grace-ms']!<1000||values['grace-ms']!>60000)return null;
 return{kind:'service',objective:`finite owned coin transfer ${from} -> ${to}: ${amount} coins; donor bank reserve ${values.reserve}`};
}

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
 if(script==='scripts/coin-courier.ts')return coinTransferIntent(args,env);
 const consumer=setting(env,args,'CONSUMER')??setting(env,args,'GOAL')??script;
 if(script==='scripts/make-wine-order.ts'){
  const maximum=Number(args[0]),cap=Number(args[1]??1000),reserve=Number(args[2]??0);
  if(args.length<1||args.length>3||![maximum,cap,reserve].every(whole)||maximum<1||cap<1)return null;
  // This is a new-notes delta, not an existing bank balance or incidental Cooking XP.
  if(accept&&(Object.keys(accept).length!==1||Object.keys(accept.counters??{}).length!==1||accept.counters?.preservedWine!==maximum))return null;
  return{kind:'service',objective:`preserve ${maximum} new unfermented wine notes (1996) from owned grapes (1987) and jugs of water (1937); reconcile assets; input reserve ${reserve}; CAP ${cap}`,units:1};
 }
 const requestedItems=positiveItems(accept?.bank);
 if(script==='scripts/train-prayer.ts'&&requestedItems&&accept?.skills){
  const skills=Object.entries(accept.skills),target=Number(args[0]??env.TARGET_LEVEL??43),bone=Number(env.BONE_ID??526),reserve=Number(env.BONE_RESERVE??6),cap=Number(env.CAP??1500),maximum=Number(env.MAX_BURY??175);
  // Matching Prayer work owns the intent; retained bank stock stays a coordinator postcondition.
  if(args.length<=1&&skills.length===1&&key(skills[0]![0])==='prayer'&&skills[0]![1]===target&&finiteLevel(target)&&target>=43
   &&[526,532,536].includes(bone)&&whole(reserve)&&reserve>=6&&requestedItems[bone]!==undefined&&requestedItems[bone]!>=reserve
   &&whole(cap)&&cap>=1&&cap<=1000000&&whole(maximum)&&maximum>=1&&maximum<=1000000
   &&(env.BURY_HELD===undefined||env.BURY_HELD==='0')&&accept.quests===undefined&&accept.counters===undefined)return{kind:'train',skill:'prayer',targetLevel:target};
 }
 if(requestedItems)return{kind:'acquire',items:{...requestedItems},consumer};
 if(accept?.quests?.length===1&&accept.quests[0]?.trim())return{kind:'quest',quest:accept.quests[0]};
 const specialistGathering=new Map<string,string>([
  ['scripts/fletching-specialist.ts','fletching'],
  ['scripts/fishing-specialist.ts','fishing'],
  ['scripts/mining-specialist.ts','mining'],
  ['scripts/thieving-specialist.ts','thieving'],
 ]);
 const specialistSkill=specialistGathering.get(script);
 if(specialistSkill)return{kind:'service',objective:`fresh-clock ${specialistSkill} 99 specialist`,units:1};
 const fastSkillSpecialists:Readonly<Record<string,{skill:string;cap:number}>>={
  'scripts/crafting-specialist.ts':{skill:'crafting',cap:250},
  'scripts/herblore-specialist.ts':{skill:'herblore',cap:600},
  'scripts/prayer-specialist.ts':{skill:'prayer',cap:1350},
  'scripts/smithing-specialist.ts':{skill:'smithing',cap:1350},
  'scripts/runecraft-specialist.ts':{skill:'runecraft',cap:2300},
  'scripts/magic-specialist.ts':{skill:'magic',cap:1300},
 };
 if(script in fastSkillSpecialists){
  const spec=fastSkillSpecialists[script]!;
  const cap=Number(setting(env,args,'CAP')??(/^\d+$/.test(args[0]??'')?args[0]:String(spec.cap)));
  const target=Number(setting(env,args,'TARGET')??setting(env,args,'TARGET_LEVEL')??'99');
  if(!whole(cap)||cap<1||!finiteLevel(target))return null;
  return{kind:'service',objective:`specialist:${spec.skill}:${target}`,units:1};
 }
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
 if(script==='scripts/attack-specialist.ts'){
  const skills=accept?.skills?Object.entries(accept.skills):[];
  if((!skills.length||(skills.length===1&&skills[0]![0].toLowerCase()==='attack'&&skills[0]![1]===99))&&!Object.keys(accept?.bank??{}).length&&!(accept?.quests?.length)){
   return {kind:'service',objective:'fresh-clock Attack 99 specialist route',units:1};
  }
 }
 if(script==='scripts/ranged-specialist.ts'){
  const skills=accept?.skills?Object.entries(accept.skills):[];
  if((!skills.length||(skills.length===1&&key(skills[0]![0])==='ranged'&&skills[0]![1]===99))&&!Object.keys(accept?.bank??{}).length&&!(accept?.quests?.length)){
   return{kind:'service',objective:'fresh-clock Ranged 99 specialist route',units:1};
  }
 }
 if(script==='scripts/specialist-supplier.ts')return {kind:'service',objective:'stage or hand off specialist supply kit',units:1};
 if(script==='scripts/gathering-supplier.ts')return {kind:'service',objective:'hand off gathering specialist supply kit',units:1};
 if(script==='scripts/ranged-live-prep.ts'){
  const modeArg=args.find(a=>a.startsWith('--mode='));
  const mode=(modeArg?modeArg.slice(7):'all').trim().toLowerCase();
  if(!['all','leather','brew','decant'].includes(mode))return null;
  const capArg=args.find(a=>a.startsWith('--cap='));
  const positional=args.filter(a=>!a.startsWith('--'));
  const posCap=positional.length>=2&&/^\d+$/.test(positional[1]!)?positional[1]:positional.length===1&&/^\d+$/.test(positional[0]!)?positional[0]:undefined;
  const cap=Number(capArg?capArg.slice(6):setting(env,args,'CAP')??posCap??'2400');
  if(!whole(cap)||cap<100||cap>20000)return null;
  return{kind:'service',objective:`ranged-live-prep:${mode}`,units:1};
 }
 if(acceptedSkills.length)return trainingIntent(accept!.skills!);
 // Native GE counterparties have finite fixture work, admitted only on local practice.
 if(script==='packages/practice/src/ge-bulk-order-proof.ts'){
  const actor=args[1];if(!actor||!/^[A-Za-z0-9]{1,12}$/.test(actor))return null;
  if(args[0]==='--snapshot')return args.length===2?{kind:'observe',objective:`observe the owned native GE bank of ${actor} once`,units:1}:null;
  if(args[0]!=='--sell'||args.length!==5)return null;
  const item=Number(args[2]),quantity=Number(args[3]),price=Number(args[4]);
  return [item,quantity,price].every(n=>whole(n)&&n>0)&&item!==995&&item<=2147483647&&Number.isSafeInteger(quantity*price)&&quantity*price<=2147483647
   ?{kind:'service',objective:`post one owned native GE sell offer: ${quantity} of item ${item} at ${price} each; confirm escrow debit and logout`,units:1}:null;
 }
 if(script==='scripts/handoff-inputs.ts'){
  // These are new-output/delta orders. Existing stock cannot satisfy them before
  // the worker reconciles the exact debit, bank credit and logout. Explicit parent targets still win above.
  if(args[0]==='--headless-order'){
   const maximum=Number(args[1]),logs=Number(args[2]),cap=Number(env.CAP??1600);
   return args.length===3&&[maximum,logs,cap].every(whole)&&maximum>=15&&maximum%15===0&&logs>=1&&logs<=25&&cap>0
    ?{kind:'service',objective:`bank ${maximum} new headless arrows (53) from ${logs} plain logs (1511), owned shafts (52) and feathers (314); retain knife (946) and input reserves; CAP ${cap}`,units:1}:null;
  }
  const [donor,receiver,...rest]=args,order=env.HANDOFF_ORDER,items=rest.filter(a=>!a.startsWith('--'));
  if(!donor||!receiver||donor.toLowerCase()===receiver.toLowerCase()||![donor,receiver].every(n=>/^[A-Za-z0-9_ -]{1,12}$/.test(n)&&n.trim()===n&&!/^(main|haggis)$/i.test(n))
   ||!order||!/^[a-zA-Z0-9-]{1,64}$/.test(order)||!items.length||items.some(item=>{const m=item.match(/^([1-9]\d*):([^\r\n\0]+)$/);return!m||!whole(Number(m[1]))||!m[2]!.trim();}))return null;
  return{kind:'service',objective:`settle exact owned handoff ${order} ${JSON.stringify(args)}${env.HANDOFF_ITEM_ID?' plain item ID '+env.HANDOFF_ITEM_ID:''}; reconcile donor debit and receiver bank credit`,units:1};
 }
 if(script==='scripts/aio.ts'){
  const category=args[0],entry=category&&['skiller','fighter','boss','pvp','quester','market','logistics'].includes(category)?category:args[1];
  if(entry)return intentForEntry('scripts/aio-'+entry+'.ts',args.slice(entry===category?1:2),env,accept,catalog);
 }
 if(script==='scripts/hp-specialist.ts')return{kind:'train',skill:'hitpoints',targetLevel:99};
 if(script==='scripts/strength-specialist.ts')return{kind:'train',skill:'strength',targetLevel:99};
 if(script==='scripts/defence-specialist.ts')return{kind:'train',skill:'defence',targetLevel:99};
 if(script==='scripts/ranged-starter.ts')return{kind:'train',skill:'ranged',targetLevel:5};
 if(script==='scripts/generated/rcair.ts')return{kind:'service',objective:'craft current carried rune essence into air runes once',units:1};
 if(script==='scripts/pvp-kit-stage.ts'){
  const cap=Number(args[0]??1800);
  return whole(cap)&&cap>=1&&cap<=2000?{kind:'acquire',items:{1985:2},consumer}:null;
 }
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
   const raw=args[0];
   const order=raw?JSON.parse(readFileSync(raw,'utf8')):{recipe:env.RECIPE,target:Number(env.TARGET),stringAmulet:env.STRING_AMULET==='1'};
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
 if(script==='scripts/earth-shop.ts'){
  const profile=args[0],cap=Number(args[1]),target=Number(setting(env,args,'STOCK_TARGET')),maximum=Number(setting(env,args,'MAX_ITEMS')),spend=Number(setting(env,args,'MAX_SPEND')),reserve=Number(setting(env,args,'COIN_RESERVE')),seedUsed=Number(setting(env,args,'EARTH_SEED_USED')??0);
  return(profile==='aubury'||profile==='betty')&&[cap,target,maximum,spend,reserve].every(whole)&&[0,1].includes(seedUsed)&&cap>=1&&cap<=16000&&target>=1&&maximum>=1&&maximum<=target
   ?{kind:'acquire',items:{557:target},consumer}:null;
 }
 if(script==='scripts/earth-production.ts'){
  const mode=args[0],cap=Number(args[1]),target=Number(setting(env,args,'STOCK_TARGET')),reserve=Number(setting(env,args,'COIN_RESERVE')),kills=Number(setting(env,args,'HUNT_KILLS_PER_TARGET')??0);
  return(mode==='talismans'||mode==='craft')&&[cap,target,reserve,kills].every(whole)&&cap>=1&&cap<=20000&&target>=1&&kills>=0&&kills<=3
   ?{kind:'acquire',items:{557:target},consumer}:null;
 }
 if(script==='scripts/shop-buyer.ts'){
  const count=Number(setting(env,args,'STOCK_TARGET')??setting(env,args,'MAX_ITEMS')),pattern=setting(env,args,'ITEMS')??(args[0]==='jukat'?'^dragon longsword$':undefined);
  if(!whole(count)||count<1||!pattern)return null;
  let matches:CatalogMethod[]=[];
  try{const re=new RegExp(pattern,'i');matches=(data?.methods??[]).filter(m=>m.step.script===script&&m.step.args[0]===args[0]&&m.step.env.ITEMS&&re.test(m.step.env.ITEMS.replace(/^\^|\$$/g,'').replace(/\\(.)/g,'$1')));}catch{return null;}
  const ids=[...new Set(matches.flatMap(m=>Object.keys(m.effects.items??{})))];
  if(ids.length===1)return{kind:'acquire',items:{[Number(ids[0])]:count},consumer};
  return{kind:'service',objective:`finite shop order ${args[0]??'unknown'} ${pattern} stock ${count} for ${consumer}`};
 }
 if(script==='scripts/chain.ts'){
  const steps=args.map(a=>parseStep(a));if(!steps.length)return null;
  const resolved=steps.map(st=>intentForEntry(st.script,st.args,{...env,...st.env},accept,data));
  if(resolved.some(r=>!r))return null;
  const last=resolved.at(-1)!;
  return last.kind==='service'||last.kind==='observe'?{kind:'service',objective:`chain:${steps.map(s=>s.script).join('+')}`,units:steps.length}:last;
 }
 if(['scripts/fleet-trade.ts','scripts/courier-handoff.ts'].includes(script)){
  const file=args.find(a=>a.endsWith('.json')&&!a.includes('='));return file?{kind:'service',objective:'finite owned order '+file}:null;
 }
 if(script==='scripts/smelt-bars.ts'){
  if(setting(env,args,'ORDER_ACTION')==='smith'||setting(env,args,'PRODUCT_ID')!==undefined){
   const product=Number(setting(env,args,'PRODUCT_ID')),maximum=Number(setting(env,args,'MAX_MAKE'));
   if(whole(product)&&product>0&&whole(maximum)&&maximum>0)return{kind:'service',objective:`smith-anvil:${product}:${maximum}`,units:1};
   return null;
  }
 }
 if(['scripts/microbot-production.ts','scripts/smelt-bars.ts'].includes(script)){
  const recipe=script==='scripts/microbot-production.ts'?args.find(a=>!a.includes('=')&&!/^\d+$/.test(a)):setting(env,args,'BAR_TYPE')??args[1];
  const maximum=Number(setting(env,args,'MAX_MAKE'));
  const method=data?.methods.find(m=>{const job=m.execution?.bankJob;return script==='scripts/microbot-production.ts'?!!job&&job.family==='inventory'&&job.recipe===recipe:m.step.script===script&&m.step.args[1]===recipe;});
  const items=method&&Object.fromEntries(Object.entries(method.effects.items??{}).map(([id,n])=>[id,n*maximum]));
  if(whole(maximum)&&maximum>0&&positiveItems(items))return{kind:'produce',items:items!,consumer};
 }
 if(script==='scripts/smelt-bars.ts'){
  // A smelt order with no product count: its tick cap is the bound.
  const bar=setting(env,args,'BAR_TYPE')??args.find(a=>!/^\d+$/.test(a)&&!a.includes('='))??'bronze';
  const capText=setting(env,args,'CAP')??args.find(a=>/^\d+$/.test(a));
  const cap=capText===undefined?15000:Number(capText);
  if(whole(cap)&&cap>0)return{kind:'service',objective:`smelt:${bar}`,units:1};
 }
 if(script==='scripts/aio-skiller.ts'&&args[0]==='bank-job'){
  try{const raw=args[1]??'';
   const job=JSON.parse(raw.startsWith('--job=')?decodeURIComponent(raw.slice(6)):readFileSync(raw,'utf8'));
   const method=data?.methods.find(m=>{const profile=m.execution?.bankJob;return!!profile&&profile.family===job.family&&profile.recipe===job.recipe;}),skill=method&&Object.keys(method.effects.xp??{})[0];
   if(skill&&finiteLevel(job.targetLevel))return{kind:'train',skill,targetLevel:job.targetLevel};
   const product=method&&Object.keys(method.effects.items??{})[0];if(product&&whole(job.target)&&job.target>0)return{kind:'produce',items:{[Number(product)]:job.target},consumer};
   // A catalog recipe with no product row: the count of the job is the bound.
   if(method&&whole(job.target)&&job.target>0)return{kind:'service',objective:`bank-job:${job.family}:${job.recipe}`,units:job.target};
  }catch{return null;}
 }
 if(script==='scripts/aio-skiller.ts'&&args[0]&&finiteLevel(target))return PROGRESSION_SKILLS.includes(key(args[0]) as typeof PROGRESSION_SKILLS[number])?{kind:'train',skill:key(args[0]),targetLevel:target}:null;
 const quest=data?.quests.find(q=>q.script===script||script==='scripts/quest-sweep.ts'&&args.includes(q.id));
 if(quest)return{kind:'quest',quest:quest.name};
 const singleSkill=matching?.skills.length===1?matching.skills[0]:undefined;
 if(singleSkill&&matching?.intents.includes('train')){
  const positional=routes.find(r=>r.skills.includes(singleSkill))?.name;
  target=Number(setting(env,args,'TARGET_LEVEL')??setting(env,args,'TARGET')??(/agility|runecraft|prayer|alch|splash/.test(positional??'')?args.find(a=>/^\d+$/.test(a)):undefined));
  if(finiteLevel(target))return{kind:'train',skill:singleSkill,targetLevel:target};
 }
 const entryName=(script.startsWith('scripts/')||/^packages\/[^/]+\/src\//.test(script))&&script.endsWith('.ts')
  ?script.replace(/^(?:scripts|packages\/[^/]+\/src)\/|\.ts$/g,''):'';
 if(entryName==='edgeville-woodcut-order'){
  const stall=env.STALL_TICKS===undefined?0:Number(env.STALL_TICKS);
  return whole(stall)?{kind:'train',skill:'woodcutting',targetLevel:36}:null;
 }
 if(entryName==='microbot-magic-items'){
  const mode=args[0]??'',count=Number(args[2]??1),cap=Number(args[3]??200);
  return /^(?:low-alch|high-alch|enchant:\w+|superheat:(?:bronze|iron|silver|steel|gold|mithril|adamantite|runite))$/.test(mode)&&whole(count)&&count>=1&&count<=10000&&whole(cap)&&cap>=1&&cap<=100000
   ?{kind:'service',objective:`magic-items:${mode}:${count}`,units:1}:null;
 }
 if(entryName==='dusty-key')return{kind:'acquire',items:{1590:1},consumer};
 if(entryName==='quest-chain'){const quests=(args[0]||'').split(',').filter(Boolean);if(quests.length)return{kind:'service',objective:'quest-chain:'+quests.join(','),units:quests.length};}
 if(entryName==='goldfarm'){const ticks=Number(env.TICKS??9000);if(whole(ticks)&&ticks>0)return{kind:'service',objective:`goldfarm:${env.KNIGHT_SPOT??'2653,3302'}`,units:1};}
 if(entryName==='gather-feathers'){const feathers=Number(env.TARGET??2000),ticks=Number(env.TICKS??3000);if(whole(feathers)&&feathers>0&&whole(ticks)&&ticks>0)return{kind:'acquire',items:{314:feathers},consumer};}
 if(entryName==='black-dragon-camp'){const kills=Number(setting(env,args,'KILLS')??9);if(whole(kills)&&kills>0)return{kind:'service',objective:'black-dragon-camp',units:kills};}
 if(entryName==='black-dhide-sets')return{kind:'service',objective:'black-dhide-sets',units:1};
 if(entryName==='gather-combat'&&setting(env,args,'GIANT_BURY')==='1'){const kills=Number(setting(env,args,'GIANT_KILLS'));if(whole(kills)&&kills>0)return{kind:'service',objective:'trooper-bury',units:kills};}
 if(entryName==='gather-combat'){
  const combatTarget=setting(env,args,'TARGET')??args[1];
  const capText=setting(env,args,'CAP')??args[0];
  const cap=capText===undefined?6000:Number(capText);
  if(combatTarget&&combatTarget!=='trooper'&&whole(cap)&&cap>0)return{kind:'service',objective:'gather-combat:'+combatTarget,units:1};
  return null;
 }
 if(['microbot-village-fishing','microbot-mining-progressive','microbot-production-progressive','microbot-magic-trip','microbot-pickpocket-trip','microbot-rune-trip','microbot-shade-trip','microbot-loot-trip','microbot-shop-trip','fletch-worker'].includes(entryName)){
  const jobFile=args.find(a=>a.endsWith('.json'));
  if(jobFile||entryName==='microbot-rune-trip')return{kind:'service',objective:`${scriptPath(script)}:${jobFile??'default'}`,units:1};
 }
 if(entryName==='rune-bank-craft'&&args.some(a=>a.startsWith('--staged=')))return{kind:'service',objective:'rune-carriers',units:1};
 if(entryName==='pvp-relog-combat'){
  const capText=setting(env,args,'CAP')??(args[0]==='--companion-tank'?args[4]:undefined);
  const cap=capText===undefined?5000:Number(capText);
  if(whole(cap)&&cap>0&&cap<=20000){
   if(args[0]==='--companion-tank')return{kind:'service',objective:'pvp-relog-tank',units:1};
   return{kind:'service',objective:'pvp-relog-combat:'+(args[0]??'combat'),units:1};
  }
  return null;
 }
 const boundedServiceEntries=new Set([
  'gather-flax','spin-bowstrings','fletch-arrows','gather-fish','cook-food','gather-yews','gather-ore','gather-essence','blood-chest',
  'craft-jewelry','shark-supply','cook-stock','cook-wine','microbot-b-cooking','microbot-glass','druid-meats','goldfarm-stable','microbot-c-stalls',
  'collect-wool','fishcook','microbot-b-fishing','microbot-wine','microbot-b-mining','microbot-mining-drop','microbot-b-mining-loot','microbot-b-jewellery',
  'microbot-c-tanner','soften-clay','microbot-magic-npc','microbot-magic-teleport','microbot-c-orbs','microbot-bones','microbot-a-pickpocket',
  'microbot-b-nature-chest','microbot-c-care','microbot-misc-coffer','microbot-c-qol','grapes','agility-order','magic-order','alch-train','splash-train',
  'train-prayer','microbot-prayer-flick','firemaking-order','firemaking-line','rune-bank-craft','rune-supply',
  'cannon-fight','gather-fire-combat','gather-fire-giants','gather-imps','gather-ranged','microbot-a-ranged-camp','microbot-chompy-trip','microbot-a-chompy',
  'microbot-b-kbd','microbot-trawler-trip','microbot-b-trawler','pvp-kit-stage','buy-owned-sword','sell-owned-ge-item','foodcourier','supply-bootstrap',
  'microbot-c-clues','microbot-c-clue-guardian','microbot-c-clue-puzzle','quest-cook-job','quest-order','quest-items-order','quest-sweep',
  'generated/quest-hero-owned','generated/quest-legends-owned','generated/quest-tbwt-owned','generated/quest-itwatchtower-owned',
  'owned-logistics-entry','ranged-progression-case',
 ]);
 if(boundedServiceEntries.has(entryName)){
  // The entry states its bound: a CAP or TICKS setting, or a count among its positional arguments. No number, a zero
  // or a fraction is no finite goal.
  // A bound in a flag is a stated bound too: quest-order states its time limit as --timeout-ms=<ms>.
  const stated=[setting(env,args,'CAP'),setting(env,args,'TICKS'),...args.filter(a=>/^-?\d+(?:\.\d+)?$/.test(a)),...args.flatMap(a=>/^--timeout-ms=(.*)$/.exec(a)?.[1]??[])].filter(v=>v!==undefined);
  // These nine workers run to their own default tick cap, so a bare entry is finite.
  const defaultCap=['gather-flax','spin-bowstrings','fletch-arrows','gather-fish','cook-food','gather-yews','gather-ore','gather-essence','blood-chest'].includes(entryName);
  if(!stated.length&&!defaultCap||stated.some(v=>!whole(Number(v))||Number(v)<=0))return null;
  const label=args.find(a=>!/^\d+$/.test(a)&&!a.includes('=')&&!a.startsWith('-'))??routes[0]?.id??script;
  return{kind:'service',objective:`${entryName}:${label}`,units:1};
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
