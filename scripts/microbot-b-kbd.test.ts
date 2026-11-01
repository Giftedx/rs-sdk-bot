import {test,expect} from 'bun:test';
import {inKbdLair,kbdEntryFailure,kbdKillCredit,kbdRetreatReason,runKbdOne} from './microbot-b-kbd';
import type {Session} from '../packages/core/src/inprocess';
import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';
const state=()=>({player:{worldX:2717,worldZ:9802,level:0,lifeId:1},inventory:[{id:385,count:6},{id:2448,count:1},{id:2452,count:1},{id:563,count:1},{id:556,count:3},{id:554,count:1}],equipment:[{id:1540,slot:5},{id:1289,slot:3}],skills:[{name:'Hitpoints',level:80,baseLevel:80},{name:'Magic',level:25}],prayers:{prayerLevel:43,prayerPoints:30,activePrayers:[]},nearbyPlayers:[],nearbyNpcs:[{id:50,index:1,hp:240,maxHp:240,inCombat:false}]} as unknown as BotWorldState);
test('KBD staged prerequisites use exact shield, supplies and free dragon',()=>{
 const s=state();expect(inKbdLair(s)).toBe(true);expect(kbdEntryFailure(s)).toBeNull();
 s.equipment[0]!.id=1541;expect(kbdEntryFailure(s)).toContain('shield');
 s.equipment[0]!.id=1540;s.nearbyNpcs[0]!.hp=null;s.nearbyNpcs[0]!.maxHp=null;expect(kbdEntryFailure(s)).toBeNull();
 s.nearbyNpcs[0]!.hp=200;s.nearbyNpcs[0]!.maxHp=240;expect(kbdEntryFailure(s)).toContain('known damage');
 s.nearbyNpcs[0]!.hp=240;s.inventory=s.inventory.filter(i=>i.id!==563);expect(kbdEntryFailure(s)).toContain('runes');
});
test('KBD kill requires own XP, disappearance and both exact guaranteed drops',()=>{
 expect(kbdKillCredit(true,10,[1,1])).toBe(true);
 expect(kbdKillCredit(false,10,[1,1])).toBe(false);
 expect(kbdKillCredit(true,0,[1,1])).toBe(false);
 expect(kbdKillCredit(true,10,[0,1])).toBe(false);
 expect(kbdKillCredit(true,10,[2,1])).toBe(false);
});
test('KBD retreat thresholds protect cleanup margin and bounded immunity window',()=>{
 const s=state();expect(kbdRetreatReason(s,1,300)).toBeNull();
 expect(kbdRetreatReason(s,300,300)).toBe('combat cap');
 s.skills[0]!.level=34;expect(kbdRetreatReason(s,1,300)).toBe('low HP');
 s.skills[0]!.level=80;s.prayers.prayerPoints=9;expect(kbdRetreatReason(s,1,300)).toBe('low prayer');
});
function simulation(){
 let current=state(),tick=0;const actions:string[]=[];
 current.groundItems=[];current.skills.push({name:'Attack',level:70,experience:1000} as any);current.skills.forEach(k=>k.experience??=0);
 current.inventory=current.inventory.map((i,slot)=>({...i,slot,optionsWithIndex:[{text:'Drink',opIndex:1}]}));
 current.nearbyNpcs[0]={...current.nearbyNpcs[0]!,x:2720,z:9805,tileX:2720,tileZ:9805,optionsWithIndex:[{text:'Attack',opIndex:2}]} as any;
 const change=(f:(s:BotWorldState)=>void)=>{current=structuredClone(current);f(current);};
 const s={tick:()=>tick,ended:new Promise(()=>{}),sdk:{getState:()=>current,sendCloseModal:async()=>({success:true}),sendTogglePrayer:async()=>{change(v=>{v.prayers.activePrayers[14]=!v.prayers.activePrayers[14];});return{success:true};},sendInteractNpc:async()=>{actions.push('attack');return{success:true};}},direct:async(a:any)=>{
  if(a.type==='useInventoryItem'){change(v=>{const i=v.inventory.find(i=>i.slot===a.slot)!;i.id=i.id===2448?181:2454;});actions.push('potion');}
  else if(a.type==='clickComponent'){change(v=>{v.player!.worldX=3213;v.player!.worldZ=3424;v.inventory.find(i=>i.id===563)!.count--;});actions.push('teleport');}
  return{success:true};
 },bot:{pickupItem:async(item:any)=>{change(v=>{v.inventory.push({...item,slot:v.inventory.length});v.groundItems=v.groundItems.filter(i=>i.id!==item.id);});return{success:true};}}} as unknown as Session;
 return{s,actions,step:async()=>{tick++;change(v=>{v.nearbyNpcs=[];v.skills.find(k=>k.name==='Attack')!.experience+=100;v.groundItems=[536,1747].map(id=>({id,name:'drop',count:1,x:2720,z:9805,distance:1}));});},wait:async(test:()=>boolean)=>test(),set:change};
}
test('staged KBD loop reconciles two guaranteed drops and teleports after one kill',async()=>{
 const d=simulation();const r=await runKbdOne(d.s,{cap:300,stop:()=>false,step:d.step,wait:d.wait});
 expect(r.ok).toBe(true);expect(r.credited).toBe(true);expect(r.looted).toBe(2);expect(r.escaped).toBe(true);expect(d.actions).toEqual(['potion','potion','attack','teleport']);
});
test('stop after admission still attempts bounded Varrock cleanup without attacking',async()=>{
 const d=simulation();const r=await runKbdOne(d.s,{cap:300,stop:()=>true,step:d.step,wait:d.wait});
 expect(r.ok).toBe(false);expect(r.escaped).toBe(true);expect(r.attacked).toBe(false);expect(d.actions).toEqual(['teleport']);
});
