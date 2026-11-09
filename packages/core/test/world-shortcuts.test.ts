import {test,expect} from 'bun:test';
import {createWorld,type Tile,type Transport} from '../src/world';

const account={skills:{},varps:{},items:[]};
const flat=(a:Tile,b:Tile)=>a.level===b.level&&Math.abs(a.z-b.z)<3200?Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z)):null;
const transport=(name:string,from:Tile,to:Tile):Transport=>({locName:name,option:'op1',from,to,exact:true,src:'fixture:1',toSrc:'fixture:2',handler:'fixture:1'});

test('a useful transport detour away from the goal is not pruned by straight-line distance',()=>{
 const from={x:1100,z:3200,level:0},to={x:1200,z:3200,level:0};
 const gate=transport('shortcut',{x:1090,z:3200,level:0},to);
 const result=createWorld({transports:[gate],doors:[],pathLength:flat}).route(from,to,account);
 expect(result.ok&&result.cost).toBe(13);
 expect(result.ok&&result.legs[1]).toMatchObject({kind:'transport',loc:'shortcut'});
});

test('a dungeon shortcut can start with a surface detour before returning near the goal',()=>{
 const from={x:1100,z:3200,level:0},to={x:1200,z:3200,level:0};
 const entry={x:1090,z:3200,level:0},below={x:1090,z:9600,level:0};
 const result=createWorld({transports:[transport('entry',entry,below),transport('exit',below,to)],doors:[],pathLength:flat}).route(from,to,account);
 expect(result.ok&&result.cost).toBe(16);
 expect(result.ok&&result.legs.filter(l=>l.kind==='transport')).toHaveLength(2);
});

test('lazy measured routes agree with an independent complete-graph relaxation oracle',()=>{
 for(let seed=0;seed<32;seed++){
  const start={x:1100,z:3200,level:0},goal={x:1230,z:3200,level:0};
  const links=[transport('side',{x:1080+seed,z:3200,level:0},{x:1210+seed%9,z:3200,level:0}),
   transport('down',{x:1090+seed%11,z:3200,level:0},{x:1100,z:9600,level:0}),
   transport('up',{x:1110+seed%7,z:9600,level:0},{x:1225,z:3200,level:0})];
  const id=(t:Tile)=>`${t.x},${t.z},${t.level}`;
  const nodes=[...new Map([start,goal,...links.flatMap(l=>[l.from,l.to])].map(t=>[id(t),t])).values()];
  const destinations=[goal,...links.map(l=>l.from)],dist=new Map<string,number>([[id(start),0]]);
  // Bellman-Ford uses the public graph edges and measured costs, no planner
  // heap, heuristic, lazy entries or lower-bound code.
  for(let pass=0;pass<nodes.length;pass++)for(const from of nodes){
   const base=dist.get(id(from))??Infinity;
   const relax=(to:Tile,cost:number)=>dist.set(id(to),Math.min(dist.get(id(to))??Infinity,base+cost));
   for(const link of links)if(id(from)===id(link.from))relax(link.to,3);
   for(const to of destinations){const cost=flat(from,to);if(cost!==null&&cost<=300)relax(to,cost);}
  }
  const actual=createWorld({transports:links,doors:[],pathLength:flat}).route(start,goal,account);
  expect(actual.ok&&actual.cost).toBe(dist.get(id(goal))??Infinity);
 }
});

test('a sided passage starts on the far side of its loc from each landing, so the door works both ways',async()=>{
 const {passageStart,shortcutTravel}=await import('../src/travel');
 // treedoorl 1967 at 2464,3492: the south landing 2465,3490 is entered from the north, the north landing from the south.
 const rec=(to:Tile)=>({kind:'passage',locName:'treedoorl',id:1967,option:'op1',from:{x:2464,z:3492,level:0},to,exact:false,side:['coordz(coord)<coordz(loc_coord)']});
 expect(passageStart(rec({x:2465,z:3494,level:0}))).toEqual({x:2463,z:3490,level:0});
 expect(passageStart(rec({x:2465,z:3490,level:0}))).toEqual({x:2463,z:3494,level:0});
 expect(passageStart({...rec({x:2465,z:3494,level:0}),side:undefined})).toEqual({x:2464,z:3492,level:0});
 const edges=shortcutTravel([rec({x:2465,z:3494,level:0}),rec({x:2465,z:3490,level:0})] as any);
 expect(edges.map(e=>[e.from,e.to])).toEqual([[{x:2463,z:3490,level:0},{x:2465,z:3494,level:0}],[{x:2463,z:3494,level:0},{x:2465,z:3490,level:0}]]);
 // The click still targets the loc tile.
 expect(edges.map(e=>(e.run as any).at)).toEqual([{x:2464,z:3492,level:0},{x:2464,z:3492,level:0}]);
});
