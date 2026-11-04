import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Session} from '../packages/core/src/inprocess';
import {depositObserved} from '../packages/core/src/deposit';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {sessionWalker,walkPath,goTo} from '../packages/core/src/walk';
import {accountOf,getWorld} from '../packages/core/src/bot';
import {parseConfigs} from '../packages/knowledge/src/config';
import {productionBatch} from '../packages/planner/src/production-batch';
import {smithStageRoute,SMITH_BANK,SMITH_ANVIL} from '../packages/planner/src/travel';

// Finite anvil order. Recipe, bar count, XP and interface slot come from the pinned server content
// (smithing.dbrow, smelting.obj, smithing.struct, smithing.inv, interface.pack), the mapping that
// scripts/measure/floor-smithing.ts hardcodes. Each product is one Make-1 click with an observed
// bar debit, product credit and XP gain (smithing.rs2 attempt_smithing/smithing_anvil).
type Stock=readonly {id:number;count:number}[];
export type SmithRecipe={product:number;amount:number;level:number;bar:number;bars:number;xpPerBar:number;component:number;slot:number};
export const HAMMER=2347,SMITHING_INTERFACE=994,TOLL_GUARD_EAST=926;
const count=(rows:Stock,id:number)=>rows.filter(v=>v.id===id).reduce((n,v)=>n+v.count,0);
export function smithRecipe(product:number):SmithRecipe{
 const unsupported=Error('unsupported smith recipe: '+product);
 if(!Number.isSafeInteger(product)||product<0)throw unsupported;
 const content=resolve(import.meta.dir,'../vendor/rs-sdk/server/content'),configs='scripts/skill_smithing/configs/';
 const pack=(file:string)=>new Map(readFileSync(resolve(content,'pack',file),'utf8').split(/\r?\n/).flatMap(l=>{const m=l.match(/^(\d+)=(.+)$/);return m?[[m[2]!,Number(m[1])] as const]:[];}));
 const blocks=(file:string)=>parseConfigs(readFileSync(resolve(content,configs+file),'utf8'),file);
 const field=(rows:string[]|undefined,key:string)=>rows?.find(v=>v.startsWith(key+','))?.slice(key.length+1);
 const objs=pack('obj.pack'),name=[...objs].find(([,id])=>id===product)?.[0];
 const row=name===undefined?undefined:blocks('smithing/smithing.dbrow').find(b=>field(b.props.data,'product')===name);
 if(!row)throw unsupported;
 const bar=field(row.props.data,'bar')!,struct=field(blocks('smelting/smelting.obj').find(b=>b.name===bar)?.props.param,'smithing_anvil_struct');
 const params=blocks('smithing/smithing.struct').find(b=>b.name===struct)?.props.param;
 const invs=blocks('smithing/smithing.inv'),components=pack('interface.pack');
 // Columns1-5 only: claws and dart tips have quest gates this order does not check.
 for(let column=1;column<=5;column++){
  const inv=invs.find(b=>b.name===field(params,'invcolumn'+column));
  const stock=Object.entries(inv?.props??{}).find(([k,v])=>/^stock\d+$/.test(k)&&v[0]?.split(',')[0]===name);
  const component=components.get('smithing:column'+column);
  if(!stock||component===undefined)continue;
  const recipe={product,amount:Number(field(row.props.data,'product_amount')),level:Math.max(Number(field(row.props.data,'levelrequired')),Number(field(params,'levelrequired'))),
   bar:objs.get(bar)!,bars:Number(field(row.props.data,'bar_amount')),xpPerBar:Number(field(params,'xpperbar')),component,slot:Number(stock[0].slice(5))-1};
  if(!Object.values(recipe).every(n=>Number.isSafeInteger(n)&&n>=0)||recipe.amount<1||recipe.bars<1)throw unsupported;
  return recipe;
 }
 throw unsupported;
}
export function planSmithLoad(r:SmithRecipe,bank:Stock,freeSlots:number,maximum:number,reserve:number){
 return productionBatch([{id:r.bar,available:count(bank,r.bar),reserved:reserve,units:r.bars,stackable:false}],freeSlots,maximum,'best-effort');
}
// 0: nothing changed. 1: one product. Anything else is a mismatch the order cannot account for.
export function smithEffect(r:SmithRecipe,before:Stock,after:Stock,xpBefore:number,xpAfter:number){
 const debit=count(before,r.bar)-count(after,r.bar),made=count(after,r.product)-count(before,r.product);
 if(debit===0&&made===0&&xpAfter===xpBefore)return 0;
 if(debit===r.bars&&made===r.amount&&xpAfter>xpBefore)return 1;
 throw Error('smith bar/product/XP mismatch');
}
export async function runSmithBatch(s:Session,o:{product:number;cap:number;maximum:number;reserve:number;stop?:()=>boolean},io?:{walk:(x:number,z:number)=>Promise<boolean>;recover?:(x:number,z:number)=>Promise<boolean>}){
 if(![o.product,o.cap,o.maximum,o.reserve].every(Number.isSafeInteger)||o.cap<1||o.maximum<1||o.reserve<0)throw Error('invalid finite smith order');
 const r=smithRecipe(o.product),state=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),held=(id:number)=>count(inv(),id),xp=()=>s.sdk.getSkillXp('Smithing')??0;
 const ready=await waitUntil(s,()=>!!state()?.player&&(s.sdk.getSkill('Hitpoints')?.level??0)>0&&(s.sdk.getSkill('Smithing')?.baseLevel??0)>0,{timeoutTicks:15});
 if(!ready)throw Error('smith entry state unobserved');
 const p0=state()!.player!,start=s.tick(),xp0=xp(),level=s.sdk.getSkill('Smithing')!.baseLevel;
 const material=new Set([r.bar,r.product]),kit=new Map<number,number>();
 for(const i of inv())if(!material.has(i.id))kit.set(i.id,(kit.get(i.id)??0)+i.count);
 let ended=false,died=false,hpMin=s.sdk.getSkill('Hitpoints')!.level,made=0,attempts=0,misses=0,failure='',stop='cap',entry='';
 const hpStart=hpMin;
 void s.ended.then(()=>{ended=true;});
 const off=s.onTick(()=>{const p=state()?.player;hpMin=Math.min(hpMin,s.sdk.getSkill('Hitpoints')?.level??hpMin);died||=hpMin<=0||!!p&&(p.isDead||(p.respawnCount??0)>(p0.respawnCount??0)||(p0.lifeId!==undefined&&p.lifeId!==p0.lifeId));});
 const over=()=>ended||died||hpMin<7||!!o.stop?.()||s.tick()-start>=o.cap;
 const near=(x:number,z:number,tol=3)=>{const p=state()?.player;return !!p&&p.level===0&&Math.max(Math.abs(p.worldX-x),Math.abs(p.worldZ-z))<=tol;};
 let travel=false,travelTicks=0,coinsSpent=0,arrival=false,hammerWithdrawn=false;
 const recover=async(x:number,z:number)=>{
  if(over())return false;
  if(io)return !!io.recover&&await io.recover(x,z)&&near(x,z);
  const ac=new AbortController(),began=s.tick(),budget=Math.min(160,Math.max(1,o.cap-(s.tick()-start)));
  const stopRecovery=s.onTick(()=>{if(over()||s.tick()-began>=budget)ac.abort('smith recovery deadline/stop');});
  try{const result=await goTo(s,await getWorld(),{x,z,level:0},accountOf(s),{maxRetriesPerLeg:1,legTimeoutTicks:budget,signal:ac.signal});return result.ok&&near(x,z);}
  finally{stopRecovery();}
 };
 const walk=async(x:number,z:number,cleanup=false)=>{
  if(io)return await io.walk(x,z)&&near(x,z);
  const walker=await sessionWalker(s),plan=walker.plan;
  // As in smelt-batch: a plan must end inside the walk tolerance; a farther end is a partial plan.
  const tol=1,inside=(t:{x:number;z:number})=>Math.max(Math.abs(t.x-x),Math.abs(t.z-z))<=tol;
  walker.plan=(level,from,to)=>{const path=plan(level,from,to);if(!inside(path.at(-1)??from))throw Error('smith incomplete corridor plan');return path;};
  const result=await walkPath(walker,[{x,z,tol}],{maxTicks:Math.min(160,cleanup?160:Math.max(1,o.cap-(s.tick()-start))),stop:()=>ended||died||hpMin<7||(!cleanup&&over())||travel&&((s.sdk.getSkill('Hitpoints')?.level??0)<hpStart)});
  return result.ok&&near(x,z);
 };
 const leg=async(x:number,z:number)=>{
  if(over())throw Error('smith staging stopped');
  let reached=false,detail='';
  try{reached=await walk(x,z);}catch(error){detail=String(error);}
  if(!reached&&!await recover(x,z))throw Error(`smith staging corridor incomplete at ${x},${z}${detail?': '+detail:''}`);
 };
 let lastBank:Stock|undefined;
 const bankRows=()=>{const observed=s.bankObservation?.();if(observed)lastBank=observed.items.map(i=>({id:i.id,count:i.count}));return lastBank??[];};
 const totals=()=>{const m=new Map<number,number>();for(const i of [...inv(),...s.sdk.getEquipment(),...bankRows()])m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
 let initial:Map<number,number>|undefined;
 const openBank=async()=>{
  if(state()?.bank.isOpen&&s.bankObservation?.())return;
  const generation=s.bankObservation?.()?.generation??-1;
  if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!state()?.bank.isOpen&&(s.bankObservation?.()?.generation??-1)>generation,{timeoutTicks:10}))throw Error('smith bank observation unready');
 };
 const withdraw=async(id:number,amount:number)=>{
  const item=state()?.bank.items.find(i=>i.id===id),before=held(id);
  if(!item||!(await s.bot.withdrawItem(item,amount,{asNote:false})).success||!await waitUntil(s,()=>held(id)===before+amount,{timeoutTicks:8}))throw Error('smith withdrawal unobserved '+id);
 };
 const closeBank=async()=>{if(!(await s.bot.closeBank()).success||!await waitUntil(s,()=>!state()?.bank.isOpen,{timeoutTicks:5}))throw Error('smith bank close unobserved');};
 const depositMaterial=async(extra:number[]=[])=>{for(const id of [...material,...extra]){const item=inv().find(i=>i.id===id);if(item)await depositObserved(s,item);}};
 const ifaceOpen=()=>!!state()?.interface?.isOpen&&state()!.interface.interfaceId===SMITHING_INTERFACE;
 try{
  // Refusals happen at the observed starting bank, before any travel or withdrawal.
  if(level<r.level)throw Error(`smith refused: Smithing ${level} is below level ${r.level} for product ${r.product}`);
  let route:ReturnType<typeof smithStageRoute>;
  try{route=smithStageRoute(p0);}catch(error){throw Error('smith refused: '+(error as Error).message);}
  entry=route.name;
  await openBank();initial=totals();
  await depositMaterial();
  const bars=count(bankRows(),r.bar),need=o.maximum*r.bars+o.reserve;
  if(bars<need)throw Error(`smith refused: ${bars} bars ${r.bar} cannot cover ${o.maximum}x${r.bars} plus reserve ${o.reserve}`);
  if(!(initial.get(HAMMER)??0))throw Error('smith refused: no hammer in pack, worn or bank');
  if(28-inv().length-(held(HAMMER)?0:1)<r.bars)throw Error(`smith refused: pack needs ${r.bars} free slots plus a hammer slot`);
  if((initial.get(995)??0)<route.fare)throw Error(`smith refused: staging needs ${route.fare} coins for toll`);
  if(route.fare>held(995))await withdraw(995,route.fare-held(995));
  if(route.points.length||route.toll.length){
   travel=true;await closeBank();
   for(const point of route.toll)await leg(point.x,point.z);
   if(route.fare){
    const guard=s.sdk.getNearbyNpcs().filter(n=>n.id===TOLL_GUARD_EAST).sort((a,b)=>a.distance-b.distance)[0];
    if(!guard||!(await s.sdk.sendInteractNpc(guard.index,1)).success)throw Error('smith east toll guard unavailable');
    // border_gate.rs2 pass_toll_gate moves an east-side player to 3267,3227.
    const cash=held(995),deadline=s.tick()+45;let answered=false;
    try{
     while(!near(3267,3227,1)||(state()?.player?.worldX??9999)>3267){
      if(over()||s.tick()>=deadline)throw Error('smith toll crossing deadline');
      const d=s.sdk.getDialog();
      if(d?.isOpen&&!d.isWaiting){
       if(d.options.some(v=>/yes, ok/i.test(v.text))){if(!answered){if(!(await s.sdk.clickDialogByText(/yes, ok/i)).success)throw Error('smith toll choice refused');answered=true;}}
       else if(d.options.length===0||d.options.length===1&&/continue/i.test(d.options[0]!.text)){if(!(await s.sdk.sendClickDialog(d.options[0]?.index??0)).success)throw Error('smith toll continue refused');}
       else throw Error('smith unexpected toll dialog');
      }
      await waitTicks(s,1);
     }
     if(!await waitUntil(s,()=>cash-held(995)===(answered?route.fare:0),{timeoutTicks:5}))throw Error('smith toll debit unobserved');
    }finally{coinsSpent=cash-held(995);}
    if(coinsSpent!==(answered?route.fare:0))throw Error('smith toll debit mismatch');
   }
   for(const point of route.points)await leg(point.x,point.z);
   travel=false;travelTicks=s.tick()-start;
  }
  if(!near(SMITH_BANK.x,SMITH_BANK.z))throw Error('smith bank arrival unobserved');
  arrival=true;
  while(made<o.maximum&&!over()){
   if(!await walk(SMITH_BANK.x,SMITH_BANK.z))throw Error('smith bank route incomplete');
   await openBank();await depositMaterial();
   if(!held(HAMMER)){await withdraw(HAMMER,1);hammerWithdrawn=true;}
   const batch=planSmithLoad(r,bankRows(),28-inv().length,o.maximum-made,o.reserve).planned;
   if(!batch){stop='depleted';break;}
   await withdraw(r.bar,batch*r.bars);await closeBank();
   if(!await walk(SMITH_ANVIL.x,SMITH_ANVIL.z))throw Error('smith anvil route incomplete');
   while(held(r.bar)>=r.bars&&made<o.maximum&&!over()){
    const dialog=s.sdk.getDialog();if(dialog?.isOpen){
     if(dialog.isWaiting){await waitTicks(s,1);continue;}
     const option=dialog.options.find(v=>/continue/i.test(v.text));if(!option)throw Error('smith unexpected dialog: '+(dialog.text??''));
     if(!(await s.sdk.sendClickDialog(option.index)).success)throw Error('smith dialog click refused');
     await waitTicks(s,1);continue;
    }
    attempts++;
    if(!ifaceOpen()){
     const anvil=s.sdk.findNearbyLoc(/^anvil$/i),bar=inv().find(i=>i.id===r.bar);if(!anvil||!bar)throw Error('smith anvil/bar missing');
     const sent=await s.sdk.sendUseItemOnLoc(bar.slot,anvil.x,anvil.z,anvil.id);
     await waitUntil(s,()=>ended||died||ifaceOpen()||!!s.sdk.getDialog()?.isOpen,{timeoutTicks:12});
     // A level-up page cancels the anvil op; the dialog branch clears it, and every unopened try counts.
     if(!ifaceOpen()){if(!sent.success||++misses>=3)throw Error('no smith progress: anvil interface unopened after bounded attempts');continue;}
    }
    const before=inv().map(i=>({id:i.id,count:i.count})),beforeXp=xp();
    const sent=await s.sdk.sendClickComponentWithOption(r.component,1,r.slot);
    await waitUntil(s,()=>ended||died||held(r.bar)<count(before,r.bar),{timeoutTicks:8});
    // Inventory and XP can be separate publications; settle both before judging.
    await waitUntil(s,()=>ended||died||held(r.product)>count(before,r.product)&&xp()>beforeXp,{timeoutTicks:3});
    if(smithEffect(r,before,inv(),beforeXp,xp())){made++;misses=0;}
    else if(!sent.success||++misses>=3)throw Error('no smith progress: unchanged anvil after bounded attempts');
   }
  }
  if(made>=o.maximum)stop='target';
 }catch(error){const text=error instanceof Error?error.message:String(error);failure=text.startsWith('smith refused')?text:'no smith progress: '+text;if(text.startsWith('smith refused'))stop='refused';}
 finally{try{if(!ended&&!died){
  if(s.sdk.getDialog()?.isOpen||ifaceOpen()){await s.direct({type:'closeModal',reason:'SDK'});if(!await waitUntil(s,()=>!s.sdk.getDialog()?.isOpen&&!ifaceOpen(),{timeoutTicks:5}))throw Error('smith final modal close unobserved');}
  // Final bank only at the staged pair. A staging failure holds only kit and fare coins.
  if(arrival){
   if(!await walk(SMITH_BANK.x,SMITH_BANK.z,true))throw Error('smith final bank route incomplete');
   await openBank();await depositMaterial(hammerWithdrawn&&held(HAMMER)?[HAMMER]:[]);
  }
 }}catch(error){failure=failure?failure+'; final bank: '+String(error):'no smith progress: final bank: '+String(error);}off();}
 if(travel)travelTicks=s.tick()-start;
 const finalObservation=s.bankObservation?.(),final=initial?totals():new Map<number,number>();
 const banked=initial&&finalObservation?(final.get(r.product)??0)-(initial.get(r.product)??0)-held(r.product):null;
 const preserved=[...kit].every(([id,n])=>id===995||held(id)===n)&&inv().every(i=>i.id===995||kit.has(i.id));
 const allIds=new Set([...(initial?.keys()??[]),...final.keys()]);
 const conserved=initial&&lastBank?[...allIds].every(id=>(final.get(id)??0)===(initial!.get(id)??0)+(id===r.product?made*r.amount:0)-(id===r.bar?made*r.bars:0)-(id===995?coinsSpent:0)):null;
 const hammerRetained=!!initial&&(final.get(HAMMER)??0)>=1&&final.get(HAMMER)===initial.get(HAMMER);
 const reserveMet=finalObservation?count(finalObservation.items,r.bar)>=o.reserve:null;
 if(!failure&&made!==o.maximum)failure=`no smith progress: exact target unmet ${made}/${o.maximum} (${stop})`;
 if(!failure&&(banked!==made*r.amount||!conserved||!preserved||!reserveMet||!hammerRetained))failure='no smith progress: final bank/asset/reserve acceptance unproved';
 const ok=!failure&&!ended&&!died&&!o.stop?.()&&hpMin>=7&&made===o.maximum&&xp()>xp0&&near(SMITH_BANK.x,SMITH_BANK.z)&&banked===made*r.amount&&preserved&&conserved===true&&reserveMet===true&&hammerRetained&&[...material].every(id=>held(id)===0);
 return{ok,action:'smith',product:r.product,bar:r.bar,barsPerProduct:r.bars,level:r.level,target:o.maximum,reserve:o.reserve,targetMet:made===o.maximum,ticks:s.tick()-start,entry,travelTicks,coinsSpent,
  initialCoins:initial?.get(995)??0,finalCoins:final.get(995)??0,initialBars:initial?.get(r.bar)??0,finalBars:final.get(r.bar)??0,made,banked,attempts,
  xpGain:xp()-xp0,baseXpPerProduct:r.bars*r.xpPerBar/10,levelBefore:level,levelAfter:s.sdk.getSkill('Smithing')?.baseLevel??level,
  preserved,conserved,hammerRetained,reserveMet,hpMin,died,stop,failure,nextConsumer:'Smithing85: price rune dagger inputs (runite ore, coal) and the next Smithing band before more bars'};
}
