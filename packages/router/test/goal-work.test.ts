import {expect,test} from 'bun:test';
import {acceptStatus,addTasks,chooseTask,initialState,type CoordTask} from '../src/coordinator';
import {goalWork,ruleGoalValue} from '../src/goal-work';
import type {OwnerGoals} from '../src/goal-scoreboard';
import {applyRules} from '../src/coordinator-rules';
import {resultCounters} from '../../core/src/status';

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

test('a bounded skills refresh supports its real finite army consumer without receiving its level credit',()=>{
 const observe=run('observe',{capability:'observe',account:'Fighter',timeoutMs:120000,args:[],env:{REQUIRE_BANK:'0',LOOT_WATCH:'0',RANDOM_EVENTS:'0'},accept:{skills:{Hitpoints:1}}});
 const consumer=run('finite',{goal:'skills',account:'Fighter',accept:{skills:{Ranged:43}},dependsOn:['observe']});
 const s=initialState();addTasks(s,[observe,consumer],NOW);
 const value=(at:number)=>goalWork(s,goals(),[status('Fighter',{at,skills:[{name:'Ranged',level:1,xp:0},{name:'Hitpoints',level:10,xp:1000}]})],NOW,{entryOf:cap=>cap==='observe'?'scripts/fleet-inspect.ts':'scripts/ranged-train.ts'});
 expect(value(NOW-400000).get('observe')?.value).toBe(.01);
 expect(value(NOW).get('observe')?.value).toBe(0);
 expect(value(NOW-400000).get('finite')?.value).toBe(42/98);
});

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
test('finite new supply uses only demand beyond reserved unverified stock with a fresh own bank',()=>{
 const board=goals();board.collection.missing=[{item:'Sapphire ring',id:1637,need:12,owned:0,verifyOwned:2,consumer:'main Overall'}];
 const proof:CoordTask={id:'ring-proof',kind:'qualify',goal:'main24',capability:'ring-worker',dependsOn:[],priority:50,estimatedMs:60000,why:'Qualify one finite useful ring batch'};
 const consumer=(target:number)=>run('ring',{goal:'main24',capability:'ring-worker',dependsOn:[proof.id],accept:{bank:{1637:target}}});
 const own=status('Helper',{bank:[{id:2357,count:10},{id:1607,count:10}]});
 for(const count of [1,10]){
  const {values}=evaluate([proof,consumer(count)],board,[own]);
  expect(values.get('ring')!.value).toBe(count/12);
  expect(values.get(proof.id)!.value).toBe(count/12);
  expect(values.get('ring')!.reason).toContain('previously observed');
 }
 for(const count of [11,12])expect(evaluate([proof,consumer(count)],board,[own]).values.get('ring')!.value).toBeNull();
 const covered=goals();covered.collection.missing=[{...board.collection.missing[0]!,verifyOwned:12}];
 expect(evaluate([proof,consumer(1)],covered,[own]).values.get('ring')!.value).toBeNull();
 for(const bankAt of [0,NOW-300000])expect(evaluate([proof,consumer(1)],board,[{...own,bankAt}]).values.get('ring')!.value).toBeNull();
 expect(board.collection.missing[0]).toMatchObject({owned:0,verifyOwned:2});
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

const bankObserver=(patch:Partial<CoordTask>={}):CoordTask=>run('bank-observe',{goal:'main24',capability:'bank-observation',dependsOn:['bank-qualified'],
 timeoutMs:120000,args:[],env:{REQUIRE_BANK:'1'},accept:{counters:{bankObserved:1}},...patch});
const bankProof:CoordTask={...geProof,id:'bank-qualified',capability:'bank-observation'};
const bankContext={entryOf:(capability:string)=>capability==='bank-observation'?'scripts/fleet-inspect.ts':ringContext.entryOf(capability)};
const observationChain=(observer=bankObserver(),consumer=ringConsumer())=>[bankProof,geProof,observer,
 run('fund-ring',{goal:'main24',capability:'coin-courier',account:undefined,participants:['Donor','Helper'],acceptIndex:1,
  dependsOn:[observer.id],timeoutMs:600000,accept:{bank:{995:111470}}}),
 ringInput({dependsOn:[geProof.id,'fund-ring']}),consumer];
const observedRingGoals=()=>{const board=ringGoals();delete board.collection.missing[0]!.verifyOwned;return board;};

test('a strict bounded bank observer unblocks observation before an unknown funded production chain',()=>{
 const board=observedRingGoals(),{state}=evaluate(observationChain(),board,[]);
 for(const statuses of [[],[status('Helper',{bankAt:0})],[status('Helper',{bankAt:NOW-300000})]]){
  const values=goalWork(state,board,statuses,NOW,bankContext);
  expect(values.get('bank-observe')!.value).toBe(.01);
  expect(values.get('bank-observe')!.reason).toContain('Bounded bank observation');
  expect(values.get('bank-observe')!.reason).toContain('not game progress');
  expect(values.get('bank-qualified')!.value).toBe(.01);
  expect(values.get('fund-ring')!.value).toBeNull();
  expect(values.get('ring-consumer')!.value).toBeNull();
  expect(values.get('ge-supply')!.value).toBe(.01);
 }
 for(const row of state.tasks)if(row.spec.kind==='qualify')row.status='succeeded';
 const values=goalWork(state,board,[],NOW,bankContext),goalValue=(task:CoordTask)=>values.get(task.id)?.value??null;
 expect(chooseTask(state,NOW,{goalValue})?.id).toBe('bank-observe');
 expect(chooseTask(state,NOW,{goalValue,runHeld:()=>true})).toBeNull();
 expect(chooseTask(state,NOW,{goalValue,liveLimit:0})).toBeNull();
 state.tasks.find(row=>row.spec.id==='bank-observe')!.status='succeeded';
 const fresh=goalWork(state,board,[status('Helper',{bank:[{id:1623,count:4},{id:995,count:100470}]})],NOW,bankContext);
 for(const id of ['fund-ring','ge-supply','ring-consumer'])expect(fresh.get(id)!.value).toBe(1/12);
 expect(chooseTask(state,NOW,{goalValue:task=>fresh.get(task.id)?.value??null})?.id).toBe('fund-ring');
 expect(board.collection.missing[0]!.owned).toBe(0);
 expect(state.goals.find(goal=>goal.id==='main24')!.completedTasks).toBe(0);
});

test('bank observation support cannot leak into ordinary run ancestors',()=>{
 const earlier=ringConsumer({id:'earlier-worker',dependsOn:[]}),observer=bankObserver({dependsOn:[bankProof.id,earlier.id]});
 const {state}=evaluate([earlier,...observationChain(observer)],observedRingGoals(),[]);
 const values=goalWork(state,observedRingGoals(),[],NOW,bankContext);
 expect(values.get(observer.id)!.value).toBe(.01);expect(values.get(earlier.id)!.value).toBeNull();
 expect(values.get(bankProof.id)!.value).toBe(.01);
 for(const row of state.tasks)if(row.spec.kind==='qualify')row.status='succeeded';
 expect(chooseTask(state,NOW,{goalValue:task=>values.get(task.id)?.value??null})).toBeNull();
 expect(goalWork(state,observedRingGoals(),[status('Helper')],NOW,bankContext).get(earlier.id)!.value).toBe(1/12);
});

test('near-complete ring demand can observe an absolute bank target and credits only the fresh new quantity',()=>{
 const board=ringGoals();board.collection.missing[0]!.verifyOwned=8;
 const observer=bankObserver({account:'BowBeforeMe'}),consumer=ringConsumer({account:'BowBeforeMe',dependsOn:[observer.id],env:{RECIPE:'sapphire_ring',TARGET:'2',BATCH:'2'},accept:{bank:{1637:5}}});
 const {state}=evaluate([bankProof,observer,consumer],board,[]);
 const stale=status('BowBeforeMe',{bank:[{id:1637,count:3}],bankAt:NOW-300000});
 const values=goalWork(state,board,[stale],NOW,bankContext);
 expect(values.get(observer.id)!.value).toBe(.01);
 expect(values.get(observer.id)!.reason).toContain('Bounded bank observation');
 expect(values.get(bankProof.id)!.value).toBe(.01);
 expect(values.get(consumer.id)!.value).toBeNull();
 state.tasks.find(row=>row.spec.id===bankProof.id)!.status='succeeded';
 expect(chooseTask(state,NOW,{goalValue:task=>values.get(task.id)?.value??null})?.id).toBe(observer.id);
 const fresh=goalWork(state,board,[status('BowBeforeMe',{bank:[{id:1637,count:3}]})],NOW,bankContext);
 expect(fresh.get(consumer.id)!.value).toBe(2/12);
 expect(fresh.get(observer.id)!.reason).not.toContain('Bounded bank observation');
 const empty=goalWork(state,board,[status('BowBeforeMe',{bank:[]})],NOW,bankContext);
 expect(empty.get(consumer.id)!.value).toBeNull();
 expect(empty.get(observer.id)!.reason).not.toContain('Bounded bank observation');
 expect(board.collection.missing[0]).toMatchObject({need:12,owned:0,verifyOwned:8});
 expect(state.goals.find(goal=>goal.id==='main24')!.completedTasks).toBe(0);
});

test('near-complete bank observation keeps total-goal, same-account and linked-consumer bounds',()=>{
 const board=ringGoals();board.collection.missing[0]!.verifyOwned=8;
 const observer=bankObserver({account:'BowBeforeMe'});
 for(const consumer of [ringConsumer({account:'BowBeforeMe',dependsOn:[observer.id],accept:{bank:{1637:13}}}),
  ringConsumer({account:'Other',dependsOn:[observer.id],accept:{bank:{1637:5}}})]){
  const {state}=evaluate([bankProof,observer,consumer],board,[]);
  expect(goalWork(state,board,[],NOW,bankContext).get(observer.id)!.value??0).toBe(0);
 }
 const {state}=evaluate([bankProof,observer],board,[]);
 expect(goalWork(state,board,[],NOW,bankContext).get(observer.id)!.value).toBe(0);
});

test('near-complete absolute production targets do not expand GE input observation spending',()=>{
 const board=ringGoals();board.collection.missing[0]!.verifyOwned=8;
 const input=ringInput({account:'BowBeforeMe',env:{ITEM_ID:'2357',QUANTITY:'2',EXPECTED_OWNED:'0',LIMIT_PRICE:'3500',CASH_RESERVE:'90000',ORDER_MS:'900000'},accept:{bank:{2357:2}}});
 const consumer=ringConsumer({account:'BowBeforeMe',dependsOn:[input.id],env:{RECIPE:'sapphire_ring',TARGET:'2',BATCH:'2'},accept:{bank:{1637:5}}});
 const {state}=evaluate([geProof,input,consumer],board,[]);
 const values=goalWork(state,board,[status('BowBeforeMe',{bank:[{id:1637,count:3}],bankAt:NOW-300000})],NOW,ringContext);
 expect(values.get(input.id)!.value).toBeNull();
 expect(values.get(input.id)!.reason).not.toContain('Bounded GE input observation');
 expect(values.get(consumer.id)!.value).toBeNull();
});

test('bank observers require the strict entry, one account, a short timeout and exact observation counter',()=>{
 const refused:CoordTask[]=[bankObserver({env:{}}),bankObserver({env:{REQUIRE_BANK:'0'}}),bankObserver({args:['unexpected']}),
  bankObserver({timeoutMs:undefined}),bankObserver({timeoutMs:120001}),bankObserver({account:undefined,participants:['Helper','Other']}),
  bankObserver({accept:{counters:{bankObserved:2}}}),bankObserver({accept:{counters:{bankItems:1}}}),bankObserver({accept:{counters:{bankObserved:1,bankItems:1}}}),
  bankObserver({accept:{bank:{1623:3}}}),bankObserver({accept:{bank:{1623:3},counters:{bankObserved:1}}})];
 for(const task of refused){const {state}=evaluate(observationChain(task),observedRingGoals(),[]);expect(goalWork(state,observedRingGoals(),[],NOW,bankContext).get(task.id)!.value??0).toBe(0);}
 const {state}=evaluate(observationChain(),observedRingGoals(),[]);
 expect(goalWork(state,observedRingGoals(),[],NOW,{entryOf:c=>c==='bank-observation'?'scripts/goldfarm.ts':bankContext.entryOf(c)}).get('bank-observe')!.value??0).toBe(0);
 const invalid=state.tasks.find(row=>row.spec.id==='bank-observe')!.spec;
 for(const timeout of [0,-1,1.5,Infinity]){invalid.timeoutMs=timeout;expect(goalWork(state,observedRingGoals(),[],NOW,bankContext).get(invalid.id)!.value??0).toBe(0);}
});

test('bank observation needs a pending same-account exact unmet noncoin consumer',()=>{
 for(const consumer of [ringConsumer({account:'Other'}),ringConsumer({account:undefined,participants:['Helper','Other']}),
  ringConsumer({accept:{bank:{1637:13}}}),ringConsumer({accept:{counters:{rings:1}}}),ringConsumer({accept:{bank:{995:1}}})]){
  const {state}=evaluate(observationChain(bankObserver(),consumer),observedRingGoals(),[]);
  expect(goalWork(state,observedRingGoals(),[],NOW,bankContext).get('bank-observe')!.value??0).toBe(0);
 }
 for(const patch of [{owned:12},{id:undefined},{consumer:'unresolved named supply'},{verifyOwned:12}]){
  const board=observedRingGoals();Object.assign(board.collection.missing[0]!,patch);
  const {state}=evaluate(observationChain(),board,[]);expect(goalWork(state,board,[],NOW,bankContext).get('bank-observe')!.value??0).toBe(0);
 }
 const board=observedRingGoals(),{state}=evaluate(observationChain(),board,[]);
 state.tasks.find(row=>row.spec.id==='ring-consumer')!.status='failed';
 expect(goalWork(state,board,[],NOW,bankContext).get('bank-observe')!.value).toBe(0);
 const isolated=evaluate([bankProof,bankObserver()],board,[]).state;
 expect(goalWork(isolated,board,[],NOW,bankContext).get('bank-observe')!.value??0).toBe(0);
});

test('an observer accepts an empty bank but cannot claim item, coin, quest or counter progress itself',()=>{
 const observer=bankObserver(),board=observedRingGoals(),{state}=evaluate(observationChain(observer),board,[]);
 expect(goalWork(state,board,[],NOW,bankContext).get(observer.id)!.value).toBe(.01);
 expect(goalWork(state,board,[status('Helper',{bank:[],bankAt:NOW-300000})],NOW,bankContext).get(observer.id)!.value).toBe(.01);
 const effects:NonNullable<CoordTask['accept']>[]=[{bank:{1637:1}},{bank:{995:90000}},{counters:{bankObserved:1}},{quests:['Lost City']}];
 for(const accept of effects){
  const own=bankObserver({accept}),only=evaluate([bankProof,own],board,[status('Helper')]).state;
  expect(goalWork(only,board,[status('Helper')],NOW,bankContext).get(own.id)!.value??0).toBe(0);
 }
 const fresh=goalWork(state,board,[status('Helper')],NOW,bankContext);
 expect(fresh.get(observer.id)!.value).toBe(1/12);
 expect(fresh.get(observer.id)!.reason).not.toContain('Bounded bank observation');
});

test('the strict observer result counter satisfies only its current successful coordinator run',()=>{
 const task=bankObserver(),detail='ok inspection bankObserved=1 bankGeneration=2 bankObservedAt=999990 bankItems=0';
 const observed=status('Helper',{result:detail,counters:resultCounters(detail),workRevision:'source',coordinatorRunId:'observe-run',started:NOW-10}) as ReturnType<typeof status>&{counters:ReturnType<typeof resultCounters>};
 const context={account:'Helper',goal:'main24',source:'source',startedAt:NOW-10,now:NOW,runId:'observe-run'};
 expect(observed.counters).toMatchObject({bankObserved:1,bankItems:0});
 expect(acceptStatus(task,observed,context)).toBe(true);
 expect(acceptStatus(task,{...observed,coordinatorRunId:'old-run'},context)).toBe(false);
 expect(acceptStatus(task,{...observed,result:'fail bank not observed'},context)).toBe(false);
 expect(acceptStatus(task,{...observed,counters:resultCounters('ok inspection')},context)).toBe(false);
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

test('the last bank read of an account whose session ended stays known until a newer login attempt, and not before the session ends', () => {
 const TEN_MINUTES = 600_000, OLD = NOW - TEN_MINUTES;
 // The session read its bank 10 minutes ago (over the 5 minutes) and ended with a result: 100 nature runes are held, so the supply adds nothing.
 const closed = status('Helper', { at: OLD + 60_000, bankAt: OLD, bank: [{ id: 561, count: 100 }], result: 'ok logout' });
 const supply = () => run('supply', { accept: { bank: { 561: 100 } } });
 const valueWith = (row: any, loginAfter?: (account: string, at: number) => boolean) => {
  const state = initialState(); addTasks(state, [supply()], NOW);
  return goalWork(state, goals(), [row], NOW, loginAfter ? { loginAfter } : {}).get('supply')!.value;
 };
 const asked: [string, number][] = [];
 // No login attempt since the read: the bank is known, no inspection is needed.
 expect(valueWith(closed, (account, at) => { asked.push([account, at]); return false; })).toBe(0);
 expect(asked).toEqual([['Helper', OLD]]);
 // A newer login attempt, or no way to exclude one: unknown again, as before.
 expect(valueWith(closed, () => true)).toBeNull();
 expect(valueWith(closed)).toBeNull();
 // A session that has not ended (no result) is not closed: its bank can have changed after the read.
 const live = { ...closed }; delete (live as any).result;
 expect(valueWith(live, () => false)).toBeNull();
 // A read in the last 5 minutes is known without the hook, and the hook is not asked.
 let calls = 0;
 expect(valueWith(status('Helper', { bank: [{ id: 561, count: 100 }] }), () => { calls++; return true; })).toBe(0);
 expect(calls).toBe(0);
 // A read that is newer than its own status row, or not a time, is never known.
 expect(valueWith({ ...closed, bankAt: closed.at + 1 }, () => false)).toBeNull();
 expect(valueWith({ ...closed, bankAt: 0 }, () => false)).toBeNull();
});

test('bounded lava-maze-escorted-ore runs get Runite board support only when advancing holdings or expected ore',()=>{
 const context={entryOf:(cap:string)=>cap==='lava-maze-escorted-ore'?'scripts/lava-maze-escorted-ore.ts':undefined};
 const proof:CoordTask={id:'qualify-runite',kind:'qualify',goal:'gear',capability:'lava-maze-escorted-ore',dependsOn:[],priority:75,estimatedMs:900000,why:'Qualify Runite escort'};
 const pilot=(patch:Partial<CoordTask>={}):CoordTask=>run('runite-pilot',{goal:'gear',capability:'lava-maze-escorted-ore',account:undefined,participants:['KnightRider','OreElse'],acceptIndex:1,dependsOn:['qualify-runite'],timeoutMs:1800000,env:{MAX_ORE:'1',EXPECTED_BANK_ORE:'0'},accept:{bank:{451:1}},...patch});
 const knownZero=status('OreElse',{bank:[{id:1275,count:1}]});
 const {state}=evaluate([proof,pilot()],goals(),[knownZero]);
 const vals=goalWork(state,goals(),[knownZero],NOW,context);
 expect(vals.get('runite-pilot')!.value).toBe(.01);
 expect(vals.get('qualify-runite')!.value).toBe(.01);
 // Already holding 1 Runite ore refuses a target of 1; advancing target=2 with EXPECTED_BANK_ORE=1 succeeds.
 const knownOne=status('OreElse',{bank:[{id:451,count:1}]});
 expect(goalWork(state,goals(),[knownOne],NOW,context).get('runite-pilot')!.value).toBe(0);
 const stepTwo=evaluate([proof,pilot({env:{MAX_ORE:'1',EXPECTED_BANK_ORE:'1'},accept:{bank:{451:2}}})],goals(),[knownOne]);
 expect(goalWork(stepTwo.state,goals(),[knownOne],NOW,context).get('runite-pilot')!.value).toBe(.01);
 // Stale bank still allows EXPECTED_BANK_ORE + 1 pilot, while omitting EXPECTED_BANK_ORE requires observation.
 const stale=status('OreElse',{bankAt:0});
 expect(goalWork(state,goals(),[stale],NOW,context).get('runite-pilot')!.value).toBe(.01);
 const noExpected=evaluate([pilot({dependsOn:[],env:{MAX_ORE:'1'}})]);
 expect(goalWork(noExpected.state,goals(),[stale],NOW,context).get('runite-pilot')!.value).toBeNull();
 // Unbounded MAX_ORE or wrong script or missing timeout gets zero.
 expect(goalWork(evaluate([pilot({dependsOn:[],env:{MAX_ORE:'2',EXPECTED_BANK_ORE:'0'}})]).state,goals(),[knownZero],NOW,context).get('runite-pilot')!.value).toBe(0);
 expect(goalWork(evaluate([pilot({dependsOn:[],timeoutMs:undefined})]).state,goals(),[knownZero],NOW,context).get('runite-pilot')!.value).toBe(0);
 expect(goalWork(state,goals(),[knownZero],NOW,{entryOf:()=> 'scripts/goldfarm.ts'}).get('runite-pilot')!.value).toBe(0);
});

test('low-playtime Quest Points accounts earn quest credit for uncompleted journal quests even when fleet coverage completed them',()=>{
 const doneBoard=goals({quests:{complete:1,total:1,remaining:[],observedAccounts:1,evidence:[]}});
 const questRun=(account:string,quest='Lost City')=>run('qp-run',{account,accept:{quests:[quest]}});
 // Low playtime (< 73,866t) + uncompleted in own journal earns 1.
 const lowStatus=status('Quiverfull',{playtimeTicks:1560,quests:[{name:'Lost City',state:'not started'}]});
 expect(goalWork(evaluate([questRun('Quiverfull')]).state,doneBoard,[lowStatus],NOW).get('qp-run')!.value).toBe(1);
 // Already complete in own journal earns 0.
 const completeOwn=status('Quiverfull',{playtimeTicks:1560,quests:[{name:'Lost City',state:'complete'}]});
 expect(goalWork(evaluate([questRun('Quiverfull')]).state,doneBoard,[completeOwn],NOW).get('qp-run')!.value).toBe(0);
 // High playtime (>= 73,866t) earns 0 when fleet already completed it.
 const slowStatus=status('Mightyrod',{playtimeTicks:73866,quests:[{name:'Lost City',state:'not started'}]});
 expect(goalWork(evaluate([questRun('Mightyrod')]).state,doneBoard,[slowStatus],NOW).get('qp-run')!.value).toBe(0);
});
