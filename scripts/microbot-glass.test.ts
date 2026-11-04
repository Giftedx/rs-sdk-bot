import {test,expect} from 'bun:test';
import {furnaceGlassRecipe,runFurnaceGlass} from './microbot-glass';
import {productionEffect} from './microbot-production';
test('native furnace glass requires sand, ash, glass, empty bucket and XP',()=>{
 const b={items:{1783:1,1781:1},xp:100},a={items:{1775:1,1925:1},xp:120};
 expect(productionEffect(furnaceGlassRecipe,b,a)).toBe('made');
 expect(productionEffect(furnaceGlassRecipe,b,{items:{1775:1},xp:120})).toBe('invalid');
});
test('finite staged furnace runner stops after requested output',async()=>{
 let tick=0,xp=100,casts=0;const items:Record<number,number>={1783:2,1781:2,995:50};
 const inventory=()=>Object.entries(items).filter(([,count])=>count>0).map(([id,count],slot)=>({id:Number(id),count,slot,name:String(id)}));
 const s:any={tick:()=>tick,ended:new Promise(()=>{}),sdk:{getInventory:inventory,getSkill:()=>({level:10}),getSkillXp:()=>xp,getDialog:()=>({isOpen:false}),getState:()=>({player:{lifeId:1,level:0},interface:{isOpen:false},nearbyLocs:[{id:2781,name:'Furnace',x:3275,z:3186,level:0,distance:1}]}),sendUseItemOnLoc:async(slot:number)=>{expect(inventory().find(i=>i.slot===slot)?.id).toBe(1783);casts++;tick++;items[1783]!--;items[1781]!--;items[1775]=(items[1775]??0)+1;items[1925]=(items[1925]??0)+1;xp+=20;return{success:true};}}};
 expect(await runFurnaceGlass(s,1,20)).toMatchObject({ok:true,made:1});
 expect(casts).toBe(1);expect(items[995]).toBe(50);expect(items[1783]).toBe(1);
});
