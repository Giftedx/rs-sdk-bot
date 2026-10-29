// Harness-owned native execution. Importing this module never starts a server or logs in.
import {readFileSync,writeFileSync,copyFileSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {freemem} from 'node:os';
import {startStack} from './stack';
import {createBot} from './bots';
import {applyPreset} from './presets';
import {runBotName} from './prove';
import {killTree} from './proc';
import {workerSourceRevision} from '../../core/src/worker-release';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {questSpec,questSavedChecks} from '../../../scripts/quest-order';
import {itemSaveChecks} from '../../../scripts/quest-items-order';
import { FREE_FLOOR_GB, PRACTICE_RESERVE_GB, PRACTICE_STARTUP_GB } from '../../core/src/memory';
type Save=ReturnType<typeof readPracticeSave>;
type Run={code:number;log:string};
export function parseItemResult(log:string){try{return JSON.parse(log.split(/\r?\n/).filter(l=>l.startsWith('QUEST_ITEMS_ORDER_RESULT ')).at(-1)?.slice(25)??'null');}catch{return null;}}
export function parseCookJobResult(log:string){try{return JSON.parse(log.split(/\r?\n/).filter(l=>l.startsWith('QUEST_COOK_JOB_RESULT ')).at(-1)?.slice('QUEST_COOK_JOB_RESULT '.length)??'null');}catch{return null;}}
const logout=(r:Run,n=1)=>(r.log.match(/^LOGOUT logged-out$/gm)??[]).length===n&&!/^WARN .*?(?:logout|session close)/m.test(r.log);
// The v6 fixture generator defaults all varps to 0. Player.ts constructor uses -1
// for non-INT types; PlayerLoading.load overlays only saved varps and Player.save
// omits zeros. Seed these permanent typed nulls so a second login cannot change
// their representation. Names/types: content/pack/varp.pack and the corresponding
// content/scripts configs: ownedmcannon, beehive_free, hemenster_pipe_stashed,
// arhein_crate_coord, ikov_icearrowchest_coord, exit_essence_mine_coord,
// fluffs_crate, macro_event_target_coord. Keep these varps in strict equality.
export const COOK_JOB_NATIVE_NULL_VARPS:Readonly<Record<number,number>>={4:-1,9:-1,13:-1,16:-1,28:-1,64:-1,181:-1,209:-1};
export function cookLiveRepeatSavedChecks(before:Save,after:Save,worker:Run){
 const result=parseCookJobResult(worker.log);
 // Pinned content/pack/varp.pack:134=last_logout. The sole excluded varp is
 // written by content/scripts/login_logout/logout.rs2 [logout,_]:
 // %last_logout = map_clock; even a refused zero-action session logs out.
 const vars=(s:Save)=>Object.fromEntries(Object.entries(s.vars).filter(([id])=>Number(id)!==134));
 return {
  refusal:worker.code!==0&&result?.ok===false&&/quest already complete/.test(result?.detail??'')&&logout(worker),
  assets:[93,94,95].every(id=>JSON.stringify(before.inventories[id]??[])===JSON.stringify(after.inventories[id]??[])),
  vars:JSON.stringify(vars(before))===JSON.stringify(vars(after)),
  skills:JSON.stringify(before.skills)===JSON.stringify(after.skills),
 };
}
export function cookLiveJobSavedChecks(before:Save,after:Save,worker:Run){
 const result=parseCookJobResult(worker.log),spec=questSpec('cook');
 const holdings=(s:Save)=>[...(s.inventories[93]??[]),...(s.inventories[95]??[])];
 const total=(s:Save,id:number)=>holdings(s).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const changed=new Set([1944,1927,1933,1925,1931,1947]);
 const ids=new Set([...holdings(before),...holdings(after)].map(i=>i.id));
 const xp=(s:Save)=>s.skills.find(k=>k.index===7)?.xp;
 return {
  worker:worker.code===0&&result?.ok===true&&result?.logout===true&&result?.gather?.ok===true&&result?.quest?.ok===true&&!!result?.checks&&Object.values(result.checks).length>0&&Object.values(result.checks).every(v=>v===true)&&logout(worker),
  entry:(before.vars[spec.varpId]??0)<spec.complete,
  quest:after.vars[spec.varpId]===spec.complete,
  questPoints:(after.vars[spec.qpVarpId]??0)===(before.vars[spec.qpVarpId]??0)+spec.questPoints,
  // This harness starts the pinned 25x native stack; it does not infer reward from a worker report.
  reward:xp(before)!==undefined&&xp(after)===xp(before)!+7500,
  ingredients:[1944,1927,1933].every(id=>total(after,id)===Math.max(0,total(before,id)-1)),
  containers:[[1927,1925],[1933,1931]].every(([product,container])=>total(after,container!)===total(before,container!)-(total(before,product!)>0?0:1)),
  grain:total(after,1947)>=Math.max(0,total(before,1947)-1)&&total(after,1947)<=Math.max(1,total(before,1947)),
  assets:[...ids].filter(id=>!changed.has(id)).every(id=>total(before,id)===total(after,id)),
  equipment:JSON.stringify(before.inventories[94]??[])===JSON.stringify(after.inventories[94]??[]),
  alive:(after.skills.find(s=>s.index===3)?.level??0)>0,
 };
}
export function questItemsConsumerChecks(before:Save,gathered:Save,after:Save,worker:Run,consumer:Run){
 const result=parseItemResult(worker.log);
 const holdings=(s:Save)=>[...(s.inventories[93]??[]),...(s.inventories[95]??[])];
 const assets=new Set([...holdings(gathered),...holdings(after)].map(i=>i.id).filter(id=>![1944,1927,1933].includes(id)));
 const total=(s:Save,id:number)=>holdings(s).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 let quest:any=null;try{quest=JSON.parse(consumer.log.split(/\r?\n/).filter(l=>l.startsWith('QUEST_ORDER_RESULT ')).at(-1)?.slice(19)??'null');}catch{}
 return{
  gathered:Object.values(itemSaveChecks('cook',before,gathered)).every(Boolean),
  acquired:(before.inventories[93]??[]).concat(before.inventories[95]??[]).every(i=>![1944,1927,1933].includes(i.id)),
  worker:worker.code===0&&result?.ok===true&&result?.logout===true&&result?.child?.ok===true&&logout(worker),
  consumer:consumer.code===0&&quest?.ok===true&&quest?.stages?.quest?.ok===true&&quest?.stages?.bank?.ok===true&&logout(consumer,2),
  quest:Object.values(questSavedChecks(questSpec('cook'),gathered,after)).every(Boolean),
  assets:[...assets].every(id=>total(gathered,id)===total(after,id)),
  equipment:JSON.stringify(gathered.inventories[94]??[])===JSON.stringify(after.inventories[94]??[]),
  alive:(after.skills.find(s=>s.index===3)?.level??0)>0,
 };
}
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
function verify(dir:string){
 const meta=JSON.parse(readFileSync(join(dir,'native.json'),'utf8'));
 const run=(label:string):Run=>({code:meta.codes[label],log:readFileSync(join(dir,label+'.log'),'utf8')+readFileSync(join(dir,label+'.err'),'utf8')});
 const save=(label:string)=>readPracticeSave(join(dir,label+'.sav'));
 const refusal=(label:string,reason:string)=>{const r=run(label),p=parseItemResult(r.log);return r.code!==0&&p?.ok===false&&p?.refused===reason&&p?.login===false&&!/^START |^LOGOUT /m.test(r.log)&&hash(join(dir,label+'-before.sav'))===hash(join(dir,label+'-after.sav'));};
 const interrupted=run('interrupted'),duplicate=refusal('duplicate','items already in pack');
 const sameAssets=(b:Save,a:Save)=>[93,94,95].every(id=>{
  const normalize=(s:Save)=>(s.inventories[id]??[]).map(i=>({id:i.id,count:i.count})).sort((x,y)=>x.id-y.id||x.count-y.count);
  return JSON.stringify(normalize(b))===JSON.stringify(normalize(a));
 });
 const job=run('job'),interruptedJob=run('job-interrupted'),missingJob=run('job-missing'),repeatJob=run('job-repeat');
 const checks={...questItemsConsumerChecks(save('before'),save('gathered'),save('after'),run('gather'),run('consumer')),
  liveWorker:Object.values(cookLiveJobSavedChecks(save('job-before'),save('job-after'),job)).every(Boolean),
  liveResume:Object.values(cookLiveJobSavedChecks(save('job-resume-before'),save('job-resume-after'),run('job-resume'))).every(Boolean),
  ordinaryEntry:save('job-before').position.x===3092&&save('job-before').position.z===3242&&save('job-before').position.level===0&&save('job-before').skills.find(s=>s.index===3)?.level===49,
  liveInterruption:interruptedJob.code!==0&&parseCookJobResult(interruptedJob.log)?.ok===false&&/deadline|budget|stopped|effect unobserved/.test(parseCookJobResult(interruptedJob.log)?.detail??'')&&logout(interruptedJob)&&(save('job-interrupted').vars[29]??0)<2,
  liveMissing:missingJob.code!==0&&parseCookJobResult(missingJob.log)?.ok===false&&/missing container 1925/.test(parseCookJobResult(missingJob.log)?.detail??'')&&logout(missingJob)&&sameAssets(save('job-missing-before'),save('job-missing-after'))&&(save('job-missing-after').vars[29]??0)<2,
  liveRepeat:Object.values(cookLiveRepeatSavedChecks(save('job-after'),save('job-repeat-after'),repeatJob)).every(Boolean),
  duplicate,missing:refusal('missing','missing container 1925'),complete:refusal('complete','quest already complete'),
  interruption:interrupted.code!==0&&parseItemResult(interrupted.log)?.ok===false&&/deadline|budget|stopped|effect unobserved/.test(parseItemResult(interrupted.log)?.detail??'')&&logout(interrupted)&&hash(join(dir,'before.sav'))!==hash(join(dir,'interrupted.sav')),
  surplus:Object.values(itemSaveChecks('cook',save('surplus-before'),save('surplus-after'))).every(Boolean)&&run('surplus').code===0&&logout(run('surplus')),
  source:meta.source===workerSourceRevision(),fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000};
 const report={ok:Object.values(checks).every(Boolean),at:Date.now(),source:meta.source,checks,
  scope:'Native150ms/25x: actual quest-cook-job CLI from ordinary Draynor kit/HP49, interrupted restart, missing-kit and completed-quest refusal, saved quest/QP/7500 XP, exact costs, retained assets and logout. Existing ingredient and quest adapters checked separately. Live and unattended readiness unproved.'};
 writeFileSync(join(dir,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
async function run(dir:string){
 if(freemem()/2**30<PRACTICE_STARTUP_GB)throw Error(`practice needs ${FREE_FLOOR_GB}GiB floor plus ${PRACTICE_RESERVE_GB}GiB startup reserve`);
 const lock=resolve(import.meta.dir,'../../../.practice/delivery-practice.lock'),fd=openSync(lock,'wx');
 writeFileSync(fd,JSON.stringify({pid:process.pid,task:'quest-items-order',directory:dir,at:Date.now()}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 const codes:Record<string,number>={};
 const command=async(args:string[],label:string,cap=2400)=>{
  const child=Bun.spawn(['bun',...args],{cwd:resolve(import.meta.dir,'../../..'),env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',CAP:String(cap)},stdout:Bun.file(join(dir,label+'.log')),stderr:Bun.file(join(dir,label+'.err')),windowsHide:true});
  let expired=false,termination:Promise<void>|undefined;
  const timer=setTimeout(()=>{expired=true;termination=killTree(child.pid);},420000);
  try{const code=await child.exited;codes[label]=expired?-1:code;}finally{clearTimeout(timer);await termination;}
 };
 try{
  const source=workerSourceRevision();stack=await startStack({tickMs:150,readyTimeoutMs:60000});
  const names=['qitems','qmiss','qextra','qdone'].map(n=>runBotName(n,1)),paths:string[]=[];
  for(const [i,name] of names.entries()){
   const botDir=resolve(import.meta.dir,'../../../vendor/rs-sdk/bots',name);if(existsSync(botDir))throw Error('fresh account required');
   await createBot(name);
   if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local fixture required');
   paths.push(await applyPreset(name,{position:{x:3092,z:3247,level:0},inventory:[{id:1351,count:1},...(i===2?[{id:1944,count:2}]:[])],
    bank:[...(i===1?[]:[{id:1925,count:1}]),{id:1931,count:1},{id:995,count:123}],varps:i===3?{29:2,101:1}:{}}));
  }
  const copy=(i:number,label:string)=>copyFileSync(paths[i]!,join(dir,label+'.sav'));
  const worker=(i:number,label:string,cap=2400)=>command(['scripts/quest-items-order.ts',names[i]!,'cook',`--save=${paths[i]}`],label,cap);
  for(const [i,label] of [[1,'missing'],[3,'complete']] as const){copy(i,label+'-before');await worker(i,label);copy(i,label+'-after');}
  copy(0,'before');await worker(0,'interrupted',80);
  const interrupted=await waitPracticeSave(paths[0]!,s=>JSON.stringify(s)!==JSON.stringify(readPracticeSave(join(dir,'before.sav'))),{timeoutMs:15000});
  if(!interrupted.matched)throw Error('interruption saved effect unobserved');copy(0,'interrupted');
  await worker(0,'gather');
  const gathered=await waitPracticeSave(paths[0]!,s=>Object.values(itemSaveChecks('cook',readPracticeSave(join(dir,'before.sav')),s)).every(Boolean),{timeoutMs:15000});copy(0,'gathered');
  console.log('QUEST_ITEMS_GATHER_SAVE '+JSON.stringify({position:gathered.save.position,hopper:gathered.save.vars[202]??0,flour:gathered.save.vars[203]??0,
   checks:itemSaveChecks('cook',readPracticeSave(join(dir,'before.sav')),gathered.save),worker:parseItemResult(readFileSync(join(dir,'gather.log'),'utf8'))}));
  if(codes.gather!==0||!gathered.matched)throw Error('gather failed: consumer not started');
  copy(0,'duplicate-before');await worker(0,'duplicate');copy(0,'duplicate-after');
  // No preset or inventory edit occurs between acquisition and the existing consumer.
  await command(['scripts/quest-order.ts',names[0]!,'cook',`--save=${paths[0]}`,'--timeout-ms=300000'],'consumer');
  await waitPracticeSave(paths[0]!,s=>Object.values(questSavedChecks(questSpec('cook'),readPracticeSave(join(dir,'gathered.sav')),s)).every(Boolean),{timeoutMs:15000});copy(0,'after');
  copy(2,'surplus-before');await worker(2,'surplus');
  await waitPracticeSave(paths[2]!,s=>Object.values(itemSaveChecks('cook',readPracticeSave(join(dir,'surplus-before.sav')),s)).every(Boolean),{timeoutMs:15000});copy(2,'surplus-after');
  // Separate native fixture adapters may set up ordinary actors. The WORKER receives only its account.
  for(const mode of ['normal','resume','missing']){
   const missing=mode==='missing';
   const name=runBotName(missing?'qjobmiss':mode==='resume'?'qresume':'qjob',1),botDir=resolve(import.meta.dir,'../../../vendor/rs-sdk/bots',name);
   if(existsSync(botDir))throw Error('fresh job account required');
   await createBot(name);
   if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local job fixture required');
   const path=await applyPreset(name,{position:{x:3092,z:3242,level:0},skills:{Hitpoints:49,Attack:40,Strength:40,Defence:40},
    equipment:[{id:1277,count:1,slot:3}],inventory:[...(missing?[]:[{id:1925,count:1}]),{id:1931,count:1},{id:1351,count:1},{id:379,count:3}],bank:[{id:995,count:123}],varps:{...COOK_JOB_NATIVE_NULL_VARPS,202:mode==='resume'?1:0}});
   const copyJob=(label:string)=>copyFileSync(path,join(dir,label+'.sav'));
   const cli=(label:string,cap=2400)=>command(['scripts/quest-cook-job.ts',name],label,cap);
   if(missing){copyJob('job-missing-before');await cli('job-missing');copyJob('job-missing-after');continue;}
   const label=mode==='resume'?'job-resume':'job';copyJob(label+'-before');
   if(mode==='resume'){
    await cli('job-interrupted',80);
    await waitPracticeSave(path,s=>JSON.stringify(s)!==JSON.stringify(readPracticeSave(join(dir,label+'-before.sav'))),{timeoutMs:15000});copyJob('job-interrupted');
   }
   await cli(label);
   await waitPracticeSave(path,s=>Object.values(cookLiveJobSavedChecks(readPracticeSave(join(dir,label+'-before.sav')),s,{code:codes[label]!,log:readFileSync(join(dir,label+'.log'),'utf8')})).every(Boolean),{timeoutMs:15000});copyJob(label+'-after');
   if(mode==='normal'){
    const beforeRepeat=readPracticeSave(join(dir,'job-after.sav'));
    await cli('job-repeat');
    // Do not accept the unchanged pre-repeat file while logout's save is pending.
    const flushed=await waitPracticeSave(path,s=>(s.vars[134]??0)>(beforeRepeat.vars[134]??0),{timeoutMs:15000});
    if(!flushed.matched)throw Error('Cook repeat post-logout save unobserved');
    copyJob('job-repeat-after');
   }
  }
  writeFileSync(join(dir,'native.json'),JSON.stringify({at:Date.now(),source,names,codes},null,2));return verify(dir);
 }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
}
if(import.meta.main){
 try{if(!process.env.DELIVERY_DIR)throw Error('run through the delivery harness');const dir=resolve(process.env.DELIVERY_DIR);process.exitCode=(process.argv[2]==='--verify'?verify(dir):await run(dir)).ok?0:1;}
 catch(e){console.error(String(e));process.exitCode=1;}
}
