import {test,expect} from 'bun:test';
import {fishSpotIds,pickFishSpot,runStagedFishing,searchNativeCatherbyFishing,catherbyFishingSearchPoints,karambwanLoadEffect,karambwanAttemptEffect,type FishDriver} from './microbot-b-fishing';
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
test('wrong-type-only window searches native shore then dispatches only a later compatible Cage spot',async()=>{
 let tick=0,searches=0,actions=0;const make=(correct=false,caught=0)=>({...state('fly',[item(301),...caught?[item(377,caught,1)]:[]],caught*90),nearbyNpcs:[{index:correct?7:1,id:correct?321:320,x:2860,z:3426,distance:2,reachable:true,optionsWithIndex:[{text:correct?'Cage':'Net',opIndex:1}]}]})as unknown as BotWorldState;let current=make();
 const d:FishDriver={state:()=>current,tick:()=>tick,stopped:()=>false,interact:async(index,op)=>{expect(index).toBe(7);expect(op).toBe(1);actions++;return{success:true};},combine:async()=>({success:true}),step:async()=>{tick++;},wait:async(test)=>{tick++;current=make(true,1);return test();},search:async(pass,stop)=>{expect(stop()).toBe(false);searches++;tick+=3;if(pass===1)current=make(true);return true;}};
 const result=await runStagedFishing(d,{method:'cage',amount:1,cap:100,maxAttempts:5,progressTicks:40});expect(result.caught).toBe(1);expect(actions).toBe(1);expect(searches).toBe(2);expect(tick).toBeLessThan(12);expect(catherbyFishingSearchPoints()).toEqual([{x:2836,z:3431,level:0},{x:2846,z:3429,level:0},{x:2860,z:3426,level:0}]);
});
test('absent compatible type and cancellation bound searches without dispatching wrong categories',async()=>{
 for(const stoppedAt of [2,100]){let tick=0,searches=0,actions=0;const current=state('fly',[item(301)]);current.nearbyNpcs[0]!.id=320;const d:FishDriver={state:()=>current,tick:()=>tick,stopped:()=>tick>=stoppedAt,interact:async()=>{actions++;return{success:true};},combine:async()=>({success:true}),step:async()=>{tick++;},wait:async()=>false,search:async(_pass,stop)=>{searches++;tick++;stop();return true;}};await expect(runStagedFishing(d,{method:'cage',amount:1,cap:100,maxAttempts:5,progressTicks:40})).rejects.toThrow();expect(actions).toBe(0);expect(searches).toBeLessThanOrEqual(3);expect(tick).toBeLessThanOrEqual(3);}
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

test('native search rejects unwalkable shore and stop without sending an NPC action',async()=>{
 let paths=0;const s:any={sdk:{getState:()=>({player:{worldX:2839,worldZ:3432,level:0},nearbyNpcs:[]}),findPath:()=>{paths++;return{success:false,reachedDestination:false};}}};
 expect(await searchNativeCatherbyFishing(s,'cage',0,()=>false)).toBe(false);expect(paths).toBe(9);paths=0;expect(await searchNativeCatherbyFishing(s,'cage',0,()=>true)).toBe(false);expect(paths).toBe(0);expect(await searchNativeCatherbyFishing(s,'cage',3,()=>false)).toBe(false);
});