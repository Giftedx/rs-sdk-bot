import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {monkLadderSpawn,buildTransports,parseTransportHandlers} from '../src/transports';
import {parseTriggers} from '../src/doors';
import {parsePack} from '../src/pack';
import {parseConfigs} from '../src/config';
import {parseJm2} from '../src/jm2';
const root=join(import.meta.dir,'../../../vendor/rs-sdk/server/content'),read=(p:string)=>readFileSync(join(root,p),'utf8');
const files=['scripts/ladders+stairs/scripts/ladders.rs2','scripts/ladders+stairs/scripts/stairs.rs2','scripts/quests/quest_drunkmonk/scripts/quest_drunkmonk.rs2','scripts/areas/area_ardougne_east/scripts/brother_omad.rs2'];
const sources=files.map(file=>({file,text:read(file)})),ctx={triggers:parseTriggers(sources)},constants={file:'scripts/quests/quest_drunkmonk/configs/quest_drunkmonk.constant',text:read('scripts/quests/quest_drunkmonk/configs/quest_drunkmonk.constant')},pack=parsePack(read('pack/loc.pack'));
const configs=new Map(['scripts/_unpack/225/all.loc','scripts/minigames/game_gamesroom/general/configs/boardgames.loc'].flatMap(file=>parseConfigs(read(file),file)).map(c=>[c.name,c]));
const handlers=sources.slice(0,2).flatMap(s=>parseTransportHandlers(s.text,s.file,ctx).handlers),locs=parseJm2('m45_55.jm2',read('maps/m45_55.jm2')).locs;
test('pinned timer proves dynamic loc geometry and current presence requirement, not guessed quest readiness',()=>{
 const dynamic=monkLadderSpawn(ctx,constants,pack);expect(dynamic).toHaveLength(1);expect(dynamic[0]).toMatchObject({id:1765,x:2561,z:3222,level:0,angle:1,shape:10,duration:200,src:'scripts/quests/quest_drunkmonk/scripts/quest_drunkmonk.rs2:5'});
 const edge=buildTransports(handlers,locs,pack,configs,dynamic).edges.find(e=>e.locName==='wildymirrorladdertop1'&&e.from.x===2561)!;
 expect(edge.unplaced).toBeUndefined();expect(edge.interaction).toMatchObject({id:1765,angle:1,shape:10,width:1,height:1,blockAccessFlags:0});expect(edge.requires).toEqual({visibleLoc:{id:1765,x:2561,z:3222,level:0}});expect(edge.to).toEqual({x:2561,z:9621,level:0});
 const changed={triggers:new Map(ctx.triggers)};changed.triggers.set('timer,blanket_ladder',{...changed.triggers.get('timer,blanket_ladder')!,body:changed.triggers.get('timer,blanket_ladder')!.body.replace('<= 2','<= 3')});expect(monkLadderSpawn(changed,constants,pack)).toEqual([]);
 changed.triggers.delete('label,omad_help');expect(monkLadderSpawn(changed,constants,pack)).toEqual([]);
});
test('both legacy literals retain provenance and resolve only to same destination actual board-game IDs',()=>{
 const es=buildTransports(handlers,locs,pack,configs).edges;
 for(const [name,id,canonical] of [['stairs',4626,'board_game_stairs_grey_base'],['stairstop',4625,'board_game_stairs_grey_top']] as const){
  const edge=es.find(e=>e.locName===name&&e.from.x===2897&&[3566,3567].includes(e.from.z))!;
  expect(edge.unplaced).toBe(true);expect(edge.canonical).toMatchObject({id,locName:canonical,from:edge.from,to:edge.to,option:edge.option,exact:edge.exact,interaction:{id}});expect(edge.canonical?.handler).not.toBe(edge.handler);
 }
 const absent=buildTransports(handlers,[],pack,configs).edges.find(e=>e.locName==='stairs'&&e.from.x===2897)!;expect(absent.canonical).toBeUndefined();
});
