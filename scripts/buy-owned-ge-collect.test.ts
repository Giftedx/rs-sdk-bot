import {test,expect} from 'bun:test';
import {collectClaim} from './buy-owned-ge-item';
import type {GEActionResult} from '../vendor/rs-sdk/sdk/ge-types';

// Live offer 72144: a cancelled buy with 0 items and 30000 coins. The live offer view has no
// collectNotes control, so the SDK returns no_control and sends nothing.
const exchange=(controls:string[])=>{
 const calls:boolean[]=[];
 const collect=async(_id:number,notes:boolean):Promise<GEActionResult>=>{
  calls.push(notes);const name=notes?'collectNotes':'collect';
  if(!controls.includes(name))return{success:false,reason:'no_control',message:`GE control ${name} is unavailable on this screen.`};
  return{success:true,message:'Collected 0 items and 30000 gp. Any overflow remains in the exchange.',items:0,coins:30000};
 };
 return{calls,collect};
};

test('coins-only claim without a notes control is collected plain',async()=>{
 const ge=exchange(['collect']);
 const r=await collectClaim(ge.collect,72144,true);
 expect(r.success).toBe(true);expect(r.coins).toBe(30000);expect(ge.calls).toEqual([true,false]);
});
test('notes control present is used once',async()=>{
 const ge=exchange(['collect','collectNotes']);
 expect((await collectClaim(ge.collect,72144,true)).success).toBe(true);expect(ge.calls).toEqual([true]);
});
test('a dispatched failure is never retried',async()=>{
 const calls:boolean[]=[];
 const r=await collectClaim(async(_id,notes)=>{calls.push(notes);return{success:false,reason:'timeout',outcome:'unknown',message:'GE result was not observed.'};},72144,true);
 expect(r.success).toBe(false);expect(calls).toEqual([true]);
});
