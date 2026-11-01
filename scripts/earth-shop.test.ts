import {test,expect} from 'bun:test';
import {earthRefillAmount,earthSeedNeeded,earthRefillStop} from './earth-shop';

test('competing buyers must not make a single available refill unbuyable',()=>{
 expect(earthRefillAmount(0,1136)).toBe(0);
 expect(earthRefillAmount(1,1136)).toBe(1);
 expect(earthRefillAmount(3,1136)).toBe(3);
 expect(earthRefillAmount(1000,7)).toBe(7);
 expect(earthRefillAmount(1000,1136)).toBe(50);
 expect(()=>earthRefillAmount(NaN,1)).toThrow();
});
test('a funded purchase race keeps its no-progress clock; lack of funds never retries',()=>{
 expect(earthRefillStop(24,true)).toBeUndefined();
 expect(earthRefillStop(25,true)).toBe('stock-wait');
 expect(earthRefillStop(0,false)).toBe('budget');
 expect(earthRefillStop(25,false)).toBe('budget');
});
test('one owned seed may precede refill; missing stock observation or prior seed refuses it',()=>{
 expect(earthSeedNeeded(0,1,false)).toBe(true);
 expect(earthSeedNeeded(1,1,false)).toBe(true);
 expect(earthSeedNeeded(NaN,1,false)).toBe(false);
 expect(earthSeedNeeded(0,0,false)).toBe(false);
 expect(earthSeedNeeded(0,1,true)).toBe(false);
});
