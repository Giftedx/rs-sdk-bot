import {test,expect} from 'bun:test';
import {inventoryRecipes,productionEffect,runInventoryProduction,runInventoryBank,type ProductionIO} from './microbot-production';
test('every inventory recipe resolves native IDs and preserves tools in its receipt',()=>{
 const recipes=inventoryRecipes();expect(recipes.length).toBeGreaterThanOrEqual(20);
 expect(new Set(recipes.map(r=>r.name)).size).toBe(recipes.length);
 const gem=recipes.find(r=>r.name==='cut-sapphire')!;
 const b={items:{[gem.inputs[0]!.id]:1,[gem.tools[0]!]:1},xp:100};
 const a={items:{[gem.product]:1,[gem.tools[0]!]:1},xp:150};
 expect(productionEffect(gem,b,a)).toBe('made');
 expect(productionEffect(gem,b,{...a,items:{...a.items,[gem.tools[0]!]:0}})).toBe('invalid');
 expect(productionEffect(gem,b,b)).toBe('none');
 expect(productionEffect(gem,b,{...a,xp:100})).toBe('invalid');
});
test('gem failure has an exact crushed output and never counts as the desired gem',()=>{
 const r=inventoryRecipes().find(r=>r.name==='cut-opal')!;
 const b={items:{[r.inputs[0]!.id]:1,[r.tools[0]!]:1},xp:100};
 const a={items:{[r.lossProduct!]:1,[r.tools[0]!]:1},xp:104};
 expect(productionEffect(r,b,a)).toBe('loss');
 expect(productionEffect(r,b,{...a,items:{...a.items,995:1}})).toBe('invalid');
});
test('native recipe tables cover leather menus and thread consumption without accepting extra losses',()=>{
 const r=inventoryRecipes().find(r=>r.name==='leather:leather_gloves')!;
 expect(r.menu).toBe('leather_crafting:com_116');
 const thread=r.optionalInputs![0]!,raw=r.inputs[0]!;
 const b={items:{[raw.id]:raw.units,[r.tools[0]!]:1,[thread]:2},xp:100};
 const a={items:{[r.product]:1,[r.tools[0]!]:1,[thread]:2},xp:113.8};
 expect(productionEffect(r,b,a)).toBe('made');
 expect(productionEffect(r,b,{...a,items:{...a.items,[thread]:1}})).toBe('made');
 expect(productionEffect(r,b,{...a,items:{...a.items,[thread]:0}})).toBe('invalid');
 expect(inventoryRecipes().find(r=>r.name==='glass:stafforb')!.menu).toBe('skill_multi3:make1_c');
 expect(inventoryRecipes().filter(r=>r.name.startsWith('bow-string:')).length).toBe(12);
 expect(inventoryRecipes().find(r=>r.name==='cut-bow:unstrung_shortbow')!.menu).toBe('skill_multi3:make1_b');
 expect(inventoryRecipes().find(r=>r.name==='cut-bow:unstrung_magic_longbow')!.menu).toBe('skill_multi2:make1_b');
});
test('native bankstanding recipes include herb identification and named mixtures',()=>{
 const recipes=inventoryRecipes();
 expect(recipes.find(r=>r.name==='identify:guam_leaf')).toMatchObject({skill:'Herblore',level:3,xp:true,itemOption:1});
 expect(recipes.find(r=>r.name==='brew:3dose1attack')!.inputs.length).toBe(2);
 expect(recipes.find(r=>r.name==='brew:unf_guam_potion')).toMatchObject({level:3,xp:false});
 expect(recipes.find(r=>r.name==='darts:bronze_dart')!.productUnits).toBe(10);
 const small=recipes.find(r=>r.name==='bolt-tips:pearl_bolttips')!,large=recipes.find(r=>r.name==='bolt-tips:pearl_bolttips:bigoysterpearls')!;
 expect(small.product).toBe(large.product);expect(small.inputs[0]!.id).not.toBe(large.inputs[0]!.id);
 expect([small.productUnits,large.productUnits]).toEqual([6,24]);
});
test('dough and cake require exact returned containers',()=>{
 const r=inventoryRecipes().find(r=>r.name==='dough:bread:jug_water')!,items=Object.fromEntries(r.inputs.map(i=>[i.id,i.units]));
 const after=Object.fromEntries([{id:r.product,units:1},...r.byproducts!].map(i=>[i.id,i.units]));
 expect(productionEffect(r,{items,xp:0},{items:after,xp:0})).toBe('made');
 delete after[r.byproducts![0]!.id];expect(productionEffect(r,{items,xp:0},{items:after,xp:0})).toBe('invalid');
 expect(inventoryRecipes().find(r=>r.name==='prepare:cake')!.inputs.length).toBe(4);
});
test('finite recipe runner stops at target, banks products and bounds failed actions',async()=>{
 const r=inventoryRecipes().find(r=>r.name==='pie-shell')!;let t=0,n=0,stored=0;
 let items:Record<number,number>={};
 const io:ProductionIO={tick:()=>t,stopped:()=>false,level:()=>99,read:()=>({items:{...items},xp:0}),
  prepare:async()=>{items=Object.fromEntries(r.inputs.map(i=>[i.id,i.units]));return true;},
  use:async()=>{t++;n++;items={[r.product]:1};},wait:async()=>{},
  deposit:async()=>{stored++;items={};return 1;},close:async()=>{}};
 expect(await runInventoryProduction(io,r,{maximum:3,cap:20,maxAttempts:3})).toMatchObject({ok:true,made:3,banked:3,attempts:3});
 expect(n).toBe(3);expect(stored).toBe(3);
 io.use=async()=>{t++;};
 expect((await runInventoryProduction(io,r,{maximum:3,cap:20,maxAttempts:3})).ok).toBe(false);
 expect(stored).toBe(3);
});
for(const name of ['pie-shell','glass:stafforb','leather:leather_gloves','identify:guam_leaf','darts:bronze_dart','dough:bread:jug_water','prepare:cake','pie-shell-stale-modal'])test('SDK adapter: '+name,async()=>{
 const r=inventoryRecipes().find(r=>r.name===name.replace('-stale-modal',''))!,units=r.productUnits??1;
 let pack:{id:number;slot:number;name:string;count:number}[]=[],generation=1,tick=0,xp=100,modal=name.endsWith('-stale-modal'),bankOpen=false;
 const stock=new Map([...r.inputs.map(i=>[i.id,i.units*2] as [number,number]),...r.tools.map(id=>[id,1] as [number,number]),...(r.optionalInputs??[]).map(id=>[id,2] as [number,number])]);
 const bankItems=()=>[...stock].map(([id,count],slot)=>({id,count,slot,name:'item-'+id}));
 const add=(id:number,n:number)=>{const p=pack.find(i=>i.id===id);if(p)p.count+=n;else pack.push({id,count:n,slot:pack.length,name:'item-'+id});};
 const effect=()=>{tick++;for(const i of r.inputs)add(i.id,-i.units);add(r.product,units);for(const i of r.byproducts??[])add(i.id,i.units);if(r.xp)xp+=25;modal=false;};
 const s={name:'fixture',tick:()=>tick,ended:new Promise(()=>{}),onTick:()=>()=>{},
  sdk:{getInventory:()=>pack.filter(i=>i.count>0),getSkill:()=>({level:99}),getSkillXp:()=>xp,getDialog:()=>({isOpen:modal}),
   getState:()=>({player:{lifeId:1},inventory:pack.filter(i=>i.count>0),bank:{isOpen:bankOpen,noteMode:false,items:bankItems()},interface:{isOpen:modal}}),
   sendUseItemOnItem:async(source:number,target:number)=>{expect(pack.find(i=>i.slot===source)).toBeDefined();expect(pack.find(i=>i.slot===target)).toBeDefined();if(r.menu)modal=true;else effect();return{success:true};},
   sendUseItem:async(slot:number,option:number)=>{expect(pack.find(i=>i.slot===slot)?.id).toBe(r.inputs[0]!.id);expect(option).toBe(1);effect();return{success:true};},
   sendClickComponent:async(id:number)=>{const {componentId}=await import('../packages/core/src/logout');expect(id).toBe(componentId(r.menu!));effect();return{success:true};}},
  bankObservation:()=>({generation,items:bankItems().map(({slot,...i})=>i)}),
  bot:{openBank:async()=>{if(modal)return{success:true};modal=true;bankOpen=true;generation++;return{success:true};},closeBank:async()=>{modal=false;bankOpen=false;},
   withdrawItem:async(target:{id:number;slot:number},n:number,o:{asNote:boolean})=>{expect(bankOpen).toBe(true);expect(o.asNote).toBe(false);expect(Number.isInteger(target.slot)).toBe(true);expect(bankItems()[target.slot]?.id).toBe(target.id);stock.set(target.id,stock.get(target.id)!-n);add(target.id,n);generation++;return{success:true};},
   depositItem:async(item:{id:number})=>{const p=pack.find(i=>i.id===item.id)!;stock.set(p.id,(stock.get(p.id)??0)+p.count);p.count=0;generation++;return{success:true};}},
  direct:async()=>{modal=false;return{success:true};}};
 const result=await runInventoryBank(s as any,r,{maximum:units,cap:40,maxAttempts:1,members:true});
 expect(result).toMatchObject({ok:true,made:units,banked:units,attempts:1});
 expect(stock.get(r.product)).toBe(units);for(const i of r.inputs)expect(stock.get(i.id)).toBe(i.units);
});
test('cached bank rows without a fresh open generation never authorize a withdrawal',async()=>{
 const r=inventoryRecipes().find(r=>r.name==='pie-shell')!;let tick=0,bankOpen=false,withdrawals=0;const callbacks=new Set<()=>void>();
 const s:any={tick:()=>tick,ended:new Promise(()=>{}),onTick:(f:()=>void)=>{callbacks.add(f);return()=>callbacks.delete(f)},sdk:{getInventory:()=>[],getSkill:()=>({level:99}),getSkillXp:()=>0,getState:()=>({player:{lifeId:1},inventory:[],bank:{isOpen:bankOpen,noteMode:false,items:[]},interface:{isOpen:false}})},bankObservation:()=>({generation:1,items:[]}),bot:{openBank:async()=>{bankOpen=true;return{success:true}},closeBank:async()=>{bankOpen=false},withdrawItem:async()=>{withdrawals++;return{success:true}}}};
 const timer=setInterval(()=>{tick++;for(const f of callbacks)f();},1);try{const result=await runInventoryBank(s,r,{maximum:1,cap:40,maxAttempts:1});expect(result.ok).toBe(false);expect(result.failure).toContain('fresh bank');expect(withdrawals).toBe(0);}finally{clearInterval(timer)}
});
test('dough checks the actual 28 occupied inventory slots before native menu dispatch',async()=>{
 const r=inventoryRecipes().find(r=>r.name==='dough:bread:jug_water')!;let uses=0,open=true;
 const pack=[...Array.from({length:26},(_,slot)=>({id:590,count:1,slot,name:'Tinderbox'})),...r.inputs.map((i,n)=>({id:i.id,count:1,slot:26+n,name:'input'}))];
 const s:any={tick:()=>0,ended:new Promise(()=>{}),sdk:{getInventory:()=>pack,getSkill:()=>({level:99}),getSkillXp:()=>0,getState:()=>({player:{lifeId:1},inventory:pack,bank:{isOpen:open,noteMode:false,items:[]},interface:{isOpen:open}}),sendUseItemOnItem:async()=>{uses++;return{success:true}}},bankObservation:()=>({generation:1,items:[]}),bot:{closeBank:async()=>{open=false}}};
 const result=await runInventoryBank(s,r,{maximum:1,cap:40,maxAttempts:1});expect(result.ok).toBe(false);expect(result.failure).toContain('inputs unavailable');expect(uses).toBe(0);
});
