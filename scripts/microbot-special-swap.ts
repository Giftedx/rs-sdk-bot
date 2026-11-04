// Adapted behavior: pinned Microbot SpecialAttackConfigs; research/microbot-ports-LICENSE.txt.
import {readFileSync} from 'node:fs';
import {openBot,settle} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {componentId} from '../packages/core/src/logout';
import {waitUntil} from '../packages/core/src/ticks';
import {enableSpecial} from './microbot-c-qol';
import {guardianStopRequested} from './microbot-c-clue-guardian';
import {ClientProt} from '../vendor/rs-sdk/server/webclient/src/io/ClientProt';
import {equipmentObserved} from '../packages/core/src/container-observation';
import {guardianLoadedSight} from './microbot-c-clue-guardian-travel';
import {walkPath,sessionWalker} from '../packages/core/src/walk';

export function specialExit(value:string|undefined){
 if(!value||!/^\d+,\d+,[0-3]$/.test(value))throw Error('NPC special CLI requires SPECIAL_EXIT=x,z,plane');
 const[x,z,level]=value.split(',').map(Number);if(x!>16383||z!>16383)throw Error('special exit outside native world');return{x:x!,z:z!,level:level!};
}
export function specialAttackBudget(cap:number,npc:boolean){
 // Six8-tick restoration waits,2 suspension ticks,40 walk and18 quiet ticks.
 const reserve=npc?108:0;if(!Number.isSafeInteger(cap)||cap<=reserve)throw Error('special cap cannot fund attack, restoration and declared escape');return Math.min(100,cap-reserve);
}
export async function finishSpecialExit(s:Session,exit:ReturnType<typeof specialExit>,deadline:number,stop:()=>boolean,original:{client:Session['client'];executor:unknown;life:number;respawns:number;hp:number}){
 const client=original.client as any,executor=original.executor,hp=original.hp;
 const assets=()=>JSON.stringify([...s.sdk.getInventory(),...s.sdk.getEquipment()].map(i=>[i.id,i.count]).sort((a,b)=>a[0]!-b[0]!)),held=assets();let ended=false;void s.ended.then(()=>{ended=true;});
 const guard=()=>{const p=s.sdk.getState()?.player;return ended||s.client!==client||client.executeBotAction!==executor||guardianStopRequested(s.name,stop)||!p||p.isDead||p.lifeId!==original.life||(p.respawnCount??0)!==original.respawns||p.level!==exit.level||s.sdk.getSkill('Hitpoints')?.level!==hp||s.sdk.getStateAge()>5000||assets()!==held||s.tick()>=deadline;};
 if(guard()||deadline-s.tick()<=18)throw Error('special escape original actor/assets/budget changed');
 const walked=await walkPath(await sessionWalker(s),[{...exit,tol:0}],{maxTicks:Math.max(1,Math.min(40,deadline-s.tick()-18)),stop:guard});
 if(!walked.ok||guard())throw Error('declared special escape not reached');
 // Native combat_preventlogout lasts16 ticks. Require18 quiet received ticks,
 // including publication slack, after the final incoming hit or arrival.
 const arrival=s.tick();if(!await waitUntil(s,()=>{if(guard())throw Error('special escape settlement changed');const p=s.sdk.getState()?.player;return !!p&&p.worldX===exit.x&&p.worldZ===exit.z&&p.combat.targetType==='none'&&s.tick()-Math.max(arrival,p.combat.lastDamageTick)>=18;},{timeoutTicks:Math.max(1,deadline-s.tick())}))throw Error('special escape quiet logout window absent');
 return{exit,ticks: s.tick()-arrival,quiet:true};
}

export function nativeSwapWeapon(id:number){
 const item=(JSON.parse(readFileSync('knowledge/items.json','utf8'))as {id:number;debugname:string;src:string;name:string}[]).find(i=>i.id===id);
 if(!item||!Number.isSafeInteger(id))throw Error('native special weapon absent');
 const block=readFileSync('vendor/rs-sdk/server/content/'+item.src.replace(/:\d+$/,''),'utf8').split('['+item.debugname+']')[1]?.split('\n[')[0]??'';
 const param=(key:string)=>block.match(new RegExp('^param='+key+',([^\\r\\n]+)','m'))?.[1],category=block.match(/^category=([^\r\n]+)/m)?.[1];
 const styles=readFileSync('vendor/rs-sdk/server/content/scripts/skill_combat/scripts/player/player_attackstyles.rs2','utf8');
 const tab=[...styles.matchAll(/case ([\w, ]+) : ~weapon_category_tab_attack\((combat_\w+):preview/g)].find(m=>m[1]!.split(/,\s*/).includes(category??''))?.[2];
 const self=item.debugname==='dragon_battleaxe'||item.debugname==='excalibur';
 const handlers=readFileSync('vendor/rs-sdk/server/content/scripts/skill_combat/scripts/player/player_special_attack.rs2','utf8');
 const handler=[...handlers.matchAll(/case ([\w, ]+) : @(pvm_\w+)_sa;/g)].find(m=>m[1]!.split(/,\s*/).includes(item.debugname)),supported=self||!!handler;
 const script=handler?readFileSync('vendor/rs-sdk/server/content/scripts/skill_combat/scripts/player/specs/scripts/'+handler[2]+'.rs2','utf8'):'';
 const delays=[...script.matchAll(/\bp_delay\((\d+)\)/g)];if((script.match(/\bp_delay\(/g)?.length??0)!==delays.length)throw Error('native special suspension needs a literal bound');
 const suspensionTicks=delays.reduce((n,m)=>n+Number(m[1])+1,0);if(suspensionTicks>1)throw Error('native special suspension exceeds declared cancellation reserve');
 const energy=Number(param('sa_energy')??readFileSync('vendor/rs-sdk/server/content/scripts/skill_combat/configs/combat.param','utf8').split('[sa_energy]')[1]?.split('\n[')[0]?.match(/^default=(\d+)/m)?.[1]);
 if(param('specwep')!=='^true'||!supported||!tab||!Number.isSafeInteger(energy)||energy<1||energy>1000)throw Error('native weapon has no supported special handler');
 const ammo=category==='weapon_bow'?(readFileSync('vendor/rs-sdk/server/content/scripts/skill_combat/scripts/player/specs/scripts/pvm_'+item.debugname+'.rs2','utf8').match(/~ranged_dropammo_npc\(/g)?.length??0):item.debugname==='rune_thrownaxe'?1:0;
 return{id,name:item.name,debugname:item.debugname,energy,self,suspensionTicks,range:Number(param('attackrange')??0),ammo,ammoSlot:category==='weapon_bow'?13:3,twoHanded:/^wearpos2=lefthand\r?$/m.test(block),bar:tab+':specbar',tab:componentId(tab)};
}
export interface SpecialSwapOrder{weapon:number;minimumEnergy:number;cap:number;target?:{index:number;id:number};costs?:Record<number,number>;chainTargets?:{index:number;id:number}[];maximumHits?:number}
export async function runSpecialSwap(s:Session,o:SpecialSwapOrder,stop:()=>boolean=()=>false){
 const recipe=nativeSwapWeapon(o.weapon),st=()=>s.sdk.getState(),gear=()=>s.sdk.getEquipment(),pack=()=>s.sdk.getInventory(),c=s.client as any,start=s.tick();
 if(!Number.isSafeInteger(o.minimumEnergy)||o.minimumEnergy<recipe.energy||o.minimumEnergy>1000||!Number.isSafeInteger(o.cap)||o.cap<1||o.cap>100)throw Error('special threshold must fund one native effect; cap1..100');
 const costs=o.costs??{};if(Object.entries(costs).some(([id,n])=>!Number.isSafeInteger(Number(id))||Number(id)<0||!Number.isSafeInteger(n)||n<0||n>100))throw Error('invalid declared special item costs');
 const chain=recipe.debugname==='rune_thrownaxe',maximumHits=o.maximumHits??1;if(!Number.isSafeInteger(maximumHits)||maximumHits<1||maximumHits>5||!chain&&(maximumHits!==1||!!o.chainTargets?.length)||o.minimumEnergy<recipe.energy*maximumHits)throw Error('special hit budget must fund1..5 native hits');
 const first=st()?.player,hp=()=>s.sdk.getSkill('Hitpoints')?.level??0,initialHp=hp(),life=first?.lifeId,respawns=first?.respawnCount??0,plane=first?.level;
 const originalGear=gear().map(i=>({...i})),originalStyle=structuredClone(st()?.combatStyle),enabled=c.var?.[301],energy=c.var?.[300],executor=c.executeBotAction;
 const totals=()=>{const a:Record<number,number>={};for(const i of [...pack(),...gear()])a[i.id]=(a[i.id]??0)+i.count;return a;},initial=totals(),view=(rows:typeof originalGear)=>rows.map(i=>({id:i.id,slot:i.slot,count:i.count})).sort((a,b)=>a.slot-b.slot),same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
 let ended=false;void s.ended.then(()=>{ended=true;});
 const fatal=()=>{const me=st()?.player;return ended||!me||me.isDead||hp()<1||me.lifeId!==life||(me.respawnCount??0)!==respawns||me.level!==plane;};
 const stopped=()=>fatal()||!equipmentObserved(c)||c.executeBotAction!==executor||guardianStopRequested(s.name,stop)||s.tick()-start>=o.cap||hp()!==initialHp||!!st()?.nearbyPlayers.length||s.sdk.getStateAge()>5000;
 const aliveForCleanup=()=>!fatal();
 if(!first||initialHp<70||!equipmentObserved(c)||!originalStyle?.known||!Number.isSafeInteger(life)||!Number.isSafeInteger(energy)||energy<o.minimumEnergy||enabled!==0||st()?.autoRetaliateEnabled!==false)throw Error('stage HP70, observed gear/original weapon style, funded inactive special and retaliation off');
 if(!pack().some(i=>i.id===recipe.id&&i.count===1)||recipe.twoHanded&&gear().some(i=>i.slot===3)&&gear().some(i=>i.slot===5)&&pack().length===28)throw Error('stage one owned special weapon and room for displaced shield');
 if(!recipe.self&&!o.target)throw Error('attack special needs an explicit observed target');
 if(recipe.ammo){const ammoId=recipe.ammoSlot===13?gear().find(i=>i.slot===13)?.id:recipe.id,quantity=recipe.ammoSlot===13?gear().find(i=>i.slot===13)?.count:pack().filter(i=>i.id===recipe.id).reduce((n,i)=>n+i.count,0);if(ammoId===undefined||quantity===undefined||quantity<recipe.ammo||(costs[ammoId]??0)<recipe.ammo)throw Error('stage and declare the native special ammunition cost');}
 const target=()=>o.target&&st()?.nearbyNpcs.find(n=>n.index===o.target!.index&&n.id===o.target!.id&&(n.targetIndex===-1||n.targetIndex===32768+c.selfSlot)&&n.optionsWithIndex.some(a=>a.opIndex===2&&/^Attack$/i.test(a.text)));
 if(o.target&&!target())throw Error('special target unavailable or owned by another player');
 const combat=first.combat;if(combat.targetType!=='none'&&(!o.target||combat.targetType!=='npc'||combat.targetIndex!==o.target.index))throw Error('special cannot take over a different active target');
 const chainSight=chain?guardianLoadedSight(c):undefined;
 const chainAdmission=()=>{if(!chain)return;const n=target(),me=st()?.player,allowed=[o.target!,...o.chainTargets??[]],style=st()?.combatStyle,chosen=style?.styles.find(t=>t.index===style.currentStyle),range=Math.min(10,recipe.range+(chosen?.type==='Longrange'?2:0)),local=c.localPlayer,enemy=n&&c.npc?.[n.index];
  if(!n||!me||energy!==1000||allowed.length>5||new Set(allowed.map(t=>t.index)).size!==allowed.length||recipe.range!==4||!local||local.routeLength!==0||enemy?.type?.id!==n.id)throw Error('rune thrownaxe needs full energy and an immediate visible bounded target set');
  const from={x:c.mapBuildBaseX+local.routeX[0],z:c.mapBuildBaseZ+local.routeZ[0],level:me.level},to={x:c.mapBuildBaseX+enemy.routeX[0],z:c.mapBuildBaseZ+enemy.routeZ[0],size:enemy.type.size??1};
  if(![from.x,from.z,to.x,to.z].every(Number.isSafeInteger)||Math.max(Math.abs(from.x-to.x),Math.abs(from.z-to.z))>range||!chainSight!(from,to))throw Error('rune thrownaxe target requires approach or lacks native line of sight');
  const nearby=st()!.nearbyNpcs.filter(t=>Math.max(Math.abs((t.tileX??t.x)-to.x),Math.abs((t.tileZ??t.z)-to.z))<=4);if(nearby.some(t=>!allowed.some(a=>a.index===t.index&&a.id===t.id)||t.targetIndex!==-1&&t.targetIndex!==32768+c.selfSlot)||nearby.length>maximumHits)throw Error('rune thrownaxe could chain to an undeclared native target');};
 let consumed=false,restored=false,detail='',attempted=false,attacked=false,debitObservedAt:number|undefined;
 const conserved=()=>{const now=totals();return [...new Set([...Object.keys(initial),...Object.keys(now)].map(Number))].every(id=>{const used=(initial[id]??0)-(now[id]??0);return used>=0&&used<=(costs[id]??0);});};
 const gearRestored=()=>{const now=totals(),expected=originalGear.map(i=>({...i}));for(const i of expected){const spent=(initial[i.id]??0)-(now[i.id]??0);if(i.slot===13&&spent>0&&spent<=(costs[i.id]??0))i.count=Math.max(0,i.count-spent);if(chain&&i.slot===3&&i.id===recipe.id&&spent>0&&spent<=(costs[i.id]??0)){const actual=gear().find(g=>g.slot===3);if(actual?.id===i.id&&actual.count>=Math.max(0,i.count-spent)&&actual.count<=i.count)i.count=actual.count;else i.count=Math.max(0,i.count-spent);}}return same(view(gear()),view(expected.filter(i=>i.count>0)));};
 const equip=async(id:number,cleanup=false)=>{if(c.executeBotAction!==executor||(cleanup?!aliveForCleanup():stopped()))throw Error('special equip stopped');if(gear().some(i=>i.id===id))return;const row=pack().find(i=>i.id===id);if(!row)throw Error('owned restoration item absent');const before=totals();let reply='';try{reply=(await s.bot.equipItem(row)).message;}catch(error){reply=String(error);}await waitUntil(s,()=>fatal()||gear().some(i=>i.id===id),{timeoutTicks:8});if(fatal()||!gear().some(i=>i.id===id)||!same(before,totals()))throw Error('special paired equipment effect unconfirmed: '+reply);};
 const cancelTarget=async()=>{
  if(fatal()||c.executeBotAction!==executor)throw Error('special cancellation original owner changed');const previous=c.executeBotAction,at=s.tick();let sent=false;
  const cancel=function(this:unknown,a:any){if(a?.type!=='specialSwapCancel')return previous.call(c,a);const local=c.localPlayer,x=c.mapBuildBaseX+local?.routeX[0],z=c.mapBuildBaseZ+local?.routeZ[0];if(sent||fatal()||c.executeBotAction!==cancel||![x,z].every(v=>Number.isSafeInteger(v)&&v>=0&&v<=65535)||s.sdk.getStateAge()>5000)throw Error('special own-action cancellation life/head unavailable');sent=true;c.writeOpcode(ClientProt.MOVE_GAMECLICK);c.out.p1(5);c.out.p1(0);c.out.p2(x);c.out.p2(z);return{success:true};};
  c.executeBotAction=cancel;try{await s.direct({type:'specialSwapCancel',reason:'cancel our explicit finite special target'});}finally{if(c.executeBotAction===cancel)c.executeBotAction=previous;}
  if(!await waitUntil(s,()=>fatal()||s.tick()>at&&st()?.player?.combat.targetType==='none',{timeoutTicks:8})||fatal()||st()?.player?.combat.targetType!=='none'||c.executeBotAction!==executor)throw Error('special attack cancellation unconfirmed');
 };
 try{
  if(stopped())throw Error('special stopped before swap');if(combat.targetType==='npc')await cancelTarget();await equip(recipe.id);
  if(!await waitUntil(s,()=>stopped()||!!st()?.combatStyle?.known&&st()?.combatStyle?.tabInterfaceId===recipe.tab,{timeoutTicks:8})||stopped()||st()?.combatStyle?.tabInterfaceId!==recipe.tab)throw Error('native special weapon tab unobserved');
  if(!conserved()||c.var[300]!==energy)throw Error('special stock or energy changed before activation');chainAdmission();
  attempted=true;const armed=await enableSpecial(s,recipe.bar,o.minimumEnergy,Math.min(8,o.cap),stopped);
  if(!armed.ok)throw Error(armed.detail);
  if(!recipe.self){const n=target();if(!n||stopped())throw Error('special target changed before attack');chainAdmission();attacked=true;
   if(chain){
    const before=totals();let sent=false;const attack=function(this:unknown,a:any){if(a?.type!=='specialSwapChainAttack')return executor.call(c,a);if(sent||fatal()||c.executeBotAction!==attack||guardianStopRequested(s.name,stop)||s.sdk.getStateAge()>5000||hp()!==initialHp||st()!.nearbyPlayers.length||!same(before,totals()))throw Error('special chain dispatch admission changed');chainAdmission();sent=true;const local=c.localPlayer,x=c.mapBuildBaseX+local.routeX[0],z=c.mapBuildBaseZ+local.routeZ[0];c.writeOpcode(ClientProt.MOVE_GAMECLICK);c.out.p1(5);c.out.p1(0);c.out.p2(x);c.out.p2(z);c.writeOpcode(ClientProt.OPNPC2);c.out.p2(n.index);return{success:true};};
    c.executeBotAction=attack;try{await s.direct({type:'specialSwapChainAttack',reason:'immediate in-range owned Rune thrownaxe without queued client approach'});}finally{if(c.executeBotAction===attack)c.executeBotAction=executor;}
   }else await s.sdk.sendInteractNpc(n.index,2);
  }
  await waitUntil(s,()=>stopped()||c.var[300]!==energy,{timeoutTicks:Math.max(1,o.cap-(s.tick()-start))});
  const spent=energy-c.var[300];consumed=Number.isSafeInteger(spent)&&spent>=recipe.energy&&spent<=recipe.energy*maximumHits&&spent%recipe.energy===0&&c.var[301]===0;if(consumed)debitObservedAt=s.tick();if(!consumed||stopped()||!conserved())throw Error('native exact special debit, life or declared item cost unconfirmed');
 }catch(error){detail=String(error);}
 finally{
  if(aliveForCleanup())try{
   const ownCleanup=()=>{if(fatal()||!equipmentObserved(c)||c.executeBotAction!==executor)throw Error('special cleanup original input owner or observed gear changed');};ownCleanup();
   // Retire our selected combat action before swapping back, including unknown outcomes.
   // MOVE packets are rejected while native p_delay is active. The dagger's
   // p_delay(0) lasts one server cycle; add one publication cycle before the
   // single cancellation. This ends before its next four-tick normal attack.
   if(attacked&&debitObservedAt!==undefined&&recipe.suspensionTicks){const ready=debitObservedAt+recipe.suspensionTicks+1;if(!await waitUntil(s,()=>{ownCleanup();return s.tick()>=ready;},{timeoutTicks:recipe.suspensionTicks+1}))throw Error('native special suspension did not settle');ownCleanup();}
   if(attacked)await cancelTarget();
   ownCleanup();if(c.var[301]===1){await s.sdk.sendClickComponent(componentId(recipe.bar));await waitUntil(s,()=>fatal()||c.executeBotAction!==executor||c.var[301]===0,{timeoutTicks:8});ownCleanup();if(c.var[301]!==0)throw Error('special toggle cleanup unconfirmed');}
   const weapon=originalGear.find(i=>i.slot===3);if(weapon)await equip(weapon.id,true);else{const worn=gear().find(i=>i.slot===3);if(worn){if(c.executeBotAction!==executor)throw Error('special cleanup input owner changed');const before=totals();try{await s.bot.unequipItem(worn);}catch{}await waitUntil(s,()=>fatal()||!gear().some(i=>i.slot===3),{timeoutTicks:8});if(fatal()||gear().some(i=>i.slot===3)||!same(before,totals()))throw Error('special original unarmed return unconfirmed');}}const shield=originalGear.find(i=>i.slot===5);if(shield)await equip(shield.id,true);
   if(!await waitUntil(s,()=>fatal()||!!st()?.combatStyle?.known&&st()?.combatStyle?.weaponName===originalStyle.weaponName,{timeoutTicks:8})||fatal())throw Error('original combat tab unconfirmed');
   ownCleanup();if(st()?.combatStyle?.currentStyle!==originalStyle.currentStyle){await s.sdk.sendSetCombatStyle(originalStyle.currentStyle);await waitUntil(s,()=>fatal()||c.executeBotAction!==executor||st()?.combatStyle?.currentStyle===originalStyle.currentStyle,{timeoutTicks:8});ownCleanup();}
   restored=gearRestored()&&same(st()?.combatStyle,originalStyle)&&conserved()&&c.var[301]===0;if(!restored)throw Error('special original gear, style or assets not restored');
  }catch(error){detail ||=String(error);}
 }
 if(hp()!==initialHp)detail||='special incoming HP changed during settlement';
 return{ok:!detail&&consumed&&restored,weapon:recipe.id,attempted,consumed,energyBefore:energy,energyAfter:c.var?.[300],nativeCost:recipe.energy,maximumHits,chainTargets:o.chainTargets??[],restored,preserved:conserved(),itemCosts:Object.fromEntries(Object.entries(initial).map(([id,n])=>[id,n-(totals()[Number(id)]??0)]).filter(([,n])=>Number(n)>0)),hpBefore:initialHp,hpAfter:hp(),ticks:s.tick()-start,detail};
}
if(import.meta.main){
 const name=process.argv[2]??'',weapon=Number(process.argv[3]),minimumEnergy=Number(process.argv[4]??1000),cap=Number(process.argv[5]??(process.env.SPECIAL_TARGET===undefined?60:180));if(!name)throw Error('Usage: bun scripts/microbot-special-swap.ts <account> <owned-weapon-id> [minimum-energy] [cap]');
 let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});const s=await openBot(name);let ok=false;
 try{
  const wanted=process.env.SPECIAL_TARGET===undefined?undefined:Number(process.env.SPECIAL_TARGET),types=process.env.SPECIAL_CHAIN_TYPES?.split(',').map(Number)??[];
  const exit=wanted===undefined?undefined:specialExit(process.env.SPECIAL_EXIT),deadline=s.tick()+cap,attackCap=specialAttackBudget(cap,wanted!==undefined);
  if(types.some(id=>!Number.isSafeInteger(id)||id<0)||new Set(types).size!==types.length)throw Error('SPECIAL_CHAIN_TYPES needs distinct native NPC IDs');
  const matches=wanted===undefined?[]:s.sdk.getState()?.nearbyNpcs.filter(n=>n.id===wanted).sort((a,b)=>a.index-b.index)??[];
  if(wanted!==undefined&&(!matches.length||matches.length!==1&&!types.includes(wanted)))throw Error('stage exactly one explicit target or declare its chain type');
  const costs:Record<number,number>={};if(process.env.SPECIAL_COSTS)for(const entry of process.env.SPECIAL_COSTS.split(',')){if(!/^\d+:\d+$/.test(entry))throw Error('SPECIAL_COSTS must declare item-id:maximum-count pairs');const[id,n]=entry.split(':').map(Number);costs[id!]=n!;}
  const target=matches[0],chainTargets=target?s.sdk.getState()!.nearbyNpcs.filter(n=>n.index!==target.index&&types.includes(n.id)&&Math.max(Math.abs(n.x-target.x),Math.abs(n.z-target.z))<=4).map(n=>({id:n.id,index:n.index})):[];
  const player=s.sdk.getState()?.player;if(!player)throw Error('special original player observation absent');
  const original={client:s.client,executor:(s.client as any).executeBotAction,life:player.lifeId,respawns:player.respawnCount??0,hp:s.sdk.getSkill('Hitpoints')!.level};
  const r=await runSpecialSwap(s,{weapon,minimumEnergy,cap:attackCap,costs,chainTargets,maximumHits:Number(process.env.SPECIAL_MAX_HITS??1),...target?{target:{id:target.id,index:target.index}}:{}},()=>stopped);
  const escaped=exit&&r.attempted&&r.restored&&r.preserved?await finishSpecialExit(s,exit,deadline,()=>stopped,original):undefined;
  console.log('SPECIAL_SWAP_RESULT '+JSON.stringify({...r,escaped}));ok=r.ok;
 }finally{ok=await settle([s],ok,'finite owned special weapon swap and restoration');}process.exitCode=ok?0:1;
}
