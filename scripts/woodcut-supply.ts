import {existsSync} from 'node:fs';
import {openBot, getWorld, accountOf, countItems} from '../packages/core/src/bot';
import {goTo} from '../packages/core/src/walk';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import { depositObserved } from '../packages/core/src/deposit';
import { runShafts } from './fletch-shafts';
import { runHeadless } from './fletch-arrows';
import {
    type ShopRetryGate,
    WOODCUTTING_AXES_DESC,
    bestWoodcuttingAxe,
    executeShopToolPurchase,
    planToolShopUpgrade,
    readSkillLevels,
    reconcileBankTool,
    recordShopAttempt,
    sessionShopGate,
    sessionToolHooks,
    shouldAttemptShopUpgrade,
    tierBoundaryOf,
} from '../packages/planner/src/gear-progression';
type Session=Awaited<ReturnType<typeof openBot>>;
const BANK={x:3092,z:3243,level:0},KNIFE={x:3224,z:3202,level:0},TREES={x:3226,z:3237,level:0};
const CORRIDOR=[{x:3092,z:3266,level:0},{x:3140,z:3270,level:0},{x:3180,z:3258,level:0},{x:3218,z:3256,level:0}];
export function supplyPlan(logs:number,headless:number,cap:number){
 if(!Number.isSafeInteger(logs)||logs<1||logs>25||!Number.isSafeInteger(headless)||headless<0||headless%15||headless>Math.floor(Math.max(0,logs*15-200)/15)*15||!Number.isSafeInteger(cap)||cap<100||cap>10000)throw Error('supply requires LOGS1..25, HEADLESS multiple15 within shaft reserve200, CAP100..10000');
 return {logs,headless,shafts:logs*15};
}
// Called only at an observed, guarded owned bank. A failed withdrawal is not missing stock.
export async function takeOwnedSupplyKnife(s:Session,check:()=>void):Promise<'held'|'withdrawn'|'missing'>{
 const held=()=>s.sdk.getInventory().filter(i=>i.id===946).reduce((n,i)=>n+i.count,0);
 check();if(held()>0)return'held';
 const before=s.bankObservation?.();
 if(!before||!s.sdk.getState()?.bank?.isOpen)throw Error('supply owned knife bank unobserved');
 const bankBefore=before.items.filter(i=>i.id===946).reduce((n,i)=>n+i.count,0),generationBefore=before.generation,packBefore=held();
 if(bankBefore===0)return'missing';
 const knife=s.sdk.getState()!.bank.items.find(i=>i.id===946);
 if(!knife)throw Error('supply owned knife slot unobserved');
 check();
 if(!(await s.bot.withdrawItem(knife,1,{asNote:false})).success)throw Error('supply owned knife withdrawal refused');
 check();
 const observed=await waitUntil(s,()=>{
  const bank=s.bankObservation?.();
  return !!bank&&bank.generation>generationBefore&&bank.items.filter(i=>i.id===946).reduce((n,i)=>n+i.count,0)===bankBefore-1&&held()===packBefore+1;
 },{timeoutTicks:5});
 check();if(!observed)throw Error('supply owned knife withdrawal unobserved');
 console.log('WOOD_SUPPLY_KNIFE_RECEIPT '+JSON.stringify({account:s.name,itemId:946,amount:1,bankBefore,bankAfter:bankBefore-1,packBefore,packAfter:held(),generationBefore,generationAfter:s.bankObservation!()!.generation,tick:s.tick()}));
 return'withdrawn';
}
export function selectWoodSupplyAxe(
 stock:readonly {id:number;count:number}[],
 levels:ReturnType<typeof readSkillLevels>,
){
 return bestWoodcuttingAxe(stock,levels);
}
const woodSupplyShopGates=new WeakMap<object,ShopRetryGate>();
export async function reconcileWoodSupplyAxe(
 s:Session,
 options:{bankSpot?:{x:number;z:number;level?:number};walkTo?:(spot:{x:number;z:number;level?:number})=>Promise<boolean>;check:()=>void;allowShop?:boolean;shopGate?:ShopRetryGate},
){
 options.check();
 const bankItems=s.bankObservation?.()?.items??s.sdk.getState()?.bank?.items??[];
 const inv=s.sdk.getInventory(),eq=s.sdk.getEquipment?.()??[];
 const levels=readSkillLevels(s.sdk);
 const stock=[...inv,...eq.filter(e=>e.slot===3),...bankItems];
 const coins=stock.filter(i=>i.id===995).reduce((n,i)=>n+i.count,0);
 const axeTier=tierBoundaryOf(levels.woodcutting,[1,6,21,31,41]);
 const shopGate=sessionShopGate(woodSupplyShopGates,s,options.shopGate);
 if(options.allowShop!==false&&shouldAttemptShopUpgrade(shopGate,axeTier,s.tick?.()??0)){
  const shopPlan=planToolShopUpgrade('woodcutting-axe',stock,coins,levels,{allowedShops:['axeshop'],onlyWhenStarterOrMissing:true});
  if(shopPlan){
   options.check();
   const hooks=sessionToolHooks(s,{walkTo:options.walkTo,waitUntil:(pred,timeoutTicks)=>waitUntil(s,pred,{timeoutTicks}),stop:()=>{try{options.check();return false;}catch{return true;}}});
   const res=await executeShopToolPurchase(hooks,{targetId:shopPlan.target.id,shop:'axeshop',maxBudget:shopPlan.coinBudgetNeeded,returnBankSpot:options.bankSpot??BANK});
   recordShopAttempt(shopGate,axeTier,s.tick?.()??0,res.bought);
   if(res.bought){
    console.log('WOOD_SUPPLY_SHOP_AXE '+JSON.stringify(res));
    options.check();
    if(!(await s.bot.openBank()).success)throw Error('supply bank unavailable after axe purchase');
    options.check();
    const spareCoins=s.sdk.getInventory().find(i=>i.id===995);
    if(spareCoins)await depositObserved(s,spareCoins);
   }
  }
 }
 options.check();
 const latestBank=s.bankObservation?.()?.items??s.sdk.getState()?.bank?.items??[];
 const rec=bestWoodcuttingAxe([...s.sdk.getInventory(),...(s.sdk.getEquipment?.()??[]).filter(e=>e.slot===3),...latestBank],levels).current;
 if(!rec)return null;
 await reconcileBankTool(sessionToolHooks(s,{waitUntil:(pred,timeoutTicks)=>waitUntil(s,pred,{timeoutTicks}),stop:()=>{try{options.check();return false;}catch{return true;}}}),{
  targetId:rec.item.id,
  canWield:rec.canWield,
  toolGroupIds:WOODCUTTING_AXES_DESC,
 });
 return rec.item.id;
}
export async function runWoodSupply(s:Session,logs:number,headless:number,cap:number){
 const plan=supplyPlan(logs,headless,cap),start=s.tick(),hp=s.sdk.getSkill('Hitpoints')?.level??0;
 let hpMin=hp,last=hp;const damage:any[]=[];const off=s.onTick(()=>{const now=s.sdk.getSkill('Hitpoints')?.level??0;const hit=now<last;last=now;if(hit){const p=s.sdk.getState()?.player;damage.push({tick:s.tick()-start,hp:now,pos:p&&{x:p.worldX,z:p.worldZ,level:p.level},combat:p?.combat,npcs:s.sdk.getState()?.nearbyNpcs.map(n=>({name:n.name,x:n.x,z:n.z,distance:n.distance}))});console.log('WOOD_SUPPLY_DAMAGE '+JSON.stringify(damage.at(-1)));}hpMin=Math.min(hpMin,now);});
 const stop=()=>existsSync('.practice/stop-'+s.name),held=(id:number)=>s.sdk.getInventory().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 // Damage latches: a later heal does not clear it. Every guard, including the helpers' stop callbacks and active travel, reads halt().
 const halt=()=>stop()||s.tick()-start>=cap||damage.length>0||(s.sdk.getSkill('Hitpoints')?.level??0)<hp||!!s.sdk.getState()?.player?.isDead;
 const check=()=>{if(halt())throw Error('supply stopped, capped or damaged');};
 const walk=async(t:typeof BANK)=>{
  check();const abort=new AbortController(),watch=s.onTick(()=>{if(halt())abort.abort('supply stopped, capped or damaged');});
  try{const r=await goTo(s,await getWorld(),t,accountOf(s),{legTimeoutTicks:100,signal:abort.signal});check();if(!r.ok)throw Error('supply route '+r.reason+' '+r.detail);}finally{watch();}
 };
 const travel=async(t:typeof BANK)=>{
  check();const p=s.sdk.getState()?.player;if(p&&p.level===t.level&&Math.max(Math.abs(p.worldX-t.x),Math.abs(p.worldZ-t.z))<=2)return;
  // The courier's north-bank lane avoids the jail/road approach. Keep the supply route north of the Lumbridge spiders.
  if(t.x===BANK.x&&t.z===BANK.z)for(const step of [...CORRIDOR].reverse())await walk(step);
  else if(t===TREES||t===KNIFE||t.x>3150)for(const step of CORRIDOR)await walk(step);
  await walk(t);
 };
 // An owner stop can land while the bank opens, so recheck before every bank mutation.
 const bank=async()=>{await travel(BANK);check();if(!(await s.bot.openBank()).success)throw Error('supply bank unavailable');check();};
 const deposit=async()=>{for(const id of [1511,946]){check();const item=s.sdk.getInventory().find(i=>i.id===id);if(item)await depositObserved(s,item);}await s.bot.closeBank();};
 const activeAxeId=()=>{const levels=readSkillLevels(s.sdk);const eq=s.sdk.getEquipment?.()??[];return bestWoodcuttingAxe([...s.sdk.getInventory(),...eq.filter(e=>e.slot===3)],levels).current?.item.id??null;};
 const walkToSpot=async(spot:{x:number;z:number;level?:number})=>{await travel({x:spot.x,z:spot.z,level:spot.level??0});return true;};
 let gathered=0,shafts:any,arrows:any;
 try{
  if(!activeAxeId()||activeAxeId()===1351){
   await bank();
   const picked=await reconcileWoodSupplyAxe(s,{bankSpot:BANK,walkTo:walkToSpot,check});
   if(!picked)throw Error('supply owned or shop axe required');
   await s.bot.closeBank();
  }
  // Feather holders can carry a full starter kit. Only logs and the knife move into the bank; trees stay inside the existing Lumbridge safe box.
  if(!held(946)){
   await bank();const owned=await takeOwnedSupplyKnife(s,check);check();await s.bot.closeBank();check();
   if(owned==='missing'){
    await travel(KNIFE);
    for(let n=0;n<8&&!held(946);n++){check();const k=s.sdk.findGroundItem(/^knife$/i);if(k)await s.bot.pickupItem(k);await waitTicks(s,2);}
    if(!held(946))throw Error('supply knife spawn unavailable');
   }
  }
  await bank();await deposit();
  let lastGain=s.tick();
  while(gathered<plan.logs){
   // Only logs and the knife are deposited. A pack with no free slot after that would walk the loop with no progress.
   if(s.sdk.getInventory().length>=27)throw Error('supply pack has no free gathering slot after deposit');
   await travel(TREES);lastGain=s.tick();
   while(gathered<plan.logs&&s.sdk.getInventory().length<27){
    check();if(s.sdk.getDialog()?.isOpen){await s.sdk.sendClickDialog(0);await waitTicks(s,1);}
    const old=held(1511),tree=s.sdk.getState()?.nearbyLocs.filter(l=>l.x>=3214&&l.x<=3239&&l.z>=3226&&l.z<=3250&&/^tree$/i.test(l.name)&&l.optionsWithIndex.some(o=>/chop/i.test(o.text))&&l.reachable!==false).sort((a,b)=>a.distance-b.distance)[0];
    if(!tree){if(s.tick()-lastGain>240)throw Error('supply no normal tree after respawn budget');await waitTicks(s,4);continue;}
    const result=await s.bot.interactLoc(tree,tree.optionsWithIndex.find(o=>/chop/i.test(o.text))!.text);if(!result.success)console.log('WOOD_SUPPLY_CHOP_REFUSED '+JSON.stringify({tree:{id:tree.id,x:tree.x,z:tree.z},result}));await waitUntil(s,()=>held(1511)>old||stop(),{timeoutTicks:12});
    const gain=held(1511)-old;if(gain>0){gathered+=gain;lastGain=s.tick();}
    if(s.tick()-lastGain>80)throw Error('supply no log progress');
   }
   await bank();await reconcileWoodSupplyAxe(s,{bankSpot:BANK,walkTo:walkToSpot,check});await deposit();
  }
  check();shafts=await runShafts(s,{cap:Math.max(1,cap-(s.tick()-start)),maximum:logs,reserve:0,bankKnife:true,stop:halt,pause:stop});check();
  if(!shafts.ok)throw Error('supply shafts '+JSON.stringify(shafts));
  if(headless){check();arrows=await runHeadless(s,{cap:Math.max(1,cap-(s.tick()-start)),maximum:headless,shaftReserve:200,featherReserve:100,stop:halt,pause:stop});check();if(!arrows.ok||!arrows.targetMet)throw Error('supply headless '+JSON.stringify(arrows));}
  return {ok:true,gathered,shafts,arrows,ticks:s.tick()-start,hpMin,damage};
 }catch(error){return {ok:false,gathered,shafts,arrows,ticks:s.tick()-start,error:String(error),hpMin,damage};}finally{off();}
}
