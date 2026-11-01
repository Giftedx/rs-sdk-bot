import {expect,test} from 'bun:test';
import {productionBatch,productionConserved,talismanTarget} from './earth-production';

test('a level-one order buys only the air unlock, then switches to earth and bounds its last batch',()=>{
 expect(productionBatch(1,0,1137,625)).toEqual({rune:556,talisman:1438,essence:7,multiple:1});
 expect(productionBatch(9,875,1137,618).rune).toBe(557);
 expect(productionBatch(26,10000,3,100).essence).toBe(2);
 expect(productionBatch(52,100000,1,100).essence).toBe(1);
 expect(productionBatch(52,100000,0,100).essence).toBe(0);
});
test('unknown inputs never dispatch crafting or authorize an unsupported hunt',()=>{
 for(const n of [-1,NaN,Infinity,1.2])expect(()=>productionBatch(9,875,n,100)).toThrow();
 expect(talismanTarget(1440)).toEqual({id:1440,npcIds:[1,2,3,4,5,6],spot:{x:3221,z:3219}});
 expect(talismanTarget(1438).npcIds).toEqual([100]);
 expect(()=>talismanTarget(557)).toThrow();
});
test('conservation binds essence debit, crafted output and food-stage transformations',()=>{
 const before=new Map([[995,352310],[554,1482],[557,2],[1436,20],[1891,1],[1438,1],[1440,1]]);
 const after=new Map([[995,352310],[554,1482],[557,22],[1436,10],[1893,1],[1438,1],[1440,1]]);
 const ledger={consumed:10,crafted:20,air:0,eaten:{1891:1}};
 expect(productionConserved(before,after,ledger)).toBe(true);
 expect(productionConserved(before,new Map(after).set(995,352309),ledger)).toBe(false);
 expect(productionConserved(before,new Map(after).set(554,1481),ledger)).toBe(false);
 expect(productionConserved(before,new Map(after).set(557,21),ledger)).toBe(false);
 expect(productionConserved(before,new Map(after).set(1436,9),ledger)).toBe(false);
 expect(productionConserved(before,new Map(after).set(1893,0),ledger)).toBe(false);
});
