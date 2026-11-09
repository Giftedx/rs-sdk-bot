import {test,expect} from 'bun:test';
import {inKbdLair,kbdEntryFailure,kbdKillCredit,kbdRetreatReason,runKbdOne,selectKbdTarget} from './microbot-b-kbd';
import type {Session} from '../packages/core/src/inprocess';
import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';
const state=()=>({player:{worldX:2717,worldZ:9802,level:0,lifeId:1},inventory:[{id:385,count:6},{id:2448,count:1},{id:2452,count:1},{id:2436,count:1},{id:2440,count:1},{id:2434,count:2},{id:563,count:1},{id:556,count:3},{id:554,count:1}],equipment:[{id:1540,slot:5},{id:1289,slot:3},{id:1113,slot:4},{id:1079,slot:7}],skills:[{name:'Hitpoints',level:80,baseLevel:80},{name:'Magic',level:25},{name:'Attack',level:70,experience:0},{name:'Defence',level:70,experience:0}],prayers:{prayerLevel:43,prayerPoints:80,activePrayers:[]},nearbyPlayers:[],nearbyNpcs:[{id:50,index:1,hp:240,maxHp:240,inCombat:false}]} as unknown as BotWorldState);
test('KBD staged prerequisites use exact shield, supplies and free dragon',()=>{
 const s=state();expect(inKbdLair(s)).toBe(true);expect(kbdEntryFailure(s)).toBeNull();
 s.equipment[0]!.id=1541;expect(kbdEntryFailure(s)).toContain('shield');
 s.equipment[0]!.id=1540;s.nearbyNpcs[0]!.hp=null;s.nearbyNpcs[0]!.maxHp=null;expect(kbdEntryFailure(s)).toBeNull();
 s.nearbyNpcs[0]!.hp=200;s.nearbyNpcs[0]!.maxHp=240;expect(kbdEntryFailure(s)).toContain('known damage');
 s.nearbyNpcs[0]!.hp=240;s.inventory=s.inventory.filter(i=>i.id!==563);expect(kbdEntryFailure(s)).toContain('runes');
});
test('KBD kill requires own XP, disappearance and both exact guaranteed drops',()=>{
 expect(kbdKillCredit(true,960,[1,1])).toBe(true);
 expect(kbdKillCredit(false,960,[1,1])).toBe(false);
 expect(kbdKillCredit(true,0,[1,1])).toBe(false);expect(kbdKillCredit(true,959,[1,1])).toBe(false);
 expect(kbdKillCredit(true,960,[0,1])).toBe(false);
 expect(kbdKillCredit(true,960,[2,1])).toBe(false);
});
test('KBD retreat thresholds protect cleanup margin and bounded immunity window',()=>{
 const s=state();expect(kbdRetreatReason(s,1,300)).toBeNull();
 expect(kbdRetreatReason(s,300,300)).toBe('combat cap');
 s.skills[0]!.level=34;expect(kbdRetreatReason(s,1,300)).toBe('low HP');
 s.skills[0]!.level=80;s.prayers.prayerPoints=9;expect(kbdRetreatReason(s,1,300)).toBe('low prayer');
});
function simulation(extraDrops:number[]=[],interrupt=false,missUntil=0){
 let current=state(),tick=0,busyUntil=0;const actions:string[]=[];
 current.groundItems=[];current.skills.find(k=>k.name==='Attack')!.experience=1000;current.skills.forEach(k=>k.experience??=0);
 current.inventory=current.inventory.map((i,slot)=>({...i,slot,optionsWithIndex:[{text:'Drink',opIndex:1}]}));
 current.nearbyNpcs[0]={...current.nearbyNpcs[0]!,x:2720,z:9805,tileX:2720,tileZ:9805,optionsWithIndex:[{text:'Attack',opIndex:2}]} as any;
 const change=(f:(s:BotWorldState)=>void)=>{current=structuredClone(current);f(current);};
 const s={tick:()=>tick,ended:new Promise(()=>{}),client:{objType:()=>({cost:1,stackable:false})},sdk:{sendPickup:async(x:number,z:number,id:number)=>{change(v=>{const item=v.groundItems.find(i=>i.id===id)!;v.inventory.push({...item,slot:v.inventory.length,optionsWithIndex:[]});v.groundItems=v.groundItems.filter(i=>i.id!==id);});return{success:true};},getState:()=>current,sendSetCombatStyle:async()=>{change(v=>{v.combatStyle={known:true,currentStyle:0,weaponName:'Rune sword',styles:[{index:0,damageType:'Stab',trainsSkills:['Attack']}]} as any;});return{success:true};},sendCloseModal:async()=>({success:true}),sendTogglePrayer:async()=>{change(v=>{v.prayers.activePrayers[14]=!v.prayers.activePrayers[14];});return{success:true};},sendInteractNpc:async()=>{actions.push('attack');return{success:true};}},direct:async(a:any)=>{
  if(a.type==='useInventoryItem'){if(tick<busyUntil)return{success:false};busyUntil=tick+3;change(v=>{const i=v.inventory.find(i=>i.slot===a.slot)!;const next:Record<number,number>={2448:181,2452:2454,2436:145,2440:157,2434:139,139:141,141:143,143:229,181:183,183:185,185:229,2454:2456,2456:2458,2458:229};if([2434,139,141,143].includes(i.id))v.prayers.prayerPoints+=25;i.id=next[i.id]!;});actions.push('potion');}
  else if(a.type==='clickComponent'){change(v=>{v.player!.worldX=3213;v.player!.worldZ=3424;v.inventory.find(i=>i.id===563)!.count--;});actions.push('teleport');}
  return{success:true};
 },bot:{pickupItem:async(item:any)=>{change(v=>{v.inventory.push({...item,slot:v.inventory.length,optionsWithIndex:[]});v.groundItems=v.groundItems.filter(i=>i.id!==item.id);});return{success:true};}}} as unknown as Session;
 return{s,actions,step:async()=>{tick++;if(missUntil&&actions.includes('attack')&&tick<missUntil){change(v=>{v.combatEvents=[{tick,type:'damage_dealt',damage:0,sourceType:'player',sourceIndex:-1,targetType:'npc',targetIndex:1}];});return;}if(interrupt&&actions.filter(a=>a==='attack').length===1){change(v=>{v.player!.combat={targetIndex:-1} as any;});return;}if(actions.includes('attack')&&current.nearbyNpcs.length)change(v=>{v.nearbyNpcs=[];v.skills.find(k=>k.name==='Attack')!.experience+=960;v.groundItems=[536,1747,...extraDrops].map(id=>({id,name:'drop',count:1,x:2720,z:9805,distance:1}));});},wait:async(test:()=>boolean)=>test(),set:change};
}
test('staged KBD respects native post-transform potion delay, collects and teleports',async()=>{
 const d=simulation();const r=await runKbdOne(d.s,{cap:300,stop:()=>false,step:d.step,wait:d.wait});
 expect(r.ok).toBe(true);expect(r.credited).toBe(true);expect(r.looted).toBe(2);expect(r.escaped).toBe(true);expect(d.actions).toEqual(['potion','potion','potion','potion','attack','teleport']);
});
test('stop after admission still attempts bounded Varrock cleanup without attacking',async()=>{
 const d=simulation();const r=await runKbdOne(d.s,{cap:300,stop:()=>true,step:d.step,wait:d.wait});
 expect(r.ok).toBe(false);expect(r.escaped).toBe(true);expect(r.attacked).toBe(false);expect(d.actions).toEqual(['teleport']);
});

test('native KBD admission rejects foreign ownership and unsupported staged kit',()=>{
 const s=state();s.nearbyNpcs[0]!.inCombat=true;s.nearbyNpcs[0]!.targetIndex=32769;expect(selectKbdTarget(s,1)).toBeDefined();expect(selectKbdTarget(s,2)).toBeUndefined();
 s.nearbyNpcs[0]!.inCombat=false;s.equipment[1]!.id=4151;expect(kbdEntryFailure(s)).toContain('rune sword');s.equipment[1]!.id=1289;s.equipment[2]!.id=1127;expect(kbdEntryFailure(s)).toContain('chainbody');
});

test('KBD collects attributed rare loot with guaranteed drops',async()=>{
 const d=simulation([1149]);const r=await runKbdOne(d.s,{cap:300,stop:()=>false,step:d.step,wait:d.wait});
 expect(r.ok).toBe(true);expect(r.drops).toEqual({536:1,1747:1,1149:1});
});

test('KBD resumes its owned living target after the attack action clears',async()=>{
 const d=simulation([],true);const r=await runKbdOne(d.s,{cap:300,stop:()=>false,step:d.step,wait:d.wait});
 expect(r.ok).toBe(true);expect(d.actions.filter(a=>a==='attack').length).toBe(2);
});

test('observed zero-damage swings keep a bounded fight alive without granting kill credit',async()=>{
 const d=simulation([],false,130);const r=await runKbdOne(d.s,{cap:300,stop:()=>false,step:d.step,wait:d.wait});
 expect(r.ok).toBe(true);expect(r.ticks).toBeGreaterThan(100);expect(r.credited).toBe(true);
});
