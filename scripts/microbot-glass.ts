// Native furnace glass subset of Microbot crafting/charter-crafting. BSD notice: research/microbot-ports-LICENSE.txt.
import type {Session} from '../packages/core/src/inprocess';
import {openBot,finish} from '../packages/core/src/bot';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {productionEffect,type InventoryRecipe,type ProductionSnapshot} from './microbot-production';
import {watchProductionLife} from './microbot-c-lifetime';
export const furnaceGlassRecipe:InventoryRecipe={name:'furnace-glass',inputs:[{id:1783,units:1},{id:1781,units:1}],tools:[],product:1775,byproducts:[{id:1925,units:1}],skill:'Crafting',level:1,xp:true,members:true,source:'vendor/rs-sdk/server/content/scripts/skill_crafting/scripts/glass/glass.rs2'};
export async function runFurnaceGlass(s:Session,maximum:number,cap:number,stop:()=>boolean=()=>false){
 if(!Number.isSafeInteger(maximum)||maximum<1||!Number.isSafeInteger(cap)||cap<1)throw Error('invalid glass order');
 const life=watchProductionLife(s,stop),start=s.tick(),over=()=>life.stopped()||s.tick()-start>=cap;
 const read=():ProductionSnapshot=>{const items:Record<number,number>={};for(const i of s.sdk.getInventory())items[i.id]=(items[i.id]??0)+i.count;return{items,xp:s.sdk.getSkillXp('Crafting')??0};};
 let made=0,failure='';
 try{
  const initial=read();if(furnaceGlassRecipe.inputs.some(i=>(initial.items[i.id]??0)<maximum))throw Error('glass supplies not staged');
  while(made<maximum&&!over()){
   const p=s.sdk.getState()?.player,furnace=s.sdk.getState()?.nearbyLocs.find(l=>/^furnace$/i.test(l.name)&&l.reachable!==false&&l.distance<=3&&l.level===p?.level);
   if(!furnace)throw Error('stage beside observed native furnace');
   if(s.sdk.getDialog()?.isOpen||s.sdk.getState()?.interface?.isOpen)await s.direct({type:'closeModal',reason:'SDK'});
   const before=read(),sand=s.sdk.getInventory().find(i=>i.id===1783);if(!sand)throw Error('glass sand missing');
   await s.sdk.sendUseItemOnLoc(sand.slot,furnace.x,furnace.z,furnace.id);
   await waitUntil(s,()=>over()||productionEffect(furnaceGlassRecipe,before,read())!=='none',{timeoutTicks:Math.min(8,Math.max(1,cap-(s.tick()-start)))});
   if(productionEffect(furnaceGlassRecipe,before,read())!=='made')throw Error('glass ingredient/product/container/XP receipt failed');
   made++;if(made<maximum&&!over())await waitTicks(s,1);
  }
  if(made!==maximum||over())throw Error('glass target incomplete');
 }catch(e){failure=String(e);}
 return{ok:!failure,made,ticks:s.tick()-start,failure:failure||'-',output:'held molten glass and returned empty buckets; no bank claim'};
}
if(import.meta.main){
 let stopped=false;const maximum=Number(process.env.MAX_MAKE??1),cap=Number(process.env.CAP??200);
 if(process.env.MEMBERS!=='1')throw Error('furnace glass requires explicit MEMBERS=1 scope');
 const s=await openBot(process.argv[2]!,{onStop:async()=>{stopped=true;}});
 try{const result=await runFurnaceGlass(s,maximum,cap,()=>stopped);await finish([s],result.ok,JSON.stringify(result));}
 catch(e){await finish([s],false,String(e));}
}
