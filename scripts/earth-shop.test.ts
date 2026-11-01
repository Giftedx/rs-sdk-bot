import {test,expect} from 'bun:test';
import {earthRefillAmount,earthSeedNeeded,earthRefillStop,buyEarthObserved,sellEarthSeedObserved,retainedEarthBank,openEarthBankObserved} from './earth-shop';

test('a confirmed already-open bank needs no new open packet or generation',async()=>{
 let opens=0;const s:any={sdk:{getState:()=>({bank:{isOpen:true}})},bankObservation:()=>({generation:7,items:[{id:557,count:53}]}),bot:{openBank:async()=>{opens++;return{success:true};}}};
 await openEarthBankObserved(s);expect(opens).toBe(0);
});
test('a closed bank still requires its newly observed opening',async()=>{
 let opened=false,opens=0;const s:any={sdk:{getState:()=>({bank:{isOpen:opened}})},bankObservation:()=>opened?{generation:8,items:[]}:null,bot:{openBank:async()=>{opens++;opened=true;return{success:true};}}};
 await openEarthBankObserved(s);expect(opens).toBe(1);
});

test('closing the bank retains its confirmed assets and exact outstanding order quantity',()=>{
 let live:any={items:[{id:557,count:2},{id:995,count:320288}]};
 const bank=retainedEarthBank(()=>live);
 expect(bank()).toEqual(live.items);const old=live.items;live=null;
 expect(bank().find(i=>i.id===557)?.count).toBe(2);
 old[0].count=9000;expect(bank()[0]?.count).toBe(2);
 live={items:[{id:557,count:53},{id:995,count:352047}]};bank();live=null;
 expect(bank()).toEqual([{id:557,count:53},{id:995,count:352047}]);
});

test('competing buyers must not make a single available refill unbuyable',()=>{
 expect(earthRefillAmount(0,1136)).toBe(1);
 expect(earthRefillAmount(0,0)).toBe(0);
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
  sdk:{getInventory:inventory,sendShopBuy:async()=>{earth++;return{success:true};},getState:()=>({tick,inventory:inventory(),gameMessages:[],shop:{isOpen:true,shopItems:[{slot:3,id:557,name:'Earth rune',count:10,baseCost:4}],shopConfig:{sellMultiplier:1000}}})},
  bot:{buyFromShop:async()=>{earth++;return{success:true};}}};
 const clock=setInterval(()=>{tick++;if(tick===3)coins-=6;for(const cb of [...listeners])cb();},2);
 try{expect(await buyEarthObserved(s,1,900,24,()=>false)).toEqual({bought:1,spent:6});expect(tick).toBeGreaterThanOrEqual(3);}finally{clearInterval(clock);}
});

function rawEarthFixture(response:'fill'|'refuse'|'silent'|'chat'){
 let coins=1000,earth=0,tick=0,calls=0;const listeners=new Set<()=>void>();
 const messages=[{observationId:10,tick:0,type:0,sender:'',text:'The shop has run out of stock.'}];
 const inventory=()=>[{id:995,name:'Coins',count:coins},{id:557,name:'Earth rune',count:earth}];
 const s:any={tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},ended:new Promise(()=>{}),
  sdk:{getInventory:inventory,sendShopBuy:async(slot:number,n:number)=>{expect([slot,n]).toEqual([3,1]);calls++;return{success:true};},
   getState:()=>({tick,inventory:inventory(),gameMessages:messages,shop:{isOpen:true,shopItems:[{slot:3,id:557,name:'Earth rune',count:0,baseCost:4}],shopConfig:{sellMultiplier:1000}}})}};
 const clock=setInterval(()=>{tick++;if(calls&&tick===3){if(response==='fill'){earth++;coins-=6;}else if(response==='refuse'||response==='chat')messages.push({observationId:11,tick,type:response==='chat'?2:0,sender:response==='chat'?'Nearby player':'',text:'The shop has run out of stock.'});}for(const cb of [...listeners])cb();},2);
 return{s,calls:()=>calls,close:()=>clearInterval(clock)};
}
test('a stale zero shelf may receive exactly one funded server-current purchase',async()=>{
 const f=rawEarthFixture('fill');try{expect(await buyEarthObserved(f.s,1,900,24,()=>false)).toEqual({bought:1,spent:6});expect(f.calls()).toBe(1);}finally{f.close();}
});
test('only a fresh server refusal can settle a dispatched zero-effect purchase',async()=>{
 const f=rawEarthFixture('refuse');try{expect(await buyEarthObserved(f.s,1,900,24,()=>false)).toEqual({bought:0,spent:0});expect(f.calls()).toBe(1);}finally{f.close();}
});
test('a stale refusal and missing acknowledgement retain an unresolved request',async()=>{
 const f=rawEarthFixture('silent');try{await expect(buyEarthObserved(f.s,1,900,24,()=>false)).rejects.toThrow('unacknowledged');expect(f.calls()).toBe(1);}finally{f.close();}
});
test('nearby public chat cannot acknowledge an unresolved shop request',async()=>{
 const f=rawEarthFixture('chat');try{await expect(buyEarthObserved(f.s,1,900,24,()=>false)).rejects.toThrow('unacknowledged');expect(f.calls()).toBe(1);}finally{f.close();}
});
test('a worst-price funding shortfall cannot submit even one low-level packet',async()=>{
 const f=rawEarthFixture('fill');try{await expect(buyEarthObserved(f.s,1,999,24,()=>false)).rejects.toThrow('funding');expect(f.calls()).toBe(0);}finally{f.close();}
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
