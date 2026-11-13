// Finite held-supply fishing batch. Caller stages the account beside a native spot.
// No world hopping, dropping, bank travel, or modern donor IDs.
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {openBot,finish} from '../packages/core/src/bot';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {catchSharks} from './gather-fish';
import type {BotWorldState,NearbyNpc} from '../vendor/rs-sdk/sdk/types';
import type{Session}from'../packages/core/src/inprocess';
import{walkPath,sessionWalker}from'../packages/core/src/walk';
import{componentId}from'../packages/core/src/logout';
import{knifeCut,type KnifeAction}from'./knife-reset';

const content=resolve(import.meta.dir,'../vendor/rs-sdk/server/content');
export const FISH_PROFILES={
 net:{category:'saltfish',op:1,label:'Net',level:1,tool:303,bait:0,products:[317,321]},
 seaBait:{category:'saltfish',op:3,label:'Bait',level:5,tool:307,bait:313,products:[327,345]},
 fly:{category:'freshfish',op:1,label:'Lure',level:20,tool:309,bait:314,products:[335,331]},
 riverBait:{category:'freshfish',op:3,label:'Bait',level:25,tool:307,bait:313,products:[349]},
 cage:{category:'rarefish',op:1,label:'Cage',level:40,tool:301,bait:0,products:[377]},
 harpoon:{category:'rarefish',op:3,label:'Harpoon',level:35,tool:311,bait:0,products:[359,371]},
 karambwanji:{category:'category_632',op:1,label:'Net',level:5,tool:303,bait:0,products:[3150,317]},
 karambwan:{category:'category_633',op:1,label:'Fish',level:65,tool:3157,bait:3150,products:[3142]},
 bigNet:{category:'memberfish',op:1,label:'Net',level:16,tool:305,bait:0,products:[353,341,363],byproducts:[1061,401,1059,407,405]},
 lava:{category:null,names:['0_45_152_lavafish'],op:1,label:'Bait',level:53,tool:1585,bait:313,products:[2148]},
} as const;
export type FishMethod=keyof typeof FISH_PROFILES;
// The knife reset (scripts/knife-reset.ts) on the visible op of each spot. S = vendor/rs-sdk/server/content/scripts/
// skill_fishing/scripts/fishing_spots. A cut in tick T sets %action_delay = T+2; the hidden ops roll when
// %action_delay = map_clock (S/freshfish.rs2:79, S/saltfish.rs2:73, S/rarefish.rs2:119).
// - 'same': the visible op with %action_delay = clock + 2 re-ops a label that rolls at T+2, so the knife, Make 1 and
//   the click go in one tick T.
// - 'delayed': the visible op rolls when %action_delay = map_clock and has no branch for clock + 2 (the click ends the
//   action), so the knife goes in T, a drop or a modal close in T+1, and the click in T+2 rolls.
// Both give one roll each 3 ticks, against 5 or 6 for the hidden-op loop (+4 or +5 one tick after each roll).
// - null: no %action_delay. Karambwan waits p_delay(5) for each cast (S/tbwt.rs2:123).
export type FishReset='same'|'delayed';
export const FISH_KNIFE_RESET:Readonly<Record<FishMethod,FishReset|null>>={
 net:'delayed',        // attempt_fish_shrimp S/saltfish.rs2:37-52
 seaBait:'delayed',    // attempt_fish_sardine S/saltfish.rs2:101-121
 fly:'same',           // attempt_fish_trout_salmon S/freshfish.rs2:48-52
 riverBait:'same',     // attempt_fish_pike S/freshfish.rs2:113-117
 cage:'delayed',       // attempt_fish_lobster S/rarefish.rs2:60-73
 harpoon:'delayed',    // attempt_fish_swordfish S/rarefish.rs2:164-179
 karambwanji:'delayed',// attempt_fish_karambwanji S/tbwt.rs2:41-51
 karambwan:null,
 bigNet:'delayed',     // attempt_fish_mackerel S/memberfish.rs2:102-114
 lava:'same',          // attempt_fish_lava_eel S/lavafish.rs2:50-67: any other delay re-ops op 1, and it rolls at = clock
};
export type FishAction=KnifeAction|{type:'interactNpc';npcIndex:number;optionIndex:number}|{type:'dropItem';slot:number};
type NativeFishProfile={category:string|null;names?:readonly string[];products:readonly number[];byproducts?:readonly number[]};
export const BIG_NET_RAW_XP:Readonly<Record<number,number>>={1061:10,401:1,1059:10,353:200,407:100,405:100,341:450,363:1000};
const BIG_NET_ROLL_MAX:Readonly<Record<number,number>>={1061:1,401:1,1059:1,353:2,407:1,405:1,341:1,363:1};
export const fishingByproducts=(method:FishMethod):readonly number[]=>(FISH_PROFILES[method]as NativeFishProfile).byproducts??[];
export const fishingOutputs=(method:FishMethod)=>[...FISH_PROFILES[method].products,...fishingByproducts(method)];
export const fishingCapacityOutputs=(method:FishMethod):Record<number,number>=>method==='bigNet'?{...BIG_NET_ROLL_MAX}:{[FISH_PROFILES[method].products[0]!]:1};
export function bigNetSnapshot(s:BotWorldState){const items:Record<number,number>={};for(const i of s.inventory)items[i.id]=(items[i.id]??0)+i.count;return{items,xp:s.skills.find(k=>k.name==='Fishing')?.experience??0};}
export function bigNetReceipt(b:ReturnType<typeof bigNetSnapshot>,a:ReturnType<typeof bigNetSnapshot>,rawBefore=0,initialXp=b.xp,rolls=1,xpRate=25){
 let rawXp=0,primary=0,changed=false;const byproducts:Record<number,number>={};
 for(const id of new Set([...Object.keys(b.items),...Object.keys(a.items)].map(Number))){const n=(a.items[id]??0)-(b.items[id]??0);if(!n)continue;changed=true;if(n<0||!Number.isSafeInteger(n)||!BIG_NET_ROLL_MAX[id]||n>BIG_NET_ROLL_MAX[id]!*rolls)return{kind:'invalid' as const};rawXp+=n*BIG_NET_RAW_XP[id]!;if(FISH_PROFILES.bigNet.products.includes(id as never))primary+=n;else byproducts[id]=n;}
 const total=(rawBefore+rawXp)*xpRate,publicDelta=a.xp-initialXp;
 // Native seaweed awards one raw tenth. Public XP exposes only the integer floor; keep one shared initial phase.
 if(publicDelta<Math.floor(total/10)||publicDelta>Math.ceil(total/10))return{kind:'pending' as const};
 return{kind:changed?'made' as const:'none' as const,rawXp,primary,byproducts};
}
const npcPack=new Map(readFileSync(resolve(content,'pack/npc.pack'),'utf8').split(/\r?\n/).map(l=>{const at=l.indexOf('=');return[l.slice(at+1),Number(l.slice(0,at))];}));
const npcDefs=readFileSync(resolve(content,'scripts/skill_fishing/configs/fishing.npc'),'utf8').split(/(?=^\[)/m);
const spotIdsCache=new Map<FishMethod,number[]>();
export function fishSpotIds(method:FishMethod){
 const hit=spotIdsCache.get(method);if(hit)return hit;
 const profile=FISH_PROFILES[method]as NativeFishProfile;
 const ids=npcDefs.filter(block=>profile.names?profile.names.includes(block.match(/^\[([^\]]+)\]/)?.[1]??''):new RegExp(`^category=${profile.category}\\r?$`,'m').test(block)).map(block=>npcPack.get(block.match(/^\[([^\]]+)\]/)?.[1]??'')).filter((id):id is number=>id!==undefined);
 spotIdsCache.set(method,ids);
 return ids;
}
export function pickFishSpot(s:BotWorldState,method:FishMethod,radius=8):NearbyNpc|undefined{
 const p=FISH_PROFILES[method],ids=fishSpotIds(method);
 return s.nearbyNpcs.filter(n=>ids.includes(n.id)&&n.reachable!==false&&n.distance<=radius&&n.optionsWithIndex.some(o=>o.opIndex===p.op&&o.text.toLowerCase()===p.label.toLowerCase())).sort((a,b)=>a.distance-b.distance)[0];
}
export function catherbyFishingSearchPoints(){const body=readFileSync(resolve(content,'scripts/skill_fishing/configs/fishing_movement.enum'),'utf8').split('[fishing_movement_catherby_enum]')[1]!.split('\n[')[0]!;const points=[...body.matchAll(/^val=\d+,(\d+)_(\d+)_(\d+)_(\d+)_(\d+)/gm)].map(m=>({x:Number(m[2])*64+Number(m[4]),z:Number(m[3])*64+Number(m[5]),level:Number(m[1])}));return[points[0]!,points[Math.floor(points.length/2)]!,points.at(-1)!];}
export async function searchNativeCatherbyFishing(s:Session,method:FishMethod,pass:number,stop:()=>boolean){
 const player=s.sdk.getState()?.player;if(!player||player.level!==0||player.worldX<2800||player.worldX>2870||player.worldZ<3410||player.worldZ>3455||!['net','seaBait','cage','harpoon','bigNet'].includes(method)||pass>=3||stop())return false;
 const visible=pickFishSpot(s.sdk.getState()!,method,16),target=visible??catherbyFishingSearchPoints()[pass];if(!target)return false;
 let end:{x:number;z:number}|undefined;for(const distance of[2,3,4]){for(const[x,z]of[[target.x,target.z+distance],[target.x-distance,target.z+distance],[target.x+distance,target.z+distance]]){const path=s.sdk.findPath(x!,z!);if(path.success&&path.reachedDestination===true){end={x:x!,z:z!};break;}}if(end)break;}
 if(!end)return false;console.log('FISH_SEARCH '+JSON.stringify({method,pass,visible:visible?.index,target:{x:target.x,z:target.z},shore:end}));const result=await walkPath(await sessionWalker(s),[{...end,tol:0}],{maxTicks:20,stop});if(!result.ok||stop())return false;await waitTicks(s,1);return true;
}
const count=(s:BotWorldState,id:number)=>s.inventory.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const fishCount=(s:BotWorldState,method:FishMethod)=>FISH_PROFILES[method].products.reduce((n,id)=>n+count(s,id),0);
const xp=(s:BotWorldState)=>s.skills.find(k=>k.name==='Fishing')?.experience??0;
const hp=(s:BotWorldState)=>s.skills.find(k=>k.name==='Hitpoints')?.level??0;
const protectedKit=(s:BotWorldState,method:FishMethod)=>{
 const p=FISH_PROFILES[method],allow=new Set<number>([...p.products,...fishingByproducts(method),p.bait,...method==='karambwan'?[3157,3159]:[]]);
 return JSON.stringify([...s.inventory.filter(i=>!allow.has(i.id)).reduce((m,i)=>m.set(i.id,(m.get(i.id)??0)+i.count),new Map<number,number>())].sort((a,b)=>a[0]-b[0]));
};
// knife: the knife reset (FISH_KNIFE_RESET) with a knife and logs in the pack; make1 is skill_multi3:make1_a. drop
// drops one catch in each cycle, so the pack never fills. Without knife the batch is unchanged.
export interface FishBatchOptions{method:FishMethod;amount:number;cap:number;maxAttempts:number;progressTicks:number;xpRate?:number;knife?:{make1:number;drop?:boolean}}
// send: the inputs of one tick, sent together. stand: walk to a tile beside the spot (not a corner). The knife reset
// needs both.
export interface FishDriver{state:()=>BotWorldState|null;tick:()=>number;stopped:()=>boolean;interact:(index:number,op:number)=>Promise<{success:boolean}>;combine:(a:number,b:number)=>Promise<{success:boolean}>;wait:(test:()=>boolean,ticks:number)=>Promise<boolean>;step:()=>Promise<void>;search?:(pass:number,stop:()=>boolean)=>Promise<boolean>;send?:(actions:FishAction[])=>Promise<void>;stand?:(spot:NearbyNpc)=>Promise<boolean>}
export function karambwanLoadEffect(before:BotWorldState,after:BotWorldState){
 return count(before,3157)-count(after,3157)===1&&count(after,3159)-count(before,3159)===1&&count(before,3150)-count(after,3150)===1;
}
export function karambwanAttemptEffect(before:BotWorldState,after:BotWorldState){
 if(count(before,3159)-count(after,3159)!==1||count(after,3157)-count(before,3157)!==1)throw Error('karambwan vessel debit does not reconcile');
 const caught=count(after,3142)-count(before,3142);
 if(caught!==0&&caught!==1||caught===1&&xp(after)<=xp(before)||caught===0&&xp(after)!==xp(before))throw Error('karambwan catch does not reconcile');
 return caught;
}
// The knife reset loop: one cycle of 3 ticks for each roll while the account stands beside the spot. The spot is never
// clicked without a cut, so the hidden-op loop never sets its own +4 or +5 delay. A catch is a tick in which the
// Fishing XP rises; catches and drops never share a tick (the drop goes in T or T+1, the roll in T+2).
async function knifeFishing(d:FishDriver,o:FishBatchOptions,state:()=>BotWorldState,initial:BotWorldState,start:number){
 const reset=FISH_KNIFE_RESET[o.method],k=o.knife!,profile=FISH_PROFILES[o.method],outputs=new Set<number>(fishingOutputs(o.method)),products:readonly number[]=profile.products;
 if(!reset)throw Error(`no knife reset for fishing ${o.method}`);
 const send=d.send,stand=d.stand;if(!send||!stand)throw Error('knife fishing needs send and stand');
 if(!knifeCut(initial.inventory,k.make1))throw Error('knife fishing needs a knife and logs');
 const freeRequired=o.method==='bigNet'?9:1,bait0=profile.bait?count(initial,profile.bait):0;
 let held=fishCount(initial,o.method),seenXp=xp(initial),caught=0,dropped=0,cycles=0,stands=0,progress=start,searches=0,missingSince=start;
 const observe=(drops:number)=>{
  const s=state(),now=fishCount(s,o.method),x=xp(s);
  if(now<held)dropped+=Math.min(drops,held-now);
  if(x>seenXp){caught+=Math.max(0,now-held+drops);progress=d.tick();}
  held=now;seenXp=x;return s;
 };
 while(caught<o.amount){
  let s=state();if(d.tick()-progress>=o.progressTicks)throw Error('fishing no progress');
  if(profile.bait&&count(s,profile.bait)<1)throw Error('fishing bait exhausted');
  const drop=k.drop?s.inventory.find(i=>outputs.has(i.id)):undefined;
  if(!drop&&28-s.inventory.length<freeRequired)throw Error('fishing pack capacity before next native roll');
  // Radius 15, not 8: a spot that moves to the far end of its route is still found (the Lumbridge river spot moves
  // between 3239,3241 and 3238,3255, fishing_movement.enum:279-289; from 3239,3252 the far tiles are 9 to 11 away).
  const spot=pickFishSpot(s,o.method,15);
  if(!spot){if(d.search){if(searches>=3||!await d.search(searches++,()=>{state();return false;}))throw Error('fishing no compatible native spot after bounded search');}else{if(d.tick()-missingSince>=Math.min(12,o.progressTicks))throw Error('fishing no compatible native spot');await d.step();}observe(0);continue;}
  searches=0;missingSince=d.tick();
  if(Math.abs(s.player!.worldX-spot.x)+Math.abs(s.player!.worldZ-spot.z)!==1){if(++stands>o.maxAttempts)throw Error('fishing dispatch limit');if(!await stand(spot))await d.step();observe(0);continue;}
  const cut=knifeCut(s.inventory,k.make1);if(!cut)throw Error('knife fishing needs a knife and logs');
  const drops:FishAction[]=drop?[{type:'dropItem',slot:drop.slot}]:[],n=drop&&products.includes(drop.id)?1:0;
  const click:FishAction={type:'interactNpc',npcIndex:spot.index,optionIndex:profile.op};
  cycles++;
  if(reset==='same'){
   // The drop goes first: it ends the pending action (OpHeldHandler.ts:54-55). The close after the click clears the
   // queued cut at the queue pass of this tick (Player.ts:998-1000) when the server refuses the click (a spot about to
   // move is delayed, OpNpcHandler.ts:27), and leaves the interaction alone.
   await send([...drops,...cut,click,{type:'closeModal'}]);await d.step();observe(n);await d.step();observe(0);await d.step();observe(0);
  }else{
   await send(cut);await d.step();observe(0);
   await send(drops.length?drops:[{type:'closeModal'}]);await d.step();s=observe(n);
   // A spot that moved gets no click (it would walk and roll late); the next cycle stands beside it first.
   if(s.nearbyNpcs.some(m=>m.index===spot.index&&m.x===spot.x&&m.z===spot.z))await send([click]);
   await d.step();observe(0);
  }
 }
 const final=state();if(xp(final)<=xp(initial))throw Error('fishing target unobserved');
 return{caught,baitUsed:profile.bait?bait0-count(final,profile.bait):0,attempts:cycles,ticks:d.tick()-start,knife:{reset,dropped,stands}};
}
export interface FishBatchResult{caught:number;baitUsed:number;attempts:number;ticks:number;byproducts?:Record<number,number>;rawXp?:number;publicXpDelta?:number;knife?:{reset:FishReset;dropped:number;stands:number}}
export async function runStagedFishing(d:FishDriver,o:FishBatchOptions):Promise<FishBatchResult>{
 if(!FISH_PROFILES[o.method])throw Error('unknown fishing method');
 for(const [k,n] of Object.entries(o))if(k!=='method'&&k!=='knife'&&(!Number.isSafeInteger(n)||Number(n)<1))throw Error(`invalid fishing ${k}`);
 const xpRate=o.xpRate??25;if(!Number.isSafeInteger(xpRate)||xpRate<1||xpRate>1000)throw Error('invalid fishing XP rate');
 const initial=d.state(),profile=FISH_PROFILES[o.method];
 if(!initial?.player||hp(initial)<1)throw Error('fishing state unknown');
 if((initial.skills.find(k=>k.name==='Fishing')?.level??0)<profile.level)throw Error(`requires Fishing${profile.level}`);
 if(!count(initial,profile.tool)&&!(o.method==='karambwan'&&count(initial,3159)))throw Error(`missing fishing tool ${profile.tool}`);
 const freeRequired=o.method==='bigNet'?9:1;if(28-initial.inventory.length<freeRequired)throw Error('fishing requires free space for native roll');
 const start=d.tick(),base=fishCount(initial,o.method);let last=base,progress=start,attempts=0,baitUsed=0,active:number|undefined,searches=0,missingSince=start;
 const originalLife=initial.player.lifeId,originalPlane=initial.player.level,originalRespawns=initial.player.respawnCount??0,originalHp=hp(initial),originalKit=protectedKit(initial,o.method),initialXp=xp(initial);let netRawXp=0;const netByproducts:Record<number,number>={};
 const state=()=>{const s=d.state();if(!s?.player)throw Error('fishing session ended');if(d.stopped())throw Error('fishing stopped');if(d.tick()-start>=o.cap)throw Error('fishing tick cap');if(s.player.level!==originalPlane||s.player.lifeId!==originalLife||(s.player.respawnCount??0)!==originalRespawns||hp(s)!==originalHp||s.player.isDead)throw Error('fishing health or plane changed');if(protectedKit(s,o.method)!==originalKit)throw Error('fishing protected assets changed');return s;};
 if(o.knife)return knifeFishing(d,o,state,initial,start);
 while(last-base<o.amount){
  let s=state();if(d.tick()-progress>=o.progressTicks)throw Error('fishing no progress');
  if(28-s.inventory.length<freeRequired)throw Error('fishing pack capacity before next native roll');
  if(profile.bait&&count(s,profile.bait)<1&&!(o.method==='karambwan'&&count(s,3159)))throw Error('fishing bait exhausted');
  const spot=pickFishSpot(s,o.method);if(!spot){active=undefined;if(d.search){if(searches>=3||!await d.search(searches++,()=>{state();return false;}))throw Error('fishing no compatible native spot after bounded search');state();}else{if(d.tick()-missingSince>=Math.min(12,o.progressTicks))throw Error('fishing no compatible native spot');await d.step();}continue;}searches=0;missingSince=d.tick();
  if(o.method==='karambwan'){
   if(attempts>=o.maxAttempts)throw Error('karambwan attempt limit');
   if(!count(s,3159)){
    const vessel=s.inventory.find(i=>i.id===3157)!,bait=s.inventory.find(i=>i.id===3150)!;
    if(bait.count!==1)throw Error('native karambwanji must occupy single-item slots');
    if(!(await d.combine(vessel.slot,bait.slot)).success)throw Error('karambwan load refused');
    if(!await d.wait(()=>karambwanLoadEffect(s,state()),Math.min(8,o.cap-(d.tick()-start))))throw Error('karambwan loading unobserved');
    baitUsed++;s=state();
   }
   if(!(await d.interact(spot.index,profile.op)).success)throw Error('karambwan cast refused');attempts++;
   if(!await d.wait(()=>count(state(),3159)<count(s,3159),Math.min(20,o.cap-(d.tick()-start))))throw Error('karambwan attempt unobserved; check Lubufu vessel unlock');
   karambwanAttemptEffect(s,state());
  }else if(o.method==='bigNet'){
   const before=bigNetSnapshot(s),began=d.tick(),x=spot.x,z=spot.z;
   if(active!==spot.index){if(++attempts>o.maxAttempts)throw Error('fishing dispatch limit');if(!(await d.interact(spot.index,profile.op)).success)throw Error('fishing action refused');active=spot.index;}
   await d.wait(()=>{const now=state();return fishingOutputs('bigNet').some(id=>count(now,id)>(before.items[id]??0))||!now.nearbyNpcs.some(n=>n.index===active&&n.x===x&&n.z===z);},Math.min(40,o.progressTicks-(d.tick()-progress),o.cap-(d.tick()-start)));
   const receipt=()=>bigNetReceipt(before,bigNetSnapshot(state()),netRawXp,initialXp,Math.max(1,Math.ceil((d.tick()-began)/5)),xpRate);let effect=receipt();
   if(effect.kind==='pending'){await d.wait(()=>receipt().kind!=='pending',Math.min(3,o.cap-(d.tick()-start)));effect=receipt();}
   if(effect.kind==='invalid'||effect.kind==='pending')throw Error('big-net whole-pack/native XP receipt unobserved');
   netRawXp+=effect.rawXp;for(const[id,n]of Object.entries(effect.byproducts))netByproducts[+id]=(netByproducts[+id]??0)+n;
   if(!state().nearbyNpcs.some(n=>n.index===active&&n.x===x&&n.z===z))active=undefined;
  }else{
   if(active!==spot.index){if(++attempts>o.maxAttempts)throw Error('fishing dispatch limit');if(!(await d.interact(spot.index,profile.op)).success)throw Error('fishing action refused');active=spot.index;}
   const before=s,beforeBait=profile.bait?count(s,profile.bait):0,beforeCatch=fishCount(s,o.method),beforeXp=xp(s);
   await d.wait(()=>{const now=state();return fishCount(now,o.method)>last||!now.nearbyNpcs.some(n=>n.index===active&&n.x===spot.x&&n.z===spot.z);},Math.min(40,o.progressTicks-(d.tick()-progress),o.cap-(d.tick()-start)));
   const after=state(),delta=fishCount(after,o.method)-(o.method==='lava'?beforeCatch:fishCount(before,o.method)),bait=profile.bait?(o.method==='lava'?beforeBait:count(before,profile.bait))-count(after,profile.bait):0;
   if(delta<0||delta>0&&xp(after)<=(o.method==='lava'?beforeXp:xp(before))||bait<0||profile.bait&&bait!==delta)throw Error('fishing catch/bait does not reconcile');
   if(o.method==='lava'&&xp(after)-initialXp!==(fishCount(after,o.method)-base)*60*xpRate)throw Error('lava eel native XP does not reconcile');
   baitUsed+=bait;
   if(!after.nearbyNpcs.some(n=>n.index===active&&n.x===spot.x&&n.z===spot.z))active=undefined;
  }
  const after=state(),previous=last;last=fishCount(after,o.method);if(last>((o.method==='bigNet'||o.method==='lava')?previous:fishCount(s,o.method))){progress=d.tick();}
  if(last-base<o.amount){
   const pendingCatch=last,pendingBait=profile.bait?count(after,profile.bait):0,pendingXp=xp(after);await d.step();
   if(o.method!=='bigNet'&&o.method!=='karambwan'){const next=state(),received=fishCount(next,o.method)-pendingCatch,used=profile.bait?pendingBait-count(next,profile.bait):0,gained=xp(next)-pendingXp;if(received<0||received>1||profile.bait&&used!==received||received===0&&gained!==0||received>0&&gained<=0||o.method==='lava'&&gained!==received*60*xpRate)throw Error('fishing step catch/bait/XP does not reconcile');baitUsed+=used;last+=received;if(received)progress=d.tick();}
  }
 }
 const final=state();if(last-base<o.amount||xp(final)<=((o.method==='bigNet'||o.method==='lava')?initialXp:xp(initial)))throw Error('fishing target unobserved');
 return{caught:last-base,baitUsed,attempts,ticks:d.tick()-start,...o.method==='bigNet'?{byproducts:netByproducts,rawXp:netRawXp,publicXpDelta:xp(final)-initialXp}:{}};
}
if(import.meta.main){
 const name=process.argv[2],method=process.argv[3]??'fly',amount=Number(process.argv[4]??10),cap=Number(process.argv[5]??1000);
 if(!name||!(method in FISH_PROFILES)&&method!=='shark'||!Number.isSafeInteger(amount)||amount<1||!Number.isSafeInteger(cap)||cap<1)throw Error('account method amount cap required');
 const s=await openBot(name).catch(e=>finish([],false,`login: ${String(e)}`));let ended=false;void s.ended.then(()=>{ended=true;});
 const start=s.tick(),entry=s.sdk.getState(),entryHp=entry?hp(entry):0,stopped=()=>ended||existsSync(`.practice/stop-${name}`)||existsSync('.practice/stop-all');
 // FISH_KNIFE=1: the knife reset (FISH_KNIFE_RESET); FISH_DROP=1 drops one catch in each cycle.
 const knife=process.env.FISH_KNIFE==='1'?{make1:componentId('skill_multi3:make1_a'),drop:process.env.FISH_DROP==='1'}:undefined;
 // Ticks of each catch (the Fishing XP rises), for FISH_RATE.
 const catches:{tick:number;xp:number}[]=[];let seen=entry?xp(entry):0;const offRate=s.onTick(()=>{const now=s.sdk.getState();const x=now?xp(now):seen;if(x>seen)catches.push({tick:s.tick(),xp:x});seen=x;});
 // A tile beside the spot (not a corner) that the path finder reaches, nearest first.
 const stand=async(spot:NearbyNpc)=>{const p=s.sdk.getState()?.player;if(!p)return false;const tiles=[[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dz])=>({x:spot.x+dx!,z:spot.z+dz!})).sort((a,b)=>Math.max(Math.abs(a.x-p.worldX),Math.abs(a.z-p.worldZ))-Math.max(Math.abs(b.x-p.worldX),Math.abs(b.z-p.worldZ)));for(const t of tiles){const path=s.sdk.findPath(t.x,t.z);if(path.success&&path.reachedDestination===true)return(await walkPath(await sessionWalker(s),[{...t,tol:0}],{maxTicks:20,stop:stopped})).ok;}return false;};
 try{
  const result=method==='shark'?await catchSharks(s,amount,()=>{const current=s.sdk.getState();return stopped()||s.tick()-start>=cap||!current?.player||entryHp<1||hp(current)!==entryHp||current.player.lifeId!==entry?.player?.lifeId||current.player.level!==entry?.player?.level;}):await runStagedFishing({state:()=>s.sdk.getState(),tick:()=>s.tick(),stopped,interact:(i,op)=>s.sdk.sendInteractNpc(i,op),combine:(a,b)=>s.sdk.sendUseItemOnItem(a,b),wait:(test,ticks)=>waitUntil(s,test,{timeoutTicks:ticks}),step:()=>waitTicks(s,1),send:async acts=>{for(const a of acts)await s.direct({...a,reason:'SDK'});},stand},{method:method as FishMethod,amount,cap,maxAttempts:Number(process.env.MAX_ATTEMPTS??100),progressTicks:Number(process.env.PROGRESS_TICKS??420),xpRate:Number(process.env.FISHING_XP_RATE??25),knife});
  offRate();
  // Ticks per catch and XP per tick from the first catch to the last, so the walk and the login are not in it.
  if(catches.length>1){const a=catches[0]!,b=catches.at(-1)!,per=(b.tick-a.tick)/(catches.length-1);console.log(`FISH_RATE method=${method} knife=${knife?1:0} catches=${catches.length} ticksPerCatch=${per.toFixed(2)} xpPerTick=${((b.xp-a.xp)/(b.tick-a.tick)).toFixed(1)} runTicks=${s.tick()-start}`);}
  await finish([s],true,JSON.stringify(result));
 }catch(e){await finish([s],false,String(e));}
}
