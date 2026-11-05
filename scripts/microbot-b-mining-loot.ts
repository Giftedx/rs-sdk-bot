// Finite visible-ground looter: exact ID/name lists, native static-value bounds, or their union.
// Native OpObjHandler resolves private/public visibility with the player's hash64.
// This proves inventory acquisition, never kill ownership or a live GE valuation.
import {existsSync} from 'node:fs';
import {openBot,finish} from '../packages/core/src/bot';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import type {BotWorldState,GroundItem} from '../vendor/rs-sdk/sdk/types';
export interface LootPolicy{mode:'list'|'value'|'mixed';ids:readonly number[];names:readonly string[];minimumValue:number;maximumValue:number;radius:number;maximumUnits:number;cap:number;idleTicks:number}
export interface LootDefinition{cost:number;stackable:boolean}
const stock=(s:BotWorldState)=>{const n:Record<number,number>={};for(const i of s.inventory)n[i.id]=(n[i.id]??0)+i.count;return n;};
const hp=(s:BotWorldState)=>s.skills.find(k=>k.name==='Hitpoints')?.level??0;
export function lootCapacity(s:BotWorldState,i:GroundItem,definition:LootDefinition){
 const held=stock(s)[i.id]??0,free=28-s.inventory.length;
 return definition.stackable?(held>0||free>=1)&&held+i.count<=2147483647:free>=i.count;
}
export function selectGroundLoot(s:BotWorldState,p:LootPolicy,definition:(id:number)=>LootDefinition|undefined,left=p.maximumUnits){
 return s.groundItems.flatMap(i=>{
  // Native pickup addresses the tile and item ID. Differently sized stacks
  // at that address cannot be selected individually or bounded by this row.
  if(s.groundItems.some(other=>other.id===i.id&&other.x===i.x&&other.z===i.z&&other.count!==i.count))return[];
  const d=definition(i.id);if(!d||!Number.isSafeInteger(i.count)||i.count<1||i.count>left||!Number.isSafeInteger(d.cost)||d.cost<0||!Number.isSafeInteger(i.count*d.cost)||i.reachable===false||i.distance>p.radius||!lootCapacity(s,i,d)||s.nearbyPlayers.some(player=>Math.max(Math.abs(player.x-i.x),Math.abs(player.z-i.z))<=1))return[];
  const listed=p.ids.includes(i.id)||p.names.some(name=>name.toLowerCase()===i.name.toLowerCase()),value=i.count*d.cost,valued=value>=p.minimumValue&&value<=p.maximumValue;
  return(p.mode==='list'?listed:p.mode==='value'?valued:listed||valued)?[{item:i,value}]:[];
 }).sort((a,b)=>b.value-a.value||a.item.distance-b.item.distance)[0];
}
export function groundLootEffect(before:BotWorldState,after:BotWorldState,item:GroundItem){
 const b=stock(before),a=stock(after),keys=new Set([...Object.keys(b),...Object.keys(a)].map(Number));
 if([...keys].every(id=>(a[id]??0)===(b[id]??0)))return false;
 if(![...keys].every(id=>(a[id]??0)-(b[id]??0)===(id===item.id?item.count:0)))throw Error('ground pickup inventory delta does not reconcile');
 return true;
}
export interface LootDriver{state:()=>BotWorldState|null;tick:()=>number;stop:()=>boolean;definition:(id:number)=>LootDefinition|undefined;pickup:(i:GroundItem)=>Promise<boolean>;wait:(test:()=>boolean,ticks:number)=>Promise<boolean>;step:()=>Promise<void>;clearModal?:()=>Promise<void>}
export async function runVisibleGroundLoot(d:LootDriver,p:LootPolicy){
 if(!['list','value','mixed'].includes(p.mode)||![p.maximumUnits,p.cap,p.idleTicks,p.radius].every(n=>Number.isSafeInteger(n)&&n>0)||p.radius>12||!Number.isSafeInteger(p.minimumValue)||p.minimumValue<0||!Number.isSafeInteger(p.maximumValue)||p.maximumValue<p.minimumValue||p.ids.some(id=>!Number.isSafeInteger(id)||id<0)||p.mode==='list'&&!p.ids.length&&!p.names.length)throw Error('invalid finite ground-loot policy');
 const initial=d.state();if(!initial?.player||hp(initial)<1)throw Error('ground-loot state unknown');const start=d.tick();let units=0,pickups=0,staticValue=0,progress=start;const acquired:Record<number,number>={};
 const kit=JSON.stringify(initial.equipment.map(i=>({id:i.id,slot:i.slot,count:i.count})).sort((a,b)=>a.slot-b.slot));
 const state=()=>{const s=d.state();if(!s?.player)throw Error('ground-loot session ended');if(d.stop())throw Error('ground-loot stopped');if(d.tick()-start>=p.cap)throw Error('ground-loot cap');if(s.player.lifeId!==initial.player!.lifeId||s.player.level!==initial.player!.level||s.player.isDead||hp(s)!==hp(initial)||Math.max(Math.abs(s.player.worldX-initial.player!.worldX),Math.abs(s.player.worldZ-initial.player!.worldZ))>p.radius)throw Error('ground-loot health, life or area changed');if(JSON.stringify(s.equipment.map(i=>({id:i.id,slot:i.slot,count:i.count})).sort((a,b)=>a.slot-b.slot))!==kit)throw Error('ground-loot equipment changed');return s;};
 while(units<p.maximumUnits){
  let before=state();if(d.tick()-progress>=p.idleTicks)throw Error('ground-loot no eligible pickup progress');
  if(before.dialog?.isOpen||before.interface?.isOpen){if(!d.clearModal)throw Error('ground-loot modal blocked');await d.clearModal();before=state();}
  const scoped={...before,groundItems:before.groundItems.filter(i=>Math.max(Math.abs(i.x-initial.player!.worldX),Math.abs(i.z-initial.player!.worldZ))<=p.radius)};
  const selected=selectGroundLoot(scoped,p,d.definition,p.maximumUnits-units);if(!selected){await d.step();continue;}
  const target={...selected.item};if(!await d.pickup(target))throw Error('native ground pickup refused');
  await d.wait(()=>{const s=state();return groundLootEffect(before,s,target)||!s.groundItems.some(i=>i.id===target.id&&i.x===target.x&&i.z===target.z);},Math.min(12,p.cap-(d.tick()-start)));
  if(!groundLootEffect(before,state(),target)){await d.step();if(!groundLootEffect(before,state(),target))throw Error('ground disappeared without own inventory receipt');}
  units+=target.count;pickups++;staticValue+=selected.value;acquired[target.id]=(acquired[target.id]??0)+target.count;progress=d.tick();
  if(units<p.maximumUnits)await d.step();
 }
 const b=stock(initial),a=stock(state()),all=new Set([...Object.keys(a),...Object.keys(b),...Object.keys(acquired)].map(Number));if(![...all].every(id=>(a[id]??0)-(b[id]??0)===(acquired[id]??0)))throw Error('ground-loot final inventory audit failed');
 return{units,pickups,acquired,staticValue,valueSource:'native static item cost; not GE price',ticks:d.tick()-start,banked:0,attribution:'visible native pickup and owned inventory receipt; no kill-credit claim'};
}
if(import.meta.main){
 const name=process.argv[2];if(!name)throw Error('account required');
 const p:LootPolicy={mode:(process.env.LOOT_MODE??'list') as LootPolicy['mode'],ids:(process.env.LOOT_IDS??'').split(',').filter(Boolean).map(Number),names:(process.env.LOOT_NAMES??'').split(',').map(n=>n.trim()).filter(Boolean),minimumValue:Number(process.env.MIN_VALUE??1),maximumValue:Number(process.env.MAX_VALUE??2147483647),radius:Number(process.env.RADIUS??2),maximumUnits:Number(process.env.MAX_UNITS??1),cap:Number(process.env.CAP??200),idleTicks:Number(process.env.IDLE_TICKS??80)};
 const s=await openBot(name).catch(e=>finish([],false,`login: ${String(e)}`));let ended=false;void s.ended.then(()=>{ended=true;});
 const client=s.client as {objType?:(id:number)=>{cost:number;stackable:boolean}};
 try{const result=await runVisibleGroundLoot({state:()=>s.sdk.getState(),tick:()=>s.tick(),stop:()=>ended||existsSync(`.practice/stop-${name}`)||existsSync('.practice/stop-all'),definition:id=>{const d=client.objType?.(id);return d&&typeof d.stackable==='boolean'?{cost:d.cost,stackable:d.stackable}:undefined;},pickup:async i=>(await s.sdk.sendPickup(i.x,i.z,i.id)).success,wait:(test,ticks)=>waitUntil(s,test,{timeoutTicks:ticks}),step:()=>waitTicks(s,1),clearModal:async()=>{await s.sdk.sendCloseModal();}},p);await finish([s],true,JSON.stringify(result));}catch(e){await finish([s],false,String(e));}
}
