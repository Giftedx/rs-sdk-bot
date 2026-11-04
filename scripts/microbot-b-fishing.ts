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
export function fishSpotIds(method:FishMethod){
 const profile=FISH_PROFILES[method]as NativeFishProfile;
 return npcDefs.filter(block=>profile.names?profile.names.includes(block.match(/^\[([^\]]+)\]/)?.[1]??''):new RegExp(`^category=${profile.category}\\r?$`,'m').test(block)).map(block=>npcPack.get(block.match(/^\[([^\]]+)\]/)?.[1]??'')).filter((id):id is number=>id!==undefined);
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
export interface FishBatchOptions{method:FishMethod;amount:number;cap:number;maxAttempts:number;progressTicks:number;xpRate?:number}
export interface FishDriver{state:()=>BotWorldState|null;tick:()=>number;stopped:()=>boolean;interact:(index:number,op:number)=>Promise<{success:boolean}>;combine:(a:number,b:number)=>Promise<{success:boolean}>;wait:(test:()=>boolean,ticks:number)=>Promise<boolean>;step:()=>Promise<void>;search?:(pass:number,stop:()=>boolean)=>Promise<boolean>}
export function karambwanLoadEffect(before:BotWorldState,after:BotWorldState){
 return count(before,3157)-count(after,3157)===1&&count(after,3159)-count(before,3159)===1&&count(before,3150)-count(after,3150)===1;
}
export function karambwanAttemptEffect(before:BotWorldState,after:BotWorldState){
 if(count(before,3159)-count(after,3159)!==1||count(after,3157)-count(before,3157)!==1)throw Error('karambwan vessel debit does not reconcile');
 const caught=count(after,3142)-count(before,3142);
 if(caught!==0&&caught!==1||caught===1&&xp(after)<=xp(before)||caught===0&&xp(after)!==xp(before))throw Error('karambwan catch does not reconcile');
 return caught;
}
export async function runStagedFishing(d:FishDriver,o:FishBatchOptions){
 if(!FISH_PROFILES[o.method])throw Error('unknown fishing method');
 for(const [k,n] of Object.entries(o))if(k!=='method'&&(!Number.isSafeInteger(n)||Number(n)<1))throw Error(`invalid fishing ${k}`);
 const xpRate=o.xpRate??25;if(!Number.isSafeInteger(xpRate)||xpRate<1||xpRate>1000)throw Error('invalid fishing XP rate');
 const initial=d.state(),profile=FISH_PROFILES[o.method];
 if(!initial?.player||hp(initial)<1)throw Error('fishing state unknown');
 if((initial.skills.find(k=>k.name==='Fishing')?.level??0)<profile.level)throw Error(`requires Fishing${profile.level}`);
 if(!count(initial,profile.tool)&&!(o.method==='karambwan'&&count(initial,3159)))throw Error(`missing fishing tool ${profile.tool}`);
 const freeRequired=o.method==='bigNet'?9:1;if(28-initial.inventory.length<freeRequired)throw Error('fishing requires free space for native roll');
 const start=d.tick(),base=fishCount(initial,o.method);let last=base,progress=start,attempts=0,baitUsed=0,active:number|undefined,searches=0,missingSince=start;
 const originalLife=initial.player.lifeId,originalPlane=initial.player.level,originalRespawns=initial.player.respawnCount??0,originalHp=hp(initial),originalKit=protectedKit(initial,o.method),initialXp=xp(initial);let netRawXp=0;const netByproducts:Record<number,number>={};
 const state=()=>{const s=d.state();if(!s?.player)throw Error('fishing session ended');if(d.stopped())throw Error('fishing stopped');if(d.tick()-start>=o.cap)throw Error('fishing tick cap');if(s.player.level!==originalPlane||s.player.lifeId!==originalLife||(s.player.respawnCount??0)!==originalRespawns||hp(s)!==originalHp||s.player.isDead)throw Error('fishing health or plane changed');if(protectedKit(s,o.method)!==originalKit)throw Error('fishing protected assets changed');return s;};
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
 try{
  const result=method==='shark'?await catchSharks(s,amount,()=>{const current=s.sdk.getState();return stopped()||s.tick()-start>=cap||!current?.player||entryHp<1||hp(current)!==entryHp||current.player.lifeId!==entry?.player?.lifeId||current.player.level!==entry?.player?.level;}):await runStagedFishing({state:()=>s.sdk.getState(),tick:()=>s.tick(),stopped,interact:(i,op)=>s.sdk.sendInteractNpc(i,op),combine:(a,b)=>s.sdk.sendUseItemOnItem(a,b),wait:(test,ticks)=>waitUntil(s,test,{timeoutTicks:ticks}),step:()=>waitTicks(s,1)},{method:method as FishMethod,amount,cap,maxAttempts:Number(process.env.MAX_ATTEMPTS??100),progressTicks:Number(process.env.PROGRESS_TICKS??420),xpRate:Number(process.env.FISHING_XP_RATE??25)});
  await finish([s],true,JSON.stringify(result));
 }catch(e){await finish([s],false,String(e));}
}
