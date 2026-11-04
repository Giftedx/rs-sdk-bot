// bun scripts/magic-order.ts <account>
// TARGET_LEVEL (2..99, required), MAX_CASTS=1000, CAP=6000 ticks, RUNE_BUDGET=0 coins, CASH_RESERVE=0 coins.
// RANDOM_EVENTS=0 turns off the shared random-event handler in openBot. The server comes from the account's bot.env.
// Source decision: scripts/measure/floor-teleport.ts wind strike dispatch -> this worker. Adapt: that CLI logs in at
// module load, so the {type:'spellOnNpc'} literal is restated with the shared componentId. Pinned
// magic_combat_spells.dbrow magic_spell_wind_strike: level 1, 1 mind + 1 air, 55 tenths XP. player_magic.rs2
// pvm_spell_cast deletes the runes and gives the XP on the cast tick, so one cast is one observed debit of each rune
// plus a Magic XP rise. Shop: scripts/shop-buyer.ts PROFILES.aubury, maximumUnitCost and buyWithBudget (reuse).
// Routes: scripts/train-chickens.ts chickenTrainingProfile legs (reuse, danger-checked in that source).
// Acceptance belongs to packages/practice/src/magic-order-proof.ts.
import {openBot,finish,randomEventsOf,getWorld,accountOf} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks,waitUntil,type TickSource} from '../packages/core/src/ticks';
import {walkPath,sessionWalker,goTo,type PathPoint} from '../packages/core/src/walk';
import {depositObserved} from '../packages/core/src/deposit';
import {componentId} from '../packages/core/src/logout';
import {equipmentObserved} from '../packages/core/src/container-observation';
import {PROFILES,buyWithBudget,maximumUnitCost} from './shop-buyer';
import {chickenTrainingProfile} from './train-chickens';
import {startQuestSustain,questFoodDefinitions,selectQuestFood} from './quest-sustain';
import {loadTravel} from '../packages/core/src/travel';
import {LUMBRIDGE_TO_DRAYNOR} from './courier-route';

export const AIR=556,MIND=558,COINS=995;
export const TELE_RUNE_IDS={air:AIR,mind:MIND,earth:557,water:555,fire:554,law:563} as const;
export type Rune=keyof typeof TELE_RUNE_IDS;
export type RuneCounts=Record<Rune,number>;
export const TELEPORTS=[
 {name:'camelot',level:45,xp:55.5,members:true},
 {name:'falador',level:37,xp:48,members:false},
 {name:'lumbridge',level:31,xp:41,members:false},
 {name:'varrock',level:25,xp:35,members:false},
].map(t=>{
 const component=`magic:${t.name}_teleport`,edge=loadTravel().find(e=>e.run.how==='spell'&&e.run.component===component);
 if(!edge)throw Error(`missing teleport travel ${component}`);
 const costs=Object.fromEntries(Object.keys(TELE_RUNE_IDS).map(k=>[k,edge.runes.find(r=>r.item===`${k}rune`)?.count??0])) as RuneCounts;
 return {...t,component,to:edge.to,costs};
});
export type Teleport=typeof TELEPORTS[number];
// Only the observed right-hand staff substitutes. Unknown member access excludes Camelot.
export function teleportCosts(t:Teleport,worn:readonly {slot:number;id:number}[],members=false):RuneCounts{
 const costs={...t.costs};
 const staff=worn.find(i=>i.slot===3)?.id;
 const substitutes:Record<number,Rune>={1381:'air',1383:'water',1385:'earth',1387:'fire',1397:'air',1395:'water',1399:'earth',1393:'fire',1405:'air',1403:'water',1407:'earth',1401:'fire'};
 if(staff!==undefined&&(staff<=1387||members)&&substitutes[staff])costs[substitutes[staff]!]=0;
 return costs;
}
export function selectTeleport(level:number,target:number,owned:RuneCounts,worn:readonly {slot:number;id:number}[]=[],members=false){
 if(level>=target)return undefined;
 return TELEPORTS.find(t=>level>=t.level&&(!t.members||members)&&Object.entries(teleportCosts(t,worn,members)).every(([k,n])=>owned[k as Rune]>=n));
}
const SHOP_RUNES=['air','mind','earth','water','fire'] as const;
// Base spell XP gives an upper bound without assuming the server's XP multiplier.
// Owned law runes and MAX_CASTS bound the batch; Aubury cannot supply laws.
export function teleportShortfall(xp:number,target:number,maxCasts:number,t:Teleport,costs:RuneCounts,owned:RuneCounts):RuneCounts{
 const casts=Math.min(castsNeeded(xp,target,t.xp,maxCasts),costs.law?Math.floor(owned.law/costs.law):maxCasts);
 return Object.fromEntries(Object.keys(TELE_RUNE_IDS).map(k=>[k,Math.max(0,casts*costs[k as Rune]-owned[k as Rune])])) as RuneCounts;
}
export function teleportPurchaseCost(missing:RuneCounts,stock:readonly {id:number;count:number;baseCost:number}[],config:{sellMultiplier:number}|undefined,allowance:number){
 if(missing.law>0)return null;
 let total=0;
 for(const k of SHOP_RUNES){
  if(!missing[k])continue;
  const item=stock.find(i=>i.id===TELE_RUNE_IDS[k]);
  if(!item||item.count<missing[k]||missing[k]>1000)return null;
  total+=missing[k]*maximumUnitCost(item,config);
 }
 return total<=allowance?total:null;
}
export function purchaseEffect(rune:Rune,requested:number,before:RuneCounts&{coins:number},after:RuneCounts&{coins:number},got:{bought:number;spent:number},allowance:number){
 return got.bought===requested&&requested>0&&got.spent>0&&got.spent<=allowance&&before.coins-after.coins===got.spent
  &&(Object.keys(TELE_RUNE_IDS) as Rune[]).every(k=>after[k]-before[k]===(k===rune?requested:0));
}
export function teleportEffect(t:Teleport,costs:RuneCounts,before:RuneCounts&{xp:number},after:RuneCounts&{xp:number},position:{x:number;z:number;level:number}):CastEffect{
 const deltas=Object.keys(TELE_RUNE_IDS).map(k=>before[k as Rune]-after[k as Rune]);
 if(deltas.every(n=>n===0)&&after.xp===before.xp)return 'none';
 if(deltas.some((n,i)=>n<0||n>costs[Object.keys(TELE_RUNE_IDS)[i] as Rune]))return 'invalid';
 return deltas.every((n,i)=>n===costs[Object.keys(TELE_RUNE_IDS)[i] as Rune])&&after.xp>before.xp
  &&position.level===t.to.level&&Math.max(Math.abs(position.x-t.to.x),Math.abs(position.z-t.to.z))<=2?'cast':'partial';
}
export const WIND_STRIKE={level:1,air:1,mind:1,xp:5.5,component:'magic:wind_strike'} as const;
type Tile={x:number;z:number};
export const BANKS={draynor:{x:3092,z:3243},varrockWest:{x:3185,z:3436},varrockEast:{x:3253,z:3420}} as const;
// The banks the Falador and Camelot teleport cleanup ends at (the walks in the cleanup below).
export const CLEANUP_BANKS={falador:{x:2946,z:3370},seers:{x:2725,z:3491}} as const;
// research/route-danger.ts: Varrock East bank -> 3244,3407 and Varrock West bank -> 3244,3407 pass 0 aggressive
// spawns (margin 3). The shop door 3253,3398 passes 7 tiles from the mugger at 3249,3391 (reach 8). The mugger
// (all.npc: strength 5, strengthbonus -21) and the men and women here hit at most 1, so an HP10 account survives
// inside the food and hurt floors below.
export const CAST_SITE={x:3244,z:3407,tol:2};
export const TARGET_AREA={x0:3228,x1:3250,z0:3393,z1:3415};
export const TARGET_NAMES=/^(man|woman|mugger)$/i;
// A struck mugger retaliates, so it is a target only when no free man or woman is in the area.
export const PREFERRED_TARGETS=/^(man|woman)$/i;
export const AUBURY={npc:PROFILES.aubury!.npc,outside:{x:3253,z:3398,tol:1},inside:{x:PROFILES.aubury!.npcSpot.x,z:PROFILES.aubury!.npcSpot.z,tol:1}};
// HP floors for an account whose attackers hit at most 1: eat at 6, stop with the hurt failure at 5 without food,
// and at 3 even with food. A stopped account walks at most 30 tiles to a bank while it is still attacked.
export const HEALTH={eatAt:6,hurtNoFood:5,critical:3};
// One cast needs the approach plus %action_delay (player_magic.rs2: map_clock + 5).
// eatTicks is the debit deadline of one eat. quietTicks bounds the wait for the logout window after the retreat.
export const CAST={effectTicks:12,missLimit:4,avoidTicks:25,targetWaitTicks:50,progressTicks:120,bankTicks:600,walkTicks:900,
 eatTicks:6,eatAttempts:3,quietTicks:200};

// Player.ts levelExperience: floor(acc/4) XP for level, acc = sum floor(l + 300*2^(l/10)).
export function magicXpForLevel(level:number){
 if(!Number.isSafeInteger(level)||level<1||level>99)throw Error('invalid Magic level');
 let acc=0;for(let l=1;l<level;l++)acc+=Math.floor(l+300*2**(l/10));
 return Math.floor(acc/4);
}
export interface MagicOptions{target:number;maxCasts:number;cap:number;budget:number;reserve:number}
export function magicOptions(env:Record<string,string|undefined>=process.env):MagicOptions{
 const int=(key:string,fallback:number|undefined,min:number,max:number)=>{
  const raw=env[key],n=raw===undefined||raw===''?fallback:Number(raw);
  if(n===undefined||!Number.isSafeInteger(n)||n<min||n>max)throw Error(`invalid ${key}`);return n;
 };
 return{target:int('TARGET_LEVEL',undefined,2,99),maxCasts:int('MAX_CASTS',1000,1,100000),cap:int('CAP',6000,1,1000000),
  budget:int('RUNE_BUDGET',0,0,1_000_000_000),reserve:int('CASH_RESERVE',0,0,2_000_000_000)};
}
export function magicPreflight(o:Pick<MagicOptions,'target'>,level:number,plane:number){
 if(!Number.isSafeInteger(level)||level<1)return 'Magic state unknown';
 if(level>=o.target)return 'already at target';
 if(plane!==0)return 'off plane 0';
 return null;
}
const d8=(a:Tile,b:Tile)=>Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z));
export type Region='draynor'|'varrock-west'|'varrock-east'|'varrock'|'falador'|'seers';
// Supported starts: a checked bank, anywhere in central Varrock (an interrupted cast or shop visit), or a bank a
// teleport cleanup ends at (Falador, Seers), from which the shared route planner walks to Varrock East bank first.
export function startRegion(p:{x:number;z:number;level:number}):Region|null{
 if(p.level!==0)return null;
 if(d8(p,BANKS.draynor)<=8)return 'draynor';
 if(d8(p,BANKS.varrockWest)<=6)return 'varrock-west';
 if(d8(p,BANKS.varrockEast)<=6)return 'varrock-east';
 if(d8(p,CLEANUP_BANKS.falador)<=6)return 'falador';
 if(d8(p,CLEANUP_BANKS.seers)<=6)return 'seers';
 return p.x>=3170&&p.x<=3270&&p.z>=3380&&p.z<=3450?'varrock':null;
}
// Draynor bank -> Varrock East bank: the Draynor chicken leg up to 3200,3310, then the Varrock leg from 3200,3348
// (both legs from chickenTrainingProfile; rune-supply.ts uses the same 3089,3320 tile adjustment).
export function draynorToVarrock():PathPoint[]{
 const draynor=chickenTrainingProfile('draynor').route.map(p=>p.x===3088&&p.z===3320?{x:3089,z:3320,tol:1}:p);
 const east=chickenTrainingProfile('varrock').route;
 return[...draynor.slice(1,-1),...east.slice(0,-2).reverse()];
}
export function spendAllowance(budget:number,spent:number,coins:number,reserve:number){
 return Math.max(0,Math.min(budget-spent,coins-reserve));
}
export interface CastObservation{magic:number;hp:number}
// A cast without Hitpoints XP dealt no damage, so its Magic gain is the spell's base XP at this server's rate.
// Without such a cast the smallest gain is an upper bound on base XP; a later purchase covers any shortfall.
export function baseXpEstimate(casts:readonly CastObservation[]):number|null{
 const clean=casts.filter(c=>c.hp===0).map(c=>c.magic),all=casts.map(c=>c.magic);
 const pick=clean.length?clean:all;
 return pick.length?Math.min(...pick):null;
}
// Casts still needed. Before any observed cast, plan one cast only: its effect sets the estimate.
export function castsNeeded(xp:number,target:number,base:number|null,castsLeft:number){
 const missing=magicXpForLevel(target)-xp;
 if(missing<=0||castsLeft<=0)return 0;
 if(base===null||!(base>0))return 1;
 return Math.min(castsLeft,Math.ceil(Math.round(missing*10)/Math.round(base*10)));
}
export function runeShortfall(casts:number,air:number,mind:number,airCost:number=WIND_STRIKE.air){
 return{air:Math.max(0,casts*airCost-air),mind:Math.max(0,casts*WIND_STRIKE.mind-mind)};
}
// Largest cast count up to `casts` whose missing runes fit the allowance at the worst-case shop unit costs.
export function affordablePurchase(casts:number,air:number,mind:number,unit:{air:number;mind:number},allowance:number,airCost:number=WIND_STRIKE.air){
 for(let n=casts;n>0;n--){
  const s=runeShortfall(n,air,mind,airCost);
  if((s.air&&s.air*unit.air)+(s.mind&&s.mind*unit.mind)<=allowance)return{casts:n,...s};
 }
 return{casts:0,air:0,mind:0};
}
export type CastEffect='cast'|'none'|'partial'|'invalid';
export function classifyCast(before:{air:number;mind:number;xp:number},after:{air:number;mind:number;xp:number},airCost:number=WIND_STRIKE.air):CastEffect{
 const air=before.air-after.air,mind=before.mind-after.mind,xp=after.xp>before.xp;
 if(air===0&&mind===0&&!xp)return 'none';
 if(air===airCost&&mind===WIND_STRIKE.mind&&xp)return 'cast';
 if(air<0||mind<0||air>airCost||mind>WIND_STRIKE.mind)return 'invalid';
 return 'partial';
}
type Npc={index:number;name:string;x:number;z:number;distance:number;hp:number|null;inCombat:boolean;targetIndex?:number;reachable?:boolean;optionsWithIndex?:{text:string;opIndex:number}[]};
// The engaged NPC first (single-way combat refuses any other), then the nearest free man or woman, then a mugger.
export function pickTarget(npcs:readonly Npc[],engaged:number,avoid:ReadonlySet<number>,ownPlayer?:number){
 const A=TARGET_AREA;
 const fit=(n:Npc)=>TARGET_NAMES.test(n.name)&&(n.hp===null||n.hp>0)&&n.reachable!==false
  &&n.x>=A.x0&&n.x<=A.x1&&n.z>=A.z0&&n.z<=A.z1&&(n.optionsWithIndex??[]).some(o=>/^attack$/i.test(o.text));
 const own=npcs.find(n=>(n.index===engaged||Number.isSafeInteger(ownPlayer)&&n.inCombat&&n.targetIndex===32768+ownPlayer!)&&fit(n));
 if(own)return own;
 const free=npcs.filter(n=>fit(n)&&!n.inCombat&&!avoid.has(n.index)).sort((a,b)=>a.distance-b.distance);
 return free.find(n=>PREFERRED_TARGETS.test(n.name))??free[0];
}
// The worker eats only between casts, never while a cast waits for its effect. levelup.rs2 opens a chat modal
// (if_openchat), and OpHeldHandler runs the eat as a protected script, which Player.canAccess refuses while a modal
// is open or the player is delayed. That refusal is silent, so each eat closes the modal first and counts only on a
// debit of one food. A dropped eat is sent again, at most `attempts` times.
export interface EatEffect{id:number;before:number;after:number;hpBefore:number;hpAfter:number;attempts:number}
export async function eatBetweenCasts(s:TickSource&{direct(action:{type:string;[k:string]:unknown}):Promise<unknown>},
 o:{food:readonly number[];eatAt:number;timeoutTicks:number;attempts:number}):Promise<EatEffect|null>{
 const count=(id:number)=>(s.sdk.getState()?.inventory??[]).filter((i:{id:number})=>i.id===id).reduce((n:number,i:{count:number})=>n+i.count,0);
 const hp=()=>s.sdk.getState()?.skills?.find((k:{name:string})=>k.name==='Hitpoints')?.level??0;
 const modal=(st:any)=>!!st?.dialog?.isOpen||!!st?.modalOpen;
 if(!selectQuestFood(s.sdk.getState(),{food:o.food,eatAt:o.eatAt}))return null;
 let last:{id:number;before:number}|undefined;
 for(let attempt=1;attempt<=o.attempts;attempt++){
  if(modal(s.sdk.getState())){
   await s.direct({type:'closeModal',reason:'SDK'});
   if(!await waitUntil(s,st=>!modal(st),{timeoutTicks:o.timeoutTicks}))continue;
  }
  const choice=selectQuestFood(s.sdk.getState(),{food:o.food,eatAt:o.eatAt});
  if(!choice)return null;
  const id=choice.item.id,before=count(id),hpBefore=hp();last={id,before};
  const reply=await s.direct({type:'useInventoryItem',slot:choice.item.slot,optionIndex:choice.opIndex,reason:'SDK'}) as {success?:boolean;message?:string}|undefined;
  if(reply&&reply.success===false)throw Error(`eat refused: ${reply.message??'unknown'}`);
  if(await waitUntil(s,()=>count(id)!==before,{timeoutTicks:o.timeoutTicks})){
   if(count(id)!==before-1)throw Error(`food debit invalid: item${id} ${before}->${count(id)}`);
   return{id,before,after:count(id),hpBefore,hpAfter:hp(),attempts:attempt};
  }
 }
 throw Error(`food debit unobserved before the next cast: ${o.attempts} eats, item${last?.id??'?'} ${last?.before??'?'}->${last?count(last.id):'?'}`);
}
// logout.rs2:27 combat_preventlogout: each hit on the player (auto_retaliate.rs2:2) blocks logout for 16 ticks.
export const LOGOUT_QUIET_TICKS=17;
export function logoutQuiet(now:number,lastHit:number,inCombat:boolean){return !inCombat&&now-lastHit>=LOGOUT_QUIET_TICKS;}
// Before logout: the retreat walk ends the player's own attack, then the wait runs until no hit lands for the
// logout window. `between` eats while waiting. The result is observed, never assumed.
export async function awaitLogoutQuiet(s:TickSource,o:{lastHit:()=>number;retreat:()=>Promise<void>;between:()=>Promise<unknown>;timeoutTicks:number}){
 let ended=false;void s.ended?.then(()=>{ended=true;});
 const start=s.tick(),quiet=()=>logoutQuiet(s.tick(),o.lastHit(),!!s.sdk.getState()?.player?.combat?.inCombat);
 if(quiet())return{quiet:true,retreated:false,ticks:0};
 await o.retreat();
 while(!ended&&!quiet()&&s.tick()-start<o.timeoutTicks){await o.between();await waitTicks(s,1);}
 return{quiet:quiet(),retreated:true,ticks:s.tick()-start};
}
const AIR_STAFF=/^(staff of air|air battlestaff|mystic air staff)$/i;

export interface MagicResult{ok:boolean;stop:string;target:number;level:number;casts:number;runesUsed:{air:number;mind:number};
 bought:{air:number;mind:number};coinsSpent:number;magicXpGained:number;hpXpGained:number;hpMin:number;eats:number;
 missing?:{air:number;mind:number};banked?:{air:number;mind:number;coins:number};failure?:string;ticks:number;
 teleportRunesUsed?:RuneCounts;teleportRunesBought?:RuneCounts}

export async function runMagicOrder(s:Session,o:MagicOptions,stopRequested:()=>boolean=()=>false):Promise<MagicResult>{
 const start=s.tick();let ended=false;void s.ended.then(()=>{ended=true;});
 const state=()=>s.sdk.getState(),pos=()=>state()?.player;
 const pack=(id:number)=>s.sdk.getInventory().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const runeCounts=(count:(id:number)=>number)=>Object.fromEntries(Object.entries(TELE_RUNE_IDS).map(([k,id])=>[k,count(id)])) as RuneCounts;
 const banked=(id:number)=>(s.bankObservation?.()?.items??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const magicXp=()=>s.sdk.getSkillXp('Magic')??NaN,hpXp=()=>s.sdk.getSkillXp('Hitpoints')??NaN;
 const level=()=>s.sdk.getSkill('Magic')?.baseLevel??0,hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
 const at=()=>{const p=pos();return p?{x:p.worldX,z:p.worldZ,level:p.level}:null;};
 const food=[...questFoodDefinitions().keys()],foodHeld=()=>s.sdk.getInventory().some(i=>food.includes(i.id));
 const r:MagicResult={ok:false,stop:'entry',target:o.target,level:0,casts:0,runesUsed:{air:0,mind:0},bought:{air:0,mind:0},
  coinsSpent:0,magicXpGained:0,hpXpGained:0,hpMin:0,eats:0,ticks:0};
 const ready=()=>{const p=pos(),m=s.sdk.getSkill('Magic'),h=s.sdk.getSkill('Hitpoints');
  return !!p&&p.worldX>0&&!!m&&m.baseLevel>0&&!!h&&h.baseLevel>0&&Number.isFinite(magicXp())&&Number.isFinite(hpXp())&&Array.isArray(state()?.inventory)
   // The air-rune cost reads the worn staff, so equipment must be the server's packet, not the empty default.
   &&!!s.client&&typeof s.client==='object'&&equipmentObserved(s.client);};
 if(!await waitUntil(s,ready,{timeoutTicks:30})){r.stop='entry';r.failure='entry state unobserved';return r;}
 const xp0=magicXp(),hpXp0=hpXp();r.level=level();r.hpMin=hp();
 const project=(list:{slot:number;id:number;count:number}[])=>list.map(({slot,id,count})=>({slot,id,count}));
 console.log('MAGIC_ORDER_INITIAL '+JSON.stringify({name:s.name,options:o,tick:s.tick(),position:at(),hp:hp(),hpBase:s.sdk.getSkill('Hitpoints')?.baseLevel,
  magic:{level:level(),xp:xp0},pack:{air:pack(AIR),mind:pack(MIND),coins:pack(COINS)},inventory:project(s.sdk.getInventory()),equipment:project(s.sdk.getEquipment())}));
 const refusal=magicPreflight(o,level(),pos()!.level);
 if(refusal){r.stop=refusal;r.ticks=s.tick()-start;return r;}
 let region=startRegion(at()!);
 if(!region){r.stop='unsupported start region';r.failure=`no checked route from ${JSON.stringify(at())}`;return r;}
 const airCost=s.sdk.getEquipment().some(i=>AIR_STAFF.test(i.name))?0:WIND_STRIKE.air;
 // `moved` turns on at the first withdrawal. A refusal before it leaves every item in place.
 let stop:string|undefined,eats=0,coinsWithdrawn=0,entryCoins=0,spent=0,bankOpen=false,moved=false;
 // Sustain watches the account life only (eatAt 0 never selects food). Its own eat could land mid-cast or under the
 // level-up modal, so the worker eats itself between casts.
 const sustain=startQuestSustain({sdk:s.sdk,tick:()=>s.tick(),onTick:cb=>s.onTick(cb),ended:s.ended,
  direct:async action=>await s.direct(action) as {success:boolean;message?:string}},{food,eatAt:0});
 const fed=async()=>{
  if(ended)return null;
  const e=await eatBetweenCasts(s,{food,eatAt:HEALTH.eatAt,timeoutTicks:CAST.eatTicks,attempts:CAST.eatAttempts});
  if(e){eats++;console.log('MAGIC_ORDER_EAT '+JSON.stringify({tick:s.tick(),...e}));}
  return e;
 };
 // Last hit taken, from the client hitsplat tick or an observed HP drop.
 let lastHit=-Infinity,hpPrev=hp();
 const offHp=s.onTick(()=>{
  const h=hp(),d=pos()?.combat?.lastDamageTick??-1;r.hpMin=Math.min(r.hpMin,h);
  if(d>=0&&d>lastHit)lastHit=d;
  if(h<hpPrev)lastHit=Math.max(lastHit,s.tick());
  hpPrev=h;
 });
 const over=()=>ended||stopRequested()||s.tick()-start>=o.cap;
 const reason=()=>ended?'session ended':stopRequested()?'stop requested':s.tick()-start>=o.cap?'cap':undefined;
 const hurt=()=>{const h=hp();return h<=HEALTH.critical||h<=HEALTH.hurtNoFood&&!foodHeld();};
 // Cleanup after a hurt stop still walks to a bank, but never below the critical floor.
 let cleanup=false;
 const unsafe=()=>cleanup?hp()<=HEALTH.critical:hurt();
 const check=()=>{
  if(ended)throw Error('session ended');
  if(sustain.failure())throw Error(sustain.failure()!);
  if(unsafe())throw Object.assign(Error(`hurt: HP ${hp()} at floor (food ${foodHeld()?'held':'none'})`),{stop:'hurt'});
 };
 const walk=async(points:PathPoint[],label:string,budget=CAST.walkTicks,stopOn=over)=>{
  check();
  const res=await walkPath(await sessionWalker(s),points,{maxTicks:budget,stop:()=>stopOn()||unsafe()||!!sustain.failure()});
  check();
  if(!res.ok){
   const why=stopOn()?reason()??'cleanup deadline':undefined;
   throw Object.assign(Error(`route refusal ${label}: ${res.detail??'walk failed'} at ${JSON.stringify(at())}`),why?{stop:why}:{});
  }
 };
 const openBank=async()=>{
  check();const generation=s.bankObservation?.()?.generation??0;
  const reply=await s.bot.openBank();
  if(!reply.success||!await waitUntil(s,()=>!!state()?.bank?.isOpen&&(s.bankObservation?.()?.generation??0)>generation,{timeoutTicks:15}))
   throw Error(`bank observation unavailable: ${reply.message??'open unobserved'}`);
  bankOpen=true;
 };
 const closeBank=async()=>{if(bankOpen){await s.bot.closeBank();bankOpen=false;}};
 const withdraw=async(id:number,n:number)=>{
  if(n<=0)return;
  const item=state()?.bank?.items.find(i=>i.id===id),stored=banked(id),held=pack(id),generation=s.bankObservation?.()?.generation??0;
  if(!item||stored<n)throw Error(`withdraw item${id}: needs ${n}, bank has ${stored}`);
  await s.bot.withdrawItem(item,n);
  if(!await waitUntil(s,()=>pack(id)===held+n&&banked(id)===stored-n&&(s.bankObservation?.()?.generation??0)>generation,{timeoutTicks:10}))
   throw Error(`withdraw debit/credit unobserved item${id}`);
 };
 const deposit=async(id:number)=>{const item=s.sdk.getInventory().find(i=>i.id===id);return item?await depositObserved(s,item):0;};
 const casts:CastObservation[]=[];
 const remaining=()=>castsNeeded(magicXp(),o.target,baseXpEstimate(casts),o.maxCasts-r.casts);
 // Leftover runes and withdrawn coins go back to the bank on every exit that can reach one safely.
 const secure=async()=>{
  const carried=(r.teleportRunesUsed?Object.values(TELE_RUNE_IDS):[AIR,MIND]).reduce((n,id)=>n+pack(id),0)+(coinsWithdrawn>0?pack(COINS):0);
  if(!moved||!carried||ended||hp()<=HEALTH.critical)return;
  cleanup=true;
  const deadline=s.tick()+CAST.bankTicks,late=()=>ended||s.tick()>=deadline;
  if(!bankOpen){
   if(s.sdk.getState()?.shop?.isOpen)await s.bot.closeShop();
   let p=at()!;
   if(r.teleportRunesUsed){
    const landing=TELEPORTS.find(t=>p.level===t.to.level&&d8(p,t.to)<=2);
    if(landing?.name==='lumbridge'){
     await walk(LUMBRIDGE_TO_DRAYNOR.map(([x,z,tol])=>({x,z,tol})),'Lumbridge to Draynor bank',CAST.bankTicks,late);p=at()!;
    }else if(landing?.name==='falador'){
     await walk([{x:2946,z:3368,tol:2},{x:2946,z:3370,tol:2}],'Falador bank',CAST.bankTicks,late);
     await openBank();
    }else if(landing?.name==='camelot'){
     await walk([{x:2726,z:3485,tol:2},{x:2725,z:3491,tol:2}],'Seers bank',CAST.bankTicks,late);
     await openBank();
    }
   }
   const home=d8(p,BANKS.draynor)<=30?BANKS.draynor:!startRegion(p)?undefined:d8(p,BANKS.varrockWest)<=6?BANKS.varrockWest:BANKS.varrockEast;
   if(!bankOpen){
   if(!home){r.failure=(r.failure?r.failure+'; ':'')+'leftover runes carried: no checked route to a bank';return;}
   if(d8(p,home)>2)await walk([{...home,tol:2}],'bank leftovers',CAST.bankTicks,late);
   await openBank();
   }
  }
  const b={air:await deposit(AIR),mind:await deposit(MIND),coins:coinsWithdrawn>0?await deposit(COINS):0};
  if(r.teleportRunesUsed)for(const id of [557,555,554,563])await deposit(id);
  r.banked=b;console.log('MAGIC_ORDER_BANKED '+JSON.stringify({tick:s.tick(),...b,bank:{air:banked(AIR),mind:banked(MIND),coins:banked(COINS)}}));
  await closeBank();
 };
 // A struck man, woman or mugger retaliates, and each hit blocks logout. The retreat walks to the checked Varrock East
 // bank (no aggressive spawn on the cast-site leg). It ignores the hurt floor, because staying keeps the fight going.
 const disengage=async()=>{
  if(ended)return;
  const q=await awaitLogoutQuiet(s,{lastHit:()=>lastHit,timeoutTicks:CAST.quietTicks,
   between:async()=>{if(!ended&&foodHeld())await fed();},
   retreat:async()=>{
    if(state()?.shop?.isOpen)await s.bot.closeShop();
    await closeBank();
    const p=at();
    if(!p||!startRegion(p)||startRegion(p)==='draynor'||d8(p,BANKS.varrockEast)<=2)return;
    const deadline=s.tick()+CAST.walkTicks;
    await walkPath(await sessionWalker(s),[{...BANKS.varrockEast,tol:2}],{maxTicks:CAST.walkTicks,stop:()=>ended||s.tick()>=deadline});
   }});
  console.log('MAGIC_ORDER_DISENGAGE '+JSON.stringify({tick:s.tick(),...q,lastHit:Number.isFinite(lastHit)?lastHit:null,position:at(),hp:hp()}));
  if(!q.quiet&&!ended)throw Error(`combat continued ${q.ticks} ticks: last hit at tick ${lastHit}, logout window not reached`);
 };
 try{
  // Entry bank: observe owned runes and coins before any purchase or cast.
  r.stop='entry-bank';
  if(region==='falador'||region==='seers'){
   const moved=await goTo(s,await getWorld(),{...BANKS.varrockEast,level:0},accountOf(s),{legTimeoutTicks:100});
   if(!moved.ok)throw Error(`no route from the ${region} cleanup bank to Varrock East bank: ${JSON.stringify(moved)}`);
   region='varrock-east';
  }
  if(region==='varrock')await walk([{...BANKS.varrockEast,tol:2}],'entry bank');
  await openBank();
  const owned={air:pack(AIR)+banked(AIR),mind:pack(MIND)+banked(MIND),coins:pack(COINS)+banked(COINS)};entryCoins=owned.coins;
  const allowance0=spendAllowance(o.budget,0,owned.coins,o.reserve);
  console.log('MAGIC_ORDER_ENTRY '+JSON.stringify({tick:s.tick(),region,position:at(),hp:hp(),magic:{level:level(),xp:xp0},owned,
   pack:{air:pack(AIR),mind:pack(MIND),coins:pack(COINS)},bank:{air:banked(AIR),mind:banked(MIND),coins:banked(COINS)},allowance:allowance0,airCost}));
  if(level()>=25){
   // UPDATE_PID reports account membership, not map_members. It only admits a bounded
   // candidate attempt. Debit, XP and destination must still prove the spell actually ran.
   let members=(s.client as {membersAccount?:number}|undefined)?.membersAccount===1;
   const worn=()=>s.sdk.getEquipment();
   const totalRunes=runeCounts(id=>pack(id)+banked(id)),availableLevel=Math.min(level(),s.sdk.getSkill('Magic')?.level??0);
   // Keep the highest funded method; only consider a shop-funded candidate when no owned cast is possible.
   const first=selectTeleport(availableLevel,o.target,totalRunes,worn(),members)
    ??(allowance0>0?TELEPORTS.find(t=>availableLevel>=t.level&&(!t.members||members)&&totalRunes.law>=teleportCosts(t,worn(),members).law):undefined);
   if(!first){r.stop='short teleport runes';await closeBank();return r;}
   const missing=teleportShortfall(magicXp(),o.target,o.maxCasts,first,teleportCosts(first,worn(),members),totalRunes);
   const shopNeeded=allowance0>0&&SHOP_RUNES.some(k=>missing[k]>0);
   r.teleportRunesUsed=runeCounts(()=>0);r.teleportRunesBought=runeCounts(()=>0);moved=true;
   // teleport.rs2 post_tele_checks destroys carried quest cargo (rum, samples, monkey, fungus).
   // Bank unrelated cargo before casting. Totals, rather than container location, remain unchanged.
   for(const id of new Set(s.sdk.getInventory().map(i=>i.id)))if(!(Object.values(TELE_RUNE_IDS) as number[]).includes(id)){
    if(over())throw Object.assign(Error(reason()??'stopped'),{stop:reason()});
    const item=s.sdk.getInventory().find(i=>i.id===id);if(item)await depositObserved(s,item);
   }
   for(const id of Object.values(TELE_RUNE_IDS))await withdraw(id,banked(id));
   if(shopNeeded){
    coinsWithdrawn=Math.min(banked(COINS),Math.max(0,allowance0-pack(COINS)));await withdraw(COINS,coinsWithdrawn);
   }
   await closeBank();r.stop='casting';
   if(shopNeeded){
    r.stop='teleport supplies';
    if(region==='draynor')await walk(draynorToVarrock(),'Draynor to Varrock East bank');
    await walk([AUBURY.outside,AUBURY.inside],'Aubury shop');
    check();
    const npc=state()?.nearbyNpcs.find(n=>AUBURY.npc.test(n.name));
    const opened=npc?await s.bot.openShop(npc):undefined;
    if(!opened?.success)throw Error('Aubury shop unavailable');
    try{
     // Shop visibility can precede its inventory rows. Observe one usable quote within the open deadline.
     await waitUntil(s,st=>{
      check();
      return over()||!!st.shop?.isOpen&&teleportPurchaseCost(missing,st.shop.shopItems,st.shop.shopConfig,
       spendAllowance(o.budget,spent,entryCoins-spent,o.reserve))!==null;
     },{timeoutTicks:10});
     check();const shop=state()?.shop;
     const allowance=spendAllowance(o.budget,spent,entryCoins-spent,o.reserve);
     const cost=shop?.isOpen?teleportPurchaseCost(missing,shop.shopItems,shop.shopConfig,allowance):null;
     console.log('MAGIC_ORDER_QUOTE '+JSON.stringify({tick:s.tick(),missing,allowance,cost,isOpen:!!shop?.isOpen,
      shelf:shop?.shopItems??[],shopConfig:shop?.shopConfig}));
     if(over())throw Object.assign(Error(reason()??'stopped'),{stop:reason()});
     if(cost===null)
      throw Error('Aubury teleport stock or budget shortfall');
     for(const k of SHOP_RUNES){
      const amount=missing[k];if(amount<=0)continue;check();
      const before={...runeCounts(pack),coins:pack(COINS)},left=spendAllowance(o.budget,spent,entryCoins-spent,o.reserve);
      const name=k[0]!.toUpperCase()+k.slice(1)+' rune';
      const got=await buyWithBudget(s.bot,s.sdk,name,amount,Math.max(0,pack(COINS)-left),left);
      const after={...runeCounts(pack),coins:pack(COINS)};
      spent+=got.spent;r.coinsSpent=spent;r.teleportRunesBought[k]+=got.bought;
      if(k==='air'||k==='mind')r.bought[k]+=got.bought;
      console.log('MAGIC_ORDER_PURCHASE '+JSON.stringify({tick:s.tick(),rune:name,requested:amount,...got,
       packBefore:before,packAfter:after,coinsAfter:after.coins,missing,allowance:left,totalSpent:spent}));
      if(!purchaseEffect(k,amount,before,after,got,left))throw Error(`${name} exact purchase accounting failed`);
     }
    }finally{await s.bot.closeShop();}
    // Leave the shop before teleporting; the landing cleanup owns the remaining bank trip.
    await walk([AUBURY.outside],'Aubury exit');r.stop='casting';
   }
   let misses=0;
   while(level()<o.target){
    if(over()){stop=reason();break;}check();
    if(r.casts>=o.maxCasts){stop='max casts';break;}
    if(randomEventsOf(s)?.busy()){await waitTicks(s,1);continue;}
    if(await fed())continue;
    const spell=selectTeleport(Math.min(level(),s.sdk.getSkill('Magic')?.level??0),o.target,runeCounts(pack),worn(),members);
    if(!spell){stop='teleport rune exhaustion';break;}
    let costs=teleportCosts(spell,worn(),members);
    if(state()?.dialog?.isOpen||state()?.modalOpen){
     await s.direct({type:'closeModal',reason:'SDK'});
     if(!await waitUntil(s,st=>!st?.dialog?.isOpen&&!st?.modalOpen,{timeoutTicks:CAST.effectTicks}))throw Error('teleport modal remained open');
    }
    if(over()){stop=reason();break;}check();
    const before={...runeCounts(pack),xp:magicXp()};
    const reply=await s.direct({type:'clickComponent',componentId:componentId(spell.component),reason:'SDK'}) as {success?:boolean}|undefined;
    if(reply?.success===false)throw Error('teleport dispatch refused');
    await waitUntil(s,()=>ended||over()||(teleportEffect(spell,costs,before,{...runeCounts(pack),xp:magicXp()},at()!)==='cast'&&pos()?.animId===-1),{timeoutTicks:CAST.effectTicks});
    check();const after={...runeCounts(pack),xp:magicXp()};let effect=teleportEffect(spell,costs,before,after,at()!);
    if(effect!=='cast'&&members&&!spell.members){
     const freeCosts=teleportCosts(spell,worn(),false);
     if(teleportEffect(spell,freeCosts,before,after,at()!)==='cast'){costs=freeCosts;members=false;effect='cast';}
    }
    if(effect==='none'&&members&&!over()){
     // A member-only candidate or staff can be refused on a free world. A clean
     // no-effect observation spends nothing. Exclude that assumption for this session.
     members=false;continue;
    }
    if(effect==='none'&&!over()&&++misses<CAST.missLimit)continue;
    if(effect!=='cast'||pos()?.animId!==-1)throw Error(`teleport effect ${effect}: ${JSON.stringify({spell:spell.name,before,after,position:at()})}`);
    misses=0;r.casts++;
    for(const k of Object.keys(TELE_RUNE_IDS) as Rune[])r.teleportRunesUsed[k]+=costs[k];
    r.runesUsed.air+=costs.air;r.runesUsed.mind+=costs.mind;
    console.log('MAGIC_ORDER_CAST '+JSON.stringify({tick:s.tick(),cast:r.casts,spell:spell.name,costs,before,after,position:at(),gain:{magic:after.xp-before.xp,hp:0},magic:{level:level(),xp:after.xp}}));
   }
   r.stop=level()>=o.target?'target':stop??'stopped';
  }else{
  const short=runeShortfall(1,owned.air,owned.mind,airCost);
  if((short.air||short.mind)&&(o.budget===0||allowance0<=0)){
   r.stop='short runes';r.missing=short;await closeBank();return r;
  }
  r.stop='withdraw';moved=true;
  await withdraw(AIR,banked(AIR));await withdraw(MIND,banked(MIND));
  coinsWithdrawn=Math.min(banked(COINS),Math.max(0,allowance0-pack(COINS)));await withdraw(COINS,coinsWithdrawn);
  await closeBank();
  r.stop='travel';
  if(region==='draynor')await walk(draynorToVarrock(),'Draynor to Varrock East bank');
  await walk([CAST_SITE],'cast site');
  const buy=async()=>{
   const need=remaining(),air=pack(AIR),mind=pack(MIND),allowance=spendAllowance(o.budget,spent,entryCoins-spent,o.reserve);
   const missing=runeShortfall(need,air,mind,airCost);
   if(allowance<=0){r.missing=missing;return false;}
   await walk([AUBURY.outside,AUBURY.inside],'Aubury shop');
   const npc=state()?.nearbyNpcs.find(n=>AUBURY.npc.test(n.name));
   const opened=npc?await s.bot.openShop(npc):undefined;
   if(!opened?.success||!await waitUntil(s,()=>!!state()?.shop?.isOpen,{timeoutTicks:10}))throw Error(`Aubury shop unavailable: ${opened?.message??'Aubury unobserved'}`);
   try{
    const shop=state()!.shop!,line=(name:string)=>shop.shopItems.find(i=>i.name.toLowerCase()===name);
    const unitOf=(name:string)=>{const l=line(name);return l&&l.count>0?maximumUnitCost(l,shop.shopConfig):Infinity;};
    const plan=affordablePurchase(need,air,mind,{air:unitOf('air rune'),mind:unitOf('mind rune')},allowance,airCost);
    if(plan.casts<=Math.min(airCost?air/airCost:Infinity,mind)){r.missing=missing;return false;}
    for(const [id,name,amount] of [[MIND,'Mind rune',plan.mind],[AIR,'Air rune',plan.air]] as const){
     if(amount<=0)continue;check();
     const before={air:pack(AIR),mind:pack(MIND),coins:pack(COINS)},left=spendAllowance(o.budget,spent,entryCoins-spent,o.reserve);
     const got=await buyWithBudget(s.bot,s.sdk,name,amount,pack(COINS)-Math.min(pack(COINS),left),left);
     spent+=got.spent;r.coinsSpent=spent;
     if(id===AIR)r.bought.air+=got.bought;else r.bought.mind+=got.bought;
     console.log('MAGIC_ORDER_PURCHASE '+JSON.stringify({tick:s.tick(),rune:name,requested:amount,bought:got.bought,spent:got.spent,
      packBefore:before,coinsAfter:pack(COINS),need,estimate:baseXpEstimate(casts),allowance:left,totalSpent:spent}));
     if(got.bought<=0)throw Error(`${name} purchase effect unobserved`);
    }
   }finally{await s.bot.closeShop();}
   await walk([AUBURY.outside,CAST_SITE],'cast site after shop');
   return true;
  };
  const avoid=new Map<number,number>();let misses=0,idle=0,lastCast=s.tick();
  const castOnce=async()=>{
   check();
   for(const [index,until] of avoid)if(s.tick()>=until)avoid.delete(index);
   const p=at()!;if(d8(p,CAST_SITE)>8)await walk([CAST_SITE],'return to cast site');
   if(state()?.dialog?.isOpen)await s.direct({type:'closeModal',reason:'SDK'});
   const combat=pos()?.combat,engaged=combat?.targetType==='npc'?combat.targetIndex:-1;
   const target=pickTarget((state()?.nearbyNpcs??[]) as Npc[],engaged,new Set(avoid.keys()),(s.client as {selfSlot?:number})?.selfSlot);
   if(!target){if(++idle>=CAST.targetWaitTicks)throw Object.assign(Error('combat stall: no safe target near the cast site'),{stop:'combat stall'});await waitTicks(s,1);return;}
   idle=0;
   if(await fed())return;
   const before={air:pack(AIR),mind:pack(MIND),xp:magicXp()},hp0=hpXp();
   const reply=await s.direct({type:'spellOnNpc',npcIndex:target.index,spellComponent:componentId(WIND_STRIKE.component),reason:'SDK'}) as {success?:boolean}|undefined;
   if(reply&&reply.success===false)throw Error(`cast dispatch refused ${JSON.stringify(reply)}`);
   await waitUntil(s,()=>ended||classifyCast(before,{air:pack(AIR),mind:pack(MIND),xp:magicXp()},airCost)!=='none',{timeoutTicks:CAST.effectTicks});
   await waitTicks(s,1);check();
   const after={air:pack(AIR),mind:pack(MIND),xp:magicXp()},effect=classifyCast(before,after,airCost);
   if(effect==='cast'){
    const gain={magic:Math.round((after.xp-before.xp)*10)/10,hp:Math.round((hpXp()-hp0)*10)/10};
    casts.push(gain);r.casts++;r.runesUsed.air+=airCost;r.runesUsed.mind++;misses=0;lastCast=s.tick();
    console.log('MAGIC_ORDER_CAST '+JSON.stringify({tick:s.tick(),cast:r.casts,target:{index:target.index,name:target.name},gain,
     magic:{level:level(),xp:after.xp},pack:{air:after.air,mind:after.mind},hp:hp(),purchased:r.bought.air+r.bought.mind>0}));
    return;
   }
   if(effect!=='none')throw Error(`cast effect ${effect}: ${JSON.stringify({before,after})}`);
   avoid.set(target.index,s.tick()+CAST.avoidTicks);
   if(++misses>=CAST.missLimit||s.tick()-lastCast>=CAST.progressTicks)
    throw Object.assign(Error(`combat stall: ${misses} casts without effect, last target ${target.name}`),{stop:'combat stall'});
  };
  r.stop='casting';
  while(level()<o.target){
   if(over()){stop=reason();break;}
   check();
   if(r.casts>=o.maxCasts){stop='max casts';break;}
   if(randomEventsOf(s)?.busy()){await waitTicks(s,1);continue;}
   if(await fed())continue;
   if(pack(MIND)<WIND_STRIKE.mind||pack(AIR)<airCost){
    if(!await buy()){stop='rune exhaustion';break;}
    continue;
   }
   await castOnce();
  }
  r.stop=level()>=o.target?'target':stop??'stopped';
  if(r.stop==='rune exhaustion'){r.missing=runeShortfall(remaining(),pack(AIR),pack(MIND),airCost);}
  }
 }catch(error){
  r.failure=String(error);r.stop=(error as {stop?:string}).stop??(ended?'session ended':'failure');
 }finally{
  try{await secure();}catch(error){r.failure=(r.failure?r.failure+'; ':'')+'secure: '+String(error);}
  try{await disengage();}catch(error){r.failure=(r.failure?r.failure+'; ':'')+'disengage: '+String(error);}
  try{await sustain.settle();}catch{}
  offHp();
 }
 r.eats=eats;r.level=level();r.magicXpGained=Math.round((magicXp()-xp0)*10)/10;r.hpXpGained=Math.round((hpXp()-hpXp0)*10)/10;
 r.ticks=s.tick()-start;
 r.ok=r.stop==='target'&&r.level>=o.target&&r.casts>0&&!r.failure&&(r.teleportRunesUsed?Object.values(TELE_RUNE_IDS):[AIR,MIND]).every(id=>pack(id)===0);
 return r;
}

if(import.meta.main){
 let s:Session|undefined,stopped=false;
 try{
  const name=process.argv[2];
  if(!name||!/^[a-z0-9]{1,12}$/i.test(name))throw Error('usage: magic-order.ts <account>');
  const o=magicOptions(process.env);
  s=await openBot(name,{onStop:async()=>{stopped=true;}});
  const r=await runMagicOrder(s,o,()=>stopped);
  console.log('MAGIC_ORDER_RESULT '+JSON.stringify(r));
  await finish([s],r.ok,`magic-order ${r.stop} level=${r.level} target=${r.target} casts=${r.casts} spent=${r.coinsSpent}${r.missing?` missing air=${r.missing.air} mind=${r.missing.mind}`:''}${r.failure?` failure=${r.failure}`:''}`);
 }catch(error){await finish(s?[s]:[],false,String(error));}
}
