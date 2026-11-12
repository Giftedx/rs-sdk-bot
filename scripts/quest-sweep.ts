// Quest sweep: run one generated quest (scripts/generated/quest-<quest>.ts) on an ordinary account from wherever it
// stands. The quest's practice preset names its start tile and pack. This runner takes the missing pack items from the
// nearest bank, walks to the start tile and hands its session to the quest script, which owns the quest, the RESULT
// line and the logout. A missing item ends the run before travel with `missing id:count` (acquisition work).
// Usage: bun scripts/quest-sweep.ts <account> <quest>      e.g. bun scripts/quest-sweep.ts Mightyrod blackknight
// tbwt/itwatchtower use owned API staging with finite options; omit options for the preset CLI.
// Trio stages inside the observed Shilo bank and reuses its protected stockade exit; full28 pack carries no ferry fare.
// Heroes uses the explicit owned-pair quest-hero-owned.ts CLI/API, never this single-account entry.
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {openBot,finish,getWorld,accountOf,finishHooks,sessionDied} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {goTo,sessionWalker,walkPath,walkRoute,type PathDeps} from '../packages/core/src/walk';
import type {World,Transport,Account} from '../packages/core/src/world';
import {combatLevel,deadly,loadHunters} from '../packages/core/src/danger';
import {loadTravel} from '../packages/core/src/travel';
import {sellersByDistance,shopSellers} from '../packages/core/src/shop-index';
import {spawnsByDistance,locsByDistance} from '../packages/core/src/spawn-index';
import {gatherPlan,gatherItems,rangedKit,magicKit,arrowsFor,castsFor,ARROWS,BOWS,NPC_SOURCES,PICK_SOURCES} from '../packages/core/src/gather';
import {questFlags} from '../packages/core/src/quest-status';
import {QUEST_NAMES} from './quest-chain';
import {PRESETS,type SaveConfig} from '../packages/practice/src/presets';
import travel from '../packages/planner/src/haggis-travel.json';
import {BotActions} from '../vendor/rs-sdk/sdk/actions';
import {runOwnedLoadout,validateOwnedKit,type OwnedKit} from './microbot-owned-loadout';
import {productionStopRequested} from './microbot-c-lifetime';
import {createShiloTransit,NATURE} from './microbot-rune-trip';
import {retainedGhostSkull,retainedGhostBankSkull,leaveGhostBasement,inGhostBasement,dashThroughDoor} from './ghost-basement-exit';
import {walkQuestCorridor} from './quest-walk';
import {crossStrongholdGate,STRONGHOLD_GATE,type GateDeps} from './agility-order';
import {crossesSea} from '../packages/core/src/spawn-index';
import {startQuestSustain,questFoodDefinitions} from './quest-sustain';
import {holdSessionEater} from '../packages/core/src/sustain';

type Item={id:number;count:number};
type Tile={x:number;z:number;level:number};
const BANKS:Tile[]=Object.values((travel as unknown as {banks:Record<string,Tile>}).banks);

export type SweepApiOptions={cap:number;prepareTicks:number;xpRate:number;maximumCasts?:number};
type ApiSweepDeps={open:typeof openBot;world:typeof getWorld;go:typeof goTo;loadout:typeof runOwnedLoadout;load:(path:string)=>Promise<Record<string,unknown>>;finish:(sessions:Session[],ok:boolean,detail:string)=>Promise<unknown>;exists:(path:string)=>boolean;stop:()=>boolean;transit:typeof createShiloTransit};
function apiOptions(quest:string,value:unknown):SweepApiOptions{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('quest sweep API requires explicit bounded options');const o=value as SweepApiOptions;
 if(Object.keys(o).some(k=>!['cap','prepareTicks','xpRate','maximumCasts'].includes(k))||![o.cap,o.prepareTicks,o.xpRate].every(Number.isSafeInteger)||o.cap<1000||o.cap>(quest==='tbwt'?15000:12000)||o.prepareTicks<200||o.prepareTicks>4000||o.xpRate<1||o.xpRate>1000||quest==='tbwt'&&(!Number.isSafeInteger(o.maximumCasts)||o.maximumCasts!<1||o.maximumCasts!>40)||quest==='itwatchtower'&&o.maximumCasts!==undefined)throw Error('quest sweep API invalid finite options');return{...o};
}
async function apiSweep(account:string,quest:'tbwt'|'itwatchtower',fresh:string|undefined,value:unknown,injected:Partial<ApiSweepDeps>){
 const o=apiOptions(quest,value),d:ApiSweepDeps={open:openBot,world:getWorld,go:goTo,loadout:runOwnedLoadout,load:path=>import(path),finish,exists:existsSync,stop:()=>false,transit:createShiloTransit,...injected};
 let signalled=false;const requested=()=>productionStopRequested(account,()=>signalled||d.stop(),d.exists)||d.exists('.practice/stop-quest-sweep');if(requested())throw Error('quest sweep API stopped before login');
 const path=resolve(import.meta.dir,'generated',`quest-${quest}-owned.ts`),m=await d.load(fresh?`${path}?${fresh}`:path),run=m[quest==='tbwt'?'runTaiBwoWannaiTrio':'runWatchtower'];if(typeof run!=='function')throw Error('quest sweep explicit API export missing');
 const pack=quest==='tbwt'?Object.entries({3150:21,3032:1,3171:1,3128:1,3164:1,401:1,379:1,558:Math.max(20,o.maximumCasts!)}).map(([id,count])=>({id:Number(id),count})):Object.entries(m.WATCH_SUPPLIES as Record<number,number>).map(([id,count])=>({id:Number(id),count}));
 const wear=(quest==='tbwt'?[[1381,3],[1540,5],[577,4],[1011,7],[579,0]]:[[1289,3],[1540,5],[1127,4],[1079,7],[1163,0]]).map(([id,slot])=>({id:id!,slot:slot!,count:1})),start:Tile=quest==='tbwt'?{x:2781,z:3086,level:0}:{x:2548,z:3118,level:0};
 validateOwnedKit({bank:BANKS[0]!,pack,wear,cap:600,maximumMoves:160});if(requested())throw Error('quest sweep API stopped before login');
 const raw=await d.open(account,{onStop:async()=>{signalled=true;}}),client=raw.client as any,owner=client?.executeBotAction,self=client?.selfSlot,initial=raw.sdk.getState()?.player,life=initial?.lifeId,respawns=initial?.respawnCount??0,began=raw.tick();let ended=false,preparing=true,ok=false,detail='quest sweep API incomplete',transit:ReturnType<typeof createShiloTransit>|undefined,departed=false,recoveryDeferred=false;const cleanupReserve=quest==='tbwt'?Math.min(600,Math.floor(o.prepareTicks/2)):0;void raw.ended.then(()=>{ended=true;});
 const own=()=>{const p=raw.sdk.getState()?.player;return !ended&&!!initial&&typeof owner==='function'&&raw.client===client&&client.executeBotAction===owner&&client.selfSlot===self&&!!p&&!p.isDead&&p.lifeId===life&&(p.respawnCount??0)===respawns;};
 const stop=()=>!own()||requested()||preparing&&raw.tick()-began>=o.prepareTicks-cleanupReserve,guard=()=>{if(!own()||raw.sdk.getStateAge()>5000)throw Error('quest sweep original client/life/input owner unavailable');};
 // Keep the receiver through SDK reconnect and BotActions door/UI awaits.
 // Helpers retain their own ordinary-stop and owned-cleanup distinction.
 const sdk=new Proxy(raw.sdk,{get(target,key,receiver){const v=Reflect.get(target,key,receiver);return typeof v==='function'?function(...args:unknown[]){if(String(key).startsWith('send'))guard();return v.apply(receiver,args);}:v;}}),s=Object.create(raw)as Session;
 Object.defineProperties(s,{sdk:{value:sdk},bot:{value:new BotActions(sdk)},direct:{value:(action:Parameters<Session['direct']>[0])=>{guard();return raw.direct(action);}}});
 const controller=new AbortController(),off=raw.onTick(()=>{if(stop())controller.abort('quest sweep preparation stop/owner/budget');});
 const position=()=>{const p=s.sdk.getState()?.player;return p&&{x:p.worldX,z:p.worldZ,level:p.level};},near=(to:Tile,tol=3)=>{const p=position();return !!p&&p.level===to.level&&Math.max(Math.abs(p.x-to.x),Math.abs(p.z-to.z))<=tol;};
 const move=async(world:World,to:Tile)=>{guard();if(stop())throw Error('quest sweep preparation stopped');const r=await d.go(s,world,to,accountOf(s),{signal:controller.signal,legTimeoutTicks:120,maxRetriesPerLeg:1});guard();if(stop()||!r.ok||!near(to))throw Error('quest sweep preparation route unconfirmed '+(r.ok?'arrival/stop':r.detail));};
 try{
  guard();if(stop())throw Error('quest sweep preparation stopped');const flags=questFlags(client),journal=flags?.find(f=>f.name===(quest==='tbwt'?'Tai Bwo Wannai Trio':'Watch Tower'));if(journal?.state!=='not started'||quest==='tbwt'&&!flags?.some(f=>f.name==='Jungle Potion'&&f.state==='complete')||client.membersAccount!==1)throw Error('quest sweep observed member/journal/prerequisite unavailable');
  if(quest==='tbwt'&&(!flags?.some(f=>f.name==='Shilo Village'&&f.state==='complete')||(s.sdk.getSkill('Prayer')?.baseLevel??0)<43||(s.sdk.getState()?.prayers.prayerPoints??0)<40||s.sdk.getSkill('Hitpoints')?.level!==s.sdk.getSkill('Hitpoints')?.baseLevel||s.sdk.getState()?.autoRetaliateEnabled!==false||s.sdk.getState()?.prayers.activePrayers.some(Boolean)))throw Error('Trio sweep requires observed Shilo access, full health, Prayer43/40 points and original all-off controls');
  const world=await d.world();guard();if(stop())throw Error('quest sweep preparation stopped');
  const exit=await leaveStronghold(s,async to=>{await move(world,to);return{ok:true};});guard();if(!exit.ok||stop())throw Error('quest sweep observed Stronghold exit unavailable');
  const at=position();if(!at)throw Error('quest sweep initial position unknown');let bank:Tile|undefined,last='';for(const candidate of (quest==='tbwt'?[NATURE.bank]:nearestBanks({...at,level:0}).slice(0,4))){try{await move(world,candidate);bank=candidate;break;}catch(e){last=String(e);if(stop()||!own())throw e;}}if(!bank)throw Error('quest sweep reachable owned bank unavailable '+last);
  const remaining=o.prepareTicks-(s.tick()-began);if(remaining<120)throw Error('quest sweep owned kit preparation budget');const kit:OwnedKit={bank,pack,wear,cap:Math.min(600,remaining),maximumMoves:160},staged=await d.loadout(s,kit,stop);guard();if(staged.ok!==true||stop())throw Error('quest sweep mandatory owned kit unconfirmed '+staged.failure);
  const totals=(rows:readonly{id:number;count:number}[])=>Object.entries(rows.reduce((a,r)=>(a[r.id]=(a[r.id]??0)+r.count,a),{}as Record<number,number>)).sort(([a],[b])=>Number(a)-Number(b));
  if(JSON.stringify(totals(s.sdk.getInventory()))!==JSON.stringify(totals(pack))||JSON.stringify(s.sdk.getEquipment().map(i=>[i.slot,i.id,i.count]).sort((a,b)=>a[0]!-b[0]!))!==JSON.stringify(wear.map(i=>[i.slot,i.id,i.count]).sort((a,b)=>a[0]!-b[0]!)))throw Error('quest sweep mandatory observed pack/wear differs');
  if(quest==='tbwt'){transit=d.transit(s,{protectMelee:true},()=>own()&&(s.sdk.getSkill('Hitpoints')?.level??0)===(s.sdk.getSkill('Hitpoints')?.baseLevel??-1));departed=true;await transit.outbound(stop);guard();if(stop())throw Error('Trio Shilo departure unconfirmed');}
  await move(world,start);guard();if(stop())throw Error('quest sweep stopped before API dispatch');off();preparing=false;
  console.log('QUEST_SWEEP_API '+JSON.stringify({quest,phase:'dispatch',start,options:o}));const result=quest==='tbwt'?await run(s,{cap:o.cap,xpRate:o.xpRate,maximumCasts:o.maximumCasts},stop):await run(s,{cap:o.cap,xpRate:o.xpRate,stop});guard();
  if(!result||typeof result.ok!=='boolean'||result.complete!==true)throw Error('quest sweep API completion unknown');ok=result.ok&&!requested();detail=JSON.stringify({quest,scope:'explicit API on mandatory owned bank kit',result});
 }catch(error){detail=`quest-sweep ${quest} ${String(error)}`;if(preparing&&departed&&transit&&own()){if(transit.pending()){recoveryDeferred=true;detail+='; Shilo crossing outcome unknown; no repeat or bank movement';}else{const cleanupStop=()=>!own()||raw.tick()-began>=o.prepareTicks||(s.sdk.getSkill('Hitpoints')?.level??0)!==(s.sdk.getSkill('Hitpoints')?.baseLevel??-1);try{await transit.returnVillage(cleanupStop);guard();if(cleanupStop()||!near(NATURE.bank,0)||s.sdk.getState()?.prayers.activePrayers[14]!==false)throw Error('Shilo bank/protection restoration unconfirmed');}catch(cleanup){recoveryDeferred=true;detail+='; Shilo cleanup '+String(cleanup);}}}}finally{off();preparing=false;}
 if(recoveryDeferred||!own()){console.log('QUEST_SWEEP_SETTLEMENT_DEFERRED '+detail);return{ok:false,recoveryDeferred:true,detail};}return d.finish([s],ok,detail);
}

export function presetFor(quest:string):SaveConfig&{position:Tile}{
 const p=PRESETS['quest_'+quest];
 if(!p?.position)throw Error(`quest sweep: no preset quest_${quest} with a start tile`);
 // Pirate's Treasure picks its ten bananas from Luthas's plantation (quest-hunt.ts), where the quest already stands.
 const inventory=quest==='hazeelcult'?[{id:385,count:4}]:quest==='hunt'?(p.inventory??[]).filter(i=>i.id!==1963):p.inventory;
 return{...p,position:{level:0,...p.position},...(inventory?{inventory}:{}),
  ...(quest==='totem'?{coins:90,inventory:[...(p.inventory??[]),{id:1891,count:8},{id:1893,count:1},{id:1895,count:2}]}:{})};
}
// Preset food (lobster, shark) only feeds the quest's eat-at threshold, and teleport runes (fire, water, air, earth,
// law) only save walking (quest-lib teleport walks without a law rune): the runner takes what the bank holds of both.
// Fish, bread, lobster and shark are the food presets carry (quest_death: 10 bread, 10 trout); a banana can be a quest's
// own item (Pirate's Treasure smuggles bananas), so only these and the Tribal Totem preset's cakes count as optional.
export const FOOD=new Set([329,333,361,365,373,379,385,1891,1893,1895,2309,554,555,556,557,563]),COINS=995;
// A quest whose own item is on the food list: Merlin's Crystal hands its bread to the beggar for Excalibur.
export const QUEST_ITEMS_AMONG_FOOD:Record<string,number[]>={merlin:[2309]};
// A preset's protective supply that no quest script uses and no shop sells (Scorpion Catcher's antipoison, 2446): the
// sweep neither needs nor withdraws it; an account that holds one keeps it as any other pack item.
export const OPTIONAL=new Set([2446]);
export function needs(preset:SaveConfig,food=false,quest=''):Map<number,number>{
 const m=new Map<number,number>(),own=new Set(QUEST_ITEMS_AMONG_FOOD[quest]??[]);
 for(const i of preset.inventory??[])if(!OPTIONAL.has(i.id)&&(FOOD.has(i.id)&&!own.has(i.id))===food)m.set(i.id,(m.get(i.id)??0)+i.count);
 if(!food&&preset.coins)m.set(COINS,(m.get(COINS)??0)+preset.coins);
 return m;
}
const SCORPION_BARCRAWL = new Map([[COINS,268],[563,3],[556,11],[555,1],[554,1]]);
export function scorpionBarcrawlNeeds(base:ReadonlyMap<number,number>,barcrawlState:number):Map<number,number>{
 const staged=new Map(base);
 if(barcrawlState===2)return staged;
 for(const [id,n] of SCORPION_BARCRAWL)staged.set(id,(staged.get(id)??0)+n);
 return staged;
}
const count=(rows:readonly Item[],id:number)=>rows.filter(r=>r.id===id).reduce((n,r)=>n+r.count,0);
const WORN_KIT:Record<string,readonly {id:number;required:boolean}[]>={ball:[{id:1059,required:true},{id:1331,required:false}]};
export function wornKitPlan(quest:string,base:ReadonlyMap<number,number>,pack:readonly Item[],bank:readonly Item[],equipment:readonly Item[]){
 const wear=(WORN_KIT[quest]??[]).filter(i=>i.required||count(bank,i.id)>0||count(pack,i.id)>0||count(equipment,i.id)>0);
 const need=new Map(base);
 for(const i of wear)if(!count(equipment,i.id))need.set(i.id,Math.max(1,need.get(i.id)??0));
 return{need,wear};
}
export async function wearQuestKit(s:Session,wear:readonly {id:number;required:boolean}[]):Promise<string|null>{
 for(const i of wear){
  if(s.sdk.getEquipment().some(e=>e.id===i.id&&e.count>0))continue;
  const row=s.sdk.getState()?.inventory.find(e=>e.id===i.id&&e.count>0);
  if(!row)return `${i.required?'required':'selected'} worn item ${i.id} unavailable`;
  await s.bot.equipItem(row);
  const observed=await waitUntil(s,()=>s.sdk.getEquipment().some(e=>e.id===i.id&&e.count>0),{timeoutTicks:10});
  console.log(`QUEST_SWEEP_WORN ${JSON.stringify({id:i.id,required:i.required,observed})}`);
  if(!observed)return `${i.required?'required':'selected'} worn item ${i.id} equip unobserved`;
 }
 return null;
}
// What the pack still lacks, and what the bank cannot cover.
export function plan(need:ReadonlyMap<number,number>,pack:readonly Item[],bank:readonly Item[]){
 const withdraw:Item[]=[],missing:Item[]=[];
 for(const [id,n] of need){
  const lack=n-count(pack,id);if(lack<=0)continue;
  const take=Math.min(lack,count(bank,id));
  if(take>0)withdraw.push({id,count:take});
  if(take<lack)missing.push({id,count:lack-take});
 }
 return{withdraw,missing};
}
// The edibles a bank may hold in place of a preset's food, best heal first (a shark's 20, a lobster's 12, a slice's 4).
export const MEALS=[385,373,379,365,361,333,329,1891,1893,1895,2309];
// The food withdrawal: the preset's own kinds first, then any other edible for the units still short, less the edibles the
// pack already carries (a ranger with sharks banked and a preset of lobsters leaves with sharks). The quest's own
// withdrawals and needs are not meals: Merlin's Crystal's bread for the beggar stays the beggar's.
export function mealPlan(food:ReadonlyMap<number,number>,pack:readonly Item[],bank:readonly Item[],questWithdraw:readonly Item[]=[],need:ReadonlyMap<number,number>=new Map()):Item[]{
 // An item on both lists (Scorpion Catcher's law runes for the Barcrawl beside the preset's) is wanted on top of the
 // quest's count. The quest's withdrawals count as held, and the bank is read less them, as in toolPlan. Otherwise both
 // plans take the same bank stock and the second withdrawal meets an empty row.
 const want=new Map([...food].map(([id,n])=>[id,n+(need.get(id)??0)] as const));
 const stock=[...food.keys()].map(id=>({id,count:Math.max(0,count(bank,id)-count(questWithdraw,id))}));
 const exact=plan(want,[...pack,...questWithdraw],stock),withdraw=[...exact.withdraw];
 const edible=(id:number)=>MEALS.includes(id)&&!food.has(id);
 const spare=(id:number)=>Math.max(0,count(pack,id)-(need.get(id)??0));
 let left=exact.missing.filter(m=>MEALS.includes(m.id)).reduce((n,m)=>n+m.count,0)-MEALS.filter(edible).reduce((n,id)=>n+spare(id),0);
 for(const id of MEALS){
  if(left<=0)break;
  if(!edible(id))continue;
  const take=Math.min(left,count(bank,id)-count(questWithdraw,id));
  if(take>0){withdraw.push({id,count:take});left-=take;}
 }
 return withdraw;
}
// The gather's tools, planned after the quest plan's withdrawals: a rune the quest itself needs (Goblin Diplomacy's 3 air
// beside the casts' hundreds) is wanted on top of the quest's count, the quest's withdrawals count as held, and the bank
// is read less them. Otherwise both plans take the same bank stock and the second withdrawal fails, or the quest's runes
// in the pack count toward the casts.
export function toolPlan(tools:readonly Item[],need:ReadonlyMap<number,number>,pack:readonly Item[],worn:readonly Item[],bank:readonly Item[],questWithdraw:readonly Item[]){
 const want=new Map(tools.map(t=>[t.id,t.count+(need.get(t.id)??0)]));
 const taken=(id:number)=>count(questWithdraw,id);
 return plan(want,[...pack,...questWithdraw,...worn],bank.map(i=>({id:i.id,count:i.count-taken(i.id)})).filter(i=>i.count>0));
}
// A quest's own items: never deposited as unneeded, and withdrawn when the bank holds them, since the server counts
// them in the bank (obj_gettotal) and then neither re-issues nor accepts them (sedridor.rs2, duke_horacio.rs2, aubury.rs2).
// An untradeable item is kept the same way: quest and reward items are the untradeable ones a pack carries.
// Murder Mystery's evidence (quest_murder.rs2 obj_gettotal: the dagger, the six suspects' items, the threads, flypaper,
// the pungent pot and the prints): the server counts them in the bank and refuses a second pickup.
// Sheep Herder's prod, poisoned feed, plague suit and sheep bones: Orbon sells his one suit at stage 1 only
// (doctor_orbon.rs2), so a resumed run takes the banked suit.
export const QUEST_KEEP:Record<string,number[]>={runemysteries:[1438,290,291],totem:[1858,1857],
 murder:[1796,1797,1798,1799,1800,1801,1802,1803,1804,1805,1806,1807,1808,1809,1810,1811,1812,1813,1814,1815,1816,1817,1818,1819,1820,1821,1822],
 sheepherder:[278,279,284,285,280,281,282,283],
 // Pirate's Treasure's rum, chest key and message: a resumed run carries on from whichever the bank holds.
 hunt:[431,432,433]};
// A preset's protective supply that an account with Hitpoints and Defence at STURDY does without: it rides as food
// does (taken when the bank holds it, never reported missing). Lost City's two prayer potions keep Protect from
// Melee up against the tree spirit after the cave ladder drains Prayer (cave_monk.rs2:14); no shop sells them.
export const STURDY=90,STURDY_MEALS=10,STURDY_OPTIONAL:Record<string,number[]>={zanaris:[2434]};
// The pack of a build that fights a quest with the bow (scripts/pk-kits.ts; research/pvp-fight-loop.md, "Quest routes
// of the builds"): a magic shortbow and rune arrows, so the quest script fights in the style that trains only Ranged
// (quest-upass.ts RANGED_ARROWS), and for Underground Pass two prayer potions in the place of two sharks. Regicide
// takes 8 sharks, not 10: the quest pack, the bow, the arrows and the coins for the shops fill the other 20 slots. An account
// takes it when it cannot wear the rune armour of the quest presets (Defence under 40) and its Ranged is 50 or more
// and over its Attack. These are needs: without the bow the fights would give Attack and Defence XP. The sweep banks
// what such an account wears, as for a BARE quest: the practice cases ran with nothing worn.
export const BUILD_PACK:Record<string,Item[]>={upass:[{id:861,count:1},{id:892,count:600},{id:2434,count:2}],regicide:[{id:861,count:1},{id:892,count:600}]};
export const BUILD_MEALS:Record<string,number>={upass:12,regicide:8};
export const buildPack=(quest:string,level:(skill:string)=>number):Item[]=>
 level('Defence')<40&&level('Ranged')>=50&&level('Ranged')>level('Attack')?BUILD_PACK[quest]??[]:[];
// Quests that board the Entrana ship: its monk carries nobody with a weapon or a piece of armour in the pack or worn
// (monk_of_entrana.rs2 has_entrana_restricted_items; an arrow, a ring, an amulet and boots pass). The bank pass banks
// everything the account wears and every pack item the quest does not use, and runs even with the pack complete.
// The Fremennik Trials start bare too: Peer banks everything worn before his trial, and the quest script fights the
// Draugen and Koschei unarmed, with the style that trains only Strength (a bow has no such style).
export const BARE=new Set(['zanaris','grail','viking']);
// The coins to take from the bank for the shops, fares and paid recipes of a pass: what they cost beyond the coins the
// account carries over the quest's own need. The quest's coins are not shop money (practice: Merlin's Crystal asks 500
// coins, the pass bought bread and a tinderbox for 13 of them and ended `withdraw short 995:13`).
export const shopCoinTake=(shopCoins:number,packCoins:number,plannedCoins:number,questCoins:number)=>
 Math.max(0,shopCoins-Math.max(0,packCoins+plannedCoins-questCoins));
// Pack rows a bare quest banks: all but its own pack, its food and runes, its kept items and coins.
export function bareDeposits(quest:string,pack:readonly Item[],need:ReadonlyMap<number,number>,food:ReadonlyMap<number,number>,tradeable:(id:number)=>boolean|undefined):number[]{
 return [...new Set(pack.map(i=>i.id))].filter(id=>id!==COINS&&!need.has(id)&&!food.has(id)&&!MEALS.includes(id)&&!keepsItem(quest,id,tradeable));
}
export function keepsItem(quest:string,id:number,tradeable:(id:number)=>boolean|undefined):boolean{
 return (QUEST_KEEP[quest]??[]).includes(id)||tradeable(id)===false;
}
// Pack slots a withdrawal list needs: a stack (coins, runes, anything the pack already holds as a stack) takes one slot
// whatever its count; everything else one slot per unit.
// Coins, runes and arrows stack: 238 bronze arrows for a goblin series take one slot, not 238.
export const STACKS=new Set([COINS,554,555,556,557,558,559,560,561,562,563,564,565,566,...ARROWS]);
export function slotsFor(withdraw:readonly Item[],pack:readonly Item[]):number{
 const stack=(id:number)=>STACKS.has(id)||pack.some(i=>i.id===id&&i.count>1);
 return withdraw.reduce((n,w)=>n+(stack(w.id)?(pack.some(i=>i.id===w.id)?0:1):w.count),0);
}
// What to deposit so the pack has `need` free slots: first whole kinds the quest does not use (count -1: one deposit
// banks the kind; a second deposit of the same kind from a stale slot waits out its timeout), never coins, runes, the
// quest's own items or what the preset needs; then food units beyond a KEEP_FOOD allowance, as many as still needed;
// last, when still short, whole kinds `spare` names: another quest's untradeable leftovers (Excalibur, the pirate
// message, the fishing pass, a lit black candle), which the bank holds as well as the pack does. A pack of nine such
// slots left Prince Ali Rescue's 22 inputs 19 free.
export const KEEP_FOOD=8;
// Everything that heals (consume_normal.dbrow): FOOD above names what a preset carries as optional; this is what the
// deposit plan protects and the sweep's eater eats (an account arrives with swordfish and cake slices, not lobsters).
let edible:Set<number>|undefined;
export const isEdible=(id:number)=>FOOD.has(id)||(edible??=new Set(questFoodDefinitions().keys())).has(id);
// The preset's edible ingredients (Family Crest's cooked fish, Pirate's Treasure's bananas): the sweep's eater and, after
// the handover, the quest's own eater leave them alone.
export const reservedEdible=(need:ReadonlyMap<number,number>):Record<number,number>=>Object.fromEntries([...need].filter(([id])=>isEdible(id)));
// Slots a quest script fills on its own, undeclared by its preset: what it picks up and is handed (Murder Mystery takes
// the dagger, flypaper, a suspect's item and its dust and print, and a full pack fails its first pickup). The reserve
// gives way to the supplies down to MIN_PICKUP_SLOTS, before the food allowance does: Demon Slayer's 25 bones and two
// rune stacks beside the coins leave nothing else.
export const QUEST_PICKUP_SLOTS=8,MIN_PICKUP_SLOTS=2;
// What a quest picks up on its way beyond the pickup reserve, counted with the supplies: Pirate's Treasure holds ten
// bananas off the plantation and Zambo's rum at once before the crate takes them.
export const QUEST_PICKUPS:Record<string,Item[]>={hunt:[{id:1963,count:10},{id:431,count:1}]};
// Arrows a quest's own fights take from a bow account, beyond the gathers' kills: Merlin's Crystal's Sir Mordred has 38
// hitpoints behind Protect from Melee, and the quiver that emptied on him ended a run at Morgan Le Faye's door.
export const QUEST_ARROWS:Record<string,number>={merlin:40,prince:30,hazeelcult:20,scorpion:40};
// Casts a quest's own fights take from an account that fights with strike spells (Magic above Attack, no bow): Alomone
// (level 13) and Prince Ali's jail guard (26) fall to a few Fire Strikes; the Jailer (47) to about twenty.
export const QUEST_CASTS:Record<string,number>={hazeelcult:12,prince:15,scorpion:30};
// Fishing Contest wants Fishing 10 (hemenster_fishing.rs2:70). An account short of it nets shrimps first, at the
// nearest Net spot (Catherby beach beside Harry's shop, where the rod and bait come from): 250 XP a catch at 25x, five
// catches from level 1. The net is a tool of the bank pass; the catches take pack slots until the quest.
export const NET=303,RAW_SHRIMPS=317,RAW_ANCHOVIES=321,CATHERBY_BEACH:Tile={x:2838,z:3431,level:0},TRAIN_TICKS=900;
export const questSkillTraining=(quest:string,level:(skill:string)=>number):{skill:'Fishing';level:number;tools:Item[];pickups:Item[]}|null=>
 quest==='fishingcompo'&&level('Fishing')<10?{skill:'Fishing',level:10,tools:[{id:NET,count:1}],pickups:[{id:RAW_SHRIMPS,count:6}]}:null;
async function trainFishing(s:Session,world:World,level:number):Promise<string|null>{
 const st=()=>s.sdk.getState() as any,lvl=()=>st()?.skills?.find((k:any)=>k.name==='Fishing')?.baseLevel??1;
 const caught=()=>count((st()?.inventory??[]).map((i:any)=>({id:i.id,count:i.count})),RAW_SHRIMPS)+count((st()?.inventory??[]).map((i:any)=>({id:i.id,count:i.count})),RAW_ANCHOVIES);
 // The small-net spot offers Net and Bait (0_44_53_fish 320); the Net and Harpoon spot beside it (memberfish 322) wants a
 // big net and answers a small one with a message box that stops the action.
 const spot=()=>(st()?.nearbyNpcs??[]).filter((n:any)=>/^fishing spot$/i.test(n.name)&&n.optionsWithIndex?.some((o:any)=>/^net$/i.test(o.text))&&n.optionsWithIndex?.some((o:any)=>/^bait$/i.test(o.text))).sort((a:any,b:any)=>a.distance-b.distance)[0];
 if(!(st()?.inventory??[]).some((i:any)=>i.id===NET))return `fishing training needs a small net (${NET}) in the pack`;
 if(!spot()){const w=await walkFar(s,world,CATHERBY_BEACH,100);if(!w.ok)return `fishing spot walk failed: ${w.reason} ${w.detail}`;}
 // Each level gained opens the level-up dialogue, which stops the fishing until it is clicked away.
 const dialog=()=>{const d:any=s.sdk.getDialog();return !!d?.isOpen&&!d.isWaiting;};
 const t0=s.tick(),from=lvl();let casts=0;
 while(lvl()<level&&s.tick()-t0<TRAIN_TICKS){
  if(dialog()){await s.sdk.sendClickDialog(0);await waitTicks(s,1);continue;}
  const n=spot();
  if(!n){await waitTicks(s,5);continue;}
  if((st()?.inventory?.length??0)>=28)return `fishing training: pack full at Fishing ${lvl()}`;
  const before=caught();
  await s.direct({type:'interactNpc',npcIndex:n.index,optionIndex:n.optionsWithIndex.find((o:any)=>/^net$/i.test(o.text))!.opIndex,reason:'SDK'});
  casts++;
  await waitUntil(s,()=>caught()>before||lvl()>=level||dialog(),{timeoutTicks:30});
 }
 console.log(`QUEST_SWEEP_TRAIN ${JSON.stringify({skill:'Fishing',from,to:lvl(),target:level,casts,caught:caught(),ticks:s.tick()-t0})}`);
 return lvl()>=level?null:`Fishing ${lvl()} of ${level} after ${s.tick()-t0} ticks`;
}
// What the pack keeps whatever the plan: coins, the quest's and the preset's own items, and rune stacks.
export const staysCount=(pack:readonly Item[],keep:(id:number)=>boolean)=>pack.filter(i=>i.id===COINS||keep(i.id)||(STACKS.has(i.id)&&isEdible(i.id))).length;
// The slots the bank pass frees: the supplies plus as much pickup reserve as leaves the food allowance room, at least
// MIN_PICKUP_SLOTS, never beyond what the pack can hold next to what stays.
export function slotNeed(supplies:number,stays:number):number{
 const room=28-supplies-stays,reserve=Math.max(MIN_PICKUP_SLOTS,Math.min(QUEST_PICKUP_SLOTS,room-KEEP_FOOD));
 return Math.min(28-stays,supplies+reserve);
}
export function depositPlan(pack:readonly Item[],need:number,keep:(id:number)=>boolean,spare:(id:number)=>boolean=()=>false):Item[]{
 let free=28-pack.length;
 const out:Item[]=[];
 for(const id of [...new Set(pack.map(i=>i.id))]){
  if(free>=need)break;
  if(id===COINS||isEdible(id)||keep(id))continue;
  out.push({id,count:-1});free+=pack.filter(i=>i.id===id).length;
 }
 // The allowance gives way to the supplies: 25 bones, two rune stacks and the coins leave no slot for food.
 let allowance=Math.max(0,Math.min(KEEP_FOOD,28-need-staysCount(pack,keep)));
 for(const id of [...new Set(pack.filter(i=>isEdible(i.id)&&!STACKS.has(i.id)&&!keep(i.id)).map(i=>i.id))]){
  if(free>=need)break;
  const held=pack.filter(i=>i.id===id).length,kept=Math.min(held,allowance);allowance-=kept;
  const bank=Math.min(held-kept,need-free);
  if(bank>0){out.push({id,count:bank});free+=bank;}
 }
 for(const id of [...new Set(pack.filter(i=>spare(i.id)).map(i=>i.id))]){
  if(free>=need)break;
  out.push({id,count:-1});free+=pack.filter(i=>i.id===id).length;
 }
 return out;
}
// A far start walks hub to hub: each hop is a short route search (a search for a 900-tile route plans for hundreds of
// ticks before the first step, live and on practice, and the session's status row goes stale meanwhile). Hubs are the
// known banks and Lumbridge; a hop is at most MAX_HOP tiles (a search this long plans in a few ticks; the Barbarian
// Outpost lies 172 from the Seers' bank, its nearest hub) and must bring the goal nearer by HOP_GAIN.
export const MAX_HOP=180,HOP_GAIN=50;
const cheb=(a:Tile,b:Tile)=>Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z));
export function hopsTo(from:Tile,to:Tile,hubs:readonly Tile[]=[...BANKS,{x:3222,z:3218,level:0}]):Tile[]{
 const out:Tile[]=[];let at=from;
 for(let i=0;i<12&&cheb(at,to)>MAX_HOP;i++){
  const next=hubs.filter(h=>h.level===to.level&&cheb(at,h)<=MAX_HOP&&cheb(h,to)<=cheb(at,to)-HOP_GAIN).sort((a,b)=>(cheb(at,a)+cheb(a,to))-(cheb(at,b)+cheb(b,to)))[0];
  if(!next)break;
  out.push(next);at=next;
 }
 return out;
}
// A dungeon tile lies 6400 north of the surface it is under (the Wizards' Tower basement, 3120,9567, under 3120,3167):
// banks rank by the surface tile, so an account left underground heads for the bank above it, not across the map.
export const UNDERGROUND=6400;
export const surfaceOf=(t:Tile):Tile=>t.z>=UNDERGROUND?{...t,z:t.z-UNDERGROUND}:t;
// Reserve the whole acquisition batch before leaving the bank. Existing stacks need no new slot.
export async function reserveInputSlots(s:Session,inputs:readonly Item[],keep:ReadonlySet<number>):Promise<string|null>{
 const pack=()=>s.sdk.getState()?.inventory??[],bank=()=>s.sdk.getState()?.bank?.items??[];
 const client=s.client as {objType?:(id:number)=>{stackable:boolean}};
 const slots=()=>{
  const stacks=new Set(pack().map(i=>i.id));let n=0;
  for(const i of inputs)if(client.objType?.(i.id)?.stackable){if(!stacks.has(i.id)){n++;stacks.add(i.id);}}else n+=i.count;
  return n;
 };
 for(const id of new Set(pack().map(i=>i.id))){
  if(28-pack().length>=slots())break;
  if(keep.has(id))continue;
  const row=pack().find(i=>i.id===id)!,held=count(pack(),id),stored=count(bank(),id);
  await s.bot.depositItem(row,-1);
  if(!await waitUntil(s,()=>count(pack(),id)===0&&count(bank(),id)===stored+held,{timeoutTicks:10}))return `capacity deposit unobserved ${id}:${held}`;
 }
 const required=slots(),free=28-pack().length;
 console.log(`QUEST_SWEEP_CAPACITY ${JSON.stringify({required,free})}`);
 return free>=required?null:`input capacity short: free ${free}, required ${required}`;
}
export function nearestBanks(at:Tile):Tile[]{
 const a=surfaceOf(at);
 return BANKS.filter(b=>b.level===a.level).sort((x,y)=>Math.max(Math.abs(x.x-a.x),Math.abs(x.z-a.z))-Math.max(Math.abs(y.x-a.x),Math.abs(y.z-a.z)));
}
// The sweep eats on its own walks (the quest script brings its own eater at the handover): anything that heals, from
// 60 percent of the account's hitpoints down. A quest that failed leaves the account where it stood, and the next
// sweep logs in there: Restless Ghost's skull skeleton killed a 37-hitpoint account on the bank walk.
export function eatAtFor(maxHp:number):number{return Math.max(10,Math.floor(maxHp*0.6));}
// Straight-line distance plus a boat: a seller across the water (Hamab in Tai Bwo Wannai, 488 tiles from Al Kharid as the
// crow flies; the Miscellania food shop, 581 from Ardougne) ranks behind one on the same landmass (Kortan in Ardougne,
// 654), since the world router's search for the crossing idles hundreds of ticks.
import {SEA} from '../packages/core/src/spawn-index';
export {SEA};
// The farthest seller a sweep walks to: Al Kharid to Ardougne is 654 tiles; a crossing costs SEA on top.
export const FAR_SELLER=800;
export function travelDistance(from:Tile,to:Tile):number{return cheb(from,to)+(crossesSea(from,to)?SEA:0);}
// With a destination, a seller ranks by the extra travel it adds to the way there (detour): from Ardougne bound for
// Hetty's house in Rimmington, Betty in Port Sarim (53 tiles off the way) comes before Jatix in Taverley and the ogre
// merchant at Gu'Tanoth, both nearer the bank and both behind the mountain or a stall counter the client cannot path to.
// A seller that adds the two boats (eastOfArdougne, walkFar's own test) costs a crossing on top: for a Big Wolf account at
// the Falador bank bound for Doric, Arhein in Catherby (detour 222) ranked before Bob in Lumbridge (485), the foot leg west
// from Taverley ended at 2866,3423 with the client refusing 2855,3430 (no floor joins Taverley to Catherby off the
// pass), and the way back east took both boats.
export function sellersByTravel<S extends {tile:Tile}>(sellers:readonly S[],at:Tile,dest?:Tile,acct?:Pick<Account,'skills'>):S[]{
 const boats=(a:Tile,b:Tile)=>eastOfArdougne(a,b,acct)?1:0;
 const cost=(t:Tile)=>(dest?detour([at,dest],t)+SEA*Math.max(0,boats(at,t)+boats(t,dest)-boats(at,dest)):travelDistance(at,t)+SEA*boats(at,t));
 return [...sellers].sort((a,b)=>cost(a.tile)-cost(b.tile));
}
export function nearestBank(at:Tile):Tile{
 return BANKS.filter(b=>b.level===at.level).sort((a,b)=>Math.max(Math.abs(a.x-at.x),Math.abs(a.z-at.z))-Math.max(Math.abs(b.x-at.x),Math.abs(b.z-at.z)))[0]??BANKS[0]!;
}

// gnome_gate.rs2: gate190 at 2459,3383 walks to loc+(2,2), then force-moves three tiles south.
// special-crossings.json instead names the southern landing as the interaction tile. Leave the interior before
// asking the shared route planner for the bank, so it does not select that malformed crossing.
export async function leaveStronghold(s:Session,approach:(to:Tile)=>Promise<{ok:boolean}>=async(to)=>walkPath(await sessionWalker(s),[{...to,tol:0}],{maxTicks:150})){
 const pos=()=>s.sdk.getState()?.player;
 const p=pos();
 if(!p||p.level!==0||p.worldX<2369||p.worldX>2505||p.worldZ<3385||p.worldZ>3524)return{ok:true};
 // The Heckel ladder lands behind the Grand Tree doors. A path west from 2466,3494 misses their anchors.
 // gnome_gate.rs2 open_tree_door aligns treedoorr to x2466 and force-moves two tiles south.
 if(p.worldX>=2464&&p.worldX<=2467&&p.worldZ>=3493&&p.worldZ<=3495){
  await s.direct({type:'interactLoc',x:2466,z:3492,locId:1968,optionIndex:1,reason:'SDK'});
  const outside=await waitUntil(s,()=>{const q=pos();return q?.level===0&&q.worldX===2466&&q.worldZ===3491;},{timeoutTicks:30});
  console.log(`QUEST_SWEEP_TREE_EXIT ${JSON.stringify({ok:outside,at:pos()&&{x:pos()!.worldX,z:pos()!.worldZ,level:pos()!.level}})}`);
  if(!outside)return{ok:false,detail:'Grand Tree southern landing unobserved'};
 }
 const walked=await approach({x:2461,z:3385,level:0});
 if(!walked.ok)return{ok:false,detail:'Stronghold north gate approach failed'};
 const n=pos();
 if(n?.worldX!==2461||n.worldZ!==3385||n.level!==0)return{ok:false,detail:'Stronghold north landing unobserved'};
 await s.direct({type:'interactLoc',x:2459,z:3383,locId:190,optionIndex:1,reason:'SDK'});
 const crossed=await waitUntil(s,()=>{const p=pos();return p?.worldX===2461&&p.worldZ===3382&&p.level===0;},{timeoutTicks:30});
 console.log(`QUEST_SWEEP_GATE ${JSON.stringify({ok:crossed,at:pos()&&{x:pos()!.worldX,z:pos()!.worldZ,level:pos()!.level}})}`);
 return{ok:crossed,detail:crossed?undefined:'Stronghold southern landing unobserved'};
}

// Black Knights' Fortress box room (level 1, south of the cabbage hole wall): its only exit is the secret wall
// bksecretdoor 2341 on the south edge of 3030,3510 (quest_blackknight.rs2:86-88). The nearest climb-down there,
// 3021,3510, sits behind the sturdy door and gets "I can't reach that!". quest-blackknight.ts step 7 reversed:
// push the wall north, the corridor to 3022,3517, laddertop 1749 at 3022,3518 down to the hall, out by the
// guards' door to the fortress front (both doors open from inside, :14-22,56-66).
const inBoxRoom=(p:{worldX:number;worldZ:number;level:number})=>p.level===1&&p.worldX>=3026&&p.worldX<=3031&&p.worldZ>=3504&&p.worldZ<=3509;
export async function leaveFortress(s:Session,approach:(to:readonly Tile[])=>Promise<{ok:boolean}>=async(to)=>walkPath(await sessionWalker(s),to.map(t=>({x:t.x,z:t.z,tol:0})),{maxTicks:150})){
 const pos=()=>s.sdk.getState()?.player;
 const at=(x:number,z:number,level:number,tol=0)=>{const p=pos();return !!p&&p.level===level&&Math.abs(p.worldX-x)<=tol&&Math.abs(p.worldZ-z)<=tol;};
 const where=()=>{const p=pos();return p?`${p.worldX},${p.worldZ},${p.level}`:'unknown';};
 const p=pos();
 if(!p||!inBoxRoom(p))return{ok:true};
 const log=(step:string,ok:boolean)=>console.log(`QUEST_SWEEP_FORTRESS ${JSON.stringify({step,ok,at:where()})}`);
 if(!(await approach([{x:3030,z:3509,level:1}])).ok||!at(3030,3509,1)){log('wall tile',false);return{ok:false,detail:`fortress secret wall tile 3030,3509,1 unobserved at ${where()}`};}
 await s.direct({type:'interactLoc',x:3030,z:3510,locId:2341,optionIndex:1,reason:'SDK'});
 const pushed=await waitUntil(s,()=>{const p=pos();return !!p&&p.level===1&&p.worldZ>=3510;},{timeoutTicks:20});
 log('secret wall',pushed);
 if(!pushed)return{ok:false,detail:`fortress secret wall push unobserved at ${where()}`};
 if(!(await approach([{x:3030,z:3516,level:1},{x:3029,z:3517,level:1},{x:3022,z:3517,level:1}])).ok||!at(3022,3517,1)){log('corridor',false);return{ok:false,detail:`fortress corridor 3022,3517,1 unobserved at ${where()}`};}
 await s.direct({type:'interactLoc',x:3022,z:3518,locId:1749,optionIndex:1,reason:'SDK'});
 const down=await waitUntil(s,()=>pos()?.level===0,{timeoutTicks:20});
 log('hall ladder',down);
 if(!down)return{ok:false,detail:`fortress hall ladder descent unobserved at ${where()}`};
 const out=(await approach([{x:3016,z:3512,level:0}])).ok&&at(3016,3512,0,1);
 log('front',out);
 return out?{ok:true}:{ok:false,detail:`fortress front 3016,3512,0 unobserved at ${where()}`};
}

// Hazeel Cult's cave (maps/m40_151.jm2, under the Ardougne cave mouth 2585,3233): the walker has no route out, since
// the stairs hazeelcultstairs 2853 at 2570,9683 are the quest's own (quest_hazeelcult.rs2 oploc1, Climb-up lands on
// 2587,3237). A run that resumes down there climbs them before its bank walk.
const inHazeelCave=(p:{worldX:number;worldZ:number;level:number})=>p.level===0&&p.worldX>=2555&&p.worldX<=2625&&p.worldZ>=9655&&p.worldZ<=9705;
export async function leaveHazeelCave(s:Session,approach:(to:readonly Tile[])=>Promise<{ok:boolean}>=async(to)=>walkPath(await sessionWalker(s),to.map(t=>({x:t.x,z:t.z,tol:0})),{maxTicks:150})){
 const pos=()=>s.sdk.getState()?.player;
 const where=()=>{const p=pos();return p?`${p.worldX},${p.worldZ},${p.level}`:'unknown';};
 const p=pos();
 if(!p||!inHazeelCave(p))return{ok:true};
 const log=(step:string,ok:boolean)=>console.log(`QUEST_SWEEP_HAZEEL_CAVE ${JSON.stringify({step,ok,at:where()})}`);
 const foot=(await approach([{x:2570,z:9682,level:0}])).ok&&(()=>{const q=pos();return !!q&&q.level===0&&Math.abs(q.worldX-2570)<=1&&Math.abs(q.worldZ-9682)<=1;})();
 log('stairs foot',foot);
 if(!foot)return{ok:false,detail:`hazeel cave stairs foot 2570,9682,0 unobserved at ${where()}`};
 await s.direct({type:'interactLoc',x:2570,z:9683,locId:2853,optionIndex:1,reason:'SDK'});
 const up=await waitUntil(s,()=>{const q=pos();return !!q&&q.worldZ<9000;},{timeoutTicks:20});
 log('stairs',up);
 return up?{ok:true}:{ok:false,detail:`hazeel cave stairs climb unobserved at ${where()}`};
}

// Ernest the Chicken's fish food has one spawn, upstairs in Draynor Manor (maps/m48_52.jm2:9477, 3108,3356,1).
// spawn-index.ts lists sources on the player's plane only, so gatherPlan leaves it missing. In by the front door
// (opens from the south only, quest_haunted.rs2:4-8), spookystairs 3108,3363 up (+4 z) and spookystairstop
// 3108,3364 down (-4 z, stairs.rs2:106-120), out by hauntedbackdoor 3123,3360 (north wall; opens from both sides).
export const MANOR_FOOD={id:272,x:3108,z:3356,level:1};
// The poison lies in the Manor's west room on the ground floor, through two ordinary doors from the hall (loc_1530 at
// 3103,3363 and 3099,3366); the only shop with it is Frincos's on Entrana, off the sweep's map.
export const MANOR_POISON={id:273,x:3097,z:3366,level:0};
export const manorFoodNeed=(quest:string,missing:readonly Item[])=>quest==='haunted'&&missing.some(m=>m.id===MANOR_FOOD.id&&m.count===1);
export const manorPoisonNeed=(quest:string,missing:readonly Item[])=>quest==='haunted'&&missing.some(m=>m.id===MANOR_POISON.id&&m.count===1);
// The Manor trip fetches the fish food and the poison, so the gather pass leaves them: spawnsByDistance also offers
// their spawns.
export const leaveToManorTrip=<G extends {id:number}>(gathers:readonly G[],manorFood:boolean,manorPoison=false):G[]=>gathers.filter(g=>!(manorFood&&g.id===MANOR_FOOD.id)&&!(manorPoison&&g.id===MANOR_POISON.id));
type ManorLoc={id:number;x:number;z:number};
type ManorItem={id:number;x:number;z:number;level:number};
export type ManorIO={pos:()=>Tile|undefined;held:(item:ManorItem)=>number;ground:(item:ManorItem)=>{x:number;z:number}|undefined;
 travel:(to:Tile)=>Promise<{ok:boolean;detail?:string}>;walk:(to:readonly Tile[])=>Promise<{ok:boolean;detail?:string}>;
 op:(loc:ManorLoc,re:RegExp)=>Promise<unknown>;pickup:(at:{x:number;z:number},item:ManorItem)=>Promise<unknown>;wait:(ok:()=>boolean,ticks:number)=>Promise<boolean>};
export async function fetchManorFishFood(io:ManorIO,start:Tile,want:{food:boolean;poison:boolean}={food:true,poison:false}):Promise<{ok:boolean;detail?:string}>{
 const where=()=>{const p=io.pos();return p?`${p.x},${p.z},${p.level}`:'unknown';};
 const at=(x:number,z:number,level:number,tol=0)=>{const p=io.pos();return !!p&&p.level===level&&Math.max(Math.abs(p.x-x),Math.abs(p.z-z))<=tol;};
 const log=(step:string,ok:boolean,extra:object={})=>console.log(`QUEST_SWEEP_MANOR ${JSON.stringify({step,ok,at:where(),...extra})}`);
 const fail=(step:string,what:string)=>{log(step,false);return{ok:false,detail:`manor fish food ${what} unobserved at ${where()}`};};
 // One item off its spawn tile, where the bot stands: the spawn is waited on, the pickup repeated until the pack credits it.
 const take=async(item:ManorItem,name:string):Promise<{ok:boolean;detail?:string}>=>{
  const before=io.held(item);
  if(!io.ground(item)&&!await io.wait(()=>!!io.ground(item),60))return fail(name,`ground ${name}`);
  for(let i=0;i<3&&io.held(item)<before+1;i++){
   const g=io.ground(item);
   if(g)await io.pickup(g,item);
   await io.wait(()=>io.held(item)>=before+1,10);
  }
  const got=io.held(item)===before+1;
  log('pickup',got,{item:item.id,before,after:io.held(item)});
  return got?{ok:true}:{ok:false,detail:`manor ${name} inventory credit unobserved: ${before} -> ${io.held(item)} at ${where()}`};
 };
 const travelled=await io.travel(start);
 if(!travelled.ok){log('travel',false);return{ok:false,detail:`manor fish food travel to ${start.x},${start.z} failed: ${travelled.detail}`};}
 if(!(await io.walk([{x:3108,z:3352,level:0}])).ok||!at(3108,3352,0))return fail('front','front door tile 3108,3352,0');
 await io.op({id:134,x:3108,z:3353},/^open$/i);
 if(!await io.wait(()=>{const p=io.pos();return !!p&&p.level===0&&p.z>=3354;},20))return fail('front door','front door entry');
 log('front door',true);
 if(want.poison){
  // The router's walk opens the two doors on the way; walkPath keeps to open ground.
  const r=await io.travel(MANOR_POISON);
  if(!r.ok||!at(MANOR_POISON.x,MANOR_POISON.z,0,1))return fail('poison tile','poison tile 3097,3366,0');
  const taken=await take(MANOR_POISON,'poison');if(!taken.ok)return taken;
  const back=await io.travel({x:3108,z:3362,level:0});
  if(!back.ok||!at(3108,3362,0,1))return fail('hall','stairs tile 3108,3362,0');
 }
 if(want.food){
  if(!(await io.walk([{x:3108,z:3362,level:0}])).ok||!at(3108,3362,0))return fail('hall','stairs tile 3108,3362,0');
  await io.op({id:1730,x:3108,z:3363},/climb-up/i);
  if(!await io.wait(()=>io.pos()?.level===1,20))return fail('stairs up','level 1');
  log('stairs up',true);
  if(!(await io.walk([MANOR_FOOD])).ok||!at(MANOR_FOOD.x,MANOR_FOOD.z,1,1))return fail('food tile','food tile 3108,3356,1');
  const taken=await take(MANOR_FOOD,'fish food');if(!taken.ok)return taken;
  if(!(await io.walk([{x:3108,z:3366,level:1}])).ok||!at(3108,3366,1,1))return fail('landing','stairs landing 3108,3366,1');
  await io.op({id:1731,x:3108,z:3364},/climb-down/i);
  if(!await io.wait(()=>io.pos()?.level===0,20))return fail('stairs down','level 0');
  log('stairs down',true);
 }
 if(!(await io.walk([{x:3123,z:3361,level:0}])).ok||!at(3123,3361,0))return fail('back door','back door exit 3123,3361,0');
 log('back door',true);
 return{ok:true};
}
export function manorIO(s:Session,world:World):ManorIO{
 const st=()=>s.sdk.getState() as any;
 return{
  pos:()=>{const p=st()?.player;return p?{x:p.worldX,z:p.worldZ,level:p.level}:undefined;},
  held:item=>count((st()?.inventory??[]).map((i:any)=>({id:i.id,count:i.count})),item.id),
  ground:item=>st()?.player?.level===item.level?(st()?.groundItems??[]).find((g:any)=>g.id===item.id&&g.x===item.x&&g.z===item.z):undefined,
  travel:async to=>{const r=await goTo(s,world,to,accountOf(s),{legTimeoutTicks:150});return r.ok?{ok:true}:{ok:false,detail:`${r.reason} ${r.detail}`};},
  walk:async to=>walkPath(await sessionWalker(s),to.map(t=>({x:t.x,z:t.z,tol:0})),{maxTicks:150}),
  op:async(loc,re)=>{
   const l=(st()?.nearbyLocs??[]).find((n:any)=>n.x===loc.x&&n.z===loc.z&&(n.optionsWithIndex??[]).some((o:any)=>re.test(o.text)));
   await s.direct({type:'interactLoc',x:loc.x,z:loc.z,locId:l?.id??loc.id,optionIndex:l?.optionsWithIndex.find((o:any)=>re.test(o.text)).opIndex??1,reason:'SDK'});
  },
  pickup:async(g,item)=>s.direct({type:'pickupItem',x:g.x,z:g.z,itemId:item.id,reason:'SDK'}),
  wait:(ok,ticks)=>waitUntil(s,ok,{timeoutTicks:ticks}),
 };
}

// m38_54.jm2 LOC: 0/1_38_54_34_39, ladder1747 / laddermiddle1748.
// ladders.rs2: ground op1 climbs up, middle op3 climbs down without a choice menu.
export const HECKEL_DUST={id:1975,coins:106,ground:{x:2493,z:3488,level:0},ladder:{x:2466,z:3495}};
export const heckelDustNeed=(quest:string,missing:readonly Item[])=>quest==='elena'&&missing.some(m=>m.id===1975&&m.count===1);
export const groundShopNeeds=(quest:string,missing:readonly Item[])=>missing.filter(m=>!(heckelDustNeed(quest,missing)&&m.id===1975));
export type HeckelIO={pos:()=>Tile|undefined;held:()=>number;coins:()=>number;
 gate:()=>Promise<unknown>;
 travel:(to:Tile)=>Promise<{ok:boolean;detail?:string}>;walk:(to:Tile)=>Promise<{ok:boolean}>;
 climb:(up:boolean)=>Promise<unknown>;open:()=>Promise<boolean>;row:()=>Item|undefined;
 buy:(row:Item)=>Promise<unknown>;close:()=>Promise<unknown>;wait:(ok:()=>boolean,ticks:number)=>Promise<boolean>};
export async function fetchHeckelDust(io:HeckelIO):Promise<{ok:boolean;detail?:string}>{
 const at=(to:Tile,tol=2)=>{const p=io.pos();return !!p&&p.level===to.level&&Math.max(Math.abs(p.x-to.x),Math.abs(p.z-to.z))<=tol;};
 const fail=(detail:string)=>({ok:false,detail:`Heckel dust ${detail}`});
 const before=io.held();
 const p=io.pos();
 if(!p)return fail('Stronghold entry location unobserved');
 if(!(p.level===0&&p.x>=2369&&p.x<=2505&&p.z>=3385&&p.z<=3524)){
  const south={...STRONGHOLD_GATE.south,level:0};
  const approach=await io.travel(south);
  if(!approach.ok||!at(south,1))return fail(`Stronghold south leg to 2461,3382,0 failed: ${approach.detail??'arrival unobserved'}`);
  try{await io.gate();}catch(error){return fail(`Stronghold gate leg 2461,3382,0 -> 2461,3385,0 failed: ${String(error)}`);}
  if(!at({...STRONGHOLD_GATE.north,level:0},0))return fail('Stronghold gate leg to 2461,3385,0 failed: north arrival unobserved');
 }
 const travelled=await io.travel(HECKEL_DUST.ground);
 if(!travelled.ok)return fail(`Stronghold ground leg to 2493,3488,0 failed: ${travelled.detail}`);
 if(!at(HECKEL_DUST.ground))return fail('Stronghold ground arrival 2493,3488,0 unobserved');
 const landing={x:2466,z:3494,level:0};
 if(!(await io.walk(landing)).ok||!at(landing,0))return fail('ladder approach 2466,3494,0 unobserved');
 await io.climb(true);
 if(!await io.wait(()=>at({...landing,level:1}),20))return fail('ladder up 2466,3495,1 unobserved');
 const seller={x:2493,z:3488,level:1};
 if(!(await io.walk(seller)).ok||!at(seller))return fail('seller leg to 2493,3488,1 unobserved');
 if(!await io.open())return fail('shop open unobserved');
 let got=false,paid=false;
 try{
  // gnomeshop_heck stock13=chocolate_dust,5,100. Wait for one restock, then send one purchase only.
  if(!await io.wait(()=>{const row=io.row();return !!row&&row.id===1975&&row.count>0;},110))return fail('stock 1975 unobserved');
  const row=io.row();
  if(!row||row.id!==1975||row.count<1)return fail('stock 1975 vanished');
  const coinsBefore=io.coins();
  await io.buy(row);
  await io.wait(()=>io.held()===before+1&&io.coins()<coinsBefore,10);
  got=io.held()===before+1;paid=io.coins()<coinsBefore;
  console.log(`QUEST_SWEEP_HECKEL ${JSON.stringify({item:1975,before,after:io.held(),coinsBefore,coins:io.coins(),observed:got&&paid})}`);
 }finally{await io.close();}
 if(!got)return fail(`inventory credit unobserved: ${before} -> ${io.held()}`);
 if(!paid)return fail('coin debit unobserved');
 if(!(await io.walk({...landing,level:1})).ok||!at({...landing,level:1},0))return fail('ladder return 2466,3494,1 unobserved');
 await io.climb(false);
 if(!await io.wait(()=>at(landing),20))return fail('ladder down 2466,3495,0 unobserved');
 return{ok:true};
}
export function heckelIO(s:Session,world:World):HeckelIO{
 const st=()=>s.sdk.getState(),held=(id:number)=>count(st()?.inventory??[],id);
 const gate=async()=>{
  const initial=st()?.player;
  const live=()=>{if(!st()?.inGame)throw Error('session interrupted');if(sessionDied(initial,st()?.player)||(s.sdk.getSkill('Hitpoints')?.level??0)<=0)throw Error('died');};
  const end=s.tick()+200;
  const deps:GateDeps={live,left:label=>{live();if(s.tick()>=end)throw Error(`${label}: tick budget exhausted`);},health:async()=>{live();}};
  return crossStrongholdGate(s,deps);
 };
 return{
  gate,
  pos:()=>{const p=st()?.player;return p?{x:p.worldX,z:p.worldZ,level:p.level}:undefined;},held:()=>held(1975),coins:()=>held(COINS),
  travel:async to=>{const r=await goTo(s,world,to,accountOf(s),{legTimeoutTicks:150,maxRetriesPerLeg:1});return r.ok?{ok:true}:{ok:false,detail:`${r.reason} ${r.detail}`};},
  walk:async to=>walkPath(await sessionWalker(s),[{x:to.x,z:to.z,tol:0}],{maxTicks:150}),
  climb:async up=>s.direct({type:'interactLoc',...HECKEL_DUST.ladder,locId:up?1747:1748,optionIndex:up?1:3,reason:'SDK'}),
  open:async()=>{const npc=st()?.nearbyNpcs.find(n=>n.id===603);if(!npc)return false;await s.bot.openShop(npc);return waitUntil(s,()=>!!st()?.shop?.isOpen,{timeoutTicks:10});},
  row:()=>st()?.shop?.shopItems.find(i=>i.id===1975&&i.count>0),
  buy:async row=>{const observed=st()?.shop?.shopItems.find(i=>i.id===row.id&&i.count>0);if(observed)await s.bot.buyFromShop(observed,1);},
  close:()=>s.bot.closeShop(),wait:(ok,ticks)=>waitUntil(s,ok,{timeoutTicks:ticks}),
 };
}

// courier-route.ts / foodcourier.ts: two 30-coin boats bypass White Wolf Mountain for the HP10 mainland entry.
// The corridors are courier waypoints [x,z,tolerance], walked with walkPath as foodcourier.ts walks them. A waypoint
// is a pass-by tile, not a world-route goal: goTo found no route to 2850,3175, while walkPath plans each leg on
// rs-sdk collision and clicks straight on where that plan is empty. Only the last tile's tolerance is checked.
type Pt=[number,number,number];
export const KARAMJA:Pt[]=[[2774,3228,3],[2800,3200,5],[2850,3175,5],[2920,3160,5],[2956,3146,3]];
// SARIM_TO_DRAYNOR's first legs, then LUMBRIDGE_TO_DRAYNOR reversed: north of the jail guards.
export const SARIM_NORTH:Pt[]=[[3047,3237,3],[3060,3265,3],[3089,3266,2],[3100,3285,3],[3180,3258,3]];
export async function walkCorridor(deps:PathDeps,points:readonly Pt[],walk:typeof walkPath=walkPath){
 const [gx,gz,gtol]=points[points.length-1]!;
 const at=()=>{const p=deps.pos();return p&&{x:p.x,z:p.z,level:p.level};};
 const near=()=>{const p=at();return !!p&&p.level===0&&Math.max(Math.abs(p.x-gx),Math.abs(p.z-gz))<=gtol+1;};
 let left=points.map(([x,z,tol])=>({x,z,tol}));
 for(let i=0;i<3&&!near();i++){
  const r=await walk(deps,left);
  console.log(`QUEST_SWEEP_CORRIDOR ${JSON.stringify({to:{x:gx,z:gz},try:i+1,ok:r.ok,next:r.next,at:at(),detail:r.detail})}`);
  left=left.slice(Math.min(r.next,left.length-1));
 }
 return{ok:near(),at:at()};
}

// Every far walk of the sweep (bank, shop, gather source, quest start) goes hub to hub: a ground hop walks on rs-sdk
// collision first (walkPath plans a 450-tile leg in a few ticks; the world router's search for Falador to Catherby alone
// idled 920 ticks on practice, and Al Kharid to a Karamja shop idled 938), and takes the world router only when that
// walk fails or the legs change level.
export type Walked={ok:boolean;reason?:string;detail?:string;ticks?:number};
// The sweep's route searches get 15 s each: a legitimate leg plans in well under that, and the 900-tick watchdog runs at
// 150 ms ticks on practice (135 s), so three 45 s searches for one unreachable spawn cluster ended a run.
export const SWEEP_PLAN_BUDGET_MS=15_000;
// `signal`: a quest guard's abort (a death, the retreat threshold, a sustain failure, the tick cap) ends the walk between
// legs and inside each leg's clicks; the result then says `stopped`.
// Quests whose scripts fight under prayers: Merlin's Crystal turns Protect from Melee on in Keep Le Faye and at the
// chaos altar, Holy Grail three prayers on the Black Knight Titan (99 points last them about 160 ticks). The value is
// the points the quest wants at its start. An account that comes with fewer (spent in another job) prays first at the
// Seers' Village church: altar 409 at 2694,3462, prayed at from the tile east of it, about 70 tiles from King Arthur.
// Practice with no points: Merlin's Crystal ended `step protect from melee on` in the keep.
export const SEERS_ALTAR={id:409,x:2694,z:3462,level:0,stand:{x:2695,z:3462,level:0}} as const;
export const PRAYER_QUESTS:Record<string,number>={merlin:30,grail:60};
export const prayerShort=(points:number,level:number,wanted:number)=>points<Math.min(level,wanted);
export async function prayBefore(s:Session,world:World,quest:string):Promise<string|null>{
 const wanted=PRAYER_QUESTS[quest];
 if(wanted===undefined)return null;
 const points=():number=>(s.sdk.getState() as any)?.prayers?.prayerPoints??0,level=s.sdk.getSkill('Prayer')?.baseLevel??1,before=points();
 if(!prayerShort(before,level,wanted))return null;
 const walked=await walkFar(s,world,SEERS_ALTAR.stand,150);
 if(!walked.ok)return `walk to the Seers' Village altar failed: ${walked.reason} ${walked.detail}`;
 for(let i=0;i<3&&points()<level;i++){
  await s.direct({type:'interactLoc',x:SEERS_ALTAR.x,z:SEERS_ALTAR.z,locId:SEERS_ALTAR.id,optionIndex:1,reason:'SDK'});
  await waitUntil(s,()=>points()>=level,{timeoutTicks:12});
 }
 console.log(`QUEST_SWEEP_PRAY ${JSON.stringify({quest,before,after:points(),level,wanted})}`);
 return prayerShort(points(),level,wanted)?`prayer points ${points()} of ${level} after the Seers' Village altar`:null;
}
export async function walkFar(s:Session,world:World,to:Tile,legTimeoutTicks=150,opts:{signal?:AbortSignal}={}):Promise<Walked>{
 const from=at(s);
 const r=await walkFarLegs(s,world,to,legTimeoutTicks,opts.signal);
 if(!r.ok)console.log(`QUEST_SWEEP_WALK_FAIL ${JSON.stringify({from,to,at:at(s),reason:r.reason,detail:r.detail})}`);
 return r;
}
const at=(s:Session):Tile=>{const q=s.sdk.getState()?.player;return{x:q?.worldX??0,z:q?.worldZ??0,level:q?.level??0};};
const STOPPED:Walked={ok:false,reason:'stopped',detail:'quest guard'};
async function walkFarLegs(s:Session,world:World,to:Tile,legTimeoutTicks:number,signal?:AbortSignal):Promise<Walked>{
 const stopped=()=>signal?.aborted===true;
 const router=async(t:Tile):Promise<Walked>=>stopped()?STOPPED:goTo(s,world,t,accountOf(s),{legTimeoutTicks,planBudgetMs:SWEEP_PLAN_BUDGET_MS,signal});
 const ground=async(t:Tile):Promise<Walked>=>{
  if(stopped())return STOPPED;
  const r=at(s).level===0&&t.level===0?await walkCorridor(await sessionWalker(s),[[t.x,t.z,3]],(d,pts)=>walkPath(d,pts,{signal})):{ok:false};
  return r.ok?{ok:true}:router(t);
 };
 if(stopped())return STOPPED;
 // A far walk that starts upstairs (Hudo's shop on the Grand Tree's first floor, bound for Port Sarim) first comes down by
 // the nearest way down: the boats and hubs are ground legs, and asked from the first floor the world router found no route.
 for(let i=0;i<3&&at(s).level!==0&&cheb(at(s),to)>MAX_HOP;i++){
  const down=wayDown(world.navigationGraph?.().transports??[],at(s));
  console.log(`QUEST_SWEEP_DOWN ${JSON.stringify({from:at(s),to:down})}`);
  const r=await router(down);if(!r.ok)return r;
 }
 if(eastOfArdougne(at(s),to,accountOf(s))){const r=await crossEast(s,world,to,signal);if(!r.ok)return r;}
 // An upstairs target (Morgan's garlic cupboard in Draynor) is approached by the hubs toward the foot of its way up;
 // only the last leg, with its stairs, is the world router's.
 const beneath=wayUp(world.navigationGraph?.().transports??[],to);
 for(const hop of at(s).level===0?hopsTo(at(s),beneath):[]){
  console.log(`QUEST_SWEEP_HOP ${JSON.stringify({from:at(s),to:hop})}`);
  const r=await ground(hop);if(!r.ok)return r;
 }
 // A far upstairs target with no hub on the way (Hudo's shop on the Grand Tree's first floor, 226 tiles from the Ardougne
 // bank) is still approached by the ground: asked from Ardougne, the world router took an Ardougne staircase and a
 // 240-tile walk on the first floor, where no floor lies, and the search ran out the plan budget.
 if(to.level!==0&&at(s).level===0&&cheb(at(s),beneath)>MAX_HOP){const r=await ground(beneath);if(!r.ok)return r;}
 return to.level===0&&at(s).level===0&&cheb(at(s),to)>30?ground(to):router(to);
}
// The landing of the nearest way down from this floor (the Grand Tree ladder, 2466,3495): the tile beneath an upstairs shop
// is a wall as often as a floor (under Hudo's counter, 2449,3508, the router found no route).
export function wayDown(transports:readonly Transport[],at:Tile):Tile{
 const downs=transports.filter(t=>t.from.level===at.level&&t.to.level<at.level&&cheb(t.from,at)<=80).sort((a,b)=>cheb(a.from,at)-cheb(b.from,at));
 return downs[0]?.to??{x:at.x,z:at.z,level:0};
}
// The ground foot of the nearest way up to an upstairs target (the Grand Tree ladder's base, 2466,3495, for Hudo's counter):
// a far walk heads for a floor tile the router can reach, not the wall beneath the target. A way up from a middle floor
// is followed down to the ground; with no way up within 80 tiles the tile beneath stands in.
export function wayUp(transports:readonly Transport[],to:Tile,depth=3):Tile{
 if(to.level===0||depth===0)return{x:to.x,z:to.z,level:0};
 const up=transports.filter(t=>t.to.level===to.level&&t.from.level<to.level&&cheb(t.to,to)<=80).sort((a,b)=>cheb(a.to,to)-cheb(b.to,to))[0];
 if(!up)return{x:to.x,z:to.z,level:0};
 return up.from.level===0?up.from:wayUp(transports,up.from,depth-1);
}
// From the Ardougne side (x under 2800, z 3270 and up) to anywhere east of x 2950 the way is the two boats, Brimhaven and
// Port Sarim, with the Karamja and Port Sarim corridors between: no hub lies within a hop of Ardougne to the east, and
// the world router's search for the land way round idles out the budget. Two fares of 30 coins.
// White Wolf Mountain: the Big Wolf (combat 73, reach 22) at 2840,3497 holds the pass against an account it would kill
// (TheFullMonty, combat 57 and 37 hitpoints: Kandarin to Taverley found no route under the plan budget), so for that
// account a Taverley-side target (Taverley, Burthorpe and Doric's house, x 2880 to 2960, z 3400 and up) is east of Ardougne too: the
// boats, then the Port Sarim to Falador road. A stronger account walks the pass.
export const TAVERLEY_SIDE=(to:Tile)=>to.level===0&&to.x>=2880&&to.x<2960&&to.z>=3400;
const BIG_WOLF:Tile={x:2840,z:3497,level:0};
export const mountainClosed=(acct:Pick<Account,'skills'>,hunters=loadHunters())=>hunters.filter(h=>h.spawns.some(s=>s.x===BIG_WOLF.x&&s.z===BIG_WOLF.z&&s.level===BIG_WOLF.level)).some(h=>deadly(h,combatLevel(acct.skills),acct.skills.hitpoints??10));
// Catherby (x 2800 to 2860) is on the Ardougne side too for an account the pass is closed to: its only way east is
// back through Ardougne and the boats. A stronger account at Catherby walks the pass.
export const eastOfArdougne=(from:Tile,to:Tile,acct?:Pick<Account,'skills'>)=>from.level===0&&from.z>=3270&&(from.x<2800||from.x<2860&&!!acct&&mountainClosed(acct))&&(to.x>=2950||!!acct&&TAVERLEY_SIDE(to)&&mountainClosed(acct));
export const BOAT_FARES=60;
export const fares=(from:Tile,targets:readonly Tile[],acct?:Pick<Account,'skills'>)=>targets.some(t=>eastOfArdougne(from,t,acct))?BOAT_FARES:0;
// The Port Sarim landing: a target in the town itself (Wydin's shop, 3014,3204) needs no walk north past the jail.
export const SARIM_LANDING:Tile={x:3029,z:3217,level:0};
// Keepers with no Trade option: the shop opens through their talk (area_yanille/scripts/ogre_merchant.rs2: "Yes I do."
// opens Grud's Herblore Stall at Gu'Tanoth, the eye of newt seller nearest Ardougne that has a route).
export const SHOP_TALK:Record<number,RegExp[]>={874:[/^yes i do/i]};
async function crossEast(s:Session,world:World,to:Tile,signal?:AbortSignal):Promise<Walked>{
 if(count(s.sdk.getState()?.inventory??[],COINS)<BOAT_FARES)return{ok:false,reason:'precondition',detail:`missing 995:${BOAT_FARES} for safe boat route`};
 const walk=async(to:Tile):Promise<Walked>=>signal?.aborted?STOPPED:goTo(s,world,to,accountOf(s),{legTimeoutTicks:150,planBudgetMs:SWEEP_PLAN_BUDGET_MS,signal});
 const corridor=async(points:readonly Pt[]):Promise<Walked>=>{
  if(signal?.aborted)return STOPPED;
  const r=await walkCorridor(await sessionWalker(s),points,(d,pts)=>walkPath(d,pts,{signal}));
  return r.ok?{ok:true}:{ok:false,reason:'corridor',detail:`corridor walk failed to ${points[points.length-1]!.join(',')} at ${JSON.stringify(r.at)}`};
 };
 const sail=async(id:string):Promise<Walked>=>{
  const t=loadTravel().find(t=>t.id===id);
  if(!t?.from)return{ok:false,reason:'precondition',detail:`safe boat route unavailable: ${id}`};
  // KARAMJA ends within 4 tiles of 2956,3146, so within 7 of the customs officer at 2953,3147. The travel leg
  // only needs the NPC in view; goTo has no Karamja route there.
  const q=s.sdk.getState()?.player;
  if(!q||q.level!==t.from.level||Math.max(Math.abs(q.worldX-t.from.x),Math.abs(q.worldZ-t.from.z))>8){const w=await walk(t.from);if(!w.ok)return w;}
  const r=await walkRoute(s,[{kind:'travel',travel:t,at:t.from,to:t.to}],{maxRetriesPerLeg:1,legTimeoutTicks:150});
  if(!r.ok)return{ok:false,reason:r.reason,detail:`safe boat route failed: ${r.detail}`};
  console.log(`QUEST_SWEEP_BOAT ${JSON.stringify({id,coins:t.coins})}`);
  return{ok:true};
 };
 for(const leg of [()=>sail('npc:captain_barnaby:brimhaven@2679,3275'),()=>corridor(KARAMJA),()=>sail('npc:customs_officer:port-sarim@2953,3147')]){
  const r=await leg();if(!r.ok)return r;
 }
 // SARIM_NORTH leads to Draynor; a Taverley-side target leaves the landing by the hubs and the router (Falador's road).
 return cheb(to,SARIM_LANDING)<=60||TAVERLEY_SIDE(to)?{ok:true}:corridor(SARIM_NORTH);
}
// The surface east of White Wolf Mountain's pass, for an account the Big Wolf closes it to: Misthalin, Asgarnia, the
// Wilderness, the Taverley side and the mountain's north-west pocket (Ballspinner, combat 19, stopped at 2790,3502: the
// danger-guarded plan from there reaches the west only through the Big Wolf's ground, so it is empty, and the straight
// fallback click to 2779,3491 was refused). Port Sarim's boats lead round to Ardougne.
export const eastOfPass=(at:Tile,acct:Pick<Account,'skills'>)=>at.level===0&&at.z<4000
 &&(at.z>=3270?at.x>=2880||at.x>=2780&&at.z>=3470:at.x>=2950)&&mountainClosed(acct);
// Ardougne customs landing (2683,3271) to the Observatory reception: corners of the pinned findLongPath, danger-guarded
// for a combat-19 account. The path passes south of the reception and turns north at 2456,3167.
export const OBSERVATORY_FROM_ARDOUGNE:Pt[]=[[2657,3275,2],[2626,3260,2],[2588,3243,2],[2549,3230,2],[2527,3240,2],[2501,3228,2],[2481,3204,2],[2466,3180,2],[2456,3167,2]];
export async function reachStart(s:Session,world:World,start:Tile,quest?:string,walker=()=>sessionWalker(s),route=walkRoute,acct=():Pick<Account,'skills'>=>accountOf(s)){
 const p=s.sdk.getState()?.player;
 const totemMainland=quest==='totem'&&p?.level===0&&p.worldX<2745&&p.worldZ>=3200;
 const observatoryEast=quest==='itgronigen'&&!!p&&start.level===0&&eastOfPass({x:p.worldX,z:p.worldZ,level:p.level},acct());
 // The mainland-to-tower whole-world bank comparison waits before the first walk leg;
 // legTimeoutTicks cannot bound that planner. Reuse the courier's two boats and corridors.
 if(totemMainland||observatoryEast||quest==='cog'&&p?.level===0&&p.worldX>=2950&&p.worldZ<3500&&start.level===0){
  const fares=totemMainland?90:60,label=totemMainland?'Tribal Totem':observatoryEast?'Observatory':'Clock Tower';
  if(count(s.sdk.getState()?.inventory??[],COINS)<fares)throw Error(`missing 995:${fares} for ${label} boat route`);
  const deps=await walker(),deadline=s.tick()+(observatoryEast?2700:1800);
  const near=(point:{x:number;z:number},tol:number)=>{const at=deps.pos();return !!at&&at.level===0&&Math.max(Math.abs(at.x-point.x),Math.abs(at.z-point.z))<=tol;};
  const corridor=async(points:readonly Pt[],legTicks=600)=>{
   const r=await walkQuestCorridor({tick:()=>s.tick(),stop:()=>s.sdk.getState()?.player?.isDead===true,near,
    walk:(points,opts)=>walkPath(deps,points,opts),
   },points.map(([x,z,tol])=>({x,z,tol})),Math.min(deadline,s.tick()+legTicks));
   if(!r.ok)throw Error(`${label} corridor failed: ${r.detail}`);
  };
  const sail=async(id:string)=>{
   const t=loadTravel().find(t=>t.id===id);
   if(!t?.from||!near(t.from,8))throw Error(`${label} boat approach unobserved: ${id}`);
   if(s.tick()>=deadline)throw Error(`${label} entry deadline`);
   const r=await route(s,[{kind:'travel',travel:t,at:t.from,to:t.to}],{maxRetriesPerLeg:1,legTimeoutTicks:150});
   if(!r.ok||!near(t.to,8))throw Error(`${label} boat failed: ${id} ${r.ok?'arrival unobserved':r.detail}`);
   console.log(`QUEST_SWEEP_BOAT ${JSON.stringify({id,coins:t.coins})}`);
  };
  if(totemMainland){
   await corridor([[2644,3293,2],[2669,3284,2],[2679,3275,2]]);
   await sail('npc:captain_barnaby:brimhaven@2679,3275');
   await corridor([[2774,3228,2],[start.x,start.z,2]]);
   return;
  }
  // One guarded leg to the landing: 115 path corners from 2790,3502 round the mountain's north side, 93 from the
  // Wilderness plank spawn at 3291,3652. Then the boats to Ardougne and the pinned ground path to the reception.
  if(observatoryEast){
   await corridor([[SARIM_LANDING.x,SARIM_LANDING.z,2]],900);
   await sail('npc:captain_tobias:karamja-musa-point@3028,3216');
   await corridor([...KARAMJA].reverse().concat([[2772,3231,2]]));
   await sail('npc:customs_officer:ardougne@2772,3231');
   await corridor([...OBSERVATORY_FROM_ARDOUGNE,[start.x,start.z,2]]);
   return;
  }
  await corridor([...SARIM_NORTH].reverse().concat([[3029,3217,2]]));
  await sail('npc:captain_tobias:karamja-musa-point@3028,3216');
  await corridor([...KARAMJA].reverse().concat([[2772,3231,2]]));
  await sail('npc:customs_officer:ardougne@2772,3231');
  await corridor([[2669,3284,2],[2644,3293,2],[2610,3290,3],[2580,3260,2],[2575,3250,0],[start.x,start.z,2]]);
  return;
 }
 // m44_54.jm2 tunnel_dwarf spawns at 2820,3487 (wanderrange=2). The pinned collision has a ground path
 // from Ardougne; the world graph refuses the preset goal. Use the same bounded corridor as quest-lib,
 // then let the generated quest's talk helper walk to the observed NPC and open its dialogue.
 if(quest==='fishingcompo'&&start.level===0){
  if(p?.level!==0)throw Error('Fishing Contest west dwarf approach requires ground entry');
  const deps=await walker(),goal={x:2820,z:3487,tol:2};
  const near=(t:{x:number;z:number},tol:number)=>{const at=deps.pos();return !!at&&at.level===0&&Math.max(Math.abs(at.x-t.x),Math.abs(at.z-t.z))<=tol;};
  const r=await walkQuestCorridor({tick:()=>s.tick(),stop:()=>s.sdk.getState()?.player?.isDead===true,
   near,walk:(points,options)=>walkPath(deps,points,options),
  },[goal],s.tick()+600);
  if(!r.ok)throw Error(`Fishing Contest west dwarf approach failed: ${r.detail}`);
  const observed=()=>near(goal,3)&&(s.sdk.getState()?.nearbyNpcs??[]).some(n=>n.id===232&&/^mountain dwarf$/i.test(n.name)
   &&Math.max(Math.abs(n.x-goal.x),Math.abs(n.z-goal.z))<=4);
  if(!await waitUntil(s,observed,{timeoutTicks:10}))throw Error('Fishing Contest west dwarf unobserved');
  console.log(`QUEST_SWEEP_DWARF ${JSON.stringify({at:deps.pos(),observed:true})}`);
  return;
 }
 const r=await walkFar(s,world,start);
 if(!r.ok)throw Error(`start walk failed to ${JSON.stringify(start)}: ${r.reason} ${r.detail}`);
}

// Missing quest items a shop sells: the nearest seller of each (shop-index.ts), and the coins to take for them
// (3 times the item's base cost, plus 100). Items no shop sells stay missing.
// `atLeast`: the smallest purchase that still serves (a kit consumable estimated with a margin); the full count otherwise.
export type Buy={id:number;count:number;name:string;npcId:number;npc:string;tile:Tile;alts?:{npc:string;npcId:number;tile:Tile}[];atLeast?:number};
export function shopPlan(missing:readonly Item[],at:Tile,item:(id:number)=>{debugname:string;name:string;cost:number}|undefined,
 seller:(debugname:string,at:Tile)=>{npc:string;npcId:number;tile:Tile}|null,alts:(debugname:string,at:Tile)=>{npc:string;npcId:number;tile:Tile}[]=()=>[]){
 const buys:Buy[]=[],unsold:Item[]=[];let coins=0;
 for(const m of missing){
  const it=item(m.id),s=it&&m.id!==COINS?seller(it.debugname,at):null;
  if(!it||!s){unsold.push(m);continue;}
  buys.push({id:m.id,count:m.count,name:it.name,npcId:s.npcId,npc:s.npc,tile:s.tile,alts:alts(it.debugname,at).filter(a=>a.npcId!==s.npcId||a.tile.x!==s.tile.x||a.tile.z!==s.tile.z).slice(0,8)});coins+=3*Math.max(1,it.cost)*m.count;
 }
 return{buys,unsold,coins:buys.length?coins+100:0};
}
// What a stop adds to a tour: the least extra travel over any leg of the ordered stops (its distance from one end when
// the tour is a single tile).
export function detour(stops:readonly Tile[],t:Tile):number{
 if(stops.length<2)return stops.length?travelDistance(stops[0]!,t):0;
 let best=Infinity;
 for(let i=1;i<stops.length;i++)best=Math.min(best,travelDistance(stops[i-1]!,t)+travelDistance(t,stops[i]!)-travelDistance(stops[i-1]!,stops[i]!));
 return best;
}
// The stops in the order the purchases run: nearest first from wherever the last one ended.
export function tourOrder(from:Tile,stops:readonly Tile[]):Tile[]{
 const out:Tile[]=[],left=[...stops];let at=from;
 while(left.length){const next=left.sort((a,b)=>travelDistance(at,a)-travelDistance(at,b)).shift()!;out.push(next);at=next;}
 return out;
}
// A purchase whose item also grows in a field is picked instead when the field is the smaller detour from the tour of the
// bank, the other sellers and the quest start. From the Ardougne bank the Lumbridge onion field is 533 tiles off and
// Hudo 226, but redberries come from Wydin in Port Sarim and the Goblin Village lies 52 tiles from Wydin: the field adds
// 263 tiles to that tour and Hudo 452. The field judged is the nearest to any stop; the gather walks to the nearest from
// where the purchases end.
export function pickInstead(buys:readonly Buy[],from:Tile,end:Tile,fields:(id:number,at:Tile)=>Tile[]=(id,at)=>locsByDistance(PICK_SOURCES[id]!.loc,at)):{buys:Buy[];picks:{id:number;count:number;field:Tile;detours:{field:number;seller:number}}[]}{
 const picks:{id:number;count:number;field:Tile;detours:{field:number;seller:number}}[]=[];let left=[...buys];
 for(const b of buys){
  if(!PICK_SOURCES[b.id])continue;
  const stops=[from,...tourOrder(from,left.filter(o=>o!==b).map(o=>o.tile)),end];
  const field=stops.map(a=>fields(b.id,a)[0]).filter((t):t is Tile=>!!t).sort((a,c)=>detour(stops,a)-detour(stops,c))[0];
  if(!field)continue;
  const detours={field:detour(stops,field),seller:detour(stops,b.tile)};
  if(detours.field<detours.seller){picks.push({id:b.id,count:b.count,field,detours});left=left.filter(o=>o!==b);}
 }
 return{buys:left,picks};
}
let itemCatalog:Map<number,{debugname:string;name:string;cost:number}>|undefined;
const catalogItem=(id:number)=>(itemCatalog??=new Map((JSON.parse(readFileSync(resolve(import.meta.dir,'../knowledge/items.json'),'utf8')) as {id:number;debugname:string;name:string;cost:number}[]).map(i=>[i.id,i])) ).get(id);

type GatherArgs=Parameters<typeof gatherPlan>;
export function questGatherPlan(quest:string,missing:readonly Item[],at:Tile,seller:(id:number)=>number,...rest:[GatherArgs[4]?,GatherArgs[5]?,GatherArgs[6]?,GatherArgs[7]?,GatherArgs[8]?,GatherArgs[9]?]){
 // Wydin's apron spawn is behind wydindoor: employment and a worn apron are required (food_store.rs2).
 // Hunt stages its first apron through the existing clotheshop purchase path.
 return gatherPlan(missing,at,(id,tile)=>quest==='hunt'&&id===1005||WORN_KIT[quest]?.some(i=>i.required&&i.id===id)?[]:spawnsByDistance(id,tile),seller,...rest);
}

// Walk to each seller, open its shop and buy. Ok when the pack holds the bought counts.
async function buyFromShops(s:Session,world:World,buys:readonly Buy[]):Promise<string|null>{
 const st=()=>s.sdk.getState() as any,held=(id:number)=>count((st()?.inventory??[]).map((i:any)=>({id:i.id,count:i.count})),id);
 // Purchases go nearest seller first from wherever the bot stands (onions from Hudo in the Gnome Stronghold before
 // redberries from Wydin in Port Sarim, from Ardougne), so a walk east by boat is not followed by a walk back west.
 const here=():Tile=>{const q=st()?.player;return{x:q?.worldX??0,z:q?.worldZ??0,level:q?.level??0};};
 const left=[...buys];
 while(left.length){
  const b=left.sort((x,y)=>travelDistance(here(),x.tile)-travelDistance(here(),y.tile)).shift()!;
  // The nearest seller may be out of reach (a quest area, deadly ground) or short (Kortan holds 14 balls of wool, the
  // quest wants 20): the next sellers take over, nearest first, for the rest.
  const before=held(b.id),target=before+b.count,sellers=[b,...(b.alts??[])];
  let walked:{ok:boolean;reason?:string;detail?:string}={ok:false},tried=0;
  for(const [k,c] of sellers.entries()){
   if(held(b.id)>=target)break;
   // A seller across the sea or the map is not worth the search: the sweep fails fast and the shortfall is acquisition work.
   if(travelDistance(here(),c.tile)>FAR_SELLER){console.log(`QUEST_SWEEP_SELLER_FAR ${JSON.stringify({npc:c.npc,tile:c.tile,from:here()})}`);continue;}
   walked=await walkFar(s,world,c.tile,100);
   if(!walked.ok)continue;
   tried++;
   const npc=(st()?.nearbyNpcs??[]).filter((n:any)=>n.id===c.npcId).sort((x:any,y:any)=>x.distance-y.distance)[0];
   if(!npc)return `${c.npc} not in sight at ${c.tile.x},${c.tile.z}`;
   // A shut shop door leaves the keeper unroutable (the client reports cant_reach and sends nothing) even from the
   // seller's own tile: open the nearest door once and ask again, as ranged-train does at Lowe's.
   const shopOpen=()=>waitUntil(s,()=>!!st()?.shop?.isOpen,{timeoutTicks:10});
   // A stall that opens through its keeper's talk (SHOP_TALK) is asked, choice by choice, until the shop shows.
   const talked=async()=>{
    const choices=SHOP_TALK[c.npcId]!;
    const t:any=await s.bot.talkTo(npc);if(!t?.success)return false;
    for(let i=0,next=0;i<30&&!st()?.shop?.isOpen;i++){
     const dlg:any=s.sdk.getDialog();
     if(dlg?.isOpen&&!dlg.isWaiting){const opts:any[]=dlg.options??[];const idx=next<choices.length&&opts.some(o=>choices[next]!.test(o.text))?next:undefined;if(idx!==undefined){await s.sdk.clickDialogByText(choices[idx]!);next=idx+1;}else await s.sdk.sendClickDialog(0);}
     await waitTicks(s,1);
    }
    return !!st()?.shop?.isOpen;
   };
   const opened=async()=>SHOP_TALK[c.npcId]?talked():(await s.bot.openShop(npc)).success&&await shopOpen();
   if(!await opened()){
    const door=(await s.bot.openDoor(/door/i)).success;
    console.log(`QUEST_SWEEP_SHOP_DOOR ${JSON.stringify({npc:c.npc,at:here(),door})}`);
    if(!door||!await opened())return `${c.npc} shop did not open`;
   }
   // Another bot may have emptied the shelf: buy what is there, wait for the restock, buy the rest. Small shops
   // restock one item per 100 ticks (wydinstore: 3 flour), so the last seller waits up to 12 x 50 ticks; an earlier
   // one waits 3 rounds before the next seller is tried.
   const rounds=k===sellers.length-1?12:3,had0=held(b.id),coinsBefore=held(COINS);
   for(let i=0;i<rounds&&held(b.id)<target;i++){
    const row=(st()?.shop?.shopItems??[]).find((x:any)=>x.id===b.id);
    if(!row||row.count<1){await waitTicks(s,50);continue;}
    const want=Math.min(target-held(b.id),row.count),had=held(b.id);
    await s.bot.buyFromShop(row,want);
    await waitUntil(s,()=>held(b.id)>=had+want,{timeoutTicks:10});
   }
   console.log(`QUEST_SWEEP_BUY ${JSON.stringify({item:b.id,name:b.name,count:b.count,npc:c.npc,before:had0,after:held(b.id),coinsBefore,coins:held(COINS)})}`);
   await s.bot.closeShop();
  }
  if(!tried)return `shop walk to ${b.npc} at ${b.tile.x},${b.tile.z} and ${b.alts?.length??0} more failed: ${walked.reason?`${walked.reason} ${walked.detail}`:`no seller within ${FAR_SELLER} tiles`}`;
  if(held(b.id)-before<(b.atLeast??b.count))return `bought ${held(b.id)-before} of ${b.count} ${b.name} from ${tried} sellers`;
 }
 return null;
}

// General stores nearest `at`, one tile per keeper. A general store buys any item (shop/scripts/shop.rs2
// can_sell_obj: inv_allstock).
export function generalStores(at:Tile,sellers=shopSellers()):{npcId:number;npc:string;tile:Tile}[]{
 const seen=new Map<string,{npcId:number;npc:string;tile:Tile}>();
 for(const list of sellers.values())for(const s of list)if(s.shop.startsWith('general'))for(const t of s.spawns)if(t.level===at.level)seen.set(`${s.npcId}@${t.x},${t.z}`,{npcId:s.npcId,npc:s.npc,tile:t});
 const d=(t:Tile)=>Math.max(Math.abs(t.x-at.x),Math.abs(t.z-at.z));
 return [...seen.values()].sort((a,b)=>d(a.tile)-d(b.tile));
}
// The way to every bank can cost a fare the pack cannot pay (OreElse on Karamja: 24 coins, 30 to Port Sarim, no
// bank on the island). Sell the pack at the nearest reachable general store, cheapest item first.
async function raiseFare(s:Session,world:World):Promise<boolean>{
 const st=()=>s.sdk.getState() as any,coins=()=>count((st()?.inventory??[]).map((i:any)=>({id:i.id,count:i.count})),COINS);
 const here=():Tile=>{const p=st()?.player;return{x:p?.worldX??0,z:p?.worldZ??0,level:p?.level??0};};
 const start=coins();
 for(const store of generalStores(here()).slice(0,3)){
  const walked=await goTo(s,world,store.tile,accountOf(s),{legTimeoutTicks:100});
  console.log(`QUEST_SWEEP_FARE_WALK ${JSON.stringify({npc:store.npc,to:store.tile,ok:walked.ok,detail:"detail" in walked?walked.detail:undefined})}`);
  if(!walked.ok)continue;
  const npc=(st()?.nearbyNpcs??[]).filter((n:any)=>n.id===store.npcId).sort((a:any,b:any)=>a.distance-b.distance)[0];
  if(!npc||!(await s.bot.openShop(npc)).success)continue;
  await waitUntil(s,()=>!!st()?.shop?.isOpen,{timeoutTicks:10});
  const items=[...(st()?.inventory??[])].filter((i:any)=>i.id!==COINS).sort((a:any,b:any)=>(catalogItem(a.id)?.cost??0)-(catalogItem(b.id)?.cost??0));
  for(const i of items){const before=coins();await s.bot.sellToShop(i,'all');await waitUntil(s,()=>coins()>before,{timeoutTicks:10});}
  await s.bot.closeShop();
  console.log(`QUEST_SWEEP_FARE ${JSON.stringify({npc:store.npc,before:start,after:coins()})}`);
  return coins()>start;
 }
 return false;
}

// Gathering (ground spawns, milk, loc sources) lives in packages/core/src/gather.ts, shared with scripts/gather-spawn.ts.
export {gatherPlan,MILK,BUCKET,LOC_SOURCES,type Gather} from '../packages/core/src/gather';

// Ladders say Climb-down. Draynor Manor's spookystairstop says Walk-down (all.loc op1, stairs.rs2 [oploc1,spookystairstop]).
const DOWN=/(climb|walk)-down/i;
type DownLoc={distance:number;optionsWithIndex?:{text:string;opIndex:number}[]};
export function downward<L extends DownLoc>(locs:readonly L[]):{loc:L;opIndex:number}|undefined{
 const loc=locs.filter(l=>(l.optionsWithIndex??[]).some(o=>DOWN.test(o.text))).sort((a,b)=>a.distance-b.distance)[0];
 const opIndex=loc?.optionsWithIndex?.find(o=>DOWN.test(o.text))?.opIndex;
 return loc&&opIndex!==undefined?{loc,opIndex}:undefined;
}

// Gertrude's Cat's lumber yard has one way out the walkers know nothing of: the gertrudefence loc 2618 at 3305,3493,
// climbed from inside onto 3305,3492 (quest_fluffs.rs2:116-136). %fluffs is not sent to the client, so a started
// journal inside the yard with no milk 1927, seasoned sardine 1552 or kitten 1554 held is the kitten given (5).
export const FLUFFS_FENCE={id:2618,x:3305,z:3493};
type YardPos={worldX:number;worldZ:number;level:number};
export const inLumberYard=(p?:YardPos|null)=>!!p&&p.level>=0&&p.level<=1&&p.worldX>=3293&&p.worldX<=3313&&p.worldZ>=FLUFFS_FENCE.z&&p.worldZ<=3517;
export const fluffsKittenGiven=(journal:string|undefined,pack:readonly {id:number}[],p?:YardPos|null)=>
 journal==='started'&&inLumberYard(p)&&!pack.some(i=>i.id===1927||i.id===1552||i.id===1554);
// Varrock Teleport when the account can cast it; otherwise the fence first, from inside the yard.
export const fluffsExit=(castable:boolean,p?:YardPos|null):'teleport'|'fence'=>!castable&&inLumberYard(p)?'fence':'teleport';

// One bot at a time hands its session over through globalThis.QUEST_SESSION, until quest-lib's openQuest has taken
// it (QUEST_SESSION_TAKEN) or 60 s pass. `fresh` imports the quest module under a unique query, so every bot in one
// process runs the quest's top-level code again.
export const questScriptId=(script:string)=>String(script).replace(/^.*[\\/]/,'').replace(/\.ts$/,'');
let handoff:Promise<void>=Promise.resolve();
export function handOver(s:Session,script:string,fresh?:string):Promise<unknown>{
 const g=globalThis as {QUEST_SESSION?:Session;QUEST_SESSION_TAKEN?:()=>void;QUEST_SCRIPT_ID?:string};
 let started!:(p:Promise<unknown>)=>void;const run=new Promise<Promise<unknown>>(r=>{started=r;});
 handoff=handoff.then(()=>new Promise<void>(release=>{
  const done=()=>{clearTimeout(timer);if(g.QUEST_SESSION===s)delete g.QUEST_SESSION;if(g.QUEST_SESSION_TAKEN===done)delete g.QUEST_SESSION_TAKEN;release();};
  const timer=setTimeout(done,60_000);
  g.QUEST_SESSION=s;g.QUEST_SESSION_TAKEN=done;
  // quest-lib reads the talk plans of the quest script by this name.
  g.QUEST_SCRIPT_ID=questScriptId(script);
  started(import(fresh?`${script}?${fresh}`:script).finally(()=>{if(g.QUEST_SESSION_TAKEN===done)done();}));
 }));
 return run.then(p=>p);
}

export const returnToAmik=(quest:string,state:string)=>quest==='blackknight'&&state==='started';
export type AmikIO={pos:()=>Tile|undefined;travel:(to:Tile)=>Promise<{ok:boolean;detail?:string}>;
 climb:(loc:{id:number;x:number;z:number},level:number)=>Promise<boolean>;
 talk:()=>Promise<string>;complete:()=>boolean};
export async function finishBlackKnight(io:AmikIO):Promise<{ok:boolean;detail?:string}>{
 const to={x:2955,z:3337,level:0},r=await io.travel(to),p=io.pos();
 if(!r.ok||!p||p.level!==0||Math.max(Math.abs(p.x-to.x),Math.abs(p.z-to.z))>2)return{ok:false,detail:`Amik castle leg to 2955,3337,0 failed: ${r.detail??'arrival unobserved'}`};
 for(const [x,level] of [[2954,1],[2960,2]] as const){
  if(!await io.climb({id:1738,x,z:3338},level)||io.pos()?.level!==level)return{ok:false,detail:`Amik stairs leg at ${x},3338 to level ${level} unobserved`};
 }
 const dialogue=await io.talk();
 return io.complete()?{ok:true}:{ok:false,detail:`Sir Amik did not complete quest; observed dialogue: ${JSON.stringify(dialogue)}`};
}
export function amikIO(s:Session,world:World):AmikIO{
 const st=()=>s.sdk.getState(),initial=st()?.player;
 const state=()=>questFlags(s.client)?.find(f=>f.name==="Black Knight's Fortress")?.state;
 const text:string[]=[],messages=new Set((st()?.gameMessages??[]).map(m=>m));
 let questComplete=false;
 const observe=()=>{
  const d=st()?.dialog;
  const page=[d?.text??'',...(d?.allComponents??[]).map(c=>c.text)].filter(Boolean).join('\n');
  if(d?.isOpen&&page&&text.at(-1)!==page)text.push(page);
  if((st()?.gameMessages??[]).some(m=>!messages.has(m)&&/quest complete/i.test(m.text)))questComplete=true;
 };
 const live=()=>{if(!st()?.inGame||sessionDied(initial,st()?.player)||(s.sdk.getSkill('Hitpoints')?.level??0)<=0)throw Error('Amik return session interrupted or died');};
 return{
  pos:()=>{const p=st()?.player;return p?{x:p.worldX,z:p.worldZ,level:p.level}:undefined;},
  travel:async to=>{const r=await goTo(s,world,to,accountOf(s),{legTimeoutTicks:150,maxRetriesPerLeg:1});return r.ok?{ok:true}:{ok:false,detail:`${r.reason} ${r.detail}`};},
  climb:async(loc,level)=>{
   live();
   const r=await walkPath(await sessionWalker(s),[{x:loc.x,z:loc.z,tol:1}],{maxTicks:60});
   if(!r.ok)return false;
   const l=st()?.nearbyLocs.find(l=>l.x===loc.x&&l.z===loc.z);
   if(!l)return false;
   await s.bot.interactLoc(l,/climb/i);
   return waitUntil(s,()=>st()?.player?.level===level,{timeoutTicks:20});
  },
  talk:async()=>{
   const off=s.onTick(observe);
   try{
    live();
    const r=await walkPath(await sessionWalker(s),[{x:2960,z:3336,tol:1}],{maxTicks:60});
    if(!r.ok)return 'Sir Amik approach 2960,3336,2 failed';
    await s.bot.talkTo(/^sir amik varze$/i);
    for(let i=0;i<60;i++){
     live();observe();
     if(state()==='complete'&&questComplete)return text.join('\n');
     const d=st()?.dialog;
     if(d?.isOpen&&!d.isWaiting){
      if(d.options.some(o=>!/click here to continue/i.test(o.text)))return text.concat(d.options.map(o=>o.text)).join('\n');
      const reply=await s.sdk.sendClickDialog(0);
      if(!reply.success)return text.concat(reply.message??'dialogue click refused').join('\n');
     }
     await waitTicks(s,1);
    }
    return text.join('\n');
   }finally{off();}
  },
  complete:()=>state()==='complete'&&questComplete,
 };
}

function observeQuestFlags(s:Session){
 const seen=new Map<number,string>();
 const observe=()=>{for(const q of questFlags(s.client)??[])if(seen.get(q.id)!==q.state){seen.set(q.id,q.state);console.log(`QUEST_SWEEP_FLAG ${JSON.stringify(q)}`);}};
 observe();const off=s.onTick(observe);void s.ended.then(off);
}
export async function sweep(account:string,quest:string,fresh?:string,options?:SweepApiOptions,deps:Partial<ApiSweepDeps>={}){
 if(quest==='hero'||quest==='heroes')throw Error('Heroes requires the explicit owned pair CLI quest-hero-owned.ts or runHeroesPair(original sessions, validated order); no single-actor partner login');
 if(quest==='tbwt'||quest==='itwatchtower')return apiSweep(account,quest,fresh,options,deps);
 return sweepPreset(account,quest,fresh);
}
export async function sweepPreset(account:string,quest:string,fresh?:string){
 if(quest==='hero'||quest==='heroes')throw Error('Heroes requires the explicit owned pair CLI quest-hero-owned.ts or runHeroesPair(original sessions, validated order); no single-actor partner login');
 const script=resolve(import.meta.dir,'generated',`quest-${quest}.ts`);
 if(!existsSync(script))throw Error(`quest sweep: no script ${script}`);
 const preset=presetFor(quest);let base=needs(preset,false,quest);const food=needs(preset,true,quest);
 const s:Session=await openBot(account);
 // A quest session has no eat guard (packages/core/src/eat-guard.ts): the staged items can be food. The hold has no release.
 holdSessionEater(s.sdk);
 const fail=(why:string)=>finish([s],false,`quest-sweep ${quest} ${why}`);
 let handed=false;
 try {
 const st=()=>s.sdk.getState();
 if(!await waitUntil(s,()=>!!st()?.player,{timeoutTicks:20}))return fail('entry state unavailable');
 if(quest==='scorpion'){
  const state=()=>Number((s.client as any).var?.[77]);
  if(!await waitUntil(s,()=>Number.isSafeInteger(state()),{timeoutTicks:20}))return fail('Barcrawl gate state unavailable');
  base=scorpionBarcrawlNeeds(base,state());
 }
 const baseLevel=(name:string)=>st()?.skills?.find((k:any)=>k.name===name)?.baseLevel??1;
 for(const id of STURDY_OPTIONAL[quest]??[])if(base.has(id)&&baseLevel('Hitpoints')>=STURDY&&baseLevel('Defence')>=STURDY){
  food.set(id,base.get(id)!);base.delete(id);
  // Without the supply the fight is paid in food: the preset's meal count rises to STURDY_MEALS.
  const meal=[...food.keys()].find(f=>MEALS.includes(f));
  if(meal!==undefined)food.set(meal,Math.max(food.get(meal)!,STURDY_MEALS));
 }
 const build=buildPack(quest,baseLevel);
 for(const i of build)base.set(i.id,(base.get(i.id)??0)+i.count);
 if(build.length){
  const meal=[...food.keys()].find(f=>MEALS.includes(f));
  if(meal!==undefined&&BUILD_MEALS[quest]!==undefined)food.set(meal,BUILD_MEALS[quest]!);
  console.log(`QUEST_SWEEP_BUILD_PACK ${JSON.stringify({quest,pack:build,meals:BUILD_MEALS[quest]})}`);
 }
 let wornKit=wornKitPlan(quest,base,st()?.inventory??[],[],s.sdk.getEquipment()),need=wornKit.need;
 const maxHp=()=>st()?.skills?.find((k:any)=>k.name==='Hitpoints')?.baseLevel??10;
 const sustain=startQuestSustain({sdk:s.sdk,tick:()=>s.tick(),onTick:cb=>s.onTick(cb),ended:s.ended,direct:async action=>{
  const reply:any=await s.direct(action);return{success:!!reply?.success,message:reply?.message===undefined?undefined:String(reply.message)};
 // An edible quest ingredient (Family Crest's cooked fish, The Knight's Sword's redberry pie) is reserved, never eaten.
 }},{food:[...questFoodDefinitions().keys()],eatAt:eatAtFor(maxHp()),reserved:reservedEdible(need)});
 void s.ended.then(()=>sustain.stop());
 sustain.aborted.addEventListener('abort',()=>console.log(`QUEST_SWEEP_SUSTAIN_FAIL ${JSON.stringify({failure:sustain.failure(),hp:st()?.player?.hp,at:at(s)})}`));
 const danger=()=>{const p=st()?.player;return!!p&&(p.combat?.inCombat||p.hp<=eatAtFor(maxHp()));};
 if(danger())console.log(`QUEST_SWEEP_DANGER ${JSON.stringify({hp:st()?.player?.hp,inCombat:st()?.player?.combat?.inCombat,at:{x:st()?.player?.worldX,z:st()?.player?.worldZ,level:st()?.player?.level}})}`);
 // The skull basement has no walk out that the world router plans: take its door, corridor and ladder first.
 if(inGhostBasement(st()?.player)){
  const locAt=(x:number,z:number)=>(st()?.nearbyLocs??[]).find((l:any)=>l.x===x&&l.z===z);
  const ops=(l:any)=>(l?.optionsWithIndex??[]) as {text:string;opIndex:number}[];
  const near=(x:number,z:number,tol:number)=>{const p=st()?.player;return!!p&&Math.max(Math.abs(p.worldX-x),Math.abs(p.worldZ-z))<=tol;};
  await leaveGhostBasement({pos:()=>st()?.player,
   openDoor:async(_l,x,z)=>{const d=locAt(x,z),op=ops(d).find(o=>/^open$/i.test(o.text));if(d&&op){await s.bot.interactLoc(d,op.opIndex);await waitUntil(s,()=>!ops(locAt(x,z)).some(o=>/^open$/i.test(o.text)),{timeoutTicks:12});}},
   dash:(l,x,z,tol)=>dashThroughDoor({pos:()=>st()?.player,
    walk:async(x,z)=>{await s.direct({type:'walkTo',x,z,running:true,reason:'SDK'});},
    arrived:(x,z,tol)=>waitUntil(s,()=>near(x,z,tol),{timeoutTicks:30}),
    closedDoor:within=>(st()?.nearbyLocs??[]).filter((d:any)=>/door|gate/i.test(d.name)&&near(d.x,d.z,within)&&ops(d).some(o=>/^open$/i.test(o.text))).sort((a:any,b:any)=>a.distance-b.distance)[0],
    open:async d=>{const l=locAt(d.x,d.z),op=ops(l).find(o=>/^open$/i.test(o.text));if(l&&op){await s.bot.interactLoc(l,op.opIndex);await waitUntil(s,()=>!ops(locAt(d.x,d.z)).some(o=>/^open$/i.test(o.text)),{timeoutTicks:12});}}},l,x,z,tol),
   waitForLadder:()=>waitUntil(s,()=>!!locAt(3104,9576)||!!(st()?.nearbyLocs??[]).find((l:any)=>ops(l).some(o=>/climb-up|climb$/i.test(o.text))&&l.distance<=3),{timeoutTicks:15}),
   climbLadder:async()=>{const l=(st()?.nearbyLocs??[]).filter((l:any)=>ops(l).some(o=>/climb-up|^climb$/i.test(o.text))).sort((a:any,b:any)=>a.distance-b.distance)[0],op=ops(l).find(o=>/climb-up|^climb$/i.test(o.text));if(l&&op){const z0=st()?.player?.worldZ??0;await s.bot.interactLoc(l,op.opIndex);await waitUntil(s,()=>(st()?.player?.worldZ??z0)<UNDERGROUND,{timeoutTicks:30});}},
   waitForLanding:()=>waitUntil(s,()=>(st()?.player?.worldZ??UNDERGROUND)<UNDERGROUND,{timeoutTicks:15})});
  console.log(`QUEST_SWEEP_LEFT_BASEMENT ${JSON.stringify({x:st()?.player?.worldX,z:st()?.player?.worldZ,level:st()?.player?.level})}`);
 }
 const ghostState=()=>questFlags(s.client)?.find(f=>f.name==='The Restless Ghost')?.state??'unknown';
 const retained=()=>quest==='priest'&&retainedGhostSkull(ghostState(),st()?.inventory??[],s.sdk.getEquipment());
 const returnSkull=async()=>{
  console.log('QUEST_SWEEP_RETAINED_SKULL '+JSON.stringify({state:ghostState(),position:st()?.player&&{x:st()!.player!.worldX,z:st()!.player!.worldZ,level:st()!.player!.level}}));
  observeQuestFlags(s);sustain.stop();handed=true;(s as {questReserved?:Record<number,number>}).questReserved=reservedEdible(need);await handOver(s,script,fresh);return;
 };
 if(quest==='priest'){
  await waitUntil(s,()=>ghostState()!=='unknown',{timeoutTicks:20});
  if((st()?.inventory??[]).some(i=>i.id===553)){
   if(!retained())return fail('retained skull requires a started journal and worn ghostspeak amulet');
   return await returnSkull();
  }
 }
 // Gertrude's Cat with the kitten given inside the lumber yard needs no inputs, and no walker leaves the yard: the
 // quest script climbs the fence itself.
 if(quest==='fluffs'){
  const journal=()=>questFlags(s.client)?.find(f=>f.name===QUEST_NAMES.fluffs)?.state??'unknown';
  await waitUntil(s,()=>journal()!=='unknown',{timeoutTicks:20});
  if(fluffsKittenGiven(journal(),st()?.inventory??[],st()?.player)){
   console.log('QUEST_SWEEP_FLUFFS_RESUME '+JSON.stringify({state:journal(),position:{x:st()!.player!.worldX,z:st()!.player!.worldZ,level:st()!.player!.level}}));
   observeQuestFlags(s);sustain.stop();handed=true;(s as {questReserved?:Record<number,number>}).questReserved=reservedEdible(need);await handOver(s,script,fresh);return;
  }
 }
 const here=():Tile=>{const p=st()?.player;return p?{x:p.worldX,z:p.worldZ,level:p.level}:{x:0,z:0,level:-1};};
 const world=await getWorld();
 const fortress=await leaveFortress(s);
 if(!fortress.ok)return fail(fortress.detail!);
 const cave=await leaveHazeelCave(s);
 if(!cave.ok)return fail(cave.detail!);
 // The world walker plans from the ground floor: an account left upstairs (Hazeel Cult ends there, Ernest the Chicken on
 // Draynor Manor's top floor) takes the nearest way down a floor at a time by the route graph; a Climb-down loc in view is
 // the fallback (the manor's top-floor stairs were out of view and the sweep failed with no way down).
 for(let i=0;i<4&&(st()?.player?.level??0)>0;i++){
  const level=st()?.player?.level??0,down=wayDown(world.navigationGraph?.().transports??[],here());
  console.log(`QUEST_SWEEP_DOWN ${JSON.stringify({from:here(),to:down})}`);
  const r=await goTo(s,world,down,accountOf(s),{legTimeoutTicks:150,planBudgetMs:SWEEP_PLAN_BUDGET_MS});
  if(r.ok&&(st()?.player?.level??level)<level)continue;
  const way=downward(st()?.nearbyLocs??[]);
  if(!way)return fail(`no way down from level ${st()?.player?.level}${r.ok?'':`: ${r.reason} ${r.detail}`}`);
  // bot.interactLoc opens a shut door on the way (Juliet's room door stands between her and the stairs).
  await s.bot.interactLoc(way.loc,way.opIndex);
  await waitUntil(s,()=>(st()?.player?.level??level)<level,{timeoutTicks:30});
 }
 if((st()?.player?.level??0)>0)return fail(`no observed descent from ${JSON.stringify(here())}`);
 if(quest==='blackknight'){
  const state=()=>questFlags(s.client)?.find(f=>f.name==="Black Knight's Fortress")?.state??'unknown';
  if(!await waitUntil(s,()=>state()!=='unknown',{timeoutTicks:20}))return fail('Black Knight journal state unavailable');
  if(returnToAmik(quest,state())){
   observeQuestFlags(s);
   const result=await finishBlackKnight(amikIO(s,world));
   if(!result.ok)return fail(result.detail!);
   return finish([s],true,'quest-sweep blackknight quest complete qp=3');
  }
 }
 const pack=():Item[]=>(st()?.inventory??[]).map((i:any)=>({id:i.id,count:i.count}));
 const seekGhostSkull=quest==='priest'&&ghostState()==='started'&&s.sdk.getEquipment().some(i=>i.id===552);
 const skill=(name:string)=>st()?.skills?.find((k:any)=>k.name===name)?.baseLevel??1;
 // A skill the quest wants and the account lacks sends the account through the bank pass too, with every supply held.
 const tradeableId=(id:number)=>(catalogItem(id) as {tradeable?:boolean}|undefined)?.tradeable;
 const bare=(BARE.has(quest)||build.length>0)&&(s.sdk.getEquipment().length>0||bareDeposits(quest,pack(),need,food,tradeableId).length>0);
 if(bare||seekGhostSkull||WORN_KIT[quest]?.some(i=>!i.required&&!s.sdk.getEquipment().some(e=>e.id===i.id))||plan(need,pack(),[]).missing.length||plan(food,pack(),[]).missing.length||questSkillTraining(quest,skill)){
  const exit=await leaveStronghold(s);
  if(!exit.ok)return fail(exit.detail!);
  // The nearest bank may be out of reach: try the next three.
  let walked:Walked={ok:false,reason:'precondition',detail:'no bank tried',ticks:0};
  for(const bank of nearestBanks(here()).slice(0,4)){
   console.log(`QUEST_SWEEP_BANK ${JSON.stringify({from:here(),to:bank})}`);
   walked=await walkFar(s,world,bank,100);
   console.log(`QUEST_SWEEP_BANK_WALK ${JSON.stringify({at:here(),to:bank,outcome:walked})}`);
   if(walked.ok)break;
  }
  // No bank in reach with few coins: the exit may be a fare. Raise it at a general store and try again.
  if(!walked.ok&&count(pack(),COINS)<200&&await raiseFare(s,world))for(const bank of nearestBanks(here()).slice(0,4)){
   walked=await walkFar(s,world,bank,100);
   console.log(`QUEST_SWEEP_BANK_WALK ${JSON.stringify({at:here(),to:bank,outcome:walked})}`);
   if(walked.ok)break;
  }
  if(!walked.ok)return fail(`bank walk failed at ${JSON.stringify(here())}: ${walked.reason} ${walked.detail}`);
  const opened=await s.bot.openBank();
  if(!opened.success)return fail('bank did not open');
  await waitUntil(s,()=>(st()?.bank?.items?.length??0)>0,{timeoutTicks:10});
  if(bare){
   // Bank the spare pack rows, take off what is worn (taking an item off shuts the bank), then bank those too.
   const bankRows=async()=>{
    for(const id of bareDeposits(quest,pack(),need,food,tradeableId)){
     const row=(st()?.inventory??[]).find((i:any)=>i.id===id);
     if(!row)continue;
     await s.bot.depositItem(row,-1);
     if(!await waitUntil(s,()=>count(pack(),id)===0,{timeoutTicks:10}))return `bare deposit unobserved ${id}`;
    }
    return null;
   };
   const first=await bankRows();
   if(first)return fail(first);
   const worn=[...s.sdk.getEquipment()];
   for(const item of worn){
    await s.bot.unequipItem(item);
    if(!await waitUntil(s,()=>!s.sdk.getEquipment().some(e=>e.slot===item.slot),{timeoutTicks:8}))return fail(`worn item ${item.id} did not come off`);
   }
   if(worn.length){
    if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!st()?.bank?.isOpen,{timeoutTicks:10}))return fail('bank did not reopen for the worn items');
    const second=await bankRows();
    if(second)return fail(second);
   }
   console.log(`QUEST_SWEEP_BARE ${JSON.stringify({worn:worn.map(i=>i.id),left:s.sdk.getEquipment().length,pack:pack().map(i=>i.id)})}`);
  }
  const rows=():Item[]=>(st()?.bank?.items??[]).map((i:any)=>({id:i.id,count:i.count}));
  wornKit=wornKitPlan(quest,base,pack(),rows(),s.sdk.getEquipment());need=wornKit.need;
  const p=plan(need,pack(),rows()),meal=mealPlan(food,pack(),rows(),p.withdraw,need);
  p.withdraw.push(...meal);
  for(const id of QUEST_KEEP[quest]??[])if(count(pack(),id)===0&&count(rows(),id)>0)p.withdraw.push({id,count:1});
  if(seekGhostSkull&&retainedGhostBankSkull(ghostState(),pack(),s.sdk.getEquipment(),rows()))p.withdraw.push({id:553,count:1});
  // A missing item a shop sells is bought after the bank: take coins for it now. Sellers rank by travel distance.
  const ranked=(d:string,at:Tile)=>sellersByTravel(sellersByDistance(d,at),at,preset.position,accountOf(s)).map(n=>({npc:n.npc,npcId:n.npcId,tile:n.tile}));
  const shops=(items:readonly Item[])=>shopPlan(items,here(),catalogItem,(d,at)=>ranked(d,at)[0]??null,ranked);
  // What no shop sells is gathered after the shops; a gather tool comes from the bank or a shop.
  const sellerAt=(id:number)=>{const it=catalogItem(id),n=it&&id!==COINS?ranked(it.debugname,here())[0]:null;return n?travelDistance(here(),n.tile):Infinity;};
  // A bow and arrows owned (pack, bank or worn) let the Ranged level count against an animal; the kit is withdrawn
  // with the gather's tools and wielded before the kill (UnderMyKilt: Ranged 97, Attack 6, a shortbow and iron arrows).
  const worn=():Item[]=>s.sdk.getEquipment().map((i:any)=>({id:i.id,count:i.count}));
  const owned=[...pack(),...rows(),...worn()];
  // A rune a shop sells completes the magic kit: the shop plan buys the casts' shortfall with the other consumables.
  const kit=rangedKit(owned),mkit=magicKit(owned,skill('Magic'),undefined,id=>sellerAt(id)<Infinity);
  // What the kit decision saw: which containers were read and the levels the style choice compares.
  const seen=(ids:readonly number[])=>Object.fromEntries(ids.filter(id=>owned.some(i=>i.id===id)).map(id=>[id,count(owned,id)]));
  console.log(`QUEST_SWEEP_KIT ${JSON.stringify({kit,mkit,bows:seen(BOWS),arrows:seen(ARROWS),bank:rows().length,pack:pack().length,worn:worn().length,ranged:skill('Ranged'),magic:skill('Magic'),attack:skill('Attack'),strength:skill('Strength')})}`);
  const gather=questGatherPlan(quest,p.missing,here(),sellerAt,undefined,skill('Attack'),kit?skill('Ranged'):1,undefined,mkit?skill('Magic'):1,skill('Strength'));
  // The quest's own fights take arrows from an account that fights with the bow (Ranged above Attack), not from one
  // that merely owns a bow.
  const questArrows=kit&&skill('Ranged')>skill('Attack')?QUEST_ARROWS[quest]??0:0;
  if(kit&&(gather.gathers.some(g=>g.kit==='ranged')||questArrows))gather.tools.push({id:kit.bow,count:1},{id:kit.arrows,count:gather.gathers.filter(g=>g.kit==='ranged').reduce((n,g)=>n+arrowsFor(g.id,g.count),0)+questArrows});
  // A magic kill takes the staff and the strike's runes for its casts (the staff's own rune costs nothing); so do the
  // quest's own fights for an account that fights with strike spells.
  const questCasts=mkit&&!questArrows&&skill('Magic')>skill('Attack')?QUEST_CASTS[quest]??0:0;
  if(mkit&&(gather.gathers.some(g=>g.kit==='magic')||questCasts)){
   const casts=gather.gathers.filter(g=>g.kit==='magic').reduce((n,g)=>n+castsFor(g.id,g.count,mkit.maxhit),0)+questCasts;
   if(mkit.staff!==undefined)gather.tools.push({id:mkit.staff,count:1});
   for(const [id,n] of Object.entries(mkit.runes))gather.tools.push({id:Number(id),count:n*casts});
  }
  // A skill the quest wants and the account lacks is trained after the gathers; its tool joins the gather's tools.
  const training=questSkillTraining(quest,skill);
  if(training)gather.tools.push(...training.tools);
  // A tool already worn (the bow, the arrows) counts as held; the gather's tools are kept by the deposit pass.
  const tools=toolPlan(gather.tools,need,pack(),worn(),rows(),p.withdraw);
  p.withdraw.push(...tools.withdraw);
  const manorFood=manorFoodNeed(quest,p.missing),manorPoison=manorPoisonNeed(quest,p.missing),heckelDust=heckelDustNeed(quest,p.missing);
  const shopNeeds=groundShopNeeds(quest,gather.still).filter(m=>!(manorFood&&m.id===MANOR_FOOD.id)&&!(manorPoison&&m.id===MANOR_POISON.id));
  gather.gathers=leaveToManorTrip(gather.gathers,manorFood,manorPoison);
  const toolIds=new Set(gather.tools.map(t=>t.id));
  let shop=shops([...shopNeeds,...tools.missing]);
  // A field on the way beats a seller off it (onions at Lumbridge over Hudo, when redberries take the tour to Port Sarim):
  // the pick goes before the gathers, as an ingredient of a dye does, and the shop plan is drawn again without it.
  const instead=pickInstead(shop.buys,here(),preset.position);
  if(instead.picks.length){
   console.log(`QUEST_SWEEP_PICK_INSTEAD ${JSON.stringify(instead.picks)}`);
   gather.gathers.unshift(...instead.picks.map(i=>({id:i.id,count:i.count,how:'pick' as const})));
   shop=shops([...shopNeeds,...tools.missing].filter(i=>!instead.picks.some(p=>p.id===i.id)));
  }
  // A kit consumable (arrows, runes) is estimated with a margin: nine in ten of the shortfall from the shops serve, where
  // 17 of 18 air runes from three sellers ended a run whose casts were budgeted at three a goblin.
  const consumable=new Set(tools.missing.filter(t=>STACKS.has(t.id)).map(t=>t.id));
  for(const b of shop.buys)if(consumable.has(b.id))b.atLeast=Math.ceil(b.count*0.9);
  if(gather.gathers.length)console.log(`QUEST_SWEEP_GATHER_PLAN ${JSON.stringify(gather)}`);
  if(shop.unsold.length){await s.bot.closeBank();return fail('missing '+shop.unsold.map(i=>`${i.id}:${i.count}`).join(',')+(shop.buys.length?' (unsold; others in shops)':''));}
  // Recipes paid in dialogue (Aggie's dyes, Wyson's woad leaves) take their coins out with the shop money, and so do the
  // two boat fares when a destination lies east of Ardougne: a plan of Wyson's woad and Aggie's blue dye alone budgets 25
  // coins, and crossEast refuses the crossing below 60.
  shop.coins+=gather.coins+(heckelDust?HECKEL_DUST.coins:0)+fares(here(),[...shop.buys.map(b=>b.tile),preset.position,...gather.gathers.flatMap(g=>g.how==='npc'&&NPC_SOURCES[g.id]?[NPC_SOURCES[g.id]!.tile]:[])],accountOf(s))
   +(quest==='itgronigen'&&eastOfPass(here(),accountOf(s))?BOAT_FARES:0);
  if(shop.coins){
   const take=shopCoinTake(shop.coins,count(pack(),COINS),p.withdraw.find(w=>w.id===COINS)?.count??0,need.get(COINS)??0);
   if(count(rows(),COINS)<take){await s.bot.closeBank();return fail(`missing ${COINS}:${take} to buy ${[...shop.buys.map(b=>b.id),...(heckelDust?[1975]:[])].join(',')}`+(shop.buys.some(b=>wornKit.wear.some(i=>i.required&&i.id===b.id))?' (required worn kit unavailable)':''));}
   if(take>0){const c=p.withdraw.find(w=>w.id===COINS);if(c)c.count+=take;else p.withdraw.push({id:COINS,count:take});}
   console.log(`QUEST_SWEEP_SHOP_PLAN ${JSON.stringify({buys:shop.buys,coins:shop.coins})}`);
  }
  // Free the slots the withdrawals, the shop purchases and the gathered items need, plus the pickups: whole kinds the
  // quest does not use first, one deposit per kind, then food beyond the allowance.
  const tradeable=(id:number)=>(catalogItem(id) as {tradeable?:boolean}|undefined)?.tradeable;
  const keep=(id:number)=>need.has(id)||toolIds.has(id)||keepsItem(quest,id,tradeable);
  // Another quest's untradeable leftovers go to the bank when the inputs still want slots, so they are not counted as
  // staying when the slots to free are sized (counted, nine of them capped the slots at 18 for 26 inputs). Only while
  // this quest's journal entry is not started: a resumed quest's own intermediate items (Excalibur on a Merlin's Crystal
  // resume) are untradeable and in neither list, and the withdrawals are planned before the deposits.
  const journal=questFlags(s.client)?.find(f=>f.name===QUEST_NAMES[quest])?.state;
  const leftover=(id:number)=>journal==='not started'&&!need.has(id)&&!toolIds.has(id)&&!(QUEST_KEEP[quest]??[]).includes(id)&&tradeable(id)===false;
  const slots=slotNeed(slotsFor([...p.withdraw,...shop.buys.map(b=>({id:b.id,count:b.count})),...gather.gathers.map(g=>({id:g.id,count:g.count})),...(manorFood?[{id:MANOR_FOOD.id,count:1}]:[]),...(manorPoison?[{id:MANOR_POISON.id,count:1}]:[]),...(heckelDust?[{id:1975,count:1}]:[]),...(QUEST_PICKUPS[quest]??[]),...(training?.pickups??[])],pack()),staysCount(pack(),id=>keep(id)&&!leftover(id)));
  for(const d of depositPlan(pack(),slots,keep,leftover)){
   const item=(st()?.inventory??[]).find((i:any)=>i.id===d.id);
   if(!item)continue;
   const r:any=await s.bot.depositItem(item,d.count);
   console.log(`QUEST_SWEEP_DEPOSIT ${JSON.stringify({id:d.id,count:d.count,success:r?.success,message:r?.message,free:28-(st()?.inventory?.length??0)})}`);
  }
  console.log(`QUEST_SWEEP_BANK_PASS ${JSON.stringify({withdraw:p.withdraw,slots,free:28-pack().length})}`);
  // Milk replaces its staged bucket. Other gathered inputs need additional slots.
  const inputs=[...p.withdraw,...shop.buys,...gather.gathers.filter(g=>g.how!=='milk'),...(manorFood?[{id:MANOR_FOOD.id,count:1}]:[]),...(manorPoison?[{id:MANOR_POISON.id,count:1}]:[]),...(heckelDust?[{id:1975,count:1}]:[])];
  const capacity=await reserveInputSlots(s,inputs,new Set([...need.keys(),...toolIds,...inputs.map(i=>i.id),...pack().map(i=>i.id).filter(id=>keep(id)||STACKS.has(id))]));
  if(capacity){await s.bot.closeBank();return fail(capacity);}
  for(const w of p.withdraw){
   const row=(st()?.bank?.items??[]).find((i:any)=>i.id===w.id);
   const before=count(pack(),w.id),bankBefore=count(rows(),w.id);
   if(!row)return fail(`bank row ${w.id} vanished`);
   await s.bot.withdrawItem(row,w.count);
   const observed=await waitUntil(s,()=>count(pack(),w.id)===before+w.count&&count(rows(),w.id)===bankBefore-w.count,{timeoutTicks:10});
   console.log(`QUEST_SWEEP_WITHDRAW ${JSON.stringify({id:w.id,count:w.count,before,after:count(pack(),w.id),bankBefore,bankAfter:count(rows(),w.id),observed})}`);
   if(!observed)return fail(`withdraw debit unobserved ${w.id}:${w.count}`);
  }
  await s.bot.closeBank();
  console.log(`QUEST_SWEEP_BANK_DONE ${JSON.stringify({at:here(),buys:shop.buys.map(b=>b.id),gathers:gather.gathers.map(g=>g.id)})}`);
  if(shop.buys.length){const why=await buyFromShops(s,world,shop.buys);if(why)return fail(why);}
  if(heckelDust){const dust=await fetchHeckelDust(heckelIO(s,world));if(!dust.ok)return fail(dust.detail!);}
  if(manorFood||manorPoison){const food=await fetchManorFishFood(manorIO(s,world),preset.position,{food:manorFood,poison:manorPoison});if(!food.ok)return fail(food.detail!);}
  if(gather.gathers.length){const why=await gatherItems(s,world,gather.gathers,(to)=>walkFar(s,world,to,100));if(why)return fail(why);}
  if(training){const why=await trainFishing(s,world,training.level);if(why)return fail(why);}
  const left=plan(need,pack(),[]).missing;
  if(left.length)return fail('withdraw short '+left.map(i=>`${i.id}:${i.count}`).join(','));
 }
 const worn=await wearQuestKit(s,wornKit.wear);
 if(worn)return fail(worn);
 if(retained())return await returnSkull();
 const start=preset.position;
 const exit=await leaveStronghold(s);
 if(!exit.ok)return fail(exit.detail!);
 const unprayed=await prayBefore(s,world,quest);
 if(unprayed)return fail(unprayed);
 await reachStart(s,world,start,quest);
 if(wornKit.wear.some(i=>!s.sdk.getEquipment().some(e=>e.id===i.id&&e.count>0)))return fail('worn kit missing before handover');
 console.log(`MILESTONE quest-sweep ${quest} staged at ${JSON.stringify(here())}`);
 observeQuestFlags(s);
 sustain.stop();
 handed=true;
 (s as {questReserved?:Record<number,number>}).questReserved=reservedEdible(need);await handOver(s,script,fresh);
 } catch(error) {
  if(handed)throw error;
  return fail(String(error));
 }
}

async function main(){
 const [account,quest,optionsPath]=process.argv.slice(2);
 if(!account||!quest)throw Error('usage: bun scripts/quest-sweep.ts <account> <quest> [api-options.json]');
 let options:SweepApiOptions|undefined;if((quest==='tbwt'||quest==='itwatchtower')&&optionsPath){const bytes=readFileSync(optionsPath);if(bytes.length>32768)throw Error('quest sweep options file too large');let value:unknown;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw Error('invalid quest sweep options JSON');}options=apiOptions(quest,value);}
 // As a bot-host entry, the quest module's finish() (plain bot.ts) reports through this entry's own finish, which
 // the host rewrites to the per-bot one; without it the quest's finish would end the whole host.
 if((globalThis as {__rsBotHost?:unknown}).__rsBotHost)finishHooks.set(account.toLowerCase(),(ok,detail)=>{void finish([],ok,detail);});
 // A unique query: in a bot host, each account runs the quest module afresh.
 const fresh=`run=${account.toLowerCase()}-${Date.now()}`;if((quest==='tbwt'||quest==='itwatchtower')&&!optionsPath)await sweepPreset(account,quest,fresh);else await sweep(account,quest,fresh,options);
}

if(import.meta.main)await main();
