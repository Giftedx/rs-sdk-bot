import {test,expect} from 'bun:test';
import {proveInProcess,okPass,type InProcessDeps} from '../src/prove';
const state=(crafted=false,banked=false)=>({version:9,position:{x:2841,z:4830,level:0},skills:Array.from({length:21},(_,i)=>({index:i,rawExperience:i===20&&crafted?1350:0,xp:i===20&&crafted?135:0,level:1})),vars:{},inventories:{93:[{slot:0,id:1438,count:1},...(crafted?(banked?[]:[{slot:1,id:556,count:27}]):[{slot:1,id:1436,count:27}])],95:banked?[{slot:0,id:556,count:27}]:[]}});
for(const mode of ['unchanged','bank-only','wrong-account','wrong-source','zero-xp','partial','crafted'] as const)test(`rcair independent outcome: ${mode}`,async()=>{
 const order:string[]=[];
 const deps:InProcessDeps={prepare:async()=>{order.push('prepare');},run:async()=>{order.push('run');return{stdout:'START 2841 4830 0\nRESULT ok',exitCode:0};},cleanup:async()=>{order.push('cleanup');},
  snapshot:async(bot,phase)=>{order.push(phase);const save=state(phase==='after'&&mode!=='unchanged',mode==='bank-only');if(phase==='after'&&mode==='zero-xp')save.skills[20]!.rawExperience=0;if(phase==='after'&&mode==='partial')save.inventories[93]!.push({slot:2,id:1436,count:1});return{bot:mode==='wrong-account'?'otherbot':bot,sourcePath:phase==='after'&&mode==='wrong-source'?`other/${bot}.sav`:`${bot}.sav`,path:`${bot}-${phase}.sav`,sha256:phase==='before'||mode==='unchanged'?'a'.repeat(64):'b'.repeat(64),save};}} as InProcessDeps;
 const result=await proveInProcess({bot:'proof',script:'inert',runs:1,preset:'rc_air_inside',pass:okPass,outcome:'rcair'},deps);
 expect(result.passes).toBe(mode==='crafted'?1:0);
 expect(result.results[0]!.logOk).toBe(mode!=='wrong-account');
 expect(result.results[0]!.outcome?.ok).toBe(mode==='crafted');
 expect(order.indexOf('cleanup')).toBeGreaterThan(order.indexOf(mode==='wrong-account'?'before':'after'));
 if(mode==='wrong-account')expect(order).not.toContain('run');
});
test('rcair missing independent snapshot support fails closed',async()=>{
 const result=await proveInProcess({bot:'proof',script:'inert',runs:1,preset:'rc_air_inside',pass:okPass,outcome:'rcair'},{prepare:async()=>{},run:async()=>({stdout:'START 2841 4830 0\nRESULT ok',exitCode:0}),cleanup:async()=>{}});
 expect(result.passes).toBe(0);
});

import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createSaveData} from '../../../vendor/rs-sdk/sdk/test/utils/save-generator';
import {readPracticeSave} from '../../../scripts/measure/fleet-player-save';
test('actual CRC checked binary save is read after work and before cleanup',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rcair-proof-'));
 let actor='',source='';
 const initial=()=>Buffer.from(createSaveData({position:{x:2841,z:4830,level:0},inventory:[{id:1438,count:1},...Array.from({length:27},()=>({id:1436,count:1}))]}));
 const final=()=>{const data=Buffer.from(createSaveData({position:{x:2841,z:4830,level:0},inventory:[{id:1438,count:1},{id:556,count:27}]}));data.writeInt32BE(1350,128);data.writeUInt8(2,132);data.writeUInt32BE(Bun.hash.crc32(data.subarray(0,-4))>>>0,data.length-4);return data;};
 try{
  const deps:InProcessDeps={prepare:async bot=>{actor=bot;source=join(dir,`${bot}.sav`);writeFileSync(source,initial());},run:async()=>{writeFileSync(source,final());return{stdout:'START 2841 4830 0\nRESULT ok',exitCode:0};},cleanup:async()=>{expect(readPracticeSave(source).inventories[93]?.some(i=>i.id===556)).toBe(true);},snapshot:async(bot,phase)=>{const path=join(dir,`${phase}.sav`),bytes=readFileSync(source);writeFileSync(path,bytes);return{bot,sourcePath:source,path,sha256:createHash('sha256').update(bytes).digest('hex'),save:readPracticeSave(path)};}};
  const result=await proveInProcess({bot:'rcproof',script:'inert',runs:1,preset:'rc_air_inside',pass:okPass,outcome:'rcair'},deps);
  expect(result.passes).toBe(1);expect(result.results[0]!.outcome?.before?.bot).toBe(actor);expect(result.results[0]!.outcome?.after?.sha256).not.toBe(result.results[0]!.outcome?.before?.sha256);
  const broken=readFileSync(join(dir,'after.sav'));broken[10]^=1;writeFileSync(join(dir,'after.sav'),broken);expect(()=>readPracticeSave(join(dir,'after.sav'))).toThrow('CRC');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

import {snapshotPracticeSave} from '../src/prove-outcome';
import {rsSdkRoot} from '../src/paths';
import {existsSync,mkdirSync} from 'node:fs';
test('real snapshot backend waits for CRC valid publication and retains exact proof bytes',async()=>{
 const bot=`rcp${Date.now().toString(36)}`;
 const directory=join(rsSdkRoot(),'server/engine/data/players/main'),source=join(directory,`${bot}.sav`);
 if(existsSync(source))throw new Error('test account already has a save');
 mkdirSync(directory,{recursive:true});
 const initial=Buffer.from(createSaveData({position:{x:2841,z:4830,level:0},inventory:[{id:1438,count:1},...Array.from({length:27},()=>({id:1436,count:1}))]}));
 const final=Buffer.from(createSaveData({position:{x:2841,z:4830,level:0},inventory:[{id:1438,count:1},{id:556,count:27}]}));final.writeInt32BE(1350,128);final.writeUInt8(2,132);final.writeUInt32BE(Bun.hash.crc32(final.subarray(0,-4))>>>0,final.length-4);
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  writeFileSync(source,initial);
  const before=await snapshotPracticeSave(bot,'before');
  timer=setTimeout(()=>writeFileSync(source,final),10);
  const after=await snapshotPracticeSave(bot,'after',s=>s.save.skills[20]!.rawExperience===1350);
  expect(after.sha256).not.toBe(before.sha256);
  expect(createHash('sha256').update(readFileSync(after.path)).digest('hex')).toBe(after.sha256);
  expect(readPracticeSave(after.path).skills[20]!.xp).toBe(135);
  expect(after.sourcePath).toBe(source);
 }finally{if(timer)clearTimeout(timer);rmSync(source,{force:true});}
});

import {verifyOutcome} from '../src/prove-outcome';
test('default25x stack XP multiplier satisfies the task contract',()=>{
 const before={bot:'inert',sourcePath:'inert.sav',path:'before.sav',sha256:'a'.repeat(64),save:state(false)};
 const after={bot:'inert',sourcePath:'inert.sav',path:'after.sav',sha256:'b'.repeat(64),save:state(true)};
 // runecraft_air experience50 *27 essence; Player.addXp applies stack's default25.
 after.save.skills[20]!.rawExperience=50*27*25;
 expect(verifyOutcome('rcair','inert',before,after).ok).toBe(true);
});

