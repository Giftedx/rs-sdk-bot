import {expect,test} from 'bun:test';
import {enableSpecial,refillCannon,holdPrayer} from './microbot-c-qol';
test('special helper confirms transmitted native state after explicit specbar',async()=>{
 const vars:number[]=[];vars[300]=1000;vars[301]=0;
 const s:any={client:{var:vars},tick:()=>0,sdk:{getState:()=>({player:{lifeId:1}}),getSkill:()=>({level:10}),getEquipment:()=>[{id:1215,slot:3}],sendClickComponent:async()=>{vars[301]=1;}}};
 expect(await enableSpecial(s,'combat_stabsword:specbar',250,20)).toMatchObject({ok:true,changed:true,energy:1000});
});
test('cannon refill reconciles fresh explicit load count and ammo debit',async()=>{
 const items=[{id:2,slot:0,count:50}],messages:any[]=[];
 const s:any={tick:()=>0,sdk:{getState:()=>({player:{lifeId:1},nearbyLocs:[{id:6,x:20,z:30}],gameMessages:messages}),getSkill:()=>({level:10}),getInventory:()=>items,sendUseItemOnLoc:async(slot:number,x:number,z:number,id:number)=>{expect([slot,x,z,id]).toEqual([0,20,30,6]);items[0]!.count-=30;messages.push({type:0,observationId:1,tick:0,text:'You load the cannon with 30 cannonballs.'});}}};
 expect(await refillCannon(s,20,30,20)).toMatchObject({ok:true,loaded:30});
});
test('finite prayer hold restores originally inactive prayer',async()=>{
 let active=false,tick=0;
 const s:any={tick:()=>tick,onTick:(cb:()=>void)=>{let run=true;const next=()=>queueMicrotask(()=>{if(run){tick++;cb();next();}});next();return()=>{run=false;};},sdk:{getState:()=>({player:{lifeId:1}}),getSkill:()=>({level:99}),isPrayerActive:()=>active},bot:{activatePrayer:async()=>{active=true;return{success:true};},deactivatePrayer:async()=>{active=false;return{success:true};}}};
 expect(await holdPrayer(s,0,3)).toMatchObject({ok:true,activated:true,restored:true});expect(active).toBe(false);
});
test('public chat plus ammo debit cannot impersonate native cannon load message',async()=>{
 let tick=0;const items=[{id:2,slot:0,count:50}],messages:any[]=[];
 const s:any={tick:()=>tick,onTick:(cb:()=>void)=>{let active=true;queueMicrotask(()=>{if(active){tick++;cb();}});return()=>{active=false;};},sdk:{getState:()=>({player:{lifeId:1},nearbyLocs:[{id:6,x:20,z:30}],gameMessages:messages}),getSkill:()=>({level:10}),getInventory:()=>items,sendUseItemOnLoc:async()=>{items[0]!.count-=30;messages.push({type:2,observationId:1,tick:0,text:'You load the cannon with 30 cannonballs.'});}}};
 expect(await refillCannon(s,20,30,1)).toMatchObject({ok:false,loaded:30});
});
