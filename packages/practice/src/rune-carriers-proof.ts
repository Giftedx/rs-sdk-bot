// Delivery owns the native turn. This proof runs the shared worker's real CLI.
import {copyFileSync,writeFileSync,readFileSync,mkdirSync,openSync,closeSync,unlinkSync,existsSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';
import {freemem} from 'node:os';
import {createHash} from 'node:crypto';
import {ISOLATED,ISOLATED_ENGINE_ENV,pointBotAt} from './rehearse';
import {startStack} from './stack';
import {createBot} from './bots';
import {applyPreset} from './presets';
import {runBotName} from './prove';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {killTree} from './proc';
import {PRACTICE_STARTUP_GB,FREE_FLOOR_GB} from '../../core/src/memory';
import {xpForLevel,levelForXp} from '../../planner/src/curve';
import {runRunePipeline,verifyRunePipeline} from './rune-pipeline-proof';
const root=resolve(import.meta.dir,'../../..'),helpers=16;
const TICK_MS=400,WORKER_CAP=2800,WORKER_TIMEOUT_MS=WORKER_CAP*TICK_MS+60000;
const files=['scripts/rune-pipeline.ts','scripts/rune-bank-craft.ts','scripts/rune-carriers.ts','scripts/rune-carrier-start.ts','scripts/rune-carrier-trade.ts','scripts/rune-carrier-bank.ts','scripts/rune-carrier-roster.ts','packages/practice/src/rune-carriers-proof.ts'];
const hashes=()=>Object.fromEntries(files.map(f=>[f,createHash('sha256').update(readFileSync(join(root,f))).digest('hex')]));

function verify(dir:string){
 const meta=JSON.parse(readFileSync(join(dir,'native.json'),'utf8')),stdout=readFileSync(join(dir,'worker.log'),'utf8');
 const line=stdout.split(/\r?\n/).find(l=>l.startsWith('RUNE_CARRIERS_RESULT ')),result=line?JSON.parse(line.slice('RUNE_CARRIERS_RESULT '.length)):null;
 const saves=meta.names.map((_:string,i:number)=>readPracticeSave(join(dir,i+'-after.sav')));
 const total=(i:number,id:number)=>Object.values(saves[i].inventories).flat().filter((t:any)=>t.id===id).reduce((n:number,t:any)=>n+t.count,0),all=(id:number)=>saves.reduce((n:number,_:unknown,i:number)=>n+total(i,id),0);
 const airXp=27*125,batches=Math.ceil((xpForLevel(99)-airXp)/(27*187.5)),consumed=batches*27;
 const bodyRunes=Array.from({length:batches},(_,i)=>27*(Math.floor(levelForXp(airXp+i*27*187.5)/46)+1)).reduce((n,x)=>n+x,0);
 const checks={exit:meta.code===0&&!meta.timedOut&&!meta.lowMemory,watcher:meta.randomEvents===true,source:JSON.stringify(hashes())===JSON.stringify(meta.source),saveVersion:saves.every((s:any)=>s.version===10),publications:meta.publications?.length===helpers+1&&meta.publications.every((p:any,i:number)=>p.name===meta.names[i]&&p.matched===true&&readFileSync(join(dir,i+'-after.sav')).readInt32BE(24)===p.expectedTicks),fresh:meta.freshAbsent===true&&saves[0].vars[281]===1000,
  xp:saves[0].skills[20].rawExperience===(airXp+consumed*187.5)*10&&saves[0].skills[20].level===99,runes:all(559)===bodyRunes+2&&all(556)===52,
  essence:total(0,1436)===0&&all(1436)===helpers*405-consumed,talisman:all(1446)===helpers+1&&all(1438)===1,
  helper:saves.slice(1).every((s:any)=>s.skills[20].rawExperience===0),coins:all(995)===25,starter:!!result?.prefix?.starterKit&&Object.entries(result.prefix.starterKit).every(([id,n])=>all(Number(id))===Number(n)+(Number(id)===556?27:Number(id)===559?bodyRunes:0)),
  handoff:result?.craftAfter==='trade-message'&&result?.pipeline===true,handlers:verifyRunePipeline(join(dir,'handlers')).ok,restock:result?.batches===batches&&result.crew.every((h:any)=>h.refills.length>0),logout:result?.logout===true&&[...stdout.matchAll(/^LOGOUT (.*)$/gm)].reduce((n,m)=>n+(m[1]!.match(/\blogged-out\b/g)??[]).length,0)===helpers+1};
 const master=readFileSync(join(dir,'0-after.sav')),accountTicks=meta.names.map((_:string,i:number)=>readFileSync(join(dir,i+'-after.sav')).readInt32BE(24)-(i?readFileSync(join(dir,i+'-before.sav')).readInt32BE(24):0));
 const report={ok:Object.values(checks).every(Boolean),checks,craftAfter:result?.craftAfter,workerFailure:result?.failure??null,source:meta.source,names:meta.names,tickMs:400,xpRate:25,infiniteRun:true,buildLiveReload:false,levelTicks:saves[0].version===10?master.readInt32BE(master.length-184):null,accountTicks,combinedTicks:accountTicks.reduce((n:number,t:number)=>n+t,0),elapsedMs:meta.elapsedMs,
  scope:'Actual rune-bank-craft CLI, authentic fresh master to99,16 bank carriers, pre-supplied helper kits and positions. No live rank claim.'};
 writeFileSync(join(dir,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
async function run(dir:string){
 if(freemem()/2**30<PRACTICE_STARTUP_GB)throw Error('HOST_DEFERRED_NATIVE_HEADROOM: no stack started');
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,task:'rune-carriers',directory:dir}));closeSync(fd);
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  if(!(await runRunePipeline(join(dir,'handlers'))).ok)throw Error('Pinned trade controller fixture failed before native launch');
  const source=hashes();for(const f of files)copyFileSync(join(root,f),join(dir,basename(f)));
  stack=await startStack({tickMs:TICK_MS,xpRate:25,readyTimeoutMs:60000,ports:ISOLATED,instance:'rune-carriers',enginePreload:{module:join(root,'packages/practice/src/save-endpoint.ts'),env:{...ISOLATED_ENGINE_ENV,BUILD_LIVE_RELOAD:'false',BUILD_STARTUP:'false',NODE_INFINITE_RUN:'true'}}});
  const name=runBotName('flrc',0),names=[name,...Array.from({length:helpers},(_,i)=>name+String.fromCharCode(98+i))],paths=names.map(n=>join(root,'vendor/rs-sdk/server/engine/data/players/main',n+'.sav'));
  if(paths.some(existsSync))throw Error('fresh names already have saved state');
  for(const n of names){const bot=await createBot(n);pointBotAt(bot.envPath,ISOLATED.engine,ISOLATED.gateway);}
  for(let i=1;i<names.length;i++){
   await applyPreset(names[i]!,i===1?{position:{x:3222,z:3223,level:0},inventory:[{id:1438,count:1},...Array.from({length:27},()=>({id:1436,count:1}))],bank:[{id:1436,count:405},{id:1446,count:2}]}:
    {position:{x:2523,z:4833,level:0},inventory:[{id:1446,count:1},...Array.from({length:27},()=>({id:1436,count:1}))],bank:[{id:1436,count:378}]});
   copyFileSync(paths[i]!,join(dir,i+'-before.sav'));
  }
  const freshAbsent=!existsSync(paths[0]!);if(!freshAbsent)throw Error('master save exists before first login');
  const started=Date.now(),child=Bun.spawn(['bun','--smol','scripts/rune-bank-craft.ts',...names,'--carriers'],{cwd:root,env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'1',CAP:String(WORKER_CAP),RUNE_CRAFT_AFTER:'trade-message',RUNE_HANDOFF_PIPELINE:'1',BODY_XP_RATE:'25'},windowsHide:true,stdout:Bun.file(join(dir,'worker.log')),stderr:Bun.file(join(dir,'worker.err'))});
  let timedOut=false,lowMemory=false,termination:Promise<void>|undefined;
  const stop=()=>{termination??=killTree(child.pid);};
  const timer=setTimeout(()=>{timedOut=true;stop();},WORKER_TIMEOUT_MS),floor=setInterval(()=>{if(freemem()/2**30<FREE_FLOOR_GB){lowMemory=true;stop();}},1000);
  const code=await child.exited;clearTimeout(timer);clearInterval(floor);await termination;
  const meta={source,names,freshAbsent,code,timedOut,lowMemory,randomEvents:true,workerCap:WORKER_CAP,workerTimeoutMs:WORKER_TIMEOUT_MS,elapsedMs:Date.now()-started,publications:[] as {name:string;expectedTicks:number;matched:boolean}[]};
  writeFileSync(join(dir,'native.json'),JSON.stringify(meta,null,2));
  for(let i=0;i<paths.length;i++)if(existsSync(paths[i]!)){
   if(code===0){
    const status=JSON.parse(readFileSync(join(root,'.practice/status',names[i]+'.json'),'utf8'));
    if(status.name!==names[i]||status.server!=='localhost:8910'||status.started<started||!/^ok(?:\s|$)/.test(status.result??'')||!Number.isSafeInteger(status.tick)||status.tick<1)throw Error('fresh completed carrier status unavailable: '+names[i]);
    const expectedTicks=(i?readFileSync(join(dir,i+'-before.sav')).readInt32BE(24):0)+status.tick;
    const saved=await waitPracticeSave(paths[i]!,()=>readFileSync(paths[i]!).readInt32BE(24)===expectedTicks,{timeoutMs:6000});
    meta.publications.push({name:names[i]!,expectedTicks,matched:saved.matched});writeFileSync(join(dir,'native.json'),JSON.stringify(meta,null,2));
    if(!saved.matched)throw Error('final carrier save publication timed out: '+names[i]);
   }
   copyFileSync(paths[i]!,join(dir,i+'-after.sav'));
  }
  return verify(dir);
 }finally{try{await stack?.stop();}finally{
  if(stack)for(const [service,path]of Object.entries(stack.logs))if(existsSync(path))copyFileSync(path,join(dir,service+'.log'));
  if(existsSync(lock)&&JSON.parse(readFileSync(lock,'utf8')).pid===process.pid)unlinkSync(lock);
 }}
}
if(import.meta.main){
 try{
  if(!process.env.DELIVERY_DIR)throw Error('run through the delivery harness (DELIVERY_DIR)');
  const dir=join(resolve(process.env.DELIVERY_DIR),'rune-carriers');mkdirSync(dir,{recursive:true});
  process.exitCode=(process.argv[2]==='--verify'?verify(dir):await run(dir)).ok?0:1;
 }catch(error){console.error(String(error));process.exitCode=1;}
}
