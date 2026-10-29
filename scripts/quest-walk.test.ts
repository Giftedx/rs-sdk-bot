import {expect,test} from 'bun:test';
import {walkQuestCorridor} from './quest-walk';
const points=[{x:10,z:0,tol:0},{x:10,z:10,tol:0},{x:20,z:10,tol:1}];
const result=(next:number,ok=false)=>({ok,next,ticks:5,still:0,clicks:1,repaths:0,doors:0});
test('failed corridor resumes its first unfinished point and preserves every remaining bend',async()=>{
 let tick=0,atGoal=false;const calls:any[]=[];
 const r=await walkQuestCorridor({tick:()=>tick,stop:()=>false,near:()=>atGoal,walk:async(p,o)=>{calls.push({p,budget:o.maxTicks});tick+=5;if(calls.length===1)return result(1);atGoal=true;return result(p.length,true);}},points,20);
 expect(r.ok).toBe(true);expect(calls).toEqual([{p:points,budget:20},{p:points.slice(1),budget:15}]);
});
test('a route that never advances repeats the same corridor, then fails without a direct fallback',async()=>{
 const calls:any[]=[];const r=await walkQuestCorridor({tick:()=>0,stop:()=>false,near:()=>false,walk:async p=>{calls.push(p);return result(0);}},points,20);
 expect(r.ok).toBe(false);expect(calls).toEqual([points,points,points]);
});
test('cancellation or exhausted global deadline stops before another route attempt',async()=>{
 let tick=0,calls=0,stopped=false;
 const r=await walkQuestCorridor({tick:()=>tick,stop:()=>stopped,near:()=>false,walk:async()=>{calls++;tick=10;stopped=true;return result(1);}},points,10);
 expect(r.ok).toBe(false);expect(calls).toBe(1);expect(r.detail).toContain('stopped');
});
test('invalid progress and a false arrival cannot discard unfinished corridor points',async()=>{
 for(const next of [-1,4,1.5]){
  const r=await walkQuestCorridor({tick:()=>0,stop:()=>false,near:()=>false,walk:async()=>result(next)},points,20);
  expect(r.ok).toBe(false);expect(r.detail).toContain('cursor');
 }
 const r=await walkQuestCorridor({tick:()=>0,stop:()=>false,near:()=>false,walk:async()=>result(3,true)},points,20);
 expect(r.ok).toBe(false);expect(r.detail).toContain('arrival');
});
test('a stalled tick transport is surfaced once, not retried as a blocked corridor',async()=>{
 let calls=0;const detail='tick stream stalled: no game tick for15000ms';
 const r=await walkQuestCorridor({tick:()=>0,stop:()=>false,near:()=>false,walk:async()=>{calls++;return{...result(0),detail};}},points,20);
 expect(r).toEqual({ok:false,detail});expect(calls).toBe(1);
});
