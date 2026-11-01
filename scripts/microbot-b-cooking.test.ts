import {test,expect} from 'bun:test';
import {cookingRecipes,cookingEffect,runCookingBatch,type CookingDriver} from './microbot-b-cooking';
import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';

test('native gnome resolver XP waits for the later inventory publication',()=>{
 const r=cookingRecipes().recipes.find(r=>r.name==='cooking_generic_unfinished_gnome_batta')!;
 const before={items:{[r.raw]:1,995:1000},xp:100};
 expect(cookingEffect(r,before,{items:{...before.items},xp:160})).toBeNull();
 const product=r.products[0]!;
 const output={items:{[product]:1,995:1000,...r.additional===undefined?{}:{[r.additional]:1}},xp:160};
 expect(cookingEffect(r,before,output)?.kind).toBe('cooked');
 expect(()=>cookingEffect(r,before,{items:{...before.items},xp:99})).toThrow();
 expect(()=>cookingEffect(r,before,{...output,items:{...output.items,995:999}})).toThrow();
});
test('every useful native cooking row has reconciled success and burn/container outcomes',()=>{
 const {recipes,blocked}=cookingRecipes();expect(recipes.length).toBeGreaterThan(45);expect(blocked.length).toBe(3);
 for(const r of recipes){
  const before={items:{[r.raw]:2,999999:1},xp:100};
  for(const product of r.products){const after=structuredClone(before);after.items[r.raw]!--;after.items[product]=(after.items[product]??0)+1;if(r.additional!==undefined&&!r.noAdditionalSuccess)after.items[r.additional]=(after.items[r.additional]??0)+1;after.xp+=r.xp>0?1:0;expect(cookingEffect(r,before,after)?.kind).toBe('cooked');}
  if(r.burnt!==undefined){const after=structuredClone(before);after.items[r.raw]!--;after.items[r.burnt]=(after.items[r.burnt]??0)+1;if(r.additional!==undefined)after.items[r.additional]=(after.items[r.additional]??0)+1;expect(cookingEffect(r,before,after)?.kind).toBe('burnt');}
 }
});
test('cake returns tin both outcomes; first-stage gnome retains mould only on burn',()=>{
 const {recipes}=cookingRecipes(),cake=recipes.find(r=>r.name==='cooking_generic_cake')!,gnome=recipes.find(r=>r.name==='cooking_generic_half_baked_batta')!;
 expect(cake.additional).toBeDefined();expect(cake.fire).toBe(false);expect(cake.range).toBe(true);expect(gnome.noAdditionalSuccess).toBe(true);
 const before={items:{[cake.raw]:1},xp:10},after={items:{[cake.products[0]!]:1},xp:20};expect(()=>cookingEffect(cake,before,after)).toThrow('returned container');
 const dynamic=recipes.find(r=>r.name==='cooking_generic_unfinished_gnome_batta')!;expect(dynamic.products.length).toBe(6);
});
test('finite staged cooker reports successful and burnt products separately',async()=>{
 const r=cookingRecipes().recipes.find(r=>r.name==='cooking_generic_bread')!;let tick=0,n=0;
 let current={player:{lifeId:1,level:0},inventory:[{id:r.raw,count:2,slot:0}],skills:[{name:'Cooking',level:99,experience:100},{name:'Hitpoints',level:10}]} as unknown as BotWorldState;
 const d:CookingDriver={state:()=>current,tick:()=>tick,stop:()=>false,close:async()=>{},heat:async()=>{current=structuredClone(current);current.inventory[0]!.count--;const product=n++===0?r.products[0]!:r.burnt!;current.inventory.push({id:product,count:1,slot:n} as any);if(n===1)current.skills[0]!.experience+=40;return true;},wait:async test=>test(),step:async()=>{tick++;}};
 expect(await runCookingBatch(d,r,{maximum:2,cap:100,heat:'range'})).toEqual({processed:2,cooked:1,burnt:1,products:{[r.products[0]!]:1,[r.burnt!]:1},xp:40,ticks:1});
 await expect(runCookingBatch(d,r,{maximum:1,cap:100,heat:'fire'})).rejects.toThrow('forbids');
});
