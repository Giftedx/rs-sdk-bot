import {expect,test} from 'bun:test';
import {recommendNextAioJob,runAio} from './aio';
import {runAioFighter} from './aio-fighter';
import {selectAioProgression} from './aio-progression';
import {xpForLevel} from '../packages/planner/src/curve';
import type {ProgressionCatalog,CatalogMethod} from '../packages/planner/src/progression-catalog';

const now=10000,skills=Object.fromEntries(['Attack','Strength','Defence','Hitpoints','Magic','Prayer','Cooking','Woodcutting','Fletching','Fishing','Firemaking','Crafting','Smithing','Mining','Herblore','Agility','Thieving','Runecraft','Ranged'].map(s=>[s,s==='Ranged'?70:99]));
const status={name:'Example',server:'rs-sdk-demo.fly.dev',at:now,bankAt:now,equipmentObserved:true,inventory:[],bank:[],equipment:[],quests:[],skills:Object.entries(skills).map(([name,level])=>({name,level,xp:xpForLevel(level)}))};
const fast:CatalogMethod={id:'ranged/qualified-fast',routeId:'fighter:trooper',ladderIds:[],source:'fixture',
 step:{script:'scripts/gather-combat.ts',args:['1500','trooper'],env:{TARGET:'trooper',TRAIN_SKILL:'Ranged',TARGET_LEVEL:'99'}},
 effects:{xp:{ranged:1}},rate:{unitsPerTick:100,basis:'measured',evidence:'fixture'},costs:{setupTicks:0,travelTicks:0,acquisitionTicks:0,unlockTicks:0},repeatable:true,qualification:{source:'fixture',bands:[{}]}};
const c:ProgressionCatalog={version:1,generatedBy:'fixture',skills:['ranged'],routes:[],quests:[],entries:[{script:'scripts/ranged-train.ts',intents:['train'],skills:['ranged'],routeIds:[]},{script:'scripts/gather-combat.ts',intents:['train','acquire'],skills:['ranged'],routeIds:[]}],methods:[fast]};
const context={status,catalog:c,now};

test('AIO selects the same qualified faster route for its declared training goal',()=>{
 const selected=selectAioProgression('Example',{script:'scripts/ranged-train.ts',args:['99'],env:{}},{},context,false);
 expect(selected.decision?.selected).toBe(fast.id);
 expect(selected.step).toEqual(fast.step);
 expect(selected.changed).toBe(true);
});

test('AIO recommendation consumes the shared observed-state decision',()=>{
 const result=recommendNextAioJob({name:'Example',skills,ownedItems:{}},'pk-tribrid',context);
 expect(result.progression?.selected).toBe(fast.id);
 expect(result.step).toEqual(fast.step);
 expect(result.reason).toContain('qualified');
});

test('an unmeasured comparison retains the authored route with an explicit gap',()=>{
 const original={script:'scripts/ranged-train.ts',args:['99'],env:{}};
 const result=selectAioProgression('Example',original,{}, {...context,catalog:{...c,methods:[{...fast,qualification:undefined}]}},false);
 expect(result.step).toEqual(original);
 expect(result.decision?.state).not.toBe('execute');
 expect(result.reason).toContain('unverified');
});

test('AIO preserves a fixed item consumer against unrelated XP alternatives',()=>{
 const original={script:'scripts/gather-combat.ts',args:['1500','giant'],env:{TARGET:'giant',TRAIN_SKILL:'Ranged',TARGET_LEVEL:'99'}};
 const result=selectAioProgression('Example',original,{}, {...context,accept:{bank:{536:20}}},false);
 expect(result.step).toEqual(original);
 expect(result.decision?.selected).toBeNull();
});

test('AIO launchers dispatch the shared selected Step and preserve its environment',async()=>{
 // The red phase must fail before an old launcher can start a real child.
 expect(selectAioProgression('Example',{script:'scripts/ranged-train.ts',args:['99'],env:{}},{},context,false).decision?.selected).toBe(fast.id);
 const calls:{args:string[];env:Record<string,string|undefined>}[]=[];
 const run=async(args:string[],env:Record<string,string|undefined>)=>{calls.push({args,env});return'RESULT ok fixture';};
 await runAioFighter('Example',['ranged','99'],{CAP:'2000'},context,run);
 await runAio('fighter','Example',['ranged','99'],{CAP:'2000'},context,run);
 expect(calls).toHaveLength(2);
 for(const call of calls){expect(call.args).toEqual([fast.step.script,'Example',...fast.step.args]);expect(call.env.TRAIN_SKILL).toBe('Ranged');expect(call.env.CAP).toBe('2000');}
});

test('a protected clock cannot fall back into an authored training launch',()=>{
 const original={script:'scripts/ranged-train.ts',args:['99'],env:{}};
 const result=selectAioProgression('Example',original,{}, {...context,status:{...status,clock:{protected:true,fresh:true,authorized:false}}},false);
 expect(result.step).toBeNull();
 expect(result.blocked).toBe(true);
});
