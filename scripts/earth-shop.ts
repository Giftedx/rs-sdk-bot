// One earth order from ordinary shop restock. One owned seed at most; retain one shelf rune.
import {existsSync} from 'node:fs';
import {openBot,settle,getWorld,accountOf,sessionDied} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {goTo} from '../packages/core/src/walk';
import {depositObserved} from '../packages/core/src/deposit';
import {PROFILES,buyWithBudget} from './shop-buyer';

export function earthRefillAmount(shelf:number,missing:number){
 if(![shelf,missing].every(n=>Number.isSafeInteger(n)&&n>=0))throw Error('earth refill quantities unknown');
 return Math.min(50,Math.max(0,shelf-1),missing);
}
export const earthSeedNeeded=(shelf:number,carried:number,seeded:boolean)=>Number.isSafeInteger(shelf)&&shelf>=0&&carried>=1&&!seeded;

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
 const banked=(id:number)=>(s.bankObservation?.()?.items??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const assets=()=>{const m=new Map<number,number>();for(const i of [...inv(),...s.sdk.getEquipment(),...(s.bankObservation?.()?.items??[])])m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
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
 const openBank=async()=>{const generation=s.bankObservation?.()?.generation??0;
  if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!st()?.bank.isOpen&&(s.bankObservation?.()?.generation??0)>generation,{timeoutTicks:15}))throw Error('earth refill bank unobserved');
 };
 const bank=async(cleanup=false)=>{await s.bot.dismissBlockingUI();await walk(conf.bankSpot,cleanup);await openBank();
  for(const i of [...inv()])if(cleanup||i.id!==995)await depositObserved(s,i);
 };
 const withdraw=async(id:number,n:number)=>{if(!n)return;const item=st()?.bank.items.find(i=>i.id===id),before=held(id),stored=banked(id);
  if(!item||stored<n)throw Error('earth refill missing owned item '+id);
  await s.bot.withdrawItem(item,n);
  if(!await waitUntil(s,()=>held(id)===before+n&&banked(id)===stored-n,{timeoutTicks:10}))throw Error('earth refill withdrawal unobserved');
 };
 try{
  await bank();initial=assets();
  const missing=Math.max(0,o.target-(initial.get(557)??0));
  if(missing>o.maximum)throw Error('earth refill existing stock below authorized order');
  if(missing){
   const needed=Math.max(0,o.reserve+o.spend-held(995));await withdraw(995,Math.min(needed,banked(995)));
   if(held(995)<=o.reserve)throw Error('earth refill reserve unavailable');
   if(banked(557)>0)await withdraw(557,1);
   await s.bot.closeBank();await walk(conf.npcSpot);
   if(!(await s.bot.openShop(conf.npc)).success||!await waitUntil(s,()=>st()?.shop.isOpen===true&&shelf()!==undefined,{timeoutTicks:10}))throw Error('earth refill shop unobserved');
   console.log('EARTH_REFILL_SHELF '+JSON.stringify({tick:s.tick(),count:shelf(),carried:held(557)}));
   if(earthSeedNeeded(shelf()!,held(557),o.seedUsed===1)){
    const earth=held(557),coins=held(995);uncertain=true;
    await s.bot.sellToShop(/^earth rune$/i,1);
    if(!await waitUntil(s,()=>held(557)===earth-1&&held(995)>=coins,{timeoutTicks:10}))throw Error('earth seed debit/credit unobserved');
    await waitTicks(s,1);
    seeded=1;seedCredit=held(995)-coins;uncertain=false;lastProgress=s.tick();
    console.log('EARTH_REFILL_SEED '+JSON.stringify({tick:s.tick(),seeded,seedCredit,count:shelf()}));
   }
   lastProgress=s.tick();let previous=shelf();
   while(!over()&&banked(557)+held(557)<o.target&&boughtTotal<o.maximum+seeded&&spentTotal<o.spend){
    const count=shelf();if(count===undefined)throw Error('earth shelf observation lost');
    if(previous!==count){console.log('EARTH_REFILL_STOCK '+JSON.stringify({tick:s.tick(),count,boughtTotal,spentTotal}));if(count>(previous??count)){stockGrowth=true;lastProgress=s.tick();}previous=count;}
    const n=earthRefillAmount(count,Math.min(o.target-banked(557)-held(557),o.maximum+seeded-boughtTotal));
    if(n>0){
     uncertain=true;const result=await buyWithBudget(s.bot,s.sdk,'Earth rune',n,o.reserve,o.spend-spentTotal);
     boughtTotal+=result.bought;spentTotal+=result.spent;uncertain=false;
     if(result.bought){lastProgress=s.tick();if(shelf()===0){stop='shelf-drained';break;}continue;}
     if(result.spent)throw Error('earth debit without observed runes');
     stop='budget';break;
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
 return {ok:!failure&&!terminal()&&!stopped()&&atBank&&targetMet,targetMet:targetMet?1:0,bank:atBank,conserved,boughtTotal,spentTotal,seeded,seedCredit,stockGrowth,hpMin,stop,target:o.target,finalEarth:final.get(557)??0,finalCoins:final.get(995)??0,ticks:s.tick()-start,failure:failure||'-'};
}
if(import.meta.main){
 let stopped=false;const s=await openBot(process.argv[2]!,{onStop:async()=>{stopped=true;}});
 try{const r=await runEarthRefill(s,{profile:process.argv[3]!,cap:Number(process.argv[4]),target:Number(process.env.STOCK_TARGET),maximum:Number(process.env.MAX_ITEMS),spend:Number(process.env.MAX_SPEND),reserve:Number(process.env.COIN_RESERVE),seedUsed:Number(process.env.EARTH_SEED_USED??0),stop:()=>stopped});
  console.log('EARTH_REFILL '+JSON.stringify(r));process.exitCode=await settle([s],r.ok,Object.entries(r).map(([k,v])=>`${k}=${v}`).join(' '))?0:1;
 }catch(e){await settle([s],false,String(e));process.exitCode=1;}
}
