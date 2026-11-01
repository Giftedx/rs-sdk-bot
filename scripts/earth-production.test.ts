import {expect,test} from 'bun:test';
import {productionBatch,productionConserved,talismanTarget,huntFight,collectHuntLoot,stageOwnedEquipment} from './earth-production';

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
 try{await huntFight(s,npc,()=>false,()=>food);expect(attacks).toBe(2);expect(tick).toBeLessThan(100);}finally{clearInterval(timer);}
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
test('equipping closes the bank, so every missing kit item must be withdrawn first',async()=>{
 let open=true;const pack=new Set<number>(),worn=new Set<number>();
 await stageOwnedEquipment([1277,1171,1115],()=>[...worn],async id=>{if(!open)throw Error('bank closed before kit withdrawal');pack.add(id);},async()=>{open=false;},async id=>{open=false;if(!pack.has(id))throw Error('kit item missing');pack.delete(id);worn.add(id);});
 expect([...worn]).toEqual([1277,1171,1115]);expect(pack.size).toBe(0);
});
