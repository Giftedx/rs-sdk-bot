// One earth order from ordinary shop restock. One owned seed per order; observe every tick.
import {existsSync} from 'node:fs';
import {openBot,settle,getWorld,accountOf,sessionDied} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {goTo} from '../packages/core/src/walk';
import {depositObserved} from '../packages/core/src/deposit';
import {PROFILES,maximumUnitCost,shopFinishOk} from './shop-buyer';

export function earthRefillAmount(shelf:number,missing:number){
 if(![shelf,missing].every(n=>Number.isSafeInteger(n)&&n>=0))throw Error('earth refill quantities unknown');
 return Math.min(1,missing);
}
export const earthSeedNeeded=(shelf:number,carried:number,seeded:boolean)=>Number.isSafeInteger(shelf)&&shelf>=0&&carried>=1&&!seeded;
export const earthRefillStop=(idle:number,affordable:boolean):'budget'|'stock-wait'|undefined=>!affordable?'budget':idle>=25?'stock-wait':undefined;

// The session exposes bankObservation only while the bank is open. The account has one mutation owner.
export function retainedEarthBank(read:()=>{items:readonly {id:number;count:number}[]}|null|undefined){
 let confirmed:{id:number;count:number}[]=[];
 return()=>{const live=read();if(live)confirmed=live.items.map(i=>({id:i.id,count:i.count}));return confirmed;};
}
export async function openEarthBankObserved(s:Session){
 const previous=s.bankObservation?.();
 if(s.sdk.getState()?.bank.isOpen&&previous)return;
 const generation=previous?.generation??0;
 if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!s.sdk.getState()?.bank.isOpen&&(s.bankObservation?.()?.generation??0)>generation,{timeoutTicks:15}))throw Error('earth refill bank unobserved');
}

export async function sellEarthSeedObserved(s:Session,stop:()=>boolean){
 const count=(id:number)=>s.sdk.getInventory().filter(i=>i.id===id).reduce((v,i)=>v+i.count,0);
 const earth=count(557),coins=count(995);if(earth<1)throw Error('earth seed is not owned');
 await s.bot.sellToShop(/^earth rune$/i,1);
 const paired=()=>count(557)===earth-1&&count(995)>coins;
 if(!await waitUntil(s,()=>stop()||paired(),{timeoutTicks:10})||stop()||!paired())
  throw Error('earth seed debit/positive credit unobserved; zero-price sale remains unresolved');
 return count(995)-coins;
}

// Item and coin packets need not arrive in the same publication. Price the observed paired change.
export async function buyEarthObserved(s:Session,n:number,reserve:number,remaining:number,stop:()=>boolean){
 if(n!==1)throw Error('earth settlement requires one purchase packet');
 const count=(id:number)=>s.sdk.getInventory().filter(i=>i.id===id).reduce((v,i)=>v+i.count,0);
 const coins=count(995),earth=count(557);
 const state=s.sdk.getState(),item=state?.shop.shopItems.find(i=>i.id===557);
 if(!state?.shop.isOpen||!item||!Number.isSafeInteger(item.slot))throw Error('earth purchase slot unobserved');
 const unit=maximumUnitCost(item,state.shop.shopConfig);
 if(Math.min(coins-reserve,remaining)<unit)throw Error('earth purchase worst-price funding unavailable');
 const messageAfter=Math.max(0,...(state.gameMessages??[]).map(m=>m.observationId??0));
 const refused=()=>(s.sdk.getState()?.gameMessages??[]).some(m=>Number.isSafeInteger(m.observationId)&&(m.observationId??0)>messageAfter&&/^The shop has run out of stock\.$/i.test(m.text));
 const paired=()=>count(557)===earth+1&&count(995)<coins;
 // The public packet API checks the open shop and slot. The server owns its current stock check.
 if(!(await s.sdk.sendShopBuy(item.slot,1)).success)throw Error('earth purchase dispatch refused');
 if(!await waitUntil(s,()=>stop()||paired()||refused(),{timeoutTicks:6}))throw Error('earth purchase unacknowledged; retain unresolved intent');
 if(stop())throw Error('earth purchase stopped before settlement');
 const bought=count(557)-earth,spent=coins-count(995);
 if(!Number.isSafeInteger(bought)||bought<0||bought>n||!Number.isSafeInteger(spent)||spent<0||spent>Math.min(unit,remaining)||count(995)<reserve
  ||bought===0&&spent!==0||bought>0&&spent<bought)throw Error('earth purchase paired accounting unresolved');
 return{bought,spent};
}

export async function runEarthRefill(s:Session,o:{profile:string;cap:number;target:number;maximum:number;spend:number;reserve:number;seedUsed:number;stop:()=>boolean}){
 const conf=PROFILES[o.profile];
 if(!['aubury','betty'].includes(o.profile)||!conf||![o.cap,o.target,o.maximum,o.spend,o.reserve].every(n=>Number.isSafeInteger(n)&&n>=0)||![0,1].includes(o.seedUsed)||o.cap<1||o.cap>16000||o.target<1)throw Error('invalid earth refill bounds');
 const start=s.tick(),st=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),pos=()=>st()?.player;
 if(!await waitUntil(s,()=>!!pos()&&(s.sdk.getSkill('Hitpoints')?.level??0)>6,{timeoutTicks:20}))throw Error('earth refill life unknown');
 const life=pos(),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
 let ended=false;void s.ended.then(()=>{ended=true;});
 const terminal=()=>ended||sessionDied(life,pos())||hp()<=6;
 const stopped=()=>o.stop()||existsSync(`.practice/stop-${s.name}`);
 const over=()=>terminal()||stopped()||s.tick()-start>=o.cap;
 const held=(id:number)=>inv().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const bankItems=retainedEarthBank(()=>s.bankObservation?.());
 const banked=(id:number)=>bankItems().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const assets=()=>{const m=new Map<number,number>();for(const i of [...inv(),...s.sdk.getEquipment(),...bankItems()])m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
 const shelf=()=>st()?.shop.shopItems.find(i=>i.id===557)?.count;
 let boughtTotal=0,spentTotal=0,seeded=0,seedCredit=0,stockGrowth=false,stop='cap',failure='',uncertain=false;
 let initial:Map<number,number>|undefined,hpMin=hp(),lastProgress=start;
 const off=s.onTick(()=>{hpMin=Math.min(hpMin,hp());});
 const walk=async(to:{x:number;z:number},cleanup=false)=>{
  if(terminal()||!cleanup&&over())throw Error('earth refill stopped before travel');
  const abort=new AbortController(),cancel=()=>{if(terminal()||!cleanup&&over())abort.abort();};
  const off=s.onTick(cancel);let r;try{cancel();r=await goTo(s,await getWorld(),{...to,level:0},accountOf(s),{legTimeoutTicks:100,signal:abort.signal});}finally{off();}
  if(!r.ok||terminal()||!cleanup&&over())throw Error('earth refill route refused: '+JSON.stringify(r));
 };
 const openBank=()=>openEarthBankObserved(s);
 const bank=async(cleanup=false)=>{await s.bot.dismissBlockingUI();await walk(conf.bankSpot,cleanup);await openBank();
  for(const i of [...inv()])if(cleanup||i.id!==995)await depositObserved(s,i);
  bankItems();
 };
 const withdraw=async(id:number,n:number)=>{if(over())throw Error('earth refill stopped before withdrawal');if(!n)return;const item=st()?.bank.items.find(i=>i.id===id),before=held(id),stored=banked(id);
  if(!item||stored<n)throw Error('earth refill missing owned item '+id);
  await s.bot.withdrawItem(item,n);
  if(!await waitUntil(s,()=>held(id)===before+n&&banked(id)===stored-n,{timeoutTicks:10}))throw Error('earth refill withdrawal unobserved');
 };
 try{
  await bank();initial=assets();
  const missing=Math.max(0,o.target-(initial.get(557)??0));
  if(missing>o.maximum+o.seedUsed)throw Error('earth refill existing stock below authorized order');
  if(missing){
   const needed=Math.max(0,o.reserve+o.spend-held(995));await withdraw(995,Math.min(needed,banked(995)));
   if(held(995)<=o.reserve)throw Error('earth refill reserve unavailable');
   if(banked(557)>0)await withdraw(557,1);
   await s.bot.closeBank();await walk(conf.npcSpot);
   if(!(await s.bot.openShop(conf.npc)).success||!await waitUntil(s,()=>st()?.shop.isOpen===true&&shelf()!==undefined,{timeoutTicks:10}))throw Error('earth refill shop unobserved');
   console.log('EARTH_REFILL_SHELF '+JSON.stringify({tick:s.tick(),count:shelf(),carried:held(557)}));
   if(earthSeedNeeded(shelf()!,held(557),o.seedUsed===1)){
    uncertain=true;seedCredit=await sellEarthSeedObserved(s,over);
    seeded=1;uncertain=false;lastProgress=s.tick();
    console.log('EARTH_REFILL_SEED '+JSON.stringify({tick:s.tick(),seeded,seedCredit,count:shelf()}));
   }
   lastProgress=s.tick();let previous=shelf();
   while(!over()&&banked(557)+held(557)<o.target&&boughtTotal<o.maximum+o.seedUsed+seeded&&spentTotal<o.spend){
    const count=shelf();if(count===undefined)throw Error('earth shelf observation lost');
    if(previous!==count){console.log('EARTH_REFILL_STOCK '+JSON.stringify({tick:s.tick(),count,boughtTotal,spentTotal}));if(count>(previous??count))stockGrowth=true;previous=count;}
    const n=earthRefillAmount(count,Math.min(o.target-banked(557)-held(557),o.maximum+o.seedUsed+seeded-boughtTotal));
    if(n>0){
     const item=st()!.shop.shopItems.find(i=>i.id===557)!,unit=maximumUnitCost(item,st()!.shop.shopConfig);
     const unavailable=earthRefillStop(s.tick()-lastProgress,held(995)-o.reserve>=unit&&o.spend-spentTotal>=unit);
     if(unavailable){stop=unavailable;break;}
     uncertain=true;const result=await buyEarthObserved(s,n,o.reserve,o.spend-spentTotal,over);
     boughtTotal+=result.bought;spentTotal+=result.spent;uncertain=false;
     if(result.bought){lastProgress=s.tick();continue;}
     if(result.spent)throw Error('earth debit without observed runes');
     // Another buyer can consume the observed shelf before this packet arrives.
     // No debit is a funded race, not a reason to reset the progress clock.
    }
    if(s.tick()-lastProgress>=25){stop='stock-wait';break;}
    await waitTicks(s,1);
   }
  }
 }catch(error){failure=String(error);}
 finally{try{if(!terminal()){await bank(true);await s.bot.closeBank();}}catch(error){failure+='; '+String(error);}off();}
 const final=assets(),before=initial;
 const conserved=!!before&&(final.get(557)??0)===(before.get(557)??0)+boughtTotal-seeded
  &&(final.get(995)??0)===(before.get(995)??0)+seedCredit-spentTotal
  &&[...before].every(([id,n])=>[557,995].includes(id)||(final.get(id)??0)===n);
 const targetMet=banked(557)>=o.target&&held(557)===0,atBank=held(995)===0&&!!pos()&&pos()!.level===0&&Math.max(Math.abs(pos()!.worldX-conf.bankSpot.x),Math.abs(pos()!.worldZ-conf.bankSpot.z))<=4;
 if(uncertain||!conserved)throw Error('earth refill accounting unresolved; retain running intent: '+failure);
 const safeOffline=!failure&&!terminal()&&!stopped()&&atBank;
 return {ok:safeOffline&&targetMet,safeOffline,targetMet:targetMet?1:0,bank:atBank,conserved,boughtTotal,spentTotal,seeded,seedCredit,stockGrowth,hpMin,stop,target:o.target,finalEarth:final.get(557)??0,finalCoins:final.get(995)??0,ticks:s.tick()-start,failure:failure||'-'};
}
if(import.meta.main){
 let stopped=false;const s=await openBot(process.argv[2]!,{onStop:async()=>{stopped=true;}});
 try{const r=await runEarthRefill(s,{profile:process.argv[3]!,cap:Number(process.argv[4]),target:Number(process.env.STOCK_TARGET),maximum:Number(process.env.MAX_ITEMS),spend:Number(process.env.MAX_SPEND),reserve:Number(process.env.COIN_RESERVE),seedUsed:Number(process.env.EARTH_SEED_USED??0),stop:()=>stopped});
  const quiescent=r.safeOffline&&shopFinishOk(0,false,r.stop);
  console.log('EARTH_REFILL '+JSON.stringify(r));process.exitCode=await settle([s],r.ok||quiescent,Object.entries(r).map(([k,v])=>`${k}=${v}`).join(' '))?0:1;
 }catch(e){await settle([s],false,String(e));process.exitCode=1;}
}
