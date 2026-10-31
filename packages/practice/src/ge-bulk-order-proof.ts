import {readFileSync,writeFileSync,copyFileSync,existsSync,openSync,closeSync,unlinkSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {freemem} from 'node:os';
import {startStack} from './stack';
import {createBot} from './bots';
import {applyPreset} from './presets';
import {runBotName} from './prove';
import {killTree} from './proc';
import {rsSdkRoot,practiceDir} from './paths';
import {readPracticeSave,waitPracticeSave,setPracticeSkills} from '../../../scripts/measure/fleet-player-save';
import {workerSourceRevision} from '../../core/src/worker-release';
import {openBot,finish,serverFromEnv} from '../../core/src/bot';
import {waitUntil} from '../../core/src/ticks';
import {orderPaths,orderQuantity,orderEscrow,orderAccounting,type ItemOrder} from '../../../scripts/buy-owned-ge-item';
import { FREE_FLOOR_GB, PRACTICE_RESERVE_GB, PRACTICE_STARTUP_GB } from '../../core/src/memory';

// Native bulk GE order: an owned seller lists noted grapes, then the actual worker buys the exact
// quantity, banks it and reruns the same order key. The consumer stage reads the saved bank.
type Save=ReturnType<typeof readPracticeSave>;
type Run={code:number;log:string};
export const ORDER={item:1987,quantity:300,limit:5,ask:3,reserve:100,coins:2000};
const BANK_TILE={x:3185,z:3436,level:0};
// The live consumer entry: Pocketpython at north Varrock with 11 HP, 26 carried salmon and 60 coins.
export const NORTH_CASE={position:{x:3165,z:3487,level:0},hitpoints:11,
 carried:[...Array.from({length:26},()=>({id:329,count:1})),{id:995,count:60}],order:{...ORDER,quantity:500,coins:3000}};
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

function verifyCase(directory:string,remote=false){
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const log=(label:string)=>readFileSync(join(directory,label+'.log'),'utf8')+readFileSync(join(directory,label+'.err'),'utf8');
 const journal=existsSync(join(directory,'journal.json'))?JSON.parse(readFileSync(join(directory,'journal.json'),'utf8')) as ItemOrder:null;
 const repeat=readPracticeSave(join(directory,'repeat.sav'));
 const checks={...bulkOrderChecks({before:readPracticeSave(join(directory,'before.sav')),after:readPracticeSave(join(directory,'after.sav')),repeat,journal,
  sell:{code:meta.sellCode,log:log('sell')},buy:{code:meta.buyCode,log:log('buy')},again:{code:meta.againCode,log:log('again')},order:remote?NORTH_CASE.order:ORDER}),
  ...(remote?{remoteEntry:northEntryCheck(readPracticeSave(join(directory,'before.sav')),log('buy')),
   refusal:duplicateRefusalCheck(repeat,readPracticeSave(join(directory,'refused.sav')),{code:meta.refuseCode,log:log('refuse')},NORTH_CASE.order.item)}:{}),
  identity:journal?.request.actor===meta.buyer&&journal?.request.goal===meta.orderKey&&journal?.request.server==='localhost:8888',
  source:meta.source===workerSourceRevision(),fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000};
 return{ok:Object.values(checks).every(Boolean),at:Date.now(),checks,source:meta.source,order:remote?NORTH_CASE.order:ORDER,
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
function verify(directory:string){
 const bank=verifyCase(directory),north=verifyCase(join(directory,'north'),true);
 const report={...bank,ok:bank.ok&&north.ok,checks:{...bank.checks,north:north.ok},north};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}

async function run(directory:string){
 if(freemem()/2**30<PRACTICE_STARTUP_GB)throw Error(`practice needs ${FREE_FLOOR_GB}GiB floor plus ${PRACTICE_RESERVE_GB}GiB startup reserve`);
 const lock=join(practiceDir(),'delivery-practice.lock'),fd=openSync(lock,'wx');
 writeFileSync(fd,JSON.stringify({pid:process.pid,task:'ge-bulk-order',directory,at:Date.now()}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 const command=async(args:string[],env:Record<string,string>,label:string,timeoutMs=150000):Promise<Run>=>{
  const out=join(directory,label+'.log'),err=join(directory,label+'.err');
  const child=Bun.spawn(['bun',...args],{cwd:resolve(import.meta.dir,'../../..'),env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',...env},stdout:Bun.file(out),stderr:Bun.file(err),windowsHide:true});
  let expired=false,termination:Promise<void>|undefined;const timer=setTimeout(()=>{expired=true;termination=killTree(child.pid);},timeoutMs);
  const code=await child.exited;clearTimeout(timer);await termination;
  return{code:expired?-1:code,log:readFileSync(out,'utf8')+readFileSync(err,'utf8')};
 };
 try{
  stack=await startStack({tickMs:150,readyTimeoutMs:60000});
  const root=directory;
  for(const remote of [false,true]){
  directory=remote?join(root,'north'):root;mkdirSync(directory,{recursive:true});
  const order=remote?NORTH_CASE.order:ORDER;
  const source=workerSourceRevision(),[buyer,seller]=[runBotName('flgebuy',remote?2:1),runBotName('flgesell',remote?2:1)],orderKey='native-'+Date.now(),paths:Record<string,string>={};
  const seeds:[string,{id:number;count:number}][]=[[buyer,{id:995,count:order.coins}],[seller,{id:order.item,count:order.quantity}]];
  for(const [name,stock] of seeds){
   if(existsSync(join(rsSdkRoot(),'bots',name)))throw Error('practice name already exists');
   await createBot(name);
   if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(rsSdkRoot(),'bots',name,'bot.env'),'utf8')))throw Error('practice only');
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
  writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source,orderKey,buyer,seller,sellCode:sell.code,buyCode:buy.code,againCode:again.code,refuseCode:refuse?.code},null,2));
  }
  return verify(root);
 }finally{
  try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}
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
  if(process.argv[2]==='--sell'){
   const [name,item,quantity,price]=process.argv.slice(3);
   if(!name||!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(rsSdkRoot(),'bots',name,'bot.env'),'utf8')))throw Error('practice seller required');
   await sell(name,Number(item),Number(quantity),Number(price));
  }else{
   if(!process.env.DELIVERY_DIR)throw Error('run through bun run deliver ge-bulk-order');
   const directory=resolve(process.env.DELIVERY_DIR);
   process.exitCode=(process.argv[2]==='--verify'?verify(directory):await run(directory)).ok?0:1;
  }
 }catch(error){console.error(String(error));process.exitCode=1;}
}
