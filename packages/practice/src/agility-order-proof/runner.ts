import {closeSync,copyFileSync,existsSync,mkdirSync,openSync,readFileSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {freemem} from 'node:os';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {FREE_FLOOR_GB} from '../../../core/src/memory';
import {readPracticeSave,waitPracticeSave} from '../fleet-player-save';
import {PRESETS,type SaveConfig} from '../presets';
import {startStack} from '../stack';
import {
 ARDOUGNE_CONFIGURATION,ARDOUGNE_ENTRY_CONFIGURATION,ARDOUGNE_PLAN,type Case,type Child,DRAYNOR_START,
 FALL_SAMPLE_PLAN,type FallSample,FOOD_RECOVERY_CONFIGURATION,foodBinding,GNOME_CONSUMER_CONFIGURATION,
 GNOME_CONSUMER_PLAN,GNOME_FOOD_CONFIGURATION,GNOME_FOOD_PLAN,GNOME_FOOD_RESTART_CONFIGURATION,GNOME_SCOPE,
 INFLIGHT_FOOD_CONFIGURATION,INITIALIZATION_CONFIGURATION,initializationBinding,interruptionDeadlineMs,type Mode,
 NATIVE_FORMAT,refusalCases,repoRoot,restartBinding,type Save,SAVE_WAIT_MS,sha256,sources,
} from './contracts';
import {caseHashes,child,createAgilityFixture,foodChildBudget,runCourseApproach} from './fixtures';
import {
 foodRecoveryChecks,gnomeFoodChecks,inflightFoodChecks,inflightFoodOutcome,readInflightSample,
 verifyFoodRecovery,ardougneEntryChecks,
} from './food-checks';
import {
 agilitySaveChecks,agilitySaveDifferences,childChecks,draynorEntryChecks,fallSampleChecks,
 fallSampleOutcome,interruptionSaveChecks,readFallSamples,sampleFalls,
} from './save-checks';
import {
 verificationReport,verifyArdougneEntry,verifyGnomeConsumer,verifyGnomeFood,
} from './verify';

export async function run(directory:string,mode:Mode='full',retainedPath?:string){
 const started=performance.now();
 const gnomeMode=mode==='gnome-food'||mode==='ardougne'||mode==='gnome-consumer';
 if(mode==='food-recovery'||gnomeMode){directory=join(directory,mode);mkdirSync(directory,{recursive:true});}
 if(freemem()/2**30<FREE_FLOOR_GB)throw Error('insufficient free memory: below the floor');
 const lock=join(repoRoot,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');
 writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:mode==='full'?'agility-order':`agility-order-${mode}`}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  const source=sources(),results:any[]=[],falls:FallSample[]=[];
  const tickMs=INITIALIZATION_CONFIGURATION.tickMs;
  stack=await startStack({tickMs,xpRate:GNOME_CONSUMER_CONFIGURATION.xpRate,readyTimeoutMs:60000});
  if(mode==='course-approach')return await runCourseApproach(directory,source,retainedPath);
  const fixture=(index:number,preset:SaveConfig,assets?:Pick<SaveConfig,'bank'|'equipment'>,recoveryHp?:number)=>
   createAgilityFixture(directory,mode,source,started,index,preset,assets,recoveryHp);
  if(mode==='food-recovery'){
   const C=FOOD_RECOVERY_CONFIGURATION;
   const f=await fixture(C.fixture,{position:C.position,skills:{Hitpoints:C.baseHp},
    inventory:Array.from({length:C.foodCount},()=>({id:C.foodId,count:1}))},undefined,C.currentHp);
   copyFileSync(f.path,join(directory,'food-before.sav'));
   const before=readPracticeSave(f.path),stamp=statSync(f.path).mtimeMs;
   const record:any={at:Date.now(),name:f.name,source,configuration:C};
   try{
    record.child=await child(directory,'food',f.name,C.course,C.target,false,foodChildBudget(started));
    const saved=await waitPracticeSave(f.path,s=>statSync(f.path).mtimeMs>stamp
     &&Object.values(foodRecoveryChecks(before,s,readFileSync(join(directory,'food.log'),'utf8'),record.child,f.name)).every(Boolean),{timeoutMs:SAVE_WAIT_MS});
    record.saveMatched=saved.matched;
   }catch(error){record.error=String(error);}finally{
    copyFileSync(f.path,join(directory,'food-after.sav'));
    const initial=JSON.parse(readFileSync(join(directory,'initial-10.json'),'utf8'));
    const hashes={before:sha256(readFileSync(join(directory,'food-before.sav'))),after:sha256(readFileSync(join(directory,'food-after.sav'))),
     log:sha256(existsSync(join(directory,'food.log'))?readFileSync(join(directory,'food.log')):'')};
    record.binding=foodBinding(f.name,source,record.child,hashes,initial.binding);
    record.differences=agilitySaveDifferences(before,readPracticeSave(join(directory,'food-after.sav')));
    writeFileSync(join(directory,'food-recovery.json'),JSON.stringify(record,null,2));
   }
   // Stop at the first failure: the in-flight case runs only after the consecutive-heal case passes.
   const heals:Record<string,boolean>=record.child?foodRecoveryChecks(before,readPracticeSave(join(directory,'food-after.sav')),
    existsSync(join(directory,'food.log'))?readFileSync(join(directory,'food.log'),'utf8'):'',record.child,f.name):{child:false};
   const I=INFLIGHT_FOOD_CONFIGURATION,inflight:any={configuration:I,source,samples:[]};
   if(record.saveMatched===true&&!record.error&&Object.values(heals).every(Boolean))try{
    for(const [k,index] of I.fixtures.entries()){
     const remaining=C.deadlineMs-(performance.now()-started)-C.cleanupReserveMs;
     if(remaining<I.sampleMinMs)throw Error(`in-flight food sample ${k+1} not admitted: food recovery envelope exhausted`);
     const label=`inflight-${k+1}`,sample:any={index:k+1,fixture:index,label,outcome:'failed'};inflight.samples.push(sample);
     const g=await fixture(index,{...PRESETS.agility_wilderness_52!,position:I.position},undefined,I.currentHp);sample.name=g.name;
     copyFileSync(g.path,join(directory,label+'-before.sav'));
     const start=readPracticeSave(g.path),mtime=statSync(g.path).mtimeMs,logPath=join(directory,label+'.log');
     try{
      sample.child=await child(directory,label,g.name,I.course,I.target,false,foodChildBudget(started));
      const saved=await waitPracticeSave(g.path,s=>statSync(g.path).mtimeMs>mtime
       &&inflightFoodOutcome(inflightFoodChecks(start,s,readFileSync(logPath,'utf8'),sample.child,g.name),start,s,readFileSync(logPath,'utf8'))!=='failed',{timeoutMs:SAVE_WAIT_MS});
      sample.saveMatched=saved.matched;
     }catch(error){sample.error=String(error);}finally{
      copyFileSync(g.path,join(directory,label+'-after.sav'));
      try{
       const files=readInflightSample(directory,label,index);
       sample.sha256=files.sha256;sample.initialization=files.initial.binding;sample.at=Date.now();
       sample.checks=sample.child?inflightFoodChecks(files.before,files.after,files.log,sample.child,g.name):{child:false};
       sample.outcome=sample.error||sample.saveMatched!==true?'failed':inflightFoodOutcome(sample.checks,files.before,files.after,files.log);
       sample.differences=agilitySaveDifferences(files.before,files.after);
      }catch(error){sample.captureError=String(error);sample.outcome='failed';}
      writeFileSync(join(directory,'inflight.json'),JSON.stringify(inflight,null,2));
      console.log('AGILITY_INFLIGHT_SAMPLE '+JSON.stringify({index:sample.index,name:g.name,outcome:sample.outcome,checks:sample.checks}));
     }
     if(sample.outcome!=='zero-fall')break;
    }
    if(inflight.samples.at(-1)?.outcome!=='proved')throw Error('missing boundary: health becoming due during active stones crossing with animation741 and exactmove feedback');
   }catch(error){inflight.error=String(error);}finally{writeFileSync(join(directory,'inflight.json'),JSON.stringify(inflight,null,2));}
   else{inflight.error='skipped: consecutive-heal case failed';writeFileSync(join(directory,'inflight.json'),JSON.stringify(inflight,null,2));}
   const checks=verifyFoodRecovery(directory,source,false);
   const report={ok:Object.values(checks).every(Boolean),at:Date.now(),name:f.name,source,configuration:C,binding:record.binding,
    scope:'Labelled depleted-HP recovery and labelled in-flight Wilderness food settlement through installed CLI. Not default entry, historical dispatch reconstruction, or live qualification.',checks};
   report.ok=report.ok&&record.saveMatched===true&&!record.error&&!inflight.error;
   writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
  }
  // A fall sample passes its own retained record and file label.
  // A Gnome case may supply its own recomputed save predicate (food, Femi varp) and child budget.
  type Judge=(before:Save,after:Save,log:string,child:Child)=>Record<string,boolean>;
  const scenario=async(id:Case,f:{name:string;path:string},course:string,target:number,sample?:FallSample,
   opts:{judge?:Judge;budget?:{entryTicks?:number;maxTicks?:number;timeoutMs?:number}}={})=>{
   const label=sample?.label??id;
   copyFileSync(f.path,join(directory,label+'-before.sav'));const before=readPracticeSave(f.path),stamp=statSync(f.path).mtimeMs;
   // Record the attempted case before a failed recovery can abort the batch.
   const record:any=sample?Object.assign(sample,{id,name:f.name,target}):{id,label,course,name:f.name,target};if(!sample)results.push(record);
   let interrupted:Child|undefined;
   if(id==='restart'){
    const engineStart=readFileSync(stack!.logs.engine,'utf8').length;
    interrupted=await child(directory,'interrupted',f.name,course,target,true);
    record.interrupted=interrupted;
    copyFileSync(f.path,join(directory,'interrupted-at-kill.sav'));
    const log=readFileSync(join(directory,'interrupted.log'),'utf8'),startedAt=Date.now();
    const engineLog=()=>readFileSync(stack!.logs.engine,'utf8').slice(engineStart).split(/\r?\n/)
     .filter(l=>l.startsWith('[LOGOUT DEBUG]')&&l.includes(`for ${f.name}`)).join('\n');
    try{
     const saved=await waitPracticeSave(f.path,s=>statSync(f.path).mtimeMs>stamp
      &&Object.values(interruptionSaveChecks(before,s,target,log,engineLog(),f.name)).every(Boolean),{timeoutMs:interruptionDeadlineMs(tickMs)});
     record.interruption={matched:saved.matched,elapsedMs:Date.now()-startedAt,reads:saved.reads,lastError:saved.lastError,
      checks:interruptionSaveChecks(before,saved.save,target,log,engineLog(),f.name),differences:agilitySaveDifferences(before,saved.save)};
     if(!saved.matched)throw Error('interruption recovery unobserved: '+JSON.stringify(record.interruption.checks));
     if(!interrupted.interrupted||interrupted.timedOut||interrupted.code===0)throw Error('abrupt child termination unobserved');
    }finally{
     // Preserve bytes and server evidence even if the deadline/predicate fails.
     copyFileSync(f.path,join(directory,'interrupted.sav'));
     writeFileSync(join(directory,'interrupted-engine.log'),engineLog());
     writeFileSync(join(directory,'interruption.json'),JSON.stringify(record,null,2));
    }
   }
   if(id==='restart'){
    // Read the actual engine file, never restore the retained checkpoint. This
    // copy is the last operation on the save before the restarted CLI launch.
    copyFileSync(f.path,join(directory,'restart-prelaunch.sav'));
    readPracticeSave(join(directory,'restart-prelaunch.sav'));
    if(!readFileSync(f.path).equals(readFileSync(join(directory,'interrupted.sav'))))throw Error('restart checkpoint changed before launch');
    record.restartBinding=restartBinding(directory,f.name,target,source,interrupted!);
    writeFileSync(join(directory,'interruption.json'),JSON.stringify(record,null,2));
    record.interruptionSha256=sha256(readFileSync(join(directory,'interruption.json')));
   }
   const result=await child(directory,label,f.name,course,target,false,opts.budget);record.child=result;
   const caseMode=refusalCases.has(id)?'refusal':'progress';
   const judge=(s:Save)=>opts.judge?opts.judge(before,s,readFileSync(join(directory,label+'.log'),'utf8'),result):agilitySaveChecks(before,s,target,caseMode);
   const saved=await waitPracticeSave(f.path,s=>statSync(f.path).mtimeMs>stamp&&Object.values(judge(s)).every(Boolean),{timeoutMs:SAVE_WAIT_MS});
   copyFileSync(f.path,join(directory,label+'-after.sav'));
   const saveChecks=judge(saved.save),differences=agilitySaveDifferences(before,saved.save);
   Object.assign(record,{child:result,interrupted,saveMatched:saved.matched,saveChecks,differences});
   console.log('AGILITY_SAVE_CHECK '+JSON.stringify({id:label,checks:saveChecks,differences}));
   // Keep failed bytes, logs and metadata. Stop dependent work at this boundary.
   if(!saved.matched||!Object.values(childChecks(result,readFileSync(join(directory,label+'.log'),'utf8'),caseMode)).every(Boolean))throw Error(`native scenario failed: ${label}`);
  };
  // Judge the sample from its retained bytes and log, the same way --verify does.
  const fallSample=async(sample:FallSample)=>{
   if(freemem()/2**30<FREE_FLOOR_GB)throw Error('practice memory floor reached before fall sample');
   const f=await fixture(sample.fixture,PRESETS.agility_wilderness_52!);sample.name=f.name;
   await scenario('fall',f,FALL_SAMPLE_PLAN.course,FALL_SAMPLE_PLAN.target,sample);
   const files=readFallSamples(directory).read(sample.label);
   if(!files)throw Error(`fall sample ${sample.index} evidence unreadable`);
   sample.at=Date.now();sample.sha256=files.sha256;
   sample.initialization=files.initial.binding;
   if(files.initialFiles!.sha256.after!==files.sha256.before
    ||!isDeepStrictEqual(files.initial.binding,initializationBinding(f.name,sample.fixture,source,files.initialFiles!.sha256)))
    throw Error(`fall sample ${sample.index} initialization evidence failed`);
   sample.checks=fallSampleChecks(files.before,files.after,files.log,sample.child!,f.name);
   sample.outcome=fallSampleOutcome(sample.checks,files.before,files.after,files.log);
   console.log('AGILITY_FALL_SAMPLE '+JSON.stringify({index:sample.index,name:f.name,outcome:sample.outcome,checks:sample.checks}));
  };
  if(gnomeMode){
   // Bind every attempted case to its raw files and initialization, even after a failure.
   const bind=(r:any,fixtureIndex:number|null)=>{
    try{r.fixture=fixtureIndex;r.sha256=caseHashes(directory,r.label);r.at=Date.now();
     r.initialization=fixtureIndex===null?null:JSON.parse(readFileSync(join(directory,`initial-${fixtureIndex}.json`),'utf8')).binding;
     if(r.label==='restart')r.middleSha256=sha256(readFileSync(join(directory,'interrupted.sav')));
    }catch(e){r.captureError=String(e);}
   };
   const [plan,file,configuration,verifyMode]=mode==='gnome-food'?[GNOME_FOOD_PLAN,'gnome-food.json',GNOME_FOOD_CONFIGURATION,verifyGnomeFood] as const
    :mode==='ardougne'?[ARDOUGNE_PLAN,'ardougne.json',ARDOUGNE_CONFIGURATION,verifyArdougneEntry] as const
    :[GNOME_CONSUMER_PLAN,'gnome-consumer.json',GNOME_CONSUMER_CONFIGURATION,verifyGnomeConsumer] as const;
   const meta:any={format:configuration.format,source,configuration,cases:results};
   try{
    if(mode==='gnome-food')for(const C of [FOOD_RECOVERY_CONFIGURATION,GNOME_FOOD_RESTART_CONFIGURATION]){
     const label=C===FOOD_RECOVERY_CONFIGURATION?'food':'food-restart';
     const f=await fixture(C.fixture,{position:C.position,skills:{Hitpoints:C.baseHp},inventory:Array.from({length:C.foodCount},()=>({id:C.foodId,count:1}))},undefined,C.currentHp);
     await scenario(label,f,C.course,C.target,undefined,{judge:(b,s,log,c)=>gnomeFoodChecks(b,s,log,c,f.name,C),budget:foodChildBudget(started)});
    }
    if(mode==='ardougne'){
     const A=ARDOUGNE_ENTRY_CONFIGURATION;
     const f=await fixture(A.fixture,{position:A.position,skills:A.skills,inventory:Array.from({length:A.foodCount},()=>({id:A.foodId,count:1}))},
      {bank:A.bank.map(i=>({...i})),equipment:[]},A.currentHp);
     await scenario('ardougne-entry',f,A.course,A.target,undefined,{judge:(b,s,log,c)=>ardougneEntryChecks(b,s,log,c,f.name),budget:A.budget});
    }
    if(mode==='gnome-consumer'){
     let approach:{name:string;path:string}|undefined;
     for(const p of GNOME_CONSUMER_PLAN){
      const f=p.fixture===null?approach!:await fixture(p.fixture,{...(p.course==='wilderness'?PRESETS.agility_wilderness_49!:PRESETS.agility_gnome_1!),position:p.start!});
      if(p.label==='approach')approach=f;
      await scenario(p.label as Case,f,p.course,p.target);
     }
    }
   }catch(error){meta.error=String(error);}finally{
    for(const r of results)if(!r.sha256)bind(r,plan.find(p=>p.label===r.label)?.fixture??null);
    meta.at=Date.now();writeFileSync(join(directory,file),JSON.stringify(meta,null,2));
   }
   const checks=verifyMode(directory,source,Date.now(),false).checks;
   const report={ok:Object.values(checks).every(Boolean),at:Date.now(),scope:GNOME_SCOPE,source,checks};
   writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,scope:report.scope,checks}));return report;
  }
  if(mode==='draynor'){
   // Moneyshot-shaped start: default skills (10 HP, combat 3), 440 carried coins, banked cash and
   // logs, no food, Draynor bank. Nothing near the course, no quests, no travel unlocks.
   const id='draynor-entry',target=10;
   const f=await fixture(6,{position:DRAYNOR_START,coins:440},{bank:[{id:995,count:15606},{id:1511,count:13}],equipment:[]});
   copyFileSync(f.path,join(directory,id+'-before.sav'));
   const before=readPracticeSave(f.path),stamp=statSync(f.path).mtimeMs,record:any={id,name:f.name,target};
   const log=()=>existsSync(join(directory,id+'.log'))?readFileSync(join(directory,id+'.log'),'utf8'):'';
   try{
    record.child=await child(directory,id,f.name,'gnome',target,false,{entryTicks:1300,maxTicks:1500,timeoutMs:240000});
    const saved=await waitPracticeSave(f.path,s=>statSync(f.path).mtimeMs>stamp&&Object.values(draynorEntryChecks(before,s,target,log()).checks).every(Boolean),{timeoutMs:15000});
    record.saveMatched=saved.matched;
   }finally{
    // A failed entry keeps its exact saved bytes, raw differences and worker log.
    copyFileSync(f.path,join(directory,id+'-after.sav'));
    const after=readPracticeSave(f.path);
    Object.assign(record,draynorEntryChecks(before,after,target,log()),{differences:agilitySaveDifferences(before,after)});
    if(record.child)record.childChecks=childChecks(record.child,log(),'progress');
    // Evidence fields for --verify-gnome. The gate's checks and meaning are unchanged.
    try{Object.assign(record,{label:id,fixture:6,course:'gnome',at:Date.now(),sha256:caseHashes(directory,id),
     initialization:JSON.parse(readFileSync(join(directory,'initial-6.json'),'utf8')).binding});}catch(e){record.captureError=String(e);}
    writeFileSync(join(directory,'draynor.json'),JSON.stringify({at:Date.now(),source,case:record},null,2));
   }
   const checks:Record<string,boolean>={saveMatched:record.saveMatched===true,...record.checks,...record.childChecks};
   const report={ok:Object.values(checks).every(Boolean),at:Date.now(),scope:'Native fixture Draynor entry to Gnome Agility at 150ms. No live, record, speed or unattended claim. Does not replace the full native delivery.',receipt:record.receipt,checks};
   writeFileSync(join(directory,'draynor-consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
  }
  try{
   const approach=await fixture(1,{...PRESETS.agility_gnome_1!,position:{x:2460,z:3445,level:0}});
   await scenario('approach',approach,'gnome',10);
   const restart=await fixture(2,PRESETS.agility_gnome_1!);await scenario('restart',restart,'gnome',20);
   // A saved landing after a Wilderness fall; no teleport or fixture change after worker entry.
   const pit=await fixture(3,{...PRESETS.agility_wilderness_52!,position:{x:3005,z:10363,level:0},varps:{266:1}});
   await scenario('pit',pit,'wilderness',53);
   await scenario('rerun',approach,'gnome',10);
   const low=await fixture(4,{...PRESETS.agility_wilderness_49!,position:{x:2998,z:3916,level:0}});
   await scenario('wilderness-entry',low,'wilderness',60);
   // Last, so the envelope admission covers everything that remains. An ordinary course
   // start must actually fall and then earn further XP. A seeded pit cannot satisfy it.
   await sampleFalls(fallSample,()=>performance.now(),falls);
  }finally{writeFileSync(join(directory,'native.json'),JSON.stringify({format:NATIVE_FORMAT,at:Date.now(),source,cases:results,
   fall:{plan:FALL_SAMPLE_PLAN,samples:falls}},null,2));}
  const report=verificationReport(directory);
  writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
 }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
}
