import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseTriggers,classifyDoor,openedTeamDoor} from '../src/doors';
const root=join(import.meta.dir,'../../../vendor/rs-sdk/server/content/scripts');
test('actual guild rules retain worn gear AND current skill, plus the side where checks apply',()=>{
 for(const [file,loc,skill,level,worn,whenAxis] of [
  ['skill_crafting/scripts/crafting_guild/crafting_guild.rs2','crafting_guild_door','crafting',40,'brown_apron',true],
  ['skill_cooking/scripts/cooking_guild.rs2','chefdoor','cooking',32,'chefs_hat',false],
  ['skill_fishing/scripts/fishing_guild.rs2','loc_2025','fishing',68,undefined,false],
  ['areas/area_yanille/scripts/magic_guild.rs2','magicguild_door_l','magic',66,undefined,true],
 ] as const){
  const t=parseTriggers([{text:readFileSync(join(root,file),'utf8'),file}]);
  const rule=classifyDoor(loc,undefined,t);
  expect(rule.kind).toBe('skill');
  expect(rule.need).toEqual({skill,level,...(worn?{worn}:{}),whenAxis});
 }
});
test('Castle Wars closed main doors require own team only on the entering axis',()=>{
 const file='minigames/game_castlewars/scripts/castlewars_maindoor.rs2',t=parseTriggers([{file,text:readFileSync(join(root,file),'utf8')}]);
 for(const team of ['saradomin','zamorak'])for(const side of ['l','r'])expect(classifyDoor(`castlewars_${team}_maindoor${side}`,undefined,t)).toMatchObject({kind:'team',need:{team:team==='saradomin'?0:1,whenAxis:true}});
});
test('open main-door witnesses use the source shifted tile and leaf rotation',()=>{
 for(const [name,x,z,angle,id,ox,oz,oa] of [
 ['castlewars_saradomin_maindoorr',2426,3088,3,4425,2426,3087,0],
 ['castlewars_saradomin_maindoorl',2427,3088,3,4426,2427,3087,2],
 ['castlewars_zamorak_maindoorr',2373,3119,1,4429,2373,3120,2],
 ['castlewars_zamorak_maindoorl',2372,3119,1,4430,2372,3120,0],
 ] as const)expect(openedTeamDoor(name,{x,z,level:0,angle},id)).toEqual({id,x:ox,z:oz,level:0,angle:oa});
});

test('guild quest guards retain exact source thresholds and outer exit direction',()=>{
 for(const [file,loc,varp,minimum,whenAxis] of [
 ['areas/area_varrock/scripts/champions_guild.rs2','championdoor','qp',32,undefined],
 ['areas/areas_heroes_guild/scripts/heroes_entrance.rs2','herodoor_l','heroquest',15,undefined],
 ['quests/quest_legends/scripts/legends_door.rs2','legendsguilddoorl','legendsquest',50,undefined],
 ['quests/quest_legends/scripts/legends_gate.rs2','legendsguildgatel','legendsquest',1,true],
 ] as const){const rule=classifyDoor(loc,undefined,parseTriggers([{file,text:readFileSync(join(root,file),'utf8')}]));expect(rule).toMatchObject({kind:'quest',need:{varp,minimum,...(whenAxis===undefined?{}:{whenAxis})}});}
});
