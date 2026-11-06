// Harness entry only. Import and --verify never start services or log in.
import {copyFileSync,readFileSync,writeFileSync,mkdirSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {freemem} from 'node:os';
import {startStack,PROOF_TICK_MS,type StackOptions} from './stack';
import {canBind} from './ports';
import {createBot} from './bots';
import {applyPreset,type SaveConfig} from './presets';
import {runBotName} from './prove';
import {killTree} from './proc';
import {workerSourceRevision} from '../../core/src/worker-release';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';
import {ARRIVAL,BANK,BLOOD_RUNE,COINS,EXIT_TICKS,STAGE} from '../../../scripts/blood-chest';

type Save=ReturnType<typeof readPracticeSave>;
const root=resolve(import.meta.dir,'../../..');
const thieving='vendor/rs-sdk/server/content/scripts/skill_thieving/';
const owned=['scripts/blood-chest.ts','scripts/blood-chest.test.ts','packages/practice/src/blood-chest-proof.ts','packages/practice/test/blood-chest-proof.test.ts'];
const serverFiles=[thieving+'scripts/thieving.rs2',thieving+'scripts/chest/trapped_chest.rs2',thieving+'scripts/doors/locked_door.rs2',thieving+'configs/chests/trapped_chest.dbrow',thieving+'configs/doors/locked_door.dbrow'];
// Delivery takes the practice turn and admits native startup at startupGb; this proof keeps the floor per child.
export const ADMISSION={floorGb:FREE_FLOOR_GB,startupGb:PRACTICE_STARTUP_GB};
const XP_RATE=25,THIEVING=17,CAKE=1895;
// Raw tenths: chest 2500 and door 375 (trapped_chest.dbrow, locked_door.dbrow). Each loot needs one door pick from the surface.
export const ENTRY_RAW_XP=2*(2500+375)*XP_RATE;
export function bloodProofEndpoints(ports:{engine:number;gateway:number;management:number;tcp:number},instance:string){
 const values=[ports?.engine,ports?.gateway,ports?.management,ports?.tcp];
 if(!values.every(p=>Number.isSafeInteger(p)&&p>=1024&&p<=65535&&![8888,7780,8898,43594].includes(p))
  ||new Set(values).size!==4||!/^blood-[a-z0-9-]{1,24}$/.test(instance))throw Error('owned practice endpoints required');
 const server=`127.0.0.1:${ports.engine}`,gateway=`ws://127.0.0.1:${ports.gateway}`;
 return{ports:{...ports},instance,server,gateway,env:{AGENT_PORT:String(ports.gateway),GATEWAY_URL:`http://127.0.0.1:${ports.gateway}`,
  WEB_MANAGEMENT_PORT:String(ports.management),NODE_PORT:String(ports.tcp),GE_DATABASE:`data/market-${instance}.sqlite`}};
}
type ProofEndpoints=ReturnType<typeof bloodProofEndpoints>;
export function selectBloodProofEndpoints(bind:typeof canBind=canBind,random:()=>number=Math.random){
 for(let i=0;i<100;i++){
  const engine=20000+Math.floor(random()*20000),ports={engine,gateway:engine+1,management:engine+2,tcp:engine+3};
  if(Object.values(ports).every(bind))return bloodProofEndpoints(ports,'blood-'+randomUUID().replaceAll('-','').slice(0,20));
 }
 throw Error('owned practice ports unavailable');
}
export function bloodProofAccountEnv(text:string,p:ProofEndpoints){
 if(!/^SERVER=localhost:8888\r?$/m.test(text)||!/^GATEWAY_URL=ws:\/\/localhost:7780\r?$/m.test(text))throw Error('new practice account required');
 return text.replace(/^SERVER=.*$/gm,`SERVER=${p.server}`).replace(/^GATEWAY_URL=.*$/gm,`GATEWAY_URL=${p.gateway}`);
}
export async function startBloodProofStack(p:ProofEndpoints,start:(opts:StackOptions)=>ReturnType<typeof startStack>=startStack){
 const previous=Object.fromEntries(Object.keys(p.env).map(k=>[k,process.env[k]]));
 try{Object.assign(process.env,p.env);return await start({ports:p.ports,instance:p.instance,tickMs:PROOF_TICK_MS,xpRate:XP_RATE,readyTimeoutMs:60000});}
 finally{for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
}
const source=()=>({runtime:workerSourceRevision(),files:Object.fromEntries([...owned,...serverFiles].map(p=>[p,createHash('sha256').update(readFileSync(join(root,p))).digest('hex')]))});
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const count=(s:Save,container:number,id:number)=>(s.inventories[container]??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const total=(s:Save,id:number)=>Object.values(s.inventories).flat().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const near=(s:Save,t:{x:number;z:number},range:number)=>s.position.level===0&&Math.max(Math.abs(s.position.x-t.x),Math.abs(s.position.z-t.z))<=range;
export function bloodResult(log:string){try{return JSON.parse(log.split(/\r?\n/).filter(l=>l.startsWith('BLOOD_CHEST_RESULT ')).at(-1)?.slice(19)??'null');}catch{return null;}}
const cases=['entry','exit','refusal'] as const;
type Case=typeof cases[number];
export function bloodSaveChecks(before:Save,after:Save,result:any,kind:Case){
 const raw=(s:Save)=>s.skills[THIEVING]!.rawExperience,runes=count(after,95,BLOOD_RUNE)-count(before,95,BLOOD_RUNE),coins=total(after,COINS)-total(before,COINS);
 const packCoins=count(before,93,COINS),ids=new Set([...Object.values(before.inventories).flat(),...Object.values(after.inventories).flat()].map(i=>i.id));
 const looted=kind==='entry',moved=kind!=='refusal';
 return{
  entry:near(before,kind==='exit'?STAGE:ARRIVAL,0)&&before.skills[THIEVING]!.level===(kind==='refusal'?58:99)&&count(before,93,CAKE)===3&&count(before,93,BLOOD_RUNE)===0&&packCoins>0,
  place:moved?near(after,BANK,3):JSON.stringify(after.position)===JSON.stringify(before.position),
  target:kind==='entry'?result?.ok===true&&result?.stop==='target'&&result?.targetMet===true&&result?.conserved===true
   :kind==='exit'?result?.ok===false&&result?.stop==='cap'&&result?.targetMet===false&&result?.conserved===true
   :result?.ok===false&&result?.stop==='refused'&&String(result?.failure).includes('blood chest refused: Thieving 58 is below level 59'),
  // The saved bank holds the reward; the pack holds no runes or coins after a bank trip.
  output:runes===(looted?4:0)&&coins===(looted?1000:0)&&total(after,BLOOD_RUNE)===runes&&count(after,93,BLOOD_RUNE)===0&&count(after,93,COINS)===(moved?0:packCoins)
   &&(!moved||(result?.loots===(looted?2:0)&&result?.runes===runes&&result?.coins===coins&&result?.bankedRunes===runes&&result?.bankedCoins===packCoins+coins)),
  xp:raw(after)-raw(before)===(looted?ENTRY_RAW_XP:0),
  assets:[...ids].every(id=>id===BLOOD_RUNE||id===COINS||total(before,id)===total(after,id))
   &&[93,94].every(inv=>(before.inventories[inv]??[]).filter(i=>i.id!==COINS).every(i=>count(before,inv,i.id)===count(after,inv,i.id))),
  skills:before.skills.every((s,i)=>i===THIEVING||after.skills[i]?.rawExperience===s.rawExperience),
  health:after.skills[3]!.level>0&&(!moved||(result?.died===false&&result?.hpMin>=1)),
 };
}
export function bloodChildChecks(code:number,timedOut:boolean,log:string,kind:Case){
 return{exit:!timedOut&&(kind==='entry'?code===0:code!==0),logout:(log.match(/^LOGOUT logged-out\r?$/gm)??[]).length===1&&!/^WARN .*?(logout|session close)/m.test(log),
  result:kind==='entry'?/^RESULT ok /m.test(log):/^RESULT fail /m.test(log)};
}
// The route facts that the work order leaves to practice, read from the worker log.
export function bloodObservations(log:string){
 const rows=(tag:string)=>log.split(/\r?\n/).filter(l=>l.startsWith(tag+' ')).map(l=>{try{return JSON.parse(l.slice(tag.length+1));}catch{return null;}});
 return{trips:rows('BLOOD_TRIP'),loots:rows('BLOOD_LOOT'),banks:rows('BLOOD_BANK')};
}
export function verifyBlood(directory:string){
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const endpoints=bloodProofEndpoints(meta.endpoints?.ports,meta.endpoints?.instance??'');
 const checks:Record<string,boolean>={source:JSON.stringify(meta.source)===JSON.stringify(source()),configuration:meta.tickMs===PROOF_TICK_MS&&meta.xpRate===XP_RATE,fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000,
  cases:JSON.stringify(meta.cases?.map((c:any)=>c.id))===JSON.stringify(cases),endpoints:meta.server===endpoints.server};
 const observed:Record<string,unknown>={};
 for(const id of cases){
  const dir=join(directory,id),c=meta.cases?.find((v:any)=>v.id===id);
  const before=readPracticeSave(join(dir,'before.sav')),after=readPracticeSave(join(dir,'after.sav')),log=readFileSync(join(dir,'worker.log'),'utf8');
  const local={...bloodSaveChecks(before,after,bloodResult(log),id),...bloodChildChecks(c?.code,c?.timedOut,log,id),
   savedLogout:c?.persisted===true&&(after.vars[134]??0)>(before.vars[134]??0),beforeHash:c?.before===hash(join(dir,'before.sav')),afterHash:c?.after===hash(join(dir,'after.sav')),logHash:c?.log===hash(join(dir,'worker.log'))};
  for(const [key,value] of Object.entries(local))checks[id+':'+key]=value;
  observed[id]={result:bloodResult(log),...bloodObservations(log)};
 }
 const report={ok:Object.values(checks).every(Boolean),at:Date.now(),checks,observed,scope:'Native installed blood chest CLI only: two loots from the arrival tile with a bank trip, a cap exit from the dungeon and a level refusal. No live release, unattended, rival player or speed claim.',nextConsumer:'run-blood-moneyshot-loot100: Moneyshot banks 200 Blood rune 565, then larger batches to 2100 runes'};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
// The Moneyshot profile: Thieving 99, Attack 72, Hitpoints 56, combat 37, slices of cake and coins carried.
const preset=(id:Case):SaveConfig=>({position:{...(id==='exit'?STAGE:ARRIVAL),level:0},skills:{Thieving:id==='refusal'?58:99,Attack:72,Hitpoints:56,Agility:60},
 inventory:[{id:CAKE,count:3},{id:COINS,count:40}],bank:[{id:COINS,count:1000},{id:314,count:7}]});
const CASES:Record<Case,{cap:string;maxLoots:string;timeoutMs:number}>={
 // CAP 2500 ticks is 375 s at 150 ms; the margin covers login and logout.
 entry:{cap:'2500',maxLoots:'2',timeoutMs:420000},
 // The soft cap is reached at once, so the worker takes the exit from the dungeon inside EXIT_TICKS.
 exit:{cap:String(EXIT_TICKS),maxLoots:'2',timeoutMs:150000},
 refusal:{cap:'2500',maxLoots:'2',timeoutMs:90000},
};
export function childConfiguration(name:string,id:Case,inherited:NodeJS.ProcessEnv=process.env,endpoints?:ProofEndpoints){
 const c=CASES[id];
 return{cmd:['bun','scripts/blood-chest.ts',name,c.cap],cwd:root,windowsHide:true,
  env:{...inherited,...endpoints?.env,...(endpoints?{GATEWAY_URL:endpoints.gateway}:{}),DEMO_OK:'',RANDOM_EVENTS:'0',MAX_LOOTS:c.maxLoots,CAP:c.cap}};
}
async function run(directory:string){
 if(!existsSync(join(root,'.practice/delivery-native.lock')))throw Error('practice turn required: run through delivery');
 if(freemem()/2**30<FREE_FLOOR_GB)throw Error('insufficient free memory: below the floor');
 mkdirSync(directory,{recursive:true});
 // Exclusive delivery folder: do not overwrite previous before/ snapshots.
 if(existsSync(join(directory,'native.json'))||cases.some(id=>existsSync(join(directory,id))))throw Error('blood proof directory already used');
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:'blood-chest-order'}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  const pin=source(),receipts=[],endpoints=selectBloodProofEndpoints();
  stack=await startBloodProofStack(endpoints);
  for(const [index,id] of cases.entries()){
   if(freemem()/2**30<FREE_FLOOR_GB)throw Error('insufficient practice free memory floor');
   const dir=join(directory,id);mkdirSync(dir);
   const name=runBotName('bloodshot',index+1),botDir=join(root,'vendor/rs-sdk/bots',name);
   if(existsSync(botDir))throw Error('isolated practice identity already exists');
   const account=await createBot(name);
   writeFileSync(account.envPath,bloodProofAccountEnv(readFileSync(account.envPath,'utf8'),endpoints));
   const c=CASES[id],path=await applyPreset(name,preset(id));copyFileSync(path,join(dir,'before.sav'));
   const child=Bun.spawn({...childConfiguration(name,id,process.env,endpoints),windowsHide:true,stdout:Bun.file(join(dir,'worker.log')),stderr:Bun.file(join(dir,'worker.err'))});
   let timedOut=false,termination:Promise<void>|undefined;const timer=setTimeout(()=>{timedOut=true;termination=killTree(child.pid)},c.timeoutMs);
   const code=await child.exited;clearTimeout(timer);await termination;
   const before=readPracticeSave(join(dir,'before.sav'));
   const persisted=await waitPracticeSave(path,s=>(s.vars[134]??0)>(before.vars[134]??0),{timeoutMs:15000});
   copyFileSync(path,join(dir,'after.sav'));
   receipts.push({id,name,code,timedOut,persisted:persisted.matched,before:hash(join(dir,'before.sav')),after:hash(join(dir,'after.sav')),log:hash(join(dir,'worker.log'))});
   writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source:pin,tickMs:PROOF_TICK_MS,xpRate:XP_RATE,server:endpoints.server,endpoints:{ports:endpoints.ports,instance:endpoints.instance},cases:receipts},null,2));
   // Preserve the failed case; do not proceed with a still-owned account.
   if(!persisted.matched||timedOut)throw Error('blood child logout/save deadline; evidence retained');
  }
  return verifyBlood(directory);
 }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
}
if(import.meta.main){try{if(!process.env.DELIVERY_DIR)throw Error('run through the blood-chest-order delivery harness');const directory=resolve(process.env.DELIVERY_DIR);process.exitCode=(process.argv[2]==='--verify'?verifyBlood(directory):await run(directory)).ok?0:1;}catch(error){console.error(String(error));process.exitCode=1;}}
