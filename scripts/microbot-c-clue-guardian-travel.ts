import {readFileSync} from 'node:fs';
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {walkPath,sessionWalker,expandPath} from '../packages/core/src/walk';
import {clientReach} from '../packages/core/src/reach';
import {componentId} from '../packages/core/src/logout';
import {combatTeleportAllowed} from './microbot-combat-trip';
import {eatBetweenCasts} from './magic-order';
import type {NativeTeleport} from './microbot-magic-teleport';
import {elementalRuneCost} from './microbot-magic-items';
import {CollisionFlag as NativeCollisionFlag} from '../vendor/rs-sdk/server/engine/src/engine/routefinder/flags';
import {ClientProt} from '../vendor/rs-sdk/server/webclient/src/io/ClientProt';
const mageAnim=Number(readFileSync('vendor/rs-sdk/server/content/pack/seq.pack','utf8').split(/\r?\n/).find(l=>l.endsWith('=human_casting'))?.split('=')[0]);
const saraRange=Number(readFileSync('vendor/rs-sdk/server/content/scripts/minigames/game_trail/configs/trail.npc','utf8').split('[trail_hard2]')[1]?.split('\n[')[0]?.match(/^attackrange=(\d+)/m)?.[1]);
export const guardianMagePose=(npc:{animId?:number}|undefined)=>Number.isInteger(mageAnim)&&npc?.animId===mageAnim;
type Policy={fatal:()=>boolean;stop:()=>boolean};
const hp=(s:Session)=>s.sdk.getSkill('Hitpoints')?.level??0;
export async function guardianHeal(s:Session,p:Policy){
 for(let n=0;n<4&&hp(s)<=70;n++){
  if(p.fatal()||p.stop())throw Error('guardian food stopped');
  if(!await eatBetweenCasts(s,{food:[379],eatAt:70,timeoutTicks:6,attempts:2}))break;
  // Native food extends action_delay by three ticks after its inventory debit.
  await waitUntil(s,()=>p.fatal()||p.stop(),{timeoutTicks:3});
  if(p.fatal()||p.stop())throw Error('guardian food settlement stopped');
 }
}
export async function clearGuardianMessage(s:Session,p:Policy){
 const dialog=()=>s.sdk.getState()?.dialog;
 if(!dialog()?.isOpen)return;
 if(p.fatal()||p.stop())throw Error('guardian message stopped');if(!dialog()?.isOpen)return;
 const d=dialog();if(d?.options.length!==1||!/^Click here to continue$/i.test(d.options[0]!.text))throw Error('guardian unexpected blocking dialogue');
 if(p.fatal()||p.stop())throw Error('guardian message stopped');
 // Native trail_casket_obtained ends after objbox without if_close. The
 // casket already exists; CLOSE_MODAL retires this informational pause.
 await s.sdk.sendCloseModal();
 await waitTicks(s,2);if(p.fatal()||p.stop())throw Error('guardian message stopped');
 // The client may retain the final page after PAUSEBUTTON resumes. The next
 // bounded walk must prove physical arrival; no Continue is retried.
}
export async function guardianWalk(s:Session,to:{x:number;z:number},p:Policy,maxTicks=40){
 if(p.fatal()||p.stop())throw Error('guardian movement stopped');await clearGuardianMessage(s,p);await guardianHeal(s,p);if(p.fatal()||p.stop()||hp(s)<35)throw Error('guardian movement life/HP floor');
 const result=await walkPath(await sessionWalker(s),[{...to,tol:0}],{maxTicks,stop:()=>p.fatal()||p.stop()||hp(s)<35});
 if(!result.ok||p.fatal()||hp(s)<35)throw Error('guardian movement '+(result.detail??'life/HP floor'));await guardianHeal(s,p);
}
export function guardianSeparationGoals(dig:{x:number;z:number},player:{worldX:number;worldZ:number;level:number},npc:{x:number;z:number},plan:(level:number,from:{x:number;z:number},to:{x:number;z:number})=>{x:number;z:number}[],reach?:(to:{x:number;z:number})=>boolean|null,sight?:(to:{x:number;z:number})=>boolean){
 const from={x:player.worldX,z:player.worldZ};
 const candidates:{x:number;z:number}[]=[];for(let dx=-8;dx<=8;dx++)for(let dz=-8;dz<=8;dz++)if(Math.max(Math.abs(dx),Math.abs(dz))>=4)candidates.push({x:dig.x+dx,z:dig.z+dz});
 return candidates.filter(to=>{
  // A retreat endpoint can lie outside casting range: the pursuing wizard moves during the walk.
  // Dispatch separately requires the received native head tiles to be exactly five tiles apart.
  const separation=Math.max(Math.abs(to.x-npc.x),Math.abs(to.z-npc.z));if(!Number.isSafeInteger(saraRange)||separation<saraRange||separation>16||reach?.(to)===false||sight?.(to)===false)return false;
  const corners=plan(player.level,from,to),end=corners.at(-1);
  return !!end&&end.x===to.x&&end.z===to.z&&expandPath(from,corners).every(t=>Math.max(Math.abs(t.x-npc.x),Math.abs(t.z-npc.z))<=16);
 }).sort((a,b)=>Math.max(Math.abs(b.x-npc.x),Math.abs(b.z-npc.z))-Math.max(Math.abs(a.x-npc.x),Math.abs(a.z-npc.z)));
}
type SaraSight=(from:{x:number;z:number;level:number},to:{x:number;z:number;size:number})=>boolean;
export function installGuardianSaraBridge(s:Session,index:number,npcId:number,p:Policy,sight:SaraSight){
 const c=s.client as any,first=s.sdk.getState()?.player,life=first?.lifeId,respawns=first?.respawnCount??0,health=hp(s),original=c?.executeBotAction;
 if(!Number.isSafeInteger(life)||!Number.isSafeInteger(c?.selfSlot)||c.selfSlot<0||c.selfSlot>2047||typeof original!=='function'||typeof c.writeOpcode!=='function'||typeof c.out?.p1!=='function'||typeof c.out?.p2!=='function')throw Error('guardian Sara native packet owner unavailable');
 let attackedAt:number|undefined,held=false;
 const observed=()=>{const st=s.sdk.getState(),me=st?.player,n=st?.nearbyNpcs.find(n=>n.id===npcId&&n.index===index),native=c.npc?.[index],local=c.localPlayer;
  if(p.fatal()||p.stop()||s.sdk.getStateAge()>5000||!c.isInGame()||!me||me.isDead||me.lifeId!==life||(me.respawnCount??0)!==respawns||hp(s)!==health||!s.sdk.isPrayerActive(12)||st!.nearbyPlayers.length||!n||n.targetIndex!==32768+c.selfSlot||n.hp!==null&&n.hp!==undefined&&n.hp<=0||!n.optionsWithIndex.some(o=>o.opIndex===2&&/^Attack$/i.test(o.text))||native?.type?.id!==npcId||!local||c.minusedlevel!==me.level)throw Error('guardian Sara fresh private target/life/prayer changed');
  const from={x:c.mapBuildBaseX+local.routeX[0],z:c.mapBuildBaseZ+local.routeZ[0],level:me.level},to={x:c.mapBuildBaseX+native.routeX[0],z:c.mapBuildBaseZ+native.routeZ[0],size:n.size??1};
  if(![from.x,from.z,to.x,to.z].every(v=>Number.isSafeInteger(v)&&v>=0&&v<=65535)||to.size!==1||!sight(from,to))throw Error('guardian Sara native head tiles/line of sight unavailable');return{from,to,distance:Math.max(Math.abs(from.x-to.x),Math.abs(from.z-to.z))};
 };
 const bridge=function(this:unknown,a:any){
  if(a?.type!=='guardianSaraAttack'&&a?.type!=='guardianSaraHold')return original.call(c,a);
  if(a.index!==index||a.npcId!==npcId)throw Error('guardian Sara packet target differs');const at=observed();
  if(a.type==='guardianSaraAttack'){
   if(attackedAt!==undefined||at.distance!==saraRange||saraRange!==5)throw Error('guardian Sara requires exactly five native tiles before one AP input');
   // Lite opNpc prepends MOVE_OPCLICK. Native can then run AP, move two tiles,
   // and run OP in the same cycle; OP changes the wizard back to melee mode.
   attackedAt=s.tick();c.writeOpcode(ClientProt.OPNPC2);c.out.p2(index);return{success:true};
  }
  if(attackedAt===undefined||held||s.tick()!==attackedAt+1||at.distance<2||at.distance>saraRange)throw Error('guardian Sara stationary cancel needs exactly one fresh native cycle');
  // Lite same-tile walk can emit no packet. This native normal click always
  // clears pending interaction. ctrl=0 does not disable persistent run mode.
  held=true;c.writeOpcode(ClientProt.MOVE_GAMECLICK);c.out.p1(5);c.out.p1(0);c.out.p2(at.from.x);c.out.p2(at.from.z);return{success:true};
 };
 c.executeBotAction=bridge;return Object.assign(()=>{if(c.executeBotAction===bridge)c.executeBotAction=original;},{owns:()=>c.executeBotAction===bridge});
}
export async function requestGuardianSaraAP(s:Session,index:number,npcId:number,p:Policy,sight:SaraSight){
 const before=s.tick(),health=hp(s),owner=32768+(s.client as any).selfSlot;
 const pack=()=>JSON.stringify(s.sdk.getInventory().map(i=>({id:i.id,count:i.count,slot:i.slot})).sort((a,b)=>a.slot-b.slot)),initialPack=pack(),skills=['Attack','Strength','Defence','Ranged','Magic','Hitpoints'],xp=skills.map(k=>s.sdk.getSkillXp(k));
 const restore=installGuardianSaraBridge(s,index,npcId,p,sight);
 const unchanged=()=>{const n=s.sdk.getState()?.nearbyNpcs.find(n=>n.id===npcId&&n.index===index);if(!restore.owns()||!n||n.targetIndex!==owner||s.sdk.getState()!.nearbyPlayers.length||hp(s)!==health||pack()!==initialPack||skills.some((k,i)=>s.sdk.getSkillXp(k)!==xp[i]))throw Error('guardian Sara AP input owner, target, HP, stock or player XP changed before mage pose');};
 try{
  const attack=await s.direct({type:'guardianSaraAttack',index,npcId,reason:'fresh owned Sara AP without client melee route'})as{success?:boolean};if(!attack?.success)throw Error('guardian Sara AP packet unconfirmed; no retry');
  // Session tick advances only on native PLAYER_INFO, not client animation frames.
  if(!await waitUntil(s,()=>{if(p.fatal()||p.stop())return true;unchanged();return s.tick()>before;},{timeoutTicks:1})||p.fatal()||p.stop())throw Error('guardian Sara AP native cycle unavailable');
  unchanged();const hold=await s.direct({type:'guardianSaraHold',index,npcId,reason:'received native head-tile normal click cancels player melee approach'})as{success?:boolean};if(!hold?.success)throw Error('guardian Sara stationary packet unconfirmed; no retry');const heldAt=s.tick();
  const pose=()=>s.tick()>heldAt&&s.sdk.getState()?.player?.combat.targetType==='none'&&guardianMagePose(s.sdk.getState()?.nearbyNpcs.find(n=>n.id===npcId&&n.index===index));
  return !!await waitUntil(s,()=>{if(p.fatal()||p.stop())return true;unchanged();return pose()&&s.sdk.isPrayerActive(12);},{timeoutTicks:12})&&pose()&&!p.fatal()&&!p.stop();
 }finally{restore();}
}
export async function setupSaradominMage(s:Session,index:number,npcId:number,dig:{x:number;z:number},p:Policy){
 const state=()=>s.sdk.getState(),target=()=>state()?.nearbyNpcs.find(n=>n.index===index&&n.id===npcId),start=s.tick(),used=new Set<string>();
 const reach=clientReach(s.client,()=>{const at=state()?.player;return at?{x:at.worldX,z:at.worldZ,level:at.level}:null;});
 for(let attempt=0;attempt<2;attempt++){
  const n=target(),player=state()?.player;if(!n||!player||p.stop()||p.fatal())throw Error('guardian Sara setup target/life');
  const walker=await sessionWalker(s),rsmod=await import('../vendor/rs-sdk/server/vendor/rsmod-pathfinder'),sight=(to:{x:number;z:number})=>rsmod.hasLineOfSight(player.level,to.x,to.z,n.tileX??n.x,n.tileZ??n.z,1,1,n.size??1,n.size??1,NativeCollisionFlag.BLOCK_NPC_AND_PLAYERS),goal=guardianSeparationGoals(dig,player,n,walker.plan,to=>reach?.({...to,level:player.level},{maxSteps:4096})??null,sight).find(to=>!used.has(`${to.x},${to.z}`));
  if(!goal)throw Error('guardian Sara reachable separation unavailable');used.add(`${goal.x},${goal.z}`);
  await guardianWalk(s,goal,p,18);
  const current=target(),at=state()?.player,c=s.client as any;if(!current||!at||!c.localPlayer)continue;
  const from={x:c.mapBuildBaseX+c.localPlayer.routeX[0],z:c.mapBuildBaseZ+c.localPlayer.routeZ[0]},native=c.npc?.[index];if(!native)continue;
  const separation=Math.max(Math.abs(from.x-c.mapBuildBaseX-native.routeX[0]),Math.abs(from.z-c.mapBuildBaseZ-native.routeZ[0]));if(separation!==saraRange)continue;
  const liveSight:SaraSight=(a,n)=>rsmod.hasLineOfSight(a.level,a.x,a.z,n.x,n.z,1,1,n.size,n.size,NativeCollisionFlag.BLOCK_NPC_AND_PLAYERS);
  if(await requestGuardianSaraAP(s,index,npcId,p,liveSight)){
   await guardianHeal(s,p);console.log('GUARDIAN_SARA_AP '+JSON.stringify({index,attempt:attempt+1,ticks:s.tick()-start,hp:hp(s),anim:target()?.animId}));return;
  }
 }
 throw Error('guardian Sara mage-only AP mode unobserved');
}
export function guardianExitCandidates(walkable:(to:{x:number;z:number})=>boolean){
 const points:{x:number;z:number}[]=[];
 for(let x=2944;x<=3391;x+=8)points.push({x,z:3679});
 for(let z=3680;z<=3999;z+=8)points.push({x:2943,z},{x:3392,z});
 return points.filter(walkable);
}
export function guardianExtractionStep(player:{worldX:number;worldZ:number;level:number},plan:(level:number,from:{x:number;z:number},to:{x:number;z:number})=>{x:number;z:number}[],exit?:{x:number;z:number},walkable:(to:{x:number;z:number})=>boolean=()=>true,reach?:(to:{x:number;z:number})=>boolean|null){
 const from={x:player.worldX,z:player.worldZ},distance=(to:{x:number;z:number})=>Math.max(Math.abs(to.x-from.x),Math.abs(to.z-from.z));
 const candidates=(exit?[exit]:guardianExitCandidates(walkable)).filter(to=>combatTeleportAllowed({...player,worldX:to.x,worldZ:to.z})&&reach?.(to)!==false).sort((a,b)=>distance(a)-distance(b));
 let best:{x:number;z:number}[]|undefined;
 for(const to of candidates){
  // No remaining route can be shorter than this tile-distance lower bound.
  if(best&&distance(to)>=best.length)break;
  const corners=plan(player.level,from,to),end=corners.at(-1);
  if(!end||end.x!==to.x||end.z!==to.z)continue;
  const route=expandPath(from,corners);if(route.length&&(!best||route.length<best.length))best=route;
 }
 return best?{target:best[Math.min(23,best.length-1)]!,exit:best.at(-1)!}:null;
}
export async function recoverGuardian(s:Session,tele:NativeTeleport,p:{fatal:()=>boolean},budget=500){
 const start=s.tick(),state=()=>s.sdk.getState(),over=()=>p.fatal()||s.tick()-start>=budget;
 let exit:{x:number;z:number}|undefined;let player=state()?.player;if(!player||over())return{ok:false,failure:'guardian recovery life/session'};
 while(!combatTeleportAllowed(player)){
  if(over())return{ok:false,failure:'guardian extraction budget'};
  const walker=await sessionWalker(s),pf=await import('../vendor/rs-sdk/sdk/pathfinding'),at=player;const reach=clientReach(s.client,()=>{const p=state()?.player;return p?{x:p.worldX,z:p.worldZ,level:p.level}:null;});const route=guardianExtractionStep(player,walker.plan,exit,to=>pf.isTileWalkable(at.level,to.x,to.z),to=>reach?.({...to,level:at.level},{maxSteps:4096})??null);if(!route)return{ok:false,failure:`guardian legal extraction path unavailable from ${player.worldX},${player.worldZ} to ${exit?.x},${exit?.z}`};exit=route.exit;
  await guardianWalk(s,route.target,{fatal:over,stop:()=>false},Math.min(40,budget-(s.tick()-start)));player=state()?.player;
  if(!player)return{ok:false,failure:'guardian extraction session'};
 }
 await guardianHeal(s,{fatal:over,stop:()=>false});if(over())return{ok:false,failure:'guardian recovery budget before teleport'};
 const before=new Map(s.sdk.getInventory().map(i=>[i.id,s.sdk.getInventory().filter(j=>j.id===i.id).reduce((n,j)=>n+j.count,0)])),xp=s.sdk.getSkillXp('Magic')??0;
 const costs=Object.fromEntries(Object.entries(tele.runes).map(([id,n])=>[id,elementalRuneCost(Number(id),n,s.sdk.getEquipment(),true)]));
 if(Object.entries(costs).some(([id,n])=>(before.get(Number(id))??0)<n))return{ok:false,failure:'guardian reserved escape runes missing'};
 await s.sdk.sendCloseModal();await s.direct({type:'clickComponent',componentId:componentId(tele.component),reason:'guardian legal bounded recovery'});
 const landed=()=>{const at=state()?.player;return !!at&&at.level===tele.to.level&&Math.max(Math.abs(at.worldX-tele.to.x),Math.abs(at.worldZ-tele.to.z))<=2;};
 await waitUntil(s,()=>landed()||over(),{timeoutTicks:Math.max(1,Math.min(20,budget-(s.tick()-start)))});
 const count=(id:number)=>s.sdk.getInventory().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0),paid=Object.entries(costs).every(([id,n])=>(before.get(Number(id))??0)-count(Number(id))===n);
 return{ok:landed()&&!p.fatal()&&paid&&(s.sdk.getSkillXp('Magic')??0)>xp,failure:landed()?'':'guardian legal Varrock landing unobserved',ticks:s.tick()-start};
}
