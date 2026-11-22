import {expect,test} from 'bun:test';
import {addTasks,initialState,chooseTask,type CoordTask} from '../src/coordinator';
import {applyObservationRequests,generatedObservationConsumer,observationConsumerHeld,prepareObservationBand,type ObservationBridgeDeps} from '../src/coordinator-observations';
import {goalWork} from '../src/goal-work';
import type {OwnerGoals} from '../src/goal-scoreboard';
import type {FleetProgressionRequest} from '../../planner/src/progression-fleet';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {coordinatorAccountPaused} from '../src/coordinator-cli';
import {SWARM_STOP} from '../../../scripts/swarm';
const NOW=1_000_000,server='rs-sdk-demo.fly.dev';
const status=(name:string,at=NOW-400000)=>({name,at,server,bankAt:at,skills:[{name:'Ranged',level:80,xp:285700},{name:'Hitpoints',level:99,xp:1000000}],bank:[],inventory:[],equipment:[]});
const request=(account:string):FleetProgressionRequest=>({account,action:'observe',method:'ranged/troopers',reason:'Fresh valid account skill observations are required.',consumer:{work:{script:'scripts/ranged-train.ts',args:['99','1500'],env:{MAX_TRIPS:'50'}},accept:{skills:{Ranged:99}}}});
function fixture(names=['Fighter']){
 const state=initialState();
 for(const cap of ['ranged-train','owned-bank-observation']){
  addTasks(state,[{id:'review-'+cap,kind:'review',goal:'skills',capability:cap,dependsOn:[],priority:1,estimatedMs:1,why:'Source review'}, {id:'native-'+cap,kind:'qualify',goal:'skills',capability:cap,dependsOn:[],priority:1,estimatedMs:1,why:'Native source proof'}],NOW-10);
  for(const r of state.tasks.filter(r=>r.spec.capability===cap)){r.status='succeeded';r.receipt={taskId:r.spec.id,runId:r.spec.id,ok:true,at:NOW-5,output:r.spec.kind==='review'?{review:{approved:true}}:{delivery:{id:cap,ok:true,source:'source-'+cap}}};}
 }
 const goals={version:1,at:NOW,quests:{remaining:[]},collection:{missing:[]},army:{roster:names,accounts:names.map(account=>({account,levels:{Ranged:80},at:NOW}))},specialists:{targets:[]},main:{}}as unknown as OwnerGoals;
 const deps:ObservationBridgeDeps={now:NOW,side:'local',goals,statuses:names.map(n=>status(n)),allowed:n=>names.includes(n),paused:()=>false,definition:id=>({id,entry:id==='owned-bank-observation'?'scripts/fleet-inspect.ts':'scripts/ranged-train.ts',source:'source-'+id}),capabilityFor:entry=>entry==='scripts/ranged-train.ts'?'ranged-train':null,prepare:()=>null};
 return{state,deps};
}
const consumers=(state:ReturnType<typeof initialState>)=>state.tasks.filter(r=>generatedObservationConsumer(r.spec));
const observations=(state:ReturnType<typeof initialState>)=>state.tasks.filter(r=>r.spec.id.startsWith('progression-observe-'));
const settle=(r:any,at=NOW)=>{r.status='succeeded';r.runId=r.spec.id;r.receipt={taskId:r.spec.id,runId:r.spec.id,ok:true,at,output:{ok:true,evidence:'live',account:r.spec.account}};};

function bowSupply(){
 const {state,deps}=fixture(['BowBeforeMe']);
 deps.goals.collection.missing=[{id:1637,item:'Sapphire ring',need:12,owned:0,verifyOwned:10,consumer:'main Overall'}];
 deps.statuses=[{...status('BowBeforeMe'),bank:[{id:1637,count:5}]}];
 deps.definition=id=>({id,entry:id==='owned-bank-observation'?'scripts/fleet-inspect.ts':id==='ge'?'scripts/aio-market.ts':id==='cut'?'scripts/microbot-production.ts':'scripts/microbot-jewellery-trip.ts',source:'source-'+id});
 const task=(id:string,kind:CoordTask['kind'],capability:string,dependsOn:string[],accept:CoordTask['accept']={}):CoordTask=>({id,kind,capability,dependsOn,goal:'main24',...(kind==='run'?{account:'BowBeforeMe',launch:'ordinary' as const}:{}),priority:45,estimatedMs:60000,timeoutMs:900000,args:[],env:{LOOT_WATCH:'0',RANDOM_EVENTS:'0'},accept,why:'Finite two-ring Overall supply chain'});
 addTasks(state,[task('ge-build','build','ge',[]),task('ge-qualified','qualify','ge',['ge-build']),task('cut-qualified','qualify','cut',[]),task('jewel-qualified','qualify','jewel',[]),
  task('buy-bars','run','ge',['ge-qualified'],{bank:{2357:2}}),task('cut-two','run','cut',['buy-bars','cut-qualified'],{bank:{1607:2}}),
  {...task('make-two','run','jewel',['cut-two','jewel-qualified'],{bank:{1637:7}}),env:{RECIPE:'sapphire_ring',TARGET:'2',BATCH:'2',CAP:'1500',RETURN_TICKS:'200',LOOT_WATCH:'0',RANDOM_EVENTS:'0'}}],NOW);
 return{state,deps};
}

test('stale Bow supply stock gets one strict observer after every slow qualification without changing the two-ring budget',()=>{
 const {state,deps}=bowSupply(),original=structuredClone(state.tasks.find(r=>r.spec.id==='make-two')!.spec);
 const result=applyObservationRequests(state,[],deps),observer=result.added.find(t=>t.capability==='owned-bank-observation')!;
 expect(observer).toBeDefined();expect(result.added).toHaveLength(1);
 expect(observer.env).toEqual({REQUIRE_BANK:'1',LOOT_WATCH:'0',RANDOM_EVENTS:'0'});expect(observer.timeoutMs).toBe(120000);expect(observer.accept).toEqual({counters:{bankObserved:1}});
 for(const id of ['native-owned-bank-observation','ge-qualified','cut-qualified','jewel-qualified'])expect(observer.dependsOn).toContain(id);
 const consumer=state.tasks.find(r=>r.spec.id==='make-two')!.spec;expect({...consumer,dependsOn:original.dependsOn}).toEqual(original);expect(consumer.dependsOn).toContain(observer.id);
 const values=goalWork(state,deps.goals,deps.statuses,NOW,{entryOf:cap=>deps.definition(cap).entry});
 expect(values.get(observer.id)?.value).toBe(.01);expect(values.get('make-two')?.value).toBeNull();
 for(const id of ['ge-build','ge-qualified','cut-qualified','jewel-qualified'])expect(values.get(id)?.value).toBe(.01);
 expect(applyObservationRequests(state,[],deps).added).toEqual([]);
});

test('fresh bank, orphan and unknown coin targets do not create supply observers',()=>{
 for(const mode of ['fresh','orphan','coins']){
  const {state,deps}=bowSupply();if(mode==='fresh')deps.statuses=[{...status('BowBeforeMe',NOW),bank:[{id:1637,count:5}]}];
  if(mode==='orphan')deps.goals.collection.missing=[];
  if(mode==='coins')state.tasks.find(r=>r.spec.id==='make-two')!.spec.accept={bank:{995:2}};
  expect(applyObservationRequests(state,[],deps).added).toEqual([]);
 }
});

test('a pending prequalification bank observer is reused and ordered after all slow qualifications',()=>{
 const {state,deps}=bowSupply();
 const observer:CoordTask={id:'existing-bank-observer',kind:'run',goal:'main24',capability:'owned-bank-observation',account:'BowBeforeMe',launch:'ordinary',dependsOn:['native-owned-bank-observation'],priority:49,estimatedMs:30000,timeoutMs:120000,args:[],env:{REQUIRE_BANK:'1',LOOT_WATCH:'0',RANDOM_EVENTS:'0'},accept:{counters:{bankObserved:1}},why:'Observe the same finite supply consumer'};
 addTasks(state,[observer],NOW);expect(applyObservationRequests(state,[],deps).added).toEqual([]);
 for(const id of ['ge-qualified','cut-qualified','jewel-qualified'])expect(observer.dependsOn).toContain(id);
 expect(state.tasks.find(r=>r.spec.id==='make-two')!.spec.dependsOn).toContain(observer.id);
});

test('a queued strict bank observer keeps its identity across source refresh instead of duplicating the manual queue repair',()=>{
 const {state,deps}=bowSupply();
 const observer:CoordTask={id:'manual-bank-observer',kind:'run',goal:'main24',capability:'owned-bank-observation',account:'BowBeforeMe',launch:'ordinary',dependsOn:['native-owned-bank-observation','ge-qualified','cut-qualified','jewel-qualified'],priority:49,estimatedMs:30000,timeoutMs:120000,args:[],env:{REQUIRE_BANK:'1',LOOT_WATCH:'0',RANDOM_EVENTS:'0'},accept:{counters:{bankObserved:1}},why:'Accepted queue-only fresh bank repair'};
 addTasks(state,[observer],NOW);const definition=deps.definition;deps.definition=id=>({...definition(id),...(id==='owned-bank-observation'?{source:'new-source'}:{})});
 const result=applyObservationRequests(state,[],deps);expect(result.added.filter(t=>t.kind==='run')).toEqual([]);
 const refresh=result.added.find(t=>t.kind==='qualify')!;expect(refresh.capability).toBe('owned-bank-observation');expect(observer.dependsOn).toContain(refresh.id);
 expect(state.tasks.find(r=>r.spec.id==='make-two')!.spec.dependsOn).toContain(observer.id);expect(applyObservationRequests(state,[],deps).added).toEqual([]);
});

test('reusing an observer cannot move it behind a qualification that requires its captured entry',()=>{
 const {state,deps}=bowSupply();
 const observer:CoordTask={id:'entry-bank-observer',kind:'run',goal:'main24',capability:'owned-bank-observation',account:'BowBeforeMe',launch:'ordinary',dependsOn:['native-owned-bank-observation'],priority:49,estimatedMs:30000,timeoutMs:120000,args:[],env:{REQUIRE_BANK:'1',LOOT_WATCH:'0',RANDOM_EVENTS:'0'},accept:{counters:{bankObserved:1}},why:'Capture an entry for qualification'};
 addTasks(state,[observer,{id:'captured-entry-qualified',kind:'qualify',goal:'main24',capability:'jewel',dependsOn:[observer.id],priority:49,estimatedMs:600000,why:'Qualify the captured observer entry'}],NOW);
 state.tasks.find(r=>r.spec.id==='make-two')!.spec.dependsOn.push('captured-entry-qualified');
 applyObservationRequests(state,[],deps);expect(observer.dependsOn).not.toContain('captured-entry-qualified');expect(()=>addTasks(state,[],NOW)).not.toThrow();
 expect(state.tasks.find(r=>r.spec.id==='captured-entry-qualified')!.spec.dependsOn).toContain(observer.id);
});

test('an expired successful prequalification bank snapshot cannot hold the consumer forever',()=>{
 const {state,deps}=bowSupply();const old:CoordTask={id:'old-bank-observer',kind:'run',goal:'main24',capability:'owned-bank-observation',account:'BowBeforeMe',launch:'ordinary',dependsOn:['native-owned-bank-observation'],priority:49,estimatedMs:30000,timeoutMs:120000,args:[],env:{REQUIRE_BANK:'1',LOOT_WATCH:'0',RANDOM_EVENTS:'0'},accept:{counters:{bankObserved:1}},why:'Earlier successful bank inspection'};
 addTasks(state,[old],NOW-400000);settle(state.tasks.find(r=>r.spec.id===old.id),NOW-400000);
 deps.statuses=[{...deps.statuses[0],coordinatorRunId:old.id}];state.tasks.find(r=>r.spec.id==='make-two')!.spec.dependsOn.push(old.id);
 const added=applyObservationRequests(state,[],deps).added;expect(added).toHaveLength(1);expect(added[0].id).not.toBe(old.id);
 expect(added[0].dependsOn).toContain('jewel-qualified');expect(applyObservationRequests(state,[],deps).added).toEqual([]);
});

test('a generated Ranged consumer refreshes an accepted bank and kit snapshot after its slow qualification',()=>{
 const {state,deps}=fixture();deps.statuses=[{...status('Fighter',NOW-800000),equipmentObserved:true}];
 deps.needsEntryObservation=(_t,_a,s)=>!s||deps.now-s.bankAt>=300000;
 applyObservationRequests(state,[request('Fighter')],deps);const old=observations(state)[0];settle(old,NOW-400000);
 deps.statuses=[{...status('Fighter',NOW-400000),equipmentObserved:true,coordinatorRunId:old.runId}];
 addTasks(state,[{id:'slow-state-qualification',kind:'qualify',capability:'ranged-train',goal:'skills',account:'Fighter',dependsOn:[old.spec.id],priority:49,estimatedMs:600000,why:'Actual captured-state proof after prior bank inspection'}],NOW-300000);
 settle(state.tasks.find(r=>r.spec.id==='slow-state-qualification'));consumers(state)[0].spec.dependsOn.push('slow-state-qualification');
 const result=applyObservationRequests(state,[],deps);expect(result.added).toHaveLength(1);expect(result.added[0].env?.REQUIRE_BANK).toBe('1');
 expect(result.added[0].id).not.toBe(old.spec.id);expect(result.added[0].dependsOn).toContain('slow-state-qualification');
 expect(old.status).toBe('succeeded');expect(applyObservationRequests(state,[],deps).added).toEqual([]);
});

test('internal stops permit a linked observer; owner, unknown and lowercase pauses remain held',()=>{
 const directory=mkdtempSync(join(tmpdir(),'observer-pauses-'));mkdirSync(join(directory,'.practice'));
 try{
  const file=join(directory,'.practice/stop-Fighter'),lower=join(directory,'.practice/stop-fighter');
  for(const text of Object.values(SWARM_STOP)){
   writeFileSync(file,text);const {state,deps}=fixture();deps.paused=account=>coordinatorAccountPaused(account,directory);
   expect(deps.paused('Fighter')).toBe(false);expect(applyObservationRequests(state,[request('Fighter')],deps).added).toHaveLength(2);expect(readFileSync(file,'utf8')).toBe(text);
  }
  for(const text of ['owner pause','', 'unknown stop']){
   writeFileSync(file,SWARM_STOP.all);writeFileSync(lower,text);const {state,deps}=fixture();deps.paused=account=>coordinatorAccountPaused(account,directory);
   expect(deps.paused('Fighter')).toBe(true);expect(applyObservationRequests(state,[request('Fighter')],deps).added).toEqual([]);expect(readFileSync(lower,'utf8')).toBe(text);
  }
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('22 actual selected useful consumers fan out once, then resume qualified finite bands from fresh state',()=>{
 const names=Array.from({length:22},(_,i)=>'Helper'+i),{state,deps}=fixture(names),requests=names.map(request);
 const first=applyObservationRequests(state,requests,deps);expect(first.added).toHaveLength(44);expect(consumers(state)).toHaveLength(22);expect(observations(state)).toHaveLength(22);
 const values=goalWork(state,deps.goals,deps.statuses,NOW,{entryOf:c=>deps.definition(c).entry});
 for(const r of observations(state))expect(values.get(r.spec.id)?.value).toBe(.01);
 expect(consumers(state).every(r=>observationConsumerHeld(r.spec))).toBe(true);
 const second=applyObservationRequests(state,requests,deps);expect(second).toEqual({added:[],linked:[],prepared:[],invalidated:[]});
 for(const r of observations(state))settle(r);
 deps.statuses=names.map(n=>status(n,NOW));deps.prepare=t=>({...t,args:['83','1500'],accept:{skills:{Ranged:83}},env:{...t.env,PROGRESSION_METHOD:'ranged/troopers',PROGRESSION_SOURCE:'worker-source'}});
 expect(applyObservationRequests(state,requests,deps).prepared).toHaveLength(22);
 expect(consumers(state).every(r=>r.spec.args?.[1]==='1500'&&r.spec.env?.MAX_TRIPS==='50'&&!observationConsumerHeld(r.spec))).toBe(true);
 expect(chooseTask(state,NOW,{goalValue:t=>goalWork(state,deps.goals,deps.statuses,NOW,{entryOf:c=>deps.definition(c).entry}).get(t.id)?.value??null})?.accept?.skills).toEqual({Ranged:83});
});

test('qualification owns the captured entry; a slow successful proof gets a fresh observation after it',()=>{
 const {state,deps}=fixture();applyObservationRequests(state,[request('Fighter')],deps);settle(observations(state)[0]);deps.statuses=[status('Fighter',NOW)];
 deps.qualificationFor=t=>({id:'state-native',kind:'qualify',capability:t.capability,account:t.account,goal:t.goal,dependsOn:[...t.dependsOn],env:{PROGRESSION_ACCOUNT:'Fighter'},priority:46,estimatedMs:100,why:'Fresh state native'});
 applyObservationRequests(state,[],deps);expect(state.tasks.find(r=>r.spec.id==='state-native')?.status).toBe('pending');
 deps.now=NOW+400000;expect(applyObservationRequests(state,[],deps).added).toEqual([]);
 settle(state.tasks.find(r=>r.spec.id==='state-native'));
 const after=applyObservationRequests(state,[],deps);expect(after.added.filter(t=>t.kind==='run')).toHaveLength(1);expect(after.added[0]?.dependsOn).toContain('state-native');
});

test('completed finite work retains the selected99 request for the next state; failure never retries unchanged',()=>{
 const {state,deps}=fixture();deps.statuses=[status('Fighter',NOW)];deps.prepare=t=>({...t,args:['83','1500'],accept:{skills:{Ranged:83}},env:{...t.env,PROGRESSION_METHOD:'ranged/troopers',PROGRESSION_SOURCE:'source'}});
 applyObservationRequests(state,[{...request('Fighter'),action:'qualify'}],deps);const first=consumers(state)[0];settle(first);
 deps.statuses=[{...status('Fighter',NOW+1),skills:[{name:'Ranged',level:83,xp:350000}]}];deps.now=NOW+1;
 expect(applyObservationRequests(state,[],deps).added.filter(t=>generatedObservationConsumer(t))).toHaveLength(1);
 const next=consumers(state).at(-1)!;next.status='failed';next.receipt={taskId:next.spec.id,runId:'failed',ok:false,at:NOW+2,output:null};
 deps.now=NOW+400001;deps.statuses=[status('Fighter',NOW+400001)];expect(applyObservationRequests(state,[request('Fighter')],deps).added).toEqual([]);
});

test('proof drift removes prepared claims and a failed prerequisite cannot be replaced by another observation',()=>{
 const {state,deps}=fixture();applyObservationRequests(state,[request('Fighter')],deps);const consumer=consumers(state)[0];settle(observations(state)[0]);deps.statuses=[status('Fighter',NOW)];
 consumer.spec.env={...consumer.spec.env,PROGRESSION_METHOD:'stale',PROGRESSION_SOURCE:'stale'};
 applyObservationRequests(state,[],deps);expect(observationConsumerHeld(consumer.spec)).toBe(true);
 observations(state)[0].status='failed';deps.now=NOW+500000;expect(applyObservationRequests(state,[],deps).added).toEqual([]);
});

test('pre-eligibility telemetry, protected, paused, unowned and non-goal accounts cannot create an observer',()=>{
 for(const mode of ['telemetry','protected','paused','unowned','non-goal']){
  const name=mode==='protected'?'Haggis':'Fighter',{state,deps}=fixture([name]);let r=request(name);
  if(mode==='telemetry')delete r.consumer;if(mode==='paused')deps.paused=()=>true;if(mode==='unowned')deps.allowed=()=>false;if(mode==='non-goal')deps.goals.army.roster=[];
  expect(applyObservationRequests(state,[r],deps).added).toEqual([]);expect(observations(state)).toHaveLength(0);
 }
});

test('a priority100 authored finite consumer retains its controls and all observation priorities remain legal',()=>{
 const {state,deps}=fixture();state.tasks=state.tasks.filter(r=>r.spec.id!=='native-owned-bank-observation');
 const t:CoordTask={id:'authored',kind:'run',goal:'skills',capability:'ranged-train',account:'Fighter',dependsOn:['native-ranged-train'],args:['85','1500'],env:{MAX_TRIPS:'50'},accept:{skills:{Ranged:85}},priority:100,estimatedMs:1000,timeoutMs:900000,why:'Actual finite army consumer'};addTasks(state,[t],NOW);
 const added=applyObservationRequests(state,[],deps).added;expect(added).toHaveLength(2);expect(added.every(t=>t.priority===100)).toBe(true);expect(t.args).toEqual(['85','1500']);expect(t.env).toEqual({MAX_TRIPS:'50'});
});

test('fresh skills with missing bank or kit facts immediately get one strict supported bank observation',()=>{
 const {state,deps}=fixture();deps.statuses=[{...status('Fighter',NOW),equipmentObserved:false}];deps.needsEntryObservation=(_t,_a,s)=>s.equipmentObserved!==true;
 applyObservationRequests(state,[{...request('Fighter'),action:'qualify'}],deps);
 const observe=observations(state)[0];expect(observe.spec.env?.REQUIRE_BANK).toBe('1');expect(observe.spec.accept).toEqual({counters:{bankObserved:1}});
 settle(observe);deps.statuses=[{...status('Fighter',NOW+1),equipmentObserved:false,coordinatorRunId:observe.runId}];deps.now=NOW+1;
 expect(applyObservationRequests(state,[],deps).added).toEqual([]);
 expect(observationConsumerHeld(consumers(state)[0].spec)).toBe(true);
});

test('finite band selection prices intermediate qualified levels without raising1500ticks or50trips',()=>{
 const t:CoordTask={...request('Fighter').consumer!.work,id:'finite',kind:'run',goal:'skills',capability:'ranged-train',account:'Fighter',dependsOn:[],priority:1,estimatedMs:1,timeoutMs:1200000,why:'OriginalRanged99',accept:{skills:{Ranged:99}}};
 const seen:number[]=[],selected=prepareObservationBand(t,status('Fighter',NOW),'scripts/ranged-train.ts',trial=>{const level=trial.accept!.skills!.Ranged!;seen.push(level);return{action:'continue',capability:'ranged-train',decision:{expectedTicks:level===85?1904:level===84?1600:1400,selected:'ranged/troopers'},stepAccept:{skills:{Ranged:level}},route:[{capability:'ranged-train'}]}as any;},()=>'current-source');
 expect(seen).toEqual([85,84,83]);expect(selected?.accept).toEqual({skills:{Ranged:83}});expect(selected?.args).toEqual(['83','1500']);expect(selected?.env?.MAX_TRIPS).toBe('50');expect(t.accept).toEqual({skills:{Ranged:99}});
 expect(prepareObservationBand(t,status('Fighter',NOW),'scripts/ranged-train.ts',()=>({action:'measure',decision:null}as any),()=>'current-source')).toBeNull();
});
