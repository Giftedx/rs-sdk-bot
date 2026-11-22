// Qualifies finite owned transfers on fresh loopback bench actors. Authentication,
// coordinator state, receipts and session proofs belong to a private copied source root.
import {copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {serverFromEnv} from '../../core/src/bot';
import {isLocalServer} from '../../core/src/localserver';
import {lifecycleRootForServer,resolveBotEnvPath,simBotsDir,simStatusDir} from '../../core/src/practice-paths';
import {prepareReplayRoot,removeReplayRoot} from './build-workspace';
import {killTree} from '../../core/src/proc';
import {accountDir} from '../../core/src/session-lifecycle';
import {jobAccounts,readMergedPlan} from '../../core/src/coordinator-jobs';
import {readPracticeSave,waitPracticeSave} from '../../practice/src/fleet-player-save';
import {resolveLogisticsStep} from '../../workers/src/logistics';

const SOURCE=resolve(import.meta.dir,'../../..');
const MODES=['coin-courier','coin-fanout','item-fanin','note-courier'] as const;
type Mode=typeof MODES[number];
type Entry={mode:Mode;names:string[];server:string;workerArgs:string[]};
type ChildResult={code:number;stdout:string;stderr?:string;failure?:string};
type ChildOptions={cwd:string;env:NodeJS.ProcessEnv;timeoutMs:number;signal?:AbortSignal;forward?:boolean;graceMs?:number;observe?:(chunk:string)=>void};

export function ownedLogisticsEntry(args:readonly string[],envFor:(name:string)=>string):Entry{
 const [primary='',modeInput='',...others]=args;
 if(!MODES.includes(modeInput as Mode))throw Error('owned logistics fixture requires a finite owned-transfer mode');
 const mode=modeInput as Mode,names=[primary,...others],expected=mode==='coin-courier'||mode==='note-courier'?2:3;
 if(names.length!==expected||!/^aiob[a-z0-9]{1,7}$/i.test(primary)
  ||others.some(n=>!new RegExp('^'+primary+'[a-z]$','i').test(n))
  ||new Set(names.map(n=>n.toLowerCase())).size!==names.length)
  throw Error('owned logistics fixture requires distinct primary bench actor and its one-letter companions');
 const servers=names.map(name=>{
  const env=envFor(name),server=serverFromEnv(env);
  if(!isLocalServer(server)||!/^PASSWORD=\S+/m.test(env))throw Error('owned logistics fixture requires configured loopback credentials for every actor');
  return server;
 });
 if(servers.some(server=>server!==servers[0]))throw Error('owned logistics fixture requires one exact loopback endpoint');
 const rest=[...others,...mode==='coin-courier'?['100']:mode==='coin-fanout'?['50']:mode==='item-fanin'?['Feather']:['MAX_DELIVERIES=1','CAP=1000']];
 const step=resolveLogisticsStep(mode,rest);
 return{mode,names,server:servers[0]!,workerArgs:[...step.args,...Object.entries(step.env??{}).map(([k,v])=>`${k}=${v}`)]};
}

export function ownedRegistrationProgram(entry:Entry):string{
 return `import {readFileSync} from 'node:fs';
import {openBot,serverFromEnv,settle} from './packages/core/src/bot';
import {resolveBotEnvPath} from './packages/core/src/practice-paths';
import {waitTicks} from './packages/core/src/ticks';
import {ownedAccounts} from './packages/core/src/tradeguard';
import {readLogoutProof} from './packages/core/src/session-lifecycle';
const names=${JSON.stringify(entry.names)},server=${JSON.stringify(entry.server)};
for(const name of names)if(serverFromEnv(readFileSync(resolveBotEnvPath(name),'utf8'))!==server)throw Error('practice endpoint changed before authentication');
for(const name of names){
 let session,ok=false;
 try{session=await openBot(name,{record:{script:'packages/router/src/owned-logistics-entry.ts',argv:[name,'CAP=120']}});await waitTicks(session,3);ok=true;}
 finally{if(session)ok=await settle([session],ok,'practice transfer authentication');}
 if(!ok||readLogoutProof(name,server).state!=='confirmed'||!ownedAccounts(server).has(name.toLowerCase()))throw Error('practice authenticated logout unproved: '+name);
 console.log('OWNED_LOGISTICS_AUTH '+JSON.stringify({name,server,loggedOut:true}));
}process.exit(0);`;
}

// Empty scratch metadata must not hide an owner or an earlier source session.
export function assertFreshOwnedActors(source:string,entry:Pick<Entry,'names'|'server'>){
 const targets=new Set(entry.names.map(name=>name.toLowerCase()));
 for(const name of entry.names){
  const lower=name.toLowerCase(),paths=[
   join(source,'.practice/status',name+'.json'),join(source,'.practice/status',lower+'.json'),
   join(simStatusDir(source),name+'.json'),join(simStatusDir(source),lower+'.json'),
   join(source,'.practice/account-leases',lower+'.lock'),
   accountDir(name,entry.server,join(source,'.practice/session-lifecycle')),
   accountDir(name,entry.server,lifecycleRootForServer(entry.server,source)),
  ];
  if(paths.some(path=>existsSync(path)))throw Error('owned logistics fixture requires fresh source actors: '+name);
 }
 const jobs=readMergedPlan(source).jobs;
 if(!Array.isArray(jobs))throw Error('owned logistics source assignments unknown');
 if(jobs.some(job=>job?.enabled!==false&&jobAccounts(job).some(name=>targets.has(name.toLowerCase()))))
  throw Error('owned logistics source actor already has a plan assignment');
 const file=join(source,'.practice/coordinator/state.json');
 if(!existsSync(file))return;
 const state=JSON.parse(readFileSync(file,'utf8'));
 if(state?.version!==1||!Array.isArray(state.tasks))throw Error('owned logistics source coordinator ownership unknown');
 const supplied=(id:string)=>state.tasks.find((task:any)=>task.spec?.id===id)?.receipt?.output?.account;
 for(const task of state.tasks){
  if(!['pending','running'].includes(task?.status))continue;
  const spec=task.spec;
  if(!spec)throw Error('owned logistics source coordinator assignment unknown');
  const bindings=spec.participants??(spec.account?[spec.account]:spec.accountFrom?['@'+spec.accountFrom]:[]);
  if(!Array.isArray(bindings))throw Error('owned logistics source coordinator participants unknown');
  const accounts=bindings.map((binding:unknown)=>typeof binding==='string'?(binding.startsWith('@')?supplied(binding.slice(1)):binding):undefined);
  if(accounts.some((name:unknown)=>typeof name!=='string'))throw Error('owned logistics source coordinator ownership unresolved');
  if(accounts.some((name:string)=>targets.has(name.toLowerCase())))
   throw Error('owned logistics source actor already has a coordinator assignment');
 }
}

type NativeSave=ReturnType<typeof readPracticeSave>;
export function noteCourierSaveReceipt(before:NativeSave,after:NativeSave){
 const count=(save:NativeSave,container:number,id:number)=>(save.inventories[container]??[]).filter(item=>item.id===id).reduce((n,item)=>n+item.count,0);
 const totals=(save:NativeSave)=>{const out=new Map<number,number>();for(const container of [93,94,95])for(const item of save.inventories[container]??[])out.set(item.id,(out.get(item.id)??0)+item.count);return out;};
 const first=totals(before),last=totals(after),notesDelivered=count(before,93,1780)-count(after,93,1780);
 const assetsPreserved=[...new Set([...first.keys(),...last.keys()])].every(id=>(last.get(id)??0)===(first.get(id)??0)-(id===1780?28:0));
 const xpPreserved=JSON.stringify(before.skills)===JSON.stringify(after.skills),gearPreserved=JSON.stringify(before.inventories[94]??[])===JSON.stringify(after.inventories[94]??[]);
 const troutRetained=count(after,93,333),input=count(before,93,1780)===28&&count(before,93,333)===2;
 return{ok:input&&notesDelivered===28&&count(after,93,1780)===0&&troutRetained===2&&assetsPreserved&&xpPreserved&&gearPreserved,
  notesDelivered,troutRetained,assetsPreserved,xpPreserved,gearPreserved};
}

export function noteBankerProgram(entry:Entry):string{
 return `import {openBot,settle} from './packages/core/src/bot';
import {waitTicks,waitUntil} from './packages/core/src/ticks';
import {depositObserved} from './packages/core/src/deposit';
import {readLogoutProof} from './packages/core/src/session-lifecycle';
const banker=${JSON.stringify(entry.names[1])},courier=${JSON.stringify(entry.names[0])},server=${JSON.stringify(entry.server)};
let session,ok=false,receipt={},failure='',cancelled=false;
const cancel=()=>{cancelled=true;if(session)void settle([session],false,'practice banker cancelled');};
process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
try{
 session=await openBot(banker,{record:{script:'packages/router/src/owned-logistics-entry.ts',argv:[banker,'CAP=600']}});if(cancelled)throw Error('practice banker cancelled');await waitTicks(session,3);
 const state=()=>session.sdk.getState(),pack=()=>session.sdk.getInventory(),qty=(items,id)=>items.filter(item=>item.id===id).reduce((n,item)=>n+item.count,0);
 const player=state().player,life=player.lifeId,respawns=player.respawnCount??0,hp=session.sdk.getSkill('Hitpoints').level;
 const alive=()=>!cancelled&&!state().player.isDead&&state().player.lifeId===life&&(state().player.respawnCount??0)===respawns&&session.sdk.getSkill('Hitpoints').level>=hp;
 const open=async()=>{const generation=session.bankObservation()?.generation??0;if(!(await session.bot.openBank()).success||!await waitUntil(session,()=>!!session.bankObservation()&&session.bankObservation().generation>generation,{timeoutTicks:20}))throw Error('practice banker fresh bank unavailable');};
 const snapshot=()=>{const bank=session.bankObservation();if(!bank||!alive())throw Error('practice banker original bank unavailable');const out=new Map();for(const item of [...bank.items,...pack(),...session.sdk.getEquipment()])out.set(item.id,(out.get(item.id)??0)+item.count);return out;};
 await open();const before=snapshot(),bankBefore=qty(session.bankObservation().items,1779),gear=JSON.stringify(session.sdk.getEquipment());
 if(qty(pack(),1780)!==0)throw Error('practice banker starts without flax notes');
 if(!(await session.bot.closeBank()).success||!await waitUntil(session,()=>!state().bank.isOpen,{timeoutTicks:10}))throw Error('practice banker bank did not close');
 console.log('NOTE_BANKER_READY '+JSON.stringify({name:banker,server}));
 const trade=await session.bot.serveTrades({from:new RegExp('^'+courier+'$','i'),give:[],maxTrades:1,timeout:60000,
  accept:offer=>offer.length===1&&offer[0].id===1780&&offer[0].count===28});
 if(!trade.success||!trade.trades.some(row=>row.success&&row.received.length===1&&row.received[0].id===1780&&row.received[0].count===28)
  ||!await waitUntil(session,()=>qty(pack(),1780)===28,{timeoutTicks:20})||!alive())throw Error('practice banker exact note trade unobserved');
 await open();const note=pack().find(item=>item.id===1780);await depositObserved(session,note);
 const after=snapshot(),bankAfter=qty(session.bankObservation().items,1779);
 const preserved=[...new Set([...before.keys(),...after.keys()])].every(id=>(after.get(id)??0)===(before.get(id)??0)+(id===1779?28:0))&&gear===JSON.stringify(session.sdk.getEquipment());
 ok=preserved&&bankAfter===bankBefore+28&&qty(pack(),1780)===0&&alive();
 receipt={bankBefore,bankAfter,banked:bankAfter-bankBefore,preserved};
 await session.bot.closeBank();
}catch(error){failure=String(error);}
finally{if(session)ok=await settle([session],ok,'practice exact banknote receiver')&&ok;}
const loggedOut=readLogoutProof(banker,server).state==='confirmed';ok&&=loggedOut;
console.log('NOTE_BANKER_RECEIPT '+JSON.stringify({...receipt,ok,loggedOut,failure}));process.exit(ok?0:1);`;
}

// Own a process group so an AIO dispatcher's worker cannot survive its timeout.
// A normal exit preserves its output; an interrupted group gets a bounded logout grace.
export async function runOwnedChild(args:readonly string[],options:ChildOptions):Promise<ChildResult>{
 if(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1)throw Error('invalid practice child deadline');
 options.signal?.throwIfAborted();
 const child=spawn(process.execPath,[...args],{cwd:options.cwd,env:options.env,windowsHide:true,
  detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',outputBytes=0,failure:string|undefined,termination:Promise<void>|undefined;
 const signalGroup=(signal:NodeJS.Signals)=>{
  if(!child.pid)return;
  try{if(process.platform==='win32')void killTree(child.pid);else process.kill(-child.pid,signal);}catch{/* already ended */}
 };
 const terminate=(reason:string)=>{
  failure??=reason;
  termination??=(async()=>{signalGroup('SIGTERM');await new Promise<void>(done=>setTimeout(done,options.graceMs??5000));signalGroup('SIGKILL');})();
 };
 const timer=setTimeout(()=>terminate('practice child deadline'),options.timeoutMs);
 const abort=()=>terminate('practice child cancelled');options.signal?.addEventListener('abort',abort,{once:true});
 const collect=(chunk:Buffer,isError=false)=>{
  outputBytes+=chunk.length;
  if(outputBytes>8*1024*1024){terminate('practice child output limit');return;}
  const text=chunk.toString();if(isError)stderr+=text;else stdout+=text;
  if(!isError&&options.observe)try{options.observe(text);}catch{terminate('practice child observer failed');}
  if(options.forward)(isError?process.stderr:process.stdout).write(text);
 };
 child.stdout.on('data',chunk=>collect(chunk));child.stderr.on('data',chunk=>collect(chunk,true));
 try{
  const code=await new Promise<number>((done,reject)=>{child.once('error',reject);child.once('close',value=>done(value??1));});
  await termination;
  return{code:failure?1:code,stdout,stderr,...failure?{failure}:{}};
 }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
}

type EntryOptions={sourceRoot?:string;parent?:string;signal?:AbortSignal;
 prepare?:typeof prepareReplayRoot;remove?:typeof removeReplayRoot;run?:typeof runOwnedChild;readSave?:typeof readPracticeSave;waitSave?:typeof waitPracticeSave};
const resultLine=(text:string)=>text.split(/\r?\n/).filter(line=>/^RESULT\b/.test(line)).at(-1)??'';
const hiddenOutput=(child:ChildResult)=>{process.stdout.write(child.stdout.replace(/^(?=.)/gm,'  | '));if(child.stderr)process.stderr.write(child.stderr.replace(/^(?=.)/gm,'  | '));};
export async function qualifyOwnedLogistics(args:readonly string[],options:EntryOptions={}){
 const source=resolve(options.sourceRoot??SOURCE);
 const entry=ownedLogisticsEntry(args,name=>readFileSync(resolveBotEnvPath(name,source),'utf8'));
 assertFreshOwnedActors(source,entry);
 const paused=()=>['all','coordinator','swarm',...entry.names].some(name=>existsSync(join(source,'.practice','stop-'+name)));
 if(paused())throw Error('owned logistics fixture preserves source stop files');
 options.signal?.throwIfAborted();
 const parent=resolve(options.parent??join(source,'.practice','aio-owned-logistics'));mkdirSync(parent,{recursive:true});
 const scratch=(options.prepare??prepareReplayRoot)(source,parent),run=options.run??runOwnedChild;
 if(resolve(scratch)===source||dirname(resolve(scratch))!==parent||!basename(scratch).startsWith('replay-root-'))
  throw Error('owned logistics fixture refuses unowned scratch root');
 try{
  if(resolve(scratch)===source||lstatSync(join(scratch,'.practice')).isSymbolicLink())throw Error('owned logistics fixture needs private state');
  for(const name of entry.names){
   const simEnv=join(simBotsDir(source),name,'bot.env');
   if(existsSync(simEnv)){
    const dstDir=join(simBotsDir(scratch),name);
    mkdirSync(dstDir,{recursive:true});
    copyFileSync(simEnv,join(dstDir,'bot.env'));
   }
  }
  const plan=JSON.parse(readFileSync(join(scratch,'swarm.json'),'utf8'));
  writeFileSync(join(scratch,'swarm.json'),JSON.stringify({...plan,jobs:[]}));
  mkdirSync(join(scratch,'.practice/coordinator'),{recursive:true});
  writeFileSync(join(scratch,'.practice/coordinator/state.json'),JSON.stringify({version:1,tasks:[]}));
  mkdirSync(join(scratch,'fleet'),{recursive:true});writeFileSync(join(scratch,'fleet/owners.json'),JSON.stringify({accounts:{}}));
  const env={...process.env,DEMO_OK:'',FLEET_SIDE:'local',FLEET_DIR:join(scratch,'fleet'),SWARM_PLAN:join(scratch,'swarm.json'),CLOUD_WATCH_ID:'',COORDINATOR_RUN_ID:'',STANDING:'0',
   BOT_GOAL:'practice owned logistics '+entry.mode,COIN_ORDER:'bench-'+crypto.randomUUID(),ITEM_ORDER:'bench-'+crypto.randomUUID()};
  const controller=new AbortController(),cancel=()=>controller.abort(Error('owned logistics fixture cancelled'));
  options.signal?.addEventListener('abort',cancel,{once:true});
  if(options.signal?.aborted)cancel();
  const stopTimer=setInterval(()=>{if(paused())cancel();},250);
  try{
   assertFreshOwnedActors(source,entry);
   const actors=entry.mode==='note-courier'?[entry.names[1]!]:entry.names;
   const primarySave=join(source,'vendor/rs-sdk/server/engine/data/players/main',entry.names[0]!.toLowerCase()+'.sav');
   const beforeNote=entry.mode==='note-courier'?(options.readSave??readPracticeSave)(primarySave):undefined;
   const auth=await run(['--eval',ownedRegistrationProgram({...entry,names:actors})],{cwd:scratch,env,timeoutMs:120000,signal:controller.signal});
   hiddenOutput(auth);
   const observed=auth.stdout.split(/\r?\n/).filter(line=>line.startsWith('OWNED_LOGISTICS_AUTH ')).map(line=>JSON.parse(line.slice('OWNED_LOGISTICS_AUTH '.length)));
   if(auth.code!==0||actors.some(name=>observed.filter(row=>row.name===name&&row.server===entry.server&&row.loggedOut===true).length!==1))
    throw Error(auth.failure??'owned logistics fixture authentication/logout failed');
   controller.signal.throwIfAborted();
   if(paused())throw Error('owned logistics fixture preserves source stop files');
   assertFreshOwnedActors(source,entry);
   const execute=()=>run(['scripts/aio.ts','logistics',entry.names[0]!,...entry.workerArgs],{cwd:scratch,env,timeoutMs:180000,signal:controller.signal,forward:true});
   if(entry.mode==='note-courier'){
    let ready:()=>void=()=>{},buffer='';const waiting=new Promise<void>(done=>{ready=done;});
    let bankerPrinted=false;
    const banker=run(['--eval',noteBankerProgram(entry)],{cwd:scratch,env,timeoutMs:180000,signal:controller.signal,observe:text=>{
     buffer+=text;const lines=buffer.split(/\r?\n/);buffer=lines.pop()??'';
     for(const line of lines)if(line.startsWith('NOTE_BANKER_READY ')){const marker=JSON.parse(line.slice('NOTE_BANKER_READY '.length));if(marker.name===entry.names[1]&&marker.server===entry.server)ready();}
    }});
    try{
     await Promise.race([waiting,banker.then(()=>{throw Error('practice banker ended before readiness');})]);
     const transferred=await execute();
     if(transferred.code!==0||!/^RESULT ok(?:\s|$)/.test(resultLine(transferred.stdout)))controller.abort();
     const stored=await banker;hiddenOutput(stored);bankerPrinted=true;
     const receiptLine=stored.stdout.split(/\r?\n/).find(line=>line.startsWith('NOTE_BANKER_RECEIPT '));
     const receipt=receiptLine?JSON.parse(receiptLine.slice('NOTE_BANKER_RECEIPT '.length)):null;
     const saved=await (options.waitSave??waitPracticeSave)(primarySave,after=>noteCourierSaveReceipt(beforeNote!,after).ok);
     const courier=noteCourierSaveReceipt(beforeNote!,saved.save);
     return{ok:transferred.code===0&&/^RESULT ok(?:\s|$)/.test(resultLine(transferred.stdout))&&stored.code===0&&receipt?.ok===true&&receipt?.banked===28&&receipt?.preserved===true&&receipt?.loggedOut===true&&saved.matched&&courier.ok,
      mode:entry.mode,authenticated:actors.length,server:entry.server,code:transferred.code,banker:receipt,courier};
    }catch(error){controller.abort();const stored=await banker.catch(()=>undefined);if(stored&&!bankerPrinted)hiddenOutput(stored);throw error;}
   }
   const transferred=await execute();
   return{ok:transferred.code===0&&/^RESULT ok(?:\s|$)/.test(resultLine(transferred.stdout)),mode:entry.mode,authenticated:entry.names.length,
    server:entry.server,code:transferred.code,...transferred.failure?{failure:transferred.failure}:{}};
  }finally{clearInterval(stopTimer);options.signal?.removeEventListener('abort',cancel);}
 }finally{if(!(options.remove??removeReplayRoot)(scratch))throw Error('owned logistics fixture scratch cleanup incomplete');}
}

if(import.meta.main){
 const controller=new AbortController(),cancel=()=>controller.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
 try{
  const result=await qualifyOwnedLogistics(process.argv.slice(2),{signal:controller.signal});
  console.log('OWNED_LOGISTICS_RESULT '+JSON.stringify(result));console.log(`RESULT ${result.ok?'ok':'fail'} owned logistics ${result.mode}`);process.exitCode=result.ok?0:1;
 }catch(error){console.log('RESULT fail '+String(error));process.exitCode=1;}
 finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);}
}
