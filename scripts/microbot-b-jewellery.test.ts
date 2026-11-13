import {test,expect} from 'bun:test';
import {jewelleryRecipes,jewelleryMenu,jewellerySnapshot,runJewellery,type JewelleryDriver} from './microbot-b-jewellery';
import {productionEffect} from './microbot-production';
import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';
test('all 23 native jewellery struct rows have exact mould, level and conversion contract',()=>{
 const recipes=jewelleryRecipes();expect(recipes.length).toBe(23);
 for(const r of recipes){expect(r.tools.length).toBe(1);expect(r.level).toBeGreaterThan(0);const before={items:Object.fromEntries([...r.inputs.map(i=>[i.id,i.units]),...r.tools.map(id=>[id,1])]),xp:0},after=structuredClone(before);for(const input of r.inputs)after.items[input.id]!-=input.units;after.items[r.product]=(after.items[r.product]??0)+1;after.xp=1;expect(productionEffect(r,before,after)).toBe('made');}
 const ruby=recipes.find(r=>r.name==='ruby_ring')!;expect(jewelleryMenu(ruby,{},true)).toEqual({component:'crafting_jewelry:rings_inv',slot:3,option:1});
 const perfect=recipes.find(r=>r.name==='perfect_ring')!;expect(perfect.bar).not.toBe(ruby.bar);expect(perfect.product).not.toBe(ruby.product);
});
test('silver menu accounts for sickle mould and members; exact holy/unholy positions',()=>{
 const all=jewelleryRecipes(),holy=all.find(r=>r.name==='unstrung_symbol')!,unholy=all.find(r=>r.name==='unstrung_emblem')!,sickle=all.find(r=>r.name==='silver_sickle')!;
 expect(jewelleryMenu(holy,{},false).component).toBe('skill_multi2:make1_b');
 expect(jewelleryMenu(unholy,{},true).component).toBe('skill_multi2:make1_a');
 expect(jewelleryMenu(holy,{[sickle.tools[0]!]:1},true).component).toBe('skill_multi3:make1_b');
 expect(()=>jewelleryMenu(sickle,{},true)).toThrow('sickle mould');
 expect(jewelleryMenu(sickle,{[sickle.tools[0]!]:1},true).component).toBe('skill_multi3:make1_c');
});
test('finite staged jewellery makes products by receipt and rejects perfect-bar precedence',async()=>{
 const r=jewelleryRecipes().find(r=>r.name==='sapphire_ring')!;
 let current={player:{lifeId:1,level:0},interface:{isOpen:true},skills:[{name:'Crafting',level:99,experience:100},{name:'Hitpoints',level:10}],inventory:[...r.tools.map((id,slot)=>({id,count:1,slot})),...r.inputs.map((i,slot)=>({id:i.id,count:2,slot:slot+1}))]} as unknown as BotWorldState,tick=0,selected=0;
 const d:JewelleryDriver={state:()=>current,tick:()=>tick,stop:()=>false,close:async()=>{},open:async()=>true,choose:async menu=>{expect(menu.slot).toBe(1);selected++;current=structuredClone(current);for(const i of r.inputs)current.inventory.find(v=>v.id===i.id)!.count--;const product=current.inventory.find(v=>v.id===r.product);if(product)product.count++;else current.inventory.push({id:r.product,count:1,slot:3} as any);current.skills[0]!.experience++;return true;},wait:async test=>test(),step:async()=>{tick++;}};
 expect(await runJewellery(d,r,{maximum:2,cap:100,members:true})).toEqual({made:2,product:r.product,ticks:1});expect(selected).toBe(2);
 expect(jewellerySnapshot(current).items[r.tools[0]!]).toBe(1);
 const perfect=jewelleryRecipes().find(v=>v.name==='perfect_ring')!;current.inventory.push({id:perfect.bar,count:1,slot:4} as any);
 await expect(runJewellery(d,r,{maximum:1,cap:100,members:true})).rejects.toThrow('precedence');
});
test('a level-up dialog left open does not count as the furnace interface: the menu click waits for the interface',async()=>{
 const r=jewelleryRecipes().find(r=>r.name==='sapphire_ring')!;
 let current={player:{lifeId:1,level:0},interface:{isOpen:false},dialog:{isOpen:true},skills:[{name:'Crafting',level:99,experience:100},{name:'Hitpoints',level:10}],inventory:[...r.tools.map((id,slot)=>({id,count:1,slot})),...r.inputs.map((i,slot)=>({id:i.id,count:1,slot:slot+1}))]} as unknown as BotWorldState,tick=0,early=0;
 const later=(n:number)=>{tick+=n;if(tick>=2)current={...current,interface:{isOpen:true},dialog:{isOpen:false}} as unknown as BotWorldState;};
 const d:JewelleryDriver={state:()=>current,tick:()=>tick,stop:()=>false,close:async()=>{},
  // The driver's own check passes on the stale dialog at once.
  open:async()=>!!current.dialog?.isOpen||!!current.interface?.isOpen,
  choose:async()=>{if(!current.interface?.isOpen){early++;return true;}current=structuredClone(current);for(const i of r.inputs)current.inventory.find(v=>v.id===i.id)!.count--;current.inventory.push({id:r.product,count:1,slot:3} as any);current.skills[0]!.experience++;return true;},
  wait:async(test,ticks)=>{for(let i=0;i<=ticks;i++){if(test())return true;later(1);}return false;},step:async()=>{later(1);}};
 expect(await runJewellery(d,r,{maximum:1,cap:100,members:true})).toEqual({made:1,product:r.product,ticks:2});
 expect(early).toBe(0);
});
