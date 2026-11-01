// Finite bank-owned combat trips. Native doors and ladders remain observed actions.
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {walkPath,sessionWalker} from '../packages/core/src/walk';
import {depositObserved} from '../packages/core/src/deposit';
import {withdrawFireOwned} from './gather-fire-giants';
import {componentId} from '../packages/core/src/logout';
import {eatBetweenCasts} from './magic-order';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

export type CombatKit={id:number;count:number;slot?:number;native?:string};
const content=resolve(import.meta.dir,'../vendor/rs-sdk/server/content');
const nativeItems=new Map(readFileSync(resolve(content,'pack/obj.pack'),'utf8').split(/\r?\n/).filter(l=>/^\d+=/.test(l)).map(l=>{const at=l.indexOf('=');return[l.slice(at+1),Number(l.slice(0,at))];}));
const item=(native:string,count=1,slot?:number):CombatKit=>{const id=nativeItems.get(native);if(id===undefined)throw Error('native combat item missing '+native);return{id,count,native,...slot===undefined?{}:{slot}};};
const escapeRunes=()=>[item('lawrune'),item('airrune',3),item('firerune')];
export const BLUE_KIT:CombatKit[]=[item('crossbow',1,3),item('antidragonbreathshield',1,5),item('bolt',500,13),item('dusty_key'),...escapeRunes(),item('shark',6)];
export const KBD_KIT:CombatKit[]=[item('rune_sword',1,3),item('antidragonbreathshield',1,5),item('rune_chainbody',1,4),item('rune_platelegs',1,7),item('4dose2antipoison'),item('4dose1antidragon'),item('4dose2attack'),item('4dose2strength'),item('4doseprayerrestore',2),...escapeRunes(),item('shark',12)];
// Wield constraints come from the exact native handlers. These kits use no quest-gated equipment.
export function validateCombatKit(kit:readonly CombatKit[]){
 const ids=new Set(nativeItems.values()),requirements:{skill:string;level:number}[]=[];
 const tiers=['tier1.rs2','tier40.rs2'].map(f=>readFileSync(resolve(content,'scripts/levelrequire/scripts',f),'utf8')).join('\n');
 for(const i of kit){if(!ids.has(i.id)||i.native&&nativeItems.get(i.native)!==i.id||!Number.isSafeInteger(i.count)||i.count<1)throw Error('invalid native combat kit item '+i.id);
  if(i.slot===undefined||i.native==='bolt'||i.native==='antidragonbreathshield')continue;
  if(!i.native)throw Error('native equipped item name required '+i.id);
  const handler=tiers.match(new RegExp('\\[opheld2,'+i.native+'\\]\\s*@levelrequire_(attack|defence|ranged)\\((\\d+),'));
  if(!handler)throw Error('native kit wield handler unsupported '+i.native);
  requirements.push({skill:handler[1]![0]!.toUpperCase()+handler[1]!.slice(1),level:Number(handler[2])});
 }
 return requirements;
}
export function combatKitTotals(kit:readonly CombatKit[]){const out:Record<number,number>={};for(const i of kit)out[i.id]=(out[i.id]??0)+i.count;return out;}
export function combatAssetIssues(before:Record<number,number>,after:Record<number,number>,delta:Record<number,number>){
 return [...new Set([...Object.keys(before),...Object.keys(after),...Object.keys(delta)].map(Number))].filter(id=>(after[id]??0)-(before[id]??0)!==(delta[id]??0)).map(id=>({id,actual:(after[id]??0)-(before[id]??0),expected:delta[id]??0}));
}
type CombatPosition={worldX:number;worldZ:number;level:number};
export const inKbdEntrancePit=(p:CombatPosition|undefined)=>!!p&&p.level===0&&p.worldX>=3008&&p.worldX<3072&&p.worldZ>=10240&&p.worldZ<10304;
export const inNativeKbdLair=(p:CombatPosition|undefined)=>!!p&&p.level===0&&p.worldX>=2688&&p.worldX<2752&&p.worldZ>=9792&&p.worldZ<9856;
export function combatTeleportAllowed(p:CombatPosition){
 if(p.worldX<2944||p.worldX>3391)return true;
 const bottom=p.worldZ>=9920&&p.worldZ<=12799&&p.level===0?9920:p.worldZ>=3520&&p.worldZ<=6399&&p.level<=3?3520:undefined;
 return bottom===undefined||Math.floor((p.worldZ-bottom)/8)+1<=20;
}
export async function leaveKbdEntrancePit(d:{position:()=>CombatPosition|undefined;locs:()=>readonly{id:number;x:number;z:number;optionsWithIndex:readonly{text:string;opIndex:number}[]}[];interact:(x:number,z:number,id:number,op:number)=>Promise<boolean>;wait:(test:()=>boolean,ticks:number)=>Promise<boolean>}){
 if(!inKbdEntrancePit(d.position()))return;
 for(const id of [1816,1766]){
  const loc=d.locs().find(l=>l.id===id),op=loc?.optionsWithIndex.find(v=>id===1816?/^pull$/i.test(v.text):/^climb.up$/i.test(v.text));if(!loc||!op)continue;
  const arrived=()=>id===1816?inNativeKbdLair(d.position()):!!d.position()&&d.position()!.level===0&&Math.max(Math.abs(d.position()!.worldX-3017),Math.abs(d.position()!.worldZ-3849))<=3;
  if(await d.interact(loc.x,loc.z,id,op.opIndex)&&await d.wait(arrived,20)&&arrived())return;
  if(!inKbdEntrancePit(d.position()))throw Error('KBD pit cleanup reached unknown destination');
 }
 throw Error('KBD pit cleanup needs observed lever or climb-out ladder');
}
export async function combatTrip(s:Session,kind:'blue'|'kbd',fight:(stopped:()=>boolean)=>Promise<{ok:boolean;failure:string}>,o:{cap:number;stop:()=>boolean}){
 if(!Number.isSafeInteger(o.cap)||o.cap<1||o.cap>10000)throw Error('invalid combat trip cap');
 const start=s.tick(),state=()=>s.sdk.getState(),p0=state()?.player;
 if(!p0||p0.level!==0||p0.worldZ>4000)throw Error('combat trip needs a surface bank');
 const initialRetaliate=state()?.autoRetaliateEnabled;if(typeof initialRetaliate!=='boolean')throw Error('combat trip auto-retaliate state unknown');
 let ended=false;void s.ended.then(()=>{ended=true;});
 const alive=()=>{const p=state()?.player;return !ended&&!!p&&!p.isDead&&p.lifeId===p0.lifeId&&(s.sdk.getSkill('Hitpoints')?.level??0)>0;};
 const over=()=>!alive()||o.stop()||s.tick()-start>=o.cap;
 const held=(id:number)=>s.sdk.getInventory().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const near=(x:number,z:number,r=3)=>{const p=state()?.player;return !!p&&p.level===0&&Math.max(Math.abs(p.worldX-x),Math.abs(p.worldZ-z))<=r;};
 const trace:unknown[]=[],mark=(phase:string)=>{const p=state()?.player;const event={phase,tick:s.tick()-start,position:p&&[p.worldX,p.worldZ,p.level],hp:s.sdk.getSkill('Hitpoints')?.level};trace.push(event);console.log('COMBAT_TRIP '+JSON.stringify(event));};
 let routeFoods=0;
 const walk=async(x:number,z:number,cleanup=false,until?:()=>boolean)=>{if((s.sdk.getSkill('Hitpoints')?.level??0)<=70){const n=held(385);await eatBetweenCasts(s,{food:[385],eatAt:70,timeoutTicks:5,attempts:2});routeFoods+=n-held(385);}
  mark('walk '+x+','+z);const r=await walkPath(await sessionWalker(s),[{x,z,tol:1}],{maxTicks:500,stop:()=>!alive()||(s.sdk.getSkill('Hitpoints')?.level??0)<35||!cleanup&&over()||!!until?.()});if(!r.ok&&!until?.())throw Error('combat route '+r.detail);};
 const open=async()=>{if(state()?.bank.isOpen&&s.bankObservation?.())return;await s.bot.dismissBlockingUI();if(state()?.bank.isOpen&&!s.bankObservation?.()){await s.sdk.sendCloseModal();if(!await waitUntil(s,()=>!state()?.bank.isOpen,{timeoutTicks:8}))throw Error('combat stale bank close unobserved');}const generation=s.bankObservation?.()?.generation??-1;if(!state()?.bank.isOpen){const booth=state()?.nearbyLocs.filter(l=>l.distance<=3&&/bank|booth|chest/i.test(l.name)&&l.optionsWithIndex.some(v=>/^bank$|use.quickly/i.test(v.text))).sort((a,b)=>a.distance-b.distance)[0];const option=booth?.optionsWithIndex.find(v=>/^bank$|use.quickly/i.test(v.text));if(!booth||!option)throw Error('combat stand beside usable bank booth');mark('bank-open');await s.sdk.sendInteractLoc(booth.x,booth.z,booth.id,option.opIndex);if(!await waitUntil(s,()=>!!state()?.bank.isOpen&&(s.bankObservation?.()?.generation??-1)>generation,{timeoutTicks:15}))throw Error('combat fresh bank unavailable');}if(!s.bankObservation?.())throw Error('combat bank unknown');};
 const deposit=async()=>{await open();for(const id of new Set(s.sdk.getInventory().map(i=>i.id))){const item=s.sdk.getInventory().find(i=>i.id===id);if(item)await depositObserved(s,item);}};
 const close=async()=>{await s.bot.closeBank();if(!await waitUntil(s,()=>!state()?.bank.isOpen,{timeoutTicks:8}))throw Error('combat bank close unknown');};
 const interact=async(id:number,x:number,z:number,arrived:()=>boolean,key?:number)=>{const loc=state()?.nearbyLocs.find(l=>l.id===id&&l.x===x&&l.z===z),op=loc?.optionsWithIndex[0];if(over()||!loc||!op)throw Error('combat entry loc missing '+id);const item=key===undefined?undefined:s.sdk.getInventory().find(i=>i.id===key);if(key!==undefined&&!item)throw Error('combat entry key missing');const reply=item?await s.sdk.sendUseItemOnLoc(item.slot,x,z,id):await s.sdk.sendInteractLoc(x,z,id,op.opIndex);if(!reply.success||!await waitUntil(s,()=>arrived()||over(),{timeoutTicks:20})||!arrived())throw Error('combat entry effect missing '+id);mark('entered '+id);};
 const setRetaliate=async(value:boolean)=>{if(state()?.autoRetaliateEnabled===value)return;await s.direct({type:'clickComponent',componentId:value?150:151,reason:'finite combat trip ownership'});if(!await waitUntil(s,()=>state()?.autoRetaliateEnabled===value,{timeoutTicks:8}))throw Error('combat trip auto-retaliate unobserved');};
 const canonical=(id:number)=>{const d=(s.client as {objType?:(id:number)=>{certtemplate:number;certlink:number}}).objType?.(id);return d&&d.certtemplate!==-1&&d.certlink>=0?d.certlink:id;};
 const totals=()=>{const out:Record<number,number>={};for(const i of [...s.sdk.getInventory(),...s.sdk.getEquipment(),...(s.bankObservation?.()?.items??[])])out[canonical(i.id)]=(out[canonical(i.id)]??0)+i.count;return out;};
 let initial:Record<number,number>|undefined,final:Record<number,number>|undefined,failure='',banked=false,escaped=false,result:Awaited<ReturnType<typeof fight>>|undefined;
 try{
  if(over())throw Error('combat trip stopped at bank');await open();initial=totals();
  const kit=kind==='blue'?BLUE_KIT:KBD_KIT,needs=combatKitTotals(kit),requirements=validateCombatKit(kit);
  for(const r of requirements)if((s.sdk.getSkill(r.skill)?.level??0)<r.level)throw Error('combat native wield requirement '+r.skill+r.level);
  for(const [id,n] of Object.entries(needs))if((initial[Number(id)]??0)<n)throw Error('combat OWN stock missing '+id+':'+n);
  if((s.sdk.getSkill('Hitpoints')?.level??0)<70)throw Error('combat needs HP70 staging');
  if((s.sdk.getSkill('Magic')?.level??0)<25)throw Error('combat needs Magic25 escape');
  if(kind==='kbd'&&((state()?.prayers.prayerLevel??0)<43||(state()?.prayers.prayerPoints??0)<30))throw Error('combat needs Prayer43 and 30 points');
  if(kind==='blue'&&(s.sdk.getSkill('Ranged')?.level??0)<40)throw Error('combat needs Ranged40');
  await deposit();await close();await setRetaliate(false);
  for(const i of [...s.sdk.getEquipment()]){await s.bot.unequipItem(i);if(!await waitUntil(s,()=>!s.sdk.getEquipment().some(e=>e.slot===i.slot),{timeoutTicks:8}))throw Error('combat unequip unknown');}
  await deposit();for(const [id,n] of Object.entries(needs)){if(over())throw Error('combat staging stopped');await withdrawFireOwned(s,Number(id),n);}await close();
  for(const item of kit.filter(i=>i.slot!==undefined)){const inv=s.sdk.getInventory().find(i=>i.id===item.id);if(!inv)throw Error('combat kit disappeared');await s.bot.equipItem(inv);if(!await waitUntil(s,()=>s.sdk.getEquipment().some(i=>i.slot===item.slot&&i.id===item.id&&i.count>=item.count),{timeoutTicks:8}))throw Error('combat equip unknown '+item.id);}
  mark('staged');
  if(kind==='blue'){
   await walk(2884,3397);await interact(1759,2884,3397,()=>near(2884,9797));
   await walk(2886,9817);await walk(2889,9831);await walk(2910,9830);await walk(2924,9803);
   const gateX=state()!.player!.worldX;await interact(2623,2924,9803,()=>{const p=state()?.player;return !!p&&p.worldX!==gateX&&[2923,2924].includes(p.worldX)&&p.worldZ===9803;},1590);
   await waitTicks(s,3);await walk(2904,9803);await walk(2895,9792);
  }else{
   for(const [x,z] of [[3094,3535],[3080,3580],[3055,3625],[3025,3670],[3000,3715],[3000,3760],[3000,3805],[3017,3849]])await walk(x!,z!);if(!state()!.prayers.activePrayers[14]){if(!(await s.sdk.sendTogglePrayer(14)).success||!await waitUntil(s,()=>!!state()?.prayers.activePrayers[14],{timeoutTicks:5}))throw Error('KBD route melee protection unobserved');}await interact(1765,3017,3849,()=>near(3069,10255));
   await walk(3067,10253);await interact(1816,3067,10253,()=>near(2717,9802));
   const seen=()=>!!state()?.nearbyNpcs.some(n=>n.id===50);
   // Native king_dragon wanders30 tiles. Search observed scene bounds, never attack an unseen target.
   for(const [x,z] of [[2717,9812],[2717,9826],[2705,9836],[2735,9836],[2735,9807],[2701,9807]]){
    if(seen())break;if(over())throw Error('KBD search stopped');
    const at=state()?.player;if(!at)throw Error('KBD search player missing');const path=(await sessionWalker(s)).plan(at.level,{x:at.worldX,z:at.worldZ},{x:x!,z:z!}),end=path.at(-1);
    if(!end||Math.max(Math.abs(end.x-x!),Math.abs(end.z-z!))>1){if(at&&Math.max(Math.abs(at.worldX-x!),Math.abs(at.worldZ-z!))<=1)await waitTicks(s,2);continue;}
    await walk(x!,z!,false,seen);
   }
   if(!seen()&&!await waitUntil(s,()=>seen()||over(),{timeoutTicks:15})||!seen())throw Error('KBD native target not visible after bounded search');
  }
  if(over())throw Error('combat trip stopped after entry');mark('combat');result=await fight(over);if(!result.ok)failure=result.failure||'combat incomplete';
 }catch(e){failure=String(e);}
 finally{
  if(alive())try{
   // Keep reserved runes until a surface return is observed, including on stop/cap.
   if(kind==='kbd'&&inKbdEntrancePit(state()?.player??undefined))await leaveKbdEntrancePit({position:()=>state()?.player??undefined,locs:()=>state()?.nearbyLocs??[],interact:async(x,z,id,op)=>{if(!alive())throw Error('combat cleanup life changed');await s.sdk.sendCloseModal();return(await s.sdk.sendInteractLoc(x,z,id,op)).success;},wait:(test,ticks)=>waitUntil(s,()=>test()||!alive(),{timeoutTicks:ticks})});
   if(!near(3213,3424,5)&&state()!.player!.worldZ>4000){if(!combatTeleportAllowed(state()!.player!))throw Error('combat return blocked in high Wilderness; use observed exit');await s.sdk.sendCloseModal();await s.direct({type:'clickComponent',componentId:componentId('magic:varrock_teleport'),reason:'finite combat emergency return'});if(!await waitUntil(s,()=>near(3213,3424,5),{timeoutTicks:20}))throw Error('combat emergency return missing');escaped=true;}
   if(state()!.player!.worldZ<4000){
    if(kind==='kbd'&&state()!.player!.worldZ>3500){for(const [x,z] of [[3000,3805],[3000,3760],[3000,3715],[3025,3670],[3055,3625],[3080,3580],[3094,3535],[3096,3495]])if(z!<state()!.player!.worldZ)await walk(x!,z!,true);await walk(3185,3436,true);}
    else if(!near(p0.worldX,p0.worldZ,4))await walk(3185,3436,true);
    await deposit();final=totals();await close();banked=true;mark('banked');await setRetaliate(initialRetaliate);}
  }catch(e){failure+=[failure?'; ':'',String(e)].join('');}
 }
 const delta:Record<number,number>={},detail=result as {ammoUsed?:number;foods?:number;escaped?:boolean;loot?:number[];drops?:Record<number,number>;potions?:Record<number,number>}|undefined;
 if(escaped||detail?.escaped){delta[563]=-1;delta[556]=-3;delta[554]=-1;}
 if(detail?.ammoUsed)delta[877]=-detail.ammoUsed;
 if(routeFoods||detail?.foods)delta[385]=-routeFoods-(detail?.foods??0);
 if(detail?.drops)for(const [id,n] of Object.entries(detail.drops))delta[canonical(Number(id))]=(delta[canonical(Number(id))]??0)+n;
 if(kind==='kbd'){
  for(const [id,n] of Object.entries(detail?.potions??{}))delta[Number(id)]=(delta[Number(id)]??0)+n;
 }
 const assets=initial&&final?combatAssetIssues(initial,final,delta):[];
 if(assets.length)failure+=[failure?'; ':'','combat asset mismatch '+JSON.stringify(assets)].join('');
 return{ok:!failure&&!!result?.ok&&banked&&alive(),kind,failure,banked,escaped,initial,final,delta,assets,result,trace,ticks:s.tick()-start};
}
