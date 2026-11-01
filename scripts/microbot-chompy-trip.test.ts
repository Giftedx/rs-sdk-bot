import {test,expect} from 'bun:test';
import {CHOMPY_TRIP,chompyRouteJob,chompyTripAssets,runChompyTrip,restoreChompyStyle} from './microbot-chompy-trip';
test('Chompy route reserves return time and keeps batches within native hunter limits',()=>{
 expect(chompyRouteJob({kills:2,perTrip:1,cap:5000,returnTicks:800})).toMatchObject({family:'chompy',target:2,batch:1,members:true});
 expect(()=>chompyRouteJob({kills:2,perTrip:6,cap:5000,returnTicks:800})).toThrow();expect(()=>chompyRouteJob({kills:2,perTrip:1,cap:800,returnTicks:800})).toThrow();
});
test('Chompy asset audit accounts for gas refill, bait charges, raw meat, feathers and net arrows',()=>{
 const before=new Map([[2871,1],[2883,1],[2866,32],[995,42]]),after=new Map([[2873,1],[2883,1],[2866,31],[2876,1],[314,10],[995,42]]),r={kills:1,baits:1,raw:1,feathers:10,rangedXp:40};
 expect(chompyTripAssets(before,after,r)).toEqual({ammoUsed:1,baits:1,fills:1,raw:1,feathers:10,rangedXp:40});
 for(const [id,n]of [[2873,2],[995,41],[2876,0],[314,30],[2866,33]]){const wrong=new Map(after);wrong.set(id!,n!);expect(()=>chompyTripAssets(before,wrong,r)).toThrow('reconcile');}
 expect(()=>chompyTripAssets(before,after,{...r,rangedXp:39})).toThrow('reconcile');
});
test('a partly used bellows is preserved rather than requiring a new empty pair each bank trip',()=>{
 const before=new Map([[2873,1],[2883,1],[2866,32]]),after=new Map([[2874,1],[2883,1],[2866,32],[CHOMPY_TRIP.raw,1],[314,29]]);
 expect(chompyTripAssets(before,after,{kills:1,baits:1,raw:1,feathers:29,rangedXp:40})).toMatchObject({ammoUsed:0,fills:0});
});

test('Chompy adapter rejects unknown retaliation before withdrawing any bank kit',async()=>{
 const s:any={tick:()=>0,client:{ingame:true,ifType:()=>({colour:0x00f800})},sdk:{getState:()=>({player:{name:'Owned',worldX:2613,worldZ:3092,level:0,lifeId:1}}),getSkill:()=>({level:99}),getInventory:()=>[],getEquipment:()=>[]}};
 await expect(runChompyTrip(s,{kills:2,perTrip:1,cap:5000,returnTicks:800})).rejects.toThrow('auto-retaliate unknown');
});

test('after bank kit removal Chompy restores the original defensive unarmed style with observed acknowledgement',async()=>{
 const combatStyle={known:true,weaponName:'Unarmed',currentStyle:0,styles:[{index:0},{index:1},{index:2}]},sent:number[]=[];const s:any={sdk:{getState:()=>({combatStyle}),sendSetCombatStyle:async(index:number)=>{sent.push(index);combatStyle.currentStyle=index;return{success:true};}}};
 expect(await restoreChompyStyle(s,2,()=>true)).toBe(true);expect(sent).toEqual([2]);expect(combatStyle.currentStyle).toBe(2);
 combatStyle.weaponName='Ogre bow';expect(await restoreChompyStyle(s,2,()=>true)).toBe(false);expect(sent).toEqual([2]);
});

test('mutable cached life replacement during kit staging prevents the next owned bank withdrawal',async()=>{
 const player={name:'Owned',worldX:2613,worldZ:3092,level:0,lifeId:1,respawnCount:0,isDead:false},inventory:any[]=[],items=[{id:2883,count:1,name:'Ogre bow',slot:0},{id:2866,count:64,name:'Ogre arrow',slot:1},{id:2871,count:1,name:'Ogre bellows',slot:2}],bank={isOpen:true,items};let generation=1,withdrawals=0,closed=0;
 const state=()=>({player,inventory,bank,equipment:[],nearbyPlayers:[],combatStyle:{known:true,weaponName:'Unarmed',currentStyle:2,styles:[{index:0},{index:1},{index:2}]},autoRetaliateEnabled:false});
 const s:any={name:'fixture',tick:()=>0,ended:new Promise(()=>{}),client:{ingame:true,ifType:()=>({colour:0x00f800})},bankObservation:()=>({generation,items}),sdk:{getState:state,getSkill:()=>({level:99}),getInventory:()=>inventory,getEquipment:()=>[],sendCloseModal:async()=>{bank.isOpen=false;}},bot:{withdrawItem:async(item:any,n:number)=>{withdrawals++;item.count-=n;generation++;inventory.push({...item,count:n});player.lifeId=2;return{success:true};},closeBank:async()=>{closed++;bank.isOpen=false;},openBank:async()=>{bank.isOpen=true;generation++;return{success:true};}}};
 const result=await runChompyTrip(s,{kills:2,perTrip:1,cap:5000,returnTicks:800});expect(result.ok).toBe(false);expect(withdrawals).toBe(1);expect(closed).toBe(0);expect(inventory[0].id).toBe(2883);
});
