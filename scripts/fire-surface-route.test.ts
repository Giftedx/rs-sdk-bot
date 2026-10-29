import {expect,test} from 'bun:test';
import {fireWalkOptions} from './gather-fire-combat';
import * as fire from './gather-fire-combat';
import type {Session} from '../packages/core/src/inprocess';
import {walkPath,type PathDeps,type PathOptions} from '../packages/core/src/walk';

const options=(z:number):PathOptions=>fireWalkOptions(z);
async function route(z:number,moving=true){
 let p={x:2617,z,level:0},tick=0,target={...p};
 const pending:{at:number;x:number;z:number}[]=[],listeners=new Set<()=>void>();
 const goal={x:2522,z:z+185,tol:2};
 const deps:PathDeps={tick:()=>tick,pos:()=>p,onTick:cb=>{listeners.add(cb);return()=>listeners.delete(cb);},
  walk:(x,z)=>{pending.push({at:tick+2,x,z});},locs:()=>[],interactLoc:()=>{},plan:(_l,_p,to)=>[to]};
 const result=walkPath(deps,[goal],options(z));
 for(let i=0;i<1000;i++){
  const done=await Promise.race([result,Promise.resolve(null)]);if(done)return done;
  tick++;while(pending[0]&&pending[0].at<=tick){const next=pending.shift()!;target={...p,x:next.x,z:next.z};}
  // Legitimate walking speed, with a two-tick input delivery delay. This is
  // a deterministic failure fixture, not a measured remote latency claim.
  if(moving)p={...p,x:p.x+Math.sign(target.x-p.x),z:p.z+Math.sign(target.z-p.z)};
  for(const cb of [...listeners])cb();
 }
 throw Error('route lost its absolute bound');
}
test('a progressing long surface approach reaches its goal beyond180ticks',async()=>{
 const r=await route(3309);expect(r.ok).toBe(true);expect(r.ticks).toBeGreaterThan(180);expect(r.ticks).toBeLessThan(300);
});
test('a stalled surface approach still terminates within its path budget',async()=>{
 const r=await route(3309,false);expect(r.ok).toBe(false);expect(r.ticks).toBeLessThan(300);
});
test('dungeon walking retains its tight180tick bound',async()=>{
 const r=await route(9883);expect(r.ok).toBe(false);expect(r.ticks).toBeLessThanOrEqual(181);
});

test('close the room from the first north tile before a following spider crosses',async()=>{
 // The legacy call walked an extra tile before closing. In this controlled
 // race the player runs two tiles/tick, the follower moves one, and closing
 // takes one tick. The real seal guard must reject a trapped follower.
 const entry=fire.FIRE_ROOM_ENTRY;
 const spider={id:58,x:2564,z:9879,tileX:2564,tileZ:9879};
 const state={player:{worldX:2564,worldZ:9880,level:0},nearbyNpcs:[spider],nearbyLocs:[{id:1517,x:2563,z:9882,optionsWithIndex:[{text:'Close',opIndex:1}]}]};
 while(state.player.worldZ<entry.z){state.player.worldZ=Math.min(entry.z,state.player.worldZ+2);spider.z++;spider.tileZ++;}
 const s={sdk:{getState:()=>state,sendInteractLoc:async()=>{
  spider.z++;spider.tileZ++;state.nearbyLocs=[{id:1516,x:2564,z:9881,optionsWithIndex:[{text:'Open',opIndex:1}]}];return{success:true};
 }}} as unknown as Session;
 await fire.sealFireRoom(s,()=>false);
 expect(spider.tileZ).toBeLessThan(9882);
});
