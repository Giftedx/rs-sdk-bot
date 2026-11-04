import {expect,test} from 'bun:test';
import {caseChecks,childChecks,childConfiguration,firemakingFixture,keptAssets,progressChecks,refusalChecks,savedBurns,
 cases,NATIVE_ADMISSION_GB,RAW_PER_LOG,TARGET,ENTRY,RECOVERY_AFTER,type Kind} from '../src/firemaking-order-proof';
import {xpForLevel,levelForXp} from '../../../scripts/firemaking-order';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';

type Item={slot:number;id:number;count:number};
type Save={version:number;position:{x:number;z:number;level:number};skills:{index:number;rawExperience:number;xp:number;level:number}[];vars:Record<number,number>;inventories:Record<number,Item[]>};
const LOG=1511,TB=590,COINS=995;
const items=(list:{id:number;count:number}[])=>list.filter(i=>i.count>0).map((i,slot)=>({slot,...i}));
function fixture(kind:'entry'|'short'):Save{
 const f=firemakingFixture(kind),skills=Array.from({length:21},(_,index)=>({index,rawExperience:0,xp:0,level:1}));
 for(const [index,name] of [[0,'Attack'],[1,'Defence'],[2,'Strength'],[3,'Hitpoints'],[8,'Woodcutting'],[9,'Fletching']] as const){
  const level=f.skills![name]!,xp=xpForLevel(level);skills[index]={index,level,xp,rawExperience:xp*10};
 }
 return{version:9,position:f.position as Save['position'],skills,vars:{134:100},inventories:{93:items(f.inventory??[]),94:[],95:items(f.bank??[])}};
}
const clone=<T>(v:T):T=>structuredClone(v);
function completed(before:Save):Save{
 const after=clone(before);after.position={x:2810,z:3433,level:0};after.vars[134]=200;
 after.skills[11]={index:11,rawExperience:2*RAW_PER_LOG,xp:2*RAW_PER_LOG/10,level:levelForXp(2*RAW_PER_LOG/10)};
 after.inventories[95]=items(after.inventories[95]!.filter(i=>i.id!==TB).map(i=>({...i,count:i.count-(i.id===LOG?2:0)})));
 after.inventories[93]!.push({slot:4,id:TB,count:1});return after;
}
const ok=()=>[
 `FIREMAKING_INITIAL ${JSON.stringify({position:ENTRY,hp:10,level:1,options:{target:TARGET,maxLogs:2,cap:2000,toolBudget:0,cashReserve:0}})}`,
 `FIREMAKING_ORDER_RESULT ${JSON.stringify({ok:true,stop:'target',level:15,logsBurnt:2,xpGained:2000,bankTrips:1,hpMin:10,tinderbox:{source:'bank',spent:0}})}`,
 'LOGOUT logged-out','RESULT ok firemaking-order'].join('\n');
const refusal=(reason:string)=>[`FIREMAKING_ORDER_RESULT ${JSON.stringify({ok:false,stop:'refused',refused:reason,logsBurnt:0})}`,'LOGOUT logged-out',`RESULT fail refused: ${reason}`].join('\n');
function delivery(){
 const start=fixture('entry'),done=completed(start),rerun=clone(done);rerun.vars[134]=250;
 const short=fixture('short'),shortAfter=clone(short);shortAfter.vars[134]=200;
 const files:Record<Kind,{before:Save;after:Save;log:string}>={entry:{before:start,after:done,log:ok()},
  rerun:{before:done,after:rerun,log:refusal('already at target')},
  short:{before:short,after:shortAfter,log:refusal('short log stock: need 1 Logs, own 0, shortfall 1')}};
 const receipts:Record<Kind,any>={entry:{name:'a',code:0,timedOut:false,persisted:true,before:'h0',after:'h1'},
  rerun:{name:'a',code:1,timedOut:false,persisted:true,before:'h1',after:'h2'},
  short:{name:'b',code:1,timedOut:false,persisted:true}};
 return{files,receipts};
}
const run=(d:ReturnType<typeof delivery>)=>Object.fromEntries(cases.map(id=>[id,caseChecks(id,k=>d.files[k],k=>d.receipts[k])]));
test('admission imports the shared startup limit and floor; recovery binds the failed consumer end',()=>{
 expect(NATIVE_ADMISSION_GB).toBe(Math.max(FREE_FLOOR_GB,PRACTICE_STARTUP_GB));
 expect(RECOVERY_AFTER).toBe(1793418022381);
 expect(cases).toEqual(['entry','rerun','short']);
});
test('recovery fixture keeps Shaftmaker ordinary skills and owned inputs at the exact rejected tile',()=>{
 const f=firemakingFixture('entry');
 expect(f.position).toEqual({x:2863,z:3428,level:0});
 expect(f.skills).toEqual({Attack:2,Defence:1,Strength:1,Hitpoints:10,Woodcutting:99,Fletching:99});
 expect(f.skills).not.toHaveProperty('Firemaking');expect(f.skills).not.toHaveProperty('Agility');
 expect(f.bank).toContainEqual({id:LOG,count:5074});expect(f.bank).toContainEqual({id:1521,count:25});
 expect(f.bank).toContainEqual({id:TB,count:1});expect(f.inventory).toContainEqual({id:COINS,count:80});
 expect(firemakingFixture('short').bank!.some(i=>i.id===LOG)).toBe(false);
});
test('real worker CLI retains the named consumer target, two-log cap and zero buying budget',()=>{
 const c=childConfiguration('flfmxabc1','entry',{PATH:'p',DEMO_OK:'1'});
 expect(c.cmd).toEqual(['bun','scripts/firemaking-order.ts','flfmxabc1']);
 expect(c.env).toMatchObject({PATH:'p',DEMO_OK:'',RANDOM_EVENTS:'0',TARGET_LEVEL:'15',MAX_LOGS:'2',CAP:'2000',LOG:'normal',TOOL_BUDGET:'0',CASH_RESERVE:'0'});
 expect(c.windowsHide).toBe(true);
});
test('saved XP, exact log debit, zero coin debit, tinderbox and unrelated assets must reconcile',()=>{
 const start=fixture('entry'),good=completed(start);
 expect(savedBurns(start,good)).toBe(2);expect(Object.values(progressChecks(start,good)).every(Boolean)).toBe(true);
 let bad=clone(good);bad.skills[11]!.rawExperience++;expect(savedBurns(start,bad)).toBeNaN();
 bad=clone(good);bad.inventories[95]!.find(i=>i.id===LOG)!.count--;expect(progressChecks(start,bad).logDebit).toBe(false);
 bad=clone(good);bad.inventories[93]!.find(i=>i.id===COINS)!.count--;expect(progressChecks(start,bad).coins).toBe(false);
 bad=clone(good);bad.inventories[93]=bad.inventories[93]!.filter(i=>i.id!==TB);expect(progressChecks(start,bad).tinderbox).toBe(false);
 bad=clone(good);bad.inventories[95]!.find(i=>i.id===1521)!.count--;expect(keptAssets(start,bad,[LOG])).toBe(false);
 bad=clone(good);bad.skills[11]!.xp=1000;bad.skills[11]!.level=levelForXp(1000);expect(progressChecks(start,bad).level).toBe(false);
 bad=clone(good);bad.inventories[93]!.push({slot:5,id:LOG,count:1});expect(progressChecks(start,bad).position).toBe(false);
 bad=clone(good);bad.position={x:3097,z:3248,level:0};expect(progressChecks(start,bad).position).toBe(false);
});
test('the real CLI result that returns to the selected Catherby bank after its two-log pack passes; other ends fail',()=>{
 const start=fixture('entry'),good=completed(start);good.position={x:2809,z:3441,level:0};
 expect(Object.values(progressChecks(start,good)).every(Boolean)).toBe(true);
 let bad=clone(good);bad.position={x:3092,z:3243,level:0};expect(progressChecks(start,bad).position).toBe(false);
 bad=clone(good);bad.position={x:2809,z:3441,level:1};expect(progressChecks(start,bad).position).toBe(false);
 bad=clone(good);bad.position={x:2809,z:3445,level:0};expect(progressChecks(start,bad).position).toBe(false);
 bad=clone(good);bad.inventories[93]!.push({slot:5,id:LOG,count:1});expect(progressChecks(start,bad).position).toBe(false);
});
test('a refusal preserves all containers and skills; absent and empty containers agree',()=>{
 const start=fixture('short'),after=clone(start);delete (start.inventories as any)[94];
 expect(Object.values(refusalChecks(start,after)).every(Boolean)).toBe(true);
 after.inventories[95]!.find(i=>i.id===1521)!.count--;expect(refusalChecks(start,after).assets).toBe(false);
});
test('child checks require one result, target success or the precise refusal, and confirmed logout',()=>{
 const c={code:0,timedOut:false};
 expect(Object.values(childChecks(c,ok(),'ok')).every(Boolean)).toBe(true);
 expect(childChecks(c,ok()+'\nWARN logout did not complete','ok').logout).toBe(false);
 expect(childChecks(c,ok()+'\n'+ok(),'ok').result).toBe(false);
 expect(Object.values(childChecks({code:1,timedOut:false},refusal('already at target'),'refusal',/^already at target$/)).every(Boolean)).toBe(true);
 expect(childChecks({code:1,timedOut:false},refusal('off plane 0'),'refusal',/^already at target$/).result).toBe(false);
});
test('the entry, unchanged rerun and short-stock saved-state consumer checks pass',()=>{
 const r=run(delivery());
 for(const id of cases)expect([id,Object.entries(r[id]!).filter(([,v])=>!v).map(([k])=>k)]).toEqual([id,[]]);
});
test('wrong recovery start, stronger actor, missing asset, reseeded rerun and unsaved logout fail',()=>{
 let d=delivery();d.files.entry.before.position.x=2734;expect(run(d).entry!.start).toBe(false);
 d=delivery();d.files.entry.before.skills[3]!.level=70;expect(run(d).entry!.start).toBe(false);
 d=delivery();d.files.entry.before.skills[1]!.level=70;expect(run(d).entry!.start).toBe(false);
 d=delivery();d.files.entry.before.skills[2]!.level=70;expect(run(d).entry!.start).toBe(false);
 d=delivery();d.files.entry.log=d.files.entry.log.replace('"cashReserve":0','"cashReserve":1');expect(run(d).entry!.cliEntry).toBe(false);
 d=delivery();d.files.entry.log=d.files.entry.log.replace('2863','2864');expect(run(d).entry!.cliEntry).toBe(false);
 d=delivery();d.files.entry.after.inventories[95]!.find(i=>i.id===1521)!.count--;expect(run(d).entry!.assets).toBe(false);
 d=delivery();d.receipts.rerun.before='other';expect(run(d).rerun!.sameAccount).toBe(false);
 d=delivery();d.files.entry.after.vars[134]=100;expect(run(d).entry!.savedLogout).toBe(false);
 d=delivery();d.files.rerun.after.position.x=3000;expect(run(d).rerun!.position).toBe(false);
});
