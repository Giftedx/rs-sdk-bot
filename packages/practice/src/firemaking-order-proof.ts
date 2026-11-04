// Harness entry only. Import and --verify never start services or log in.
// Native proof: the installed scripts/firemaking-order.ts CLI on ordinary generated fixtures, judged from saved state.
import {copyFileSync,readFileSync,writeFileSync,mkdirSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {freemem} from 'node:os';
import {startStack,PROOF_TICK_MS} from './stack';
import {createBot} from './bots';
import {applyPreset,type SaveConfig} from './presets';
import {runBotName} from './prove';
import {killTree} from './proc';
import {workerSourceRevision} from '../../core/src/worker-release';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {levelForXp,lineTiles,firemakingSite,DRAYNOR_BANK,LOGS,TINDERBOX,COINS} from '../../../scripts/firemaking-order';

type Save=ReturnType<typeof readPracticeSave>;
type Child={code:number;timedOut:boolean};
const root=resolve(import.meta.dir,'../../..');
const owned=['scripts/firemaking-order.ts','scripts/firemaking-order.test.ts','packages/practice/src/firemaking-order-proof.ts','packages/practice/test/firemaking-order-proof.test.ts'];
const pinned=['scripts/shop-buyer.ts','packages/core/src/walk.ts','packages/core/src/bot.ts','packages/core/src/deposit.ts','scripts/measure/fleet-player-save.ts',
 'vendor/rs-sdk/server/content/scripts/skill_firemaking/scripts/firemaking.rs2','vendor/rs-sdk/server/content/scripts/skill_firemaking/configs/firemaking.obj',
 'vendor/rs-sdk/server/content/scripts/areas/area_lumbridge/configs/lumbridge.inv','vendor/rs-sdk/server/content/scripts/areas/area_lumbridge/configs/lumbridge.npc',
 'vendor/rs-sdk/sdk/collision-data.json','vendor/rs-sdk/server/content/maps/m43_53.jm2','vendor/rs-sdk/server/content/maps/m44_53.jm2',
 'vendor/rs-sdk/server/content/scripts/skill_firemaking/configs/bank_zones.dbrow'];
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
export const sources=()=>({runtime:workerSourceRevision(),files:Object.fromEntries([...owned,...pinned].map(p=>[p,hash(join(root,p))]))});

// Native admission follows the shared practice startup limit and free-memory floor.
export const NATIVE_ADMISSION_GB=Math.max(PRACTICE_STARTUP_GB,FREE_FLOOR_GB);
export const XP_RATE=25,TICK_MS=PROOF_TICK_MS,FM=11;
// firemaking.obj logs productexp 400 (tenths) times the stack XP rate.
export const RAW_PER_LOG=400*XP_RATE;
export const TARGET=15,TOOL_BUDGET=0,NATIVE_DEADLINE_MS=900000;
export const RECOVERY_AFTER=1793418022381;
export const ENTRY={x:2863,z:3428,level:0};
export const cases=['entry','rerun','short'] as const;
export type Kind=typeof cases[number];
const OAK=LOGS.oak.id,LOG=LOGS.normal.id;
const VARPS={4:-1,9:-1,13:-1,16:-1,28:-1,64:-1,181:-1,209:-1,300:1000};
// Shaftmaker's ordinary skill levels and owned inputs at the failed distant-entry step.
// No combat, access or movement unlock is added to help the route.
export function firemakingFixture(kind:'entry'|'short'):SaveConfig{
 const skills={Attack:2,Defence:1,Strength:1,Hitpoints:10,Woodcutting:99,Fletching:99};
 const bank=[{id:COINS,count:19895},{id:TINDERBOX,count:1},{id:303,count:1},{id:1925,count:1},{id:1931,count:1},
  {id:1265,count:1},{id:1205,count:1},{id:1277,count:1},{id:1171,count:1},{id:841,count:1},{id:882,count:25},
  {id:556,count:25},{id:558,count:15},{id:555,count:6},{id:557,count:4},{id:559,count:2},{id:52,count:100},
  {id:314,count:100},{id:53,count:195},{id:OAK,count:25},{id:1777,count:45},{id:845,count:955},
  {id:946,count:1},{id:1351,count:1},{id:2309,count:1},{id:315,count:1}];
 if(kind==='entry')bank.push({id:LOG,count:5074});
 return{position:kind==='entry'?{...ENTRY}:{...DRAYNOR_BANK,level:0},skills,varps:VARPS,
  inventory:[{id:COINS,count:80},...Array.from({length:3},()=>({id:1933,count:1}))],bank};
}
export function childConfiguration(name:string,kind:Kind,inherited:NodeJS.ProcessEnv=process.env){
 return{cmd:['bun','scripts/firemaking-order.ts',name],cwd:root,windowsHide:true,
  env:{...inherited,DEMO_OK:'',RANDOM_EVENTS:'0',TARGET_LEVEL:String(TARGET),LOG:'normal',
   TOOL_BUDGET:String(TOOL_BUDGET),CASH_RESERVE:'0',CAP:'2000',MAX_LOGS:'2'}};
}
const total=(s:Save,id:number)=>Object.values(s.inventories).flat().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const ids=(a:Save,b:Save)=>new Set([...Object.values(a.inventories).flat(),...Object.values(b.inventories).flat()].map(i=>i.id));
const lines=(log:string,tag:string)=>log.split(/\r?\n/).filter(l=>l.startsWith(tag+' ')).map(l=>{try{return JSON.parse(l.slice(tag.length+1));}catch{return null;}});
export const firemakingResult=(log:string)=>{const r=lines(log,'FIREMAKING_ORDER_RESULT');return r.length===1?r[0]:null;};
export const purchases=(log:string)=>lines(log,'FIREMAKING_PURCHASE');
// Burns from the saved XP effect alone: every normal log adds RAW_PER_LOG tenths.
export function savedBurns(before:Save,after:Save){
 const d=(after.skills[FM]?.rawExperience??NaN)-(before.skills[FM]?.rawExperience??NaN);
 return Number.isSafeInteger(d)&&d>=0&&d%RAW_PER_LOG===0?d/RAW_PER_LOG:NaN;
}
const nearBank=(s:Save)=>s.position.level===0&&Math.max(Math.abs(s.position.x-DRAYNOR_BANK.x),Math.abs(s.position.z-DRAYNOR_BANK.z))<=3;
// Every asset except logs, tinderbox and coins keeps its total; worn items keep their exact slots.
export function keptAssets(before:Save,after:Save,changing:readonly number[]){
 return [...ids(before,after)].every(id=>changing.includes(id)||total(before,id)===total(after,id))
  &&JSON.stringify(before.inventories[94]??[])===JSON.stringify(after.inventories[94]??[]);
}
export function keptSkills(before:Save,after:Save,except:readonly number[]){
 return before.skills.every((s,i)=>except.includes(i)||after.skills[i]?.rawExperience===s.rawExperience);
}
// The saved Firemaking effect must match every burnt normal log, with no other asset debit.
export function progressChecks(start:Save,after:Save){
 const burns=savedBurns(start,after),old=start.skills[FM]!,fm=after.skills[FM]!,site=firemakingSite(start.position);
 return{
  xp:Number.isSafeInteger(burns)&&burns>0&&burns<=2&&fm.rawExperience>old.rawExperience,
  level:levelForXp(fm.xp)>=TARGET&&levelForXp(old.xp)<TARGET&&fm.level>=TARGET,
  logDebit:total(start,LOG)-total(after,LOG)===burns,
  coins:total(start,COINS)===total(after,COINS),
  tinderbox:total(start,TINDERBOX)===1&&total(after,TINDERBOX)===1,
  assets:keptAssets(start,after,[LOG]),skills:keptSkills(start,after,[FM]),
  alive:(after.skills[3]?.level??0)>0,
  // The two-log consumer ends with no carried logs on the selected site's burn line, or at its bank after it empties the withdrawn pack.
  position:after.position.level===0&&(lineTiles(site.rows).some(t=>t.z===after.position.z&&Math.abs(t.x-after.position.x)<=1)
   ||Math.max(Math.abs(after.position.x-site.bank.x),Math.abs(after.position.z-site.bank.z))<=3)
   &&!(after.inventories[93]??[]).some(i=>i.id===LOG),
 };
}
export function refusalChecks(before:Save,after:Save){
 // save-generator omits empty containers and Player.save writes them, so absent and empty are equal.
 const containers=[...new Set([...Object.keys(before.inventories),...Object.keys(after.inventories)])].map(Number)
  .every(k=>JSON.stringify(before.inventories[k]??[])===JSON.stringify(after.inventories[k]??[]));
 return{assets:[...ids(before,after)].every(id=>total(before,id)===total(after,id))&&containers,
  skills:JSON.stringify(before.skills)===JSON.stringify(after.skills),alive:(after.skills[3]?.level??0)>0};
}
export function childChecks(c:Child,log:string,mode:'ok'|'refusal',refusal?:RegExp):Record<string,boolean>{
 const r=firemakingResult(log),logouts=(log.match(/^LOGOUT logged-out\r?$/gm)??[]).length;
 return{exit:!c.timedOut&&(mode==='ok'?c.code===0:c.code!==0),
  logout:logouts===1&&!/^WARN .*?(logout|session close)/m.test(log),
  result:mode==='ok'?r?.ok===true&&r.stop==='target'&&r.level>=TARGET&&/^RESULT ok /m.test(log)
   :r?.ok===false&&r.stop==='refused'&&!!refusal&&refusal.test(r.refused)&&r.logsBurnt===0&&/^RESULT fail /m.test(log)};
}
const savedLogout=(before:Save,after:Save)=>(after.vars[134]??0)>(before.vars[134]??0);
export function caseChecks(id:Kind,dir:(k:Kind)=>{before:Save;after:Save;log:string},receipt:(k:Kind)=>any):Record<string,boolean>{
 const c=receipt(id),{before,after,log}=dir(id),child:Child={code:c?.code,timedOut:c?.timedOut};
 const base={savedLogout:c?.persisted===true&&savedLogout(before,after)};
 if(id==='entry'){
  const r=firemakingResult(log),initial=lines(log,'FIREMAKING_INITIAL');
  const fixture=firemakingFixture('entry');
  return{...base,...childChecks(child,log,'ok'),...progressChecks(before,after),
   start:JSON.stringify(before.position)===JSON.stringify(ENTRY)&&before.skills[FM]!.rawExperience===0
    &&Object.entries(fixture.skills!).every(([name,level])=>before.skills[SKILL_INDEX[name]!]!.level===level)
    &&[...(fixture.inventory??[]),...(fixture.bank??[])].every(i=>total(before,i.id)===
     [...(fixture.inventory??[]),...(fixture.bank??[])].filter(j=>j.id===i.id).reduce((n,j)=>n+j.count,0)),
   cliEntry:initial.length===1&&JSON.stringify(initial[0]?.position)===JSON.stringify(ENTRY)
    &&initial[0]?.hp===10&&initial[0]?.level===1&&initial[0]?.options?.target===TARGET
    &&initial[0]?.options?.maxLogs===2&&initial[0]?.options?.cap===2000&&initial[0]?.options?.toolBudget===0&&initial[0]?.options?.cashReserve===0,
   receipt:r?.logsBurnt===savedBurns(before,after)&&r?.xpGained===after.skills[FM]!.xp-before.skills[FM]!.xp
    &&r?.tinderbox?.source==='bank'&&r?.tinderbox?.spent===0&&r.bankTrips>=1&&purchases(log).length===0&&r.hpMin===10};
 }
 if(id==='rerun')return{...base,...childChecks(child,log,'refusal',/^already at target$/),...refusalChecks(before,after),
  sameAccount:receipt('entry')?.name===c?.name&&receipt('entry')?.after===c?.before,
  position:JSON.stringify(before.position)===JSON.stringify(after.position),atTarget:levelForXp(before.skills[FM]!.xp)>=TARGET};
 return{...base,...childChecks(child,log,'refusal',/^short log stock: need 1 Logs, own 0, shortfall 1$/),...refusalChecks(before,after),
  start:total(before,LOG)===0&&total(before,OAK)===25&&total(before,TINDERBOX)===1,position:nearBank(after)};
}
const SKILL_INDEX:Record<string,number>={Attack:0,Defence:1,Strength:2,Hitpoints:3,Woodcutting:8,Fletching:9};
export function verifyFiremaking(directory:string){
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const receipt=(id:Kind)=>meta.cases?.find((v:any)=>v.id===id);
 const cache=new Map<Kind,{before:Save;after:Save;log:string}>();
 const files=(id:Kind)=>{let f=cache.get(id);if(!f){const d=join(directory,id);
  f={before:readPracticeSave(join(d,'before.sav')),after:readPracticeSave(join(d,'after.sav')),log:readFileSync(join(d,'worker.log'),'utf8')};cache.set(id,f);}return f;};
 const checks:Record<string,boolean>={source:JSON.stringify(meta.source)===JSON.stringify(sources()),
  configuration:meta.tickMs===TICK_MS&&meta.xpRate===XP_RATE,
  recovery:meta.startedAt>RECOVERY_AFTER&&meta.at>=meta.startedAt,
  fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<NATIVE_DEADLINE_MS,
  cases:JSON.stringify(meta.cases?.map((c:any)=>c.id))===JSON.stringify(cases)};
 for(const id of cases){
  const d=join(directory,id),c=receipt(id);
  let local:Record<string,boolean>;
  try{local={...caseChecks(id,files,receipt),beforeHash:c?.before===hash(join(d,'before.sav')),afterHash:c?.after===hash(join(d,'after.sav')),logHash:c?.log===hash(join(d,'worker.log'))};}
  catch(e){local={readable:false};console.error(`${id}: ${String(e)}`);}
  for(const [k,v] of Object.entries(local))checks[`${id}:${k}`]=v;
 }
 const report={ok:Object.values(checks).every(Boolean),at:Date.now(),checks,
  scope:'Native installed firemaking-order CLI on generated practice fixtures at 150ms/25x only. No live access, unattended or speed claim.',
  nextConsumer:'run-firemaking-shaftmaker-entry-normal15, then run-firemaking-shaftmaker-connected-oak30; live execution belongs to the controller.'};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
async function run(directory:string){
 const started=Date.now(),deadline=started+NATIVE_DEADLINE_MS-30000;
 if(started<=RECOVERY_AFTER)throw Error('recovery proof must postdate the failed consumer');
 if(freemem()/2**30<NATIVE_ADMISSION_GB)throw Error(`insufficient native admission headroom: need ${NATIVE_ADMISSION_GB} GiB free`);
 mkdirSync(directory,{recursive:true});
 // Exclusive delivery folder: never overwrite earlier before/ snapshots.
 if(existsSync(join(directory,'native.json'))||cases.some(id=>existsSync(join(directory,id))))throw Error('firemaking proof directory already used');
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:'firemaking-order'}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  const pin=sources(),receipts:any[]=[];let entry:{name:string;path:string}|undefined;
  stack=await startStack({tickMs:TICK_MS,xpRate:XP_RATE,readyTimeoutMs:60000});
  for(const [index,id] of cases.entries()){
   if(freemem()/2**30<FREE_FLOOR_GB)throw Error(`practice free floor: need ${FREE_FLOOR_GB} GiB free`);
   const dir=join(directory,id);mkdirSync(dir);
   let name:string,path:string;
   if(id==='rerun'){if(!entry)throw Error('rerun requires the completed entry account');({name,path}=entry);}
   else{
    name=runBotName('flfm',index+1);const botDir=join(root,'vendor/rs-sdk/bots',name);
    if(existsSync(botDir))throw Error('isolated practice identity already exists');
    await createBot(name);
    if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local fixture required');
    path=await applyPreset(name,firemakingFixture(id));
    if(id==='entry')entry={name,path};
   }
   copyFileSync(path,join(dir,'before.sav'));
   const before=readPracticeSave(join(dir,'before.sav')),log=join(dir,'worker.log');
   const limit=Math.min(id==='entry'?360000:90000,deadline-Date.now()-15000);
   if(limit<30000)throw Error(`native envelope exhausted before ${id}`);
   if(existsSync(join(root,'.practice',`stop-${name}`)))throw Error('stale stop file for practice identity');
   const config=childConfiguration(name,id);
   const child=Bun.spawn({...config,stdout:Bun.file(log),stderr:Bun.file(join(dir,'worker.err')),windowsHide:true});
   let timedOut=false,termination:Promise<void>|undefined;
   const timer=setTimeout(()=>{timedOut=true;termination=killTree(child.pid);},limit);
   const code=await child.exited;clearTimeout(timer);await termination;
   const persisted=await waitPracticeSave(path,s=>(s.vars[134]??0)>(before.vars[134]??0),{timeoutMs:15000});
   copyFileSync(path,join(dir,'after.sav'));
   receipts.push({id,name,code,timedOut,persisted:persisted.matched,before:hash(join(dir,'before.sav')),after:hash(join(dir,'after.sav')),log:hash(log)});
   writeFileSync(join(directory,'native.json'),JSON.stringify({startedAt:started,at:Date.now(),source:pin,tickMs:TICK_MS,xpRate:XP_RATE,cases:receipts},null,2));
   // Retain the first failed boundary and all saves. Never continue with a still-owned account.
   const checks=caseChecks(id,k=>{const d=join(directory,k);return{before:readPracticeSave(join(d,'before.sav')),after:readPracticeSave(join(d,'after.sav')),log:readFileSync(join(d,'worker.log'),'utf8')};},k=>receipts.find(c=>c.id===k));
   if(Object.values(checks).some(v=>!v))throw Error(`${id}: failed ${Object.entries(checks).filter(([,v])=>!v).map(([k])=>k).join(',')}; evidence retained`);
  }
  return verifyFiremaking(directory);
 }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
}
if(import.meta.main){try{if(!process.env.DELIVERY_DIR)throw Error('run through the firemaking-order delivery harness');const directory=resolve(process.env.DELIVERY_DIR);
 process.exitCode=(process.argv[2]==='--verify'?verifyFiremaking(directory):await run(directory)).ok?0:1;}catch(error){console.error(String(error));process.exitCode=1;}}
