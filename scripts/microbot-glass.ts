// Native furnace glass subset of Microbot crafting/charter-crafting. BSD notice: research/microbot-ports-LICENSE.txt.
import type {Session} from '../packages/core/src/inprocess';
import {openBot,finish,getWorld} from '../packages/core/src/bot';
import {existsSync} from 'node:fs';
import {gatherItems} from '../packages/core/src/gather';
import {walkPath,sessionWalker} from '../packages/core/src/walk';
import {sail,disembark} from '../packages/core/src/boat';
import {executionContext,abortable} from '../vendor/rs-sdk/sdk/execution-context';
import {cookingRecipes,runCookingBatch} from './microbot-b-cooking';
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
// SUPPLY_MODE=1: MAX_MAKE is the bank target (1..10), not an extra batch.
// MAX_SPEND (default 0) caps coin debit; CASH_RESERVE (default 0) is protected.
// CAP (default 4000 in supply mode) bounds all work in ticks. MEMBERS=1 is required.
// No shop stocks sand/ash/seaweed in knowledge/shops.json. Reuse owned inputs first.
// Source -> consumer -> adapt -> check: glass.rs2 sand_fill/smelt_glass -> supply
// order -> empty bucket on sandpit2645 -> exact bucket/sand/glass/XP deltas.
// cooking_generic.dbrow cooking_generic_seaweed -> runCookingBatch -> seaweed401
// to ash1781, no XP -> exact conversion. Map m43_52 (seaweed coast),
// m44_52 (sandpit2816,3341, range2822,3351, furnace2833,3351), m47_51
// (bucket3026,3289) -> gatherItems/walkPath -> observed arrival and item credit.
// shipmonk/shipmonk2 scripts -> sail/disembark -> free Entrana passage, pack
// and equipment banked first. No paid transport or shop action is used.
export type GlassStock=Record<number,number>;
export type GlassSupplyOptions={maximum:number;cap:number;maxSpend:number;cashReserve:number;members:boolean};
export const GLASS_BANK={x:3185,z:3436},GLASS_RETURN_BANK={x:3092,z:3243};
export function glassSupplyOptions(env:Record<string,string|undefined>):GlassSupplyOptions{
 const o={maximum:Number(env.MAX_MAKE??1),cap:Number(env.CAP??4000),maxSpend:Number(env.MAX_SPEND??0),cashReserve:Number(env.CASH_RESERVE??0),members:env.MEMBERS==='1'};
 if(!Number.isSafeInteger(o.maximum)||o.maximum<1||o.maximum>10||!Number.isSafeInteger(o.cap)||o.cap<1||![o.maxSpend,o.cashReserve].every(n=>Number.isSafeInteger(n)&&n>=0))throw Error('invalid glass supply bounds');
 return o;
}
export function planGlassSupply(stock:GlassStock,maximum:number){
 if(!Number.isSafeInteger(maximum)||maximum<1||maximum>10)throw Error('invalid glass supply target');
 const make=Math.max(0,maximum-(stock[1775]??0)),sand=Math.min(make,stock[1783]??0),ash=Math.min(make,stock[1781]??0),cook=make-ash;
 return{make,sand,ash,fill:make-sand,cook,seaweed:Math.min(cook,stock[401]??0),gatherSeaweed:Math.max(0,cook-(stock[401]??0)),gatherBucket:make>sand&&sand===0&&(stock[1925]??0)<1?1:0};
}
export function glassSupplyLedger(before:GlassStock,after:GlassStock,r:{made:number;filled:number;cooked:number;seaweed:number;buckets:number;spent:number},o:GlassSupplyOptions){
 const delta:GlassStock={1775:r.made,1783:r.filled-r.made,1781:r.cooked-r.made,401:r.seaweed-r.cooked,1925:r.buckets+r.made-r.filled,995:-r.spent};
 return Number.isSafeInteger(r.spent)&&r.spent===0&&r.spent<=o.maxSpend&&(after[995]??0)>=Math.min(o.cashReserve,before[995]??0)
  &&[...new Set([...Object.keys(before),...Object.keys(after),...Object.keys(delta)])].every(k=>(after[+k]??0)-(before[+k]??0)===(delta[+k]??0));
}
// The adapter owns actions, not the session. The CLI remains the only cleanup owner.
export interface GlassSupplyIO{
 tick():number;check():void;bank():Promise<GlassStock>;take(id:number,n:number):Promise<void>;close():Promise<void>;
 gather(id:number,n:number):Promise<void>;island():Promise<void>;fill():Promise<void>;cook(n:number):Promise<void>;smelt(n:number):Promise<number>;returnBank():Promise<void>;
}
export async function runGlassSupply(d:GlassSupplyIO,o:GlassSupplyOptions){
 const start=d.tick();let made=0,filled=0,cooked=0,seaweed=0,buckets=0,banked=0,conserved=false,failure='';
 const check=()=>{d.check();if(d.tick()-start>=o.cap)throw Error('glass supply CAP reached');};
 try{
  if(!o.members)throw Error('glass supply refused: MEMBERS=1 required');
  check();const before=await d.bank(),p=planGlassSupply(before,o.maximum);check();
  console.log('GLASS_SUPPLY_PLAN '+JSON.stringify({target:o.maximum,...p,spent:0,maxSpend:o.maxSpend,cashReserve:o.cashReserve}));
  if(p.make){
   await d.take(1783,p.sand);await d.take(1781,p.ash);await d.take(401,p.seaweed);
   if(p.fill&&p.sand===0&&!p.gatherBucket)await d.take(1925,1);
   await d.close();check();
   if(p.gatherBucket){await d.gather(1925,1);buckets=1;check();}
   await d.island();check();
   if(p.gatherSeaweed){await d.gather(401,p.gatherSeaweed);seaweed=p.gatherSeaweed;check();}
   if(p.cook){await d.cook(p.cook);cooked=p.cook;check();}
   // A single bucket is reused after every smelt. No extra buckets or sand are gathered.
   for(let i=0;i<p.make;i++){
    check();if(i>=p.sand){await d.fill();filled++;check();}
    if(await d.smelt(1)!==1)throw Error('glass supply furnace shortfall');made++;check();
   }
   await d.returnBank();check();
  }
  const after=await d.bank();check();banked=after[1775]??0;
  conserved=glassSupplyLedger(before,after,{made,filled,cooked,seaweed,buckets,spent:0},o);
  if(!conserved)throw Error('glass supply assets/costs/buckets do not reconcile');
  if(banked<o.maximum||made!==p.make)throw Error('glass supply bank target unobserved');
  await d.close();check();
 }catch(e){failure=String(e);}
 return{ok:!failure,target:o.maximum,made,filled,cooked,seaweed,buckets,spent:0,banked,conserved,ticks:d.tick()-start,failure:failure||'-',output:'banked molten glass for finite named consumer'};
}
export async function runBankedGlass(s:Session,o:GlassSupplyOptions,stop:()=>boolean=()=>false){
 const start=s.tick(),life=watchProductionLife(s,stop),ac=new AbortController(),parent=executionContext.getStore();
 const check=()=>{const why=life.reason();if(why)throw Error('glass supply '+why);if(s.tick()-start>=o.cap)throw Error('glass supply CAP reached');ac.signal.throwIfAborted();};
 const guard=()=>{try{check();}catch(e){ac.abort(e);}},off=s.onTick(guard),cancel=()=>ac.abort(parent?.signal.reason);
 parent?.signal.addEventListener('abort',cancel,{once:true});if(parent?.signal.aborted)cancel();
 const inv=()=>s.sdk.getInventory(),held=(id:number)=>inv().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const wait=async(test:()=>boolean,n=12)=>{check();if(!await waitUntil(s,test,{timeoutTicks:Math.min(n,o.cap-(s.tick()-start)),signal:ac.signal}))throw Error('glass supply effect deadline');check();};
 const close=async()=>{check();await s.sdk.sendCloseModal();await wait(()=>!s.sdk.getState()?.bank.isOpen&&!s.sdk.getState()?.interface?.isOpen&&!s.sdk.getDialog()?.isOpen);};
 const walk=async(to:{x:number;z:number;level?:number})=>{
  check();if(to.level&&to.level!==s.sdk.getState()?.player?.level)throw Error('glass supply walk floor');
  const r=await walkPath(await sessionWalker(s),[{x:to.x,z:to.z,tol:1}],{maxTicks:Math.min(700,o.cap-(s.tick()-start)),stop:()=>ac.signal.aborted});check();
  const p=s.sdk.getState()?.player;if(!r.ok||!p||p.level!==0||Math.max(Math.abs(p.worldX-to.x),Math.abs(p.worldZ-to.z))>1)throw Error('glass supply travel failed '+JSON.stringify({to,r}));
  console.log('GLASS_SUPPLY_ARRIVE '+JSON.stringify(to));return{ok:true};
 };
 const deposit=async()=>{
  for(let tries=0;inv().length&&tries<60;tries++){
   check();const item=inv()[0]!,n=held(item.id),b=s.sdk.getBankItems().filter(i=>i.id===item.id).reduce((v,i)=>v+i.count,0);
   await s.bot.depositItem(item,-1);await wait(()=>held(item.id)===0&&s.sdk.getBankItems().filter(i=>i.id===item.id).reduce((v,i)=>v+i.count,0)===b+n);
  }if(inv().length)throw Error('glass supply inventory not banked');
 };
 const bank=async()=>{
  check();if(!(await s.bot.openBank()).success)throw Error('glass supply ordinary bank unavailable');await wait(()=>s.sdk.isBankOpen());
  await deposit();
  const equipment=s.sdk.getEquipment();
  if(equipment.length){
   // unequipItem dismisses the bank modal. Reopen before depositing the kit.
   await close();for(const item of equipment){check();await s.bot.unequipItem(item.name);await wait(()=>!s.sdk.getEquipment().some(i=>i.id===item.id));}
   check();if(!(await s.bot.openBank()).success)throw Error('glass supply kit bank unavailable');await wait(()=>s.sdk.isBankOpen());await deposit();
  }
  await wait(()=>!!s.bankObservation?.());const observed=s.bankObservation?.();if(!observed)throw Error('glass supply fresh bank unobserved');
  const stock:GlassStock={};for(const i of observed.items)stock[i.id]=(stock[i.id]??0)+i.count;return stock;
 };
 const take=async(id:number,n:number)=>{if(!n)return;check();const row=s.sdk.getBankItems().find(i=>i.id===id),b=held(id);if(!row||row.count<n)throw Error('glass supply bank short '+id);await s.bot.withdrawItem(row,n,{asNote:false});await wait(()=>held(id)===b+n);};
 const gather=async(id:number,n:number)=>{
  check();if(id===1925)await walk({x:3026,z:3289});
  else await walk({x:2804,z:3380});
  const before=held(id),why=await gatherItems(s,await getWorld(),[{id,count:n,how:'spawn'}],async at=>{
   check();if(id===1925&&!(at.level===0&&at.x>=3020&&at.x<=3026&&at.z>=3289&&at.z<=3291)||id===401&&!(at.level===0&&at.x>=2800&&at.x<=2812&&at.z>=3380&&at.z<=3390))return{ok:false,reason:'outside pinned supply spawn area'};
   return walk(at);
  });check();if(why||held(id)!==before+n)throw Error('glass supply acquisition '+(why??'wrong item delta'));
 };
 const island=async()=>{
  await walk({x:3046,z:3236});check();
  const r=await sail(s,{npc:/^monk of entrana$/i,choices:[/^yes, okay/i],deck:{x:2834,z:3331},attempts:2,converseTicks:80,stop:()=>ac.signal.aborted,deadline:start+o.cap,before:check});
  if(!r.ok)throw Error('glass supply outward boat '+r.detail);
  if(!(await disembark(s,{stop:()=>ac.signal.aborted,deadline:start+o.cap,before:check})).ok)throw Error('glass supply outward gangplank');check();
 };
 const fill=async()=>{
  await close();await walk({x:2815,z:3341});const b=held(1925),sand=held(1783),item=inv().find(i=>i.id===1925),pit=s.sdk.getState()?.nearbyLocs.find(l=>l.id===2645&&l.x===2816&&l.z===3341);
  if(!item||!pit)throw Error('glass supply bucket/pinned sandpit missing');check();await s.sdk.sendUseItemOnLoc(item.slot,pit.x,pit.z,pit.id);await wait(()=>held(1925)===b-1&&held(1783)===sand+1);
 };
 const cook=async(n:number)=>{
  await close();await walk({x:2821,z:3351});
  const recipe=cookingRecipes().recipes.find(r=>r.raw===401&&r.products.includes(1781));if(!recipe)throw Error('glass supply pinned ash recipe missing');
  const r=await runCookingBatch({state:()=>s.sdk.getState(),tick:()=>s.tick(),stop:()=>ac.signal.aborted,close,step:()=>waitTicks(s,1),wait:(test,ticks)=>waitUntil(s,test,{timeoutTicks:ticks,signal:ac.signal}),heat:async slot=>{
   check();const loc=s.sdk.getState()?.nearbyLocs.find(l=>l.id===2728&&l.x===2822&&l.z===3351&&l.distance<=3);if(!loc)throw Error('glass supply pinned range missing');return(await s.sdk.sendUseItemOnLoc(slot,loc.x,loc.z,loc.id)).success;
  }},recipe,{maximum:n,cap:Math.max(1,o.cap-(s.tick()-start)),heat:'range',expectedProduct:1781});if(r.cooked!==n||r.burnt)throw Error('glass supply ash conversion incomplete');check();
 };
 const smelt=async(n:number)=>{await close();await walk({x:2832,z:3351});const r=await runFurnaceGlass(s,n,Math.max(1,o.cap-(s.tick()-start)),()=>ac.signal.aborted);check();if(!r.ok)throw Error(r.failure);return r.made;};
 const returnBank=async()=>{
  await close();await walk({x:2830,z:3335});const r=await sail(s,{npc:/^monk of entrana$/i,choices:[/^yes, i'm ready/i],deck:{x:3048,z:3231},attempts:2,converseTicks:80,stop:()=>ac.signal.aborted,deadline:start+o.cap,before:check});
  if(!r.ok)throw Error('glass supply return boat '+r.detail);if(!(await disembark(s,{stop:()=>ac.signal.aborted,deadline:start+o.cap,before:check})).ok)throw Error('glass supply return gangplank');await walk(GLASS_RETURN_BANK);
 };
 try{return await executionContext.run({...parent,signal:ac.signal},()=>abortable(runGlassSupply({tick:()=>s.tick(),check,bank,take,close,gather,island,fill,cook,smelt,returnBank},o)));}
 catch(e){return{ok:false,failure:String(e),ticks:s.tick()-start};}
 finally{off();parent?.signal.removeEventListener('abort',cancel);}
}
if(import.meta.main){
 const supply=process.env.SUPPLY_MODE==='1';let stopped=false;const maximum=Number(process.env.MAX_MAKE??1),cap=Number(process.env.CAP??200);
 if(!supply&&process.env.MEMBERS!=='1')throw Error('furnace glass requires explicit MEMBERS=1 scope');
 const s=await openBot(process.argv[2]!,{onStop:async()=>{stopped=true;}});
 const stop=()=>stopped||existsSync('.practice/stop-all')||existsSync(`.practice/stop-${s.name}`);
 try{const result=supply?await runBankedGlass(s,glassSupplyOptions(process.env),stop):await runFurnaceGlass(s,maximum,cap,stop);if(supply)console.log('GLASS_SUPPLY_RESULT '+JSON.stringify(result));await finish([s],result.ok,JSON.stringify(result));}
 catch(e){await finish([s],false,String(e));}
}
