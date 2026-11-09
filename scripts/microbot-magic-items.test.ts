import {test,expect} from 'bun:test';
import {itemMagicRecipe,itemSpellCosts,itemSpellEffect} from './microbot-magic-items';
import {objId} from './measure/floor-bands';
test('native recipes include all native jewelry conversions and eight smelting metals',()=>{
 for(const metal of ['bronze','iron','silver','steel','gold','mithril','adamantite','runite'])expect(itemMagicRecipe('superheat:'+metal).product).toBe(objId(metal+'_bar'));
 for(const gem of ['sapphire','emerald','ruby','diamond','dragonstone'])for(const shape of ['ring','amulet'])expect(itemMagicRecipe('enchant:'+(shape==='amulet'?'strung_':'')+gem+'_'+shape).level).toBeGreaterThan(0);
 expect(itemMagicRecipe('enchant:sapphire_necklace').product).toBe(objId('necklace_of_minigames_8'));
 expect(()=>itemMagicRecipe('enchant:emerald_necklace')).toThrow();expect(()=>itemMagicRecipe('superheat:lead')).toThrow();
});
test('alchemy uses native cost and excludes rune targets',()=>{
 const r=itemMagicRecipe('high-alch','bronze_dagger');expect(r.spell).toBe('magic:highlvl_alchemy');expect(r.output).toBeGreaterThan(0);
 expect(itemMagicRecipe('low-alch','bronze_dagger').output).toBeLessThan(r.output);expect(()=>itemMagicRecipe('high-alch','naturerune')).toThrow();
});
test('exact product, all inputs, XP and unrelated assets reconcile',()=>{
 const r=itemMagicRecipe('superheat:steel'),costs=itemSpellCosts(r,[]),before={...costs},after:Record<number,number>={[r.product]:1};
 expect(itemSpellEffect(r,costs,before,before,0,0)).toBe('none');
 expect(itemSpellEffect(r,costs,before,after,0,53)).toBe('cast');
 expect(itemSpellEffect(r,costs,before,{...after,[objId('coal')]:1},0,53)).toBe('invalid');
 expect(itemSpellEffect(r,costs,before,{...after,995:1},0,53)).toBe('invalid');
 expect(itemSpellEffect(r,costs,before,after,0,0)).toBe('invalid');
});
test('only wielded elemental staff substitutes its rune',()=>{
 const r=itemMagicRecipe('superheat:gold');expect(itemSpellCosts(r,[{id:1387,slot:3}])[554]).toBeUndefined();expect(itemSpellCosts(r,[{id:1387,slot:1}])[554]).toBe(4);
});
import {runItemMagic} from './microbot-magic-items';
test('finite runner confirms a real mocked dispatch effect and bounds count',async()=>{
 const r=itemMagicRecipe('superheat:gold');let tick=0,xp=0,calls=0;let inventory=Object.entries(r.inputs).map(([id,count],slot)=>({id:Number(id),count,slot}));
 const state=()=>({player:{worldX:3200,worldZ:3200,lifeId:1,isDead:false},equipment:[],inventory});
 const listeners=new Set<()=>void>();
 const s:any={tick:()=>tick,ended:new Promise(()=>{}),onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f)},sdk:{getState:state,getInventory:()=>inventory,getSkillXp:()=>xp,getSkill:()=>({level:99})},bot:{dismissBlockingUI:async()=>{}},direct:async(a:any)=>{calls++;expect(a.type).toBe('spellOnItem');inventory=[{id:r.product,count:1,slot:0}];xp=53;return{success:true}}};
 const timer=setInterval(()=>{tick++;for(const f of listeners)f();},1);try{const out=await runItemMagic(s,r,{count:1,cap:20});expect(out.ok).toBe(true);expect(out.casts).toBe(1);expect(calls).toBe(1);}finally{clearInterval(timer)}
});
test('finite runner stops before dispatch and refuses insufficient supplies',async()=>{
 const r=itemMagicRecipe('superheat:gold');let calls=0;
 const s:any={tick:()=>0,ended:new Promise(()=>{}),sdk:{getState:()=>({player:{worldX:1,worldZ:1,lifeId:1},equipment:[]}),getInventory:()=>[],getSkillXp:()=>0,getSkill:()=>({level:99})},bot:{dismissBlockingUI:async()=>{}},direct:async()=>{calls++}};
 expect((await runItemMagic(s,r,{count:1,cap:20,stop:()=>true})).stop).toBe('stopped');expect((await runItemMagic(s,r,{count:1,cap:20})).stop).toBe('supplies');expect(calls).toBe(0);
});
import {elementalRuneCost} from './microbot-magic-items';
test('native staff table supports both lava elements and gates member staff on F2P',()=>{
 for(const id of [3053,3054])for(const rune of [554,557]){expect(elementalRuneCost(rune,10,[{id,slot:3}],true)).toBe(0);expect(elementalRuneCost(rune,10,[{id,slot:3}],false)).toBe(10);}
 expect(elementalRuneCost(556,5,[{id:1397,slot:3}],false)).toBe(5);expect(elementalRuneCost(556,5,[{id:1397,slot:3}],true)).toBe(0);expect(elementalRuneCost(556,5,[{id:1381,slot:3}],false)).toBe(0);
});
test('an elemental staff removes spell runes but never the alchemy target debit',()=>{
 const r=itemMagicRecipe('high-alch','airrune');
 expect(r.inputs[r.target]).toBe(1);
 expect(itemSpellCosts(r,[{id:1381,slot:3}])[r.target]).toBe(1);
});
