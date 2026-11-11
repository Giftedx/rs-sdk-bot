import {expect,test} from 'bun:test';
import {ADMISSION,BLOOD_RUNE,COINS,ENTRY,FARE,ORDER,YANILLE_BANK,buyChecks,caseChecks,childChecks,childConfiguration,refuseChecks,runeShopFixture,runeShopSource} from '../src/rune-shop-order-proof';
import {bloodProofEndpoints} from '../src/blood-chest-proof';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';
import type {readPracticeSave} from '../../../scripts/measure/fleet-player-save';

type Save=ReturnType<typeof readPracticeSave>;
const save=(p:{x:number;z:number;level?:number;magic:number;pack:[number,number][];bank:[number,number][];logins?:number})=>({position:{x:p.x,z:p.z,level:p.level??0},vars:{134:p.logins??1},
 skills:Array.from({length:21},(_,i)=>({index:i,level:i===6?p.magic:i===3?10:1,xp:0,rawExperience:0})),
 inventories:{93:p.pack.map(([id,count],slot)=>({slot,id,count})),94:[],95:p.bank.map(([id,count],slot)=>({slot,id,count}))}} as unknown as Save);
const start=(magic:number)=>save({...ENTRY,magic,pack:[[1351,1]],bank:[[COINS,150000],[590,1],[1925,3]]});
const bought=(spent:number,fare:number,extra:[number,number][]=[])=>save({...YANILLE_BANK,magic:74,logins:2,pack:[],bank:[[COINS,150000-spent-fare],[590,1],[1925,3],[1351,1],[BLOOD_RUNE,100],...extra]});
const okLog=(spent:number,fare:number)=>`START shop-buyer x\nBOUGHT 60x Blood rune\nBOUGHT 40x Blood rune\nRESULT ok ticks=900 boughtTotal=100 bankedTotal=100 bankTrips=3 shopTrips=1 coinsLeft=0 spentTotal=${spent} coinReserve=2000 maxSpend=30000 maxItems=100 stop=stock-target targetMet=1 noBuyTicks=0 noBuyLimit=25 fareTotal=${fare}\nLOGOUT logged-out\n`;
const refuseLog='RESULT fail magic guild needs Magic 66 (Magic 60) boughtTotal=0 spentTotal=0 fareTotal=0 stop=refused\nLOGOUT logged-out\n';
const failed=(c:Record<string,boolean>)=>Object.entries(c).filter(([,v])=>!v).map(([k])=>k);

test('admission uses the shared memory limits',()=>{
 expect(ADMISSION).toEqual({floorGb:FREE_FLOOR_GB,startupGb:PRACTICE_STARTUP_GB});
});
test('fixtures are ordinary saves at Varrock West bank with 150000 coins banked and no blood runes',()=>{
 for(const id of ['buy','refuse'] as const){
  const f=runeShopFixture(id);
  expect(f.position).toEqual(ENTRY);
  expect(f.skills).toEqual({Magic:id==='buy'?74:60,Hitpoints:10});
  expect(f.bank).toContainEqual({id:COINS,count:150000});
  expect([...(f.inventory??[]),...(f.bank??[])].some(i=>i.id===BLOOD_RUNE)).toBe(false);
  expect(f.varps).toBeUndefined();
 }
});
test('the child runs the real CLI with the bounded blood order on owned endpoints',()=>{
 const p=bloodProofEndpoints({engine:20400,gateway:20401,management:20402,tcp:20403},'blood-runeshoptest');
 const c=childConfiguration('flrunex1','buy',{PATH:'x',ITEMS:'fire rune'},p);
 expect(c.cmd).toEqual(['bun','scripts/shop-buyer.ts','flrunex1','magic_guild','12000']);
 expect(c.windowsHide).toBe(true);
 expect(c.env).toMatchObject({ITEMS:'blood rune',STOP_AT_TARGET:'1',STOCK_TARGET:'100',MAX_ITEMS:'100',MAX_SPEND:'30000',COIN_RESERVE:'2000',NO_BUY_TICKS:'25',BANK_PACK:'1',DEMO_OK:'',RANDOM_EVENTS:'0',PATH:'x',GATEWAY_URL:p.gateway,AGENT_PORT:'20401'});
 expect(ORDER).toEqual({target:100,maxSpend:30000,reserve:2000,coins:150000});
 expect(FARE).toBe(60);
});
test('the buy case passes on 100 banked runes and a debit of spend plus fares, and fails on any gap',()=>{
 const before=start(74),receipt={code:0,timedOut:false,persisted:true};
 expect(failed(caseChecks('buy',before,bought(5000,60),okLog(5000,60),receipt))).toEqual([]);
 expect(failed(caseChecks('buy',before,bought(5000,0),okLog(5000,0),receipt))).toEqual([]);
 // A debit that the result does not account for.
 expect(failed(buyChecks(before,bought(5000,60),okLog(5000,0)))).toEqual(['coins']);
 expect(failed(buyChecks(before,bought(31000,0),okLog(31000,0)))).toEqual(['spend']);
 expect(failed(buyChecks(before,bought(5000,90),okLog(5000,90)))).toEqual(['fares']);
 // Another asset changed, or the runes were not banked.
 expect(failed(buyChecks(before,bought(5000,60,[[554,5]]),okLog(5000,60)))).toEqual(['assets']);
 const carried=save({...YANILLE_BANK,magic:74,pack:[[BLOOD_RUNE,100]],bank:[[COINS,144940],[590,1],[1925,3],[1351,1]]});
 expect(failed(buyChecks(before,carried,okLog(5000,60)))).toEqual(['target']);
 const elsewhere=save({x:2595,z:3087,level:1,magic:74,pack:[],bank:[[COINS,144940],[590,1],[1925,3],[1351,1],[BLOOD_RUNE,100]]});
 expect(failed(buyChecks(before,elsewhere,okLog(5000,60)))).toEqual(['place']);
 expect(failed(buyChecks(start(60),bought(5000,60),okLog(5000,60)))).toEqual(['entry']);
 // No confirmed logout or a save that never followed it.
 expect(childChecks(0,false,okLog(5000,60).replace('LOGOUT logged-out\n',''),'buy').logout).toBe(false);
 expect(caseChecks('buy',before,bought(5000,60),okLog(5000,60),{...receipt,persisted:false}).savedLogout).toBe(false);
 expect(childChecks(0,false,okLog(5000,60).replace('stop=stock-target','stop=stock-wait'),'buy').result).toBe(false);
});
test('the refusal case needs the clear refusal, a logout and an untouched save before any walk',()=>{
 const before=start(60),after=save({...ENTRY,magic:60,logins:2,pack:[[1351,1]],bank:[[COINS,150000],[590,1],[1925,3]]});
 expect(failed(caseChecks('refuse',before,after,refuseLog,{code:1,timedOut:false,persisted:true}))).toEqual([]);
 expect(childChecks(0,false,refuseLog,'refuse').exit).toBe(false);
 expect(childChecks(1,false,refuseLog.replace('(Magic 60)','(Magic 61)'),'refuse').result).toBe(false);
 expect(refuseChecks(before,after,'START shop-buyer x\n'+refuseLog).noWalk).toBe(false);
 const moved=save({x:3180,z:3436,magic:60,logins:2,pack:[[1351,1]],bank:[[COINS,150000],[590,1],[1925,3]]});
 expect(refuseChecks(before,moved,refuseLog).noWalk).toBe(false);
 const spent=save({...ENTRY,magic:60,logins:2,pack:[[1351,1]],bank:[[COINS,149000],[590,1],[1925,3]]});
 expect(refuseChecks(before,spent,refuseLog).unchanged).toBe(false);
});
test('the source pin binds the owned files and the guild shop content',()=>{
 const files=Object.keys(runeShopSource().files);
 for(const f of ['scripts/shop-buyer.ts','scripts/shop-buyer.test.ts','packages/practice/src/rune-shop-order-proof.ts','packages/practice/test/rune-shop-order-proof.test.ts',
  'vendor/rs-sdk/server/content/scripts/areas/area_yanille/configs/magic_guild/magic_guild.inv','vendor/rs-sdk/server/content/scripts/areas/area_yanille/scripts/magic_guild.rs2'])expect(files).toContain(f);
});
