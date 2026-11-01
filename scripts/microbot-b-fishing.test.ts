import {test,expect} from 'bun:test';
import {fishSpotIds,pickFishSpot,runStagedFishing,karambwanLoadEffect,karambwanAttemptEffect,type FishDriver} from './microbot-b-fishing';
import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';
const item=(id:number,count=1,slot=0)=>({id,count,slot});
const state=(method:'fly'|'karambwan',inventory:ReturnType<typeof item>[],xp=0)=>({player:{worldX:2899,worldZ:3118,level:0,lifeId:1},inventory,skills:[{name:'Fishing',level:65,experience:xp},{name:'Hitpoints',level:10,experience:1000}],nearbyNpcs:[{index:1,id:fishSpotIds(method)[0],x:2900,z:3118,distance:1,optionsWithIndex:[{text:method==='fly'?'Lure':'Fish',opIndex:1}]}]} as unknown as BotWorldState);
const options={method:'fly' as const,amount:2,cap:100,maxAttempts:10,progressTicks:40};
test('native spot categories exclude lookalike shrimp and quest-only spots',()=>{
 expect(fishSpotIds('karambwan')).toEqual([1176,1177,1178]);
 expect(fishSpotIds('karambwanji')).toEqual([1174,1175]);
 const s=state('fly',[item(309),item(314,10,1)]);expect(pickFishSpot(s,'fly')?.index).toBe(1);
 s.nearbyNpcs[0]!.id=fishSpotIds('net')[0]!;expect(pickFishSpot(s,'fly')).toBeUndefined();
});
test('fly fishing counts native catches and exact feather debit without repeated clicks',async()=>{
 let current=state('fly',[item(309),item(314,10,1)]),tick=0,actions=0,caught=0;
 const d:FishDriver={state:()=>current,tick:()=>tick,stopped:()=>false,interact:async()=>{actions++;return{success:true};},combine:async()=>({success:true}),step:async()=>{tick++;},wait:async(test)=>{tick++;caught++;current=state('fly',[item(309),item(314,10-caught,1),item(335,caught,2)],caught*50);return test();}};
 expect(await runStagedFishing(d,options)).toEqual({caught:2,baitUsed:2,attempts:1,ticks:3});expect(actions).toBe(1);
});
test('karambwan vessel transitions distinguish a missed roll from a catch',()=>{
 const before=state('karambwan',[item(3157),item(3150,1,1)]),loaded=state('karambwan',[item(3159)]);
 expect(karambwanLoadEffect(before,loaded)).toBe(true);
 expect(karambwanAttemptEffect(loaded,state('karambwan',[item(3157)]))).toBe(0);
 expect(karambwanAttemptEffect(loaded,state('karambwan',[item(3157),item(3142,1,1)],105))).toBe(1);
 expect(()=>karambwanAttemptEffect(loaded,state('karambwan',[item(3157),item(3142,1,1)]))).toThrow('reconcile');
});
test('karambwan finite job reloads each consumed single bait and limits missed attempts',async()=>{
 let current=state('karambwan',[item(3157),item(3150,1,1)]),tick=0;
 const d:FishDriver={state:()=>current,tick:()=>tick,stopped:()=>false,interact:async()=>{current=state('karambwan',[item(3157),item(3142,1,1)],105);return{success:true};},combine:async()=>{current=state('karambwan',[item(3159)]);return{success:true};},step:async()=>{tick++;},wait:async(test)=>{tick++;return test();}};
 expect(await runStagedFishing(d,{...options,method:'karambwan',amount:1})).toEqual({caught:1,baitUsed:1,attempts:1,ticks:2});
});
test('stops, missing bait and no progress do not run forever',async()=>{
 let current=state('fly',[item(309),item(314,1,1)]),tick=0,actions=0;
 const d:FishDriver={state:()=>current,tick:()=>tick,stopped:()=>true,interact:async()=>{actions++;return{success:true};},combine:async()=>({success:true}),step:async()=>{tick++;},wait:async()=>{tick+=10;return false;}};
 await expect(runStagedFishing(d,options)).rejects.toThrow('stopped');expect(actions).toBe(0);
 current=state('fly',[item(309)]);await expect(runStagedFishing({...d,stopped:()=>false},options)).rejects.toThrow('bait');
 current=state('fly',[item(309),item(314,1,1)]);await expect(runStagedFishing({...d,stopped:()=>false},options)).rejects.toThrow('no progress');
});
