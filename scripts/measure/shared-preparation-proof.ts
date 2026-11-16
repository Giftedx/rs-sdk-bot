// Finite native acceptance for bank preflight, ground filters and exact partial supplies.
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {openBot,settle,getWorld,accountOf,serverFromEnv} from '../../packages/core/src/bot';
import type {Session} from '../../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../../packages/core/src/ticks';
import {tickWaits} from '../../packages/core/src/tick-stream';
import {takeItems} from '../../packages/core/src/trip';
import {isLocalServer} from '../../packages/core/src/localserver';
import {readLogoutProof} from '../../packages/core/src/session-lifecycle';
import {goTo} from '../../packages/core/src/walk';
import {performFleetTransfer,watchTradeScreen,type Order} from '../fleet-trade';
import {runBankJob} from '../microbot-bank-jobs';
import {runLootTrip} from '../microbot-loot-trip';
import {BOW_TRIP,SNARE_KIT,pickTrip,restock} from '../pk-hunt';

const totals=(items:readonly {id:number;count:number}[])=>{const out:Record<number,number>={};for(const i of items)out[i.id]=(out[i.id]??0)+i.count;return out;};
async function audit(s:Session){
 const prior=s.bankObservation?.(),current=!!s.sdk.getState()?.bank.isOpen&&!!prior,generation=prior?.generation??-1;
 assert.equal((await s.bot.openBank()).success,true,'audit bank open');
 assert.equal(await waitUntil(s,()=>!!s.sdk.getState()?.bank.isOpen&&!!s.bankObservation?.()&&(current||s.bankObservation!()!.generation>generation),{timeoutTicks:12}),true,'fresh audit bank');
 const bank=totals(s.bankObservation!()!.items),pack=totals(s.sdk.getInventory()),gear=s.sdk.getEquipment().map(i=>({id:i.id,count:i.count,slot:i.slot}));
 const hp=s.sdk.getSkill('Hitpoints')?.level,life=s.sdk.getState()?.player?.lifeId;
 await s.bot.closeBank();return {bank,pack,gear,hp,life,assets:totals([...Object.entries(bank),...Object.entries(pack)].map(([id,count])=>({id:Number(id),count})))};
}

async function ownedBankRingConsumer(name:string,companion:string){
 const root=resolve(import.meta.dir,'../..');
 assert.match(name,/^[a-z0-9]{1,11}$/i);assert.equal(companion,name+'b','declared companion suffix');
 const servers=[name,companion].map(n=>serverFromEnv(readFileSync(resolve(root,'vendor/rs-sdk/bots',n,'bot.env'),'utf8')));
 assert.equal(servers[0],servers[1],'same practice server');assert.equal(isLocalServer(servers[0]!),true,'native proof is local only');
 const sessions:Session[]=[],off:(()=>void)[]=[],deadline=Date.now()+95000;let signalled=false,ok=false,settled=false,error='';
 const signal=()=>{signalled=true;},stop=()=>signalled||Date.now()>=deadline||['stop-all','stop-swarm',`stop-${name}`,`stop-${companion}`].some(file=>existsSync(resolve(root,'.practice',file)));
 const check=()=>assert.equal(stop(),false,'owned consumer stopped or deadline');
 process.on('SIGINT',signal);process.on('SIGTERM',signal);
 let evidence:object|undefined;
 try{
  check();tickWaits.active++;
  try{sessions.push(await openBot(name));check();sessions.push(await openBot(companion));}finally{tickWaits.active--;}
  const [giver,receiver]=sessions as [Session,Session];
  check();const before=[await audit(giver),await audit(receiver)];
  assert.deepEqual(before[0]!.bank,{2357:1});assert.deepEqual(before[0]!.pack,{});
  assert.deepEqual(before[1]!.bank,{1592:1});assert.deepEqual(before[1]!.pack,{});
  const withdrawn=await takeItems(giver,0,{gold_bar:1},n=>waitTicks(giver,n),{stop,deadline:performance.now()+Math.min(30000,deadline-Date.now())});
  assert.equal(withdrawn.ok,true,withdrawn.detail);check();
  const donorReady=await audit(giver);
  assert.deepEqual(donorReady,{...before[0]!,bank:{},pack:{2357:1}});
  const progress:Parameters<typeof watchTradeScreen>[1][]=[{uncertain:false,count:0},{uncertain:false,count:0}];
  sessions.forEach((s,i)=>off.push(watchTradeScreen(s,progress[i]!)));
  const now=Date.now(),order:Order={id:'shared-ring-'+now,server:servers[0]!,from:name,to:companion,item:'Gold bar',count:1,start:now,end:Math.min(now+45000,deadline),meet:[{x:3269,z:3167,level:0},{x:3270,z:3167,level:0}]};
  const transfers=await Promise.allSettled(sessions.map((s,i)=>performFleetTransfer(s,order,i===0?'from':'to',progress[i]!,{gone:stop})));
  for(const transfer of transfers)if(transfer.status==='rejected')throw transfer.reason;
  check();assert.ok(progress.every(p=>p.count===1&&p.screen===true),'paired exact trade progress');
  assert.equal(progress[1]!.bank?.count,1,'receiver bank credit receipt');
  const transferred=[await audit(giver),await audit(receiver)];
  assert.deepEqual(transferred[0],{...before[0]!,bank:{},assets:{}});
  assert.deepEqual(transferred[1],{...before[1]!,bank:{1592:1,2357:1},assets:{1592:1,2357:1}});
  const result=await runBankJob(receiver,{family:'jewellery',recipe:'gold_ring',target:1,batch:1,cap:600,returnTicks:120,members:false,bank:{x:3269,z:3167,level:0},site:{x:3275,z:3186,level:0}},stop);
  check();assert.equal(result.ok,true,result.failure);assert.equal(result.completed,1);assert.equal(result.trips,1);assert.deepEqual(result.banked,{1635:1});
  const after=[await audit(giver),await audit(receiver)];
  assert.deepEqual(after[0],transferred[0]);
  assert.deepEqual(after[1],{...before[1]!,bank:{1592:1,1635:1},assets:{1592:1,1635:1}});
  evidence={case:'owned-bank-ring-consumer',withdrawn:withdrawn.ok,transfer:progress,completed:result.completed,banked:result.banked,before,donorReady,transferred,after,scope:'native bank withdrawal, transfer helper and actual production worker; no live or CLI-admission claim'};
  ok=true;
 }catch(cause){error=String(cause);}
 finally{
  for(const unwatch of off)unwatch();
  try{settled=await settle(sessions,ok,error||'owned bank transfer and one-ring consumer reconciled');}
  finally{process.off('SIGINT',signal);process.off('SIGTERM',signal);}
 }
 if(!settled)return false;
 const logout=sessions.map(s=>readLogoutProof(s.name,servers[0]!,{root:resolve(root,'.practice/session-lifecycle')}));
 logout.forEach((proof,i)=>{assert.equal(proof.state,'confirmed','native companion logout');if(proof.state==='confirmed')assert.equal(proof.attemptId,sessions[i]!.lifecycle?.attemptId,'same session logout');});
 console.log('SHARED_PREPARATION_PROOF '+JSON.stringify({...evidence,logoutsConfirmed:true}));return true;
}

async function bankPreflight(s:Session){
 const before=await audit(s),withdraw=s.bot.withdrawItem;let dispatches=0;
 assert.equal(before.bank[1739],2);assert.equal(before.bank[995]??0,0);
 s.bot.withdrawItem=async(...args)=>{dispatches++;return withdraw.apply(s.bot,args);};
 let result:Awaited<ReturnType<typeof runBankJob>>;
 try{result=await runBankJob(s,{family:'tanning',recipe:'soft',target:2,batch:2,cap:200,returnTicks:50,members:true,bank:{x:3269,z:3167,level:0},site:{x:3276,z:3192,level:0}});}finally{s.bot.withdrawItem=withdraw;}
 const after=await audit(s);
 assert.equal(result.ok,false);assert.equal(result.completed,0);assert.equal(result.trips,0);assert.equal(result.atBank,true);
 assert.equal(result.preparation?.status,'short');
 assert.deepEqual(result.preparation?.shortfalls,{995:2});assert.deepEqual(result.banked,{});
 assert.equal(dispatches,0);assert.deepEqual(after,before);assert.equal(after.assets[1741]??0,0);
 return {case:'bank-preflight-tanning-short',shortfalls:result.preparation?.shortfalls,dispatches,assetsPreserved:true,completed:result.completed};
}

async function lootFilters(s:Session){
 const bank={x:3253,z:3421,level:0},site={x:3243,z:3397,level:0},before=await audit(s),world=await getWorld();
 const client=s.client as {objType:(id:number)=>{name:string}};
 assert.equal(client.objType(1511).name,'Logs');assert.equal(client.objType(1129).name,'Leather body');
 assert.equal((await goTo(s,world,site,accountOf(s),{legTimeoutTicks:80,maxRetriesPerLeg:1,planBudgetMs:5000})).ok,true,'reach native ground spawns');
 assert.equal(await waitUntil(s,()=>[1511,1129].every(id=>s.sdk.getState()?.groundItems.some(i=>i.id===id)),{timeoutTicks:10}),true,'listed and ignored native ground visible');
 const pickup=s.sdk.sendPickup,pickups:number[]=[];
 s.sdk.sendPickup=async(...args)=>{pickups.push(args[2]);return pickup.apply(s.sdk,args);};
 let result:Awaited<ReturnType<typeof runLootTrip>>;
 try{result=await runLootTrip(s,{target:2,batch:2,cap:600,returnTicks:120,members:true,bank,site,policy:{mode:'list',ids:[],names:[],nameGlobs:['Log?','Leather*'],ignoredIds:[1129],minimumValue:0,maximumValue:2147483647,radius:8,idleTicks:12}});}finally{s.sdk.sendPickup=pickup;}
 const after=await audit(s);
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.completed,2);assert.equal(result.bankReconciled,true);assert.deepEqual(result.acquired,{1511:2});
 assert.deepEqual(pickups,[1511,1511]);assert.equal((after.bank[1511]??0)-(before.bank[1511]??0),2);
 assert.equal(after.assets[1129]??0,before.assets[1129]??0);assert.deepEqual(after.pack,before.pack);assert.deepEqual(after.gear,before.gear);
 return {case:'loot-wildcard-ignore',names:['Logs','Leather body'],pickups,banked:result.banked,ignoredPicked:false};
}

async function partialSupplies(s:Session){
 const before=await audit(s),trip=BOW_TRIP.map(row=>row.id===2434?{...row,minDoses:6,maxSlots:2}:row),withdraw=s.bot.withdrawItem,dispatches:{id:number;count:number}[]=[];
 assert.equal(before.bank[1706],1);assert.equal(before.bank[139],2);assert.equal(before.bank[1712]??0,0);assert.equal(before.bank[2434]??0,0);
 assert.notEqual(pickTrip(Object.entries(before.bank).map(([id,count])=>({id:Number(id),count})),true).name,'bow','default eight doses still required');
 s.bot.withdrawItem=async(...args)=>{const row=args[0];if(!row||typeof row!=='object'||!('id' in row))throw Error('restock exact native row missing');dispatches.push({id:Number(row.id),count:args[1]??1});return withdraw.apply(s.bot,args);};
 let first:Awaited<ReturnType<typeof audit>>|undefined,second:Awaited<ReturnType<typeof audit>>|undefined;
 try{for(let pass=0;pass<2;pass++){
  assert.equal(await restock(s,2,trip,SNARE_KIT),null,'real hunter restock');const observed=await audit(s);
  assert.deepEqual(observed.pack,{139:2,385:2,861:1,1706:1});assert.deepEqual(observed.bank,{385:2});assert.deepEqual(observed.assets,before.assets);assert.deepEqual(observed.gear,before.gear);
  if(pass===0)first=observed;else second=observed;
 }}finally{s.bot.withdrawItem=withdraw;}
 assert.deepEqual(second,first);assert.deepEqual(totals(dispatches),{139:4,385:4,861:2,1706:2});
 return {case:'hunt-restock-partial-glory',restocks:2,glory:1706,prayer:139,prayerDoses:6,prayerSlots:2,assetsPreserved:true,dispatches};
}

if(import.meta.main){
 const [name,mode,companion]=process.argv.slice(2);if(!name||!['bank','loot','partial','trade'].includes(mode??''))throw Error('usage: shared-preparation-proof.ts account bank|loot|partial|trade [companion]');
 if(mode==='trade'){
  try{process.exitCode=await ownedBankRingConsumer(name,companion??name+'b')?0:1;}catch(error){console.error(String(error));process.exitCode=1;}
 }else{
 const s=await openBot(name);let ok=false,detail='shared preparation incomplete';
 try{const result=mode==='bank'?await bankPreflight(s):mode==='loot'?await lootFilters(s):await partialSupplies(s);ok=true;detail=JSON.stringify(result);console.log('SHARED_PREPARATION_PROOF '+detail);}catch(error){detail=String(error);}
 process.exitCode=await settle([s],ok,detail)?0:1;
 }
}
