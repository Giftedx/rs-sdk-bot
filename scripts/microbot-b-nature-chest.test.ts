import {test,expect} from 'bun:test';
import {chestEffect,chestOptions,runNatureChest} from './microbot-b-nature-chest';
import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';
const state=(n=0,coins=n*3,xp=n*25)=>({player:{worldX:2673,worldZ:3301,level:1,lifeId:1},skills:[{name:'Thieving',level:28,experience:xp},{name:'Hitpoints',level:10,experience:1000}],inventory:[{id:561,count:n,slot:0},{id:995,count:coins,slot:1},{id:1735,count:1,slot:2}],nearbyLocs:[{id:2567,x:2673,z:3301,level:1,optionsWithIndex:[{text:'Open',opIndex:1},{text:'Search for traps',opIndex:2}]}]} as unknown as BotWorldState);
const options={x:2673,z:3301,level:1,maxLoots:2,cap:100,idleTicks:40};
test('options require explicit native location and finite limits',()=>{
 expect(()=>chestOptions({})).toThrow('CHEST_X');
 expect(()=>chestOptions({CHEST_X:'1',CHEST_Z:'2',CHEST_LEVEL:'1',MAX_LOOTS:'NaN'})).toThrow('MAX_LOOTS');
 expect(chestOptions({CHEST_X:'1',CHEST_Z:'2',CHEST_LEVEL:'1'}).maxLoots).toBe(10);
});
test('reward requires both items, XP and intact assets',()=>{
 expect(chestEffect(state(),state())).toBe(false);
 expect(chestEffect(state(),state(1))).toBe(true);
 expect(()=>chestEffect(state(),state(1,2))).toThrow('reconcile');
 expect(()=>chestEffect(state(),state(1,3,0))).toThrow('reconcile');
 const lost=state(1);lost.inventory.pop();expect(()=>chestEffect(state(),lost)).toThrow('assets');
});
test('finite consumer uses traps option and exact output; stop prevents dispatch',async()=>{
 let current=state(),tick=0,actions:number[]=[];
 const d={state:()=>current,tick:()=>tick,stopped:()=>false,act:async(_x:number,_z:number,id:number,op:number)=>{expect(id).toBe(2567);actions.push(op);current=state(actions.length);return{success:true};},wait:async(p:()=>boolean,_t:number)=>p(),step:async()=>{tick++;}};
 expect(await runNatureChest(d,options)).toEqual({loots:2,natureRunes:2,coins:6,ticks:1});expect(actions).toEqual([2,2]);
 await expect(runNatureChest({...d,stopped:()=>true},options)).rejects.toThrow('stopped');expect(actions.length).toBe(2);
});
test('wrong floor, no reward and idle chest terminate',async()=>{
 let current=state(),tick=0;
 const d={state:()=>current,tick:()=>tick,stopped:()=>false,act:async()=>({success:true}),wait:async()=>false,step:async()=>{tick++;}};
 await expect(runNatureChest(d,{...options,level:0})).rejects.toThrow('floor');
 await expect(runNatureChest(d,options)).rejects.toThrow('unobserved');
 current={...state(),nearbyLocs:[]};await expect(runNatureChest(d,{...options,idleTicks:2})).rejects.toThrow('no progress');
});
