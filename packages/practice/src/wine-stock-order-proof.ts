// Native paired-input production, accessible-tick preservation, owned handoff and ordinary wine consumption.
import {copyFileSync,existsSync,mkdirSync,openSync,closeSync,readFileSync,unlinkSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {freemem} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {createBot} from './bots';
import {applyPreset} from './presets';
import {runBotName} from './prove';
import {withPracticeTurn} from './proof-lock';
import {selectCoinProofEndpoints,startCoinProofStack,coinProofAccountEnv,coinChildConfiguration,coinRegistrationArgs} from './coin-courier-proof';
import {killTree} from '../../core/src/proc';
import {openBot,settle} from '../../core/src/bot';
import type {Session} from '../../core/src/inprocess';
import {waitUntil} from '../../core/src/ticks';
import {readLogoutProof} from '../../core/src/session-lifecycle';
import {capabilityRevision} from '../../core/src/worker-release';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';
import {performFleetTransfer,runOrderWork,watchTradeScreen,type Order} from '../../workers/src/logistics';
import {readPracticeSave,waitPracticeSave} from './fleet-player-save';
import {xpForLevel} from '../../planner/src/curve';

const root=resolve(import.meta.dir,'../../..'),QUANTITY=12,TARGET=72,HOLD_TICKS=25;
const entries=['scripts/aio-logistics.ts','scripts/aio-skiller.ts','packages/workers/src/bank-artisan/cooking.ts','packages/practice/src/wine-stock-order-proof.ts'];
const rules=['vendor/rs-sdk/server/content/scripts/skill_cooking/scripts/cooking_inv/scripts/wine/wine.rs2',
 'vendor/rs-sdk/server/engine/src/engine/script/handlers/PlayerOps.ts','vendor/rs-sdk/server/engine/src/engine/entity/Player.ts',
 'vendor/rs-sdk/server/content/scripts/interface_bank/scripts/bank.rs2','vendor/rs-sdk/server/content/scripts/interface_trade/scripts/trade.rs2'];
const source=()=>({runtime:capabilityRevision(entries,root),rules:Object.fromEntries(rules.map(file=>[file,createHash('sha256').update(readFileSync(join(root,file))).digest('hex')]))});
type Save=ReturnType<typeof readPracticeSave>;
export type WineStockSaves={makerBefore:Save;makerProduced:Save;makerHeld:Save;makerAfter:Save;consumerBefore:Save;consumerReady:Save;consumerAfter:Save};
const wineIds=[1991,1992,1993,1994,1995,1996];
const rows=(s:Save,containers=[93,94,95])=>containers.flatMap(id=>s.inventories[id]??[]);
const count=(s:Save,id:number,containers=[93,94,95])=>rows(s,containers).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const totals=(s:Save,exclude:number[]=[],containers=[93,94,95])=>{
 const out:Record<number,number>={};for(const i of rows(s,containers))if(!exclude.includes(i.id))out[i.id]=(out[i.id]??0)+i.count;
 return Object.entries(out).sort(([a],[b])=>+a-+b);
};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const delta=(before:Save,after:Save,changes:Record<number,number>)=>[...new Set([...rows(before).map(i=>i.id),...rows(after).map(i=>i.id),...Object.keys(changes).map(Number)])]
 .every(id=>count(after,id)===count(before,id)+(changes[id]??0));
export function wineStockSaveChecks(s:WineStockSaves){
 const {makerBefore:a,makerProduced:b,makerHeld:c,makerAfter:d,consumerBefore:e,consumerReady:f,consumerAfter:g}=s;
 return{
  unseeded:[a,e].every(save=>wineIds.every(id=>count(save,id)===0)),
  entry:a.skills[7]!.level>=35&&e.skills[7]!.level===69&&e.skills[7]!.xp===xpForLevel(69)&&count(a,1987)===14&&count(a,1937)===14,
  production:delta(a,b,{1987:-QUANTITY,1937:-QUANTITY,1996:QUANTITY})&&count(b,1996,[93])===QUANTITY&&wineIds.filter(id=>id!==1996).every(id=>count(b,id)===0),
  held:same(totals(b),totals(c))&&same(b.skills,c.skills)&&count(c,1996,[93])===QUANTITY,
  handoff:delta(c,d,{1996:-QUANTITY})&&delta(e,f,{1995:QUANTITY})&&count(f,1995,[95])===QUANTITY&&same(e.skills,f.skills),
  consumer:g.skills[7]!.level===TARGET&&g.skills[7]!.xp===e.skills[7]!.xp+QUANTITY*2750&&count(g,1993,[95])===QUANTITY&&wineIds.filter(id=>id!==1993).every(id=>count(g,id)===0),
  assets:same(totals(a,[1987,1937,...wineIds]),totals(d,[1987,1937,...wineIds]))&&count(d,1987)===2&&count(d,1937)===2
   &&same(totals(e,wineIds),totals(g,wineIds)),
  equipment:[[a,b],[a,c],[a,d],[e,f],[e,g]].every(([before,after])=>same(before!.inventories[94],after!.inventories[94])),
  health:[[a,b],[a,c],[a,d],[e,f],[e,g]].every(([before,after])=>same(before!.skills[3],after!.skills[3])),
  otherXp:same(a.skills,d.skills)&&e.skills.every((skill,i)=>i===7||same(skill,g.skills[i])),
 };
}
const readJson=(directory:string,file:string)=>JSON.parse(readFileSync(join(directory,file),'utf8'));
const result=(directory:string,label:string,prefix:string)=>{
 const lines=readFileSync(join(directory,label+'.log'),'utf8').split(/\r?\n/).filter(line=>line.startsWith(prefix));
 if(lines.length!==1)throw Error(`${label} needs one ${prefix} record`);return JSON.parse(lines[0]!.slice(prefix.length));
};
export function verifyWineStock(directory:string){
 const meta=readJson(directory,'native.json'),producer=result(directory,'produce','WINE_STOCK_RESULT '),hold=readJson(directory,'hold.json'),trade=readJson(directory,'handoff.json'),consumer=result(directory,'consume','WINE_ORDER_RESULT ');
 const saved=Object.fromEntries(['makerBefore','makerProduced','makerHeld','makerAfter','consumerBefore','consumerReady','consumerAfter'].map(key=>[key,readPracticeSave(join(directory,key+'.sav'))]))as WineStockSaves;
 const productionLog=readFileSync(join(directory,'produce.log'),'utf8');
 const checks={...wineStockSaveChecks(saved),source:same(meta.source,source()),
  children:Array.isArray(meta.children)&&['auth-0','auth-1','produce','hold','handoff','consume'].every(label=>meta.children.some((c:any)=>c.label===label&&c.code===0&&!c.timedOut)),
  produced:producer.ok===true&&producer.made===QUANTITY&&producer.noted===QUANTITY&&producer.inputs?.grapes===QUANTITY&&producer.inputs?.water===QUANTITY&&producer.assets===true
   &&new RegExp(`^RESULT ok preservedWine=${QUANTITY} grapesUsed=${QUANTITY} waterUsed=${QUANTITY} assets=1\\b`,'m').test(productionLog),
  accessible:hold.ok===true&&hold.accessibleTicks>=HOLD_TICKS&&hold.notesBefore===QUANTITY&&hold.notesAfter===QUANTITY&&hold.blockedTicks===0,
  transfer:trade.ok===true&&trade.progress?.length===2&&trade.progress.every((p:any)=>p.count===QUANTITY&&p.screen===true)&&trade.progress[1].bank?.count===QUANTITY,
  consumed:consumer.ok===true&&consumer.targetMet===true&&consumer.level===TARGET,
  logout:[hold,trade].every(p=>Array.isArray(p.logout)&&p.logout.length===(p===trade?2:1)&&p.logout.every((l:any)=>l.state==='confirmed'))
   &&/^LOGOUT logged-out$/m.test(productionLog)&&(readFileSync(join(directory,'consume.log'),'utf8').match(/^LOGOUT logged-out$/gm)??[]).length===consumer.stages?.length,
 };
 const report={ok:Object.values(checks).every(Boolean),checks,quantity:QUANTITY,target:TARGET,source:meta.source,
  scope:'One native25x paired-input order,25 accessible ticks after producer relog, owned trade, then ordinary cook-wine consumption. No live or sustained speed claim.'};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}

async function phase(directory:string,mode:string){
 const endpoint=readJson(directory,'endpoints.json'),names=endpoint.names as string[],sessions:Session[]=[];
 if(names.length!==2||names.some(name=>!/^fl[a-z0-9]{1,10}$/i.test(name))||!/^127\.0\.0\.1:\d+$/.test(endpoint.server))throw Error('owned ordinary practice names required');
 let ok=false,error='',stopped=false,data:any={};const off:(()=>void)[]=[];
 const open=async(name:string)=>{
  const env=readFileSync(join(root,'vendor/rs-sdk/bots',name,'bot.env'),'utf8');
  if(!env.split(/\r?\n/).includes('SERVER='+endpoint.server))throw Error('owned practice profile endpoint mismatch');
  const s=await openBot(name,{onStop:async()=>{stopped=true;},onSessionEnd:async()=>{stopped=true;}});sessions.push(s);return s;
 };
 try{
  if(mode==='--hold'){
   const s=await open(names[0]!);const notes=()=>s.sdk.getInventory().filter(i=>i.id===1996).reduce((n,i)=>n+i.count,0);
   data={accessibleTicks:0,blockedTicks:0,notesBefore:notes(),notesAfter:0};
   if(data.notesBefore!==QUANTITY)throw Error('produced notes not held on relog');
   let previous=s.tick();off.push(s.onTick(()=>{if(s.tick()<=previous)return;previous=s.tick();const state=s.sdk.getState();
    if(state?.bank?.isOpen||state?.interface?.isOpen||state?.dialog?.isOpen)data.blockedTicks++;else if(state?.inGame)data.accessibleTicks++;
    if(notes()!==QUANTITY||s.sdk.getInventory().some(i=>i.id===1995))stopped=true;
   }));
   if(!await waitUntil(s,()=>stopped||data.accessibleTicks>=HOLD_TICKS,{timeoutTicks:80})||stopped||data.blockedTicks)throw Error('produced notes did not survive accessible ticks');
   data.notesAfter=notes();ok=true;
  }else if(mode==='--handoff'){
   const progress:Parameters<typeof performFleetTransfer>[3][]=[{uncertain:false,count:0},{uncertain:false,count:0}];
   for(const name of names)await open(name);
   const at=Date.now(),order:Order={id:'wine-stock-'+at,server:endpoint.server,from:names[0]!,to:names[1]!,item:'Unfermented wine',count:QUANTITY,start:at,end:at+90000,
    meet:[{x:3092,z:3243,level:0},{x:3093,z:3243,level:0}]};
   for(const [i,s]of sessions.entries())off.push(watchTradeScreen(s,progress[i]!));
   await Promise.all(sessions.map((s,i)=>runOrderWork(order,()=>performFleetTransfer(s,order,i?'to':'from',progress[i]!,{gone:()=>stopped}))));
   data={progress};ok=true;
  }else throw Error('unknown wine-stock phase');
 }catch(e){error=String(e);}finally{for(const fn of off)fn();}
 const attempts=sessions.map(s=>s.lifecycle?.attemptId);ok=await settle(sessions,ok,error||'wine stock native phase');
 const logout=sessions.map(s=>readLogoutProof(s.name,endpoint.server));
 data={...data,ok:ok&&logout.every((l,i)=>l.state==='confirmed'&&l.attemptId===attempts[i]),error,logout};
 writeFileSync(join(directory,mode==='--hold'?'hold.json':'handoff.json'),JSON.stringify(data,null,2));return data;
}

// The delivery runs this proof as a check inside its own practice turn (packages/router/src/delivery-cli.ts holds
// .practice/delivery-native.lock for the child). Asking for the same turn again made the proof wait for its parent
// until its own wait ran out. The turn is held by the delivery when the delivery directory is set, the lock file of the
// proof is the file that the delivery holds, and that lock names the parent process of this one.
export function turnHeldByDelivery(lockFile:string,deliveryLock:string,env:Record<string,string|undefined>,parent:number):boolean{
 if(!env.DELIVERY_DIR||resolve(lockFile)!==resolve(deliveryLock))return false;
 try{const owner=JSON.parse(readFileSync(lockFile,'utf8'));return Number.isSafeInteger(owner?.pid)&&owner.pid===parent;}catch{return false;}
}
export async function runWineStockNative(directory:string){
 mkdirSync(directory,{recursive:true});if(existsSync(join(directory,'makerBefore.sav')))throw Error('preserve existing wine-stock evidence; use a fresh delivery directory');
 const git=Bun.spawnSync(['git','rev-parse','--git-common-dir'],{cwd:root,stdout:'pipe',stderr:'pipe',windowsHide:true});
 if(git.exitCode!==0)throw Error('shared practice owner unavailable');
 const main=dirname(resolve(root,git.stdout.toString().trim())),shared=join(main,'.practice');
 const practiceTurn:typeof withPracticeTurn=(file,run,options)=>turnHeldByDelivery(file,join(root,'.practice/delivery-native.lock'),process.env,process.ppid)?run():withPracticeTurn(file,run,options);
 let signalled=false;const stop=()=>{signalled=true;},stopped=()=>signalled||[root,main].some(base=>existsSync(join(base,'.practice/stop-coordinator'))||existsSync(join(base,'.practice/stop-swarm')));
 process.on('SIGINT',stop);process.on('SIGTERM',stop);
 try{return await practiceTurn(join(shared,'delivery-native.lock'),async()=>{
  if(stopped()||freemem()/2**30<PRACTICE_STARTUP_GB)throw Error('native wine startup headroom unavailable or owner stopped');
  const lock=join(shared,'delivery-practice.lock'),owner=JSON.stringify({pid:process.pid,task:'wine-stock-order',directory}),fd=openSync(lock,'wx');writeFileSync(fd,owner);
  const pin=source(),endpoint=selectCoinProofEndpoints(),names=[runBotName('flwine',1),runBotName('flcook',1)],saves:string[]=[],children:any[]=[];
  let stack:Awaited<ReturnType<typeof startCoinProofStack>>|undefined;
  const started=Date.now(),deadline=started+600000;
  const command=async(args:string[],label:string,env:Record<string,string>={})=>{
   if(stopped()||freemem()/2**30<FREE_FLOOR_GB)throw Error('native wine owner stopped or memory floor reached');
   const timeout=Math.min(120000,deadline-Date.now()-20000);if(timeout<1)throw Error('native wine deadline exhausted');
   const at=Date.now(),child=Bun.spawn({...coinChildConfiguration(args,{DELIVERY_DIR:directory,STALL_TICKS:'0',PROGRESSION_CONSUMER:'',...env},endpoint,process.env,root),windowsHide:true,stdout:Bun.file(join(directory,label+'.log')),stderr:Bun.file(join(directory,label+'.err'))});
   let timedOut=false,termination:Promise<void>|undefined;
   const cancel=()=>{if(!termination){timedOut=true;termination=killTree(child.pid);}},timer=setTimeout(cancel,timeout),floor=setInterval(()=>{if(stopped()||freemem()/2**30<FREE_FLOOR_GB)cancel();},1000);
   try{const code=await child.exited;await termination;children.push({label,args,code,timedOut,elapsedMs:Date.now()-at});if(timedOut||code!==0)throw Error(`${label} failed code=${code} timedOut=${timedOut}`);}
   finally{clearTimeout(timer);clearInterval(floor);}
  };
  const snapshot=async(index:number,label:string,ready:(s:Save)=>boolean)=>{
   const observed=await waitPracticeSave(saves[index]!,ready);writeFileSync(join(directory,label+'-publication.json'),JSON.stringify(observed,null,2));
   if(!observed.matched)throw Error(label+' saved-state publication unmatched');copyFileSync(saves[index]!,join(directory,label+'.sav'));
  };
  try{
   stack=await startCoinProofStack(endpoint);writeFileSync(join(directory,'endpoints.json'),JSON.stringify({names,server:endpoint.server,ports:endpoint.ports,instance:endpoint.instance}));
   for(const [i,name]of names.entries()){
    if(existsSync(join(root,'vendor/rs-sdk/bots',name)))throw Error('fresh practice account required');
    const bot=await createBot(name);writeFileSync(bot.envPath,coinProofAccountEnv(readFileSync(bot.envPath,'utf8'),endpoint));
    saves.push(await applyPreset(name,{position:{x:3092+i,z:3243,level:0},skills:{Cooking:i?69:82,Hitpoints:99},equipment:[{id:1277,count:1,slot:3}],
     inventory:i?[{id:946,count:1}]:[{id:995,count:777}],bank:i?[{id:995,count:1234}]:[{id:1987,count:14},{id:1937,count:14},{id:2347,count:1}]}));
    await command(coinRegistrationArgs(name,endpoint),'auth-'+i);
    await snapshot(i,i?'consumerBefore':'makerBefore',s=>s.skills[7]!.level===(i?69:82)&&wineIds.every(id=>count(s,id)===0));
   }
   await command(['scripts/aio-logistics.ts',names[0]!,'wine-stock','12','1000','2'],'produce');
   await snapshot(0,'makerProduced',s=>count(s,1996,[93])===QUANTITY&&count(s,1995)===0);
   await command(['packages/practice/src/wine-stock-order-proof.ts','--hold'],'hold');
   await snapshot(0,'makerHeld',s=>count(s,1996,[93])===QUANTITY&&count(s,1995)===0);
   await command(['packages/practice/src/wine-stock-order-proof.ts','--handoff'],'handoff');
   await snapshot(0,'makerAfter',s=>wineIds.every(id=>count(s,id)===0));
   await snapshot(1,'consumerReady',s=>count(s,1995,[95])===QUANTITY&&s.skills[7]!.level===69);
   await command(['scripts/aio-skiller.ts',names[1]!,'artisan','cooking','wine',String(TARGET),'80'],'consume',{PROGRESSION_CONSUMER:JSON.stringify({skills:{Cooking:TARGET}})});
   await snapshot(1,'consumerAfter',s=>s.skills[7]!.level===TARGET&&count(s,1993,[95])===QUANTITY);
   writeFileSync(join(directory,'native.json'),JSON.stringify({source:pin,children,elapsedMs:Date.now()-started},null,2));return verifyWineStock(directory);
  }catch(error){writeFileSync(join(directory,'native.json'),JSON.stringify({source:pin,children,error:String(error),elapsedMs:Date.now()-started},null,2));throw error;}
  finally{try{if(stack){for(const [label,path]of Object.entries(stack.logs))if(existsSync(path))copyFileSync(path,join(directory,'stack-'+label+'.log'));await stack.stop();}}
   finally{closeSync(fd);if(existsSync(lock)&&readFileSync(lock,'utf8')===owner)unlinkSync(lock);}}
 },{waitMs:600000,stopped});}
 finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}
if(import.meta.main){
 try{
  if(!process.env.DELIVERY_DIR)throw Error('run through bun run deliver wine-stock-order');
  const directory=resolve(process.env.DELIVERY_DIR),mode=process.argv[2];
  const report=mode==='--verify'?verifyWineStock(directory):mode==='--hold'||mode==='--handoff'?await phase(directory,mode):await runWineStockNative(directory);
  process.exitCode=report.ok?0:1;
 }catch(error){console.error(String(error));process.exitCode=1;}
}
