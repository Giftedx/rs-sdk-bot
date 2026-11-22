import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runeSupplyPreserved} from '../../../../scripts/rune-supply';
import {workerSourceRevision} from '../../../core/src/worker-release';
import {readPracticeSave} from '../fleet-player-save';
import {
 airRecoveryPositions,assets,type Binding,checkpoints,freshRuneBinding,type FreshRuneStage,freshRuneStages,
 hash,json,logout,readRun,retainedProgress,type Run,same,sources,stageFile,type StageRecord,sum,summary,
} from './contracts';
import {
 freshRuneAirRecoveryChecks,freshRuneDefaultSkills,freshRunePostCraftChecks,freshRuneRecoveryContentsEqual,
 freshRuneSavedResult,freshRuneSupplyChecks,freshRuneSupportedInterruption,
} from './checks';

export function verifyFreshRuneAirRecovery(parent:string,deps={binding:freshRuneBinding}){
 const directory=join(parent,'air-recovery'),meta=json(join(directory,'native.json'));
 if(meta.at<=1793211592453||meta.fixtures?.length!==5||meta.source!==workerSourceRevision()||!same(meta.files,sources()))throw Error('missing fresh air recovery evidence');
 const checks:Record<string,boolean>={};
 for(const [i,fixture] of meta.fixtures.entries()){
  const dir=join(directory,String(i)),binding=deps.binding(fixture.binding.name,i===4?400:150);
  checks['binding'+i]=same(binding,fixture.binding);
  const labels=i>=3?['postcraft']:i===0?['refused','recovery','higher']:['exit'];
  const required=['fixture.json','before.sav','after.sav',...(i===0?['refused.sav','higher.sav']:[]),...labels.flatMap(l=>[l+'.log',l+'.err',l+'-outcome.json']),
   ...(i>=3?['postcraft-clock.json']:[(i===0?'refused':'exit')+'-session.json'])];
  checks['hashes'+i]=required.every(file=>fixture.hashes[file]===hash(join(dir,file)))
   &&Object.entries(fixture.hashes).every(([file,digest])=>hash(join(dir,file))===digest);
  checks['codes'+i]=same(Object.keys(fixture.codes).sort(),[...labels].sort());
  const before=readPracticeSave(join(dir,'before.sav')),after=readPracticeSave(join(dir,'after.sav'));
  checks['position'+i]=same(before.position,airRecoveryPositions[i>=3?0:i]!);
  checks['pacing'+i]=fixture.tickMs===(i===4?400:150);
  if(i===0){
   checks.noReseed=fixture.higherInputHash===hash(join(dir,'after.sav'));
   const run=readRun(dir,'recovery',fixture.codes.recovery),higher=readRun(dir,'higher',fixture.codes.higher);
   Object.assign(checks,Object.fromEntries(Object.entries(freshRuneAirRecoveryChecks(before,after,run,20)).map(([k,v])=>['recovery-'+k,v])));
   Object.assign(checks,Object.fromEntries(Object.entries(freshRuneAirRecoveryChecks(after,readPracticeSave(join(dir,'higher.sav')),higher,21)).map(([k,v])=>['higher-'+k,v])));
   const refused=readRun(dir,'refused',fixture.codes.refused),refusedSave=readPracticeSave(join(dir,'refused.sav'));
   const session=json(join(dir,'refused-session.json'));
   checks.refused=session.mode==='refused'&&refused.code===0&&logout(refused)&&freshRuneRecoveryContentsEqual(before,refusedSave,session)&&refused.log.includes('AIR_EXIT_REJECTION {"ok":true,')&&refused.log.includes('"reason":"no_matching_option"');
  }else if(i>=3){
   const clock=json(join(dir,'postcraft-clock.json'));
   checks['clock'+i]=clock.tickMs===(i===4?400:150)&&clock.after>=clock.before&&clock.before>0;
   Object.assign(checks,Object.fromEntries(Object.entries(freshRunePostCraftChecks(before,after,readRun(dir,'postcraft',fixture.codes.postcraft))).map(([k,v])=>['postcraft'+i+'-'+k,v])));
  }else{
   const run=readRun(dir,'exit',fixture.codes.exit);
   const session=json(join(dir,'exit-session.json'));
   checks['nearby'+i]=session.mode==='exit'&&run.code===0&&logout(run)&&freshRuneRecoveryContentsEqual(before,after,session)
    &&same(after.position,{x:2983,z:3288,level:0})&&run.log.includes('"phase":"outside"');
  }
  checks['outcomes'+i]=Object.entries(fixture.codes).every(([label,code])=>{const o=json(join(dir,label+'-outcome.json'));return o.code===code&&o.failure==='';});
 }
 return {ok:Object.values(checks).every(Boolean),checks,at:meta.at};
}

// Read-only chain validation. Check every preceding receipt, save and log before
// acquiring a stack or logging in. An attempt without publication is a failure,
// never permission to replay. The harness retains that first boundary.
export function freshRuneStageInput(directory:string,stage:FreshRuneStage,binding:Binding,currentSave:string,ownedAttempt=false){
 const index=freshRuneStages.indexOf(stage);
 if(index<0)throw Error('unknown fresh rune stage');
 if(existsSync(join(directory,'native.json')))throw Error('completed native proof; refuse duplicate stage');
 for(let i=index;i<freshRuneStages.length;i++){
  const file=stageFile(freshRuneStages[i]!);
  if(existsSync(join(directory,file))||(!(ownedAttempt&&i===index)&&existsSync(join(directory,file+'.attempt'))))throw Error('duplicate or out-of-order stage; retain first attempt');
 }
 const fixture=json(join(directory,'fixture.json'));
 if(fixture.name!==binding.name||fixture.saveAbsent!==true||fixture.credentialsAbsent!==true)throw Error('stage account/default fixture binding changed');
 const chain=freshRunePublishedStages(directory,binding,index);
 if(index>0&&(!existsSync(currentSave)||hash(currentSave)!==chain.inputHash))throw Error('engine save differs from prior checkpoint; never restore or reseed');
 return chain;
}

export function freshRunePublishedStages(directory:string,binding:Binding,count=4){
 let previous:string|null=null,inputHash:string|null=null;
 const records:StageRecord[]=[];
 for(let i=0;i<count;i++){
  const record:StageRecord=json(join(directory,stageFile(freshRuneStages[i]!)));
  if(record.stage!==freshRuneStages[i]||!same(record.binding,binding)||record.previous!==previous||record.inputHash!==inputHash
   ||record.output!==checkpoints[i]||record.outputHash!==hash(join(directory,checkpoints[i]!))
   ||!Object.keys(record.checks).length||!Object.values(record.checks).every(v=>v===true)
   ||!Object.keys(record.evidence).length||!Object.entries(record.evidence).every(([p,h])=>hash(join(directory,p))===h))
   throw Error('stale stage source/account/configuration/save/evidence binding');
  records.push(record);previous=hash(join(directory,stageFile(freshRuneStages[i]!)));inputHash=record.outputHash;
 }
 return {previous,inputHash,records};
}

export function stagedChecks(directory:string,stage:FreshRuneStage,codes:Record<string,number>){
 const before=readPracticeSave(join(directory,'before.sav')),interrupted=readPracticeSave(join(directory,'interrupted.sav'));
 const first=readRun(directory,'interrupted',codes.interrupted!);
 if(stage==='start')return {defaultSkills:freshRuneDefaultSkills(before),defaultQuest:(before.vars[63]??0)===0&&(before.vars[101]??0)===0,
  noSeededEssence:sum(before,1436)===0,registration:codes.registration===0&&logout(readRun(directory,'registration',codes.registration)),
  stopped:freshRuneSupportedInterruption(first),progress:retainedProgress(before,interrupted),logout:logout(first)};
 const bank=readRun(directory,'first-bank',codes['first-bank']!);
 const target=stage==='first-bank'?2:stage==='target'?20:21;
 const resume=stage==='first-bank'?bank:readRun(directory,stage==='target'?'resume':'higher',codes[stage==='target'?'resume':'higher']!);
 const additional=stage==='first-bank'?[]:stage==='target'?[bank]:[bank,readRun(directory,'resume',codes.resume!)];
 const after=readPracticeSave(join(directory,checkpoints[freshRuneStages.indexOf(stage)]!));
 const checks:Record<string,boolean>=freshRuneSupplyChecks({before,interrupted,after,first,resume,additional,xpRate:25,target});
 if(stage!=='first-bank'){
  const prior=readPracticeSave(join(directory,stage==='target'?'first-bank.sav':'after.sav')),result=summary(resume);
  const used=(after.skills[20]!.rawExperience-prior.skills[20]!.rawExperience)/1250;
  const mined=(after.skills[14]!.rawExperience-prior.skills[14]!.rawExperience)/1250;
  const productive=after.skills[20]!.xp>prior.skills[20]!.xp&&sum(after,556,95)>sum(prior,556,95);
  // At 25x the first 26 essence already reach 20 on the pinned flatter curve.
  // Still run the target 20 CLI; its valid no-op must preserve every saved asset/XP.
  const alreadyTarget=stage==='target'&&prior.skills[20]!.level>=20&&after.skills.every((s,i)=>s.rawExperience===prior.skills[i]!.rawExperience)
   &&same(assets(prior),assets(after))&&result?.crafted===0&&result?.consumed===0&&result?.mined===0;
  checks.continuation=(productive||alreadyTarget)
   &&sum(after,556,95)-sum(prior,556,95)===result?.crafted&&result?.banked===result?.crafted
   &&result?.consumed===used&&result?.mined===mined&&mined===used+sum(after,1436)-sum(prior,1436)
   &&after.vars[63]===prior.vars[63]&&after.vars[101]===prior.vars[101]&&runeSupplyPreserved(assets(prior),assets(after));
  checks.noRepeatedPreparation=!result?.stages?.training&&!result?.stages?.food&&!result?.stages?.quest&&!result?.stages?.questExit
   &&! /MILESTONE training|STARTER_COOKING_RESULT/.test(resume.log);
 }
 return checks;
}

export function verifyFreshRuneSupply(directory:string,deps={binding:freshRuneBinding,source:workerSourceRevision,files:sources,recovery:verifyFreshRuneAirRecovery}){
 const recovery=deps.recovery(directory);
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const run=(label:string):Run=>({code:meta.codes[label],log:readFileSync(join(directory,label+'.log'),'utf8')+readFileSync(join(directory,label+'.err'),'utf8')});
 let stageChecks:Record<string,boolean>={};
 if(meta.staged){
  const chain=freshRunePublishedStages(directory,deps.binding(meta.name));
  stageChecks={stageChain:chain.records.length===4&&chain.records.every(r=>same(r.codes,Object.fromEntries(Object.keys(r.codes).map(k=>[k,meta.codes[k]])))),
   ...Object.fromEntries(chain.records.map(r=>{
    const labels=r.stage==='start'?['registration','interrupted']:[r.stage==='target'?'resume':r.stage];
    const label=labels.at(-1)!;
    return [r.stage,Object.values(stagedChecks(directory,r.stage,r.codes)).every(Boolean)
     &&freshRuneSavedResult(readPracticeSave(join(directory,r.output)),run(label))
     &&labels.every(l=>{const outcome=json(join(directory,l+'-outcome.json'));return outcome.code===r.codes[l]&&outcome.failure==='';})];
   }))};
 }
 const checks={...freshRuneSupplyChecks({before:readPracticeSave(join(directory,'before.sav')),interrupted:readPracticeSave(join(directory,'interrupted.sav')),after:readPracticeSave(join(directory,'after.sav')),first:run('interrupted'),resume:run('resume'),additional:meta.staged?[run('first-bank')]:[],xpRate:meta.xpRate,target:20}),
  ...stageChecks,airRecovery:recovery.ok,...Object.fromEntries(Object.entries(recovery.checks).map(([k,v])=>['airRecovery-'+k,v])),
  source:meta.source===deps.source()&&JSON.stringify(meta.files)===JSON.stringify(deps.files()),
  registration:meta.saveAbsent===true&&meta.credentialsAbsent===true&&meta.registrationCode===0&&logout(run('registration')),
  configuration:meta.tickMs===150&&meta.xpRate===25,
  snapshots:['before.sav','interrupted.sav',...(meta.staged?['first-bank.sav']:[]),'after.sav','higher.sav'].every(p=>meta.hashes[p]===hash(join(directory,p))),
 };
 const later=readPracticeSave(join(directory,'higher.sav')),higher=run('higher'),b=summary(higher),prior=readPracticeSave(join(directory,'after.sav'));
 const report={ok:Object.values(checks).every(Boolean)&&higher.code===0&&b?.ok===true&&later.skills[20]!.level>=21&&later.skills[20]!.xp>prior.skills[20]!.xp&&sum(later,556,95)>sum(prior,556,95)&&runeSupplyPreserved(assets(prior),assets(later))&&logout(higher),checks,at:Date.now(),source:meta.source,
  scope:'Native default registration, installed CLI interruption/resume to 20 and finite continuation to 21. Server stays owned by the harness. No live release or unattended claim.'};
 return report;
}
