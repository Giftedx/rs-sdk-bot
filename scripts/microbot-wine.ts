// Finite ordinary wine production. Uses the same native fermenting timer as cook-wine.
import type {Session} from '../packages/core/src/inprocess';
import {openBot,finish} from '../packages/core/src/bot';
import {waitUntil} from '../packages/core/src/ticks';
import {inventoryRecipes,runInventoryBank} from './microbot-production';
export function wineOutcome(before:{good:number;bad:number},after:{good:number;bad:number;raw:number},made:number){
 const good=after.good-before.good,bad=after.bad-before.bad;
 return{ok:after.raw===0&&good>=0&&bad>=0&&good+bad===made&&good>0,good,bad};
}
export async function runMixedWine(s:Session,maximum:number,cap:number,stop:()=>boolean=()=>false,reserve=0){
 if(!Number.isSafeInteger(reserve)||reserve<0)throw Error('invalid wine reserve');
 if(!Number.isSafeInteger(maximum)||maximum<1||!Number.isSafeInteger(cap)||cap<35)throw Error('wine requires positive count and at least 35 ticks');
 let ended=false;void s.ended.then(()=>{ended=true;});
 const initial=s.sdk.getState()?.player;const stopped=()=>{const p=s.sdk.getState()?.player;return ended||stop()||!initial||!p||p.isDead||p.lifeId!==initial.lifeId;};
 const start=s.tick(),count=(id:number)=>s.sdk.getInventory().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const bank=(id:number)=>s.bankObservation?.()?.items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0)??NaN;
 const openFresh=async()=>{
  if(stopped())throw Error('wine session stopped');
  const state=()=>s.sdk.getState();
  if(state()?.interface?.isOpen||state()?.dialog?.isOpen){await s.direct({type:'closeModal',reason:'wine fresh bank audit'});
   if(!await waitUntil(s,()=>!state()?.interface?.isOpen&&!state()?.dialog?.isOpen,{timeoutTicks:8}))throw Error('wine blocking interface remains');}
  const generation=s.bankObservation?.()?.generation??-1;
  if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!state()?.bank?.isOpen&&(s.bankObservation?.()?.generation??-1)>generation,{timeoutTicks:10}))throw Error('wine fresh bank unavailable');
 };
 await openFresh();
 for(const input of inventoryRecipes().find(r=>r.name==='wine-unfermented')!.inputs)if(bank(input.id)+count(input.id)-maximum*input.units<reserve)throw Error('wine inputs short of order and reserve');
 if(bank(1995)||count(1995)||count(1993)||count(1991))throw Error('wine order requires no existing raw wine and finished pack wines banked');
 const before={good:bank(1993),bad:bank(1991)};
 await s.bot.closeBank();
 const productionTicks=cap-(s.tick()-start)-35;if(productionTicks<1)throw Error('wine budget leaves no production time after fermentation/audit reserve');
 const production=await runInventoryBank(s,inventoryRecipes().find(r=>r.name==='wine-unfermented')!,{maximum,cap:productionTicks,maxAttempts:maximum,reserve,stop:stopped});
 if(!production.ok)return{...production,good:0,bad:0};
 // Open modals delay normal timers. Let the final native 20-tick timer settle with the bank closed.
 const fermentUntil=s.tick()+22;
 await waitUntil(s,()=>stopped()||s.tick()>=fermentUntil,{timeoutTicks:22});
 if(stopped()||s.tick()-start>=cap) return{...production,ok:false,good:0,bad:0,failure:'wine stopped before fermentation audit'};
 await openFresh();
 if(!await waitUntil(s,()=>stopped()||bank(1995)===0,{timeoutTicks:8})||stopped()||s.tick()-start>=cap)throw Error('wine fermentation unfinished');
 const after={good:bank(1993),bad:bank(1991),raw:bank(1995)},outcome=wineOutcome(before,after,maximum);
 await s.bot.closeBank();
 return{...production,...outcome,ticks:s.tick()-start,failure:outcome.ok?'-':'wine output accounting or useful product failed'};
}
if(import.meta.main){
 const maximum=Number(process.env.MAX_MAKE??14),cap=Number(process.env.CAP??1000);
 if(!Number.isSafeInteger(maximum)||maximum<1||!Number.isSafeInteger(cap)||cap<35)throw Error('wine requires positive count and at least35 ticks');let stopped=false;
 const s=await openBot(process.argv[2]!,{onStop:async()=>{stopped=true;}});
 try{const result=await runMixedWine(s,maximum,cap,()=>stopped);await finish([s],result.ok,JSON.stringify(result));}
 catch(e){await finish([s],false,String(e));}
}
