import {existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {openBot,settle,getWorld,accountOf,serverFromEnv,assertServerAllowed} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {assertSideOwns} from '../packages/core/src/fleet';
import {ownedAccounts} from '../packages/core/src/tradeguard';
import {goTo} from '../packages/core/src/walk';
import {waitUntil} from '../packages/core/src/ticks';
import {depositObserved} from '../packages/core/src/deposit';
import {assertAccountOwnership,assertRecoverableStatus,acquireAccountLeases} from './handoff-inputs';
import {preparePayout} from './banker';
import {ownedSwap,state} from './rune-carrier-trade';
import {inside,leaveBody,enterBody,stopCarriers} from './rune-carrier-bank';
import {leaveRuneStarter,runeSupplyAssets} from './rune-supply';
import {assertRuneDonor} from './rune-carrier-roster';
import {runeStageRoster,runeCarrierShortfall} from './rune-carrier-stage-contract';

export async function mainRuneStage(args:readonly string[]){
 const {mode,names}=runeStageRoster(args),root=resolve(import.meta.dir,'..'),dir=join(root,'.practice');
 const cap=Number(process.env.CAP??1600);if(!Number.isSafeInteger(cap)||cap<1||cap>2800)throw Error('Rune staging budget must be1..2800');
 const servers=names.map(n=>{assertSideOwns(n);return serverFromEnv(readFileSync(join(root,'vendor/rs-sdk/bots',n,'bot.env'),'utf8'));});
 if(new Set(servers.map(s=>s.toLowerCase())).size!==1)throw Error('Rune staging participants must share a server');
 const server=servers[0]!;assertServerAllowed(server);const owned=ownedAccounts(server);
 if(names.some(n=>!owned.has(n.toLowerCase())))throw Error('Rune staging needs authenticated owned participants');
 const runId=process.env.COORDINATOR_RUN_ID??'',read=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
 assertAccountOwnership(names,read(join(dir,'coordinator/state.json')),read(join(root,'swarm.json')).jobs,n=>existsSync(join(dir,'stop-'+n)),runId);
 for(const n of names)if(existsSync(join(dir,'status',n+'.json')))assertRecoverableStatus(read(join(dir,'status',n+'.json')),undefined,()=>true);
 const release=acquireAccountLeases(names,runId),cancel=new AbortController(),opened:Session[]=[],active=new Set<Session>(),closing=new Set<Session>(),monitors:(()=>void)[]=[],flights:Promise<unknown>[]=[],rows:unknown[]=[];
 let failure:unknown,done=false,logout=true,receivedEssence=0,receivedTalismans=0;
 const stop=()=>{
  if(cancel.signal.aborted)return true;
  if(failure||names.some(n=>existsSync(join(dir,'stop-'+n)))||existsSync(join(dir,'stop-coordinator'))||existsSync(join(dir,'stop-swarm'))||[...active].some(s=>s.tick()>cap||state(s)?.player?.isDead)){
   cancel.abort(failure??Error('Rune staging stopped or over budget'));stopCarriers();return true;
  }return false;
 };
 const check=()=>{if(stop())throw cancel.signal.reason;};
 const fail=(s:Session,detail:string)=>{if(!closing.has(s)&&!done){failure=Error(s.name+': '+detail);stop();}};
 const open=async(n:string)=>{check();const s=await openBot(n,{onStop:async(s,d)=>fail(s,d),onSessionEnd:async(s,d)=>fail(s,d)});opened.push(s);active.add(s);monitors.push(s.onTick(stop));
  if(!await waitUntil(s,()=>stop()||!!state(s)?.player&&state(s).skills?.length===21,{timeoutTicks:20}))throw Error('Rune staging initial state unavailable');check();return s;};
 const close=async(s:Session,ok:boolean)=>{closing.add(s);logout=(await settle([s],ok,'finite Rune carrier staging'))&&logout;active.delete(s);};
 const xp=(s:Session)=>JSON.stringify(state(s).skills.map(i=>[i.name,i.experience]));
 const count=(items:readonly {id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const bankItems=(s:Session)=>{const b=s.bankObservation?.();if(!b)throw Error('Rune staging bank unobserved');return b.items;};
 const travel=async(s:Session,x:number,z:number)=>{check();const r=await goTo(s,await getWorld(),{x,z,level:0},accountOf(s),{legTimeoutTicks:180,signal:cancel.signal});check();if(!r.ok)throw Error('Rune staging travel '+JSON.stringify(r));};
 const bank=async(s:Session)=>{
  check();if(inside(s))await leaveBody(s);await travel(s,3094,3491);
  if(state(s).bank.isOpen){await s.bot.closeBank();check();}
  const generation=s.bankObservation?.()?.generation??0;
  if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>stop()||state(s).bank.isOpen&&(s.bankObservation?.()?.generation??0)>generation,{timeoutTicks:20}))throw Error('Rune staging fresh bank unavailable');check();
 };
 const deposit=async(s:Session)=>{for(const id of new Set(s.sdk.getInventory().map(i=>i.id))){check();const item=s.sdk.getInventory().find(i=>i.id===id);if(item)await depositObserved(s,item);check();}};
 const withdraw=async(s:Session,id:number,n:number)=>{
  check();const before=count(bankItems(s),id),held=count(s.sdk.getInventory(),id),item=state(s).bank.items.find(i=>i.id===id);
  if(!item||before<n)throw Error('Rune staging shortage '+id);
  if(!(await s.bot.withdrawItem(item,n,{asNote:false})).success||!await waitUntil(s,()=>stop()||count(s.sdk.getInventory(),id)===held+n&&count(bankItems(s),id)===before-n,{timeoutTicks:15}))throw Error('Rune staging withdrawal did not reconcile '+id);check();
 };
 const record=(s:Session,extra:object)=>{const p=state(s).player!;const row={name:s.name,tick:s.tick(),position:{x:p.worldX,z:p.worldZ,level:p.level},inventory:runeSupplyAssets(s.sdk.getInventory()),bank:bankItems(s),...extra};rows.push(row);console.log('RUNE_CARRIER_STAGE '+JSON.stringify(row));};
 try{
  await getWorld();check();
  if(mode==='opening'){
   const s=await open(names[0]!),beforeXp=xp(s);await bank(s);await deposit(s);
   if(count(bankItems(s),1436)<432||count(bankItems(s),1446)<2||count(bankItems(s),1438)<1)throw Error('opening donor reserve needs432 essence,2 body talismans and1 air talisman');
   await withdraw(s,1436,27);await withdraw(s,1438,1);await s.bot.closeBank();check();await travel(s,3222,3223);assertRuneDonor(state(s).player,s.sdk.getInventory());
   if(xp(s)!==beforeXp)throw Error('Rune staging changed donor XP');record(s,{role:'opening',receivedEssence:0,receivedTalismans:0});await close(s,true);
  }else{
   const prepared:Promise<{s:Session;beforeXp:string;shortfall:ReturnType<typeof runeCarrierShortfall>;beforeEssence:number;beforeTalismans:number}>[]=[];
   for(const name of names.slice(1)){
    const s=await open(name),beforeXp=xp(s);
    const flight=(async()=>{await leaveRuneStarter(s,stop);check();await bank(s);await deposit(s);const items=bankItems(s),beforeEssence=count(items,1436),beforeTalismans=count(items,1446),shortfall=runeCarrierShortfall(items);await s.bot.closeBank();check();return {s,beforeXp,shortfall,beforeEssence,beforeTalismans};})();
    prepared.push(flight);flights.push(flight.catch(e=>{failure=e;stop();}));
   }
   const receivers=await Promise.all(prepared);check();
   const needs=receivers.filter(r=>r.shortfall.essence||r.shortfall.talismans);
   let source:Session|undefined,sourceXp='',sourceEssence=0,sourceTalismans=0;
   if(needs.length){
    source=await open(names[0]!);sourceXp=xp(source);await bank(source);await deposit(source);sourceEssence=count(bankItems(source),1436);sourceTalismans=count(bankItems(source),1446);
    if(sourceEssence<432+needs.reduce((n,r)=>n+r.shortfall.essence,0)||sourceTalismans<2+needs.reduce((n,r)=>n+r.shortfall.talismans,0)||count(bankItems(source),1438)<1)throw Error('Rune staging supplier lacks kits plus opening reserve');
   }
   for(const r of receivers){
    check();const {s,shortfall}=r;
    if(shortfall.essence||shortfall.talismans){
     const giver=source!,e0=count(bankItems(giver),1436),t0=count(bankItems(giver),1446);
     const want=[...(shortfall.essence?[{name:'Rune essence',count:shortfall.essence}]:[]),...(shortfall.talismans?[{name:'Body talisman',count:shortfall.talismans}]:[])];
     await preparePayout(giver,want,true);check();
     if(!await waitUntil(giver,()=>stop()||count(bankItems(giver),1436)===e0-shortfall.essence&&count(bankItems(giver),1446)===t0-shortfall.talismans,{timeoutTicks:15}))throw Error('Rune staging supplier bank debit mismatch');check();
     const pack=giver.sdk.getInventory();
     if(pack.some(i=>![1437,1446,1447].includes(i.id))||count(pack,1437)!==shortfall.essence||count(pack,1446)+count(pack,1447)!==shortfall.talismans)throw Error('Rune staging payout pack mismatch');
     await ownedSwap(giver,s,runeSupplyAssets(pack),{},stop);check();receivedEssence+=shortfall.essence;receivedTalismans+=shortfall.talismans;
    }
    const ready=(async()=>{
     await bank(s);await deposit(s);
     if(count(bankItems(s),1436)!==r.beforeEssence+shortfall.essence||count(bankItems(s),1446)!==r.beforeTalismans+shortfall.talismans)throw Error('Rune staging receiver bank credit mismatch');
     await withdraw(s,1446,1);await withdraw(s,1436,27);await s.bot.closeBank();check();await enterBody(s);check();
     if(!inside(s)||count(s.sdk.getInventory(),1436)!==27||count(s.sdk.getInventory(),1446)!==1||count(bankItems(s),1436)<378||xp(s)!==r.beforeXp)throw Error('Rune carrier readiness unobserved');
     record(s,{role:'carrier',receivedEssence:shortfall.essence,receivedTalismans:shortfall.talismans});await close(s,true);
    })();flights.push(ready.catch(e=>{failure=e;stop();}));
   }
   if(source){
    await bank(source);
    if(count(bankItems(source),1436)!==sourceEssence-receivedEssence||count(bankItems(source),1446)!==sourceTalismans-receivedTalismans||source.sdk.getInventory().length||xp(source)!==sourceXp)throw Error('Rune staging supplier final reconciliation failed');
    record(source,{role:'supplier',debitedEssence:receivedEssence,debitedTalismans:receivedTalismans});await source.bot.closeBank();await close(source,true);
   }
   await Promise.all(flights);check();
  }
  done=true;console.log('RUNE_CARRIER_STAGE_RESULT '+JSON.stringify({ok:logout,mode,names,receivedEssence,receivedTalismans,rows,logout}));process.exitCode=logout?0:1;
 }catch(error){
  failure=error;cancel.abort(error);stopCarriers();await Promise.allSettled(flights);done=true;
  for(const s of [...active])await close(s,false);
  console.log('RUNE_CARRIER_STAGE_RESULT '+JSON.stringify({ok:false,mode,names,failure:String(error),rows,logout}));process.exitCode=1;
 }finally{monitors.forEach(off=>off());release();}
}
