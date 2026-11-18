import {expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {setEquipmentObserved} from '../src/container-observation';
import {attachProgressionSession,evaluateProgressionWork,preflightProgressionWork,parentProgressionAccept,finiteProgressionAccept,progressionRateConditions,progressionProofs} from '../src/progression-session';
import {accountFromStatus,loadProgressionCatalog} from '../../planner/src/progression-catalog';
import {chooseProgression} from '../../planner/src/progression';
import {progressionMethods} from '../../planner/src/progression-catalog';

test('fleet preparation preserves its finite consumer and coordinator acceptance wins',()=>{
 const base=mkdtempSync(join(tmpdir(),'progression-consumer-'));
 const work={script:'scripts/ranged-train.ts',args:['85'],env:{PROGRESSION_CONSUMER:JSON.stringify({skills:{ranged:99}}),COORDINATOR_RUN_ID:'run'}};
 try{
  expect(parentProgressionAccept(work,'Fixture',base)).toEqual({skills:{ranged:99}});
  mkdirSync(join(base,'.practice/coordinator'),{recursive:true});
  writeFileSync(join(base,'.practice/coordinator/state.json'),JSON.stringify({tasks:[{runId:'run',spec:{account:'Fixture',accept:{bank:{882:500}}}}]}));
  expect(parentProgressionAccept(work,'Fixture',base)).toEqual({bank:{882:500}});
  expect(parentProgressionAccept({...work,env:{PROGRESSION_CONSUMER:'{"skills":{"ranged":100}}'}},'Fixture',base)).toBeUndefined();
  expect(finiteProgressionAccept({bank:{882:Infinity}})).toBeUndefined();
  expect(finiteProgressionAccept({skills:{ranged:99},authorized:true})).toBeUndefined();
 }finally{rmSync(base,{recursive:true,force:true});}
});

test('learned rates separate boosts, combat levels, active prayers and attack style',()=>{
 const status={server:'server',skills:[{name:'Ranged',level:80,currentLevel:80},{name:'Hitpoints',level:99,currentLevel:99}],equipment:[{slot:3,id:841}],progressionCrowding:0,progressionContext:{style:'rapid',prayers:[false]}};
 const key=progressionRateConditions(status);
 expect(progressionRateConditions({...status,skills:[{...status.skills[0],currentLevel:90},status.skills[1]]})).not.toBe(key);
 expect(progressionRateConditions({...status,progressionContext:{style:'rapid',prayers:[true]}})).not.toBe(key);
 expect(progressionRateConditions({...status,progressionContext:{style:'accurate',prayers:[false]}})).not.toBe(key);
});

test('Prayer99 with a six-bone reserve is not complete at the actual Prayer96 entry',()=>{
 const base=mkdtempSync(join(tmpdir(),'progression-prayer-reserve-')),now=Date.now();
 const work={script:'scripts/train-prayer.ts',args:['99'],env:{BONE_ID:'536',MAX_BURY:'105',BONE_RESERVE:'6',CAP:'1500',COORDINATOR_RUN_ID:'prayer-run'}};
 const status={name:'Fixture',server:'rs-sdk-demo.fly.dev',at:now,bankAt:now,questsAt:now,equipmentObserved:true,skills:[{name:'Prayer',level:96,xp:811012},{name:'Hitpoints',level:99,xp:1115790}],inventory:[],equipment:[],bank:[{id:536,count:111}],quests:[]};
 try{
  mkdirSync(join(base,'.practice/coordinator'),{recursive:true});
  writeFileSync(join(base,'.practice/coordinator/state.json'),JSON.stringify({tasks:[{runId:'prayer-run',spec:{account:'Fixture',accept:{skills:{Prayer:99},bank:{536:6}}}}]}));
  const live=evaluateProgressionWork(work,status,{base,now,requireQualification:true});
  expect(live.intent).toEqual({kind:'train',skill:'prayer',targetLevel:99});expect(live.decision?.state).not.toBe('complete');expect(live.supported).toBe(true);
  const done=evaluateProgressionWork(work,{...status,skills:[{name:'Prayer',level:99,xp:1000012},{name:'Hitpoints',level:99,xp:1115790}],bank:[{id:536,count:6}]},{base,now,requireQualification:true});
  expect(done.decision?.state).toBe('complete');
 }finally{rmSync(base,{recursive:true,force:true});}
});

test('source-qualified admission survives a spent arrow but stays bound to its finite intent',()=>{
 const base=mkdtempSync(join(tmpdir(),'progression-stock-')),now=Date.now(),source='native-source';
 const work={script:'scripts/ranged-train.ts',args:['85'],env:{WORKER_RELEASE:source}};
 const status={name:'Fixture',server:'rs-sdk-demo.fly.dev',at:now,bankAt:now,questsAt:now,equipmentObserved:true,skills:[{name:'Ranged',level:80,xp:285700},{name:'Hitpoints',level:99,xp:1084907},{name:'Defence',level:99,xp:1084907}],inventory:[],equipment:[{id:284,slot:4,count:1},{id:285,slot:7,count:1}],bank:[{id:841,count:1},{id:882,count:149},{id:2142,count:43},{id:995,count:382923}],quests:[],pos:{x:3253,z:3421,level:0}};
 try{
  mkdirSync(join(base,'.practice/progression-system'),{recursive:true});
  const proof=join(base,'proof.json'),bytes=JSON.stringify({ok:true,source,supportedMethods:[{id:'ranged/troopers',source,bands:[{items:{882:149},levels:{Ranged:{min:80,max:85}},loadout:[284,285]}]}]});
  writeFileSync(proof,bytes);writeFileSync(join(base,'.practice/progression-system/qualifications.json'),JSON.stringify({proofs:[{path:proof,sha256:createHash('sha256').update(bytes).digest('hex')}]}));
  const initial=evaluateProgressionWork(work,status,{now,base,requireQualification:true});
  expect(initial.decision?.selected).toBe('ranged/troopers');
  const admitted={method:initial.decision!.selected!,source,intent:initial.intent!,account:structuredClone(initial.account!)};
  const spent={...status,bank:status.bank.map(i=>i.id===882?{...i,count:148}:i)};
  expect(evaluateProgressionWork(work,spent,{now,base,requireQualification:true,currentMethod:admitted.method,continuing:true}).supported).toBe(false);
  expect(evaluateProgressionWork(work,spent,{now,base,requireQualification:true,currentMethod:admitted.method,continuing:true,admitted}).decision?.state).toBe('execute');
  expect(evaluateProgressionWork({...work,args:['99']},spent,{now,base,requireQualification:true,currentMethod:admitted.method,continuing:true,admitted}).decision?.state).not.toBe('execute');
 }finally{rmSync(base,{recursive:true,force:true});}
});

test('native qualifications retain different account bands on the same source without mixing releases',()=>{
 const base=mkdtempSync(join(tmpdir(),'progression-bands-'));
 try{
  const dir=join(base,'.practice/progression-system');mkdirSync(dir,{recursive:true});
  const references=[85,95].map(level=>{
   const path=join(dir,'proof-'+level+'.json'),bytes=JSON.stringify({ok:true,source:'same-source',supportedMethods:[{id:'ranged/troopers',source:'same-source',bands:[{levels:{Prayer:{min:level,max:level}}}]}]});
   writeFileSync(path,bytes);return{path,sha256:createHash('sha256').update(bytes).digest('hex')};
  });
  const index=join(dir,'qualifications.json');writeFileSync(index,JSON.stringify({proofs:[...references,...references]}));
  const retained=progressionProofs(base)['ranged/troopers'];
  expect(retained?.bands).toHaveLength(2);expect(retained?.bands.map(b=>b.levels.Prayer.min)).toEqual([85,95]);
  const path=join(dir,'changed-source.json'),bytes=JSON.stringify({ok:true,source:'changed-source',supportedMethods:[{id:'ranged/troopers',source:'changed-source',bands:[{levels:{Prayer:{min:99,max:99}}}]}]});
  writeFileSync(path,bytes);writeFileSync(index,JSON.stringify({proofs:[...references,{path,sha256:createHash('sha256').update(bytes).digest('hex')}]}));
  expect(progressionProofs(base)['ranged/troopers']).toEqual({source:'changed-source',bands:[{levels:{Prayer:{min:99,max:99}}}]});
 }finally{rmSync(base,{recursive:true,force:true});}
});

test('every connected session records and enforces a handoff before new work',()=>{
 const base=mkdtempSync(join(tmpdir(),'progression-session-')),ticks:(()=>void)[]=[];
 const state:any={inGame:true,player:{worldX:3253,worldZ:3421,level:0,inCombat:false},skills:[{name:'Hitpoints',baseLevel:99,level:99,experience:1000000}],inventory:[],equipment:[]};
 const s:any={name:'Fixture',sdk:{getState:()=>state},tick:()=>1,onTick:(cb:()=>void)=>(ticks.push(cb),()=>{}),bankObservation:()=>null,ended:new Promise(()=>{})};
 try{
  const p=attachProgressionSession(s,{script:'scripts/train-chickens.ts',args:[],env:{}},'localhost:8888',{base,log:()=>{},evaluate:()=>({supported:false,intent:{kind:'train',skill:'Ranged',targetLevel:85},decision:null,reason:'faster qualified route'})});
  ticks[0]!();expect(s.progression).toBe(p);
  expect(p.refusal({type:'interactNpc',option:'Attack'})).toContain('progression');
  expect(p.refusal({type:'clickComponent',componentId:2458})).toBeNull();
  let handoff='';p.onHandoff(detail=>{handoff=detail;});expect(handoff).toContain('faster qualified route');
  const record=JSON.parse(readFileSync(join(base,'.practice/progression-system/decisions/Fixture.json'),'utf8'));
  expect(record.supported).toBe(false);expect(record.entry).toBe('scripts/train-chickens.ts');
 }finally{rmSync(base,{recursive:true,force:true});}
});

test('an unqualified model cannot interrupt the authored practice worker it needs to measure',()=>{
 const base=mkdtempSync(join(tmpdir(),'progression-practice-')),now=Date.now(),client={};setEquipmentObserved(client,true);
 const state:any={inGame:true,player:{worldX:3253,worldZ:3421,level:0,combat:{inCombat:false}},skills:[{name:'Ranged',baseLevel:1,level:1,experience:0},{name:'Hitpoints',baseLevel:10,level:10,experience:1154}],inventory:[],equipment:[]};
 const s:any={name:'Fixture',client,sdk:{getState:()=>state},tick:()=>1,onTick:()=>()=>{},bankObservation:()=>({at:now,generation:1,items:[{id:841,count:1},{id:882,count:25},{id:1985,count:3}]}),ended:new Promise(()=>{})};
 try{
  const p=attachProgressionSession(s,{script:'scripts/ranged-starter.ts',args:[],env:{}},'localhost:8888',{base,log:()=>{}}),e=p.refresh();
  expect(e?.supported).toBe(true);expect(e?.decision?.followUps.some(f=>f.state==='qualify')).toBe(true);
  expect(p.refusal({type:'interactNpc',option:'Attack'})).toBeNull();
 }finally{rmSync(base,{recursive:true,force:true});}
});

test('unmapped and practice-only live entries refuse before opening an account',()=>{
 const c=loadProgressionCatalog();
 expect(()=>preflightProgressionWork({script:'.practice/unknown.ts',args:[],env:{}},'rs-sdk-demo.fly.dev',c)).toThrow('unmapped');
 const localOnly={...c,entries:[...c.entries,{script:'scripts/measure/fixture.ts',intents:['observe' as const],skills:[],routeIds:[],practiceOnly:true}]};
 expect(()=>preflightProgressionWork({script:'scripts/measure/fixture.ts',args:[],env:{}},'rs-sdk-demo.fly.dev',localOnly)).toThrow('local practice only');
 expect(()=>preflightProgressionWork({script:'scripts/ranged-train.ts',args:['85'],env:{PROGRESSION_SOURCE:'old',WORKER_RELEASE:'current'}},'rs-sdk-demo.fly.dev',c)).toThrow('source claim');
});

test('a completed finite goal yields cleanup without dereferencing a nonexistent next step',()=>{
 const now=Date.now();
 const status={name:'Fixture',at:now,bankAt:now,questsAt:now,equipmentObserved:true,skills:[{name:'Ranged',level:99,xp:1000000}],inventory:[],equipment:[],bank:[],quests:[]};
 const result=evaluateProgressionWork({script:'scripts/ranged-train.ts',args:['85'],env:{}},status,{now});
 expect(result.decision?.state).toBe('complete');expect(result.supported).toBe(false);expect(result.reason).toContain('complete');
});

test('a known build ceiling refuses a direct larger training goal despite unknown comparisons',()=>{
 const now=Date.now(),status={name:'Fixture',server:'server',at:now,bankAt:now,questsAt:now,equipmentObserved:true,skills:[{name:'Ranged',level:80,xp:285700},{name:'Hitpoints',level:99,xp:1084907}],inventory:[],equipment:[],bank:[],quests:[],build:{maxLevels:{Ranged:80}}};
 const result=evaluateProgressionWork({script:'scripts/ranged-train.ts',args:['99'],env:{}},status,{now});
 expect(result.supported).toBe(false);expect(result.reason).toContain('build');
});

test('the actual method cannot silently leave its controller resource claim',()=>{
 const base=mkdtempSync(join(tmpdir(),'progression-claim-')),now=Date.now();
 const state:any={inGame:true,player:{worldX:3253,worldZ:3421,level:0,inCombat:false},skills:[{name:'Ranged',baseLevel:80,level:80,experience:285700},{name:'Hitpoints',baseLevel:99,level:99,experience:1000000}],inventory:[],equipment:[]};
 const s:any={name:'Fixture',sdk:{getState:()=>state},tick:()=>1,onTick:()=>()=>{},bankObservation:()=>({at:now,generation:1,items:[{id:841,count:1},{id:882,count:149},{id:2142,count:43}]}),ended:new Promise(()=>{})};
 try{
  const p=attachProgressionSession(s,{script:'scripts/ranged-train.ts',args:['85'],env:{PROGRESSION_METHOD:'ranged/chickens'}},'localhost:8888',{base,log:()=>{}});
  expect(()=>p.executing('ranged/troopers')).toThrow('resource claim');
 }finally{rmSync(base,{recursive:true,force:true});}
});

test('the real SDK nested combat state defers handoff until the current fight ends',()=>{
 const base=mkdtempSync(join(tmpdir(),'progression-combat-')),ticks:(()=>void)[]=[];let tick=1,handoffs=0;
 const state:any={inGame:true,player:{worldX:3253,worldZ:3421,level:0,combat:{inCombat:true,targetType:'npc',targetIndex:17}},skills:[{name:'Hitpoints',baseLevel:99,level:99,experience:1000000}],inventory:[],equipment:[]};
 const s:any={name:'Fixture',sdk:{getState:()=>state},tick:()=>tick,onTick:(cb:()=>void)=>(ticks.push(cb),()=>{}),bankObservation:()=>null,ended:new Promise(()=>{})};
 try{
  const p=attachProgressionSession(s,{script:'scripts/train-chickens.ts',args:[],env:{}},'localhost:8888',{base,log:()=>{},evaluate:()=>({supported:false,intent:{kind:'train',skill:'Ranged',targetLevel:85},decision:null,reason:'faster qualified route'})});
  ticks[0]!();p.onHandoff(()=>{handoffs++;});
  expect(handoffs).toBe(0);expect(p.refusal({type:'interactNpc',npcIndex:17,option:'Attack'})).toBeNull();
  state.player.combat.inCombat=false;tick++;p.refresh('fight complete');expect(handoffs).toBe(1);
 }finally{rmSync(base,{recursive:true,force:true});}
});

test('the session uses the same finite selector and catalog as controller planning',()=>{
 const now=Date.now(),status={name:'Fixture',server:'localhost:8888',at:now,bankAt:now,questsAt:now,equipmentObserved:true,skills:[{name:'Ranged',level:80,xp:285700},{name:'Hitpoints',level:99,xp:1000000},{name:'Defence',level:99,xp:1000000}],inventory:[],equipment:[],bank:[{id:841,count:1},{id:882,count:149},{id:2142,count:43},{id:995,count:382923}],quests:[],pos:{x:3253,z:3421,level:0}};
 const work={script:'scripts/ranged-train.ts',args:['85'],env:{}};
 const evaluation=evaluateProgressionWork(work,status,{now,requireQualification:false});
 expect(evaluation.intent).toMatchObject({kind:'train',skill:'ranged',targetLevel:85});
 const account=accountFromStatus(status.name,status,now),methods=progressionMethods(evaluation.intent!,account).methods;
 const same=chooseProgression(evaluation.intent!,account,methods,{now,maxSearchNodes:256,maxDepth:6});
 expect(evaluation.decision?.selected).toBe(same.selected);
 expect(evaluation.decision?.expectedTicks).toBe(same.expectedTicks);
});

test('an obsolete route can still open a bank booth through the SDK Use-quickly fallback',()=>{
 const base=mkdtempSync(join(tmpdir(),'progression-bank-cleanup-'));
 const state:any={inGame:true,player:{worldX:3253,worldZ:3421,level:0,combat:{inCombat:false}},skills:[{name:'Hitpoints',baseLevel:99,level:99,experience:1000000}],inventory:[],equipment:[],nearbyLocs:[{id:2213,x:3253,z:3420,name:'Bank booth',optionsWithIndex:[{opIndex:1,text:'Use-quickly'}]}]};
 const s:any={name:'Fixture',sdk:{getState:()=>state},tick:()=>1,onTick:()=>()=>{},bankObservation:()=>null,ended:new Promise(()=>{})};
 try{
  const p=attachProgressionSession(s,{script:'scripts/train-chickens.ts',args:[],env:{}},'localhost:8888',{base,log:()=>{},evaluate:()=>({supported:false,intent:null,decision:null,reason:'route handoff'})});
  expect(p.refusal({type:'interactLoc',locId:2213,x:3253,z:3420,optionIndex:1})).toBeNull();
 }finally{rmSync(base,{recursive:true,force:true});}
});
