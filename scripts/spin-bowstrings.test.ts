import {test,expect} from 'bun:test';
import {spinInputFailure} from './spin-bowstrings';
import {isNoProgressFailure,supervise} from '../packages/practice/src/supervise';
test('empty and partial bank-at-reserve batches stop the supervisor after one run',async()=>{
 for(const made of [0,25]) {
  const reason=spinInputFailure(made,500,50,50);let runs=0;
  const end=await supervise({run:async()=>{runs++;return{exitCode:1,stdout:`RESULT fail ${reason} made=${made} rawBank=50 targetMet=0 stop=input-wait`};},stopped:()=>false,pause:async()=>{throw new Error('empty input must not log in again');},maxRestarts:20});
  expect(end).toEqual({reason:'blocked',runs:1});expect(runs).toBe(1);
 }
 expect(spinInputFailure(0,500,49,50)).toContain('no spinning progress');
});
test('a complete backed batch remains successful even when its last flax is the reserve',async()=>{
 expect(spinInputFailure(500,500,50,50)).toBe('');
 const stdout='RESULT ok made=500 rawBank=50 targetMet=1 stop=target';expect(isNoProgressFailure(stdout)).toBe(false);
 expect(await supervise({run:async()=>({exitCode:0,stdout}),stopped:()=>false,pause:async()=>{throw new Error('must finish once');},maxRestarts:20})).toEqual({reason:'done',runs:1});
});
test('a target shortfall with stock still above reserve keeps its other failure cause',()=>{
 expect(spinInputFailure(25,500,550,50)).toBe('');
});
