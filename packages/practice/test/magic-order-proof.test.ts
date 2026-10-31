import {test,expect} from 'bun:test';
import {totals,lines,unrelatedKept,segmentChecks,progressChecks,refusalChecks,fixtureChecks,
 FIXTURES,CASES,ADMISSION} from '../src/magic-order-proof';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';
import type {readPracticeSave} from '../../../scripts/measure/fleet-player-save';

type Save=ReturnType<typeof readPracticeSave>;
type Item={id:number;count:number};
const AIR=556,MIND=558,COINS=995,TROUT=333;
function save(o:{pack?:Item[];bank?:Item[];magic?:{xp:number;level:number};hp?:number;at?:{x:number;z:number}}={}):Save{
 const skills=Array.from({length:21},(_,index)=>({index,rawExperience:0,xp:0,level:1}));
 skills[3]={index:3,rawExperience:11540,xp:1154,level:o.hp??10};
 if(o.magic)skills[6]={index:6,rawExperience:o.magic.xp*10,xp:o.magic.xp,level:o.magic.level};
 const slots=(list:Item[]=[])=>list.map((i,slot)=>({slot,...i}));
 return{version:9,position:{x:o.at?.x??3253,z:o.at?.z??3420,level:0},skills,vars:{},inventories:{93:slots(o.pack),94:[],95:slots(o.bank)}};
}
const ok={code:0,timedOut:false};
const result=(r:Record<string,unknown>)=>'MAGIC_ORDER_RESULT '+JSON.stringify({ok:true,stop:'target',casts:0,coinsSpent:0,bought:{air:0,mind:0},eats:0,hpMin:9,...r});
const logout='LOGOUT logged-out\nRESULT ok magic-order target';
const cast=(n:number,purchased=false)=>Array.from({length:n},(_,i)=>'MAGIC_ORDER_CAST '+JSON.stringify({cast:i+1,purchased})).join('\n');
const purchase=(p:Record<string,unknown>)=>'MAGIC_ORDER_PURCHASE '+JSON.stringify({rune:'Mind rune',packBefore:{air:38,mind:0,coins:300},...p});

test('fixtures match the work order shapes',()=>{
 expect(FIXTURES.varrock.position).toEqual({x:3185,z:3436,level:0});
 expect(FIXTURES.varrock.bank).toContainEqual({id:AIR,count:37});
 expect(FIXTURES.varrock.bank).toContainEqual({id:MIND,count:31});
 expect(FIXTURES.short.bank.some(i=>i.id===MIND)).toBe(false);
 for(const f of Object.values(FIXTURES)){expect(f.bank.some(i=>i.id===COINS&&i.count>0)).toBe(true);expect(f.inventory.some(i=>i.id===TROUT)).toBe(true);}
 expect(CASES.map(c=>c.label)).toEqual(['varrock','rerun','short']);
 expect(CASES.map(c=>c.mode)).toEqual(['progress','refusal','refusal']);
 // The rerun repeats the varrock account and target, so it starts at the target.
 expect(CASES[1].fixture).toBe('varrock');expect(CASES[1].env.TARGET_LEVEL).toBe(CASES[0].env.TARGET_LEVEL);
 expect(CASES[0].env.TARGET_LEVEL).toBe('15');
 expect(CASES.find(c=>c.label==='short')!.env.RUNE_BUDGET).toBe('0');
 expect(ADMISSION).toEqual({floorGb:FREE_FLOOR_GB,startupGb:PRACTICE_STARTUP_GB});
});
test('fixture checks read the saved shape',()=>{
 const s=save({at:{x:3185,z:3436},pack:[{id:TROUT,count:1},{id:TROUT,count:1},{id:TROUT,count:1},{id:1351,count:1}],bank:FIXTURES.varrock.bank});
 expect(fixtureChecks(s,'varrock')).toBe(true);
 expect(fixtureChecks({...s,position:{x:3186,z:3436,level:0}},'varrock')).toBe(false);
 expect(fixtureChecks(save({at:{x:3185,z:3436},bank:FIXTURES.varrock.bank,hp:9}),'varrock')).toBe(false);
});

test('food fixtures prevent the item333 3->0 debit from one pinned slot deletion',()=>{
 // consume_effect_stat uses inv_delslot(inv, last_slot), not a quantity debit.
 for(const fixture of ['varrock','short'] as const){
  const f=FIXTURES[fixture],before=save({at:f.position,pack:f.inventory,bank:f.bank});
  const food=before.inventories[93]!.filter(i=>i.id===TROUT);
  expect(food.map(i=>i.count)).toEqual(Array(fixture==='varrock'?3:2).fill(1));
  expect(fixtureChecks(before,fixture)).toBe(true);
  const after=save({at:f.position,pack:f.inventory.slice(1),bank:f.bank});
  expect(totals(before).get(TROUT)!-totals(after).get(TROUT)!).toBe(1);
  const malformed=save({at:f.position,pack:[{id:TROUT,count:food.length},...f.inventory.filter(i=>i.id!==TROUT)],bank:f.bank});
  expect(fixtureChecks(malformed,fixture)).toBe(false);
 }
});
test('totals add pack, worn and bank; log lines parse by prefix',()=>{
 const s=save({pack:[{id:AIR,count:3}],bank:[{id:AIR,count:4},{id:COINS,count:9}]});
 expect(totals(s).get(AIR)).toBe(7);expect(totals(s).get(COINS)).toBe(9);
 expect(lines('MAGIC_ORDER_CAST {"cast":1}\nMAGIC_ORDER_CASTX {}\nother\nMAGIC_ORDER_CAST {"cast":2}','MAGIC_ORDER_CAST').map(c=>c.cast)).toEqual([1,2]);
 expect(unrelatedKept(s,save({pack:[{id:AIR,count:1}],bank:[{id:COINS,count:2}]}))).toBe(true);
 expect(unrelatedKept(save({bank:[{id:1511,count:5}]}),save({bank:[{id:1511,count:4}]}))).toBe(false);
 expect(unrelatedKept(save(),save({bank:[{id:1511,count:1}]}))).toBe(false);
});
const before=save({at:{x:3185,z:3436},pack:[{id:TROUT,count:3},{id:1351,count:1}],bank:[{id:AIR,count:37},{id:MIND,count:31},{id:COINS,count:400},{id:1511,count:5}]});
const after=save({pack:[{id:TROUT,count:2},{id:1351,count:1}],bank:[{id:AIR,count:23},{id:MIND,count:17},{id:COINS,count:400},{id:1511,count:5}],magic:{xp:1900,level:15}});
const goodLog=[cast(14),'MAGIC_ORDER_EAT {"id":333}',result({casts:14,eats:1}),logout].join('\n');
test('a progress segment reconciles casts, runes, coins, food and banking',()=>{
 const c=progressChecks(before,after,goodLog,ok,15,200,100);
 expect(c).toEqual({runeDebitMatched:true,coinDebit:true,foodEaten:true,unrelatedAssets:true,alive:true,purchaseOnlyWhenShort:true,
  exit:true,oneResult:true,level:true,castsExact:true,resultAccounting:true,budget:true,leftoversBanked:true,logout:true});
});
test('progress fails on a lost rune, an uneaten food debit, carried leftovers, a missing logout or a short level',()=>{
 const lost=save({...{pack:[{id:TROUT,count:2},{id:1351,count:1}]},bank:[{id:AIR,count:22},{id:MIND,count:17},{id:COINS,count:400},{id:1511,count:5}],magic:{xp:1900,level:15}});
 expect(progressChecks(before,lost,goodLog,ok,15,200,100).runeDebitMatched).toBe(false);
 expect(progressChecks(before,after,[cast(14),result({casts:14,eats:1}),logout].join('\n'),ok,15,200,100).foodEaten).toBe(false);
 // A run that took no damage need not eat; its food stays and the accounting still holds.
 const uneaten=save({pack:[{id:TROUT,count:3},{id:1351,count:1}],bank:[{id:AIR,count:23},{id:MIND,count:17},{id:COINS,count:400},{id:1511,count:5}],magic:{xp:1900,level:15}});
 const noEat=progressChecks(before,uneaten,[cast(14),result({casts:14,eats:0}),logout].join('\n'),ok,15,200,100);
 expect(noEat.foodEaten&&noEat.resultAccounting).toBe(true);
 expect(progressChecks(before,uneaten,goodLog,ok,15,200,100).foodEaten).toBe(false);
 const carried=save({pack:[{id:TROUT,count:2},{id:1351,count:1},{id:AIR,count:23},{id:MIND,count:17}],bank:[{id:COINS,count:400},{id:1511,count:5}],magic:{xp:1900,level:15}});
 expect(progressChecks(before,carried,goodLog,ok,15,200,100).leftoversBanked).toBe(false);
 expect(progressChecks(before,after,goodLog.replace('LOGOUT logged-out','LOGOUT timeout'),ok,15,200,100).logout).toBe(false);
 expect(progressChecks(before,after,goodLog,ok,16,200,100).level).toBe(false);
 expect(progressChecks(before,after,goodLog,{...ok,code:1},15,200,100).exit).toBe(false);
});
const dBefore=save({at:{x:3092,z:3243},pack:[{id:TROUT,count:4},{id:590,count:1}],bank:[{id:AIR,count:40},{id:MIND,count:2},{id:COINS,count:600},{id:1511,count:5}]});
// 2 owned casts, bought 9 mind for 36 coins, then 1 cast; the second rune pair is still carried.
const dMiddle=save({pack:[{id:TROUT,count:4},{id:590,count:1},{id:AIR,count:37},{id:MIND,count:8},{id:COINS,count:564}],bank:[{id:1511,count:5}],magic:{xp:550,level:5}});
test('a purchase made while carried runes could still cast is a double purchase',()=>{
 const seg=segmentChecks(dBefore,dMiddle,[cast(2),purchase({requested:9,bought:9,spent:36,packBefore:{air:38,mind:1,coins:300}}),cast(1,true)].join('\n'));
 expect(seg.checks.purchaseOnlyWhenShort).toBe(false);
 const coins=segmentChecks(dBefore,dMiddle,[cast(2),purchase({requested:9,bought:9,spent:35}),cast(1,true)].join('\n'));
 expect(coins.checks.coinDebit).toBe(false);
});
test('a refusal leaves skills and every item unchanged and logs out',()=>{
 const log=[result({ok:false,stop:'short runes',missing:{air:0,mind:1}}),'LOGOUT logged-out','RESULT fail magic-order short runes'].join('\n');
 const s=save({pack:[{id:TROUT,count:2}],bank:[{id:AIR,count:10},{id:COINS,count:300}]});
 const fail={code:1,timedOut:false};
 expect(refusalChecks(s,s,log,fail,'short runes')).toEqual({exit:true,refused:true,unchanged:true,noAction:true,logout:true});
 expect(refusalChecks(s,save({pack:[{id:TROUT,count:2},{id:AIR,count:10}],bank:[{id:COINS,count:300}]}),log,fail,'short runes').unchanged).toBe(false);
 expect(refusalChecks(s,save({pack:[{id:TROUT,count:2}],bank:[{id:AIR,count:9},{id:COINS,count:300}]}),log,fail,'short runes').unchanged).toBe(false);
 expect(refusalChecks(s,s,log,ok,'short runes').exit).toBe(false);
 expect(refusalChecks(s,s,log,fail,'already at target').refused).toBe(false);
});
