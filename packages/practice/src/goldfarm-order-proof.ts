// Harness entry only. Import and --verify never start services or log in.
// Runs the installed goldfarm-stable CLI on fresh fl-prefixed practice accounts, then checks the saved state.
import {copyFileSync,readFileSync,writeFileSync,mkdirSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {freemem} from 'node:os';
import {startStack} from './stack';
import {createBot} from './bots';
import {applyPreset,type SaveConfig} from './presets';
import {runBotName} from './prove';
import {killTree} from './proc';
import {practiceDir} from './paths';
import {workerSourceRevision} from '../../core/src/worker-release';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {farmStartProblem} from '../../../scripts/goldfarm-stable';
import { FREE_FLOOR_GB, PRACTICE_RESERVE_GB, PRACTICE_STARTUP_GB } from '../../core/src/memory';

type Save=ReturnType<typeof readPracticeSave>;
type Kind='earn'|'exhausted'|'refuse'|'error'|'unbanked';
const root=resolve(import.meta.dir,'../../..');
const owned=['scripts/goldfarm-stable.ts','scripts/goldfarm-stable.test.ts','scripts/goldfarm.ts','scripts/goldfarm.test.ts','packages/core/src/bot.ts','packages/core/src/deposit.ts','packages/practice/src/goldfarm-order-proof.ts','packages/practice/test/goldfarm-order-proof.test.ts','packages/core/src/walk.ts','packages/core/test/walkpath.test.ts'];
const serverFiles=['vendor/rs-sdk/server/content/scripts/player/configs/consumption/consume_normal.dbrow'];
const source=()=>({runtime:workerSourceRevision(),files:Object.fromEntries([...owned,...serverFiles].map(p=>[p,createHash('sha256').update(readFileSync(join(root,p))).digest('hex')]))});
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');

const COINS=995,TROUT=333,SALMON=329,SHARK=385,THIEVING=17,HITPOINTS=3,BANK={x:2654,z:3283,level:0};
const SEEDED_FOOD=[TROUT,SALMON,SHARK];
// Live goldfarm jobs leave RANDOM_EVENTS unset, so the watcher runs. Keep that behaviour here.
export const WORKER_ENV={TICKS:'600',BANK_AT:'50000',FOOD_FROM:'',FUND_COURIER:'',RANDOM_EVENTS:'1'};
export const MIN_COINS=1000;
export function goldfarmFaultPreload(module:string,failRecovery:boolean):string {
 return `import {mock} from 'bun:test';
const real=await import(${JSON.stringify(module)});const {sessionWalker,walkPath}=real;const sessions=new WeakMap();let failed=false;
mock.module(${JSON.stringify(module)},()=>({...real,
 sessionWalker:async(s)=>{const d=await sessionWalker(s);sessions.set(d,s);return d;},
 walkPath:async(d,points,options)=>{const s=sessions.get(d);const coins=s?.sdk.getState()?.inventory.filter(i=>i.id===995).reduce((n,i)=>n+i.count,0)??0;
 if(!failed&&coins>=1000&&points.at(-1)?.z===3283){failed=true;console.log('PROOF_FAULT route');return {ok:false,detail:'proof injected route failure'};}
 if(failed&&${failRecovery}){console.log('PROOF_FAULT recovery');return {ok:false,detail:'proof injected recovery failure'};}
 return walkPath(d,points,options);}}));`;
}
const kit:SaveConfig={inventory:[{id:1265,count:1},{id:590,count:1},{id:COINS,count:37}],equipment:[{id:1277,count:1,slot:3},{id:1171,count:1,slot:5}]};
const fixture=(thieving:number,food:{id:number;count:number}[]):SaveConfig=>({...kit,position:BANK,skills:{Thieving:thieving,Hitpoints:10},bank:[{id:COINS,count:1000},{id:440,count:5},...food]});
// A restart case reuses the saved state its source case left behind.
export const cases:{id:string;kind:Kind;thieving:number;from?:string;preset?:SaveConfig}[]=[
 {id:'entry99',kind:'earn',thieving:99,preset:fixture(99,[{id:TROUT,count:10},{id:SALMON,count:4},{id:SHARK,count:3}])},
 {id:'restart99',kind:'earn',thieving:99,from:'entry99'},
 {id:'entry55',kind:'earn',thieving:55,preset:fixture(55,[{id:TROUT,count:40},{id:SALMON,count:4},{id:SHARK,count:2}])},
 {id:'exhausted',kind:'exhausted',thieving:55,preset:fixture(55,[{id:SHARK,count:2}])},
 {id:'exhausted-restart',kind:'refuse',thieving:55,from:'exhausted'},
 {id:'route-error',kind:'error',thieving:99,preset:fixture(99,[{id:TROUT,count:100}])},
 {id:'route-error-restart',kind:'earn',thieving:99,from:'route-error'},
 {id:'unbanked-error',kind:'unbanked',thieving:99,preset:fixture(99,[{id:TROUT,count:100}])},
 {id:'unbanked-restart',kind:'earn',thieving:99,from:'unbanked-error'},
];

// Reduced doorway gate (--door-repro). 2026-10-28 route-error-restart idled at 2651,3304 inside the knight
// house with 8900 carried coins. TICKS=0 earns nothing: the CLI must only leave, bank the carried cash and log out.
// This gate is diagnostic only. It never replaces the full earning proof above.
export const DOOR_DIR='door-repro';
export const DOOR_ENV={...WORKER_ENV,TICKS:'0'};
export const DOOR_CARRIED=8900;
const doorFixture=(x:number,z:number):SaveConfig=>({inventory:[{id:1265,count:1},{id:590,count:1},{id:COINS,count:DOOR_CARRIED},{id:TROUT,count:5}],
 equipment:kit.equipment,position:{x,z,level:0},skills:{Thieving:99,Hitpoints:10},bank:[{id:COINS,count:1000},{id:440,count:5},{id:TROUT,count:10}]});
export const doorCases:{id:string;start:{x:number;z:number};preset:SaveConfig}[]=[
 {id:'house-2651',start:{x:2651,z:3304},preset:doorFixture(2651,3304)},
 {id:'house-2650',start:{x:2650,z:3304},preset:doorFixture(2650,3304)},
 {id:'outside-2653',start:{x:2653,z:3302},preset:doorFixture(2653,3302)},
];

const count=(s:Save,container:number,id:number)=>(s.inventories[container]??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const total=(s:Save,id:number)=>Object.values(s.inventories).flat().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const near=(p:Save['position'])=>p.level===0&&Math.max(Math.abs(p.x-BANK.x),Math.abs(p.z-BANK.z))<=4;
export function goldfarmResult(log:string){const lines=log.split(/\r?\n/).filter(l=>l.startsWith('GOLDFARM_RESULT '));if(lines.length!==1)return null;try{return JSON.parse(lines[0]!.slice(16));}catch{return null;}}
export function goldfarmSaveChecks(before:Save,after:Save,result:any,kind:Kind,thieving:number,fresh:boolean,parent?:Save){
 const eatenById:Record<string,number>=result?.eatenById??{};
 const foodIds=[...new Set([...SEEDED_FOOD,...Object.keys(eatenById).map(Number)])];
 const ids=new Set([...Object.values(before.inventories).flat(),...Object.values(after.inventories).flat()].map(i=>i.id));
 const sameItems=(c:number)=>JSON.stringify((before.inventories[c]??[]).map(i=>[i.slot,i.id,i.count]))===JSON.stringify((after.inventories[c]??[]).map(i=>[i.slot,i.id,i.count]));
 const gained=result?.coinsGained,xpBefore=before.skills[THIEVING]!.rawExperience,xpAfter=after.skills[THIEVING]!.rawExperience;
 return {
  // A restart keeps the HP its source case left; a fresh fixture starts full at 10.
  entry:(fresh ? near(before.position)&&before.skills[THIEVING]?.level===thieving
    : !!parent&&JSON.stringify(parent)===JSON.stringify(before)
      &&farmStartProblem({worldX:before.position.x,worldZ:before.position.z,level:before.position.level},before.skills[THIEVING]!.level)===null)
   &&before.skills[HITPOINTS]!.level>0
   &&(!fresh||(before.skills[HITPOINTS]?.level===10&&count(before,93,1265)===1&&count(before,93,590)===1&&count(before,93,COINS)===37)),
  target:kind==='earn'?result?.ok===true&&Number.isSafeInteger(gained)&&gained>=MIN_COINS&&result.picks>result.fails
   :kind==='error'||kind==='unbanked'?result?.ok===false&&result.reason==='Error: no farm route progress: proof injected route failure'
     &&gained>=MIN_COINS&&(kind==='error'?result.recovery==='banked':result.recovery==='failed: Error: no farm route progress: proof injected recovery failure'&&result.packCoins>=MIN_COINS)
   :kind==='exhausted'?result?.ok===false&&result.reason==='no food supply: waited 0 ticks at bank'&&result.ticks<Number(WORKER_ENV.TICKS)
   :result?.ok===false&&result.reason==='no food supply: waited 0 ticks at bank'&&result.picks===0&&gained===0&&result.ticks<=100,
  // Only new income changes total coins. Starting pack coins move to the bank but stay counted.
  coins:result?.coinsExact===true&&Number.isSafeInteger(gained)&&total(after,COINS)-total(before,COINS)===gained&&count(after,95,COINS)-count(before,95,COINS)===result.banked
   &&count(after,93,COINS)===result.packCoins&&(kind==='unbanked'||result.packCoins===0)&&result.coins0===count(before,93,COINS)
   &&result.banked+result.packCoins-result.coins0===gained,
  food:foodIds.every(id=>total(before,id)-total(after,id)===(eatenById[id]??0))&&Object.values(eatenById).reduce((n,v)=>n+v,0)===result?.eaten,
  premium:kind==='exhausted'?(eatenById[SHARK]??0)>=1:(eatenById[SHARK]??0)===0||total(after,TROUT)+total(after,SALMON)===0,
  assets:[...ids].every(id=>id===COINS||foodIds.includes(id)||total(before,id)===total(after,id))&&sameItems(94),
  skills:before.skills.every((s,i)=>i===THIEVING||after.skills[i]?.rawExperience===s.rawExperience)
   &&after.skills[THIEVING]!.level>=before.skills[THIEVING]!.level
   &&(result?.picks>result?.fails?xpAfter>xpBefore:xpAfter===xpBefore),
  life:result?.died===false&&result.hpMin>0&&after.skills[HITPOINTS]!.level>0&&(kind==='unbanked'
    ?farmStartProblem({worldX:after.position.x,worldZ:after.position.z,level:after.position.level},after.skills[THIEVING]!.level)===null:near(after.position)),
 };
}
// No earning, no eating: every item total stays the same and only the carried coins move into the bank.
export function goldfarmDoorChecks(before:Save,after:Save,result:any,start:{x:number;z:number}){
 const ids=new Set([...Object.values(before.inventories).flat(),...Object.values(after.inventories).flat()].map(i=>i.id));
 const carried=count(before,93,COINS);
 return {
  entry:before.position.level===0&&before.position.x===start.x&&before.position.z===start.z&&before.skills[THIEVING]?.level===99
   &&before.skills[HITPOINTS]?.level===10&&carried===DOOR_CARRIED&&count(before,93,TROUT)===5,
  target:result?.ok===true&&result.picks===0&&result.coinsGained===0&&result.coins0===carried&&result.banked===carried
   &&result.packCoins===0&&result.bankTrips>=1&&result.ticks<=200,
  coins:result?.coinsExact===true&&total(after,COINS)===total(before,COINS)&&count(after,93,COINS)===0
   &&count(after,95,COINS)-count(before,95,COINS)===carried,
  food:result?.eaten===0&&SEEDED_FOOD.every(id=>total(after,id)===total(before,id)),
  assets:[...ids].every(id=>total(before,id)===total(after,id))
   &&JSON.stringify((before.inventories[94]??[]).map(i=>[i.slot,i.id,i.count]))===JSON.stringify((after.inventories[94]??[]).map(i=>[i.slot,i.id,i.count])),
  skills:before.skills.every((s,i)=>after.skills[i]?.rawExperience===s.rawExperience),
  life:result?.died===false&&after.skills[HITPOINTS]?.level===before.skills[HITPOINTS]?.level&&near(after.position),
 };
}
export function verifyGoldfarmDoor(delivery:string){
 const directory=join(delivery,DOOR_DIR),meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const checks:Record<string,boolean>={source:JSON.stringify(meta.source)===JSON.stringify(source()),configuration:meta.tickMs===150&&JSON.stringify(meta.env)===JSON.stringify(DOOR_ENV),
  fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000,cases:JSON.stringify(meta.cases?.map((c:any)=>c.id))===JSON.stringify(doorCases.map(c=>c.id))};
 const results:Record<string,any>={};
 for(const k of doorCases){
  const dir=join(directory,k.id),c=meta.cases?.find((v:any)=>v.id===k.id);
  const before=readPracticeSave(join(dir,'before.sav')),after=readPracticeSave(join(dir,'after.sav')),log=readFileSync(join(dir,'worker.log'),'utf8'),result=goldfarmResult(log);
  results[k.id]=result;
  const local={...goldfarmDoorChecks(before,after,result,k.start),...goldfarmChildChecks(c?.code,c?.timedOut,log,'earn',result),
   savedLogout:c?.persisted===true&&(after.vars[134]??0)>(before.vars[134]??0),beforeHash:c?.before===hash(join(dir,'before.sav')),afterHash:c?.after===hash(join(dir,'after.sav')),logHash:c?.log===hash(join(dir,'worker.log'))};
  for(const [key,value] of Object.entries(local))checks[k.id+':'+key]=value;
 }
 const report={ok:Object.values(checks).every(Boolean),at:Date.now(),checks,results,
  scope:'Diagnostic doorway gate only: native 150ms installed goldfarm-stable CLI, TICKS=0, carried cash banked from the knight house and outside. Not an earning, restart, exhausted or live proof.',
  next:'If ok, run the full goldfarm-order proof (no argument). If not ok, return this report for walker repair.'};
 writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
export function goldfarmChildChecks(code:number,timedOut:boolean,log:string,kind:Kind,result:any){
 return {exit:!timedOut&&(kind==='earn'?code===0:code!==0),
  logout:(log.match(/^LOGOUT logged-out$/gm)??[]).length===1&&!/^WARN .*?(logout|session close)/m.test(log),
  result:kind==='earn'?/^RESULT ok /m.test(log):kind==='error'||kind==='unbanked'
    ?/^RESULT fail Error: no farm route progress: proof injected route failure /m.test(log):/^RESULT fail no food supply: /m.test(log),
  randomEvents:result?.randomEvents===true&&/^EVENTS \{/m.test(log)};
}

export function verifyGoldfarm(directory:string){
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const checks:Record<string,boolean>={source:JSON.stringify(meta.source)===JSON.stringify(source()),configuration:meta.tickMs===150&&JSON.stringify(meta.env)===JSON.stringify(WORKER_ENV),
  fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000,cases:JSON.stringify(meta.cases?.map((c:any)=>c.id))===JSON.stringify(cases.map(c=>c.id))};
 const results:Record<string,any>={};
 for(const k of cases){
  const dir=join(directory,k.id),c=meta.cases?.find((v:any)=>v.id===k.id),parent=meta.cases?.find((v:any)=>v.id===k.from);
  const before=readPracticeSave(join(dir,'before.sav')),after=readPracticeSave(join(dir,'after.sav')),log=readFileSync(join(dir,'worker.log'),'utf8'),result=goldfarmResult(log);
  results[k.id]=result;
  const local={...goldfarmSaveChecks(before,after,result,k.kind,k.thieving,!k.from,k.from?readPracticeSave(join(directory,k.from,'after.sav')):undefined),...goldfarmChildChecks(c?.code,c?.timedOut,log,k.kind,result),
   restart:!k.from||(parent?.name===c?.name&&parent?.after===c?.before),
   savedLogout:c?.persisted===true&&(after.vars[134]??0)>(before.vars[134]??0),beforeHash:c?.before===hash(join(dir,'before.sav')),afterHash:c?.after===hash(join(dir,'after.sav')),logHash:c?.log===hash(join(dir,'worker.log'))};
  for(const [key,value] of Object.entries(local))checks[k.id+':'+key]=value;
 }
 const report={ok:Object.values(checks).every(Boolean),at:Date.now(),checks,results,
  scope:'Native 150ms installed goldfarm-stable CLI with RANDOM_EVENTS on and no courier; no live, unattended or speed claim.',
  nextConsumer:'Finite live 600-tick batches on the seven trained Ardougne earners with dated owned food; coins fund endgame gear and premium-food procurement.'};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}

type RunCase={id:string;kind:Kind;from?:string;preset?:SaveConfig};
async function run(delivery:string,door=false){
 const directory=door?join(delivery,DOOR_DIR):delivery,list:RunCase[]=door?doorCases.map(k=>({id:k.id,kind:'earn',preset:k.preset})):cases;
 const env=door?DOOR_ENV:WORKER_ENV,verify=()=>door?verifyGoldfarmDoor(delivery):verifyGoldfarm(delivery);
 if(freemem()/2**30<PRACTICE_STARTUP_GB)throw Error(`practice needs ${FREE_FLOOR_GB}GiB floor plus ${PRACTICE_RESERVE_GB}GiB startup reserve`);
 mkdirSync(directory,{recursive:true});
 // Exclusive delivery folder: do not overwrite earlier before/ snapshots.
 if(existsSync(join(directory,'native.json'))||list.some(k=>existsSync(join(directory,k.id))))throw Error('goldfarm proof directory already used');
 const lock=join(practiceDir(),'delivery-practice.lock'),fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:'goldfarm-order',at:Date.now()}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  const pin=source(),receipts:any[]=[],accounts:Record<string,{name:string;path:string}>={};
  stack=await startStack({tickMs:150,readyTimeoutMs:60000});
  for(const [index,k] of list.entries()){
   const dir=join(directory,k.id);mkdirSync(dir);
   let account=k.from?accounts[k.from]:undefined;
   if(!account){
    const name=runBotName(door?'fldoor':'flgold',index+1),botDir=join(root,'vendor/rs-sdk/bots',name);
    if(existsSync(botDir))throw Error('isolated practice identity already exists');
    await createBot(name);
    if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local fixture required');
    account={name,path:await applyPreset(name,k.preset!)};
   }
   accounts[k.id]=account;
   copyFileSync(account.path,join(dir,'before.sav'));
   const preload:string[]=[];
   if(k.kind==='error'||k.kind==='unbanked'){
    // Test-only fault at the route boundary after real earning. The installed CLI,
    // deposits, food, logout and independent saves all remain real. No worker flag.
    const path=join(dir,'route-fault.ts'),module=join(root,'packages/core/src/walk.ts');
    writeFileSync(path,goldfarmFaultPreload(module,k.kind==='unbanked'));
    preload.push('--preload',path);
   }
   const child=Bun.spawn(['bun',...preload,'scripts/goldfarm-stable.ts',account.name],{cwd:root,env:{...process.env,DEMO_OK:'',...env},stdout:Bun.file(join(dir,'worker.log')),stderr:Bun.file(join(dir,'worker.err')),windowsHide:true});
   let timedOut=false,termination:Promise<void>|undefined;const timer=setTimeout(()=>{timedOut=true;termination=killTree(child.pid);},200000);
   const code=await child.exited;clearTimeout(timer);await termination;
   const before=readPracticeSave(join(dir,'before.sav'));
   const persisted=await waitPracticeSave(account.path,s=>(s.vars[134]??0)>(before.vars[134]??0),{timeoutMs:15000});
   copyFileSync(account.path,join(dir,'after.sav'));
   receipts.push({id:k.id,name:account.name,code,timedOut,persisted:persisted.matched,before:hash(join(dir,'before.sav')),after:hash(join(dir,'after.sav')),log:hash(join(dir,'worker.log'))});
   writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source:pin,tickMs:150,env,cases:receipts},null,2));
   // Keep the failed case. Do not continue with an account whose logout or save is unproved.
   if(!persisted.matched||timedOut)throw Error(`goldfarm ${k.id} logout/save deadline; evidence retained`);
  }
  return verify();
 }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
}
// No argument: full delivery. --verify: recheck the full delivery. --door-repro: reduced doorway gate only.
// --door-repro --verify: recheck that gate. Neither door mode can satisfy the full delivery checks.
if(import.meta.main){try{if(!process.env.DELIVERY_DIR)throw Error('run through the goldfarm-order delivery harness');const directory=resolve(process.env.DELIVERY_DIR);
 const args=process.argv.slice(2),door=args[0]==='--door-repro',verify=args.includes('--verify');
 if(args.length>(door?2:1)||(args.length&&!door&&!verify)||(door&&args.length===2&&!verify))throw Error(`unknown arguments: ${args.join(' ')}`);
 process.exitCode=(verify?(door?verifyGoldfarmDoor(directory):verifyGoldfarm(directory)):await run(directory,door)).ok?0:1;}catch(error){console.error(String(error));process.exitCode=1;}}
