import {expect,test} from 'bun:test';
import {goldfarmResult,goldfarmSaveChecks,goldfarmChildChecks,goldfarmFaultPreload,cases,WORKER_ENV,goldfarmDoorChecks,doorCases,DOOR_ENV,DOOR_DIR,DOOR_CARRIED} from '../src/goldfarm-order-proof';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('native fault preload forwards real calls without recursion, fails after earning, then controls recovery',()=>{
 const directory=mkdtempSync(join(tmpdir(),'goldfarm-preload-'));
 try {
  const module=join(directory,'walk.ts'),preload=join(directory,'fault.ts'),entry=join(directory,'check.ts');
  writeFileSync(module,'export const sessionWalker=async(s)=>s;export const walkPath=async()=>({ok:true});');
  writeFileSync(entry,`import {sessionWalker,walkPath} from './walk';let coins=0;const d=await sessionWalker({sdk:{getState:()=>({inventory:[{id:995,count:coins}]})}});
console.log(JSON.stringify(await walkPath(d,[{z:3283}])));coins=2000;
console.log(JSON.stringify(await walkPath(d,[{z:3283}])));
console.log(JSON.stringify(await walkPath(d,[{z:3302}])));`);
  for(const fail of [true,false]){
   writeFileSync(preload,goldfarmFaultPreload(module,fail));
   const child=Bun.spawnSync([process.execPath,'--preload',preload,entry],{timeout:5000,windowsHide:true});
   expect(child.exitCode).toBe(0);
   const results=child.stdout.toString().split(/\r?\n/).filter(l=>l.startsWith('{')).map(l=>JSON.parse(l));
   expect(results).toEqual([{ok:true},{ok:false,detail:'proof injected route failure'},fail?{ok:false,detail:'proof injected recovery failure'}:{ok:true}]);
  }
 } finally {rmSync(directory,{recursive:true,force:true});}
});

const skills=(thieving:number,xp:number)=>Array.from({length:21},(_,index)=>({index,level:index===17?thieving:index===3?10:1,xp:0,rawExperience:index===17?xp:index===3?11540:0}));
function fixture(){
 const before:any={position:{x:2654,z:3283,level:0},skills:skills(99,130344310),vars:{134:5},inventories:{
  93:[{slot:0,id:1265,count:1},{slot:1,id:590,count:1},{slot:2,id:995,count:37}],94:[{slot:3,id:1277,count:1},{slot:5,id:1171,count:1}],
  95:[{slot:0,id:995,count:1000},{slot:1,id:440,count:5},{slot:2,id:333,count:10},{slot:3,id:329,count:4},{slot:4,id:385,count:3}]}};
 const after=structuredClone(before);after.vars[134]=9;after.position={x:2655,z:3284,level:0};after.skills[17].rawExperience+=500000;after.skills[3].level=7;
 after.inventories[93]=[{slot:0,id:333,count:1},{slot:1,id:333,count:1},{slot:2,id:333,count:1},{slot:3,id:333,count:1},{slot:4,id:333,count:1},{slot:5,id:333,count:1},{slot:6,id:333,count:1},{slot:7,id:333,count:1},{slot:8,id:329,count:1},{slot:9,id:329,count:1},{slot:10,id:329,count:1},{slot:11,id:329,count:1},{slot:12,id:385,count:1},{slot:13,id:385,count:1},{slot:14,id:385,count:1}];
 after.inventories[95]=[{slot:0,id:995,count:6037},{slot:1,id:440,count:5},{slot:2,id:1265,count:1},{slot:3,id:590,count:1}];
 const result={ok:true,reason:'',ticks:600,picks:110,fails:10,coinsGained:5000,coinsExact:true,banked:5037,packCoins:0,coins0:37,eaten:2,eatenById:{333:2},food:15,idleTicks:3,bankTrips:3,hpMin:4,hp:7,died:false,randomEvents:true};
 return {before,after,result};
}
const pass=(c:Record<string,boolean>)=>Object.values(c).every(Boolean);

test('installed earning case proves new coins, matched food debit, kept kit, life and bank position',()=>{
 const {before,after,result}=fixture();
 expect(goldfarmSaveChecks(before,after,result,'earn',99,true)).toEqual({entry:true,target:true,coins:true,food:true,premium:true,assets:true,skills:true,life:true});
});

test('unbanked income, unexplained food loss, lost kit, death, other XP and a short batch reject the proof',()=>{
 const mutations:[string,(b:any,a:any,r:any)=>void][]=[
  ['coins',(_,a)=>a.inventories[93].push({slot:20,id:995,count:50})],
  ['coins',(_,__,r)=>r.coinsGained=5037], // starting pack coins are not income
  ['food',(_,a)=>a.inventories[93].shift()],
  ['food',(_,__,r)=>r.eaten=3],
  ['premium',(_,__,r)=>{r.eatenById={385:1,333:1};}],
  ['assets',(_,a)=>a.inventories[95].splice(2,1)],
  ['assets',(_,a)=>a.inventories[94].pop()],
  ['life',(_,__,r)=>r.died=true],
  ['life',(_,a)=>a.position={x:3222,z:3218,level:0}],
  ['skills',(_,a)=>a.skills[14].rawExperience++],
  ['target',(_,__,r)=>{r.coinsGained=900;}],
  ['entry',b=>b.skills[3].level=9],
 ];
 for(const [key,mutate] of mutations){
  const {before,after,result}=fixture();mutate(before,after,result);
  expect(goldfarmSaveChecks(before,after,result,'earn',99,true)[key as 'coins']).toBe(false);
 }
});

test('an exhausted supply must end at once at the bank after eating owned sharks; its restart picks nothing',()=>{
 const {before,after}=fixture();
 before.inventories[95]=[{slot:0,id:995,count:1000},{slot:1,id:440,count:5},{slot:2,id:385,count:2}];
 after.inventories[93]=[{slot:0,id:385,count:1}];after.inventories[95]=[{slot:0,id:995,count:1437},{slot:1,id:440,count:5},{slot:2,id:1265,count:1},{slot:3,id:590,count:1}];
 const result={ok:false,reason:'no food supply: waited 0 ticks at bank',ticks:180,picks:12,fails:3,coinsGained:400,coinsExact:true,banked:437,packCoins:0,coins0:37,eaten:1,eatenById:{385:1},food:1,hpMin:4,died:false,randomEvents:true};
 before.skills[17].level=after.skills[17].level=55;
 expect(pass(goldfarmSaveChecks(before,after,result,'exhausted',55,true))).toBe(true);
 expect(goldfarmSaveChecks(before,after,{...result,eatenById:{},eaten:0},'exhausted',55,true).premium).toBe(false);
 expect(goldfarmSaveChecks(before,after,{...result,reason:'no food supply: waited 300 ticks at bank'},'exhausted',55,true).target).toBe(false);
 const restart=structuredClone(after);
 expect(pass(goldfarmSaveChecks(after,restart,{...result,ticks:20,picks:0,fails:0,coinsGained:0,banked:0,coins0:0,eaten:0,eatenById:{}},'refuse',55,false,after))).toBe(true);
 expect(goldfarmSaveChecks(after,restart,{...result,ticks:20,picks:1,fails:1,coinsGained:0,banked:0,coins0:0,eaten:0,eatenById:{}},'refuse',55,false).target).toBe(false);
});

test('CLI exit, one logout, the result line and the random-event watcher are all required',()=>{
 const log='START 2654 3283 0\nGOLDFARM_RESULT {"ok":true,"randomEvents":true}\nEVENTS {}\nLOGOUT logged-out\nRESULT ok ticks=600\n';
 const r=goldfarmResult(log);expect(r).toEqual({ok:true,randomEvents:true});
 expect(pass(goldfarmChildChecks(0,false,log,'earn',r))).toBe(true);
 expect(goldfarmChildChecks(0,false,log.replace('LOGOUT logged-out\n',''),'earn',r).logout).toBe(false);
 expect(goldfarmChildChecks(0,false,log+'WARN logout did not complete: timeout\n','earn',r).logout).toBe(false);
 expect(goldfarmChildChecks(0,true,log,'earn',r).exit).toBe(false);
 expect(goldfarmChildChecks(0,false,log.replace('EVENTS {}\n',''),'earn',r).randomEvents).toBe(false);
 expect(goldfarmChildChecks(1,false,log.replace('RESULT ok','RESULT fail no food supply: waited 0 ticks at bank'),'exhausted',r).result).toBe(true);
 expect(goldfarmResult(log+log)).toBeNull();
});

test('the native plan covers HP10 Thieving 55 and 99, restart, exhausted supply and live-like random events',()=>{
 expect(cases.map(c=>c.id)).toEqual(['entry99','restart99','entry55','exhausted','exhausted-restart','route-error','route-error-restart','unbanked-error','unbanked-restart']);
 expect(cases.filter(c=>c.preset).every(c=>c.preset!.skills!.Hitpoints===10)).toBe(true);
 expect(WORKER_ENV).toEqual({TICKS:'600',BANK_AT:'50000',FOOD_FROM:'',FUND_COURIER:'',RANDOM_EVENTS:'1'});
});

test('recorded restarts retain parent position and earned Thieving, while fresh entries stay strict',()=>{
 for(const [position,level,xp] of [[{x:2650,z:3304,level:0},99,14262805],[{x:2655,z:3283,level:0},57,549640]] as const){
  const {before,after,result}=fixture();before.position={...position};before.skills[17].level=level;before.skills[17].rawExperience=xp;
  const declared=level===99?99:55,parent=structuredClone(before);
  expect(goldfarmSaveChecks(before,after,result,'earn',declared,false,parent).entry).toBe(true);
  expect(goldfarmSaveChecks(before,after,result,'earn',declared,true).entry).toBe(false);
  expect(goldfarmSaveChecks(before,after,result,'earn',declared,false).entry).toBe(false);
  parent.skills[17].rawExperience--;expect(goldfarmSaveChecks(before,after,result,'earn',declared,false,parent).entry).toBe(false);
  for(const bad of [{x:3222,z:3218,level:0},{...position,level:1}]){
   before.position=bad;expect(goldfarmSaveChecks(before,after,result,'earn',declared,false,structuredClone(before)).entry).toBe(false);
  }
 }
});

test('recorded 8600 new coins stay distinct from 18750 banked on a carried-income restart',()=>{
 const {before,after,result}=fixture();
 before.inventories[93]=[{slot:17,id:995,count:10150}];before.inventories[95][0].count=1037;
 after.inventories[93]=[];after.inventories[95][0].count=19787;
 Object.assign(result,{coins0:10150,coinsGained:8600,banked:18750,packCoins:0});
 expect(goldfarmSaveChecks(before,after,result,'earn',99,false,before).coins).toBe(true);
 expect(goldfarmSaveChecks(before,after,{...result,coinsGained:18750},'earn',99,false,before).coins).toBe(false);
});

test('a failed route and failed recovery prove explicit unbanked assets, never successful earning',()=>{
 const {before,after,result}=fixture();after.position={x:2650,z:3304,level:0};
 after.inventories[95][0].count=1037;after.inventories[93].push({slot:20,id:995,count:5000});
 Object.assign(result,{ok:false,reason:'Error: no farm route progress: proof injected route failure',banked:37,packCoins:5000,
  recovery:'failed: Error: no farm route progress: proof injected recovery failure'});
 expect(pass(goldfarmSaveChecks(before,after,result,'unbanked',99,true))).toBe(true);
 expect(goldfarmSaveChecks(before,after,result,'earn',99,true).target).toBe(false);
 expect(goldfarmSaveChecks(before,after,{...result,packCoins:0},'unbanked',99,true).coins).toBe(false);
 const log='GOLDFARM_RESULT '+JSON.stringify(result)+'\nEVENTS {}\nLOGOUT logged-out\nRESULT fail '+result.reason+' ticks=600\n';
 expect(pass(goldfarmChildChecks(1,false,log,'unbanked',result))).toBe(true);
});

function doorFixture(x:number,z:number){
 const before:any={position:{x,z,level:0},skills:skills(99,130344310),vars:{134:5},inventories:{
  93:[{slot:0,id:1265,count:1},{slot:1,id:590,count:1},{slot:2,id:995,count:DOOR_CARRIED},{slot:3,id:333,count:5}],94:[{slot:3,id:1277,count:1},{slot:5,id:1171,count:1}],
  95:[{slot:0,id:995,count:1000},{slot:1,id:440,count:5},{slot:2,id:333,count:10}]}};
 const after=structuredClone(before);after.vars[134]=6;after.position={x:2654,z:3283,level:0};
 after.inventories[93]=Array.from({length:15},(_,slot)=>({slot,id:333,count:1}));
 after.inventories[95]=[{slot:0,id:995,count:1000+DOOR_CARRIED},{slot:1,id:440,count:5},{slot:2,id:1265,count:1},{slot:3,id:590,count:1}];
 const result={ok:true,reason:'',ticks:64,picks:0,fails:0,coinsGained:0,coinsExact:true,banked:DOOR_CARRIED,packCoins:0,coins0:DOOR_CARRIED,eaten:0,eatenById:{},food:15,bankTrips:2,hpMin:10,hp:10,died:false,randomEvents:true};
 return {before,after,result};
}

test('door gate starts in the recorded house tiles and outside, earns nothing and stays apart from the full proof',()=>{
 expect(doorCases.map(c=>[c.start.x,c.start.z])).toEqual([[2651,3304],[2650,3304],[2653,3302]]);
 expect(doorCases.every(c=>c.preset.position!.x===c.start.x&&c.preset.position!.z===c.start.z&&c.preset.skills!.Hitpoints===10)).toBe(true);
 expect(DOOR_ENV).toEqual({...WORKER_ENV,TICKS:'0'});
 expect(DOOR_DIR).toBe('door-repro');
 // Full delivery still requires every earning, restart, exhausted and error case.
 expect(doorCases.some(d=>cases.some(c=>c.id===d.id))).toBe(false);
 expect(cases).toHaveLength(9);
});

test('door gate passes only an exact carried-cash deposit with unchanged kit, food, skills and HP at the bank',()=>{
 const {before,after,result}=doorFixture(2651,3304);
 expect(goldfarmDoorChecks(before,after,result,{x:2651,z:3304})).toEqual({entry:true,target:true,coins:true,food:true,assets:true,skills:true,life:true});
 const mutations:[string,(b:any,a:any,r:any)=>void][]=[
  ['entry',b=>b.position={x:2650,z:3304,level:0}],
  ['target',(_,__,r)=>r.ok=false],
  ['target',(_,__,r)=>r.picks=1],
  ['target',(_,__,r)=>r.ticks=313], // the recorded 300-tick idle in the house
  ['coins',(_,a)=>a.inventories[93].push({slot:20,id:995,count:DOOR_CARRIED})],
  ['coins',(_,a)=>a.inventories[95][0].count-=50],
  ['coins',(_,__,r)=>r.coinsExact=false],
  ['food',(_,a)=>a.inventories[93].pop()],
  ['food',(_,__,r)=>r.eaten=1],
  ['assets',(_,a)=>a.inventories[95].pop()],
  ['assets',(_,a)=>a.inventories[94].pop()],
  ['skills',(_,a)=>a.skills[17].rawExperience++],
  ['life',(_,a)=>a.skills[3].level=9],
  ['life',(_,a)=>a.position={x:2651,z:3304,level:0}],
  ['life',(_,__,r)=>r.died=true],
 ];
 for(const [key,mutate] of mutations){
  const f=doorFixture(2651,3304);mutate(f.before,f.after,f.result);
  expect(goldfarmDoorChecks(f.before,f.after,f.result,{x:2651,z:3304})[key as 'coins']).toBe(false);
 }
});

test('late saved credit and unknown settlement fail strict coin equality even on an error exit',()=>{
 const {before,after,result}=fixture();
 after.inventories[95][0].count=1037;after.inventories[93].push({slot:20,id:995,count:10350});
 Object.assign(result,{ok:false,coinsGained:10300,banked:37,packCoins:10300});
 expect(goldfarmSaveChecks(before,after,result,'unbanked',99,true).coins).toBe(false);
 Object.assign(result,{coinsGained:10350,packCoins:10350});
 expect(goldfarmSaveChecks(before,after,result,'unbanked',99,true).coins).toBe(true);
 for(const changed of [{coinsExact:false},{coinsExact:undefined},{coinsGained:null}]){
  expect(goldfarmSaveChecks(before,after,{...result,...changed},'unbanked',99,true).coins).toBe(false);
 }
});
