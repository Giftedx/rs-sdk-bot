import {expect,test} from 'bun:test';
import {readFileSync,rmSync,mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {applyPreset} from '../../packages/practice/src/presets';
import {levelForXp} from '../../packages/planner/src/curve';
import {readPracticeSave,setPracticeSkills} from './fleet-player-save';
import {artisanTransition,artisanSourceEntries,artisanSourceRevision,toolsEnv} from './catalog-integration-proof';
import {PROFILES,selectItems} from '../shop-buyer';

test('the actual artisan proof filter selects both Dommik tool patterns',()=>{
 expect(selectItems(PROFILES.dommik!.items,toolsEnv.ITEMS)).toEqual(PROFILES.dommik!.items);
});
import {runtimeTrees,releaseFiles} from '../../packages/core/src/worker-release';

const stdout='RESULT ok finite native artisan\nLOGOUT logged-out\n';
const toolsStdout='RESULT ok ticks=400 boughtTotal=2 bankedTotal=2 spentTotal=6 maxSpend=20 maxItems=2 targetMet=1 fareTotal=10\nLOGOUT logged-out\n';
async function fixture(mode:'cut'|'producer'|'tools',delta=mode==='cut'?2500:mode==='producer'?1000:0,output=mode==='producer'?1:2){
 const name=()=>`flat${randomUUID().replaceAll('-','').slice(0,8)}`;
 const skills=mode==='tools'?{Crafting:51,Hitpoints:64}:{Crafting:20,Hitpoints:40};
 const before=await applyPreset(name(),{position:mode==='tools'?{x:3085,z:3250,level:0}:{x:3269,z:3167,level:0},skills,inventory:[],equipment:[],
  bank:mode==='cut'?[{id:1623,count:2},{id:1755,count:1}]:mode==='producer'?[{id:1607,count:13},{id:2357,count:13},{id:1592,count:1}]:[{id:995,count:100470},{id:1623,count:4}]});
 const after=await applyPreset(name(),{position:{x:3269,z:3167,level:0},skills,equipment:[],
  inventory:mode==='cut'?[{id:1755,count:1}]:[],bank:mode==='cut'?[{id:1607,count:output}]:mode==='producer'?[{id:1607,count:12},{id:2357,count:12},{id:1592,count:1},{id:1637,count:output}]:
   [{id:995,count:100454},{id:1623,count:4},{id:1755,count:1},...(output===2?[{id:1592,count:1}]:[])]});
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

test('retained artisan source pins include dispatcher, planner and save reader dependencies',()=>{
 const base=mkdtempSync(join(tmpdir(),'artisan-release-'));
 const sources:Record<string,string>={'package.json':'{}','bun.lock':'','tsconfig.json':'{}',
  'scripts/microbot-production.ts':'export const cut=1;','scripts/microbot-jewellery-trip.ts':'export const ring=1;','scripts/shop-buyer.ts':'export const shop=1;',
  'scripts/measure/catalog-integration-proof.ts':"import './fleet-player-save'; import '../../packages/planner/src/autopilot';",
  'scripts/measure/fleet-player-save.ts':'export const reader=1;','packages/planner/src/autopilot.ts':'export const plan=1;',
  'scripts/aio.ts':"import './aio-skiller';",'scripts/aio-skiller.ts':'export const dispatch=1;',
  'packages/practice/src/supervise.ts':'export {};','packages/practice/src/supervise-host.ts':'export {};'};
 try{
  for(const dir of runtimeTrees)mkdirSync(join(base,dir),{recursive:true});
  for(const [file,text]of Object.entries(sources)){mkdirSync(dirname(join(base,file)),{recursive:true});writeFileSync(join(base,file),text);}
  for(const mode of ['cut','producer','tools'] as const){
   const closure=releaseFiles(artisanSourceEntries(mode),base),pin=artisanSourceRevision(mode,base);
   const dependencies=['scripts/measure/fleet-player-save.ts','packages/planner/src/autopilot.ts',...(mode==='producer'?['scripts/aio.ts','scripts/aio-skiller.ts']:[])];
   for(const file of dependencies){
    expect(closure).toContain(file);writeFileSync(join(base,file),sources[file]+'\nexport const edited=true;');
    expect(artisanSourceRevision(mode,base)).not.toBe(pin);writeFileSync(join(base,file),sources[file]!);
    expect(artisanSourceRevision(mode,base)).toBe(pin);
   }
  }
 }finally{rmSync(base,{recursive:true,force:true});}
});
