// One actual-session helper proof. No fleet order, claim, live account or CLI admission is changed.
import {copyFileSync,existsSync,mkdirSync,openSync,closeSync,readFileSync,unlinkSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {freemem} from 'node:os';
import {join,resolve} from 'node:path';
import {withPracticeTurn} from './proof-lock';
import {selectCoinProofEndpoints,startCoinProofStack,coinProofAccountEnv,coinChildConfiguration,coinRegistrationArgs} from './coin-courier-proof';
import {createBot} from './bots';
import {applyPreset} from './presets';
import {runBotName} from './prove';
import {rsSdkRoot} from './paths';
import {killTree} from '../../core/src/proc';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';
import {capabilityRevision,cachedReleaseFor} from '../../core/src/worker-release';
import {readPracticeSave,waitPracticeSave} from './fleet-player-save';
import {validOrder,type Order} from '../../core/src/fleet-trade-settlement';

const root=resolve(import.meta.dir,'../../..');
const sourceFiles=['packages/practice/src/fleet-trade-capacity-proof.ts','scripts/aio-logistics.ts','packages/workers/src/logistics/trade.ts','knowledge/items.json',
 'packages/core/src/deposit.ts','packages/core/src/bot.ts','packages/core/src/inprocess.ts','vendor/rs-sdk/sdk/actions.ts',
 'vendor/rs-sdk/server/webclient/src/config/ObjType.ts'];
const digest=(file:string)=>createHash('sha256').update(readFileSync(join(root,file))).digest('hex');
const entries=['scripts/aio-logistics.ts','packages/practice/src/fleet-trade-capacity-proof.ts'];
const diagnosticFiles=()=>Object.fromEntries(sourceFiles.map(file=>[file,digest(file)]));
const source=()=>({runtime:cachedReleaseFor(entries,root),files:diagnosticFiles()});
type Save=ReturnType<typeof readPracticeSave>;
const sum=(save:Save,id:number,container?:number)=>Object.entries(save.inventories)
 .filter(([c])=>container===undefined||Number(c)===container).flatMap(([,rows])=>rows)
 .filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const totals=(save:Save,containers=[93,94,95])=>{
 const counts:Record<number,number>={};
 for(const item of containers.flatMap(c=>save.inventories[c]??[]))counts[item.id]=(counts[item.id]??0)+item.count;
 return Object.entries(counts).sort(([a],[b])=>Number(a)-Number(b));
};

// The generated child executes this exact order through the fleet-trade helper.
// Its record names that work, rather than its temporary .practice entry path.
export function fleetTradeCapacityRecord(file:string,order:Order,account:string,env:Record<string,string|undefined>=process.env){
 if(!file.endsWith('.json')||file.includes('\0')||!validOrder(order)||![order.from,order.to].some(n=>n.toLowerCase()===account.toLowerCase()))throw Error('finite participant order required');
 if(JSON.stringify(JSON.parse(readFileSync(file,'utf8')))!==JSON.stringify(order))throw Error('native order record differs');
 return{script:'scripts/aio-logistics.ts',argv:[account,'fleet-trade',file],env:{...env,COORDINATOR_RUN_ID:undefined,
  COORDINATOR_PARTICIPANTS:JSON.stringify([order.from,order.to]),PROGRESSION_CONSUMER:undefined,PROGRESSION_METHOD:undefined,PROGRESSION_SOURCE:undefined}};
}

export function verifyFleetTradeCapacity(directory:string){
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const before=[0,1].map(i=>readPracticeSave(join(directory,`before-${i}.sav`)));
 const after=[0,1].map(i=>readPracticeSave(join(directory,`after-${i}.sav`)));
 const result=JSON.parse(readFileSync(join(directory,'transfer-result.json'),'utf8'));
 const observed=JSON.parse(readFileSync(join(directory,'transfer-observed.json'),'utf8'));
 const checks={
  source:meta.source.runtime===capabilityRevision(entries,root)&&sourceFiles.every(file=>meta.source.files[file]===digest(file)),
  fullReceiver:before[1]!.inventories[93]?.length===28&&sum(before[1]!,1895,93)===23&&sum(before[1]!,1891,93)===3
   &&sum(before[1]!,1935,93)===1&&sum(before[1]!,995,93)===800&&sum(before[1]!,1387,94)===1,
  nativeMetadata:observed.metadata.length===2&&observed.metadata.every((m:any)=>m.fire===true&&m.jug===false),
  transfer:result.ok&&observed.progress.length===2&&observed.progress.every((p:any)=>p.count===250&&p.screen===true),
  fire:sum(before[0]!,554)===250&&sum(after[0]!,554)===0&&sum(before[1]!,554)===0
   &&sum(after[1]!,554,95)===250&&sum(after[1]!,554,93)===0,
  jugOnly:sum(after[1]!,1935,93)===0&&sum(after[1]!,1935,95)===1
   &&JSON.stringify(totals(before[1]!,[93]).filter(([id])=>Number(id)!==1935))===JSON.stringify(totals(after[1]!,[93])),
  assets:before.every((s,i)=>JSON.stringify(totals(s).filter(([id])=>Number(id)!==554))
   ===JSON.stringify(totals(after[i]!).filter(([id])=>Number(id)!==554))),
  equipment:before.every((s,i)=>JSON.stringify(totals(s,[94]))===JSON.stringify(totals(after[i]!,[94]))),
  health:before.every((s,i)=>s.skills[3]!.level===after[i]!.skills[3]!.level),
  logout:result.logout.length===2&&result.logout.every((l:any,i:number)=>l.state==='confirmed'&&l.attemptId===observed.metadata[i].attemptId),
 };
 const report={ok:Object.values(checks).every(Boolean),checks,elapsedMs:meta.elapsedMs,
  scope:'One actual-session helper native proof; no CLI, live, or repeat qualification',source:meta.source};
 writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));return report;
}

export async function runFleetTradeCapacity(directory:string){
 mkdirSync(directory,{recursive:true});
 let signalled=false;
 const stopped=()=>signalled||existsSync(join(root,'.practice/stop-coordinator'))||existsSync(join(root,'.practice/stop-swarm'));
 const stop=()=>{signalled=true;};process.on('SIGINT',stop);process.on('SIGTERM',stop);
 try{return await withPracticeTurn(join(root,'.practice/delivery-native.lock'),async()=>{
  if(stopped())throw Error('native helper owner stopped; no child started');
  if(freemem()/2**30<PRACTICE_STARTUP_GB)throw Error('HOST_DEFERRED_NATIVE_HEADROOM: native startup headroom unavailable; no child started');
  const revision=source(),endpoints=selectCoinProofEndpoints(),lock=join(root,'.practice/delivery-practice.lock');
  const owner=JSON.stringify({pid:process.pid,task:'fleet-trade-capacity',directory});
  const fd=openSync(lock,'wx');writeFileSync(fd,owner);
  let stack:Awaited<ReturnType<typeof startCoinProofStack>>|undefined;
  const started=Date.now(),deadline=started+180000;
  const command=async(args:string[],label:string)=>{
   if(stopped()||freemem()/2**30<FREE_FLOOR_GB)throw Error('native helper owner stopped or memory floor reached');
   const budget=Math.min(60000,deadline-Date.now()-20000);
   if(budget<1)throw Error('native helper work budget exhausted');
   const child=Bun.spawn({...coinChildConfiguration(args,{STALL_TICKS:'0',RANDOM_EVENTS:'0'},endpoints),
    windowsHide:true,
    stdout:Bun.file(join(directory,label+'.log')),stderr:Bun.file(join(directory,label+'.err'))});
   let timedOut=false;
   const timer=setTimeout(()=>{timedOut=true;void killTree(child.pid);},budget);
   const floor=setInterval(()=>{if(stopped()||freemem()/2**30<FREE_FLOOR_GB){timedOut=true;void killTree(child.pid);}},1000);
   try{const code=await child.exited;if(timedOut||code!==0)throw Error(`${label} failed code=${code} timedOut=${timedOut}`);}
   finally{clearTimeout(timer);clearInterval(floor);}
  };
  try{
   if(stopped())throw Error('native helper owner stopped; no child started');
   if(freemem()/2**30<PRACTICE_STARTUP_GB)throw Error('HOST_DEFERRED_NATIVE_HEADROOM: native startup headroom unavailable; no child started');
   stack=await startCoinProofStack(endpoints);
   const names=[runBotName('trgive',1),runBotName('trtake',1)],saves:string[]=[];
   writeFileSync(join(directory,'endpoints.json'),JSON.stringify({names,server:endpoints.server,ports:endpoints.ports,instance:endpoints.instance}));
   for(const [i,name]of names.entries()){
    if(existsSync(join(rsSdkRoot(),'bots',name)))throw Error('practice name already exists');
    const account=await createBot(name);
    writeFileSync(account.envPath,coinProofAccountEnv(readFileSync(account.envPath,'utf8'),endpoints));
    const inventory=i?[...Array.from({length:23},()=>({id:1895,count:1})),...Array.from({length:3},()=>({id:1891,count:1})),
     {id:1935,count:1},{id:995,count:800}]:[{id:554,count:250}];
    const save=await applyPreset(name,{position:{x:i?3184:3183,z:3436,level:0},skills:{Hitpoints:99,Defence:99,Magic:99},inventory,
     equipment:i?[{id:1387,count:1,slot:3}]:[],bank:[{id:2347,count:1}]});
    saves.push(save);await command(coinRegistrationArgs(name,endpoints),'auth-'+i);
    const entry=await waitPracticeSave(save,s=>i?s.inventories[93]?.length===28&&sum(s,995,93)===800:sum(s,554,93)===250);
    if(!entry.matched)throw Error('native fixture entry not retained');
    copyFileSync(save,join(directory,`before-${i}.sav`));
   }
   const child=join(directory,'transfer.ts');
   const moduleUrl=(file:string)=>new URL('../../../'+file,import.meta.url).href;
   writeFileSync(child,`import {writeFileSync} from 'node:fs';
import {openBot,settle} from ${JSON.stringify(moduleUrl('packages/core/src/bot.ts'))};
import {readLogoutProof} from ${JSON.stringify(moduleUrl('packages/core/src/session-lifecycle.ts'))};
import {waitTicks} from ${JSON.stringify(moduleUrl('packages/core/src/ticks.ts'))};
import {performFleetTransfer,runOrderWork,watchTradeScreen} from ${JSON.stringify(moduleUrl('packages/workers/src/logistics/index.ts'))};
import {fleetTradeCapacityRecord} from ${JSON.stringify(moduleUrl('packages/practice/src/fleet-trade-capacity-proof.ts'))};
const names=${JSON.stringify(names)},sessions=[],progress=[{uncertain:false,count:0},{uncertain:false,count:0}],off=[];
let ok=false,error='';const at=Date.now();
const order={id:'native-helper-'+at,server:${JSON.stringify(endpoints.server)},from:names[0],to:names[1],item:'Fire rune',count:250,start:at,end:at+60000,meet:[{x:3183,z:3436,level:0},{x:3184,z:3436,level:0}]};
const orderPath=${JSON.stringify(join(directory,'order.json'))};writeFileSync(orderPath,JSON.stringify(order));
process.env.COORDINATOR_PARTICIPANTS=JSON.stringify(names);
try{
 for(const name of names){const s=await openBot(name,{record:fleetTradeCapacityRecord(orderPath,order,name)});sessions.push(s);await waitTicks(s,3);}
 const metadata=sessions.map(s=>({name:s.name,fire:s.client.objType(554).stackable,jug:s.client.objType(1935).stackable,pack:s.sdk.getInventory(),equipment:s.sdk.getState().equipment,attemptId:s.lifecycle?.attemptId}));
 for(const [i,s]of sessions.entries())off.push(watchTradeScreen(s,progress[i]));
 await Promise.all(sessions.map((s,i)=>runOrderWork(order,()=>performFleetTransfer(s,order,i?'to':'from',progress[i]))));
 ok=true;writeFileSync(${JSON.stringify(join(directory,'transfer-observed.json'))},JSON.stringify({at,metadata,progress}));
}catch(e){error=String(e);}finally{for(const fn of off)fn();}
const settled=await settle(sessions,ok,error||'native receiver capacity observed');
const logout=names.map(name=>readLogoutProof(name,${JSON.stringify(endpoints.server)},{root:${JSON.stringify(join(root,'.practice/session-lifecycle'))}}));
writeFileSync(${JSON.stringify(join(directory,'transfer-result.json'))},JSON.stringify({ok:settled,error,progress,logout}));
process.exit(settled?0:1);
`);
   await command([child],'transfer');
   for(const [i,save]of saves.entries()){
    const saved=await waitPracticeSave(save,s=>i?sum(s,554,95)===250:sum(s,554)===0);
    if(!saved.matched)throw Error('post-transfer save not observed');
    copyFileSync(save,join(directory,`after-${i}.sav`));
   }
   writeFileSync(join(directory,'native.json'),JSON.stringify({source:revision,elapsedMs:Date.now()-started}));
   return verifyFleetTradeCapacity(directory);
  }finally{
   try{if(stack){for(const [name,file]of Object.entries(stack.logs))if(existsSync(file))copyFileSync(file,join(directory,'stack-'+name+'.log'));await stack.stop();}}
   finally{closeSync(fd);if(existsSync(lock)&&readFileSync(lock,'utf8')===owner)unlinkSync(lock);}
  }
 },{waitMs:1800000,stopped});}
 finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}

if(import.meta.main){
 const directory=resolve(process.env.DELIVERY_DIR??join(root,'.practice','fleet-trade-capacity-'+Date.now()));
 try{const report=process.argv.includes('--verify')?verifyFleetTradeCapacity(directory):await runFleetTradeCapacity(directory);process.exitCode=report.ok?0:1;}
 catch(error){mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'failure.json'),JSON.stringify({at:Date.now(),error:String(error),files:diagnosticFiles()}));console.error(String(error));process.exitCode=1;}
}
