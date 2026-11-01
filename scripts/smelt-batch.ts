import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Session} from '../packages/core/src/inprocess';
import {depositObserved} from '../packages/core/src/deposit';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {sessionWalker,walkPath,goTo} from '../packages/core/src/walk';
import {accountOf,getWorld} from '../packages/core/src/bot';
import {parseConfigs} from '../packages/knowledge/src/config';
import {productionBatch} from '../packages/planner/src/production-batch';
import {smeltEntryRoute} from '../packages/planner/src/travel';

// Adapted from rs2b2t/rs2b0t SmelterBotLogic.withdrawFor/canSmelt/smeltStalled,
// commit6e747f8bda494d9f75365b5533cf758d353dcc3b (MIT; quest-sustain.NOTICE.txt).
// Replace substring matching/fixed28/wall-clock waits with pinned IDs, actual slots,
// reserved stock, observed effects and the existing paired deposit receipts.
type Stock=readonly {id:number;count:number}[];
export type SmeltRecipe={product:number;level:number;ingredients:{id:number;units:number}[];iron:boolean};
const count=(rows:Stock,id:number)=>rows.filter(v=>v.id===id).reduce((n,v)=>n+v.count,0);
export function smeltRecipe(bar:string):SmeltRecipe{
 if(!['iron','steel','gold','mithril'].includes(bar))throw Error('unsupported smelt recipe: '+bar);
 const content=resolve(import.meta.dir,'../vendor/rs-sdk/server/content'),file='scripts/skill_smithing/configs/smelting/smelting.struct';
 const ids=new Map(readFileSync(resolve(content,'pack/obj.pack'),'utf8').split(/\r?\n/).flatMap(l=>{const m=l.match(/^(\d+)=(.+)$/);return m?[[m[2]!,Number(m[1])] as const]:[];}));
 const b=parseConfigs(readFileSync(resolve(content,file),'utf8'),file).find(b=>b.name==='smelting_'+bar+'_bar');
 if(!b)throw Error('pinned smelt recipe missing');
 const p=Object.fromEntries((b.props.param??[]).map(v=>{const at=v.indexOf(',');return[v.slice(0,at),v.slice(at+1)];}));
 const item=(name:string)=>{const id=ids.get(name);if(id===undefined)throw Error('unknown smelt item '+name);return id;};
 const ingredients=[{id:item(p.ingredient!),units:Number(p.bar_count)}];
 if(p.ingredient_secondary)ingredients.push({id:item(p.ingredient_secondary),units:Number(p.ingredient_secondary_count)});
 return{product:item(p.product!),level:Number(p.levelrequired),ingredients,iron:bar==='iron'};
}
export function planSmeltLoad(r:SmeltRecipe,bank:Stock,freeSlots:number,maximum:number,reserved:Readonly<Record<number,number>>){
 return productionBatch(r.ingredients.map(i=>({...i,available:count(bank,i.id),reserved:reserved[i.id]??0,stackable:false})),freeSlots,maximum,'best-effort');
}
export function smeltEffect(r:SmeltRecipe,before:Stock,after:Stock,xpBefore:number,xpAfter:number):{kind:'none'|'made'|'loss';made:number}{
 const debits=r.ingredients.map(i=>count(before,i.id)-count(after,i.id)),made=count(after,r.product)-count(before,r.product);
 if(made===0&&debits.every(v=>v===0)&&xpAfter===xpBefore)return{kind:'none',made:0};
 if(!debits.every((v,n)=>v===r.ingredients[n]!.units))throw Error('smelt ingredient debit mismatch');
 if(made===1&&xpAfter>xpBefore)return{kind:'made',made};
 if(r.iron&&made===0&&xpAfter===xpBefore)return{kind:'loss',made:0};
 throw Error('smelt output/XP mismatch');
}
export async function runSmeltBatch(s:Session,o:{bar:string;cap:number;maximum:number;reserve:number;mode:'exact'|'best-effort';stop?:()=>boolean},io?:{walk:(x:number,z:number)=>Promise<boolean>;recover?:(x:number,z:number)=>Promise<boolean>}){
 if(![o.cap,o.maximum,o.reserve].every(Number.isSafeInteger)||o.cap<1||o.maximum<1||o.reserve<0||!['exact','best-effort'].includes(o.mode))throw Error('invalid finite smelt order');
 const r=smeltRecipe(o.bar),state=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),held=(id:number)=>count(inv(),id),xp=()=>s.sdk.getSkillXp('Smithing')??0;
 const ready=await waitUntil(s,()=>!!state()?.player&&(s.sdk.getSkill('Hitpoints')?.level??0)>0&&(s.sdk.getSkill('Smithing')?.baseLevel??0)>=r.level,{timeoutTicks:15});
 if(!ready)throw Error('smelt entry level/state unobserved');
 const p0=state()!.player!,start=s.tick(),xp0=xp();
 const entryBank={x:p0.worldX,z:p0.worldZ};
 const entry=smeltEntryRoute(p0);
 // The pinned furnace auto-selects steel if iron is used while carrying2coal.
 // Preserve that stock rather than silently producing a different bar.
 if(r.iron&&held(453)>=2&&(s.sdk.getSkill('Smithing')?.baseLevel??0)>=30)throw Error('iron entry requires coal banked before recipe dispatch');
 const material=new Set([...r.ingredients.map(i=>i.id),r.product]),kit=new Map<number,number>();
 for(const i of inv())if(!material.has(i.id))kit.set(i.id,(kit.get(i.id)??0)+i.count);
 let ended=false,died=false,hpMin=s.sdk.getSkill('Hitpoints')!.level,made=0,consumedOre=0,losses=0,attempts=0,misses=0,failure='',stop='cap';
 void s.ended.then(()=>{ended=true;});
 const off=s.onTick(()=>{const p=state()?.player;hpMin=Math.min(hpMin,s.sdk.getSkill('Hitpoints')?.level??hpMin);died||=hpMin<=0||!!p&&(p.isDead||(p.respawnCount??0)>(p0.respawnCount??0)||(p0.lifeId!==undefined&&p.lifeId!==p0.lifeId));});
 const over=()=>ended||died||hpMin<7||!!o.stop?.()||s.tick()-start>=o.cap;
 const near=(x:number,z:number,tol=3)=>{const p=state()?.player;return !!p&&p.level===0&&Math.max(Math.abs(p.worldX-x),Math.abs(p.worldZ-z))<=tol;};
 let travel=false,travelTicks=0,coinsSpent=0,arrival=false,crossed=false;
 const passed:{x:number;z:number}[]=[];
 const recover=async(x:number,z:number,cleanup=false)=>{
  if(ended||died||hpMin<7||(!cleanup&&over()))return false;
  if(io)return !!io.recover&&await io.recover(x,z)&&near(x,z);
  const ac=new AbortController(),began=s.tick(),budget=cleanup?160:Math.min(160,Math.max(1,o.cap-(s.tick()-start)));
  const off=s.onTick(()=>{if(ended||died||hpMin<7||s.tick()-began>=budget||(!cleanup&&over()))ac.abort('smelt recovery deadline/stop');});
  try{
   const r=await goTo(s,await getWorld(),{x,z,level:0},accountOf(s),{maxRetriesPerLeg:1,legTimeoutTicks:budget,signal:ac.signal});
   return r.ok&&near(x,z);
  }finally{off();}
 };
 const walk=async(x:number,z:number,cleanup=false)=>{
  if(io)return await io.walk(x,z)&&near(x,z);
  const walker=await sessionWalker(s),plan=walker.plan;
  // A plan must end inside the walk tolerance. Blocked targets (furnace, counters) end on an adjacent tile,
  // and a bot already at the target gets an empty plan. A farther end is a partial plan, never a fallback.
  const tol=1,inside=(t:{x:number;z:number})=>Math.max(Math.abs(t.x-x),Math.abs(t.z-z))<=tol;
  walker.plan=(level,from,to)=>{const path=plan(level,from,to);if(!inside(path.at(-1)??from))throw Error('smelt incomplete corridor plan');return path;};
  // A hit stops travel; a cleanup walk to the near bank keeps moving rather than stand in a fight.
  const result=await walkPath(walker,[{x,z,tol}],{maxTicks:Math.min(160,cleanup?160:Math.max(1,o.cap-(s.tick()-start))),stop:()=>ended||died||hpMin<7||(!cleanup&&(over()||travel&&((s.sdk.getSkill('Hitpoints')?.level??0)<hpStart)))});return result.ok&&near(x,z);
 };
 let lastBank:Stock|undefined;
 const bankRows=()=>{const observed=s.bankObservation?.();if(observed)lastBank=observed.items.map(i=>({id:i.id,count:i.count}));return lastBank??[];};
 const totals=()=>{const rows=[...inv(),...s.sdk.getEquipment(),...bankRows()],m=new Map<number,number>();for(const i of rows)m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
 let initial:Map<number,number>|undefined;
 const hpStart=hpMin;
 const observeBank=async()=>{
  const generation=s.bankObservation?.()?.generation??-1;
  if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!state()?.bank.isOpen&&(s.bankObservation?.()?.generation??-1)>generation,{timeoutTicks:10}))throw Error('smelt bank observation unready');
 };
 const reserved=Object.fromEntries(r.ingredients.map(i=>[i.id,o.reserve]));
 const bank=async(refill:boolean,cleanup=false)=>{
  if(!await walk(3269,3167,cleanup))throw Error('smelt bank route incomplete');
  if(!state()?.bank.isOpen)await observeBank();
  if(!await waitUntil(s,()=>!!state()?.bank.isOpen&&!!s.bankObservation?.(),{timeoutTicks:10}))throw Error('smelt bank observation unready');
  initial??=totals();
  for(const id of material){const item=inv().find(i=>i.id===id);if(item)await depositObserved(s,item);}
  if(!refill)return 0;
  const batch=planSmeltLoad(r,bankRows(),28-inv().length,o.maximum-made,reserved).planned;
  if(!batch)return 0;
  for(const ingredient of r.ingredients){
   const item=state()?.bank.items.find(i=>i.id===ingredient.id),amount=batch*ingredient.units;
   if(!item||!(await s.bot.withdrawItem(item,amount,{asNote:false})).success||!await waitUntil(s,()=>held(ingredient.id)===amount,{timeoutTicks:8}))throw Error('smelt withdrawal unobserved '+ingredient.id);
  }
  if(!(await s.bot.closeBank()).success||!await waitUntil(s,()=>!state()?.bank.isOpen,{timeoutTicks:5}))throw Error('smelt bank close unobserved');
  return batch;
 };
 try{
  if(entry.fare){
   travel=true;
   await observeBank();initial=totals();
   if(over()||hpMin<7)throw Error('smelt entry stopped/low health');
   if((initial.get(995)??0)<entry.fare)throw Error('smelt entry needs 10 coins for toll');
   // Keep pack kit/food; withdraw only the missing fare, with an observed delta.
   const needed=Math.max(0,entry.fare-held(995));
   if(needed){const coins=state()?.bank.items.find(i=>i.id===995),before=held(995);
    if(!coins||!(await s.bot.withdrawItem(coins,needed,{asNote:false})).success||!await waitUntil(s,()=>held(995)===before+needed,{timeoutTicks:8}))throw Error('smelt fare withdrawal unobserved');}
   if(!await waitUntil(s,()=>count(bankRows(),995)+held(995)===(initial!.get(995)??0),{timeoutTicks:8}))throw Error('smelt fare bank balance unobserved');
   if(!(await s.bot.closeBank()).success||!await waitUntil(s,()=>!state()?.bank.isOpen,{timeoutTicks:5}))throw Error('smelt entry bank close unobserved');
   for(const point of entry.points){
    if(over())throw Error('smelt entry stopped');
    let reached=false,detail='';
    try{reached=await walk(point.x,point.z);}catch(error){detail=String(error);}
    if(!reached&&!await recover(point.x,point.z))throw Error(`smelt entry corridor incomplete at ${point.x},${point.z}${detail?': '+detail:''}`);
    passed.push(point);
   }
   const guard=s.sdk.getNearbyNpcs().filter(n=>n.id===925).sort((a,b)=>a.distance-b.distance)[0];
   if(!guard||!(await s.sdk.sendInteractNpc(guard.index,1)).success)throw Error('smelt west toll guard unavailable');
   const cash=held(995),deadline=s.tick()+45;let answered=false;
   try{
   while(!near(3268,3227,1)|| (state()?.player?.worldX??0)<3268){
    if(over()||s.tick()>=deadline)throw Error('smelt toll crossing deadline');
    const d=s.sdk.getDialog();
    if(d?.isOpen&&!d.isWaiting){
     if(d.options.some(v=>/yes, ok/i.test(v.text))){if(!answered){if(!(await s.sdk.clickDialogByText(/yes, ok/i)).success)throw Error('smelt toll choice refused');answered=true;}}
     else if(d.options.length===0||d.options.length===1&&/continue/i.test(d.options[0]!.text)){if(!(await s.sdk.sendClickDialog(d.options[0]?.index??0)).success)throw Error('smelt toll continue refused');}
     else throw Error('smelt unexpected toll dialog');
    }
    await waitTicks(s,1);
   }
   crossed=true;
   if(!await waitUntil(s,()=>cash-held(995)===(answered?entry.fare:0),{timeoutTicks:5}))throw Error('smelt toll debit unobserved');
   }finally{coinsSpent=cash-held(995);}
   if(coinsSpent!==(answered?entry.fare:0))throw Error('smelt toll debit mismatch');
   for(const [x,z] of [[3272,3227],[3275,3212],[3273,3194],[3269,3167]])if(over()||!await walk(x!,z!))throw Error('smelt destination corridor incomplete');
   travel=false;travelTicks=s.tick()-start;
  }
  arrival=true;
  while(made<o.maximum&&!over()){
   const batch=await bank(true);if(!batch){stop='depleted';break;}
   if(!await walk(3274,3186))throw Error('smelt furnace route incomplete');
   while(r.ingredients.every(i=>held(i.id)>=i.units)&&made<o.maximum&&!over()){
    const dialog=s.sdk.getDialog();if(dialog?.isOpen){
     if(dialog.isWaiting){await waitTicks(s,1);continue;}
     const option=dialog.options.find(v=>/continue/i.test(v.text));if(!option)throw Error('smelt unexpected dialog');
     const reply=await s.sdk.sendClickDialog(option.index);
     if(!reply.success)throw Error('smelt dialog click refused: '+JSON.stringify(reply));
     // Dispatch acknowledgement precedes the server's next UI packet. Yield as
     // quest-lib.converse/runBronze do; otherwise resolved promises can starve
     // the socket pump indefinitely on a retained level-up page.
     await waitTicks(s,1);continue;
    }
    const furnace=s.sdk.findNearbyLoc(/^furnace$/i,{withOption:/smelt/i}),ore=inv().find(i=>i.id===r.ingredients[0]!.id);if(!furnace||!ore)throw Error('smelt furnace/ore missing');
    const before=inv().map(i=>({id:i.id,count:i.count})),beforeXp=xp();attempts++;
    const cursor=Math.max(-1,...(state()?.gameMessages??[]).map(m=>m.observationId??m.tick));
    const ironLoss=()=>r.iron&&(state()?.gameMessages??[]).some(m=>(m.observationId??m.tick)>cursor&&/ore is too impure|fail to refine/i.test(m.text));
    const sent=await s.sdk.sendUseItemOnLoc(ore.slot,furnace.x,furnace.z,furnace.id);
    await waitUntil(s,()=>ended||died||held(r.ingredients[0]!.id)<count(before,r.ingredients[0]!.id),{timeoutTicks:8});
    // Inventory and XP can be separate publications; settle both before judging success.
    await waitUntil(s,()=>ended||died||held(r.product)>count(before,r.product)&&xp()>beforeXp||ironLoss(),{timeoutTicks:2});
    const effect=smeltEffect(r,before,inv(),beforeXp,xp());
    if(effect.kind==='none'){if(!sent.success||++misses>=3)throw Error('no smelt progress: unchanged recipe after bounded attempts');}
    else{misses=0;consumedOre++;made+=effect.made;if(effect.kind==='loss'){losses++;if(!ironLoss())throw Error('iron impurity loss message unobserved');}}
   }
  }
  if(made>=o.maximum)stop='target';
 }catch(error){failure='no smelt progress: '+String(error);}
 finally{try{if(!ended&&!died){
  if(s.sdk.getDialog()?.isOpen){await s.direct({type:'closeModal',reason:'SDK'});if(!await waitUntil(s,()=>!s.sdk.getDialog()?.isOpen,{timeoutTicks:5}))throw Error('smelt final dialog close unobserved');}
  // Never turn an interrupted entry into a blind cross-map cleanup walk. East of the gate the Al Kharid
  // bank is the near bank; a retreat west would pay the toll again.
  if(arrival||crossed){
   await bank(false,true);
  }
  else if(entry.fare){
   // Retrace only the observed entry corridor. Escape a stalled hostile leg
   // before the session owner attempts logout; never start a second logout.
   if(!near(3253,3420,5)){
    for(const point of [...passed].reverse())if(!await recover(point.x,point.z,true))throw Error('smelt entry retreat incomplete');
    if(!await recover(entryBank.x,entryBank.z,true))throw Error('smelt entry bank retreat incomplete');
   }
   if(!state()?.bank.isOpen)await observeBank();
  }
 }}catch(error){failure=failure?failure+'; final bank: '+String(error):'no smelt progress: final bank: '+String(error);}off();}
 if(travel)travelTicks=s.tick()-start;
 const finalObservation=s.bankObservation?.(),final=initial?totals():new Map<number,number>();
 const banked=initial&&finalObservation?(final.get(r.product)??0)-(initial.get(r.product)??0)-held(r.product):null;
 const preserved=[...kit].every(([id,n])=>id===995?true:held(id)===n);
 const allIds=new Set([...(initial?.keys()??[]),...final.keys()]);
 const conserved=initial&&lastBank?[...allIds].every(id=>{
  const ingredient=r.ingredients.find(i=>i.id===id),expected=(initial!.get(id)??0)+(id===r.product?made:0)-(ingredient?consumedOre*ingredient.units:0)-(id===995?coinsSpent:0);
  return(final.get(id)??0)===expected;
 }):null;
 const reserveMet=finalObservation?r.ingredients.every(i=>count(finalObservation.items,i.id)>=(reserved[i.id]??0)):null;
 if(!failure&&o.mode==='exact'&&made!==o.maximum)failure=`no smelt progress: exact target unmet ${made}/${o.maximum} (${stop})`;
 if(!failure&&made===0)failure=`no smelt progress: zero observed bars (${stop})`;
 if(!failure&&(banked!==made||!conserved||!preserved||!reserveMet))failure='no smelt progress: final bank/asset/reserve acceptance unproved';
 const ok=!failure&&!ended&&!died&&!o.stop?.()&&hpMin>=7&&made>0&&xp()>xp0&&near(3269,3167)&&banked===made&&preserved&&conserved===true&&reserveMet===true&&[...material].every(id=>held(id)===0)&&(o.mode==='best-effort'||made===o.maximum);
 return{ok,bar:o.bar,mode:o.mode,target:o.maximum,targetMet:made===o.maximum,ticks:s.tick()-start,entry:entry.name,travelTicks,coinsSpent,initialCoins:initial?.get(995)??0,finalCoins:final.get(995)??0,made,banked,consumedOre,losses,attempts,xpGain:xp()-xp0,preserved,conserved,reserveMet,hpMin,died,stop,failure,nextConsumer:'Smithing progression; measure iron-tip/ammo conversion before more surplus mining'};
}
