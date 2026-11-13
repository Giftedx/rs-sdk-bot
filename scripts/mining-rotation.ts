// Rock rotation and the knife reset for the at-site miner (scripts/microbot-b-mining.ts runAtSiteMining).
// Server facts (C = vendor/rs-sdk/server/content/scripts, E = vendor/rs-sdk/server/engine/src):
// - C/skill_mining/scripts/mining.rs2:76-86, the first swing: %action_delay < clock sets it to clock + mining_rate;
//   %action_delay = clock rolls in the same tick; a later %action_delay waits for it. mining.rs2:117-124: the swing
//   rolls when %action_delay = clock; one tick after a failed roll it sets clock + mining_rate again.
// - C/skill_fletching/scripts/cut_logs.rs2:83-86: knife on a log, then "Make 1", sets %action_delay = clock + 2 when
//   it is older than clock, and puts the cut in the weak queue for 2 ticks.
// - E/network/game/client/handler/OpLocHandler.ts:53 and E/engine/entity/Player.ts:1086-1089 and 876-879: a rock
//   click clears the weak queue (no log is cut) and keeps %action_delay. A close-modal request clears it at the next
//   queue pass (Player.ts:998-1000), before the cut can run (processWeakQueue, Player.ts:1033-1041).
// So the knife sets the next roll 2 ticks after the cut tick, whatever the pickaxe: a 3-tick roll cycle for each
// pickaxe (the rune pickaxe, mining_rate 2 in C/skill_mining/configs/pickaxes.obj, has it already). The cut also
// starts the delay while the account walks to a rock, or waits for a rock to respawn: the first swing then lands on
// %action_delay = clock and rolls at once (mining.rs2:83-84).
// Respawn: C/general/scripts/player_count.rs2:1-4 scales mine.dbrow rock_respawnrate by (4000 - players) / 4000,
// truncated (E/engine/script/handlers/NumberOps.ts:124-126). The worker learns the true interval from each rock that
// it sees deplete and come back.
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseJm2} from '../packages/knowledge/src/jm2';
import {parseConfigs} from '../packages/knowledge/src/config';
import type {BotWorldState,NearbyLoc} from '../vendor/rs-sdk/sdk/types';
import type {MiningDriver,MiningProfile} from './microbot-b-mining';

export type Tile={x:number;z:number;level:number};
export type MiningAction=
 |{type:'interactLoc';x:number;z:number;locId:number;optionIndex:number}
 |{type:'useItemOnItem';sourceSlot:number;targetSlot:number}
 |{type:'clickComponent';componentId:number}
 |{type:'dropItem';slot:number}
 |{type:'walkTo';x:number;z:number}
 |{type:'closeModal'};
export const KNIFE=946,NORMAL_LOGS=1511;

const content=resolve(import.meta.dir,'../vendor/rs-sdk/server/content');
const locPack=()=>new Map(readFileSync(resolve(content,'pack/loc.pack'),'utf8').split(/\r?\n/).flatMap(l=>{const m=l.match(/^(\d+)=(.+)$/);return m?[[Number(m[1]),m[2]!] as const]:[];}));

// get_ore_fast (iron, granite, sandstone) gives the ore in the roll tick; get_ore_normal waits one tick (p_delay(0),
// mining.rs2:157) and the gem rock gives it in the roll tick (mining.rs2:247 is a comment). The category of each
// loc decides (mining.rs2:1-7): the Haunted Mine iron veins (quest_hauntedmine/configs/hauntedmine.loc, loc_4982)
// are in iron_rock_table but mining_rock_normal.
let fastIds:Set<number>|undefined;
export function oreLag(p:MiningProfile,rock=p.rocks[0]!){
 if(!fastIds){
  const names=new Map([...locPack()].map(([id,n])=>[n,id])),files=[
   'scripts/skill_mining/configs/rocks.loc','scripts/quests/quest_hauntedmine/configs/hauntedmine.loc'];
  fastIds=new Set(files.flatMap(f=>parseConfigs(readFileSync(resolve(content,f),'utf8'),f)).filter(b=>(b.props.category??[]).includes('mining_rock_fast')).map(b=>names.get(b.name)!).filter(n=>n!==undefined));
 }
 return p.gemRock||fastIds.has(rock)?0:1;
}

export function respawnTicks(base:number,players=1){return Math.trunc((4000-Math.min(players,2000))*base/4000);}
// The cut: %action_delay = T + 2 when it is older than T (cut_logs.rs2:83-84).
export function knifeDelay(delay:number,tick:number){return delay<tick?tick+2:delay;}
// The first swing at arrival tick A (mining.rs2:76-86): the roll tick and the new %action_delay.
export function firstRoll(delay:number,arrival:number,rate:number){return delay<arrival?{roll:arrival+rate,delay:arrival+rate}:{roll:delay,delay};}

// Rock tiles of every map file (C/../maps/*.jm2), cached per process.
let mapRocks:{id:number;x:number;z:number;level:number}[]|undefined;
function allRocks(){
 if(mapRocks)return mapRocks;
 const dir=resolve(content,'maps');mapRocks=[];
 for(const f of readdirSync(dir).filter(f=>f.endsWith('.jm2')))for(const l of parseJm2(f,readFileSync(resolve(dir,f),'utf8')).locs)mapRocks.push({id:l.id,x:l.x,z:l.z,level:l.level});
 return mapRocks;
}
const cheb=(a:{x:number;z:number},b:{x:number;z:number})=>Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z));
// The rocks of a profile within `radius` of a tile, from the map files.
export function siteRocks(p:MiningProfile,center:Tile,radius:number):Tile[]{
 return allRocks().filter(r=>p.rocks.includes(r.id)&&r.level===center.level&&cheb(r,center)<=radius).map(r=>({x:r.x,z:r.z,level:r.level})).sort((a,b)=>a.x-b.x||a.z-b.z);
}
// Every rock site of a profile in the map files: rocks within `gap` tiles of each other form one site.
export function contentSites(p:MiningProfile,gap=3):{center:Tile;rocks:Tile[]}[]{
 const left=allRocks().filter(r=>p.rocks.includes(r.id)).map(r=>({x:r.x,z:r.z,level:r.level})),out:{center:Tile;rocks:Tile[]}[]=[];
 while(left.length){
  const site=[left.pop()!];
  for(let grew=true;grew;){grew=false;for(let i=left.length-1;i>=0;i--)if(site.some(r=>r.level===left[i]!.level&&cheb(r,left[i]!)<=gap)){site.push(left.splice(i,1)[0]!);grew=true;}}
  const x=Math.round(site.reduce((n,r)=>n+r.x,0)/site.length),z=Math.round(site.reduce((n,r)=>n+r.z,0)/site.length);
  out.push({center:{x,z,level:site[0]!.level},rocks:site.sort((a,b)=>a.x-b.x||a.z-b.z)});
 }
 return out.sort((a,b)=>b.rocks.length-a.rocks.length);
}

// Named sites with a bank. The Ardougne zoo iron: six rocks at 2602,3233 2602,3234 2602,3236 2605,3233 2605,3235
// 2605,3237 (maps/m40_50.jm2:5587-5678); research/route-danger.ts finds no hunting NPC on the path to the
// Ardougne south bank (bank:ardougne-south-bank:0 in packages/planner/src/haggis-travel.json).
// `ardougne-zoo-iron-9` adds the three iron rocks 10 tiles west, 2590,3230 2591,3232 2592,3234 (m40_50.jm2:5212-5266).
// The six-rock site is the zoo default. Bench, 75 ores from Mining 64 with the knife, seeds 7/8/9, seen respawn 18:
// six rocks 3.22/3.19/3.19 ticks an ore (272/274/274 XP a tick); nine rocks with the first-roll pick the same (it
// never walks west: a zoo rock back in a tick beats the walk); nine rocks with the nearest-free pick, which walks west
// when the six are down, 3.76 at each seed (233 XP a tick).
export interface MiningSite{key:string;profile:string;center:Tile;radius:number;bank:Tile;more?:readonly{center:Tile;radius:number}[]}
export const MINING_SITES:readonly MiningSite[]=[
 {key:'ardougne-zoo-iron',profile:'iron_rock_table',center:{x:2603,z:3235,level:0},radius:3,bank:{x:2655,z:3283,level:0}},
 {key:'ardougne-zoo-iron-9',profile:'iron_rock_table',center:{x:2603,z:3235,level:0},radius:3,bank:{x:2655,z:3283,level:0},more:[{center:{x:2591,z:3232,level:0},radius:2}]},
 {key:'varrock-east-iron',profile:'iron_rock_table',center:{x:3286,z:3368,level:0},radius:3,bank:{x:3253,z:3420,level:0}},
];

export function siteTiles(p:MiningProfile,site:MiningSite):Tile[]{return[site,...(site.more??[])].flatMap(a=>siteRocks(p,a.center,a.radius));}

// A loc is reached from a tile beside one of its sides, not from a corner. Stand tiles are those that are no rock.
export function standTiles(rock:Tile,rocks:readonly Tile[]):Tile[]{
 return [[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dz])=>({x:rock.x+dx!,z:rock.z+dz!,level:rock.level})).filter(t=>!rocks.some(r=>r.x===t.x&&r.z===t.z&&r.level===t.level));
}
const beside=(p:{x:number;z:number},rock:Tile)=>Math.abs(p.x-rock.x)+Math.abs(p.z-rock.z)===1;
// Ticks of run (2 tiles a tick) to a stand tile of the rock; 0 when the account stands beside it.
const runTicks=(p:{x:number;z:number},rock:Tile,rocks:readonly Tile[])=>beside(p,rock)?0:Math.ceil(Math.min(...standTiles(rock,rocks).map(t=>cheb(p,t)))/2);

export interface RotationOptions{
 maximum:number;cap:number;idleTicks:number;
 knife:boolean;           // the knife reset; needs a knife and normal logs in the pack (members world, cut_logs.rs2:19)
 drop:boolean;            // drop each ore in the tick of the next rock click
 keep?:readonly number[]; // item ids that drop mode keeps (the pickaxe, knife and logs always stay)
 make1:number;            // component skill_multi3:make1_a
 players?:number;         // first respawn estimate; the observed interval replaces it
 rocks?:readonly Tile[];  // the site; default: the profile rocks within 3 tiles of the start tile
 pick?:'roll'|'nearest';  // the rock that rolls first (default with the knife), or the nearest free rock
}
export interface RotationResult{made:number;sideGems:number;attempts:number;outputs:Record<number,number>;xp:number;ticks:number;banked:0;dropped:number;knifeCuts:number;preArms:number;fletches:number;respawn:number;rolls:number[];waitTicks:number}

const stockOf=(s:BotWorldState)=>{const r:Record<number,number>={};for(const i of s.inventory)r[i.id]=(r[i.id]??0)+i.count;return r;};
const xpOf=(s:BotWorldState)=>s.skills.find(k=>k.name==='Mining')?.experience??0;
const hpOf=(s:BotWorldState)=>s.skills.find(k=>k.name==='Hitpoints')?.level??0;

// One loop step per game tick. Actions sent after the observation of tick n run in tick n + 1.
export async function runRotationMining(d:MiningDriver,p:MiningProfile,o:RotationOptions,rate:number,gems:readonly number[]):Promise<RotationResult>{
 const send=d.send;if(!send)throw Error('rotation mining needs a driver that sends actions in one tick');
 const initial=d.state();if(!initial?.player)throw Error('mining state unknown');
 const start=d.tick(),me=initial.player,keep=new Set([...(o.keep??[]),KNIFE,NORMAL_LOGS]);
 const rocks=(o.rocks??siteRocks(p,{x:me.worldX,z:me.worldZ,level:me.level},3)).filter(r=>r.level===me.level);
 if(!rocks.length)throw Error('no '+p.name+' rocks at this site in the map files');
 const key=(t:Tile)=>`${t.x},${t.z}`;
 const equipment=JSON.stringify(initial.equipment.map(i=>({id:i.id,slot:i.slot})).sort((a,b)=>a.slot-b.slot));
 const state=()=>{const s=d.state();if(!s?.player)throw Error('mining session ended');if(d.stop())throw Error('mining stopped');if(d.tick()-start>=o.cap)throw Error('mining tick cap');if(s.player.isDead||s.player.lifeId!==me.lifeId||s.player.level!==me.level||hpOf(s)!==hpOf(initial))throw Error('mining health or life changed');if(JSON.stringify(s.equipment.map(i=>({id:i.id,slot:i.slot})).sort((a,b)=>a.slot-b.slot))!==equipment)throw Error('mining equipment changed');return s;};
 let respawn=respawnTicks(p.respawn,o.players??1);
 const depleted=new Map<string,number>(),seen=new Map<string,boolean>();
 let delay=-Infinity,made=0,sideGems=0,attempts=0,dropped=0,knifeCuts=0,preArms=0,fletches=0,progress=start,waitTicks=0;
 const outputs:Record<number,number>={},rolls:number[]=[];
 // The rock in hand: clicked in tick `sent`; the first swing at `arrival`; the roll at `roll`.
 let active:{rock:Tile;loc:NearbyLoc;sent:number;arrival?:number;roll?:number}|undefined;
 let walkingTo:string|undefined,armedFor:number|undefined;
 // Receipts: the drops sent in the last tick may explain a loss of that item, and nothing else may.
 const side=gems.filter(id=>!p.products.includes(id)),watched=[...new Set([...p.products,...side])];
 const first=state();let prevXp=xpOf(first),prevInv=stockOf(first),sent:Record<number,number>={};
 const locAt=(s:BotWorldState,t:Tile)=>s.nearbyLocs.find(l=>l.x===t.x&&l.z===t.z&&l.level===t.level&&p.rocks.includes(l.id)&&l.optionsWithIndex.some(v=>v.opIndex===1&&/^mine$/i.test(v.text)));
 for(;;){
  const s=state(),n=d.tick(),pos={x:s.player!.worldX,z:s.player!.worldZ};
  // 1. Receipts. One roll at most in a tick, so one ore at most.
  const xp=xpOf(s),inv=stockOf(s),delta=(id:number)=>(inv[id]??0)-(prevInv[id]??0);
  if(delta(NORMAL_LOGS)<0)fletches-=delta(NORMAL_LOGS);
  let oreId:number|undefined;
  if(xp>prevXp){
   oreId=p.products.find(id=>delta(id)===1)??p.products.find(id=>delta(id)<=1&&1-delta(id)<=(sent[id]??0));
   if(oreId===undefined)throw Error('mining XP without one own ore');
   made++;rolls.push(n);outputs[oreId]=(outputs[oreId]??0)+1;
   progress=n;delay=n-oreLag(p,active?.loc.id);active=undefined;
  }
  for(const id of watched){
   const g=delta(id)-(id===oreId?1:0);
   if(g>0){if(!side.includes(id)||xp>prevXp&&id!==oreId&&p.products.includes(id))throw Error('mining ore without XP');sideGems+=g;outputs[id]=(outputs[id]??0)+g;}
   else if(-g>(sent[id]??0))throw Error('mining item lost without a drop');
   else dropped-=g;
  }
  prevXp=xp;prevInv=inv;sent={};
  if(made>=o.maximum)break;
  if(n-progress>=o.idleTicks)throw Error('mining no useful ore progress');
  // 2. Rock states: learn the respawn from each rock seen to deplete and come back.
  for(const r of rocks){
   const k=key(r),up=!!locAt(s,r),was=seen.get(k);
   if(was===true&&!up)depleted.set(k,n);
   if(was===false&&up&&depleted.has(k)){respawn=n-depleted.get(k)!;depleted.delete(k);}
   seen.set(k,up);
  }
  const actions:MiningAction[]=[];
  const ticksTo=(r:Tile)=>runTicks(pos,r,rocks);
  const slot=(id:number)=>s.inventory.find(i=>i.id===id)?.slot;
  const knifeSlots=o.knife?{k:slot(KNIFE),l:slot(NORMAL_LOGS)}:undefined;
  const canCut=!!knifeSlots&&knifeSlots.k!==undefined&&knifeSlots.l!==undefined;
  const cut=()=>{actions.push({type:'useItemOnItem',sourceSlot:knifeSlots!.k!,targetSlot:knifeSlots!.l!},{type:'clickComponent',componentId:o.make1});delay=knifeDelay(delay,n+1);knifeCuts++;};
  // Drop: free slots so the next ore fits (mining.rs2:52, 95). One drop in a click tick keeps the tick inside the 5
  // user events a tick (E/network/game/client/ClientGameProtCategory.ts:6): drop, cut, Make 1, move, click.
  const drops=(most:number)=>{if(!o.drop)return;for(const i of s.inventory.filter(i=>!keep.has(i.id)&&(p.products.includes(i.id)||gems.includes(i.id))).slice(0,most)){actions.push({type:'dropItem',slot:i.slot});sent[i.id]=(sent[i.id]??0)+i.count;}};
  if(!o.drop&&s.inventory.length>=28)throw Error('mining pack full; retain ore for owned bank route');
  if(active&&!locAt(s,active.rock))active=undefined;
  // A level-up window opens one tick after the ore and holds the swing (the interaction waits while a modal is open):
  // click again, which closes it (OpLocHandler.ts:53). A click that never moved the account is sent again too.
  const modal=!!(s.dialog?.isOpen||s.interface?.isOpen);
  if(active&&(modal&&n>=active.sent||active.arrival===undefined&&n>=active.sent+8))active=undefined;
  if(active){
   // After a step the swing starts in the next tick (the bench trace: a click with a 1-tile walk in tick 5 rolls in 8).
   if(active.arrival===undefined&&n>=active.sent&&beside(pos,active.rock)){active.arrival=n+1;const f=firstRoll(delay,n+1,rate);active.roll=f.roll;delay=f.delay;}
   // On a walk of more than one tick the click-tick cut runs out on the way: cut again (and click again, as the cut
   // clears the click, OpHeldUHandler.ts:57) when the swing is 2 ticks off, so it rolls in its first tick.
   else if(active.arrival===undefined&&canCut&&n>=active.sent&&ticksTo(active.rock)===2&&delay<n+1){cut();actions.push({type:'interactLoc',x:active.loc.x,z:active.loc.z,locId:active.loc.id,optionIndex:1});}
   if(active.roll!==undefined&&n>=active.roll){
    // No ore by the roll: a miss, or a gem roll (mining.rs2:194). Cut again so the next roll is 2 ticks away.
    if(canCut){cut();actions.push({type:'interactLoc',x:active.loc.x,z:active.loc.z,locId:active.loc.id,optionIndex:1});attempts++;active.roll=Math.max(delay,n+1);}
    else{delay=n+1+rate;active.roll=delay;}
   }
  }
  if(!active){
   // Pick the rock that rolls first: a free rock after the walk to it, or a depleted rock when it is seen again
   // (with the knife the respawn click rolls in its own tick). Waiting beside a rock that is back in a tick beats a
   // walk of 6 ticks to a free one.
   const free=rocks.map(r=>({r,loc:locAt(s,r)})).filter(v=>v.loc&&v.loc.reachable!==false&&!s.nearbyPlayers.some(q=>cheb(q,v.r)<=1));
   const freeRoll=(r:Tile)=>{const op=n+1+ticksTo(r);return delay>=op?delay:canCut?Math.max(op,n+3):op+rate;};
   const waitRoll=(r:Tile,back:number)=>{const click=Math.max(back+1,n+1+ticksTo(r));return canCut?Math.max(click,n+3):click+rate;};
   const byRoll=(o.pick??(canCut?'roll':'nearest'))==='roll',stepsTo=(r:Tile)=>Math.min(...standTiles(r,rocks).map(t=>cheb(pos,t)));
   const best=free.map(v=>({...v,roll:freeRoll(v.r)})).sort((a,b)=>(byRoll?a.roll-b.roll:0)||stepsTo(a.r)-stepsTo(b.r))[0];
   const soon=rocks.filter(r=>depleted.has(key(r))).map(r=>({r,back:depleted.get(key(r))!+respawn})).map(v=>({...v,roll:waitRoll(v.r,v.back)})).sort((a,b)=>a.roll-b.roll||a.back-b.back)[0];
   if(best&&!(byRoll&&soon&&soon.roll<best.roll)){
    const pick=best;
    if(s.inventory.length>=27)drops(1);
    if(canCut&&delay<n+1)cut();
    actions.push({type:'interactLoc',x:pick.loc!.x,z:pick.loc!.z,locId:pick.loc!.id,optionIndex:1});attempts++;
    active={rock:pick.r,loc:pick.loc!,sent:n+1};walkingTo=undefined;armedFor=undefined;
    if(beside(pos,pick.r)){active.arrival=n+1;const f=firstRoll(delay,n+1,rate);active.roll=f.roll;delay=f.delay;}
   }else{
    // Wait beside the rock that rolls first, and cut 2 ticks before the click.
    waitTicks++;
    const next=soon;
    // Seen up in tick `back`, clicked in back + 1: the cut in back - 1 sets the delay to back + 1. The close after
    // the cut drops the queued cut in that tick, so no log is cut if the rock comes back late.
    const arm=!!next&&canCut&&n+2===next.back&&delay<n+1&&armedFor!==next.back;
    const stands=next?standTiles(next.r,rocks).sort((a,b)=>cheb(pos,a)-cheb(pos,b)):[];
    const walk=!!next&&!stands.some(t=>t.x===pos.x&&t.z===pos.z)&&walkingTo!==key(stands[0]!);
    drops(arm&&walk?0:arm||walk?1:2);
    if(walk){actions.push({type:'walkTo',x:stands[0]!.x,z:stands[0]!.z});walkingTo=key(stands[0]!);}
    if(arm){cut();preArms++;armedFor=next!.back;}
    if(arm||modal)actions.push({type:'closeModal'});
   }
  }
  if(process.env.MINING_DEBUG==="1")console.log(`MDBG n=${n} pos=${pos.x},${pos.z} made=${made} delay=${delay} active=${active?`${active.rock.x},${active.rock.z} a=${active.arrival} r=${active.roll}`:"-"} up=${rocks.map(r=>locAt(s,r)?1:0).join("")} locs=${s.nearbyLocs.length} dlg=${!!s.dialog?.isOpen}/${!!s.interface?.isOpen}/${!!(s as any).modalOpen} acts=${actions.map(a=>a.type).join(",")}`);
  if(actions.length)await send(actions);
  await d.step();
 }
 return{made,sideGems,attempts,outputs,xp:xpOf(state())-xpOf(initial),ticks:d.tick()-start,banked:0,dropped,knifeCuts,preArms,fletches,respawn,rolls,waitTicks};
}
