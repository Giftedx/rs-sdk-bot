import {expect,test} from 'bun:test';
import {readFileSync,rmSync,mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {applyPreset} from '../../packages/practice/src/presets';
import {levelForXp} from '../../packages/planner/src/curve';
import {readPracticeSave,setPracticeSkills} from './fleet-player-save';
import {artisanTransition,artisanSourceEntries,artisanSourceRevision,toolsEnv} from './catalog-integration-proof';
import {PROFILES,selectItems} from '../../packages/workers/src/market';

test('the actual artisan proof filter selects both Dommik tool patterns',()=>{
 expect(selectItems(PROFILES.dommik!.items,toolsEnv.ITEMS).map(i=>i.re.source)).toEqual(['^ring mould$','^chisel$']);
});
import {runtimeTrees,releaseFiles} from '../../packages/core/src/worker-release';

const stdout='RESULT ok finite native artisan\nLOGOUT logged-out\n';
const toolsStdout='RESULT ok ticks=400 boughtTotal=2 bankedTotal=2 spentTotal=6 maxSpend=20 maxItems=2 targetMet=1 fareTotal=10\nLOGOUT logged-out\n';
const observerStdout='BANK [{"id":995,"name":"Coins","count":100470},{"id":1623,"name":"Uncut sapphire","count":4}]\nBANK_OBSERVED {"generation":2,"at":2001,"items":2}\nLOGOUT logged-out\nRESULT ok inspection bankObserved=1 bankGeneration=2 bankObservedAt=2001 bankItems=2\n';
async function fixture(mode:'cut'|'producer'|'tools'|'observer',delta=mode==='cut'?2500:mode==='producer'?1000:0,output=mode==='producer'?1:2){
 const name=()=>`flat${randomUUID().replaceAll('-','').slice(0,8)}`;
 const skills=mode==='tools'||mode==='observer'?{Crafting:51,Hitpoints:64}:{Crafting:20,Hitpoints:40};
 const before=await applyPreset(name(),{position:mode==='tools'||mode==='observer'?{x:3085,z:3250,level:0}:{x:3269,z:3167,level:0},skills,inventory:[],equipment:[],
  bank:mode==='cut'?[{id:1623,count:2},{id:1755,count:1}]:mode==='producer'?[{id:1607,count:13},{id:2357,count:13},{id:1592,count:1}]:[{id:995,count:100470},{id:1623,count:4}]});
 const after=await applyPreset(name(),{position:{x:3269,z:3167,level:0},skills,equipment:[],
  inventory:mode==='cut'?[{id:1755,count:1}]:[],bank:mode==='cut'?[{id:1607,count:output}]:mode==='producer'?[{id:1607,count:12},{id:2357,count:12},{id:1592,count:1},{id:1637,count:output}]:
   mode==='observer'?[{id:995,count:100470},{id:1623,count:output===2?4:3}]:[{id:995,count:100454},{id:1623,count:4},{id:1755,count:1},...(output===2?[{id:1592,count:1}]:[])]});
 const afterSkills=readPracticeSave(after).skills.map(s=>({level:s.level,xp:s.xp}));afterSkills[12]!.xp+=delta;afterSkills[12]!.level=levelForXp(afterSkills[12]!.xp);setPracticeSkills(after,afterSkills);
 return{before:readFileSync(before),after:readFileSync(after),close:()=>{rmSync(before,{force:true});rmSync(after,{force:true});}};
}

for(const mode of ['cut','producer','tools'] as const)test(`retained ${mode} artisan bytes prove exact conversion and XP without a session`,async()=>{
 const f=await fixture(mode);
 try{
  const log=mode==='tools'?toolsStdout:stdout;
  expect(artisanTransition(mode,f.before,f.after,log)).toMatchObject({mode,xpGain:mode==='cut'?2500:mode==='producer'?1000:0,count:mode==='producer'?1:2});
  expect(()=>artisanTransition(mode,f.before,f.after,'RESULT ok claimed without logout\n')).toThrow('worker logout acknowledgement');
  const corrupt=Buffer.from(f.after);corrupt[corrupt.length-1]=(corrupt[corrupt.length-1]??0)^1;expect(()=>artisanTransition(mode,f.before,corrupt,log)).toThrow('CRC mismatch');
 }finally{f.close();}
});

test('retained observer bytes require a fresh bank marker, exact BANK payload and preserved state',async()=>{
 const valid=await fixture('observer'),changed=await fixture('observer',0,1),xp=await fixture('observer',1);
 try{
  expect(artisanTransition('observer',valid.before,valid.after,observerStdout)).toMatchObject({mode:'observer',xpGain:0,count:0,bankObserved:true});
  for(const log of [observerStdout.replace('bankObserved=1','bankObserved=0'),observerStdout.replace('bankGeneration=2','bankGeneration=1'),
   observerStdout.replace('100470','100469'),observerStdout.replace('BANK_OBSERVED','UNOBSERVED'),observerStdout.replace('LOGOUT logged-out\n','')])
   expect(()=>artisanTransition('observer',valid.before,valid.after,log)).toThrow();
  expect(()=>artisanTransition('observer',changed.before,changed.after,observerStdout)).toThrow();
  expect(()=>artisanTransition('observer',xp.before,xp.after,observerStdout)).toThrow('exact native25x Crafting XP');
 }finally{valid.close();changed.close();xp.close();}
});

test('tool acquisition requires both banked tools and reconciled bounded spend',async()=>{
 const short=await fixture('tools',0,1),valid=await fixture('tools');
 try{
  expect(()=>artisanTransition('tools',short.before,short.after,toolsStdout)).toThrow();
  expect(()=>artisanTransition('tools',valid.before,valid.after,toolsStdout.replace('spentTotal=6','spentTotal=7'))).toThrow('shop coin debit');
  expect(()=>artisanTransition('tools',valid.before,valid.after,toolsStdout.replace('spentTotal=6','spentTotal=21'))).toThrow('bounded shop spend');
 }finally{short.close();valid.close();}
});

test('a successful artisan log cannot qualify short output or the wrong saved XP',async()=>{
 const short=await fixture('cut',2500,1),xp=await fixture('cut',2499);
 try{expect(()=>artisanTransition('cut',short.before,short.after,stdout)).toThrow();expect(()=>artisanTransition('cut',xp.before,xp.after,stdout)).toThrow('exact native25x Crafting XP');}
 finally{short.close();xp.close();}
});

test('retained artisan source pins include dispatcher, step resolver and save reader dependencies',()=>{
 const base=mkdtempSync(join(tmpdir(),'artisan-release-'));
 const sources:Record<string,string>={'package.json':'{}','bun.lock':'','tsconfig.json':'{}',
  'packages/workers/src/bank-artisan/index.ts':'export const artisan=1;','scripts/aio-market.ts':'export const shop=1;',
  'scripts/aio-logistics.ts':"import '../packages/core/src/inprocess';",'packages/core/src/inprocess.ts':'export const bankObservation=1;',
  'scripts/measure/catalog-integration-proof.ts':"import './fleet-player-save'; import '../aio-skiller';",
  'scripts/measure/fleet-player-save.ts':'export const reader=1;','scripts/aio-skiller.ts':"import '../packages/workers/src/bank-artisan'; export const resolveSkillerStep=1;",
  'packages/practice/src/supervise.ts':'export {};','packages/practice/src/supervise-host.ts':'export {};'};
 try{
  for(const dir of runtimeTrees)mkdirSync(join(base,dir),{recursive:true});
  for(const [file,text]of Object.entries(sources)){mkdirSync(dirname(join(base,file)),{recursive:true});writeFileSync(join(base,file),text);}
  for(const mode of ['cut','producer','tools','observer'] as const){
   const closure=releaseFiles(artisanSourceEntries(mode),base),pin=artisanSourceRevision(mode,base);
   const dependencies=['scripts/measure/fleet-player-save.ts','scripts/aio-skiller.ts',...(mode==='observer'?['scripts/aio-logistics.ts','packages/core/src/inprocess.ts']:[])];
   for(const file of dependencies){
    expect(closure).toContain(file);writeFileSync(join(base,file),sources[file]+'\nexport const edited=true;');
    expect(artisanSourceRevision(mode,base)).not.toBe(pin);writeFileSync(join(base,file),sources[file]!);
    expect(artisanSourceRevision(mode,base)).toBe(pin);
   }
  }
 }finally{rmSync(base,{recursive:true,force:true});}
});
