// Harness entry only. Import and --verify never start services or log in.
import {copyFileSync,readFileSync,writeFileSync,mkdirSync,existsSync,openSync,closeSync,unlinkSync,statSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {freemem} from 'node:os';
import {startStack} from './stack';
import {ISOLATED,ISOLATED_ENGINE_ENV,pointBotAt} from './rehearse';
import {createBot} from './bots';
import {applyPreset,type SaveConfig} from './presets';
import {runBotName} from './prove';
import {killTree} from '../../core/src/proc';
import {simBotsDir, simStopFile} from '../../core/src/practice-paths';
import {workerSourceRevision} from '../../core/src/worker-release';
import {readPracticeSave,setPracticeSkills,waitPracticeSave} from './fleet-player-save';
import {verifyCompletedRecoveryDelivery} from './session-recovery-proof';
import { FREE_FLOOR_GB, PRACTICE_STARTUP_GB } from '../../core/src/memory';

type Save=ReturnType<typeof readPracticeSave>;
type Kind=typeof cases[number];
const root=resolve(import.meta.dir,'../../..');
const owned=['scripts/aio-fighter.ts','packages/workers/src/combat/melee-gather.ts','packages/workers/test/combat.test.ts','scripts/quest-sustain.ts','scripts/quest-sustain.test.ts','packages/practice/src/cow-progress-isolated-proof.ts','packages/practice/test/cow-progress-isolated-proof.test.ts'];
const source=()=>({runtime:workerSourceRevision(),files:Object.fromEntries(owned.map(p=>[p,createHash('sha256').update(readFileSync(join(root,p))).digest('hex')]))});
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const DROPS=[1739,526,2132],TROUT=333,SWORD=1277,SHIELD=1171;
const BANK={x:2654,z:3283};
// Swordinhand entry: Attack9/900, Defence20/3200, Strength20/3300, HP19/20 (3385XP) at Ardougne south bank.
export const SWORDINHAND={position:{x:2655,z:3283,level:0},
 skills:[{level:9,xp:900},{level:20,xp:3200},{level:20,xp:3300},{level:19,xp:3385},...Array.from({length:17},()=>({level:1,xp:0}))],
 inventory:[{id:995,count:140},{id:TROUT,count:1},{id:315,count:1},{id:TROUT,count:1},{id:TROUT,count:1},{id:2309,count:1},{id:TROUT,count:1},{id:TROUT,count:1},{id:TROUT,count:1},{id:SWORD,count:1},{id:SHIELD,count:1}],
 equipment:[{id:SWORD,count:1,slot:3},{id:SHIELD,count:1,slot:5}],
 bank:[{id:995,count:25},{id:1351,count:1},{id:590,count:1},{id:303,count:1},{id:1925,count:1},{id:1931,count:1},{id:1265,count:1},{id:1205,count:1},{id:841,count:1},{id:882,count:25},{id:556,count:25},{id:558,count:15},{id:555,count:6},{id:557,count:4},{id:559,count:2},{id:1739,count:8},{id:526,count:8},{id:2132,count:8}]};
export const cases=['nofood','nokit','entry','stopped','partial','restarted'] as const;
// The native fixture follows the finite south-bank consumer, regardless of the parent profile.
export function cowChildConfiguration(name:string,inherited:NodeJS.ProcessEnv=process.env,kind:Kind='entry'){
 return {cmd:['bun','scripts/aio-fighter.ts',name,'cow','1500'],cwd:root,
  env:{...inherited,SERVER:`localhost:${ISOLATED.engine}`,GATEWAY_URL:`ws://localhost:${ISOLATED.gateway}`,DEMO_OK:'',RANDOM_EVENTS:'0',TARGET:'cow',MAX_KILLS:kind==='partial'?'1':'5',TRAIN_SKILL:'Attack',TARGET_LEVEL:'20',COW_BANK_PROFILE:'south',COW_FOOD_MODE:'held'},windowsHide:true};
}
// Source decision: session-recovery-proof.ts releaseStopArtifact -> cow CLI proof
// -> reuse mutation-free retention. Path-based compare/rename/delete has a race.
// Retire stop-test identities permanently; prove resume on an unstopped identity.
// Acceptance: replacement/access-failure tests make zero retention filesystem calls.
type CowStop={path:string;marker:string;ino:bigint;dev:bigint};
export function claimCowStop(path:string,marker:string):CowStop{
 mkdirSync(dirname(path),{recursive:true});
 try{writeFileSync(path,marker,{flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw Error('stop path already exists');throw error;}
 const info=statSync(path,{bigint:true});return {path,marker,ino:info.ino,dev:info.dev};
}
export function retainCowStop(stop:CowStop,_evidence?:string){
 return stop.path;
}
const refusal:Partial<Record<Kind,RegExp>>={nofood:/^RESULT fail .*cow prerequisite: stage2unnoted Trout/m,nokit:/^RESULT fail .*cow prerequisite: missing owned wearable melee weapon/m};
// The cow worker wields the best melee weapon that the pack, the worn gear and the bank hold (reconcileLoadout), so a
// case with no kit holds none: no sword, no dagger, and no axe or pickaxe that can be wielded.
const WIELDABLE=[1205,1265,1351];
export function cowFixture(kind:Kind):SaveConfig{
 const inventory=SWORDINHAND.inventory.filter((i,n)=>kind==='nofood'?i.id!==TROUT||n===1:kind==='nokit'?i.id!==SWORD:true);
 return {position:SWORDINHAND.position,skills:{Attack:9,Defence:20,Strength:20,Hitpoints:20},inventory,
  equipment:SWORDINHAND.equipment.filter(i=>kind!=='nokit'||i.id!==SWORD),bank:SWORDINHAND.bank.filter(i=>kind!=='nokit'||!WIELDABLE.includes(i.id))};
}
const count=(s:Save,container:number,id:number)=>(s.inventories[container]??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const total=(s:Save,id:number)=>Object.values(s.inventories).flat().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
export function cowResult(log:string){try{return JSON.parse(log.split(/\r?\n/).filter(l=>l.startsWith('COW_RESULT ')).at(-1)?.slice(11)??'null');}catch{return null;}}
// Source entry. The restarted case starts from the unstopped partial save.
export function cowEntry(before:Save,kind:Kind){
 const p=before.position,expectedTrout=kind==='nofood'?1:6;
 return p.level===0&&p.x===2655&&p.z===3283&&SWORDINHAND.skills.every((v,i)=>before.skills[i]?.level===v.level&&before.skills[i]?.xp===v.xp)
  &&total(before,TROUT)===expectedTrout&&count(before,93,TROUT)===expectedTrout&&count(before,95,TROUT)===0
  &&total(before,SWORD)===(kind==='nokit'?0:2)&&total(before,SHIELD)===2&&total(before,995)===165&&DROPS.every(id=>count(before,95,id)===8&&count(before,93,id)===0);
}
// A refusal ends before any cow work. The worker reports it either as no result or as a result of 0 kills and 0 XP whose
// failure is a prerequisite error (the worker reports its own failure in COW_RESULT).
export const refusedCow=(result:any)=>result===null||result?.ok===false&&result.creditedKills===0&&result.selectedXp===0&&result.attackXp===0&&result.preserved===true&&/^Error: cow prerequisite/.test(String(result.failure??''));
export function cowSaveChecks(before:Save,after:Save,result:any,kind:Kind){
 const p=after.position,ids=new Set([...Object.values(before.inventories).flat(),...Object.values(after.inventories).flat()].map(i=>i.id));
 const atBank=p.level===0&&Math.max(Math.abs(p.x-BANK.x),Math.abs(p.z-BANK.z))<=4&&DROPS.every(id=>count(after,93,id)===0);
 const skillsSame=(skip:number[])=>before.skills.every((s,i)=>skip.includes(i)||after.skills[i]?.rawExperience===s.rawExperience);
 const assets=(food:number,loot:number)=>[...ids].every(id=>total(after,id)===total(before,id)+(DROPS.includes(id)?loot:id===TROUT?-food:0))
  &&[93,94].every(inv=>(before.inventories[inv]??[]).filter(i=>!DROPS.includes(i.id)&&i.id!==TROUT).every(i=>count(after,inv,i.id)===count(before,inv,i.id)));
 if(refusal[kind])return {
  entry:cowEntry(before,kind),bank:atBank&&p.x===before.position.x&&p.z===before.position.z,refused:refusedCow(result),
  // Natural regeneration may restore one HP during the refusal session.
  skills:skillsSame([]),assets:assets(0,0),health:after.skills[3]!.level>=before.skills[3]!.level&&after.skills[3]!.level<=20};
 const kills=result?.creditedKills,gain=after.skills[0]!.xp-before.skills[0]!.xp;
 const finished=kind==='entry'||kind==='restarted';
 return {
  entry:kind==='restarted'||cowEntry(before,kind),bank:atBank,
  target:finished?result?.ok===true&&result.targetMet===true&&result.stop==='target-level'&&after.skills[0]!.level>=20&&result.finalLevel>=20
   :kind==='partial'?result?.ok===true&&result.targetMet===false&&result.stop==='max-kills'&&result.partial===true&&kills===1&&after.skills[0]!.level<20
   :result?.ok===false&&result.targetMet===false&&result.stop==='stop-file'&&result.partial===false&&after.skills[0]!.level<20,
  order:result?.trainSkill==='Attack'&&result.targetLevel===20&&result.startLevel===before.skills[0]?.level&&result.finalLevel===after.skills[0]?.level,
  xp:Number.isSafeInteger(result?.selectedXp)&&result.selectedXp>0&&gain===result.selectedXp&&result.attackXp===gain
   &&after.skills[3]!.rawExperience>before.skills[3]!.rawExperience&&skillsSame([0,3]),
  loot:Number.isSafeInteger(kills)&&kills>=1&&kills<=5&&['hide','bones','beef'].every(k=>result.banked?.[k]===kills)
   &&DROPS.every(id=>count(after,95,id)-count(before,95,id)===kills),
  food:Number.isSafeInteger(result?.eaten)&&result.eaten>=0&&result.foodAccounted===true&&total(before,TROUT)-total(after,TROUT)===result.eaten&&count(after,93,TROUT)>=2,
  assets:assets(result?.eaten??0,kills??0)&&result?.preserved===true,
  health:after.skills[3]!.level>0&&result?.died===false&&result.respawns===0&&Number.isFinite(result.hpMin)&&result.hpMin>0,
 };
}
// One surface-camp case: an ordinary owned start away from the bank, with the
// melee weapon and food banked. Damaged current HP requires observed eating.
const giantCases=['giant'] as const;
export const trooperCases=['trooper'] as const;
const allCases=[...cases,...giantCases,...trooperCases];
const SHARK=385,MELEE=1331,STAFF=1381,GIANT_DROPS=[532,225,199,201,203,205,207,209,211,213,215,217,219],GIANT_BANK={x:2655,z:3283};
// Engine level/10 curve. The save stores XP times ten.
export const xpForLevel=(level:number)=>{let points=0;for(let n=1;n<level;n++)points+=Math.floor(n+300*2**(n/10));return Math.floor(points/4);};
export const GIANT_HITPOINTS_XP=xpForLevel(87)-1000;
export const MIGHTYROD={position:{x:2670,z:3290,level:0},
 skills:[{level:99,xp:xpForLevel(99)},{level:99,xp:xpForLevel(99)},{level:99,xp:xpForLevel(99)},{level:40,xp:GIANT_HITPOINTS_XP},...Array.from({length:17},()=>({level:1,xp:0}))],
 inventory:[{id:995,count:50},{id:532,count:1},{id:199,count:1}],equipment:[{id:STAFF,count:1,slot:3}],
 bank:[{id:995,count:100},{id:SHARK,count:20},{id:532,count:3},{id:MELEE,count:1}]};
export function giantFixture():SaveConfig{
 return {position:MIGHTYROD.position,skills:{Attack:99,Defence:99,Strength:99,Hitpoints:86},inventory:MIGHTYROD.inventory,equipment:MIGHTYROD.equipment,bank:MIGHTYROD.bank};
}
export function giantChildConfiguration(name:string,inherited:NodeJS.ProcessEnv=process.env){
 return {cmd:['bun','scripts/aio-fighter.ts',name,'giant','1500'],cwd:root,
  env:{...inherited,SERVER:`localhost:${ISOLATED.engine}`,GATEWAY_URL:`ws://localhost:${ISOLATED.gateway}`,DEMO_OK:'',RANDOM_EVENTS:'0',LOOT_WATCH:'0',TARGET:'giant',TRAIN_SKILL:'Hitpoints',TARGET_LEVEL:'87',GIANT_FOOD:'5'},windowsHide:true};
}
export function giantResult(log:string){try{return JSON.parse(log.split(/\r?\n/).filter(l=>l.startsWith('GIANT_RESULT ')).at(-1)?.slice(13)??'null');}catch{return null;}}
export function giantEntry(before:Save){
 const p=before.position;
 return p.level===0&&p.x===MIGHTYROD.position.x&&p.z===MIGHTYROD.position.z&&MIGHTYROD.skills.every((v,i)=>before.skills[i]?.level===v.level&&before.skills[i]?.xp===v.xp)
  &&count(before,94,STAFF)===1&&count(before,95,MELEE)===1&&total(before,MELEE)===1
  &&count(before,93,SHARK)===0&&count(before,95,SHARK)===20&&count(before,95,532)===3&&count(before,93,532)===1&&count(before,93,199)===1&&total(before,995)===150;
}
export function giantSaveChecks(before:Save,after:Save,result:any){
 const p=after.position,ids=new Set([...Object.values(before.inventories).flat(),...Object.values(after.inventories).flat()].map(i=>i.id));
 const kills=result?.creditedKills,roots=result?.limpwurt,gain=after.skills[3]!.xp-before.skills[3]!.xp;
 const delta=(id:number)=>count(after,95,id)-total(before,id);
 return {
  entry:giantEntry(before),
  bank:p.level===0&&Math.max(Math.abs(p.x-GIANT_BANK.x),Math.abs(p.z-GIANT_BANK.z))<=6&&GIANT_DROPS.every(id=>count(after,93,id)===0),
  target:result?.ok===true&&result.targetMet===true&&result.stop==='target-level'&&after.skills[3]!.xp>=xpForLevel(87)&&result.finalLevel>=87,
  order:result?.trainSkill==='Hitpoints'&&result.targetLevel===87&&result.style?.weapon==='Adamant scimitar'&&result.startLevel===86,
  xp:Number.isSafeInteger(result?.selectedXp)&&result.selectedXp>0&&gain===result.selectedXp,
  loot:Number.isSafeInteger(kills)&&kills>=1&&result.banked?.bigBones===kills&&delta(532)===kills
   &&Number.isSafeInteger(roots)&&result.banked?.limpwurt===roots&&delta(225)===roots
   &&GIANT_DROPS.slice(2).every(id=>Number.isSafeInteger(result?.bankedHerbs?.[id])&&result.bankedHerbs[id]>=0&&delta(id)===result.bankedHerbs[id]),
  food:Number.isSafeInteger(result?.eaten)&&result.eaten>=1&&result.foodAccounted===true&&total(before,SHARK)-total(after,SHARK)===result.eaten,
  assets:[...ids].every(id=>GIANT_DROPS.includes(id)||id===SHARK||total(after,id)===total(before,id))&&count(after,94,MELEE)===1&&total(after,STAFF)===1&&result?.preserved===true,
  health:after.skills[3]!.level>0&&result?.died===false&&result.respawns===0&&Number.isFinite(result.hpMin)&&result.hpMin>0,
 };
}
export function giantChildChecks(code:number,timedOut:boolean,log:string){
 log=log.replace(/\r\n/g,'\n');
 return {exit:!timedOut&&code===0,logout:(log.match(/^LOGOUT logged-out$/gm)??[]).length===1&&!/^WARN .*?(logout|session close)/m.test(log),result:/^RESULT ok mode=giant /m.test(log)};
}
// NabTheKnob status at1794782237646, bank at1794780627716. Prayer's connected
// owned54-bone consumer supplies69/124312XP and retains46bones before combat.
export const NABTHEKNOB={position:{x:2618,z:3333,level:0},
 skills:[{level:70,xp:140900},{level:1,xp:0},{level:99,xp:998800},{level:86,xp:410135},{level:66,xp:103800},{level:69,xp:124312},
  {level:1,xp:0},{level:59,xp:62250},...Array.from({length:4},()=>({level:1,xp:0})),{level:22,xp:3750},
  ...Array.from({length:3},()=>({level:1,xp:0})),{level:60,xp:67037},{level:99,xp:85113822},...Array.from({length:3},()=>({level:1,xp:0}))],
 inventory:[{id:558,count:33},{id:556,count:33}],
 equipment:[{id:SWORD,count:1,slot:3},{id:284,count:1,slot:4},{id:SHIELD,count:1,slot:5},{id:285,count:1,slot:7},{id:882,count:305,slot:13}],
 bank:[{id:995,count:436119},{id:1351,count:1},{id:590,count:1},{id:303,count:1},{id:315,count:1},{id:1931,count:4},{id:1265,count:1},{id:1205,count:1},
  {id:556,count:2},{id:558,count:2},{id:555,count:6},{id:557,count:4},{id:559,count:2},{id:1438,count:1},{id:279,count:1},{id:1813,count:1},{id:1809,count:1},
  {id:1815,count:1},{id:1819,count:1},{id:1796,count:1},{id:1802,count:1},{id:314,count:2105},{id:278,count:1},{id:1739,count:1242},{id:526,count:46},
  {id:2132,count:1168},{id:841,count:1},{id:1935,count:16},{id:1446,count:8},{id:2347,count:3},{id:954,count:6},{id:1925,count:1},{id:MELEE,count:1},{id:1895,count:2},{id:2142,count:43}]};
const NAB_FOOD=[2142,1895];
export function trooperFixture():SaveConfig{
 return {position:NABTHEKNOB.position,skills:{Attack:70,Defence:1,Strength:99,Hitpoints:86,Prayer:69},inventory:NABTHEKNOB.inventory,equipment:NABTHEKNOB.equipment,bank:NABTHEKNOB.bank};
}
export function trooperChildConfiguration(name:string,inherited:NodeJS.ProcessEnv=process.env){
 const env:NodeJS.ProcessEnv={...inherited,SERVER:`localhost:${ISOLATED.engine}`,GATEWAY_URL:`ws://localhost:${ISOLATED.gateway}`,DEMO_OK:'',
  TRAIN_SKILL:'Defence',TARGET_LEVEL:'60',GIANT_FOOD:'20',GIANT_BURY:'1',TROOPER_COOK:'1',LOOT_WATCH:'0',RANDOM_EVENTS:'0'};
 // These opt-ins change or refuse the finite level order instead of running it.
 for(const key of ['GIANT_KILLS','MAX_KILLS','COMBAT_POTIONS_FILE','COMBAT_ALCH_FILE','TELEGRAB_MAX'])delete env[key];
 return {cmd:['bun','scripts/aio-fighter.ts',name,'trooper','2500'],cwd:root,env,windowsHide:true};
}
export function trooperEntry(before:Save){
 const expected:Record<number,{id:number;count:number}[]>={93:NABTHEKNOB.inventory,94:NABTHEKNOB.equipment,95:NABTHEKNOB.bank};
 return before.position.level===0&&before.position.x===2618&&before.position.z===3333
  &&NABTHEKNOB.skills.every((v,i)=>before.skills[i]?.level===v.level&&before.skills[i]?.xp===v.xp&&before.skills[i]?.rawExperience===v.xp*10)
  &&Object.keys(before.inventories).every(inv=>inv in expected)
  &&Object.entries(expected).every(([inv,items])=>{
   const container=Number(inv),ids=new Set([...items,...(before.inventories[container]??[])].map(i=>i.id));
   return [...ids].every(id=>count(before,container,id)===items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0));
  })&&NABTHEKNOB.equipment.every(i=>before.inventories[94]?.some(v=>v.slot===i.slot&&v.id===i.id&&v.count===i.count));
}
export function trooperSaveChecks(before:Save,after:Save,result:any){
 const p=after.position,ids=new Set([...Object.values(before.inventories).flat(),...Object.values(after.inventories).flat()].map(i=>i.id));
 const kills=result?.creditedKills,buried=result?.buried,gain=after.skills[1]!.xp-before.skills[1]!.xp;
 const food=(s:Save)=>NAB_FOOD.reduce((n,id)=>n+total(s,id),0),debits=NAB_FOOD.map(id=>total(before,id)-total(after,id));
 const bankedBones=count(after,95,526)-count(before,95,526);
 return {
  entry:trooperEntry(before),
  bank:p.level===0&&Math.max(Math.abs(p.x-2619),Math.abs(p.z-3332))<=6&&count(after,93,526)===0&&result?.bankTrips>=2,
  target:result?.ok===true&&result.targetMet===true&&result.partial===false&&result.stop==='target-level'&&result.failure==='-'
   &&after.skills[1]!.xp>=xpForLevel(60)&&after.skills[1]!.level>=60&&result.finalLevel>=60,
  order:result?.trainSkill==='Defence'&&result.targetLevel===60&&result.startLevel===1&&result.style?.weapon==='Adamant scimitar'&&result.style?.index===3&&result.style?.name==='Block',
  xp:Number.isSafeInteger(result?.selectedXp)&&gain===result.selectedXp&&gain>0&&after.skills[3]!.rawExperience>before.skills[3]!.rawExperience
   &&before.skills.every((v,i)=>[1,3,5].includes(i)||after.skills[i]?.rawExperience===v.rawExperience),
  food:Number.isSafeInteger(result?.eaten)&&result.eaten>=0&&result.foodAccounted===true&&result.initialFood===food(before)&&result.finalFood===food(after)
   &&food(before)-food(after)===result.eaten&&debits.every(n=>n>=0),
  loot:Number.isSafeInteger(kills)&&kills>0&&Number.isSafeInteger(buried)&&buried>0&&buried<=kills
   &&after.skills[5]!.rawExperience-before.skills[5]!.rawExperience===buried*1125&&after.skills[5]!.xp-before.skills[5]!.xp===result.prayerXp
   &&bankedBones>=0&&bankedBones+buried<=kills&&count(after,95,526)>=46,
  assets:result?.preserved===true&&[...ids].every(id=>NAB_FOOD.includes(id)||id===526||total(after,id)===total(before,id))
   &&count(after,94,MELEE)===1&&NABTHEKNOB.equipment.filter(i=>i.slot!==3).every(i=>after.inventories[94]?.some(v=>v.slot===i.slot&&v.id===i.id&&v.count===i.count)),
  health:after.skills[3]!.level>0&&result?.died===false&&result.respawns===0&&Number.isFinite(result.hpMin)&&result.hpMin>0,
  budget:Number.isSafeInteger(result?.ticks)&&result.ticks>0&&result.ticks<=2500,
 };
}
export function trooperChildChecks(code:number,timedOut:boolean,log:string){
 let stage:any=null;try{stage=JSON.parse(log.split(/\r?\n/).filter(l=>l.startsWith('TROOPER_FOOD ')).at(-1)?.slice(13)??'null');}catch{}
 return {...giantChildChecks(code,timedOut,log),
  preparation:!!stage&&['cooked','burnt','trips','stolen','refused'].every(k=>stage[k]===0)&&Number.isSafeInteger(stage.ticks)&&stage.ticks>=0,
  totalBudget:!!stage&&Number.isSafeInteger(stage.ticks)&&stage.ticks>=0&&Number.isSafeInteger(giantResult(log)?.ticks)&&stage.ticks+giantResult(log).ticks<=2500};
}
export function cowChildChecks(code:number,timedOut:boolean,log:string,kind:Kind){
 log=log.replace(/\r\n/g,'\n');
 const ok=kind==='entry'||kind==='partial'||kind==='restarted';
 const start=log.search(/^START \d+ \d+ 0$/m),owner=log.indexOf('COW_STOP_OWNER stop file\n'),result=log.indexOf('COW_RESULT '),logout=log.indexOf('LOGOUT logged-out');
 return {exit:!timedOut&&(ok?code===0:code!==0),logout:(log.match(/^LOGOUT logged-out$/gm)??[]).length===1&&!/^WARN .*?(logout|session close)/m.test(log),
  stopOwner:kind!=='stopped'||start>=0&&owner>start&&result>owner&&logout>result,
  result:ok?/^RESULT ok mode=cow /m.test(log):refusal[kind]?refusal[kind]!.test(log):/^RESULT fail mode=cow .*stop=stop-file/m.test(log)};
}
export function cowSequenceChecks(receipts:any[]){
 const receipt=(id:Kind)=>receipts.find((v:any)=>v.id===id),stopped=receipt('stopped'),partial=receipt('partial'),restarted=receipt('restarted');
 return {
  restart:typeof partial?.name==='string'&&restarted?.name===partial.name&&restarted?.before===partial.after&&typeof partial.after==='string',
  retired:typeof stopped?.name==='string'&&receipts.filter(c=>c.name===stopped.name).length===1&&stopped.retired===true&&stopped.stopRequested===true
   &&stopped.stopRetained===simStopFile(stopped.name,root),
  unstopped:receipts.filter(c=>c.id!=='stopped').every(c=>c.stopRequested===false&&c.stopRetained===null&&c.retired===false&&c.stopFailure===null),
 };
}
function verifyCow(directory:string){
 verifyCompletedRecoveryDelivery(directory);
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const receipt=(id:string)=>meta.cases?.find((v:any)=>v.id===id);
 const checks:Record<string,boolean>={source:JSON.stringify(meta.source)===JSON.stringify(source()),configuration:meta.tickMs===150&&meta.xpRate===25,
  fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000,cases:JSON.stringify(meta.cases?.map((c:any)=>c.id))===JSON.stringify(allCases),
  ...cowSequenceChecks(meta.cases??[])};
 for(const id of allCases){
  const dir=join(directory,id),c=receipt(id);
  const before=readPracticeSave(join(dir,'before.sav')),after=readPracticeSave(join(dir,'after.sav')),log=readFileSync(join(dir,'worker.log'),'utf8');
  const local={...(id==='trooper'?{...trooperSaveChecks(before,after,giantResult(log)),...trooperChildChecks(c?.code,c?.timedOut,log)}:id==='giant'?{...giantSaveChecks(before,after,giantResult(log)),...giantChildChecks(c?.code,c?.timedOut,log)}:{...cowSaveChecks(before,after,cowResult(log),id),...cowChildChecks(c?.code,c?.timedOut,log,id)}),
   stopRetained:id!=='stopped'||c?.stopFailure===null&&typeof c?.stopMarkerHash==='string'&&hash(c.stopRetained)===c.stopMarkerHash,
   savedLogout:c?.persisted===true&&(after.vars[134]??0)>(before.vars[134]??0),beforeHash:c?.before===hash(join(dir,'before.sav')),afterHash:c?.after===hash(join(dir,'after.sav')),logHash:c?.log===hash(join(dir,'worker.log'))};
  for(const [key,value] of Object.entries(local))checks[id+':'+key]=value;
 }
 const report={ok:Object.values(checks).every(Boolean),at:Date.now(),checks,
  scope:'Native cow CLI on a Swordinhand clone, giant CLI Hitpoints86->87 and exact2500-tick trooper CLI Defence1->60 on a Nab clone after its owned Prayer69 consumer; no live release, unattended or speed claim.',
  nextConsumer:'run-prayer-nab-owned69-admission, then run-nabtheknob-trooper-defence60-owned through controller admission. Next: funded Defence70 army band. Existing Swordinhand and Mightyrod consumers retain their own admission.'};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
async function run(directory:string){
 if(!existsSync(join(root,'.practice/delivery-native.lock')))throw Error('practice turn required: run through delivery');
 verifyCompletedRecoveryDelivery(directory);
 if(freemem()/2**30<PRACTICE_STARTUP_GB)throw Error('HOST_DEFERRED_NATIVE_HEADROOM: no stack started');
 mkdirSync(directory,{recursive:true});
 // Exclusive delivery folder: do not overwrite previous before/ snapshots.
 if(existsSync(join(directory,'native.json'))||allCases.some(id=>existsSync(join(directory,id))))throw Error('cow proof directory already used');
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:'cow-progress-order'}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  const pin=source(),receipts:any[]=[];let partial:{name:string;path:string}|undefined;
  stack=await startStack({tickMs:150,xpRate:25,ports:ISOLATED,instance:'cow-progress-order',readyTimeoutMs:60000,enginePreload:{module:join(root,'packages/practice/src/save-endpoint.ts'),env:{...ISOLATED_ENGINE_ENV,BUILD_LIVE_RELOAD:'false',BUILD_STARTUP:'false',NODE_INFINITE_RUN:'true'}}});
  for(const [index,id] of allCases.entries()){
   const dir=join(directory,id);mkdirSync(dir);
   let name:string,path:string;
   if(id==='restarted'){if(!partial)throw Error('restart requires the unstopped partial account');({name,path}=partial);}
   else{
    // setPracticeSkills accepts only generated fl* practice saves.
    name=runBotName('flcow',index+1);const botDir=join(simBotsDir(root),name);
    if(existsSync(botDir)||existsSync(join(root,'vendor/rs-sdk/bots',name)))throw Error('isolated practice identity already exists');
    const bot=await createBot(name);pointBotAt(bot.envPath,ISOLATED.engine,ISOLATED.gateway);
    if(!readFileSync(bot.envPath,'utf8').split(/\r?\n/).includes(`SERVER=localhost:${ISOLATED.engine}`))throw Error('isolated local fixture required');
    if(id==='trooper'){path=await applyPreset(name,trooperFixture());setPracticeSkills(path,NABTHEKNOB.skills);}
    else if(id==='giant'){path=await applyPreset(name,giantFixture());setPracticeSkills(path,MIGHTYROD.skills);}
    else{path=await applyPreset(name,cowFixture(id));setPracticeSkills(path,SWORDINHAND.skills);}
   }
   copyFileSync(path,join(dir,'before.sav'));
   const log=join(dir,'worker.log'),stopFile=simStopFile(name,root);
   if(existsSync(stopFile))throw Error('stale stop file for practice identity');
   const config=id==='trooper'?trooperChildConfiguration(name,process.env):id==='giant'?giantChildConfiguration(name,process.env):cowChildConfiguration(name,process.env,id);
   if(freemem()/2**30<FREE_FLOOR_GB)throw Error('HOST_DEFERRED_NATIVE_HEADROOM: below free-memory floor; no child started');
   const child=Bun.spawn({...config,stdout:Bun.file(log),stderr:Bun.file(join(dir,'worker.err')),windowsHide:true});
   let timedOut=false,exited=false,stopRequested=false,termination:Promise<void>|undefined,ownedStop:CowStop|undefined;
   const timer=setTimeout(()=>{timedOut=true;termination=killTree(child.pid)},id==='trooper'?450000:270000);
   const exit=child.exited.then(code=>{exited=true;return code;});
   if(id==='stopped'){
    // Request the stop after the first observed credited kill.
    while(!exited&&!timedOut){let text='';try{text=readFileSync(log,'utf8');}catch{}if(/^MILESTONE cow credited=1 /m.test(text))break;await Bun.sleep(250);}
    if(!exited&&!timedOut){ownedStop=claimCowStop(stopFile,`cow-progress-order proof stop ${directory} ${id}\n`);stopRequested=true;}
   }
   const code=await exit;clearTimeout(timer);await termination;
   // No retention observation or mutation. This stop identity is never reused.
   let stopRetained:string|null=null,stopFailure='';
   if(ownedStop)stopRetained=retainCowStop(ownedStop);
   if(!ownedStop&&existsSync(stopFile))stopFailure='foreign stop file for practice identity; retained';
   const before=readPracticeSave(join(dir,'before.sav'));
   const persisted=await waitPracticeSave(path,s=>(s.vars[134]??0)>(before.vars[134]??0),{timeoutMs:15000});
   copyFileSync(path,join(dir,'after.sav'));
   receipts.push({id,name,code,timedOut,stopRequested,stopRetained,retired:!!ownedStop,stopMarkerHash:ownedStop?createHash('sha256').update(ownedStop.marker).digest('hex'):null,stopFailure:stopFailure||null,persisted:persisted.matched,before:hash(join(dir,'before.sav')),after:hash(join(dir,'after.sav')),log:hash(log)});
   writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source:pin,tickMs:150,xpRate:25,cases:receipts},null,2));
   // Preserve the failed case; do not proceed with a still-owned account.
   if(!persisted.matched||timedOut)throw Error('cow child logout/save deadline; evidence retained');
   if(stopFailure)throw Error(stopFailure);
   const text=readFileSync(log,'utf8'),saved=readPracticeSave(join(dir,'after.sav'));
   const local=id==='trooper'?{...trooperSaveChecks(before,saved,giantResult(text)),...trooperChildChecks(code,timedOut,text)}:id==='giant'?{...giantSaveChecks(before,saved,giantResult(text)),...giantChildChecks(code,timedOut,text)}:{...cowSaveChecks(before,saved,cowResult(text),id),...cowChildChecks(code,timedOut,text,id)};
   if(!Object.values(local).every(Boolean))throw Error(`cow ${id} checks failed; evidence retained`);
   if(id==='partial')partial={name,path};
  }
  return verifyCow(directory);
 }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
}
if(import.meta.main){try{if(!process.env.DELIVERY_DIR)throw Error('run through the cow-progress-order delivery harness');const directory=resolve(process.env.DELIVERY_DIR);process.exitCode=(process.argv[2]==='--verify'?verifyCow(directory):await run(directory)).ok?0:1;}catch(error){const reason=String(error);console.error(/^Error: HOST_DEFERRED_NATIVE_HEADROOM:/.test(reason)?JSON.stringify({ok:false,hostDeferred:true,reason}):reason);process.exitCode=1;}}
