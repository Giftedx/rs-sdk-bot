import {expect,test} from 'bun:test';
import {ironResult,ironSaveChecks,ironChildChecks,smithResult,smithSaveChecks,SMITH_ORDER,ADMISSION} from '../src/iron-progress-order-proof';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';

function fixture(){
 const before:any={position:{x:3252,z:3420,level:0},skills:Array.from({length:21},(_,index)=>({index,level:index===13?31:16,xp:100,rawExperience:1000})),vars:{},inventories:{93:[{id:1265,count:1},{id:315,count:2}],95:[{id:440,count:684},{id:995,count:24}]}};
 const after=structuredClone(before);after.position={x:3269,z:3167,level:0};after.inventories[95]=[{id:440,count:674},{id:995,count:14},{id:2351,count:6}];after.skills[13].rawExperience=2000;
 const result={ok:true,bar:'iron',mode:'exact',target:6,targetMet:true,made:6,banked:6,consumedOre:10,losses:4,coinsSpent:10,initialCoins:24,finalCoins:14,xpGain:100,died:false,hpMin:16};return{before,after,result};
}
test('independent iron proof checks failed smelts, exact bank credit and fare',()=>{
 const {before,after,result}=fixture();expect(Object.values(ironSaveChecks(before,after,result,'entry')).every(Boolean)).toBe(true);
 result.losses=0;expect(ironSaveChecks(before,after,result,'entry').ore).toBe(false);
 result.bar='gold';expect(ironSaveChecks(before,after,result,'entry').output).toBe(false);
});
test('wrong entry, missing food, pack bars, unrelated XP and unpaid fare reject the proof',()=>{
 for(const mutate of [(b:any,a:any)=>b.position.x=3269,(_:any,a:any)=>a.inventories[93].pop(),(_:any,a:any)=>a.inventories[93].push({id:2351,count:6}),(_:any,a:any)=>a.skills[14].rawExperience++,(_:any,a:any)=>a.inventories[95][1].count=24]){
  const {before,after,result}=fixture();mutate(before,after);expect(Object.values(ironSaveChecks(before,after,result,'entry')).every(Boolean)).toBe(false);
 }
});
test('interrupted order preserves coins and refuses unearned output and XP',()=>{
 const {before,after}=fixture();before.position={x:3269,z:3167,level:0};before.inventories[95]=[{id:440,count:2},{id:995,count:24}];
 after.inventories[95]=structuredClone(before.inventories[95]);after.skills[13].rawExperience=before.skills[13].rawExperience;
 const result={ok:false,bar:'iron',mode:'exact',target:6,targetMet:false,made:0,banked:0,consumedOre:0,losses:0,coinsSpent:0,initialCoins:24,finalCoins:24,xpGain:0,died:false,hpMin:16};
 expect(Object.values(ironSaveChecks(before,after,result,'interrupted')).every(Boolean)).toBe(true);
 result.finalCoins=0;expect(ironSaveChecks(before,after,result,'interrupted').coins).toBe(false);
 result.xpGain=1;expect(ironSaveChecks(before,after,result,'interrupted').xp).toBe(false);
});
test('CLI success without a single confirmed logout is insufficient',()=>{
 expect(ironChildChecks(0,false,'RESULT ok test\n','entry').logout).toBe(false);
 expect(Object.values(ironChildChecks(0,false,'LOGOUT logged-out\nRESULT ok test\n','entry')).every(Boolean)).toBe(true);
 expect(ironChildChecks(0,true,'LOGOUT logged-out\nRESULT ok test\n','entry').exit).toBe(false);
 expect(ironChildChecks(0,false,'LOGOUT logged-out\nRESULT ok test\n','interrupted').exit).toBe(false);
 expect(ironResult('SMELT_RESULT '+JSON.stringify({made:6}))).toEqual({made:6});
});

function smithFixture(level=84){
 const before:any={position:{x:3269,z:3166,level:0},skills:Array.from({length:21},(_,index)=>({index,level:index===13?level:index===3?35:1,xp:100,rawExperience:index===13?3690420:1000})),vars:{},
  inventories:{93:[{id:995,count:7340}],95:[{id:2351,count:349},{id:2349,count:1641},{id:2347,count:1},{id:995,count:396828},{id:440,count:1}]}};
 const after=structuredClone(before);after.position={x:3185,z:3436,level:0};after.inventories[93]=[{id:995,count:7330}];
 after.inventories[95]=[{id:2351,count:334},{id:2349,count:1641},{id:2347,count:1},{id:995,count:396828},{id:440,count:1},{id:1115,count:3}];after.skills[13].rawExperience=3690420+93750;
 const result:any={ok:true,action:'smith',product:1115,target:3,reserve:334,made:3,banked:3,finalBars:334,stop:'target',xpGain:9375,coinsSpent:10,initialCoins:404168,finalCoins:404158,hammerRetained:true,died:false,hpMin:35};
 return{before,after,result};
}
test('anvil proof needs 15 bars debited, three banked platebodies, 9375 XP, the toll and the hammer',()=>{
 expect(SMITH_ORDER.rawXpPerProduct*SMITH_ORDER.maximum/10).toBe(9375);
 const {before,after,result}=smithFixture();expect(Object.entries(smithSaveChecks(before,after,result,'anvil')).filter(([,v])=>!v)).toEqual([]);
 for(const mutate of [
  (_:any,a:any)=>a.inventories[95][5].count=2,
  (_:any,a:any)=>a.inventories[95][0].count=333,
  (_:any,a:any)=>a.inventories[95][2].count=0,
  (_:any,a:any)=>a.inventories[93].push({id:1115,count:1}),
  (_:any,a:any)=>a.skills[13].rawExperience-=10,
  (_:any,a:any)=>a.skills[14].rawExperience++,
  (_:any,a:any)=>a.inventories[93][0].count=7340,
  (_:any,a:any)=>a.inventories[95][1].count--,
  (_:any,a:any)=>a.position={x:3269,z:3166,level:0},
  (b:any)=>b.skills[13].level=85,
 ]){const {before,after,result}=smithFixture();mutate(before,after);expect(Object.values(smithSaveChecks(before,after,result,'anvil')).every(Boolean)).toBe(false);}
 const {before:b,after:a,result:r}=smithFixture();r.banked=2;expect(smithSaveChecks(b,a,r,'anvil').output).toBe(false);
});
test('a level refusal leaves position, bars, coins, XP and hammer unchanged',()=>{
 const {before}=smithFixture(30),after=structuredClone(before);
 // The worker's level refusal emits no ledger: see the matching scripts/smith-batch.test.ts case.
 const result:any={ok:false,action:'smith',product:1115,target:3,reserve:334,made:0,banked:null,finalBars:0,stop:'refused',failure:'smith refused: Smithing 30 is below level 33 for product 1115',
  xpGain:0,coinsSpent:0,initialCoins:0,finalCoins:0,hammerRetained:false,died:false,hpMin:35};
 expect(Object.entries(smithSaveChecks(before,after,result,'refusal')).filter(([,v])=>!v)).toEqual([]);
 expect(smithSaveChecks(before,after,{...result,banked:0},'refusal').output).toBe(false);
 after.inventories[93][0].count--;expect(smithSaveChecks(before,after,result,'refusal').coins).toBe(false);after.inventories[93][0].count++;
 expect(smithSaveChecks(before,after,{...result,stop:'cap'},'refusal').target).toBe(false);
 after.position={x:3272,z:3227,level:0};expect(smithSaveChecks(before,after,result,'refusal').place).toBe(false);
 expect(smithResult('x\nSMITH_RESULT '+JSON.stringify({made:3}))).toEqual({made:3});expect(smithResult('SMELT_RESULT {}')).toBeNull();
});
test('the proof keeps the shared memory floor and leaves startup admission to delivery',()=>{
 expect(ADMISSION).toEqual({floorGb:FREE_FLOOR_GB,startupGb:PRACTICE_STARTUP_GB});
});
