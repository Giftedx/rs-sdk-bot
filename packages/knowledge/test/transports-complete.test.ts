import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseTransportHandlers,buildTransports,NAMED_TRANSPORT_FILES} from '../src/transports';
import {parseTriggers} from '../src/doors';
const root=join(import.meta.dir,'../../../vendor/rs-sdk/server/content');
const files=['scripts/ladders+stairs/scripts/ladders.rs2','scripts/ladders+stairs/scripts/stairs.rs2','scripts/quests/quest_mcannon/scripts/locs/mcannon_ladders.rs2'];
const sources=files.map(file=>({file,text:readFileSync(join(root,file),'utf8')}));
const context={triggers:parseTriggers(sources)};
const parsed=()=>sources.slice(0,2).map(s=>parseTransportHandlers(s.text,s.file,context));
test('interaction metadata preserves raw geometry and unrotated source approach flags',()=>{
 const h=parseTransportHandlers('[oploc1,stairs]\n~climb_ladder(movecoord(coord, 0, 1, 0), true);','fixture.rs2').handlers;
 const r=buildTransports(h,[{id:1,x:10,z:20,level:0,shape:10,angle:1,src:'map:1'}],new Map([[1,'stairs']]),new Map([['stairs',{props:{width:['2'],length:['1'],forceapproach:['south']},file:'config.loc',line:7}]]));
 expect(r.edges[0]?.interaction).toEqual({id:1,shape:10,angle:1,width:2,height:1,blockAccessFlags:11,src:'map:1',configSrc:'config.loc:7'});
});
test('movecoord destinations follow actual packed level and coordinate wrap semantics',()=>{
 const h=parseTransportHandlers('[oploc1,edge_ladder]\n~climb_ladder(movecoord(coord, 2, 1, -2), true);','fixture.rs2').handlers;
 const edge=buildTransports(h,[{id:1,x:16383,z:0,level:3,shape:10,angle:0,src:'map:1'}],new Map([[1,'edge_ladder']])).edges[0]!;
 expect(edge.to).toEqual({x:1,z:16382,level:0});
});
test('guild-specific ladder and diagonal gate movement retain exact current/membership guards',()=>{
 const extra=['scripts/areas/area_falador/scripts/mining_guild.rs2','scripts/areas/monastery/scripts/prayer_guild.rs2','scripts/minigames/game_ranging/scripts/ranging_guild_door.rs2'];
 const handlers=extra.flatMap(file=>parseTransportHandlers(readFileSync(join(root,file),'utf8'),file,context).handlers);
 const edges=buildTransports(handlers,[{id:1,x:3046,z:3483,level:0,shape:10,angle:1,src:'map:1'},{id:2,x:3018,z:3339,level:0,shape:10,angle:0,src:'map:2'},{id:3,x:2658,z:3438,level:0,shape:9,angle:0,src:'map:3'}],new Map([[1,'monasteryladder'],[2,'miningguildladder'],[3,'ranging_guild_door']])).edges;
 expect(edges.find(e=>e.locName==='monasteryladder')).toMatchObject({requires:{unlock:'prayer-guild'}});
 expect(edges.find(e=>e.locName==='miningguildladder')).toMatchObject({requires:{skill:{name:'mining',level:60}}});
 const range=edges.filter(e=>e.locName==='ranging_guild_door');expect(range.length).toBe(2);expect(range[0]).toMatchObject({src:'map:3',entry:{x:2657,z:3439,level:0},to:{x:2659,z:3437,level:0},requires:{skill:{name:'ranged',level:40}}});expect(range[1]?.requires).toBeUndefined();
 expect(buildTransports(handlers,[],new Map()).edges.some(e=>e.locName==='ranging_guild_door')).toBe(false);
});
test('all fourteen old skips are either actual guarded movement or explicit covered/no-movement handlers',()=>{
 const rows=parsed();
 expect(rows.flatMap(r=>r.skipped)).toEqual([]);
 expect(rows.flatMap(r=>(r as any).classified??[]).map((r:any)=>[r.locName,r.kind]).sort()).toEqual([
  ['spiralstairsmiddle','menu-covered'],['spiralstairsmiddle_wooden','menu-covered'],
  ['board_game_stairs_top2','no-movement'],['board_game_stairs_base2','no-movement'],['castlewars_topstair_linked','no-movement'],
 ].sort());
});
test('DwarfTower gate and own-banner restrictions are retained instead of unconditional edges',()=>{
 const handlers=parsed().flatMap(r=>r.handlers);
 const edges=buildTransports(handlers,[{id:1,x:2570,z:3441,level:0,shape:10,angle:0,src:'map:1'}],new Map([[1,'ladder']])).edges as any[];
 expect(edges.find(e=>e.locName==='ladder')?.requires).toEqual({unlock:'dwarf-tower'});
 const sar=edges.find(e=>e.locName==='castlewars_topstair'&&e.from.x===2419&&e.from.level===1);
 expect(sar?.requires).toEqual({notOwnBanner:{team:0,item:'castlewars_saradomin_banner'}});
 expect(edges.filter(e=>e.locName==='castlewars_outsidestairs_saradomin_linked').map(e=>[e.entry.x,e.to.x,e.to.z,!!e.requires])).toEqual([[2416,2417,3077,false],[2418,2416,3074,true]]);
});

test('generic laddertop retains downward default for actual Prayer Guild exits and its special fortress landing',()=>{
 const handlers=parsed().flatMap(r=>r.handlers);
 const edges=buildTransports(handlers,[{id:1,x:3046,z:3483,level:1,shape:10,angle:1,src:'monastery-map:1'},{id:1,x:3025,z:3513,level:2,shape:10,angle:1,src:'fortress-map:1'}],new Map([[1,'laddertop']])).edges.filter(e=>e.locName==='laddertop');
 expect(edges[0]).toMatchObject({from:{x:3046,z:3483,level:1},to:{x:3046,z:3483,level:0},exact:false});
 expect(edges[0]?.requires).toBeUndefined();
 expect(edges[1]).toMatchObject({to:{x:3025,z:3514,level:1},exact:true});
});
test('board room arrivals preserve all six possible tiles and loc-relative angle offsets are exact',()=>{
 const handlers=parsed().flatMap(r=>r.handlers);
 const edges=buildTransports(handlers,[{id:1,x:2460,z:3400,level:0,shape:10,angle:0,src:'map:1'}],new Map([[1,'spiralstairs_wooden']])).edges as any[];
 expect(edges.find(e=>e.locName==='spiralstairs_wooden')).toMatchObject({from:{x:2460,z:3400,level:0},to:{x:2462,z:3400,level:1},exact:true});
 expect(edges.find(e=>e.locName==='board_game_stairs_grey_all')?.landing).toEqual({minX:2205,maxX:2207,minZ:4933,maxZ:4934,level:1});
});
test('NAMED_TRANSPORT_FILES parses Mage Arena, Lava Maze, and Lighthouse stair handlers cleanly',()=>{
 const extra=['scripts/areas/area_mage_arena/scripts/mage_arena.rs2','scripts/areas/area_wilderness/scripts/lava_maze.rs2','scripts/quests/quest_horror/scripts/quest_horror.rs2'];
 for(const file of extra)expect(NAMED_TRANSPORT_FILES[file]?.length).toBeGreaterThan(0);
 const handlers=extra.flatMap(file=>parseTransportHandlers(readFileSync(join(root,file),'utf8'),file,context).handlers.filter(h=>NAMED_TRANSPORT_FILES[file]!.includes(h.locName)));
 expect(handlers.map(h=>h.locName)).toEqual(expect.arrayContaining(['magearena_ladder_to_cellar','magearena_ladder_from_cellar','loc_1766','wildymirrorladdertop2','horror_lighthouse_spiralstairs_base']));
 const edges=buildTransports(handlers,[
  {id:1,x:3091,z:3957,level:0,shape:10,angle:0,src:'mage-map:1'},
  {id:2,x:2542,z:4713,level:0,shape:10,angle:0,src:'mage-map:2'},
  {id:3,x:3069,z:3856,level:0,shape:10,angle:0,src:'lava-map:1'},
  {id:4,x:3017,z:3849,level:0,shape:10,angle:0,src:'lava-map:2'},
  {id:5,x:2506,z:3640,level:0,shape:10,angle:0,src:'horror-map:1'},
 ],new Map([[1,'magearena_ladder_to_cellar'],[2,'magearena_ladder_from_cellar'],[3,'loc_1766'],[4,'wildymirrorladdertop2'],[5,'horror_lighthouse_spiralstairs_base']])).edges;
 expect(edges.some(e=>e.locName==='magearena_ladder_to_cellar'&&e.to.level===0&&e.to.x===2542&&e.to.z===4713)).toBe(true);
 expect(edges.some(e=>e.locName==='magearena_ladder_from_cellar'&&e.to.level===0&&e.to.x===3091&&e.to.z===3957)).toBe(true);
 expect(edges.some(e=>e.locName==='loc_1766')).toBe(true);
 expect(edges.some(e=>e.locName==='wildymirrorladdertop2')).toBe(true);
 expect(edges.some(e=>e.locName==='horror_lighthouse_spiralstairs_base'&&e.to.level===1)).toBe(true);
});
