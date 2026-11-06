import {expect,test} from 'bun:test';
import {ADMISSION,ENTRY_RAW_XP,bloodChildChecks,bloodObservations,bloodProofAccountEnv,bloodResult,bloodSaveChecks,childConfiguration,selectBloodProofEndpoints,startBloodProofStack} from '../src/blood-chest-proof';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';
import {ARRIVAL,BANK,EXIT_TICKS,STAGE} from '../../../scripts/blood-chest';
import type {readPracticeSave} from '../../../scripts/measure/fleet-player-save';

type Save=ReturnType<typeof readPracticeSave>;
const save=(p:{x:number;z:number;thieving?:number;raw?:number;pack:[number,number][];bank:[number,number][]})=>({position:{...p,level:0},vars:{},
 skills:Array.from({length:21},(_,i)=>({index:i,level:i===17?p.thieving??99:i===3?56:1,xp:0,rawExperience:i===17?p.raw??1000:0})),
 inventories:{93:p.pack.map(([id,count],slot)=>({slot,id,count})),94:[],95:p.bank.map(([id,count],slot)=>({slot,id,count}))}} as unknown as Save);
const before=(id:'entry'|'exit'|'refusal')=>save({...(id==='exit'?STAGE:ARRIVAL),thieving:id==='refusal'?58:99,pack:[[1895,3],[995,40]],bank:[[995,1000],[314,7]]});
const banked=save({...BANK,raw:1000+ENTRY_RAW_XP,pack:[[1895,3]],bank:[[995,2040],[314,7],[565,4]]});
const entryResult={ok:true,stop:'target',targetMet:true,conserved:true,loots:2,runes:4,coins:1000,bankedRunes:4,bankedCoins:1040,died:false,hpMin:50};
const pass=(checks:Record<string,boolean>)=>Object.entries(checks).filter(([,v])=>!v).map(([k])=>k);

test('admission uses the shared memory limits',()=>{
 expect(ADMISSION).toEqual({floorGb:FREE_FLOOR_GB,startupGb:PRACTICE_STARTUP_GB});
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
test('the exit case banks the carried coins from the dungeon with no loot',()=>{
 const after=save({...BANK,pack:[[1895,3]],bank:[[995,1040],[314,7]]});
 const result={ok:false,stop:'cap',targetMet:false,conserved:true,loots:0,runes:0,coins:0,bankedRunes:0,bankedCoins:40,died:false,hpMin:56};
 expect(pass(bloodSaveChecks(before('exit'),after,result,'exit'))).toEqual([]);
 expect(pass(bloodSaveChecks(before('exit'),after,{...result,stop:'failed'},'exit'))).toContain('target');
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
