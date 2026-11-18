// Exact staged grapes/water order. Raw wine is noted before the bank modal can close.
import type {Session} from '../packages/core/src/inprocess';
import {openBot,settle} from '../packages/core/src/bot';
import {waitUntil} from '../packages/core/src/ticks';
import {depositObserved} from '../packages/core/src/deposit';
import {inventoryRecipes,runInventoryProduction,type ProductionSnapshot} from './microbot-production';

type Item={id:number;count:number};
export type WineStock={items:Record<number,number>;equipment:(Item&{slot:number})[];xp:number};
export type WineStockOptions={maximum:number;cap:number;reserve?:number};
const sum=(rows:readonly Item[],id:number)=>rows.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const worn=(rows:WineStock['equipment'])=>rows.map(i=>({id:i.id,count:i.count,slot:i.slot})).sort((a,b)=>a.slot-b.slot);
export function wineStockChecks(before:WineStock,after:WineStock,maximum:number){
 const delta:Record<number,number>={1987:-maximum,1937:-maximum,1996:maximum};
 return{
  inputs:(after.items[1987]??0)===(before.items[1987]??0)-maximum&&(after.items[1937]??0)===(before.items[1937]??0)-maximum,
  output:(before.items[1995]??0)===0&&(after.items[1995]??0)===0&&(after.items[1996]??0)===(before.items[1996]??0)+maximum,
  assets:[...new Set([...Object.keys(before.items),...Object.keys(after.items),...Object.keys(delta)])].every(id=>(after.items[+id]??0)===(before.items[+id]??0)+(delta[+id]??0)),
  equipment:JSON.stringify(worn(before.equipment))===JSON.stringify(worn(after.equipment)),xp:before.xp===after.xp,
 };
}

export async function runPreservedWine(s:Session,o:WineStockOptions,stop:()=>boolean=()=>false){
 if(!Number.isSafeInteger(o.maximum)||o.maximum<1||!Number.isSafeInteger(o.cap)||o.cap<1||!Number.isSafeInteger(o.reserve??0)||(o.reserve??0)<0)
  throw Error('invalid preserved wine order');
 const start=s.tick(),recipe=inventoryRecipes().find(r=>r.name==='wine-unfermented')!,reserve=o.reserve??0;
 let ended=false;void s.ended.then(()=>{ended=true;});
 const initial=s.sdk.getState()?.player;
 const stopped=()=>{const p=s.sdk.getState()?.player;return ended||stop()||!initial||!p||p.isDead||p.lifeId!==initial.lifeId||(s.sdk.getSkill('Hitpoints')?.level??0)<=0;};
 const guard=()=>{if(stopped()||s.tick()-start>=o.cap)throw Error('preserved wine stopped or CAP exhausted');};
 const pack=()=>s.sdk.getInventory(),held=(id:number)=>sum(pack(),id),stored=(id:number)=>sum(s.bankObservation?.()?.items??[],id);
 const stock=():WineStock=>{
  if(!s.bankObservation?.())throw Error('preserved wine bank unknown');
  const items:Record<number,number>={};for(const i of [...s.bankObservation()!.items,...pack()])items[i.id]=(items[i.id]??0)+i.count;
  return{items,equipment:s.sdk.getEquipment().map(i=>({id:i.id,count:i.count,slot:i.slot})),xp:s.sdk.getSkillXp('Cooking')??0};
 };
 const read=():ProductionSnapshot=>{const items:Record<number,number>={};for(const i of pack())items[i.id]=(items[i.id]??0)+i.count;return{items,xp:s.sdk.getSkillXp('Cooking')??0};};
 const open=async()=>{
  guard();if(s.sdk.getState()?.bank.isOpen&&s.bankObservation?.())return;
  const generation=s.bankObservation?.()?.generation??-1;
  if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!s.sdk.getState()?.bank.isOpen&&(s.bankObservation?.()?.generation??-1)>generation,{timeoutTicks:10}))
   throw Error('preserved wine fresh bank unavailable');
  guard();
 };
 let before:WineStock|undefined,after:WineStock|undefined,made=0,noted=0,failure='',assets=false;
 try{
  guard();if((s.sdk.getSkill('Cooking')?.baseLevel??0)<recipe.level)throw Error('preserved wine requires Cooking35');
  await open();before=stock();
  if((before.items[1995]??0)!==0)throw Error('preserved wine entry has existing raw wine');
  if(recipe.inputs.some(i=>(before!.items[i.id]??0)<o.maximum*i.units+reserve))throw Error('preserved wine staged inputs short of order and reserve');
  let dispatchedAt=-1;
  const result=await runInventoryProduction({tick:()=>s.tick(),stopped,level:()=>s.sdk.getSkill('Cooking')?.baseLevel??0,read,
   prepare:async()=>{
    await open();
    for(const input of recipe.inputs){
     guard();const missing=input.units-held(input.id);if(missing<=0)continue;
     const target=s.sdk.getState()?.bank.items.find(i=>i.id===input.id),old=stored(input.id),count=held(input.id),generation=s.bankObservation!()!.generation;
     if(!target||old-missing<reserve)throw Error('preserved wine input reserve unavailable');
     await s.bot.withdrawItem(target,missing,{asNote:false});
     if(!await waitUntil(s,()=>held(input.id)===count+missing&&stored(input.id)===old-missing&&(s.bankObservation?.()?.generation??-1)>generation,{timeoutTicks:8}))
      throw Error('preserved wine paired input withdrawal unobserved');
    }
    guard();if(held(1995)||stored(1995))throw Error('preserved wine raw stock before close');
    if(!(await s.bot.closeBank()).success||!await waitUntil(s,()=>!s.sdk.getState()?.bank.isOpen,{timeoutTicks:8}))throw Error('preserved wine bank close unobserved');
    guard();return true;
   },
   use:async()=>{
    guard();const grapes=pack().find(i=>i.id===recipe.inputs[0]!.id),water=pack().find(i=>i.id===recipe.inputs[1]!.id);
    if(!grapes||!water)throw Error('preserved wine input slots missing');
    dispatchedAt=s.tick();return s.sdk.sendUseItemOnItem(grapes.slot,water.slot);
   },
   wait:done=>waitUntil(s,done,{timeoutTicks:8}),
   deposit:async id=>{
    guard();if(id!==1995||dispatchedAt<0||s.tick()-dispatchedAt>=20)throw Error('preserved wine first timer window missed');
    await open();const raw=pack().find(i=>i.id===1995);
    if(!raw||held(1995)!==1||stored(1995)!==0)throw Error('preserved wine raw output mismatch');
    if(await depositObserved(s,raw)!==1)throw Error('preserved wine raw bank credit mismatch');
    guard();const target=s.sdk.getState()?.bank.items.find(i=>i.id===1995),previous=held(1996),generation=s.bankObservation!()!.generation;
    if(!target||stored(1995)!==1)throw Error('preserved wine raw bank slot missing');
    await s.bot.withdrawItem(target,1,{asNote:true});
    if(!await waitUntil(s,()=>held(1996)===previous+1&&held(1995)===0&&stored(1995)===0&&(s.bankObservation?.()?.generation??-1)>generation,{timeoutTicks:8}))
     throw Error('preserved wine paired note withdrawal unobserved');
    guard();noted++;return 1;
   },
   // Failure must keep a raw output behind its modal rather than release its timer here.
   close:async()=>{},
  },recipe,{maximum:o.maximum,cap:o.cap-(s.tick()-start),maxAttempts:o.maximum});
  made=result.made;if(!result.ok)throw Error(result.failure);
  guard();after=stock();const checks=wineStockChecks(before,after,o.maximum);assets=Object.values(checks).every(Boolean);
  if(!assets||noted!==o.maximum)throw Error('preserved wine final input/output/assets mismatch');
  if(!(await s.bot.closeBank()).success||!await waitUntil(s,()=>!s.sdk.getState()?.bank.isOpen,{timeoutTicks:8}))throw Error('preserved wine final close unobserved');
  guard();
 }catch(error){failure=String(error);}
 // The count of used inputs comes from the stock read with the bank open. After the last close the session holds no
 // bank reading, and a count from it gives every staged input as used.
 const used=(id:number)=>!before?0:after?(before.items[id]??0)-(after.items[id]??0):(before.items[id]??0)-stored(id)-held(id);
 return{ok:!failure,made,noted,inputs:{grapes:used(1987),water:used(1937)},assets,ticks:s.tick()-start,failure:failure||'-'};
}

if(import.meta.main){
 let stopped=false,s:Session|undefined;
 let result={ok:false,made:0,noted:0,inputs:{grapes:0,water:0},assets:false,ticks:0,failure:''};
 try{
  const name=process.argv[2]??'',maximum=Number(process.argv[3]),cap=Number(process.argv[4]??1000),reserve=Number(process.argv[5]??0);
  if(!name||/^(main|haggis)$/i.test(name)||![maximum,cap,reserve].every(Number.isSafeInteger)||maximum<1||cap<1||reserve<0)throw Error('invalid preserved wine order');
  s=await openBot(name,{onStop:async()=>{stopped=true;},onSessionEnd:async()=>{stopped=true;}});
  result=await runPreservedWine(s,{maximum,cap,reserve},()=>stopped);
 }catch(error){result.failure=String(error);}
 result.ok=await settle(s?[s]:[],result.ok,ok=>`preservedWine=${ok?result.noted:0} grapesUsed=${result.inputs.grapes} waterUsed=${result.inputs.water} assets=${result.assets?1:0} ticks=${result.ticks} ${result.failure}`);
 console.log('WINE_STOCK_RESULT '+JSON.stringify(result));process.exitCode=result.ok?0:1;
}
