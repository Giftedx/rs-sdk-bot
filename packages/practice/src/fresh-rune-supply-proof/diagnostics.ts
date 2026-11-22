import {copyFileSync,existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {workerSourceRevision} from '../../../core/src/worker-release';
import {createBot} from '../bots';
import {readPracticeSave,setPracticeSkills,waitPracticeSave} from '../fleet-player-save';
import {applyPreset} from '../presets';
import {runBotName} from '../prove';
import {
 freshRuneAirRecoveryChecks,freshRuneCookingDiagnosticChecks,freshRuneCookingDiagnosticInput,
 freshRuneEssenceDiagnosticChecks,freshRuneEssenceDiagnosticInput,freshRunePostCraftChecks,
 freshRuneRecoveryContentsEqual,freshRuneSavedResult,
} from './checks';
import {airRecoveryPositions,engineSave,freshRuneBinding,hash,json,POSTCRAFT_XP,readRun,repoRoot,same,sources,sum} from './contracts';
import {freshRuneCommand,freshRuneRecoveryClock,withFreshRuneStack} from './stack';
import {verifyFreshRuneAirRecovery} from './verify';

export async function diagnoseFreshRuneEssence(directory:string,name:string,retained:string){
 freshRuneEssenceDiagnosticInput(name,retained);
 mkdirSync(directory,{recursive:true});
 if(['native.json','before.sav','essence-before.sav','essence-diagnostic.json'].some(f=>existsSync(join(directory,f))))
  throw Error('use a separate new essence diagnostic directory');
 const retainedHash=hash(retained),source=workerSourceRevision(),files=sources();
 return withFreshRuneStack(directory,async budget=>{
  const {save,before}=freshRuneEssenceDiagnosticInput(name,retained);
  copyFileSync(save,join(directory,'essence-before.sav'));
  const startedAt=Date.now();
  const code=await freshRuneCommand(directory,budget,'essence-diagnostic',['scripts/aio-skiller.ts',name,'runecraft','supply','2'],save,{CAP:'3000'});
  const elapsedMs=Date.now()-startedAt;
  // A supported failure also retains the first saved boundary. Never replay it.
  const publication=await waitPracticeSave(save,s=>code!==0||s.skills[20]!.xp>before.skills[20]!.xp);
  copyFileSync(save,join(directory,'essence-after.sav'));
  const after=readPracticeSave(save),log=readFileSync(join(directory,'essence-diagnostic.log'),'utf8')+readFileSync(join(directory,'essence-diagnostic.err'),'utf8');
  const checks={...freshRuneEssenceDiagnosticChecks(before,after,{code,log}),published:publication.matched,retained:hash(retained)===retainedHash,
   source:workerSourceRevision()===source&&JSON.stringify(files)===JSON.stringify(sources())};
  const report={ok:Object.values(checks).every(Boolean),checks,name,source,files,retained:resolve(retained),retainedHash,
   beforeHash:hash(join(directory,'essence-before.sav')),afterHash:hash(join(directory,'essence-after.sav')),elapsedMs,tickMs:150,xpRate:25,
   scope:'Retained essence through installed CLI to first banked crafted output only. Not default-entry, Runecraft 20, continuation, live or full delivery proof.'};
  writeFileSync(join(directory,'essence-diagnostic.json'),JSON.stringify(report,null,2),{flag:'wx'});
  return report;
 });
}

// Harness-only reduced run. No new identity, restore, training, quest or native.json.
export async function diagnoseFreshRuneCooking(directory:string,name:string,retained:string){
 freshRuneCookingDiagnosticInput(name,retained);
 mkdirSync(directory,{recursive:true});
 if(['native.json','before.sav','cooking-before.sav','cooking-diagnostic.json'].some(f=>existsSync(join(directory,f))))
  throw Error('use a separate new cooking diagnostic directory');
 const retainedHash=hash(retained),source=workerSourceRevision(),files=sources();
 return withFreshRuneStack(directory,async budget=>{
  // Recheck after admission. Failed delivery saves remain read-only evidence.
  const {save,before}=freshRuneCookingDiagnosticInput(name,retained);
  copyFileSync(save,join(directory,'cooking-before.sav'));
  const code=await freshRuneCommand(directory,budget,'cooking',['scripts/aio-skiller.ts',name,'runecraft','supply','20'],save,{RUNE_COOK_DIAGNOSTIC:'1'});
  await waitPracticeSave(save,s=>code!==0||sum(s,2138,93)===sum(before,2138,93)-1);copyFileSync(save,join(directory,'cooking-after.sav'));
  const after=readPracticeSave(save),log=readFileSync(join(directory,'cooking.log'),'utf8')+readFileSync(join(directory,'cooking.err'),'utf8');
  const cooked=sum(after,2140)-sum(before,2140),burnt=sum(after,2144)-sum(before,2144),debit=sum(before,2138)-sum(after,2138);
  const xp=after.skills[7]!.xp-before.skills[7]!.xp;
  const checks={...freshRuneCookingDiagnosticChecks(before,after,{code,log}),retained:hash(retained)===retainedHash,
   source:workerSourceRevision()===source&&JSON.stringify(files)===JSON.stringify(sources())};
  const report={ok:Object.values(checks).every(Boolean),checks,name,source,files,retained:resolve(retained),retainedHash,
   beforeHash:hash(join(directory,'cooking-before.sav')),afterHash:hash(join(directory,'cooking-after.sav')),cooked,burnt,debit,xp,
   scope:'Single retained-state cooking diagnostic. Does not qualify the full fresh rune supply delivery.'};
  writeFileSync(join(directory,'cooking-diagnostic.json'),JSON.stringify(report,null,2),{flag:'wx'});
  return report;
 });
}

export async function proveFreshRuneAirRecovery(parent:string){
 const directory=join(parent,'air-recovery');mkdirSync(directory,{recursive:true});
 // No replay after any partial fixture. Preserve its first missing effect.
 writeFileSync(join(directory,'attempt.json'),JSON.stringify({at:Date.now(),source:workerSourceRevision(),files:sources()}),{flag:'wx'});
 const fixtures:any[]=[];
 try{
  for(const tickMs of [150,400] as const){
   const stackDir=join(directory,'stack-'+tickMs);mkdirSync(stackDir,{recursive:true});
   await withFreshRuneStack(stackDir,async budget=>{
    for(const i of tickMs===150?[3,0,1,2]:[4]){
     const position=airRecoveryPositions[i>=3?0:i]!;
     budget.check();const dir=join(directory,String(i));mkdirSync(dir,{recursive:true});
     const name=runBotName('flair',i+1),save=engineSave(name);
     if(existsSync(save)||existsSync(join(repoRoot,'vendor/rs-sdk/bots',name)))throw Error('air recovery fixture identity already exists');
     await createBot(name);
     const binding=freshRuneBinding(name,tickMs);writeFileSync(join(dir,'fixture.json'),JSON.stringify({binding,position,scope:'ordinary recovery fixture; never default registration'}),{flag:'wx'});
     // Seed once, only for this separate ordinary fixture. Postcraft fixtures
     // carry one essence. The existing continuation fixture mines its own.
     await applyPreset(name,{position,skills:{Runecraft:i>=3?19:20,Mining:20,Hitpoints:16,Attack:12,Defence:11,Strength:11},varps:{63:6,101:1,281:1000},
      inventory:[{id:1438,count:1},{id:556,count:26},{id:315,count:1},...(i>=3?[{id:1436,count:1}]:[])],equipment:[{id:1265,count:1,slot:3},{id:1171,count:1,slot:5}],
      bank:[{id:556,count:25},{id:995,count:25},{id:1277,count:1},{id:2140,count:8},{id:2309,count:1},{id:1351,count:1},{id:590,count:1}]});
     const seeded=readPracticeSave(save);setPracticeSkills(save,seeded.skills.map((s,index)=>({level:s.level,xp:index===20?(i>=3?POSTCRAFT_XP:3250):index===14?3375:s.xp})));
     copyFileSync(save,join(dir,'before.sav'));
     const codes:Record<string,number>={};let higherInputHash:string|undefined;
     const command=async(label:string,target:number,env:Record<string,string>={})=>{
      const mode=env.RUNE_AIR_EXIT_DIAGNOSTIC,clockBefore=mode?await freshRuneRecoveryClock(tickMs):undefined;
      codes[label]=await freshRuneCommand(dir,budget,label,['scripts/aio-skiller.ts',name,'runecraft','supply',String(target)],save,{CAP:'4000',...env});
      if(mode)writeFileSync(join(dir,label+'-session.json'),JSON.stringify({mode,clockBefore,clockAfter:await freshRuneRecoveryClock(tickMs)}),{flag:'wx'});
      copyFileSync(save,join(dir,label+'-observed.sav'));
      if(codes[label]!==0)throw Error('air recovery first boundary: '+label+'; retain action reply/messages/save; no full replay');
     };
     if(i>=3){
      const clockBefore=await freshRuneRecoveryClock(tickMs);
      await command('postcraft',20);
      writeFileSync(join(dir,'postcraft-clock.json'),JSON.stringify({tickMs,before:clockBefore,after:await freshRuneRecoveryClock(tickMs)}),{flag:'wx'});
      const observed=await waitPracticeSave(save,s=>freshRuneSavedResult(s,readRun(dir,'postcraft',codes.postcraft!)));
      copyFileSync(save,join(dir,'after.sav'));
      const checks=freshRunePostCraftChecks(readPracticeSave(join(dir,'before.sav')),readPracticeSave(save),readRun(dir,'postcraft',codes.postcraft!));
      if(!observed.matched||!Object.values(checks).every(Boolean))throw Error('postcraft recovery predicates failed '+JSON.stringify(checks));
     }else if(i===0){
      await command('refused',20,{RUNE_AIR_EXIT_DIAGNOSTIC:'refused'});
      const refusedBefore=readPracticeSave(join(dir,'before.sav')),session=json(join(dir,'refused-session.json'));
      const refused=await waitPracticeSave(save,s=>freshRuneRecoveryContentsEqual(refusedBefore,s,session));
      copyFileSync(save,join(dir,'refused.sav'));
      if(!refused.matched)throw Error('refused action changed fixture state');
      await command('recovery',20);
      const observed=await waitPracticeSave(save,s=>freshRuneSavedResult(s,readRun(dir,'recovery',codes.recovery!)));
      copyFileSync(save,join(dir,'after.sav'));
      const checks=freshRuneAirRecoveryChecks(readPracticeSave(join(dir,'before.sav')),readPracticeSave(save),readRun(dir,'recovery',codes.recovery!),20);
      if(!observed.matched||!Object.values(checks).every(Boolean))throw Error('air recovery predicates failed '+JSON.stringify(checks));
      // Same save and identity. Nothing restores it between these installed CLI calls.
      higherInputHash=hash(save);if(higherInputHash!==hash(join(dir,'after.sav')))throw Error('higher recovery input changed; refuse reseed');
      await command('higher',21);
      const higher=await waitPracticeSave(save,s=>freshRuneSavedResult(s,readRun(dir,'higher',codes.higher!)));
      copyFileSync(save,join(dir,'higher.sav'));if(!higher.matched)throw Error('higher recovery save unobserved');
      const later=freshRuneAirRecoveryChecks(readPracticeSave(join(dir,'after.sav')),readPracticeSave(save),readRun(dir,'higher',codes.higher!),21);
      if(!Object.values(later).every(Boolean))throw Error('higher recovery predicates failed '+JSON.stringify(later));
     }else{
      await command('exit',20,{RUNE_AIR_EXIT_DIAGNOSTIC:'exit'});
      const observed=await waitPracticeSave(save,s=>same(s.position,{x:2983,z:3288,level:0}));
      copyFileSync(save,join(dir,'after.sav'));if(!observed.matched)throw Error('nearby air exit save unobserved');
     }
     const paths=readdirSync(dir).filter(p=>/\.(sav|log|err|json)$/.test(p));
     fixtures[i]={binding,codes,tickMs,higherInputHash,hashes:Object.fromEntries(paths.map(p=>[p,hash(join(dir,p))]))};
    }
   },undefined,tickMs);
  }
  const meta={at:Date.now(),fixtures,source:workerSourceRevision(),files:sources()};
  writeFileSync(join(directory,'native.json'),JSON.stringify(meta,null,2),{flag:'wx'});
  const report=verifyFreshRuneAirRecovery(parent);writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});return report;
 }catch(error){
  writeFileSync(join(directory,'report.json'),JSON.stringify({ok:false,at:Date.now(),source:workerSourceRevision(),files:sources(),
   boundary:String(error),scope:'Reduced ordinary air recovery failed. Preserve all identities, saves and logs. Do not replay full starter stages.'},null,2),{flag:'wx'});
  throw error;
 }
}
