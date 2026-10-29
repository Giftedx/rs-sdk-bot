import {readFileSync,writeFileSync,copyFileSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {freemem} from 'node:os';
import {startStack} from './stack';
import {createBot} from './bots';
import {applyPreset} from './presets';
import {runBotName} from './prove';
import {killTree} from './proc';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {workerSourceRevision} from '../../core/src/worker-release';

type Save=ReturnType<typeof readPracticeSave>;
const count=(s:Save,id:number)=>(s.inventories[95]??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
export function wineSaveChecks(before:Save,after:Save){
 const notes=(s:Save)=>(s.inventories[93]??[]).filter(i=>i.id===1996).reduce((n,i)=>n+i.count,0);
 return{entry:before.skills[7]!.level===1&&count(before,1995)>0&&notes(before)===600,
  target:after.skills[7]!.level===99&&after.skills[7]!.xp>before.skills[7]!.xp,
  input:count(after,1995)===0&&(notes(after)===0||notes(after)===notes(before)),
  accounting:count(after,1991)+count(after,1993)+notes(after)===count(before,1995)+notes(before),
  health:after.skills[3]!.level===before.skills[3]!.level};
}
function verify(directory:string){
 const before=readPracticeSave(join(directory,'before.sav')),after=readPracticeSave(join(directory,'after.sav'));
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8')),log=readFileSync(join(directory,'worker.log'),'utf8');
 const summary=JSON.parse(log.split('\n').find(l=>l.startsWith('WINE_ORDER_RESULT '))?.slice('WINE_ORDER_RESULT '.length)??'null');
 const checks={...wineSaveChecks(before,after),exit:meta.code===0&&!meta.timedOut,
  logout:Array.isArray(summary?.stages)&&summary.stages.length>=1&&summary.stages.length<=2&&(log.match(/LOGOUT logged-out/g)??[]).length===summary.stages.length,
  result:summary?.ok===true&&summary?.targetMet===true,
  source:meta.source===workerSourceRevision(),fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000};
 const report={ok:Object.values(checks).every(Boolean),at:Date.now(),scope:'One native400ms/25x staged wine order. No live, unattended or comparative speed claim.',checks,cookingXp:after.skills[7]!.xp,workerElapsedMs:meta.workerElapsedMs};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
async function run(directory:string){
 if(freemem()/2**30<12)throw Error('insufficient practice startup reserve');
 const lock=resolve(import.meta.dir,'../../../.practice/delivery-practice.lock'),fd=openSync(lock,'wx');
 writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:'wine-order'}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  const source=workerSourceRevision(),name=runBotName('wine',1);
  const botDir=resolve(import.meta.dir,'../../../vendor/rs-sdk/bots',name);if(existsSync(botDir))throw Error('fresh account required');
  stack=await startStack({tickMs:400,readyTimeoutMs:60000});await createBot(name);
  if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local fixture required');
  const path=await applyPreset(name,{position:{x:3092,z:3243,level:0},bank:[{id:1995,count:150}],inventory:[{id:1996,count:600}]});copyFileSync(path,join(directory,'before.sav'));
  const started=Date.now(),child=Bun.spawn(['bun','scripts/cook-wine.ts',name,'99','80'],{cwd:resolve(import.meta.dir,'../../..'),env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0'},stdout:Bun.file(join(directory,'worker.log')),stderr:Bun.file(join(directory,'worker.err')),windowsHide:true});
  let timedOut=false,termination:Promise<void>|undefined;const timer=setTimeout(()=>{timedOut=true;termination=killTree(child.pid)},90000);
  const code=await child.exited;clearTimeout(timer);await termination;
  const workerElapsedMs=Date.now()-started;
  await waitPracticeSave(path,s=>s.skills[7]!.level===99);copyFileSync(path,join(directory,'after.sav'));
  writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),name,source,code,timedOut,workerElapsedMs},null,2));return verify(directory);
 }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
}
if(import.meta.main){
 try{
  if(!process.env.DELIVERY_DIR)throw Error('run through bun run deliver wine-order');
  const directory=resolve(process.env.DELIVERY_DIR);
  process.exitCode=(process.argv[2]==='--verify'?verify(directory):await run(directory)).ok?0:1;
 }catch(error){console.error(String(error));process.exitCode=1;}
}
