// Quest sweep: run one generated quest (scripts/generated/quest-<quest>.ts) on an ordinary account from wherever it
// stands. The quest's practice preset names its start tile and pack. This runner takes the missing pack items from the
// nearest bank, walks to the start tile and hands its session to the quest script, which owns the quest, the RESULT
// line and the logout. A missing item ends the run before travel with `missing id:count` (acquisition work).
// Usage: bun scripts/quest-sweep.ts <account> <quest>      e.g. bun scripts/quest-sweep.ts Mightyrod blackknight
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {openBot,finish,getWorld,accountOf} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {goTo,sessionWalker,walkPath,walkRoute,type PathDeps} from '../packages/core/src/walk';
import type {World} from '../packages/core/src/world';
import {loadTravel} from '../packages/core/src/travel';
import {nearestSeller} from '../packages/core/src/shop-index';
import {questFlags} from '../packages/core/src/quest-status';
import {PRESETS,type SaveConfig} from '../packages/practice/src/presets';
import travel from '../packages/planner/src/haggis-travel.json';

type Item={id:number;count:number};
type Tile={x:number;z:number;level:number};
const BANKS:Tile[]=Object.values((travel as unknown as {banks:Record<string,Tile>}).banks);

export function presetFor(quest:string):SaveConfig&{position:Tile}{
 const p=PRESETS['quest_'+quest];
 if(!p?.position)throw Error(`quest sweep: no preset quest_${quest} with a start tile`);
 return{...p,position:{level:0,...p.position},...(quest==='hazeelcult'?{inventory:[{id:385,count:4}]}:{})};
}
// Preset food (lobster, shark) only feeds the quest's eat-at threshold, and teleport runes (fire, water, air, earth,
// law) only save walking (quest-lib teleport walks without a law rune): the runner takes what the bank holds of both.
export const FOOD=new Set([379,385,554,555,556,557,563]),COINS=995;
export function needs(preset:SaveConfig,food=false):Map<number,number>{
 const m=new Map<number,number>();
 for(const i of preset.inventory??[])if(FOOD.has(i.id)===food)m.set(i.id,(m.get(i.id)??0)+i.count);
 if(!food&&preset.coins)m.set(COINS,(m.get(COINS)??0)+preset.coins);
 return m;
}
const count=(rows:readonly Item[],id:number)=>rows.filter(r=>r.id===id).reduce((n,r)=>n+r.count,0);
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
 const walked=await approach({x:2461,z:3385,level:0});
 if(!walked.ok)return{ok:false,detail:'Stronghold north gate approach failed'};
 const n=pos();
 if(n?.worldX!==2461||n.worldZ!==3385||n.level!==0)return{ok:false,detail:'Stronghold north landing unobserved'};
 await s.direct({type:'interactLoc',x:2459,z:3383,locId:190,optionIndex:1,reason:'SDK'});
 const crossed=await waitUntil(s,()=>{const p=pos();return p?.worldX===2461&&p.worldZ===3382&&p.level===0;},{timeoutTicks:30});
 console.log(`QUEST_SWEEP_GATE ${JSON.stringify({ok:crossed,at:pos()&&{x:pos()!.worldX,z:pos()!.worldZ,level:pos()!.level}})}`);
 return{ok:crossed,detail:crossed?undefined:'Stronghold southern landing unobserved'};
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

async function reachStart(s:Session,world:World,start:Tile){
 const p=s.sdk.getState()?.player;
 const walk=async(to:Tile)=>{
  const r=await goTo(s,world,to,accountOf(s),{legTimeoutTicks:150});
  if(!r.ok)throw Error(`start walk failed to ${JSON.stringify(to)}: ${r.reason} ${r.detail}`);
 };
 const corridor=async(points:readonly Pt[])=>{
  const r=await walkCorridor(await sessionWalker(s),points);
  if(!r.ok)throw Error(`corridor walk failed to ${points[points.length-1]!.join(',')} at ${JSON.stringify(r.at)}`);
 };
 if(p?.level===0&&p.worldX<2800&&p.worldZ>=3270&&start.level===0&&start.x>=2950){
  if(count(s.sdk.getState()?.inventory??[],COINS)<60)throw Error('missing 995:60 for safe boat route');
  const sail=async(id:string)=>{
   const t=loadTravel().find(t=>t.id===id);
   if(!t?.from)throw Error(`safe boat route unavailable: ${id}`);
   // KARAMJA ends within 4 tiles of 2956,3146, so within 7 of the customs officer at 2953,3147. The travel leg
   // only needs the NPC in view; goTo has no Karamja route there.
   const q=s.sdk.getState()?.player;
   if(!q||q.level!==t.from.level||Math.max(Math.abs(q.worldX-t.from.x),Math.abs(q.worldZ-t.from.z))>8)await walk(t.from);
   const r=await walkRoute(s,[{kind:'travel',travel:t,at:t.from,to:t.to}],{maxRetriesPerLeg:1,legTimeoutTicks:150});
   if(!r.ok)throw Error(`safe boat route failed: ${r.reason} ${r.detail}`);
   console.log(`QUEST_SWEEP_BOAT ${JSON.stringify({id,coins:t.coins})}`);
  };
  await sail('npc:captain_barnaby:brimhaven@2679,3275');
  await corridor(KARAMJA);
  await sail('npc:customs_officer:port-sarim@2953,3147');
  await corridor(SARIM_NORTH);
 }
 await walk(start);
}

// Missing quest items a shop sells: the nearest seller of each (shop-index.ts), and the coins to take for them
// (3 times the item's base cost, plus 100). Items no shop sells stay missing.
export type Buy={id:number;count:number;name:string;npcId:number;npc:string;tile:Tile};
export function shopPlan(missing:readonly Item[],at:Tile,item:(id:number)=>{debugname:string;name:string;cost:number}|undefined,
 seller:(debugname:string,at:Tile)=>{npc:string;npcId:number;tile:Tile}|null){
 const buys:Buy[]=[],unsold:Item[]=[];let coins=0;
 for(const m of missing){
  const it=item(m.id),s=it&&m.id!==COINS?seller(it.debugname,at):null;
  if(!it||!s){unsold.push(m);continue;}
  buys.push({id:m.id,count:m.count,name:it.name,npcId:s.npcId,npc:s.npc,tile:s.tile});coins+=3*Math.max(1,it.cost)*m.count;
 }
 return{buys,unsold,coins:buys.length?coins+100:0};
}
let itemCatalog:Map<number,{debugname:string;name:string;cost:number}>|undefined;
const catalogItem=(id:number)=>(itemCatalog??=new Map((JSON.parse(readFileSync(resolve(import.meta.dir,'../knowledge/items.json'),'utf8')) as {id:number;debugname:string;name:string;cost:number}[]).map(i=>[i.id,i])) ).get(id);

// Walk to each seller, open its shop and buy. Ok when the pack holds the bought counts.
async function buyFromShops(s:Session,world:World,buys:readonly Buy[]):Promise<string|null>{
 const st=()=>s.sdk.getState() as any,held=(id:number)=>count((st()?.inventory??[]).map((i:any)=>({id:i.id,count:i.count})),id);
 for(const b of buys){
  const walked=await goTo(s,world,b.tile,accountOf(s),{legTimeoutTicks:100});
  if(!walked.ok)return `shop walk to ${b.npc} at ${b.tile.x},${b.tile.z} failed: ${walked.reason} ${walked.detail}`;
  const npc=(st()?.nearbyNpcs??[]).filter((n:any)=>n.id===b.npcId).sort((x:any,y:any)=>x.distance-y.distance)[0];
  if(!npc)return `${b.npc} not in sight at ${b.tile.x},${b.tile.z}`;
  if(!(await s.bot.openShop(npc)).success)return `${b.npc} shop did not open`;
  await waitUntil(s,()=>!!st()?.shop?.isOpen,{timeoutTicks:10});
  const row=(st()?.shop?.shopItems??[]).find((i:any)=>i.id===b.id);
  if(!row||row.count<1){await s.bot.closeShop();return `${b.npc} has no ${b.name} in stock`;}
  const before=held(b.id);
  await s.bot.buyFromShop(row,b.count);
  const got=await waitUntil(s,()=>held(b.id)>=before+b.count,{timeoutTicks:10});
  console.log(`QUEST_SWEEP_BUY ${JSON.stringify({item:b.id,name:b.name,count:b.count,npc:b.npc,before,after:held(b.id),coins:held(COINS)})}`);
  await s.bot.closeShop();
  if(!got)return `bought ${held(b.id)-before} of ${b.count} ${b.name} from ${b.npc}`;
 }
 return null;
}

async function main(){
 const [account,quest]=process.argv.slice(2);
 if(!account||!quest)throw Error('usage: bun scripts/quest-sweep.ts <account> <quest>');
 const script=resolve(import.meta.dir,'generated',`quest-${quest}.ts`);
 if(!existsSync(script))throw Error(`quest sweep: no script ${script}`);
 const preset=presetFor(quest),need=needs(preset),food=needs(preset,true);
 const s:Session=await openBot(account);
 const fail=(why:string)=>finish([s],false,`quest-sweep ${quest} ${why}`);
 let handed=false;
 try {
 const st=()=>s.sdk.getState();
 if(!await waitUntil(s,()=>!!st()?.player,{timeoutTicks:20}))return fail('entry state unavailable');
 const here=():Tile=>{const p=st()?.player;return p?{x:p.worldX,z:p.worldZ,level:p.level}:{x:0,z:0,level:-1};};
 const world=await getWorld();
 // The world walker plans from the ground floor: an account left upstairs (Hazeel Cult ends there) climbs down first.
 for(let i=0;i<3&&(st()?.player?.level??0)>0;i++){
  const down=(st()?.nearbyLocs??[]).filter((l:any)=>(l.optionsWithIndex??[]).some((o:any)=>/climb-down/i.test(o.text))).sort((a:any,b:any)=>a.distance-b.distance)[0];
  if(!down)return fail(`no way down from level ${st()?.player?.level}`);
  const level=st()?.player?.level??0,op=down.optionsWithIndex.find((o:any)=>/climb-down/i.test(o.text))?.opIndex??1;
  await s.direct({type:'interactLoc',x:down.x,z:down.z,locId:down.id,optionIndex:op,reason:'SDK'});
  await waitUntil(s,()=>(st()?.player?.level??level)<level,{timeoutTicks:30});
 }
 const pack=():Item[]=>(st()?.inventory??[]).map((i:any)=>({id:i.id,count:i.count}));
 if(plan(need,pack(),[]).missing.length||plan(food,pack(),[]).missing.length){
  const exit=await leaveStronghold(s);
  if(!exit.ok)return fail(exit.detail!);
  const bank=nearestBank(here());
  console.log(`QUEST_SWEEP_BANK ${JSON.stringify({from:here(),to:bank})}`);
  const walked=await goTo(s,world,bank,accountOf(s),{legTimeoutTicks:100});
  console.log(`QUEST_SWEEP_BANK_WALK ${JSON.stringify({at:here(),to:bank,outcome:walked})}`);
  if(!walked.ok)return fail(`bank walk failed at ${JSON.stringify(here())}: ${walked.reason} ${walked.detail}`);
  const opened=await s.bot.openBank();
  if(!opened.success)return fail('bank did not open');
  await waitUntil(s,()=>(st()?.bank?.items?.length??0)>0,{timeoutTicks:10});
  const rows=():Item[]=>(st()?.bank?.items??[]).map((i:any)=>({id:i.id,count:i.count}));
  const p=plan(need,pack(),rows()),meal=plan(food,pack(),rows()).withdraw;
  p.withdraw.push(...meal);
  // A missing item a shop sells is bought after the bank: take coins for it now.
  const shop=shopPlan(p.missing,here(),catalogItem,(d,at)=>{const n=nearestSeller(d,at);return n&&{npc:n.npc,npcId:n.npcId,tile:n.tile};});
  if(shop.unsold.length){await s.bot.closeBank();return fail('missing '+shop.unsold.map(i=>`${i.id}:${i.count}`).join(',')+(shop.buys.length?' (unsold; others in shops)':''));}
  if(shop.coins){
   const take=Math.max(0,shop.coins-count(pack(),COINS)-(p.withdraw.find(w=>w.id===COINS)?.count??0));
   if(count(rows(),COINS)<take){await s.bot.closeBank();return fail(`missing ${COINS}:${take} to buy ${shop.buys.map(b=>b.id).join(',')}`);}
   if(take>0){const c=p.withdraw.find(w=>w.id===COINS);if(c)c.count+=take;else p.withdraw.push({id:COINS,count:take});}
   console.log(`QUEST_SWEEP_SHOP_PLAN ${JSON.stringify({buys:shop.buys,coins:shop.coins})}`);
  }
  // Free the slots the withdrawals need: bank every pack item the quest does not use.
  const slots=p.withdraw.reduce((n,i)=>n+i.count,0);
  if(28-(st()?.inventory?.length??0)<slots)for(const i of [...(st()?.inventory??[])])if(!need.has(i.id))await s.bot.depositItem(i,-1);
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
  if(shop.buys.length){const why=await buyFromShops(s,world,shop.buys);if(why)return fail(why);}
  const left=plan(need,pack(),[]).missing;
  if(left.length)return fail('withdraw short '+left.map(i=>`${i.id}:${i.count}`).join(','));
 }
 const start=preset.position;
 const exit=await leaveStronghold(s);
 if(!exit.ok)return fail(exit.detail!);
 await reachStart(s,world,start);
 console.log(`MILESTONE quest-sweep ${quest} staged at ${JSON.stringify(here())}`);
 const seen=new Map<number,string>();
 const observe=()=>{for(const q of questFlags(s.client)??[])if(seen.get(q.id)!==q.state){
  seen.set(q.id,q.state);console.log(`QUEST_SWEEP_FLAG ${JSON.stringify(q)}`);
 }};
 observe();const off=s.onTick(observe);void s.ended.then(off);
 (globalThis as {QUEST_SESSION?:Session}).QUEST_SESSION=s;
 handed=true;
 await import(script);
 } catch(error) {
  if(handed)throw error;
  return fail(String(error));
 }
}

if(import.meta.main)await main();
