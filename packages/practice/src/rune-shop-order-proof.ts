// Harness entry only. Import and --verify never start services or log in.
// Native proof: the installed scripts/shop-buyer.ts CLI buys an exact blood rune order at the Magic Guild store on an
// ordinary generated fixture, and refuses below Magic 66, judged from the saved state.
import {copyFileSync,readFileSync,writeFileSync,mkdirSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {freemem} from 'node:os';
import {PROOF_TICK_MS,type startStack} from './stack';
import {createBot} from './bots';
import {applyPreset,type SaveConfig} from './presets';
import {runBotName} from './prove';
import {killTree} from './proc';
import {bloodProofEndpoints,selectBloodProofEndpoints,bloodProofAccountEnv,startBloodProofStack} from './blood-chest-proof';
import {capabilityRevision} from '../../core/src/worker-release';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {PROFILES} from '../../../scripts/shop-buyer';

type Save=ReturnType<typeof readPracticeSave>;
type Endpoints=ReturnType<typeof bloodProofEndpoints>;
const root=resolve(import.meta.dir,'../../..');
const workerEntry='scripts/shop-buyer.ts',proofEntry='packages/practice/src/rune-shop-order-proof.ts';
const owned=[workerEntry,'scripts/shop-buyer.test.ts',proofEntry,'packages/practice/test/rune-shop-order-proof.test.ts'];
const guild='vendor/rs-sdk/server/content/scripts/areas/area_yanille/';
const pinned=['packages/practice/src/blood-chest-proof.ts',guild+'configs/magic_guild/magic_guild.inv',guild+'configs/magic_guild/magic_guild.npc',guild+'scripts/magic_guild.rs2',
 'vendor/rs-sdk/server/content/scripts/skill_magic/configs/runes.obj','knowledge/npc-travel.json','knowledge/doors.json','knowledge/transports.json'];
// Delivery takes the practice turn and admits native startup at startupGb; this proof keeps the floor per child.
export const ADMISSION={floorGb:FREE_FLOOR_GB,startupGb:PRACTICE_STARTUP_GB};
export const XP_RATE=25,MAGIC=6,COINS=995,BLOOD_RUNE=565,BANK=95,PACK=93,WORN=94;
export const ENTRY={x:3185,z:3436,level:0},YANILLE_BANK=PROFILES.magic_guild!.bankSpot,FARE=PROFILES.magic_guild!.fare??0;
export const ORDER={target:100,maxSpend:30000,reserve:2000,coins:150000};
export const cases=['buy','refuse'] as const;
export type Case=typeof cases[number];
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
export function runeShopSource(base=root){
 return{scope:'rune-shop-order-v1',runtime:capabilityRevision([workerEntry,proofEntry],base),files:Object.fromEntries([...owned,...pinned].map(p=>[p,hash(join(base,p))]))};
}
// An ordinary save where the coin courier leaves Shaftmaker: Varrock West bank, coins banked, no blood runes.
export function runeShopFixture(id:Case):SaveConfig{
 return{position:{...ENTRY},skills:{Magic:id==='buy'?74:60,Hitpoints:10},inventory:[{id:1351,count:1}],
  bank:[{id:COINS,count:ORDER.coins},{id:590,count:1},{id:1925,count:3}]};
}
const LIMITS:Record<Case,{cap:string;timeoutMs:number}>={
 // CAP 12000 ticks bounds the worker; the child deadline keeps both cases inside the 900 s harness window.
 buy:{cap:'12000',timeoutMs:600000},
 refuse:{cap:'12000',timeoutMs:90000},
};
export function childConfiguration(name:string,id:Case,inherited:NodeJS.ProcessEnv=process.env,endpoints?:Endpoints){
 return{cmd:['bun',workerEntry,name,'magic_guild',LIMITS[id].cap],cwd:root,windowsHide:true,
  env:{...inherited,...endpoints?.env,...(endpoints?{GATEWAY_URL:endpoints.gateway}:{}),DEMO_OK:'',RANDOM_EVENTS:'0',
   ITEMS:'blood rune',STOP_AT_TARGET:'1',STOCK_TARGET:String(ORDER.target),MAX_ITEMS:String(ORDER.target),MAX_SPEND:String(ORDER.maxSpend),
   COIN_RESERVE:String(ORDER.reserve),NO_BUY_TICKS:'25',BANK_PACK:'1'}};
}
const count=(s:Save,container:number,id:number)=>(s.inventories[container]??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const total=(s:Save,id:number)=>Object.values(s.inventories).flat().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const ids=(a:Save,b:Save)=>new Set([...Object.values(a.inventories).flat(),...Object.values(b.inventories).flat()].map(i=>i.id));
export const resultValue=(log:string,key:string)=>Number(log.split(/\r?\n/).filter(l=>l.startsWith('RESULT ')).at(-1)?.match(new RegExp('\\b'+key+'=(\\d+)'))?.[1]??NaN);
const startOk=(s:Save,id:Case)=>JSON.stringify(s.position)===JSON.stringify(ENTRY)&&s.skills[MAGIC]!.level===(id==='buy'?74:60)
 &&count(s,BANK,COINS)===ORDER.coins&&total(s,COINS)===ORDER.coins&&total(s,BLOOD_RUNE)===0;
export function childChecks(code:number,timedOut:boolean,log:string,id:Case){
 return{exit:!timedOut&&(id==='buy'?code===0:code!==0),
  logout:(log.match(/^LOGOUT logged-out\r?$/gm)??[]).length===1&&!/^WARN .*?(logout|session close)/m.test(log),
  result:id==='buy'?/^RESULT ok .*\bstop=stock-target\b.*\btargetMet=1\b/m.test(log)
   :/^RESULT fail magic guild needs Magic 66 \(Magic 60\) .*\bstop=refused\b/m.test(log)};
}
// The order: 100 blood runes banked, the coin debit equal to the shop spend plus the measured boat fares, nothing else moved.
export function buyChecks(before:Save,after:Save,log:string){
 const spent=resultValue(log,'spentTotal'),fare=resultValue(log,'fareTotal'),debit=total(before,COINS)-total(after,COINS);
 return{
  entry:startOk(before,'buy'),
  target:count(after,BANK,BLOOD_RUNE)===ORDER.target&&total(after,BLOOD_RUNE)===ORDER.target
   &&resultValue(log,'boughtTotal')===ORDER.target&&resultValue(log,'bankedTotal')===ORDER.target,
  spend:Number.isSafeInteger(spent)&&spent>0&&spent<=ORDER.maxSpend,
  fares:Number.isSafeInteger(fare)&&fare>=0&&fare<=FARE,
  coins:debit===spent+fare&&total(after,COINS)>=ORDER.reserve,
  assets:[...ids(before,after)].every(id=>id===COINS||id===BLOOD_RUNE||total(before,id)===total(after,id))
   &&JSON.stringify(before.inventories[WORN]??[])===JSON.stringify(after.inventories[WORN]??[]),
  place:after.position.level===0&&Math.max(Math.abs(after.position.x-YANILLE_BANK.x),Math.abs(after.position.z-YANILLE_BANK.z))<=4,
  alive:(after.skills[3]?.level??0)>0,
 };
}
// The refusal comes before any walk: same tile, same containers, no shop-buyer start line.
export function refuseChecks(before:Save,after:Save,log:string){
 const containers=[...new Set([...Object.keys(before.inventories),...Object.keys(after.inventories)])].map(Number)
  .every(k=>JSON.stringify(before.inventories[k]??[])===JSON.stringify(after.inventories[k]??[]));
 return{entry:startOk(before,'refuse'),unchanged:containers&&JSON.stringify(before.skills)===JSON.stringify(after.skills),
  noWalk:JSON.stringify(before.position)===JSON.stringify(after.position)&&!/^(START shop-buyer|WALK|MILESTONE|BOUGHT)/m.test(log)};
}
export function caseChecks(id:Case,before:Save,after:Save,log:string,receipt:any):Record<string,boolean>{
 return{...(id==='buy'?buyChecks(before,after,log):refuseChecks(before,after,log)),...childChecks(receipt?.code,receipt?.timedOut,log,id),
  savedLogout:receipt?.persisted===true&&(after.vars[134]??0)>(before.vars[134]??0)};
}
export function verifyRuneShop(directory:string){
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const endpoints=bloodProofEndpoints(meta.endpoints?.ports,meta.endpoints?.instance??'');
 const checks:Record<string,boolean>={source:JSON.stringify(meta.source)===JSON.stringify(runeShopSource()),
  configuration:meta.tickMs===PROOF_TICK_MS&&meta.xpRate===XP_RATE,endpoints:meta.server===endpoints.server,
  // Saved effects do not expire; the source pin binds them to this code.
  fresh:Number.isFinite(meta.at)&&meta.at<=Date.now(),
  cases:JSON.stringify(meta.cases?.map((c:any)=>c.id))===JSON.stringify(cases)};
 const observed:Record<string,unknown>={};
 for(const id of cases){
  const dir=join(directory,id),c=meta.cases?.find((v:any)=>v.id===id);
  let local:Record<string,boolean>;
  try{
   const before=readPracticeSave(join(dir,'before.sav')),after=readPracticeSave(join(dir,'after.sav')),log=readFileSync(join(dir,'worker.log'),'utf8');
   local={...caseChecks(id,before,after,log,c),beforeHash:c?.before===hash(join(dir,'before.sav')),afterHash:c?.after===hash(join(dir,'after.sav')),logHash:c?.log===hash(join(dir,'worker.log'))};
   observed[id]={result:log.split(/\r?\n/).filter(l=>l.startsWith('RESULT ')).at(-1)??null,walkFails:log.split(/\r?\n/).filter(l=>/^WALK .*fail/.test(l)).slice(0,10),
    bloodBanked:count(after,BANK,BLOOD_RUNE),coinDebit:total(before,COINS)-total(after,COINS),position:after.position};
  }catch(e){local={readable:false};console.error(`${id}: ${String(e)}`);}
  for(const [k,v] of Object.entries(local))checks[`${id}:${k}`]=v;
 }
 const report={ok:Object.values(checks).every(Boolean),at:Date.now(),checks,observed,
  scope:'Native installed shop-buyer CLI on generated practice fixtures at 150ms/25x only: 100 blood runes from the Magic Guild store banked at Yanille, and a Magic 60 refusal. The coin debit includes the measured boat fares (fareTotal). No live access, unattended or speed claim.',
  nextConsumer:'run-shop-shaftmaker-blood776: Shaftmaker buys 776 Blood rune 565 with ITEMS=blood rune, STOCK_TARGET=776, MAX_ITEMS=776, MAX_SPEND=140000, COIN_RESERVE=2000; live execution belongs to the controller.'};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
async function run(directory:string){
 if(!existsSync(join(root,'.practice/delivery-native.lock')))throw Error('practice turn required: run through delivery');
 if(freemem()/2**30<FREE_FLOOR_GB)throw Error(`insufficient free memory: need ${FREE_FLOOR_GB} GiB free`);
 mkdirSync(directory,{recursive:true});
 // Exclusive delivery folder: do not overwrite previous before/ snapshots.
 if(existsSync(join(directory,'native.json'))||cases.some(id=>existsSync(join(directory,id))))throw Error('rune shop proof directory already used');
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:'rune-shop-order'}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  const pin=runeShopSource(),receipts:any[]=[],endpoints=selectBloodProofEndpoints();
  stack=await startBloodProofStack(endpoints);
  for(const [index,id] of cases.entries()){
   if(freemem()/2**30<FREE_FLOOR_GB)throw Error(`practice free floor: need ${FREE_FLOOR_GB} GiB free`);
   const dir=join(directory,id);mkdirSync(dir);
   const name=runBotName('flrune',index+1),botDir=join(root,'vendor/rs-sdk/bots',name);
   if(existsSync(botDir))throw Error('isolated practice identity already exists');
   const account=await createBot(name);
   writeFileSync(account.envPath,bloodProofAccountEnv(readFileSync(account.envPath,'utf8'),endpoints));
   const path=await applyPreset(name,runeShopFixture(id));
   copyFileSync(path,join(dir,'before.sav'));
   const before=readPracticeSave(join(dir,'before.sav')),log=join(dir,'worker.log');
   const child=Bun.spawn({...childConfiguration(name,id,process.env,endpoints),windowsHide:true,stdout:Bun.file(log),stderr:Bun.file(join(dir,'worker.err'))});
   let timedOut=false,termination:Promise<void>|undefined;const timer=setTimeout(()=>{timedOut=true;termination=killTree(child.pid);},LIMITS[id].timeoutMs);
   const code=await child.exited;clearTimeout(timer);await termination;
   const persisted=await waitPracticeSave(path,s=>(s.vars[134]??0)>(before.vars[134]??0),{timeoutMs:15000});
   copyFileSync(path,join(dir,'after.sav'));
   receipts.push({id,name,code,timedOut,persisted:persisted.matched,before:hash(join(dir,'before.sav')),after:hash(join(dir,'after.sav')),log:hash(log)});
   writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source:pin,tickMs:PROOF_TICK_MS,xpRate:XP_RATE,server:endpoints.server,endpoints:{ports:endpoints.ports,instance:endpoints.instance},cases:receipts},null,2));
   // Preserve the failed case; do not continue with a still-owned account.
   const failed=Object.entries(caseChecks(id,before,readPracticeSave(join(dir,'after.sav')),readFileSync(log,'utf8'),receipts.at(-1))).filter(([,v])=>!v).map(([k])=>k);
   if(failed.length)throw Error(`${id}: failed ${failed.join(',')}; evidence retained`);
  }
  return verifyRuneShop(directory);
 }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
}
if(import.meta.main){try{if(!process.env.DELIVERY_DIR)throw Error('run through the rune-shop-order delivery harness');const directory=resolve(process.env.DELIVERY_DIR);
 process.exitCode=(process.argv[2]==='--verify'?verifyRuneShop(directory):await run(directory)).ok?0:1;}catch(error){console.error(String(error));process.exitCode=1;}}
