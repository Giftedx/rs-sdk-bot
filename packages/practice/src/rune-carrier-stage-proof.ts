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
 const checks={source:meta.source===source(),delivery:meta.delivery===basename(dir)&&Number.isFinite(meta.at)&&meta.at<=Date.now(),fresh:meta.freshAbsent===true&&final.slice(1).every((s:any)=>s.vars[281]===1000),
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
 const report={ok:Object.values(checks).every(Boolean),checks,names:meta.names,phases:meta.phases,source:meta.source,tickMs:150,xpRate:25,scope:'Actual Rune worker CLI. Four authentic fresh carriers receive owned kits, bank and stage; repeat sends nothing; supplier starts at Varrock west bank and stages the opening pack. Supplier inputs are fixtures. No live claim.'};
 writeFileSync(join(dir,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
async function run(dir:string){
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
   const child=Bun.spawn(['bun','scripts/rune-bank-craft.ts',...args],{cwd:root,env:{...process.env,DEMO_OK:'',CAP:'1600'},windowsHide:true,stdout:Bun.file(join(dir,id+'.log')),stderr:Bun.file(join(dir,id+'.err'))});
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
  return verify(dir);
 }finally{try{await stack?.stop();}finally{if(stack)for(const [service,path]of Object.entries(stack.logs))if(existsSync(path))copyFileSync(path,join(dir,service+'.log'));if(existsSync(lock)&&JSON.parse(readFileSync(lock,'utf8')).pid===process.pid)unlinkSync(lock);}}
}
if(import.meta.main){try{
 if(!process.env.DELIVERY_DIR)throw Error('run through delivery (DELIVERY_DIR)');
 const dir=resolve(process.env.DELIVERY_DIR);mkdirSync(dir,{recursive:true});process.exitCode=(process.argv[2]==='--verify'?verify(dir):await run(dir)).ok?0:1;
}catch(error){console.error(String(error));process.exitCode=1;}}
