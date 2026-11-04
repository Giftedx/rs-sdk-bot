// Finite held-supply fishing batch. Caller stages the account beside a native spot.
// No world hopping, dropping, bank travel, or modern donor IDs.
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {openBot,finish} from '../packages/core/src/bot';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {catchSharks} from './gather-fish';
import type {BotWorldState,NearbyNpc} from '../vendor/rs-sdk/sdk/types';

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
} as const;
export type FishMethod=keyof typeof FISH_PROFILES;
const npcPack=new Map(readFileSync(resolve(content,'pack/npc.pack'),'utf8').split(/\r?\n/).map(l=>{const at=l.indexOf('=');return[l.slice(at+1),Number(l.slice(0,at))];}));
const npcDefs=readFileSync(resolve(content,'scripts/skill_fishing/configs/fishing.npc'),'utf8').split(/(?=^\[)/m);
export function fishSpotIds(method:FishMethod){
 const profile=FISH_PROFILES[method];
 return npcDefs.filter(block=>new RegExp(`^category=${profile.category}\\r?$`,'m').test(block)).map(block=>npcPack.get(block.match(/^\[([^\]]+)\]/)?.[1]??'')).filter((id):id is number=>id!==undefined);
}
export function pickFishSpot(s:BotWorldState,method:FishMethod):NearbyNpc|undefined{
 const p=FISH_PROFILES[method],ids=fishSpotIds(method);
 return s.nearbyNpcs.filter(n=>ids.includes(n.id)&&n.reachable!==false&&n.distance<=8&&n.optionsWithIndex.some(o=>o.opIndex===p.op&&o.text.toLowerCase()===p.label.toLowerCase())).sort((a,b)=>a.distance-b.distance)[0];
}
const count=(s:BotWorldState,id:number)=>s.inventory.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const fishCount=(s:BotWorldState,method:FishMethod)=>FISH_PROFILES[method].products.reduce((n,id)=>n+count(s,id),0);
const xp=(s:BotWorldState)=>s.skills.find(k=>k.name==='Fishing')?.experience??0;
const hp=(s:BotWorldState)=>s.skills.find(k=>k.name==='Hitpoints')?.level??0;
const protectedKit=(s:BotWorldState,method:FishMethod)=>{
 const p=FISH_PROFILES[method],allow=new Set<number>([...p.products,p.bait,...method==='karambwan'?[3157,3159]:[]]);
 return JSON.stringify([...s.inventory.filter(i=>!allow.has(i.id)).reduce((m,i)=>m.set(i.id,(m.get(i.id)??0)+i.count),new Map<number,number>())].sort((a,b)=>a[0]-b[0]));
};
export interface FishBatchOptions{method:FishMethod;amount:number;cap:number;maxAttempts:number;progressTicks:number}
export interface FishDriver{state:()=>BotWorldState|null;tick:()=>number;stopped:()=>boolean;interact:(index:number,op:number)=>Promise<{success:boolean}>;combine:(a:number,b:number)=>Promise<{success:boolean}>;wait:(test:()=>boolean,ticks:number)=>Promise<boolean>;step:()=>Promise<void>}
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
 const initial=d.state(),profile=FISH_PROFILES[o.method];
 if(!initial?.player||hp(initial)<1)throw Error('fishing state unknown');
 if((initial.skills.find(k=>k.name==='Fishing')?.level??0)<profile.level)throw Error(`requires Fishing${profile.level}`);
 if(!count(initial,profile.tool)&&!(o.method==='karambwan'&&count(initial,3159)))throw Error(`missing fishing tool ${profile.tool}`);
 if(initial.inventory.length>=28)throw Error('fishing requires free space');
 const start=d.tick(),base=fishCount(initial,o.method);let last=base,progress=start,attempts=0,baitUsed=0,active:number|undefined;
 const state=()=>{const s=d.state();if(!s?.player)throw Error('fishing session ended');if(d.stopped())throw Error('fishing stopped');if(d.tick()-start>=o.cap)throw Error('fishing tick cap');if(s.player.level!==initial.player!.level||s.player.lifeId!==initial.player!.lifeId||hp(s)!==hp(initial)||s.player.isDead)throw Error('fishing health or plane changed');if(protectedKit(s,o.method)!==protectedKit(initial,o.method))throw Error('fishing protected assets changed');return s;};
 while(last-base<o.amount){
  let s=state();if(d.tick()-progress>=o.progressTicks)throw Error('fishing no progress');
  if(s.inventory.length>=28)throw Error('fishing pack full before target');
  if(profile.bait&&count(s,profile.bait)<1&&!(o.method==='karambwan'&&count(s,3159)))throw Error('fishing bait exhausted');
  const spot=pickFishSpot(s,o.method);if(!spot){await d.step();continue;}
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
  }else{
   if(active!==spot.index){if(++attempts>o.maxAttempts)throw Error('fishing dispatch limit');if(!(await d.interact(spot.index,profile.op)).success)throw Error('fishing action refused');active=spot.index;}
   const before=s;
   await d.wait(()=>{const now=state();return fishCount(now,o.method)>last||!now.nearbyNpcs.some(n=>n.index===active&&n.x===spot.x&&n.z===spot.z);},Math.min(40,o.progressTicks-(d.tick()-progress),o.cap-(d.tick()-start)));
   const after=state(),delta=fishCount(after,o.method)-fishCount(before,o.method),bait=profile.bait?count(before,profile.bait)-count(after,profile.bait):0;
   if(delta<0||delta>0&&xp(after)<=xp(before)||bait<0||profile.bait&&bait!==delta)throw Error('fishing catch/bait does not reconcile');
   baitUsed+=bait;
   if(!after.nearbyNpcs.some(n=>n.index===active&&n.x===spot.x&&n.z===spot.z))active=undefined;
  }
  const after=state();last=fishCount(after,o.method);if(last>fishCount(s,o.method)){progress=d.tick();}
  if(last-base<o.amount)await d.step();
 }
 const final=state();if(last-base<o.amount||xp(final)<=xp(initial))throw Error('fishing target unobserved');
 return{caught:last-base,baitUsed,attempts,ticks:d.tick()-start};
}
if(import.meta.main){
 const name=process.argv[2],method=process.argv[3]??'fly',amount=Number(process.argv[4]??10),cap=Number(process.argv[5]??1000);
 if(!name||!(method in FISH_PROFILES)&&method!=='shark'||!Number.isSafeInteger(amount)||amount<1||!Number.isSafeInteger(cap)||cap<1)throw Error('account method amount cap required');
 const s=await openBot(name).catch(e=>finish([],false,`login: ${String(e)}`));let ended=false;void s.ended.then(()=>{ended=true;});
 const start=s.tick(),entry=s.sdk.getState(),entryHp=entry?hp(entry):0,stopped=()=>ended||existsSync(`.practice/stop-${name}`)||existsSync('.practice/stop-all');
 try{
  const result=method==='shark'?await catchSharks(s,amount,()=>{const current=s.sdk.getState();return stopped()||s.tick()-start>=cap||!current?.player||entryHp<1||hp(current)!==entryHp||current.player.lifeId!==entry?.player?.lifeId||current.player.level!==entry?.player?.level;}):await runStagedFishing({state:()=>s.sdk.getState(),tick:()=>s.tick(),stopped,interact:(i,op)=>s.sdk.sendInteractNpc(i,op),combine:(a,b)=>s.sdk.sendUseItemOnItem(a,b),wait:(test,ticks)=>waitUntil(s,test,{timeoutTicks:ticks}),step:()=>waitTicks(s,1)},{method:method as FishMethod,amount,cap,maxAttempts:Number(process.env.MAX_ATTEMPTS??100),progressTicks:Number(process.env.PROGRESS_TICKS??420)});
  await finish([s],true,JSON.stringify(result));
 }catch(e){await finish([s],false,String(e));}
}
