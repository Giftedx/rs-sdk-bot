import {expect,test} from 'bun:test';
import {createProgressionMonitor,methodSupportsWork,snapshotForProgression,type WorkDescriptor} from '../src/progression-policy';

const work:WorkDescriptor={script:'scripts/train-chickens.ts',args:['99'],env:{TRAIN_SKILL:'Ranged'}};
const decision=(supported:boolean)=>({supported,intent:{kind:'train' as const,skill:'Ranged',targetLevel:99},decision:{state:'execute' as const,selected:supported?'current':'ranged/troopers',step:{script:supported?work.script:'scripts/ranged-train.ts',args:['99'],env:{}},path:[],expectedTicks:1000,basis:'model' as const,alternatives:[],followUps:[],stateFingerprint:'state',reason:'selected finite route',gaps:[],search:{nodes:2,bound:100,depth:1,exhausted:false}}});

test('every session refuses a new obsolete training batch at a safe boundary',()=>{
 const monitor=createProgressionMonitor({evaluate:()=>decision(false),onHandoff:()=>{}});
 monitor.observe({tick:1,inCombat:false,bankGeneration:1,stateKey:'entry'});
 expect(monitor.refusal({type:'interactNpc',option:'Attack'})).toContain('progression');
 expect(monitor.refusal({type:'walkTo',x:3253,z:3421})).toBeNull();
 expect(monitor.refusal({type:'logout'})).toBeNull();
 expect(monitor.refusal({type:'useInventoryItem',slot:1})).toBeNull();
});

test('a route change settles the current fight and raises one handoff at the next safe boundary',()=>{
 let supported=true,handoffs=0;
 const monitor=createProgressionMonitor({evaluate:()=>decision(supported),onHandoff:()=>{handoffs++;}});
 monitor.observe({tick:1,inCombat:true,bankGeneration:0,stateKey:'entry'});
 supported=false;
 monitor.observe({tick:2,inCombat:true,bankGeneration:0,stateKey:'unlock'});
 expect(monitor.refusal({type:'interactNpc',option:'Attack'})).toBeNull();
 monitor.observe({tick:3,inCombat:false,bankGeneration:0,stateKey:'unlock'});
 expect(monitor.refusal({type:'interactNpc',option:'Attack'})).toContain('progression');
 monitor.observe({tick:4,inCombat:false,bankGeneration:0,stateKey:'unlock'});
 expect(handoffs).toBe(1);
});

test('authored quest and finite item consumers keep their selected worker',()=>{
 const monitor=createProgressionMonitor({evaluate:()=>({...decision(true),intent:{kind:'quest',quest:'Dwarf Cannon'}}),onHandoff:()=>{}});
 monitor.observe({tick:1,inCombat:false,bankGeneration:1,stateKey:'quest'});
 expect(monitor.refusal({type:'interactNpc',option:'Talk-to'})).toBeNull();
 expect(monitor.refusal({type:'useItemOnLoc',inventorySlot:1,locId:2})).toBeNull();
});

test('the same entry with a different monster or recipe is not an enforcement match',()=>{
 const step={script:'scripts/gather-combat.ts',args:['1500','trooper'],env:{TRAIN_SKILL:'Ranged',TARGET:'trooper'}};
 expect(methodSupportsWork(step,{script:'scripts/gather-combat.ts',args:['1500','cow'],env:{TRAIN_SKILL:'Ranged',TARGET:'cow'}})).toBe(false);
 expect(methodSupportsWork(step,{script:'F:/repo/scripts/gather-combat.ts',args:['1500','trooper'],env:{TRAIN_SKILL:'Ranged',TARGET:'trooper'}})).toBe(true);
});

test('a fresh live status does not turn an old bank into a fresh observation',()=>{
 const s={name:'A',server:'rs-sdk-demo.fly.dev',at:5000,bank:[{id:892,count:500}],bankAt:100,inventory:[],equipment:[],quests:[]};
 const merged=snapshotForProgression(s,{skills:[{name:'Ranged',baseLevel:80,level:80,experience:270000}],inventory:[],equipment:[],player:{worldX:1,worldZ:2,level:0}},null,6000);
 expect(merged.bankAt).toBe(100);
 expect(merged.at).toBe(6000);
 expect(merged.skills[0]).toMatchObject({name:'Ranged',level:80,xp:270000});
 const bank=snapshotForProgression(s,{inventory:[],equipment:[],skills:[]},{generation:4,at:5900,items:[]},6000);
 expect(bank.bank).toEqual([]);
 expect(bank.bankAt).toBe(5900);
});

test('an unmapped productive entry is explicit while cleanup remains available',()=>{
 const monitor=createProgressionMonitor({evaluate:()=>({supported:false,intent:null,decision:null,reason:'unmapped progression entry'}),onHandoff:()=>{}});
 monitor.observe({tick:1,inCombat:false,bankGeneration:0,stateKey:'unknown'});
 expect(monitor.refusal({type:'interactNpc',option:'Attack'})).toContain('unmapped');
 expect(monitor.refusal({type:'logout'})).toBeNull();
});

test('missing recipe discriminators cannot authorize a different default worker',()=>{
 const step={script:'scripts/gather-combat.ts',args:['1500','trooper'],env:{TRAIN_SKILL:'Ranged',TARGET:'trooper'}};
 expect(methodSupportsWork(step,{script:step.script,args:[],env:{}})).toBe(false);
});

test('compound cannon target maps must match the selected finite executable boundary',()=>{
 const step={script:'scripts/cannon-fight.ts',args:[],env:{STOP:'ranged=45,defence=45'}};
 expect(methodSupportsWork(step,{...step,env:{STOP:'Ranged=99,Defence=99'}})).toBe(false);
 expect(methodSupportsWork(step,{...step,env:{STOP:'Defence=45,Ranged=45'}})).toBe(true);
 expect(methodSupportsWork(step,{...step,env:{STOP:'Ranged=45'}})).toBe(false);
});

test('shared shop profiles and encoded bank recipes keep their exact output identity',()=>{
 const shop={script:'scripts/aio-market.ts',args:['shop-buy','dargaud','1600'],env:{ITEMS:'mithril arrow'}};
 expect(methodSupportsWork(shop,{script:shop.script,args:shop.args,env:{ITEMS:'willow shortbow'}})).toBe(false);
 const step={script:'scripts/aio-skiller.ts',args:['bank-job','--job='+encodeURIComponent(JSON.stringify({family:'inventory',recipe:'cut-sapphire',target:1}))],env:{}};
 const job=(recipe:string,target:number)=>({script:step.script,args:['bank-job','--job='+encodeURIComponent(JSON.stringify({family:'inventory',recipe,target}))],env:{}});
 expect(methodSupportsWork(step,job('cut-emerald',1))).toBe(false);
 expect(methodSupportsWork(step,job('cut-sapphire',25))).toBe(true);
 expect(methodSupportsWork(step,{...job('cut-sapphire',25),args:[...job('cut-sapphire',25).args,job('cut-emerald',1).args[1]!]})).toBe(false);
});

test('missing telemetry remains unknown after a state refresh',()=>{
 const result=snapshotForProgression({inventory:[{id:892,count:500}],equipment:[{id:861,count:1}],equipmentObserved:true},{skills:[]},null,6000);
 expect(result.inventory).toBeNull();expect(result.equipment).toBeNull();expect(result.equipmentObserved).toBe(false);
});

test('inventory training is held while food and protection remain available',()=>{
 const monitor=createProgressionMonitor({evaluate:()=>decision(false),onHandoff:()=>{}});
 monitor.observe({tick:1,inCombat:false,bankGeneration:1,stateKey:'entry'});
 expect(monitor.refusal({type:'useInventoryItem',progressionOption:'Bury'})).toContain('progression');
 expect(monitor.refusal({type:'useInventoryItem',progressionOption:'Eat'})).toBeNull();
 expect(monitor.refusal({type:'useInventoryItem',progressionOption:'Drink'})).toBeNull();
});

test('a held route may finish its target but cannot start another fight',()=>{
 const monitor=createProgressionMonitor({evaluate:()=>decision(false),onHandoff:()=>{}});
 monitor.observe({tick:1,inCombat:true,combatTargetIndex:17,bankGeneration:1,stateKey:'entry'});
 expect(monitor.refusal({type:'interactNpc',npcIndex:17,option:'Attack'})).toBeNull();
 expect(monitor.refusal({type:'interactNpc',npcIndex:18,option:'Attack'})).toContain('progression');
});

test('a held gathering route cannot start a new rock while bank and doors remain usable',()=>{
 const monitor=createProgressionMonitor({evaluate:()=>decision(false),onHandoff:()=>{}});
 monitor.observe({tick:1,inCombat:false,bankGeneration:1,stateKey:'entry'});
 expect(monitor.refusal({type:'interactLoc',progressionOption:'Mine'})).toContain('progression');
 expect(monitor.refusal({type:'interactLoc',progressionOption:'Bank'})).toBeNull();
 expect(monitor.refusal({type:'interactLoc',progressionOption:'Open'})).toBeNull();
});

test('real SDK spell actions hold obsolete work while allowing only the current fight',()=>{
 const monitor=createProgressionMonitor({evaluate:()=>decision(false),onHandoff:()=>{}});
 monitor.observe({tick:1,inCombat:false,bankGeneration:1,stateKey:'entry'});
 expect(monitor.refusal({type:'spellOnItem',slot:0,spellComponent:1162})).toContain('progression');
 expect(monitor.refusal({type:'spellOnGroundItem',x:1,z:1,itemId:1,spellComponent:1162})).toContain('progression');
 monitor.observe({tick:2,inCombat:true,combatTargetIndex:17,bankGeneration:1,stateKey:'fight'});
 expect(monitor.refusal({type:'spellOnNpc',npcIndex:17,spellComponent:1162})).toBeNull();
 expect(monitor.refusal({type:'spellOnNpc',npcIndex:18,spellComponent:1162})).toContain('progression');
 expect(monitor.refusal({type:'useInventoryItem',progressionOption:'Bury'})).toContain('progression');
 expect(monitor.refusal({type:'spellOnLoc',spellComponent:1162,x:1,z:1,locId:1})).toContain('progression');
});

test('meeting the goal holds another batch while the authored worker owns successful cleanup',()=>{
 let handoffs=0;
 const monitor=createProgressionMonitor({evaluate:()=>({...decision(false),decision:{...decision(false).decision,state:'complete',selected:null,step:null}}),onHandoff:()=>{handoffs++;}});
 monitor.observe({tick:1,inCombat:false,bankGeneration:1,stateKey:'complete'});
 expect(handoffs).toBe(0);
 expect(monitor.refusal({type:'interactNpc',option:'Attack'})).toContain('progression');
 expect(monitor.refusal({type:'interactLoc',progressionOption:'Bank'})).toBeNull();
});

test('a finished goal still lets the player leave an altar through its portal, and holds the next craft',()=>{
 const monitor=createProgressionMonitor({evaluate:()=>({...decision(false),decision:{...decision(false).decision,state:'complete',selected:null,step:null}}),onHandoff:()=>{}});
 monitor.observe({tick:1,inCombat:false,bankGeneration:1,stateKey:'complete'});
 // The session marks a use of a loc named Portal as an exit (progression-session.ts).
 expect(monitor.refusal({type:'interactLoc',progressionOption:'Use',progressionPortalExit:true})).toBeNull();
 expect(monitor.refusal({type:'interactLoc',progressionOption:'Use'})).toContain('progression');
 expect(monitor.refusal({type:'useItemOnLoc'})).toContain('progression');
});
