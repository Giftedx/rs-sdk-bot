import {expect,test} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {resolveBossStep} from './aio-boss';
import {importAioLoadout,resolveLogisticsStep} from './aio-logistics';
import {planAioPipeline,toSwarmChainJob} from './aio';
import {parseStep} from '../packages/core/src/chain-step';
import {workerEntries} from '../packages/core/src/worker-release';

const root=resolve(import.meta.dir,'..');

test('travel and prayer recovery workers dispatch through AIO with the worker argument contract',()=>{
 expect(resolveLogisticsStep('walk-edge')).toEqual({script:'scripts/pk-live/walk-edge.ts',args:[],env:{}});
 expect(resolveLogisticsStep('restore-prayer',['ALTAR=3243,3205'])).toEqual({script:'scripts/pray-at-altar.ts',args:[],env:{ALTAR:'3243,3205'}});
});

test('KBD positional limit reaches the fight worker environment and invalid limits fail before login',()=>{
 expect(resolveBossStep('kbd',['500'])).toEqual({script:'scripts/microbot-b-kbd.ts',args:[],env:{CAP:'500'}});
 expect(resolveBossStep('kbd',['500','CAP=700','TRIP_CAP=5000']).env).toEqual({CAP:'700',TRIP_CAP:'5000'});
 for(const args of [['0'],['1001'],['5000'],['not-a-cap'],['100','200']])expect(()=>resolveBossStep('kbd',args)).toThrow('1..1000');
});

test('offline loadout importer works through direct AIO, pipelines and generated swarm chains',()=>{
 const folder=mkdtempSync(join(tmpdir(),'aio loadout-')),source=join(folder,'source.json'),bindings=join(folder,'bindings.json');
 try{
  writeFileSync(source,JSON.stringify({inv:[{id:10003}],eq:[]}));
  writeFileSync(bindings,JSON.stringify({items:{10003:385},bank:{x:2655,z:3283,level:0},cap:600,maximumMoves:128,packPolicy:'exact-counts'}));
  const step=resolveLogisticsStep('loadout-import',[source,bindings]);
  expect(step).toEqual({script:'scripts/aio-logistics.ts',args:['loadout-import',source,bindings],env:{}});
  expect(importAioLoadout([source,bindings]).pack).toEqual([{id:385,count:1}]);
  const specs=[`logistics:loadout-import ${JSON.stringify(source)} ${JSON.stringify(bindings)}`];
  const chain=toSwarmChainJob('Offline','setup','Compile owned kit',[
   ...planAioPipeline(specs),...planAioPipeline(specs),
  ]);
  const commands=[
   ['scripts/aio-logistics.ts','Offline','loadout-import',source,bindings],
   ['scripts/aio.ts','pipeline','Offline',...specs],
   [chain.script,'Offline',...chain.args],
  ];
  for(const command of commands){
   const r=spawnSync(process.execPath,command,{cwd:root,encoding:'utf8',timeout:20000,windowsHide:true});
   expect(r.status,r.stderr).toBe(0);
   expect(r.stdout).toContain('"id": 385');
   expect(r.stdout).toMatch(/^RESULT ok/m);
   expect(r.stdout).not.toContain('RESULT fail');
  }
  expect(()=>resolveLogisticsStep('loadout-import',[source])).toThrow('requires');
  writeFileSync(source,JSON.stringify({inv:[{id:999}],eq:[]}));
  expect(()=>importAioLoadout([source,bindings])).toThrow('explicit native binding');
 }finally{rmSync(folder,{recursive:true,force:true});}
});

test('catalog route identifiers and literal worker options survive generated host and swarm chains',()=>{
 const specs=['skiller:fishing:harpoon CAP=500','pvp:roam LOOPS=3 ARMY_OPTS={"pace":2}','quester:mode:sweep cook'];
 const steps=planAioPipeline(specs);
 expect(steps[0]!.args).toEqual(['harpoon']);
 expect(steps[1]!.args).toEqual(['LOOPS=3','ARMY_OPTS={"pace":2}']);
 expect(steps[2]!.args).toEqual(['cook']);
 const job=toSwarmChainJob('Example','mixed','Use exact routes',steps);
 expect(job.args.map(parseStep)).toEqual(steps);
 expect(workerEntries(job.script,job.args)).toEqual(expect.arrayContaining(['scripts/pk-roam.ts','scripts/gather-fish.ts','scripts/quest-sweep.ts']));
 expect(()=>planAioPipeline([' '])).toThrow('requires');
});
