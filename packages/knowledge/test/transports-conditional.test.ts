import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseTransportHandlers,buildTransports} from '../src/transports';
import {contentRoot} from '../src/paths';

const loc=(id:number,x:number,z:number,level=0)=>({id,x,z,level,shape:10,angle:0,src:'fixture.jm2:1'});
const file='scripts/ladders+stairs/scripts/ladders.rs2';

test('pinned Zanaris ladder takes its named absolute branch before the cellar fallback',()=>{
 const text=readFileSync(join(contentRoot(),file),'utf8');
 const {handlers}=parseTransportHandlers(text,file);
 const {edges}=buildTransports(handlers.filter(h=>h.locName==='ladder_from_cellar'),[loc(1,3222,9588),loc(1,3018,9739)],new Map([[1,'ladder_from_cellar']]));
 expect(edges.map(e=>[e.from,e.to,e.exact])).toEqual([
  [{x:3222,z:9588,level:0},{x:3201,z:3169,level:0},true],
  [{x:3018,z:9739,level:0},{x:3018,z:3339,level:0},false],
 ]);
 expect(edges[0]!.toSrc).toBe(file+':91');
});

test('coordinate aliases select the movement destination, never the condition coordinate',()=>{
 const text=readFileSync(join(contentRoot(),file),'utf8');
 const {handlers}=parseTransportHandlers(text,file);
 const {edges}=buildTransports(handlers.filter(h=>h.locName==='wizards_tower_laddertop'),[loc(2,3104,3162),loc(2,3105,3162),loc(2,3104,3162,1)],new Map([[2,'wizards_tower_laddertop']]));
 expect(edges).toHaveLength(1);
 expect(edges[0]).toMatchObject({from:{x:3104,z:3162,level:0},to:{x:3104,z:9576,level:0},exact:true});
});

test('an unsupported coordinate branch cannot silently fall through to the ordinary offset',()=>{
 const text=`[oploc1,conditional_ladder]\nif (loc_coord = 0_50_149_22_52) {\n p_teleport($unknown);\n return;\n}\n~climb_ladder(movecoord(coord(),0,0,-6400),true);`;
 const result=parseTransportHandlers(text,'unknown.rs2');
 expect(result.handlers).toEqual([]);
 expect(result.skipped).toEqual([{locName:'conditional_ladder',handler:'unknown.rs2:1'}]);
});

test('plain absolute destinations ignore coordinate mentions in messages',()=>{
 const text=`[oploc1,plain]\nmes("old place 0_1_1_1_1");\n~climb_ladder(0_50_50_10_20,false);`;
 const {handlers}=parseTransportHandlers(text,'plain.rs2');
 const {edges}=buildTransports(handlers,[loc(3,3200,3200)],new Map([[3,'plain']]));
 expect(edges[0]!.to).toEqual({x:3210,z:3220,level:0});
});

test('a coordinate move without return cannot be modeled as overriding a later move',()=>{
 const text=`[oploc1,fallthrough]\nif (loc_coord = 0_50_149_22_52) {\n p_teleport(0_50_49_1_33);\n}\n~climb_ladder(movecoord(coord(),0,0,-6400),true);`;
 expect(parseTransportHandlers(text,'fallthrough.rs2').handlers).toEqual([]);
});

test('a known movement cannot conceal another unresolved movement in its branch',()=>{
 const text=`[oploc1,ambiguous]\nif (loc_coord = 0_50_149_22_52) {\n p_teleport(0_50_49_1_33);\n p_teleport($unknown);\n return;\n}\n~climb_ladder(movecoord(coord(),0,0,-6400),true);`;
 expect(parseTransportHandlers(text,'ambiguous.rs2').handlers).toEqual([]);
});

test('a switch over a proven loc_coord alias retains each named destination',()=>{
 const text=readFileSync(join(contentRoot(),file),'utf8');
 const {handlers}=parseTransportHandlers(text,file);
 const {edges}=buildTransports(handlers.filter(h=>h.locName==='wildymirrorladdertop1'),[],new Map());
 expect(edges.map(e=>[e.from,e.to])).toEqual([
  [{x:2561,z:3222,level:0},{x:2561,z:9621,level:0}],
  [{x:3017,z:3849,level:0},{x:3069,z:10255,level:0}],
 ]);
});

test('coordinate switch cases bind a following-line movement and reject guarded landings',()=>{
 const text=`[oploc1,stairs]\nswitch_coord(loc_coord) {\n case 0_50_50_1_1:\n  p_telejump(1_50_50_2_2);\n case 0_50_50_3_3:\n  if (%gate = 1) { p_telejump(1_50_50_4_4); }\n case default: mes("unknown");\n}`;
 const result=parseTransportHandlers(text,'table.rs2');
 const {edges}=buildTransports(result.handlers,[],new Map());
 expect(edges.map(e=>e.to)).toEqual([{x:3202,z:3202,level:1}]);
 expect(edges[0]).toMatchObject({src:'table.rs2:3',toSrc:'table.rs2:4'});
 expect(result.skipped).toEqual([{locName:'stairs',handler:'table.rs2:1'}]);
});

test('movement from another procedure is not attributed to the preceding loc handler',()=>{
 const text=`[oploc1,no_move]\nmes("No stairs here");\n[proc,unrelated]\np_teleport(0_50_50_1_1);`;
 const result=parseTransportHandlers(text,'separate.rs2');
 expect(result.handlers).toEqual([]);
 expect(result.skipped).toEqual([{locName:'no_move',handler:'separate.rs2:1'}]);
});

test('a coordinate switch may retain a player-relative landing without claiming exactness',()=>{
 const text=`[oploc1,stairs]\nswitch_coord(loc_coord) {\n case 0_50_50_1_1: p_telejump(movecoord(coord,0,1,4));\n case default: mes("unknown");\n}`;
 const result=parseTransportHandlers(text,'relative.rs2');
 const {edges}=buildTransports(result.handlers,[],new Map());
 expect(edges[0]).toMatchObject({from:{x:3201,z:3201,level:0},to:{x:3201,z:3205,level:1},exact:false,src:'relative.rs2:3',toSrc:'relative.rs2:3'});
 expect(result.skipped).toEqual([]);
});

test('a return in the ELSE branch cannot prove the selected coordinate branch stops',()=>{
 const text=`[oploc1,fallthrough]\nif (loc_coord = 0_50_149_22_52) {\n p_teleport(0_50_49_1_33);\n} else {\n return;\n}\n~climb_ladder(movecoord(coord(),0,0,-6400),true);`;
 expect(parseTransportHandlers(text,'else-return.rs2').handlers).toEqual([]);
});
