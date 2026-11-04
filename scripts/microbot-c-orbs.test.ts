import {expect,test} from 'bun:test';
import {orbEffect,orbRecipes,chargeInventory,orbStopRequested} from './microbot-c-orbs';
import {spellOnNativeLoc,installSpellLocBridge} from './microbot-c-spell-loc';
import {elementalRuneCost} from './microbot-magic-items';
test('native spell location encodes route then OPLOCT x,z,loc,spell',()=>{
 const calls:any[]=[];
 const c={isInGame:()=>true,localPlayer:{},toSceneTile:()=>({x:4,z:7}),locSceneInfo:()=>({shape:10,angle:0}),routeToLoc:(...a:any[])=>{calls.push(['route',...a]);return true;},writeOpcode:(n:number)=>calls.push(['opcode',n]),out:{p2:(n:number)=>calls.push(['p2',n])}};
 expect(spellOnNativeLoc(c,3000,4000,2152,1186)).toEqual({success:true,routed:true});
 expect(calls).toEqual([['route',4,7,2152],['opcode',218],['p2',3000],['p2',4000],['p2',2152],['p2',1186]]);
 expect(()=>spellOnNativeLoc({...c,locSceneInfo:()=>null},3000,4000,2152,1186)).toThrow('target absent');
 expect(()=>spellOnNativeLoc(null,3000,4000,2152,1186)).toThrow('requires native');
});
test('orb conversion reconciles both runes, orb and XP',()=>{
 const before={raw:2,product:0,cosmic:6,element:60,xp:1},after={raw:1,product:1,cosmic:3,element:30,xp:77};
 expect(orbEffect(before,after)).toBe(true);
 expect(orbEffect(before,{...after,cosmic:6})).toBe(false);
 expect(orbEffect(before,{...after,element:60})).toBe(false);
 expect(orbEffect(before,{...after,xp:1})).toBe(false);
 expect(Object.keys(orbRecipes)).toHaveLength(4);
 const staffCost=elementalRuneCost(556,30,[{id:1381,slot:3}]);expect(staffCost).toBe(0);
 expect(orbEffect(before,{...after,element:60},staffCost)).toBe(true);
 expect(elementalRuneCost(556,30,[{id:1381,slot:5}])).toBe(30);
});
test('invalid orb order accesses no session',async()=>{await expect(chargeInventory(null as any,'air',0,20)).rejects.toThrow('invalid orb order');});
test('finite orb order confirms conversions and preserves unrelated stock',async()=>{
 const items=[{id:567,count:3},{id:573,count:1},{id:564,count:12},{id:556,count:120},{id:995,count:9}];let xp=100,words=0;
 const client={executeBotAction:(_:unknown)=>({success:false}),isInGame:()=>true,localPlayer:{},toSceneTile:()=>({x:1,z:2}),locSceneInfo:()=>({shape:10}),routeToLoc:()=>true,writeOpcode:()=>{},out:{p2:()=>{if(++words%4===0){items[0]!.count--;items[1]!.count++;items[2]!.count-=3;items[3]!.count-=30;xp+=76;}}}};
 let tick=0;const s:any={client,direct:(a:unknown)=>client.executeBotAction(a),tick:()=>tick,onTick:(cb:()=>void)=>{let active=true;const next=()=>queueMicrotask(()=>{if(active){tick++;cb();next();}});next();return()=>{active=false;};},sdk:{getInventory:()=>items,getEquipment:()=>[],getSkill:()=>({baseLevel:66,level:66}),getSkillXp:()=>xp,getState:()=>({player:{lifeId:1},nearbyLocs:[{id:2152,x:3000,z:4000}]})}};
 const result=await chargeInventory(s,'air',2,80);expect(result).toMatchObject({ok:true,made:2,preserved:true});expect(words).toBe(8);expect(items[4]!.count).toBe(9);
});
test('instance executor bridge delegates other actions and restores method',()=>{
 const original=(a:any)=>a.type;const client={executeBotAction:original};const restore=installSpellLocBridge(client);
 expect(client.executeBotAction({type:'closeModal'})).toBe('closeModal');restore();expect(client.executeBotAction).toBe(original);
});

test('CLI global stop callback prevents a second real charge action',async()=>{
 const items=[{id:567,count:2},{id:573,count:0},{id:564,count:6},{id:556,count:60}];let xp=100,words=0,globalStop=false,tick=0;
 const client={executeBotAction:(_:unknown)=>({success:false}),isInGame:()=>true,localPlayer:{},toSceneTile:()=>({x:1,z:2}),locSceneInfo:()=>({shape:10}),routeToLoc:()=>true,writeOpcode:()=>{},out:{p2:()=>{if(++words%4===0){items[0]!.count--;items[1]!.count++;items[2]!.count-=3;items[3]!.count-=30;xp+=76;globalStop=true;}}}};
 const s:any={client,direct:(a:unknown)=>client.executeBotAction(a),tick:()=>tick,onTick:(cb:()=>void)=>{let active=true;const next=()=>queueMicrotask(()=>{if(active){tick++;cb();next();}});next();return()=>{active=false;};},sdk:{getInventory:()=>items,getEquipment:()=>[],getSkill:()=>({baseLevel:66,level:66}),getSkillXp:()=>xp,getState:()=>({player:{lifeId:1},nearbyLocs:[{id:2152,x:3000,z:4000}]})}};
 const stop=()=>orbStopRequested('fixture',false,path=>path==='.practice/stop-all'&&globalStop,'');
 expect(stop()).toBe(false);const result=await chargeInventory(s,'air',2,80,stop);expect(result.ok).toBe(false);expect(result.made).toBe(1);expect(words).toBe(4);expect(items[0]!.count).toBe(1);expect(stop()).toBe(true);
});

import{orbInputOwner}from'./microbot-orb-trip';
test('actual paid orb charge loses input ownership without a second cast or cleanup dispatch',async()=>{
 const items=[{id:567,count:2},{id:573,count:0},{id:564,count:6},{id:556,count:60}];let xp=100,words=0,foreignInputs=0,tick=0;const foreign=()=>{foreignInputs++;return{success:true};};
 const client:any={executeBotAction:(_:unknown)=>({success:false}),isInGame:()=>true,localPlayer:{},toSceneTile:()=>({x:1,z:2}),locSceneInfo:()=>({shape:10}),routeToLoc:()=>true,writeOpcode:()=>{},out:{p2:()=>{if(++words%4===0){items[0]!.count--;items[1]!.count++;items[2]!.count-=3;items[3]!.count-=30;xp+=76;client.executeBotAction=foreign;}}}};
 const s:any={client,direct:(a:unknown)=>client.executeBotAction(a),tick:()=>tick,onTick:(cb:()=>void)=>{let active=true;const next=()=>queueMicrotask(()=>{if(active){tick++;cb();next();}});next();return()=>{active=false;};},sdk:{getInventory:()=>items,getEquipment:()=>[],getSkill:()=>({baseLevel:66,level:66}),getSkillXp:()=>xp,getState:()=>({player:{lifeId:1},nearbyLocs:[{id:2152,x:3000,z:4000}]})}},owner=orbInputOwner(s);
 const r=await chargeInventory(s,'air',2,80,()=>!owner.valid(),()=>owner.scoped(()=>installSpellLocBridge(client)));expect(r.ok).toBe(false);expect(r.made).toBe(1);expect(words).toBe(4);expect(owner.valid()).toBe(false);expect(client.executeBotAction).toBe(foreign);expect(foreignInputs).toBe(0);
 // This is the same fatal predicate used by trip finally before TP/bank/control cleanup.
 if(owner.valid())await s.direct({type:'closeModal'});expect(foreignInputs).toBe(0);
});
