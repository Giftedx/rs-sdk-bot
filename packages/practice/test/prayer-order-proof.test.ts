import {test,expect} from 'bun:test';
import {prayerFixture,childConfiguration,saveChecks,childChecks,savedBurials,ENTRY,ENTRY_SKILLS,cases,NATIVE_ADMISSION_GB,selectPrayerProofEndpoints,prayerProofAccountEnv,startPrayerProofStack} from '../src/prayer-order-proof';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';
import {levelForXp} from '../../planner/src/curve';
import type {readPracticeSave} from '../../../scripts/measure/fleet-player-save';
type Save=ReturnType<typeof readPracticeSave>;
test('isolated endpoints reach stack, generated account and actual CLI child without changing the parent',async()=>{
 const checked:number[]=[],samples=[0,0.01];
 const p=selectPrayerProofEndpoints(port=>{checked.push(port);return port!==20003;},()=>samples.shift()!);
 expect(checked).toEqual([20000,20001,20002,20003,20200,20201,20202,20203]);
 expect(p.ports).toEqual({engine:20200,gateway:20201,management:20202,tcp:20203});
 expect(p.instance).toMatch(/^prayer-[a-z0-9-]{1,25}$/);
 const original='SERVER=localhost:8888\r\nGATEWAY_URL=ws://localhost:7780\r\nPASSWORD=fixture\r\n';
 const configured=prayerProofAccountEnv(original,p);
 expect(configured).toContain(`SERVER=${p.server}\r\n`);
 expect(configured).toContain(`GATEWAY_URL=${p.gateway}\r\n`);
 expect(configured).toContain('PASSWORD=fixture\r\n');
 expect(()=>prayerProofAccountEnv(original.replace('localhost:8888','rs-sdk-demo.fly.dev'),p)).toThrow('new practice account required');
 const previous=Object.fromEntries(Object.keys(p.env).map(k=>[k,process.env[k]]));
 let calls=0;
 const start=async(opts:any)=>{
  calls++;expect(opts).toEqual({ports:p.ports,instance:p.instance,tickMs:150,xpRate:25,readyTimeoutMs:60000});
  for(const [k,v] of Object.entries(p.env))expect(process.env[k]).toBe(v);
  return{logs:{engine:'',gateway:''},stop:async()=>{}};
 };
 await startPrayerProofStack(p,start);expect(calls).toBe(1);
 expect(Object.fromEntries(Object.keys(p.env).map(k=>[k,process.env[k]]))).toEqual(previous);
 await expect(startPrayerProofStack(p,async()=>{throw Error('startup refused');})).rejects.toThrow('startup refused');
 expect(Object.fromEntries(Object.keys(p.env).map(k=>[k,process.env[k]]))).toEqual(previous);
 const child=childConfiguration('flprayx001',{GATEWAY_URL:'ws://localhost:7780',WEB_MANAGEMENT_PORT:'8898',NODE_PORT:'43594'},p);
 expect(child.cmd).toEqual(['bun','scripts/train-prayer.ts','flprayx001','60']);
 expect(child.env).toMatchObject({...p.env,GATEWAY_URL:p.gateway,DEMO_OK:'',CAP:'5000',MAX_BURY:'600',BONE_RESERVE:'384'});
 expect(child.env.GE_DATABASE).toBe(`data/market-${p.instance}.sqlite`);
 expect(child.windowsHide).toBe(true);
 expect(()=>selectPrayerProofEndpoints(()=>false,()=>0)).toThrow('owned practice ports unavailable');
});
function fixture(kind:'entry'|'short'='entry'):Save{
 const f=prayerFixture(kind),items=(v:{id:number;count:number;slot?:number}[])=>v.map((i,slot)=>({...i,slot:i.slot??slot}));
 return{version:6,position:{...ENTRY},vars:{134:0},skills:ENTRY_SKILLS.map((s,index)=>({index,level:s.level,xp:s.xp,rawExperience:s.xp*10})),
  inventories:{93:items(f.inventory!),94:items(f.equipment!),95:items(f.bank!)}};
}
function completed(before:Save,kind:'entry'|'short'='entry'){
 const after=structuredClone(before);after.position={x:3092,z:3243,level:0};after.vars[134]=100;
 if(kind==='entry'){after.skills[5]={index:5,rawExperience:662625,xp:66262,level:60};after.inventories[95]!.find(i=>i.id===526)!.count-=589;}
 return after;
}
const entryLine='PRAYER_ENTRY '+JSON.stringify({position:ENTRY,xp:0,hp:69,target:60,cap:5000,maximum:600,reserve:384});
function log(kind:'entry'|'short'='entry'){
 const r=kind==='entry'?{ok:true,targetMet:true,target:60,buried:589,consumed:589,attempts:589,boneBank:384,heldBones:0,finalXp:66262,finalLevel:60,
  rateVerified:true,firstBoneXp:112,toggledOn:true,toggledOff:true,prayerPointsOn:60,preserved:true,equipmentPreserved:true,hpMin:69,died:false,stop:'target-level',ticks:1500}
  :{ok:false,buried:0,consumed:0,attempts:0,boneBank:972,preserved:true,toggledOn:false,toggledOff:true,hpMin:69,died:false,
    failure:'no prayer progress: insufficient owned bones: need 589, available 588'};
 return`${entryLine}\nPRAYER_BANK ${JSON.stringify(r)}\nLOGOUT logged-out\nRESULT ${kind==='entry'?'ok':'fail'} mode=prayer\n`;
}
test('admission uses shared memory limits and proof has only useful entry and one refusal',()=>{
 expect(NATIVE_ADMISSION_GB).toBe(Math.max(FREE_FLOOR_GB,PRACTICE_STARTUP_GB));expect(cases).toEqual(['entry','short']);
 const f=prayerFixture('entry');expect(f.position).toEqual(ENTRY);expect(f.skills?.Prayer).toBe(1);expect(f.skills?.Hitpoints).toBe(69);
 expect(f.bank).toContainEqual({id:526,count:973});expect(f.bank).toContainEqual({id:995,count:454160});
 expect(prayerFixture('short').bank).toContainEqual({id:526,count:972});
 const c=childConfiguration('flprayx001',{PATH:'p',DEMO_OK:'1',TARGET_LEVEL:'99',CAP:'1'});
 expect(c.cmd).toEqual(['bun','scripts/train-prayer.ts','flprayx001','60']);
 expect(c.env).toMatchObject({PATH:'p',DEMO_OK:'',RANDOM_EVENTS:'0',CAP:'5000',MAX_BURY:'600',BONE_RESERVE:'384',TARGET_LEVEL:'60'});expect(c.windowsHide).toBe(true);
});
test('saved raw XP requires589 actual bones,384reserved, all unrelated assets, skills and worn slots',()=>{
 const before=fixture(),after=completed(before);expect(savedBurials(before,after)).toBe(589);expect(levelForXp(after.skills[5]!.xp)).toBe(60);
 expect(Object.values(saveChecks(before,after,'entry')).every(Boolean)).toBe(true);
 let bad=structuredClone(after);bad.skills[5]!.rawExperience++;expect(saveChecks(before,bad,'entry').xp).toBe(false);
 bad=structuredClone(after);bad.inventories[95]!.find(i=>i.id===526)!.count--;expect(saveChecks(before,bad,'entry').bones).toBe(false);
 bad=structuredClone(after);bad.inventories[95]!.find(i=>i.id===995)!.count--;expect(saveChecks(before,bad,'entry').assets).toBe(false);
 bad=structuredClone(after);bad.inventories[94]![0]!.slot++;expect(saveChecks(before,bad,'entry').equipment).toBe(false);
 bad=structuredClone(after);bad.skills[4]!.rawExperience++;expect(saveChecks(before,bad,'entry').skills).toBe(false);
 bad=structuredClone(after);bad.position={...ENTRY};expect(saveChecks(before,bad,'entry').position).toBe(false);
 bad=structuredClone(after);bad.vars[134]=0;expect(saveChecks(before,bad,'entry').savedLogout).toBe(false);
 bad=structuredClone(after);bad.skills[3]!.level--;expect(saveChecks(before,bad,'entry').alive).toBe(false);
});
test('short-stock refusal must preserve every bone and unrelated asset after ordinary bank travel',()=>{
 const before=fixture('short'),after=completed(before,'short');expect(Object.values(saveChecks(before,after,'short')).every(Boolean)).toBe(true);
 const child={code:1,timedOut:false};expect(Object.values(childChecks(child,log('short'),'short')).every(Boolean)).toBe(true);
 after.inventories[95]!.find(i=>i.id===526)!.count--;expect(saveChecks(before,after,'short').bones).toBe(false);
 expect(childChecks(child,log('short').replace('insufficient owned bones','bank unavailable'),'short').result).toBe(false);
});
test('CLI success needs target, exact costs, protection ON with points then OFF, and confirmed logout',()=>{
 const child={code:0,timedOut:false},good=log();expect(Object.values(childChecks(child,good,'entry')).every(Boolean)).toBe(true);
 for(const [from,to] of [['"toggledOff":true','"toggledOff":false'],['"prayerPointsOn":60','"prayerPointsOn":0'],['"buried":589','"buried":590'],['"hpMin":69','"hpMin":68']])
  expect(childChecks(child,good.replace(from!,to!),'entry').result).toBe(false);
 expect(childChecks({code:0,timedOut:true},good,'entry').exit).toBe(false);
 expect(childChecks(child,good.replace('LOGOUT logged-out','LOGOUT timed-out'),'entry').logout).toBe(false);
 expect(childChecks(child,good+'LOGOUT logged-out\n','entry').logout).toBe(false);
 expect(childChecks(child,good.replace('"x":3237','"x":3092'),'entry').entry).toBe(false);
});
