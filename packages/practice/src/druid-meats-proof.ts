// Harness entry. Imports and --verify do not start services or log in.
import {readFileSync,writeFileSync,copyFileSync,existsSync,mkdirSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {freemem} from 'node:os';
import {startStack} from './stack';
import {createBot} from './bots';
import {applyPreset,type SaveConfig} from './presets';
import {runBotName} from './prove';
import {killTree} from './proc';
import {canBind} from './ports';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {workerSourceRevision} from '../../core/src/worker-release';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';
import {MEATS,nearestMeatBank} from '../../../scripts/druid-meats';

type Save=ReturnType<typeof readPracticeSave>;
const root=resolve(import.meta.dir,'../../..');
const owned=['scripts/druid-meats.ts','scripts/druid-meats.test.ts','packages/practice/src/druid-meats-proof.ts','packages/practice/test/druid-meats-proof.test.ts'];
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const source=()=>({runtime:workerSourceRevision(),files:Object.fromEntries(owned.map(p=>[p,hash(join(root,p))]))});
export const DRUID_FIXTURE:SaveConfig={position:{x:2572,z:3268,level:1},
 skills:{Attack:94,Strength:83,Defence:76,Hitpoints:75},
 equipment:[{id:1289,count:1,slot:3},{id:1171,count:1,slot:5}],
 inventory:[{id:954,count:1},{id:329,count:2}],
 bank:[{id:995,count:1000},{id:590,count:1},{id:1511,count:13}]};
const qty=(s:Save,id:number,container?:number)=> (container===undefined?Object.values(s.inventories).flat():s.inventories[container]??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const totalMap=(s:Save)=>Object.fromEntries([...new Set(Object.values(s.inventories).flat().map(i=>i.id))].sort((a,b)=>a-b).map(id=>[id,qty(s,id)]));
const equipment=(s:Save)=>JSON.stringify((s.inventories[94]??[]).map(i=>[i.slot,i.id,i.count]));
export function druidSaveChecks(before:Save,after:Save,r:any){
 const ids=new Set([...Object.values(before.inventories).flat(),...Object.values(after.inventories).flat()].map(i=>i.id));
 const p=after.position,b=nearestMeatBank(p.x,p.z);
 return {
  entry:before.skills[3]?.level===75&&before.position.x===2572&&before.position.z===3268&&before.position.level===1&&MEATS.every(m=>qty(before,m.item)===0),
  meats:MEATS.every(m=>qty(after,m.item,95)===1&&qty(after,m.item)===1),
  kills:r?.ok===true&&r.kills===4&&Array.isArray(r.acquired)&&r.acquired.length===MEATS.length&&MEATS.every(m=>r.acquired.filter((id:number)=>id===m.item).length===1)&&r.skipped?.length===0,
  assets:[...ids].every(id=>MEATS.some(m=>m.item===id)||qty(before,id)===qty(after,id))&&equipment(before)===equipment(after),
  life:r?.died===false&&Number.isFinite(r.hpMin)&&r.hpMin>=35&&(after.skills[3]?.level??0)>0,
  bank:p.level===0&&Math.max(Math.abs(p.x-b.x),Math.abs(p.z-b.z))<=2,
 };
}
export function druidChildChecks(code:number,timedOut:boolean,log:string,refusal=false){
 log=log.replace(/\r\n/g,'\n');
 return {exit:!timedOut&&code===(refusal?1:0),
  result:refusal?/^RESULT fail mode=druid-meats Error: all-meats-owned$/m.test(log):/^RESULT ok mode=druid-meats banked=2132,2134,2136,2138$/m.test(log),
  logout:(log.match(/^LOGOUT logged-out$/gm)??[]).length===1&&!/^WARN .*?(logout|session close)/m.test(log)};
}
export function druidMemoryGate(freeGiB:number,startup=false){
 const need=startup?PRACTICE_STARTUP_GB:FREE_FLOOR_GB;
 if(!(freeGiB>=need))throw Error(`practice memory ${startup?'startup reserve':'floor'}: need ${need}GiB, observed ${freeGiB}`);
}
const parseResult=(log:string)=>{try{return JSON.parse(log.split(/\r?\n/).find(l=>l.startsWith('DRUID_MEATS_RESULT '))?.slice('DRUID_MEATS_RESULT '.length)??'null');}catch{return null;}};
export function verifyDruid(directory:string){
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const before=readPracticeSave(join(directory,'before.sav')),after=readPracticeSave(join(directory,'after.sav')),rerun=readPracticeSave(join(directory,'rerun.sav'));
 const log=readFileSync(join(directory,'worker.log'),'utf8'),refusal=readFileSync(join(directory,'rerun.log'),'utf8');
 const checks:Record<string,boolean>={...druidSaveChecks(before,after,parseResult(log)),...druidChildChecks(meta.worker.code,meta.worker.timedOut,log),
  ...Object.fromEntries(Object.entries(druidChildChecks(meta.rerun.code,meta.rerun.timedOut,refusal,true)).map(([k,v])=>['rerun_'+k,v])),
  rerunAssets:JSON.stringify(totalMap(after))===JSON.stringify(totalMap(rerun))&&equipment(after)===equipment(rerun),
  rerunNoTravel:JSON.stringify(after.position)===JSON.stringify(rerun.position)&&!refusal.includes('DRUID_MEATS_RESULT ')&&!refusal.includes('DRUID_MEATS_TRAVEL '),
  rerunNoCombat:JSON.stringify(after.skills.map(k=>k.xp))===JSON.stringify(rerun.skills.map(k=>k.xp))&&rerun.skills[3]!.level>0,
  source:JSON.stringify(meta.source)===JSON.stringify(source()),configuration:meta.tickMs===150&&meta.xpRate===25,
  persisted:meta.persisted===true,fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000,
  ...Object.fromEntries(['before.sav','after.sav','rerun.sav','worker.log','rerun.log'].map(p=>['hash_'+p,meta.hashes[p]===hash(join(directory,p))]))};
 const report={ok:Object.values(checks).every(Boolean),checks,source:meta.source,
  scope:'One HP75 Ardougne fixture, native CLI kill/pickup/bank of four meats, saved assets and life, all-owned rerun refusal and logout. No live or unattended claim.',
  consumer:'run-druid-meats-mightyrod supplies run-quest-druid-mightyrod and Herblore entry.'};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
async function run(directory:string){
 if(!existsSync(join(root,'.practice/delivery-native.lock')))throw Error('practice turn required: run through delivery');
 druidMemoryGate(freemem()/2**30,true);mkdirSync(directory,{recursive:true});
 if(['native.json','before.sav','after.sav','rerun.sav','worker.log','rerun.log'].some(p=>existsSync(join(directory,p))))throw Error('proof directory already used: preserve snapshots');
 const lock=join(root,'.practice/delivery-practice.lock'),owner=JSON.stringify({pid:process.pid,directory,task:'druid-meats-order'}),fd=openSync(lock,'wx');
 let stack:Awaited<ReturnType<typeof startStack>>|undefined,pids:string|undefined;
 const pidFile=join(root,'.practice/pids.json');
 try{
  writeFileSync(fd,owner);
  if(existsSync(pidFile)||!canBind(8888)||!canBind(7780))throw Error('practice stack has another owner: harness recovery required');
  const pin=source(),name=runBotName('fldrm',1),botDir=join(root,'vendor/rs-sdk/bots',name);
  if(existsSync(botDir))throw Error('isolated practice identity already exists');
  stack=await startStack({tickMs:150,xpRate:25,readyTimeoutMs:60000});pids=readFileSync(pidFile,'utf8');
  await createBot(name);
  if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local fixture required');
  const path=await applyPreset(name,DRUID_FIXTURE);copyFileSync(path,join(directory,'before.sav'));
  const child=async(label:string,timeoutMs:number)=>{
   druidMemoryGate(freemem()/2**30);
   const c=Bun.spawn({cmd:['bun','scripts/druid-meats.ts',name],cwd:root,
    env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',CAP:'4000'},windowsHide:true,
    stdout:Bun.file(join(directory,`${label}.log`)),stderr:Bun.file(join(directory,`${label}.err`))});
   let timedOut=false,termination:Promise<void>|undefined;
   const stop=()=>{if(!termination){timedOut=true;termination=killTree(c.pid);}};
   const timer=setTimeout(stop,timeoutMs),floor=setInterval(()=>{if(freemem()/2**30<FREE_FLOOR_GB)stop();},1000);
   try{return {code:await c.exited,get timedOut(){return timedOut;}};}
   finally{clearTimeout(timer);clearInterval(floor);await termination;}
  };
  const worker=await child('worker',690000);
  const saved=await waitPracticeSave(path,s=>MEATS.every(m=>qty(s,m.item,95)===1),{timeoutMs:15000});
  copyFileSync(path,join(directory,'after.sav'));
  if(!Object.values(druidChildChecks(worker.code,worker.timedOut,readFileSync(join(directory,'worker.log'),'utf8'))).every(Boolean)||!saved.matched){
   writeFileSync(join(directory,'failed.json'),JSON.stringify({worker,persisted:saved.matched}));throw Error('native worker failed: retain raw logs and snapshots');
  }
  const rerun=await child('rerun',45000);copyFileSync(path,join(directory,'rerun.sav'));
  writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source:pin,tickMs:150,xpRate:25,name,worker,rerun,persisted:saved.matched,
   hashes:Object.fromEntries(['before.sav','after.sav','rerun.sav','worker.log','rerun.log'].map(p=>[p,hash(join(directory,p))]))},null,2));
  return verifyDruid(directory);
 }finally{
  try{if(stack){if(!pids||!existsSync(pidFile)||readFileSync(pidFile,'utf8')!==pids)throw Error('practice stack ownership changed: no foreign stop');await stack.stop();}}
  finally{closeSync(fd);if(existsSync(lock)&&readFileSync(lock,'utf8')===owner)unlinkSync(lock);}
 }
}
if(import.meta.main){try{
 if(!process.env.DELIVERY_DIR)throw Error('run through the druid-meats-order delivery harness');
 const directory=resolve(process.env.DELIVERY_DIR);
 process.exitCode=(process.argv[2]==='--verify'?verifyDruid(directory):await run(directory)).ok?0:1;
}catch(error){console.error(String(error));process.exitCode=1;}}
