import {test,expect} from 'bun:test';
import {selectGroundLoot,lootCapacity,groundLootEffect,runVisibleGroundLoot,type LootPolicy,type LootDriver} from './microbot-b-mining-loot';
import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';
const policy:LootPolicy={mode:'list',ids:[561],names:[],minimumValue:1,maximumValue:100000,radius:2,maximumUnits:3,cap:100,idleTicks:10};
const state=()=>({player:{worldX:3000,worldZ:3500,level:0,lifeId:1},skills:[{name:'Hitpoints',level:10}],equipment:[],inventory:[{id:995,count:9,slot:0}],nearbyPlayers:[],groundItems:[{id:561,name:'Nature rune',count:3,x:3001,z:3500,distance:1,reachable:true}]} as unknown as BotWorldState);
test('ground selection combines exact IDs/names with explicitly static pile value',()=>{
 const s=state(),definition=()=>({cost:180,stackable:true});expect(selectGroundLoot(s,policy,definition)?.value).toBe(540);
 expect(selectGroundLoot(s,{...policy,ids:[],names:['nature rune']},definition)?.item.id).toBe(561);
 expect(selectGroundLoot(s,{...policy,ids:[],names:['rune']},definition)).toBeUndefined();
 expect(selectGroundLoot(s,{...policy,mode:'value',minimumValue:541},definition)).toBeUndefined();
 expect(selectGroundLoot(s,{...policy,mode:'mixed',ids:[],names:[]},definition)?.item.id).toBe(561);
 s.nearbyPlayers=[{x:3001,z:3500} as any];expect(selectGroundLoot(s,policy,definition)).toBeUndefined();
});
test('capacity distinguishes full-pack existing stacks from nonstackable piles',()=>{
 const s=state(),i=s.groundItems[0]!;s.inventory=Array.from({length:28},(_,slot)=>({id:slot===0?561:1000+slot,count:1,slot} as any));
 expect(lootCapacity(s,i,{cost:1,stackable:true})).toBe(true);expect(lootCapacity(s,i,{cost:1,stackable:false})).toBe(false);
 s.inventory=s.inventory.slice(0,26);expect(lootCapacity(s,i,{cost:1,stackable:false})).toBe(false);s.inventory.pop();expect(lootCapacity(s,i,{cost:1,stackable:false})).toBe(true);
});
test('own inventory receipt rejects disappearance alone and unrelated asset loss',()=>{
 const b=state(),a=structuredClone(b);a.groundItems=[];expect(groundLootEffect(b,a,b.groundItems[0]!)).toBe(false);
 a.inventory.push({id:561,count:3,slot:1} as any);expect(groundLootEffect(b,a,b.groundItems[0]!)).toBe(true);a.inventory[0]!.count--;expect(()=>groundLootEffect(b,a,b.groundItems[0]!)).toThrow('reconcile');
});
test('finite pickup reports held output and refuses a contested disappearance',async()=>{
 let current=state(),tick=0,actions=0;
 const d:LootDriver={state:()=>current,tick:()=>tick,stop:()=>false,definition:()=>({cost:180,stackable:true}),pickup:async()=>{actions++;current=structuredClone(current);current.inventory.push({id:561,count:3,slot:1} as any);current.groundItems=[];return true;},wait:async test=>test(),step:async()=>{tick++;}};
 expect(await runVisibleGroundLoot(d,policy)).toMatchObject({units:3,pickups:1,acquired:{561:3},staticValue:540,banked:0});expect(actions).toBe(1);
 current=state();await expect(runVisibleGroundLoot({...d,pickup:async()=>{current={...current,groundItems:[]};return true;}},policy)).rejects.toThrow('without own inventory');
});

test('skips a pickup address whose same-ID piles have different counts', () => {
 const s = state();
 const first = s.groundItems[0]!;
 const definition = () => ({cost:180,stackable:true});
 s.groundItems.push({...first,count:16});
 expect(selectGroundLoot(s,policy,definition)).toBeUndefined();
 s.groundItems[1]!.count = first.count;
 expect(selectGroundLoot(s,policy,definition)?.item.count).toBe(first.count);
});
