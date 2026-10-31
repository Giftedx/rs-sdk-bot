// Harness entry only. Import and --verify never start services or log in.
import {readFileSync,writeFileSync,copyFileSync,existsSync,mkdirSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {freemem} from 'node:os';
import {startStack} from './stack';
import {createBot} from './bots';
import {applyPreset,type SaveConfig} from './presets';
import {runBotName} from './prove';
import {killTree} from './proc';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {workerSourceRevision} from '../../core/src/worker-release';
import {FREE_FLOOR_GB} from '../../core/src/memory';

type Save=ReturnType<typeof readPracticeSave>;
const root=resolve(import.meta.dir,'../../..');
const owned=['scripts/ranged-train.ts','scripts/ranged-train.test.ts','packages/practice/src/ranged-train-proof.ts'];
const source=()=>({runtime:workerSourceRevision(),files:Object.fromEntries(owned.map(p=>[p,createHash('sha256').update(readFileSync(join(root,p))).digest('hex')]))});
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const ARROWS=[882,884,886,888,890,892],COINS=995,BONES=526,CHICKEN=2138,FEATHER=314,FOOD=329,OAK_SHORTBOW=843,BANK={x:3253,z:3421};
const TARGET=10,MAX_SPEND=800;
// Bigchopper status (.practice/status/Bigchopper.json): Ranged 7, HP 16, shortbow banked, sword and shield worn,
// at Varrock East bank. The fixture adds an oak shortbow and keeps 15 arrows so the bow choice and the Lowe purchase run.
export const RANGED_FIXTURE:SaveConfig={position:{x:3253,z:3420,level:0},
 skills:{Attack:10,Defence:10,Strength:11,Hitpoints:16,Ranged:7},
 inventory:[315,2309,1349,1438].map(id=>({id,count:1})),
 equipment:[{id:1277,count:1,slot:3},{id:1171,count:1,slot:5}],
 bank:[{id:COINS,count:1000},{id:841,count:1},{id:OAK_SHORTBOW,count:1},{id:884,count:10},{id:882,count:5},{id:FOOD,count:3},{id:1511,count:13},{id:590,count:1}]};
export function rangedChildConfiguration(name:string,inherited:NodeJS.ProcessEnv=process.env){
 return {cmd:['bun','scripts/ranged-train.ts',name,String(TARGET),'3000'],cwd:root,
  env:{...inherited,DEMO_OK:'',RANDOM_EVENTS:'0',MIN_ARROWS:'30',BUY_ARROWS:'40',BUY_ARROW_ID:'882',MAX_SPEND:String(MAX_SPEND),COIN_RESERVE:'0',AMMO:'60',FOOD:'3',FOOD_ID:String(FOOD),KILLS_PER_TRIP:'5',MAX_TRIPS:'2'},windowsHide:true};
}
const total=(s:Save,id:number)=>Object.values(s.inventories).flat().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const worn=(s:Save)=>(s.inventories[94]??[]).map(i=>i.id).sort((a,b)=>a-b);
export function rangedResult(log:string){try{return JSON.parse(log.split(/\r?\n/).filter(l=>l.startsWith('RANGED_TRAIN_RESULT ')).at(-1)?.slice(20)??'null');}catch{return null;}}
export function rangedSaveChecks(before:Save,after:Save,r:any){
 const p=after.position,ids=new Set([...Object.values(before.inventories).flat(),...Object.values(after.inventories).flat()].map(i=>i.id));
 const free=new Set([...ARROWS,COINS,BONES,CHICKEN,FEATHER,FOOD]);
 const arrows=(s:Save)=>ARROWS.reduce((n,id)=>n+total(s,id),0);
 return {
  entry:before.skills[4]!.level===7&&before.skills[4]!.level<TARGET&&total(before,OAK_SHORTBOW)===1&&arrows(before)===15&&total(before,COINS)===1000,
  target:r?.ok===true&&r.targetMet===true&&r.stop==='target-level'&&after.skills[4]!.level>=TARGET&&r.finalLevel===after.skills[4]!.level&&r.startLevel===7,
  xp:Number.isSafeInteger(r?.xpGain)&&r.xpGain>0&&after.skills[4]!.xp-before.skills[4]!.xp===r.xpGain,
  bow:r?.bow===OAK_SHORTBOW&&total(after,OAK_SHORTBOW)===1,
  arrows:Number.isSafeInteger(r?.arrowsBought)&&r.arrowsBought>0&&Number.isSafeInteger(r.arrowsSpent)&&r.arrowsSpent>=0&&r.arrowsSpent<=r.shots
   &&arrows(after)===arrows(before)+r.arrowsBought-r.arrowsSpent,
  coins:Number.isSafeInteger(r?.coinsSpent)&&r.coinsSpent>0&&r.coinsSpent<=MAX_SPEND&&total(before,COINS)-total(after,COINS)===r.coinsSpent&&r.shopVisits>=1,
  loot:Number.isSafeInteger(r?.kills)&&r.kills>=1&&total(after,BONES)-total(before,BONES)===r.kills&&total(after,CHICKEN)-total(before,CHICKEN)===r.kills,
  food:Number.isSafeInteger(r?.eaten)&&total(before,FOOD)-total(after,FOOD)===r.eaten,
  assets:[...ids].every(id=>free.has(id)||total(after,id)===total(before,id))&&JSON.stringify(worn(after))===JSON.stringify(worn(before)),
  bank:p.level===0&&Math.max(Math.abs(p.x-BANK.x),Math.abs(p.z-BANK.z))<=4,
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
 const checks:Record<string,boolean>={...rangedSaveChecks(before,after,rangedResult(log)),...rangedChildChecks(meta.code,meta.timedOut,log),
  source:JSON.stringify(meta.source)===JSON.stringify(source()),configuration:meta.tickMs===150&&meta.xpRate===25,persisted:meta.persisted===true,
  fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000,
  beforeHash:meta.before===hash(join(directory,'before.sav')),afterHash:meta.after===hash(join(directory,'after.sav')),logHash:meta.log===hash(join(directory,'worker.log'))};
 const report={ok:Object.values(checks).every(Boolean),at:Date.now(),checks,
  scope:'One native 150ms/25x Ranged 7->10 order on a Bigchopper-shaped clone with an added oak shortbow and 15 arrows. No live, unattended or speed claim.',
  nextConsumer:'Bigchopper live order: bun scripts/ranged-train.ts Bigchopper <TARGET_LEVEL> with FOOD_ID=329; its owned 111 arrows pass MIN_ARROWS=30, so no purchase is expected.'};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
// Delivery admits the practice start reserve before this process starts; the proof holds only the floor.
export function rangedMemoryFloor(freeGiB:number,stage:string){if(!(freeGiB>=FREE_FLOOR_GB))throw Error(`practice memory floor reached ${stage}: need ${FREE_FLOOR_GB}GiB, observed ${freeGiB.toFixed(2)}GiB`);}
const freeGiB=()=>freemem()/2**30;
async function run(directory:string){
 rangedMemoryFloor(freeGiB(),'before stack');
 mkdirSync(directory,{recursive:true});
 // Exclusive delivery folder: do not overwrite previous before/ snapshots.
 if(['native.json','before.sav','after.sav','worker.log'].some(f=>existsSync(join(directory,f))))throw Error('ranged proof directory already used');
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:'ranged-train'}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  const pin=source(),name=runBotName('flrng',1),botDir=join(root,'vendor/rs-sdk/bots',name);
  if(existsSync(botDir))throw Error('isolated practice identity already exists');
  stack=await startStack({tickMs:150,xpRate:25,readyTimeoutMs:60000});await createBot(name);
  if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local fixture required');
  const path=await applyPreset(name,RANGED_FIXTURE);copyFileSync(path,join(directory,'before.sav'));
  const log=join(directory,'worker.log'),config=rangedChildConfiguration(name);
  rangedMemoryFloor(freeGiB(),'before child');
  const child=Bun.spawn({...config,stdout:Bun.file(log),stderr:Bun.file(join(directory,'worker.err')),windowsHide:true});
  let timedOut=false,termination:Promise<void>|undefined;const stopChild=()=>{if(!termination){timedOut=true;termination=killTree(child.pid);}};
  const timer=setTimeout(stopChild,600000),floor=setInterval(()=>{if(freeGiB()<FREE_FLOOR_GB)stopChild();},1000);
  const code=await child.exited;clearTimeout(timer);clearInterval(floor);await termination;
  const before=readPracticeSave(join(directory,'before.sav'));
  const persisted=await waitPracticeSave(path,s=>s.skills[4]!.xp>before.skills[4]!.xp,{timeoutMs:15000});
  copyFileSync(path,join(directory,'after.sav'));
  writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source:pin,tickMs:150,xpRate:25,name,code,timedOut,persisted:persisted.matched,
   before:hash(join(directory,'before.sav')),after:hash(join(directory,'after.sav')),log:hash(log)},null,2));
  return verifyRanged(directory);
 }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
}
if(import.meta.main){try{if(!process.env.DELIVERY_DIR)throw Error('run through the ranged-train delivery harness');const directory=resolve(process.env.DELIVERY_DIR);process.exitCode=(process.argv[2]==='--verify'?verifyRanged(directory):await run(directory)).ok?0:1;}catch(error){console.error(String(error));process.exitCode=1;}}
