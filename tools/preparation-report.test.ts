import {expect,test} from 'bun:test';
import {preparationRoute,reconcilePreparation} from './preparation-report';
import {questDefinitions} from '../packages/core/src/quest-status';
const now=1_000_000;
const bank=(name:string,items:any[],age=100)=>({name,server:'rs-sdk-demo.fly.dev',bankAt:now-age,bank:items});
test('exact kit IDs ignore lookalikes and pool known aliases once',()=>{
 const requirements=[{item:'black dragonhide body',itemId:2503,count:1},{item:'Black body alias',itemId:2503,count:1}];
 const rows=[bank('Wrong',[{id:2501,name:'Dragonhide body',count:8}]),bank('Right',[{id:2503,name:'Dragonhide body',count:1}])];
 const r=reconcilePreparation(requirements,rows,['Wrong','Right'],now);
 expect(r.items).toHaveLength(1);
 expect(r.items[0]).toMatchObject({itemId:2503,required:2,recentBanked:1,shortfall:1,state:'short'});
});
test('preparation unlocks distinguish unobserved containers from observed empty ones',()=>{
 const quest=questDefinitions().find(q=>q.name==='Rune Mysteries Quest')!;
 const pick={id:1267,name:'Iron pickaxe',count:1};
 const base={...bank('A',[],10),at:now-10,questsAt:now-10,quests:[{...quest,state:'complete'}],
  inventory:[],equipment:[] as (typeof pick)[],equipmentObserved:true as boolean|undefined};
 const tools=(patch:Partial<typeof base>)=>reconcilePreparation([],[{...base,...patch}],['A'],now).readiness[0]!.goals['essence-tools']?.state;
 expect(tools({})).toBe(false);
 expect(tools({equipmentObserved:false})).toBeNull();
 expect(tools({equipmentObserved:undefined,equipment:[pick]})).toBeNull();
 expect(tools({equipment:[pick]})).toBe(true);
 expect(tools({equipmentObserved:false,bank:[pick]})).toBe(true);
 expect(tools({bankAt:now-5,bank:[pick]})).toBeNull();
 expect(tools({questsAt:now-5,bank:[pick]})).toBeNull();
});
test('shared consumers cannot count the same stock twice',()=>{
 const r=reconcilePreparation([{item:'feathers',count:6,consumers:['quest']},{item:'Feather',count:6,consumers:['gear']}],[bank('A',[{id:314,name:'Feather',count:10}])],['A'],now);
 expect(r.items).toHaveLength(1);
 expect(r.items[0]).toMatchObject({required:12,recentBanked:10,shortfall:2,state:'short',consumers:['quest','gear']});
});
test('route report binds stock to recent owned observations and never stages it',()=>{
 const model={places:{start:{x:0,z:0},target:{x:10,z:0}},cache:{nearestBank:{},legs:{},banks:{pickup:{x:4,z:0}}}};
 const cost={coins:30,food:1,accessible:true};
 const req={from:'start',to:'target',count:10,capacity:10,budget:{coins:60,food:2},stops:[{holder:'A',bank:'pickup',reserved:0,outbound:cost,onward:cost}]};
 for(const age of [100,300001]){
  const r=reconcilePreparation([{item:'Trout',count:10}],[bank('A',[{id:333,name:'Trout',count:10}],age)],['A'],now);
  const route=preparationRoute(r,model,'Trout',req);
  expect(!!route.selected).toBe(age===100);expect(r.staged).toBe(false);
 }
});
test('planner plural names resolve only the verified feather and headless-arrow aliases',()=>{
 const r=reconcilePreparation([{item:'feathers',count:800},{item:'headless arrows',count:100},{item:'glasses',count:1}],
  [bank('A',[{id:314,name:'Feather',count:900},{id:53,name:'Headless arrow',count:75},{id:999,name:'Glass',count:10}])],['A'],now);
 expect(r.items[0]).toMatchObject({itemId:314,recentBanked:900,shortfall:0});
 expect(r.items[1]).toMatchObject({itemId:53,recentBanked:75,shortfall:25});
 expect(r.items[2]!.unresolved).toBe(true);
});
test('counts identified recent owned banks once and never calls them staged',()=>{
 const r=reconcilePreparation([{item:'Trout',count:20}], [bank('Cook',[{id:334,baseId:333,name:'Trout',count:12}]),bank('Cook',[{id:334,baseId:333,name:'Trout',count:12}]),bank('stranger',[{id:333,name:'Trout',count:90}])],['Cook','cook'],now);
 expect(r.staged).toBe(false);expect(r.items[0]).toMatchObject({recentBanked:12,shortfall:8});expect(r.items[0]!.holders).toHaveLength(1);
});
test('old stock, future stock, practice stock and packs cannot cover a shortage',()=>{
 const old=bank('Old',[{id:333,name:'Trout',count:100}],300001);
 const future=bank('Future',[{id:333,name:'Trout',count:100}],-1);
 const local={...bank('Local',[{id:333,name:'Trout',count:100}]),server:'localhost:8888'};
 const pack={...bank('Pack',[]),inventory:[{id:333,name:'Trout',count:100}]};
 const r=reconcilePreparation([{item:'Trout',count:20}],[old,future,local,pack],['Old','Future','Local','Pack'],now);
 expect(r.items[0]).toMatchObject({recentBanked:0,datedBanked:100,shortfall:20});expect(r.banks.find(b=>b.name==='Future')?.state).toBe('unknown');
});
test('unknown and conflicting item IDs remain unresolved, not spendable stock',()=>{
 const r=reconcilePreparation([{item:'Trout',count:20}], [bank('A',[{name:'Trout',count:20}]),bank('B',[{id:333,name:'Trout',count:4},{id:999,name:'Trout',count:5}])],['A','B'],now);
 expect(r.items[0]!.recentBanked).toBe(0);expect(r.items[0]!.unresolved).toBe(true);
});
test('newest holder snapshot wins, malformed banks and future observations stay unknown',()=>{
 const r=reconcilePreparation([{item:'Coins',count:10}], [bank('A',[{id:995,name:'Coins',count:50}],200),bank('a',[{id:995,name:'Coins',count:3}],100),bank('B',[{id:995,name:'Coins',count:-1}])],['A','B'],now);
 expect(r.items[0]!.recentBanked).toBe(3);expect(r.items[0]!.shortfall).toBe(7);expect(r.banks.find(b=>b.name==='B')?.state).toBe('unknown');
});
