import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createWorld,type Transport,type Tile} from '../../core/src/world';

const transports=JSON.parse(readFileSync(join(import.meta.dir,'../../../knowledge/transports.json'),'utf8')) as Transport[];
// This exercises the installed JSON -> real route planner boundary. It models
// ordinary same-region walking; it does not claim native collision or traversal.
const world=createWorld({transports,doors:[],pathLength:(a,b)=>a.level===b.level&&Math.abs(a.z-b.z)<3200?Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z)):null});
const account={skills:{},varps:{},items:[]};

for(const [name,from,to] of [
 ['Zanaris exit',{x:3222,z:9588,level:0},{x:3201,z:3169,level:0}],
 ['Wizard Tower down',{x:3104,z:3162,level:0},{x:3104,z:9576,level:0}],
 ['Wizard Tower up',{x:3103,z:9576,level:0},{x:3105,z:3162,level:0}],
 ['KBD ladder',{x:3017,z:3849,level:0},{x:3069,z:10255,level:0}],
] as const){
 test(`generated ${name} edge is consumed with its pinned destination`,()=>{
  const result=world.route(from as Tile,to as Tile,account);
  expect(result.ok).toBe(true);
  if(result.ok){
   expect(result.cost).toBe(3);
   expect(result.legs).toHaveLength(1);
   expect(result.legs[0]).toMatchObject({kind:'transport',at:from,to,exact:true});
  }
 });
}

test('generated player-relative Yanille stairs reach the planner without claiming exactness',()=>{
 const from={x:2537,z:3085,level:0},to={x:2537,z:3081,level:1};
 const result=world.route(from,to,account);
 expect(result.ok&&result.legs[0]).toMatchObject({kind:'transport',at:from,to,exact:false});
});

test('guarded helper is resolved with its restriction and menu op1 remains excluded',()=>{
 const guarded=transports.filter(t=>t.locName==='castlewars_topstair');
 expect(guarded.length).toBe(6);
 expect(guarded.every(t=>!!t.requires?.notOwnBanner&&!!t.requireSrc)).toBe(true);
 expect(transports.some(t=>t.locName==='spiralstairsmiddle'&&t.option==='op1')).toBe(false);
 expect(transports.some(t=>t.locName==='spiralstairsmiddle'&&t.option==='op2')).toBe(true);
});
