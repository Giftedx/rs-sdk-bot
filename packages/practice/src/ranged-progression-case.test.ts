import {expect,test} from 'bun:test';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {xpForLevel} from '../../planner/src/curve';
import fixture from './ranged-progression-entry.json';
import {parseRangedEntry,rangedComparisonPreset,rangedComparisonChecks,rangedEntryProofChecks,rangedSupportedMethods,RANGED_COMPARISON_PRESET,pointRangedComparisonBot} from './ranged-progression-case';
import * as rangedCase from './ranged-progression-case';
import type {RangedComparisonEntry} from './ranged-progression-case';

test('the case points its bot env at IPv4 127.0.0.1, not localhost',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ranged-case-env-')),envPath=join(dir,'bot.env');
 try{
  writeFileSync(envPath,'BOT_USERNAME=x\nSERVER=localhost:1\nGATEWAY_URL=ws://localhost:2\n');
  pointRangedComparisonBot(envPath,21000);
  const env=readFileSync(envPath,'utf8');
  expect(env).toMatch(/^SERVER=127\.0\.0\.1:21000$/m);
  expect(env).toMatch(/^GATEWAY_URL=ws:\/\/127\.0\.0\.1:21001$/m);
  expect(env).not.toContain('localhost');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

const bytes=(value:unknown)=>Buffer.from(JSON.stringify(value));
const fresh=():RangedComparisonEntry=>{const entry=structuredClone(fixture);entry.skills[5]={...entry.skills[5]!,level:96,currentLevel:53,xp:xpForLevel(96)};return entry;};
const save=(entry:ReturnType<typeof parseRangedEntry>['entry'])=>({version:10,position:entry.pos,vars:{},
 skills:entry.skills.map((s,index)=>({index,xp:s.xp,level:s.currentLevel,rawExperience:s.xp*10})),
 inventories:{93:entry.inventory.map((i,slot)=>({...i,slot})),94:entry.equipment,95:entry.bank.map((i,slot)=>({...i,slot}))}});

test('a captured native band accepts the next finite target without changing fixed comparisons',()=>{
 const input=fresh();input.skills[4]={...input.skills[4]!,level:85,currentLevel:85,xp:xpForLevel(85)};
 expect(rangedCase.rangedPracticeTarget(85,input,{RANGED_PROGRESSION_ENTRY:'captured.json',RANGED_PROGRESSION_TARGET:'90'})).toBe(90);
 expect(rangedCase.rangedPracticeTarget(83,fresh(),{})).toBe(83);
 expect(()=>rangedCase.rangedPracticeTarget(85,input,{RANGED_PROGRESSION_TARGET:'90'})).toThrow();
 expect(rangedCase.rangedPracticeTarget(85,input,{RANGED_PROGRESSION_ENTRY:'captured.json',RANGED_PROGRESSION_TARGET:'99'})).toBe(99);
 for(const target of ['85','84','100','NaN','90.5'])expect(()=>rangedCase.rangedPracticeTarget(85,input,{RANGED_PROGRESSION_ENTRY:'captured.json',RANGED_PROGRESSION_TARGET:target})).toThrow();
});

test('captured practice protects its actual coin stock with the same bounded spend',()=>{
 const input=fresh();expect(rangedCase.rangedPracticeCoins(input)).toEqual({spend:500,reserve:382483});
 input.bank=input.bank.filter(i=>i.id!==995);input.inventory=[{id:995,count:200}];
 expect(rangedCase.rangedPracticeCoins(input)).toEqual({spend:200,reserve:0});
});

test('an override freezes its own exact bytes and presets and checks its observed Prayer96 state',()=>{
 const input=bytes(fresh()),loaded=parseRangedEntry(input),before=save(loaded.entry);
 expect(loaded.sha256).toBe(createHash('sha256').update(input).digest('hex'));
 expect(Buffer.from(loaded.bytes).equals(input)).toBe(true);
 expect(rangedComparisonPreset(loaded.entry).skills?.Prayer).toBe(96);
 expect(rangedComparisonChecks(before,before,null,'',1,83,loaded.entry).exactEntry).toBe(true);
 expect(rangedComparisonChecks(before,before,null,'',1).exactEntry).toBe(false);
 expect(RANGED_COMPARISON_PRESET.skills?.Prayer).toBe(95);
});

test('the tracked default keeps its exact entry SHA and preset',()=>{
 const raw=readFileSync(join(import.meta.dir,'ranged-progression-entry.json')),loaded=parseRangedEntry(raw);
 expect(loaded.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
 expect(rangedComparisonPreset(loaded.entry)).toEqual(RANGED_COMPARISON_PRESET);
});

test('the outer benchmark checks the captured start tile after reading an override',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ranged-entry-')),path=join(dir,'entry.json'),input=fresh();input.pos={x:3252,z:3420,level:0};
 try{
  writeFileSync(path,bytes(input));
  const code="import {PROGRESSION_BENCH_CASES} from './scripts/measure/progression-bench-cases'; process.env.RANGED_PROGRESSION_ENTRY=process.env.TEST_ENTRY; console.log(JSON.stringify(PROGRESSION_BENCH_CASES.map(c=>c.presetConfig?.position)));";
  const p=Bun.spawnSync(['bun','-e',code],{cwd:join(import.meta.dir,'../../..'),env:{...process.env,RANGED_PROGRESSION_ENTRY:'',TEST_ENTRY:path},windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:30000});
  expect(p.exitCode).toBe(0);expect(JSON.parse(p.stdout.toString())).toEqual(Array.from({length:4},()=>input.pos));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('the proof takes a training method and no acquire method, as the worker splits them',async()=>{
 const {isRangedAcquireMethod}=await import('../../../scripts/ranged-train');
 const ids=new Set<string>();
 for(const file of ['scripts/ranged-train.ts'])for(const m of readFileSync(join(import.meta.dir,'../../..',file),'utf8').matchAll(/'(ranged\/[a-z0-9-]+)'/g))ids.add(m[1]!);
 expect(ids.size).toBeGreaterThan(10);
 for(const id of ids)expect([id,rangedCase.rangedTrainingMethod(id)]).toEqual([id,!isRangedAcquireMethod(id)]);
});

test('saved entry verification refuses tampered frozen bytes or detached skill and stock bands',()=>{
 const changed=fresh();changed.bank.find(i=>i.id===882)!.count=147;changed.bank.find(i=>i.id===2142)!.count=40;
 const loaded=parseRangedEntry(bytes(changed)),result={method:'ranged/troopers',bow:841,arrow:882,xpGain:123160};
 const report={entrySha256:loaded.sha256,source:'a'.repeat(64),target:85,supportedMethods:rangedSupportedMethods(loaded.entry,result,'a'.repeat(64),85)};
 expect(rangedEntryProofChecks(loaded.bytes,report,result).supportedMethods).toBe(true);
 // The band is an envelope: a minimum for each combat level and for Ranged, and the Ranged levels of the proof run.
 const band=report.supportedMethods[0]!.bands[0]!;
 expect(band.levels.Prayer).toEqual({min:96});
 expect(band.levels.Ranged).toEqual({min:loaded.entry.skills[4]!.level});
 expect(Object.values(band.levels).every(range=>!('max' in range))).toBe(true);
 // The step bound is the Ranged XP of the proof run, not its levels.
 expect(band.gainXp).toEqual({Ranged:123160});
 // The bow and the arrow of the run are named, so the method must use them for the account.
 expect(band.kit).toEqual([841,882]);
 expect(rangedSupportedMethods(loaded.entry,{...result,xpGain:undefined},report.source,85)[0]!.bands[0]!.gainXp).toEqual({Ranged:0});
 // Every Ranged training method the worker reports gets a band; an acquire step and a foreign id get none.
 expect(rangedSupportedMethods(loaded.entry,{...result,method:'ranged/troopers-maple'},report.source,85)[0]!.id).toBe('ranged/troopers-maple');
 for(const method of ['ranged/lowe-buy-oak','ranged/ge-buy-maple','ranged/guild-buy-willow','magic/splash','Ranged/x',null])
  expect(rangedSupportedMethods(loaded.entry,{...result,method},report.source,85)).toEqual([]);
 expect(report.supportedMethods[0]!.bands[0]!.items).toMatchObject({882:147,2142:40});
 const stale={...report,supportedMethods:rangedSupportedMethods(parseRangedEntry(bytes(fixture)).entry,result,report.source,85)};
 expect(rangedEntryProofChecks(loaded.bytes,stale,result).supportedMethods).toBe(false);
 changed.skills[5]!.xp++;
 expect(()=>rangedEntryProofChecks(bytes(changed),report,result)).toThrow('frozen Ranged entry SHA-256 differs');
});

test('entry validation rejects malformed counts, slots, base XP, current skills and unsettled metadata',()=>{
 for(const mutate of [
  (e:ReturnType<typeof fresh>)=>{e.bank[0]!.count=-1;},
  (e:ReturnType<typeof fresh>)=>{e.bank[0]!.count=2**31;},
  (e:ReturnType<typeof fresh>)=>{e.equipment[1]!.slot=e.equipment[0]!.slot;},
  (e:ReturnType<typeof fresh>)=>{e.skills[5]!.xp=0;},
  (e:ReturnType<typeof fresh>)=>{e.skills[5]!.currentLevel=100;},
  (e:ReturnType<typeof fresh>)=>{e.skills[3]!.currentLevel=0;e.hp.now=0;},
  (e:ReturnType<typeof fresh>)=>{e.skills.reverse();},
  (e:ReturnType<typeof fresh>)=>{e.producer.loggedOutAt=e.at+1;},
  (e:ReturnType<typeof fresh>)=>{e.pos.level=4;},
 ]){const entry=fresh();mutate(entry);expect(()=>parseRangedEntry(bytes(entry))).toThrow('invalid Ranged entry');}
 expect(()=>parseRangedEntry(bytes({...fresh(),server:'private.example'}))).toThrow('invalid Ranged entry');
});
