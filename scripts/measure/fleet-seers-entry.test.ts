import {expect,test} from 'bun:test';
import {seersEntryConfig,seersEntryRoute,seersCarryFares,seersAssetsPreserved} from './fleet-seers-entry';
import type {Session} from '../../packages/core/src/inprocess';
test('forward defaults remain exact; return must use the northern bear detour',()=>{
 expect(seersEntryConfig({})).toEqual({reverse:false,carry:0});
 const original=[[2654,3283],[2809,3441],[2800,3457],[2763,3472],[2727,3492]].map(([x,z])=>({x,z,tol:2}));
 expect(seersEntryRoute()).toEqual(original);
 expect(seersEntryRoute(true)).toEqual([...original.slice(1).reverse(),{x:2677,z:3358,tol:2},{x:2648,z:3358,tol:2},original[0]!]);
 expect(seersEntryRoute()).toEqual(original);
 expect(seersEntryConfig({RETURN_ARDY:'1',CARRY_COINS:'60'})).toEqual({reverse:true,carry:60});
 for(const env of [{RETURN_ARDY:'yes'},{CARRY_COINS:'NaN'},{CARRY_COINS:'-60'},{CARRY_COINS:'59'}])expect(()=>seersEntryConfig(env)).toThrow();
});
function fixture(partial=false) {
 const inv=[{id:1778,count:500,slot:0,name:'Bow string'},{id:333,count:1,slot:1,name:'Trout'},{id:333,count:1,slot:2,name:'Trout'}];
 const bank=[{id:995,count:140,slot:0,name:'Coins'},{id:946,count:1,slot:1,name:'Knife'}];
 const listeners=new Set<()=>void>(),timer=setInterval(()=>{for(const cb of [...listeners])cb();},1);
 const s={onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},sdk:{getInventory:()=>inv,getState:()=>({bank:{items:bank}})},bot:{
  withdrawItem:async(_:unknown,n:number)=>{const count=partial?30:n;bank[0]!.count-=count;inv.push({id:995,count,slot:3,name:'Coins'});return{success:true};},
  depositItem:async()=>{const i=inv.findIndex(i=>i.id===995);bank[0]!.count+=inv[i]!.count;inv.splice(i,1);return{success:true};}
 }} as unknown as Session;
 return{s,inv,bank,close:()=>clearInterval(timer)};
}
test('end withdrawal uses actual60 held and conserves bank plus pouch; cargo and foods never move',async()=>{
 const f=fixture();try{const kit=f.inv.map(i=>({...i}));await seersCarryFares(f.s,60);expect(f.bank[0]!.count).toBe(80);expect(f.inv.find(i=>i.id===995)?.count).toBe(60);expect(f.inv.filter(i=>i.id!==995)).toEqual(kit);}finally{f.close();}
});
test('partial withdrawal despiteAPI success returns actual partial coins and fails offline',async()=>{
 const f=fixture(true);try{await expect(seersCarryFares(f.s,60)).rejects.toThrow('withdrawal incomplete');expect(f.bank[0]!.count).toBe(140);expect(f.inv.some(i=>i.id===995)).toBe(false);}finally{f.close();}
});
test('asset gate requires every cargo, food and bank count; moving60GP is conservation',()=>{
 const initial=new Map([[1778,500],[333,2],[995,140],[946,1]]),final=new Map(initial);
 expect(seersAssetsPreserved(initial,final)).toBe(true);final.set(1778,499);expect(seersAssetsPreserved(initial,final)).toBe(false);final.set(1778,500);final.delete(946);expect(seersAssetsPreserved(initial,final)).toBe(false);
});
test('defaultzero does not touch coins; insufficient ownedbankcoins fail before withdrawal',async()=>{
 const f=fixture();try{await seersCarryFares(f.s,0);expect(f.bank[0]!.count).toBe(140);expect(f.inv.some(i=>i.id===995)).toBe(false);
 f.bank[0]!.count=59;await expect(seersCarryFares(f.s,60)).rejects.toThrow('shortfall');expect(f.bank[0]!.count).toBe(59);expect(f.inv.some(i=>i.id===995)).toBe(false);}finally{f.close();}
});

