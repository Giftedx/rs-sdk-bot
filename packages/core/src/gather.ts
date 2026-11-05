// Gathering items no shop sells: a ground spawn (maps OBJ, spawn-index.ts), milk from a cow with an empty bucket
// (npc/scripts/cow_milking.rs2), or a loc that hands the item out. Shared by scripts/quest-sweep.ts (quest packs)
// and scripts/gather-spawn.ts (route supplies).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { accountOf } from './bot';
import type { Session } from './inprocess';
import { waitTicks, waitUntil } from './ticks';
import { goTo } from './walk';
import type { World } from './world';
import { spawnsByDistance } from './spawn-index';

type Item = { id: number; count: number };
type Tile = { x: number; z: number; level: number };
const count = (rows: readonly Item[], id: number) => rows.filter(r => r.id === id).reduce((n, r) => n + r.count, 0);

// The bucket is a pack item like any other: bank or shop.
export const MILK=1927,BUCKET=1925,COW=81;
// Garlic: the cupboard upstairs in Morgan's house, Draynor (general_use/scripts/cupboards.rs2:34, loc 2612 shut,
// 2613 open: Open, then Search). The only shops are the Greengrocers on Miscellania and in Rellekka.
export const LOC_SOURCES:Record<number,{tile:Tile;open:RegExp;take:RegExp}>={1550:{tile:{x:3096,z:3268,level:1},open:/^open$/i,take:/^search$/i}};
export type Gather={id:number;count:number;how:'spawn'|'milk'|'loc'|'kill'};
export const CLUSTER=20;
// Meats no shop sells drop from animals on death, every kill (drop tables/scripts/cow.rs2, chicken.rs2, giant_rat.rs2,
// bear.rs2 `always` rows); goblin mail drops from goblins while Goblin Diplomacy asks for it (goblin.rs2:53,119). The
// account kills the nearest one and takes the drop. NPC ids and spawns come from knowledge/npcs.json.
export const KILL_SOURCES:Record<number,{npcs:number[];name:string}>={
 2132:{npcs:[81],name:'cow'},2138:{npcs:[41,1017],name:'chicken'},2134:{npcs:[86,87,950],name:'giant rat'},
 2136:{npcs:[105,106],name:'bear'},288:{npcs:[100,101,298,299],name:'goblin'},
};
let npcRows:{id:number;spawns?:Tile[]}[]|undefined;
const npcSpawns=(ids:readonly number[]):Tile[]=>(npcRows??=JSON.parse(readFileSync(resolve(import.meta.dir,'../../../knowledge/npcs.json'),'utf8')) as {id:number;spawns?:Tile[]}[]).filter(n=>ids.includes(n.id)).flatMap(n=>n.spawns??[]);
export const killSpawns=(id:number):Tile[]=>KILL_SOURCES[id]?npcSpawns(KILL_SOURCES[id]!.npcs):[];
// A spawn wins over a shop when it is nearer: eggs lie by Lumbridge, while the only egg seller is in Rellekka.
// `seller` gives the straight-line distance to the nearest seller (Infinity when no shop sells the item).
export function gatherPlan(missing:readonly Item[],at:Tile,spawns:(id:number,at:Tile)=>Tile[]=spawnsByDistance,seller:(id:number)=>number=()=>Infinity,kills:(id:number)=>Tile[]=killSpawns){
 const gathers:Gather[]=[],still:Item[]=[],tools:Item[]=[];
 const d=(t:Tile)=>Math.max(Math.abs(t.x-at.x),Math.abs(t.z-at.z));
 for(const m of missing){
  const sold=seller(m.id),spot=spawns(m.id,at)[0];
  if(m.id===MILK&&sold===Infinity){gathers.push({...m,how:'milk'});tools.push({id:BUCKET,count:m.count});}
  else if(spot&&d(spot)<sold)gathers.push({...m,how:'spawn'});
  else if(LOC_SOURCES[m.id]&&d(LOC_SOURCES[m.id]!.tile)<sold)gathers.push({...m,how:'loc'});
  // A drop is taken only where no shop sells the item: Rufus in Canifis sells the meats, but behind Priest in Peril.
  else if(sold===Infinity&&kills(m.id).some(t=>t.level===at.level))gathers.push({...m,how:'kill'});
  else still.push(m);
 }
 return{gathers,still,tools};
}
let cowTiles:Tile[]|undefined;
const cows=()=>cowTiles??=(JSON.parse(readFileSync(resolve(import.meta.dir,'../../../knowledge/npcs.json'),'utf8')) as {id:number;spawns?:Tile[]}[]).filter(n=>n.id===COW).flatMap(n=>n.spawns??[]);
const nearest=(tiles:readonly Tile[],at:Tile)=>tiles.filter(t=>t.level===at.level).sort((a,b)=>Math.max(Math.abs(a.x-at.x),Math.abs(a.z-at.z))-Math.max(Math.abs(b.x-at.x),Math.abs(b.z-at.z)));

// Walk to each source, nearest first, and take the item until the pack holds the planned count. A ground spawn is
// waited on for its respawn; a source out of reach gives way to the next.
export async function gatherItems(s:Session,world:World,gathers:readonly Gather[],walk:(to:Tile)=>Promise<{ok:boolean;reason?:string;detail?:string}>=(to)=>goTo(s,world,to,accountOf(s),{legTimeoutTicks:100})):Promise<string|null>{
 const st=()=>s.sdk.getState() as any,held=(id:number)=>count((st()?.inventory??[]).map((i:any)=>({id:i.id,count:i.count})),id);
 const here=():Tile=>{const p=st()?.player;return{x:p?.worldX??0,z:p?.worldZ??0,level:p?.level??0};};
 for(const g of gathers){
  const target=held(g.id)+g.count,sources=(g.how==='milk'?nearest(cows(),here()):g.how==='loc'?[LOC_SOURCES[g.id]!.tile]:g.how==='kill'?nearest(killSpawns(g.id),here()):spawnsByDistance(g.id,here())).slice(0,6);
  // Spawns lie in clusters (three egg spawns within 4 tiles beyond White Wolf Mountain): one with no route rules out
  // the rest of its cluster, so the walk moves on to the next place rather than searching the same ground again.
  const unreachable:Tile[]=[];
  for(const at of sources){
   if(held(g.id)>=target)break;
   if(unreachable.some(u=>u.level===at.level&&Math.max(Math.abs(u.x-at.x),Math.abs(u.z-at.z))<=CLUSTER))continue;
   const walked=await walk(at);
   console.log(`QUEST_SWEEP_GATHER_WALK ${JSON.stringify({item:g.id,how:g.how,to:at,ok:walked.ok,detail:walked.detail})}`);
   if(!walked.ok){unreachable.push(at);continue;}
   for(let tries=0;tries<(g.how==='kill'?g.count*3:g.count)+3&&held(g.id)<target;tries++){
    const before=held(g.id);
    if(g.how==='kill'){
     // The nearest free one in sight; its drop lands on its tile when it dies, and another player's kill drops nothing for us.
     const ids=KILL_SOURCES[g.id]!.npcs;
     const npc=(st()?.nearbyNpcs??[]).filter((n:any)=>ids.includes(n.id)&&!n.inCombat&&n.distance<=15).sort((a:any,b:any)=>a.distance-b.distance)[0];
     if(!npc){if(!await waitUntil(s,()=>(st()?.nearbyNpcs??[]).some((n:any)=>ids.includes(n.id)&&!n.inCombat&&n.distance<=15),{timeoutTicks:30}))break;continue;}
     const r:any=await s.bot.attack(npc);
     if(!r?.success){await waitTicks(s,2);continue;}
     const gone=()=>!(st()?.nearbyNpcs??[]).some((n:any)=>n.index===npc.index),drop=()=>(st()?.groundItems??[]).filter((i:any)=>i.id===g.id&&i.distance<=12).sort((a:any,b:any)=>a.distance-b.distance)[0];
     await waitUntil(s,()=>gone()||!!drop(),{timeoutTicks:150});
     if(!await waitUntil(s,()=>!!drop(),{timeoutTicks:10}))continue;
     await s.bot.pickupItem(drop());
     console.log(`QUEST_SWEEP_KILL ${JSON.stringify({item:g.id,npc:npc.name,at:{x:npc.x,z:npc.z},held:held(g.id)})}`);
    }else if(g.how==='milk'){
     if(!await waitUntil(s,()=>(st()?.nearbyNpcs??[]).some((n:any)=>n.id===COW),{timeoutTicks:20}))break;
     const cow=(st()?.nearbyNpcs??[]).filter((n:any)=>n.id===COW).sort((a:any,b:any)=>a.distance-b.distance)[0],bucket=(st()?.inventory??[]).find((i:any)=>i.id===BUCKET);
     if(!bucket)return `milk needs an empty bucket (${BUCKET})`;
     await s.bot.useItemOnNpc(bucket,cow);
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

