import {test,expect,spyOn} from 'bun:test';
import * as walking from '../packages/core/src/walk';
import {loadPathfinding} from '../packages/core/src/pathcache';
import {magicXpForLevel,magicOptions,magicPreflight,startRegion,draynorToVarrock,spendAllowance,baseXpEstimate,castsNeeded,
 runeShortfall,affordablePurchase,classifyCast,pickTarget,eatBetweenCasts,logoutQuiet,awaitLogoutQuiet,LOGOUT_QUIET_TICKS,runMagicOrder,
 AIR,MIND,COINS,CAST_SITE,BANKS,TARGET_AREA,HEALTH,CAST} from './magic-order';
import {TELEPORTS,TELE_RUNE_IDS,selectTeleport,teleportCosts,teleportEffect,teleportShortfall,teleportPurchaseCost,purchaseEffect,type RuneCounts} from './magic-order';
import {chickenTrainingProfile} from './train-chickens';
import type {Session} from '../packages/core/src/inprocess';
import {setEquipmentObserved} from '../packages/core/src/container-observation';

const ownedTele=(values:Partial<RuneCounts>={}):RuneCounts=>({air:25,mind:0,earth:5,water:0,fire:0,law:5,...values});
test('teleport shortfall counts owned stock, law supply, staff and finite cast/target limits',()=>{
 const t=TELEPORTS.find(t=>t.name==='lumbridge')!,costs=teleportCosts(t,[]);
 expect(teleportShortfall(8125,37,5,t,costs,ownedTele({earth:4}))).toEqual({air:0,mind:0,earth:1,water:0,fire:0,law:0});
 expect(teleportShortfall(8125,37,4,t,costs,ownedTele({earth:4})).earth).toBe(0);
 expect(teleportShortfall(8125,37,200,t,costs,ownedTele({earth:4})).earth).toBe(1);
 expect(teleportShortfall(8125,37,5,t,costs,ownedTele({law:0})).earth).toBe(0);
 expect(teleportShortfall(magicXpForLevel(37)-1,37,5,t,costs,ownedTele({earth:0})).earth).toBe(1);
 expect(teleportShortfall(8125,37,5,t,teleportCosts(t,[{slot:3,id:1385}]),ownedTele({earth:0})).earth).toBe(0);
});
test('teleport purchase refuses stock, budget or reserve shortfalls before buying',()=>{
 const missing={air:0,mind:0,earth:1,water:0,fire:0,law:0};
 const stock=[{id:557,count:100,baseCost:4}];
 expect(teleportPurchaseCost(missing,stock,{sellMultiplier:1000},spendAllowance(1000,0,14911,10000))).toBe(24);
 expect(teleportPurchaseCost(missing,stock,{sellMultiplier:1000},23)).toBeNull();
 expect(teleportPurchaseCost(missing,stock,{sellMultiplier:1000},spendAllowance(1000,0,10023,10000))).toBeNull();
 expect(teleportPurchaseCost(missing,[],{sellMultiplier:1000},1000)).toBeNull();
 expect(teleportPurchaseCost({...missing,law:1},stock,{sellMultiplier:1000},1000)).toBeNull();
});
test('purchase accounting requires exact rune credit, coin debit and no unrelated rune changes',()=>{
 const b={...ownedTele({earth:4}),coins:1000},a={...b,earth:5,coins:996};
 expect(purchaseEffect('earth',1,b,a,{bought:1,spent:4},1000)).toBe(true);
 expect(purchaseEffect('earth',1,b,{...a,earth:6},{bought:2,spent:4},1000)).toBe(false);
 expect(purchaseEffect('earth',1,b,a,{bought:1,spent:3},1000)).toBe(false);
 expect(purchaseEffect('earth',1,b,{...a,law:4},{bought:1,spent:4},1000)).toBe(false);
 expect(purchaseEffect('earth',1,b,a,{bought:1,spent:4},3)).toBe(false);
});
test('teleport selection uses the highest unlocked funded band and stops at the target',()=>{
 expect(selectTeleport(31,37,ownedTele())?.name).toBe('lumbridge');
 expect(selectTeleport(30,37,ownedTele())).toBeUndefined();
 expect(selectTeleport(25,37,ownedTele({fire:1}))?.name).toBe('varrock');
 expect(selectTeleport(37,45,ownedTele({water:1}))?.name).toBe('falador');
 expect(selectTeleport(37,37,ownedTele({water:5}))).toBeUndefined();
 expect(selectTeleport(45,50,ownedTele({water:1}),[],false)?.name).toBe('falador');
 expect(selectTeleport(45,50,ownedTele(),[],true)?.name).toBe('camelot');
 expect(selectTeleport(31,37,ownedTele({law:0}))).toBeUndefined();
 expect(selectTeleport(37,45,ownedTele())?.name).toBe('lumbridge');
});
test('teleports account only for an observed equipped staff and every rune debit',()=>{
 const t=TELEPORTS.find(t=>t.name==='lumbridge')!;
 expect(teleportCosts(t,[])).toEqual({air:3,mind:0,earth:1,water:0,fire:0,law:1});
 expect(teleportCosts(t,[{slot:3,id:1381}]).air).toBe(0);
 expect(teleportCosts(t,[{slot:4,id:1381}]).air).toBe(3);
 expect(teleportCosts(t,[{slot:3,id:1385}]).earth).toBe(0);
 expect(teleportCosts(t,[{slot:3,id:1397}]).air).toBe(3);
 expect(teleportCosts(t,[{slot:3,id:1397}],true).air).toBe(0);
 const costs=teleportCosts(t,[]),b={...ownedTele(),xp:8125},a={...ownedTele({air:22,earth:4,law:4}),xp:9150};
 expect(teleportEffect(t,costs,b,a,t.to)).toBe('cast');
 expect(teleportEffect(t,costs,b,b,t.to)).toBe('none');
 expect(teleportEffect(t,costs,b,{...a,law:5},t.to)).toBe('partial');
 expect(teleportEffect(t,costs,b,{...a,xp:b.xp},t.to)).toBe('partial');
 expect(teleportEffect(t,costs,b,a,{...t.to,x:t.to.x+3})).toBe('partial');
 expect(teleportEffect(t,costs,b,{...a,mind:1},t.to)).toBe('invalid');
});
test('five funded Lumbridge casts reach37 from8125XP without a sixth or Falador cast',()=>{
 let xp=8125,level=31,held=ownedTele(),n=0;
 while(level<37){
  const t=selectTeleport(level,37,held)!;expect(t.name).toBe('lumbridge');
  for(const k of Object.keys(TELE_RUNE_IDS) as (keyof RuneCounts)[])held[k]-=t.costs[k];
  xp+=t.xp*25;n++;
  while(level<99&&xp>=magicXpForLevel(level+1))level++;
 }
 expect(n).toBe(5);expect(level).toBe(37);expect(held).toEqual(ownedTele({air:10,earth:0,law:0}));
 expect(selectTeleport(level,37,held)).toBeUndefined();
});

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
 // The Falador and Camelot teleport cleanups end at these banks; the next order starts from them.
 expect(startRegion({x:2946,z:3370,level:0})).toBe('falador');
 expect(startRegion({x:2725,z:3491,level:0})).toBe('seers');
 expect(startRegion({x:2946,z:3370,level:1})).toBeNull();
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
test('an NPC attacking our player remains selectable after the player target clears',()=>{
 const mugger={index:2965,name:'Mugger',x:3225,z:3401,distance:6,hp:null,inCombat:true,targetIndex:32769,reachable:true,optionsWithIndex:[{text:'Attack',opIndex:2}]};
 expect(pickTarget([mugger],-1,new Set(),1)?.index).toBe(2965);
 expect(pickTarget([mugger],-1,new Set(),2)).toBeUndefined();
 expect(pickTarget([mugger],-1,new Set())).toBeUndefined();
 expect(pickTarget([{...mugger,x:3254}],-1,new Set(),1)).toBeUndefined();
});
// Regression: the men east of x 3235 stand behind shut doors. Their reachable:false rows leave no target.
test('the cast site routes to a pinned Man and Woman with every door shut',async()=>{
 await loadPathfinding();
 const pf=await import('../vendor/rs-sdk/sdk/pathfinding');
 const doors:NonNullable<ReturnType<typeof pf.getDoorAt>>[]=[];
 for(let x=3150;x<=3300;x++)for(let z=3370;z<=3460;z++){const d=pf.getDoorAt(0,x,z);if(d)doors.push(d);}
 expect(doors.length).toBeGreaterThan(0);
 const end=(x:number,z:number)=>pf.findLongPath(0,CAST_SITE.x,CAST_SITE.z,x,z,500,doors).at(-1);
 for(const spawn of [{x:3223,z:3398},{x:3223,z:3401}])expect(end(spawn.x,spawn.z)).toMatchObject(spawn);
 for(const shut of [{x:3237,z:3406},{x:3238,z:3406},{x:3245,z:3395}])expect(end(shut.x,shut.z)).not.toMatchObject(shut);
 const row={index:1,name:'Man',distance:2,hp:null,inCombat:false,optionsWithIndex:[{text:'Attack',opIndex:2}]};
 expect(pickTarget([{...row,x:3223,z:3398,reachable:true}],-1,new Set())?.index).toBe(1);
 expect(pickTarget([{...row,x:3223,z:3398,reachable:false}],-1,new Set())).toBeUndefined();
 expect(pickTarget([{...row,x:3237,z:3407,reachable:true}],-1,new Set())).toBeUndefined();
});
test('targets are attackable men, women or muggers in the cast area, engaged first',()=>{
 const npc=(index:number,name:string,x:number,z:number,distance:number,extra:Record<string,unknown>={})=>
  ({index,name,x,z,distance,hp:null,inCombat:false,optionsWithIndex:[{text:'Attack',opIndex:2}],...extra});
 const npcs=[npc(1,'Man',3223,3398,4),npc(2,'Woman',3223,3401,2),npc(3,'Mugger',3229,3394,9),
  npc(4,'Man',3260,3405,1),npc(5,'Aubury',3253,3402,3,{optionsWithIndex:[{text:'Trade',opIndex:3}]}),
  npc(6,'Man',3224,3399,1,{inCombat:true}),npc(7,'Man',3224,3400,1,{hp:0}),npc(8,'Man',3222,3400,1,{reachable:false})];
 expect(pickTarget(npcs,-1,new Set())?.index).toBe(2);
 expect(pickTarget(npcs,-1,new Set([2]))?.index).toBe(1);
 expect(pickTarget(npcs,3,new Set())?.index).toBe(3);
 expect(pickTarget(npcs,6,new Set())?.index).toBe(6);
 expect(pickTarget(npcs,4,new Set([1,2,3]))).toBeUndefined();
 expect(TARGET_AREA.x1).toBeLessThan(3253);
 // A nearer mugger loses to any free man or woman, and is picked only when none is free.
 const near=[...npcs,npc(9,'Mugger',3223,3400,1)];
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
function fakeSession(o:{x:number;z:number;level?:number;magic?:{level:number;xp:number};pack?:Item[];bank?:Item[];modal?:boolean;equipmentObserved?:boolean}){
 let tick=0,bankOpen=false,generation=0,modal=o.modal??false;const callbacks=new Set<()=>void>(),calls:string[]=[];
 const named=(list:Item[])=>list.map((i,slot)=>({slot,id:i.id,count:i.count,name:NAMES[i.id]??`item${i.id}`,optionsWithIndex:[]}));
 const inventory=named(o.pack??[]),bank=named(o.bank??[]),magic=o.magic??{level:1,xp:0};
 const skills=[{name:'Magic',level:magic.level,baseLevel:magic.level,experience:magic.xp},{name:'Hitpoints',level:10,baseLevel:10,experience:1154}];
 const state=()=>({player:{worldX:o.x,worldZ:o.z,level:o.level??0,lifeId:1,respawnCount:0,isDead:false,combat:{inCombat:false,targetIndex:-1,targetType:'none',lastDamageTick:-1}},
  inventory,skills,bank:{isOpen:bankOpen,items:bank,noteMode:false},nearbyNpcs:[],dialog:{isOpen:modal},modalOpen:modal,gameMessages:[]});
 const client={};if(o.equipmentObserved!==false)setEquipmentObserved(client,true);
 const s={name:'fake',client,tick:()=>tick,onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>{callbacks.delete(cb);};},ended:new Promise<{reason:string}>(()=>{}),
  sdk:{getState:state,getInventory:()=>inventory,getEquipment:()=>[],getSkill:(n:string)=>skills.find(k=>k.name.toLowerCase()===n.toLowerCase())??null,
   getSkillXp:(n:string)=>skills.find(k=>k.name.toLowerCase()===n.toLowerCase())?.experience??null},
  bankObservation:()=>generation?{generation,at:tick,items:bank.map(({id,name,count})=>({id,name,count}))}:null,
  bot:{openBank:async()=>{calls.push('openBank');bankOpen=true;generation++;return{success:true}},closeBank:async()=>{calls.push('closeBank');bankOpen=false;return{success:true}},
   withdrawItem:async(item:{id:number},amount:number)=>{
    calls.push('withdraw');const stored=bank.find(i=>i.id===item.id)!;stored.count-=amount;
    const held=inventory.find(i=>i.id===item.id);if(held)held.count+=amount;else inventory.push({...stored,slot:inventory.length,count:amount});generation++;return{success:true};
   },
   depositItem:async(item:{id:number})=>{
    calls.push('deposit:'+item.id);const entries=inventory.filter(i=>i.id===item.id),amount=entries.reduce((n,i)=>n+i.count,0);
    if(!entries.length)throw Error('duplicate deposit');
    for(let i=inventory.length-1;i>=0;i--)if(inventory[i]!.id===item.id)inventory.splice(i,1);
    const stored=bank.find(i=>i.id===item.id);if(stored)stored.count+=amount;else bank.push({...entries[0]!,slot:bank.length,count:amount});generation++;return{success:true};
   },openShop:async()=>{calls.push('openShop');return{success:false}}},
  direct:async(a:{type:string})=>{calls.push('direct:'+a.type);if(a.type==='closeModal')modal=false;return{success:true};}};
 const timer=setInterval(()=>{tick++;for(const cb of [...callbacks])cb();},1);
 return{s:s as unknown as Session,calls,stop:()=>clearInterval(timer),inventory,bank};
}
const options={target:12,maxCasts:100,cap:500,budget:0,reserve:0};
test('target timeout logs nearby NPC rows once before returning the combat stall',async()=>{
 const entry={x:CAST_SITE.x,z:CAST_SITE.z,magic:{level:70,xp:magicXpForLevel(70)},
  bank:[{id:AIR,count:2},{id:MIND,count:1}]};
 const f=fakeSession(entry),s=f.s as any,oldState=s.sdk.getState;
 const npcs=[{index:1,name:'Man',x:3237,z:3406,distance:7,hp:7,inCombat:false,reachable:false,
  optionsWithIndex:[{text:'Attack',opIndex:2}]}];
 s.sdk.getState=()=>({...oldState(),nearbyNpcs:npcs});
 const walker=spyOn(walking,'sessionWalker').mockResolvedValue({} as any);
 const route=spyOn(walking,'walkPath').mockImplementation(async(_deps,points)=>{
  const p=points.at(-1)!;entry.x=p.x;entry.z=p.z;return{ok:true,ticks:1,still:0,clicks:1,repaths:0,doors:0,next:points.length};
 });
 const log=spyOn(console,'log').mockImplementation(()=>{});
 try{
  const r=await runMagicOrder(f.s,{...options,target:75});
  expect(r.stop).toBe('combat stall');expect(r.casts).toBe(0);expect(r.ok).toBe(false);
  expect(r.failure).toContain('no safe target near the cast site');
  const rows=log.mock.calls.filter(([line])=>String(line).startsWith('MAGIC_ORDER_TARGET_STALL '));
  expect(rows).toHaveLength(1);
  const snapshot=JSON.parse(String(rows[0]![0]).slice('MAGIC_ORDER_TARGET_STALL '.length));
  expect(snapshot.idle).toBe(CAST.targetWaitTicks);
  expect(snapshot.position).toEqual({x:CAST_SITE.x,z:CAST_SITE.z,level:0});
  expect(snapshot.nearbyNpcs).toEqual(npcs.map(({distance,...npc})=>npc));
  expect(f.calls).not.toContain('direct:spellOnNpc');
  expect(f.bank.find(i=>i.id===AIR)?.count).toBe(2);
  expect(f.bank.find(i=>i.id===MIND)?.count).toBe(1);
 }finally{log.mockRestore();route.mockRestore();walker.mockRestore();f.stop();}
});
test('level70 without laws reaches Wind Strike from Draynor and refuses unfunded runes',async()=>{
 for(const funded of [true,false]){
  const entry={x:3092,z:3242,magic:{level:70,xp:magicXpForLevel(71)-1},
   pack:[{id:590,count:1}],bank:[{id:AIR,count:2},{id:COINS,count:300},...(funded?[{id:MIND,count:1}]:[])]};
  const f=fakeSession(entry),s=f.s as any,oldState=s.sdk.getState,oldDirect=s.direct;
  const walker=spyOn(walking,'sessionWalker').mockResolvedValue({} as any);
  const route=spyOn(walking,'walkPath').mockImplementation(async(_deps,points)=>{
   const p=points.at(-1)!;entry.x=p.x;entry.z=p.z;return{ok:true,ticks:1,still:0,clicks:1,repaths:0,doors:0,next:points.length};
  });
  let casts=0;
  s.sdk.getState=()=>({...oldState(),nearbyNpcs:[{index:1,name:'Man',x:CAST_SITE.x,z:CAST_SITE.z,distance:1,hp:7,inCombat:false,optionsWithIndex:[{text:'Attack',opIndex:2}]}]});
  s.direct=async(action:any)=>{
   if(action.type!=='spellOnNpc')return oldDirect(action);
   casts++;expect(entry.x).toBe(CAST_SITE.x);expect(entry.z).toBe(CAST_SITE.z);
   for(const id of [AIR,MIND])f.inventory.find(i=>i.id===id)!.count--;
   for(let i=f.inventory.length-1;i>=0;i--)if(f.inventory[i]!.count===0)f.inventory.splice(i,1);
   const magic=s.sdk.getSkill('Magic');magic.experience+=137.5;magic.baseLevel=magic.level=71;
   return{success:true};
  };
  try{
   const r=await runMagicOrder(f.s,{...options,target:71});
   expect(r.teleportRunesUsed).toBeUndefined();expect(r.failure).toBeUndefined();
   expect(r.ok).toBe(funded);expect(r.stop).toBe(funded?'target':'short runes');
   expect(casts).toBe(funded?1:0);expect(r.coinsSpent).toBe(0);
   expect(f.inventory.find(i=>i.id===590)?.count).toBe(1);
   if(funded){expect(r.magicXpGained).toBe(137.5);expect(r.runesUsed).toEqual({air:1,mind:1});}
   else expect(r.missing).toEqual({air:0,mind:1});
  }finally{route.mockRestore();walker.mockRestore();f.stop();}
 }
});
test('worker buys only one missing earth then completes five casts and banks the remaining assets',async()=>{
 const entry={x:3185,z:3436,magic:{level:31,xp:8125},pack:[{id:590,count:1}],
  bank:[{id:AIR,count:25},{id:557,count:4},{id:563,count:5},{id:COINS,count:14911}]};
 const f=fakeSession(entry),s=f.s as any;
 const oldState=s.sdk.getState,oldDirect=s.direct;
 let shopOpen=false;
 const stock={id:557,name:'Earth rune',count:2000,baseCost:4};
 const walker=spyOn(walking,'sessionWalker').mockResolvedValue({} as any);
 const route=spyOn(walking,'walkPath').mockImplementation(async(_deps,points)=>{
  const p=points.at(-1)!;entry.x=p.x;entry.z=p.z;return{ok:true,ticks:1,still:0,clicks:1,repaths:0,doors:0,next:points.length};
 });
 const purchases:{name:string;amount:number}[]=[];
 const held=(id:number)=>f.inventory.find(i=>i.id===id)!;
 s.sdk.getState=()=>({...oldState(),player:{...oldState().player,animId:-1},
  nearbyNpcs:[{name:'Aubury'}],shop:{isOpen:shopOpen,shopItems:[stock],shopConfig:{sellMultiplier:1000}}});
 s.bot.openShop=async()=>{shopOpen=true;return{success:true};};
 s.bot.closeShop=async()=>{shopOpen=false;return{success:true};};
 s.bot.buyFromShop=async(name:RegExp,amount:number)=>{
  purchases.push({name:name.source,amount});expect(name.test('Earth rune')).toBe(true);
  held(557).count+=amount;held(COINS).count-=4*amount;stock.count-=amount;return{success:true};
 };
 // Give all rune rows their SDK names so the real shared buyer observes the credit.
 const withdraw=s.bot.withdrawItem;
 s.bot.withdrawItem=async(item:any,n:number)=>{const r=await withdraw(item,n);if(item.id===557)held(557).name='Earth rune';return r;};
 s.direct=async(action:any)=>{
  if(action.type!=='clickComponent')return oldDirect(action);
  expect(shopOpen).toBe(false);
  held(AIR).count-=3;held(557).count--;held(563).count--;
  for(let i=f.inventory.length-1;i>=0;i--)if(f.inventory[i]!.count===0)f.inventory.splice(i,1);
  const magic=s.sdk.getSkill('Magic');magic.experience+=1025;
  while(magic.baseLevel<99&&magic.experience>=magicXpForLevel(magic.baseLevel+1))magic.baseLevel++;
  magic.level=magic.baseLevel;entry.x=3221;entry.z=3218;return{success:true};
 };
 try{
  const r=await runMagicOrder(f.s,{target:37,maxCasts:5,cap:6000,budget:1000,reserve:10000});
  expect(r.ok).toBe(true);expect(r.level).toBe(37);expect(r.casts).toBe(5);
  expect(purchases).toHaveLength(1);expect(purchases[0]!.amount).toBe(1);expect(r.coinsSpent).toBe(4);
  expect(r.teleportRunesBought?.earth).toBe(1);expect(r.teleportRunesUsed?.earth).toBe(5);
  expect(f.inventory).toHaveLength(0);
  expect(f.bank.find(i=>i.id===COINS)?.count).toBe(14907);expect(f.bank.find(i=>i.id===AIR)?.count).toBe(10);
  expect(f.bank.find(i=>i.id===590)?.count).toBe(1);
 }finally{route.mockRestore();walker.mockRestore();f.stop();}
});
for(const scenario of ['delayed','missing','depleted','over-budget','reserve','stop','cap'] as const)test(`Falador shop quote ${scenario} preserves the finite purchase and asset bounds`,async()=>{
 const entry={x:3185,z:3436,magic:{level:37,xp:13250},pack:[{id:590,count:1}],
  bank:[{id:AIR,count:10},{id:555,count:6},{id:563,count:8},{id:COINS,count:7027}]};
 const f=fakeSession(entry),s=f.s as any,oldState=s.sdk.getState,oldDirect=s.direct;
 let shopOpen=false,openedAt=-1,closedAt=-1,opens=0;
 const rows=[{id:AIR,name:'Air rune',count:2000,baseCost:4},{id:555,name:'Water rune',count:2000,baseCost:4}];
 const stock=()=>scenario==='missing'?[]:rows.slice(0,s.tick()-openedAt>=3?2:s.tick()-openedAt>=1?1:0);
 if(scenario==='depleted')rows[1]!.count=1;
 if(scenario==='over-budget')rows[1]!.baseCost=100;
 const walker=spyOn(walking,'sessionWalker').mockResolvedValue({} as any);
 const route=spyOn(walking,'walkPath').mockImplementation(async(_deps,points)=>{
  const p=points.at(-1)!;entry.x=p.x;entry.z=p.z;return{ok:true,ticks:1,still:0,clicks:1,repaths:0,doors:0,next:points.length};
 });
 const logs:string[]=[];
 const log=spyOn(console,'log').mockImplementation((line)=>{logs.push(String(line));});
 const held=(id:number)=>f.inventory.find(i=>i.id===id)!;
 const purchases:number[]=[];
 s.sdk.getState=()=>({...oldState(),player:{...oldState().player,animId:-1},nearbyNpcs:[{name:'Aubury'}],
  shop:{isOpen:shopOpen,shopItems:stock(),shopConfig:{sellMultiplier:1000}}});
 s.bot.openShop=async()=>{opens++;shopOpen=true;openedAt=s.tick();return{success:true};};
 s.bot.closeShop=async()=>{closedAt=s.tick();shopOpen=false;return{success:true};};
 for(const item of f.bank){const row=rows.find(i=>i.id===item.id);if(row)item.name=row.name;}
 s.bot.buyFromShop=async(name:RegExp,amount:number)=>{
  expect(s.tick()-openedAt).toBeGreaterThanOrEqual(3);
  const row=rows.find(i=>name.test(i.name))!;purchases.push(row.id);
  held(row.id).count+=amount;held(COINS).count-=4*amount;row.count-=amount;return{success:true};
 };
 s.direct=async(action:any)=>{
  if(action.type!=='clickComponent')return oldDirect(action);
  expect(shopOpen).toBe(false);
  const t=TELEPORTS.find(t=>t.name==='falador')!;
  for(const [k,id] of Object.entries(TELE_RUNE_IDS))if(t.costs[k as keyof RuneCounts])held(id).count-=t.costs[k as keyof RuneCounts];
  for(let i=f.inventory.length-1;i>=0;i--)if(f.inventory[i]!.count===0)f.inventory.splice(i,1);
  const magic=s.sdk.getSkill('Magic');magic.experience+=1200;
  while(magic.baseLevel<99&&magic.experience>=magicXpForLevel(magic.baseLevel+1))magic.baseLevel++;
  magic.level=magic.baseLevel;entry.x=t.to.x;entry.z=t.to.z;return{success:true};
 };
 try{
  const r=await runMagicOrder(f.s,{target:45,maxCasts:8,cap:scenario==='cap'?2:6000,budget:500,reserve:scenario==='reserve'?6700:5000},
   ()=>scenario==='stop'&&openedAt>=0&&s.tick()-openedAt>=2);
  expect(opens).toBe(1);expect(shopOpen).toBe(false);
  expect(closedAt-openedAt).toBeLessThanOrEqual(10);
  const quote=JSON.parse(logs.find(l=>l.startsWith('MAGIC_ORDER_QUOTE '))?.slice('MAGIC_ORDER_QUOTE '.length)??'null');
  if(scenario==='delayed'){
   expect(r.ok).toBe(true);expect(r.level).toBe(45);expect(r.casts).toBe(8);expect(r.coinsSpent).toBe(64);
   expect(r.teleportRunesBought).toMatchObject({air:14,water:2});
   expect(r.teleportRunesUsed).toMatchObject({air:24,water:8,law:8});expect(purchases).toEqual([AIR,555]);
   expect(quote).toMatchObject({cost:384,allowance:500,missing:{air:14,water:2}});
  }else{
   expect(r.ok).toBe(false);expect(r.casts).toBe(0);expect(r.coinsSpent).toBe(0);expect(purchases).toEqual([]);
   if(scenario==='stop'||scenario==='cap')expect(r.stop).toBe(scenario==='stop'?'stop requested':'cap');
   else{
    expect(closedAt-openedAt).toBe(10);expect(r.failure).toContain('Aubury teleport stock or budget shortfall');
    expect(quote).toMatchObject({cost:null,allowance:scenario==='reserve'?327:500,missing:{air:14,water:2}});
    expect(quote.shelf).toEqual(stock());
   }
  }
  expect(f.inventory).toHaveLength(0);expect(f.bank.find(i=>i.id===590)?.count).toBe(1);
  expect(f.bank.find(i=>i.id===COINS)?.count).toBe(7027-r.coinsSpent);
  for(const [id,n] of [[AIR,10],[555,6],[563,8]])expect(f.bank.find(i=>i.id===id)?.count).toBe(scenario==='delayed'?0:n);
  expect(s.sdk.getSkill('Hitpoints').level).toBe(10);
 }finally{log.mockRestore();route.mockRestore();walker.mockRestore();f.stop();}
});

test('teleport entry banks duplicate food slots and quest cargo once, then honors stop before casting',async()=>{
 const f=fakeSession({x:3185,z:3436,magic:{level:31,xp:8125},pack:[{id:333,count:1},{id:333,count:1},{id:333,count:1},{id:431,count:1}],
  bank:[{id:AIR,count:25},{id:557,count:5},{id:563,count:5}]});
 try{
  const r=await runMagicOrder(f.s,{...options,target:37},()=>f.calls.includes('withdraw'));
  expect(r.stop).toBe('stop requested');expect(r.casts).toBe(0);expect(r.failure).toBeUndefined();
  expect(f.calls.filter(c=>c==='deposit:333')).toHaveLength(1);
  expect(f.calls.filter(c=>c==='deposit:431')).toHaveLength(1);
  expect(f.bank.find(i=>i.id===333)?.count).toBe(3);expect(f.bank.find(i=>i.id===431)?.count).toBe(1);
  expect(f.calls.some(c=>c==='direct:clickComponent')).toBe(false);
  expect(f.inventory).toHaveLength(0);
 }finally{f.stop();}
});
test('a stop received during modal closure prevents the teleport dispatch',async()=>{
 const f=fakeSession({x:3185,z:3436,magic:{level:31,xp:8125},modal:true,bank:[{id:AIR,count:25},{id:557,count:5},{id:563,count:5}]});
 try{
  const r=await runMagicOrder(f.s,{...options,target:37},()=>f.calls.includes('direct:closeModal'));
  expect(r.stop).toBe('stop requested');expect(r.casts).toBe(0);expect(r.failure).toBeUndefined();
  expect(f.calls).toContain('direct:closeModal');expect(f.calls).not.toContain('direct:clickComponent');
 }finally{f.stop();}
});
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
