import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {readPracticeSave} from '../fleet-player-save';
import {
 type Child,DRAYNOR_START,FALL_SAMPLE_PLAN,type FallFiles,type FallOutcome,type FallSample,fallSampleAdmitted,
 foodIds,initializationBinding,items,lastLine,musicVarps,type Save,sha256,trainedLevel,
} from './contracts';

export function agilityInitializationChecks(before:Save,after:Save){
 const state=agilitySaveChecks(before,after,1);
 // save-generator omits empty containers. login.rs2 reads/transmits worn (94),
 // Player.getInventory materializes it, and Player.save writes even empty invs.
 // Only absent <-> empty worn is established here. Other new container IDs fail.
 const inventories=[...new Set([...Object.keys(before.inventories),...Object.keys(after.inventories)])].every(id=>{
  const b=before.inventories[Number(id)],a=after.inventories[Number(id)];
  if(!b||!a)return id==='94'&&(b??a)!.length===0;
  const valid=(list:typeof b)=>new Set(list.map(i=>i.slot)).size===list.length;
  return valid(b)&&valid(a)&&b.length===a.length&&b.every(i=>a.some(j=>i.slot===j.slot&&i.id===j.id&&i.count===j.count));
 });
 // Initialization alone may observe ordinary login effects, never quest progress.
 // PlayerLoading/Player.save encode the same int32 as signed v6 / unsigned v9.
 // login.rs2 sets control defaults; music unlocks only gain bits. auto_cast.rs2,
 // pet.rs2 and anti_fire.rs2 reset invalid zero defaults to null. Var 367 lies
 // beyond the generator's 309 varps and inherits Player's typed-null constructor.
 // These allowances do not apply to the subsequent work/refusal preservation.
 const vars=[...new Set([...Object.keys(before.vars),...Object.keys(after.vars)])].every(key=>{
  const id=Number(key),old=before.vars[id]??0,next=after.vars[id]??0;
  if((old>>>0)===(next>>>0))return true;
  if(id===134)return Number.isSafeInteger(next)&&next>=0;
  if(musicVarps.has(id))return ((old&next)>>>0)===(old>>>0);
  if([166,168,169].includes(id))return (before.vars[166]??0)===0&&old===0&&next===2;
  return [59,275,277,367].includes(id)&&old===0&&(next>>>0)===0xffffffff;
 });
 return{assets:state.assets,unchangedSkills:state.skills,hpExperience:state.hpExperience,alive:state.alive,
  inventories,vars,
  skills:JSON.stringify(before.skills)===JSON.stringify(after.skills),
  position:JSON.stringify(before.position)===JSON.stringify(after.position)};
}

// Keep raw differences even for allowed effects. Never use these to grant a pass.
export function agilitySaveDifferences(before:Save,after:Save){
 const b=items(before),a=items(after);
 return {
  position:{before:before.position,after:after.position},
  vars:[...new Set([...Object.keys(before.vars),...Object.keys(after.vars)])].map(Number)
   .map(id=>({id,before:before.vars[id]??0,after:after.vars[id]??0})).filter(v=>v.before!==v.after),
  skills:Array.from({length:Math.max(before.skills.length,after.skills.length)},(_,index)=>({index,before:before.skills[index],after:after.skills[index]}))
   .filter(v=>JSON.stringify(v.before)!==JSON.stringify(v.after)),
  items:[...new Set([...b.keys(),...a.keys()])].map(key=>({key,before:b.get(key)??0,after:a.get(key)??0})).filter(v=>v.before!==v.after),
  containers:[...new Set([...Object.keys(before.inventories),...Object.keys(after.inventories)])]
   .map(Number).map(id=>({id,before:before.inventories[id]??null,after:after.inventories[id]??null}))
   .filter(v=>JSON.stringify(v.before)!==JSON.stringify(v.after)),
 };
}

// gnome_gate.rs2: Femi takes the first southern Stronghold gate Open while femi_help (varp 152) is 0.
// The worker answers "OK then." (femi.rs2 sets 2). Allow only 0 -> 2, only with one receipted Femi
// completed help and the exact force-move destination. Dispatch count is not completion.
export function strongholdGateCrossed(log:string){
 const g=lastLine(log,'AGILITY_ENTRY_GATE'),m=/^(\d+),(\d+),(\d+)$/.exec(String(g?.at??''));
 return !!m&&Number(m[1])===2461&&Number(m[2])===3385&&Number(m[3])===0;
}

export function femiGateVarp(before:Save,after:Save,log:string){
 const old=before.vars[152]??0,next=after.vars[152]??0;
 if(old===next)return true;
 const g=lastLine(log,'AGILITY_ENTRY_GATE');
 if(!g||!Array.isArray(g.choices)||g.choices.length!==1)return false;
 const c=g.choices[0];if(!c||typeof c!=='object')return false;
 const validPage=(p:any)=>!!p&&typeof p==='object'&&typeof p.isOpen==='boolean'&&typeof p.isWaiting==='boolean'
  &&typeof p.text==='string'&&(p.pageId===null||typeof p.pageId==='string'&&p.pageId.length>0)
  &&Array.isArray(p.options)&&p.options.every((o:any)=>!!o&&Number.isSafeInteger(o.index)&&typeof o.text==='string'
   &&(o.componentId===undefined||Number.isSafeInteger(o.componentId)));
 if(!validPage(c.page)||!validPage(c.advanced?.page)||!validPage(c.completed?.page))return false;
 // SDK page tokens also change on resume/wait state. Retirement must change the
 // visible page contents, then femi.rs2's post-varp final thanks must be observed.
 const pageKey=(p:any)=>JSON.stringify([p?.isOpen,p?.text,p?.options]);
 const pick=c.page.options.find((o:any)=>o.index===c.index);
 const tick=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
 return old===0&&next===2&&strongholdGateCrossed(log)&&g.femi===1&&g.choiceAttempts===1
  &&c.reply?.success===true
  &&c.page?.isOpen===true&&c.page?.isWaiting===false&&typeof c.page?.pageId==='string'&&c.page.pageId.length>0
  &&pick?.text==='OK then.'&&Number.isSafeInteger(pick?.componentId)
  &&c.page.options.length===2&&c.page.options.some((o:any)=>o.text==="Sorry, I'm a bit busy.")
  &&tick(c.tick)&&tick(c.advanced?.tick)&&tick(c.completed?.tick)&&tick(g.tick)
  &&c.advanced.tick>c.tick&&c.completed.tick>=c.advanced.tick&&g.tick>=c.completed.tick
  &&pageKey(c.advanced.page)!==pageKey(c.page)
  &&!(c.advanced.page.isOpen&&c.advanced.page.options.some((o:any)=>/^ok then\.?$/i.test(o.text)))
  &&c.completed.page?.isOpen===true&&typeof c.completed.page?.pageId==='string'&&c.completed.page.pageId.length>0
  &&c.completed.page.pageId!==c.page.pageId&&typeof c.completed.page?.text==='string'
  &&c.completed.page.text.split('\n').includes('Thanks again friend!');
}

export function agilitySaveChecks(before:Save,after:Save,target:number,mode:'progress'|'refusal'='progress',except:readonly number[]=[]){
 const b=items(before),a=items(after),keys=new Set([...b.keys(),...a.keys()]);
 const sameAssets=[...keys].every(k=>{const id=Number(k.split(':')[1]),old=b.get(k)??0,next=a.get(k)??0;return k.startsWith('93:')&&foodIds.has(id)?next>=0&&next<=old:next===old;});
 const unchangedSkills=before.skills.every((skill,i)=>i===16||i===3||after.skills[i]?.rawExperience===skill.rawExperience);
 // login_logout/logout.rs2 writes last_logout (134) = map_clock, including refusals.
 // Fixtures are logged in and out before the baseline so login defaults and music unlocks
 // are observed there, rather than exempting quest/other varps from preservation here.
 const unchangedVars=[...new Set([...Object.keys(before.vars),...Object.keys(after.vars)])].every(k=>{
  const id=Number(k),old=before.vars[id]??0,next=after.vars[id]??0;
  if(id===134)return Number.isSafeInteger(next)&&next>=0;
  if(except.includes(id))return true;
  return mode==='progress'&&[173,264,265,266].includes(id)||old===next;
 });
 const agi=after.skills[16],old=before.skills[16];
 const progress=!!agi&&!!old&&agi.rawExperience>old.rawExperience&&trainedLevel(agi.xp)>=target&&trainedLevel(old.xp)<target;
 // Save version, sparse zero varps and the logout timestamp are storage metadata.
 // A refusal still preserves position, every skill and every asset without food allowance.
 const refusal=JSON.stringify(before.position)===JSON.stringify(after.position)
  &&JSON.stringify(before.skills)===JSON.stringify(after.skills)
  &&[...keys].every(k=>(b.get(k)??0)===(a.get(k)??0))&&unchangedVars;
 return{target:mode==='progress'?progress:refusal,assets:sameAssets,skills:unchangedSkills,vars:unchangedVars,
  alive:(after.skills[3]?.level??0)>0,hpExperience:before.skills[3]?.rawExperience===after.skills[3]?.rawExperience};
}

export function interruptionSaveChecks(before:Save,middle:Save,target:number,log:string,engineLog:string,name:string){
 const progress=[...log.matchAll(/^AGILITY_PROGRESS level=\d+ xp=(\d+(?:\.\d+)?) tick=\d+ step=\w+$/gm)];
 const observed=Number(progress.at(-1)?.[1]);
 const lines=engineLog.split(/\r?\n/);
 const timeout=lines.findIndex(l=>l.startsWith(`[LOGOUT DEBUG] Server requesting idle logout for ${name} - `)
  ||l.startsWith(`[LOGOUT DEBUG] Server forcing logout for ${name} - `));
 const removal=lines.findIndex(l=>l===`[LOGOUT DEBUG] Server removePlayer() called for ${name}`);
 const state=agilitySaveChecks(before,middle,target);
 return {abrupt:progress.length>0&&!/^(?:AGILITY_ORDER_RESULT |RESULT |LOGOUT )/m.test(log),
  serverRemoval:timeout>=0&&removal>timeout,
  savedLogout:(middle.vars[134]??0)>(before.vars[134]??0),
  persistedProgress:Number.isFinite(observed)&&middle.skills[16]!.rawExperience>before.skills[16]!.rawExperience
   &&middle.skills[16]!.rawExperience>=observed*10,
  unfinished:trainedLevel(middle.skills[16]!.xp)<target,
  assets:state.assets,skills:state.skills,vars:state.vars,alive:state.alive,hpExperience:state.hpExperience};
}

export function fallRecoveryCheck(log:string){
 const fall=/^AGILITY_RECOVERY fall tick=(\d+) .*?xp=(\d+(?:\.\d+)?)$/m.exec(log);
 if(!fall)return false;
 return [...log.matchAll(/^AGILITY_PROGRESS level=\d+ xp=(\d+(?:\.\d+)?) tick=(\d+) step=\w+$/gm)]
  .some(m=>Number(m[1])>Number(fall[2])&&Number(m[2])>Number(fall[1]));
}

// Source decision: wilderness_course.rs2 fails the ropeswing and log on
// stat_random(agility,200,250) and the stones on (180,250). PlayerOps STAT_RANDOM passes
// when floor(low*(99-l)/98)+floor(high*(l-1)/98)+1 > floor(rand*256). Seven laps from
// 52 to 70 have no fall with p=0.088, so one child is not a fall proof. Delivery
// 1793225435815-2zPEma had 35 XP-earning steps, HP 70->70 and 0 falls: genuine, not missed.
// Sample at most three ordinary level-52 fixtures through the installed CLI. Never force
// RNG, inject a fall or seed a pit. P(three zero-fall samples)=0.0007, which fails explicitly.
const progressXp=(log:string)=>[...log.matchAll(/^AGILITY_PROGRESS level=\d+ xp=(\d+(?:\.\d+)?) tick=\d+ step=\w+$/gm)].map(m=>Number(m[1]));

// Independent saved coordinates, not the worker's success flag or position helper.
export function savedCoursePosition(save:Save,course:'gnome'|'wilderness'){
 const p=save.position;
 return course==='gnome'?p.x>=2465&&p.x<=2495&&p.z>=3410&&p.z<=3445&&p.level>=0&&p.level<=2
  :p.x>=2988&&p.x<=3010&&p.z>=3930&&p.z<=3970&&p.level===0;
}

export function childChecks(meta:Child,log:string,mode:'progress'|'refusal'){
 const resultLine=log.split(/\r?\n/).filter(l=>l.startsWith('AGILITY_ORDER_RESULT ')).at(-1);
 let result:any;try{result=JSON.parse(resultLine?.slice('AGILITY_ORDER_RESULT '.length)??'null');}catch{}
 return{exit:!meta.timedOut&&!meta.interrupted&&(mode==='progress'?meta.code===0:meta.code!==0),
  logout:(log.match(/^LOGOUT logged-out$/gm)??[]).length===1&&!/^WARN .*?(logout|session close)/m.test(log),
  result:mode==='progress'?result?.ok===true&&result?.level>=result?.target&&result?.xpGained>0&&/^RESULT ok /m.test(log):!resultLine&&/^RESULT fail /m.test(log)};
}

// Ordinary scenario predicates for one sample. A fall is judged separately.
export function fallSampleChecks(before:Save,after:Save,log:string,child:Child,name:string){
 const agi=before.skills[16];
 return{...agilitySaveChecks(before,after,FALL_SAMPLE_PLAN.target),...childChecks(child,log,'progress'),
  start:savedCoursePosition(before,'wilderness')&&agi?.level===FALL_SAMPLE_PLAN.startLevel&&trainedLevel(agi.xp)===FALL_SAMPLE_PLAN.startLevel,
  position:savedCoursePosition(after,'wilderness'),
  // logout.rs2 writes last_logout. The worker line alone is not a saved logout.
  savedLogout:(after.vars[134]??0)>(before.vars[134]??0),
  identity:/^[a-z0-9]{1,12}$/i.test(name)&&new RegExp(`^LEDGER .* bot=${name}$`,'m').test(log)};
}

// Without a fall line, every obstacle must have earned XP, the save must hold the last
// observed XP and HP cannot have dropped. Otherwise the worker may have missed a fall.
export function zeroFallObserved(before:Save,after:Save,log:string){
 if(/^AGILITY_RECOVERY fall /m.test(log))return false;
 const xp=progressXp(log);let last=before.skills[16]?.xp??NaN;
 for(const v of xp){if(!(v>last))return false;last=v;}
 return xp.length>0&&after.skills[16]?.xp===last&&(after.skills[3]?.level??0)>=(before.skills[3]?.level??Infinity);
}

export function fallSampleOutcome(checks:Record<string,boolean>,before:Save,after:Save,log:string):FallOutcome{
 if(!Object.values(checks).every(Boolean))return 'failed';
 if(/^AGILITY_RECOVERY fall /m.test(log))return fallRecoveryCheck(log)?'proved':'failed';
 return zeroFallObserved(before,after,log)?'zero-fall':'failed';
}

// Only a fully successful, preserved, logged-out zero-fall sample permits the next one.
// The caller's record is pushed before work starts, so failures stay retained.
export async function sampleFalls(run:(sample:FallSample)=>Promise<void>,elapsedMs:()=>number,samples:FallSample[]){
 for(const [i,fixture] of FALL_SAMPLE_PLAN.fixtures.entries()){
  if(!fallSampleAdmitted(elapsedMs()))throw Error(`fall sample ${i+1} not admitted: native envelope exhausted`);
  const sample:FallSample={index:i+1,fixture,label:`fall-${i+1}`,outcome:'failed'};samples.push(sample);
  try{await run(sample);}catch(error){sample.outcome='failed';sample.error=String(error);throw error;}
  if(sample.outcome==='proved')return samples;
  if(sample.outcome!=='zero-fall')throw Error(`fall sample ${sample.index} failed`);
 }
 throw Error(`fall sample limit ${FALL_SAMPLE_PLAN.limit} exhausted without an observed fall`);
}

export function initializationEvidenceChecks(before:Save,after:Save,log:string,child:Child,name:string){
 return{saveMatched:after.version>=9,readable:true,...agilityInitializationChecks(before,after),
  ...childChecks(child,log,'refusal'),
  child:Number.isSafeInteger(child?.code)&&child.code!==0&&child.timedOut===false&&child.interrupted===false,
  refusal:/^RESULT fail Error: already at target\r?$/m.test(log)&&!/^AGILITY_PROGRESS /m.test(log),
  identity:/^[a-z0-9]{1,12}$/i.test(name)&&(log.match(/^LEDGER .* bot=([^\r\n]+)\r?$/gm)??[]).length===1
   &&log.split(/\r?\n/).some(l=>l.startsWith('LEDGER ')&&l.endsWith(` bot=${name}`)),
  savedLogout:(after.vars[134]??0)>(before.vars[134]??0)};
}

// Both boundaries copy the same saved file without another session or serializer.
// Retained native evidence confirms byte equality. Require that exact link:
// the save reader's projection cannot certify equivalence of unparsed fields.
// Independent read-only check of every retained sample. read() returns undefined for a
// missing or unreadable sample; present() reports any retained file for a label.
export function verifyFallSamples(fall:any,at:number,read:(label:string)=>FallFiles|undefined,present:(label:string)=>boolean,source?:unknown){
 const plan=FALL_SAMPLE_PLAN,samples:any[]=Array.isArray(fall?.samples)?fall.samples:[];
 const checks:Record<string,boolean>={'fall.plan':JSON.stringify(fall?.plan)===JSON.stringify(plan),
  'fall.count':samples.length>=1&&samples.length<=plan.limit,
  'fall.unique':new Set(samples.map(s=>s?.name)).size===samples.length&&new Set(samples.map(s=>s?.fixture)).size===samples.length,
  // A retained sample file beyond the recorded list is an omitted sample.
  'fall.omitted':Array.from({length:plan.limit-samples.length},(_,i)=>`fall-${samples.length+i+1}`).every(l=>!present(l))};
 let previous=-Infinity;
 for(const [i,s] of samples.entries()){
  const key=`fall-${i+1}`,files=read(key),last=i===samples.length-1;
  const order=s?.index===i+1&&s?.fixture===plan.fixtures[i]&&s?.label===key&&typeof s?.name==='string'&&s.name.endsWith(String(s.fixture));
  const fresh=Number.isFinite(s?.at)&&s.at>previous&&s.at<=at&&at-s.at<plan.deadlineMs;previous=s?.at;
  checks[`${key}.order`]=order;checks[`${key}.fresh`]=fresh;checks[`${key}.files`]=!!files;
  if(!files||!order||!s.child){checks[`${key}.outcome`]=false;continue;}
  checks[`${key}.hashes`]=JSON.stringify(files.sha256)===JSON.stringify(s.sha256);
  const init=files.initial,raw=files.initialFiles;
  const expected=raw&&init?.child?initializationEvidenceChecks(raw.before,raw.after,raw.log,init.child,s.name):undefined;
  const binding=raw&&initializationBinding(s.name,s.fixture,source,raw.sha256);
  checks[`${key}.initializationBinding`]=!!source&&!!binding&&isDeepStrictEqual(init?.binding,binding)
   &&isDeepStrictEqual(s.initialization,binding);
  checks[`${key}.initialized`]=!!expected&&init?.name===s.name&&init?.index===s.fixture&&!init?.error&&!init?.captureError
   &&Object.values(expected).every(Boolean)&&isDeepStrictEqual(init?.checks,expected);
  if(expected)for(const [k,v] of Object.entries(expected))checks[`${key}.initial.${k}`]=v;
  checks[`${key}.initialBaseline`]=!!raw&&raw.sha256.after===files.sha256.before;
  const recomputed=fallSampleChecks(files.before,files.after,files.log,s.child,s.name);
  for(const [k,v] of Object.entries(recomputed))checks[`${key}.${k}`]=v;
  const outcome=fallSampleOutcome(recomputed,files.before,files.after,files.log);
  checks[`${key}.outcome`]=outcome===s.outcome&&outcome===(last?'proved':'zero-fall');
 }
 checks.fall=Object.values(checks).every(Boolean);
 return checks;
}

export function readFallSamples(directory:string){
 const paths=(label:string)=>[`${label}-before.sav`,`${label}-after.sav`,`${label}.log`].map(f=>join(directory,f));
 return{present:(label:string)=>paths(label).some(existsSync),
  read:(label:string):FallFiles|undefined=>{try{
   const [b,a,l]=paths(label),index=FALL_SAMPLE_PLAN.fixtures[Number(label.split('-')[1])-1];
   const initial=JSON.parse(readFileSync(join(directory,`initial-${index}.json`),'utf8'));
   const [ib,ia,il]=paths(`initial-${index}`);
   const initialFiles={before:readPracticeSave(ib!),after:readPracticeSave(ia!),log:readFileSync(il!,'utf8'),
    sha256:{before:sha256(readFileSync(ib!)),after:sha256(readFileSync(ia!)),log:sha256(readFileSync(il!))}};
   return{before:readPracticeSave(b!),after:readPracticeSave(a!),log:readFileSync(l!,'utf8'),initial,initialFiles,
    sha256:{before:sha256(readFileSync(b!)),after:sha256(readFileSync(a!)),log:sha256(readFileSync(l!))}};
  }catch{return undefined;}}};
}

// Separate diagnostic evidence. It cannot satisfy Draynor acquisition, fares,
// full interruption/recovery qualification or the native delivery metadata.
export function retainedApproachChecks(before:Save,after:Save,target:number,log:string,child:Child){
 let entry:any;try{entry=JSON.parse(log.split(/\r?\n/).find(l=>l.startsWith('AGILITY_ENTRY '))?.slice('AGILITY_ENTRY '.length)??'null');}catch{}
 const state=agilitySaveChecks(before,after,target,'progress',[152]);
 return {...state,vars:state.vars&&femiGateVarp(before,after,log),...childChecks(child,log,'progress'),
  start:before.position.x===2494&&before.position.z===3437&&before.position.level===0&&before.skills[3]?.level===10,
  entry:entry?.route==='walk'&&entry?.fares===0&&entry?.coinsSpent===0&&entry?.foodBought===0,
  // The retained strip is outside the Stronghold. Only the observed public gate crossing reaches the course.
  gate:strongholdGateCrossed(log),
  position:savedCoursePosition(after,'gnome'),progress:/^AGILITY_PROGRESS /m.test(log)};
}

// Draynor entry: the ordinary Moneyshot-shaped start (Draynor bank, 10 HP, combat 3, carried cash,
// banked cash, no food). Only carried coins and bought food may change; each change must match a
// worker receipt. Music unlock varps (varp.pack musicmulti_1..9) may only gain bits on the new route.
export function draynorEntryChecks(before:Save,after:Save,target:number,log:string){
 const b=items(before),a=items(after),keys=new Set([...b.keys(),...a.keys()]);
 const lines=(tag:string)=>[...log.matchAll(new RegExp(`^${tag} (\\{.*\\})$`,'gm'))].flatMap(m=>{try{return[JSON.parse(m[1]!)];}catch{return[];}});
 const fares=lines('AGILITY_ENTRY_FARE'),purchases=lines('AGILITY_ENTRY_PURCHASE'),entry=lines('AGILITY_ENTRY').at(-1);
 const resultLine=log.split(/\r?\n/).filter(l=>l.startsWith('AGILITY_ORDER_RESULT ')).at(-1);
 let result:any;try{result=JSON.parse(resultLine?.slice('AGILITY_ORDER_RESULT '.length)??'null');}catch{}
 const bought=purchases.reduce((n,p)=>n+(p.bought===1?1:0),0),foodSpent=purchases.reduce((n,p)=>n+(p.bought===1?p.spent:0),0);
 const coinsBefore=b.get('93:995')??0,coinsAfter=a.get('93:995')??0,spent=coinsBefore-coinsAfter;
 const foodBefore=[...b].filter(([k])=>k.startsWith('93:')&&foodIds.has(Number(k.split(':')[1]))).reduce((n,[,v])=>n+v,0);
 const foodAfter=[...a].filter(([k])=>k.startsWith('93:')&&foodIds.has(Number(k.split(':')[1]))).reduce((n,[,v])=>n+v,0);
 const eaten=foodBefore+bought-foodAfter;
 const agi=after.skills[16],old=before.skills[16];
 const receipt={coinsSpent:spent,fares:fares.reduce((n,f)=>n+f.paid,0),foodBought:bought,foodSpent,foodEaten:eaten,eats:result?.eats};
 return{receipt,checks:{
  // No relocated start, seeded food or seeded levels: only Hitpoints has XP (level 10, combat 3).
  start:before.position.x===DRAYNOR_START.x&&before.position.z===DRAYNOR_START.z&&before.position.level===0&&foodBefore===0
   &&coinsBefore>=72&&before.skills.every((skill,i)=>i===3?trainedLevel(skill.xp)===10:skill.rawExperience===0),
  route:entry?.route==='draynor'&&fares.length===2&&fares.every(f=>f.paid===30),
  gate:strongholdGateCrossed(log),
  target:!!agi&&!!old&&agi.rawExperience>old.rawExperience&&trainedLevel(agi.xp)>=target&&trainedLevel(old.xp)<target,
  position:savedCoursePosition(after,'gnome'),
  // Bank and equipment exact. Carried items exact except coins and food.
  assets:[...keys].every(k=>{const id=Number(k.split(':')[1]);return k.startsWith('93:')&&(id===995||foodIds.has(id))||(b.get(k)??0)===(a.get(k)??0);}),
  coins:spent>0&&spent===60+foodSpent&&entry?.coinsSpent===spent&&result?.entry?.coinsSpent===spent,
  food:bought===entry?.foodBought&&eaten>=0&&eaten===result?.eats,
  skills:before.skills.every((skill,i)=>i===16||after.skills[i]?.rawExperience===skill.rawExperience),
  vars:[...new Set([...Object.keys(before.vars),...Object.keys(after.vars)])].every(k=>{
   const id=Number(k),old=before.vars[id]??0,next=after.vars[id]??0;
   if(id===134)return Number.isSafeInteger(next)&&next>=0;
   if(musicVarps.has(id))return ((old&next)>>>0)===(old>>>0);
   if(id===152)return femiGateVarp(before,after,log);
   return [173,264,265,266].includes(id)||old===next;
  }),
  alive:(after.skills[3]?.level??0)>0,
 }};
}
