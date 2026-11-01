import{test,expect}from'bun:test';
import{shopSupplyChecks,shopRepeatChecks,shopRefusalChecks}from'../src/shop-supply-order-proof';
const save=(earth=3,coins=352288)=>({position:{x:3252,z:3420,level:0},skills:{3:{level:35,xp:10000}},inventories:{93:[],94:[],95:[{id:557,count:earth},{id:554,count:1482},{id:995,count:coins},{id:1277,count:1}]}} as any);
const run=(bought=1136,spent=6816,target=1)=>({code:0,timedOut:false,hpMin:35,log:`LOGOUT logged-out\nRESULT ok ticks=500 boughtTotal=${bought} spentTotal=${spent} stop=stock-target targetMet=${target}\n`});
test('saved shop supply binds exact new stock, money, retained fire, assets and logout',()=>{
 const before=save(),after=save(1139,345472);
 expect(Object.values(shopSupplyChecks(before,after,run())).every(Boolean)).toBe(true);
 for(const mutate of [(s:any)=>s.inventories[95][0].count--,(s:any)=>s.inventories[95][1].count--,(s:any)=>s.inventories[95][2].count--,(s:any)=>s.inventories[95][3].count--]){
  const bad=structuredClone(after);mutate(bad);expect(Object.values(shopSupplyChecks(before,bad,run())).every(Boolean)).toBe(false);
 }
 expect(shopSupplyChecks(before,after,{...run(),log:run().log.replace('LOGOUT logged-out','LOGOUT timeout')}).logout).toBe(false);
 expect(shopSupplyChecks(before,after,{...run(),hpMin:0}).health).toBe(false);
});
test('target repeat cannot buy again or debit coins; refusal retains every asset',()=>{
 const after=save(1139,345472);
 expect(Object.values(shopRepeatChecks(after,after,run(0,0))).every(Boolean)).toBe(true);
 expect(Object.values(shopRepeatChecks(after,save(1140,345470),run(1,2))).every(Boolean)).toBe(false);
 const poor=save(3,30000),refused={...run(0,0,0),log:run(0,0,0).log.replace('stock-target','stock-wait')};
 expect(Object.values(shopRefusalChecks(poor,poor,refused)).every(Boolean)).toBe(true);
 expect(Object.values(shopRefusalChecks(poor,save(3,29999),refused)).every(Boolean)).toBe(false);
});
