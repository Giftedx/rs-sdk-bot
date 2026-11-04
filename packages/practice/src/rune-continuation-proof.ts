// The delivery harness owns execution. Saved verification starts no services.
import {copyFileSync,writeFileSync,readFileSync,mkdirSync,openSync,closeSync,unlinkSync,existsSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';
import {freemem} from 'node:os';
import {createHash} from 'node:crypto';
import {ISOLATED,ISOLATED_ENGINE_ENV,pointBotAt} from './rehearse';
import {startStack} from './stack';
import {createBot} from './bots';
import {applyPreset} from './presets';
import {runBotName} from './prove';
import {readPracticeSave,waitPracticeSave,setPracticeSkills} from '../../../scripts/measure/fleet-player-save';
import {killTree} from './proc';
import {PRACTICE_STARTUP_GB,FREE_FLOOR_GB} from '../../core/src/memory';
import {releaseRevision} from '../../core/src/worker-release';
const root=resolve(import.meta.dir,'../../..'),CAP=2800,TICK_MS=400;
export const runeContinuationHelpers=[
 [2523,4833,27,6495],[2523,4833,27,108],[3050,3442,27,108],[3061,3425,27,108],
 [3071,3421,27,108],[3086,3455,27,108],[3084,3466,27,108],[3094,3491,27,108],
 [3092,3495,0,135],[3084,3464,0,135],[3077,3452,0,135],[3069,3431,0,135],
 [3058,3429,0,135],[2523,4833,27,135],[2523,4833,27,135],[2523,4833,27,135],
] as const;
const files=['scripts/rune-pipeline.ts','scripts/rune-bank-craft.ts','scripts/rune-carriers.ts','scripts/rune-carrier-start.ts','scripts/rune-carrier-trade.ts','scripts/rune-carrier-bank.ts','scripts/rune-carrier-roster.ts','packages/practice/src/rune-continuation-proof.ts'];
const hashes=()=>Object.fromEntries(files.map(f=>[f,createHash('sha256').update(readFileSync(join(root,f))).digest('hex')]));
const total=(s:ReturnType<typeof readPracticeSave>,id:number)=>Object.values(s.inventories).flat().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const pack=(s:ReturnType<typeof readPracticeSave>,id?:number)=>(s.inventories[93]??[]).filter(i=>id===undefined||i.id===id).reduce((n,i)=>n+i.count,0);
export function runeMeasurementBankedOutput(before:Pick<ReturnType<typeof readPracticeSave>,'inventories'>,after:Pick<ReturnType<typeof readPracticeSave>,'inventories'>,crafted:number){
 const count=(s:typeof before,container:number)=>(s.inventories[container]??[]).filter(i=>i.id===559).reduce((n,i)=>n+i.count,0);
 return count(after,93)===0&&count(after,95)-count(before,95)===crafted;
}
const result=(log:string)=>{const line=log.split(/\r?\n/).find(l=>l.startsWith('RUNE_CARRIERS_RESULT '));return line?JSON.parse(line.slice(21)):null;};
const logouts=(log:string)=>[...log.matchAll(/^LOGOUT (.*)$/gm)].reduce((n,m)=>n+(m[1]!.match(/\blogged-out\b/g)??[]).length,0);
const assets=(s:ReturnType<typeof readPracticeSave>)=>{
 const out:Record<number,number>={};for(const i of Object.values(s.inventories).flat())out[i.id]=(out[i.id]??0)+i.count;return out;
};
type SavedVarps={version:number;vars:Record<number,number>};
export function runeContinuationVarpDifferences(b:SavedVarps,a:SavedVarps,phase:'craft'|'refusal',entry:'body'|'falador-bank'='body'){
 // PlayerLoading reads dense v6 values, but Player.save writes only nonzero permanent v10 values.
 // Player's constructor gives absent non-int varps -1. These are the fixture's zero-valued coord/boolean vars.
 const nullDefaults=new Set([4,9,13,16,28,64,181,209,367]);
 const ids=new Set([...Object.keys(b.vars),...Object.keys(a.vars),...nullDefaults,21,25,101,134,166,168,169,275,277,300,346].map(Number));
 const differences:{id:number;before:number;expected:number;after:number}[]=[];
 for(const id of ids){
  const before=(b.vars[id]??0)|0,after=(a.vars[id]??0)|0;let expected=before;
  if(nullDefaults.has(id)&&b.vars[id]===undefined)expected=-1;
  // login_logout/login.rs2 initializes all three options only when brightness is zero.
  if([166,168,169].includes(id)&&(b.vars[166]??0)===0)expected=2;
  // Invalid fixture follower obj0 is cleared by follower_login; expired antifire is cleared at logout.
  if((id===275||id===277)&&before===0)expected=-1;
  if(phase==='craft'){
   // general/scripts/quests.rs2 recounts the fixture's completed Rune Mysteries (varp63=6).
   if(id===101&&before===0&&b.vars[63]===6)expected=1;
   // specwep.rs2 regenerates the fixture's energy to its exact maximum during the route.
   if(id===300&&before===0)expected=1000;
   // music.dbrow: Forever(2,16), Gnome Theme(2,20), Heart and Mind(6,14), Barbarianism(9,1).
   if(id===21)expected=before|1114112;
   // music.dbrow: Falador bank route adds Fanfare(2,12), Workshop(5,20), Scape Soft(5,31).
   if(entry==='falador-bank'&&id===21)expected|=1<<12;
   if(entry==='falador-bank'&&id===24)expected=before|(1<<20)|(1<<31);
   if(id===25)expected=before|16384;
   if(id===346)expected=before|2;
  }
  // logout.rs2 writes map_clock on every logout. It is a clock, not a quest or asset delta.
  if(id===134){if(after>before)continue;differences.push({id,before,expected:before+1,after});continue;}
  if(after!==expected)differences.push({id,before,expected,after});
 }
 return differences;
}
export function verifyRuneContinuation(dir:string){
 const meta=JSON.parse(readFileSync(join(dir,'native.json'),'utf8'));
 const before=meta.names.map((_:string,i:number)=>readPracticeSave(join(dir,i+'-before.sav'))),after=meta.names.map((_:string,i:number)=>readPracticeSave(join(dir,i+'-after.sav')));
 const log=readFileSync(join(dir,'worker.log'),'utf8'),r=result(log),refusal=readFileSync(join(dir,'refusal.log'),'utf8'),rr=result(refusal);
 const consumed=1096,crafted=3288;
 const varpDifferences=before.map((b:ReturnType<typeof readPracticeSave>,i:number)=>({name:meta.names[i],differences:runeContinuationVarpDifferences(b,after[i]!,'craft',i===0&&b.position.x===3011&&b.position.z===3355&&b.position.level===0?'falador-bank':'body')}));
 const refusalVarpDifferences=after.map((b:ReturnType<typeof readPracticeSave>,i:number)=>({name:meta.names[i],differences:runeContinuationVarpDifferences(b,readPracticeSave(join(dir,i+'-refusal.sav')),'refusal')}));
 const preserved=before.every((b:ReturnType<typeof readPracticeSave>,i:number)=>{
  const a=after[i]!,ids=new Set([...Object.keys(assets(b)),...Object.keys(assets(a))]);
  return [...ids].every(key=>{const id=Number(key);return id===1436||id===559&&i===0||total(a,id)===total(b,id);})
   &&JSON.stringify(b.inventories[94]??[])===JSON.stringify(a.inventories[94]??[])
   &&a.skills.every((s:any,j:number)=>i===0&&j===20||s.rawExperience===b.skills[j]!.rawExperience)
   &&a.skills[3].level>=b.skills[3].level&&varpDifferences[i]!.differences.length===0;
 });
 const checks={source:JSON.stringify(hashes())===JSON.stringify(meta.source)&&meta.runtimeRevision===releaseRevision(['scripts/rune-bank-craft.ts'],root),exit:meta.code===0&&!meta.timedOut&&!meta.lowMemory,
  entry:before[0].skills[20].xp===793125&&pack(before[0],559)===9234&&pack(before[0],1436)===0&&pack(before[0],1446)===0,
  stock:before.slice(1).reduce((n:number,s:any)=>n+total(s,1436),0)===8628&&(before[1].inventories[95]??[]).find((i:any)=>i.id===1436)?.count===6495,
  xp:after[0].skills[20].rawExperience===(793125+consumed*187.5)*10&&after[0].skills[20].level===99,
  essence:before.reduce((n:number,s:any)=>n+total(s,1436),0)-after.reduce((n:number,s:any)=>n+total(s,1436),0)===consumed,
  output:total(after[0],559)-total(before[0],559)===crafted&&pack(after[0],559)===0&&pack(after[0],1436)===0,
  assets:preserved,accounting:r?.ok===true&&r.consumed===consumed&&r.crafted===crafted&&r.batches===41,
  budget:meta.publications?.length===17&&meta.publications.every((p:any)=>p.matched&&p.ticks<=CAP)&&r.accountTicks?.every((p:any)=>p.ticks<=CAP),
  clocks:meta.names.every((_:string,i:number)=>readFileSync(join(dir,i+'-after.sav')).readInt32BE(24)>readFileSync(join(dir,i+'-before.sav')).readInt32BE(24)),
  logout:r?.logout===true&&logouts(log)===17,
  refusal:meta.refusal.code!==0&&!meta.refusal.timedOut&&!meta.refusal.lowMemory&&rr?.ok===false&&/persisted body crafter below99/.test(rr?.failure??'')&&logouts(refusal)===17,
  refusalAssets:meta.names.every((_:string,i:number)=>{const b=after[i],a=readPracticeSave(join(dir,i+'-refusal.sav'));return JSON.stringify(assets(a))===JSON.stringify(assets(b))&&JSON.stringify(a.inventories[94]??[])===JSON.stringify(b.inventories[94]??[])&&JSON.stringify(a.skills)===JSON.stringify(b.skills)&&refusalVarpDifferences[i]!.differences.length===0;})};
 const measurements=(meta.measurements??[]).map((m:any)=>{
  const b=meta.names.map((_:string,i:number)=>readPracticeSave(join(dir,i+'-'+m.prefix+'-before.sav'))),a=meta.names.map((_:string,i:number)=>readPracticeSave(join(dir,i+'-'+m.prefix+'-after.sav'))),measuredLog=readFileSync(join(dir,m.prefix+'.log'),'utf8'),rr=result(measuredLog);
  const preserved=b.every((old:ReturnType<typeof readPracticeSave>,i:number)=>{
   const next=a[i]!,spent=(rr?.rows??[]).filter((row:any)=>row.helper===meta.names[i]).reduce((n:number,row:any)=>n+row.consumed,0),ids=new Set([...Object.keys(assets(old)),...Object.keys(assets(next))]);
   return [...ids].every(key=>{const id=Number(key),expected=id===1436?(i===0?0:-spent):id===559&&i===0?972:0;return total(next,id)-total(old,id)===expected;})
    &&JSON.stringify(old.inventories[94]??[])===JSON.stringify(next.inventories[94]??[])
    &&next.skills.every((s:any,j:number)=>s.rawExperience===old.skills[j]!.rawExperience+(i===0&&j===20?607500:0))
    &&runeContinuationVarpDifferences(old,next,'craft').length===0&&pack(next,1436)===0&&next.skills[3].level>=old.skills[3].level;
  });
  const masterBefore=readFileSync(join(dir,'0-'+m.prefix+'-before.sav')),masterAfter=readFileSync(join(dir,'0-'+m.prefix+'-after.sav'));
  const checks={exit:m.execution.code===0&&!m.execution.timedOut&&!m.execution.lowMemory,
   result:rr?.ok===true&&rr.mode==='body-measure'&&rr.requestedPacks===12&&rr.craftAfter===m.craftAfter&&rr.pipeline===(m.craftAfter==='trade-message')&&rr.batches===12&&rr.consumed===324&&rr.crafted===972&&rr.rows?.every((r:any)=>r.consumed===27),
   entry:b[0].skills[20].level===99&&a[0].skills[20].level===99,assets:preserved,
   bankedOutput:runeMeasurementBankedOutput(b[0],a[0],972),
   effects:b.reduce((n:number,s:any)=>n+total(s,1436),0)-a.reduce((n:number,s:any)=>n+total(s,1436),0)===324&&total(a[0],559)-total(b[0],559)===972,
   clocks:meta.names.every((_:string,i:number)=>readFileSync(join(dir,i+'-'+m.prefix+'-after.sav')).readInt32BE(24)>readFileSync(join(dir,i+'-'+m.prefix+'-before.sav')).readInt32BE(24)),
   milestone:b[0].version===10&&a[0].version===10&&masterBefore.readInt32BE(masterBefore.length-184)===masterAfter.readInt32BE(masterAfter.length-184),
   publications:m.publications?.length===17&&m.publications.every((p:any)=>p.matched&&p.ticks<=CAP),logout:rr?.logout===true&&logouts(measuredLog)===17};
  return {craftAfter:m.craftAfter,ok:Object.values(checks).every(Boolean),checks,packs:rr?.batches,consumed:rr?.consumed,crafted:rr?.crafted,xp:a[0].skills[20].rawExperience/10-b[0].skills[20].rawExperience/10,elapsedMs:m.execution.elapsedMs};
 });
 Object.assign(checks,{measurements:measurements.length===2&&['inventory','trade-message'].every(condition=>measurements.some((m:any)=>m.craftAfter===condition&&m.ok))});
 const report={ok:Object.values(checks).every(Boolean),checks,measurements,workerFailure:r?.failure??null,source:meta.source,runtimeRevision:meta.runtimeRevision,names:meta.names,tickMs:TICK_MS,xpRate:25,cap:CAP,consumed,crafted,publications:meta.publications,varpDifferences,refusalVarpDifferences,
  scope:'Real persisted-body CLI, retained16 helper fixture, finite99 and completed-entry refusal, then12 full packs on existing99 in each craft condition. Saved assets, increasing clocks, unchanged99 milestone and17logouts per measurement. No live speed or rank claim.'};
 writeFileSync(join(dir,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
async function run(dir:string){
 if(freemem()/2**30<PRACTICE_STARTUP_GB)throw Error('HOST_DEFERRED_NATIVE_HEADROOM: no stack started');
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,task:'rune-continuation',directory:dir}));closeSync(fd);
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  const source=hashes(),runtimeRevision=releaseRevision(['scripts/rune-bank-craft.ts'],root);for(const f of files)copyFileSync(join(root,f),join(dir,basename(f)));
  stack=await startStack({tickMs:TICK_MS,xpRate:25,readyTimeoutMs:60000,ports:ISOLATED,instance:'rune-continuation',enginePreload:{module:join(root,'packages/practice/src/save-endpoint.ts'),env:{...ISOLATED_ENGINE_ENV,BUILD_LIVE_RELOAD:'false',BUILD_STARTUP:'false',NODE_INFINITE_RUN:'true'}}});
  const name=runBotName('flbc',0),names=[name,...Array.from({length:16},(_,i)=>name+String.fromCharCode(98+i))],paths=names.map(n=>join(root,'vendor/rs-sdk/server/engine/data/players/main',n+'.sav'));
  if(paths.some(existsSync))throw Error('continuation fixture names already exist');
  for(let i=0;i<names.length;i++){
   const bot=await createBot(names[i]!);pointBotAt(bot.envPath,ISOLATED.engine,ISOLATED.gateway);
   const fixture=i?runeContinuationHelpers[i-1]!:undefined;
   const position=fixture?{x:fixture[0],z:fixture[1],level:0}:{x:3011,z:3355,level:0};
   await applyPreset(names[i]!,{position,skills:{Runecraft:i===0?95:1},varps:{63:6},inventory:i===0?[{id:559,count:9234}]:[{id:1446,count:1},...Array.from({length:fixture![2]},()=>({id:1436,count:1}))],
    bank:i===0?[{id:995,count:321},{id:559,count:7},{id:1351,count:1}]:[{id:1436,count:fixture![3]},{id:995,count:i},...(i===2?[{id:1446,count:1}]:[])]});
   const saved=readPracticeSave(paths[i]!);if(i===0)setPracticeSkills(paths[i]!,saved.skills.map((s,j)=>({level:s.level,xp:j===20?793125:s.xp})));
   // These are new practice fixtures. The worker must add to a persisted clock.
   const bytes=readFileSync(paths[i]!);bytes.writeInt32BE(2788+i,24);bytes.writeUInt32BE(Bun.hash.crc32(bytes.subarray(0,-4))>>>0,bytes.length-4);writeFileSync(paths[i]!,bytes);
   copyFileSync(paths[i]!,join(dir,i+'-before.sav'));
  }
  const launch=async(prefix:string,mode='--body-continuation',craftAfter='inventory')=>{
   const started=Date.now(),child=Bun.spawn(['bun','--smol','scripts/rune-bank-craft.ts',...names,mode],{cwd:root,env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'1',CAP:String(CAP),BODY_XP_RATE:'25',RUNE_CRAFT_AFTER:craftAfter,RUNE_HANDOFF_PIPELINE:'0',RUNE_OPEN_AFTER:craftAfter==='trade-message'?'helper-ack':'incoming'},windowsHide:true,stdout:Bun.file(join(dir,prefix+'.log')),stderr:Bun.file(join(dir,prefix+'.err'))});
   let timedOut=false,lowMemory=false,termination:Promise<void>|undefined;
   const stop=()=>{termination??=killTree(child.pid);};
   const timer=setTimeout(()=>{timedOut=true;stop();},CAP*TICK_MS+60000),floor=setInterval(()=>{if(freemem()/2**30<FREE_FLOOR_GB){lowMemory=true;stop();}},1000);
   const code=await child.exited;clearTimeout(timer);clearInterval(floor);await termination;return {code,timedOut,lowMemory,started,elapsedMs:Date.now()-started};
  };
  const execution=await launch('worker'),meta={source,runtimeRevision,names,...execution,publications:[] as {name:string;ticks:number;matched:boolean}[],refusal:{} as Awaited<ReturnType<typeof launch>>,measurements:[] as {prefix:string;craftAfter:string;execution:Awaited<ReturnType<typeof launch>>;publications:{name:string;ticks:number;matched:boolean}[]}[]};
  writeFileSync(join(dir,'native.json'),JSON.stringify(meta,null,2));
  for(let i=0;i<names.length;i++){
   if(execution.code===0){
    const status=JSON.parse(readFileSync(join(root,'.practice/status',names[i]+'.json'),'utf8'));
    if(status.name!==names[i]||status.server!=='localhost:8910'||status.started<execution.started||!/^ok(?:\s|$)/.test(status.result??'')||!Number.isSafeInteger(status.tick)||status.tick<1)throw Error('completed continuation status unavailable');
    const expected=readFileSync(join(dir,i+'-before.sav')).readInt32BE(24)+status.tick;
    const published=await waitPracticeSave(paths[i]!,()=>readFileSync(paths[i]!).readInt32BE(24)===expected,{timeoutMs:6000});
    meta.publications.push({name:names[i]!,ticks:status.tick,matched:published.matched});writeFileSync(join(dir,'native.json'),JSON.stringify(meta,null,2));
    if(!published.matched)throw Error('continuation save publication unobserved');
   }
   copyFileSync(paths[i]!,join(dir,i+'-after.sav'));
  }
  if(execution.code!==0)throw Error('continuation worker failed; inspect worker.log and worker.err');
  meta.refusal=await launch('refusal');writeFileSync(join(dir,'native.json'),JSON.stringify(meta,null,2));
  for(let i=0;i<names.length;i++){
   const status=JSON.parse(readFileSync(join(root,'.practice/status',names[i]+'.json'),'utf8'));
   if(status.started<meta.refusal.started||!Number.isSafeInteger(status.tick))throw Error('refusal status unavailable');
   const expected=readFileSync(join(dir,i+'-after.sav')).readInt32BE(24)+status.tick;
   const published=await waitPracticeSave(paths[i]!,()=>readFileSync(paths[i]!).readInt32BE(24)===expected,{timeoutMs:6000});
   if(!published.matched)throw Error('refusal save publication unobserved');copyFileSync(paths[i]!,join(dir,i+'-refusal.sav'));
  }
  for(const craftAfter of ['inventory','trade-message']){
   const prefix='measure-'+craftAfter;
   for(let i=0;i<names.length;i++)copyFileSync(paths[i]!,join(dir,i+'-'+prefix+'-before.sav'));
   const execution=await launch(prefix,'--body-measure=12',craftAfter),measurement={prefix,craftAfter,execution,publications:[] as {name:string;ticks:number;matched:boolean}[]};
   meta.measurements.push(measurement);writeFileSync(join(dir,'native.json'),JSON.stringify(meta,null,2));
   for(let i=0;i<names.length;i++){
    if(execution.code===0){
     const status=JSON.parse(readFileSync(join(root,'.practice/status',names[i]+'.json'),'utf8'));
     if(status.started<execution.started||!/^ok(?:\s|$)/.test(status.result??'')||!Number.isSafeInteger(status.tick))throw Error('measurement status unavailable');
     const expected=readFileSync(join(dir,i+'-'+prefix+'-before.sav')).readInt32BE(24)+status.tick;
     const publication=await waitPracticeSave(paths[i]!,()=>readFileSync(paths[i]!).readInt32BE(24)===expected,{timeoutMs:6000});
     measurement.publications.push({name:names[i]!,ticks:status.tick,matched:publication.matched});
     if(!publication.matched)throw Error('measurement save publication unobserved');
    }
    copyFileSync(paths[i]!,join(dir,i+'-'+prefix+'-after.sav'));
   }
   writeFileSync(join(dir,'native.json'),JSON.stringify(meta,null,2));
   if(execution.code!==0)throw Error('bounded measurement failed; inspect '+prefix+'.log');
  }
  return verifyRuneContinuation(dir);
 }finally{try{await stack?.stop();}finally{
  if(stack)for(const [service,path]of Object.entries(stack.logs))if(existsSync(path))copyFileSync(path,join(dir,service+'.log'));
  if(existsSync(lock)&&JSON.parse(readFileSync(lock,'utf8')).pid===process.pid)unlinkSync(lock);
 }}
}
if(import.meta.main){try{
 if(!process.env.DELIVERY_DIR)throw Error('run through the delivery harness (DELIVERY_DIR)');
 const dir=join(resolve(process.env.DELIVERY_DIR),'rune-continuation');mkdirSync(dir,{recursive:true});
 process.exitCode=(process.argv[2]==='--verify'?verifyRuneContinuation(dir):await run(dir)).ok?0:1;
}catch(error){console.error(String(error));process.exitCode=1;}}
