import {expect,test} from 'bun:test';
import {freshRuneSupplyChecks} from '../src/fresh-rune-supply-proof';
import * as proof from '../src/fresh-rune-supply-proof';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readPracticeSave} from '../../../scripts/measure/fleet-player-save';

// flairx60g01's retained failure: no action was sent and no game contents changed.
// Historical regression uses the recorded logout clock28. New native evidence
// must supply independent /tickstats bounds, not derive them from this save.
const recordedSession={mode:'refused' as const,clockBefore:28,clockAfter:28};

const cookingFailure=join(import.meta.dir,'../../../.practice/deliveries/fresh-rune-supply-order-1793208082105-DtsG72');
test.skipIf(!existsSync(join(cookingFailure,'interrupted.sav')))('copies of the retained late-cooking save reject its stale checkpoint without gameplay',()=>{
 const dir=mkdtempSync(join(tmpdir(),'rune-cooking-evidence-'));
 const names=['before.sav','interrupted.sav','interrupted.log'];
 const hashes=()=>names.map(n=>createHash('sha256').update(readFileSync(join(cookingFailure,n))).digest('hex'));
 const original=hashes();
 try{
  for(const n of names)copyFileSync(join(cookingFailure,n),join(dir,n));
  const before=readPracticeSave(join(dir,'before.sav')),after=readPracticeSave(join(dir,'interrupted.sav'));
  expect(before.skills[3]!.rawExperience).toBe(9800);
  expect(after.skills[7]).toMatchObject({rawExperience:7500,xp:750,level:8});
  const held=(id:number)=>after.inventories[93]!.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
  expect([held(2138),held(2140),held(2144)]).toEqual([9,1,0]);
  const log=readFileSync(join(dir,'interrupted.log'),'utf8'),run={code:1,log};
  expect(proof.freshRuneSavedResult(after,run)).toBe(false);
  const recorded=JSON.parse(log.split('\n').find(l=>l.startsWith('RUNE_SUPPLY_RESULT '))!.slice('RUNE_SUPPLY_RESULT '.length));
  expect(recorded).toMatchObject({ok:false,stopReason:'tick-cap',stages:{food:{consumed:0,cooked:0,xp:0}}});
  expect(log).toContain('LOGOUT logged-out');
  // A synthetic corrected snapshot exercises the predicate only. It is never published as a checkpoint.
  const final={...recorded.final,inventory:after.inventories[93],equipment:after.inventories[94],
   skills:after.skills.map(s=>({experience:s.xp,level:s.level}))};
  const corrected={...recorded,final,stages:{...recorded.stages,food:{...recorded.stages.food,consumed:1,cooked:1,xp:750,remainingRaw:9}}};
  const check=(r:unknown)=>proof.freshRuneSavedResult(after,{code:1,log:'RUNE_SUPPLY_RESULT '+JSON.stringify(r)});
  expect(check(corrected)).toBe(true);
  corrected.stages.food.settlement='unresolved';expect(check(corrected)).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});expect(hashes()).toEqual(original);}
});
const recordedVarps={23:8192,134:28,166:2,168:2,169:2,275:4294967295,277:4294967295,367:4294967295};
function checkRecordedSession(before:ReturnType<typeof readPracticeSave>,after:ReturnType<typeof readPracticeSave>){
 expect(proof.freshRuneRecoveryContentsEqual(before,after,recordedSession)).toBe(true);
 expect(proof.freshRuneRecoveryContentsEqual(before,after)).toBe(false);
 for(const mutate of [
  (s:typeof after)=>{s.vars[166]=3;},(s:typeof after)=>{s.vars[168]=1;},(s:typeof after)=>{s.vars[169]=0;},
  (s:typeof after)=>{s.vars[23]=8193;},(s:typeof after)=>{s.vars[22]=67108864;},
  (s:typeof after)=>{s.vars[63]=5;},(s:typeof after)=>{s.vars[101]=2;},(s:typeof after)=>{s.vars[365]=1;},
  (s:typeof after)=>{s.vars[367]=123;},(s:typeof after)=>{s.vars[275]=0;},(s:typeof after)=>{s.vars[277]=600;},
  (s:typeof after)=>{s.vars[134]=30;},(s:typeof after)=>{s.vars[999]=1;},
  (s:typeof after)=>{s.skills[3]!.rawExperience--;},(s:typeof after)=>{s.skills[20]!.level++;},
  (s:typeof after)=>{s.inventories[93]![1]!.count++;},(s:typeof after)=>{s.inventories[95]![0]!.count--;},
  (s:typeof after)=>{s.inventories[94]![0]!.id=1277;},(s:typeof after)=>{s.inventories[94]![0]!.slot=4;},
  (s:typeof after)=>{s.position.x++;},(s:typeof after)=>{s.position.z++;},(s:typeof after)=>{s.position.level++;},
 ]){const bad=structuredClone(after);mutate(bad);expect(proof.freshRuneRecoveryContentsEqual(before,bad,recordedSession)).toBe(false);}
}

test('recorded ordinary login/logout transitions preserve exact game contents',()=>{
 const before=save();before.version=6;before.position={x:2843,z:4832,level:0};before.vars={63:6,101:1,281:1000,275:0,277:0};
 before.inventories={93:[{slot:0,id:1438,count:1},{slot:1,id:556,count:26}],94:[{slot:3,id:1265,count:1}],95:[{slot:0,id:556,count:25}]};
 const after=structuredClone(before);after.version=9;Object.assign(after.vars,recordedVarps);
 checkRecordedSession(before,after);
 for(const clock of [{clockBefore:29,clockAfter:30},{clockBefore:27,clockAfter:27},{clockBefore:0,clockAfter:28},
  {clockBefore:29,clockAfter:28},{clockBefore:1,clockAfter:6002},{clockBefore:27.5,clockAfter:29}])
  expect(proof.freshRuneRecoveryContentsEqual(before,after,{...recordedSession,...clock})).toBe(false);
 const outside=structuredClone(after);outside.position={x:2983,z:3288,level:0};outside.vars[22]=67108864;
 expect(proof.freshRuneRecoveryContentsEqual(before,outside,{...recordedSession,mode:'exit'})).toBe(true);
 for(const mutate of [(s:typeof outside)=>{s.vars[22]=67108865;},(s:typeof outside)=>{s.vars[23]=0;},
  (s:typeof outside)=>{s.position.x++;},(s:typeof outside)=>{s.vars[367]=0;}]){
  const bad=structuredClone(outside);mutate(bad);
  expect(proof.freshRuneRecoveryContentsEqual(before,bad,{...recordedSession,mode:'exit'})).toBe(false);
 }
 // A later ordinary login keeps existing options, music and explicit coordinates.
 const established=structuredClone(after);established.vars[166]=4;established.vars[168]=0;established.vars[169]=1;
 established.vars[367]=0;const later=structuredClone(established);later.vars[134]=32;
 expect(proof.freshRuneRecoveryContentsEqual(established,later,{mode:'refused',clockBefore:31,clockAfter:33})).toBe(true);
 later.vars[166]=2;
 expect(proof.freshRuneRecoveryContentsEqual(established,later,{mode:'refused',clockBefore:31,clockAfter:33})).toBe(false);
});

const retainedRecovery=join(import.meta.dir,'../../../.practice/deliveries/fresh-rune-supply-order-1793207396996-1F7SbV/air-recovery/0');
test.skipIf(!existsSync(join(retainedRecovery,'refused.sav')))('retained before/refused saves pass only the supported session transitions, read-only',()=>{
 const paths=['before.sav','refused.sav'].map(p=>join(retainedRecovery,p));
 const hashes=()=>paths.map(p=>createHash('sha256').update(readFileSync(p)).digest('hex'));
 const original=hashes();checkRecordedSession(readPracticeSave(paths[0]!),readPracticeSave(paths[1]!));
 expect(hashes()).toEqual(original);
});

test('nested worker deadlines reserve save/cleanup time within the900s native check',()=>{
 const deadline=810000;
 expect(proof.freshRuneChildTimeout('registration',deadline,0)).toBe(45000);
 expect(proof.freshRuneChildTimeout('cooking',deadline,0)).toBe(45000);
 expect(proof.freshRuneChildTimeout('interrupted',deadline,45000)).toBe(180000);
 expect(proof.freshRuneChildTimeout('resume',deadline,300000)).toBe(450000);
 expect(proof.freshRuneChildTimeout('higher',deadline,700000)).toBe(50000);
 for(const label of ['registration','interrupted','resume','higher']){
  expect(proof.freshRuneChildTimeout(label,deadline,749000)).toBe(1000);
  expect(()=>proof.freshRuneChildTimeout(label,deadline,750000)).toThrow('no child budget');
 }
});

async function lifecycle(run:(directory:string,deps:any,events:string[])=>Promise<void>){
 const directory=mkdtempSync(join(tmpdir(),'fresh-rune-lifecycle-')),events:string[]=[];
 const deps={practice:directory,free:()=>13*2**30,portsFree:()=>true,start:async(options:any)=>{
  events.push('ready');expect(options).toEqual({tickMs:150,xpRate:25,readyTimeoutMs:60000});
  writeFileSync(join(directory,'pids.json'),'owned-stack');
  return {logs:{engine:'',gateway:''},stop:async()=>{events.push('stop');}};
 }};
 try{await run(directory,deps,events);}finally{rmSync(directory,{recursive:true,force:true});}
}
test('registration waits for stack readiness and cleanup holds exclusive ownership',async()=>lifecycle(async(dir,deps,events)=>{
 let ready!:()=>void;const barrier=new Promise<void>(resolve=>{ready=resolve;}),start=deps.start;
 deps.start=async(options:any)=>{events.push('starting');await barrier;return start(options);};
 const pending=proof.withFreshRuneStack(dir,async()=>{events.push('registration');expect(existsSync(join(dir,'delivery-practice.lock'))).toBe(true);},deps);
 await Promise.resolve();expect(events).toEqual(['starting']);ready();await pending;
 expect(events).toEqual(['starting','ready','registration','stop']);expect(existsSync(join(dir,'delivery-practice.lock'))).toBe(false);
}));
test('startup failure never reaches registration and releases only its lock',async()=>lifecycle(async(dir,deps,events)=>{
 deps.start=async()=>{throw Error('startup failed');};
 await expect(proof.withFreshRuneStack(dir,async()=>{events.push('registration');},deps)).rejects.toThrow('startup failed');
 expect(events).toEqual([]);expect(existsSync(join(dir,'delivery-practice.lock'))).toBe(false);
}));
test('400ms recovery uses the same admission, ownership and cleanup path',async()=>lifecycle(async(dir,deps,events)=>{
 deps.start=async(options:any)=>{
  expect(options).toEqual({tickMs:400,xpRate:25,readyTimeoutMs:60000});
  writeFileSync(join(dir,'pids.json'),'owned-stack');
  return {logs:{engine:'',gateway:''},stop:async()=>{events.push('stop');}};
 };
 await proof.withFreshRuneStack(dir,async()=>{events.push('work');},deps,400);
 expect(events).toEqual(['work','stop']);expect(existsSync(join(dir,'delivery-practice.lock'))).toBe(false);
}));
for(const boundary of ['registration','worker'])test(`${boundary} failure stops acquired stack and releases its lock`,async()=>lifecycle(async(dir,deps,events)=>{
 await expect(proof.withFreshRuneStack(dir,async()=>{events.push(boundary);throw Error(boundary);},deps)).rejects.toThrow(boundary);
 expect(events).toEqual(['ready',boundary,'stop']);expect(existsSync(join(dir,'delivery-practice.lock'))).toBe(false);
}));
test('foreign lock, occupied port and recorded stack refuse before startup',async()=>{
 for(const occupied of ['lock','port','pids'])await lifecycle(async(dir,deps,events)=>{
  const file=join(dir,occupied==='lock'?'delivery-practice.lock':'pids.json');
  if(occupied==='port')deps.portsFree=()=>false;else writeFileSync(file,'foreign-owner');
  await expect(proof.withFreshRuneStack(dir,async()=>{events.push('registration');},deps)).rejects.toThrow();
  expect(events).toEqual([]);if(occupied!=='port')expect(readFileSync(file,'utf8')).toBe('foreign-owner');
 });
});
test('changed ownership is retained without stopping another stack or deleting its lock',async()=>lifecycle(async(dir,deps,events)=>{
 await expect(proof.withFreshRuneStack(dir,async()=>{
  writeFileSync(join(dir,'pids.json'),'foreign-stack');writeFileSync(join(dir,'delivery-practice.lock'),'foreign-lock');throw Error('worker');
 },deps)).rejects.toThrow();
 expect(events).toEqual(['ready']);expect(readFileSync(join(dir,'delivery-practice.lock'),'utf8')).toBe('foreign-lock');
 expect(readFileSync(join(dir,'pids.json'),'utf8')).toBe('foreign-stack');
}));
test('fresh startup admission and post-start memory floor prevent registration',async()=>{
 for(const memory of [11,7])await lifecycle(async(dir,deps,events)=>{
  let reads=0;deps.free=()=>((memory===11||reads++>1)?memory:13)*2**30;
  await expect(proof.withFreshRuneStack(dir,async()=>{events.push('registration');},deps)).rejects.toThrow(/reserve|floor/);
  expect(events).toEqual(memory===11?[]:['ready','stop']);expect(existsSync(join(dir,'delivery-practice.lock'))).toBe(false);
 });
});
test('admission is checked again after acquiring ownership',async()=>lifecycle(async(dir,deps,events)=>{
 let reads=0;deps.free=()=> (reads++===0?13:11)*2**30;
 await expect(proof.withFreshRuneStack(dir,async()=>{events.push('registration');},deps)).rejects.toThrow('fresh practice startup reserve');
 expect(events).toEqual([]);expect(existsSync(join(dir,'delivery-practice.lock'))).toBe(false);
}));
test('cleanup failure still releases its own lock and preserves owner evidence',async()=>lifecycle(async(dir,deps,events)=>{
 const start=deps.start;deps.start=async(options:any)=>({...await start(options),stop:async()=>{throw Error('stop failed');}});
 await expect(proof.withFreshRuneStack(dir,async()=>{},deps)).rejects.toThrow('stop failed');
 expect(existsSync(join(dir,'delivery-practice.lock'))).toBe(false);
 expect(readFileSync(join(dir,'stack-owner.json'),'utf8')).toBe('owned-stack');
}));
test('verify on absent evidence is read-only and never acquires practice ownership',async()=>lifecycle(async(dir)=>{
 expect(()=>proof.verifyFreshRuneSupply(dir)).toThrow();
 expect(existsSync(join(dir,'practice-owner.json'))).toBe(false);
 expect(existsSync(join(dir,'delivery-practice.lock'))).toBe(false);
 expect(existsSync(join(dir,'consumer.json'))).toBe(false);
}));
const save=()=>({version:9,position:{x:3094,z:3106,level:0},skills:Array.from({length:21},(_,index)=>({index,level:index===3?10:1,xp:index===3?980:0,rawExperience:index===3?9800:0})),vars:{} as Record<number,number>,inventories:{} as Record<number,any[]>});

test('retained essence diagnostic accounts conversion independently and cannot repeat preparation',()=>{
 const before=save();before.vars={63:6,101:1,281:1000};before.skills[14]!.xp=3375;
 before.inventories={93:[{id:1436,count:26},{id:1438,count:1},{id:315,count:1}],94:[{id:1265,count:1}],95:[{id:1436,count:1},{id:556,count:25}]};
 const after=structuredClone(before);after.skills[20]!.xp=3250;after.skills[20]!.rawExperience=32500;after.skills[20]!.level=18;
 after.inventories[93]=[];after.inventories[95]=[{id:1436,count:1},{id:556,count:51},{id:1438,count:1},{id:315,count:1}];
 const r={ok:true,target:2,preserved:true,mined:0,consumed:26,crafted:26,banked:26,stages:{batches:1},travelFoodEaten:0};
 const run={code:0,log:'RUNE_SUPPLY_ACTION {"action":"craft-air","phase":"end"}\nRUNE_SUPPLY_ACTION {"action":"deposit-air","phase":"end"}\nRUNE_SUPPLY_RESULT '+JSON.stringify(r)+'\nLOGOUT logged-out'};
 expect(Object.values(proof.freshRuneEssenceDiagnosticChecks(before,after,run)).every(Boolean)).toBe(true);
 for(const change of [
  (s:typeof after)=>{s.skills[14]!.rawExperience=50;},
  (s:typeof after)=>{s.inventories[95]!.find(i=>i.id===1436).count=2;},
  (s:typeof after)=>{s.inventories[95]!.find(i=>i.id===556).count=25;},
  (s:typeof after)=>{s.inventories[95]!.find(i=>i.id===556).count=52;},
  (s:typeof after)=>{s.vars[101]=2;},
 ]){const bad=structuredClone(after);change(bad);expect(Object.values(proof.freshRuneEssenceDiagnosticChecks(before,bad,run)).every(Boolean)).toBe(false);}
 const repeated={...r,stages:{...r.stages,training:{ok:true}}};
 expect(proof.freshRuneEssenceDiagnosticChecks(before,after,{...run,log:run.log.replace(JSON.stringify(r),JSON.stringify(repeated))}).noPreparation).toBe(false);
 expect(proof.freshRuneEssenceDiagnosticChecks(before,after,{...run,log:run.log.replace('logged-out','timeout')}).logout).toBe(false);
 expect(()=>proof.freshRuneEssenceDiagnosticInput('invalid-name','missing.sav')).toThrow('existing practice account');
});
test('reduced cooking diagnostic requires real output, independent XP, unchanged other skills and logout',()=>{
 for(const burn of [false,true]){
  const before=save();before.inventories[93]=[{id:2138,count:9},{id:2144,count:1}];
  const after=structuredClone(before);after.inventories[93]=[{id:2138,count:8},{id:2144,count:burn?2:1},...(!burn?[{id:2140,count:1}]:[])];
  if(!burn)Object.assign(after.skills[7]!,{xp:750,rawExperience:7500});
  const run={code:0,log:'STARTER_COOKING {"phase":"dispatch"}\nSTARTER_COOKING {"phase":"action"}\nRUNE_COOK_DIAGNOSTIC_RESULT {}\nLOGOUT logged-out'};
  expect(Object.values(proof.freshRuneCookingDiagnosticChecks(before,after,run)).every(Boolean)).toBe(true);
  expect(proof.freshRuneCookingDiagnosticChecks(before,after,{...run,code:1}).child).toBe(false);
  expect(proof.freshRuneCookingDiagnosticChecks(before,after,{...run,log:run.log.replace('logged-out','timeout')}).logout).toBe(false);
  after.skills[7]!.xp=burn?1:0;expect(proof.freshRuneCookingDiagnosticChecks(before,after,run).xp).toBe(false);
  after.skills[14]!.rawExperience=50;expect(proof.freshRuneCookingDiagnosticChecks(before,after,run).otherSkills).toBe(false);
  after.vars[63]=6;expect(proof.freshRuneCookingDiagnosticChecks(before,after,run).questUnchanged).toBe(false);
  after.inventories[93]![0]!.count=9;expect(proof.freshRuneCookingDiagnosticChecks(before,after,run).oneConversion).toBe(false);
 }
});
test('a reduced diagnostic cannot satisfy full delivery metadata or register a missing identity',async()=>lifecycle(async(dir)=>{
 writeFileSync(join(dir,'cooking-diagnostic.json'),JSON.stringify({ok:true}));
 expect(()=>proof.verifyFreshRuneSupply(dir)).toThrow();
 expect(()=>proof.freshRuneCookingDiagnosticInput('invalid-name','missing.sav')).toThrow('existing practice account');
 expect(()=>proof.freshRuneCookingDiagnosticInput('','missing.sav')).toThrow('existing practice account');
 expect(existsSync(join(dir,'practice-owner.json'))).toBe(false);expect(existsSync(join(dir,'native.json'))).toBe(false);
}));
function scenario(){
 const before=save(),interrupted=structuredClone(before),after=structuredClone(before);
 interrupted.skills[0]!.xp=500;after.vars={63:6,101:1,281:1000};
 after.skills[14]!.xp=5000;after.skills[20]!.xp=5000;after.skills[20]!.level=20;
 after.inventories[95]=[1277,1171,1265,1351,590,303,1925,1931,1205,841,1438].map(id=>({id,count:1})).concat([{id:995,count:25},{id:556,count:65},{id:315,count:1},{id:2309,count:1}]);
 const log=(r:object)=>'RUNE_SUPPLY_RESULT '+JSON.stringify(r)+'\nLOGOUT logged-out';
 return {before,interrupted,after,first:{code:1,log:log({ok:false,stage:'starter-training',stopReason:'tick-cap',ticks:1000,failure:'stopped during training',crafted:0})},resume:{code:0,log:log({ok:true,preserved:true,target:20,crafted:40})},xpRate:25,target:20};
}
test('native checker needs default state, real quest/reward, self-mined input, new bank output and logout',()=>{
 const p=scenario();expect(Object.values(freshRuneSupplyChecks(p)).every(Boolean)).toBe(true);
 const changes:((p:ReturnType<typeof scenario>)=>void)[]=[p=>{p.before.skills[14]!.xp=1;},p=>{p.before.vars[63]=6;},p=>{p.before.inventories[93]=[{id:1436,count:1}];},p=>{p.after.vars[101]=0;},p=>{p.after.inventories[95]!.find(i=>i.id===556).count=25;},p=>{p.after.inventories[95]!.find(i=>i.id===1265).count=0;},p=>{p.after.skills[14]!.xp=0;},p=>{p.resume.log=p.resume.log.replace('logged-out','timeout');}];
 for(const change of changes){
  const mutated=scenario();change(mutated);expect(Object.values(freshRuneSupplyChecks(mutated)).every(Boolean)).toBe(false);
 }
});
test('retained progress and child result cannot be replaced by a matching final save',()=>{
 const p=scenario();p.interrupted=structuredClone(p.before);expect(freshRuneSupplyChecks(p).retainedProgress).toBe(false);
 p.resume.code=1;expect(freshRuneSupplyChecks(p).resume).toBe(false);
});

test('late conversion belongs to the interrupted food stage once across retained-stock resume',()=>{
 const p=scenario();
 const result=(log:string)=>JSON.parse(log.split('\n')[0]!.slice('RUNE_SUPPLY_RESULT '.length));
 const first={...result(p.first.log),stage:'bootstrap-food',ticks:1001,stages:{food:{ok:false,raw:10,consumed:1,cooked:1,burnt:0,xp:750,remainingRaw:9}}};
 const resumed={...result(p.resume.log),stages:{food:{ok:true,raw:9,consumed:9,cooked:8,burnt:1,xp:6000,remainingRaw:0}}};
 const log=(r:unknown)=>'RUNE_SUPPLY_RESULT '+JSON.stringify(r)+'\nLOGOUT logged-out';
 p.first.log=log(first);p.resume.log=log(resumed);
 p.after.skills[7]!.rawExperience=67500;
 p.after.inventories[95]!.push({id:2140,count:9},{id:2144,count:1});
 expect(freshRuneSupplyChecks(p)).toMatchObject({food:true,cooking:true,stopped:true});
 for(const cooked of [0,2]){
  first.stages.food.cooked=cooked;p.first.log=log(first);
  expect(freshRuneSupplyChecks(p)).toMatchObject({food:false,cooking:false});
 }
});
test('pinned default is exactly HP10 at980XP; seeded1154XP and altered levels are refused',()=>{
 expect(freshRuneSupplyChecks(scenario()).defaultSkills).toBe(true);
 for(const [level,xp] of [[10,1154],[9,980],[11,980],[10,979],[10,981]]){
  const p=scenario();Object.assign(p.before.skills[3]!,{level,xp,rawExperience:xp!*10});
  expect(freshRuneSupplyChecks(p).defaultSkills).toBe(false);
 }
 const p=scenario();p.before.skills[3]!.rawExperience=9801;expect(freshRuneSupplyChecks(p).defaultSkills).toBe(false);
 const other=scenario();other.before.skills[14]!.rawExperience=1;expect(freshRuneSupplyChecks(other).defaultSkills).toBe(false);
});
test('entry refusal and generic incomplete failures are not the intentional CAP interruption',()=>{
 for(const failure of ['starter acquisition: tutorial skip unavailable; complete normal tutorial before rune supply','training incomplete hurt=true','unsupported tutorial choice: cap']){
  const p=scenario();p.first.log='RUNE_SUPPLY_RESULT '+JSON.stringify({ok:false,failure})+'\nLOGOUT logged-out';
  expect(freshRuneSupplyChecks(p).stopped).toBe(false);
 }
 for(const change of [{stage:'entry'},{stopReason:'operator'},{stopReason:'died'},{stopReason:'session-ended'},{ticks:999}]){
  const log='RUNE_SUPPLY_RESULT '+JSON.stringify({ok:false,stage:'starter-training',stopReason:'tick-cap',ticks:1000,...change});
  expect(proof.freshRuneSupportedInterruption({code:1,log})).toBe(false);
 }
});
test('native proof requires the saved tutorial completion flag as well as starter items',()=>{
 const p=scenario();p.after.vars[281]=1;expect(freshRuneSupplyChecks(p).tutorial).toBe(false);
});

test('ordinary recovery requires exact inherited deposit, fresh production on continuation and logout',()=>{
 const before=save();before.position={x:2843,z:4832,level:0};before.vars={63:6,101:1,281:1000};
 Object.assign(before.skills[20]!,{level:20,xp:3250,rawExperience:32500});
 before.inventories={93:[{id:556,count:26},{id:1438,count:1},{id:315,count:1}],94:[{id:1265,count:1},{id:1171,count:1}],95:[{id:556,count:25},{id:995,count:25}]};
 const after=structuredClone(before);after.position={x:3253,z:3420,level:0};
 after.inventories[95]=[...before.inventories[93]!,...before.inventories[95]!].filter(i=>i.id!==556).concat([{id:556,count:51}]);after.inventories[93]=[];
 const result={ok:true,target:20,banked:26,inheritedBanked:26,newBanked:0,crafted:0,consumed:0,mined:0,stages:{},travelFoodEaten:0};
 const run=(r:any,s:any)=>({code:0,log:'AIR_EXIT '+JSON.stringify({phase:'outside',position:{worldX:2983,worldZ:3288,level:0}})+'\nRUNE_SUPPLY_RESULT '+JSON.stringify({...r,final:{skills:s.skills.map((sk:any)=>({experience:Math.trunc(sk.rawExperience/10),level:sk.level})),inventory:s.inventories[93],equipment:s.inventories[94]}})+'\nLOGOUT logged-out'});
 const checks=proof.freshRuneAirRecoveryChecks(before,after,run(result,after),20);expect(Object.values(checks).every(Boolean)).toBe(true);
 for(const patch of [{banked:0},{inheritedBanked:25},{crafted:26},{newBanked:26}])expect(Object.values(proof.freshRuneAirRecoveryChecks(before,after,run({...result,...patch},after),20)).every(Boolean)).toBe(false);
 const lost=structuredClone(after);lost.inventories[95]!.find(i=>i.id===995)!.count=24;
 expect(proof.freshRuneAirRecoveryChecks(before,lost,run(result,lost),20).assets).toBe(false);
 expect(proof.freshRuneAirRecoveryChecks(before,after,{...run(result,after),log:run(result,after).log.replace('LOGOUT logged-out','')},20).logout).toBe(false);
 const higher=structuredClone(after);higher.skills[20]!.rawExperience+=1250;higher.skills[20]!.xp+=125;higher.skills[20]!.level=21;
 higher.skills[14]!.rawExperience+=1250;higher.skills[14]!.xp+=125;higher.inventories[95]!.find(i=>i.id===556)!.count+=2;
 const production={...result,target:21,banked:2,inheritedBanked:0,newBanked:2,crafted:2,consumed:1,mined:1};
 expect(Object.values(proof.freshRuneAirRecoveryChecks(after,higher,run(production,higher),21)).every(Boolean)).toBe(true);
 const reseeded=structuredClone(after);reseeded.inventories[95]!.push({id:1436,count:1});
 expect(proof.freshRuneAirRecoveryChecks(reseeded,higher,run(production,higher),21).entry).toBe(false);
});
test('ordinary fixture login may upgrade save format and omit zero varps without changing its contents',()=>{
 const before=save(),after=structuredClone(before);before.version=6;before.vars={63:6,101:1,281:1000,12:0};after.vars={63:6,101:1,281:1000};
 expect(proof.freshRuneRecoveryContentsEqual(before,after)).toBe(true);
 for(const mutate of [(s:any)=>s.vars[12]=1,(s:any)=>s.skills[3].rawExperience--,(s:any)=>s.inventories[93]=[{id:556,count:1}]]){
  const changed=structuredClone(after);mutate(changed);expect(proof.freshRuneRecoveryContentsEqual(before,changed)).toBe(false);
 }
});

test('failed reduced recovery prevents stage admission and default registration',async()=>stageModel(async(dir,deps,events)=>{
 deps.recovery=()=>({ok:false});
 await expect(proof.proveFreshRuneStage(dir,'start',deps)).rejects.toThrow('air recovery gate failed');
 expect(events).toEqual([]);expect(existsSync(join(dir,'fixture.json'))).toBe(false);
}));

const sha=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
// A minimal v9 save for offline stage tests. These bytes never enter the engine.
function encodeSave(path:string,s:ReturnType<typeof save>){
 const header=Buffer.alloc(133);header.writeUInt16BE(0x2004);header.writeUInt16BE(9,2);
 header.writeUInt16BE(s.position.x,4);header.writeUInt16BE(s.position.z,6);header[8]=s.position.level;
 s.skills.forEach((sk,i)=>{header.writeInt32BE(sk.rawExperience,28+i*5);header[32+i*5]=sk.level;});
 const bytes:number[]=[];const u2=(n:number)=>bytes.push(n>>8&255,n&255);
 u2(Object.keys(s.vars).length);
 for(const [id,value] of Object.entries(s.vars)){
  u2(Number(id));const parts=[value&127];let n=value>>>7;while(n){parts.unshift((n&127)|128);n>>>=7;}bytes.push(...parts);
 }
 bytes.push(Object.keys(s.inventories).length);
 for(const [id,items] of Object.entries(s.inventories)){
  u2(Number(id));u2(items.length);for(const item of items){u2(item.id+1);if(item.count<255)bytes.push(item.count);else{bytes.push(255);const b=Buffer.alloc(4);b.writeInt32BE(item.count);bytes.push(...b);}}
 }
 const body=Buffer.concat([header,Buffer.from(bytes)]),crc=Buffer.alloc(4);crc.writeUInt32BE(Bun.hash.crc32(body)>>>0);
 writeFileSync(path,Buffer.concat([body,crc]));
}
const binding={name:'flstagetest',source:'source',files:{'worker.ts':'hash'},identity:'identity',configuration:{server:'localhost:8888',tickMs:150,xpRate:25,content:'content'}};

async function stageModel(work:(dir:string,deps:any,events:string[],current:()=>ReturnType<typeof save>)=>Promise<void>,fail=''){
 const dir=mkdtempSync(join(tmpdir(),'fresh-rune-stage-')),events:string[]=[],path=join(dir,'engine.sav'),p=scenario();
 let current=p.before;
 for(const s of [p.before,p.interrupted,p.after])s.skills.forEach(sk=>sk.rawExperience=sk.xp*10);
 Object.assign(p.interrupted.skills[3]!,{rawExperience:25725,xp:2572,level:18});
 Object.assign(p.after.skills[3]!,{rawExperience:25725,xp:2572,level:18});
 const resultLog=(r:any,s:ReturnType<typeof save>)=>'RUNE_SUPPLY_RESULT '+JSON.stringify({...r,final:{
  skills:s.skills.map(sk=>({experience:Math.trunc(sk.rawExperience/10),level:sk.level})),inventory:s.inventories[93]??[],equipment:s.inventories[94]??[]}})+'\nLOGOUT logged-out';
 const deps:any={recovery:()=>({ok:true}),binding:()=>structuredClone(binding),name:()=>binding.name,save:()=>path,
  create:async()=>{events.push('create');},
  stack:async(stackDir:string,worker:any)=>{events.push('ready');try{return await worker({deadline:Date.now()+810000,check(){}});}finally{
   const stage=stackDir.slice(stackDir.lastIndexOf('stack-')+6);expect(existsSync(join(dir,`stage-${stage}.json`))).toBe(false);events.push('stop');}},
  wait:async(_path:string,ready:any)=>({matched:ready(current)}),
  verify:(directory:string)=>{
   events.push('verify');expect(proof.freshRunePublishedStages(directory,binding).records.length).toBe(4);
   return proof.verifyFreshRuneSupply(directory,{binding:()=>binding,source:()=>binding.source,files:()=>binding.files,recovery:()=>({ok:true,checks:{},at:1})});
  },
  command:async(directory:string,_budget:any,label:string,args:string[],_save:string,env:any)=>{
   events.push(label);if(label!=='registration')expect(Number(env.CAP)).toBeGreaterThan(0);
   let r:any={ok:true,preserved:true,target:Number(args.at(-1)),crafted:0,consumed:0,mined:0,banked:0,stages:{}};
   let code=0;
   if(label==='registration')current=p.before;
   else if(label==='interrupted'){current=p.interrupted;r={...summaryForTest(p.first.log),...r,ok:false,stage:'starter-training',stopReason:'tick-cap',ticks:1000};code=1;}
   else if(label==='first-bank'){expect(args).toEqual(['scripts/rune-supply.ts',binding.name,'2']);current=p.after;r={...r,crafted:40,consumed:40,mined:40,banked:40};}
   else if(label==='resume'){expect(args).toEqual(['scripts/rune-supply.ts',binding.name,'20']);}
   else if(label==='higher'){
    current=structuredClone(current);current.skills[20]!.xp+=125;current.skills[20]!.rawExperience+=1250;current.skills[20]!.level=21;
    current.skills[14]!.xp+=125;current.skills[14]!.rawExperience+=1250;
    current.inventories[95]!.find(i=>i.id===556).count+=2;r={...r,crafted:2,consumed:1,mined:1,banked:2};
   }
   encodeSave(path,current);
   if(fail===label)throw Error('child deadline; retained effects');
   writeFileSync(join(directory,label+'.log'),label==='registration'?'LOGOUT logged-out':resultLog(r,current));writeFileSync(join(directory,label+'.err'),'');
   writeFileSync(join(directory,label+'-outcome.json'),JSON.stringify({code,failure:''}));
   return code;
  }};
 try{await work(dir,deps,events,()=>current);}finally{rmSync(dir,{recursive:true,force:true});}
}
function summaryForTest(log:string){return JSON.parse(log.split('\n')[0]!.slice(19));}

test('stages publish after cleanup in order; restart uses exact retained identity without registration',async()=>stageModel(async(dir,deps,events)=>{
 await proof.proveFreshRuneStage(dir,'start',deps);
 expect(events).toEqual(['ready','create','registration','interrupted','stop']);
 expect(existsSync(join(dir,'stage-start.json'))).toBe(true);
 await proof.proveFreshRuneStage(dir,'first-bank',deps);
 await proof.proveFreshRuneStage(dir,'target',deps);
 expect(events.slice(5)).toEqual(['ready','first-bank','stop','ready','resume','stop']);
 expect(existsSync(join(dir,'first-bank.sav'))).toBe(true);expect(existsSync(join(dir,'after.sav'))).toBe(true);
 expect(existsSync(join(dir,'native.json'))).toBe(false);
 const chain=proof.freshRunePublishedStages(dir,binding,3);
 expect(chain.records.map(r=>r.stage)).toEqual(['start','first-bank','target']);
 expect(chain.records[1]!.inputHash).toBe(sha(join(dir,'interrupted.sav')));
 expect(chain.records[2]!.inputHash).toBe(sha(join(dir,'first-bank.sav')));
 expect(chain.records[2]!.checks.continuation).toBe(true);
 expect(chain.records[2]!.checks.noRepeatedPreparation).toBe(true);
 expect(()=>proof.freshRunePublishedStages(dir,binding)).toThrow();
 const calls=events.length;
 await expect(proof.proveFreshRuneStage(dir,'target',deps)).rejects.toThrow('duplicate');expect(events.length).toBe(calls);
 expect((await proof.proveFreshRuneStage(dir,'higher',deps)).ok).toBe(true);
 expect(events.slice(-4)).toEqual(['ready','higher','stop','verify']);
 expect(existsSync(join(dir,'higher.sav'))).toBe(true);expect(existsSync(join(dir,'native.json'))).toBe(true);
 expect(()=>proof.freshRuneStageInput(dir,'higher',binding,deps.save())).toThrow('completed native');
 const record=readFileSync(join(dir,'stage-higher.json'),'utf8'),native=readFileSync(join(dir,'native.json'),'utf8');
 const evidence={binding:()=>binding,source:()=>binding.source,files:()=>binding.files,recovery:()=>({ok:true,checks:{},at:1})};
 expect(proof.verifyFreshRuneSupply(dir,evidence).ok).toBe(true);
 expect(readFileSync(join(dir,'stage-higher.json'),'utf8')).toBe(record);expect(readFileSync(join(dir,'native.json'),'utf8')).toBe(native);
 const path=join(dir,'first-bank.sav'),old=readFileSync(path);writeFileSync(path,'stale');
 expect(()=>proof.verifyFreshRuneSupply(dir,evidence)).toThrow();writeFileSync(path,old);
 const outcome=join(dir,'higher-outcome.json'),saved=readFileSync(outcome);writeFileSync(outcome,JSON.stringify({code:0,failure:'child deadline'}));
 expect(()=>proof.verifyFreshRuneSupply(dir,evidence)).toThrow('stale stage');writeFileSync(outcome,saved);
}));

test('missing, stale, changed-source/account/config/save and out-of-order stages refuse before admission',async()=>stageModel(async(dir,deps,events)=>{
 await expect(proof.proveFreshRuneStage(dir,'target',deps)).rejects.toThrow();expect(events).toEqual([]);
 await proof.proveFreshRuneStage(dir,'start',deps);const calls=events.length;
 await expect(proof.proveFreshRuneStage(dir,'target',deps)).rejects.toThrow();expect(events.length).toBe(calls);
 for(const changed of [{...binding,name:'another'},{...binding,source:'changed'},{...binding,files:{'worker.ts':'new'}},{...binding,identity:'changed'},
  {...binding,configuration:{...binding.configuration,xpRate:1}}]){
  const bad={...deps,binding:()=>changed};await expect(proof.proveFreshRuneStage(dir,'first-bank',bad)).rejects.toThrow();expect(events.length).toBe(calls);
 }
 const path=deps.save();const bytes=readFileSync(path);writeFileSync(path,'different');
 await expect(proof.proveFreshRuneStage(dir,'first-bank',deps)).rejects.toThrow('engine save differs');writeFileSync(path,bytes);
 const log=join(dir,'interrupted.log'),old=readFileSync(log);writeFileSync(log,'changed');
 await expect(proof.proveFreshRuneStage(dir,'first-bank',deps)).rejects.toThrow('stale stage');writeFileSync(log,old);
 writeFileSync(join(dir,'stage-higher.json.attempt'),'failed');
 await expect(proof.proveFreshRuneStage(dir,'first-bank',deps)).rejects.toThrow('out-of-order');expect(events.length).toBe(calls);
}));

test('a child deadline releases owned stack, retains effects and blocks replay/publication',async()=>stageModel(async(dir,deps,events)=>{
 await proof.proveFreshRuneStage(dir,'start',deps);
 await expect(proof.proveFreshRuneStage(dir,'first-bank',deps)).rejects.toThrow('child deadline');
 expect(events.at(-1)).toBe('stop');expect(existsSync(join(dir,'engine.sav'))).toBe(true);
 expect(existsSync(join(dir,'stage-first-bank.json.attempt'))).toBe(true);
 expect(existsSync(join(dir,'stage-first-bank.json'))).toBe(false);expect(existsSync(join(dir,'native.json'))).toBe(false);
 const calls=events.length;await expect(proof.proveFreshRuneStage(dir,'first-bank',deps)).rejects.toThrow('duplicate');expect(events.length).toBe(calls);
},'first-bank'));

test('stack cleanup failure prevents stage publication and leaves the attempt for the harness',async()=>stageModel(async(dir,deps,events)=>{
 const stack=deps.stack;deps.stack=async(...args:any[])=>{await stack(...args);throw Error('owned cleanup failed');};
 await expect(proof.proveFreshRuneStage(dir,'start',deps)).rejects.toThrow('cleanup failed');
 expect(events.at(-1)).toBe('stop');expect(existsSync(join(dir,'stage-start.json'))).toBe(false);
 expect(existsSync(join(dir,'interrupted.sav'))).toBe(true);expect(existsSync(join(dir,'native.json'))).toBe(false);
 await expect(proof.proveFreshRuneStage(dir,'start',deps)).rejects.toThrow('retain existing identity');
}));

test('each continuation gets its own wall envelope and finite tick cap with logout/save/cleanup reserves',()=>{
 for(const stage of ['first-bank','target','higher'] as const){
  const r=proof.freshRuneStageWorker(stage,binding.name,810000,60000);
  expect(r.timeoutMs).toBe(690000);expect(Number(r.env.CAP)*150+30000).toBeLessThanOrEqual(r.timeoutMs);
  expect(r.timeoutMs+60000+90000+60000).toBeLessThanOrEqual(900000);
  expect(()=>proof.freshRuneStageWorker(stage,binding.name,810000,730000)).toThrow('logout reserve');
 }
 expect(proof.freshRuneChildTimeout('higher',810000,60000)).toBe(690000);
});

test('stale persisted XP or pack cannot satisfy a logged final worker snapshot',()=>{
 const p=scenario(),s=p.after;
 const log='RUNE_SUPPLY_RESULT '+JSON.stringify({final:{skills:s.skills.map(sk=>({experience:sk.rawExperience/10,level:sk.level})),inventory:[],equipment:[]}});
 expect(proof.freshRuneSavedResult(s,{code:0,log})).toBe(true);
 s.skills[20]!.rawExperience=100;expect(proof.freshRuneSavedResult(s,{code:0,log})).toBe(false);
 s.skills[20]!.rawExperience=0;s.inventories[93]=[{id:1436,count:26}];expect(proof.freshRuneSavedResult(s,{code:0,log})).toBe(false);
});

function interruptedSnapshot(){
 const saved=save();
 for(const [index,rawExperience,level] of [[0,16000,13],[1,18000,14],[2,15000,13],[3,25725,18]])
  Object.assign(saved.skills[index!]!,{rawExperience,xp:Math.trunc(rawExperience!/10),level});
 saved.inventories[93]=[{id:2138,count:10},{id:1265,count:1}];
 saved.inventories[94]=[{id:1277,count:1},{id:1171,count:1}];
 const final={skills:saved.skills.map(s=>({experience:Math.trunc(s.rawExperience/10),level:s.level})),
  inventory:structuredClone(saved.inventories[93]),equipment:structuredClone(saved.inventories[94])};
 const run=()=>({code:1,log:'RUNE_SUPPLY_RESULT '+JSON.stringify({final})});
 return {saved,final,run};
}

test('saved fractional HP25725 matches wire XP2572 without changing raw XP',()=>{
 const {saved,final,run}=interruptedSnapshot(),before=structuredClone(saved);
 expect(final.skills[3]!.experience).toBe(2572);
 expect(proof.freshRuneSavedResult(saved,run())).toBe(true);
 expect(saved).toEqual(before);
 for(const xp of [2571,2573,2572.5]){
  final.skills[3]!.experience=xp;
  expect(proof.freshRuneSavedResult(saved,run())).toBe(false);
 }
});

test('wire projection still refuses adjacent saved XP, stale progress and current levels',()=>{
 for(const raw of [25719,25730]){
  const {saved,run}=interruptedSnapshot();saved.skills[3]!.rawExperience=raw;
  expect(proof.freshRuneSavedResult(saved,run())).toBe(false);
 }
 const {saved,run}=interruptedSnapshot();
 expect(proof.freshRuneSavedResult(save(),run())).toBe(false);
 for(const index of [0,3]){
  const changed=structuredClone(saved);changed.skills[index]!.level--;
  expect(proof.freshRuneSavedResult(changed,run())).toBe(false);
 }
});

test('wire XP match still requires exact pack and equipment quantities and IDs',()=>{
 for(const container of [93,94])for(const change of ['quantity','id','missing','extra']){
  const {saved,run}=interruptedSnapshot(),logged=run();
  const items=saved.inventories[container]!;
  if(change==='quantity')items[0]!.count++;
  if(change==='id')items[0]!.id=995;
  if(change==='missing')items.pop();
  if(change==='extra')items.push({id:995,count:1});
  expect(proof.freshRuneSavedResult(saved,logged)).toBe(false);
 }
});


test('post-craft proof requires exact new output, immediate portal action, arrival and saved logout',()=>{
 const before=save();before.position={x:2843,z:4832,level:0};before.vars={63:6,101:1,281:1000};
 Object.assign(before.skills[20]!,{level:20,xp:3250,rawExperience:32500});
 before.inventories={93:[{id:1436,count:1},{id:556,count:26},{id:1438,count:1},{id:315,count:1}],94:[{id:1265,count:1},{id:1171,count:1}],95:[{id:556,count:25},{id:995,count:25}]};
 const after=structuredClone(before);after.position={x:3253,z:3420,level:0};
 after.skills[20]!.rawExperience+=1250;after.skills[20]!.xp+=125;
 after.inventories[93]=[];after.inventories[95]=[...before.inventories[95]!.filter(i=>i.id!==556),...before.inventories[93]!.filter(i=>![1436,556].includes(i.id)),{id:556,count:53}];
 const action={action:'craft-air',phase:'end',tick:6,essence:0,air:28,runecraftXp:3375};
 const line=(prefix:string,o:any)=>prefix+' '+JSON.stringify(o);
 const events=[line('RUNE_SUPPLY_ACTION',action),line('AIR_EXIT',{phase:'selected',tick:6,position:{animId:791,spotanimId:186}}),
  line('AIR_EXIT',{phase:'path',reply:{path:{success:true,reachedDestination:true}}}),
  line('AIR_EXIT',{phase:'approached',position:{worldX:2841,worldZ:4829,level:0},reply:{success:true}}),
  line('AIR_EXIT',{phase:'dispatch',portal:{id:2465,x:2841,z:4828},tick:9}),line('AIR_EXIT',{phase:'action',reply:{success:true}}),
  line('AIR_EXIT',{phase:'outside',position:{worldX:2983,worldZ:3288,level:0},tick:10})];
 const result={ok:true,target:20,inheritedBanked:26,banked:28,newBanked:2,crafted:2,consumed:1,mined:0,travelFoodEaten:0,
  stages:{resumedCraft:{ok:true,consumed:1,runes:2,xp:125}},final:{skills:after.skills.map(sk=>({experience:sk.xp,level:sk.level})),inventory:after.inventories[93],equipment:after.inventories[94]}};
 const run=(e=events,r=result,s=after)=>({code:0,log:[...e,line('RUNE_SUPPLY_RESULT',{...r,final:{...r.final,skills:s.skills.map(sk=>({experience:sk.xp,level:sk.level}))}}),'LOGOUT logged-out'].join('\n')});
 expect(Object.values(proof.freshRunePostCraftChecks(before,after,run())).every(Boolean)).toBe(true);
 for(const phase of ['selected','approached','dispatch','action','outside']){
  const reduced=events.filter(l=>!l.includes('"phase":"'+phase+'"'));
  expect(Object.values(proof.freshRunePostCraftChecks(before,after,run(reduced))).every(Boolean)).toBe(false);
 }
 expect(proof.freshRunePostCraftChecks(before,after,run(events,{...result,crafted:0})).production).toBe(false);
 const idle=events.map(l=>l.includes('"phase":"selected"')?line('AIR_EXIT',{phase:'selected',tick:30}):l);
 expect(proof.freshRunePostCraftChecks(before,after,run(idle)).craftThenExit).toBe(false);
 const lost=structuredClone(after);lost.skills[3]!.rawExperience--;
 expect(proof.freshRunePostCraftChecks(before,lost,run(events,result,lost)).otherSkills).toBe(false);
 expect(proof.freshRunePostCraftChecks(before,after,{...run(),log:run().log.replace('LOGOUT logged-out','')}).logout).toBe(false);
 const badBank=structuredClone(after);badBank.inventories[95]!.find(i=>i.id===556)!.count--;
 expect(proof.freshRunePostCraftChecks(before,badBank,run()).banked).toBe(false);
});
