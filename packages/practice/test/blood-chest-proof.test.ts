import {expect,test} from 'bun:test';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {ADMISSION,ATTACK_DAMAGE_RAW_XP,HITPOINTS_DAMAGE_RAW_XP,STRANDED,bloodChildChecks,bloodObservations,bloodProofAccountEnv,bloodProofPreset,bloodProofSource,bloodResult,bloodSaveChecks,childConfiguration,selectBloodProofEndpoints,startBloodProofStack,thievingRawXp} from '../src/blood-chest-proof';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';
import {runtimeTrees,workerLaunchers} from '../../core/src/worker-release';
import {ARRIVAL,BANK,EXIT_TICKS,STAGE} from '../../../scripts/blood-chest';
import type {readPracticeSave} from '../../../scripts/measure/fleet-player-save';

type Save=ReturnType<typeof readPracticeSave>;
const save=(p:{x:number;z:number;thieving?:number;raw?:number;pack:[number,number][];bank:[number,number][]})=>({position:{...p,level:0},vars:{},
 skills:Array.from({length:21},(_,i)=>({index:i,level:i===17?p.thieving??99:i===3?56:1,xp:0,rawExperience:i===17?p.raw??1000:0})),
 inventories:{93:p.pack.map(([id,count],slot)=>({slot,id,count})),94:[],95:p.bank.map(([id,count],slot)=>({slot,id,count}))}} as unknown as Save);
const before=(id:'entry'|'exit'|'refusal')=>save({...(id==='exit'?STAGE:ARRIVAL),thieving:id==='refusal'?58:99,pack:[[1895,3],[995,40]],bank:[[995,1000],[314,7]]});
const ENTRY_RAW_XP=thievingRawXp(2,2);
const banked=save({...BANK,raw:1000+ENTRY_RAW_XP,pack:[[1895,3]],bank:[[995,2040],[314,7],[565,4]]});
const entryResult={ok:true,stop:'target',targetMet:true,conserved:true,loots:2,runes:4,coins:1000,bankedRunes:4,bankedCoins:1040,entries:2,died:false,hpMin:50};
const fought=(s:Save,attack:number,hitpoints:number)=>{const c=structuredClone(s);c.skills[0]!.rawExperience+=attack;c.skills[3]!.rawExperience+=hitpoints;return c;};
const pass=(checks:Record<string,boolean>)=>Object.entries(checks).filter(([,v])=>!v).map(([k])=>k);

test('admission uses the shared memory limits',()=>{
 expect(ADMISSION).toEqual({floorGb:FREE_FLOOR_GB,startupGb:PRACTICE_STARTUP_GB});
});
test('the Blood proof source ignores unrelated code and binds its worker, harness and server content',()=>{
 const base=mkdtempSync(join(tmpdir(),'blood-source-'));
 const put=(path:string,text='')=>{const file=join(base,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);};
 for(const path of runtimeTrees)mkdirSync(join(base,path),{recursive:true});
 for(const path of [...Object.keys(bloodProofSource().files),...workerLaunchers,'package.json','bun.lock','tsconfig.json'])put(path);
 put('scripts/blood-chest.ts',"import './blood-fixture';");
 put('scripts/blood-fixture.ts');
 put('packages/practice/src/blood-chest-proof.ts',"import './blood-fixture';");
 put('packages/practice/src/blood-fixture.ts');
 const source=bloodProofSource(base);
 put('packages/core/src/replay.ts','unrelated change');
 expect(bloodProofSource(base)).toEqual(source);
 put('scripts/blood-fixture.ts','worker dependency');
 const worker=bloodProofSource(base);
 expect(worker.runtime).not.toBe(source.runtime);
 put('packages/practice/src/blood-fixture.ts','proof dependency');
 const harness=bloodProofSource(base);
 expect(harness.runtime).not.toBe(worker.runtime);
 const server=Object.keys(harness.files).find(path=>path.endsWith('/trapped_chest.rs2'))!;
 put(server,'server content');
 expect(bloodProofSource(base).files[server]).not.toBe(harness.files[server]);
});
test('owned endpoints reach the stack, new fixture and finite CLI child and restore the parent',async()=>{
 const checked:number[]=[],samples=[0,0.01];
 const p=selectBloodProofEndpoints(port=>{checked.push(port);return port!==20003;},()=>samples.shift()!);
 expect(checked).toEqual([20000,20001,20002,20003,20200,20201,20202,20203]);
 expect(p.ports).toEqual({engine:20200,gateway:20201,management:20202,tcp:20203});
 const original='SERVER=localhost:8888\r\nGATEWAY_URL=ws://localhost:7780\r\nPASSWORD=fixture\r\n';
 const configured=bloodProofAccountEnv(original,p);
 expect(configured).toContain(`SERVER=${p.server}\r\n`);expect(configured).toContain(`GATEWAY_URL=${p.gateway}\r\n`);
 expect(()=>bloodProofAccountEnv(original.replace('localhost:8888','rs-sdk-demo.fly.dev'),p)).toThrow('new practice account required');
 const previous=Object.fromEntries(Object.keys(p.env).map(k=>[k,process.env[k]]));
 const owned={logs:{engine:'',gateway:''},stop:async()=>{}};
 const stack=await startBloodProofStack(p,async opts=>{
  expect(opts).toEqual({ports:p.ports,instance:p.instance,tickMs:150,xpRate:25,readyTimeoutMs:60000});
  for(const [k,v] of Object.entries(p.env))expect(process.env[k]).toBe(v);
  return owned;
 });
 expect(stack).toBe(owned);
 expect(Object.fromEntries(Object.keys(p.env).map(k=>[k,process.env[k]]))).toEqual(previous);
 const child=childConfiguration('fixture','entry',{GATEWAY_URL:'ws://localhost:7780'},p);
 expect(child.cmd).toEqual(['bun','scripts/blood-chest.ts','fixture','2500']);
 expect(child.env).toMatchObject({GATEWAY_URL:p.gateway,MAX_LOOTS:'2',CAP:'2500',RANDOM_EVENTS:'0',DEMO_OK:''});
 expect(childConfiguration('fixture','exit',{},p).cmd.at(-1)).toBe(String(EXIT_TICKS));
});
test('the entry case needs the banked reward, exact XP and kept assets',()=>{
 expect(pass(bloodSaveChecks(before('entry'),banked,entryResult,'entry'))).toEqual([]);
 const short=save({...BANK,raw:1000+ENTRY_RAW_XP,pack:[[1895,3]],bank:[[995,2040],[314,7],[565,2]]});
 expect(pass(bloodSaveChecks(before('entry'),short,entryResult,'entry'))).toContain('output');
 const lost=save({...BANK,raw:1000+ENTRY_RAW_XP,pack:[[1895,2]],bank:[[995,2040],[314,7],[565,4]]});
 expect(pass(bloodSaveChecks(before('entry'),lost,entryResult,'entry'))).toContain('assets');
 const carried=save({...BANK,raw:1000+ENTRY_RAW_XP,pack:[[1895,3],[565,4]],bank:[[995,2040],[314,7]]});
 expect(pass(bloodSaveChecks(before('entry'),carried,entryResult,'entry'))).toContain('output');
 const elsewhere=save({...ARRIVAL,raw:1000+ENTRY_RAW_XP,pack:[[1895,3]],bank:[[995,2040],[314,7],[565,4]]});
 expect(pass(bloodSaveChecks(before('entry'),elsewhere,entryResult,'entry'))).toContain('place');
 expect(pass(bloodSaveChecks(before('entry'),banked,{...entryResult,ok:false},'entry'))).toContain('target');
 expect(pass(bloodSaveChecks(before('entry'),save({...BANK,pack:[[1895,3]],bank:[[995,2040],[314,7],[565,4]]}),entryResult,'entry'))).toContain('xp');
});
test('Thieving XP is exact for the observed door entries',()=>{
 // The retained saves hold these raw rises: 3 chests with 4 doors, and 2 chests with 3 doors.
 expect(thievingRawXp(3,4)).toBe(225000);expect(thievingRawXp(2,3)).toBe(153125);
 const again=save({...BANK,raw:1000+thievingRawXp(2,3),pack:[[1895,3]],bank:[[995,2040],[314,7],[565,4]]});
 expect(pass(bloodSaveChecks(before('entry'),again,{...entryResult,entries:3},'entry'))).toEqual([]);
 expect(pass(bloodSaveChecks(before('entry'),again,entryResult,'entry'))).toContain('xp');
 expect(pass(bloodSaveChecks(before('entry'),again,{...entryResult,entries:4},'entry'))).toContain('xp');
 const {entries:_,...unknown}=entryResult;
 expect(pass(bloodSaveChecks(before('entry'),banked,unknown,'entry'))).toContain('xp');
 const short=save({...BANK,raw:1000+thievingRawXp(2,1),pack:[[1895,3]],bank:[[995,2040],[314,7],[565,4]]});
 expect(pass(bloodSaveChecks(before('entry'),short,{...entryResult,entries:1},'entry'))).toContain('xp');
});
test('only the pinned melee XP pair may rise beside Thieving',()=>{
 // The retained saves hold these raw rises: 5 damage in entry and 7 damage in stranded.
 expect([5*ATTACK_DAMAGE_RAW_XP,5*HITPOINTS_DAMAGE_RAW_XP]).toEqual([5000,1625]);
 expect([7*ATTACK_DAMAGE_RAW_XP,7*HITPOINTS_DAMAGE_RAW_XP]).toEqual([7000,2275]);
 expect(pass(bloodSaveChecks(before('entry'),fought(banked,5000,1625),entryResult,'entry'))).toEqual([]);
 expect(pass(bloodSaveChecks(before('entry'),fought(banked,5000,1626),entryResult,'entry'))).toContain('skills');
 expect(pass(bloodSaveChecks(before('entry'),fought(banked,0,1625),entryResult,'entry'))).toContain('skills');
 expect(pass(bloodSaveChecks(before('entry'),fought(banked,500,162),entryResult,'entry'))).toContain('skills');
 const strength=fought(banked,5000,1625);strength.skills[2]!.rawExperience+=5000;
 expect(pass(bloodSaveChecks(before('entry'),strength,entryResult,'entry'))).toContain('skills');
 const refused={ok:false,stop:'refused',failure:'Error: blood chest refused: Thieving 58 is below level 59'};
 expect(pass(bloodSaveChecks(before('refusal'),fought(before('refusal'),5000,1625),refused,'refusal'))).toContain('skills');
});
test('the exit case banks the carried coins from the dungeon with no loot',()=>{
 const after=save({...BANK,pack:[[1895,3]],bank:[[995,1040],[314,7]]});
 const result={ok:false,stop:'cap',targetMet:false,conserved:true,loots:0,runes:0,coins:0,bankedRunes:0,bankedCoins:40,entries:0,died:false,hpMin:56};
 expect(pass(bloodSaveChecks(before('exit'),after,result,'exit'))).toEqual([]);
 expect(pass(bloodSaveChecks(before('exit'),after,{...result,stop:'failed'},'exit'))).toContain('target');
});
test('stranded entry retains six carried runes and twelve banked runes with the new four-rune output',()=>{
 const fixture=bloodProofPreset('stranded');
 expect(fixture.position).toEqual({...STRANDED,level:0});
 expect(fixture.skills).toEqual({Thieving:99,Attack:62,Defence:10,Strength:12,Hitpoints:47,Agility:1});
 expect(fixture.inventory?.filter(i=>i.id===379)).toHaveLength(26);
 const start=save({...STRANDED,pack:[[995,1500],[379,26],[565,6]],bank:[[995,178422],[565,12],[379,74]]});
 start.skills[3]!.level=32;
 const end=fought(save({...BANK,raw:1000+thievingRawXp(2,3),pack:[[379,26]],bank:[[995,180922],[565,22],[379,74]]}),7000,2275);
 const result={...entryResult,bankedRunes:10,bankedCoins:2500,startRunes:6,startCoins:1500,entries:3,meals:0};
 expect(pass(bloodSaveChecks(start,end,result,'stranded'))).toEqual([]);
 expect(pass(bloodChildChecks(0,false,'LOGOUT logged-out\nRESULT ok {}\n','stranded'))).toEqual([]);
 const missing=structuredClone(end);missing.inventories[95]!.find(i=>i.id===565)!.count=16;
 expect(pass(bloodSaveChecks(start,missing,result,'stranded'))).toContain('output');
 const lostFood=structuredClone(end);lostFood.inventories[93]![0]!.count=25;
 expect(pass(bloodSaveChecks(start,lostFood,result,'stranded'))).toContain('assets');
 expect(pass(bloodSaveChecks(start,lostFood,{...result,meals:1},'stranded'))).toEqual([]);
 expect(childConfiguration('fixture','stranded',{}).cmd).toEqual(['bun','scripts/blood-chest.ts','fixture','2500']);
});
test('the refusal case moves nothing and names the level',()=>{
 const result={ok:false,stop:'refused',failure:'Error: blood chest refused: Thieving 58 is below level 59'};
 expect(pass(bloodSaveChecks(before('refusal'),before('refusal'),result,'refusal'))).toEqual([]);
 expect(pass(bloodSaveChecks(before('refusal'),before('refusal'),{...result,failure:'other'},'refusal'))).toContain('target');
 expect(pass(bloodSaveChecks(before('refusal'),save({...BANK,thieving:58,pack:[[1895,3],[995,40]],bank:[[995,1000],[314,7]]}),result,'refusal'))).toContain('place');
});
test('child checks need the exit code, one confirmed logout and the result line',()=>{
 const ok='LOGOUT logged-out\r\nRESULT ok {}\r\n',fail='LOGOUT logged-out\nRESULT fail x\n';
 expect(pass(bloodChildChecks(0,false,ok,'entry'))).toEqual([]);
 expect(pass(bloodChildChecks(1,false,fail,'refusal'))).toEqual([]);
 expect(pass(bloodChildChecks(0,false,ok+'WARN logout did not complete: x\n','entry'))).toContain('logout');
 expect(pass(bloodChildChecks(0,false,'RESULT ok {}\n','entry'))).toContain('logout');
 expect(pass(bloodChildChecks(0,true,ok,'entry'))).toContain('exit');
 expect(pass(bloodChildChecks(0,false,fail,'exit'))).toContain('exit');
});
test('worker lines parse into the result and the route observations',()=>{
 const log='BLOOD_TRIP {"ticks":40,"picks":3,"hp":56,"npcs":["Ogre"]}\nBLOOD_LOOT {"loot":1}\nBLOOD_BANK {"trip":1}\nBLOOD_CHEST_RESULT {"ok":true}\n';
 expect(bloodResult(log)).toEqual({ok:true});expect(bloodResult('BLOOD_CHEST_RESULT nope')).toBeNull();
 expect(bloodObservations(log)).toEqual({trips:[{ticks:40,picks:3,hp:56,npcs:['Ogre']}],loots:[{loot:1}],banks:[{trip:1}]});
});
