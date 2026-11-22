// Ranged from supported bank or observed Wizards' Tower cellar entry; owned bows and counted preparation.
// Usage: bun scripts/ranged-train.ts <bot> [TARGET_LEVEL] [CAP ticks]
// Env: MIN_ARROWS, BUY_ARROWS, BUY_ARROW_ID, MAX_SPEND, COIN_RESERVE, AMMO, FOOD, FOOD_ID, KILLS_PER_TRIP, MAX_TRIPS.
// MAX_SPEND includes food, arrows and fares. COIN_RESERVE protects total owned coins.
// Missing trout/salmon falls back to observed Wydin cheese stock; FOOD remains the per-trip meal target.
import {existsSync,readFileSync} from 'node:fs';
import {openBot,finish,accountOf,getWorld,sessionDied} from '../packages/core/src/bot';
import {equipmentObserved} from '../packages/core/src/container-observation';
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {depositObserved} from '../packages/core/src/deposit';
import {sessionWalker,walkPath,walkRoute,expandPath,goTo,type PathPoint} from '../packages/core/src/walk';
import {rangedCredit,selectRangedTarget} from './gather-ranged';
import {startQuestSustain} from './quest-sustain';
import {buyWithBudget,orderPaths,runOwnedItem,type ItemRequest} from '../packages/workers/src/market';
import {planTripOffThread} from '../packages/core/src/route-plan';
import {routeFares,type Account} from '../packages/core/src/world';
import {chooseProgression,type ObservedAccount,type ProgressionDecision} from '../packages/planner/src/progression';
import {rangedProgressionMethods,rangedKit,rangedBandTarget} from '../packages/planner/src/progression-ranged';
import {standardBowTiers,standardArrowTiers,gearById,shopCatalog} from '../packages/planner/src/gear-progression';
import {questFlags} from '../packages/core/src/quest-status';
import {isLocalServer} from '../packages/core/src/localserver';
import {runGiants,TROOPER_SITE} from './gather-combat';
import {ferryWalk} from './walk-to';
type Item={id:number;count:number};
// Bow and arrow tiers come from knowledge/gear.json through the planner engine (standardBowTiers, standardArrowTiers).
// player_ranged.rs2 refuses arrows whose levelrequire exceeds the bow's levelrequire. In a level the shortbow is first,
// so it wins a tie (it fires faster).
// (packages/knowledge/src/ladders.ts names this declaration as the worker's bow evidence.)
export const BOWS=[...standardBowTiers()].reverse()
 .flatMap(t=>t.ids.map(id=>({id,req:t.level,name:gearById(id)?.name??String(id)})));
export const ARROWS:readonly {id:number;req:number;name:string}[]=standardArrowTiers().sort((x,y)=>x.id-y.id)
 .map(t=>({id:t.id,req:t.level,name:gearById(t.id)?.name??String(t.id)}));
const ARROW_IDS:number[]=ARROWS.map(a=>a.id),BOW_IDS:number[]=BOWS.map(b=>b.id);
const COINS=995,BONES=526,CHICKEN=2138,FEATHER=314,BANK={x:3253,z:3421},LOWE={x:3232,z:3423},WYDIN={x:3015,z:3206},PEN={x:3233,z:3297},LOOT_WINDOW=12;
// The arrows Lowe's archeryshop lists (knowledge/shops.json).
const LOWE_ARROWS:number[]=ARROWS.filter(a=>shopCatalog().get(a.id)?.some(s=>s.shop==='archeryshop')).map(a=>a.id);
const OUT:PathPoint[]=[{x:3280,z:3429,tol:2},{x:3275,z:3380,tol:2},{x:3260,z:3335,tol:2},{x:3233,z:3297,tol:0}];
const BACK:PathPoint[]=[{x:3260,z:3335,tol:2},{x:3275,z:3380,tol:2},{x:3280,z:3429,tol:2},{...BANK,tol:1}];
// The starter's east-Varrock corridor and agility-order's public Draynor -> Wydin approach. A known mainland food
// trip uses the guarded walker directly; a cold global food search can outlast the session's no-progress bound.
const FOOD_OUT:PathPoint[]=[{x:3280,z:3429,tol:2},{x:3275,z:3380,tol:2},{x:3260,z:3335,tol:2},
 {x:3239,z:3306,tol:2},{x:3232,z:3285,tol:2},{x:3226,z:3262,tol:2},{x:3089,z:3266,tol:2},
 {x:3060,z:3265,tol:3},{x:3047,z:3237,tol:3},{x:3029,z:3217,tol:3},{...WYDIN,tol:1}];
const FOOD_BACK:PathPoint[]=[...FOOD_OUT.slice(0,-1).reverse(),{...BANK,tol:1}];
const count=(items:readonly Item[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const sum=(items:readonly Item[],ids:readonly number[])=>ids.reduce((n,id)=>n+count(items,id),0);
// Highest levelrequire the account can wield; the shortbow wins a tie because it fires faster.
export function bestBow(owned:readonly Item[],ranged:number){
 return BOWS.filter(b=>b.req<=ranged&&count(owned,b.id)>0).reduce<typeof BOWS[number]|undefined>((best,b)=>!best||b.req>best.req?b:best,undefined);
}
export const usableArrows=(bowReq:number,ranged:number):number[]=>ARROWS.filter(a=>a.req<=bowReq&&a.req<=ranged).map(a=>a.id);
// The strongest owned usable arrow whose stack can start a trip (at least MIN_TRIP_ARROWS). A stronger stack too small
// for a trip gives way to a weaker usable one instead of stopping the order.
export const MIN_TRIP_ARROWS=3;
export function chooseArrow(owned:readonly Item[],bowReq:number,ranged:number,min=MIN_TRIP_ARROWS){
 return usableArrows(bowReq,ranged).map(id=>({id,count:count(owned,id)})).filter(a=>a.count>=min).sort((a,b)=>b.id-a.id)[0];
}
export function rangedEntry(p:{worldX:number;worldZ:number;level:number}|null|undefined){
 if(!p||p.level!==0)return null;
 // Observed entry only. The shared planner owns the pinned cellar ladder and surface route.
 if(p.worldX===3113&&p.worldZ===9555)return BANK;
 for(const bank of [BANK,{x:2809,z:3441},{x:2619,z:3332}])if(Math.max(Math.abs(p.worldX-bank.x),Math.abs(p.worldZ-bank.z))<=6)return bank;
 return null;
}
export function preparationFunds(total:number,spent:number,maxSpend:number,reserve:number){return Math.max(0,Math.min(maxSpend-spent,total-reserve));}
// A shut shop door leaves the keeper unroutable: the client reports cant_reach and sends nothing. Open the nearest
// door once and ask again; a second refusal stays a failure.
export async function openShopWithDoor(bot:{openShop(t:RegExp):Promise<{success:boolean}>;openDoor(t?:RegExp):Promise<{success:boolean}>},keeper:RegExp,opened:()=>Promise<boolean>){
 if((await bot.openShop(keeper)).success&&await opened())return true;
 if(!(await bot.openDoor(/door/i)).success)return false;
 return (await bot.openShop(keeper)).success&&await opened();
}
// Units for one shop packet group within the remaining budget; the margin covers price rise as stock falls.
export function buyChunk(want:number,stock:number,unitPrice:number,budget:number,wallet:number,reserve:number){
 if(![want,stock,unitPrice,budget,wallet,reserve].every(Number.isFinite)||unitPrice<=0)return 0;
 const margin=Math.ceil(unitPrice*1.5);
 return Math.max(0,Math.min(10,want,stock,Math.floor(Math.min(budget,wallet-reserve)/margin)));
}
// Arrows leave the account only through shots; every other change must be a counted purchase.
export function arrowAccount(initial:number,bought:number,final:number,shots:number){
 const spent=initial+bought-final;
 return {spent,ok:Number.isSafeInteger(spent)&&spent>=0&&spent<=shots};
}
export type RangedTrainOptions={target:number;cap:number;minArrows:number;buyArrows:number;buyArrowId:number;maxSpend:number;coinReserve:number;ammo:number;food:number;foodId:number;killsPerTrip:number;maxTrips:number;kit?:{bow:number;arrow:number};stop?:()=>boolean};
export function rangedTrainOptions(env:Record<string,string|undefined>,argv:string[]):RangedTrainOptions{
 const n=(v:string|undefined,d:number)=>v===undefined||v===''?d:Number(v);
 const o={target:n(argv[3]??env.TARGET_LEVEL,10),cap:n(argv[4]??env.CAP,3000),minArrows:n(env.MIN_ARROWS,30),buyArrows:n(env.BUY_ARROWS,60),buyArrowId:n(env.BUY_ARROW_ID,882),
  maxSpend:n(env.MAX_SPEND,500),coinReserve:n(env.COIN_RESERVE,0),ammo:n(env.AMMO,60),food:n(env.FOOD,3),foodId:n(env.FOOD_ID,329),killsPerTrip:n(env.KILLS_PER_TRIP,5),maxTrips:n(env.MAX_TRIPS,10)};
 const bad=Object.entries(o).filter(([,v])=>!Number.isSafeInteger(v)||v<0).map(([k])=>k);
 if(bad.length||o.target<2||o.target>99||o.cap<800||o.ammo<15||o.ammo>500||o.food<2||o.food>8||o.killsPerTrip<1||o.killsPerTrip>8||o.maxTrips<1||o.maxTrips>50||!LOWE_ARROWS.includes(o.buyArrowId)||![329,333].includes(o.foodId))
  throw Error('ranged-train prerequisite: bounded options '+(bad.join(',')||'target2..99,cap>=800,ammo15..500,food2..8,kills1..8,trips1..50,Lowe arrow,food329/333'));
 return o;
}
export async function runRangedTrain(s:Session,o:RangedTrainOptions){
 const st=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),eq=()=>s.sdk.getEquipment(),held=(id:number)=>count(inv(),id),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
 const level=()=>s.sdk.getSkill('Ranged')?.baseLevel??0,xp=()=>s.sdk.getSkillXp('Ranged')??0,coins=()=>held(COINS);
 if(!await waitUntil(s,()=>hp()>0&&level()>0,{timeoutTicks:15}))throw Error('ranged-train prerequisite: skill observation unknown');
 if(!await waitUntil(s,()=>!!rangedEntry(st()?.player),{timeoutTicks:15}))throw Error('ranged-train prerequisite: Varrock East, Catherby, Ardougne north bank or observed Wizards Tower cellar entry required');
 const originalRetaliate=st()?.autoRetaliateEnabled;if(typeof originalRetaliate!=='boolean')throw Error('ranged-train prerequisite: auto-retaliate telemetry unknown');
 const p0=st()?.player,start=s.tick(),startLevel=level(),startXp=xp(),originalEquipment=eq().map(i=>i.id);
 const entry=rangedEntry(p0);if(!p0||!entry)throw Error('ranged-train prerequisite: supported entry observation lost');
 const entryItems=[...inv(),...eq()].map(i=>({id:i.id,count:i.count}));
 if(originalEquipment.some(id=>BOW_IDS.includes(id)||ARROW_IDS.includes(id)))throw Error('ranged-train prerequisite: bow and arrows must start unequipped');
 let ended=false,died=false,cleanup=false,hpMin=hp(),kills=0,trips=0,eaten=0,picked=0,shots=0,bought=0,coinsSpent=0,coinsWithdrawn=0,shopVisits=0,failure='',stop='cap';
 let bowUsed=0,arrowUsed=0,foodId=o.foodId,foodBought=0,foodSpent=0,travelSpent=0;let bankReady=false;
 // Bones and raw chicken are by-products: the kill is already credited on XP and the loot drop, so a pickup another
 // player wins or that misses its window loses only the item. Accounting counts what was actually picked up.
 let bonesPicked=0,chickenPicked=0;
 const foodConsumed:Record<number,number>={},foodPurchases:Record<number,number>={};
 void s.ended.then(()=>{ended=true;});
 let stopAmmo=()=>{};
 const off=s.onTick(()=>{const p=st()?.player;hpMin=Math.min(hpMin,hp());
  if(sessionDied(p0,p))died=true;});
 const over=()=>ended||died||(!cleanup&&!!o.stop?.())||s.tick()-start>=o.cap;
 let snapshot:Item[]=[];let initial:Item[]|undefined;
 const capture=()=>{const b=s.bankObservation?.();if(!b)throw Error('ranged-train bank observation unknown');snapshot=b.items.map(i=>({id:i.id,count:i.count}));};
 const owned=():Item[]=>[...snapshot,...inv(),...eq()].map(i=>({id:i.id,count:i.count}));
 const stored=(id:number)=>count(snapshot,id);
 const open=async()=>{if(!st()?.bank?.isOpen){const g=s.bankObservation?.()?.generation??0;if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!st()?.bank?.isOpen&&(s.bankObservation?.()?.generation??0)>g,{timeoutTicks:15}))throw Error('ranged-train fresh bank unavailable');}capture();};
 const close=async()=>{await s.bot.closeBank();if(!await waitUntil(s,()=>!st()?.bank?.isOpen,{timeoutTicks:5}))throw Error('ranged-train bank close unobserved');};
 const withdraw=async(id:number,amount:number)=>{if(amount<=0)return;const item=st()?.bank?.items.find(i=>i.id===id);if(!item||item.count<amount)throw Error('ranged-train prerequisite: owned stock short '+id);const before=held(id),bankBefore=stored(id),g=s.bankObservation!()!.generation;await s.bot.withdrawItem(item,amount,{asNote:false});if(!await waitUntil(s,()=>held(id)===before+amount&&(s.bankObservation?.()?.generation??0)>g&&count(s.bankObservation!()!.items,id)===bankBefore-amount,{timeoutTicks:10}))throw Error('ranged-train withdrawal effect unknown '+id);capture();};
 const deposit=async(ids:readonly number[])=>{for(const id of new Set(inv().filter(i=>ids.includes(i.id)&&i.count>0).map(i=>i.id)))await depositObserved(s,inv().find(i=>i.id===id)!);capture();};
 const equip=async(id:number)=>{const item=inv().find(i=>i.id===id);if(!item)throw Error('ranged-train equip input absent '+id);const before=sum(inv(),ARROW_IDS)+sum(eq(),ARROW_IDS);await s.bot.equipItem(item);if(!await waitUntil(s,()=>count(eq(),id)>0,{timeoutTicks:10})||(ARROW_IDS.includes(id)&&sum(inv(),ARROW_IDS)+sum(eq(),ARROW_IDS)!==before))throw Error('ranged-train equip effect unknown '+id);};
 const unequip=async(ids:readonly number[])=>{for(const item of eq().filter(i=>ids.includes(i.id))){await s.bot.unequipItem(item);if(!await waitUntil(s,()=>!eq().some(i=>i.id===item.id),{timeoutTicks:10}))throw Error('ranged-train unequip unobserved '+item.id);}};
 const sustain=startQuestSustain({sdk:s.sdk,tick:()=>s.tick(),onTick:cb=>s.onTick(cb),ended:s.ended,direct:async action=>{
  const reply=await s.direct(action);
  return {success:!!reply&&typeof reply==='object'&&'success' in reply&&reply.success===true};
 }},{food:[329,333,1985],eatAt:12,onConsumed:effect=>{eaten++;foodConsumed[effect.id]=(foodConsumed[effect.id]??0)+1;}});
 const heal=async()=>{if(sustain.failure())throw Error(sustain.failure()!);if(hp()<=6&&!held(foodId))throw Error('ranged-train food exhausted below retreat floor');};
 const base=await sessionWalker(s);
 const guarded={...base,walk:async(x:number,z:number)=>{await heal();const p=base.pos();if(!p||p.level!==0)throw Error('ranged-train walk plane unknown');const path=base.plan(0,p,{x,z}),last=path.at(-1);if(Math.max(Math.abs(p.x-x),Math.abs(p.z-z))>1&&(!last||Math.max(Math.abs(last.x-x),Math.abs(last.z-z))>1))throw Error('ranged-train incomplete route refused');if(expandPath(p,path).some(t=>t.x<3250&&t.z>=3350&&t.z<=3390))throw Error('ranged-train dark-wizard corridor refused');return base.walk(x,z);}};
 const walk=async(points:PathPoint[])=>{const r=await walkPath(guarded,points,{look:4,maxTicks:500,stop:over});if(!r.ok)throw Error('ranged-train route failed '+r.detail);};
 const near=(t:{x:number;z:number},tol:number)=>{const p=st()?.player;return !!p&&p.level===0&&Math.max(Math.abs(p.worldX-t.x),Math.abs(p.worldZ-t.z))<=tol;};
 const ground=()=>st()?.groundItems??[];
 const pickup=async(id:number,x:number,z:number,required=true)=>{const item=ground().find(i=>i.id===id&&i.x===x&&i.z===z),before=held(id);if(!item){if(required)throw Error('ranged-train fresh loot missing '+id);return 0;}await s.bot.pickupItem(item);const observed=await waitUntil(s,()=>held(id)>before||over(),{timeoutTicks:8});if(over())throw Error('ranged-train pickup stopped');if(!observed&&required)throw Error('ranged-train pickup effect missing '+id);return Math.max(0,held(id)-before);};
 // Shared trip search and execution; exclude consumable teleports so fares are the only travel debit.
 type Stop={x:number;z:number};
 const same=(a:Stop,b:Stop)=>a.x===b.x&&a.z===b.z;
 const mainlandFood=entry.x===BANK.x&&entry.z===BANK.z;
 const foodRoute=(from:Stop,to:Stop)=>mainlandFood&&(same(from,BANK)&&same(to,WYDIN)||same(from,WYDIN)&&same(to,BANK));
 const tripAccount=()=>{const actor=accountOf(s);return{...actor,skills:{...actor.skills,magic:0},items:[],counts:{},worn:[],coins:coins()};};
 // The route worker starts cold and closes 30 s after its last plan, so a food-run leg that plans alone waits some
 // hundreds of ticks. A trip queues the legs known to follow it; travel from that stop takes the ready plan, or plans again if it is null.
 const queued:{from:Stop;to:Stop;plan:ReturnType<typeof planTripOffThread>}[]=[];
 const queue=(from:Stop,to:Stop)=>{if(foodRoute(from,to)||queued.some(q=>same(q.from,from)&&same(q.to,to)))return;const plan=planTripOffThread({...from,level:0},{...to,level:0},tripAccount());plan.catch(()=>{});queued.push({from,to,plan});};
 const travel=async(to:Stop,next:readonly (readonly [Stop,Stop])[]=[])=>{
  const p=st()?.player;if(!p)throw Error('ranged-train travel state unknown');
  const corridor=p.level===0&&(near(BANK,6)&&foodRoute(BANK,to)?FOOD_OUT:near(WYDIN,2)&&foodRoute(WYDIN,to)?FOOD_BACK:null);
  if(corridor){
   if(over()||sustain.failure()||hp()<=6)throw Error('ranged-train travel deadline/health/stop');
   const wallet=coins();await walk(corridor);const paid=wallet-coins();travelSpent+=paid;coinsSpent+=paid;
   if(over()||!near(to,2)||paid!==0)throw Error('ranged-train mainland food walk effect/stop/fare unobserved');
   return;
  }
  const i=queued.findIndex(q=>same(q.to,to)&&p.level===0&&Math.max(Math.abs(p.worldX-q.from.x),Math.abs(p.worldZ-q.from.z))<=2);
  const ready=i<0?undefined:queued.splice(i,1)[0]!.plan.catch(()=>null);
  const fresh=()=>planTripOffThread({x:p.worldX,z:p.worldZ,level:p.level},{...to,level:0},tripAccount());
  const first=ready??fresh();for(const [a,b] of next)queue(a,b);
  const plan=(await first)??(ready?await fresh():null);
  if(over()||sustain.failure()||hp()<=6)throw Error('ranged-train travel deadline/health/stop');
  if(!plan||plan.bank||plan.legs.some(l=>l.kind==='travel'&&(l.travel.runes.length||l.travel.needs.some(n=>'held' in n))))throw Error('ranged-train funded travel unavailable');
  const fare=routeFares(plan.legs),wallet=coins();if(fare>preparationFunds(sum(owned(),[COINS]),coinsSpent,o.maxSpend,o.coinReserve)||fare>wallet)throw Error('ranged-train travel budget refused');
  const ac=new AbortController(),offTravel=s.onTick(()=>{if(over()||sustain.failure()||hp()<=6)ac.abort('ranged-train travel deadline/health/stop');});
  try{const r=await walkRoute(s,plan.legs,{signal:ac.signal,legTimeoutTicks:100,maxRetriesPerLeg:1});
   const paid=wallet-coins();travelSpent+=paid;coinsSpent+=paid;
   if(!r.ok||!near(to,2)||paid!==fare)throw Error('ranged-train travel effect/fare unobserved '+JSON.stringify(r));
  }finally{offTravel();}
 };
 const fund=async()=>{const amount=preparationFunds(sum(owned(),[COINS]),coinsSpent,o.maxSpend,o.coinReserve);await withdraw(COINS,Math.min(stored(COINS),Math.max(0,amount-coins())));coinsWithdrawn++;};
 const stageFood=async()=>{
  const available=[o.foodId,333,329,1985].find(id=>count(owned(),id)>=o.food);
  if(available){foodId=available;return;}
  // Pinned wydinstore: cheese1985 stock3. Observe the actual shelf before choosing or buying.
  foodId=1985;const need=Math.max(0,o.food-count(owned(),foodId));
  await fund();await close();await travel(WYDIN,[[WYDIN,BANK]]);
  if(!(await s.bot.openShop(/^wydin$/i)).success||!await waitUntil(s,()=>!!st()?.shop?.isOpen,{timeoutTicks:10}))throw Error('ranged-train food shop unavailable');
  const shelf=st()?.shop?.shopItems.find(i=>i.id===foodId);
  console.log('RANGED_TRAIN_FOOD_STOCK '+JSON.stringify(shelf??null));
  if(!shelf||shelf.count<need)throw Error('ranged-train prerequisite: food stock short');
  const r=await buyWithBudget(s.bot,s.sdk,shelf.name,need,0,preparationFunds(sum(owned(),[COINS]),coinsSpent,o.maxSpend,o.coinReserve));
  foodBought+=r.bought;foodPurchases[foodId]=(foodPurchases[foodId]??0)+r.bought;foodSpent+=r.spent;coinsSpent+=r.spent;
  if(r.bought!==need||r.spent<=0)throw Error('ranged-train food purchase unobserved');
  await s.bot.closeShop();if(!await waitUntil(s,()=>!st()?.shop?.isOpen,{timeoutTicks:5}))throw Error('ranged-train food shop close unobserved');
  await travel(BANK);await open();await deposit([foodId,COINS]);bankReady=true;
 };
 // Bank is open. Buys at Lowe only within MAX_SPEND, then returns and banks the arrows and coins.
 const restock=async(bowReq:number)=>{
  if(o.buyArrows<=0||o.maxSpend<=coinsSpent)return;
  const wanted=Math.min(o.buyArrows,Math.max(0,o.minArrows-sum(owned(),usableArrows(bowReq,level()))));if(!wanted)return;
  const arrow=ARROWS.find(a=>a.id===o.buyArrowId)!;if(arrow.req>bowReq||arrow.req>level())throw Error('ranged-train prerequisite: bought arrow unusable with chosen bow');
  const funds=Math.min(stored(COINS),preparationFunds(sum(owned(),[COINS]),coinsSpent,o.maxSpend,o.coinReserve));if(funds<=0)return;
  const before=coins();await withdraw(COINS,funds);coinsWithdrawn+=coins()-before;await close();
  shopVisits++;await walk([{...LOWE,tol:2}]);
  if(!await openShopWithDoor(s.bot,/^lowe$/i,()=>waitUntil(s,()=>!!st()?.shop?.isOpen,{timeoutTicks:10})))throw Error('ranged-train Lowe shop unavailable');
  let got=0;
  for(let round=0;round<30&&got<wanted&&!over();round++){
   const shelf=st()?.shop?.shopItems.find(i=>i.id===arrow.id);if(!shelf)throw Error('ranged-train Lowe stock line missing '+arrow.id);
   const amount=Math.min(10,wanted-got,shelf.count);if(amount<=0)break;
   const wallet=coins(),pack=held(arrow.id);await buyWithBudget(s.bot,s.sdk,shelf.name,amount,0,preparationFunds(sum(owned(),[COINS]),coinsSpent,o.maxSpend,o.coinReserve));
   if(!await waitUntil(s,()=>held(arrow.id)>pack,{timeoutTicks:10}))break;
   const n=held(arrow.id)-pack,paid=wallet-coins();if(paid<=0||n<=0)throw Error('ranged-train purchase effect unobserved');
   got+=n;bought+=n;coinsSpent+=paid;if(coinsSpent>o.maxSpend||sum(owned(),[COINS])<o.coinReserve)throw Error('ranged-train shop budget violated');
  }
  await s.bot.closeShop();if(!await waitUntil(s,()=>!st()?.shop?.isOpen,{timeoutTicks:5}))throw Error('ranged-train shop close unobserved');
  console.log('RANGED_TRAIN_BUY '+JSON.stringify({id:arrow.id,bought:got,coinsSpent,coins:coins(),tick:s.tick()}));
  await walk([{...BANK,tol:1}]);await open();await deposit([arrow.id,...(coinsWithdrawn>0?[COINS]:[])]);
 };
 try{
  // The bank is unread here, so the food-run legs are queued in case the bank holds too little food.
  if(!near(entry,6))await travel(entry,[[entry,WYDIN],[WYDIN,BANK]]);
  await open();initial=[...snapshot,...entryItems];
  await deposit(inv().map(i=>i.id));
  if(sum(owned(),[COINS])<o.coinReserve)throw Error('ranged-train prerequisite: coin reserve short');
  await stageFood();
  if(!near(BANK,4)){await fund();await close();await travel(BANK);await open();await deposit([COINS]);}
  bankReady=true;
  for(trips=0;trips<o.maxTrips&&level()<o.target&&!over();){
   await deposit([BONES,CHICKEN,FEATHER,...ARROW_IDS]);
   const bow=o.kit?BOWS.find(b=>b.id===o.kit!.bow&&b.req<=level()&&count(owned(),b.id)>0):bestBow(owned(),level());if(!bow)throw Error('ranged-train prerequisite: no owned bow usable at Ranged '+level());
   if(sum(owned(),usableArrows(bow.req,level()))<o.minArrows)await restock(bow.req);
   const arrow=o.kit?usableArrows(bow.req,level()).includes(o.kit.arrow)&&count(owned(),o.kit.arrow)>=MIN_TRIP_ARROWS?{id:o.kit.arrow,count:count(owned(),o.kit.arrow)}:undefined:chooseArrow(owned(),bow.req,level());if(!arrow){stop='ammo-short';break;}
   if(count(owned(),foodId)<o.food)await stageFood();
   const food=Math.max(0,o.food-held(foodId));if(stored(foodId)<food)throw Error('ranged-train prerequisite: stage unnoted food '+foodId);
   // Bow, quiver stack, food, two displaced melee items, two non-stacking drops per kill and feathers.
   if(28-inv().length<2*o.killsPerTrip+5+food)throw Error('ranged-train prerequisite: pack needs loot and unequipped-kit slots');
   if(!count(eq(),bow.id)&&!held(bow.id))await withdraw(bow.id,1);
   await withdraw(arrow.id,Math.min(o.ammo,stored(arrow.id)));await withdraw(foodId,food);await close();
   if(st()?.autoRetaliateEnabled)await s.direct({type:'clickComponent',componentId:151,reason:'Ranged exact target XP: auto-retaliate OFF'});if(!await waitUntil(s,()=>st()?.autoRetaliateEnabled===false,{timeoutTicks:8}))throw Error('ranged-train auto-retaliate OFF unobserved');
   if(!count(eq(),bow.id))await equip(bow.id);
   if(held(arrow.id)>0)await equip(arrow.id);
   await s.sdk.sendSetCombatStyle(1);
   if(!await waitUntil(s,()=>{const c=st()?.combatStyle;return !!c?.known&&c.currentStyle===1&&c.styles.some(i=>i.index===1&&i.trainsSkills.length===1&&i.trainsSkills[0]==='Ranged');},{timeoutTicks:10}))throw Error('ranged-train rapid style unobserved');
   bowUsed=bow.id;arrowUsed=arrow.id;trips++;
   // Observe a prepared trip only: bank transfers are not shots.
   stopAmmo();let lastAmmo=sum(inv(),ARROW_IDS)+sum(eq(),ARROW_IDS);
   stopAmmo=s.onTick(()=>{const a=sum(inv(),ARROW_IDS)+sum(eq(),ARROW_IDS);shots+=Math.max(0,lastAmmo-a);lastAmmo=a;});
   console.log('RANGED_TRAIN_TRIP '+JSON.stringify({trip:trips,bow:bow.id,arrow:arrow.id,ammo:lastAmmo,level:level(),tick:s.tick()}));
   await walk(OUT);if(!near(PEN,0))throw Error('ranged-train coop entry unobserved');
   let tripKills=0,lostTargets=0,lastProgress=s.tick(),penReturn=false;
   while(tripKills<o.killsPerTrip&&lostTargets<5&&level()<o.target&&!over()&&s.tick()-start<o.cap-500){
    await heal();if(sum(inv(),ARROW_IDS)+sum(eq(),ARROW_IDS)<3)break;
    if(held(arrow.id)>0)await equip(arrow.id);
    const target=selectRangedTarget(st()?.nearbyNpcs??[],st()?.player?.level);
    // A chase or pickup can leave the account east of pen gate 1551 (3236,3296), where no chicken is selectable.
    // Walk back to the pen entry once per empty streak, then wait for a respawn.
    if(!target){if(s.tick()-lastProgress>120)throw Error('ranged-train no target progress');if(!penReturn&&!near(PEN,0)){penReturn=true;await walk([{...PEN,tol:0}]);continue;}await waitTicks(s,1);continue;}
    if(target.distance>5)await walk([{x:target.tileX??target.x,z:target.tileZ??target.z,tol:3}]);
    const fresh=st()?.nearbyNpcs.find(n=>n.index===target.index&&n.id===target.id);if(!fresh||fresh.inCombat)continue;
    const stacks=()=>{const m=new Map<string,number>();for(const i of ground())m.set(`${i.id}:${i.x}:${i.z}`,(m.get(`${i.id}:${i.x}:${i.z}`)??0)+i.count);return m;};
    const beforeXp=xp(),beforeGround=stacks();
    const attackStarted=s.tick();let x=fresh.tileX??fresh.x,z=fresh.tileZ??fresh.z,seenXp=xp(),gone=false,goneAt=0,credited=false,retries=0,lastAttack=attackStarted;
    await s.bot.attack(fresh);lastProgress=s.tick();
    while(!over()&&s.tick()-start<o.cap-500){
     // The tile freezes at disappearance: the same NPC index can respawn on another tile.
     await heal();const current=gone?undefined:st()?.nearbyNpcs.find(n=>n.index===target.index&&n.id===target.id);if(current){x=current.tileX??current.x;z=current.tileZ??current.z;}else if(!gone){gone=true;goneAt=s.tick();}
     if(xp()>seenXp){seenXp=xp();lastProgress=s.tick();}
     const delta=(id:number)=>count(ground().filter(i=>i.x===x&&i.z===z),id)-(beforeGround.get(`${id}:${x}:${z}`)??0);
     if(s.tick()-attackStarted>180)throw Error('ranged-train engagement exceeds admitted regen budget');
     if(rangedCredit(gone,xp()-beforeXp,delta(BONES),delta(CHICKEN),s.tick()-attackStarted)){credited=true;break;}
     // Missing loot is bounded apart from XP and before the pinned 50-tick respawn; expiry counts only a lost target.
     if(gone&&s.tick()-goneAt>=LOOT_WINDOW){
      const appeared=[...stacks()].filter(([k,n])=>[BONES,CHICKEN].some(id=>k.startsWith(id+':'))&&n>(beforeGround.get(k)??0)).map(([k,n])=>`${k}+${n-(beforeGround.get(k)??0)}`);
      console.log('RANGED_TRAIN_LOST '+JSON.stringify({index:target.index,id:target.id,attackTick:attackStarted,goneAt,tick:s.tick(),tile:{x,z},xp:xp()-beforeXp,bones:delta(BONES),chicken:delta(CHICKEN),appeared}));
      break;
     }
     if(current&&!gone&&s.tick()-lastProgress>=8&&s.tick()-lastAttack>=8&&retries<3){retries++;lastAttack=s.tick();await s.bot.attack(current);}
     if(s.tick()-lastProgress>120)throw Error('ranged-train combat/credit stalled');await waitTicks(s,1);
    }
    if(!credited){lostTargets++;continue;}
    bonesPicked+=await pickup(BONES,x,z,false);chickenPicked+=await pickup(CHICKEN,x,z,false);kills++;tripKills++;lastProgress=s.tick();penReturn=false;
    if(ground().some(i=>i.id===FEATHER&&i.x===x&&i.z===z))await pickup(FEATHER,x,z,false);
    for(const item of ground().filter(i=>i.id===arrow.id&&i.distance<=7&&i.x>=3220&&i.x<=3248&&i.z>=3280&&i.z<=3310).slice(0,4))picked+=await pickup(item.id,item.x,item.z,false);
    console.log('RANGED_TRAIN_KILL '+JSON.stringify({kills,level:level(),xp:xp()-startXp,ammo:sum(inv(),ARROW_IDS)+sum(eq(),ARROW_IDS),picked,hp:hp(),tick:s.tick()}));
    if(o.kit?count(owned(),o.kit.arrow)<MIN_TRIP_ARROWS:bestBow(owned(),level())?.id!==bow.id||chooseArrow(owned(),bow.req,level())?.id!==arrow.id)break;
   }
   stopAmmo();
   if(over())break;
   await walk(BACK);if(!near(BANK,4))throw Error('ranged-train bank return unobserved');await open();
  }
  if(level()>=o.target)stop='target-level';else if(o.stop?.())stop='stop-file';else if(trips>=o.maxTrips&&stop==='cap')stop='max-trips';
 }catch(e){failure=String(e);}
 finally{
  stopAmmo();cleanup=true;
  await sustain.settle();if(sustain.failure())failure=[failure,sustain.failure()].filter(Boolean).join('; ');
  if(!ended&&!died&&initial)try{
   if(st()?.shop?.isOpen)await s.bot.closeShop();
   if(st()?.bank?.isOpen)await close();
   if(!near(BANK,4)){if(!bankReady)await travel(entry);else if((st()?.player?.worldZ??0)<3380)await walk(BACK);else await walk([{...BANK,tol:1}]);}
   await unequip([...ARROW_IDS,...BOW_IDS]);
   for(const id of originalEquipment)if(!eq().some(i=>i.id===id))await equip(id);
   await open();await deposit([...BOW_IDS,...ARROW_IDS,foodId,BONES,CHICKEN,FEATHER,...(coinsWithdrawn>0?[COINS]:[])]);await close();
   if(st()?.autoRetaliateEnabled!==originalRetaliate){await s.direct({type:'clickComponent',componentId:originalRetaliate?150:151,reason:'restore original auto-retaliate'});if(!await waitUntil(s,()=>st()?.autoRetaliateEnabled===originalRetaliate,{timeoutTicks:8}))throw Error('ranged-train auto-retaliate restore unobserved');}
  }catch(e){failure=[failure,'cleanup '+String(e)].filter(Boolean).join('; ');}
  off();
 }
 const final=owned(),total=(items:readonly Item[]|undefined,id:number)=>count(items??[],id);
 const arrows=arrowAccount(sum(initial??[],ARROW_IDS),bought,sum(final,ARROW_IDS),shots);
 const coinDebit=total(initial,COINS)-total(final,COINS);
 const loot=new Set([BONES,CHICKEN,FEATHER,329,333,1985,COINS,...ARROW_IDS]);
 const preserved=!!initial&&[...new Set([...initial.map(i=>i.id),...final.map(i=>i.id)])].every(id=>loot.has(id)||total(initial,id)===total(final,id));
 const equipmentRestored=JSON.stringify(eq().map(i=>i.id).sort())===JSON.stringify([...originalEquipment].sort());
 const accounting=!!initial&&arrows.ok&&coinDebit===coinsSpent&&coinsSpent<=o.maxSpend&&total(final,COINS)>=o.coinReserve&&[329,333,1985].every(id=>total(final,id)===total(initial,id)+(foodPurchases[id]??0)-(foodConsumed[id]??0))&&total(final,BONES)-total(initial,BONES)===bonesPicked&&total(final,CHICKEN)-total(initial,CHICKEN)===chickenPicked;
 const targetMet=level()>=o.target;
 return{ok:!failure&&!died&&!ended&&targetMet&&preserved&&accounting&&equipmentRestored,targetMet,stop,targetLevel:o.target,startLevel,finalLevel:level(),xpGain:xp()-startXp,
  bow:bowUsed,arrow:arrowUsed,trips,kills,bonesPicked,chickenPicked,shots,picked,arrowsSpent:arrows.spent,arrowsBought:bought,coinsSpent,coinDebit,foodId,foodBought,foodSpent,foodPurchases,foodConsumed,travelSpent,shopVisits,eaten,hpMin,hp:hp(),died,
  ticks:s.tick()-start,preserved,accounting,equipmentRestored,failure:failure||'-'};
}
// A disconnect mid-trip leaves the account on the route or in the coop with the bow and quiver worn. Walk back to
// Varrock East bank and take them off first, so the bounded run starts from a supported entry instead of refusing every retry.
// Kandarin accounts recover to Ardougne North bank (already a rangedEntry) so zero-coin recovery walks avoid White Wolf Mountain.
export function recoveryBank(p:{worldX:number;worldZ:number;level:number}){
 return p.worldX<2850?{x:2619,z:3332}:BANK;
}
export function needsRangedRecovery(p:{worldX:number;worldZ:number;level:number},worn:readonly number[]){
 return !rangedEntry(p)||worn.some(id=>BOW_IDS.includes(id)||ARROW_IDS.includes(id));
}
// The recovery leg runs before the run's budget and asset snapshot exist, so it is walk-only: no Magic, carried or
// banked items, worn gear or coins, hence no teleport, supply withdrawal or fare. A stop request aborts the route.
export function recoveryWalker(actor:Account):Account{return{...actor,skills:{...actor.skills,magic:0},items:[],counts:{},worn:[],coins:0};}
export async function recoverRangedStart(s:Session,stop:()=>boolean=()=>false){
 const st=()=>s.sdk.getState(),eq=()=>s.sdk.getEquipment();
 if(!await waitUntil(s,()=>!!st()?.player&&!!s.client&&equipmentObserved(s.client),{timeoutTicks:20}))throw Error('ranged-train prerequisite: position/equipment unobserved');
 const p=st()!.player!;if(!needsRangedRecovery(p,eq().map(i=>i.id)))return null;
 const from={x:p.worldX,z:p.worldZ,level:p.level};
 if(stop())return{from,stopped:true};
 if(!rangedEntry(p)){
  const abort=new AbortController(),off=s.onTick(()=>{if(stop()&&!abort.signal.aborted)abort.abort('stop requested');});
  let r:Awaited<ReturnType<typeof goTo>>;
  try{r=await goTo(s,await getWorld(),{...recoveryBank(p),level:0},recoveryWalker(accountOf(s)),{legTimeoutTicks:100,signal:abort.signal});}finally{off();}
  if(stop())return{from,stopped:true};
  if(!r.ok)throw Error('ranged-train recovery walk failed '+JSON.stringify(r));
 }
 for(const item of eq().filter(i=>BOW_IDS.includes(i.id)||ARROW_IDS.includes(i.id))){
  await s.bot.unequipItem(item);if(!await waitUntil(s,()=>!eq().some(i=>i.id===item.id),{timeoutTicks:10}))throw Error('ranged-train recovery unequip unobserved '+item.id);
 }
 console.log('RANGED_TRAIN_RECOVERY '+JSON.stringify({from,to:st()?.player?{x:st()!.player!.worldX,z:st()!.player!.worldZ}:null,tick:s.tick()}));
 return{from,stopped:false};
}
export function rangedComparisonMethod(value:string|undefined,server:string):'chickens'|'troopers'|undefined{
 if(!value)return;
 if(!isLocalServer(server))throw Error('Ranged comparison override requires the local practice server');
 if(value!=='chickens'&&value!=='troopers')throw Error('Unknown Ranged comparison method');
 return value;
}
// Every decision starts from this session's observed containers, never a fleet bank snapshot.
export function rangedAccountObservation(s:Session,reserve=0,now=Date.now()):ObservedAccount{
 const counts=(rows:readonly {id:number;count:number}[])=>rows.reduce<Record<number,number>>((all,i)=>(all[i.id]=(all[i.id]??0)+i.count,all),{});
 const bank=s.bankObservation?.(),p=s.sdk.getState()?.player,quests=questFlags(s.client);
 return{account:s.name,at:now,skills:Object.fromEntries(s.sdk.getSkills().map(skill=>[skill.name,{level:skill.baseLevel,xp:s.sdk.getSkillXp(skill.name)??0}])),
  inventory:{at:now,value:counts(s.sdk.getInventory())},equipment:s.client&&equipmentObserved(s.client)?{at:now,value:counts(s.sdk.getEquipment())}:null,
  bank:bank?{at:bank.at,value:counts(bank.items),generation:bank.generation}:null,
  quests:quests?{at:now,value:Object.fromEntries(quests.map(q=>[q.name,q.state==='unknown'?null:q.state==='complete']))}:null,
  position:p?{at:now,value:{x:p.worldX,z:p.worldZ,level:p.level}}:null,currentHP:s.sdk.getSkill('Hitpoints')?.level,
  reservations:reserve?{995:reserve}:{},
 };
}
const RANGED_SHOP_ACQUIRE:Record<string,{itemId:number;name:string;count:number;maxUnitCost:number;minRanged:number}>={
 'ranged/lowe-buy-shortbow':{itemId:841,name:'Shortbow',count:1,maxUnitCost:100,minRanged:1},
 'ranged/lowe-buy-oak':{itemId:843,name:'Oak shortbow',count:1,maxUnitCost:200,minRanged:5},
 'ranged/lowe-buy-bronze':{itemId:882,name:'Bronze arrow',count:100,maxUnitCost:3,minRanged:1},
 'ranged/lowe-buy-iron':{itemId:884,name:'Iron arrow',count:100,maxUnitCost:8,minRanged:1},
 'ranged/lowe-buy-steel':{itemId:886,name:'Steel arrow',count:100,maxUnitCost:24,minRanged:5},
 'ranged/guild-buy-willow':{itemId:849,name:'Willow shortbow',count:1,maxUnitCost:1000,minRanged:40},
 'ranged/guild-buy-mithril':{itemId:888,name:'Mithril arrow',count:250,maxUnitCost:192,minRanged:40},
};
const RANGED_GE_ACQUIRE=new Set(['ranged/ge-buy-willow','ranged/ge-buy-mithril','ranged/ge-buy-maple']);
const RANGED_TRAIN_METHODS=new Set(['ranged/chickens','ranged/chickens-oak','ranged/troopers','ranged/troopers-oak','ranged/troopers-willow','ranged/troopers-maple','ranged/guild-willow-mithril']);
export const isRangedAcquireMethod=(method:string|null|undefined):method is string=>!!method&&(method in RANGED_SHOP_ACQUIRE||RANGED_GE_ACQUIRE.has(method));

async function walkRangedAcquirePoint(s:Session,to:{x:number;z:number},stop?:()=>boolean){
 const p=s.sdk.getState()?.player;
 if(p&&p.level===0&&Math.max(Math.abs(p.worldX-to.x),Math.abs(p.worldZ-to.z))<=4)return true;
 const world=await getWorld();
 const out=await ferryWalk(s,{x:to.x,z:to.z,level:0},(tile,budgetMs)=>goTo(s,world,tile,recoveryWalker(accountOf(s)),{maxRetriesPerLeg:2,legTimeoutTicks:150,planBudgetMs:budgetMs}),stop);
 const cur=s.sdk.getState()?.player;
 return out.ok&&!!cur&&cur.level===0&&Math.max(Math.abs(cur.worldX-to.x),Math.abs(cur.worldZ-to.z))<=8;
}

async function executeRangedAcquireStep(s:Session,o:RangedTrainOptions,account:ObservedAccount,method:string,step:ProgressionDecision['step']|undefined,decision:ProgressionDecision,start:number){
 const level=()=>s.sdk.getSkill('Ranged')?.baseLevel??0;
 const st=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),bankItems=()=>s.bankObservation?.()?.items??[];
 const total=(id:number)=>count(inv(),id)+count(bankItems(),id)+count(s.sdk.getEquipment(),id);
 if(!st()?.bank?.isOpen){
  if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!st()?.bank?.isOpen,{timeoutTicks:15}))
   return{ok:false,acquired:false,targetMet:false,stop:'preparation',targetLevel:o.target,finalLevel:level(),xpGain:0,ticks:s.tick()-start,method,decision,coinsSpent:0,coinDebit:0,arrowsSpent:0,failure:'ranged acquire bank unavailable'};
 }
 const totalCoins=total(COINS),spendEnv=Number(step?.env?.MAX_SPEND??o.maxSpend);
 const spendCap=Number.isFinite(spendEnv)&&spendEnv>=0?Math.min(o.maxSpend,spendEnv):o.maxSpend;
 const budget=preparationFunds(totalCoins,0,spendCap,o.coinReserve);
 if(method in RANGED_SHOP_ACQUIRE){
  const spec=RANGED_SHOP_ACQUIRE[method]!;
  if(level()<spec.minRanged)return{ok:false,acquired:false,targetMet:false,stop:'preparation',targetLevel:o.target,finalLevel:level(),xpGain:0,ticks:s.tick()-start,method,decision,coinsSpent:0,coinDebit:0,arrowsSpent:0,failure:`progression requires Ranged ${spec.minRanged} for ${method}`};
  const maxEnv=Number(step?.env?.MAX_ITEMS);
  const wanted=Number.isSafeInteger(maxEnv)&&maxEnv>0?Math.min(spec.count,maxEnv):spec.count;
  const minNeed=Math.min(spec.maxUnitCost,totalCoins);
  if(budget<spec.maxUnitCost&&budget<1){
   await s.bot.closeBank();
   return{ok:false,acquired:false,targetMet:false,stop:'preparation',targetLevel:o.target,finalLevel:level(),xpGain:0,ticks:s.tick()-start,method,decision,coinsSpent:0,coinDebit:0,arrowsSpent:0,failure:`ranged acquire budget short for ${spec.name}: budget=${budget} min=${minNeed}`};
  }
  const p=st()?.player,hicktonItems=[841,843,882,884];
  const useDargaud=method.startsWith('ranged/guild-');
  const useHickton=!useDargaud&&!!p&&p.worldX<2850&&hicktonItems.includes(spec.itemId);
  const shop=useDargaud?{npc:/^bow and arrow salesman$/i,spot:{x:2673,z:3434},bank:{x:2727,z:3492}}
   :useHickton?{npc:/^hickton$/i,spot:{x:2821,z:3444},bank:{x:2809,z:3441}}
   :{npc:/^lowe$/i,spot:LOWE,bank:BANK};
  const packCoins=count(inv(),COINS),needWithdraw=Math.max(0,budget-packCoins);
  let withdrawn=0;
  if(needWithdraw>0&&count(bankItems(),COINS)>0){
   const amt=Math.min(needWithdraw,count(bankItems(),COINS));
   if(amt>0){
    const beforeW=count(inv(),COINS);
    await s.bot.withdrawItem({id:COINS,name:'Coins',count:amt,slot:0} as any,amt);
    await waitUntil(s,()=>count(inv(),COINS)>beforeW,{timeoutTicks:8});
    withdrawn=Math.max(0,count(inv(),COINS)-beforeW);
   }
  }
  await s.bot.closeBank();await waitUntil(s,()=>!st()?.bank?.isOpen,{timeoutTicks:5});
  if(o.stop?.())return{ok:false,acquired:false,targetMet:false,stop:'stop-file',targetLevel:o.target,finalLevel:level(),xpGain:0,ticks:s.tick()-start,method,decision,coinsSpent:0,coinDebit:0,arrowsSpent:0};
  const beforeWalkOut=total(COINS);
  const walked=await walkRangedAcquirePoint(s,shop.spot,o.stop);
  const fareOut=Math.max(0,beforeWalkOut-total(COINS));
  let bought=0,spent=0;
  if(walked&&!o.stop?.()){
   if(await openShopWithDoor(s.bot,shop.npc,()=>waitUntil(s,()=>!!st()?.shop?.isOpen,{timeoutTicks:10}))){
    const wallet=count(inv(),COINS),allowed=Math.min(Math.max(0,budget-fareOut),wallet);
    if(allowed>0){
     const res=await buyWithBudget(s.bot,s.sdk,spec.name,wanted,Math.max(0,wallet-allowed),allowed);
     bought=res.bought;spent=res.spent;
    }
    await s.bot.closeShop();await waitUntil(s,()=>!st()?.shop?.isOpen,{timeoutTicks:5});
   }
  }
  const beforeWalkBack=total(COINS);
  await walkRangedAcquirePoint(s,shop.bank,o.stop);
  const fareBack=Math.max(0,beforeWalkBack-total(COINS)),travelSpent=fareOut+fareBack;
  if((await s.bot.openBank()).success&&await waitUntil(s,()=>!!st()?.bank?.isOpen,{timeoutTicks:12})){
   for(const id of [spec.itemId,...(withdrawn>0||spent>0||travelSpent>0?[COINS]:[])]){
    for(const slot of inv().filter(i=>i.id===id))await s.bot.depositItem(slot as any,slot.count);
   }
   await waitTicks(s,1);
   await s.bot.closeBank();await waitUntil(s,()=>!st()?.bank?.isOpen,{timeoutTicks:5});
  }
  const coinsAfter=total(COINS),debit=Math.max(0,totalCoins-coinsAfter);
  const reconciled=coinsAfter>=o.coinReserve&&debit<=o.maxSpend&&debit===spent+travelSpent;
  const ok=bought>0&&reconciled&&!o.stop?.();
  return{ok,acquired:ok,targetMet:false,stop:ok?'acquire':'preparation',targetLevel:o.target,finalLevel:level(),xpGain:0,ticks:s.tick()-start,method,decision,
   coinsSpent:debit,coinDebit:debit,travelSpent,arrowsSpent:0,bow:BOW_IDS.includes(spec.itemId)?spec.itemId:0,arrow:ARROW_IDS.includes(spec.itemId)?spec.itemId:0,
   ...(ok?{}:{failure:bought===0?`ranged acquire unavailable or empty stock for ${spec.name}`:'ranged acquire coin reconciliation mismatch'})};
 }
 // GE acquire (willow shortbow, mithril arrows, maple shortbow).
 const itemId=Number(step?.env?.ITEM_ID??(method==='ranged/ge-buy-willow'?849:method==='ranged/ge-buy-maple'?853:888));
 const limitPrice=Number(step?.env?.LIMIT_PRICE??(itemId===849?2500:itemId===853?4000:120));
 const reqQty=Number(step?.env?.QUANTITY??1);
 const maxQty=limitPrice>0?Math.min(reqQty,Math.floor(budget/limitPrice)):0;
 await s.bot.closeBank();await waitUntil(s,()=>!st()?.bank?.isOpen,{timeoutTicks:5});
 if(!Number.isSafeInteger(itemId)||!Number.isSafeInteger(limitPrice)||limitPrice<=0||maxQty<=0)
  return{ok:false,acquired:false,targetMet:false,stop:'preparation',targetLevel:o.target,finalLevel:level(),xpGain:0,ticks:s.tick()-start,method,decision,coinsSpent:0,coinDebit:0,arrowsSpent:0,failure:`ranged GE acquire budget short for ${method}`};
 const server=s.lifecycle?.server??'local',now=Date.now();
 const expectedOwned=step?.env?.EXPECTED_OWNED!==undefined?Number(step.env.EXPECTED_OWNED):undefined;
 let goal=`ranged-acquire-${itemId}`,journalPath=orderPaths(server,s.name,goal).journal,reused:ItemRequest|undefined;
 for(let seq=0;seq<50&&existsSync(journalPath);seq++){
  try{
   const prev=JSON.parse(readFileSync(journalPath,'utf8'));
   if(prev?.version===1&&['placing','open','cancelling','collecting'].includes(prev.phase)&&prev.request?.item===itemId&&prev.request?.actor?.toLowerCase()===s.name.toLowerCase()){
    reused=prev.request as ItemRequest;
    break;
   }
  }catch{}
  goal=`ranged-acquire-${itemId}-${seq+1}`;
  journalPath=orderPaths(server,s.name,goal).journal;
 }
 const req:ItemRequest=reused??{actor:s.name,server,goal,item:itemId,quantity:maxQty,...(expectedOwned!==undefined?{expectedOwned}:{}),limit:limitPrice,reserve:o.coinReserve,createdAt:now,reviewAt:now+60_000,deadline:now+300_000};
 const res=await runOwnedItem(s,req,journalPath,()=>!!o.stop?.(),false,100);
 const coinsAfter=total(COINS),debit=Math.max(0,totalCoins-coinsAfter);
 const ok=res.acquired>0&&coinsAfter>=o.coinReserve&&debit<=o.maxSpend&&!o.stop?.();
 return{ok,acquired:ok,targetMet:false,stop:ok?'acquire':'preparation',targetLevel:o.target,finalLevel:level(),xpGain:0,ticks:s.tick()-start,method,decision,
  coinsSpent:debit,coinDebit:debit,arrowsSpent:0,bow:BOW_IDS.includes(itemId)?itemId:0,arrow:ARROW_IDS.includes(itemId)?itemId:0,
  ...(ok?{}:{failure:res.failure??`ranged GE acquire unfilled for ${method}`})};
}

async function runAdaptiveRangedBand(s:Session,o:RangedTrainOptions,options:{comparison?:'chickens'|'troopers';decision?:ProgressionDecision}={}){
 const start=s.tick(),generation=s.bankObservation?.()?.generation??0;
 if(s.sdk.getState()?.bank?.isOpen)await s.bot.closeBank();
 if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!s.sdk.getState()?.bank?.isOpen&&(s.bankObservation?.()?.generation??0)>generation,{timeoutTicks:20}))
  throw Error('adaptive Ranged needs a fresh bank observation');
 const account=rangedAccountObservation(s,o.coinReserve),methods=rangedProgressionMethods(account,o.target);
 const coins=Object.values([account.bank,account.inventory,account.equipment]).reduce((n,b)=>n+(b?.value[COINS]??0),0);
 if(coins<o.coinReserve)throw Error('ranged-train prerequisite: coin reserve short');
 const localDecision=options.decision??chooseProgression({kind:'train',skill:'Ranged',targetLevel:o.target},account,methods,{now:Date.now()});
 let decision=localDecision;
 if(!options.decision&&s.lifecycle?.domain==='live'){
  const live=s.progression?.refresh('Ranged fresh bank');
  if(!live?.decision)throw Error('adaptive Ranged live progression decision unavailable');
  decision=live.decision;
 }
 console.log('RANGED_PROGRESSION '+JSON.stringify(decision));
 const method=options.comparison?'ranged/'+options.comparison:decision.path[0]?.method??decision.selected;
 const step=decision.path[0]?.step??decision.step;
 if(!options.comparison&&isRangedAcquireMethod(method)&&(decision.state==='acquire'||decision.state==='execute'))
  return executeRangedAcquireStep(s,o,account,method,step,decision,start);
 if(!options.comparison&&(decision.state==='acquire'||decision.state==='qualify')&&!method&&!rangedKit(account)){
  const starterMethod=localDecision.path[0]?.method??localDecision.selected;
  if(isRangedAcquireMethod(starterMethod))return executeRangedAcquireStep(s,o,account,starterMethod,localDecision.path[0]?.step??localDecision.step,decision,start);
 }
 await s.bot.closeBank();
 if(!await waitUntil(s,()=>!s.sdk.getState()?.bank?.isOpen,{timeoutTicks:5}))throw Error('adaptive Ranged bank close unobserved');
 if(decision.state==='complete')return{ok:true,targetMet:true,stop:'target-level',targetLevel:o.target,finalLevel:account.skills.Ranged!.level,xpGain:0,ticks:s.tick()-start,method:null,decision};
 if(!options.comparison&&(decision.state!=='execute'||!method||!RANGED_TRAIN_METHODS.has(method)))
  return{ok:false,targetMet:false,stop:'preparation',targetLevel:o.target,finalLevel:account.skills.Ranged?.level??0,xpGain:0,ticks:s.tick()-start,method,decision,failure:'progression requires '+decision.state};
 const remaining=o.cap-(s.tick()-start);if(remaining<800)throw Error('adaptive Ranged preparation exhausted the finite cap');
 const kit=rangedKit(account);if(!kit)throw Error('adaptive Ranged selected kit unavailable');
 const policyStep=decision.path[0]?.step??decision.step,declaredTarget=Number(policyStep?.env.TARGET_LEVEL??policyStep?.args[0]??o.target);
 if(!Number.isSafeInteger(declaredTarget)||declaredTarget<1||declaredTarget>99)throw Error('adaptive Ranged policy target unknown');
 const bandTarget=Math.min(rangedBandTarget(account,o.target),declaredTarget);
 s.progression?.executing(method!);
 if(method==='ranged/chickens'||method==='ranged/chickens-oak'){
  const r=await runRangedTrain(s,{...o,target:bandTarget,cap:remaining,kit});
  return{...r,ticks:s.tick()-start,method,decision,bandTarget};
 }
 // A closed bank has no current observation. Retain only this finite run's fresh snapshot across travel.
 let bankSnapshot=Object.entries(account.bank!.value).map(([id,count])=>({id:Number(id),count}));
 const observeBank=()=>{const observed=s.bankObservation?.();if(observed)bankSnapshot=observed.items.map(i=>({id:i.id,count:i.count}));};
 const totals=()=>{observeBank();const all=new Map<number,number>();for(const i of [...bankSnapshot,...s.sdk.getInventory(),...s.sdk.getEquipment()])all.set(i.id,(all.get(i.id)??0)+i.count);return all;};
 const offBank=s.onTick(observeBank);
 try{
 const before=totals(),coinsBefore=before.get(COINS)??0;
 const entryCoins=s.sdk.getInventory().find(i=>i.id===COINS);
 if(entryCoins){
  const g=s.bankObservation?.()?.generation??0;
  if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!s.sdk.getState()?.bank?.isOpen&&(s.bankObservation?.()?.generation??0)>g,{timeoutTicks:20}))throw Error('adaptive Ranged entry-coin bank unobserved');
  await depositObserved(s,entryCoins);await s.bot.closeBank();
  if(!await waitUntil(s,()=>!s.sdk.getState()?.bank?.isOpen,{timeoutTicks:5}))throw Error('adaptive Ranged entry-coin bank close unobserved');
 }
 // Ferry funding is the shared worker's only coin operation. Keep its withdrawal inside this order's reserve and budget.
 const guarded={...s,bot:new Proxy(s.bot,{get(bot,key){
  if(key==='closeBank')return async()=>{observeBank();return bot.closeBank();};
  if(key==='withdrawItem')return async(item:Parameters<Session['bot']['withdrawItem']>[0],amount:number,...rest:unknown[])=>{
   if(typeof item==='object'&&'id' in item&&item.id===COINS){
    const held=count(s.sdk.getInventory(),COINS),spent=coinsBefore-(totals().get(COINS)??0),available=preparationFunds(coinsBefore,spent,o.maxSpend,o.coinReserve);
    if(!Number.isSafeInteger(amount)||amount<0||held+amount>available)throw Error('adaptive Ranged fare budget refused');
   }
   return Reflect.apply(bot.withdrawItem,bot,[item,amount,...rest]);
  };
  const value=Reflect.get(bot,key);return typeof value==='function'?value.bind(bot):value;
 }})} as Session;
 const delegatedCap=o.cap-(s.tick()-start);if(delegatedCap<800)throw Error('adaptive Ranged preparation exhausted the finite cap');
 const r=await runGiants(guarded,{cap:delegatedCap,trainSkill:'Ranged',targetLevel:bandTarget,site:TROOPER_SITE,food:o.food,ammo:o.ammo,ammoPickup:true,rangedKit:kit,bury:false,stop:o.stop,
  walk:async(x,z,tol=2,signal)=>{
   if(o.stop?.())return false;
   const out=await ferryWalk(guarded,{x,z,level:0},async(tile,planBudgetMs)=>goTo(guarded,await getWorld(),tile,recoveryWalker(accountOf(s)),{maxRetriesPerLeg:2,legTimeoutTicks:150,signal,planBudgetMs}),o.stop);
   const p=s.sdk.getState()?.player;return out.ok&&!!p&&p.level===0&&Math.max(Math.abs(p.worldX-x),Math.abs(p.worldZ-z))<=tol;
  },
 });
 const after=totals(),coinDebit=coinsBefore-(after.get(COINS)??0),coinAccounted=Number.isSafeInteger(coinDebit)&&coinDebit>=0&&coinDebit<=o.maxSpend&&(after.get(COINS)??0)>=o.coinReserve;
 const variable=new Set([COINS,...TROOPER_SITE.foods,...r.ammoId===undefined?[]:[r.ammoId]]);
 const preserved=r.preserved&&[...new Set([...before.keys(),...after.keys()])].every(id=>variable.has(id)||before.get(id)===after.get(id));
 // The shared worker permits useful partial runs. This target order accepts only the requested level.
 return{...r,ok:r.ok&&r.targetMet&&preserved&&coinAccounted,preserved,targetMet:r.targetMet,targetLevel:bandTarget,xpGain:r.selectedXp,ticks:s.tick()-start,method,decision,bandTarget,
  bow:s.sdk.getEquipment().find(i=>BOW_IDS.includes(i.id))?.id??0,arrow:r.ammoId??0,arrowsSpent:r.ammoUsed??0,
  accounting:r.foodAccounted&&preserved&&coinAccounted,coinsSpent:coinDebit,coinDebit,travelSpent:coinDebit};
 }finally{offBank();}
}
export async function runAdaptiveRanged(s:Session,o:RangedTrainOptions,options:{comparison?:'chickens'|'troopers';decision?:ProgressionDecision}={}){
 const start=s.tick(),startXp=s.sdk.getSkillXp('Ranged'),startLevel=s.sdk.getSkill('Ranged')?.baseLevel;
 if(startXp===null||startXp===undefined||!startLevel)throw Error('adaptive Ranged skill observation unknown');
 const recovery=await recoverRangedStart(s,o.stop);if(recovery?.stopped)throw Error('stop file during Ranged entry recovery');
 const segments:Awaited<ReturnType<typeof runAdaptiveRangedBand>>[]=[];
 const spent=()=>segments.reduce((n,r)=>n+('coinsSpent' in r?r.coinsSpent:0),0);
 for(let band=0;band<12;band++){
  const before=s.sdk.getSkill('Ranged')!.baseLevel,remaining=o.cap-(s.tick()-start);
  if(remaining<800||o.stop?.())break;
  if(band){
   if(s.sdk.getState()?.bank?.isOpen)await s.bot.closeBank();
   const recovery=await recoverRangedStart(s,o.stop);if(recovery?.stopped)break;
  }
  const r=await runAdaptiveRangedBand(s,{...o,cap:remaining,maxSpend:Math.max(0,o.maxSpend-spent())},options);segments.push(r);
  if(!r.ok||s.sdk.getSkill('Ranged')!.baseLevel>=o.target||(!('acquired' in r&&r.acquired)&&s.sdk.getSkill('Ranged')!.baseLevel<=before))break;
 }
 const last=segments.at(-1);if(!last)throw Error('adaptive Ranged stopped before a finite band could start');
 const finalLevel=s.sdk.getSkill('Ranged')!.baseLevel,targetMet=finalLevel>=o.target;
 const ammoDebits:Record<number,number>={};for(const r of segments)if('arrow' in r&&'arrowsSpent' in r)ammoDebits[r.arrow]=(ammoDebits[r.arrow]??0)+r.arrowsSpent;
 return{...last,ok:segments.every(r=>r.ok)&&targetMet,targetMet,targetLevel:o.target,startLevel,finalLevel,xpGain:s.sdk.getSkillXp('Ranged')!-startXp,
  ticks:s.tick()-start,coinsSpent:spent(),coinDebit:spent(),arrowsSpent:Object.values(ammoDebits).reduce((n,v)=>n+v,0),ammoDebits,
  segments:segments.map(r=>({method:r.method,target:'bandTarget' in r?r.bandTarget:o.target,ok:r.ok,xpGain:r.xpGain,ticks:r.ticks})),
 };
}
if(import.meta.main){
 let stopped=false;const s=await openBot(process.argv[2]!,{onStop:async()=>{stopped=true;}});
 try{const comparison=rangedComparisonMethod(process.env.RANGED_COMPARE_METHOD,s.lifecycle?.server??new URL(s.sdk.config.browserLaunchUrl).host);
  const r=await runAdaptiveRanged(s,{...rangedTrainOptions(process.env,process.argv),stop:()=>stopped},{comparison});console.log('RANGED_TRAIN_RESULT '+JSON.stringify(r));
  await finish([s],r.ok,(r.ok?'mode=ranged-train ':r.stop==='stop-file'?'stop file ':'no Ranged progress: ')+JSON.stringify(r));}
 catch(e){await finish([s],false,'no Ranged progress: '+String(e));}
}
