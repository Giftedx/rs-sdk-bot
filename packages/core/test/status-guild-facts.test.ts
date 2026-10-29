import {test,expect} from 'bun:test';
import {readFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {startStatus} from '../src/status';
import {setEquipmentObserved} from '../src/container-observation';
test('status publishes only observed client guild facts, never private varp defaults',()=>{
 const name=`StatusGuild${process.pid}`,path=resolve(import.meta.dir,'../../../.practice/status',name+'.json');
 const callbacks:(()=>void)[]=[],state={player:{worldX:2903,worldZ:3510,level:0},skills:[],inventory:[],equipment:[]};
 let colour=0xff0000;
 const client:any={ingame:true,var:{101:107,188:15,139:75,82:1},varServ:{},ifType:(id:number)=>({colour:id===7363?colour:0xff0000})};
 const session:any={name,client,sdk:{getState:()=>state},tick:()=>1,onTick:(cb:()=>void)=>{callbacks.push(cb);return()=>{};}};
 const status=startStatus(session,'localhost:8888'),read=()=>JSON.parse(readFileSync(path,'utf8'));
 try{
  expect(read().guildFacts).toEqual({varps:{},questStages:{},unlocks:[]});
  expect(read().equipmentObserved).toBe(false);
  client.varServ[101]=32;colour=0x00f800;
  setEquipmentObserved(client,true);
  for(let i=0;i<5;i++)callbacks.forEach(cb=>cb());
  expect(read().guildFacts.varps).toEqual({qp:32});expect(read().guildFacts.questStages).toEqual({heroquest:15});
  expect(read().guildFacts.unlocks).toEqual([]);
  expect(read().equipmentObserved).toBe(true);
 }finally{status.stop();rmSync(path,{force:true});rmSync(path+'.tmp',{force:true});}
});

test('status door states use current exact loc witnesses and do not retain earlier openings',()=>{
 const name=`StatusDoors${process.pid}`,path=resolve(import.meta.dir,'../../../.practice/status',name+'.json');
 const callbacks:(()=>void)[]=[],state:any={inGame:true,player:{worldX:2426,worldZ:3088,level:0},skills:[],inventory:[],equipment:[],nearbyLocs:[{id:4423,x:2426,z:3088,level:0}]};
 const client={ingame:true},session:any={name,client,sdk:{getState:()=>state},tick:()=>1,onTick:(cb:()=>void)=>{callbacks.push(cb);return()=>{};}};
 const status=startStatus(session,'localhost:8888'),read=()=>JSON.parse(readFileSync(path,'utf8'));
 const update=(locs:any[])=>{state.nearbyLocs=locs;for(let i=0;i<5;i++)callbacks.forEach(cb=>cb());};
 try{
  expect(typeof read().doorStates).toBe('object');
  // These are actual pinned Saradomin-right closed/open IDs and shifted tile.
  expect(read().doorStates).toEqual({'0,2426,3088':false});
  update([{id:4425,x:2426,z:3088,level:0}]);expect(read().doorStates).toEqual({});
  update([{id:4425,x:2426,z:3087,level:0}]);expect(read().doorStates).toEqual({'0,2426,3088':true});
  client.ingame=false;update(state.nearbyLocs);expect(read().doorStates).toEqual({});
  client.ingame=true;update(state.nearbyLocs);expect(read().doorStates).toEqual({'0,2426,3088':true});
  update([{id:4423,x:2426,z:3088,level:0},{id:4425,x:2426,z:3087,level:0}]);expect(read().doorStates).toEqual({'0,2426,3088':false});
  update([]);expect(read().doorStates).toEqual({});
  update([{id:4425,x:2426,z:3087,level:1}]);expect(read().doorStates).toEqual({});
  state.inGame=false;update([{id:4425,x:2426,z:3087,level:0}]);expect(read().doorStates).toEqual({});
 }finally{status.stop();rmSync(path,{force:true});rmSync(path+'.tmp',{force:true});}
});
