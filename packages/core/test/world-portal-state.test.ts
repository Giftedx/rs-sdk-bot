import {test,expect} from 'bun:test';
import {createWorld,type Transport,type Tile} from '../src/world';
const actor={skills:{},varps:{},items:[]};
const link=(from:Tile,to:Tile):Transport=>({locName:'stair',option:'op1',from,to,exact:true,src:'fixture:1',toSrc:'fixture:2',handler:'fixture:1',interaction:{id:1,shape:10,angle:0,width:2,height:2,blockAccessFlags:0,src:'fixture:1',configSrc:'fixture:2'}});
test('tolerated stair approach behind a wall cannot become an exact walking waypoint',()=>{
 const portal={x:8,z:0,level:0},calls:number[]=[];
 const w=createWorld({transports:[link(portal,{x:8,z:100,level:1})],doors:[],pathLength:(a,b,_doors,tol)=>{
  if(a.level!==b.level)return null;
  if(a.level===0&&a.x<=6&&b.x>6){if(b.x===8&&b.z===0){calls.push(tol);return tol>=2?6:null;}return null;}
  return Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z));
 }});
 expect(w.route({x:0,z:0,level:0},{x:10,z:0,level:0},actor)).toEqual({ok:false,reason:'no_route'});
 expect(calls).toContain(0);
});
test('the same coordinate pair keeps separate exact and interaction-tolerance measurements',()=>{
 const portal={x:8,z:0,level:0},calls:number[]=[];
 const w=createWorld({transports:[link(portal,{x:10,z:0,level:1})],doors:[],pathLength:(a,b,_d,tol)=>{if(a.level!==b.level)return null;if(a.x===0&&b.x===8){calls.push(tol);return tol===2?20:null;}return Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z));}});
 expect(w.route({x:0,z:0,level:0},{x:10,z:0,level:1},actor).ok).toBe(true);expect(calls).toContain(0);expect(calls).toContain(2);
});
test('an unwalkable stair can still be interacted with from its valid two-tile approach',()=>{
 const portal={x:8,z:0,level:0};
 const w=createWorld({transports:[link(portal,{x:12,z:0,level:1})],doors:[],pathLength:(a,b,_doors,tol)=>a.level!==b.level?null:b.level===0&&b.x===8?(tol>=2?6:null):Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z))});
 const r=w.route({x:0,z:0,level:0},{x:14,z:0,level:1},actor);expect(r.ok).toBe(true);if(r.ok){expect(r.legs.map(l=>l.kind)).toEqual(['walk','transport','walk']);expect(r.legs[0]).toMatchObject({tolerance:2});}
});
test('long ordinary walks retain exact validated intermediate waypoints without taking transports',()=>{
 const links=[200,400].map(x=>({...link({x,z:0,level:0},{x,z:0,level:1}),requires:{unlock:'unavailable'}}));
 const w=createWorld({transports:links,doors:[],pathLength:(a,b)=>a.level===b.level?Math.abs(a.x-b.x):null});
 const r=w.route({x:0,z:0,level:0},{x:600,z:0,level:0},actor);expect(r.ok).toBe(true);if(r.ok){expect(r.cost).toBe(600);expect(r.legs.every(l=>l.kind==='walk')).toBe(true);expect(r.legs.slice(0,-1).every(l=>l.kind==='walk'&&l.tolerance===0)).toBe(true);}
});
test('unplaced diagnostic transport cannot grant a teleport even from the same literal coordinate',()=>{
 const from={x:0,z:0,level:0},to={x:0,z:0,level:1};const t={...link(from,to),unplaced:true as const};
 expect(createWorld({transports:[t],doors:[],pathLength:(a,b)=>a.level===b.level?0:null}).route(from,to,actor)).toEqual({ok:false,reason:'no_route'});
});
test('a world search shares one synchronous route policy and releases it if a path query throws',()=>{
 let active:any=null,scopes=0;
 const path=Object.assign((_a:Tile,_b:Tile,blocked:any)=>{expect(active).toBe(blocked);throw Error('path-query-sentinel');},{withPolicy:<T>(blocked:any,query:()=>T)=>{scopes++;active=blocked;try{return query();}finally{active=null;}}});
 expect(()=>createWorld({transports:[],doors:[],pathLength:path}).route({x:0,z:0,level:0},{x:1,z:0,level:0},actor)).toThrow('path-query-sentinel');expect(scopes).toBe(1);expect(active).toBeNull();
});

test('strict qualification does not count a neighbouring tile across a locked goal wall',()=>{
 const from={x:2728,z:3374,level:0},to={x:2728,z:3372,level:0};
 const path=(_a:Tile,_b:Tile,_blocked:unknown,tol:number)=>tol===1?2:null;
 const ordinary=createWorld({transports:[],doors:[],pathLength:path}).route(from,to,actor);
 expect(ordinary.ok).toBe(true);if(ordinary.ok)expect(ordinary.legs).toEqual([{kind:'walk',to,tolerance:1}]);
 const strict=createWorld({transports:[],doors:[],pathLength:path,goalTolerance:0}).route(from,to,actor);
 expect(strict).toEqual({ok:false,reason:'no_route'});
});

test('strict goals preserve interaction reach and carry zero tolerance on the final walk',()=>{
 const portal={x:8,z:0,level:0},landing={x:12,z:0,level:1},to={x:14,z:0,level:1};
 const w=createWorld({transports:[link(portal,landing)],doors:[],goalTolerance:0,pathLength:(a,b,_doors,tol)=>a.level!==b.level?null:b.level===0&&b.x===8?(tol>=2?6:null):Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z))});
 const r=w.route({x:0,z:0,level:0},to,actor);expect(r.ok).toBe(true);if(r.ok){expect(r.legs.map(l=>l.kind)).toEqual(['walk','transport','walk']);expect(r.legs[0]).toMatchObject({tolerance:2});expect(r.legs.at(-1)).toEqual({kind:'walk',to,tolerance:0});}
});

test('either isolated end can exhaust its complete frontier without exploring the dense opposite component',()=>{
 for(const isolatedStart of [true,false]){
  const isolated={x:0,z:0,level:0},outside={x:100,z:0,level:0};let calls=0;
  const links=Array.from({length:32},(_,i)=>({...link({x:101+i,z:0,level:0},{x:101+i,z:0,level:1}),requires:{unlock:'unavailable'}}));
  const w=createWorld({transports:links,doors:[],goalTolerance:0,pathLength:(a,b)=>{if(++calls>150)throw Error('expanded the dense opposite component');if(a.level!==b.level||a.x===0||b.x===0)return null;return Math.abs(a.x-b.x);}});
  expect(w.route(isolatedStart?isolated:outside,isolatedStart?outside:isolated,actor)).toEqual({ok:false,reason:'no_route'});
  expect(calls).toBeLessThanOrEqual(150);
 }
});
