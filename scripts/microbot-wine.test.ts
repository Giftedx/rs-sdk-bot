import {test,expect} from 'bun:test';
import {wineOutcome} from './microbot-wine';
test('fermentation conserves prepared stock and records bad wine separately',()=>{
 expect(wineOutcome({good:8,bad:2},{good:18,bad:6,raw:0},14)).toEqual({ok:true,good:10,bad:4});
 expect(wineOutcome({good:8,bad:2},{good:8,bad:16,raw:0},14).ok).toBe(false);
 expect(wineOutcome({good:8,bad:2},{good:18,bad:5,raw:1},14).ok).toBe(false);
 expect(wineOutcome({good:8,bad:2},{good:20,bad:6,raw:0},14).ok).toBe(false);
});
import {runMixedWine} from './microbot-wine';
import {inventoryRecipes} from './microbot-production';
test('wine stock reserve refuses a whole order before mixing any reserved input',async()=>{
 const f=wineFixture();try{await expect(runMixedWine(f.s,2,100,()=>false,1)).rejects.toThrow('reserve');expect(f.stock.get(1987)).toBe(2);expect(f.stock.get(1937)).toBe(2);expect(f.stock.get(1995)).toBe(0);}finally{f.close();}
});
function wineFixture(cancel=false){
 const recipe=inventoryRecipes().find(r=>r.name==='wine-unfermented')!;let tick=0,generation=1,bankOpen=false,modal=false,fermentAt=Infinity;
 const stock=new Map<number,number>([[1993,8],[1991,2],[1995,0],...recipe.inputs.map(i=>[i.id,2] as [number,number])]);
 let pack:{id:number;count:number;slot:number;name:string}[]=[],snapshot:{id:number;count:number;name:string}[]=[];const listeners=new Set<()=>void>();
 const publish=()=>{generation++;snapshot=[...stock].map(([id,count])=>({id,count,name:'item-'+id}));};publish();
 const add=(id:number,n:number)=>{let item=pack.find(i=>i.id===id);if(item)item.count+=n;else pack.push({id,count:n,slot:pack.length,name:'item-'+id});};
 const s:any={name:'winefixture',tick:()=>tick,ended:new Promise(()=>{}),onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f)},bankObservation:()=>({generation,items:snapshot}),
  sdk:{getInventory:()=>pack.filter(i=>i.count>0),getEquipment:()=>[],getSkill:()=>({level:99}),getSkillXp:()=>0,getDialog:()=>({isOpen:false}),
   getState:()=>({player:{lifeId:1},inventory:pack.filter(i=>i.count>0),bank:{isOpen:bankOpen,noteMode:false,items:snapshot.map((i,slot)=>({...i,slot}))},interface:{isOpen:modal}}),
   sendUseItemOnItem:async()=>{for(const i of recipe.inputs)add(i.id,-i.units);add(1995,1);fermentAt=tick+20;return{success:true}}},
  bot:{openBank:async()=>{if(modal)return{success:true};bankOpen=true;modal=true;publish();return{success:true}},closeBank:async()=>{bankOpen=false;modal=false},
   withdrawItem:async(item:{id:number;slot:number},n:number,o:{asNote:boolean})=>{expect(bankOpen).toBe(true);expect(o.asNote).toBe(false);expect(snapshot[item.slot]?.id).toBe(item.id);stock.set(item.id,stock.get(item.id)!-n);add(item.id,n);publish();return{success:true}},
   depositItem:async(item:{id:number})=>{const p=pack.find(i=>i.id===item.id)!;stock.set(item.id,(stock.get(item.id)??0)+p.count);p.count=0;publish();return{success:true}}},
  direct:async()=>{bankOpen=false;modal=false;return{success:true}}};
 const timer=setInterval(()=>{tick++;if(tick>=fermentAt&&!modal){const raw=stock.get(1995)??0;stock.set(1995,0);stock.set(1993,(stock.get(1993)??0)+raw);fermentAt=Infinity;}for(const f of listeners)f();},1);
 return{s,stock,stop:()=>cancel&&tick>=5,close:()=>clearInterval(timer),tick:()=>tick};
}
test('wine runner closes bank for native timer and audits a fresh final generation',async()=>{
 const f=wineFixture();try{const r=await runMixedWine(f.s,2,100,f.stop);expect(r).toMatchObject({ok:true,good:2,bad:0,made:2});expect(f.stock.get(1995)).toBe(0);expect(f.stock.get(1993)).toBe(10);}finally{f.close()}
});
test('wine cancellation ends fermentation wait before the full delay',async()=>{
 const f=wineFixture(true);try{const r=await runMixedWine(f.s,2,100,f.stop);expect(r.ok).toBe(false);expect(r.made).toBe(2);expect(f.tick()).toBeGreaterThanOrEqual(5);expect(f.tick()).toBeLessThan(22);}finally{f.close()}
});
