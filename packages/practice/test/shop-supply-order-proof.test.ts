import{test,expect,spyOn}from'bun:test';
import{mkdtempSync,readFileSync,writeFileSync,rmSync,cpSync,unlinkSync}from'node:fs';
import{join,resolve}from'node:path';
import{tmpdir}from'node:os';
import{createHash}from'node:crypto';
import{capabilityRevision}from'../../core/src/worker-release';
import * as workerRelease from '../../core/src/worker-release';
import * as coreBot from '../../core/src/bot';
import * as walking from '../../core/src/walk';
import {runEarthProduction} from '../../../scripts/earth-production';
import {setEquipmentObserved} from '../../core/src/container-observation';
import {createSaveData} from '../../../vendor/rs-sdk/sdk/test/utils/save-generator';
import {parsePracticeSave} from '../../../scripts/measure/fleet-player-save';
import{bettySupplyChecks,shopSupplyChecks,shopRepeatChecks,shopRefusalChecks,shopSupplyFixture,verifyShopSupply,waitFreeMemory,HEADROOM_WAIT_MS}from'../src/shop-supply-order-proof';
const save=(earth=3,coins=352288)=>({position:{x:3252,z:3420,level:0},skills:{3:{level:35,xp:10000}},inventories:{93:[],94:[],95:[{id:557,count:earth},{id:554,count:1482},{id:995,count:coins},{id:1277,count:1}]}} as any);
const run=(bought=1136,spent=6816,target=1)=>({code:0,timedOut:false,hpMin:35,log:`LOGOUT logged-out\nRESULT ok ticks=500 boughtTotal=${bought} spentTotal=${spent} stop=stock-target targetMet=${target}\n`});

test('a transient free-memory dip waits for headroom; a sustained breach still stops',async()=>{
 const samples=[3.2,3.9,16.5],pauses:number[]=[];
 expect(await waitFreeMemory(4,()=>samples.shift()!,async ms=>{pauses.push(ms);})).toBe(16.5);
 expect(pauses).toEqual([250,250]);
 let reads=0;
 expect(await waitFreeMemory(4,()=>{reads++;return 3.5;},async()=>{})).toBe(3.5);
 expect(reads).toBe(HEADROOM_WAIT_MS/250+1);
 reads=0;expect(await waitFreeMemory(4,()=>{reads++;return 9;},async()=>{throw Error('no wait expected');})).toBe(9);expect(reads).toBe(1);
});

test('shop route fixture has the live consumer combat entry and unchanged health acceptance',()=>{
 const fixture=shopSupplyFixture(352288),saved=parsePracticeSave(createSaveData(fixture));
 expect([0,1,2,3].map(i=>saved.skills[i]!.level)).toEqual([49,11,10,35]);
 expect(saved.inventories[95]!.find(i=>i.id===995)?.count).toBe(352288);
 const before=save(),after=save(1139,345472);after.skills[3].level=34;
 expect(shopSupplyChecks(before,after,run()).health).toBe(false);
});

test('persisted hunt kit survives equip closing the bank; missing1171 still refuses',async()=>{
 const world=spyOn(coreBot,'getWorld').mockResolvedValue({} as any);
 const account=spyOn(coreBot,'accountOf').mockReturnValue({skills:{}} as any);
 const travel=spyOn(walking,'goTo').mockResolvedValue({ok:true} as any);
 try{for(const missing of [false,true]){
  const persisted=parsePracticeSave(createSaveData({position:{x:3185,z:3436},skills:{Attack:49,Strength:10,Defence:11,Hitpoints:35},
   bank:[{id:995,count:352288},{id:554,count:1482},{id:557,count:3},{id:1277,count:1},...missing?[]:[{id:1171,count:1}],{id:1115,count:1},{id:1891,count:8}]}));
  // The session names every item; the cleanup after a refusal banks the pack again by name.
  const stock:any[]=persisted.inventories[95]!.map(i=>({...i,name:`item${i.id}`})),pack:any[]=[],equipment:any[]=[],client={};
  if(missing)equipment.push(stock.splice(stock.findIndex(i=>i.id===1277),1)[0]);
  setEquipmentObserved(client,true);
  let generation=0,stopped=false,styleSet=false;
  const state={player:{worldX:3185,worldZ:3436,level:0},inventory:pack,bank:{isOpen:false,items:[] as any[]},combatStyle:{currentStyle:0},autoRetaliateEnabled:false};
  const visible=()=>{state.bank.items=state.bank.isOpen?stock:[];};
  const s={client,name:'flkitentry',tick:()=>0,ended:new Promise(()=>{}),onTick:()=>()=>{},
   bankObservation:()=>state.bank.isOpen?{generation,items:stock}:null,
   sdk:{getState:()=>state,getInventory:()=>pack,getEquipment:()=>equipment,getSkill:()=>({level:35,baseLevel:49}),
    sendSetCombatStyle:async(n:number)=>{styleSet=true;state.combatStyle.currentStyle=n;stopped=true;return{success:true};}},
   bot:{dismissBlockingUI:async()=>{},openBank:async()=>{state.bank.isOpen=true;generation++;visible();return{success:true};},
    withdrawItem:async(item:any,n:number)=>{expect(state.bank.isOpen).toBe(true);item.count-=n;generation++;pack.push({id:item.id,name:item.name,count:n,slot:pack.length});return{success:true};},
    depositItem:async(item:any)=>{expect(state.bank.isOpen).toBe(true);const row=stock.find(i=>i.id===item.id);if(row)row.count+=item.count;else stock.push({...item});pack.splice(pack.indexOf(item),1);generation++;return{success:true};},
    equipItem:async(item:any)=>{state.bank.isOpen=false;visible();equipment.push(item);pack.splice(pack.indexOf(item),1);return{success:true};},
    closeBank:async()=>{state.bank.isOpen=false;visible();}},
  } as any;
  const result=await runEarthProduction(s,{mode:'talismans',cap:20000,target:103,reserve:30000,killsPerTarget:1,stop:()=>stopped});
  if(missing){
   expect(result.failure).toBe('Error: earth production missing owned 1171');
   expect(result.ok).toBe(false);
   expect(styleSet).toBe(false);
  }else{
   expect(result.failure).not.toContain('missing owned');
   expect(equipment.map(i=>i.id)).toEqual([1277,1171,1115]);
   expect(styleSet).toBe(true);
   expect(pack.map(i=>({id:i.id,count:i.count}))).toContainEqual({id:1891,count:8});
  }
 }}finally{travel.mockRestore();account.mockRestore();world.mockRestore();}
});
test('saved shop supply binds exact new stock, money, retained fire, assets and logout',()=>{
 const before=save(),after=save(1139,345472);
 expect(Object.values(shopSupplyChecks(before,after,run())).every(Boolean)).toBe(true);
 expect(Object.values(shopSupplyChecks(before,after,{...run(),log:'MILESTONE bank boughtTotal=0\n'+run().log})).every(Boolean)).toBe(true);
 for(const mutate of [(s:any)=>s.inventories[95][0].count--,(s:any)=>s.inventories[95][1].count--,(s:any)=>s.inventories[95][2].count--,(s:any)=>s.inventories[95][3].count--]){
  const bad=structuredClone(after);mutate(bad);expect(Object.values(shopSupplyChecks(before,bad,run())).every(Boolean)).toBe(false);
 }
 expect(shopSupplyChecks(before,after,{...run(),log:run().log.replace('LOGOUT logged-out','LOGOUT timeout')}).logout).toBe(false);
 expect(shopSupplyChecks(before,after,{...run(),hpMin:0}).health).toBe(false);
});
test('target repeat cannot buy again or debit coins; refusal retains every asset',()=>{
 const after=save(1139,345472);
 expect(Object.values(shopRepeatChecks(after,after,run(0,0))).every(Boolean)).toBe(true);
 expect(Object.values(shopRepeatChecks(after,save(1140,345470),run(1,2))).every(Boolean)).toBe(false);
 const poor=save(3,30000),refused={...run(0,0,0),log:run(0,0,0).log.replace('stock-target','stock-wait')};
 expect(Object.values(shopRefusalChecks(poor,poor,refused)).every(Boolean)).toBe(true);
 expect(Object.values(shopRefusalChecks(poor,save(3,29999),refused)).every(Boolean)).toBe(false);
});
test('alternate Betty profile proves its route, useful stock and the same conserved budget',()=>{
 const before=save(),after=save(53,351888);after.position={x:3092,z:3243,level:0};
 expect(Object.values(bettySupplyChecks(before,after,run(50,400))).every(Boolean)).toBe(true);
 after.inventories[95][0].count--;expect(Object.values(bettySupplyChecks(before,after,run(50,400))).every(Boolean)).toBe(false);
});

// File-only fixture exercises the saved verifier without a client, service or live actor.
function savedShopFixture(directory:string){
 const digest=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
 const files=['scripts/buy-owned-ge-item.ts','scripts/earth-shop.ts','scripts/earth-shop.test.ts','scripts/earth-production.ts','scripts/earth-production.test.ts','scripts/shop-buyer.ts','scripts/shop-buyer.test.ts','packages/practice/src/shop-supply-order-proof.ts','packages/practice/test/shop-supply-order-proof.test.ts'];
 const root=resolve(import.meta.dir,'../../..'),paths:string[]=[];
 const put=(file:string,data:string|Uint8Array)=>{writeFileSync(join(directory,file),data);paths.push(file);};
 const saved=(label:string,earth=3,coins=352288,betty=false,essence=0)=>put(label+'.sav',createSaveData({
  position:betty?{x:3092,z:3243,level:0}:{x:3252,z:3420,level:0},skills:{Hitpoints:35},
  bank:[{id:557,count:earth},{id:554,count:1482},{id:995,count:coins},{id:1277,count:1},...(essence?[{id:1436,count:essence}]:[])],
 }));
 saved('before');saved('after',1139,345472);saved('repeat',1139,345472);
 saved('refuse-before',3,30000);saved('refused',3,30000);
 saved('betty-before');saved('betty-after',53,351888,true);
 saved('refill-before');saved('refill-after',53,351888,true);saved('refill-repeat',53,351888,true);
 saved('hunt-before');saved('hunt-after');saved('craft-before',3,352288,false,60);saved('craft-after',105,352288,false,9);
 const production={ok:true,conserved:true,consumed:0,crafted:0,air:0,eaten:{},equipmentRestored:true,kills:2,pilotReady:1};
 const runs:Record<string,any>={buy:run(),repeat:run(0,0),refuse:{...run(0,0,0),log:run(0,0,0).log.replace('stock-target','stock-wait')},betty:run(50,400),
  refill:{...run(),log:run(51,401).log+'EARTH_REFILL '+JSON.stringify({targetMet:1,seeded:1,boughtTotal:51,spentTotal:401,seedCredit:1,bank:true,ok:true,conserved:true})},
  'refill-repeat':{...run(0,0),log:run(0,0).log.trimEnd()+' seeded=0\n'},
  'owned-hunt':{...run(),log:'LOGOUT logged-out\nEARTH_PRODUCTION '+JSON.stringify(production)},
  'owned-craft':{...run(),log:'LOGOUT logged-out\nEARTH_PRODUCTION '+JSON.stringify({...production,consumed:51,crafted:102,targetMet:1,trips:2})}};
 for(const [key,r]of Object.entries(runs)){r.logout={state:'confirmed'};put(key+'.log',r.log);}
 for(const label of ['empty-ge','betty-empty-ge','refill-empty-ge'])put(label+'.log','LOGOUT logged-out\n');
 put('original-ge-journal.json','{}');put('original-ge-journal-after.json','{}');
 put('fallback-spend.json',JSON.stringify({phase:'settled',request:{item:557,quantity:1136,expectedOwned:3},spent:6816}));
 put('refill-ledger.json',JSON.stringify({phase:'settled',seeded:1,spent:401}));
 const meta={at:Date.now(),directory:resolve(directory),source:{runtime:capabilityRevision(['scripts/buy-owned-ge-item.ts'],root),files:Object.fromEntries(files.map(f=>[f,digest(join(root,f))]))},runs,hashes:Object.fromEntries(paths.map(f=>[f,digest(join(directory,f))]))};
 const write=()=>writeFileSync(join(directory,'native.json'),JSON.stringify(meta));write();return{meta,write};
}

test('immutable same-source shop receipts reconcile after an independent 15-minute queue wait',()=>{
 const directory=mkdtempSync(join(tmpdir(),'shop-saved-')),clock=spyOn(Date,'now');
 // The GE closure test covers runtime hashing; these tests retain real source and artifact byte checks.
 const revision=spyOn(workerRelease,'capabilityRevision').mockReturnValue('shop-saved-test-runtime');
 try{
  const {meta}=savedShopFixture(directory),at=meta.at;
  const initial=verifyShopSupply(directory);
  expect(Object.entries(initial.checks).filter(([,ok])=>!ok)).toEqual([]);
  expect(initial.ok).toBe(true);
  const bytes=readFileSync(join(directory,'native.json'));
  clock.mockReturnValue(at+15*60*1000+1);
  const report=verifyShopSupply(directory);
  expect(report.ok).toBe(true);expect(report.ageMs).toBe(900001);
  expect(report.nativeAt).toBe(at);expect(report.directory).toBe(resolve(directory));
  expect(readFileSync(join(directory,'native.json'))).toEqual(bytes);
 }finally{revision.mockRestore();clock.mockRestore();rmSync(directory,{recursive:true,force:true});}
});

test('saved shop timestamps must be finite numbers and cannot be in the future',()=>{
 const directory=mkdtempSync(join(tmpdir(),'shop-time-')),clock=spyOn(Date,'now');
 const revision=spyOn(workerRelease,'capabilityRevision').mockReturnValue('shop-saved-test-runtime');
 try{
  const {meta,write}=savedShopFixture(directory),now=meta.at;clock.mockReturnValue(now);
  for(const at of [now+1,null,'invalid',String(now),undefined,NaN,Infinity]){
   (meta as any).at=at;write();const report=verifyShopSupply(directory);
   expect(report.checks.fresh).toBe(false);expect(report.ok).toBe(false);
  }
 }finally{revision.mockRestore();clock.mockRestore();rmSync(directory,{recursive:true,force:true});}
});

test('saved shop proof rejects changed bytes, missing receipts, wrong source and another run directory',()=>{
 const directory=mkdtempSync(join(tmpdir(),'shop-receipts-')),copy=mkdtempSync(join(tmpdir(),'shop-copy-'));
 const revision=spyOn(workerRelease,'capabilityRevision').mockReturnValue('shop-saved-test-runtime');
 try{
  const {meta,write}=savedShopFixture(directory);
  expect(verifyShopSupply(directory).ok).toBe(true);
  const log=readFileSync(join(directory,'buy.log'));writeFileSync(join(directory,'buy.log'),Buffer.concat([log,Buffer.from('\nchanged')]));
  expect(verifyShopSupply(directory).checks.artifacts).toBe(false);writeFileSync(join(directory,'buy.log'),log);
  const receipt=meta.hashes['fallback-spend.json'];delete meta.hashes['fallback-spend.json'];write();
  expect(verifyShopSupply(directory).ok).toBe(false);meta.hashes['fallback-spend.json']=receipt!;write();
  const runDirectory=meta.directory;(meta as any).directory=undefined;write();
  expect(verifyShopSupply(directory).checks.nativeRun).toBe(false);meta.directory=runDirectory;
  meta.source.runtime='wrong-source';write();expect(verifyShopSupply(directory).checks.source).toBe(false);
  meta.source.runtime='shop-saved-test-runtime';meta.source.files['scripts/earth-shop.ts']='wrong-bytes';write();
  expect(verifyShopSupply(directory).checks.source).toBe(false);
  savedShopFixture(directory);cpSync(directory,copy,{recursive:true});
  expect(verifyShopSupply(copy).ok).toBe(false);
  unlinkSync(join(directory,'refill-ledger.json'));expect(()=>verifyShopSupply(directory)).toThrow();
 }finally{revision.mockRestore();rmSync(directory,{recursive:true,force:true});rmSync(copy,{recursive:true,force:true});}
});
