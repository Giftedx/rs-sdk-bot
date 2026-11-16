import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const start=html.indexOf('const age='),source=html.slice(start,html.indexOf('\nconst stateClass=',start));
const base=1_700_000_000_000,minute=60_000;
const ageFor=(state:any)=>new Function('S','ago',source+';return age;')(state,(ms:number)=>ms);

test('hosted evidence ages keep increasing when the snapshot clock freezes at its stale boundary',()=>{
 const ages=[14,15,120].map(minutes=>{
  const elapsed=minutes*minute,state={now:minutes<15?base+elapsed:base,hosted:{at:base},hostedAge:elapsed};
  const before=state.now,result=ageFor(state)(base-5*minute);
  expect(state.now).toBe(before);return result;
 });
 expect(ages).toEqual([19*minute,20*minute,125*minute]);
});

test('native ages and hosted publication lag retain their existing clock meaning',()=>{
 expect(ageFor({now:base+3*minute})(base-5*minute)).toBe(8*minute);
 const state={now:base-2000,hosted:{at:base},hostedAge:20*minute};
 expect(ageFor(state)(base-5*minute)).toBe(25*minute);
 expect(state.now).toBe(base-2000);
 expect(ageFor({now:base+2*minute,hosted:{at:base},hostedAge:0})(base)).toBe(2*minute);
});

test('invalid display metadata cannot advance the clock or turn invalid/future dates into observations',()=>{
 for(const state of [null,undefined])expect(ageFor(state)(undefined)).toBe('?');
 for(const hosted of [undefined,{at:null},{at:0},{at:NaN},{at:'1700000000000'}])
  expect(ageFor({now:base,hosted,hostedAge:20*minute})(base-5*minute)).toBe(5*minute);
 for(const hostedAge of [undefined,null,-1,NaN,Infinity,'1200000'])
  expect(ageFor({now:base,hosted:{at:base},hostedAge})(base-5*minute)).toBe(5*minute);
 const age=ageFor({now:base,hosted:{at:base},hostedAge:20*minute});
 for(const at of [undefined,null,0,-1,NaN,Infinity,'1700000000000',base+21*minute])expect(age(at)).toBe('?');
});
