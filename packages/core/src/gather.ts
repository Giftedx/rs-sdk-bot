// Gathering items no shop sells: a ground spawn (maps OBJ, spawn-index.ts), milk from a cow with an empty bucket
// (npc/scripts/cow_milking.rs2), or a loc that hands the item out. Shared by scripts/quest-sweep.ts (quest packs)
// and scripts/gather-spawn.ts (route supplies).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { accountOf } from './bot';
import type { Session } from './inprocess';
import { waitTicks, waitUntil } from './ticks';
import { goTo } from './walk';
import { componentId } from './logout';
import type { World } from './world';
import { spawnsByDistance, locsByDistance } from './spawn-index';

type Item = { id: number; count: number };
type Tile = { x: number; z: number; level: number };
const count = (rows: readonly Item[], id: number) => rows.filter(r => r.id === id).reduce((n, r) => n + r.count, 0);

// The bucket is a pack item like any other: bank or shop.
export const MILK=1927,BUCKET=1925,COW=81;
// Garlic: the cupboard upstairs in Morgan's house, Draynor (general_use/scripts/cupboards.rs2:34, loc 2612 shut,
// 2613 open: Open, then Search). The only shops are the Greengrocers on Miscellania and in Rellekka.
export const LOC_SOURCES:Record<number,{tile:Tile;open:RegExp;take:RegExp}>={1550:{tile:{x:3096,z:3268,level:1},open:/^open$/i,take:/^search$/i}};
export type Gather={id:number;count:number;how:'spawn'|'milk'|'loc'|'kill'|'pick'|'npc'|'combine';kit?:'ranged'|'magic'};
// A plant picked for its item: onions are loc 3366 with the Pick option (general_use/scripts/pickables.rs2:31-39; the
// plant stands again 50 ticks after a pick).
// The five pickable plants (general_use/scripts/pickables.rs2; tiles in knowledge/pickables.json): a cabbage from the
// fields beside Falador or Draynor is nearer than any cabbage shop.
export const PICK_SOURCES:Record<number,{loc:number;option:RegExp}>={1957:{loc:3366,option:/^pick$/i},1965:{loc:1161,option:/^pick$/i},1942:{loc:312,option:/^pick$/i},1947:{loc:313,option:/^pick$/i},1779:{loc:2646,option:/^pick$/i}};
// An item an NPC hands over in dialogue for ingredients and coins: Aggie in Draynor makes red dye from 3 redberries,
// yellow from 2 onions and blue from 2 woad leaves, 5 coins each (area_draynor/scripts/aggie.rs2:71-115); Wyson the
// gardener in Falador park sells 2 woad leaves for 20 coins (area_falador/scripts/wyson_the_gardener.rs2:26-35).
// `choices` are the dialogue options taken in order; a page with no matching option is continued.
export type NpcSource={npc:number;name:string;tile:Tile;needs:Item[];coins:number;yields:number;choices:RegExp[]};
const AGGIE={npc:922,name:'Aggie',tile:{x:3086,z:3259,level:0}},WYSON={npc:36,name:'Wyson the gardener',tile:{x:3027,z:3379,level:0}};
export const NPC_SOURCES:Record<number,NpcSource>={
 1793:{...WYSON,needs:[],coins:20,yields:2,choices:[/looking for woad leaves/i,/how about 20 coins/i]},
 1763:{...AGGIE,needs:[{id:1951,count:3}],coins:5,yields:1,choices:[/make dyes for me/i,/make red dye/i,/^okay, make me some red dye/i]},
 1765:{...AGGIE,needs:[{id:1957,count:2}],coins:5,yields:1,choices:[/make dyes for me/i,/make yellow dye/i,/^okay, make me some yellow dye/i]},
 1767:{...AGGIE,needs:[{id:1793,count:2}],coins:5,yields:1,choices:[/make dyes for me/i,/make blue dye/i,/^okay, make me some blue dye/i]},
};
// Two items used on each other: orange dye is red on yellow (skill_crafting/scripts/dye_mixing.rs2).
export const COMBINE_SOURCES:Record<number,[number,number]>={1769:[1763,1765]};
// A bow and arrows the account owns: shortbow or longbow, bronze, iron or steel arrows (the kinds the fleet's banks hold).
export const BOWS=[841,839,843,845],ARROWS=[884,886,882],ARROWS_PER_KILL=6;
// The strike spells (skill_combat/configs/magic/magic_combat_spells.dbrow): level, runes per cast and max hit. A worn
// elemental staff stands in for its rune (skill_magic/configs/magic_staff.dbrow). Fire Strike's 8 kills a goblin in one
// cast and a bear in four.
export const SPELLS=[
 {component:'magic:wind_strike',level:1,runes:{558:1,556:1},maxhit:2},
 {component:'magic:water_strike',level:5,runes:{558:1,555:1,556:1},maxhit:4},
 {component:'magic:earth_strike',level:9,runes:{558:1,557:2,556:1},maxhit:6},
 {component:'magic:fire_strike',level:13,runes:{558:1,554:3,556:2},maxhit:8},
] as const;
export const STAFF_RUNE:Record<number,number>={1381:556,1397:556,1383:555,1395:555,1385:557,1399:557,1387:554,1393:554};
export const CASTS_MIN=6;
export type MagicKit={staff?:number;component:string;level:number;maxhit:number;runes:Record<number,number>};
// The strongest strike the Magic level allows whose runes, less the one a staff owned covers, are owned for CASTS_MIN casts
// (TheFullMonty: Magic 99, a staff of fire, air and mind runes: Fire Strike at 2 air and 1 mind a cast).
// `casts`: the casts the runes must cover. The plan asks for CASTS_MIN; a fight asks for one more kill's casts, so a
// series that has spent most of its budget still takes its last easy animal (a chicken after a bear).
export function magicKit(owned:readonly Item[],magic:number,casts=CASTS_MIN):MagicKit|null{
 const have=(id:number)=>owned.filter(i=>i.id===id).reduce((c,i)=>c+i.count,0);
 const staffs=Object.keys(STAFF_RUNE).map(Number).filter(id=>have(id)>=1);
 for(const sp of [...SPELLS].reverse()){
  if(sp.level>magic)continue;
  for(const staff of [...staffs,undefined]){
   const runes:Record<number,number>=Object.fromEntries(Object.entries(sp.runes).filter(([id])=>staff===undefined||STAFF_RUNE[staff]!==Number(id)).map(([id,n])=>[Number(id),n]));
   if(Object.entries(runes).every(([id,n])=>have(Number(id))>=n*casts))return{staff,component:sp.component,level:sp.level,maxhit:sp.maxhit,runes};
  }
 }
 return null;
}
// Casts for the kills: the animal's combat level stands for its hitpoints, three casts in five land, and one more a kill
// (a goblin's 5: two Fire Strikes, six Wind Strikes).
// Casts a kill takes: the animal's hitpoints over half the spell's max hit (the mean of a hit), at three hits in five,
// plus one; the strike goes out every five ticks whether or not the last one landed.
export const castsPerKill=(id:number,maxhit:number)=>{const src=KILL_SOURCES[id];return src?Math.ceil(src.hp/(maxhit/2)/0.6)+1:0;};
// Casts for the series: a chance drop's kills are the attempts the drop may take, so the plan buys runes for the series;
// a fight asks castsPerKill, one animal's casts, so a series that has spent most of its budget still takes its next animal.
export const castsFor=(id:number,count:number,maxhit:number)=>{const src=KILL_SOURCES[id];if(!src)return 0;const kills=src.chance<1?killAttempts(id,count):count;return kills*castsPerKill(id,maxhit);};
// The arrows are the kind owned in the greatest number (UnderMyKilt: 21 bronze, 19 iron): the shortfall for a long kill
// series is bought, and bronze arrows are the kind most shops sell.
export function rangedKit(owned:readonly Item[]):{bow:number;arrows:number}|null{
 const have=(id:number)=>owned.filter(i=>i.id===id).reduce((c,i)=>c+i.count,0);
 const bow=BOWS.find(id=>have(id)>=1),arrows=[...ARROWS].filter(id=>have(id)>=ARROWS_PER_KILL).sort((a,b)=>have(b)-have(a))[0];
 return bow!==undefined&&arrows!==undefined?{bow,arrows}:null;
}
export const CLUSTER=20;
// Spawn tiles with at least `min` of their list within CLUSTER tiles. A series of kills for a drop by chance wants a dense
// cluster (Lumbridge's 20 goblin tiles, Port Sarim's 12, the Goblin Village's 21), not a lone pair east of Varrock, where
// a series waited out its budget on one goblin at a time.
export const SERIES_CLUSTER=4;
export const denseSpawns=(tiles:readonly Tile[],min=SERIES_CLUSTER):Tile[]=>tiles.filter(t=>tiles.filter(u=>u.level===t.level&&Math.max(Math.abs(u.x-t.x),Math.abs(u.z-t.z))<=CLUSTER).length>=min);
// Meats no shop sells drop from animals on death, every kill (drop tables/scripts/cow.rs2, chicken.rs2, giant_rat.rs2,
// bear.rs2 `always` rows); goblin mail drops from a goblin on 5 of 128 rolls (goblin.rs2:19,53; 10 of 128 for the Goblin
// Village ones, :75,119). The account kills the nearest one and takes the drop. NPC ids and spawns come from
// knowledge/npcs.json. `combat` is the strongest of the animal's forms. An account fights one only below its Attack level,
// or at combat 6 or less (a chicken, cow or giant rat dies to anyone): a dark bear (19) killed an 81-hitpoint, Attack 6
// account on practice. `chance` is the drop's share of kills; the attempt budget follows it.
export const KILL_SOURCES:Record<number,{npcs:number[];name:string;combat:number;hp:number;chance:number}>={
 2132:{npcs:[81],name:'cow',combat:2,hp:8,chance:1},2138:{npcs:[41,1017],name:'chicken',combat:1,hp:3,chance:1},2134:{npcs:[86,87,950],name:'giant rat',combat:6,hp:5,chance:1},
 2136:{npcs:[105,106],name:'bear',combat:21,hp:27,chance:1},288:{npcs:[100,101,298,299],name:'goblin',combat:5,hp:5,chance:5/128},
 // Imp Catcher's beads (imp.rs2:10-19): one roll of 128 a kill, five faces each for black, red, white and yellow.
 1470:{npcs:[708],name:'imp',combat:2,hp:8,chance:5/128},1472:{npcs:[708],name:'imp',combat:2,hp:8,chance:5/128},
 1474:{npcs:[708],name:'imp',combat:2,hp:8,chance:5/128},1476:{npcs:[708],name:'imp',combat:2,hp:8,chance:5/128},
};
// The drops a kill series takes: its own item and every later kill item of the same animal still short (the four
// beads fall from the same imps, so a red bead lying by a black-bead kill is picked up, not killed for again).
export const sharedDrops=(gathers:readonly Gather[],g:Gather,held:(id:number)=>number,targets:ReadonlyMap<number,number>):number[]=>
 [g.id,...gathers.filter(o=>o!==g&&o.how==='kill'&&KILL_SOURCES[o.id]?.npcs.some(n=>KILL_SOURCES[g.id]?.npcs.includes(n))&&held(o.id)<(targets.get(o.id)??held(o.id)+o.count)).map(o=>o.id)];
// Kills allowed for `count` drops: half again the expected number, plus three misses.
export const killAttempts=(id:number,count:number)=>Math.ceil(count/(KILL_SOURCES[id]?.chance??1)*1.5)+3;
export const EASY_KILL=6;
// The style that beats the animal. An easy animal that drops every kill (a chicken, a rat) dies to bare hands and costs
// no arrows or runes, but only for an account with no kit: a wielded bow fires an arrow and a wielded staff with
// autocast casts on every attack, so with a kit the kill is the kit's and its ammunition is budgeted (a staff account's
// bare-hand rat spent the mind runes its bear needed). Otherwise the highest level that beats the animal's combat level wins: melee by the Attack level,
// the bow by Ranged, the strike spell by Magic (Ranged and Magic are 1 without a kit). The sweep's melee is bare-handed,
// so it also needs a Strength level at or above the animal's combat level: an Attack level in the sixties with Strength
// near 1 does not beat a bear or a series of goblins. A drop by chance (goblin mail) is a series of kills and takes the
// stronger style even against an easy animal.
export type KillStyle='melee'|'ranged'|'magic';
export function killStyle(id:number,attack:number,ranged=1,magic=1,strength=attack):KillStyle|null{
 const src=KILL_SOURCES[id];
 if(!src)return null;
 const c=src.combat;
 if(c<=EASY_KILL&&src.chance===1&&ranged<=1&&magic<=1)return 'melee';
 const styles:[KillStyle,number][]=[['melee',c<attack&&strength>=c?attack:0],['ranged',c<ranged?ranged:0],['magic',c<magic?magic:0]];
 const best=styles.filter(([,level])=>level>0).sort((a,b)=>b[1]-a[1])[0];
 return best?best[0]:null;
}
// Arrows for the kills: ARROWS_PER_KILL for each drop that comes every kill (a bear's 27 hitpoints), two for each attempt
// of a series of kills whose animal dies to one arrow (a goblin's 5).
export const arrowsFor=(id:number,count:number)=>(KILL_SOURCES[id]?.chance??1)<1?2*killAttempts(id,count):ARROWS_PER_KILL*count;
export const canKill=(id:number,attack:number,ranged=1,magic=1,strength=attack)=>killStyle(id,attack,ranged,magic,strength)!==null;
let npcRows:{id:number;spawns?:Tile[]}[]|undefined;
const npcSpawns=(ids:readonly number[]):Tile[]=>(npcRows??=JSON.parse(readFileSync(resolve(import.meta.dir,'../../../knowledge/npcs.json'),'utf8')) as {id:number;spawns?:Tile[]}[]).filter(n=>ids.includes(n.id)).flatMap(n=>n.spawns??[]);
export const killSpawns=(id:number):Tile[]=>KILL_SOURCES[id]?npcSpawns(KILL_SOURCES[id]!.npcs):[];
// A spawn wins over a shop when it is nearer: eggs lie by Lumbridge, while the only egg seller is in Rellekka.
// `seller` gives the straight-line distance to the nearest seller (Infinity when no shop sells the item).
// A recipe's ingredients are planned like any missing item (a spawn, a plant, a shop, a kill, another recipe) and its
// own step follows them, so the gathers run ingredients first. `coins` is what the recipes cost; `still` is what no
// source covers and the shop plan takes.
export function gatherPlan(missing:readonly Item[],at:Tile,spawns:(id:number,at:Tile)=>Tile[]=spawnsByDistance,seller:(id:number)=>number=()=>Infinity,kills:(id:number)=>Tile[]=killSpawns,attack=99,ranged=1,picks:(loc:number,at:Tile)=>Tile[]=locsByDistance,magic=1,strength=attack){
 const gathers:Gather[]=[],still:Item[]=[],tools:Item[]=[];let coins=0;
 const d=(t:Tile)=>Math.max(Math.abs(t.x-at.x),Math.abs(t.z-at.z));
 const place=(m:Item,depth:number):void=>{
  const sold=seller(m.id),spot=spawns(m.id,at)[0],pick=PICK_SOURCES[m.id]?picks(PICK_SOURCES[m.id]!.loc,at)[0]:undefined;
  if(m.id===MILK&&sold===Infinity){gathers.push({...m,how:'milk'});tools.push({id:BUCKET,count:m.count});}
  else if(spot&&d(spot)<sold)gathers.push({...m,how:'spawn'});
  else if(LOC_SOURCES[m.id]&&d(LOC_SOURCES[m.id]!.tile)<sold)gathers.push({...m,how:'loc'});
  else if(pick&&d(pick)<sold)gathers.push({...m,how:'pick'});
  // A kill wins over a shop when its animal is nearer, as a spawn does: Rufus in Canifis sells every meat, 850 tiles
  // from Ardougne and behind Priest in Peril, while cows graze beside the Ardougne banks.
  else if(canKill(m.id,attack,ranged,magic,strength)&&kills(m.id).some(t=>t.level===at.level&&d(t)<sold)){const style=killStyle(m.id,attack,ranged,magic,strength)!;gathers.push({...m,how:'kill',...(style==='melee'?{}:{kit:style})});}
  else if(sold<Infinity)still.push(m);
  else if(NPC_SOURCES[m.id]&&depth<4){
   const r=NPC_SOURCES[m.id]!,units=Math.ceil(m.count/r.yields);
   for(const n of r.needs)place({id:n.id,count:n.count*units},depth+1);
   coins+=r.coins*units;gathers.push({id:m.id,count:units*r.yields,how:'npc'});
  }
  else if(COMBINE_SOURCES[m.id]&&depth<4){
   for(const id of COMBINE_SOURCES[m.id]!)place({id,count:m.count},depth+1);
   gathers.push({...m,how:'combine'});
  }
  else still.push(m);
 };
 for(const m of missing)place(m,0);
 return{gathers,still,tools,coins};
}
let cowTiles:Tile[]|undefined;
const cows=()=>cowTiles??=(JSON.parse(readFileSync(resolve(import.meta.dir,'../../../knowledge/npcs.json'),'utf8')) as {id:number;spawns?:Tile[]}[]).filter(n=>n.id===COW).flatMap(n=>n.spawns??[]);
const nearest=(tiles:readonly Tile[],at:Tile)=>tiles.filter(t=>t.level===at.level).sort((a,b)=>Math.max(Math.abs(a.x-at.x),Math.abs(a.z-at.z))-Math.max(Math.abs(b.x-at.x),Math.abs(b.z-at.z)));

// Walk to each source, nearest first, and take the item until the pack holds the planned count. A ground spawn is
// waited on for its respawn; a source out of reach gives way to the next.
export async function gatherItems(s:Session,world:World,gathers:readonly Gather[],walk:(to:Tile)=>Promise<{ok:boolean;reason?:string;detail?:string}>=(to)=>goTo(s,world,to,accountOf(s),{legTimeoutTicks:100})):Promise<string|null>{
 const st=()=>s.sdk.getState() as any,held=(id:number)=>count((st()?.inventory??[]).map((i:any)=>({id:i.id,count:i.count})),id);
 const here=():Tile=>{const p=st()?.player;return{x:p?.worldX??0,z:p?.worldZ??0,level:p?.level??0};};
 // Each gather's target is fixed before any runs: a bead taken during another colour's series counts toward its own.
 const targets=new Map(gathers.map(g=>[g.id,held(g.id)+g.count]));
 for(const g of gathers){
  const target=targets.get(g.id)!,sources=(g.how==='milk'?nearest(cows(),here()):g.how==='loc'?[LOC_SOURCES[g.id]!.tile]:g.how==='kill'?nearest((KILL_SOURCES[g.id]?.chance??1)<1?denseSpawns(killSpawns(g.id)):killSpawns(g.id),here()):g.how==='pick'?locsByDistance(PICK_SOURCES[g.id]!.loc,here()):g.how==='npc'?[NPC_SOURCES[g.id]!.tile]:g.how==='combine'?[here()]:spawnsByDistance(g.id,here())).slice(0,6);
  // Spawns lie in clusters (three egg spawns within 4 tiles beyond White Wolf Mountain): one with no route rules out
  // the rest of its cluster, so the walk moves on to the next place rather than searching the same ground again.
  const unreachable:Tile[]=[];
  for(const at of sources){
   if(held(g.id)>=target)break;
   if(unreachable.some(u=>u.level===at.level&&Math.max(Math.abs(u.x-at.x),Math.abs(u.z-at.z))<=CLUSTER))continue;
   const walked=await walk(at);
   console.log(`QUEST_SWEEP_GATHER_WALK ${JSON.stringify({item:g.id,how:g.how,to:at,ok:walked.ok,detail:walked.detail})}`);
   if(!walked.ok){unreachable.push(at);continue;}
   // A kill series at one source is summed when the source is left: kills, drops, and the ticks it stood with no free
   // animal in sight, so a run that ends short says whether the animals or the budget ran out.
   // A kill's attempt budget counts fights begun, not waits for a free animal or refused clicks; 400 rounds bound the rest.
   const tally={kills:0,drops:0,idle:0,fights:0,start:s.tick()};
   for(let tries=0;tries<400&&(g.how==='kill'?tally.fights<killAttempts(g.id,g.count):tries<g.count+3)&&held(g.id)<target;tries++){
    const before=held(g.id);
    if(g.how==='combine'){
     const [a,b]=COMBINE_SOURCES[g.id]!,inv=st()?.inventory??[],ia=inv.find((i:any)=>i.id===a),ib=inv.find((i:any)=>i.id===b);
     if(!ia||!ib)return `combining ${g.id} needs ${a} and ${b} in the pack`;
     await s.direct({type:'useItemOnItem',sourceSlot:ia.slot,targetSlot:ib.slot,reason:'SDK'});
    }else if(g.how==='pick'){
     const src=PICK_SOURCES[g.id]!,plant=(st()?.nearbyLocs??[]).filter((l:any)=>l.id===src.loc&&(l.optionsWithIndex??[]).some((o:any)=>src.option.test(o.text))).sort((a:any,b:any)=>a.distance-b.distance)[0];
     // A picked plant stands again after 50 ticks; the field has several.
     if(!plant){if(!await waitUntil(s,()=>(st()?.nearbyLocs??[]).some((l:any)=>l.id===src.loc),{timeoutTicks:60}))break;continue;}
     await s.bot.interactLoc(plant,src.option);
    }else if(g.how==='npc'){
     const r=NPC_SOURCES[g.id]!,have=(id:number)=>held(id);
     const short=r.needs.find(n=>have(n.id)<n.count);
     if(short)return `${r.name} needs ${short.count} of ${short.id} for ${g.id}, pack has ${have(short.id)}`;
     if(have(995)<r.coins)return `${r.name} needs ${r.coins} coins for ${g.id}`;
     const npc=(st()?.nearbyNpcs??[]).filter((n:any)=>n.id===r.npc).sort((a:any,b:any)=>a.distance-b.distance)[0];
     if(!npc)return `${r.name} not in sight at ${r.tile.x},${r.tile.z}`;
     const talked:any=await s.bot.talkTo(npc);
     if(!talked?.success)return `${r.name} did not talk: ${talked?.message??''}`;
     // One dialogue page per tick: the next choice when its option shows, else continue, until the item arrives. The page
     // just clicked can stay on screen a tick before the server's next page arrives, so a page that repeats the one
     // clicked waits, a menu shown again (an earlier choice) is clicked again, and an option page that matches no
     // choice is a failure only when it stays five ticks.
     let next=0,clicked='',stale=0;
     for(let t=0;t<60&&held(g.id)<before+r.yields;t++){
      const dlg:any=s.sdk.getDialog();
      if(dlg?.isOpen&&!dlg.isWaiting){
       const opts:any[]=dlg.options??[],sig=opts.map(o=>o.text).join(' | ');
       const idx=sig&&sig===clicked?undefined:[next,...Array.from({length:next},(_,i)=>next-1-i)].find(i=>i<r.choices.length&&opts.some(o=>r.choices[i]!.test(o.text)));
       if(idx!==undefined){await s.sdk.clickDialogByText(r.choices[idx]!);next=idx+1;clicked=sig;stale=0;}
       else if(opts.length&&!opts.some(o=>/click here to continue/i.test(o.text))&&next<r.choices.length){if(++stale>5)return `${r.name}: no option for ${r.choices[next]} among ${sig}`;}
       else{await s.sdk.sendClickDialog(0);clicked='';stale=0;}
      }
      await waitTicks(s,1);
     }
     console.log(`QUEST_SWEEP_NPC ${JSON.stringify({item:g.id,npc:r.name,held:held(g.id),coins:have(995)})}`);
    }else if(g.how==='kill'){
     // The nearest free one in sight; its drop lands on its tile when it dies, and another player's kill drops nothing for us.
     const ids=KILL_SOURCES[g.id]!.npcs,wanted=sharedDrops(gathers,g,held,targets),heldAll=()=>wanted.reduce((n,id)=>n+held(id),0);
     const lying=()=>(st()?.groundItems??[]).filter((i:any)=>wanted.includes(i.id)&&i.distance<=12).sort((a:any,b:any)=>a.distance-b.distance);
     // A drop already on the ground (an earlier kill, another player's) is taken before the next fight, so the fight's
     // own wait ends only on a drop that was not there when it began.
     if(lying()[0]){const was=heldAll();await s.bot.pickupItem(lying()[0]);await waitUntil(s,()=>heldAll()>was,{timeoutTicks:15});continue;}
     const npc=(st()?.nearbyNpcs??[]).filter((n:any)=>ids.includes(n.id)&&!n.inCombat&&n.distance<=15).sort((a:any,b:any)=>a.distance-b.distance)[0];
     // A source that has given a kill is worth its respawn (goblins return within about 50 ticks); one that shows no free
     // animal at all is left after 30.
     if(!npc){const t0=s.tick(),found=await waitUntil(s,()=>(st()?.nearbyNpcs??[]).some((n:any)=>ids.includes(n.id)&&!n.inCombat&&n.distance<=15),{timeoutTicks:tally.kills?100:30});tally.idle+=s.tick()-t0;if(!found)break;continue;}
     // A ranged kill wields the bow and the arrows from the pack first; without them in the pack the fight is not taken.
     if(g.kit==='ranged'){
      const worn=()=>s.sdk.getEquipment().map((i:any)=>i.id);
      for(const ids2 of [BOWS,ARROWS]){
       if(ids2.some(id=>worn().includes(id)))continue;
       const item=(st()?.inventory??[]).find((i:any)=>ids2.includes(i.id));
       if(!item)return `ranged kill of ${npc.name} needs ${ids2===BOWS?'a bow':'arrows'} in the pack`;
       await s.bot.equipItem(item);await waitUntil(s,()=>worn().includes(item.id),{timeoutTicks:5});
      }
     }
     // A magic kill wields the staff from the pack and casts the strongest strike the pack's runes allow at the target
     // every five ticks (the cast rate, player_magic.rs2) until it dies or drops; without the runes the fight is not taken.
     let spell:MagicKit|null=null;
     if(g.kit==='magic'){
      const worn=()=>s.sdk.getEquipment().map((i:any)=>i.id);
      const magic=st()?.skills?.find((k:any)=>k.name==='Magic')?.baseLevel??1;
      spell=magicKit([...(st()?.inventory??[]),...s.sdk.getEquipment()].map((i:any)=>({id:i.id,count:i.count})),magic,Math.max(1,castsPerKill(g.id,8)));
      if(!spell)return `magic kill of ${npc.name} needs a strike spell's runes in the pack`;
      const staff=spell.staff===undefined?undefined:(st()?.inventory??[]).find((i:any)=>i.id===spell!.staff);
      if(staff&&!worn().includes(spell.staff!)){await s.bot.equipItem(staff);await waitUntil(s,()=>worn().includes(spell!.staff!),{timeoutTicks:5});}
     }
     const seen=new Map<string,number>();for(const i of lying())seen.set(`${i.x},${i.z}`,(seen.get(`${i.x},${i.z}`)??0)+1);
     const cast=()=>s.direct({type:'spellOnNpc',npcIndex:npc.index,spellComponent:componentId(spell!.component),reason:'SDK'});
     const r:any=spell?await cast():await s.bot.attack(npc);
     if(!r?.success){await waitTicks(s,2);continue;}
     tally.fights++;
     const gone=()=>!(st()?.nearbyNpcs??[]).some((n:any)=>n.index===npc.index);
     const drop=()=>{const now=new Map<string,number>();for(const i of lying())now.set(`${i.x},${i.z}`,(now.get(`${i.x},${i.z}`)??0)+1);return lying().find((i:any)=>(now.get(`${i.x},${i.z}`)??0)>(seen.get(`${i.x},${i.z}`)??0));};
     // A fight that reaches the hitpoint floor is abandoned: the bot walks away and the sweep fails short of the item.
     const hp=()=>st()?.skills?.find((k:any)=>k.name==='Hitpoints'),floor=Math.max(5,Math.ceil((hp()?.baseLevel??10)*0.25)),low=()=>(hp()?.level??99)<=floor;
     if(spell){for(let t=0;t<30&&!(gone()||drop()||low());t++){await waitTicks(s,5);if(!(gone()||drop()||low()))await cast();}}
     else await waitUntil(s,()=>gone()||!!drop()||low(),{timeoutTicks:150});
     if(low()){
      const p=here(),dx=Math.sign(p.x-npc.x)||1,dz=Math.sign(p.z-npc.z);
      await s.direct({type:'walkTo',x:p.x+dx*20,z:p.z+dz*20,running:true,reason:'SDK'});
      await waitUntil(s,()=>!(st()?.player?.combat?.inCombat),{timeoutTicks:40});
      return `kill of ${npc.name} abandoned at ${hp()?.level} of ${hp()?.baseLevel} hitpoints`;
     }
     // The drop lands as the animal dies; a kill without one (123 of 128 goblins) moves on after three ticks.
     if(gone())tally.kills++;
     if(!await waitUntil(s,()=>!!drop(),{timeoutTicks:3}))continue;
     tally.drops++;
     const got=drop();
     await s.bot.pickupItem(got);
     console.log(`QUEST_SWEEP_KILL ${JSON.stringify({item:g.id,drop:got.id,npc:npc.name,at:{x:npc.x,z:npc.z},held:held(g.id)})}`);
    }else if(g.how==='milk'){
     if(!await waitUntil(s,()=>(st()?.nearbyNpcs??[]).some((n:any)=>n.id===COW),{timeoutTicks:20}))break;
     const cow=(st()?.nearbyNpcs??[]).filter((n:any)=>n.id===COW).sort((a:any,b:any)=>a.distance-b.distance)[0],bucket=(st()?.inventory??[]).find((i:any)=>i.id===BUCKET);
     if(!bucket)return `milk needs an empty bucket (${BUCKET})`;
     const buckets=held(BUCKET);
     await s.bot.useItemOnNpc(bucket,cow);
     // The server exchanges one empty bucket for one milk. Wait for both observations before using another bucket.
     if(await waitUntil(s,()=>held(MILK)===before+1&&held(BUCKET)===buckets-1,{timeoutTicks:15}))continue;
     if(held(MILK)!==before||held(BUCKET)!==buckets)return 'milk conversion unconfirmed: need one milk credit and one empty bucket debit';
     continue;
    }else if(g.how==='loc'){
     const src=LOC_SOURCES[g.id]!,ops=(l:any)=>(l.optionsWithIndex??[]).map((o:any)=>o.text as string);
     const loc=()=>(st()?.nearbyLocs??[]).filter((l:any)=>l.x===src.tile.x&&l.z===src.tile.z).find((l:any)=>ops(l).some((o:string)=>src.open.test(o)||src.take.test(o)));
     const l0=loc();if(!l0)break;
     if(ops(l0).some((o:string)=>src.open.test(o))){await s.bot.interactLoc(l0,src.open);await waitUntil(s,()=>!!loc()&&ops(loc()).some((o:string)=>src.take.test(o)),{timeoutTicks:10});}
     const l1=loc();if(l1&&ops(l1).some((o:string)=>src.take.test(o)))await s.bot.interactLoc(l1,src.take);
    }else{
     // A taken item respawns at its tile; wait for it there.
     if(!await waitUntil(s,()=>(st()?.groundItems??[]).some((i:any)=>i.id===g.id&&i.distance<=10),{timeoutTicks:100}))break;
     const item=(st()?.groundItems??[]).filter((i:any)=>i.id===g.id).sort((a:any,b:any)=>a.distance-b.distance)[0];
     await s.bot.pickupItem(item);
    }
    await waitUntil(s,()=>held(g.id)>before,{timeoutTicks:15});
   }
   if(g.how==='kill')console.log(`QUEST_SWEEP_KILLS ${JSON.stringify({item:g.id,at,fights:tally.fights,kills:tally.kills,drops:tally.drops,idle:tally.idle,ticks:s.tick()-tally.start,held:held(g.id),target})}`);
  }
  // The route search plans from the ground floor: come down from an upstairs source.
  for(let i=0;i<3&&here().level>0;i++){
   const lvl=here().level,down=(st()?.nearbyLocs??[]).filter((l:any)=>(l.optionsWithIndex??[]).some((o:any)=>/climb-down/i.test(o.text))).sort((a:any,b:any)=>a.distance-b.distance)[0];
   if(!down)break;
   await s.bot.interactLoc(down,/climb-down/i);
   await waitUntil(s,()=>here().level<lvl,{timeoutTicks:30});
  }
  console.log(`QUEST_SWEEP_GATHER ${JSON.stringify({item:g.id,how:g.how,count:g.count,held:held(g.id),target})}`);
  if(held(g.id)<target)return `gathered ${g.count-(target-held(g.id))} of ${g.count} item ${g.id} (${g.how})`;
 }
 return null;
}

