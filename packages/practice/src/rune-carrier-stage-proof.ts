import {readFileSync,writeFileSync,copyFileSync,mkdirSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';
import {freemem} from 'node:os';
import {startStack} from './stack';
import {ISOLATED,ISOLATED_ENGINE_ENV,pointBotAt} from './rehearse';
import {createBot} from './bots';
import {applyPreset} from './presets';
import {runBotName} from './prove';
import {killTree} from './proc';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {releaseRevision} from '../../core/src/worker-release';
import {PRACTICE_STARTUP_GB,FREE_FLOOR_GB} from '../../core/src/memory';
const root=resolve(import.meta.dir,'../../..');
const source=()=>releaseRevision(['scripts/rune-bank-craft.ts','packages/practice/src/rune-carrier-stage-proof.ts']);
const kit:Record<number,number>={1351:1,590:1,303:1,315:1,1925:1,1931:1,2309:1,1265:1,1205:1,1277:1,1171:1,841:1,882:25,556:25,558:15,555:6,557:4,559:2,995:25};
const assets=(s:ReturnType<typeof readPracticeSave>)=>{const out:Record<number,number>={};for(const i of Object.values(s.inventories).flat())out[i.id]=(out[i.id]??0)+i.count;return out;};
const amount=(s:ReturnType<typeof readPracticeSave>,id:number,inventory?:number)=>Object.entries(s.inventories).filter(([key])=>inventory===undefined||Number(key)===inventory).flatMap(([,items])=>items).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
export function runeCohortAssetsPreserved(before:ReturnType<typeof readPracticeSave>,after:ReturnType<typeof readPracticeSave>,essenceDelta:number){
 const want=assets(before),got=assets(after);want[1436]=(want[1436]??0)+essenceDelta;
 // Fixtures omit empty inventories. Engine saves can include the same empty equipment inventory.
 return [...new Set([...Object.keys(want),...Object.keys(got)])].every(id=>(want[Number(id)]??0)===(got[Number(id)]??0))
  &&JSON.stringify(before.inventories[94]??[])===JSON.stringify(after.inventories[94]??[]);
}
function verifyCohort(dir:string){
 const meta=JSON.parse(readFileSync(join(dir,'cohort.json'),'utf8'));
 const cases=meta.cases.map((c:any)=>{
  const before=c.names.map((_:string,i:number)=>readPracticeSave(join(dir,c.id+'-before-'+i+'.sav')));
  const after=c.names.map((_:string,i:number)=>readPracticeSave(join(dir,c.id+'-after-'+i+'.sav')));
  const log=readFileSync(join(dir,c.id+'.log'),'utf8');
  const line=log.split(/\r?\n/).find(l=>l.startsWith('RUNE_CARRIER_STAGE_RESULT '));
  const result=line?JSON.parse(line.slice('RUNE_CARRIER_STAGE_RESULT '.length)):null;
  const moved=c.id==='existing'?162:0;
  const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
  const checks={exit:c.code===(moved?0:1)&&!c.timedOut&&!c.lowMemory,
   entry:same(before[1].position,{x:3113,z:9555,level:0})&&amount(before[1],553,93)===1&&amount(before[1],552,94)===1&&before[1].skills[3].level===26&&before[1].skills[6].level===1,
   stock:amount(before[0],1436)===469&&amount(before[1],1436)===243&&amount(after[0],1436)===469-moved&&amount(after[1],1436)===243+moved,
   assets:before.every((b:ReturnType<typeof readPracticeSave>,i:number)=>runeCohortAssetsPreserved(b,after[i],i===0?-moved:moved)),
   xp:before.every((b:any,i:number)=>b.skills.every((s:any,j:number)=>s.rawExperience===after[i].skills[j].rawExperience)),
   health:after[1].skills[3].level===26&&after[1].skills[6].level===1,
   skull:amount(after[1],553,95)===1&&amount(after[1],553,93)===0&&amount(after[1],552,94)===1,
   output:moved?same(after[1].position,{x:2523,z:4833,level:0})&&amount(after[1],1436,95)===378&&amount(after[1],1436,93)===27&&amount(after[1],1446,93)===1&&result?.receivedEssence===162&&result?.receivedTalismans===0&&result?.ok===true
    :result?.ok===false&&/supplier lacks kits plus opening reserve/.test(result?.failure??'')&&result?.rows?.length===0,
   logout:result?.logout===true&&(log.match(/^LOGOUT logged-out\r?$/gm)??[]).length===2&&!/WARN logout/.test(log),
   publications:c.publications.length===2&&c.publications.every((p:any)=>p.matched&&readFileSync(join(dir,c.id+'-after-'+p.index+'.sav')).readInt32BE(24)===p.expectedTicks),
   leases:c.names.every((n:string)=>!existsSync(join(root,'.practice/account-leases',n.toLowerCase()+'.lock')))};
  return {...c,checks,ok:Object.values(checks).every(Boolean)};
 });
 return {ok:cases.length===2&&cases.every((c:any)=>c.ok),cases};
}

async function runCohort(dir:string,baseName:string){
 const meta={cases:[] as any[]};
 for(const id of ['existing','reserve-refusal']){
  const names=[baseName+(id==='existing'?'f':'h'),baseName+(id==='existing'?'g':'i')];
  const paths=names.map(n=>join(root,'vendor/rs-sdk/server/engine/data/players/main',n+'.sav'));
  if(paths.some(existsSync))throw Error('cohort fixture already exists');
  for(const n of names){const bot=await createBot(n);pointBotAt(bot.envPath,ISOLATED.engine,ISOLATED.gateway);}
  await applyPreset(names[0]!,{position:{x:3094,z:3491,level:0},skills:{Hitpoints:33,Magic:1},bank:[{id:1436,count:469},{id:995,count:4321},{id:590,count:1}]});
  await applyPreset(names[1]!,{position:{x:3113,z:9555,level:0},skills:{Hitpoints:26,Magic:1,Runecraft:1},inventory:[{id:553,count:1}],equipment:[{id:552,count:1,slot:2}],bank:[{id:1436,count:243},{id:1446,count:1},{id:995,count:1234},{id:590,count:1}]});
  paths.forEach((p,i)=>copyFileSync(p,join(dir,id+'-before-'+i+'.sav')));
  const ticks=paths.map(p=>readFileSync(p).readInt32BE(24)),started=Date.now();
  // The default purpose must still refuse to spend the supplier's opening reserve.
  const child=Bun.spawn(['bun','--smol','scripts/rune-bank-craft.ts',...names,'--rune-carriers'],{cwd:root,env:{...process.env,DEMO_OK:'',CAP:'2800',RUNE_STAGE_PURPOSE:id==='existing'?'existing-cohort':'fresh'},windowsHide:true,stdout:Bun.file(join(dir,id+'.log')),stderr:Bun.file(join(dir,id+'.err'))});
  let timedOut=false,lowMemory=false,termination:Promise<void>|undefined;
  const stop=()=>{termination??=killTree(child.pid);};
  const timer=setTimeout(()=>{timedOut=true;stop();},240000),floor=setInterval(()=>{if(freemem()/2**30<FREE_FLOOR_GB){lowMemory=true;stop();}},1000);
  const code=await child.exited;clearTimeout(timer);clearInterval(floor);await termination;
  const c={id,names,code,timedOut,lowMemory,publications:[] as any[]};meta.cases.push(c);
  writeFileSync(join(dir,'cohort.json'),JSON.stringify(meta,null,2));
  if(!timedOut&&!lowMemory)for(let i=0;i<2;i++){
   const status=JSON.parse(readFileSync(join(root,'.practice/status',names[i]+'.json'),'utf8'));
   const expectedResult=id==='existing'?'ok':'fail';
   if(status.name!==names[i]||status.server!=='localhost:8910'||status.started<started||!new RegExp('^'+expectedResult+'(?:\\s|$)').test(status.result??'')||!Number.isSafeInteger(status.tick)||status.tick<1)throw Error('fresh cohort status unavailable');
   const expectedTicks=ticks[i]!+status.tick,saved=await waitPracticeSave(paths[i]!,()=>readFileSync(paths[i]!).readInt32BE(24)===expectedTicks,{timeoutMs:6000});
   c.publications.push({index:i,expectedTicks,matched:saved.matched});
  }
  paths.forEach((p,i)=>copyFileSync(p,join(dir,id+'-after-'+i+'.sav')));
  writeFileSync(join(dir,'cohort.json'),JSON.stringify(meta,null,2));
  if(timedOut||lowMemory||code!==(id==='existing'?0:1))throw Error('cohort CLI failed: '+id);
 }
}
function verify(dir:string){
 const meta=JSON.parse(readFileSync(join(dir,'native.json'),'utf8'));
 if(meta.phases.length!==3||meta.phases.some((p:any)=>p.code!==0||p.timedOut||p.lowMemory)){
  const report={ok:false,reason:'native staging phases incomplete',phases:meta.phases};writeFileSync(join(dir,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
 }
 const read=(phase:string,i:number)=>readPracticeSave(join(dir,phase+'-'+i+'.sav'));
 const final=meta.names.map((_:string,i:number)=>read('opening',i)),before=readPracticeSave(join(dir,'source-before.sav'));
 const totals:Record<number,number>={};for(const save of final)for(const [id,n]of Object.entries(assets(save)))totals[Number(id)]=(totals[Number(id)]??0)+n;
 const expected=assets(before);for(const [id,n]of Object.entries(kit))expected[Number(id)]=(expected[Number(id)]??0)+4*n;
 const results=Object.fromEntries(meta.phases.map((p:any)=>{const line=readFileSync(join(dir,p.id+'.log'),'utf8').split(/\r?\n/).find(l=>l.startsWith('RUNE_CARRIER_STAGE_RESULT '));return [p.id,line?JSON.parse(line.slice('RUNE_CARRIER_STAGE_RESULT '.length)):null];}));
 const cohort=verifyCohort(dir);
 const checks={cohort:cohort.ok,source:meta.source===source(),delivery:meta.delivery===basename(dir)&&Number.isFinite(meta.at)&&meta.at<=Date.now(),fresh:meta.freshAbsent===true&&final.slice(1).every((s:any)=>s.vars[281]===1000),
  phases:meta.phases.every((p:any)=>results[p.id]?.ok===true&&results[p.id]?.logout===true),
  stock:[...new Set([...Object.keys(expected),...Object.keys(totals)])].every(id=>(totals[Number(id)]??0)===(expected[Number(id)]??0)),
  carriers:final.slice(1).every((s:any)=>s.position.x===2523&&s.position.z===4833&&s.position.level===0&&amount(s,1436,93)===27&&amount(s,1446,93)===1&&amount(s,1436,95)===378&&amount(s,1446)===1),
  sourceStock:amount(final[0],1436)===4380&&amount(final[0],1446)===2&&amount(final[0],1438)===1,
  opening:Math.max(Math.abs(final[0].position.x-3222),Math.abs(final[0].position.z-3222))<=1&&final[0].position.level===0&&amount(final[0],1436,93)===27&&amount(final[0],1438,93)===1&&Object.values(final[0].inventories[93]??[]).every((i:any)=>i.id===1436||i.id===1438),
  xp:final[0].skills.every((s:any,i:number)=>s.rawExperience===before.skills[i]!.rawExperience)&&final.slice(1).every((s:any)=>s.skills.every((v:any,i:number)=>v.rawExperience===(i===3?9800:0))),
  repeat:results.repeat?.receivedEssence===0&&results.repeat?.receivedTalismans===0&&results.repeat?.rows?.length===4&&meta.names.every((_:string,i:number)=>JSON.stringify(assets(read('stage',i)))===JSON.stringify(assets(read('repeat',i))))&&readFileSync(join(dir,'stage-0.sav')).equals(readFileSync(join(dir,'repeat-0.sav'))),
  publications:meta.phases.every((p:any)=>p.publications.length===(p.id==='stage'?5:p.id==='repeat'?4:1)&&p.publications.every((q:any)=>q.matched&&readFileSync(join(dir,p.id+'-'+q.index+'.sav')).readInt32BE(24)===q.expectedTicks)),
  logout:meta.phases.reduce((n:number,p:any)=>n+[...readFileSync(join(dir,p.id+'.log'),'utf8').matchAll(/^LOGOUT (.*)$/gm)].reduce((m,x)=>m+(x[1]!.match(/\blogged-out\b/g)??[]).length,0),0)===10,
  leases:meta.names.every((n:string)=>!existsSync(join(root,'.practice/account-leases',n.toLowerCase()+'.lock')))};
 const report={ok:Object.values(checks).every(Boolean),checks,cohort,names:meta.names,phases:meta.phases,source:meta.source,tickMs:150,xpRate:25,scope:'Actual Rune worker CLI. Four authentic fresh carriers receive owned kits, bank and stage; repeat sends nothing; supplier stages the opening pack. Existing cohort exits the skull room, transfers162 essence and preserves307 with the supplier. Fresh reserve shortage refuses. All supplies are fixtures. No live claim.'};
 writeFileSync(join(dir,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
async function run(dir:string){
 if(!existsSync(join(root,'.practice/delivery-native.lock')))throw Error('practice turn required: run through delivery');
 if(freemem()/2**30<PRACTICE_STARTUP_GB)throw Error('HOST_DEFERRED_NATIVE_HEADROOM: no stack started');
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,task:'rune-carrier-stage',directory:dir}));closeSync(fd);
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  stack=await startStack({tickMs:150,xpRate:25,ports:ISOLATED,instance:'rune-carrier-stage',readyTimeoutMs:60000,enginePreload:{module:join(root,'packages/practice/src/save-endpoint.ts'),env:{...ISOLATED_ENGINE_ENV,BUILD_LIVE_RELOAD:'false',BUILD_STARTUP:'false',NODE_INFINITE_RUN:'true'}}});
  const name=runBotName('flrs',0),names=[name,...['b','c','d','e'].map(s=>name+s)],paths=names.map(n=>join(root,'vendor/rs-sdk/server/engine/data/players/main',n+'.sav'));
  if(paths.some(existsSync))throw Error('staging names already have saved state');
  for(const n of names){const bot=await createBot(n);pointBotAt(bot.envPath,ISOLATED.engine,ISOLATED.gateway);}
  await applyPreset(name,{position:{x:3185,z:3436,level:0},skills:{Attack:47,Hitpoints:33,Cooking:30,Crafting:51,Mining:99,Thieving:99,Runecraft:99},inventory:[{id:1438,count:1}],bank:[{id:1436,count:6000},{id:1446,count:6},{id:995,count:100000},{id:590,count:1}]});
  copyFileSync(paths[0]!,join(dir,'source-before.sav'));
  const meta={source:source(),delivery:basename(dir),at:Date.now(),names,freshAbsent:paths.slice(1).every(p=>!existsSync(p)),phases:[] as any[]};
  const saveMeta=()=>writeFileSync(join(dir,'native.json'),JSON.stringify(meta,null,2));saveMeta();
  for(const id of ['stage','repeat','opening']){
   const active=id==='stage'?[0,1,2,3,4]:id==='repeat'?[1,2,3,4]:[0],base=paths.map(p=>existsSync(p)?readFileSync(p).readInt32BE(24):0),started=Date.now();
   const args=id==='opening'?[name,'--rune-opening']:[...names,'--rune-carriers'];
   const child=Bun.spawn(['bun','--smol','scripts/rune-bank-craft.ts',...args],{cwd:root,env:{...process.env,DEMO_OK:'',CAP:'1600',RUNE_STAGE_PURPOSE:'fresh'},windowsHide:true,stdout:Bun.file(join(dir,id+'.log')),stderr:Bun.file(join(dir,id+'.err'))});
   let timedOut=false,lowMemory=false,termination:Promise<void>|undefined;
   const stop=()=>{termination??=killTree(child.pid);};
   const timer=setTimeout(()=>{timedOut=true;stop();},240000),floor=setInterval(()=>{if(freemem()/2**30<FREE_FLOOR_GB){lowMemory=true;stop();}},1000);
   const code=await child.exited;clearTimeout(timer);clearInterval(floor);await termination;
   const phase={id,code,timedOut,lowMemory,elapsedMs:Date.now()-started,publications:[] as any[]};meta.phases.push(phase);saveMeta();
   if(code===0)for(const index of active){
    const status=JSON.parse(readFileSync(join(root,'.practice/status',names[index]+'.json'),'utf8'));
    if(status.name!==names[index]||status.server!=='localhost:8910'||status.started<started||!/^ok(?:\s|$)/.test(status.result??'')||!Number.isSafeInteger(status.tick)||status.tick<1)throw Error('fresh staging status unavailable: '+names[index]);
    const expectedTicks=base[index]!+status.tick,saved=await waitPracticeSave(paths[index]!,()=>readFileSync(paths[index]!).readInt32BE(24)===expectedTicks,{timeoutMs:6000});
    phase.publications.push({index,name:names[index],expectedTicks,matched:saved.matched});saveMeta();if(!saved.matched)throw Error('staging save publication timed out: '+names[index]);
   }
   for(let i=0;i<paths.length;i++)if(existsSync(paths[i]!))copyFileSync(paths[i]!,join(dir,id+'-'+i+'.sav'));
   if(code!==0||timedOut||lowMemory)break;
  }
  if(meta.phases.length===3&&meta.phases.every(p=>p.code===0&&!p.timedOut&&!p.lowMemory))await runCohort(dir,name);
  return verify(dir);
 }finally{try{await stack?.stop();}finally{if(stack)for(const [service,path]of Object.entries(stack.logs))if(existsSync(path))copyFileSync(path,join(dir,service+'.log'));if(existsSync(lock)&&JSON.parse(readFileSync(lock,'utf8')).pid===process.pid)unlinkSync(lock);}}
}
if(import.meta.main){try{
 if(!process.env.DELIVERY_DIR)throw Error('run through delivery (DELIVERY_DIR)');
 const dir=resolve(process.env.DELIVERY_DIR);mkdirSync(dir,{recursive:true});process.exitCode=(process.argv[2]==='--verify'?verify(dir):await run(dir)).ok?0:1;
}catch(error){console.error(String(error));process.exitCode=1;}}
