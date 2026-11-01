import {test,expect} from 'bun:test';
import {magicXpForLevel,magicOptions,magicPreflight,startRegion,draynorToVarrock,spendAllowance,baseXpEstimate,castsNeeded,
 runeShortfall,affordablePurchase,classifyCast,pickTarget,eatBetweenCasts,logoutQuiet,awaitLogoutQuiet,LOGOUT_QUIET_TICKS,runMagicOrder,
 AIR,MIND,COINS,CAST_SITE,BANKS,TARGET_AREA,HEALTH,CAST} from './magic-order';
import {chickenTrainingProfile} from './train-chickens';
import type {Session} from '../packages/core/src/inprocess';
import {setEquipmentObserved} from '../packages/core/src/container-observation';

test('Magic XP thresholds follow the pinned Player.ts curve',()=>{
 // levelExperience: floor(acc/4), acc = sum floor(l + 300*2^(l/10)).
 expect(magicXpForLevel(1)).toBe(0);
 expect(magicXpForLevel(2)).toBe(80);
 expect(magicXpForLevel(3)).toBe(167);
 for(let l=2;l<99;l++)expect(magicXpForLevel(l+1)).toBeGreaterThan(magicXpForLevel(l));
 expect(()=>magicXpForLevel(100)).toThrow('invalid Magic level');
});
test('options require a target and keep the budget at zero by default',()=>{
 expect(()=>magicOptions({})).toThrow('invalid TARGET_LEVEL');
 expect(magicOptions({TARGET_LEVEL:'15'})).toEqual({target:15,maxCasts:1000,cap:6000,budget:0,reserve:0});
 expect(magicOptions({TARGET_LEVEL:'12',MAX_CASTS:'40',CAP:'900',RUNE_BUDGET:'300',CASH_RESERVE:'200'}))
  .toEqual({target:12,maxCasts:40,cap:900,budget:300,reserve:200});
 for(const bad of [{TARGET_LEVEL:'1'},{TARGET_LEVEL:'100'},{TARGET_LEVEL:'5',RUNE_BUDGET:'-1'},{TARGET_LEVEL:'5',CAP:'0'},{TARGET_LEVEL:'5',MAX_CASTS:'1.5'}])
  expect(()=>magicOptions(bad)).toThrow('invalid');
});
test('preflight refuses at the target and off plane 0',()=>{
 expect(magicPreflight({target:15},15,0)).toBe('already at target');
 expect(magicPreflight({target:15},16,1)).toBe('already at target');
 expect(magicPreflight({target:15},3,1)).toBe('off plane 0');
 expect(magicPreflight({target:15},0,0)).toBe('Magic state unknown');
 expect(magicPreflight({target:15},3,0)).toBeNull();
});
test('only checked banks and central Varrock are supported starts',()=>{
 expect(startRegion({x:3092,z:3243,level:0})).toBe('draynor');
 expect(startRegion({x:3185,z:3436,level:0})).toBe('varrock-west');
 expect(startRegion({x:3253,z:3420,level:0})).toBe('varrock-east');
 expect(startRegion({...CAST_SITE,level:0})).toBe('varrock');
 expect(startRegion({x:3253,z:3402,level:0})).toBe('varrock');
 expect(startRegion({x:3222,z:3218,level:0})).toBeNull();
 expect(startRegion({x:3185,z:3436,level:1})).toBeNull();
});
test('the Draynor route reuses the checked legs and skips the chicken pen',()=>{
 const route=draynorToVarrock(),draynor=chickenTrainingProfile('draynor').route,east=chickenTrainingProfile('varrock').route;
 expect(route[0]).toEqual(draynor[1]);
 expect(route.at(-1)).toEqual(east[0]);
 expect(route.some(p=>p.x===3230&&p.z===3298)).toBe(false);
 expect(route).toContainEqual({x:3089,z:3320,tol:1});
 const legs=[...draynor,...east].map(p=>`${p.x},${p.z}`);
 for(const p of route)expect(legs).toContain(p.x===3089&&p.z===3320?'3088,3320':`${p.x},${p.z}`);
});
test('spending stays inside the budget and above the cash reserve',()=>{
 expect(spendAllowance(300,0,600,200)).toBe(300);
 expect(spendAllowance(300,0,400,200)).toBe(200);
 expect(spendAllowance(300,250,600,200)).toBe(50);
 expect(spendAllowance(0,0,600,0)).toBe(0);
 expect(spendAllowance(300,0,150,200)).toBe(0);
});
test('the base XP estimate prefers casts that dealt no damage',()=>{
 expect(baseXpEstimate([])).toBeNull();
 expect(baseXpEstimate([{magic:187.5,hp:33.3},{magic:162.5,hp:16.6}])).toBe(162.5);
 expect(baseXpEstimate([{magic:187.5,hp:33.3},{magic:137.5,hp:0},{magic:162.5,hp:16.6}])).toBe(137.5);
});
test('casts needed plan one cast before any observation and cap at the cast budget',()=>{
 expect(castsNeeded(0,3,null,100)).toBe(1);
 expect(castsNeeded(0,3,137.5,100)).toBe(2);
 expect(castsNeeded(0,3,5.5,100)).toBe(31);
 expect(castsNeeded(0,3,5.5,10)).toBe(10);
 expect(castsNeeded(167,3,5.5,100)).toBe(0);
 expect(castsNeeded(0,3,5.5,0)).toBe(0);
});
test('purchases cover only the missing runes that fit the allowance',()=>{
 expect(runeShortfall(12,40,2)).toEqual({air:0,mind:10});
 expect(runeShortfall(12,5,2)).toEqual({air:7,mind:10});
 expect(runeShortfall(12,0,2,0)).toEqual({air:0,mind:10});
 expect(affordablePurchase(12,40,2,{air:24,mind:18},300)).toEqual({casts:12,air:0,mind:10});
 expect(affordablePurchase(12,40,2,{air:24,mind:18},100)).toEqual({casts:7,air:0,mind:5});
 expect(affordablePurchase(12,0,0,{air:24,mind:18},41)).toEqual({casts:0,air:0,mind:0});
 expect(affordablePurchase(12,40,2,{air:24,mind:Infinity},1e9)).toEqual({casts:2,air:0,mind:0});
});
test('a cast counts only on a debit of each rune plus a Magic XP rise',()=>{
 const b={air:10,mind:10,xp:100};
 expect(classifyCast(b,{air:9,mind:9,xp:237.5})).toBe('cast');
 expect(classifyCast(b,{...b})).toBe('none');
 expect(classifyCast(b,{air:9,mind:9,xp:100})).toBe('partial');
 expect(classifyCast(b,{air:10,mind:10,xp:110})).toBe('partial');
 expect(classifyCast(b,{air:8,mind:9,xp:237.5})).toBe('invalid');
 expect(classifyCast(b,{air:11,mind:9,xp:237.5})).toBe('invalid');
 expect(classifyCast(b,{air:10,mind:9,xp:237.5},0)).toBe('cast');
 expect(classifyCast(b,{air:10,mind:9,xp:237.5})).toBe('partial');
});
test('targets are attackable men, women or muggers in the cast area, engaged first',()=>{
 const npc=(index:number,name:string,x:number,z:number,distance:number,extra:Record<string,unknown>={})=>
  ({index,name,x,z,distance,hp:null,inCombat:false,optionsWithIndex:[{text:'Attack',opIndex:2}],...extra});
 const npcs=[npc(1,'Man',3240,3405,4),npc(2,'Woman',3242,3406,2),npc(3,'Mugger',3249,3394,9),
  npc(4,'Man',3260,3405,1),npc(5,'Aubury',3253,3402,3,{optionsWithIndex:[{text:'Trade',opIndex:3}]}),
  npc(6,'Man',3241,3405,1,{inCombat:true}),npc(7,'Man',3243,3405,1,{hp:0}),npc(8,'Man',3243,3404,1,{reachable:false})];
 expect(pickTarget(npcs,-1,new Set())?.index).toBe(2);
 expect(pickTarget(npcs,-1,new Set([2]))?.index).toBe(1);
 expect(pickTarget(npcs,3,new Set())?.index).toBe(3);
 expect(pickTarget(npcs,6,new Set())?.index).toBe(6);
 expect(pickTarget(npcs,4,new Set([1,2,3]))).toBeUndefined();
 expect(TARGET_AREA.x1).toBeLessThan(3253);
 // A nearer mugger loses to any free man or woman, and is picked only when none is free.
 const near=[...npcs,npc(9,'Mugger',3243,3407,1)];
 expect(pickTarget(near,-1,new Set())?.index).toBe(2);
 expect(pickTarget(near,-1,new Set([1,2]))?.index).toBe(9);
 expect(pickTarget(near,9,new Set())?.index).toBe(9);
});
// Regression: an eat sent under the level-up chat modal does not debit (OpHeldHandler -> Player.canAccess).
// No cast may go out while that eat is pending.
test('a pending eat holds the next cast until its food debit, through the level-up modal',async()=>{
 const run=async(o:{debits:boolean;modal:boolean;dropFirst?:boolean})=>{
  let tick=0,hp=6,modal=o.modal,sent=0;const calls:string[]=[],callbacks=new Set<()=>void>();
  const inventory=[{slot:0,id:333,count:3,name:'Trout',optionsWithIndex:[{text:'Eat',opIndex:1}]}];
  const onTick=(cb:()=>void)=>{callbacks.add(cb);return()=>{callbacks.delete(cb);};};
  const s={sdk:{getState:()=>({player:{lifeId:1,respawnCount:0,isDead:false},skills:[{name:'Hitpoints',level:hp,baseLevel:10}],inventory,
    dialog:{isOpen:modal},modalOpen:modal})},
   tick:()=>tick,onTick,ended:new Promise<{reason:string}>(()=>{}),
   direct:async(a:{type:string})=>{
    calls.push(a.type);
    if(a.type==='closeModal')modal=false;
    // The server drops the eat while a modal is open, and once more when dropFirst models a delayed player.
    if(a.type==='useInventoryItem'&&o.debits&&!modal&&!(o.dropFirst&&sent++===0)){
     const at=tick,off=onTick(()=>{if(tick>=at+2){off();inventory[0]!.count--;hp=10;}});
    }
    return{success:true};
   }};
  // castOnce order: the eat gate, then the cast dispatch.
  const castOnce=async()=>{
   const fed=await eatBetweenCasts(s,{food:[333],eatAt:HEALTH.eatAt,timeoutTicks:CAST.eatTicks,attempts:CAST.eatAttempts});
   if(!fed)calls.push(`cast trout=${inventory[0]!.count}`);
   return fed;
  };
  const timer=setInterval(()=>{tick++;for(const cb of [...callbacks])cb();},1);
  try{return{calls,first:await castOnce().catch(String),second:await castOnce().catch(String)};}finally{clearInterval(timer);}
 };
 const ate=await run({debits:true,modal:true});
 expect(ate.first).toMatchObject({id:333,before:3,after:2,hpBefore:6,hpAfter:10,attempts:1});
 expect(ate.second).toBeNull();
 expect(ate.calls).toEqual(['closeModal','useInventoryItem','cast trout=2']);
 // A dropped eat is sent again, and the cast still waits for the debit.
 const retried=await run({debits:true,modal:false,dropFirst:true});
 expect(retried.first).toMatchObject({attempts:2,after:2});
 expect(retried.calls).toEqual(['useInventoryItem','useInventoryItem','cast trout=2']);
 // An eat that never debits stops the order: no cast is sent while it is pending.
 const lost=await run({debits:false,modal:false});
 expect(String(lost.first)).toContain('food debit unobserved before the next cast');
 expect(lost.calls).toEqual(Array(2*CAST.eatAttempts).fill('useInventoryItem'));
});
// Regression: a logout next to a retaliating NPC times out, because each hit renews the combat window.
test('logout waits for a retreat and the 16-tick combat window after the last hit',async()=>{
 expect(logoutQuiet(40,23,false)).toBe(true);
 expect(logoutQuiet(39,23,false)).toBe(false);
 expect(logoutQuiet(100,23,true)).toBe(false);
 expect(logoutQuiet(5,-Infinity,false)).toBe(true);
 const run=async(hitsUntil:number)=>{
  let tick=0,inCombat=true,lastHit=0;const calls:string[]=[],callbacks=new Set<()=>void>();
  const s={sdk:{getState:()=>({player:{combat:{inCombat,targetIndex:inCombat?7:-1,targetType:inCombat?'npc':'none',lastDamageTick:lastHit}}})},
   tick:()=>tick,onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>{callbacks.delete(cb);};},ended:new Promise<{reason:string}>(()=>{})};
  // The NPC keeps hitting every 4 ticks until hitsUntil.
  const timer=setInterval(()=>{tick++;if(tick<=hitsUntil&&tick%4===0)lastHit=tick;for(const cb of [...callbacks])cb();},1);
  try{
   const q=await awaitLogoutQuiet(s,{lastHit:()=>lastHit,timeoutTicks:CAST.quietTicks,
    retreat:async()=>{calls.push('retreat');inCombat=false;},between:async()=>{calls.push('between');}});
   return{q,tick,lastHit,calls};
  }finally{clearInterval(timer);}
 };
 const ended=await run(30);
 expect(ended.q.quiet).toBe(true);expect(ended.q.retreated).toBe(true);
 expect(ended.calls[0]).toBe('retreat');
 expect(ended.tick-ended.lastHit).toBeGreaterThanOrEqual(LOGOUT_QUIET_TICKS);
 // Hits that never stop fail inside the bound instead of reaching a logout that the server refuses.
 const endless=await run(1e9);
 expect(endless.q.quiet).toBe(false);expect(endless.q.ticks).toBeGreaterThanOrEqual(CAST.quietTicks);
});

type Item={id:number;count:number};
const NAMES:Record<number,string>={[AIR]:'Air rune',[MIND]:'Mind rune',[COINS]:'Coins',333:'Trout'};
function fakeSession(o:{x:number;z:number;level?:number;magic?:{level:number;xp:number};pack?:Item[];bank?:Item[];equipmentObserved?:boolean}){
 let tick=0,bankOpen=false,generation=0;const callbacks=new Set<()=>void>(),calls:string[]=[];
 const named=(list:Item[])=>list.map((i,slot)=>({slot,id:i.id,count:i.count,name:NAMES[i.id]??`item${i.id}`,optionsWithIndex:[]}));
 const inventory=named(o.pack??[]),bank=named(o.bank??[]),magic=o.magic??{level:1,xp:0};
 const skills=[{name:'Magic',level:magic.level,baseLevel:magic.level,experience:magic.xp},{name:'Hitpoints',level:10,baseLevel:10,experience:1154}];
 const state=()=>({player:{worldX:o.x,worldZ:o.z,level:o.level??0,lifeId:1,respawnCount:0,isDead:false,combat:{inCombat:false,targetIndex:-1,targetType:'none',lastDamageTick:-1}},
  inventory,skills,bank:{isOpen:bankOpen,items:bank,noteMode:false},nearbyNpcs:[],dialog:{isOpen:false},gameMessages:[]});
 const client={};if(o.equipmentObserved!==false)setEquipmentObserved(client,true);
 const s={name:'fake',client,tick:()=>tick,onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>{callbacks.delete(cb);};},ended:new Promise<{reason:string}>(()=>{}),
  sdk:{getState:state,getInventory:()=>inventory,getEquipment:()=>[],getSkill:(n:string)=>skills.find(k=>k.name.toLowerCase()===n.toLowerCase())??null,
   getSkillXp:(n:string)=>skills.find(k=>k.name.toLowerCase()===n.toLowerCase())?.experience??null},
  bankObservation:()=>generation?{generation,at:tick,items:bank.map(({id,name,count})=>({id,name,count}))}:null,
  bot:{openBank:async()=>{calls.push('openBank');bankOpen=true;generation++;return{success:true}},closeBank:async()=>{calls.push('closeBank');bankOpen=false;return{success:true}},
   withdrawItem:async()=>{calls.push('withdraw');return{success:true}},openShop:async()=>{calls.push('openShop');return{success:false}}},
  direct:async(a:{type:string})=>{calls.push('direct:'+a.type);return{success:true};}};
 const timer=setInterval(()=>{tick++;for(const cb of [...callbacks])cb();},1);
 return{s:s as unknown as Session,calls,stop:()=>clearInterval(timer),inventory,bank};
}
const options={target:12,maxCasts:100,cap:500,budget:0,reserve:0};
test('a rerun at the target refuses before any bank or game action',async()=>{
 const f=fakeSession({x:3253,z:3420,magic:{level:12,xp:1500}});
 try{
  const r=await runMagicOrder(f.s,options);
  expect(r.ok).toBe(false);expect(r.stop).toBe('already at target');expect(r.casts).toBe(0);expect(f.calls).toEqual([]);
 }finally{f.stop();}
});
test('entry waits for the equipment packet, so a worn staff is never read as absent',async()=>{
 const f=fakeSession({x:3253,z:3420,equipmentObserved:false});
 try{const r=await runMagicOrder(f.s,options);expect(r.stop).toBe('entry');expect(r.failure).toBe('entry state unobserved');expect(f.calls).toEqual([]);}finally{f.stop();}
});
test('off plane 0 refuses before any action',async()=>{
 const f=fakeSession({x:3253,z:3420,level:1});
 try{const r=await runMagicOrder(f.s,options);expect(r.stop).toBe('off plane 0');expect(f.calls).toEqual([]);}finally{f.stop();}
});
test('an unsupported region refuses with its position',async()=>{
 const f=fakeSession({x:3222,z:3218});
 try{const r=await runMagicOrder(f.s,options);expect(r.stop).toBe('unsupported start region');expect(r.failure).toContain('3222');expect(f.calls).toEqual([]);}finally{f.stop();}
});
test('short runes with budget zero refuse after observing the bank and move nothing',async()=>{
 const f=fakeSession({x:BANKS.draynor.x,z:BANKS.draynor.z,pack:[{id:333,count:4}],bank:[{id:AIR,count:40},{id:COINS,count:300}]});
 try{
  const r=await runMagicOrder(f.s,options);
  expect(r.ok).toBe(false);expect(r.stop).toBe('short runes');expect(r.missing).toEqual({air:0,mind:1});
  expect(r.coinsSpent).toBe(0);expect(r.casts).toBe(0);
  expect(f.calls).toEqual(['openBank','closeBank']);
 }finally{f.stop();}
});
test('a budget held entirely by the cash reserve also refuses short runes',async()=>{
 const f=fakeSession({x:BANKS.draynor.x,z:BANKS.draynor.z,bank:[{id:AIR,count:40},{id:COINS,count:150}]});
 try{
  const r=await runMagicOrder(f.s,{...options,budget:300,reserve:200});
  expect(r.stop).toBe('short runes');expect(r.missing).toEqual({air:0,mind:1});expect(f.calls).toEqual(['openBank','closeBank']);
 }finally{f.stop();}
});
