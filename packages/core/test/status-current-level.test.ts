import {test,expect} from 'bun:test';
import {readFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {startStatus} from '../src/status';

test('status keeps base progress separate from drained or boosted gate stats',()=>{
 const name=`StatusLevels${process.pid}`,file=resolve(import.meta.dir,'../../../.practice/status',name+'.json');
 const state={skills:[{name:'Agility',level:12,baseLevel:56,experience:1_000_000}],inventory:[],equipment:[]};
 const callbacks:(()=>void)[]=[];
 const session:any={name,sdk:{getState:()=>state},tick:()=>1,onTick:(cb:()=>void)=>{callbacks.push(cb);return()=>{};}};
 const status=startStatus(session,'localhost:8888');
 const read=()=>JSON.parse(readFileSync(file,'utf8'));
 try{
  expect(read().skills).toEqual([{name:'Agility',level:56,currentLevel:12,xp:1_000_000}]);
  for(const current of [0,65,110]){
   state.skills[0]!.level=current;for(let n=0;n<5;n++)callbacks.forEach(cb=>cb());
   expect(read().skills[0]).toMatchObject({level:56,currentLevel:current});
  }
 }finally{status.stop();rmSync(file,{force:true});rmSync(file+'.tmp',{force:true});}
});

test('status carries the run energy of the player, and null with no player',()=>{
 const name=`StatusRun${process.pid}`,file=resolve(import.meta.dir,'../../../.practice/status',name+'.json');
 const state:any={skills:[],inventory:[],equipment:[]};
 const callbacks:(()=>void)[]=[];
 const session:any={name,sdk:{getState:()=>state},tick:()=>1,onTick:(cb:()=>void)=>{callbacks.push(cb);return()=>{};}};
 const status=startStatus(session,'localhost:8888');
 const read=()=>JSON.parse(readFileSync(file,'utf8'));
 try{
  expect(read().runEnergy).toBeNull();
  state.player={worldX:3200,worldZ:3200,level:0,runEnergy:64};for(let n=0;n<5;n++)callbacks.forEach(cb=>cb());
  expect(read().runEnergy).toBe(64);
 }finally{status.stop();rmSync(file,{force:true});rmSync(file+'.tmp',{force:true});}
});
