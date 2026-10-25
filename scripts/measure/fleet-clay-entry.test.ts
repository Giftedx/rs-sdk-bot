import {test,expect} from 'bun:test';
import {clayEntryStart,clayEntryRoute,prepareClayEntry,clayEntryAssets,clayEntryPreserved} from './fleet-clay-entry';
import type {Session} from '../../packages/core/src/inprocess';
test('entry is east-bank only and route uses city road before the west bank',()=>{
 expect(clayEntryStart(null)).toBe(false);
 expect(clayEntryStart({worldX:3252,worldZ:3420,level:0})).toBe(true);
 expect(clayEntryStart({worldX:3185,worldZ:3436,level:0})).toBe(false);expect(clayEntryStart({worldX:3252,worldZ:3420,level:1})).toBe(false);
 expect(clayEntryRoute()).toEqual([{x:3253,z:3420,tol:1},{x:3245,z:3429,tol:1},{x:3210,z:3428,tol:1},{x:3185,z:3436,tol:1}]);
});
function fixture(mode='ok') {
 const inv=[{id:1265,count:1,slot:0,name:'Bronze pickaxe'},{id:315,count:1,slot:1,name:'Shrimps'},{id:2309,count:1,slot:2,name:'Bread'}];
 const bank=[{id:995,count:25,slot:0,name:'Coins'},{id:1925,count:mode==='missing'?0:1,slot:1,name:'Bucket'},{id:436,count:10,slot:2,name:'Copper ore'},{id:438,count:9,slot:3,name:'Tin ore'}];
 let withdrawals=0,closed=0;const listeners=new Set<()=>void>(),timer=setInterval(()=>{for(const cb of [...listeners])cb();},1);
 const s={onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},sdk:{getInventory:()=>inv,getEquipment:()=>[],getState:()=>({player:{worldX:3252,worldZ:3420,level:0},bank:{items:bank}})},bot:{
  openBank:async()=>({success:true}),closeBank:async()=>{closed++;return{success:true};},
  withdrawItem:async(item:typeof bank[number],count:number,options:unknown)=>{withdrawals++;expect(count).toBe(1);expect(options).toEqual({asNote:false});if(mode!=='partial'){item.count--;inv.push({id:1925,count:1,slot:3,name:'Bucket'});}return{success:true};}
 }} as unknown as Session;
 return{s,inv,bank,withdrawals:()=>withdrawals,closed:()=>closed,close:()=>clearInterval(timer)};
}
test('withdraws the one owned bucket and preserves pick, two foods, coins and bank ores',async()=>{
 const f=fixture();try{const before=await prepareClayEntry(f.s);expect(f.withdrawals()).toBe(1);expect(f.closed()).toBe(1);expect(f.inv.find(i=>i.id===1925)?.count).toBe(1);expect(f.inv.slice(0,3).map(i=>i.id)).toEqual([1265,315,2309]);expect(clayEntryPreserved(before,clayEntryAssets(f.s))).toBe(true);}finally{f.close();}
});
test('missing or unobserved bucket withdrawal fails once with no progress; existing held bucket is reused',async()=>{
 for(const mode of ['missing','partial']){const f=fixture(mode);try{await expect(prepareClayEntry(f.s)).rejects.toThrow('no clay entry progress');expect(f.inv.some(i=>i.id===1925)).toBe(false);expect(f.closed()).toBe(1);}finally{f.close();}}
 const f=fixture();f.inv.push({id:1925,count:1,slot:3,name:'Bucket'});try{await prepareClayEntry(f.s);expect(f.withdrawals()).toBe(0);}finally{f.close();}
});
test('asset proof rejects loss of working food or bank stock',()=>{
 const before=new Map([[315,1],[2309,1],[1925,1],[436,10]]),after=new Map(before);expect(clayEntryPreserved(before,after)).toBe(true);after.set(436,9);expect(clayEntryPreserved(before,after)).toBe(false);after.set(436,10);after.delete(315);expect(clayEntryPreserved(before,after)).toBe(false);
});
