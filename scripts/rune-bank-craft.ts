// bun scripts/rune-bank-craft.ts <account> [target=99]. Craft banked rune essence into banked air runes.
// Reuse: rcair altar entry, craft and exit; walk.goTo; rune-supply observed bank withdraw. Falador East is
// the nearest bank to the air ruins (haggis-travel air-ruins: 78 tiles). Stops at the target level or when
// the bank holds no essence. Session cleanup stays with the CLI owner below.
import {existsSync} from 'node:fs';
import {openBot,finish,getWorld,accountOf,sessionDied} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {goTo} from '../packages/core/src/walk';
import {depositObserved} from '../packages/core/src/deposit';
import {craftAirRunes,enterAirAltar,exitAirAltar,insideAirAltar} from './generated/rcair';

export const ESSENCE=1436,AIR=556,TALISMAN=1438;
export const BANK={x:3013,z:3355,level:0},RUINS={x:2986,z:3294,level:0};
export function runeBankTarget(value=99){
 if(!Number.isSafeInteger(value)||value<2||value>99)throw Error('Runecraft target must be2..99');
 return value;
}
// Pack plus bank totals at entry and at the final bank. The final pack holds no essence or runes.
export type RuneBankLedger={essence0:number;essence:number;air0:number;air:number;consumed:number;crafted:number};
export function runeBankBalanced(l:RuneBankLedger){
 return l.essence0-l.essence===l.consumed&&l.air-l.air0===l.crafted&&l.crafted>=l.consumed;
}
export const runeBankDone=(level:number,target:number,bankEssence:number)=>level>=target||bankEssence===0;
export function runeBankOk(p:{ledger:RuneBankLedger|undefined;level0:number;level:number;target:number;bankEssence:number;held:{essence:number;air:number};stopped:boolean}){
 return !p.stopped&&!!p.ledger&&runeBankBalanced(p.ledger)&&p.held.essence===0&&p.held.air===0
  &&runeBankDone(p.level,p.target,p.bankEssence)&&(p.ledger.consumed>0||p.level0>=p.target);
}

export async function runRuneBankCraft(s:Session,target=99,options:{cap?:number;stop?:()=>boolean}={}){
 runeBankTarget(target);
 const cap=options.cap??20000;if(!Number.isSafeInteger(cap)||cap<1)throw Error('invalid rune bank craft tick cap');
 const start=s.tick(),state=()=>s.sdk.getState(),pos=()=>state()?.player,initialLife=pos();
 let ended=false,stage='entry';void s.ended.then(()=>{ended=true;});
 let stoppedFor:string|undefined;
 const stopReason=()=>stoppedFor ??= sessionDied(initialLife,pos())?'died':ended?'session-ended':options.stop?.()?'operator':existsSync(`.practice/stop-${s.name}`)?'stop-file':s.tick()-start>=cap?'tick-cap':undefined;
 const stop=()=>stopReason()!==undefined;
 const check=()=>{if(stop())throw Error(`rune bank craft stopped at ${stage}: ${stopReason()}`);};
 const inv=()=>s.sdk.getInventory(),count=(id:number)=>inv().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const bankCount=(id:number)=>(s.bankObservation?.()?.items??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const level=()=>s.sdk.getSkill('Runecraft')?.baseLevel??0,xp=()=>s.sdk.getSkillXp('Runecraft')??0;
 let ledger:RuneBankLedger|undefined,consumed=0,crafted=0,trips=0,level0=0,xp0=0;
 const action=async<T>(name:string,work:()=>Promise<T>):Promise<T>=>{
  const record=(phase:string)=>console.log('RUNE_BANK_ACTION '+JSON.stringify({tick:s.tick(),stage,action:name,phase,
   position:pos()?{x:pos()!.worldX,z:pos()!.worldZ,level:pos()!.level}:null,essence:count(ESSENCE),air:count(AIR),
   bankEssence:bankCount(ESSENCE),bankAir:bankCount(AIR),runecraftXp:xp()}));
  record('start');try{const r=await work();record('end');return r;}catch(error){record('error');throw error;}
 };
 const travel=async(to:typeof BANK)=>{check();
  const r=await action(`walk:${to.x},${to.z}`,async()=>goTo(s,await getWorld(),to,accountOf(s)));
  if(!r.ok)throw Error(`route refusal ${stage}: ${JSON.stringify(r)}`);check();
 };
 const open=async()=>{check();const generation=s.bankObservation?.()?.generation??0;
  if(!(await action('open-bank',()=>s.bot.openBank())).success||!await waitUntil(s,()=>!!state()?.bank.isOpen&&(s.bankObservation?.()?.generation??0)>generation,{timeoutTicks:15}))
   throw Error(`bank observation unavailable at ${stage}`);
 };
 const close=()=>action('close-bank',()=>s.bot.closeBank());
 const withdraw=async(id:number,n:number)=>{
  const item=state()?.bank.items.find(i=>i.id===id),stored=bankCount(id),held=count(id),generation=s.bankObservation?.()?.generation??0;
  if(!item||stored<n)throw Error(`next acquisition: item${id} needs${n}, bank has${stored}`);
  await action(`withdraw:${id}:${n}`,()=>s.bot.withdrawItem(item,n));
  if(!await waitUntil(s,()=>count(id)===held+n&&bankCount(id)===stored-n&&(s.bankObservation?.()?.generation??0)>generation,{timeoutTicks:10}))
   throw Error(`withdraw debit/credit unobserved item${id}`);
 };
 // Bank every pack item except the talisman, so a trip carries the most essence.
 const secure=async()=>{for(const id of new Set(inv().map(i=>i.id))){
  const item=inv().find(i=>i.id===id);if(id!==TALISMAN&&item)await action(`deposit:${id}`,()=>depositObserved(s,item));
 }};
 const craft=async()=>{const r=await action('craft-air',()=>craftAirRunes(s,stop));consumed+=r.consumed;crafted+=r.runes;return r;};
 const summary=()=>({target,stage,trips,consumed,crafted,ledger,level0,level:level(),xp:xp()-xp0,
  held:{essence:count(ESSENCE),air:count(AIR)},ticks:s.tick()-start,position:pos()});
 try{
  if(!await waitUntil(s,()=>!!pos()&&level()>0&&Array.isArray(state()?.inventory),{timeoutTicks:30}))throw Error('entry position, skills or pack unobserved');
  level0=level();xp0=xp();
  const held0={essence:count(ESSENCE),air:count(AIR)};
  // Resume an interrupted trip from its observed position. The bank is unchanged by crafting.
  if(insideAirAltar(pos())){
   stage='altar-resume';if(count(ESSENCE)>0)await craft();
   await action('exit-air',()=>exitAirAltar(s,stop));
  }
  let bankEssence=NaN;
  while(true){
   check();stage='bank';await travel(BANK);await open();
   ledger??={essence0:held0.essence+bankCount(ESSENCE),essence:0,air0:held0.air+bankCount(AIR),air:0,consumed:0,crafted:0};
   await secure();bankEssence=bankCount(ESSENCE);
   if(runeBankDone(level(),target,bankEssence))break;
   if(count(TALISMAN)<1)await withdraw(TALISMAN,1);
   const n=Math.min(bankEssence,28-inv().length);if(n<1)throw Error('next acquisition: free pack slots for rune essence');
   await withdraw(ESSENCE,n);await close();
   stage='altar';await travel(RUINS);await action('enter-air',()=>enterAirAltar(s));
   check();await craft();await action('exit-air',()=>exitAirAltar(s,stop));trips++;
   console.log('RUNE_BANK_PROGRESS '+JSON.stringify({at:new Date().toISOString(),target,trips,level:level(),consumed,crafted}));
  }
  stage='final';
  Object.assign(ledger,{essence:bankCount(ESSENCE)+count(ESSENCE),air:bankCount(AIR)+count(AIR),consumed,crafted});
  const result=summary();await close();
  const ok=runeBankOk({ledger,level0,level:result.level,target,bankEssence,held:result.held,stopped:stop()});
  return {ok,...result,bankEssence};
 }catch(error){return {ok:false,...summary(),stopReason:stopReason(),failure:String(error)};}
}

if(import.meta.main){
 const target=runeBankTarget(Number(process.argv[3]??99));
 if(!process.argv[2])throw Error('account argument required');
 let stopped=false;const s=await openBot(process.argv[2],{onStop:async()=>{stopped=true;}});
 try{
  const r=await runRuneBankCraft(s,target,{cap:Number(process.env.CAP??20000),stop:()=>stopped});
  console.log('RUNE_BANK_CRAFT_RESULT '+JSON.stringify(r));
  await finish([s],r.ok,`runecraft=${r.level} trips=${r.trips} consumed=${r.consumed} crafted=${r.crafted}${'failure' in r?' '+r.failure:''}`);
 }catch(error){await finish([s],false,String(error));}
}
