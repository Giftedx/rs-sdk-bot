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
import {levelForXp,DRAYNOR_BANK,LOGS,TINDERBOX,COINS} from '../../../scripts/firemaking-order';

type Save=ReturnType<typeof readPracticeSave>;
type Child={code:number;timedOut:boolean;interrupted:boolean};
const root=resolve(import.meta.dir,'../../..');
const owned=['scripts/firemaking-order.ts','scripts/firemaking-order.test.ts','packages/practice/src/firemaking-order-proof.ts','packages/practice/test/firemaking-order-proof.test.ts'];
const pinned=['scripts/shop-buyer.ts','packages/core/src/walk.ts','packages/core/src/bot.ts','packages/core/src/deposit.ts','scripts/measure/fleet-player-save.ts',
 'vendor/rs-sdk/server/content/scripts/skill_firemaking/scripts/firemaking.rs2','vendor/rs-sdk/server/content/scripts/skill_firemaking/configs/firemaking.obj',
 'vendor/rs-sdk/server/content/scripts/areas/area_lumbridge/configs/lumbridge.inv','vendor/rs-sdk/server/content/scripts/areas/area_lumbridge/configs/lumbridge.npc'];
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
export const sources=()=>({runtime:workerSourceRevision(),files:Object.fromEntries([...owned,...pinned].map(p=>[p,hash(join(root,p))]))});

// Native admission follows the shared practice startup limit and free-memory floor.
export const NATIVE_ADMISSION_GB=Math.max(PRACTICE_STARTUP_GB,FREE_FLOOR_GB);
export const XP_RATE=25,TICK_MS=PROOF_TICK_MS,FM=11;
// firemaking.obj logs productexp 400 (tenths) times the stack XP rate.
export const RAW_PER_LOG=400*XP_RATE;
export const TARGET=48,TOOL_BUDGET=50,KILL_AFTER_BURNS=3,NATIVE_DEADLINE_MS=900000;
// World.processLogouts: a killed socket stays owned up to 1000 ticks before removal and save.
export const interruptionDeadlineMs=(tickMs:number)=>1000*tickMs+15000;
export const cases=['yewfirst','buy','resume','rerun','short'] as const;
export type Kind=typeof cases[number];
const AXE=1351,FEATHER=314,OAK=LOGS.oak.id,LOG=LOGS.normal.id;
const VARPS={4:-1,9:-1,13:-1,16:-1,28:-1,64:-1,181:-1,209:-1,300:1000};
// (a) YewFirst shape: Draynor bank, banked normal logs and tinderbox. (b) Away from the line, no tinderbox anywhere.
// (c) Short stock: only oak logs, which LOG=normal never burns.
export function firemakingFixture(kind:'yewfirst'|'buy'|'short'):SaveConfig{
 const skills={Woodcutting:35,Hitpoints:10};
 if(kind==='yewfirst')return{position:{...DRAYNOR_BANK,level:0},skills,varps:VARPS,
  bank:[{id:LOG,count:3625},{id:TINDERBOX,count:1},{id:COINS,count:1000},{id:AXE,count:1}]};
 if(kind==='buy')return{position:{x:3089,z:3266,level:0},skills,varps:VARPS,inventory:[{id:COINS,count:25}],
  bank:[{id:LOG,count:200},{id:COINS,count:500},{id:AXE,count:1},{id:FEATHER,count:50}]};
 return{position:{...DRAYNOR_BANK,level:0},skills,varps:VARPS,bank:[{id:OAK,count:5},{id:TINDERBOX,count:1},{id:COINS,count:100}]};
}
export function childConfiguration(name:string,kind:Kind,inherited:NodeJS.ProcessEnv=process.env){
 return{cmd:['bun','scripts/firemaking-order.ts',name],cwd:root,windowsHide:true,
  env:{...inherited,DEMO_OK:'',RANDOM_EVENTS:'0',TARGET_LEVEL:String(kind==='short'?10:TARGET),LOG:'normal',
   TOOL_BUDGET:String(TOOL_BUDGET),CASH_RESERVE:'0',CAP:'6000',MAX_LOGS:'500'}};
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
// Progress from the case's ordinary start save to its final save. Coin debit equals the receipted purchase.
export function progressChecks(start:Save,after:Save,spent:number,tinderboxBefore:0|1){
 const burns=savedBurns(start,after),old=start.skills[FM]!,fm=after.skills[FM]!,coinDebit=total(start,COINS)-total(after,COINS);
 return{
  xp:Number.isSafeInteger(burns)&&burns>0&&fm.rawExperience>old.rawExperience,
  level:levelForXp(fm.xp)>=TARGET&&levelForXp(old.xp)<TARGET&&fm.level>=TARGET,
  logDebit:total(start,LOG)-total(after,LOG)===burns,
  coins:coinDebit===spent&&(tinderboxBefore===1?spent===0:spent>0&&spent<=TOOL_BUDGET),
  tinderbox:total(start,TINDERBOX)===tinderboxBefore&&total(after,TINDERBOX)===1,
  assets:keptAssets(start,after,[LOG,TINDERBOX,COINS]),
  skills:keptSkills(start,after,[FM]),
  alive:(after.skills[3]?.level??0)>0,
  position:nearBank(after)&&total(after,LOG)===(after.inventories[95]??[]).filter(i=>i.id===LOG).reduce((n,i)=>n+i.count,0),
 };
}
export function refusalChecks(before:Save,after:Save){
 // save-generator omits empty containers and Player.save writes them, so absent and empty are equal.
 const containers=[...new Set([...Object.keys(before.inventories),...Object.keys(after.inventories)])].map(Number)
  .every(k=>JSON.stringify(before.inventories[k]??[])===JSON.stringify(after.inventories[k]??[]));
 return{assets:[...ids(before,after)].every(id=>total(before,id)===total(after,id))&&containers,
  skills:JSON.stringify(before.skills)===JSON.stringify(after.skills),alive:(after.skills[3]?.level??0)>0};
}
export function childChecks(c:Child,log:string,mode:'ok'|'refusal'|'killed',refusal?:RegExp):Record<string,boolean>{
 const r=firemakingResult(log),results=lines(log,'FIREMAKING_ORDER_RESULT').length,logouts=(log.match(/^LOGOUT logged-out\r?$/gm)??[]).length;
 if(mode==='killed')return{exit:c.interrupted&&!c.timedOut,result:results===0&&!/^RESULT /m.test(log),noLogout:!/^LOGOUT /m.test(log),
  progress:lines(log,'FIREMAKING_PROGRESS').length>=KILL_AFTER_BURNS};
 return{exit:!c.timedOut&&!c.interrupted&&(mode==='ok'?c.code===0:c.code!==0),
  logout:logouts===1&&!/^WARN .*?(logout|session close)/m.test(log),
  result:mode==='ok'?r?.ok===true&&r.stop==='target'&&r.level>=TARGET&&/^RESULT ok /m.test(log)
   :r?.ok===false&&r.stop==='refused'&&!!refusal&&refusal.test(r.refused)&&r.logsBurnt===0&&/^RESULT fail /m.test(log)};
}
const savedLogout=(before:Save,after:Save)=>(after.vars[134]??0)>(before.vars[134]??0);

export function caseChecks(id:Kind,dir:(k:Kind)=>{before:Save;after:Save;log:string},receipt:(k:Kind)=>any):Record<string,boolean>{
 const c=receipt(id),{before,after,log}=dir(id),child:Child={code:c?.code,timedOut:c?.timedOut,interrupted:c?.interrupted};
 const base={savedLogout:c?.persisted===true&&savedLogout(before,after)};
 if(id==='yewfirst'){
  const r=firemakingResult(log);
  return{...base,...childChecks(child,log,'ok'),...progressChecks(before,after,0,1),
   start:before.position.x===DRAYNOR_BANK.x&&before.position.z===DRAYNOR_BANK.z&&total(before,LOG)===3625&&total(before,TINDERBOX)===1&&before.skills[FM]!.rawExperience===0,
   receipt:r?.logsBurnt===savedBurns(before,after)&&r?.tinderbox?.source==='bank'&&r.bankTrips>=2&&purchases(log).length===0&&r.hpMin>0};
 }
 if(id==='buy'){
  const burns=savedBurns(before,after),bought=purchases(log);
  return{...base,...childChecks(child,log,'killed'),
   start:before.position.x===3089&&before.position.z===3266&&total(before,TINDERBOX)===0&&total(before,LOG)===200&&before.skills[FM]!.rawExperience===0,
   purchase:bought.length===1&&bought[0]?.bought===1&&bought[0].spent>0&&bought[0].spent<=TOOL_BUDGET&&total(after,TINDERBOX)===1
    &&total(before,COINS)-total(after,COINS)===bought[0].spent,
   persisted:Number.isSafeInteger(burns)&&burns>=KILL_AFTER_BURNS&&total(before,LOG)-total(after,LOG)===burns,
   unfinished:levelForXp(after.skills[FM]!.xp)<TARGET,
   assets:keptAssets(before,after,[LOG,TINDERBOX,COINS]),skills:keptSkills(before,after,[FM])};
 }
 if(id==='resume'){
  const start=dir('buy').before,spent=purchases(dir('buy').log)[0]?.spent??NaN,r=firemakingResult(log);
  return{...base,...childChecks(child,log,'ok'),...progressChecks(start,after,spent,0),
   noReseed:receipt('buy')?.name===c?.name&&receipt('buy')?.after===c?.before,
   receipt:r?.logsBurnt===savedBurns(before,after)&&r?.tinderbox?.source==='pack'&&purchases(log).length===0&&r.bankTrips>=2&&r.hpMin>0};
 }
 if(id==='rerun')return{...base,...childChecks(child,log,'refusal',/^already at target$/),...refusalChecks(before,after),
  sameAccount:receipt('resume')?.name===c?.name&&receipt('resume')?.after===c?.before,
  position:JSON.stringify(before.position)===JSON.stringify(after.position),atTarget:levelForXp(before.skills[FM]!.xp)>=TARGET};
 return{...base,...childChecks(child,log,'refusal',/^short log stock: need 1 Logs, own 0, shortfall 1$/),...refusalChecks(before,after),
  start:total(before,LOG)===0&&total(before,OAK)===5&&total(before,TINDERBOX)===1,position:nearBank(after)};
}
export function verifyFiremaking(directory:string){
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const receipt=(id:Kind)=>meta.cases?.find((v:any)=>v.id===id);
 const cache=new Map<Kind,{before:Save;after:Save;log:string}>();
 const files=(id:Kind)=>{let f=cache.get(id);if(!f){const d=join(directory,id);
  f={before:readPracticeSave(join(d,'before.sav')),after:readPracticeSave(join(d,'after.sav')),log:readFileSync(join(d,'worker.log'),'utf8')};cache.set(id,f);}return f;};
 const checks:Record<string,boolean>={source:JSON.stringify(meta.source)===JSON.stringify(sources()),
  configuration:meta.tickMs===TICK_MS&&meta.xpRate===XP_RATE,
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
  nextConsumer:'run-firemaking-yewfirst-30: YewFirst at Draynor bank, 3625 banked normal logs, banked tinderbox, TARGET_LEVEL=30.'};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
async function run(directory:string){
 const started=Date.now(),deadline=started+NATIVE_DEADLINE_MS-30000;
 if(freemem()/2**30<NATIVE_ADMISSION_GB)throw Error(`insufficient native admission headroom: need ${NATIVE_ADMISSION_GB} GiB free`);
 mkdirSync(directory,{recursive:true});
 // Exclusive delivery folder: never overwrite earlier before/ snapshots.
 if(existsSync(join(directory,'native.json'))||cases.some(id=>existsSync(join(directory,id))))throw Error('firemaking proof directory already used');
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:'firemaking-order'}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  const pin=sources(),receipts:any[]=[];let buy:{name:string;path:string}|undefined;
  stack=await startStack({tickMs:TICK_MS,xpRate:XP_RATE,readyTimeoutMs:60000});
  for(const [index,id] of cases.entries()){
   const dir=join(directory,id);mkdirSync(dir);
   let name:string,path:string;
   if(id==='resume'||id==='rerun'){if(!buy)throw Error('resume requires the interrupted account');({name,path}=buy);}
   else{
    name=runBotName('flfm',index+1);const botDir=join(root,'vendor/rs-sdk/bots',name);
    if(existsSync(botDir))throw Error('isolated practice identity already exists');
    await createBot(name);
    if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local fixture required');
    path=await applyPreset(name,firemakingFixture(id==='short'?'short':id==='buy'?'buy':'yewfirst'));
    if(id==='buy')buy={name,path};
   }
   copyFileSync(path,join(dir,'before.sav'));
   const before=readPracticeSave(join(dir,'before.sav')),log=join(dir,'worker.log');
   const saveWait=id==='buy'?interruptionDeadlineMs(TICK_MS):15000,limit=Math.min(id==='rerun'||id==='short'?90000:240000,deadline-Date.now()-saveWait);
   if(limit<30000)throw Error(`native envelope exhausted before ${id}`);
   if(existsSync(join(root,'.practice',`stop-${name}`)))throw Error('stale stop file for practice identity');
   const config=childConfiguration(name,id);
   const child=Bun.spawn({...config,stdout:Bun.file(log),stderr:Bun.file(join(dir,'worker.err')),windowsHide:true});
   let timedOut=false,interrupted=false,exited=false,termination:Promise<void>|undefined;
   const timer=setTimeout(()=>{timedOut=true;termination=killTree(child.pid);},limit);
   const exit=child.exited.then(code=>{exited=true;return code;});
   if(id==='buy'){
    // Abrupt stop after observed burns: no logout, no RESULT. The server keeps and then saves the player.
    while(!exited&&!timedOut){let text='';try{text=readFileSync(log,'utf8');}catch{}
     if((text.match(/^FIREMAKING_PROGRESS /gm)??[]).length>=KILL_AFTER_BURNS){interrupted=true;await killTree(child.pid);break;}
     await Bun.sleep(250);}
   }
   const code=await exit;clearTimeout(timer);await termination;
   const persisted=await waitPracticeSave(path,s=>(s.vars[134]??0)>(before.vars[134]??0),{timeoutMs:saveWait});
   copyFileSync(path,join(dir,'after.sav'));
   receipts.push({id,name,code,timedOut,interrupted,persisted:persisted.matched,before:hash(join(dir,'before.sav')),after:hash(join(dir,'after.sav')),log:hash(log)});
   writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source:pin,tickMs:TICK_MS,xpRate:XP_RATE,cases:receipts},null,2));
   // Retain the failed case; never continue with a still-owned account.
   if(!persisted.matched||timedOut)throw Error(`${id}: child logout/save deadline; evidence retained`);
   if(id==='buy'&&!interrupted)throw Error('buy: child ended before the interruption; evidence retained');
  }
  return verifyFiremaking(directory);
 }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
}
if(import.meta.main){try{if(!process.env.DELIVERY_DIR)throw Error('run through the firemaking-order delivery harness');const directory=resolve(process.env.DELIVERY_DIR);
 process.exitCode=(process.argv[2]==='--verify'?verifyFiremaking(directory):await run(directory)).ok?0:1;}catch(error){console.error(String(error));process.exitCode=1;}}
