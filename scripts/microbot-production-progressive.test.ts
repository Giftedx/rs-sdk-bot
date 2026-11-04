import {test,expect} from 'bun:test';
import {progressiveStage,burnBakePreparation,runProgressiveProduction,validateProgressiveProduction,type ProgressiveProduction} from './microbot-production-progressive';
import {inventoryRecipes} from './microbot-production';
import {cookingRecipes} from './microbot-b-cooking';
import {sessionWalker} from '../packages/core/src/walk';
const recipes=inventoryRecipes(),cooks=cookingRecipes().recipes;
function options(mode:ProgressiveProduction['mode']='fletch'):ProgressiveProduction{return{mode,targetLevel:41,maximum:2,batch:1,reserve:1,cap:3000,members:true,bank:{x:3185,z:3436,level:0},...['cooking-prepared','burn-bake'].includes(mode)?{site:{x:2816,z:3443,level:0}}:{}};}
function fixture(base=39,mode:ProgressiveProduction['mode']='fletch'){
 let level=base,stopped=false,drift=false,audits=0;const assets:Record<number,number>={1511:5,1519:5,946:1,995:37},player={lifeId:1,respawnCount:0,isDead:false},client={executeBotAction:()=>{},membersAccount:1},calls:string[]=[],s:any={name:'producer',client,tick:()=>0,ended:new Promise(()=>{}),sdk:{getState:()=>({player}),getSkill:(skill:string)=>({level:skill==='Hitpoints'?99:level,baseLevel:skill==='Hitpoints'?99:level})}};
 const deps:any={recipes,cooks,audit:async()=>{audits++;return{assets:{...assets,...drift?{995:38}:{}},gear:[]};},inventory:async(_s:any,r:any,o:any)=>{calls.push(r.name);expect(o.maximum).toBe(1);for(const i of r.inputs)assets[i.id]-=i.units;assets[r.product]=(assets[r.product]??0)+1;for(const p of r.byproducts??[])assets[p.id]=(assets[p.id]??0)+p.units;if(r.xp)level++;return{ok:true,attempts:1,losses:0,made:1,banked:1};},shafts:async(_s:any,o:any)=>{calls.push('shafts');assets[1511]-=o.maximum;assets[52]=(assets[52]??0)+15*o.maximum;level++;return{ok:true,logsUsed:o.maximum,made:15*o.maximum,banked:15*o.maximum};},cook:async(_s:any,j:any)=>{calls.push(j.recipe);const r=cooks.find(r=>r.name===j.recipe)!;assets[r.raw]-=j.target;assets[r.products[0]!]=(assets[r.products[0]!]??0)+j.target;level++;const banked:Record<number,number>={[r.products[0]!]:j.target};if(r.additional!==undefined){assets[r.additional]=(assets[r.additional]??0)+j.target;banked[r.additional]=j.target;}return{ok:true,atBank:true,completed:j.target,banked};}};
 return{s,deps,assets,player,client,calls,stop:()=>stopped,setStop:()=>stopped=true,setDrift:()=>drift=true,audits:()=>audits,options:options(mode)};
}
test('donor legacy tier boundaries select all native cut/string recipes and reject stringing below5',()=>{
 for(const[level,name]of[[5,'shortbow'],[10,'longbow'],[20,'oak_shortbow'],[25,'oak_longbow'],[35,'willow_shortbow'],[40,'willow_longbow'],[50,'maple_shortbow'],[55,'maple_longbow'],[65,'yew_shortbow'],[70,'yew_longbow'],[80,'magic_shortbow'],[85,'magic_longbow']]as const){expect(progressiveStage('fletch',level,recipes,cooks).name).toBe('cut-bow:unstrung_'+name);expect(progressiveStage('string',level,recipes,cooks).name).toBe('bow-string:'+name);}
 expect(progressiveStage('fletch',4,recipes,cooks).shafts).toBe(true);expect(()=>progressiveStage('string',4,recipes,cooks)).toThrow('requires');
});
test('each receipted batch re-reads base level and switches from willow short to long before spending next log',async()=>{
 const f=fixture();const r=await runProgressiveProduction(f.s,f.options,f.stop,f.deps);expect(r.ok).toBe(true);expect(r.targetMet).toBe(true);expect(f.calls).toEqual(['cut-bow:unstrung_willow_shortbow','cut-bow:unstrung_willow_longbow']);expect(f.assets[1519]).toBe(3);expect(f.assets[995]).toBe(37);expect(r.receipts.map(r=>r.levelBefore)).toEqual([39,40]);
});
test('normal logs use existing shafts worker below5 then parsed normal shortbow, with distinct output quantities',async()=>{
 const f=fixture(4);const r=await runProgressiveProduction(f.s,{...f.options,targetLevel:6},f.stop,f.deps);expect(r.ok).toBe(true);expect(f.calls).toEqual(['shafts','cut-bow:unstrung_shortbow']);expect(r.receipts[0]!.products).toEqual({52:15});expect(f.assets[1511]).toBe(3);
});
test('stringing switches to longbow at10 and consumes only selected unstrung bow/string pairs',async()=>{
 const f=fixture(9,'string');for(const name of['shortbow','longbow'])for(const i of recipes.find(r=>r.name==='bow-string:'+name)!.inputs)f.assets[i.id]=5;const r=await runProgressiveProduction(f.s,{...f.options,targetLevel:11},f.stop,f.deps);expect(r.ok).toBe(true);expect(f.calls).toEqual(['bow-string:shortbow','bow-string:longbow']);expect(f.assets[1511]).toBe(5);
});
test('selected-tier shortage never falls back to lower valuable logs or breaks reserves',async()=>{
 const f=fixture();f.assets[1519]=1;const r=await runProgressiveProduction(f.s,f.options,f.stop,f.deps);expect(r.ok).toBe(false);expect(r.preserved).toBe(true);expect(f.calls).toEqual([]);expect(f.assets[1511]).toBe(5);expect(f.assets[1519]).toBe(1);
});
test('fresh stock drift or original mutable-life replacement prevents next paid batch',async()=>{
 const f=fixture();const audit=f.deps.audit;let n=0;f.deps.audit=async()=>{if(++n===2)f.setDrift();return audit();};expect((await runProgressiveProduction(f.s,f.options,f.stop,f.deps)).ok).toBe(false);expect(f.calls).toEqual([]);
 const g=fixture();const run=g.deps.inventory;g.deps.inventory=async(...args:any[])=>{const r=await run(...args);g.player.lifeId++;return r;};expect((await runProgressiveProduction(g.s,g.options,g.stop,g.deps)).ok).toBe(false);expect(g.calls).toHaveLength(1);
});
test('uncertain child result parks without extra production or cleanup mutation',async()=>{
 const f=fixture();f.deps.inventory=async()=>{f.calls.push('unknown');return{ok:false};};const r=await runProgressiveProduction(f.s,f.options,f.stop,f.deps);expect(r.ok).toBe(false);expect(r.uncertain).toBe(true);expect(r.banked).toBe(false);expect(f.calls).toEqual(['unknown']);expect(f.audits()).toBe(2);
});
test('prepared cooking chooses bread→stew→cake at donor thresholds and preserves returned cake tin',async()=>{
 expect(progressiveStage('cooking-prepared',24,recipes,cooks).name).toBe('cooking_generic_bread');expect(progressiveStage('cooking-prepared',40,recipes,cooks).name).toBe('cooking_generic_stew');expect(progressiveStage('cooking-prepared',41,recipes,cooks).name).toBe('cooking_generic_cake');
 const f=fixture(40,'cooking-prepared');for(const r of cooks.filter(r=>['cooking_generic_stew','cooking_generic_cake'].includes(r.name)))f.assets[r.raw]=3;const r=await runProgressiveProduction(f.s,{...f.options,targetLevel:42},f.stop,f.deps);expect(r.ok).toBe(true);expect(f.calls).toEqual(['cooking_generic_stew','cooking_generic_cake']);expect(r.receipts[1]!.products[cooks.find(r=>r.name==='cooking_generic_cake')!.additional!]).toBe(1);
});
test('stopped entry and unknown member account perform no production',async()=>{
 const f=fixture();f.setStop();expect((await runProgressiveProduction(f.s,f.options,f.stop,f.deps)).ok).toBe(false);expect(f.calls).toEqual([]);const g=fixture();(g.client as any).membersAccount=undefined;expect((await runProgressiveProduction(g.s,g.options,g.stop,g.deps)).ok).toBe(false);expect(g.calls).toEqual([]);expect(()=>validateProgressiveProduction({...f.options,batch:25})).toThrow();
});
test('BurnBaking prepares owned flour/water then two-stage meat stew, reselecting after the cooking level boundary',async()=>{
 const f=fixture(24,'burn-bake');for(const id of[1933,1929,1942,1921,2142])f.assets[id]=3;const r=await runProgressiveProduction(f.s,{...f.options,targetLevel:26},f.stop,f.deps);expect(r.ok).toBe(true);expect(f.calls).toEqual(['dough:bread:bucket_water','cooking_generic_bread','prepare:potato-stew','prepare:uncooked-stew','cooking_generic_stew']);expect(r.preparations).toHaveLength(3);expect(f.assets[1931]).toBe(1);expect(f.assets[1925]).toBe(1);expect(f.assets[995]).toBe(37);
});
test('BurnBaking cake uses existing four-input recipe and returns its tin after heat',async()=>{
 const f=fixture(41,'burn-bake');for(const id of[1887,1933,1944,1927])f.assets[id]=2;const r=await runProgressiveProduction(f.s,{...f.options,targetLevel:42,maximum:1},f.stop,f.deps);expect(r.ok).toBe(true);expect(f.calls).toEqual(['prepare:cake','cooking_generic_cake']);expect(f.assets[1887]).toBe(2);expect(f.assets[1933]).toBe(1);expect(f.assets[1931]).toBe(1);expect(f.assets[1925]).toBe(1);
});
test('BurnBaking uses canonical native chicken recipe when meat is unavailable and refuses missing chicken before mutation',async()=>{
 const f=fixture(25,'burn-bake');f.assets[1997]=2;f.assets[2140]=2;const r=await runProgressiveProduction(f.s,{...f.options,targetLevel:26,maximum:1},f.stop,f.deps);expect(r.ok).toBe(true);expect(f.calls).toEqual(['prepare:uncooked-stew-chicken','cooking_generic_stew']);expect(f.assets[2140]).toBe(1);
 const stage=progressiveStage('burn-bake',25,recipes,cooks);expect(()=>burnBakePreparation(stage,{1921:3,1942:3},{},recipes)).toThrow('meat/chicken');expect(burnBakePreparation(stage,{1921:3,1942:3,2140:3},{1921:1,1942:1,2140:1},recipes).steps.map(r=>r.name)).toEqual(['prepare:potato-stew','prepare:uncooked-stew-chicken']);
});
test('actual return-walker direct continuation parks after executor replacement without walk, door or run inputs',async()=>{
 const f=fixture();let dispatched=0;f.s.onTick=()=>()=>{};f.s.direct=async()=>{dispatched++;};f.deps.inventory=async(view:any)=>{const walker=await sessionWalker(view);await Promise.resolve();f.client.executeBotAction=()=>{};for(const action of[()=>walker.walk(3185,3436),()=>walker.interactLoc!({id:1,x:3184,z:3436}as any,1),()=>walker.runOn!()])await expect(action()).rejects.toThrow('direct original');return{ok:false};};const r=await runProgressiveProduction(f.s,f.options,f.stop,f.deps);expect(r.ok).toBe(false);expect(r.uncertain).toBe(true);expect(dispatched).toBe(0);
});
test('native Crafting progression selects all four staff tiers and only the three native glass tiers',()=>{
 expect(()=>progressiveStage('craft-staff',53,recipes,cooks)).toThrow('54');for(const[level,name]of[[54,'water-battlestaff'],[58,'earth-battlestaff'],[62,'fire-battlestaff'],[66,'air-battlestaff'],[99,'air-battlestaff']]as const)expect(progressiveStage('craft-staff',level,recipes,cooks).name).toBe(name);
 for(const[level,name]of[[1,'glass:beer_glass'],[32,'glass:beer_glass'],[33,'glass:vial_empty'],[45,'glass:vial_empty'],[46,'glass:stafforb'],[99,'glass:stafforb']]as const)expect(progressiveStage('craft-glass',level,recipes,cooks).name).toBe(name);
});
test('native Crafting controller reselects staff and glass after each completed level boundary batch',async()=>{
 for(const[mode,level,names]of[['craft-staff',57,['water-battlestaff','earth-battlestaff']],['craft-glass',32,['glass:beer_glass','glass:vial_empty']],['craft-glass',45,['glass:vial_empty','glass:stafforb']]]as const){const f=fixture(level,mode);for(const name of names){const r=recipes.find(r=>r.name===name)!;for(const i of r.inputs)f.assets[i.id]=5;for(const id of r.tools)f.assets[id]=1;}const result=await runProgressiveProduction(f.s,{...f.options,targetLevel:level+2},f.stop,f.deps);expect(result.ok).toBe(true);expect(result.skill).toBe('Crafting');expect(f.calls).toEqual([...names]);expect(f.assets[995]).toBe(37);}
});
test('missing highest selected Crafting stock does not spend a lower orb or select absent modern glass',async()=>{
 const f=fixture(58,'craft-staff'),water=recipes.find(r=>r.name==='water-battlestaff')!;for(const i of water.inputs)f.assets[i.id]=5;const result=await runProgressiveProduction(f.s,{...f.options,targetLevel:59},f.stop,f.deps);expect(result.ok).toBe(false);expect(f.calls).toEqual([]);expect(result.preserved).toBe(true);expect(progressiveStage('craft-glass',87,recipes,cooks).name).toBe('glass:stafforb');
});
test('native members-account byte1 admits, while byte0, unknown and invented boolean fail before stock actions',async()=>{
 for(const value of[0,undefined,true]){const f=fixture();(f.client as any).membersAccount=value;const r=await runProgressiveProduction(f.s,f.options,f.stop,f.deps);expect(r.ok).toBe(false);expect(f.calls).toEqual([]);expect(f.audits()).toBe(0);}const f=fixture();expect(f.client.membersAccount).toBe(1);expect((await runProgressiveProduction(f.s,f.options,f.stop,f.deps)).ok).toBe(true);
});
