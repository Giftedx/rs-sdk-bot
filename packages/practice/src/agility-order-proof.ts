// Harness entry only. No game or server work occurs on import or with --verify.
import {readFileSync,writeFileSync,copyFileSync,existsSync,openSync,closeSync,unlinkSync,statSync,mkdirSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {freemem} from 'node:os';
import {isDeepStrictEqual} from 'node:util';
import {startStack} from './stack';
import {createBot} from './bots';
import {applyPreset,PRESETS,type SaveConfig} from './presets';
import {runBotName} from './prove';
import {killTree} from './proc';
import {workerSourceRevision} from '../../core/src/worker-release';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import { FREE_FLOOR_GB, PRACTICE_STARTUP_GB } from '../../core/src/memory';
type Save=ReturnType<typeof readPracticeSave>;
const root=resolve(import.meta.dir,'../../..');
const owned=['scripts/agility-order.ts','scripts/agility-order.test.ts','packages/practice/src/agility-order-proof.ts','packages/practice/test/agility-order-proof.test.ts',
 'packages/core/src/boat.ts','packages/core/test/boat.test.ts','scripts/foodcourier.ts'];
export function sources(){return{runtime:workerSourceRevision(),files:Object.fromEntries([...owned,
 'vendor/rs-sdk/server/engine/src/engine/World.ts','vendor/rs-sdk/server/engine/src/engine/entity/NetworkPlayer.ts',
 'vendor/rs-sdk/server/content/scripts/login_logout/logout.rs2',
 'vendor/rs-sdk/server/content/scripts/areas/area_gnome/scripts/gnome_gate.rs2',
 'vendor/rs-sdk/server/content/scripts/quests/quest_grandtree/scripts/femi.rs2',
 'vendor/rs-sdk/server/content/scripts/player/scripts/consumption/consume.rs2',
 'vendor/rs-sdk/server/content/scripts/player/scripts/consumption/effects/scripts/consume_effects.rs2',
 'vendor/rs-sdk/server/content/scripts/player/configs/consumption/consume_normal.dbrow',
 'vendor/rs-sdk/server/engine/src/network/game/client/handler/OpHeldHandler.ts',
 'vendor/rs-sdk/server/engine/src/network/game/client/handler/OpLocHandler.ts',
 'vendor/rs-sdk/server/engine/src/engine/script/handlers/PlayerOps.ts',
 'vendor/rs-sdk/server/content/scripts/skill_agility/scripts/wilderness_course.rs2',
 'vendor/rs-sdk/server/content/scripts/skill_agility/scripts/gnome_course.rs2',
 'vendor/rs-sdk/server/engine/src/engine/entity/Player.ts',
 'vendor/rs-sdk/server/engine/src/network/game/server/codec/UpdateStatEncoder.ts',
 'vendor/rs-sdk/server/webclient/src/client/Client.ts',
 'vendor/rs-sdk/server/webclient/src/bot/types.ts',
 'vendor/rs-sdk/server/content/scripts/skill_agility/scripts/agility.rs2',
 'vendor/rs-sdk/sdk/index.ts','vendor/rs-sdk/server/webclient/src/bot/dialog-page.ts',
 'vendor/rs-sdk/server/webclient/src/lite/LiteClient.ts',
 'vendor/rs-sdk/server/webclient/src/bot/StateCollector.ts',
].map(p=>[p,createHash('sha256').update(readFileSync(join(root,p))).digest('hex')]))};}
// Save.level is the CURRENT level; an agility potion must never satisfy the trained target.
// Player.ts:77-98 uses level/10 on this server, and stores XP in tenths.
export function trainedLevel(xp:number){let points=0;for(let level=1;level<99;level++){points+=Math.floor(level+300*2**(level/10));if(xp<Math.floor(points/4))return level;}return 99;}
const foodIds=new Set([379,373,385,333,329,361,315,2142,2309,1963,1985]);
function items(s:Save){const out=new Map<string,number>();for(const [inv,list] of Object.entries(s.inventories))for(const i of list){const k=`${inv}:${i.id}`;out.set(k,(out.get(k)??0)+i.count);}return out;}
// Source decision, 2026-10-28: save-generator.ts writes dense v6 zeros (0..308).
// Player's constructor initializes non-int varps to -1; PlayerLoading overwrites
// them with those zeros, then Player.save omits them in v9. The SECOND login
// therefore restores the typed nulls. Seed them before either session instead.
// IDs: content/pack/varp.pack; types: their content/scripts/**/*.varp definitions.
// sa_login starts a 50-tick +100 timer at zero. Start the ordinary fixture at
// sa_max_energy=1000 (skill_combat/configs/combat.constant), not partway to full.
export function agilityFixturePreset(preset:SaveConfig):SaveConfig{
 return {...preset,varps:{4:-1,9:-1,13:-1,16:-1,28:-1,64:-1,181:-1,209:-1,300:1000,...preset.varps}};
}
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
const lastLine=(log:string,tag:string)=>{try{return JSON.parse(log.split(/\r?\n/).filter(l=>l.startsWith(tag+' ')).at(-1)?.slice(tag.length+1)??'null');}catch{return null;}};
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
type Child={code:number;timedOut:boolean;interrupted:boolean};
// Source decision, 2026-10-28: World.processLogouts + NetworkPlayer.decodeIn
// -> restart proof. A killed socket remains owned for 500 ticks (idle), up to
// 1000 ticks (no response). At 150ms the old 30s disk predicate preceded logout.
// Adapt the deadline, require removal AND a saved logout/XP effect, retain failures.
// Do not send a graceful logout or reconnect over that still-owned session.
export function interruptionDeadlineMs(tickMs:number){return 1000*tickMs+15000;}
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
// Fall is not a fixed case: it is the bounded adverse-event sample below, run last.
const cases=['approach','restart','pit','rerun','wilderness-entry'] as const;
type Case=typeof cases[number]|'fall'|'food'|'food-restart'|'ardougne-entry'|'region'|'plane';
const refusalCases=new Set<Case>(['rerun','wilderness-entry','region','plane']);
export function fallRecoveryCheck(log:string){
 const fall=/^AGILITY_RECOVERY fall tick=(\d+) .*?xp=(\d+(?:\.\d+)?)$/m.exec(log);
 if(!fall)return false;
 return [...log.matchAll(/^AGILITY_PROGRESS level=\d+ xp=(\d+(?:\.\d+)?) tick=(\d+) step=\w+$/gm)]
  .some(m=>Number(m[1])>Number(fall[2])&&Number(m[2])>Number(fall[1]));
}
// Source decision, 2026-10-28: wilderness_course.rs2 fails the ropeswing and log on
// stat_random(agility,200,250) and the stones on (180,250). PlayerOps STAT_RANDOM passes
// when floor(low*(99-l)/98)+floor(high*(l-1)/98)+1 > floor(rand*256). Seven laps from
// 52 to 70 have no fall with p=0.088, so one child is not a fall proof. Delivery
// 1793225435815-2zPEma had 35 XP-earning steps, HP 70->70 and 0 falls: genuine, not missed.
// Sample at most three ordinary level-52 fixtures through the installed CLI. Never force
// RNG, inject a fall or seed a pit. P(three zero-fall samples)=0.0007, which fails explicitly.
export const NATIVE_DEADLINE_MS=900000;
const CHILD_TIMEOUT_MS=180000,SAVE_WAIT_MS=15000;
// Envelope from 2zPEma: gate 226s; stack start 3s; fixed cases 150s; fixture init 3s;
// fall child 73s (464 ticks), 93s in VuAuXF (594 ticks); stack stop and verify 2s.
// Admit a sample only if its worst case (initial child + save wait, course child + save
// wait) and cleanup still fit the harness deadline. Typical: about 330s for three samples.
export const FALL_SAMPLE_PLAN={limit:3,fixtures:[5,8,9],course:'wilderness',startLevel:52,target:70,
 childTimeoutMs:CHILD_TIMEOUT_MS,saveWaitMs:SAVE_WAIT_MS,sampleWorstMs:2*(CHILD_TIMEOUT_MS+SAVE_WAIT_MS),
 cleanupReserveMs:30000,deadlineMs:NATIVE_DEADLINE_MS} as const;
export const NATIVE_FORMAT='agility-native-fall-sample-2';
// Existing fixture initialization and retained native bytes -> installed Agility
// consumer: recompute raw proof, rather than reuse recorded success flags.
export const INITIALIZATION_CONFIGURATION={server:'localhost:8888',tickMs:150,course:'gnome',target:1,
 childTimeoutMs:CHILD_TIMEOUT_MS,saveWaitMs:SAVE_WAIT_MS,
 env:{RANDOM_EVENTS:'0',AGI_POTION:'0',AGI_MAX_LAPS:'100',AGI_MAX_TICKS:'2500',AGI_PROGRESS_TICKS:'150',AGI_ENTRY_TICKS:'400'}} as const;
export function fallSampleAdmitted(elapsedMs:number){
 return Number.isFinite(elapsedMs)&&elapsedMs>=0&&elapsedMs+FALL_SAMPLE_PLAN.sampleWorstMs+FALL_SAMPLE_PLAN.cleanupReserveMs<=FALL_SAMPLE_PLAN.deadlineMs;
}
const progressXp=(log:string)=>[...log.matchAll(/^AGILITY_PROGRESS level=\d+ xp=(\d+(?:\.\d+)?) tick=\d+ step=\w+$/gm)].map(m=>Number(m[1]));
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
export type FallOutcome='proved'|'zero-fall'|'failed';
export function fallSampleOutcome(checks:Record<string,boolean>,before:Save,after:Save,log:string):FallOutcome{
 if(!Object.values(checks).every(Boolean))return 'failed';
 if(/^AGILITY_RECOVERY fall /m.test(log))return fallRecoveryCheck(log)?'proved':'failed';
 return zeroFallObserved(before,after,log)?'zero-fall':'failed';
}
export type FallSample={index:number;fixture:number;label:string;outcome:FallOutcome;name?:string;at?:number;error?:string;
 child?:Child;checks?:Record<string,boolean>;sha256?:{before:string;after:string;log:string};[key:string]:unknown};
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
type EvidenceHashes={before:string;after:string;log:string};
type InitializationFiles={before:Save;after:Save;log:string;sha256:EvidenceHashes};
export type FallFiles={before:Save;after:Save;log:string;sha256:EvidenceHashes;initial:any;initialFiles?:InitializationFiles};
export function initializationEvidenceChecks(before:Save,after:Save,log:string,child:Child,name:string){
 return{saveMatched:after.version>=9,readable:true,...agilityInitializationChecks(before,after),
  ...childChecks(child,log,'refusal'),
  child:Number.isSafeInteger(child?.code)&&child.code!==0&&child.timedOut===false&&child.interrupted===false,
  refusal:/^RESULT fail Error: already at target\r?$/m.test(log)&&!/^AGILITY_PROGRESS /m.test(log),
  identity:/^[a-z0-9]{1,12}$/i.test(name)&&(log.match(/^LEDGER .* bot=([^\r\n]+)\r?$/gm)??[]).length===1
   &&log.split(/\r?\n/).some(l=>l.startsWith('LEDGER ')&&l.endsWith(` bot=${name}`)),
  savedLogout:(after.vars[134]??0)>(before.vars[134]??0)};
}
function initializationBinding(name:string,index:number,source:unknown,hashes:EvidenceHashes){
 return{format:'agility-initialization-1',name,index,source,configuration:INITIALIZATION_CONFIGURATION,sha256:hashes};
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
function sha256(bytes:Buffer|string){return createHash('sha256').update(bytes).digest('hex');}
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
export const DRAYNOR_START={x:3092,z:3242,level:0};
const musicVarps=new Set([20,21,22,23,24,25,298,311,346]);
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
// Pinned consume_normal.dbrow heal_12 + consume.rs2 -> installed worker health():
// reuse the ordinary fixture lifecycle; adapt only current HP for a labelled recovery.
// Gnome's first obstacle cannot fall. Target 2 ends after that useful XP effect.
// 10 -> 22 -> 34 -> 46 necessarily requires three consecutive lobster heals.
export const FOOD_RECOVERY_CONFIGURATION={...INITIALIZATION_CONFIGURATION,course:'gnome',target:2,
 label:'depleted-HP recovery fixture; not default entry',fixture:10,position:{x:2474,z:3437,level:0},
 currentHp:10,baseHp:70,foodId:379,foodCount:5,heal:12,effectTicks:8,eatDelayTicks:2,deadlineMs:300000,cleanupReserveMs:30000} as const;
// The same consecutive-heal fixture, saved where the log lands (2474,3429; resumeStep -> net). runAgility's
// pending obstacle is process-local, so a retained mid-course restart reaches health()/settleObstacle with
// pending=null and eats before its first course dispatch. Its settlement is recomputed by sharedSettlementChecks.
export const GNOME_FOOD_RESTART_CONFIGURATION={...FOOD_RECOVERY_CONFIGURATION,
 label:'depleted-HP retained mid-course restart fixture; not default entry',fixture:13,position:{x:2474,z:3429,level:0}} as const;
type FoodConfig=typeof FOOD_RECOVERY_CONFIGURATION|typeof GNOME_FOOD_RESTART_CONFIGURATION;
function traceLines(log:string,prefix:string){return log.split(/\r?\n/).filter(l=>l.startsWith(prefix)).map(l=>{
 const value=JSON.parse(l.slice(prefix.length));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid evidence record');return value;
});}
function foodLines(log:string){return traceLines(log,'AGILITY_FOOD ');}
function actionLines(log:string){return traceLines(log,'AGILITY_ACTION ');}
export function foodRecoveryChecks(before:Save,after:Save,log:string,child:Child,name:string,C:FoodConfig=FOOD_RECOVERY_CONFIGURATION){
 let events:any[]=[];let readable=true;try{events=foodLines(log);}catch{readable=false;}
 const dispatch=events.filter(e=>e.event==='dispatch'),effects=events.filter(e=>e.event==='effect');
 const food=(s:Save)=>(s.inventories[93]??[]).filter(i=>i.id===C.foodId).reduce((n,i)=>n+i.count,0);
 const result=lastLine(log,'AGILITY_ORDER_RESULT');
 const tick=(n:any)=>Number.isSafeInteger(n)&&n>=0;
 const snapshot=(e:any)=>tick(e.tick)&&Number.isSafeInteger(e.hp)&&e.hp>0&&e.baseHp===C.baseHp
  &&Number.isFinite(e.xp)&&Array.isArray(e.inventory)&&new Set(e.inventory.map((i:any)=>i.slot)).size===e.inventory.length
  &&e.inventory.every((i:any)=>Number.isSafeInteger(i.slot)&&Number.isSafeInteger(i.id)&&Number.isSafeInteger(i.count)&&i.count>0)
  &&e.count===e.inventory.filter((i:any)=>i.id===C.foodId).reduce((n:number,i:any)=>n+i.count,0)
  &&Object.hasOwn(e,'anim')&&Object.hasOwn(e,'dialog')&&Array.isArray(e.messages)&&e.rejected===0;
 let order=readable&&dispatch.length===3&&effects.length===3,heals=order,cooldown=order,slots=order;
 let previous:any;
 for(let i=0;i<dispatch.length;i++){
  const d=dispatch[i],seq=i+1,group=events.filter(e=>e.sequence===seq&&e.event!=='cooldown');
  if(!snapshot(d)){order=false;heals=false;slots=false;cooldown=false;continue;}
  const r=group.filter(e=>e.event==='reply'),o=group.filter(e=>e.event==='observation'),e=group.filter(e=>e.event==='effect');
  order&&=d.sequence===seq&&group[0]===d&&r.length===1&&r[0].reply?.success===true&&e.length===1
   &&group.at(-1)===e[0]&&o.length>0&&group.every((v,j)=>snapshot(v)&&v.slot===d.slot&&v.id===C.foodId&&v.held===d.held&&(j===0||v.tick>=group[j-1].tick))
   &&group[1]===r[0]&&group.slice(2,-1).every(v=>v.event==='observation');
  if(!e[0]){heals=false;cooldown=false;slots=false;continue;}
  const effect=e[0],hpFirst=o.find(v=>v.hp>d.hp),debitFirst=o.find(v=>v.count===d.count-1);
  heals&&=d.count===C.foodCount-i&&d.held===d.count&&d.hp===C.currentHp+i*C.heal&&d.xp===before.skills[16]!.xp
   &&effect.hp===d.hp+C.heal&&effect.count===d.count-1&&effect.xp===d.xp
   &&tick(effect.hpTick)&&tick(effect.inventoryTick)&&effect.hpTick===hpFirst?.tick&&effect.inventoryTick===debitFirst?.tick
   &&effect.tick>=d.tick&&effect.tick-d.tick<=C.effectTicks&&effect.hpTick>=d.tick&&effect.inventoryTick>=d.tick;
  const expected=d.inventory.filter((v:any)=>v.slot!==d.slot);
  heals&&=o.every(v=>(v.hp===d.hp||v.hp===d.hp+C.heal)&&(v.count===d.count||v.count===d.count-1)
   &&(v.tick<(hpFirst?.tick??Infinity)||v.hp===d.hp+C.heal)
   &&(v.tick<(debitFirst?.tick??Infinity)||v.count===d.count-1));
  slots&&=d.inventory.some((v:any)=>v.slot===d.slot&&v.id===C.foodId&&v.count===1)
   &&isDeepStrictEqual(expected,effect.inventory)
   &&o.every(v=>isDeepStrictEqual(v.inventory,v.count===d.count?d.inventory:expected))
   &&isDeepStrictEqual(d.inventory,i===0?before.inventories[93]:previous?.inventory);
  if(previous){
   const c=events.filter(v=>v.sequence===seq&&v.event==='cooldown');
   cooldown&&=c.length===1&&c[0].lastEffectTick===previous.tick&&c[0].tick===previous.tick
    &&c[0].readyAfter===previous.tick+C.eatDelayTicks&&d.tick>c[0].readyAfter
    &&d.tick<=c[0].readyAfter+2&&events.indexOf(c[0])>events.indexOf(previous)&&events.indexOf(c[0])<events.indexOf(d);
  }
  previous=effect;
 }
 const state=agilitySaveChecks(before,after,C.target);
 return{...state,...childChecks(child,log,'progress'),readable,
  start:isDeepStrictEqual(before.position,C.position)&&before.skills[3]?.level===C.currentHp
   &&trainedLevel(before.skills[3]!.xp)===C.baseHp&&before.skills[16]?.rawExperience===0&&food(before)===C.foodCount,
  identity:/^[a-z0-9]{1,12}$/i.test(name)&&(log.match(/^LEDGER .* bot=([^\r\n]+)$/gm)??[]).length===1
   &&new RegExp(`^LEDGER .* bot=${name}$`,'m').test(log),
  order,heals,cooldown,slots,
  events:events.every(e=>Number.isSafeInteger(e.sequence)&&e.sequence>=1&&e.sequence<=3
   &&['dispatch','reply','observation','effect','cooldown'].includes(e.event))
   &&events.filter(e=>e.event==='cooldown').length===2,
  debit:food(before)-food(after)===3&&result?.eats===3,
  savedHp:after.skills[3]?.level===C.currentHp+3*C.heal,
  savedInventory:!!previous&&isDeepStrictEqual(after.inventories[93],previous.inventory),
  retainedSkills:before.skills.every((s,i)=>i===16||i===3||isDeepStrictEqual(s,after.skills[i])),
  retainedAssets:[...new Set([...Object.keys(before.inventories),...Object.keys(after.inventories)])]
   .every(k=>k==='93'||isDeepStrictEqual(before.inventories[Number(k)],after.inventories[Number(k)])),
  progress:!!previous&&[...log.matchAll(/^AGILITY_PROGRESS level=\d+ xp=(\d+(?:\.\d+)?) tick=(\d+) step=\w+$/gm)]
   .some(m=>Number(m[1])>before.skills[16]!.xp&&Number(m[2])>previous.tick)
   &&result?.course===C.course&&result?.target===C.target,
  savedLogout:(after.vars[134]??0)>(before.vars[134]??0),position:savedCoursePosition(after,'gnome')};
}
// Source decision, 2026-10-29: pinned Wilderness log fall -> pit ladder -> stones, OpHeldHandler and
// P_EXACTMOVE plus retained UVgqj1 ticks550..558 -> installed CLI. Adapt action identity and independently
// recomputed settlement. A labelled ordinary log approach at HP40 permits a natural log fall to HP33.
// That is preparation, not proof of the publication timing: only an observed healthy->low transition
// during anim741 stones movement qualifies. No forced RNG, injected completed action or mechanics edit.
// At most two samples must reach target and logout inside the existing 300s gate after three-heal proof.
export const INFLIGHT_FOOD_CONFIGURATION={...INITIALIZATION_CONFIGURATION,course:'wilderness',target:53,startLevel:52,
 label:'active stones timing fixture; ordinary log approach at reduced HP; natural falls only; not default entry',
 fixtures:[11,12],position:{x:2996,z:3960,level:0},currentHp:40,baseHp:70,foodId:379,foodCount:15,heal:12,
 effectTicks:8,quietTicks:6,settleMaxTicks:40,sampleMinMs:120000} as const;
const INFLIGHT_BASE=['target','assets','skills','vars','alive','hpExperience','exit','logout','result','readable','start','identity','savedLogout','position'] as const;
const integer=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0;
const sampleValue=(v:any)=>({tick:v.tick,at:v.at,anim:v.anim,rejected:v.rejected,mapFlags:v.mapFlags,hp:v.hp,xp:v.xp,ops:v.ops,messages:v.messages});
function samplesValid(samples:any[]){
 return samples.length>0&&samples.every((v,i)=>integer(v?.tick)&&/^\d+,\d+,[0-3]$/.test(v.at)
  &&Number.isSafeInteger(v.anim)&&v.anim>=-1&&integer(v.rejected)&&integer(v.mapFlags)&&integer(v.ops)&&integer(v.hp)&&v.hp>0&&Number.isFinite(v.xp)&&v.xp>=0
  &&Array.isArray(v.messages)&&v.messages.every((m:any)=>integer(m?.tick)&&typeof m.text==='string')
  &&(i===0||v.tick===samples[i-1].tick+1&&v.rejected>=samples[i-1].rejected&&v.mapFlags>=samples[i-1].mapFlags&&v.ops>=samples[i-1].ops&&v.xp>=samples[i-1].xp));
}
// Independent of the worker's quiet/settled decision. Require every tick, including unchanged ticks.
export function settlementEvidence(v:any,d:any,actions:any[]):{settled:boolean;active:boolean}{
 const no={settled:false,active:false},C=INFLIGHT_FOOD_CONFIGURATION;
 if(!v||!Array.isArray(v.marks)||!Array.isArray(v.observations)||!samplesValid(v.marks)||!samplesValid(v.observations))return no;
 const m=v.marks,first=m[0],last=m.at(-1),dispatch=actions.filter(a=>a.event==='dispatch'&&a.ops===v.actionId);
 if(dispatch.length!==1)return no;
 const a=dispatch[0],quiet=m.slice(-C.quietTicks-1);
 const settled=v.settled===true&&v.quiet===C.quietTicks&&v.opsWhileSettling===0&&v.opsSinceDispatch===first.ops-a.ops
  &&integer(v.start)&&integer(v.tick)&&v.tick-v.start<=C.settleMaxTicks&&v.tick>=v.start&&v.dispatchTick===a.tick
  &&a.speculative===false&&a.actionId===a.ops&&v.step===a.step&&v.dispatchAt===a.at
  &&v.dispatchTick<=v.start&&first.tick===v.start&&last.tick===v.tick&&v.tick===d.tick
  &&v.observations[0].tick===a.tick&&isDeepStrictEqual(v.observations[0],sampleValue(a))
  &&m.every((p:any)=>p.ops===first.ops)&&quiet.length===C.quietTicks+1
  &&quiet.every((p:any)=>p.anim===-1&&p.at===last.at&&p.rejected===last.rejected&&p.mapFlags===last.mapFlags&&p.hp===last.hp&&p.xp===last.xp)
  &&last.at===d.at&&last.hp===d.hp&&last.xp===d.xp&&last.ops===d.workerOps&&d.anim===-1
  &&v.rejected===last.rejected-a.rejected
  &&!actions.some(p=>p.event!=='observation'&&p.ops>first.ops&&p.tick>=v.start&&p.tick<=v.tick
   &&!(p.event==='food'&&p.sequence===d.sequence&&p.tick===d.tick&&p.ops===d.workerOps+1));
 if(!settled)return no;
 if(a.step!=='stones')return{settled:true,active:false};
 const raw=[sampleValue(a),...actions.filter(p=>p.event==='observation'&&p.actionId===a.ops&&p.tick<=v.tick).map(sampleValue)];
 // Cross-check nested samples against the separately published ordered observations and operation log.
 if(!isDeepStrictEqual(raw,v.observations)||!isDeepStrictEqual(raw.filter(p=>p.tick>=v.start),m))return no;
 const due=raw.findIndex(p=>p.tick===v.start),prev=raw[due-1],now=raw[due];
 // Stones start at x3002. The normal crossing reaches x2996 only after the last jump.
 const onStones=(p:any)=>p.at.endsWith(',3960,0')&&Number(p.at.split(',')[0])>=2997&&Number(p.at.split(',')[0])<=3002;
 const active=a.locId===2311&&a.x===3001&&a.z===3960&&!!prev&&prev.hp>=C.baseHp/2&&now.hp<C.baseHp/2
  &&now.anim===741&&onStones(now)&&now.tick>a.tick
  &&raw.some(p=>p.tick<=now.tick&&p.messages.some((msg:any)=>msg.tick>=a.tick&&msg.tick<=p.tick&&msg.text==='You carefully start crossing the stepping stones...'))
  &&m.some((p:any)=>onStones(p)&&p.at!==now.at&&p.mapFlags>now.mapFlags&&p.ops===now.ops)
  &&!actions.some(p=>p.event==='dispatch'&&p.speculative===false&&p.ops>a.ops&&p.tick<=v.tick);
 return{settled:true,active};
}
export function inflightFoodChecks(before:Save,after:Save,log:string,child:Child,name:string){
 const C=INFLIGHT_FOOD_CONFIGURATION;
 let events:any[]=[],actions:any[]=[],stream:{kind:string;value:any}[]=[];let readable=true;
 try{events=foodLines(log);actions=actionLines(log);
  stream=log.split(/\r?\n/).flatMap(l=>l.startsWith('AGILITY_FOOD ')?[{kind:'food',value:JSON.parse(l.slice(13))}]
   :l.startsWith('AGILITY_ACTION ')?[{kind:'action',value:JSON.parse(l.slice(15))}]:[]);
 }catch{events=[];actions=[];stream=[];readable=false;}
 const food=(s:Save)=>(s.inventories[93]??[]).filter(i=>i.id===C.foodId).reduce((n,i)=>n+i.count,0);
 const result=lastLine(log,'AGILITY_ORDER_RESULT');
 const falls=[...log.matchAll(/^AGILITY_RECOVERY fall tick=(\d+) /gm)].map(m=>Number(m[1]));
 const dispatch=events.filter(e=>e.event==='dispatch'),effects=events.filter(e=>e.event==='effect');
 let heals=readable&&dispatch.length>=1&&effects.length===dispatch.length,settled=heals,isolation=heals,active=false;
 for(const [i,d] of dispatch.entries()){
  const group=events.filter(e=>e.sequence===i+1),st=group.filter(e=>e.event==='settle');
  const r=group.filter(e=>e.event==='reply'),e=group.filter(e=>e.event==='effect');
  const at=(v:any)=>group.indexOf(v);
  // A settle report precedes its dispatch, observed every quiet tick, and sent no packet.
  const validated=st.map(v=>settlementEvidence(v,d,actions));
  const previous=effects[i-1],actionSince=actions.some(a=>a.event==='dispatch'&&a.tick<=d.tick&&(!previous||a.tick>=previous.tick));
  settled&&=st.length===(actionSince?1:0)&&validated.every(v=>v.settled)&&st.every(v=>at(v)<at(d));
  active||=validated.some(v=>v.active);
  heals&&=d.sequence===i+1&&r.length===1&&r[0].reply?.success===true&&e.length===1&&at(r[0])===at(d)+1&&at(e[0])===group.length-1
   &&d.hp<C.baseHp/2&&d.held===d.count&&d.id===C.foodId&&e[0].hp===Math.min(C.baseHp,d.hp+C.heal)&&e[0].hp>d.hp
   &&e[0].count===d.count-1&&e[0].tick>=d.tick&&e[0].tick-d.tick<=C.effectTicks&&Number.isSafeInteger(e[0].hpTick)&&Number.isSafeInteger(e[0].inventoryTick);
  // Only the eat was sent between dispatch and effect, and the server refused nothing in that window.
  isolation&&=d.ops===0&&d.rejected===0&&group.filter(v=>v.event==='observation'||v.event==='effect').every(v=>v.ops===1&&v.rejected===0);
  const observations=group.filter(v=>v.event==='observation'),effect=e[0],expected=Array.isArray(d.inventory)?d.inventory.filter((v:any)=>v.slot!==d.slot):[];
  heals&&=Array.isArray(d.inventory)&&d.inventory.some((v:any)=>v.slot===d.slot&&v.id===C.foodId&&v.count===1)
   &&isDeepStrictEqual(d.inventory,previous?.inventory??before.inventories[93])&&!!effect
   &&isDeepStrictEqual(effect.inventory,expected)&&effect.hpTick===observations.find(v=>v.hp>d.hp)?.tick
   &&effect.inventoryTick===observations.find(v=>v.count===d.count-1)?.tick
   &&observations.length>0&&group.filter(v=>!['settle','cooldown'].includes(v.event)).every((v,j,list)=>integer(v.tick)&&(j===0||v.tick>=list[j-1].tick)
    &&v.id===d.id&&v.slot===d.slot&&v.held===d.held&&v.xp===d.xp&&v.baseHp===C.baseHp
    &&v.count===(v.inventory??[]).filter((item:any)=>item.id===C.foodId).reduce((n:number,item:any)=>n+item.count,0))
   &&observations.every(v=>(v.hp===d.hp||v.hp===Math.min(C.baseHp,d.hp+C.heal))
    &&isDeepStrictEqual(v.inventory,v.count===d.count?d.inventory:expected));
  isolation&&=group.filter(v=>v.event==='reply'||v.event==='observation'||v.event==='effect')
   .every(v=>v.workerOps===d.workerOps+1&&v.ops===1&&v.rejected===0)
   &&actions.filter(a=>a.event==='food'&&a.sequence===d.sequence&&a.tick===d.tick&&a.ops===d.workerOps+1).length===1
   &&!actions.some(a=>a.event!=='observation'&&a.ops>d.workerOps+1&&a.tick<=effect?.tick&&a.tick>=d.tick);
  const line=(kind:string,event:string)=>stream.findIndex(v=>v.kind===kind&&v.value.event===event&&v.value.sequence===d.sequence);
  isolation&&=line('food','dispatch')<line('action','food')&&line('action','food')<line('food','reply');
 }
 const last=effects.at(-1);
 const state=agilitySaveChecks(before,after,C.target),agi=before.skills[16];
 return{...state,...childChecks(child,log,'progress'),readable,
  start:isDeepStrictEqual(before.position,C.position)&&before.skills[3]?.level===C.currentHp&&trainedLevel(before.skills[3]!.xp)===C.baseHp
   &&agi?.level===C.startLevel&&trainedLevel(agi.xp)===C.startLevel&&food(before)===C.foodCount,
  identity:/^[a-z0-9]{1,12}$/i.test(name)&&(log.match(/^LEDGER .* bot=([^\r\n]+)$/gm)??[]).length===1&&new RegExp(`^LEDGER .* bot=${name}$`,'m').test(log),
  savedLogout:(after.vars[134]??0)>(before.vars[134]??0),position:savedCoursePosition(after,'wilderness'),
  fallBeforeFood:falls.length>=1&&!!dispatch[0]&&falls[0]!<=dispatch[0].tick,
  // A completed fall/pit landing and a speculative pending label cannot prove active stones timing.
  inflight:active,
  settled,heals,isolation,
  actions:actions.length>0&&actions.every((a,i)=>integer(a.tick)&&integer(a.ops)&&['dispatch','observation','food','modal'].includes(a.event)
   &&(i===0||a.tick>=actions[i-1].tick&&a.ops>=actions[i-1].ops))
   &&actions.filter(a=>a.event!=='observation').every((a,i,list)=>a.ops===i+1),
  traceOrder:stream.length>0&&stream.every((v,i)=>integer(v.value.tick)&&(i===0||v.value.tick>=stream[i-1].value.tick)),
  events:events.every(e=>Number.isSafeInteger(e.sequence)&&e.sequence>=1&&['settle','dispatch','reply','observation','effect','cooldown'].includes(e.event)),
  debit:food(before)-food(after)===effects.length&&result?.eats===effects.length,
  savedInventory:!!last&&isDeepStrictEqual(after.inventories[93],last.inventory),
  savedHp:after.skills[3]?.level===result?.finalHp&&result.finalHp>0,
  progress:!!last&&[...log.matchAll(/^AGILITY_PROGRESS level=\d+ xp=(\d+(?:\.\d+)?) tick=(\d+) step=\w+$/gm)]
   .some(m=>Number(m[1])>last.xp&&Number(m[2])>last.tick)&&result?.course===C.course&&result?.target===C.target};
}
// A sample without a fall line is only a retained zero-fall sample when every other obstacle earned XP.
export function inflightFoodOutcome(checks:Record<string,boolean>,before:Save,after:Save,log:string):FallOutcome{
 if(/^AGILITY_RECOVERY fall /m.test(log))return Object.values(checks).every(Boolean)?'proved':'failed';
 return INFLIGHT_BASE.every(k=>checks[k])&&!/^AGILITY_FOOD /m.test(log)&&zeroFallObserved(before,after,log)?'zero-fall':'failed';
}
function readInflightSample(directory:string,label:string,fixture:number){
 const [b,a,l]=[`${label}-before.sav`,`${label}-after.sav`,`${label}.log`].map(f=>join(directory,f));
 const [ib,ia,il]=[`initial-${fixture}-before.sav`,`initial-${fixture}-after.sav`,`initial-${fixture}.log`].map(f=>join(directory,f));
 return{before:readPracticeSave(b!),after:readPracticeSave(a!),log:readFileSync(l!,'utf8'),
  sha256:{before:sha256(readFileSync(b!)),after:sha256(readFileSync(a!)),log:sha256(readFileSync(l!))},
  initial:JSON.parse(readFileSync(join(directory,`initial-${fixture}.json`),'utf8')),
  initialFiles:{before:readPracticeSave(ib!),after:readPracticeSave(ia!),log:readFileSync(il!,'utf8'),
   sha256:{before:sha256(readFileSync(ib!)),after:sha256(readFileSync(ia!)),log:sha256(readFileSync(il!))}}};
}
// Independent recomputation from raw CRC-valid bytes and logs. Recorded flags never grant a pass.
export function verifyInflightFood(directory:string,source:unknown){
 const C=INFLIGHT_FOOD_CONFIGURATION,checks:Record<string,boolean>={};
 let meta:any;try{meta=JSON.parse(readFileSync(join(directory,'inflight.json'),'utf8'));}catch{return{'inflight.files':false};}
 const samples:any[]=Array.isArray(meta?.samples)?meta.samples:[];
 checks['inflight.configuration']=isDeepStrictEqual(meta.configuration,C);
 checks['inflight.source']=isDeepStrictEqual(meta.source,source);
 checks['inflight.count']=samples.length>=1&&samples.length<=C.fixtures.length;
 checks['inflight.unique']=new Set(samples.map(s=>s?.name)).size===samples.length;
 checks['inflight.omitted']=C.fixtures.slice(samples.length).every((_,i)=>!existsSync(join(directory,`inflight-${samples.length+i+1}.log`)));
 for(const [i,s] of samples.entries()){
  const key=`inflight-${i+1}`,lastSample=i===samples.length-1;
  const order=s?.index===i+1&&s?.fixture===C.fixtures[i]&&s?.label===key&&typeof s?.name==='string'&&s.name.endsWith(String(s.fixture));
  checks[`${key}.order`]=order;
  let files:ReturnType<typeof readInflightSample>|undefined;try{files=readInflightSample(directory,key,C.fixtures[i]!);}catch{}
  checks[`${key}.files`]=!!files;
  if(!files||!order||!s.child){checks[`${key}.outcome`]=false;continue;}
  checks[`${key}.hashes`]=isDeepStrictEqual(files.sha256,s.sha256);
  const init=initializationEvidenceChecks(files.initialFiles.before,files.initialFiles.after,files.initialFiles.log,files.initial.child,s.name);
  const binding=initializationBinding(s.name,s.fixture,source,files.initialFiles.sha256);
  checks[`${key}.initialized`]=Object.values(init).every(Boolean)&&isDeepStrictEqual(files.initial.checks,init)
   &&files.initial.name===s.name&&files.initial.index===s.fixture&&!files.initial.error&&!files.initial.captureError;
  checks[`${key}.initializationBinding`]=isDeepStrictEqual(files.initial.binding,binding)&&isDeepStrictEqual(s.initialization,binding);
  checks[`${key}.initialBaseline`]=files.initialFiles.sha256.after===files.sha256.before;
  const recomputed=inflightFoodChecks(files.before,files.after,files.log,s.child,s.name);
  for(const [k,v] of Object.entries(recomputed))checks[`${key}.${k}`]=lastSample?v:INFLIGHT_BASE.includes(k as any)?v:true;
  const outcome=inflightFoodOutcome(recomputed,files.before,files.after,files.log);
  checks[`${key}.outcome`]=outcome===s.outcome&&outcome===(lastSample?'proved':'zero-fall');
 }
 checks.inflight=Object.values(checks).every(Boolean);
 return checks;
}
function foodBinding(name:string,source:unknown,child:Child,hashes:EvidenceHashes,initialization:unknown){
 return{name,source,child,configuration:FOOD_RECOVERY_CONFIGURATION,sha256:hashes,initialization};
}
// Raw files are decoded with CRC validation on every verification. Recorded checks never grant a pass.
export function verifyFoodRecovery(directory:string,source:unknown=sources(),requireReport=true):Record<string,boolean>{
 try{
  const meta=JSON.parse(readFileSync(join(directory,'food-recovery.json'),'utf8'));
  const b=join(directory,'food-before.sav'),a=join(directory,'food-after.sav'),l=join(directory,'food.log');
  const hashes={before:sha256(readFileSync(b)),after:sha256(readFileSync(a)),log:sha256(readFileSync(l))};
  const initial=JSON.parse(readFileSync(join(directory,'initial-10.json'),'utf8'));
  const ib=join(directory,'initial-10-before.sav'),ia=join(directory,'initial-10-after.sav'),il=join(directory,'initial-10.log');
  const initHashes={before:sha256(readFileSync(ib)),after:sha256(readFileSync(ia)),log:sha256(readFileSync(il))};
  const binding=initializationBinding(meta.name,10,source,initHashes);
  const initChecks=initializationEvidenceChecks(readPracticeSave(ib),readPracticeSave(ia),readFileSync(il,'utf8'),initial.child,meta.name);
  const checks={files:true,source:isDeepStrictEqual(meta.source,source),configuration:isDeepStrictEqual(meta.configuration,FOOD_RECOVERY_CONFIGURATION),
   binding:isDeepStrictEqual(meta.binding,foodBinding(meta.name,source,meta.child,hashes,binding)),
   initialized:initial.name===meta.name&&initial.index===10&&!initial.error&&!initial.captureError
    &&isDeepStrictEqual(initial.binding,binding)&&isDeepStrictEqual(initial.checks,initChecks)&&Object.values(initChecks).every(Boolean)
    &&hashes.before===initHashes.after,
   ...foodRecoveryChecks(readPracticeSave(b),readPracticeSave(a),readFileSync(l,'utf8'),meta.child,meta.name),
   ...verifyInflightFood(directory,source)};
  if(!requireReport)return checks;
  const report=JSON.parse(readFileSync(join(directory,'consumer.json'),'utf8'));
  return{...checks,report:report.ok===true&&isDeepStrictEqual(report.checks,checks)&&report.name===meta.name
   &&isDeepStrictEqual(report.binding,meta.binding)&&isDeepStrictEqual(report.source,source)
   &&isDeepStrictEqual(report.configuration,FOOD_RECOVERY_CONFIGURATION)};
 }catch{return{files:false};}
}
export function verificationReport(directory:string):{ok:boolean;at:number;scope:string;checks:Record<string,boolean>}{
 try{
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8')),currentSource=sources();
 const checks:Record<string,boolean>={source:JSON.stringify(meta.source)===JSON.stringify(currentSource),
  fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000,
  // Old single-fall metadata has no sample plan and cannot pass as a sample proof.
  format:meta.format===NATIVE_FORMAT,
  cases:JSON.stringify(meta.cases?.map((c:any)=>c.id))===JSON.stringify(cases)};
 const files=readFallSamples(directory);
 for(const [key,value] of Object.entries(verifyFoodRecovery(join(directory,'food-recovery'),currentSource)))checks[`food.${key}`]=value;
 Object.assign(checks,verifyFallSamples(meta.fall,meta.at,files.read,files.present,meta.source));
 for(const id of cases){
  const c=meta.cases?.find((c:any)=>c.id===id);if(!c?.child){checks[id]=false;continue;}
  const before=readPracticeSave(join(directory,`${id}-before.sav`)),after=readPracticeSave(join(directory,`${id}-after.sav`));
  const log=readFileSync(join(directory,`${id}.log`),'utf8'),mode=id==='rerun'||id==='wilderness-entry'?'refusal':'progress';
  for(const [key,value] of Object.entries({...agilitySaveChecks(before,after,c.target,mode),...childChecks(c.child,log,mode)}))checks[`${id}.${key}`]=value;
  if(mode==='progress')checks[`${id}.position`]=savedCoursePosition(after,id==='approach'||id==='restart'?'gnome':'wilderness');
  if(id==='approach')checks.away=before.position.x===2460&&before.position.z===3445;
  if(id==='pit')checks.pit=before.position.z===10363&&after.position.z<4000&&/AGILITY_RECOVERY pit/.test(log);
  if(id==='restart'){
   const interrupted=readFileSync(join(directory,'interrupted.log'),'utf8');
   const middle=readPracticeSave(join(directory,'interrupted.sav'));
   checks.interrupted=c.interrupted?.interrupted===true&&!c.interrupted?.timedOut&&c.interrupted?.code!==0;
   const engineLog=readFileSync(join(directory,'interrupted-engine.log'),'utf8');
   for(const [key,value] of Object.entries(interruptionSaveChecks(before,middle,c.target,interrupted,engineLog,c.name)))checks[`restart.${key}`]=value;
   checks.retainedProgress=middle.skills[16]!.rawExperience>before.skills[16]!.rawExperience&&after.skills[16]!.rawExperience>middle.skills[16]!.rawExperience;
  }
  if(id==='rerun')checks.rerun=/already at target/.test(log)&&!/AGILITY_PROGRESS/.test(log);
  if(id==='wilderness-entry')checks.entry=/wilderness requires entry level 52/.test(log)&&!/AGILITY_PROGRESS/.test(log);
 }
 const report={ok:Object.values(checks).every(Boolean),at:Date.now(),scope:'Native fixture Agility orders at 150ms/25x. No live, record, speed or unattended claim.',checks};
 return report;
 }catch{return{ok:false,at:Date.now(),scope:'Native fixture Agility orders at 150ms/25x. No live, record, speed or unattended claim.',checks:{files:false} as Record<string,boolean>};}
}
// Every verification path is read-only. Only run(), which owns generation, publishes reports.
export function verify(directory:string):{ok:boolean;at:number;scope:string;checks:Record<string,boolean>}{
 const report=verificationReport(directory);let matches=false;
 try{const saved=JSON.parse(readFileSync(join(directory,'consumer.json'),'utf8'));
  matches=saved.ok===report.ok&&saved.scope===report.scope&&isDeepStrictEqual(saved.checks,report.checks);
 }catch{}
 return{...report,ok:report.ok&&matches,checks:{...report.checks,report:matches}};
}
// Source decision, 2026-10-29 (build-agility-gnome-consumer-31): pinned gnome_course.rs2 (no damage, fail or
// random), gnome_gate.rs2/femi.rs2, consume_normal.dbrow and the installed worker -> current Gnome consumers.
// Reuse fixture, initialization, child, interruption, food and Femi predicates. Add ordinary Ardougne-town entry,
// restart-state food and Gnome-scoped read-only verification. Wilderness and Barbarian modes keep their own
// adverse predicates and failures; nothing here qualifies them.
export const GNOME_SCOPE='Gnome course only. Native fixture Agility orders at 150ms. No Wilderness or Barbarian qualification, live, record, speed or unattended claim.';
// Every Gnome check runs in one harness pass (at most 2010s of check timeouts).
export const GNOME_FRESH_MS=3600000;
export const GNOME_STEPS=['log','net','branch','rope','treedown','net2','pipe'] as const;
// Course-scope isolation: no Wilderness/Barbarian step, recovery or in-flight trace in a Gnome case.
export function gnomeScope(log:string,mode:'progress'|'refusal'){
 let actions:any[];try{actions=actionLines(log);}catch{return false;}
 const steps=[...log.matchAll(/^AGILITY_PROGRESS level=\d+ xp=\S+ tick=\d+ step=(\w+)\r?$/gm)].map(m=>m[1]!);
 const dispatched=actions.filter(a=>a.event==='dispatch').map(a=>a.step);
 const known=(s:unknown)=>(GNOME_STEPS as readonly unknown[]).includes(s);
 if(/^AGILITY_(RECOVERY|INFLIGHT)/m.test(log))return false;
 if(mode==='refusal')return steps.length===0&&dispatched.length===0;
 return lastLine(log,'AGILITY_ORDER_RESULT')?.course==='gnome'&&steps.length>0&&steps.every(known)&&dispatched.every(known);
}
// Shared health() -> settleObstacle(): a food dispatch after a course dispatch that no settled report retired
// needs exactly one settled report for that sequence; otherwise no report may exist. Recomputed from the
// ordered AGILITY_FOOD/AGILITY_ACTION stream. Each eat is the only packet between its dispatch and reply.
export function sharedSettlementChecks(log:string){
 const no={settlement:false,actions:false,foodActions:false};
 let stream:{kind:'food'|'action';value:any}[];
 try{stream=log.split(/\r?\n/).flatMap((l):{kind:'food'|'action';value:any}[]=>l.startsWith('AGILITY_FOOD ')?[{kind:'food',value:JSON.parse(l.slice(13))}]
  :l.startsWith('AGILITY_ACTION ')?[{kind:'action',value:JSON.parse(l.slice(15))}]:[]);}catch{return no;}
 if(!stream.every(v=>!!v.value&&typeof v.value==='object'&&!Array.isArray(v.value)))return no;
 const actions=stream.filter(v=>v.kind==='action').map(v=>v.value);
 let settlement=true,foodActions=true,pending=false,settles:any[]=[];
 for(const [i,{kind,value:v}] of stream.entries()){
  if(kind==='action'){if(v.event==='dispatch'&&v.speculative===false)pending=true;continue;}
  if(v.event==='settle'){settles.push(v);continue;}
  if(v.event!=='dispatch')continue;
  settlement&&=settles.length===(pending?1:0)&&settles.every(s=>s.sequence===v.sequence&&settlementEvidence(s,v,actions).settled);
  if(settles.length)pending=false;
  settles=[];
  const reply=stream.findIndex((x,j)=>j>i&&x.kind==='food'&&x.value.event==='reply'&&x.value.sequence===v.sequence);
  const between=reply>i?stream.slice(i+1,reply).filter(x=>x.kind==='action'):[];
  foodActions&&=between.length===1&&between[0]!.value.event==='food'&&between[0]!.value.sequence===v.sequence&&between[0]!.value.ops===v.workerOps+1;
 }
 settlement&&=settles.length===0;
 return{settlement,foodActions,actions:actions.length>0&&actions.every((a,i)=>integer(a.tick)&&integer(a.ops)&&['dispatch','observation','food','modal'].includes(a.event)
  &&(i===0||a.tick>=actions[i-1].tick&&a.ops>=actions[i-1].ops))&&actions.filter(a=>a.event!=='observation').every((a,i)=>a.ops===i+1)};
}
export function gnomeFoodChecks(before:Save,after:Save,log:string,child:Child,name:string,C:FoodConfig){
 return{...foodRecoveryChecks(before,after,log,child,name,C),...sharedSettlementChecks(log),scope:gnomeScope(log,'progress')};
}
// Labelled recovery fixture for the ordinary helper start. PickpockDick's dated state (run-overnight-earn-
// pickpockdick-20261028, status 1793191661950): 2654,3283,0, HP10, combat3, Agility1, Thieving99, 16 salmon,
// banked coins and tools, hpMin 2. consume_normal.dbrow heal_9: salmon. Only current HP is reduced.
export const ARDOUGNE_ENTRY_CONFIGURATION={server:'localhost:8888',tickMs:150,course:'gnome',target:10,fixture:14,
 label:'labelled reduced-HP recovery fixture at ordinary Ardougne-town entry; helper dated state; not default entry',
 state:'run-overnight-earn-pickpockdick-20261028 status 1793191661950',
 position:{x:2654,z:3283,level:0},baseHp:10,currentHp:3,foodId:329,foodCount:16,heal:9,effectTicks:8,eatDelayTicks:2,
 skills:{Hitpoints:10,Thieving:99},
 bank:[{id:995,count:836624},{id:1351,count:1},{id:590,count:1},{id:303,count:1},{id:315,count:1},{id:1925,count:1},{id:1931,count:1},
  {id:1265,count:1},{id:1205,count:1},{id:1277,count:1},{id:1171,count:1},{id:841,count:1},{id:882,count:25},{id:556,count:25},
  {id:558,count:15},{id:555,count:6},{id:557,count:4},{id:559,count:2}],
 budget:{entryTicks:1300,maxTicks:1600,timeoutMs:240000}} as const;
type HealConfig={baseHp:number;currentHp:number;foodId:number;heal:number;effectTicks:number;eatDelayTicks:number};
// Ordered, exact food effects for any number of heals: dispatch at low HP, one successful reply, observed
// HP rise (capped at base) and one-item debit, inventory equality and eat-delay cooldown between heals.
export function healSequence(events:any[],before:Save,C:HealConfig){
 const dispatch=events.filter(e=>e.event==='dispatch'),effects=events.filter(e=>e.event==='effect');
 let ok=dispatch.length>=1&&effects.length===dispatch.length,previous:any;
 for(const [i,d] of dispatch.entries()){
  const seq=i+1,group=events.filter(e=>e.sequence===seq&&e.event!=='cooldown'&&e.event!=='settle');
  const r=group.filter(e=>e.event==='reply'),o=group.filter(e=>e.event==='observation'),effect=group.find(e=>e.event==='effect');
  if(!effect||!Array.isArray(d.inventory)){ok=false;continue;}
  ok&&=d.sequence===seq&&group[0]===d&&r.length===1&&group[1]===r[0]&&r[0].reply?.success===true&&group.filter(e=>e.event==='effect').length===1
   &&group.at(-1)===effect&&o.length>0&&group.slice(2,-1).every(v=>v.event==='observation')
   &&d.id===C.foodId&&d.held===d.count&&d.baseHp===C.baseHp&&d.hp<Math.max(8,C.baseHp*0.5)
   &&effect.hp===Math.min(C.baseHp,d.hp+C.heal)&&effect.hp>d.hp&&effect.count===d.count-1
   &&integer(effect.tick)&&effect.tick>=d.tick&&effect.tick-d.tick<=C.effectTicks
   &&effect.hpTick===o.find(v=>v.hp>d.hp)?.tick&&effect.inventoryTick===o.find(v=>v.count===d.count-1)?.tick
   &&group.every((v,j)=>integer(v.tick)&&(j===0||v.tick>=group[j-1].tick)&&v.slot===d.slot&&v.id===d.id&&v.held===d.held&&v.baseHp===C.baseHp)
   &&d.inventory.some((v:any)=>v.slot===d.slot&&v.id===C.foodId&&v.count===1)
   &&isDeepStrictEqual(effect.inventory,d.inventory.filter((v:any)=>v.slot!==d.slot))
   &&isDeepStrictEqual(d.inventory,i===0?before.inventories[93]:previous?.inventory)
   &&o.every(v=>(v.hp===d.hp||v.hp===effect.hp)&&isDeepStrictEqual(v.inventory,v.count===d.count?d.inventory:effect.inventory));
  // Natural regeneration may add HP between login and the first eat; it can never remove the low-HP need.
  if(i===0)ok&&=d.hp>=C.currentHp;
  if(previous){
   const c=events.filter(v=>v.sequence===seq&&v.event==='cooldown');
   ok&&=c.length<=1&&d.tick>previous.tick+C.eatDelayTicks&&(c.length===0||c[0].lastEffectTick===previous.tick&&c[0].readyAfter===previous.tick+C.eatDelayTicks
    &&events.indexOf(c[0])>events.indexOf(previous)&&events.indexOf(c[0])<events.indexOf(d));
  }
  previous=effect;
 }
 return{ok,count:effects.length,last:previous};
}
const savedLogoutOf=(before:Save,after:Save)=>(after.vars[134]??0)>(before.vars[134]??0);
const singleIdentity=(log:string,name:string)=>/^[a-z0-9]{1,12}$/i.test(name)&&(log.match(/^LEDGER .* bot=([^\r\n]+)\r?$/gm)??[]).length===1
 &&log.split(/\r?\n/).some(l=>l.replace(/\r$/,'').startsWith('LEDGER ')&&l.replace(/\r$/,'').endsWith(` bot=${name}`));
// Town -> gate -> Femi -> course: the planned gate route from 2654,3283, observed gate walk, exact crossing
// 2461,3385 with Femi's final thanks, observed course approach, owned-food heals, Agility10 and logout.
export function ardougneEntryChecks(before:Save,after:Save,log:string,child:Child,name:string){
 const A=ARDOUGNE_ENTRY_CONFIGURATION,b=items(before),a=items(after),keys=new Set([...b.keys(),...a.keys()]),foodKey=`93:${A.foodId}`;
 const lines=(tag:string)=>log.split(/\r?\n/).filter(l=>l.startsWith(tag+' ')).flatMap(l=>{try{return[JSON.parse(l.slice(tag.length+1))];}catch{return[];}});
 const route=lines('AGILITY_ENTRY_ROUTE'),entry=lines('AGILITY_ENTRY').at(-1),walks=lines('AGILITY_ENTRY_WALK');
 const result=lastLine(log,'AGILITY_ORDER_RESULT'),at=(tag:string)=>log.split(/\r?\n/).findIndex(l=>l.startsWith(tag+' '));
 let events:any[]=[],readable=true;try{events=foodLines(log);}catch{readable=false;}
 const heals=healSequence(events,before,A);
 const food=(s:Save)=>(s.inventories[93]??[]).filter(i=>i.id===A.foodId).reduce((n,i)=>n+i.count,0);
 const reached=(label:string,goal:{x:number;z:number})=>{const w=walks.filter(v=>v?.label===label).at(-1)?.current;
  return w?.ok===true&&w.at?.level===0&&d8(w.at,goal)<=1;};
 const agi=after.skills[16],old=before.skills[16];
 return{...childChecks(child,log,'progress'),readable,
  start:isDeepStrictEqual(before.position,A.position)&&before.skills[3]?.level===A.currentHp&&trainedLevel(before.skills[3]!.xp)===A.baseHp
   &&A.currentHp<Math.max(8,A.baseHp*0.5)&&old?.rawExperience===0&&food(before)===A.foodCount&&trainedLevel(before.skills[17]?.xp??0)===99,
  route:route.length===1&&route[0].route==='gate'&&route[0].at==='2654,3283,0'&&entry?.route==='walk'&&entry.fares===0&&entry.coinsSpent===0
   &&entry.foodBought===0&&!/^AGILITY_ENTRY_(FARE|PURCHASE) /m.test(log)&&at('AGILITY_ENTRY_ROUTE')<at('AGILITY_ENTRY_GATE')&&at('AGILITY_ENTRY_GATE')<at('AGILITY_ENTRY'),
  walk:reached('walk to Stronghold gate',STRONGHOLD_SOUTH)&&reached('course approach',GNOME_START),
  gate:strongholdGateCrossed(log),
  femi:(before.vars[152]??0)===0&&after.vars[152]===2&&femiGateVarp(before,after,log),
  heals:readable&&heals.ok,
  debit:food(before)-food(after)===heals.count&&result?.eats===heals.count&&entry?.eats===heals.count,
  savedHp:after.skills[3]?.level===result?.finalHp&&result.finalHp>A.currentHp&&result.finalHp<=A.baseHp,
  target:!!agi&&!!old&&agi.rawExperience>old.rawExperience&&trainedLevel(agi.xp)>=A.target&&trainedLevel(old.xp)<A.target
   &&result?.course==='gnome'&&result?.target===A.target,
  position:savedCoursePosition(after,'gnome'),
  assets:[...keys].every(k=>k===foodKey?(a.get(k)??0)===(b.get(k)??0)-heals.count:(b.get(k)??0)===(a.get(k)??0)),
  skills:before.skills.every((s,i)=>i===16||after.skills[i]?.rawExperience===s.rawExperience&&(i===3||after.skills[i]?.level===s.level)),
  vars:[...new Set([...Object.keys(before.vars),...Object.keys(after.vars)])].every(k=>{
   const id=Number(k),old=before.vars[id]??0,next=after.vars[id]??0;
   if(id===134)return Number.isSafeInteger(next)&&next>=0;
   if(musicVarps.has(id))return ((old&next)>>>0)===(old>>>0);
   if(id===152)return femiGateVarp(before,after,log);
   return [173,264,265,266].includes(id)||old===next;
  }),
  alive:(after.skills[3]?.level??0)>0,identity:singleIdentity(log,name),savedLogout:savedLogoutOf(before,after),
  ...sharedSettlementChecks(log),scope:gnomeScope(log,'progress')};
}
const STRONGHOLD_SOUTH={x:2461,z:3382},GNOME_START={x:2474,z:3437};
const d8=(p:{x:number;z:number},q:{x:number;z:number})=>Math.max(Math.abs(p.x-q.x),Math.abs(p.z-q.z));
// Fixed scenario lists. A missing, extra, reordered or relabelled case fails; so does any unlisted retained file.
type GnomeCase={label:string;fixture:number|null;course:'gnome'|'wilderness';target:number;start?:{x:number;z:number;level:number};agility?:number;reason?:string;baseline?:string};
export const GNOME_FOOD_PLAN:readonly GnomeCase[]=[{label:'food',fixture:10,course:'gnome',target:2},{label:'food-restart',fixture:13,course:'gnome',target:2}];
export const GNOME_FOOD_CONFIGURATION={format:'agility-gnome-food-1',initialization:INITIALIZATION_CONFIGURATION,
 cases:{food:FOOD_RECOVERY_CONFIGURATION,'food-restart':GNOME_FOOD_RESTART_CONFIGURATION}} as const;
export const ARDOUGNE_PLAN:readonly GnomeCase[]=[{label:'ardougne-entry',fixture:14,course:'gnome',target:10}];
export const ARDOUGNE_CONFIGURATION={format:'agility-ardougne-entry-1',initialization:INITIALIZATION_CONFIGURATION,entry:ARDOUGNE_ENTRY_CONFIGURATION} as const;
export const GNOME_CONSUMER_PLAN:readonly GnomeCase[]=[
 {label:'approach',fixture:1,course:'gnome',target:10,start:{x:2460,z:3445,level:0},agility:1},
 {label:'restart',fixture:2,course:'gnome',target:20,start:{x:2474,z:3437,level:0},agility:1},
 {label:'rerun',fixture:null,course:'gnome',target:10,baseline:'approach',reason:'already at target'},
 {label:'wilderness-entry',fixture:4,course:'wilderness',target:60,start:{x:2998,z:3916,level:0},agility:49,reason:'wilderness requires entry level 52'},
 // Lumbridge (fresh-account region) has no supported Gnome route; the Grand Tree upper floor is an unsupported plane.
 {label:'region',fixture:15,course:'gnome',target:10,start:{x:3222,z:3218,level:0},agility:1,reason:'unsupported gnome entry region: no safe route from here'},
 {label:'plane',fixture:16,course:'gnome',target:10,start:{x:2466,z:3495,level:1},agility:1,reason:'unsupported entry plane'},
];
export const GNOME_CONSUMER_CONFIGURATION={format:'agility-gnome-consumer-2',xpRate:25,initialization:INITIALIZATION_CONFIGURATION,cases:GNOME_CONSUMER_PLAN,
 interruptionDeadlineMs:interruptionDeadlineMs(INITIALIZATION_CONFIGURATION.tickMs)} as const;
const DRAYNOR_PLAN:readonly GnomeCase[]=[{label:'draynor-entry',fixture:6,course:'gnome',target:10}];
const RETAINED_PLAN:readonly GnomeCase[]=[{label:'course-approach',fixture:null,course:'gnome',target:10}];
type CaseFiles={before:Save;after:Save;log:string;sha256:EvidenceHashes};
function readCase(directory:string,label:string):CaseFiles{
 const [b,a,l]=[`${label}-before.sav`,`${label}-after.sav`,`${label}.log`].map(f=>join(directory,f)) as [string,string,string];
 return{before:readPracticeSave(b),after:readPracticeSave(a),log:readFileSync(l,'utf8'),sha256:{before:sha256(readFileSync(b)),after:sha256(readFileSync(a)),log:sha256(readFileSync(l))}};
}
// One case: CRC-read raw files, recorded hashes, freshness, account identity, recomputed initialization and its
// after-save -> case before-save byte binding (or the named baseline), then the case's own recomputed predicates.
function caseEvidence(directory:string,r:any,p:GnomeCase,source:unknown,now:number,baseline:string|undefined,
 recompute:(f:CaseFiles,r:any)=>Record<string,boolean>){
 const c:Record<string,boolean>={};let f:CaseFiles|undefined;
 try{f=readCase(directory,p.label);}catch{}
 c.files=!!f;
 c.plan=!!r&&r.label===p.label&&r.fixture===p.fixture&&r.course===p.course&&r.target===p.target&&typeof r.name==='string'
  &&/^[a-z0-9]{1,12}$/i.test(r.name)&&(p.fixture===null||r.name.endsWith(String(p.fixture)));
 c.fresh=Number.isFinite(r?.at)&&r.at<=now&&now-r.at<GNOME_FRESH_MS;
 c.saved=r?.saveMatched===true&&!r?.error&&!r?.captureError;
 c.child=!!r?.child&&Number.isSafeInteger(r.child.code)&&typeof r.child.timedOut==='boolean'&&typeof r.child.interrupted==='boolean';
 if(!f||!c.plan||!c.child){c.recomputed=false;return{checks:c};}
 c.hashes=isDeepStrictEqual(r.sha256,f.sha256);
 c.identity=singleIdentity(f.log,r.name);
 if(p.fixture===null){c.initialization=r.initialization===null;c.baseline=!!baseline&&baseline===f.sha256.before;}
 else{
  let init=false,base=false;
  try{
   const meta=JSON.parse(readFileSync(join(directory,`initial-${p.fixture}.json`),'utf8'));
   const [ib,ia,il]=[`initial-${p.fixture}-before.sav`,`initial-${p.fixture}-after.sav`,`initial-${p.fixture}.log`].map(x=>join(directory,x)) as [string,string,string];
   const hashes={before:sha256(readFileSync(ib)),after:sha256(readFileSync(ia)),log:sha256(readFileSync(il))};
   const expected=initializationEvidenceChecks(readPracticeSave(ib),readPracticeSave(ia),readFileSync(il,'utf8'),meta.child,r.name);
   const binding=initializationBinding(r.name,p.fixture,source,hashes);
   init=meta.name===r.name&&meta.index===p.fixture&&!meta.error&&!meta.captureError&&Object.values(expected).every(Boolean)
    &&isDeepStrictEqual(meta.checks,expected)&&isDeepStrictEqual(meta.binding,binding)&&isDeepStrictEqual(r.initialization,binding);
   base=hashes.after===f.sha256.before;
  }catch{}
  c.initialization=init;c.baseline=base;
 }
 let recomputed:Record<string,boolean>={};try{recomputed=recompute(f,r);}catch{recomputed={recomputed:false};}
 return{checks:{...c,...recomputed},before:f.sha256.before,after:f.sha256.after};
}
type ModeEvidence={checks:Record<string,boolean>;cases:{label:string;name:unknown;before?:string;after?:string}[]};
function modeEvidence(directory:string,meta:any,plan:readonly GnomeCase[],source:unknown,now:number,
 recompute:(p:GnomeCase,f:CaseFiles,r:any)=>Record<string,boolean>,o:{expected?:{format:string;configuration:unknown};allowed?:string[];baseline?:(p:GnomeCase)=>string|undefined}={}):ModeEvidence{
 const checks:Record<string,boolean>={},list:any[]=Array.isArray(meta?.cases)?meta.cases:[],cases:ModeEvidence['cases']=[];
 if(o.expected){checks.format=meta?.format===o.expected.format;checks.configuration=isDeepStrictEqual(meta?.configuration,o.expected.configuration);}
 checks.source=isDeepStrictEqual(meta?.source,source);
 checks.error=!!meta&&!meta.error;
 checks.cases=isDeepStrictEqual(list.map(c=>c?.label),plan.map(p=>p.label));
 if(o.allowed){
  // An unlisted retained case or initialization file is omitted evidence.
  const allowed=new Set([...o.allowed,...plan.flatMap(p=>[...['-before.sav','-after.sav','.log','.err'].map(s=>p.label+s),
   ...(p.fixture===null?[]:['-before.sav','-after.sav','.log','.err','.json'].map(s=>`initial-${p.fixture}${s}`))])]);
  let names:string[]|undefined;try{names=readdirSync(directory);}catch{}
  checks.omitted=!!names&&names.every(n=>allowed.has(n));
 }
 for(const p of plan){
  const r=list.find(c=>c?.label===p.label);
  const e=caseEvidence(directory,r,p,source,now,o.baseline?.(p),(f,rec)=>recompute(p,f,rec));
  for(const [k,v] of Object.entries(e.checks))checks[`${p.label}.${k}`]=v;
  cases.push({label:p.label,name:r?.name,before:e.before,after:e.after});
 }
 return{checks,cases};
}
function publishedReport(directory:string,checks:Record<string,boolean>,source:unknown){
 try{const r=JSON.parse(readFileSync(join(directory,'consumer.json'),'utf8'));
  return r.ok===true&&r.scope===GNOME_SCOPE&&isDeepStrictEqual(r.source,source)&&isDeepStrictEqual(r.checks,checks);}catch{return false;}
}
function readJson(path:string){try{return JSON.parse(readFileSync(path,'utf8'));}catch{return undefined;}}
const missing=(key:string):ModeEvidence=>({checks:{[key]:false},cases:[]});
export function verifyGnomeFood(directory:string,source:unknown,now:number,requireReport=true):ModeEvidence{
 const meta=readJson(join(directory,'gnome-food.json'));if(!meta)return missing('files');
 const r=modeEvidence(directory,meta,GNOME_FOOD_PLAN,source,now,(p,f,c)=>({
  ...gnomeFoodChecks(f.before,f.after,f.log,c.child,c.name,p.label==='food'?FOOD_RECOVERY_CONFIGURATION:GNOME_FOOD_RESTART_CONFIGURATION)}),
  {expected:{format:GNOME_FOOD_CONFIGURATION.format,configuration:GNOME_FOOD_CONFIGURATION},allowed:['gnome-food.json','consumer.json']});
 if(requireReport)r.checks.report=publishedReport(directory,r.checks,source);
 return r;
}
export function verifyArdougneEntry(directory:string,source:unknown,now:number,requireReport=true):ModeEvidence{
 const meta=readJson(join(directory,'ardougne.json'));if(!meta)return missing('files');
 const r=modeEvidence(directory,meta,ARDOUGNE_PLAN,source,now,(_p,f,c)=>ardougneEntryChecks(f.before,f.after,f.log,c.child,c.name),
  {expected:{format:ARDOUGNE_CONFIGURATION.format,configuration:ARDOUGNE_CONFIGURATION},allowed:['ardougne.json','consumer.json']});
 if(requireReport)r.checks.report=publishedReport(directory,r.checks,source);
 return r;
}
const INTERRUPTION_FILES=['interrupted.log','interrupted.err','interrupted.sav','interrupted-at-kill.sav','interrupted-engine.log','interruption.json','restart-prelaunch.sav'];
const RESTART_RAW=['restart-before.sav','interrupted-at-kill.sav','interrupted.sav','restart-prelaunch.sav','interrupted.log','interrupted-engine.log'] as const;
function restartHashes(directory:string){return Object.fromEntries(RESTART_RAW.map(p=>[p,sha256(readFileSync(join(directory,p)))]));}
// Player.save checkpoints may precede the socket kill. World removal persists the
// last completed obstacle, including XP/position changes after the last client line.
// Gnome has no damage or item effects. No other raw skill/current level may change.
function gnomeCheckpoint(before:Save,after:Save,log:string,origin=before){
 const c=agilitySaveChecks(before,after,99),agi=after.skills[16]!;
 // This bounded kill is requested at the first progress line. Replay only
 // dispatched obstacles, including the final in-flight obstacle completing
 // after the socket dies. Never infer an arbitrary increase from later XP.
 const steps=['log','net','branch','rope','treedown','net2','pipe'];
 const ends=[[[2474,3429,0]],[[2473,3424,1],[2474,3424,1]],[[2473,3420,2]],[[2479,3420,2]],
  [[2487,3420,0]],[[2485,3428,0],[2486,3428,0],[2487,3428,0]],[[2484,3437,0],[2487,3437,0]]];
 type Point={raw:number;progress:number;at:string;step?:string};
 const point=(s:Save):Point=>({raw:s.skills[16]!.rawExperience,progress:s.vars[264]??0,at:`${s.position.x},${s.position.z},${s.position.level}`});
 const candidates:Point[]=[point(origin)];let raw=origin.skills[16]!.rawExperience,progress=origin.vars[264]??0,valid=true;
 for(const line of log.split(/\r?\n/)){
  if(line.startsWith('AGILITY_ACTION ')){
   const a=JSON.parse(line.slice('AGILITY_ACTION '.length)),index=steps.indexOf(a.step);
   if(a.xp!==Math.trunc(raw/10))continue;
   candidates.push({raw,progress,at:a.at});
   if(a.event!=='dispatch'||index<0)continue;
   const next=progress+1>=index+1?index+1:progress;
   const earned=([75,75,50,75,50,75,75][index]!+(next===7?390:0))*GNOME_CONSUMER_CONFIGURATION.xpRate;
   for(const p of ends[index]!)candidates.push({raw:raw+earned,progress:next===7?0:next,at:p.join(','),step:a.step});
  }else if(line.startsWith('AGILITY_PROGRESS ')){
   const m=/^AGILITY_PROGRESS level=\d+ xp=(\d+(?:\.\d+)?) tick=\d+ step=(\w+)$/.exec(line);
   const next=m&&candidates.find(p=>p.raw>raw&&Math.trunc(p.raw/10)===Number(m[1])&&p.step===m[2]);
   if(!next){valid=false;break;}raw=next.raw;progress=next.progress;
  }
 }
 const expected=point(after);
 return c.assets&&c.skills&&c.vars&&c.alive&&c.hpExperience&&isDeepStrictEqual(before.inventories,after.inventories)
  &&[265,266].every(id=>(before.vars[id]??0)===(after.vars[id]??0))
  &&before.skills.every((s,i)=>i===16||isDeepStrictEqual(s,after.skills[i]))
  &&agi.rawExperience>=before.skills[16]!.rawExperience&&agi.level===trainedLevel(agi.xp)
  &&valid&&candidates.some(p=>p.raw===expected.raw&&p.progress===expected.progress&&p.at===expected.at);
}
export function restartInitialProjection(save:Save){
 // UPDATE_STAT truncates XP/10. Keep exact raw XP bound by the CRC-checked
 // prelaunch bytes; compare every transmitted skill, including current levels.
 return {position:save.position,skills:save.skills.map(s=>({experience:s.xp,level:s.level,baseLevel:trainedLevel(s.xp)})),
  inventory:save.inventories[93]??[],equipment:save.inventories[94]??[]};
}
function restartBinding(directory:string,name:string,target:number,source:unknown,termination:Child){
 return {format:'agility-restart-2',name,course:'gnome',target,source,configuration:GNOME_CONSUMER_CONFIGURATION,
  termination,sha256:restartHashes(directory)};
}
export function restartChainChecks(directory:string,before:Save,after:Save,log:string,r:any,source:unknown){
 const bytes=(p:string)=>readFileSync(join(directory,p)),save=(p:string)=>readPracticeSave(join(directory,p));
 const atKill=save('interrupted-at-kill.sav'),middle=save('interrupted.sav'),entry=save('restart-prelaunch.sav');
 const interrupted=bytes('interrupted.log').toString('utf8'),engine=bytes('interrupted-engine.log').toString('utf8');
 const record=readJson(join(directory,'interruption.json'));
 const binding=restartBinding(directory,r.name,r.target,source,r.interrupted);
 const observations=traceLines(log,'AGILITY_INITIAL '),initial=observations[0];
 const interruptedInitial=traceLines(interrupted,'AGILITY_INITIAL ');
 const firstAction=log.split(/\r?\n/).findIndex(l=>/^AGILITY_(?:ACTION|FOOD|ENTRY|PROGRESS|ORDER_RESULT) /.test(l));
 const initialIndex=log.split(/\r?\n/).findIndex(l=>l.startsWith('AGILITY_INITIAL '));
 const i=interruptionSaveChecks(before,middle,r.target,interrupted,engine,r.name);
 return {...Object.fromEntries(Object.entries(i).map(([k,v])=>[`interruption.${k}`,v])),
  interrupted:r.interrupted?.interrupted===true&&r.interrupted.timedOut===false&&Number.isSafeInteger(r.interrupted.code)&&r.interrupted.code!==0,
  interruptionRecord:!!record&&record.name===r.name&&record.target===r.target&&record.course==='gnome'
   &&isDeepStrictEqual(record.interrupted,r.interrupted)&&record.interruption?.matched===true
   &&isDeepStrictEqual(record.interruption?.checks,i),
  restartBinding:isDeepStrictEqual(record?.restartBinding,binding)&&isDeepStrictEqual(r.restartBinding,binding)
   &&r.interruptionSha256===sha256(bytes('interruption.json')),
  middleBinding:r.middleSha256===sha256(bytes('interrupted.sav')),
  interruptedIdentity:interruptedInitial.length===1&&interruptedInitial[0].name===r.name
   &&interruptedInitial[0].course==='gnome'&&interruptedInitial[0].target===r.target
   &&isDeepStrictEqual(interruptedInitial[0].state,restartInitialProjection(before)),
  killCheckpoint:gnomeCheckpoint(before,atKill,interrupted),
  removalCheckpoint:gnomeCheckpoint(atKill,middle,interrupted,before),
  prelaunch:bytes('interrupted.sav').equals(bytes('restart-prelaunch.sav')),
  initial:observations.length===1&&initial?.name===r.name&&initial.course==='gnome'&&initial.target===r.target
   &&Number.isSafeInteger(initial.tick)&&initial.tick>=0&&initialIndex>=0&&firstAction>initialIndex
   &&isDeepStrictEqual(initial.state,restartInitialProjection(entry)),
  retainedProgress:middle.skills[16]!.rawExperience>before.skills[16]!.rawExperience&&after.skills[16]!.rawExperience>middle.skills[16]!.rawExperience,
  noReseed:Object.values(agilitySaveChecks(entry,after,r.target)).every(Boolean)};
}
export function gnomeConsumerCaseChecks(p:GnomeCase,f:CaseFiles,r:any,directory:string,source?:unknown){
 const {before:b,after:a,log}=f,start=!p.start||isDeepStrictEqual(b.position,p.start)&&b.skills[16]?.level===p.agility&&trainedLevel(b.skills[16]!.xp)===p.agility;
 if(p.reason!==undefined)return{...agilitySaveChecks(b,a,p.target,'refusal'),...childChecks(r.child,log,'refusal'),start,
  reason:log.split(/\r?\n/).some(l=>l.replace(/\r$/,'')===`RESULT fail Error: ${p.reason}`)&&!/^AGILITY_PROGRESS /m.test(log),
  savedLogout:savedLogoutOf(b,a),scope:gnomeScope(log,'refusal')};
 const progress={...agilitySaveChecks(b,a,p.target),...childChecks(r.child,log,'progress'),start,position:savedCoursePosition(a,'gnome'),
  savedLogout:savedLogoutOf(b,a),scope:gnomeScope(log,'progress')};
 if(p.label!=='restart')return progress;
 // Abrupt kill after observed progress, server idle removal, saved useful progress, then the same saved
 // file (no reseed) continues to the higher finite target.
 return{...progress,...restartChainChecks(directory,b,a,log,r,source)};
}
export function verifyGnomeConsumer(directory:string,source:unknown,now:number,requireReport=true):ModeEvidence{
 const meta=readJson(join(directory,'gnome-consumer.json'));if(!meta)return missing('files');
 const r=modeEvidence(directory,meta,GNOME_CONSUMER_PLAN,source,now,(p,f,c)=>gnomeConsumerCaseChecks(p,f,c,directory,source),
  {expected:{format:GNOME_CONSUMER_CONFIGURATION.format,configuration:GNOME_CONSUMER_CONFIGURATION},allowed:['gnome-consumer.json','consumer.json',...INTERRUPTION_FILES],
   baseline:p=>{if(!p.baseline)return undefined;try{return sha256(readFileSync(join(directory,`${p.baseline}-after.sav`)));}catch{return undefined;}}});
 const gnome='vendor/rs-sdk/server/content/scripts/skill_agility/scripts/gnome_course.rs2';
 r.checks.gnomeContent=typeof (source as any)?.files?.[gnome]==='string'
  &&(source as any).files[gnome]===sha256(readFileSync(join(root,gnome)));
 if(requireReport)r.checks.report=publishedReport(directory,r.checks,source);
 return r;
}
// Existing Draynor gate evidence (delivery root): recomputed with the same Draynor predicates and bindings.
export function verifyDraynorEvidence(directory:string,source:unknown,now:number):ModeEvidence{
 const j=readJson(join(directory,'draynor.json'));if(!j)return missing('files');
 const r=modeEvidence(directory,{source:j.source,cases:[j.case]},DRAYNOR_PLAN,source,now,(_p,f,c)=>({...draynorEntryChecks(f.before,f.after,10,f.log).checks,
  ...childChecks(c.child,f.log,'progress'),savedLogout:savedLogoutOf(f.before,f.after),scope:gnomeScope(f.log,'progress')}));
 const rep=readJson(join(directory,'draynor-consumer.json'));
 r.checks.report=rep?.ok===true&&rep.checks?.saveMatched===true&&Object.keys(rep.checks).length>1
  &&Object.entries(rep.checks).every(([k,v])=>k==='saveMatched'||r.checks[`draynor-entry.${k}`]===v);
 return r;
}
// Existing retained eastern-entry gate: exact original bytes, no fixture initialization. The save comes from
// another server run, so its logout clock is not comparable; the child logout line is required instead.
export function verifyRetainedApproachEvidence(directory:string,source:unknown,now:number):ModeEvidence{
 const j=readJson(join(directory,'course-approach.json'));if(!j)return missing('files');
 const r=modeEvidence(directory,{source:j.source,cases:[j]},RETAINED_PLAN,source,now,
  (_p,f,c)=>({...retainedApproachChecks(f.before,f.after,10,f.log,c.child),scope:gnomeScope(f.log,'progress')}),
  {baseline:()=>{try{const h=sha256(readFileSync(String(j.original)));return h===j.originalSha256?h:undefined;}catch{return undefined;}}});
 r.checks.report=j.ok===true&&j.checks?.saveMatched===true&&j.checks?.originalPreserved===true
  &&Object.entries(j.checks).every(([k,v])=>k==='saveMatched'||k==='originalPreserved'||r.checks[`course-approach.${k}`]===v);
 return r;
}
// Read-only: reads every required raw file and published report; never writes, renames or deletes.
export function verifyGnome(directory:string,source:unknown=sources(),now=Date.now()){
 const checks:Record<string,boolean>={},all:{key:string;name:unknown;before?:string}[]=[];
 for(const [key,e] of [['gnome-food',verifyGnomeFood(join(directory,'gnome-food'),source,now)],
  ['course-approach',verifyRetainedApproachEvidence(directory,source,now)],['draynor',verifyDraynorEvidence(directory,source,now)],
  ['ardougne',verifyArdougneEntry(join(directory,'ardougne'),source,now)],['consumer',verifyGnomeConsumer(join(directory,'gnome-consumer'),source,now)]] as const){
  for(const [k,v] of Object.entries(e.checks))checks[`${key}.${k}`]=v;
  for(const c of e.cases)all.push({key:`${key}.${c.label}`,name:c.name,before:c.before});
 }
 // One account per scenario (the target refusal reuses the approach account) and no duplicated start bytes.
 const names=all.filter(c=>c.key!=='consumer.rerun').map(c=>c.name);
 checks.uniqueAccounts=names.every(n=>typeof n==='string')&&new Set(names).size===names.length
  &&all.find(c=>c.key==='consumer.rerun')?.name===all.find(c=>c.key==='consumer.approach')?.name;
 const starts=all.map(c=>c.before);
 checks.uniqueStarts=starts.every(s=>typeof s==='string')&&new Set(starts).size===starts.length;
 return{ok:Object.values(checks).every(Boolean),at:now,scope:GNOME_SCOPE,checks};
}
async function child(directory:string,label:string,name:string,course:string,target:number,interrupt=false,budget:{entryTicks?:number;maxTicks?:number;timeoutMs?:number}={}):Promise<Child>{
 if(freemem()/2**30<FREE_FLOOR_GB)throw Error('practice memory floor reached before child');
 const log=join(directory,label+'.log');writeFileSync(log,'');
 const proc=Bun.spawn(['bun','scripts/agility-order.ts',name,course,String(target)],{cwd:root,env:{...process.env,DEMO_OK:'',...INITIALIZATION_CONFIGURATION.env,AGI_MAX_TICKS:String(budget.maxTicks??2500),AGI_ENTRY_TICKS:String(budget.entryTicks??400)},stdout:Bun.file(log),stderr:Bun.file(join(directory,label+'.err')),windowsHide:true});
 let timedOut=false,interrupted=false,termination:Promise<void>|undefined;
 const timer=setTimeout(()=>{timedOut=true;termination=killTree(proc.pid);},budget.timeoutMs??CHILD_TIMEOUT_MS);
 const memory=setInterval(()=>{if(freemem()/2**30<FREE_FLOOR_GB&&!termination){timedOut=true;termination=killTree(proc.pid);}},1000);
 try{
  if(interrupt){const deadline=Date.now()+90000;while(proc.exitCode===null&&Date.now()<deadline){if(readFileSync(log,'utf8').includes('AGILITY_PROGRESS ')){interrupted=true;await killTree(proc.pid);break;}await Bun.sleep(50);}if(!interrupted)throw Error('could not interrupt an active order after progress');}
  const code=await proc.exited;return{code,timedOut,interrupted};
 }finally{clearTimeout(timer);clearInterval(memory);if(proc.exitCode===null)await killTree(proc.pid);await termination;}
}
type Mode='full'|'draynor'|'course-approach'|'food-recovery'|'gnome-food'|'ardougne'|'gnome-consumer';
const caseHashes=(directory:string,label:string):EvidenceHashes=>{
 const h=(f:string)=>sha256(existsSync(join(directory,f))?readFileSync(join(directory,f)):'');
 return{before:h(`${label}-before.sav`),after:h(`${label}-after.sav`),log:h(`${label}.log`)};
};
async function run(directory:string,mode:Mode='full',retainedPath?:string){
 const started=performance.now();
 const foodChildBudget=()=>{
  const C=FOOD_RECOVERY_CONFIGURATION,remaining=Math.floor(C.deadlineMs-(performance.now()-started)-C.cleanupReserveMs-SAVE_WAIT_MS);
  if(remaining<1)throw Error('food recovery envelope exhausted; preserving cleanup reserve');
  return{timeoutMs:Math.min(CHILD_TIMEOUT_MS,remaining)};
 };
 const gnomeMode=mode==='gnome-food'||mode==='ardougne'||mode==='gnome-consumer';
 if(mode==='food-recovery'||gnomeMode){directory=join(directory,mode);mkdirSync(directory,{recursive:true});}
 if(freemem()/2**30<FREE_FLOOR_GB)throw Error('insufficient free memory: below the floor');
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');
 writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:mode==='full'?'agility-order':`agility-order-${mode}`}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  const source=sources(),results:any[]=[],falls:FallSample[]=[];
  const tickMs=INITIALIZATION_CONFIGURATION.tickMs;
  stack=await startStack({tickMs,xpRate:GNOME_CONSUMER_CONFIGURATION.xpRate,readyTimeoutMs:60000});
  if(mode==='course-approach'){
   if(!retainedPath)throw Error('course approach requires an explicit retained save');
   const original=resolve(retainedPath),before=readPracticeSave(original),bytes=readFileSync(original);
   if(before.position.x!==2494||before.position.z!==3437||before.position.level!==0||before.skills[3]?.level!==10)
    throw Error('retained ordinary approach state required');
   const name=runBotName('agi',7),botDir=join(root,'vendor/rs-sdk/bots',name);
   const path=join(root,'vendor/rs-sdk/server/engine/data/players/main',name+'.sav');
   if(existsSync(botDir)||existsSync(path))throw Error('fresh diagnostic copy required');
   await createBot(name);
   if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local diagnostic required');
   // Copy exact bytes. No preset, supply seed, relocation or initialization run.
   writeFileSync(path,bytes,{flag:'wx'});copyFileSync(path,join(directory,'course-approach-before.sav'));
   const stamp=statSync(path).mtimeMs,logPath=join(directory,'course-approach.log');
   const record:any={at:Date.now(),source,name,original,originalSha256:createHash('sha256').update(bytes).digest('hex')};
   try{
    record.child=await child(directory,'course-approach',name,'gnome',10);
    const saved=await waitPracticeSave(path,s=>statSync(path).mtimeMs>stamp
     &&Object.values(retainedApproachChecks(before,s,10,readFileSync(logPath,'utf8'),record.child)).every(Boolean),{timeoutMs:15000});
    record.saveMatched=saved.matched;
   }finally{
    copyFileSync(path,join(directory,'course-approach-after.sav'));
    const after=readPracticeSave(path),log=existsSync(logPath)?readFileSync(logPath,'utf8'):'';
    record.checks={saveMatched:record.saveMatched===true,originalPreserved:readFileSync(original).equals(bytes),
     ...(record.child?retainedApproachChecks(before,after,10,log,record.child):{child:false})};
    record.differences=agilitySaveDifferences(before,after);
    record.walks=log.split(/\r?\n/).filter(l=>l.startsWith('AGILITY_ENTRY_WALK '));
    // Evidence fields for --verify-gnome. The gate's checks and meaning are unchanged.
    Object.assign(record,{label:'course-approach',fixture:null,course:'gnome',target:10,initialization:null,sha256:caseHashes(directory,'course-approach')});
    record.ok=Object.values(record.checks).every(Boolean);
    record.scope='Reduced retained-save course approach only. Does not replace Draynor or full delivery.';
    writeFileSync(join(directory,'course-approach.json'),JSON.stringify(record,null,2));
   }
   console.log(JSON.stringify({ok:record.ok,scope:record.scope,checks:record.checks}));return record;
  }
  const fixture=async(index:number,preset:SaveConfig,assets:Pick<SaveConfig,'bank'|'equipment'>={bank:[{id:995,count:12345},{id:1511,count:13}],equipment:[{id:1351,count:1,slot:3}]},recoveryHp?:number)=>{
   const name=runBotName('agi',index),botDir=join(root,'vendor/rs-sdk/bots',name);
   if(existsSync(botDir))throw Error('fresh fixture required');await createBot(name);
   if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local fixture required');
   const path=await applyPreset(name,agilityFixturePreset({...preset,...assets}));
   if(recoveryHp!==undefined){
    // Only this fresh, generated, offline recovery fixture gets depleted HP.
    // Leave trained XP, all other current skills and ordinary supplies untouched.
    const labelled=mode==='food-recovery'&&(index===10&&recoveryHp===FOOD_RECOVERY_CONFIGURATION.currentHp
     ||(INFLIGHT_FOOD_CONFIGURATION.fixtures as readonly number[]).includes(index)&&recoveryHp===INFLIGHT_FOOD_CONFIGURATION.currentHp)
     ||mode==='gnome-food'&&(index===FOOD_RECOVERY_CONFIGURATION.fixture||index===GNOME_FOOD_RESTART_CONFIGURATION.fixture)&&recoveryHp===FOOD_RECOVERY_CONFIGURATION.currentHp
     ||mode==='ardougne'&&index===ARDOUGNE_ENTRY_CONFIGURATION.fixture&&recoveryHp===ARDOUGNE_ENTRY_CONFIGURATION.currentHp;
    if(!labelled)throw Error('invalid recovery fixture');
    const saved=readPracticeSave(path),bytes=readFileSync(path);
    if(saved.version!==6||saved.skills[3]?.level!==(mode==='ardougne'?ARDOUGNE_ENTRY_CONFIGURATION.baseHp:70))throw Error('unexpected generated recovery save');
    bytes.writeUInt8(recoveryHp,32+3*5);bytes.writeUInt32BE(Bun.hash.crc32(bytes.subarray(0,-4))>>>0,bytes.length-4);
    writeFileSync(path,bytes);readPracticeSave(path);
   }
   // Capture source-backed login effects separately. The seeded typed-null subset
   // and special energy have ordinary values. Do not exempt mutations in training.
   copyFileSync(path,join(directory,`initial-${index}-before.sav`));
   const initial=readPracticeSave(path),stamp=statSync(path).mtimeMs;
   let init:Child|undefined,initialized:Awaited<ReturnType<typeof waitPracticeSave>>|undefined;
   let error:string|undefined,checks:Record<string,boolean>={};
   try{
    init=await child(directory,`initial-${index}`,name,INITIALIZATION_CONFIGURATION.course,INITIALIZATION_CONFIGURATION.target,false,
     mode==='food-recovery'||mode==='gnome-food'?foodChildBudget():{});
    initialized=await waitPracticeSave(path,s=>s.version>=9&&statSync(path).mtimeMs>stamp,{timeoutMs:SAVE_WAIT_MS});
   }catch(e){error=String(e);}finally{
    // Retain raw bytes even if CRC/decode or child checks fail. Never restore them.
    let saved:Save|undefined,captureError:string|undefined;
    try{copyFileSync(path,join(directory,`initial-${index}-after.sav`));saved=readPracticeSave(path);}catch(e){captureError=String(e);}
    const logPath=join(directory,`initial-${index}.log`);
    checks=saved&&init?initializationEvidenceChecks(initial,saved,existsSync(logPath)?readFileSync(logPath,'utf8'):'',init,name)
     :{saveMatched:false,readable:false};
    checks.saveMatched=checks.saveMatched&&initialized?.matched===true;
    let binding:ReturnType<typeof initializationBinding>|undefined;
    try{binding=initializationBinding(name,index,source,{
     before:sha256(readFileSync(join(directory,`initial-${index}-before.sav`))),
     after:sha256(readFileSync(join(directory,`initial-${index}-after.sav`))),log:sha256(readFileSync(logPath))});
    }catch(e){captureError??=String(e);checks.readable=false;}
    const report={name,index,child:init??null,checks,error,captureError,
     binding,
     differences:saved?agilitySaveDifferences(initial,saved):null};
    writeFileSync(join(directory,`initial-${index}.json`),JSON.stringify(report,null,2));
    console.log('AGILITY_INITIALIZATION_CHECK '+JSON.stringify(report));
   }
   if(error)throw Error('fixture initialization failed: '+error);
   if(!Object.values(checks).every(Boolean))throw Error('fixture initialization changed player assets, skills or position');
   return{name,path};
  };
  if(mode==='food-recovery'){
   const C=FOOD_RECOVERY_CONFIGURATION;
   const f=await fixture(C.fixture,{position:C.position,skills:{Hitpoints:C.baseHp},
    inventory:Array.from({length:C.foodCount},()=>({id:C.foodId,count:1}))},undefined,C.currentHp);
   copyFileSync(f.path,join(directory,'food-before.sav'));
   const before=readPracticeSave(f.path),stamp=statSync(f.path).mtimeMs;
   const record:any={at:Date.now(),name:f.name,source,configuration:C};
   try{
    record.child=await child(directory,'food',f.name,C.course,C.target,false,foodChildBudget());
    const saved=await waitPracticeSave(f.path,s=>statSync(f.path).mtimeMs>stamp
     &&Object.values(foodRecoveryChecks(before,s,readFileSync(join(directory,'food.log'),'utf8'),record.child,f.name)).every(Boolean),{timeoutMs:SAVE_WAIT_MS});
    record.saveMatched=saved.matched;
   }catch(error){record.error=String(error);}finally{
    copyFileSync(f.path,join(directory,'food-after.sav'));
    const initial=JSON.parse(readFileSync(join(directory,'initial-10.json'),'utf8'));
    const hashes={before:sha256(readFileSync(join(directory,'food-before.sav'))),after:sha256(readFileSync(join(directory,'food-after.sav'))),
     log:sha256(existsSync(join(directory,'food.log'))?readFileSync(join(directory,'food.log')):'')};
    record.binding=foodBinding(f.name,source,record.child,hashes,initial.binding);
    record.differences=agilitySaveDifferences(before,readPracticeSave(join(directory,'food-after.sav')));
    writeFileSync(join(directory,'food-recovery.json'),JSON.stringify(record,null,2));
   }
   // Stop at the first failure: the in-flight case runs only after the consecutive-heal case passes.
   const heals:Record<string,boolean>=record.child?foodRecoveryChecks(before,readPracticeSave(join(directory,'food-after.sav')),
    existsSync(join(directory,'food.log'))?readFileSync(join(directory,'food.log'),'utf8'):'',record.child,f.name):{child:false};
   const I=INFLIGHT_FOOD_CONFIGURATION,inflight:any={configuration:I,source,samples:[]};
   if(record.saveMatched===true&&!record.error&&Object.values(heals).every(Boolean))try{
    for(const [k,index] of I.fixtures.entries()){
     const remaining=C.deadlineMs-(performance.now()-started)-C.cleanupReserveMs;
     if(remaining<I.sampleMinMs)throw Error(`in-flight food sample ${k+1} not admitted: food recovery envelope exhausted`);
     const label=`inflight-${k+1}`,sample:any={index:k+1,fixture:index,label,outcome:'failed'};inflight.samples.push(sample);
     const g=await fixture(index,{...PRESETS.agility_wilderness_52!,position:I.position},undefined,I.currentHp);sample.name=g.name;
     copyFileSync(g.path,join(directory,label+'-before.sav'));
     const start=readPracticeSave(g.path),mtime=statSync(g.path).mtimeMs,logPath=join(directory,label+'.log');
     try{
      sample.child=await child(directory,label,g.name,I.course,I.target,false,foodChildBudget());
      const saved=await waitPracticeSave(g.path,s=>statSync(g.path).mtimeMs>mtime
       &&inflightFoodOutcome(inflightFoodChecks(start,s,readFileSync(logPath,'utf8'),sample.child,g.name),start,s,readFileSync(logPath,'utf8'))!=='failed',{timeoutMs:SAVE_WAIT_MS});
      sample.saveMatched=saved.matched;
     }catch(error){sample.error=String(error);}finally{
      copyFileSync(g.path,join(directory,label+'-after.sav'));
      try{
       const files=readInflightSample(directory,label,index);
       sample.sha256=files.sha256;sample.initialization=files.initial.binding;sample.at=Date.now();
       sample.checks=sample.child?inflightFoodChecks(files.before,files.after,files.log,sample.child,g.name):{child:false};
       sample.outcome=sample.error||sample.saveMatched!==true?'failed':inflightFoodOutcome(sample.checks,files.before,files.after,files.log);
       sample.differences=agilitySaveDifferences(files.before,files.after);
      }catch(error){sample.captureError=String(error);sample.outcome='failed';}
      writeFileSync(join(directory,'inflight.json'),JSON.stringify(inflight,null,2));
      console.log('AGILITY_INFLIGHT_SAMPLE '+JSON.stringify({index:sample.index,name:g.name,outcome:sample.outcome,checks:sample.checks}));
     }
     if(sample.outcome!=='zero-fall')break;
    }
    if(inflight.samples.at(-1)?.outcome!=='proved')throw Error('missing boundary: health becoming due during active stones crossing with animation741 and exactmove feedback');
   }catch(error){inflight.error=String(error);}finally{writeFileSync(join(directory,'inflight.json'),JSON.stringify(inflight,null,2));}
   else{inflight.error='skipped: consecutive-heal case failed';writeFileSync(join(directory,'inflight.json'),JSON.stringify(inflight,null,2));}
   const checks=verifyFoodRecovery(directory,source,false);
   const report={ok:Object.values(checks).every(Boolean),at:Date.now(),name:f.name,source,configuration:C,binding:record.binding,
    scope:'Labelled depleted-HP recovery and labelled in-flight Wilderness food settlement through installed CLI. Not default entry, historical dispatch reconstruction, or live qualification.',checks};
   report.ok=report.ok&&record.saveMatched===true&&!record.error&&!inflight.error;
   writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
  }
  // A fall sample passes its own retained record and file label.
  // A Gnome case may supply its own recomputed save predicate (food, Femi varp) and child budget.
  type Judge=(before:Save,after:Save,log:string,child:Child)=>Record<string,boolean>;
  const scenario=async(id:Case,f:{name:string;path:string},course:string,target:number,sample?:FallSample,
   opts:{judge?:Judge;budget?:{entryTicks?:number;maxTicks?:number;timeoutMs?:number}}={})=>{
   const label=sample?.label??id;
   copyFileSync(f.path,join(directory,label+'-before.sav'));const before=readPracticeSave(f.path),stamp=statSync(f.path).mtimeMs;
   // Record the attempted case before a failed recovery can abort the batch.
   const record:any=sample?Object.assign(sample,{id,name:f.name,target}):{id,label,course,name:f.name,target};if(!sample)results.push(record);
   let interrupted:Child|undefined;
   if(id==='restart'){
    const engineStart=readFileSync(stack!.logs.engine,'utf8').length;
    interrupted=await child(directory,'interrupted',f.name,course,target,true);
    record.interrupted=interrupted;
    copyFileSync(f.path,join(directory,'interrupted-at-kill.sav'));
    const log=readFileSync(join(directory,'interrupted.log'),'utf8'),started=Date.now();
    const engineLog=()=>readFileSync(stack!.logs.engine,'utf8').slice(engineStart).split(/\r?\n/)
     .filter(l=>l.startsWith('[LOGOUT DEBUG]')&&l.includes(`for ${f.name}`)).join('\n');
    try{
     const saved=await waitPracticeSave(f.path,s=>statSync(f.path).mtimeMs>stamp
      &&Object.values(interruptionSaveChecks(before,s,target,log,engineLog(),f.name)).every(Boolean),{timeoutMs:interruptionDeadlineMs(tickMs)});
     record.interruption={matched:saved.matched,elapsedMs:Date.now()-started,reads:saved.reads,lastError:saved.lastError,
      checks:interruptionSaveChecks(before,saved.save,target,log,engineLog(),f.name),differences:agilitySaveDifferences(before,saved.save)};
     if(!saved.matched)throw Error('interruption recovery unobserved: '+JSON.stringify(record.interruption.checks));
     if(!interrupted.interrupted||interrupted.timedOut||interrupted.code===0)throw Error('abrupt child termination unobserved');
    }finally{
     // Preserve bytes and server evidence even if the deadline/predicate fails.
     copyFileSync(f.path,join(directory,'interrupted.sav'));
     writeFileSync(join(directory,'interrupted-engine.log'),engineLog());
     writeFileSync(join(directory,'interruption.json'),JSON.stringify(record,null,2));
    }
   }
   if(id==='restart'){
    // Read the actual engine file, never restore the retained checkpoint. This
    // copy is the last operation on the save before the restarted CLI launch.
    copyFileSync(f.path,join(directory,'restart-prelaunch.sav'));
    readPracticeSave(join(directory,'restart-prelaunch.sav'));
    if(!readFileSync(f.path).equals(readFileSync(join(directory,'interrupted.sav'))))throw Error('restart checkpoint changed before launch');
    record.restartBinding=restartBinding(directory,f.name,target,source,interrupted!);
    writeFileSync(join(directory,'interruption.json'),JSON.stringify(record,null,2));
    record.interruptionSha256=sha256(readFileSync(join(directory,'interruption.json')));
   }
   const result=await child(directory,label,f.name,course,target,false,opts.budget);record.child=result;
   const mode=refusalCases.has(id)?'refusal':'progress';
   const judge=(s:Save)=>opts.judge?opts.judge(before,s,readFileSync(join(directory,label+'.log'),'utf8'),result):agilitySaveChecks(before,s,target,mode);
   const saved=await waitPracticeSave(f.path,s=>statSync(f.path).mtimeMs>stamp&&Object.values(judge(s)).every(Boolean),{timeoutMs:SAVE_WAIT_MS});
   copyFileSync(f.path,join(directory,label+'-after.sav'));
   const saveChecks=judge(saved.save),differences=agilitySaveDifferences(before,saved.save);
   Object.assign(record,{child:result,interrupted,saveMatched:saved.matched,saveChecks,differences});
   console.log('AGILITY_SAVE_CHECK '+JSON.stringify({id:label,checks:saveChecks,differences}));
   // Keep failed bytes, logs and metadata. Stop dependent work at this boundary.
   if(!saved.matched||!Object.values(childChecks(result,readFileSync(join(directory,label+'.log'),'utf8'),mode)).every(Boolean))throw Error(`native scenario failed: ${label}`);
  };
  // Judge the sample from its retained bytes and log, the same way --verify does.
  const fallSample=async(sample:FallSample)=>{
   if(freemem()/2**30<FREE_FLOOR_GB)throw Error('practice memory floor reached before fall sample');
   const f=await fixture(sample.fixture,PRESETS.agility_wilderness_52!);sample.name=f.name;
   await scenario('fall',f,FALL_SAMPLE_PLAN.course,FALL_SAMPLE_PLAN.target,sample);
   const files=readFallSamples(directory).read(sample.label);
   if(!files)throw Error(`fall sample ${sample.index} evidence unreadable`);
   sample.at=Date.now();sample.sha256=files.sha256;
   sample.initialization=files.initial.binding;
   if(files.initialFiles!.sha256.after!==files.sha256.before
    ||!isDeepStrictEqual(files.initial.binding,initializationBinding(f.name,sample.fixture,source,files.initialFiles!.sha256)))
    throw Error(`fall sample ${sample.index} initialization evidence failed`);
   sample.checks=fallSampleChecks(files.before,files.after,files.log,sample.child!,f.name);
   sample.outcome=fallSampleOutcome(sample.checks,files.before,files.after,files.log);
   console.log('AGILITY_FALL_SAMPLE '+JSON.stringify({index:sample.index,name:f.name,outcome:sample.outcome,checks:sample.checks}));
  };
  if(gnomeMode){
   // Bind every attempted case to its raw files and initialization, even after a failure.
   const bind=(r:any,fixture:number|null)=>{
    try{r.fixture=fixture;r.sha256=caseHashes(directory,r.label);r.at=Date.now();
     r.initialization=fixture===null?null:JSON.parse(readFileSync(join(directory,`initial-${fixture}.json`),'utf8')).binding;
     if(r.label==='restart')r.middleSha256=sha256(readFileSync(join(directory,'interrupted.sav')));
    }catch(e){r.captureError=String(e);}
   };
   const [plan,file,configuration,verifyMode]=mode==='gnome-food'?[GNOME_FOOD_PLAN,'gnome-food.json',GNOME_FOOD_CONFIGURATION,verifyGnomeFood] as const
    :mode==='ardougne'?[ARDOUGNE_PLAN,'ardougne.json',ARDOUGNE_CONFIGURATION,verifyArdougneEntry] as const
    :[GNOME_CONSUMER_PLAN,'gnome-consumer.json',GNOME_CONSUMER_CONFIGURATION,verifyGnomeConsumer] as const;
   const meta:any={format:configuration.format,source,configuration,cases:results};
   try{
    if(mode==='gnome-food')for(const C of [FOOD_RECOVERY_CONFIGURATION,GNOME_FOOD_RESTART_CONFIGURATION]){
     const label=C===FOOD_RECOVERY_CONFIGURATION?'food':'food-restart';
     const f=await fixture(C.fixture,{position:C.position,skills:{Hitpoints:C.baseHp},inventory:Array.from({length:C.foodCount},()=>({id:C.foodId,count:1}))},undefined,C.currentHp);
     await scenario(label,f,C.course,C.target,undefined,{judge:(b,s,log,c)=>gnomeFoodChecks(b,s,log,c,f.name,C),budget:foodChildBudget()});
    }
    if(mode==='ardougne'){
     const A=ARDOUGNE_ENTRY_CONFIGURATION;
     const f=await fixture(A.fixture,{position:A.position,skills:A.skills,inventory:Array.from({length:A.foodCount},()=>({id:A.foodId,count:1}))},
      {bank:A.bank.map(i=>({...i})),equipment:[]},A.currentHp);
     await scenario('ardougne-entry',f,A.course,A.target,undefined,{judge:(b,s,log,c)=>ardougneEntryChecks(b,s,log,c,f.name),budget:A.budget});
    }
    if(mode==='gnome-consumer'){
     let approach:{name:string;path:string}|undefined;
     for(const p of GNOME_CONSUMER_PLAN){
      const f=p.fixture===null?approach!:await fixture(p.fixture,{...(p.course==='wilderness'?PRESETS.agility_wilderness_49!:PRESETS.agility_gnome_1!),position:p.start!});
      if(p.label==='approach')approach=f;
      await scenario(p.label as Case,f,p.course,p.target);
     }
    }
   }catch(error){meta.error=String(error);}finally{
    for(const r of results)if(!r.sha256)bind(r,plan.find(p=>p.label===r.label)?.fixture??null);
    meta.at=Date.now();writeFileSync(join(directory,file),JSON.stringify(meta,null,2));
   }
   const checks=verifyMode(directory,source,Date.now(),false).checks;
   const report={ok:Object.values(checks).every(Boolean),at:Date.now(),scope:GNOME_SCOPE,source,checks};
   writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,scope:report.scope,checks}));return report;
  }
  if(mode==='draynor'){
   // Moneyshot-shaped start: default skills (10 HP, combat 3), 440 carried coins, banked cash and
   // logs, no food, Draynor bank. Nothing near the course, no quests, no travel unlocks.
   const id='draynor-entry',target=10;
   const f=await fixture(6,{position:DRAYNOR_START,coins:440},{bank:[{id:995,count:15606},{id:1511,count:13}],equipment:[]});
   copyFileSync(f.path,join(directory,id+'-before.sav'));
   const before=readPracticeSave(f.path),stamp=statSync(f.path).mtimeMs,record:any={id,name:f.name,target};
   const log=()=>existsSync(join(directory,id+'.log'))?readFileSync(join(directory,id+'.log'),'utf8'):'';
   try{
    record.child=await child(directory,id,f.name,'gnome',target,false,{entryTicks:1300,maxTicks:1500,timeoutMs:240000});
    const saved=await waitPracticeSave(f.path,s=>statSync(f.path).mtimeMs>stamp&&Object.values(draynorEntryChecks(before,s,target,log()).checks).every(Boolean),{timeoutMs:15000});
    record.saveMatched=saved.matched;
   }finally{
    // A failed entry keeps its exact saved bytes, raw differences and worker log.
    copyFileSync(f.path,join(directory,id+'-after.sav'));
    const after=readPracticeSave(f.path);
    Object.assign(record,draynorEntryChecks(before,after,target,log()),{differences:agilitySaveDifferences(before,after)});
    if(record.child)record.childChecks=childChecks(record.child,log(),'progress');
    // Evidence fields for --verify-gnome. The gate's checks and meaning are unchanged.
    try{Object.assign(record,{label:id,fixture:6,course:'gnome',at:Date.now(),sha256:caseHashes(directory,id),
     initialization:JSON.parse(readFileSync(join(directory,'initial-6.json'),'utf8')).binding});}catch(e){record.captureError=String(e);}
    writeFileSync(join(directory,'draynor.json'),JSON.stringify({at:Date.now(),source,case:record},null,2));
   }
   const checks:Record<string,boolean>={saveMatched:record.saveMatched===true,...record.checks,...record.childChecks};
   const report={ok:Object.values(checks).every(Boolean),at:Date.now(),scope:'Native fixture Draynor entry to Gnome Agility at 150ms. No live, record, speed or unattended claim. Does not replace the full native delivery.',receipt:record.receipt,checks};
   writeFileSync(join(directory,'draynor-consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
  }
  try{
   const approach=await fixture(1,{...PRESETS.agility_gnome_1!,position:{x:2460,z:3445,level:0}});
   await scenario('approach',approach,'gnome',10);
   const restart=await fixture(2,PRESETS.agility_gnome_1!);await scenario('restart',restart,'gnome',20);
   // A saved landing after a Wilderness fall; no teleport or fixture change after worker entry.
   const pit=await fixture(3,{...PRESETS.agility_wilderness_52!,position:{x:3005,z:10363,level:0},varps:{266:1}});
   await scenario('pit',pit,'wilderness',53);
   await scenario('rerun',approach,'gnome',10);
   const low=await fixture(4,{...PRESETS.agility_wilderness_49!,position:{x:2998,z:3916,level:0}});
   await scenario('wilderness-entry',low,'wilderness',60);
   // Last, so the envelope admission covers everything that remains. An ordinary course
   // start must actually fall and then earn further XP. A seeded pit cannot satisfy it.
   await sampleFalls(fallSample,()=>performance.now(),falls);
  }finally{writeFileSync(join(directory,'native.json'),JSON.stringify({format:NATIVE_FORMAT,at:Date.now(),source,cases:results,
   fall:{plan:FALL_SAMPLE_PLAN,samples:falls}},null,2));}
  const report=verificationReport(directory);
  writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
 }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
}
if(import.meta.main){try{
 if(!process.env.DELIVERY_DIR)throw Error('run through the agility-order delivery harness');
 const directory=resolve(process.env.DELIVERY_DIR);
 const flag=process.argv[2],retained=flag?.startsWith('--course-approach=')?flag.slice('--course-approach='.length):undefined;
 const modes:Record<string,Mode>={'--draynor-entry':'draynor','--food-recovery':'food-recovery','--gnome-food-recovery':'gnome-food',
  '--ardougne-entry':'ardougne','--gnome-consumer':'gnome-consumer'};
 if(flag&&flag!=='--verify'&&flag!=='--verify-gnome'&&!Object.hasOwn(modes,flag)&&retained===undefined)throw Error('unknown agility proof mode');
 const report=flag==='--verify'?verify(directory):flag==='--verify-gnome'?verifyGnome(directory)
  :await run(directory,retained!==undefined?'course-approach':flag?modes[flag]!:'full',retained);
 if(flag==='--verify'||flag==='--verify-gnome')console.log(JSON.stringify(report));
 process.exitCode=report.ok?0:1;
}catch(error){console.error(String(error));process.exitCode=1;}}
