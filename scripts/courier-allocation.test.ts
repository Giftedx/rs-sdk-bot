import {test,expect} from 'bun:test';import {courierFoodAllocation as allocate} from './courier-allocation';
test('legacy per-type cap remains per type; optional total conserves mixed stock across four recipients',()=>{
 expect(allocate([34,62],159,24)).toEqual([24,24]);
 const stock=[34,62],lots=[];for(let i=0;i<4;i++){const lot=allocate(stock,159,0,24);lots.push(lot);lot.forEach((n,j)=>stock[j]-=n);}
 expect(lots).toEqual([[24,0],[10,14],[0,24],[0,24]]);expect(stock).toEqual([0,0]);
});
test('demand, stock and both caps bound deliveries; invalid quantities refuse',()=>{
 expect(allocate([10,20],4,0,24)).toEqual([4,0]);expect(allocate([10,20],159,12,24)).toEqual([10,12]);
 expect(allocate([10,20],0,0,24)).toEqual([0,0]);expect(allocate([1,2],159,0,24)).toEqual([1,2]);
 for(const bad of [-1,NaN,Infinity,1.5]){expect(()=>allocate([10],159,0,bad)).toThrow();expect(()=>allocate([bad],159,0,24)).toThrow();}
});
