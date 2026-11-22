import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {readPracticeSave} from '../fleet-player-save';
import {
 ARDOUGNE_CONFIGURATION,ARDOUGNE_PLAN,cases,type CaseFiles,DRAYNOR_PLAN,FOOD_RECOVERY_CONFIGURATION,
 GNOME_CONSUMER_CONFIGURATION,GNOME_CONSUMER_PLAN,GNOME_FOOD_CONFIGURATION,GNOME_FOOD_PLAN,
 GNOME_FOOD_RESTART_CONFIGURATION,GNOME_FRESH_MS,GNOME_SCOPE,type GnomeCase,initializationBinding,
 INTERRUPTION_FILES,type ModeEvidence,NATIVE_FORMAT,readJson,repoRoot,restartBinding,restartInitialProjection,
 RETAINED_PLAN,type Save,savedLogoutOf,sha256,singleIdentity,sources,traceLines,trainedLevel,
} from './contracts';
import {
 ardougneEntryChecks,gnomeFoodChecks,gnomeScope,verifyFoodRecovery,
} from './food-checks';
import {
 agilitySaveChecks,childChecks,draynorEntryChecks,initializationEvidenceChecks,interruptionSaveChecks,
 readFallSamples,retainedApproachChecks,savedCoursePosition,verifyFallSamples,
} from './save-checks';

export function verificationReport(directory:string):{ok:boolean;at:number;scope:string;checks:Record<string,boolean>}{
 try{
  const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8')),currentSource=sources();
  const checks:Record<string,boolean>={source:JSON.stringify(meta.source)===JSON.stringify(currentSource),
   fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000,
   // Old single-fall metadata has no sample plan and cannot pass as a sample proof.
   format:meta.format===NATIVE_FORMAT,
   cases:JSON.stringify(meta.cases?.map((c:any)=>c.id))===JSON.stringify(cases)};
  const files=readFallSamples(directory);
  for(const [key,value] of Object.entries(verifyFoodRecovery(join(directory,'food-recovery'),currentSource)))checks[`food.${key}`]=value;
  Object.assign(checks,verifyFallSamples(meta.fall,meta.at,files.read,files.present,meta.source));
  for(const id of cases){
   const c=meta.cases?.find((c:any)=>c.id===id);if(!c?.child){checks[id]=false;continue;}
   const before=readPracticeSave(join(directory,`${id}-before.sav`)),after=readPracticeSave(join(directory,`${id}-after.sav`));
   const log=readFileSync(join(directory,`${id}.log`),'utf8'),mode=id==='rerun'||id==='wilderness-entry'?'refusal':'progress';
   for(const [key,value] of Object.entries({...agilitySaveChecks(before,after,c.target,mode),...childChecks(c.child,log,mode)}))checks[`${id}.${key}`]=value;
   if(mode==='progress')checks[`${id}.position`]=savedCoursePosition(after,id==='approach'||id==='restart'?'gnome':'wilderness');
   if(id==='approach')checks.away=before.position.x===2460&&before.position.z===3445;
   if(id==='pit')checks.pit=before.position.z===10363&&after.position.z<4000&&/AGILITY_RECOVERY pit/.test(log);
   if(id==='restart'){
    const interrupted=readFileSync(join(directory,'interrupted.log'),'utf8');
    const middle=readPracticeSave(join(directory,'interrupted.sav'));
    checks.interrupted=c.interrupted?.interrupted===true&&!c.interrupted?.timedOut&&c.interrupted?.code!==0;
    const engineLog=readFileSync(join(directory,'interrupted-engine.log'),'utf8');
    for(const [key,value] of Object.entries(interruptionSaveChecks(before,middle,c.target,interrupted,engineLog,c.name)))checks[`restart.${key}`]=value;
    checks.retainedProgress=middle.skills[16]!.rawExperience>before.skills[16]!.rawExperience&&after.skills[16]!.rawExperience>middle.skills[16]!.rawExperience;
   }
   if(id==='rerun')checks.rerun=/already at target/.test(log)&&!/AGILITY_PROGRESS/.test(log);
   if(id==='wilderness-entry')checks.entry=/wilderness requires entry level 52/.test(log)&&!/AGILITY_PROGRESS/.test(log);
  }
  const report={ok:Object.values(checks).every(Boolean),at:Date.now(),scope:'Native fixture Agility orders at 150ms/25x. No live, record, speed or unattended claim.',checks};
  return report;
 }catch{return{ok:false,at:Date.now(),scope:'Native fixture Agility orders at 150ms/25x. No live, record, speed or unattended claim.',checks:{files:false} as Record<string,boolean>};}
}

// Every verification path is read-only. Only run(), which owns generation, publishes reports.
export function verify(directory:string):{ok:boolean;at:number;scope:string;checks:Record<string,boolean>}{
 const report=verificationReport(directory);let matches=false;
 try{const saved=JSON.parse(readFileSync(join(directory,'consumer.json'),'utf8'));
  matches=saved.ok===report.ok&&saved.scope===report.scope&&isDeepStrictEqual(saved.checks,report.checks);
 }catch{}
 return{...report,ok:report.ok&&matches,checks:{...report.checks,report:matches}};
}

function readCase(directory:string,label:string):CaseFiles{
 const [b,a,l]=[`${label}-before.sav`,`${label}-after.sav`,`${label}.log`].map(f=>join(directory,f)) as [string,string,string];
 return{before:readPracticeSave(b),after:readPracticeSave(a),log:readFileSync(l,'utf8'),sha256:{before:sha256(readFileSync(b)),after:sha256(readFileSync(a)),log:sha256(readFileSync(l))}};
}

// One case: CRC-read raw files, recorded hashes, freshness, account identity, recomputed initialization and its
// after-save -> case before-save byte binding (or the named baseline), then the case's own recomputed predicates.
function caseEvidence(directory:string,r:any,p:GnomeCase,source:unknown,now:number,baseline:string|undefined,
 recompute:(f:CaseFiles,r:any)=>Record<string,boolean>){
 const c:Record<string,boolean>={};let f:CaseFiles|undefined;
 try{f=readCase(directory,p.label);}catch{}
 c.files=!!f;
 c.plan=!!r&&r.label===p.label&&r.fixture===p.fixture&&r.course===p.course&&r.target===p.target&&typeof r.name==='string'
  &&/^[a-z0-9]{1,12}$/i.test(r.name)&&(p.fixture===null||r.name.endsWith(String(p.fixture)));
 c.fresh=Number.isFinite(r?.at)&&r.at<=now&&now-r.at<GNOME_FRESH_MS;
 c.saved=r?.saveMatched===true&&!r?.error&&!r?.captureError;
 c.child=!!r?.child&&Number.isSafeInteger(r.child.code)&&typeof r.child.timedOut==='boolean'&&typeof r.child.interrupted==='boolean';
 if(!f||!c.plan||!c.child){c.recomputed=false;return{checks:c};}
 c.hashes=isDeepStrictEqual(r.sha256,f.sha256);
 c.identity=singleIdentity(f.log,r.name);
 if(p.fixture===null){c.initialization=r.initialization===null;c.baseline=!!baseline&&baseline===f.sha256.before;}
 else{
  let init=false,base=false;
  try{
   const meta=JSON.parse(readFileSync(join(directory,`initial-${p.fixture}.json`),'utf8'));
   const [ib,ia,il]=[`initial-${p.fixture}-before.sav`,`initial-${p.fixture}-after.sav`,`initial-${p.fixture}.log`].map(x=>join(directory,x)) as [string,string,string];
   const hashes={before:sha256(readFileSync(ib)),after:sha256(readFileSync(ia)),log:sha256(readFileSync(il))};
   const expected=initializationEvidenceChecks(readPracticeSave(ib),readPracticeSave(ia),readFileSync(il,'utf8'),meta.child,r.name);
   const binding=initializationBinding(r.name,p.fixture,source,hashes);
   init=meta.name===r.name&&meta.index===p.fixture&&!meta.error&&!meta.captureError&&Object.values(expected).every(Boolean)
    &&isDeepStrictEqual(meta.checks,expected)&&isDeepStrictEqual(meta.binding,binding)&&isDeepStrictEqual(r.initialization,binding);
   base=hashes.after===f.sha256.before;
  }catch{}
  c.initialization=init;c.baseline=base;
 }
 let recomputed:Record<string,boolean>={};try{recomputed=recompute(f,r);}catch{recomputed={recomputed:false};}
 return{checks:{...c,...recomputed},before:f.sha256.before,after:f.sha256.after};
}

function modeEvidence(directory:string,meta:any,plan:readonly GnomeCase[],source:unknown,now:number,
 recompute:(p:GnomeCase,f:CaseFiles,r:any)=>Record<string,boolean>,o:{expected?:{format:string;configuration:unknown};allowed?:string[];baseline?:(p:GnomeCase)=>string|undefined}={}):ModeEvidence{
 const checks:Record<string,boolean>={},list:any[]=Array.isArray(meta?.cases)?meta.cases:[],casesList:ModeEvidence['cases']=[];
 if(o.expected){checks.format=meta?.format===o.expected.format;checks.configuration=isDeepStrictEqual(meta?.configuration,o.expected.configuration);}
 checks.source=isDeepStrictEqual(meta?.source,source);
 checks.error=!!meta&&!meta.error;
 checks.cases=isDeepStrictEqual(list.map(c=>c?.label),plan.map(p=>p.label));
 if(o.allowed){
  // An unlisted retained case or initialization file is omitted evidence.
  const allowed=new Set([...o.allowed,...plan.flatMap(p=>[...['-before.sav','-after.sav','.log','.err'].map(s=>p.label+s),
   ...(p.fixture===null?[]:['-before.sav','-after.sav','.log','.err','.json'].map(s=>`initial-${p.fixture}${s}`))])]);
  let names:string[]|undefined;try{names=readdirSync(directory);}catch{}
  checks.omitted=!!names&&names.every(n=>allowed.has(n));
 }
 for(const p of plan){
  const r=list.find(c=>c?.label===p.label);
  const e=caseEvidence(directory,r,p,source,now,o.baseline?.(p),(f,rec)=>recompute(p,f,rec));
  for(const [k,v] of Object.entries(e.checks))checks[`${p.label}.${k}`]=v;
  casesList.push({label:p.label,name:r?.name,before:e.before,after:e.after});
 }
 return{checks,cases:casesList};
}

function publishedReport(directory:string,checks:Record<string,boolean>,source:unknown){
 try{const r=JSON.parse(readFileSync(join(directory,'consumer.json'),'utf8'));
  return r.ok===true&&r.scope===GNOME_SCOPE&&isDeepStrictEqual(r.source,source)&&isDeepStrictEqual(r.checks,checks);}catch{return false;}
}

const missing=(key:string):ModeEvidence=>({checks:{[key]:false},cases:[]});

export function verifyGnomeFood(directory:string,source:unknown,now:number,requireReport=true):ModeEvidence{
 const meta=readJson(join(directory,'gnome-food.json'));if(!meta)return missing('files');
 const r=modeEvidence(directory,meta,GNOME_FOOD_PLAN,source,now,(p,f,c)=>({
  ...gnomeFoodChecks(f.before,f.after,f.log,c.child,c.name,p.label==='food'?FOOD_RECOVERY_CONFIGURATION:GNOME_FOOD_RESTART_CONFIGURATION)}),
  {expected:{format:GNOME_FOOD_CONFIGURATION.format,configuration:GNOME_FOOD_CONFIGURATION},allowed:['gnome-food.json','consumer.json']});
 if(requireReport)r.checks.report=publishedReport(directory,r.checks,source);
 return r;
}

export function verifyArdougneEntry(directory:string,source:unknown,now:number,requireReport=true):ModeEvidence{
 const meta=readJson(join(directory,'ardougne.json'));if(!meta)return missing('files');
 const r=modeEvidence(directory,meta,ARDOUGNE_PLAN,source,now,(_p,f,c)=>ardougneEntryChecks(f.before,f.after,f.log,c.child,c.name),
  {expected:{format:ARDOUGNE_CONFIGURATION.format,configuration:ARDOUGNE_CONFIGURATION},allowed:['ardougne.json','consumer.json']});
 if(requireReport)r.checks.report=publishedReport(directory,r.checks,source);
 return r;
}

// Player.save checkpoints may precede the socket kill. World removal persists the
// last completed obstacle, including XP/position changes after the last client line.
// Gnome has no damage or item effects. No other raw skill/current level may change.
function gnomeCheckpoint(before:Save,after:Save,log:string,origin=before){
 const c=agilitySaveChecks(before,after,99),agi=after.skills[16]!;
 // This bounded kill is requested at the first progress line. Replay only
 // dispatched obstacles, including the final in-flight obstacle completing
 // after the socket dies. Never infer an arbitrary increase from later XP.
 const steps=['log','net','branch','rope','treedown','net2','pipe'];
 const ends=[[[2474,3429,0]],[[2473,3424,1],[2474,3424,1]],[[2473,3420,2]],[[2479,3420,2]],
  [[2487,3420,0]],[[2485,3428,0],[2486,3428,0],[2487,3428,0]],[[2484,3437,0],[2487,3437,0]]];
 type Point={raw:number;progress:number;at:string;step?:string};
 const point=(s:Save):Point=>({raw:s.skills[16]!.rawExperience,progress:s.vars[264]??0,at:`${s.position.x},${s.position.z},${s.position.level}`});
 const candidates:Point[]=[point(origin)];let raw=origin.skills[16]!.rawExperience,progress=origin.vars[264]??0,valid=true;
 for(const line of log.split(/\r?\n/)){
  if(line.startsWith('AGILITY_ACTION ')){
   const a=JSON.parse(line.slice('AGILITY_ACTION '.length)),index=steps.indexOf(a.step);
   if(a.xp!==Math.trunc(raw/10))continue;
   candidates.push({raw,progress,at:a.at});
   if(a.event!=='dispatch'||index<0)continue;
   const next=progress+1>=index+1?index+1:progress;
   const earned=([75,75,50,75,50,75,75][index]!+(next===7?390:0))*GNOME_CONSUMER_CONFIGURATION.xpRate;
   for(const p of ends[index]!)candidates.push({raw:raw+earned,progress:next===7?0:next,at:p.join(','),step:a.step});
  }else if(line.startsWith('AGILITY_PROGRESS ')){
   const m=/^AGILITY_PROGRESS level=\d+ xp=(\d+(?:\.\d+)?) tick=\d+ step=(\w+)$/.exec(line);
   const next=m&&candidates.find(p=>p.raw>raw&&Math.trunc(p.raw/10)===Number(m[1])&&p.step===m[2]);
   if(!next){valid=false;break;}raw=next.raw;progress=next.progress;
  }
 }
 const expected=point(after);
 return c.assets&&c.skills&&c.vars&&c.alive&&c.hpExperience&&isDeepStrictEqual(before.inventories,after.inventories)
  &&[265,266].every(id=>(before.vars[id]??0)===(after.vars[id]??0))
  &&before.skills.every((s,i)=>i===16||isDeepStrictEqual(s,after.skills[i]))
  &&agi.rawExperience>=before.skills[16]!.rawExperience&&agi.level===trainedLevel(agi.xp)
  &&valid&&candidates.some(p=>p.raw===expected.raw&&p.progress===expected.progress&&p.at===expected.at);
}

export function restartChainChecks(directory:string,before:Save,after:Save,log:string,r:any,source:unknown){
 const bytes=(p:string)=>readFileSync(join(directory,p)),save=(p:string)=>readPracticeSave(join(directory,p));
 const atKill=save('interrupted-at-kill.sav'),middle=save('interrupted.sav'),entry=save('restart-prelaunch.sav');
 const interrupted=bytes('interrupted.log').toString('utf8'),engine=bytes('interrupted-engine.log').toString('utf8');
 const record=readJson(join(directory,'interruption.json'));
 const binding=restartBinding(directory,r.name,r.target,source,r.interrupted);
 const observations=traceLines(log,'AGILITY_INITIAL '),initial=observations[0];
 const interruptedInitial=traceLines(interrupted,'AGILITY_INITIAL ');
 const firstAction=log.split(/\r?\n/).findIndex(l=>/^AGILITY_(?:ACTION|FOOD|ENTRY|PROGRESS|ORDER_RESULT) /.test(l));
 const initialIndex=log.split(/\r?\n/).findIndex(l=>l.startsWith('AGILITY_INITIAL '));
 const i=interruptionSaveChecks(before,middle,r.target,interrupted,engine,r.name);
 return {...Object.fromEntries(Object.entries(i).map(([k,v])=>[`interruption.${k}`,v])),
  interrupted:r.interrupted?.interrupted===true&&r.interrupted.timedOut===false&&Number.isSafeInteger(r.interrupted.code)&&r.interrupted.code!==0,
  interruptionRecord:!!record&&record.name===r.name&&record.target===r.target&&record.course==='gnome'
   &&isDeepStrictEqual(record.interrupted,r.interrupted)&&record.interruption?.matched===true
   &&isDeepStrictEqual(record.interruption?.checks,i),
  restartBinding:isDeepStrictEqual(record?.restartBinding,binding)&&isDeepStrictEqual(r.restartBinding,binding)
   &&r.interruptionSha256===sha256(bytes('interruption.json')),
  middleBinding:r.middleSha256===sha256(bytes('interrupted.sav')),
  interruptedIdentity:interruptedInitial.length===1&&interruptedInitial[0].name===r.name
   &&interruptedInitial[0].course==='gnome'&&interruptedInitial[0].target===r.target
   &&isDeepStrictEqual(interruptedInitial[0].state,restartInitialProjection(before)),
  killCheckpoint:gnomeCheckpoint(before,atKill,interrupted),
  removalCheckpoint:gnomeCheckpoint(atKill,middle,interrupted,before),
  prelaunch:bytes('interrupted.sav').equals(bytes('restart-prelaunch.sav')),
  initial:observations.length===1&&initial?.name===r.name&&initial.course==='gnome'&&initial.target===r.target
   &&Number.isSafeInteger(initial.tick)&&initial.tick>=0&&initialIndex>=0&&firstAction>initialIndex
   &&isDeepStrictEqual(initial.state,restartInitialProjection(entry)),
  retainedProgress:middle.skills[16]!.rawExperience>before.skills[16]!.rawExperience&&after.skills[16]!.rawExperience>middle.skills[16]!.rawExperience,
  noReseed:Object.values(agilitySaveChecks(entry,after,r.target)).every(Boolean)};
}

export function gnomeConsumerCaseChecks(p:GnomeCase,f:CaseFiles,r:any,directory:string,source?:unknown){
 const {before:b,after:a,log}=f,start=!p.start||isDeepStrictEqual(b.position,p.start)&&b.skills[16]?.level===p.agility&&trainedLevel(b.skills[16]!.xp)===p.agility;
 if(p.reason!==undefined)return{...agilitySaveChecks(b,a,p.target,'refusal'),...childChecks(r.child,log,'refusal'),start,
  reason:log.split(/\r?\n/).some(l=>l.replace(/\r$/,'')===`RESULT fail Error: ${p.reason}`)&&!/^AGILITY_PROGRESS /m.test(log),
  savedLogout:savedLogoutOf(b,a),scope:gnomeScope(log,'refusal')};
 const progress={...agilitySaveChecks(b,a,p.target),...childChecks(r.child,log,'progress'),start,position:savedCoursePosition(a,'gnome'),
  savedLogout:savedLogoutOf(b,a),scope:gnomeScope(log,'progress')};
 if(p.label!=='restart')return progress;
 // Abrupt kill after observed progress, server idle removal, saved useful progress, then the same saved
 // file (no reseed) continues to the higher finite target.
 return{...progress,...restartChainChecks(directory,b,a,log,r,source)};
}

export function verifyGnomeConsumer(directory:string,source:unknown,now:number,requireReport=true):ModeEvidence{
 const meta=readJson(join(directory,'gnome-consumer.json'));if(!meta)return missing('files');
 const r=modeEvidence(directory,meta,GNOME_CONSUMER_PLAN,source,now,(p,f,c)=>gnomeConsumerCaseChecks(p,f,c,directory,source),
  {expected:{format:GNOME_CONSUMER_CONFIGURATION.format,configuration:GNOME_CONSUMER_CONFIGURATION},allowed:['gnome-consumer.json','consumer.json',...INTERRUPTION_FILES],
   baseline:p=>{if(!p.baseline)return undefined;try{return sha256(readFileSync(join(directory,`${p.baseline}-after.sav`)));}catch{return undefined;}}});
 const gnome='vendor/rs-sdk/server/content/scripts/skill_agility/scripts/gnome_course.rs2';
 r.checks.gnomeContent=typeof (source as any)?.files?.[gnome]==='string'
  &&(source as any).files[gnome]===sha256(readFileSync(join(repoRoot,gnome)));
 if(requireReport)r.checks.report=publishedReport(directory,r.checks,source);
 return r;
}

// Existing Draynor gate evidence (delivery root): recomputed with the same Draynor predicates and bindings.
export function verifyDraynorEvidence(directory:string,source:unknown,now:number):ModeEvidence{
 const j=readJson(join(directory,'draynor.json'));if(!j)return missing('files');
 const r=modeEvidence(directory,{source:j.source,cases:[j.case]},DRAYNOR_PLAN,source,now,(_p,f,c)=>({...draynorEntryChecks(f.before,f.after,10,f.log).checks,
  ...childChecks(c.child,f.log,'progress'),savedLogout:savedLogoutOf(f.before,f.after),scope:gnomeScope(f.log,'progress')}));
 const rep=readJson(join(directory,'draynor-consumer.json'));
 r.checks.report=rep?.ok===true&&rep.checks?.saveMatched===true&&Object.keys(rep.checks).length>1
  &&Object.entries(rep.checks).every(([k,v])=>k==='saveMatched'||r.checks[`draynor-entry.${k}`]===v);
 return r;
}

// Existing retained eastern-entry gate: exact original bytes, no fixture initialization. The save comes from
// another server run, so its logout clock is not comparable; the child logout line is required instead.
export function verifyRetainedApproachEvidence(directory:string,source:unknown,now:number):ModeEvidence{
 const j=readJson(join(directory,'course-approach.json'));if(!j)return missing('files');
 const r=modeEvidence(directory,{source:j.source,cases:[j]},RETAINED_PLAN,source,now,
  (_p,f,c)=>({...retainedApproachChecks(f.before,f.after,10,f.log,c.child),scope:gnomeScope(f.log,'progress')}),
  {baseline:()=>{try{const h=sha256(readFileSync(String(j.original)));return h===j.originalSha256?h:undefined;}catch{return undefined;}}});
 r.checks.report=j.ok===true&&j.checks?.saveMatched===true&&j.checks?.originalPreserved===true
  &&Object.entries(j.checks).every(([k,v])=>k==='saveMatched'||k==='originalPreserved'||r.checks[`course-approach.${k}`]===v);
 return r;
}

// Read-only: reads every required raw file and published report; never writes, renames or deletes.
export function verifyGnome(directory:string,source:unknown=sources(),now=Date.now()){
 const checks:Record<string,boolean>={},all:{key:string;name:unknown;before?:string}[]=[];
 for(const [key,e] of [['gnome-food',verifyGnomeFood(join(directory,'gnome-food'),source,now)],
  ['course-approach',verifyRetainedApproachEvidence(directory,source,now)],['draynor',verifyDraynorEvidence(directory,source,now)],
  ['ardougne',verifyArdougneEntry(join(directory,'ardougne'),source,now)],['consumer',verifyGnomeConsumer(join(directory,'gnome-consumer'),source,now)]] as const){
  for(const [k,v] of Object.entries(e.checks))checks[`${key}.${k}`]=v;
  for(const c of e.cases)all.push({key:`${key}.${c.label}`,name:c.name,before:c.before});
 }
 // One account per scenario (the target refusal reuses the approach account) and no duplicated start bytes.
 const names=all.filter(c=>c.key!=='consumer.rerun').map(c=>c.name);
 checks.uniqueAccounts=names.every(n=>typeof n==='string')&&new Set(names).size===names.length
  &&all.find(c=>c.key==='consumer.rerun')?.name===all.find(c=>c.key==='consumer.approach')?.name;
 const starts=all.map(c=>c.before);
 checks.uniqueStarts=starts.every(s=>typeof s==='string')&&new Set(starts).size===starts.length;
 return{ok:Object.values(checks).every(Boolean),at:now,scope:GNOME_SCOPE,checks};
}
