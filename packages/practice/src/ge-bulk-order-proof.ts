import {readFileSync,writeFileSync,copyFileSync,existsSync,openSync,closeSync,unlinkSync,mkdirSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {freemem} from 'node:os';
import {Database} from 'bun:sqlite';
import {startStack,stopStack,pidsFile,type StackOptions} from './stack';
import {canBind} from './ports';
import {randomUUID} from 'node:crypto';
import {createBot} from './bots';
import {applyPreset} from './presets';
import {runBotName} from './prove';
import {killTree,commandLine} from './proc';
import {rsSdkRoot,practiceDir} from './paths';
import {readPracticeSave,waitPracticeSave,setPracticeSkills} from '../../../scripts/measure/fleet-player-save';
import {capabilityRevision,type ReleaseMemo} from '../../core/src/worker-release';
// One --verify shares a memo: each fresh closure hash costs seconds under load and four of them overran the 30 s check.
export const geProofRuntime=(memo:ReleaseMemo=new Map())=>capabilityRevision(['scripts/buy-owned-ge-item.ts'],resolve(import.meta.dir,'../../..'),memo);
import {openBot,finish,serverFromEnv} from '../../core/src/bot';
import {waitUntil} from '../../core/src/ticks';
import {orderPaths,orderQuantity,orderEscrow,orderAccounting,bankTotals,type ItemOrder} from '../../../scripts/buy-owned-ge-item';
import { FREE_FLOOR_GB, PRACTICE_RESERVE_GB, PRACTICE_STARTUP_GB } from '../../core/src/memory';
import {runShopSupplyNative,verifyShopSupply,waitFreeMemory} from './shop-supply-order-proof';

// Native bulk GE order: an owned seller lists noted grapes, then the actual worker buys the exact
// quantity, banks it and reruns the same order key. The consumer stage reads the saved bank.
type Save=ReturnType<typeof readPracticeSave>;
type Run={code:number;log:string};
export function geProofEndpoints(ports:{engine:number;gateway:number;management:number;tcp:number},instance:string){
 if(!ports||![ports.engine,ports.gateway,ports.management,ports.tcp].every(p=>Number.isSafeInteger(p)&&p>=1024&&p<=65535&&p!==8888&&p!==7780&&p!==8898&&p!==43594)
  ||new Set([ports.engine,ports.gateway,ports.management,ports.tcp]).size!==4||!/^ge-[a-z0-9-]{1,29}$/.test(instance))throw Error('owned practice endpoints required');
 const server=`127.0.0.1:${ports.engine}`,gateway=`ws://127.0.0.1:${ports.gateway}`;
 const env={GE_PROOF_ENGINE:String(ports.engine),GE_PROOF_GATEWAY:String(ports.gateway),GE_PROOF_INSTANCE:instance,
  AGENT_PORT:String(ports.gateway),GATEWAY_URL:`http://127.0.0.1:${ports.gateway}`,WEB_MANAGEMENT_PORT:String(ports.management),NODE_PORT:String(ports.tcp),GE_DATABASE:`data/market-${instance}.sqlite`};
 return{ports:{...ports},instance,server,gateway,env};
}
export function selectGeProofEndpoints(bind:typeof canBind=canBind,random:()=>number=Math.random){
 for(let i=0;i<100;i++){
  const engine=20000+Math.floor(random()*20000),gateway=engine+1,management=engine+2,tcp=engine+3;
  if([engine,gateway,management,tcp].every(bind))return geProofEndpoints({engine,gateway,management,tcp},'ge-'+randomUUID().replaceAll('-','').slice(0,20));
 }
 throw Error('owned practice ports unavailable');
}

type ProofEndpoints=ReturnType<typeof geProofEndpoints>;
export function assertGeProofAccount(text:string,env:Record<string,string|undefined>=process.env){
 const p=geProofEndpoints({engine:Number(env.GE_PROOF_ENGINE),gateway:Number(env.GE_PROOF_GATEWAY),management:Number(env.WEB_MANAGEMENT_PORT),tcp:Number(env.NODE_PORT)},env.GE_PROOF_INSTANCE??'');
 if(serverFromEnv(text)!==p.server||text.match(/^GATEWAY_URL=(.*)$/m)?.[1]?.trim()!==p.gateway)throw Error('owned practice account required');
 return p.server;
}
export function geProofAccountEnv(text:string,p:ProofEndpoints){
 if(!/^SERVER=localhost:8888\r?$/m.test(text))throw Error('new practice account required');
 return text.replace(/^SERVER=.*$/gm,`SERVER=${p.server}`).replace(/^GATEWAY_URL=.*$/gm,`GATEWAY_URL=${p.gateway}`);
}
export async function startGeProofStack(p:ProofEndpoints,start:(opts:StackOptions)=>ReturnType<typeof startStack>=startStack){
 const previous=Object.fromEntries(Object.keys(p.env).map(k=>[k,process.env[k]]));
 try{Object.assign(process.env,p.env);return await start({ports:p.ports,instance:p.instance,tickMs:150,readyTimeoutMs:60000});}
 finally{for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
}
function savedEndpoints(meta:any){
 const p=geProofEndpoints(meta.endpoints?.ports,meta.endpoints?.instance??'');
 if(meta.server!==p.server)throw Error('saved owned practice endpoint mismatch');
 return p;
}
export const ORDER={item:1987,quantity:300,limit:5,ask:3,reserve:100,coins:2000};
const BANK_TILE={x:3185,z:3436,level:0};
// The live consumer entry: Pocketpython at north Varrock with 11 HP, 26 carried salmon and 60 coins.
export const NORTH_CASE={position:{x:3165,z:3487,level:0},hitpoints:11,
 carried:[...Array.from({length:26},()=>({id:329,count:1})),{id:995,count:60}],order:{...ORDER,quantity:500,coins:3000}};
export const MAGIC_CASE={position:{x:2853,z:3452,level:0},bank:[{id:995,count:19911},{id:557,count:4},{id:556,count:25},{id:1351,count:1}],pack:[{id:590,count:1}]};
const held=(s:Save,container:number,match:(id:number)=>boolean)=>(s.inventories[container]??[]).filter(i=>match(i.id)).reduce((n,i)=>n+i.count,0);
const coins=(s:Save)=>[93,94,95].reduce((n,c)=>n+held(s,c,id=>id===995),0);
const resultLine=(log:string,tag:string)=>{const line=log.split('\n').find(l=>l.startsWith(tag+' '));try{return line?JSON.parse(line.slice(tag.length+1)):null;}catch{return null;}};
export function bulkOrderChecks(p:{before:Save;after:Save;repeat:Save;journal:ItemOrder|null;sell:Run;buy:Run;again:Run;order?:typeof ORDER}){
 const {before,after,repeat,journal,sell,buy,again}=p,o=p.order??ORDER,first=resultLine(buy.log,'OWNED_GE_ITEM'),second=resultLine(again.log,'OWNED_GE_ITEM');
 const spent=coins(before)-coins(after),escrow=o.quantity*o.limit;
 const healing=(before.skills[3]?.level??0)<=6;
 const bankTotals=(s:Save)=>{const m=new Map<number,number>();for(const i of s.inventories[95]??[])m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
 const startBank=bankTotals(before),endBank=bankTotals(after),repeatBank=bankTotals(repeat);
 const assets=[...new Set([...startBank.keys(),...endBank.keys(),...repeatBank.keys()])].every(id=>{
  const expected=id===995?coins(after):id===o.item?o.quantity:(startBank.get(id)??0)-(healing&&id===329?1:0);
  return expected>=0&&(endBank.get(id)??0)===expected&&(repeatBank.get(id)??0)===expected;
 })&&(!healing||JSON.stringify(first?.foodUsed)===JSON.stringify([{id:329,count:1}]));
 return{
  entry:held(before,95,id=>id===o.item)===0&&coins(before)>=escrow+o.reserve,
  seller:sell.code===0&&resultLine(sell.log,'GE_SELL_RESULT')?.ok===true&&sell.log.split(/\r?\n/).includes('LOGOUT logged-out'),
  bank:held(after,95,id=>id===o.item)===o.quantity,
  assets,
  // Every carried form, including banknotes and entry coins, was banked. Other pack and worn items are unchanged.
  pack:JSON.stringify(after.inventories[93]??[])===JSON.stringify((before.inventories[93]??[]).filter(i=>i.id!==995))
   &&JSON.stringify(after.inventories[94]??[])===JSON.stringify(before.inventories[94]??[]),
  coins:spent>=o.quantity&&spent<=escrow&&coins(after)>=o.reserve,
  journal:!!journal&&journal.phase==='settled'&&orderQuantity(journal.request)===o.quantity&&journal.request.item===o.item&&journal.request.limit===o.limit
   &&journal.request.reserve===o.reserve&&journal.coinsBefore===coins(before)&&journal.itemsBefore===0&&Number.isSafeInteger(journal.offerId)
   &&journal.acquired===o.quantity&&journal.refund===orderEscrow(journal.request)-spent&&!journal.failure&&!orderAccounting(journal).outcomeUnresolved,
  result:buy.code===0&&first?.ok===true&&first.phase==='settled'&&first.offerId===journal?.offerId&&first.targetMet===true&&first.conserved===true
   &&first.banked===true&&first.reserveKept===true&&first.acquired===o.quantity&&first.spent===spent,
  logout:[buy,again].every(r=>r.log.split(/\r?\n/).includes('LOGOUT logged-out')),
  restart:again.code===0&&second?.ok===true&&second.targetMet===true&&second.conserved===true&&second.banked===true&&second.reserveKept===true
   &&second.phase==='settled'&&Number.isSafeInteger(second.offerId)&&second.offerId===journal?.offerId&&second.newItemsThisSession===0&&second.cashDeltaThisSession===0
   &&held(repeat,95,id=>id===o.item)===o.quantity&&coins(repeat)===coins(after)
   &&[93,94].every(c=>JSON.stringify(repeat.inventories[c]??[])===JSON.stringify(after.inventories[c]??[])),
  healthy:[after,repeat].every(s=>(s.skills[3]?.level??0)>=Math.max(7,before.skills[3]?.level??0)&&s.skills[3]?.xp===before.skills[3]?.xp&&s.position.level===before.position.level
   &&s.position.x>=3180&&s.position.x<=3188&&s.position.z>=3433&&s.position.z<=3447),
 };
}

export function verifyCase(directory:string,remote=false,memo:ReleaseMemo=new Map()){
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const now=Date.now(),ageMs=now-meta.at;
 const endpoints=savedEndpoints(meta);
 const log=(label:string)=>readFileSync(join(directory,label+'.log'),'utf8')+readFileSync(join(directory,label+'.err'),'utf8');
 const journal=existsSync(join(directory,'journal.json'))?JSON.parse(readFileSync(join(directory,'journal.json'),'utf8')) as ItemOrder:null;
 const repeat=readPracticeSave(join(directory,'repeat.sav'));
 const checks={...bulkOrderChecks({before:readPracticeSave(join(directory,'before.sav')),after:readPracticeSave(join(directory,'after.sav')),repeat,journal,
  sell:{code:meta.sellCode,log:log('sell')},buy:{code:meta.buyCode,log:log('buy')},again:{code:meta.againCode,log:log('again')},order:remote?NORTH_CASE.order:ORDER}),
  ...(remote?{remoteEntry:northEntryCheck(readPracticeSave(join(directory,'before.sav')),log('buy')),
   refusal:duplicateRefusalCheck(repeat,readPracticeSave(join(directory,'refused.sav')),{code:meta.refuseCode,log:log('refuse')},NORTH_CASE.order.item)}:{}),
  identity:journal?.request.actor===meta.buyer&&journal?.request.goal===meta.orderKey&&journal?.request.server===endpoints.server,
  // Saved effects have no age limit. This timestamp check does not grant live admission.
  source:meta.source===geProofRuntime(memo),fresh:Number.isFinite(meta.at)&&meta.at<=now};
 return{ok:Object.values(checks).every(Boolean),at:now,ageMs,checks,endpoints:{ports:endpoints.ports,instance:endpoints.instance},source:meta.source,order:remote?NORTH_CASE.order:ORDER,
  scope:'Native150ms/25x: one owned buyer, one owned seller at a lower ask; exact noted fill banked; rerun resumes. No live price, liquidity or wine-throughput claim.'};
}
// The real CLI started at the north Varrock entry and walked the north approach.
export function northEntryCheck(before:Save,log:string){
 const p=NORTH_CASE.position,lines=log.split(/\r?\n/);
 return before.position.x===p.x&&before.position.z===p.z&&before.position.level===p.level&&(before.skills[3]?.level??0)===NORTH_CASE.hitpoints
  &&lines.includes(`START ${p.x} ${p.z} ${p.level}`)&&lines.some(l=>l.startsWith('GE_MARKET_ENTRY ')&&l.includes('"stage":"north-approach"'));
}
// A second order key for already owned stock is refused before any GE mutation; assets stay and the session logs out.
export function duplicateRefusalCheck(before:Save,after:Save,run:Run,item:number){
 const r=resultLine(run.log,'OWNED_GE_ITEM'),rows=(s:Save)=>JSON.stringify([93,94,95].map(c=>s.inventories[c]??[]));
 return run.code===1&&r?.ok===false&&r.phase==='unplaced'&&String(r.failure).includes('owned item already present')
  &&r.newItemsThisSession===0&&r.cashDeltaThisSession===0&&held(after,95,id=>id===item)>0&&rows(after)===rows(before)
  &&run.log.split(/\r?\n/).includes('LOGOUT logged-out');
}
function verify(directory:string,memo:ReleaseMemo=new Map()){
 const bank=verifyCase(directory,false,memo),north=verifyCase(join(directory,'north'),true,memo);
 const magic=verifyMagic(join(directory,'magic'),memo);
 const endpoints=['','north','magic'].map(part=>JSON.parse(readFileSync(join(directory,part,'native.json'),'utf8')).endpoints);
 const sameEndpoints=endpoints.every(p=>JSON.stringify(p)===JSON.stringify(endpoints[0]));
 const report={...bank,ok:bank.ok&&north.ok&&magic.ok&&sameEndpoints,checks:{...bank.checks,north:north.ok,magic:magic.ok,sameEndpoints},north,magic};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}

export function magicOrderChecks(p:{before:Save;law:Save;earth:Save;repeat:Save;refuseBefore:Save;refused:Save;lawJournal:ItemOrder;earthJournal:ItemOrder;buy:Run;topup:Run;again:Run;refuse:Run}){
 const {before,law,earth,repeat,refuseBefore,refused,lawJournal:l,earthJournal:e}=p;
 const buy=resultLine(p.buy.log,'OWNED_GE_ITEM'),topup=resultLine(p.topup.log,'OWNED_GE_ITEM'),again=resultLine(p.again.log,'OWNED_GE_ITEM');
 const totals=(s:Save)=>bankTotals([93,94,95].flatMap(c=>s.inventories[c]??[]));
 const expected=(laws:number,earths:number,spent:number)=>bankTotals([...MAGIC_CASE.bank.filter(i=>![995,557].includes(i.id)),{id:995,count:19911-spent},{id:557,count:earths},{id:590,count:1},...(laws?[{id:563,count:laws}]:[])]);
 const lawSpent=coins(before)-coins(law),earthSpent=coins(law)-coins(earth);
 const logs=p.buy.log.split(/\r?\n/),traces=logs.filter(l=>l.startsWith('GE_MARKET_ENTRY ')).map(l=>JSON.parse(l.slice(16)));
 const stages=traces.map(t=>t.stage),receipt=l?.rescue;
 const sameContainers=(a:Save,b:Save)=>[93,94,95].every(c=>JSON.stringify(bankTotals(a.inventories[c]??[]))===JSON.stringify(bankTotals(b.inventories[c]??[])));
 const settled=(j:ItemOrder,item:number,quantity:number,owned:number,limit:number,spent:number)=>!!j&&j.phase==='settled'&&!j.failure&&j.request.item===item&&orderQuantity(j.request)===quantity
  &&j.itemsBefore===owned&&j.acquired===quantity&&j.request.limit===limit&&j.request.reserve===10000&&!orderAccounting(j).outcomeUnresolved&&orderAccounting(j).spent===spent;
 return{
  entry:JSON.stringify(before.position)===JSON.stringify(MAGIC_CASE.position)&&JSON.stringify(totals(before))===JSON.stringify(expected(0,4,0)),
  rescue:logs.includes('START 2853 3452 0')&&stages.filter(s=>s==='rescue-intent').length===1&&stages.filter(s=>s==='rescue-respawned').length===1
   &&stages.indexOf('rescue-respawned')>stages.indexOf('rescue-intent')&&stages.indexOf('rescue-bank-reconciled')>stages.indexOf('rescue-respawned')
   &&receipt?.phase==='bank-reconciled'&&JSON.stringify(bankTotals(receipt.bank))===JSON.stringify(bankTotals(MAGIC_CASE.bank))
   &&traces.some(t=>t.stage==='rescue-respawned'&&t.hp===10&&t.position.level===0&&Math.max(Math.abs(t.position.x-3221),Math.abs(t.position.z-3218))<=3),
  laws:settled(l,563,5,0,1000,lawSpent)&&l.request.rescueMode==='npc-respawn-once'&&l.coinsBefore===19911&&held(law,95,id=>id===563)===5,
  topup:settled(e,557,1,4,20,earthSpent)&&e.request.expectedOwned===4&&e.request.rescueMode===undefined&&e.coinsBefore===coins(law)&&held(earth,95,id=>id===557)===5,
  costs:lawSpent>=5&&lawSpent<=5000&&earthSpent>=1&&earthSpent<=20&&lawSpent+earthSpent<=5020&&coins(earth)>=10000,
  assets:JSON.stringify(totals(law))===JSON.stringify(expected(5,4,lawSpent))&&JSON.stringify(totals(earth))===JSON.stringify(expected(5,5,lawSpent+earthSpent))
   &&[law,earth,repeat].every(s=>held(s,93,id=>id===590)===1&&(s.inventories[93]??[]).length===1&&(s.inventories[94]??[]).length===0),
  result:[{r:p.buy,v:buy,n:5},{r:p.topup,v:topup,n:1}].every(({r,v,n})=>r.code===0&&v?.ok===true&&v.acquired===n&&v.targetMet===true&&v.conserved===true&&v.unrelated===true&&v.banked===true&&v.reserveKept===true&&!v.died&&!v.damaged),
  restart:p.again.code===0&&again?.ok===true&&again.newItemsThisSession===0&&again.cashDeltaThisSession===0&&sameContainers(law,repeat)&&again.offerId===l.offerId,
  refusal:p.refuse.code===1&&p.refuse.log.includes('rescue refused:')&&!p.refuse.log.includes('"stage":"rescue-intent"')
   &&sameContainers(refuseBefore,refused)&&JSON.stringify(refuseBefore.position)===JSON.stringify(refused.position)&&refused.skills[3]?.level===refuseBefore.skills[3]?.level,
  logout:[p.buy,p.topup,p.again,p.refuse].every(r=>r.log.split(/\r?\n/).includes('LOGOUT logged-out')),
  healthy:[law,earth,repeat].every(s=>s.skills[3]?.level===10&&s.position.level===0&&s.position.x>=3180&&s.position.x<=3188&&s.position.z>=3433&&s.position.z<=3447),
 };
}
function verifyMagic(directory:string,memo:ReleaseMemo=new Map()){
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const now=Date.now(),ageMs=now-meta.at;
 const endpoints=savedEndpoints(meta);
 const read=(label:string)=>readPracticeSave(join(directory,label+'.sav'));
 const run=(label:string):Run=>({code:meta[label+'Code'],log:readFileSync(join(directory,label+'.log'),'utf8')+readFileSync(join(directory,label+'.err'),'utf8')});
 const l=JSON.parse(readFileSync(join(directory,'law-journal.json'),'utf8')),e=JSON.parse(readFileSync(join(directory,'earth-journal.json'),'utf8'));
 const checks={...magicOrderChecks({before:read('before'),law:read('law'),earth:read('earth'),repeat:read('repeat'),refuseBefore:read('refuse-before'),refused:read('refused'),lawJournal:l,earthJournal:e,buy:run('buy'),topup:run('topup'),again:run('again'),refuse:run('refuse')}),
  identity:l?.request.actor===meta.buyer&&e?.request.actor===meta.buyer&&l?.request.server===endpoints.server&&e?.request.server===endpoints.server&&l?.request.goal===meta.lawKey&&e?.request.goal===meta.earthKey,
  sellers:['sell-law','sell-earth'].every(label=>{const r=run(label);return r.code===0&&resultLine(r.log,'GE_SELL_RESULT')?.ok===true&&r.log.split(/\r?\n/).includes('LOGOUT logged-out');}),
  source:meta.source===geProofRuntime(memo),fresh:Number.isFinite(meta.at)&&meta.at<=now};
 return{ok:Object.values(checks).every(Boolean),at:now,ageMs,checks,scope:'Native practice rescue and finite law/earth acquisitions for unchanged Magic37 consumer; no Magic levels or live credit claimed.'};
}

// A save write does not release the engine's player state. Stop the owned stack before staging.
export async function stageWithStoppedStack<T>(path:string,stop:()=>Promise<void>,stage:()=>Promise<string>,position:{x:number;z:number;level:number},
 restart:()=>Promise<T>,read:typeof readPracticeSave=readPracticeSave):Promise<T>{
 await stop();
 const staged=await stage(),p=read(staged).position;
 if(resolve(staged)!==resolve(path)||p.x!==position.x||p.z!==position.z||p.level!==position.level)throw Error(`staged entry save unconfirmed at ${p.x},${p.z},${p.level}`);
 return await restart();
}

// PlayerLoading.load prefers the GE ledger checkpoint (market.sqlite accounts) over the .sav. With the stack stopped, replace only
// this practice buyer's existing checkpoint with the verified pocket save. Its carried, worn and bank assets must already match.
export function syncPracticeCheckpoint(db:Database,actor:string,pocketPath:string,position:{x:number;z:number;level:number},evidence:string){
 const pocket=readFileSync(pocketPath),staged=readPracticeSave(pocketPath),owner=actor.toLowerCase().replace(/[^a-z0-9]/g,'_');
 if(staged.position.x!==position.x||staged.position.z!==position.z||staged.position.level!==position.level)throw Error('pocket save position unconfirmed');
 return db.transaction(()=>{
  const open=db.query<{n:number},[string]>("SELECT count(*) AS n FROM offers WHERE owner=? AND (slot>=0 OR state='open')").get(owner)!.n;
  if(open!==0)throw Error(`practice buyer has ${open} outstanding GE offers; checkpoint not staged`);
  const row=db.query<{save:Uint8Array},[string]>('SELECT save FROM accounts WHERE owner=?').get(owner);
  if(!row)return null;
  writeFileSync(evidence,row.save);const previous=readPracticeSave(evidence);
  if(![93,94,95].every(c=>JSON.stringify(bankTotals(previous.inventories[c]??[]))===JSON.stringify(bankTotals(staged.inventories[c]??[]))))
   throw Error('checkpoint assets differ from pocket save; checkpoint not staged');
  const count=()=>db.query<{n:number},[]>('SELECT count(*) AS n FROM accounts').get()!.n,rows=count();
  if(db.query('UPDATE accounts SET save=? WHERE owner=?').run(pocket,owner).changes!==1)throw Error('checkpoint update unconfirmed');
  const saved=db.query<{save:Uint8Array},[string]>('SELECT save FROM accounts WHERE owner=?').get(owner)?.save;
  if(!saved||Buffer.compare(Buffer.from(saved),pocket)!==0||count()!==rows)throw Error('checkpoint update unconfirmed');
  return previous.position;
 })();
}
function practiceMarket(endpoints:ProofEndpoints){
 const engine=resolve(rsSdkRoot(),'server','engine'),path=resolve(engine,endpoints.env.GE_DATABASE);
 if(!path.startsWith(engine+sep)||!existsSync(path))throw Error(`owned practice market database unresolved: ${path}`);
 return path;
}

async function run(directory:string){
 if(!process.env.DELIVERY_DIR||!existsSync(join(practiceDir(),'delivery-native.lock')))throw Error('native turn required: run through delivery');
 for(const path of ['before.sav','north/before.sav','magic/before.sav','magic/before-checkpoint.sav','magic/refuse-before.sav'])
  if(existsSync(join(directory,path)))throw Error(`preserve before snapshot: ${path}`);
 if(freemem()/2**30<PRACTICE_STARTUP_GB)throw Error(`practice needs ${FREE_FLOOR_GB}GiB floor plus ${PRACTICE_RESERVE_GB}GiB startup reserve`);
 const owned=selectGeProofEndpoints(),metadata={server:owned.server,endpoints:{ports:owned.ports,instance:owned.instance}};
 const actors=new Set<string>();
 const createOwnedBot=async(name:string)=>{
  if(existsSync(join(rsSdkRoot(),'bots',name)))throw Error('practice name already exists');
  const {envPath}=await createBot(name);
  writeFileSync(envPath,geProofAccountEnv(readFileSync(envPath,'utf8'),owned));
  assertGeProofAccount(readFileSync(envPath,'utf8'),owned.env);
  actors.add(name);
 };
 const lock=join(practiceDir(),'delivery-practice.lock'),fd=openSync(lock,'wx');
 writeFileSync(fd,JSON.stringify({pid:process.pid,task:'ge-bulk-order',directory,at:Date.now()}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 const command=async(args:string[],env:Record<string,string>,label:string,timeoutMs=150000):Promise<Run>=>{
  if(await waitFreeMemory(FREE_FLOOR_GB)<FREE_FLOOR_GB)throw Error('practice free memory below floor');
  const actor=args[0]==='scripts/buy-owned-ge-item.ts'?args[1]:args[2];
  if(!actor||!actors.has(actor))throw Error('owned practice actor required');
  assertGeProofAccount(readFileSync(join(rsSdkRoot(),'bots',actor,'bot.env'),'utf8'),owned.env);
  const out=join(directory,label+'.log'),err=join(directory,label+'.err');
  const child=Bun.spawn(['bun',...args],{cwd:resolve(import.meta.dir,'../../..'),env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',...env,...owned.env},stdout:Bun.file(out),stderr:Bun.file(err),windowsHide:true});
  let expired=false,termination:Promise<void>|undefined;const timer=setTimeout(()=>{expired=true;termination=killTree(child.pid);},timeoutMs);
  const code=await child.exited;clearTimeout(timer);await termination;
  return{code:expired?-1:code,log:readFileSync(out,'utf8')+readFileSync(err,'utf8')};
 };
 try{
  stack=await startGeProofStack(owned);
  const root=directory;
  for(const remote of [false,true]){
  directory=remote?join(root,'north'):root;mkdirSync(directory,{recursive:true});
  const order=remote?NORTH_CASE.order:ORDER;
  const source=geProofRuntime(),[buyer,seller]=[runBotName('flgebuy',remote?2:1),runBotName('flgesell',remote?2:1)],orderKey='native-'+Date.now(),paths:Record<string,string>={};
  const seeds:[string,{id:number;count:number}][]=[[buyer,{id:995,count:order.coins}],[seller,{id:order.item,count:order.quantity}]];
  for(const [name,stock] of seeds){
   await createOwnedBot(name);
   paths[name]=await applyPreset(name,remote&&name===buyer
    ?{position:NORTH_CASE.position,skills:{Hitpoints:NORTH_CASE.hitpoints},inventory:NORTH_CASE.carried,bank:[stock,{id:329,count:2}]}
    :{position:BANK_TILE,skills:{Hitpoints:10},bank:[stock,...(name===buyer?[{id:329,count:2}]:[])]});
   if(name===buyer&&!remote){const initial=readPracticeSave(paths[name]!);setPracticeSkills(paths[name]!,initial.skills.map(s=>({level:s.index===3?3:s.level,xp:s.xp})));}
  }
  copyFileSync(paths[buyer]!,join(directory,'before.sav'));
  const sell=await command(['packages/practice/src/ge-bulk-order-proof.ts','--sell',seller,String(order.item),String(order.quantity),String(order.ask)],{},'sell');
  const env={ORDER_KEY:orderKey,ITEM_ID:String(order.item),QUANTITY:String(order.quantity),LIMIT_PRICE:String(order.limit),CASH_RESERVE:String(order.reserve),ORDER_MS:'600000',FILL_WAIT_TICKS:'20'};
  const buy=sell.code===0?await command(['scripts/buy-owned-ge-item.ts',buyer],env,'buy',remote?330000:150000):{code:1,log:''};
  if(sell.code!==0){writeFileSync(join(directory,'buy.log'),'');writeFileSync(join(directory,'buy.err'),'seller failed');}
  const saved=await waitPracticeSave(paths[buyer]!,s=>held(s,95,id=>id===order.item)===order.quantity);
  copyFileSync(paths[buyer]!,join(directory,'after.sav'));if(!saved.matched)throw Error('exact purchased bank stock not saved');
  const journalPath=orderPaths(serverFromEnv(readFileSync(join(rsSdkRoot(),'bots',buyer,'bot.env'),'utf8')),buyer,orderKey).journal;
  writeFileSync(join(directory,'journal.json'),existsSync(journalPath)?readFileSync(journalPath):'null');
  // The rerun must find the settled journal and leave the GE untouched.
  const again=await command(['scripts/buy-owned-ge-item.ts',buyer],env,'again');
  const repeated=await waitPracticeSave(paths[buyer]!,s=>held(s,95,id=>id===order.item)===order.quantity);
  copyFileSync(paths[buyer]!,join(directory,'repeat.sav'));if(!repeated.matched)throw Error('resumed bank stock not saved');
  // A new order key for the same owned item must refuse instead of buying duplicate stock.
  const refuse=remote?await command(['scripts/buy-owned-ge-item.ts',buyer],{...env,ORDER_KEY:orderKey+'-dup'},'refuse'):undefined;
  if(refuse){await waitPracticeSave(paths[buyer]!,s=>held(s,95,id=>id===order.item)===order.quantity);copyFileSync(paths[buyer]!,join(directory,'refused.sav'));}
  writeFileSync(join(directory,'native.json'),JSON.stringify({...metadata,at:Date.now(),source,orderKey,buyer,seller,sellCode:sell.code,buyCode:buy.code,againCode:again.code,refuseCode:refuse?.code},null,2));
  }
  directory=join(root,'magic');mkdirSync(directory,{recursive:true});
  const [buyer,seller,refuser]=[runBotName('flgemag',1),runBotName('flgemags',1),runBotName('flgeref',1)],source=geProofRuntime();
  for(const name of [buyer,seller,refuser])await createOwnedBot(name);
  const preset={skills:{Hitpoints:10,Magic:31},inventory:MAGIC_CASE.pack,bank:MAGIC_CASE.bank};
  const buyerPath=await applyPreset(buyer,{...preset,position:BANK_TILE});
  const snapshot=await command(['packages/practice/src/ge-bulk-order-proof.ts','--snapshot',buyer],{},'snapshot');
  if(snapshot.code!==0||!snapshot.log.split(/\r?\n/).includes('LOGOUT logged-out'))throw Error('rescue bank snapshot/logout unproved');
  // Keep the practice lock and the observed bank snapshot across this owned stack restart.
  const ownedPids=Object.values(JSON.parse(readFileSync(pidsFile(owned.instance),'utf8')) as Record<string,{pid:number}>).map(p=>p.pid);
  assertGeProofAccount(readFileSync(join(rsSdkRoot(),'bots',buyer,'bot.env'),'utf8'),owned.env);
  const market=practiceMarket(owned);
  stack=await stageWithStoppedStack(buyerPath,async()=>{
   await stack!.stop();
   if(ownedPids.some(pid=>commandLine(pid)!==null))throw Error('owned practice stack termination unproved; entry not staged');
  },async()=>{
   const staged=await applyPreset(buyer,{...preset,position:MAGIC_CASE.position}),db=new Database(market,{strict:true});
   try{db.exec('PRAGMA busy_timeout=5000');syncPracticeCheckpoint(db,buyer,staged,MAGIC_CASE.position,join(directory,'before-checkpoint.sav'));}finally{db.close();}
   return staged;
  },MAGIC_CASE.position,
  ()=>startGeProofStack(owned));
  copyFileSync(buyerPath,join(directory,'before.sav'));
  await applyPreset(seller,{position:BANK_TILE,skills:{Hitpoints:10},bank:[{id:563,count:5},{id:557,count:1}]});
  const sellLaw=await command(['packages/practice/src/ge-bulk-order-proof.ts','--sell',seller,'563','5','1000'],{},'sell-law');
  const sellEarth=await command(['packages/practice/src/ge-bulk-order-proof.ts','--sell',seller,'557','1','20'],{},'sell-earth');
  if(sellLaw.code||sellEarth.code)throw Error('magic input sellers failed');
  const lawKey='native-law-'+Date.now(),earthKey='native-earth-'+Date.now();
  const lawEnv={RESCUE_MODE:'npc-respawn-once',ORDER_KEY:lawKey,ITEM_ID:'563',QUANTITY:'5',LIMIT_PRICE:'1000',CASH_RESERVE:'10000',ORDER_MS:'900000',FILL_WAIT_TICKS:'50',EXPECTED_OWNED:''};
  const buy=await command(['scripts/buy-owned-ge-item.ts',buyer],lawEnv,'buy',240000);
  const lawSaved=await waitPracticeSave(buyerPath,s=>held(s,95,id=>id===563)===5);copyFileSync(buyerPath,join(directory,'law.sav'));
  if(buy.code||!lawSaved.matched)throw Error('rescue law acquisition failed; inspect magic/buy.log and buy.err');
  const journal=(key:string)=>orderPaths(owned.server,buyer,key).journal;
  copyFileSync(journal(lawKey),join(directory,'law-journal.json'));
  const again=await command(['scripts/buy-owned-ge-item.ts',buyer],lawEnv,'again');
  await waitPracticeSave(buyerPath,s=>held(s,95,id=>id===563)===5);copyFileSync(buyerPath,join(directory,'repeat.sav'));
  const topup=await command(['scripts/buy-owned-ge-item.ts',buyer],{...lawEnv,RESCUE_MODE:'',ORDER_KEY:earthKey,ITEM_ID:'557',QUANTITY:'1',LIMIT_PRICE:'20',EXPECTED_OWNED:'4',ORDER_MS:'600000'},'topup');
  const earthSaved=await waitPracticeSave(buyerPath,s=>held(s,95,id=>id===557)===5);copyFileSync(buyerPath,join(directory,'earth.sav'));
  if(topup.code||!earthSaved.matched)throw Error('authorized four-plus-one earth acquisition failed');
  copyFileSync(journal(earthKey),join(directory,'earth-journal.json'));
  const refusePath=await applyPreset(refuser,{...preset,position:MAGIC_CASE.position,inventory:[...MAGIC_CASE.pack,{id:995,count:1}]});
  copyFileSync(refusePath,join(directory,'refuse-before.sav'));
  const refuse=await command(['scripts/buy-owned-ge-item.ts',refuser],{...lawEnv,ORDER_KEY:lawKey+'-refuse'},'refuse');
  await waitPracticeSave(refusePath,s=>held(s,93,id=>id===590)===1);copyFileSync(refusePath,join(directory,'refused.sav'));
  writeFileSync(join(directory,'native.json'),JSON.stringify({...metadata,at:Date.now(),source,buyer,lawKey,earthKey,buyCode:buy.code,topupCode:topup.code,againCode:again.code,refuseCode:refuse.code,'sell-lawCode':sellLaw.code,'sell-earthCode':sellEarth.code},null,2));
  return verify(root);
 }finally{
  try{await (stack?stack.stop():stopStack(owned.instance));}finally{closeSync(fd);unlinkSync(lock);}
 }
}

// Seller fixture: list the owned stock as banknotes at one exact ask, then log out. The offer stays on the book.
async function sell(name:string,item:number,quantity:number,price:number){
 const s=await openBot(name);let ok=false,detail='';
 try{
  if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!s.sdk.getState()?.bank.isOpen,{timeoutTicks:15}))throw Error('seller bank open unproved');
  const stock=s.sdk.getState()!.bank.items.find(i=>i.id===item);if(!stock||stock.count<quantity)throw Error('seller stock missing');
  const carried=()=>s.sdk.getInventory().filter(i=>i.name===stock.name).reduce((n,i)=>n+i.count,0);
  if(!(await s.bot.withdrawItem(stock,quantity,{asNote:true})).success||!await waitUntil(s,()=>carried()===quantity,{timeoutTicks:10}))throw Error('seller noted withdrawal unobserved');
  await s.bot.closeBank();
  if(!(await s.bot.openGE(15000)).success)throw Error('seller GE interface unavailable');
  const placed=await s.bot.placeGEOffer({item,side:'sell',quantity,price},20000),offer=placed.offer;
  if(!placed.success||!offer||offer.item!==item||offer.side!=='sell'||offer.quantity!==quantity||offer.price!==price)throw Error('seller offer unconfirmed: '+placed.message);
  if(!await waitUntil(s,()=>carried()===0,{timeoutTicks:10}))throw Error('seller escrow debit unobserved');
  ok=true;detail=JSON.stringify({offerId:offer.id,quantity,price});
 }catch(error){detail=String(error);}
 console.log('GE_SELL_RESULT '+JSON.stringify({ok,detail}));
 await finish([s],ok,detail);
}

if(import.meta.main){
 try{
  if(process.argv[2]==='--snapshot'){
   const name=process.argv[3]!;
   if(!name)throw Error('practice snapshot required');
   assertGeProofAccount(readFileSync(join(rsSdkRoot(),'bots',name,'bot.env'),'utf8'));
   const s=await openBot(name);let ok=false,detail='';
   try{
    const generation=s.bankObservation?.()?.generation??0;
    if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!s.sdk.getState()?.bank.isOpen&&(s.bankObservation?.()?.generation??0)>generation,{timeoutTicks:15}))throw Error('snapshot fresh bank unproved');
    const bank=s.bankObservation?.();if(!bank)throw Error('snapshot bank unavailable');bankTotals(bank.items);
    ok=true;detail='observed rescue bank baseline';
   }catch(error){detail=String(error);}
   await finish([s],ok,detail);
  }else if(process.argv[2]==='--sell'){
   const [name,item,quantity,price]=process.argv.slice(3);
   if(!name)throw Error('practice seller required');
   assertGeProofAccount(readFileSync(join(rsSdkRoot(),'bots',name,'bot.env'),'utf8'));
   await sell(name,Number(item),Number(quantity),Number(price));
  }else{
   if(!process.env.DELIVERY_DIR)throw Error('run through bun run deliver ge-bulk-order');
   const directory=resolve(process.env.DELIVERY_DIR);
   const memo:ReleaseMemo=new Map(),ge=process.argv[2]==='--verify'?verify(directory,memo):await run(directory);
   const shop=ge.ok?(process.argv[2]==='--verify'?verifyShopSupply(join(directory,'shop'),memo):await runShopSupplyNative(join(directory,'shop'))):null;
   const report={ok:ge.ok&&shop?.ok===true,ge,shop};console.log(JSON.stringify(report));process.exitCode=report.ok?0:1;
  }
 }catch(error){console.error(String(error));process.exitCode=1;}
}
