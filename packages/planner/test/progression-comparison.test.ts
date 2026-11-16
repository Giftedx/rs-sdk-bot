import {expect,test} from 'bun:test';
import {compareProgressionRuns,type ProgressionRun} from '../src/progression-comparison';
const runs=():ProgressionRun[]=>['chickens','troopers','adaptive'].flatMap(mode=>[7,8,9].map(seed=>({ok:true,mode,seed,source:'a'.repeat(64),entrySha256:'b'.repeat(64),target:83,ticks:mode==='chickens'?1000:400,elapsedMs:mode==='chickens'?5000:2000,xpGain:30000,checks:{saved:true,assets:true,logout:true},result:{method:mode==='chickens'?'ranged/chickens':'ranged/troopers',targetMet:true}})));
test('three matched seeds compare whole target time and retain raw measurements',()=>{
 const r=compareProgressionRuns(runs());expect(r.ok).toBe(true);expect(r.faster).toBe(true);expect(r.seeds).toEqual([7,8,9]);
 expect(r.rows.find(row=>row.mode==='adaptive')?.ticks).toEqual([400,400,400]);
});
test('missing seeds, duplicated seeds and a failed native stage cannot prove speed',()=>{
 for(const input of [runs().slice(1),[...runs(),runs()[0]!],runs().map((r,i)=>i===0?{...r,checks:{...r.checks,assets:false}}:r)])expect(compareProgressionRuns(input).ok).toBe(false);
});
test('different source bytes, entry states or finite targets cannot be mixed',()=>{
 for(const changes of [{source:'c'.repeat(64)},{entrySha256:'c'.repeat(64)},{target:85}])expect(compareProgressionRuns(runs().map((r,i)=>i===0?{...r,...changes}:r)).ok).toBe(false);
});
test('a correct route that is slower cannot pass the faster-route contract',()=>{
 const r=compareProgressionRuns(runs().map(row=>row.mode==='adaptive'?{...row,ticks:1100}:row));expect(r.ok).toBe(false);expect(r.faster).toBe(false);
});
test('invalid time or incomplete targets stay failed evidence',()=>{
 for(const changes of [{ticks:0},{elapsedMs:NaN},{result:{targetMet:false}}])expect(compareProgressionRuns(runs().map((r,i)=>i===0?{...r,...changes}:r)).ok).toBe(false);
});
