// ONE Fire giant pilot. Actual owned inputs and actual Waterfall access; never an endless camp.
import {openBot,finish,sessionDied} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {walkPath,sessionWalker,expandPath,type PathOptions} from '../packages/core/src/walk';
import {waterfallDialogue} from './generated/waterfall';
import {withdrawFireOwned,fireHomeEntryPoints} from './gather-fire-giants';
import type {NearbyNpc} from '../vendor/rs-sdk/sdk/types';
import {ownedLoadout,fireWeaponSlot} from '../packages/planner/src/owned-loadout';
const BANK={x:2619,z:3332},BONES=532,FOOD=329;
export function selectFireWeapon(stock: ReadonlyMap<number,number>,attack:number|null=99,reserved:ReadonlyMap<number,number>=new Map()): number {
 const result=ownedLoadout([fireWeaponSlot(attack)],[...stock].map(([id,count])=>({id,count})),[...reserved].map(([id,count])=>({id,count})));
 return result.state==='ready'?result.selected[0]!.id:0;
}
export function fireStartRoute(p:{worldX:number;worldZ:number;level:number}|null|undefined){
 if(!p||p.level!==0)throw Error('no Fire progress: known Waterfall or surface start required');
 if(Math.max(Math.abs(p.worldX-BANK.x),Math.abs(p.worldZ-BANK.z))<=4)return 'bank';
 try{fireHomeEntryPoints({x:p.worldX,z:p.worldZ,level:p.level});return 'bank';}catch{}
 if(p.worldX>=2560&&p.worldX<=2590&&p.worldZ>=9860&&p.worldZ<=9899)return 'dungeon';
 if(p.worldZ<4000)return 'surface';
 throw Error('no Fire progress: known Waterfall or surface start required');
}
export const fireMaxHit=Math.floor(((65+9)*(31+64)+320)/640); // exact110 config:11
export const fireFightSafe=(hp:number,food:number,ticks:number)=>hp>30&&food>=8&&ticks<250;
// Surface travel uses the shared path-sized deadline and look-ahead. The
// dungeon keeps its short clicks and 180-tick leg limit; the whole pilot and
// return retain their independent absolute limits.
export function fireWalkOptions(worldZ:number):Pick<PathOptions,'look'|'maxTicks'>{return worldZ<4000?{}:{look:4,maxTicks:180};}
export const FIRE_ROOM_ENTRY={x:2564,z:9882,tol:0};
export const fireDeathCredit=(ownXp:number,witness:boolean,bones:number)=>ownXp>=11100&&witness&&bones===1;
export function fireTargetInRoom(n:Pick<NearbyNpc,'tileX'|'tileZ'>):boolean {
 const x=n.tileX,z=n.tileZ;
 return typeof x==='number'&&typeof z==='number'&&Number.isInteger(x)&&Number.isInteger(z)&&x>=2560&&x<=2582&&z>=9882&&z<=9899;
}
export function selectFireTarget(npcs:readonly NearbyNpc[],selfSlot:number){
 if(!Number.isSafeInteger(selfSlot)||selfSlot<0)return;
 const own=32768+selfSlot; // NPC faceEntity uses the client player-index namespace.
 const spiders=npcs.filter(n=>n.id===58&&(n.tileZ??n.z)>=9882);
 return npcs.filter(n=>n.id===110&&n.reachable!==false&&(!n.inCombat||n.targetIndex===own)
  &&spiders.every(a=>Math.max(Math.abs((a.tileX??a.x)-((n.tileX??n.x)-1)),Math.abs((a.tileZ??a.z)-(n.tileZ??n.z)))>2)
  &&(n.hp===null||n.maxHp===null||n.hp>=n.maxHp)&&fireTargetInRoom(n))
  .sort((a,b)=>Number(b.inCombat&&b.targetIndex===own)-Number(a.inCombat&&a.targetIndex===own)||a.distance-b.distance)[0];
}
export async function sealFireRoom(s:Session,stop:()=>boolean){
 const state=()=>s.sdk.getState(),p=state()?.player;
 if(!p||p.level!==0||p.worldX<2560||p.worldX>2582||p.worldZ<9882||p.worldZ>9899)throw Error('no Fire progress: room entry unobserved');
 const closed=()=>state()?.nearbyLocs.some(l=>[1516,1519].includes(l.id)&&l.z===9881&&l.x>=2563&&l.x<=2565)??false;
 const door=state()?.nearbyLocs.find(l=>[1517,1520].includes(l.id)&&Math.abs(l.z-9881)<=1&&l.x>=2562&&l.x<=2566);
 if(!closed()){
  const option=door?.optionsWithIndex.find(o=>/^close$/i.test(o.text));
  if(stop()||!door||!option||!(await s.sdk.sendInteractLoc(door.x,door.z,door.id,option.opIndex)).success
   ||!await waitUntil(s,()=>closed()||stop(),{timeoutTicks:12})||stop()||!closed())throw Error('no Fire progress: closed room door unobserved');
 }
 const here=state()?.player;
 // A spider south of the observed closed door cannot follow through it.
 if(!here||state()?.nearbyNpcs.some(n=>n.id===58&&(n.tileZ??n.z)>=9882&&Math.max(Math.abs((n.tileX??n.x)-here.worldX),Math.abs((n.tileZ??n.z)-here.worldZ))<=2))throw Error('no Fire progress: spider at Fire entry');
}
export async function runFireCombat(s:Session,o:{cap:number;stop?:()=>boolean;recoverOnly?:boolean}){
 const start=s.tick(),st=()=>s.sdk.getState(),p=()=>st()?.player,inv=()=>s.sdk.getInventory(),eq=()=>s.sdk.getEquipment(),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0,xp=()=>s.sdk.getSkillXp('Attack')??0,points=()=>st()?.prayers?.prayerPoints??0;
 const n=(a:readonly {id:number;count:number}[],id:number)=>a.filter(i=>i.id===id).reduce((v,i)=>v+i.count,0),held=(id:number)=>n(inv(),id),p0=p();
 let ended=false,died=false,hpMin=hp(),eaten=0,eating:Promise<void>|undefined,healFailure='',failure='',creditedKills=0,banked=false,weapon=0,baseline:Map<number,number>|undefined,phase='prepare',fightTicks=0,entryPrayer=0,initialPrayer=points(),recharged=false,death: {x:number;z:number;hp0:boolean;anim:boolean}|undefined,targetIndex:number|undefined;
 const startRoute=fireStartRoute(p0);
 if(!p0)throw Error('no Fire progress: position unknown');
 let returnStart:number|undefined,recoveryEaten=0;
 const loot:Record<number,number>={},trace:unknown[]=[],attack0=xp(),life=p0.lifeId,respawns=p0.respawnCount??0;void s.ended.then(()=>{ended=true;});
 const over=()=>ended||died||!!o.stop?.()||(returnStart===undefined?s.tick()-start>=o.cap:s.tick()-returnStart>=600);
 const capture=(event:string)=>{const q=p();trace.push({event,tick:s.tick()-start,phase,pos:q?[q.worldX,q.worldZ,q.level]:null,hp:hp(),food:held(FOOD),prayer:points(),runEnergy:q?.runEnergy??null,spiders:st()?.nearbyNpcs.filter(n=>n.id===58&&n.distance<=15).map(n=>({index:n.index,x:n.tileX??n.x,z:n.tileZ??n.z,distance:n.distance,inCombat:n.inCombat})),target:targetIndex,targetPosition:(()=>{const n=st()?.nearbyNpcs.find(n=>n.index===targetIndex&&n.id===110);return n?{render:[n.x,n.z],route:[n.tileX??null,n.tileZ??null],size:n.size??null}:null;})()});if(trace.length>80)trace.splice(1,1);};
 const totals=()=>{const m=new Map<number,number>();for(const i of [...inv(),...eq(),...(s.bankObservation?.()?.items??[])])m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
 const eat=async()=>{const item=inv().find(i=>i.id===FOOD),before=held(FOOD),h=hp();if(!item||before<=8)throw new Error('food retreat reserve reached');await s.bot.eatFood(item);await waitUntil(s,()=>held(FOOD)<before&&hp()>h||died||ended,{timeoutTicks:6});eaten+=Math.max(0,before-held(FOOD));if(held(FOOD)!==before-1||hp()<=h)throw new Error('actual Salmon debit/heal not observed');capture('eat');await waitTicks(s,3);};
 const off=s.onTick(()=>{const q=p();if(hp()>0)hpMin=Math.min(hpMin,hp());if(sessionDied({lifeId:life,respawnCount:respawns},q))died=true;
  if(targetIndex!==undefined){const n=st()?.nearbyNpcs.find(n=>n.id===110&&n.index===targetIndex);if(n&&(n.hp===0||n.animId===131))death={x:n.tileX??n.x,z:n.tileZ??n.z,hp0:n.hp===0,anim:n.animId===131};}
  // Eating closes the bank and clears pending actions. Bank preparation and
  // final deposits own their inputs; heal explicitly between those actions.
  if(phase!=='prepare'&&phase!=='bank'&&hp()>0&&hp()<=40&&held(FOOD)>8&&!eating&&!over()){eating=eat().catch(e=>{healFailure=String(e);}).finally(()=>{eating=undefined;});}
  if(s.tick()%5===0&&phase==='dungeon')capture('entry-observation');
 });
 const guard=async()=>{if(eating)await eating;if(over()||hp()<=30||healFailure)throw new Error(`no Fire progress: ${healFailure||'HP/stop/cap/life guard'}`);};
 const walk=async(x:number,z:number,tol=1,cleanup=false)=>{if(!cleanup)await guard();const q=p();if(!q)throw new Error('no Fire progress: walk position unknown');const r=await walkPath(await sessionWalker(s),[{x,z,tol}],{...fireWalkOptions(q.worldZ),stop:()=>over()||(!cleanup&&(hp()<=30||!!healFailure))});if(!r.ok)throw new Error(`no Fire progress: route ${r.detail}`);};
 const open=async()=>{await s.bot.dismissBlockingUI();const gen=s.bankObservation?.()?.generation??0;if(!st()?.bank.isOpen){if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!st()?.bank.isOpen&&(s.bankObservation?.()?.generation??0)>gen,{timeoutTicks:15}))throw new Error('fresh bank unavailable');}if(!s.bankObservation?.())throw new Error('bank unknown');};
 const deposit=async()=>{await open();for(const id of new Set(inv().map(i=>i.id))){const item=inv().find(i=>i.id===id);if(!item)continue;const before=n(s.bankObservation!()!.items,id),amount=held(id);if(!(await s.bot.depositItem(item,-1)).success||!await waitUntil(s,()=>held(id)===0&&n(s.bankObservation!()!.items,id)===before+amount,{timeoutTicks:10}))throw new Error(`deposit mismatch ${id}`);}};
 const withdraw=async(id:number,amount:number)=>{await open();await withdrawFireOwned(s,id,amount);},close=async()=>{await s.bot.closeBank();await waitUntil(s,()=>!st()?.bank.isOpen,{timeoutTicks:5});};
 const prayer=async(active:boolean)=>{if(active&&points()<=0)return;if(st()?.prayers?.activePrayers[14]!==active)await s.direct({type:'togglePrayer',prayerIndex:14,reason:'one Fire pilot protection'});if(!await waitUntil(s,()=>st()?.prayers?.activePrayers[14]===active,{timeoutTicks:8}))throw new Error('Prayer effect unknown');};
 const loc=(id:number,x:number,z:number)=>st()?.nearbyLocs.find(l=>l.id===id&&l.x===x&&l.z===z);
 const op=async(id:number,x:number,z:number,re=/./)=>{const l=loc(id,x,z),option=l?.optionsWithIndex.find(o=>re.test(o.text));if(!l||!option)throw new Error(`observed loc/op absent ${id}`);return s.sdk.sendInteractLoc(x,z,id,option.opIndex);};
 const step=async(label:string,act:()=>Promise<unknown>,arrived:()=>boolean,ticks=20)=>{for(let i=0;i<2;i++){await guard();if(arrived())return;await act();if(await waitUntil(s,()=>arrived()||over(),{timeoutTicks:ticks})&&arrived())return;await waitTicks(s,1);}throw new Error(`no Fire progress: ${label} effect absent`);};
 const near=(x:number,z:number,r=2)=>!!p()&&Math.max(Math.abs(p()!.worldX-x),Math.abs(p()!.worldZ-z))<=r;
 const useRope=async(id:number,x:number,z:number)=>{const rope=inv().find(i=>i.id===954);if(!rope)throw new Error('owned rope absent');return s.sdk.sendUseItemOnLoc(rope.slot,x,z,id);};
 const returnBank=async()=>{
  phase='return';returnStart??=s.tick();const q=p();if(q&&q.worldZ>9800&&q.worldZ<9950){
   const door=st()?.nearbyLocs.find(l=>[1516,1519].includes(l.id)&&l.z===9881);if(door){await walk(2564,9882,1,true);await op(door.id,door.x,door.z,/open/i);await waitTicks(s,1);}
   await walk(2564,9880,1,true);await walk(2584,9876,1,true);await walk(2575,9863,1,true);await op(2000,2575,9861);if(!await waitUntil(s,()=>near(2511,3463,3),{timeoutTicks:20}))throw new Error('falls exit not observed');
  }
  if(near(2511,3463,5)){await s.direct({type:'interactLoc',x:2512,z:3463,locId:2022,optionIndex:1,reason:'barrel return'} as any);if(!await waitUntil(s,()=>near(2527,3413,4),{timeoutTicks:25}))throw new Error('barrel return not observed');}
  if(p()&&p()!.worldZ<4000){await prayer(false);await walk(BANK.x,BANK.z,1,true);if(eating)await eating;phase='bank';await deposit();banked=true;}else throw new Error('not on safe surface return');
 };
 try{
  // Install life/health monitoring before any route. A reset can leave the
  // owned kit in the giant room; use the same guarded exit as a normal return.
  if(startRoute!=='bank'||o.recoverOnly){
   if(hp()<=30||held(FOOD)<9)throw Error('no Fire progress: recovered start needs HP>30 and9Salmon');
   capture('start-recovery');await returnBank();
   if(o.recoverOnly)return{ok:banked&&!died&&!ended&&!healFailure,recoveryOnly:true,banked,eaten,hpMin,finalHp:hp(),died,ticks:s.tick()-start,failure:healFailure||'-',trace};
   recoveryEaten=eaten;eaten=0;returnStart=undefined;banked=false;phase='prepare';
  }
  await open();baseline=totals();
  const foodFrom = process.env.FOOD_FROM?.trim() || '';
  if ((baseline.get(FOOD) ?? 0) < 16 && foodFrom) {
      console.log(`MILESTONE waiting for food trade from ${foodFrom}`);
      await close();
      const re = new RegExp(`^${foodFrom.replace(/[^a-zA-Z0-9 _-]/g, '')}$`, 'i');
      const r = await s.bot.serveTrades({ from: re, maxTrades: 1, timeout: 180_000 });
      console.log(`TRADE ${r.reason} ${r.message}`);
      await open();
      for (const item of inv().filter(i => [330, 334, 380, 329, 333, 379].includes(i.id))) {
          await s.bot.depositItem(item, -1);
      }
      baseline = totals();
  }
  if((baseline.get(295)??0)<1||(baseline.get(954)??0)<1||(baseline.get(FOOD)??0)<16)throw new Error('OWN amulet/rope/16Salmon required');weapon=selectFireWeapon(baseline,s.sdk.getSkill('Attack')?.baseLevel??null);if(!weapon||(baseline.get(1171)??0)<1)throw new Error('owned equippable sword/shield absent or Attack unknown');
  await deposit();await close();for(const item of [...eq()])await s.bot.unequipItem(item);await deposit();for(const [id,amount] of [[295,1],[954,1],[FOOD,16],[weapon,1],[1171,1]])await withdraw(id,amount);await close();
  for(const id of [weapon,1171]){const item=inv().find(i=>i.id===id);if(!item)throw new Error('equip item absent');await s.bot.equipItem(item);if(!await waitUntil(s,()=>eq().some(i=>i.id===id),{timeoutTicks:8}))throw new Error('equipment effect absent');}
  // Recover a drained return at the bank, then replenish the actual food debit.
  // The outward journey still starts with all sixteen owned Salmon.
  const fullHp=s.sdk.getSkill('Hitpoints')?.baseLevel??0;
  if(fullHp<60)throw new Error('no Fire progress: mature Hitpoints required');
  while(hp()<fullHp&&!over())await eat();
  if(over()||hp()!==fullHp)throw new Error('no Fire progress: bank healing incomplete');
  if(held(FOOD)<16){await withdraw(FOOD,16-held(FOOD));await close();}
  if(held(FOOD)!==16)throw new Error('no Fire progress: departure food unobserved');
  phase='travel';
  if(st()?.autoRetaliateEnabled===true)await s.direct({type:'clickComponent',componentId:151,reason:'Fire pilot OFF'});if(!await waitUntil(s,()=>st()?.autoRetaliateEnabled===false,{timeoutTicks:8}))throw new Error('auto-retaliate OFF absent');
  await s.sdk.sendSetCombatStyle(0);if(!await waitUntil(s,()=>st()?.combatStyle?.known===true&&st()?.combatStyle?.currentStyle===0,{timeoutTicks:8}))throw new Error('accurate style unknown');
  await walk(2617,3309,1);initialPrayer=points();await op(409,2617,3309,/pray/i);if(!await waitUntil(s,()=>points()>=43,{timeoutTicks:10}))throw new Error('altar full43 not observed');recharged=initialPrayer<43&&points()>=43;capture('altar');
  await walk(2522,3494,2);await s.bot.talkTo(/^Almera$/i);const dialogue=await waterfallDialogue(s,{proof:/you are kind|small raft out back|too careful these days|tourist centre|need to use the raft|Thanks Almera|Good for all/i,choices:[/How can I help/i],maxTicks:60,stop:over});if(!dialogue.ok)throw new Error('Almera legitimate entry dialogue unproved');
  await walk(2511,3494,1);await step('raft',()=>op(1987,2509,3493),()=>near(2512,3481,4),25);await waitTicks(s,5);
  if(s.sdk.getDialog()?.isOpen){const hudon=await waterfallDialogue(s,{proof:/fine alone|leave me alone|do I know you/i,maxTicks:60,stop:over});if(!hudon.ok)throw new Error('forced Hudon page not settled');}
  await walk(2512,3477,0);await step('rope rock',()=>useRope(1996,2512,3468),()=>near(2513,3468,0),25);await waitTicks(s,1);await step('rope tree',()=>useRope(2020,2512,3465),()=>near(2511,3463,2),20);await step('ledge door',()=>op(2010,2511,3464),()=>near(2575,9861,2),20);
  phase='dungeon';capture('dungeon-entry');await walk(2584,9876,1);await waitTicks(s,2);await walk(2564,9880,0);const shut=st()?.nearbyLocs.find(l=>[1516,1519].includes(l.id)&&l.z===9881);if(shut)await step('double door',()=>op(shut.id,shut.x,shut.z,/open/i),()=>!st()?.nearbyLocs.some(l=>[1516,1519].includes(l.id)&&l.z===9881),12);await walk(FIRE_ROOM_ENTRY.x,FIRE_ROOM_ENTRY.z,FIRE_ROOM_ENTRY.tol);
  await sealFireRoom(s,over);capture('door-sealed');
  // A blocked spider can retain single-combat ownership for eight server ticks.
  await waitTicks(s,9);await guard();
  for(let i=0;i<20&&hp()<60&&held(FOOD)>8&&!over();i++){await eat();await waitTicks(s,1);}
  if(hp()<60||held(FOOD)<9)throw new Error('refuse fight: HP<60 or food<9');entryPrayer=points();if(points()>0)await prayer(true);capture('fight-ready');
  const selfSlot=(s.client as {selfSlot?:number}|undefined)?.selfSlot??-1;
  const target=selectFireTarget(st()?.nearbyNpcs??[],selfSlot);if(!target)throw new Error('no fresh owned/idle Fire giant in room');targetIndex=target.index;capture('target-selected');
  if(st()!.nearbyPlayers.some(v=>Math.max(Math.abs(v.x-target.x),Math.abs(v.z-target.z))<=12))throw new Error('another player near target');
  // The client routes to the NPC's current 2x2 footprint before the attack.
  // A fixed "west of its old tile" walk can become occupied as it follows us.
  const fresh=st()?.nearbyNpcs.find(n=>n.index===targetIndex&&n.id===110),q=p();if(!fresh||!fireTargetInRoom(fresh)||!q||q.worldX<2560||q.worldX>2582||q.worldZ<9882||q.worldZ>9899){capture('target-dispatch-refused');throw new Error('no Fire progress: room attack dispatch unproved');}
  const ground=()=>{const m=new Map<string,number>();for(const i of st()?.groundItems??[])m.set(`${i.id}:${i.x}:${i.z}`,(m.get(`${i.id}:${i.x}:${i.z}`)??0)+i.count);return m;},old=ground(),fightStart=s.tick(),ownXp=xp(),option=fresh.optionsWithIndex.find(o=>/^attack$/i.test(o.text));if(!option||!(await s.sdk.sendInteractNpc(fresh.index,option.opIndex)).success)throw new Error('attack dispatch failed');phase='fight';
  let lastAttack=s.tick(),lastProgress=s.tick(),observedXp=ownXp,foodAtAttack=held(FOOD);
  while(!over()){
   fightTicks=s.tick()-fightStart;await guard();if(!fireFightSafe(hp(),held(FOOD),fightTicks))throw new Error('fight time/food/HP retreat');const current=st()?.nearbyNpcs.find(n=>n.id===110&&n.index===targetIndex);
   const here=p();if(!here||here.level!==0||here.worldX<2560||here.worldX>2582||here.worldZ<9882||here.worldZ>9899)throw Error('no Fire progress: attack approach left room');
   if(st()!.nearbyPlayers.some(v=>Math.max(Math.abs(v.x-(current?.x??fresh.x)),Math.abs(v.z-(current?.z??fresh.z)))<=12))throw new Error('public hero ambiguity');
   if(!death&&current){for(const i of st()?.groundItems??[]){if(i.x===(current.tileX??current.x)&&i.z===(current.tileZ??current.z))old.set(`${i.id}:${i.x}:${i.z}`,i.count);}}
   if(death){const d=death,counts=ground(),newBone=(counts.get(`${BONES}:${d.x}:${d.z}`)??0)-(old.get(`${BONES}:${d.x}:${d.z}`)??0);if(fireDeathCredit(xp()-ownXp,true,newBone)){
     const drops=(st()?.groundItems??[]).filter(i=>i.x===d.x&&i.z===d.z&&i.count>(old.get(`${i.id}:${i.x}:${i.z}`)??0));if(new Set(drops.map(i=>i.id)).size>2)throw new Error('unattributed corpse extras');
     await walk(d.x,d.z,0);for(const item of drops){const amount=item.count-(old.get(`${item.id}:${item.x}:${item.z}`)??0);let got=0;while(got<amount){const before=held(item.id);await s.sdk.sendPickup(d.x,d.z,item.id);if(!await waitUntil(s,()=>held(item.id)>before,{timeoutTicks:6}))throw new Error('actual corpse pickup not observed');const delta=held(item.id)-before;if(delta>amount-got)throw new Error('corpse attribution excess');got+=delta;loot[item.id]=(loot[item.id]??0)+delta;}}
     creditedKills=1;capture('credited-corpse');break;
   }}
   if(current&&!fireTargetInRoom(current)){capture('target-outside-room');throw new Error('target left bounded room');}
   if(xp()>observedXp){observedXp=xp();lastProgress=s.tick();}
   if(!death&&s.tick()-lastProgress>=60)throw new Error('no Fire progress: no own damage for60 ticks');
   // Eating clears the interaction. A successful packet can also have been
   // rejected by single-combat ownership, so stale facing alone is not proof.
   const me=p()?.combat,needsAttack=held(FOOD)!==foodAtAttack||me?.targetType!=='npc'||me.targetIndex!==targetIndex||s.tick()-lastProgress>=8;
   if(current&&!death&&needsAttack&&s.tick()-lastAttack>=8){
    const attack=current.optionsWithIndex.find(o=>/^attack$/i.test(o.text));
    if(!attack||!(await s.sdk.sendInteractNpc(current.index,attack.opIndex)).success)throw Error('no Fire progress: resumed attack dispatch failed');
    lastAttack=s.tick();foodAtAttack=held(FOOD);capture('attack-resumed');
   }
   await s.bot.dismissBlockingUI();await waitTicks(s,1);
  }
  if(creditedKills!==1)throw new Error('no complete hero corpse');
 }catch(e){failure=String(e);}
 finally{if(eating)await eating;if(!banked&&!ended&&!died&&!o.stop?.())try{await returnBank();}catch(e){failure=[failure,String(e)].filter(Boolean).join('; ');}off();}
 const final=totals(),preserved=!!baseline&&[...new Set([...baseline.keys(),...final.keys()])].every(id=>(final.get(id)??0)===(baseline!.get(id)??0)+(loot[id]??0)-(id===FOOD?eaten:0));
 const outputsBanked=banked&&Object.entries(loot).every(([id,amount])=>held(Number(id))===0&&n(s.bankObservation?.()?.items??[],Number(id))>=(baseline?.get(Number(id))??0)+amount);
 const ok=creditedKills===1&&!failure&&banked&&outputsBanked&&preserved&&!died&&!ended;
 return{ok,creditedKills,loot,banked,outputsBanked,preserved,eaten,recoveryEaten,hpMin,finalHp:hp(),weapon,entryPrayer,initialPrayer,recharged,finalPrayer:points(),fightTicks,attackXp:xp()-attack0,death,ticks:s.tick()-start,died,failure:failure||'-',trace,qualification:'ONE finite pilot, observed food tank and Prayer; no Spider immunity or perpetual farming claim'};
}
if(import.meta.main){let stopped=false;const s=await openBot(process.argv[2]!,{onStop:async()=>{stopped=true;},onSessionEnd:async(session,detail)=>finish([session],false,`no Fire progress: ${detail}; recover the owned dungeon kit before retry`)});try{const r=await runFireCombat(s,{cap:Number(process.env.CAP??1600),stop:()=>stopped});console.log('FIRE_COMBAT_BANK '+JSON.stringify(r));await finish([s],r.ok,`Fire-pilot ${JSON.stringify(r)}`);}catch(e){await finish([s],false,String(e));}}

