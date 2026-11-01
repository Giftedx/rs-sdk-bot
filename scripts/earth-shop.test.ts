import {test,expect} from 'bun:test';
import {earthRefillAmount,earthSeedNeeded,earthRefillStop,buyEarthObserved,sellEarthSeedObserved} from './earth-shop';

test('competing buyers must not make a single available refill unbuyable',()=>{
 expect(earthRefillAmount(0,1136)).toBe(0);
 expect(earthRefillAmount(1,1136)).toBe(1);
 expect(earthRefillAmount(3,1136)).toBe(1);
 expect(earthRefillAmount(1000,7)).toBe(1);
 expect(earthRefillAmount(1000,1136)).toBe(1);
 expect(()=>earthRefillAmount(NaN,1)).toThrow();
});
test('seed sale credit must arrive before a purchase can use its wallet baseline',async()=>{
 let coins=1000,earth=1,tick=0;const listeners=new Set<()=>void>();
 const inventory=()=>[{id:995,name:'Coins',count:coins},{id:557,name:'Earth rune',count:earth}];
 const s:any={tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},ended:new Promise(()=>{}),
  sdk:{getInventory:inventory,getState:()=>({tick,inventory:inventory()})},bot:{sellToShop:async()=>{earth--;return{success:true};}}};
 const clock=setInterval(()=>{tick++;if(tick===3)coins+=2;for(const cb of [...listeners])cb();},2);
 try{expect(await sellEarthSeedObserved(s,()=>false)).toBe(2);expect(tick).toBeGreaterThanOrEqual(3);}finally{clearInterval(clock);}
});
test('an item packet before its coin debit cannot settle a purchase at zero cost',async()=>{
 let coins=1000,earth=0,tick=0;const listeners=new Set<()=>void>();
 const inventory=()=>[{id:995,name:'Coins',count:coins},{id:557,name:'Earth rune',count:earth}];
 const s:any={tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},ended:new Promise(()=>{}),
  sdk:{getInventory:inventory,getState:()=>({tick,inventory:inventory(),shop:{shopItems:[{id:557,name:'Earth rune',count:10,baseCost:4}],shopConfig:{sellMultiplier:1000}}})},
  bot:{buyFromShop:async()=>{earth++;return{success:true};}}};
 const clock=setInterval(()=>{tick++;if(tick===3)coins-=6;for(const cb of [...listeners])cb();},2);
 try{expect(await buyEarthObserved(s,1,900,24,()=>false)).toEqual({bought:1,spent:6});expect(tick).toBeGreaterThanOrEqual(3);}finally{clearInterval(clock);}
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
