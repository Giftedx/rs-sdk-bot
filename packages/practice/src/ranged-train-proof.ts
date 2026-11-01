// Harness entry only. Import and --verify never start services or log in.
import {readFileSync,writeFileSync,copyFileSync,existsSync,mkdirSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {freemem} from 'node:os';
import {startStack,type StackOptions} from './stack';
import {canBind} from './ports';
import {pointBotAt} from './rehearse';
import {createBot} from './bots';
import {applyPreset,type SaveConfig} from './presets';
import {runBotName} from './prove';
import {killTree} from './proc';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {workerSourceRevision} from '../../core/src/worker-release';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';

type Save=ReturnType<typeof readPracticeSave>;
const root=resolve(import.meta.dir,'../../..');
const owned=['scripts/ranged-train.ts','scripts/ranged-train.test.ts','packages/practice/src/ranged-train-proof.ts'];
const source=()=>({runtime:workerSourceRevision(),files:Object.fromEntries(owned.map(p=>[p,createHash('sha256').update(readFileSync(join(root,p))).digest('hex')]))});
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const ARROWS=[882,884,886,888,890,892],COINS=995,BONES=526,CHICKEN=2138,FEATHER=314,FOOD=1985,BANK={x:3253,z:3421};
const TARGET=71,MAX_SPEND=5000,COIN_RESERVE=400000;
// Observed underground entry and protected quest kit. Bank contents are fixture stock, not a live snapshot.
export const RANGED_FIXTURE:SaveConfig={position:{x:3113,z:9555,level:0},
 skills:{Attack:65,Defence:10,Strength:11,Hitpoints:60,Ranged:70},
 inventory:[{id:556,count:3},{id:557,count:1},{id:553,count:1}],
 equipment:[{id:552,count:1,slot:2},{id:1277,count:1,slot:3},{id:1171,count:1,slot:5}],
 bank:[{id:COINS,count:455452},{id:841,count:1},{id:884,count:82},{id:882,count:25},{id:1511,count:15},{id:1521,count:8951}]};
export function rangedChildConfiguration(name:string,inherited:NodeJS.ProcessEnv=process.env){
 return {cmd:['bun','scripts/ranged-train.ts',name,String(TARGET),'10000'],cwd:root,
  env:{...inherited,DEMO_OK:'',RANDOM_EVENTS:'0',MIN_ARROWS:'100',BUY_ARROWS:'0',BUY_ARROW_ID:'884',MAX_SPEND:String(MAX_SPEND),COIN_RESERVE:String(COIN_RESERVE),AMMO:'100',FOOD:'3',FOOD_ID:'329',KILLS_PER_TRIP:'8',MAX_TRIPS:'20'},windowsHide:true};
}
const total=(s:Save,id:number)=>Object.values(s.inventories).flat().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const worn=(s:Save)=>(s.inventories[94]??[]).map(i=>i.id).sort((a,b)=>a-b);
const atBank=(p:Save['position'])=>p.level===0&&Math.max(Math.abs(p.x-BANK.x),Math.abs(p.z-BANK.z))<=4;
// The final save, not an intermediate one: saved XP delta equals the result and the position is back at the bank.
export function rangedSaveSettled(before:Save,save:Save,r:any){return Number.isSafeInteger(r?.xpGain)&&save.skills[4]!.xp-before.skills[4]!.xp===r.xpGain&&atBank(save.position);}
export function rangedResult(log:string){try{return JSON.parse(log.split(/\r?\n/).filter(l=>l.startsWith('RANGED_TRAIN_RESULT ')).at(-1)?.slice(20)??'null');}catch{return null;}}
export function rangedSaveChecks(before:Save,after:Save,r:any){
 const p=after.position,ids=new Set([...Object.values(before.inventories).flat(),...Object.values(after.inventories).flat()].map(i=>i.id));
 const free=new Set([...ARROWS,COINS,BONES,CHICKEN,FEATHER,FOOD]);
 const arrows=(s:Save)=>ARROWS.reduce((n,id)=>n+total(s,id),0);
 return {
  entry:before.skills[4]!.level===70&&before.position.x===3113&&before.position.z===9555&&before.position.level===0&&total(before,553)===1&&total(before,552)===1&&total(before,556)===3&&total(before,557)===1&&total(before,841)===1&&arrows(before)===107&&total(before,COINS)===455452&&total(before,329)===0&&total(before,333)===0,
  target:r?.ok===true&&r.targetMet===true&&r.stop==='target-level'&&after.skills[4]!.level>=TARGET&&r.finalLevel===after.skills[4]!.level&&r.startLevel===70,
  xp:Number.isSafeInteger(r?.xpGain)&&r.xpGain>0&&after.skills[4]!.xp-before.skills[4]!.xp===r.xpGain,
  bow:r?.bow===841&&r.arrow===884&&total(after,841)===1,
  arrows:Number.isSafeInteger(r?.arrowsBought)&&r.arrowsBought>=0&&Number.isSafeInteger(r.arrowsSpent)&&r.arrowsSpent>=0&&r.arrowsSpent<=r.shots
   &&arrows(after)===arrows(before)+r.arrowsBought-r.arrowsSpent,
  coins:Number.isSafeInteger(r?.coinsSpent)&&r.coinsSpent>0&&r.coinsSpent<=MAX_SPEND&&total(before,COINS)-total(after,COINS)===r.coinsSpent&&total(after,COINS)>=COIN_RESERVE&&Number.isSafeInteger(r.travelSpent)&&r.travelSpent>=0&&r.foodSpent>0,
  loot:Number.isSafeInteger(r?.kills)&&r.kills>=1&&total(after,BONES)-total(before,BONES)===r.kills&&total(after,CHICKEN)-total(before,CHICKEN)===r.kills,
  food:r?.foodId===FOOD&&r.foodBought===3&&Number.isSafeInteger(r?.eaten)&&total(before,FOOD)+r.foodBought-total(after,FOOD)===r.eaten,
  assets:[...ids].every(id=>free.has(id)||total(after,id)===total(before,id))&&JSON.stringify(worn(after))===JSON.stringify(worn(before)),
  bank:atBank(p),
  health:after.skills[3]!.level>0&&r?.died===false&&Number.isFinite(r.hpMin)&&r.hpMin>0,
 };
}
export function rangedChildChecks(code:number,timedOut:boolean,log:string){
 log=log.replace(/\r\n/g,'\n');
 return {exit:!timedOut&&code===0,result:/^RESULT ok mode=ranged-train /m.test(log),
  logout:(log.match(/^LOGOUT logged-out$/gm)??[]).length===1&&!/^WARN .*?(logout|session close)/m.test(log)};
}
export function verifyRanged(directory:string){
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const before=readPracticeSave(join(directory,'before.sav')),after=readPracticeSave(join(directory,'after.sav')),log=readFileSync(join(directory,'worker.log'),'utf8');
 const rb=readPracticeSave(join(directory,'refusal-before.sav')),ra=readPracticeSave(join(directory,'refusal-after.sav')),rl=readFileSync(join(directory,'refusal.log'),'utf8');
 const refusalIds=new Set([...Object.values(rb.inventories).flat(),...Object.values(ra.inventories).flat()].map(i=>i.id));
 const checks:Record<string,boolean>={...rangedSaveChecks(before,after,rangedResult(log)),...rangedChildChecks(meta.code,meta.timedOut,log),
  stockOnly:rangedResult(log)?.arrowsBought===0&&rangedResult(log)?.shopVisits===0,
  refusal:meta.refusalCode!==0&&!meta.refusalTimedOut&&/coin reserve short/.test(rl)&&!/^RESULT ok/m.test(rl)
   &&(rl.match(/^LOGOUT logged-out$/gm)??[]).length===1&&[...refusalIds].every(id=>total(rb,id)===total(ra,id))&&rb.skills[4]!.xp===ra.skills[4]!.xp,
  refusalHashes:meta.refusalBefore===hash(join(directory,'refusal-before.sav'))&&meta.refusalAfter===hash(join(directory,'refusal-after.sav'))&&meta.refusalLog===hash(join(directory,'refusal.log')),
  source:JSON.stringify(meta.source)===JSON.stringify(source()),configuration:meta.tickMs===150&&meta.xpRate===25,persisted:meta.persisted===true,
  fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000,
  beforeHash:meta.before===hash(join(directory,'before.sav')),afterHash:meta.after===hash(join(directory,'after.sav')),logHash:meta.log===hash(join(directory,'worker.log'))};
 const report={ok:Object.values(checks).every(Boolean),at:Date.now(),checks,
  scope:'One native150ms/25x underground Ranged70->71 order with protected quest kit, owned shortbow and stock-only ammunition, purchased food and reconciled fares. No live or speed claim.',
  nextConsumer:'run-ranged-bigchopper-stock-only80: target80, CAP35000, MAX_SPEND4419, COIN_RESERVE400000, MIN_ARROWS200, BUY_ARROWS0, AMMO100, FOOD3, FOOD_ID329, KILLS_PER_TRIP8, MAX_TRIPS50. Fresh bank stock required. Then80->90.'};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
// Delivery admits the practice start reserve before this process starts; the proof holds only the floor.
export function rangedMemoryFloor(freeGiB:number,stage:string){if(!(freeGiB>=FREE_FLOOR_GB))throw Error(`practice memory floor reached ${stage}: need ${FREE_FLOOR_GB}GiB, observed ${freeGiB.toFixed(2)}GiB`);}
const freeGiB=()=>freemem()/2**30;
type IsolatedOptions=StackOptions&{ports:{engine:number;gateway:number};instance:string};
export function rangedStackOptions(bind=canBind):IsolatedOptions{
 // All engine listeners share this host with the default stack and need separate ports.
 for(let i=0;i<8;i++){
  const web=19100+i*10,internal=44100+i*10;
  const ports={engine:web,gateway:web+1};
  const env={WEB_MANAGEMENT_PORT:String(web+2),NODE_PORT:String(internal),LOGIN_PORT:String(internal+1),FRIEND_PORT:String(internal+2),LOGGER_PORT:String(internal+3)};
  if([ports.engine,ports.gateway,...Object.values(env).map(Number)].every(bind))return{
   tickMs:150,xpRate:25,readyTimeoutMs:60000,ports,instance:`ranged-train-${process.pid}`,
   enginePreload:{module:resolve(import.meta.dir,'save-endpoint.ts'),env},
  };
 }
 throw Error('no bindable isolated ranged-train port set (8 candidates)');
}
async function run(directory:string){
 if(!existsSync(join(root,'.practice/delivery-native.lock')))throw Error('practice turn required: run through delivery');
 rangedMemoryFloor(freeGiB(),'before stack');
 if(freeGiB()<PRACTICE_STARTUP_GB)throw Error('practice startup reserve short');
 mkdirSync(directory,{recursive:true});
 // Exclusive delivery folder: do not overwrite previous before/ snapshots.
 if(['native.json','before.sav','after.sav','worker.log'].some(f=>existsSync(join(directory,f))))throw Error('ranged proof directory already used');
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:'ranged-train'}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  const pin=source(),name=runBotName('flrng',1),botDir=join(root,'vendor/rs-sdk/bots',name);
  if(existsSync(botDir))throw Error('isolated practice identity already exists');
  const options=rangedStackOptions();
  stack=await startStack(options);
  const {envPath}=await createBot(name);
  pointBotAt(envPath,options.ports.engine,options.ports.gateway);
  const path=await applyPreset(name,RANGED_FIXTURE);copyFileSync(path,join(directory,'before.sav'));
  const log=join(directory,'worker.log'),config=rangedChildConfiguration(name);
  rangedMemoryFloor(freeGiB(),'before child');
  const child=Bun.spawn({...config,stdout:Bun.file(log),stderr:Bun.file(join(directory,'worker.err')),windowsHide:true});
  let timedOut=false,termination:Promise<void>|undefined;const stopChild=()=>{if(!termination){timedOut=true;termination=killTree(child.pid);}};
  const timer=setTimeout(stopChild,780000),floor=setInterval(()=>{if(freeGiB()<FREE_FLOOR_GB)stopChild();},1000);
  const code=await child.exited;clearTimeout(timer);clearInterval(floor);await termination;
  const before=readPracticeSave(join(directory,'before.sav')),result=rangedResult(readFileSync(log,'utf8'));
  const persisted=await waitPracticeSave(path,s=>rangedSaveSettled(before,s,result),{timeoutMs:15000});
  copyFileSync(path,join(directory,'after.sav'));
  copyFileSync(path,join(directory,'refusal-before.sav'));
  const refusalLog=join(directory,'refusal.log'),refusalConfig=rangedChildConfiguration(name);
  refusalConfig.cmd[4]='800';refusalConfig.env.COIN_RESERVE='999999';
  rangedMemoryFloor(freeGiB(),'before refusal');
  const refusal=Bun.spawn({...refusalConfig,stdout:Bun.file(refusalLog),stderr:Bun.file(join(directory,'refusal.err')),windowsHide:true});
  let refusalTimedOut=false;const refusalTimer=setTimeout(()=>{refusalTimedOut=true;void killTree(refusal.pid);},60000);
  const refusalCode=await refusal.exited;clearTimeout(refusalTimer);
  copyFileSync(path,join(directory,'refusal-after.sav'));
  writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source:pin,tickMs:150,xpRate:25,stack:options,name,code,timedOut,refusalCode,refusalTimedOut,persisted:persisted.matched,
   refusalBefore:hash(join(directory,'refusal-before.sav')),refusalAfter:hash(join(directory,'refusal-after.sav')),refusalLog:hash(refusalLog),
   before:hash(join(directory,'before.sav')),after:hash(join(directory,'after.sav')),log:hash(log)},null,2));
  return verifyRanged(directory);
 }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
}
if(import.meta.main){try{if(!process.env.DELIVERY_DIR)throw Error('run through the ranged-train delivery harness');const directory=resolve(process.env.DELIVERY_DIR);process.exitCode=(process.argv[2]==='--verify'?verifyRanged(directory):await run(directory)).ok?0:1;}catch(error){console.error(String(error));process.exitCode=1;}}
