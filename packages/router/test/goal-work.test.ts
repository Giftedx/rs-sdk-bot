import {expect,test} from 'bun:test';
import {addTasks,chooseTask,initialState,type CoordTask} from '../src/coordinator';
import {goalWork,ruleGoalValue} from '../src/goal-work';
import type {OwnerGoals} from '../src/goal-scoreboard';
import {applyRules} from '../src/coordinator-rules';

const NOW=1_000_000;
const goals=(patch:Record<string,unknown>={}):OwnerGoals=>({version:1,at:NOW,
 main:{modelTicks:200,recordTicks:100,launchTargetTicks:99,gapTicks:101,rank:null,rankAt:null,rank1:false,evidence:[]},
 specialists:{targets:[],rank1s:[],scopeKnown:false,evidence:[]},
 quests:{complete:0,total:1,remaining:['Lost City'],observedAccounts:1,evidence:[]},
 collection:{targets:1,held:0,missing:[{item:'Nature rune',id:561,need:100,owned:0,consumer:'main Overall'}],scopeKnown:false,evidence:[]},
 army:{roster:['Fighter'],accounts:[{account:'Fighter',levels:{Attack:1,Strength:1,Defence:1,Ranged:1,Magic:1,Prayer:1,Hitpoints:10},missingLevels:677,maxed:false,at:NOW}],maxed:0,missingLevels:677,creditedKills:null,wildernessControl:null,evidence:[]},
 metrics:{},remaining:[],done:false,...patch} as unknown as OwnerGoals);
const run=(id:string,patch:Partial<CoordTask>={}):CoordTask=>({id,kind:'run',goal:'quests',capability:'quest-worker',account:'Helper',dependsOn:[],priority:50,estimatedMs:60000,why:'Finish the accepted effect',accept:{quests:['Lost City']},...patch});
const status=(name:string,patch:Record<string,unknown>={})=>({name,at:NOW,server:'rs-sdk-demo.fly.dev',skills:[{name:'Fishing',level:1}],bank:[],bankAt:NOW,inventory:[],equipment:[],equipmentObserved:true,...patch});
const evaluate=(tasks:CoordTask[],board=goals(),statuses:any[]=[status('Helper')])=>{const state=initialState();addTasks(state,tasks,NOW);return{state,values:goalWork(state,board,statuses,NOW)};};

test('an unresolved quest has goal value and completed coverage does not',()=>{
 const {values}=evaluate([run('quest')]);
 expect(values.get('quest')!.value).toBeGreaterThan(0);
 expect(evaluate([run('quest')],goals({quests:{complete:1,total:1,remaining:[],observedAccounts:1,evidence:[]}})).values.get('quest')!.value).toBe(0);
});

test('only the seven combat skills of a named army account earn training value',()=>{
 const tasks=[run('army',{goal:'skills',account:'Fighter',accept:{skills:{Magic:99}}}),run('helper',{goal:'skills',accept:{skills:{Fishing:99}}}),run('unlisted',{goal:'skills',accept:{skills:{Magic:99}}})];
 const {values}=evaluate(tasks);
 expect(values.get('army')!.value).toBeGreaterThan(0);
 expect(values.get('helper')!.value).toBe(0);
 expect(values.get('unlisted')!.value).toBe(0);
});

test('a known army level at its target has no training value and unknown levels need observation',()=>{
 const task=run('army',{goal:'skills',account:'Fighter',accept:{skills:{Magic:99}}});
 const complete=goals();complete.army.accounts[0]!.levels.Magic=99;
 expect(evaluate([task],complete).values.get('army')!.value).toBe(0);
 const unknown=goals();unknown.army.accounts[0]!.levels.Magic=null;
 expect(evaluate([task],unknown).values.get('army')!.value).toBeNull();
});

test('exact consumer shortages count and arbitrary stock, coins and counters do not',()=>{
 const {values}=evaluate([run('supply',{goal:'wealth',accept:{bank:{561:100}}}),run('surplus',{goal:'wealth',accept:{bank:{565:100}}}),run('coins',{goal:'wealth',accept:{bank:{995:100000}}}),run('counter',{goal:'wealth',accept:{counters:{banked:100}}})]);
 expect(values.get('supply')!.value).toBeGreaterThan(0);
 for(const id of ['surplus','coins','counter'])expect(values.get(id)!.value).toBe(0);
 const held=status('Helper',{bank:[{id:561,count:100}]});
 expect(evaluate([run('supply',{accept:{bank:{561:100}}})],goals(),[held]).values.get('supply')!.value).toBe(0);
});

test('unknown bank state needs an observation and does not conceal a useful quest',()=>{
 const {values}=evaluate([run('supply',{accept:{bank:{561:100}}}),run('quest')],goals(),[status('Helper',{bankAt:0})]);
 expect(values.get('supply')!.value).toBeNull();
 expect(values.get('quest')!.value).toBeGreaterThan(0);
});

test('old owned supply needs verification before making its replacement',()=>{
 const board=goals();board.collection.missing[0]!.verifyOwned=100;
 const {values}=evaluate([run('supply',{accept:{bank:{561:100}}}),run('quest')],board);
 expect(values.get('supply')!.value).toBeNull();
 expect(values.get('quest')!.value).toBeGreaterThan(0);
});

const geOrder=(patch:Partial<CoordTask>={}):CoordTask=>run('ge-supply',{goal:'main24',capability:'ge-bulk-order',dependsOn:['ge-qualified'],timeoutMs:2700000,
 env:{ITEM_ID:'561',QUANTITY:'60',EXPECTED_OWNED:'0',LIMIT_PRICE:'250',CASH_RESERVE:'1000',ORDER_MS:'900000'},accept:{bank:{561:60}},...patch});
const geProof:CoordTask={id:'ge-qualified',kind:'qualify',goal:'main24',capability:'ge-bulk-order',dependsOn:[],priority:50,estimatedMs:900000,why:'Qualify the finite supply consumer'};
const geContext={entryOf:()=> 'scripts/buy-owned-ge-item.ts'};

test('stale bank state can dispatch the bounded GE observation qualifier and its finite consumer without claiming supply progress',()=>{
 const board=goals();board.collection.missing[0]!.verifyOwned=40;
 const {state}=evaluate([geProof,geOrder()],board,[status('Helper',{bankAt:0})]);
 const score=()=>goalWork(state,board,[status('Helper',{bankAt:0})],NOW,geContext);
 let values=score();
 expect(values.get('ge-supply')!.value).toBe(.01);
 expect(values.get('ge-supply')!.reason).toContain('Observe Helper holdings');
 expect(values.get('ge-supply')!.reason).toContain('not game progress');
 expect(values.get('ge-qualified')!.value).toBe(.01);
 expect(chooseTask(state,NOW,{goalValue:t=>values.get(t.id)?.value??null,nativeReady:false})).toBeNull();
 expect(chooseTask(state,NOW,{goalValue:t=>values.get(t.id)?.value??null,nativeReady:true})?.id).toBe('ge-qualified');
 const proof=state.tasks.find(t=>t.spec.id==='ge-qualified')!;
 proof.status='succeeded';proof.receipt={taskId:proof.spec.id,runId:'proof',ok:true,at:NOW-1,output:{delivery:{ok:true}}};
 values=score();
 expect(chooseTask(state,NOW,{goalValue:t=>values.get(t.id)?.value??null,runHeld:()=>true})).toBeNull();
 expect(chooseTask(state,NOW,{goalValue:t=>values.get(t.id)?.value??null,liveLimit:0})).toBeNull();
 expect(chooseTask(state,NOW,{goalValue:t=>values.get(t.id)?.value??null})?.id).toBe('ge-supply');
 expect(board.collection.missing[0]!.owned).toBe(0);
 expect(state.goals.find(g=>g.id==='main24')!.completedTasks).toBe(0);
});

test('GE observation support requires a real bounded order within a confirmed named shortage',()=>{
 const board=goals();board.collection.missing[0]!.verifyOwned=40;
 const original=geOrder();
 const refused:CoordTask[]=[
  geOrder({timeoutMs:undefined}),
  geOrder({env:{...original.env,ORDER_MS:'2700001'}}),
  geOrder({env:{...original.env,ORDER_MS:'0'}}),
  geOrder({env:{...original.env,QUANTITY:'61'},accept:{bank:{561:61}}}),
  geOrder({env:{...original.env,ITEM_ID:'565'}}),
  geOrder({env:{...original.env,LIMIT_PRICE:'0'}}),
  geOrder({env:{...original.env,EXPECTED_OWNED:'1'}}),
  geOrder({env:{...original.env,CASH_RESERVE:'-1'}}),
 ];
 for(const task of refused){const {state}=evaluate([geProof,task],board);expect(goalWork(state,board,[],NOW,geContext).get(task.id)!.value).toBeNull();}
 const {state}=evaluate([geProof,original],board);
 expect(goalWork(state,board,[],NOW,{entryOf:()=> 'scripts/goldfarm.ts'}).get(original.id)!.value).toBeNull();
 const covered=goals();covered.collection.missing[0]!.verifyOwned=100;
 expect(goalWork(state,covered,[],NOW,geContext).get(original.id)!.value).toBeNull();
 const unnamed=goals();unnamed.collection.missing[0]!.consumer='unresolved named supply';
 expect(goalWork(state,unnamed,[],NOW,geContext).get(original.id)!.value).toBe(0);
 const coins=goals();coins.collection.missing=[{id:995,item:'Coins',need:60,owned:0,consumer:'main Overall'}];
 const coinTask=geOrder({env:{...original.env,ITEM_ID:'995'},accept:{bank:{995:60}}});
 const coinState=evaluate([geProof,coinTask],coins).state;
 expect(goalWork(coinState,coins,[],NOW,geContext).get(coinTask.id)!.value).toBeNull();
});

test('GE observation support covers only the confirmed shortfall and duplicate consumers do not multiply it',()=>{
 const board=goals();board.collection.missing[0]!.verifyOwned=40;
 const first=geOrder(),duplicate=geOrder({id:'ge-supply-duplicate'}),{state}=evaluate([geProof,first,duplicate],board);
 const values=goalWork(state,board,[status('Helper')],NOW,geContext);
 expect(values.get('ge-qualified')!.value).toBe(.01);
 expect(values.get(first.id)!.reason).toContain('previously observed');
 const alreadyHeld=goalWork(state,board,[status('Helper',{bank:[{id:561,count:60}]})],NOW,geContext);
 expect(alreadyHeld.get(first.id)!.value).toBeNull();
});

const ringGoals=()=>{
 const board=goals();board.collection.missing=[{item:'Sapphire ring',id:1637,need:12,owned:0,verifyOwned:4,consumer:'main Overall'}];return board;
};
const ringInput=(patch:Partial<CoordTask>={}):CoordTask=>geOrder({env:{ITEM_ID:'2357',QUANTITY:'1',EXPECTED_OWNED:'0',LIMIT_PRICE:'3500',CASH_RESERVE:'90000',ORDER_MS:'900000'},accept:{bank:{2357:1}},...patch});
const ringConsumer=(patch:Partial<CoordTask>={}):CoordTask=>run('ring-consumer',{goal:'main24',capability:'jewellery-trip',dependsOn:['ge-supply'],timeoutMs:900000,accept:{bank:{1637:1}},...patch});
const ringContext={entryOf:(capability:string)=>capability==='ge-bulk-order'?'scripts/buy-owned-ge-item.ts':'scripts/microbot-jewellery-trip.ts'};

test('a bounded same-account GE input can observe the bank for a finite unknown production consumer',()=>{
 const board=ringGoals(),input=ringInput(),consumer=ringConsumer();
 const {state}=evaluate([geProof,input,consumer],board);
 for(const statuses of [[],[status('Helper',{bankAt:0})],[status('Helper',{bankAt:NOW-300000})]]){
  const values=goalWork(state,board,statuses,NOW,ringContext);
  expect(values.get(input.id)!.value).toBe(.01);
  expect(values.get(input.id)!.reason).toContain('Bounded GE input observation');
  expect(values.get(input.id)!.reason).toContain('not game progress');
  expect(values.get(consumer.id)!.value).toBeNull();
  expect(values.get(geProof.id)!.value).toBe(.01);
 }
 const proof=state.tasks.find(row=>row.spec.id===geProof.id)!;proof.status='succeeded';
 const values=goalWork(state,board,[],NOW,ringContext),goalValue=(task:CoordTask)=>values.get(task.id)?.value??null;
 expect(chooseTask(state,NOW,{goalValue})?.id).toBe(input.id);
 expect(chooseTask(state,NOW,{goalValue,runHeld:()=>true})).toBeNull();
 expect(chooseTask(state,NOW,{goalValue,liveLimit:0})).toBeNull();
 expect(board.collection.missing[0]!.owned).toBe(0);
 expect(state.goals.find(goal=>goal.id==='main24')!.completedTasks).toBe(0);
});

test('GE input observation follows pending dependencies without dispatching unknown production or multiplying duplicate support',()=>{
 const prep:CoordTask={...geProof,id:'jewellery-qualified',capability:'jewellery-trip',dependsOn:['ge-supply']};
 const consumer=ringConsumer({dependsOn:[prep.id]}),duplicate=ringConsumer({id:'ring-duplicate',dependsOn:[prep.id]});
 const {state}=evaluate([geProof,ringInput(),prep,consumer,duplicate],ringGoals());
 const values=goalWork(state,ringGoals(),[],NOW,ringContext);
 expect(values.get('ge-supply')!.value).toBe(.01);
 expect(values.get(geProof.id)!.value).toBe(.01);
 for(const id of [prep.id,consumer.id,duplicate.id])expect(values.get(id)!.value).toBeNull();
 const known=ringGoals();delete known.collection.missing[0]!.verifyOwned;
 const fresh=goalWork(state,known,[status('Helper')],NOW,ringContext);
 expect(fresh.get(consumer.id)!.value).toBe(1/12);
 expect(fresh.get('ge-supply')!.value).toBe(1/12);
});

test('new GE input observation cannot dispatch an earlier ordinary run with an unknown bank',()=>{
 const earlier=ringConsumer({id:'earlier-production',dependsOn:[]}),input=ringInput({dependsOn:[geProof.id,earlier.id]});
 const {state}=evaluate([geProof,earlier,input,ringConsumer()],ringGoals());
 const values=goalWork(state,ringGoals(),[],NOW,ringContext);
 expect(values.get(input.id)!.value).toBe(.01);
 expect(values.get(geProof.id)!.value).toBe(.01);
 expect(values.get(earlier.id)!.value).toBeNull();
 expect(values.get('ring-consumer')!.value).toBeNull();
 state.tasks.find(row=>row.spec.id===geProof.id)!.status='succeeded';
 expect(chooseTask(state,NOW,{goalValue:task=>values.get(task.id)?.value??null})).toBeNull();
 const known=ringGoals();delete known.collection.missing[0]!.verifyOwned;
 expect(goalWork(state,known,[status('Helper')],NOW,ringContext).get(earlier.id)!.value).toBe(1/12);
 earlier.accept={bank:{1637:1},quests:['Lost City']};
 expect(goalWork(state,ringGoals(),[],NOW,ringContext).get(earlier.id)!.value).toBe(1);
});

test('intermediate GE observation retains the order bounds, single account and real downstream demand',()=>{
 const original=ringInput(),board=ringGoals();
 const refused:CoordTask[]=[
  ringInput({timeoutMs:undefined}),
  ringInput({env:{...original.env,ORDER_MS:'2700001'}}),
  ringInput({env:{...original.env,ORDER_MS:'0'}}),
  ringInput({env:{...original.env,ITEM_ID:'1607'}}),
  ringInput({env:{...original.env,EXPECTED_OWNED:'1'}}),
  ringInput({env:{...original.env,LIMIT_PRICE:'0'}}),
  ringInput({env:{...original.env,CASH_RESERVE:'-1'}}),
  ringInput({accept:{bank:{2357:1,1607:1}}}),
  ringInput({env:{...original.env,ITEM_ID:'995'},accept:{bank:{995:1}}}),
  ringInput({account:'Other'}),
  ringInput({account:undefined,participants:['Helper','Other']}),
 ];
 for(const input of refused){
  const {state}=evaluate([geProof,input,ringConsumer()],board);
  expect(goalWork(state,board,[],NOW,ringContext).get(input.id)!.value).toBeNull();
 }
 for(const consumer of [ringConsumer({account:'Other'}),ringConsumer({account:undefined,participants:['Helper','Other']}),ringConsumer({accept:{bank:{1637:9}}})]){
  const {state}=evaluate([geProof,original,consumer],board);
  expect(goalWork(state,board,[],NOW,ringContext).get(original.id)!.value).toBeNull();
 }
 const isolated=evaluate([geProof,original],board).state;
 expect(goalWork(isolated,board,[],NOW,ringContext).get(original.id)!.value).toBe(0);
 const linked=evaluate([geProof,original,ringConsumer()],board).state;
 expect(goalWork(linked,board,[],NOW,{entryOf:()=> 'scripts/goldfarm.ts'}).get(original.id)!.value).toBeNull();
});

test('intermediate GE observation rejects nonpositive input and goal item IDs',()=>{
 for(const id of [0,-1]){
  const board=ringGoals(),input=ringInput({env:{...ringInput().env,ITEM_ID:String(id)},accept:{bank:{[id]:1}}});
  const inputState=evaluate([geProof,input,ringConsumer()],board).state;
  expect(goalWork(inputState,board,[],NOW,ringContext).get(input.id)!.value).toBeNull();
  board.collection.missing[0]!.id=id;
  const goalState=evaluate([geProof,ringInput(),ringConsumer({accept:{bank:{[id]:1}}})],board).state;
  expect(goalWork(goalState,board,[],NOW,ringContext).get('ge-supply')!.value).toBeNull();
 }
});

test('GE inputs get no observation credit for covered, ambiguous, unnamed, coin or dead goal consumers',()=>{
 const input=ringInput(),consumer=ringConsumer();
 for(const patch of [{owned:12},{id:undefined},{consumer:'unresolved named supply'}]){
  const board=ringGoals();Object.assign(board.collection.missing[0]!,patch);
  const {state}=evaluate([geProof,input,consumer],board);
  expect(goalWork(state,board,[],NOW,ringContext).get(input.id)!.value).toBe(0);
 }
 const verified=ringGoals();verified.collection.missing[0]!.verifyOwned=12;
 const verifyState=evaluate([geProof,input,consumer],verified).state;
 expect(goalWork(verifyState,verified,[],NOW,ringContext).get(input.id)!.value).toBeNull();
 const coins=ringGoals();coins.collection.missing=[{item:'Coins',id:995,need:12,owned:0,consumer:'main Overall'}];
 const coinState=evaluate([geProof,input,ringConsumer({accept:{bank:{995:1}}})],coins).state;
 expect(goalWork(coinState,coins,[],NOW,ringContext).get(input.id)!.value).toBeNull();
 const {state}=evaluate([geProof,input,consumer],ringGoals());state.tasks.find(row=>row.spec.id===consumer.id)!.status='failed';
 expect(goalWork(state,ringGoals(),[],NOW,ringContext).get(input.id)!.value).toBe(0);
});

test('coins have value only for a finite named acquisition consumer',()=>{
 const board=goals();board.collection.missing=[{id:995,item:'Coins',need:100,owned:0,consumer:'main Overall'}];
 const task=run('fund',{goal:'wealth',accept:{bank:{995:100}}});
 expect(evaluate([task],board).values.get('fund')!.value).toBeGreaterThan(0);
 expect(evaluate([task],board,[status('Helper',{bank:[{id:995,count:100}]})]).values.get('fund')!.value).toBe(0);
});

test('bank acceptance uses the recent bank baseline without requiring pack or equipment observations',()=>{
 const task=run('supply',{accept:{bank:{561:100}}});
 const bankOnly=status('Helper',{inventory:undefined,equipment:undefined,equipmentObserved:false});
 expect(evaluate([task],goals(),[bankOnly]).values.get('supply')!.value).toBeGreaterThan(0);
 const carried=status('Helper',{inventory:[{id:561,count:100}]});
 expect(evaluate([task],goals(),[carried]).values.get('supply')!.value).toBeGreaterThan(0);
});

test('main preparation requires the main account and specialist preparation needs a priced target',()=>{
 const board=goals({specialists:{targets:[{account:'Angler',board:'Fishing',planTicks:80,recordTicks:100,rehearsalTicks:null,marginTicks:20,rank:null,rankAt:null,rank1:false,evidence:[]}],rank1s:[],scopeKnown:false,evidence:[]}});
 const {values}=evaluate([run('main',{goal:'main24',account:'Haggis',accept:{skills:{Fishing:99}}}),run('pretend-main',{goal:'main24',accept:{skills:{Fishing:99}}}),run('specialist',{goal:'specialists',account:'Angler',accept:{skills:{Fishing:99}}}),run('unpriced',{goal:'specialists',account:'Other',accept:{skills:{Fishing:99}}})],board,[status('Angler')]);
 expect(values.get('main')!.value).toBeGreaterThan(0);
 expect(values.get('pretend-main')!.value).toBe(0);
 expect(values.get('specialist')!.value).toBeGreaterThan(0);
 expect(values.get('unpriced')!.value).toBe(0);
});

test('preparation inherits transitive viable consumer value and rejects dead consumers',()=>{
 const build:CoordTask={id:'build',kind:'build',goal:'quests',capability:'quest-worker',dependsOn:[],priority:1,estimatedMs:60000,why:'Repair quest'};
 const qualify:CoordTask={...build,id:'qualify',kind:'qualify',dependsOn:['build']};
 const {state,values}=evaluate([build,qualify,run('quest',{dependsOn:['qualify']})]);
 expect(values.get('build')!.value).toBe(values.get('quest')!.value);
 expect(values.get('qualify')!.consumers).toEqual(['quest']);
 state.tasks.find(r=>r.spec.id==='qualify')!.status='failed';
 expect(goalWork(state,goals(),[],NOW).get('build')!.value).toBe(0);
});

test('qualification without a useful finite consumer has no goal value',()=>{
 const tasks:CoordTask[]=[{id:'proof',kind:'qualify',goal:'wealth',capability:'goldfarm',dependsOn:[],priority:100,estimatedMs:1,why:'More coins'},run('gold',{goal:'wealth',dependsOn:['proof'],accept:{bank:{995:100000}}})];
 const {values}=evaluate(tasks);
 expect(values.get('proof')!.value).toBe(0);
});

test('helper training needs a linked finite supply consumer rather than a skill maximum',()=>{
 const trainer=run('trainer',{goal:'skills',accept:{skills:{Fishing:40}}});
 const {values}=evaluate([trainer,run('supply',{goal:'wealth',dependsOn:['trainer'],accept:{bank:{561:100}}})]);
 expect(values.get('trainer')!.value).toBeGreaterThan(0);
 expect(values.get('trainer')!.consumers).toContain('supply');
 expect(evaluate([trainer]).values.get('trainer')!.value).toBe(0);
});

test('duplicate consumers of the same goal effect cannot multiply a prerequisite value',()=>{
 const proof:CoordTask={id:'proof',kind:'qualify',goal:'quests',capability:'quest-worker',dependsOn:[],priority:1,estimatedMs:60000,why:'Qualify the first quest'};
 const {values}=evaluate([proof,run('quest-a',{dependsOn:['proof']}),run('quest-b',{dependsOn:['proof']})]);
 expect(values.get('proof')!.value).toBe(values.get('quest-a')!.value);
});

test('a provision claim inherits its useful first quest before its account name exists',()=>{
 const claim:CoordTask={id:'claim',kind:'provision',goal:'quests',role:'quest',dependsOn:[],priority:1,estimatedMs:60000,why:'Create the missing quest role'};
 const first=run('quest',{account:undefined,accountFrom:'claim',dependsOn:['claim']});
 const {values}=evaluate([claim,first]);
 expect(values.get('claim')!.value).toBeGreaterThan(0);
 expect(values.get('claim')!.consumers).toEqual(['quest']);
});

test('explicit session recovery has support value without claiming game progress',()=>{
 const task=run('recover',{capability:'session-recovery-only',sessionRecovery:{account:'Helper',endedAt:NOW-100},repairs:[{account:'Helper',endedAt:NOW-100}],accept:{counters:{sessionVerified:1}}});
 const {values}=evaluate([task]);
 expect(values.get('recover')!.value).toBeGreaterThan(0);
 expect(values.get('recover')!.reason).toContain('recovery');
});

test('a bounded army PK worker gets proof support while an arbitrary kill counter does not',()=>{
 const task=run('pilot',{goal:'skills',account:'Fighter',capability:'hunting-worker',timeoutMs:1200000,accept:{counters:{creditedKills:1}}});
 const {state}=evaluate([task]);
 const context={entryOf:(capability:string)=>capability==='hunting-worker'?'scripts/pk-hunt.ts':undefined};
 const value=goalWork(state,goals(),[],NOW,context).get('pilot')!;
 expect(value.value).toBeGreaterThan(0);
 expect(value.reason).toContain('proof');
 expect(goalWork(state,goals(),[],NOW,{entryOf:()=> 'scripts/goldfarm.ts'}).get('pilot')!.value).toBe(0);
 task.timeoutMs=undefined;
 expect(goalWork(state,goals(),[],NOW,context).get('pilot')!.value).toBe(0);
});

test('goal selection excludes surplus despite priority and age and keeps legacy callers',()=>{
 const {state}=evaluate([run('quest',{priority:1,estimatedMs:600000}),run('gold',{goal:'wealth',priority:100,estimatedMs:1,accept:{bank:{995:100000}}})]);
 state.goals.find(g=>g.id==='quests')!.lastStartedAt=NOW;
 const values=goalWork(state,goals(),[status('Helper')],NOW);
 expect(chooseTask(state,NOW,{goalValue:t=>values.get(t.id)?.value??null})?.id).toBe('quest');
 expect(chooseTask(state,NOW)?.id).toBe('gold');
});

test('a freshly qualified source gets its finite consumer before another build',()=>{
 const proof:CoordTask={id:'proof',kind:'qualify',goal:'quests',capability:'quest-worker',dependsOn:[],priority:1,estimatedMs:60000,why:'Qualify the quest'};
 const rebuild:CoordTask={...proof,id:'rebuild',kind:'build',estimatedMs:1000};
 const {state,values}=evaluate([proof,run('consume',{dependsOn:['proof']}),rebuild,run('future',{dependsOn:['rebuild']})]);
 const readyProof=state.tasks.find(r=>r.spec.id==='proof')!;
 readyProof.status='succeeded';readyProof.receipt={taskId:'proof',runId:'proved',ok:true,at:NOW-1,output:{delivery:{ok:true}}};
 expect(chooseTask(state,NOW,{isolatedBuilds:true,goalValue:task=>values.get(task.id)?.value??null})?.id).toBe('consume');
});

test('a useful army rule queues its source refresh below another account fleet maximum',()=>{
 const previous=run('previous',{goal:'skills',capability:'magic-worker',account:'Fighter',dependsOn:['qualified'],args:['30'],accept:{skills:{Magic:30}}});
 const proof:CoordTask={id:'qualified',kind:'qualify',goal:'skills',capability:'magic-worker',dependsOn:[],priority:1,estimatedMs:60000,why:'Qualify Magic'};
 const {state}=evaluate([proof,{...proof,id:'reviewed',kind:'review'},previous]);
 for(const [id,output] of [['qualified',{delivery:{ok:true,source:'old-source'}}],['reviewed',{review:{approved:true}}],['previous',{evidence:'live'}]] as const){
  const record=state.tasks.find(row=>row.spec.id===id)!;record.status='succeeded';record.receipt={taskId:id,runId:id,ok:true,at:NOW-1000,output};
 }
 const board=goals();board.army.accounts[0]!.levels.Magic=30;
 const score=ruleGoalValue(state,board,[],NOW);
 const added=applyRules(state,{fingerprint:()=> 'new-source',unlocks:()=>[40],level:()=>30,paused:()=>false,maxOpen:4,side:'local',
  fleetBest:()=>({best:99,account:'Other',side:'cloud'}),
  goalValue:score},NOW);
 expect(added.map(task=>task.kind)).toEqual(['qualify','run']);
 expect(added[1]!.accept).toEqual({skills:{Magic:40}});
 const candidate={...previous,rule:'next-band' as const,accept:{skills:{Magic:40}}};
 expect(score({...candidate,id:'missing-input',dependsOn:['missing-supply']}).value).toBe(0);
 expect(score({...candidate,id:'other-refresh',dependsOn:['refresh-other-worker-source']}).value).toBe(0);
 const refresh=state.tasks.find(row=>row.spec.id==='refresh-magic-worker-new-source')!;refresh.status='failed';
 expect(score({...candidate,id:'failed-refresh',dependsOn:[refresh.spec.id]}).value).toBe(0);
});

test('useful impact per hour leads model priority and goal age',()=>{
 const {state}=evaluate([run('fast',{priority:1,estimatedMs:60000}),run('slow',{goal:'gear',priority:100,estimatedMs:600000})]);
 state.goals.find(g=>g.id==='quests')!.lastStartedAt=NOW;
 expect(chooseTask(state,NOW,{goalValue:()=>1})?.id).toBe('fast');
});

test('unknown work cannot block an independent useful task and admission still holds it',()=>{
 const {state}=evaluate([run('unknown',{account:'Other',priority:100}),run('quest')]);
 const goalValue=(task:CoordTask)=>task.id==='unknown'?null:1;
 expect(chooseTask(state,NOW,{goalValue})?.id).toBe('quest');
 expect(chooseTask(state,NOW,{goalValue,runHeld:()=>true})).toBeNull();
});
