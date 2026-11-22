import {copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {workerSourceRevision} from '../../../core/src/worker-release';
import {createBot} from '../bots';
import {readPracticeSave,waitPracticeSave} from '../fleet-player-save';
import {runBotName} from '../prove';
import {freshRuneDefaultSkills,freshRuneSavedResult,freshRuneSupportedInterruption} from './checks';
import {
 type Binding,checkpoints,engineSave,freshRuneBinding,type FreshRuneStage,freshRuneStages,freshRuneStageWorker,
 hash,json,logout,readRun,repoRoot,retainedProgress,same,sources,stageFile,type StageRecord,sum,
} from './contracts';
import {freshRuneCommand,withFreshRuneStack} from './stack';
import {freshRuneStageInput,stagedChecks,verifyFreshRuneAirRecovery,verifyFreshRuneSupply} from './verify';

const stageDeps={stack:withFreshRuneStack,binding:freshRuneBinding,save:engineSave,create:createBot,name:()=>runBotName('flrune',1),command:freshRuneCommand,wait:waitPracticeSave,verify:verifyFreshRuneSupply,recovery:verifyFreshRuneAirRecovery};

export async function proveFreshRuneStage(directory:string,stage:FreshRuneStage,deps=stageDeps){
 if(!deps.recovery(directory).ok)throw Error('air recovery gate failed; no full replay');
 mkdirSync(directory,{recursive:true});
 let binding:Binding|undefined;
 if(stage==='start'){
  if(['fixture.json','before.sav','native.json',...freshRuneStages.flatMap(s=>[stageFile(s),stageFile(s)+'.attempt'])].some(p=>existsSync(join(directory,p))))
   throw Error('retain existing identity and stage attempts; use a new delivery directory');
 }else{
  binding=deps.binding(json(join(directory,'fixture.json')).name);
  freshRuneStageInput(directory,stage,binding,deps.save(binding.name));
 }
 writeFileSync(join(directory,stageFile(stage)+'.attempt'),JSON.stringify({stage,at:Date.now(),binding}),{flag:'wx'});
 const evidenceDir=join(directory,'stack-'+stage);mkdirSync(evidenceDir,{recursive:true});
 const record=await deps.stack(evidenceDir,async budget=>{
  let input:{previous:string|null;inputHash:string|null;records:StageRecord[]}={previous:null,inputHash:null,records:[]};
  if(stage==='start'){
   const name=deps.name(),save=deps.save(name),botDir=join(repoRoot,'vendor/rs-sdk/bots',name);
   if(existsSync(save)||existsSync(botDir))throw Error('genuine unclaimed default fixture required');
   writeFileSync(join(directory,'fixture.json'),JSON.stringify({name,saveAbsent:true,credentialsAbsent:true}),{flag:'wx'});
   await deps.create(name);binding=deps.binding(name);
  }else{
   if(!same(binding,deps.binding(binding!.name)))throw Error('stage binding changed during admission');
   input=freshRuneStageInput(directory,stage,binding!,deps.save(binding!.name),true);
  }
  const save=deps.save(binding!.name),codes={...input.records.at(-1)?.codes};
  const command=async(label:string,args:string[],env:Record<string,string>={})=>codes[label]=await deps.command(directory,budget,label,args,save,env);
  if(stage==='start'){
   if(await command('registration',['packages/practice/src/register-proof-account.ts',binding!.name])!==0)throw Error('default registration failed');
   const observed=await deps.wait(save,s=>freshRuneDefaultSkills(s)&&(s.vars[63]??0)===0&&(s.vars[101]??0)===0&&sum(s,1436)===0);
   copyFileSync(save,join(directory,'before.sav'));if(!observed.matched)throw Error('default registration save unobserved');
   await command('interrupted',['scripts/aio-skiller.ts',binding!.name,'runecraft','supply','20'],{CAP:'1000'});
  }else{
   const worker=freshRuneStageWorker(stage,binding!.name,budget.deadline);
   if(await command(worker.label,worker.args,worker.env)!==0){copyFileSync(save,join(directory,worker.label+'-failed.sav'));throw Error('stage worker failed; retain first boundary');}
  }
  const output=checkpoints[freshRuneStages.indexOf(stage)]!;
  const label=stage==='start'?'interrupted':stage==='target'?'resume':stage,run=readRun(directory,label,codes[label]!);
  const observed=await deps.wait(save,s=>freshRuneSavedResult(s,run)&&(stage==='start'?retainedProgress(readPracticeSave(join(directory,'before.sav')),s)
   :(s.skills[20]?.level??0)>=(stage==='first-bank'?2:stage==='target'?20:21)&&sum(s,556,93)===0));
  copyFileSync(save,join(directory,output));
  if(!observed.matched)throw Error('stage checkpoint publication unobserved; retain save');
  const checks=stagedChecks(directory,stage,codes);
  checks.savedResult=freshRuneSavedResult(readPracticeSave(join(directory,output)),run);
  checks.source=same(binding,deps.binding(binding!.name));
  if(!Object.values(checks).every(Boolean))throw Error('stage predicates failed: '+JSON.stringify(checks));
  const labels=stage==='start'?['registration','interrupted']:[stage==='target'?'resume':stage];
  const paths=['fixture.json',...(stage==='start'?['before.sav']:[]),output,...labels.flatMap(l=>[l+'.log',l+'.err',l+'-outcome.json'])];
  return {stage,binding:binding!,previous:input.previous,inputHash:input.inputHash,output,outputHash:hash(join(directory,output)),
   evidence:Object.fromEntries(paths.map(p=>[p,hash(join(directory,p))])),codes,checks,at:Date.now()} satisfies StageRecord;
 });
 // Publish only after the owned stack has stopped and released its lock.
 writeFileSync(join(directory,stageFile(stage)),JSON.stringify(record,null,2),{flag:'wx'});
 if(stage==='higher'){
  const meta={at:Date.now(),source:record.binding.source,files:record.binding.files,name:record.binding.name,saveAbsent:true,credentialsAbsent:true,
   registrationCode:record.codes.registration,codes:record.codes,tickMs:150,xpRate:25,staged:true,
   hashes:Object.fromEntries(['before.sav',...checkpoints].map(p=>[p,hash(join(directory,p))]))};
  writeFileSync(join(directory,'native.json'),JSON.stringify(meta,null,2),{flag:'wx'});
  return deps.verify(directory);
 }
 return {ok:true,stage,checkpoint:record.output,hash:record.outputHash};
}

export async function proveFreshRuneSupply(directory:string){
 if(!verifyFreshRuneAirRecovery(directory).ok)throw Error('air recovery gate failed; no full replay');
 mkdirSync(directory,{recursive:true});
 if(existsSync(join(directory,'native.json'))||existsSync(join(directory,'before.sav')))throw Error('retain existing proof; use a new delivery directory');
 return withFreshRuneStack(directory,async budget=>{
  const name=runBotName('flrune',1),botDir=join(repoRoot,'vendor/rs-sdk/bots',name),save=join(repoRoot,'vendor/rs-sdk/server/engine/data/players/main',name.toLowerCase()+'.sav');
  const saveAbsent=!existsSync(save),credentialsAbsent=!existsSync(botDir);if(!saveAbsent||!credentialsAbsent)throw Error('genuine unclaimed default fixture required');
  writeFileSync(join(directory,'fixture.json'),JSON.stringify({name,saveAbsent,credentialsAbsent}),{flag:'wx'});
  budget.check();
  await createBot(name);
  if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local fixture required');
  const codes:Record<string,number>={};
  const command=async(label:string,args:string[],env:Record<string,string>={})=>{
   codes[label]=await freshRuneCommand(directory,budget,label,args,save,env);
   return codes[label]!;
  };
  const source=workerSourceRevision(),files=sources();
  // The registration helper only logs in and out. The server creates the initial save.
  const registrationCode=await command('registration',['packages/practice/src/register-proof-account.ts',name]);
  if(registrationCode!==0)throw Error('normal registration failed; retain registration logs');
  await waitPracticeSave(save,()=>true);copyFileSync(save,join(directory,'before.sav'));
  const before=readPracticeSave(save);
  if(!freshRuneDefaultSkills(before)||(before.vars[63]??0)!==0||(before.vars[101]??0)!==0||sum(before,1436)>0)throw Error('registration was not default; do not seed a replacement');
  const interruptedCode=await command('interrupted',['scripts/aio-skiller.ts',name,'runecraft','supply','20'],{CAP:'1000'});
  await waitPracticeSave(save,()=>true);copyFileSync(save,join(directory,'interrupted.sav'));
  const interrupted={code:interruptedCode,log:readFileSync(join(directory,'interrupted.log'),'utf8')+readFileSync(join(directory,'interrupted.err'),'utf8')};
  if(!freshRuneSupportedInterruption(interrupted)||!retainedProgress(before,readPracticeSave(join(directory,'interrupted.sav')))||!logout(interrupted))
   throw Error('unexpected interruption boundary; retain interrupted save and logs, no resume');
  const resumeCode=await command('resume',['scripts/aio-skiller.ts',name,'runecraft','supply','20'],{CAP:'30000'});
  if(resumeCode!==0){copyFileSync(save,join(directory,'resume-failed.sav'));throw Error('fresh rune resume failed; inspect resume.log and resume.err before any further run');}
  const resumed=await waitPracticeSave(save,s=>(s.skills[20]?.level??0)>=20);copyFileSync(save,join(directory,'after.sav'));
  if(!resumed.matched)throw Error('resume target save not observed; retain after.sav, no higher run');
  const higherCode=await command('higher',['scripts/aio-skiller.ts',name,'runecraft','supply','21'],{CAP:'10000'});
  if(higherCode!==0){copyFileSync(save,join(directory,'higher-failed.sav'));throw Error('fresh rune higher target failed; retain first boundary');}
  const higher=await waitPracticeSave(save,s=>(s.skills[20]?.level??0)>=21);copyFileSync(save,join(directory,'higher.sav'));
  if(!higher.matched)throw Error('higher target save not observed; retain higher.sav');
  writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source,files,name,saveAbsent,credentialsAbsent,registrationCode,codes,tickMs:150,xpRate:25,
   hashes:Object.fromEntries(['before.sav','interrupted.sav','after.sav','higher.sav'].map(p=>[p,hash(join(directory,p))]))},null,2));
  const report=verifyFreshRuneSupply(directory);writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));return report;
 });
}
