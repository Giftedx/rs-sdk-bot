import {expect,test} from 'bun:test';
import {resolve} from 'node:path';
import {getProgressionAdapter} from '../../core/src/progression-adapter';
import {xpForLevel} from '../src/curve';
import {chooseProgression,trainingTargets} from '../src/progression';
import {plannerProgressionAdapter} from '../src/progression-adapter';
import {accountFromStatus,intentForEntry,loadProgressionCatalog,progressionMethods,progressionStep} from '../src/progression-catalog';
import {assessProgressionPerformance} from '../src/progression-performance';

test('bunfig preload registers plannerProgressionAdapter lazily without loading catalog or gear upfront',async()=>{
 const repo=resolve(import.meta.dir,'../../..');
 const code=`
  import {getProgressionAdapter} from ${JSON.stringify(resolve(repo,'packages/core/src/progression-adapter.ts'))};
  const loadedBefore=Object.keys(require.cache).map(k=>k.replaceAll('\\\\','/'));
  const adapter=getProgressionAdapter();
  const hasCatalogBefore=loadedBefore.some(k=>k.endsWith('/packages/planner/src/progression-catalog.ts')||k.endsWith('/packages/planner/src/progression-ranged.ts')||k.endsWith('/packages/planner/src/progression.ts'));
  const targets=adapter?.trainingTargets({kind:'train',skill:'Ranged',targetLevel:50});
  const loadedAfterTargets=Object.keys(require.cache).map(k=>k.replaceAll('\\\\','/'));
  const hasCatalogAfter=loadedAfterTargets.some(k=>k.endsWith('/packages/planner/src/progression-catalog.ts'));
  console.log('PROBE '+JSON.stringify({registered:!!adapter,hasCatalogBefore,targets,hasCatalogAfter}));
 `;
 const proc=Bun.spawn(['bun','-e',code],{cwd:repo,stdout:'pipe',stderr:'pipe',timeout:10000,windowsHide:true});
 const [exitCode,stdout,stderr]=await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()]);
 expect(exitCode,stderr).toBe(0);
 const line=stdout.split(/\r?\n/).find(l=>l.startsWith('PROBE '));
 expect(line).toBeDefined();
 const probe=JSON.parse(line!.slice(6));
 expect(probe.registered).toBe(true);
 expect(probe.hasCatalogBefore).toBe(false);
 expect(probe.targets).toEqual({ranged:50});
 expect(probe.hasCatalogAfter).toBe(true);
});

test('plannerProgressionAdapter delegates all ProgressionAdapter methods consistently with planner exports',()=>{
 expect(getProgressionAdapter()).toBe(plannerProgressionAdapter);
 const catalog=loadProgressionCatalog();
 expect(plannerProgressionAdapter.loadProgressionCatalog()).toEqual(catalog);
 expect(plannerProgressionAdapter.levelForXp(xpForLevel(50))).toBe(50);
 const intent={kind:'train' as const,skill:'Ranged',targetLevel:40};
 expect(plannerProgressionAdapter.trainingTargets(intent)).toEqual(trainingTargets(intent));
 expect(plannerProgressionAdapter.intentForEntry('scripts/ranged-train.ts',['40'],{},undefined,catalog)).toEqual(intentForEntry('scripts/ranged-train.ts',['40'],{},undefined,catalog));
 const now=Date.now();
 const status={name:'Fixture',server:'localhost:8888',at:now,bankAt:now,questsAt:now,equipmentObserved:true,skills:[{name:'Ranged',level:20,xp:xpForLevel(20)}],inventory:[],equipment:[],bank:[],quests:[]};
 const account=accountFromStatus('Fixture',status,now);
 expect(plannerProgressionAdapter.accountFromStatus('Fixture',status,now)).toEqual(account);
 const directMethods=progressionMethods(intent,account,catalog);
 const adapterMethods=plannerProgressionAdapter.progressionMethods(intent,account,catalog);
 expect(adapterMethods).toEqual(directMethods);
 const first=directMethods.methods[0]!;
 expect(plannerProgressionAdapter.progressionStep(first,1,intent,account,catalog)).toEqual(progressionStep(first,1,intent,account,catalog));
 expect(plannerProgressionAdapter.chooseProgression(intent,account,directMethods.methods,{now,maxSearchNodes:128,maxDepth:4}))
  .toEqual(chooseProgression(intent,account,directMethods.methods,{now,maxSearchNodes:128,maxDepth:4}));
 expect(plannerProgressionAdapter.assessProgressionPerformance(
  {unitsPerTick:1,minimumTicks:100,minimumFraction:0.5,sustainedWindows:2,source:'s',conditions:'c'},
  [{units:150,ticks:150,setupTicks:0,source:'s',conditions:'c'}],
 )).toEqual(assessProgressionPerformance(
  {unitsPerTick:1,minimumTicks:100,minimumFraction:0.5,sustainedWindows:2,source:'s',conditions:'c'},
  [{units:150,ticks:150,setupTicks:0,source:'s',conditions:'c'}],
 ));
});
