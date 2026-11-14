import {expect,test} from 'bun:test';
import {walkPath,expandPath,type PathDeps} from '../packages/core/src/walk';
import {createShiloTransit} from './microbot-rune-trip';

function walkFixture(partialDetour=false,detourZ=3){
 let tick=0;
 const player={worldX:0,worldZ:0,level:0},listeners=new Set<()=>void>();
 const avoids:{x:number;z:number}[][]=[],clicks:{x:number;z:number}[]=[],segments:{from:{x:number;z:number};to:{x:number;z:number}}[]=[];
 const s:any={tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},sdk:{getState:()=>({tick,player})}};
 const deps:PathDeps={
  tick:()=>tick,pos:()=>({x:player.worldX,z:player.worldZ,level:0}),onTick:s.onTick,
  plan:(_level,from,to,avoid)=>{
   if(avoid?.length){
    avoids.push([...avoid]);
    return partialDetour?[{x:from.x,z:detourZ}]:[{x:from.x,z:detourZ},{x:to.x,z:detourZ},to];
   }
   return [to];
  },
  hunters:()=>[{x:6,z:0,r:1}],locs:()=>[],reach:()=>true,
  walk:(x,z)=>{segments.push({from:{x:player.worldX,z:player.worldZ},to:{x,z}});clicks.push({x,z});player.worldX=x;player.worldZ=z;return {success:true};},
  interactLoc:()=>{throw Error('unexpected gate interaction');},
 };
 const advance=()=>{tick++;for(const cb of [...listeners])cb();};
 return{s,deps,player,avoids,clicks,segments,advance};
}

test('Shilo native walk forwards live-hunter avoidance and completes the safe detour',async()=>{
 const f=walkFixture(),transit=createShiloTransit(f.s,{},()=>true,async()=>f.deps),timer=setInterval(f.advance,1);
 try{
  await transit.walkNative({x:12,z:0},()=>false);
  expect(f.avoids.length).toBeGreaterThan(0);
  expect(f.avoids[0]).toContainEqual({x:6,z:0});
  expect(f.player).toEqual({worldX:12,worldZ:0,level:0});
  expect(f.clicks.length).toBeGreaterThan(0);
  expect(f.clicks.every(p=>Math.max(Math.abs(p.x-6),Math.abs(p.z))>1)).toBe(true);
  expect(f.segments.every(s=>expandPath(s.from,[s.to]).every(p=>Math.max(Math.abs(p.x-6),Math.abs(p.z))>1))).toBe(true);
 }finally{clearInterval(timer);}
});

test('Nature takes a complete long hunter detour immediately while other walkers retain the default hold',async()=>{
 const f=walkFixture(false,12),timer=setInterval(f.advance,1);
 try{await createShiloTransit(f.s,{},()=>true,async()=>f.deps).walkNative({x:12,z:0},()=>false);expect(f.player.worldX).toBe(12);expect(f.player.worldZ).toBe(0);}finally{clearInterval(timer);}
 const g=walkFixture(false,12),holdTimer=setInterval(g.advance,1);
 try{const result=await walkPath(g.deps,[{x:12,z:0,tol:0}],{maxTicks:10});expect(result.ok).toBe(false);expect(g.player.worldX).toBeLessThan(5);expect(g.player.worldZ).toBe(0);}finally{clearInterval(holdTimer);}
});

test('Shilo native walk rejects an incomplete hunter detour before dispatch',async()=>{
 const f=walkFixture(true),transit=createShiloTransit(f.s,{},()=>true,async()=>f.deps);
 await expect(transit.walkNative({x:12,z:0},()=>false)).rejects.toThrow('route stops short');
 expect(f.avoids.length).toBe(1);
 expect(f.clicks).toEqual([]);
});

test('Shilo native walk still refuses a stopped or changed life before planning',async()=>{
 const f=walkFixture();let plans=0;
 const factory=async()=>{plans++;return f.deps;};
 await expect(createShiloTransit(f.s,{},()=>true,factory).walkNative({x:12,z:0},()=>true)).rejects.toThrow('walk stopped');
 await expect(createShiloTransit(f.s,{},()=>false,factory).walkNative({x:12,z:0},()=>false)).rejects.toThrow('walk stopped');
 expect(plans).toBe(0);
 expect(f.clicks).toEqual([]);
});

function stockadeFixture(id=504,x=2872){
 const f=walkFixture(),prayers={activePrayers:Array(15).fill(false),prayerPoints:40};prayers.activePrayers[14]=true;
 f.player.worldX=x-2;f.player.worldZ=2953;
 const state=f.s.sdk.getState;
 f.s.sdk.getState=()=>({...state(),prayers,nearbyNpcs:[{id,x,z:2953,tileX:x,tileZ:2953}]});
 f.deps.hunters=()=>[{x,z:2953,r:3}];
 f.deps.plan=(_level,_from,to,avoid)=>{if(avoid?.length){f.avoids.push([...avoid]);return[];}return[to];};
 return{...f,prayers,goal:{x:x+2,z:2953}};
}

test('only observed native stockade undead receive the actual declared melee protection exemption',async()=>{
 for(const id of [504,505]){
  const f=stockadeFixture(id),timer=setInterval(f.advance,1);
  try{await createShiloTransit(f.s,{protectMelee:true},()=>true,async()=>f.deps).walkNative(f.goal,()=>false);expect(f.avoids).toEqual([]);}finally{clearInterval(timer);}
 }
 for(const options of [{id:506},{x:2890},{points:9},{active:false},{declared:false}]){
  const f=stockadeFixture(options.id??504,options.x??2872);
  if(options.points!==undefined)f.prayers.prayerPoints=options.points;if(options.active===false)f.prayers.activePrayers[14]=false;
  await expect(createShiloTransit(f.s,{protectMelee:options.declared!==false},()=>true,async()=>f.deps).walkNative(f.goal,()=>false)).rejects.toThrow('route stops short');
  expect(f.avoids.length).toBe(1);expect(f.clicks).toEqual([]);
 }
});

test('loss of observed melee protection aborts the stockade walk before another movement input',async()=>{
 const f=stockadeFixture(),walk=f.deps.walk;let inputs=0;
 f.deps.walk=(x,z)=>{inputs++;const reply=walk(f.player.worldX+1,z);f.prayers.activePrayers[14]=false;return reply;};
 const timer=setInterval(f.advance,1);
 try{await expect(createShiloTransit(f.s,{protectMelee:true},()=>true,async()=>f.deps).walkNative(f.goal,()=>false)).rejects.toThrow('Nature native route');expect(inputs).toBe(1);}finally{clearInterval(timer);}
});
