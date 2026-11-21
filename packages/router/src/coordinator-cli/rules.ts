import {createHash} from 'node:crypto';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {loadOwners,mySide} from '../../../core/src/fleet';
import {evaluateProgressionWork,progressionProofs} from '../../../core/src/progression-session';
import {readLogoutProof} from '../../../core/src/session-lifecycle';
import {cachedReleaseFor} from '../../../core/src/worker-release';
import {liveHelperStatuses} from '../../../planner/src/supply-bill';
import {rangedEntry} from '../../../../scripts/ranged-train';
import {prayerBank} from '../../../../scripts/train-prayer';
import type {CoordTask,CoordinatorState} from '../coordinator';
import {applyObservationRequests,observationBudget,prepareObservationBand} from '../coordinator-observations';
import {evaluateCoordinatorProgression,type CoordinatorProgressionResult} from '../coordinator-progression';
import {applyRules,currentQualification,retarget,reviewApproved,skillUnlocks} from '../coordinator-rules';
import {atomicJson,coordinationDir,event,projectRoot,saveState} from '../coordinator-store';
import {freshScoreboard} from '../coverage';
import {deliveryFingerprint,deliveryTask} from '../delivery-cli';
import {ruleGoalValue} from '../goal-work';
import {loginAfter} from '../login-attempts';
import {coordinatorAccountPaused,readJson} from './holds';

// Rules (coordinator-rules.ts) run before any model round and whatever the planner's state. A fingerprint reads each
// candidate's import closure, so a pass runs on a new receipt or every RULE_RECHECK_MS, not every loop.
const RULE_RECHECK_MS=5*60*1000;
// The rule reads the fleet best from the scoreboard file; it rebuilds the scoreboard only when the file is older than this.
const RULE_BOARD_MAX_AGE_MS=60*60*1000;
type RulePass={at:number;receiptSequence:number};
let rulePass:RulePass={at:0,receiptSequence:-1};

export function rulePassDue(state:Pick<CoordinatorState,'latestReceiptSequence'>,previous:RulePass,now:number):boolean{
 return (state.latestReceiptSequence??0)!==previous.receiptSequence||now-previous.at>=RULE_RECHECK_MS;
}

let unlocks:((skill:string)=>number[])|undefined;
// A skipped chain is reported once per reason, not on every pass.
const ruleSkips=new Set<string>();

export function runRules(state:CoordinatorState,liveLimit:number){
 const now=Date.now();
 if(!rulePassDue(state,rulePass,now))return;
 rulePass={at:now,receiptSequence:state.latestReceiptSequence??0};
 try{
  let board:any;try{board=freshScoreboard(projectRoot,RULE_BOARD_MAX_AGE_MS);}catch{board=null;}
  const fleetSkills:any[]|undefined=Array.isArray(board?.fleetSkills)?board.fleetSkills:undefined;
  const goalStatuses=liveHelperStatuses(projectRoot),entryOf=(capability:string)=>{try{return deliveryTask(capability).entry;}catch{return undefined;}};
  const definitions=readdirSync(join(projectRoot,'packages/router/tasks')).filter(name=>name.endsWith('.json')).flatMap(name=>{try{return[deliveryTask(name.slice(0,-5))];}catch(error){event('progression-definition-unavailable',{file:name,reason:String(error)});return[];}});
  const proofs=progressionProofs(projectRoot),progressionRows:unknown[]=[];
  const observedSources=new Map<string,string>();
  const observedSource=(id:string)=>{let source=observedSources.get(id);if(!source){source=deliveryFingerprint(deliveryTask(id));observedSources.set(id,source);}return source;};
  const progression=(task:CoordTask,account:string):CoordinatorProgressionResult=>{
    const entry=entryOf(task.capability!);if(!entry)return{action:'measure',intent:null,step:null,capability:null,decision:null,stepAccept:null,consumer:task.accept??null,requests:[],reason:'Existing capability entry is unavailable.'};
    const status=goalStatuses.find((row:any)=>row.name?.toLowerCase()===account.toLowerCase())??null;
    const work={script:entry,args:task.args??[],env:task.env??{}};
    const shared=evaluateProgressionWork(work,status,{accept:task.accept,now,base:projectRoot,requireQualification:false});
    const result=evaluateCoordinatorProgression({task,entry,status,now,observed:shared.account,methods:()=>shared.methods??[],
     bindingFor:method=>{
      const proof=proofs[method.id];if(!proof)return null;
      let source:string;try{source=cachedReleaseFor([method.step.script],projectRoot);}catch{return null;}
      if(proof.source!==source||method.source!==source)return null;
      const matches=definitions.filter(d=>d.entry===method.step.script).sort((a,b)=>Number(b.id===task.capability)-Number(a.id===task.capability)||a.id.localeCompare(b.id));
      for(const definition of matches){const fingerprint=observedSource(definition.id);if(reviewApproved(state,definition.id)&&currentQualification(state,definition.id,fingerprint))return{capability:definition.id,methodId:method.id,source,qualification:{source,bands:proof.bands},reviewed:true};}
      return null;
     }});
    progressionRows.push({account,task:task.id,statusAt:status?.at??null,bankAt:status?.bankAt??null,consumer:result.consumer,action:result.action,reason:result.reason,
     method:result.decision?.selected??null,stateFingerprint:result.decision?.stateFingerprint??null,requests:result.requests});
    return result;
   };
  const side=board?.fleet?.side??mySide(),owners=loadOwners();
  const workStatus=(account:string)=>goalStatuses.find((s:any)=>s.name?.toLowerCase()===account.toLowerCase());
  const budget=(task:CoordTask)=>observationBudget(task,entryOf(task.capability!)!);
  const finiteBand=(task:CoordTask,account:string)=>prepareObservationBand(task,workStatus(account),entryOf(task.capability!)!,trial=>progression(trial,account),()=>cachedReleaseFor([entryOf(task.capability!)!],projectRoot));
  let observationRequests:any[]=[];
  try{const saved=readJson(join(projectRoot,'.practice/progression-system',`fleet-${side}.json`));if(saved.version===1&&saved.side===side&&Number.isFinite(saved.at)&&saved.at>0&&saved.at<=now&&now-saved.at<=900000&&Array.isArray(saved.requests))observationRequests=saved.requests;}catch{/* No request is authority to invent a finite consumer. */}
  const observations=board?.goals?applyObservationRequests(state,observationRequests,{now,side,goals:board.goals,statuses:goalStatuses,
   allowed:account=>owners.get(account.toLowerCase())?.side===side&&owners.get(account.toLowerCase())?.server==='rs-sdk-demo.fly.dev'&&['confirmed','none'].includes(readLogoutProof(account,'rs-sdk-demo.fly.dev',{root:join(projectRoot,'.practice/session-lifecycle')}).state),
   paused:account=>coordinatorAccountPaused(account),
   definition:id=>{const def=deliveryTask(id);return{id:def.id,entry:def.entry,source:observedSource(id)};},
   loginAfter:loginAfter(projectRoot),
   capabilityFor:entry=>entry==='scripts/ranged-train.ts'?definitions.filter(d=>d.entry===entry&&reviewApproved(state,d.id)).sort((a,b)=>Number(!!currentQualification(state,b.id,observedSource(b.id)))-Number(!!currentQualification(state,a.id,observedSource(a.id)))||a.id.localeCompare(b.id))[0]?.id??null:null,
   prepare:finiteBand,
   needsEntryObservation:(task,_account,status)=>{
    if(entryOf(task.capability!)!=='scripts/ranged-train.ts'||!status?.pos||status.pos.level!==0)return false;
    let nearby=false;for(const locate of [prayerBank,rangedEntry])try{const bank=locate({worldX:status.pos.x,worldZ:status.pos.z,level:status.pos.level});if(bank&&Math.max(Math.abs(bank.x-status.pos.x),Math.abs(bank.z-status.pos.z))<=3)nearby=true;}catch{/* Unsupported entry never implies a bank journey. */}
    if(!nearby)return false;
    return status.equipmentObserved!==true||!Number.isFinite(status.bankAt)||status.bankAt<status.started||now-status.bankAt>=300000;
   },
   qualificationFor:(task,account,status)=>{
    if(entryOf(task.capability!)!=='scripts/ranged-train.ts')return null;
    let bytes:Buffer,raw:any;try{bytes=readFileSync(join(projectRoot,'.practice/status',account+'.json'));raw=JSON.parse(bytes.toString());}catch{return null;}
    const proof=readLogoutProof(account,'rs-sdk-demo.fly.dev',{root:join(projectRoot,'.practice/session-lifecycle')});
    if(raw.at!==status.at||raw.name?.toLowerCase()!==account.toLowerCase()||raw.equipmentObserved!==true||!Number.isFinite(raw.bankAt)||raw.bankAt<raw.started||now-raw.bankAt>=300000||proof.state!=='confirmed'||proof.attemptId!==raw.sessionAttemptId)return null;
    const [skill,target]=Object.entries(task.accept?.skills??{})[0]??[],level=raw.skills?.find((s:any)=>s.name?.toLowerCase()===skill?.toLowerCase())?.level;if(!skill||!Number.isSafeInteger(level)||!Number.isSafeInteger(target)||target!<=level)return null;
    let next=level+1;
    for(let candidate=Math.min(target!,level+5);candidate>level;candidate--){const moved=retarget(task,skill,target!,candidate);if(!moved)continue;const priced=evaluateProgressionWork({script:entryOf(task.capability!)!,args:moved.args??[],env:moved.env??{}},raw,{accept:moved.accept,now,base:projectRoot,requireQualification:false}).decision?.expectedTicks;if(priced!=null&&priced<=budget(task)){next=candidate;break;}}
    const source=observedSource(task.capability!),hash=createHash('sha256').update(bytes).digest('hex');
    return{id:'qualify-progression-'+task.capability+'-'+createHash('sha256').update(JSON.stringify([source,account,hash,next])).digest('hex').slice(0,20),kind:'qualify',goal:task.goal,capability:task.capability,account,dependsOn:[...task.dependsOn],priority:Math.min(100,task.priority+1),estimatedMs:600000,timeoutMs:1200000,
     env:{PROGRESSION_ACCOUNT:account,PROGRESSION_TARGET_LEVEL:String(next),PROGRESSION_ENTRY_AT:String(raw.at),PROGRESSION_ENTRY_SHA256:hash,PROGRESSION_CONSUMER:JSON.stringify(task.accept)},
     why:'Qualify the next bounded owned state band before '+task.id+'. Preserve its original finite consumer and all source, actual equipment, bank and logout checks.'};
   }}):{added:[],linked:[],prepared:[],invalidated:[]};
  const added=applyRules(state,{fingerprint:cap=>deliveryFingerprint(deliveryTask(cap)),unlocks:unlocks??=skillUnlocks(projectRoot),maxOpen:liveLimit,progression,
   goalValue:board?.goals?(task,prerequisites=[])=>ruleGoalValue({...state,tasks:[...state.tasks,...prerequisites.map(spec=>({spec,status:'pending' as const,createdAt:now,attempts:0}))]},board.goals,goalStatuses,now,{entryOf})(task):()=>({value:null,reason:'Owner goal observations unavailable'}),
   side:board?.fleet?.side??process.env.FLEET_SIDE??'local',
   fleetBest:skill=>fleetSkills?.find(r=>String(r.skill).toLowerCase()===skill.toLowerCase()),
   skipped:skip=>{const key=JSON.stringify(skip);if(!ruleSkips.has(key)){ruleSkips.add(key);event('rule-skipped',{rule:'next-band',...skip});}},
   paused:account=>coordinatorAccountPaused(account),
   level:(account,skill)=>goalStatuses.find((row:any)=>row.name?.toLowerCase()===account.toLowerCase())?.skills?.find((v:any)=>v.name?.toLowerCase()===skill.toLowerCase())?.level},now);
  atomicJson(join(coordinationDir,'progression-requests.json'),{at:now,rows:progressionRows});
  if(added.length||observations.added.length||observations.linked.length||observations.prepared.length||observations.invalidated.length){saveState(state);event('rule-tasks-added',{tasks:[...added,...observations.added].map(t=>({id:t.id,rule:t.rule,account:t.account,accept:t.accept})),observations:{linked:observations.linked,prepared:observations.prepared,invalidated:observations.invalidated}});}
 }catch(error){event('rule-pass-failed',String(error));}
}
