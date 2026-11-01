import {expect,test,spyOn} from 'bun:test';
import {productionBatch,productionConserved,talismanTarget,huntFight,collectHuntLoot,depositEarthInventory} from './earth-production';

test('Earth cleanup banks eight nonstackable cakes and the remaining kit once per current item ID',async()=>{
 let pack=[...Array.from({length:8},(_,slot)=>({id:1891,name:'Cake',count:1,slot})),
  {id:1277,name:'Bronze sword',count:1,slot:8},{id:1277,name:'Bronze sword',count:1,slot:9}];
 let generation=9,checks=0;
 const bank=[{id:1891,name:'Cake',count:0},{id:1277,name:'Bronze sword',count:3}];
 const calls:number[]=[],receipts:any[]=[];
 const s:any={name:'fixture',tick:()=>1,sdk:{getInventory:()=>pack,getState:()=>({inventory:pack})},
  bankObservation:()=>({generation,at:1,items:bank}),
  bot:{depositItem:async(item:any,amount:number)=>{
   expect(pack.find(i=>i.id===item.id)).toBe(item);expect(amount).toBe(-1);calls.push(item.id);
   bank.find(i=>i.id===item.id)!.count+=pack.filter(i=>i.id===item.id).reduce((n,i)=>n+i.count,0);
   pack=pack.filter(i=>i.id!==item.id).map((i,slot)=>({...i,slot}));generation++;
   return{success:true};
  }}};
 const log=spyOn(console,'log').mockImplementation(line=>{if(String(line).startsWith('DEPOSIT_RECEIPT '))receipts.push(JSON.parse(String(line).slice('DEPOSIT_RECEIPT '.length)));});
 try{
  await depositEarthInventory(s,()=>{checks++;});
  expect(pack).toEqual([]);expect(calls).toEqual([1891,1277]);expect(checks).toBe(2);
  expect(bank.map(i=>i.count)).toEqual([8,5]);
  expect(receipts.map(r=>({id:r.itemId,amount:r.amount,packAfter:r.packAfter,bankBefore:r.bankBefore,bankAfter:r.bankAfter,generationBefore:r.generationBefore,generationAfter:r.generationAfter}))).toEqual([
   {id:1891,amount:8,packAfter:0,bankBefore:0,bankAfter:8,generationBefore:9,generationAfter:10},
   {id:1277,amount:2,packAfter:0,bankBefore:3,bankAfter:5,generationBefore:10,generationAfter:11}]);
  await depositEarthInventory(s,()=>{checks++;});expect(calls).toEqual([1891,1277]);expect(checks).toBe(2);
 }finally{log.mockRestore();}
});

test('a level-one order buys only the air unlock, then switches to earth and bounds its last batch',()=>{
 expect(productionBatch(1,0,1137,625)).toEqual({rune:556,talisman:1438,essence:7,multiple:1});
 expect(productionBatch(9,875,1137,618).rune).toBe(557);
 expect(productionBatch(26,10000,3,100).essence).toBe(2);
 expect(productionBatch(52,100000,1,100).essence).toBe(1);
 expect(productionBatch(52,100000,0,100).essence).toBe(0);
});
test('a mid-fight food action re-engages the same observed target within one fight budget',async()=>{
 let tick=0,food=0,xp=0,attacks=0;const callbacks=new Set<()=>void>(),npc={id:1,index:7,hp:7};let alive=true;
 const s={tick:()=>tick,onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);},sdk:{getSkillXp:()=>xp,getState:()=>({nearbyNpcs:alive?[npc]:[]})},bot:{attack:async(n:any)=>{expect(n.index).toBe(7);attacks++;return{success:true};}}} as any;
 const timer=setInterval(()=>{tick++;if(tick===3)food++;if(attacks>=2&&tick>=5){xp=700;alive=false;}for(const cb of callbacks)cb();},1);
 try{expect(await huntFight(s,npc,()=>false,()=>food)).toBe(true);expect(attacks).toBe(2);expect(tick).toBeLessThan(100);}finally{clearInterval(timer);}
});

test('a target lost to another player during approach yields without claiming a kill',async()=>{
 let tick=0,alive=true,attacks=0;const callbacks=new Set<()=>void>(),npc={id:100,index:2888,hp:5};
 const s={tick:()=>tick,onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);},sdk:{getSkillXp:()=>82100,getState:()=>({nearbyNpcs:alive?[npc]:[]})},bot:{attack:async()=>{attacks++;alive=false;return{success:false,message:'target disappeared'};}}} as any;
 const timer=setInterval(()=>{tick++;for(const cb of callbacks)cb();},1);
 try{expect(await huntFight(s,npc,()=>false,()=>0)).toBe(false);expect(attacks).toBe(1);expect(tick).toBeLessThan(10);}finally{clearInterval(timer);}
});

test('a vanished target can still receive delayed own credit; a living stalled target keeps its deadline',async()=>{
 for(const lost of [true,false]){
  let tick=0,xp=0,attacks=0;const callbacks=new Set<()=>void>(),npc={id:100,index:2888,hp:5};
  const s={tick:()=>tick,onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);},sdk:{getSkillXp:()=>xp,getState:()=>({nearbyNpcs:lost?[]:[npc]})},bot:{attack:async()=>{attacks++;return{success:true};}}} as any;
  const timer=setInterval(()=>{tick++;if(lost&&tick===2)xp=500;for(const cb of callbacks)cb();},1);
  try{if(lost)expect(await huntFight(s,npc,()=>false,()=>0)).toBe(true);else{await expect(huntFight(s,npc,()=>false,()=>0)).rejects.toThrow('earth hunt fight credit deadline');expect(attacks).toBe(4);}}finally{clearInterval(timer);}
 }
});
test('unknown inputs never dispatch crafting or authorize an unsupported hunt',()=>{
 for(const n of [-1,NaN,Infinity,1.2])expect(()=>productionBatch(9,875,n,100)).toThrow();
 expect(talismanTarget(1440)).toEqual({id:1440,npcIds:[1,2,3,4,5,6],spot:{x:3221,z:3219}});
 expect(talismanTarget(1438).npcIds).toEqual([100]);
 expect(()=>talismanTarget(557)).toThrow();
});
test('a talisman published after the NPC death delay is collected before leaving the kill',async()=>{
 let tick=0,picked=0;const callbacks=new Set<()=>void>(),pack:any[]=[],ground:any[]=[];
 const s={tick:()=>tick,onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);},sdk:{getInventory:()=>pack,getState:()=>({groundItems:ground})},bot:{pickupItem:async()=>{picked++;pack.push({id:1440,count:1});return{success:true};}}} as any;
 const timer=setInterval(()=>{tick++;if(tick===4)ground.push({id:1440,count:1,distance:1});for(const cb of callbacks)cb();},1);
 try{expect(await collectHuntLoot(s,()=>false,true)).toEqual({id:1440,count:1});expect(picked).toBe(1);}finally{clearInterval(timer);}
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
