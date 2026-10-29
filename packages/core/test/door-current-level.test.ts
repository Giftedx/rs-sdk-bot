import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {accountOf} from '../src/bot';
import {applyKnownDoorBlocks} from '../src/walk';
import {doorBlocks,type Door} from '../src/world';

const door=(JSON.parse(readFileSync(join(import.meta.dir,'../../../knowledge/doors.json'),'utf8')) as Door[]).find(d=>d.loc==='miningguilddoor')!;
const session=(baseLevel:number,level?:number):any=>({sdk:{getState:()=>({skills:[{name:'Mining',baseLevel,...(level===undefined?{}:{level})}],inventory:[]})}});

test('accountOf follows the pinned mining gate stat(), not stat_base()',()=>{
 expect(doorBlocks(door,accountOf(session(60,50)))).toBe(true);
 expect(doorBlocks(door,accountOf(session(59,65)))).toBe(false);
 expect(doorBlocks(door,accountOf(session(60)))).toBe(true);
});

test('native path door masks follow the same current-stat rule as the planner',()=>{
 for(const [base,current,blocked] of [[60,50,true],[59,65,false],[60,undefined,true]] as const){
  const s=session(base,current),calls:unknown[]=[];
  s.sdk.blockDoorTemporarily=(...args:unknown[])=>{calls.push(args);return true;};
  const result=applyKnownDoorBlocks(s.sdk,door.level,{x:door.x-1,z:door.z},{x:door.x+1,z:door.z},[door]);
  expect(result.length>0).toBe(blocked);
  expect(calls).toHaveLength(0); // Actor rules are query masks, never persistent refusal TTLs.
 }
});
