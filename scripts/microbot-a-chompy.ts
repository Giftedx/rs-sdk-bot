// Behaviour source: pinned Microbot-Hub; BSD notice: research/microbot-ports-LICENSE.txt.
// Finite post-quest chompy hunt at a staged swamp: bun scripts/microbot-a-chompy.ts <account> [kills=1] [cap=2000] [max-baits=5].
// Native quest_chompybird: one bellows per fill, own bait UID, ogre bow/arrows only, own kill notch receipt.
import {existsSync} from 'node:fs';
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {questFlags} from '../packages/core/src/quest-status';
import {objId} from './measure/floor-bands';
export function chompyHuntingTile(p:{worldX:number;worldZ:number;level:number}){
 return p.level===0&&p.worldX>=2496&&p.worldX<=2687&&p.worldZ>=2944&&p.worldZ<=3007&&!(p.worldX>=2631&&p.worldX<=2639&&p.worldZ>=2962&&p.worldZ<=2971);
}
export const CHOMPY={live:1015,dead:1016,toad:1013,bait:2875,bow:2883,arrow:2866,empty:2871,full:2872,one:2874,two:2873,feather:314} as const;
export function bellowsCharges(rows:readonly{id:number;count:number}[]){return rows.reduce((n,i)=>n+i.count*(i.id===CHOMPY.full?3:i.id===CHOMPY.two?2:i.id===CHOMPY.one?1:0),0);}
export function ownChompyNotches(messages:readonly{text:string;tick:number;observationId?:number}[],cursor:number){return messages.filter(m=>(m.observationId??m.tick)>cursor&&/^You scratch a notch on your bow for the chompy bird kill\.$/.test(m.text)).length;}
export async function runChompy(s:Session,o:{kills:number;cap:number;maxBaits:number;stop?:()=>boolean;stageBait?:(stop:()=>boolean)=>Promise<void>;upkeep?:()=>Promise<void>}){
 if(![o.kills,o.cap,o.maxBaits].every(Number.isSafeInteger)||o.kills<1||o.kills>5||o.cap<1||o.cap>20000||o.maxBaits<o.kills||o.maxBaits>15)throw Error('invalid finite chompy limits');
 const st=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),held=(id:number)=>inv().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0),npcs=()=>s.sdk.getNearbyNpcs();
 const p0=st()?.player,hp0=s.sdk.getSkill('Hitpoints')?.level??0;
 if(!p0||!chompyHuntingTile(p0)||hp0<7)throw Error('stage at post-quest ogre swamp outside Rantz bait turf');
 if(!questFlags(s.client)?.some(q=>/chompy/i.test(q.name)&&q.state==='complete'))throw Error('Chompy quest completion unobserved');
 const worn=s.sdk.getEquipment();if(!worn.some(i=>i.slot===3&&i.id===CHOMPY.bow)||!worn.some(i=>i.slot===13&&i.id===CHOMPY.arrow&&i.count>0))throw Error('wear ogre bow and ogre arrows');
 if(npcs().some(n=>n.id===CHOMPY.live||n.id===CHOMPY.dead))throw Error('start without existing chompy targets');
 const life0=p0.lifeId,start=s.tick(),raw=objId('raw_chompy'),raw0=held(raw),feathers0=held(CHOMPY.feather),xp0=s.sdk.getSkillXp('Ranged')??0;
 let ended=false,kills=0,baits=0,plucked=0,failure='',stop='target';void s.ended.then(()=>{ended=true;});
 const unsafe=()=>{const p=st()?.player;return !p||p.isDead||p.lifeId!==life0||!chompyHuntingTile(p)||(s.sdk.getSkill('Hitpoints')?.level??0)<hp0;};
 const over=()=>ended||unsafe()||!!o.stop?.()||s.tick()-start>=o.cap;
 const cursor=()=>Math.max(-1,...(st()?.gameMessages??[]).map(m=>m.observationId??m.tick));
 const wait=async(predicate:()=>boolean,ticks:number)=>await waitUntil(s,()=>over()||predicate(),{timeoutTicks:Math.min(ticks,Math.max(1,o.cap-(s.tick()-start)))})&&!over()&&predicate();
 const near=(x:number,z:number)=>{const p=st()?.player;return !!p&&Math.max(Math.abs(p.worldX-x),Math.abs(p.worldZ-z))<=8;};
 try{
 while(kills<o.kills&&baits<o.maxBaits&&!over()){
  await o.upkeep?.();await s.bot.dismissBlockingUI();if(over())break;
  if(held(CHOMPY.bait)===0){
   if(held(CHOMPY.bait)>=3)throw Error('too many carried toads');
   let bellow=inv().find(i=>[CHOMPY.full,CHOMPY.two,CHOMPY.one].includes(i.id as any));
   if(!bellow){
    const empty=inv().find(i=>i.id===CHOMPY.empty),bubble=st()?.nearbyLocs.find(l=>/^swamp bubbles$/i.test(l.name)&&l.reachable!==false&&near(l.x,l.z));
    if(!empty||!bubble)throw Error('stage bellows and reachable swamp bubbles');const n=held(CHOMPY.full),empty0=held(CHOMPY.empty);
    if(!(await s.sdk.sendUseItemOnLoc(empty.slot,bubble.x,bubble.z,bubble.id)).success||!await wait(()=>held(CHOMPY.full)===n+1&&held(CHOMPY.empty)===empty0-1,12))throw Error('bellows fill not observed');
    bellow=inv().find(i=>i.id===CHOMPY.full);
   }
   const toad=npcs().filter(n=>n.id===CHOMPY.toad&&n.reachable!==false&&near(n.x,n.z)).sort((a,b)=>a.distance-b.distance)[0];if(!bellow||!toad||inv().length>=28)throw Error('toad/bellows/free slot missing');
   const inflationStock=()=>JSON.stringify(inv().map(i=>({id:i.id,count:i.count,slot:i.slot})).sort((a,b)=>a.slot-b.slot)),stock0=inflationStock();
   const charges=bellowsCharges(inv()),bait0=held(CHOMPY.bait),inflationCursor=cursor(),deadline=s.tick()+30;
   const effect=()=>held(CHOMPY.bait)===bait0+1&&bellowsCharges(inv())===charges-1;
   const begun=()=>(st()?.gameMessages??[]).some(m=>m.type===0&&(m.observationId??m.tick)>inflationCursor&&m.text==='You manage to catch the toad and inflate it with the swamp gas.');
   let selected=toad,last={x:st()!.player!.worldX,z:st()!.player!.worldZ},lastMove=s.tick();
   const paid=()=>{const at=st()?.player;if(at&&(at.worldX!==last.x||at.worldZ!==last.z)){last={x:at.worldX,z:at.worldZ};lastMove=s.tick();}return effect();};
   for(let attempt=0;attempt<3&&!effect()&&!over();attempt++){
    const origin={x:selected.x,z:selected.z},currentBellows=inv().find(i=>i.id===bellow!.id);if(over())break;if(!currentBellows||attempt>0&&(begun()||inflationStock()!==stock0))throw Error('toad inflation changed before retarget');if(!(await s.sdk.sendUseItemOnNpc(currentBellows.slot,selected.index)).success)throw Error('toad inflation dispatch refused');
    if(deadline>s.tick()&&await wait(paid,Math.min(10,deadline-s.tick())))break;
    const current=npcs().find(n=>n.id===CHOMPY.toad&&n.index===selected.index),uncharged=held(CHOMPY.bait)===bait0&&bellowsCharges(inv())===charges&&inflationStock()===stock0;
    if(!begun()&&!uncharged&&!effect())throw Error('toad inflation inventory changed without native intro');
    // Only replace an unstarted moving-target approach. Native intro precedes
    // its delayed charge debit, so any intro forbids another item-on-NPC input.
    const replacement=!begun()&&uncharged&&current&&(current.x!==origin.x||current.z!==origin.z)&&s.tick()-lastMove>=3?npcs().filter(n=>n.id===CHOMPY.toad&&n.reachable!==false&&near(n.x,n.z)).sort((a,b)=>a.distance-b.distance)[0]:undefined;
    if(!replacement||attempt===2||s.tick()>=deadline){if(deadline>s.tick())await wait(paid,deadline-s.tick());break;}selected=replacement;
   }
   if(!effect())throw Error('toad inflation effect missing');
  }
  await o.stageBait?.(over);if(over())break;
  if(npcs().some(n=>n.id===CHOMPY.live))throw Error('unowned pre-bait chompy appeared');
  const bait=inv().find(i=>i.id===CHOMPY.bait),p=st()?.player;if(!bait||!p||!chompyHuntingTile(p))throw Error('bait stage missing');
  const b0=held(CHOMPY.bait),placed={x:p.worldX,z:p.worldZ},c=cursor();
  const reply=await s.direct({type:'useInventoryItem',slot:bait.slot,optionIndex:1,reason:'SDK'}) as {success?:boolean};
  if(reply?.success===false||!await wait(()=>held(CHOMPY.bait)===b0-1&&npcs().some(n=>n.id===1014&&n.x===placed.x&&n.z===placed.z),12))throw Error('own bait placement missing');baits++;
  // A bait may fail its random spawn roll. Bound the wait and charge it against maxBaits.
  if(!await wait(()=>npcs().some(n=>n.id===CHOMPY.live&&near(n.x,n.z)),110)){if(over())break;continue;}
  const bird=npcs().filter(n=>n.id===CHOMPY.live&&near(n.x,n.z)).sort((a,b)=>a.distance-b.distance)[0];if(!bird)throw Error('spawn target lost');
  await o.upkeep?.();if(over())break;
  const corpseBaseline=new Set(npcs().filter(n=>n.id===CHOMPY.dead).map(n=>n.index));let lastLive={x:bird.tileX??bird.x,z:bird.tileZ??bird.z},ambiguous=false;
  const observe=()=>{const rows=npcs(),live=rows.find(n=>n.id===CHOMPY.live&&n.index===bird.index);if(live)lastLive={x:live.tileX??live.x,z:live.tileZ??live.z};if(rows.some(n=>n.id===CHOMPY.live&&n.index!==bird.index))ambiguous=true;};
  const ownCorpse=()=>{observe();const fresh=npcs().filter(n=>n.id===CHOMPY.dead&&!corpseBaseline.has(n.index));return!ambiguous&&fresh.length===1&&(fresh[0]!.tileX??fresh[0]!.x)===lastLive.x&&(fresh[0]!.tileZ??fresh[0]!.z)===lastLive.z?fresh[0]:undefined;};
  const unwatch=s.onTick(observe);let corpse:ReturnType<typeof npcs>[number]|undefined;
  try{
   if(!(await s.sdk.sendInteractNpc(bird.index,5)).success)throw Error('chompy attack refused');
   if(!await wait(()=>ownChompyNotches(st()?.gameMessages??[],c)>0,160))throw Error('own chompy kill notch not observed');
   if(ambiguous||ownChompyNotches(st()?.gameMessages??[],c)!==1)throw Error('ambiguous chompy kill count');kills++;
   // Native death stops movement, waits arrivedelay, then creates a new NPC at
   // the owned bird's final coordinate. Player distance does not bind ownership.
   if(!await wait(()=>!!ownCorpse(),8))throw Error('own kill corpse missing or ambiguous');corpse=ownCorpse();
  }finally{unwatch();}
  if(!corpse)throw Error('own kill corpse missing or ambiguous');
  const f0=held(CHOMPY.feather);
  if(!(await s.sdk.sendInteractNpc(corpse.index,4)).success||!await wait(()=>held(CHOMPY.feather)>=f0+10&&!npcs().some(n=>n.index===corpse.index&&n.id===CHOMPY.dead),12))throw Error('pluck effect missing');plucked++;
  const meat=s.sdk.getGroundItems().find(i=>i.id===raw&&i.x===corpse.x&&i.z===corpse.z);if(!meat)throw Error('raw chompy loot missing');const r0=held(raw);
  if(!(await s.sdk.sendPickup(meat.x,meat.z,raw)).success||!await wait(()=>held(raw)===r0+1,12))throw Error('raw chompy pickup missing');
  console.log('CHOMPY_KILL '+JSON.stringify({kills,baits,plucked,raw:held(raw)-raw0,tick:s.tick()}));await waitTicks(s,1);
 }
 if(kills<o.kills)stop=over()?'stopped/cap':'bait budget';
 }catch(e){failure=String(e);stop='failure';}
 const rawGained=held(raw)-raw0;
 return{ok:!failure&&!ended&&!unsafe()&&!o.stop?.()&&kills===o.kills&&plucked===kills&&rawGained===kills,stop,failure,kills,baits,plucked,raw:rawGained,feathers:held(CHOMPY.feather)-feathers0,rangedXp:(s.sdk.getSkillXp('Ranged')??0)-xp0,ticks:s.tick()-start};
}
if(import.meta.main){let s:Session|undefined,stopped=false;try{const [account,kills,cap,baits]=process.argv.slice(2);if(!account)throw Error('account required');s=await openBot(account,{onStop:async()=>{stopped=true;}});const r=await runChompy(s,{kills:Number(kills??1),cap:Number(cap??2000),maxBaits:Number(baits??5),stop:()=>stopped||existsSync('.practice/stop-microbot-chompy')});console.log('CHOMPY_RESULT '+JSON.stringify(r));await finish([s],r.ok,JSON.stringify(r));}catch(e){await finish(s?[s]:[],false,String(e));}}
