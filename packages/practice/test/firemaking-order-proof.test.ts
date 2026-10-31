import {expect,test} from 'bun:test';
import {caseChecks,childChecks,childConfiguration,firemakingFixture,interruptionDeadlineMs,keptAssets,progressChecks,refusalChecks,savedBurns,
 cases,NATIVE_ADMISSION_GB,RAW_PER_LOG,TARGET,type Kind} from '../src/firemaking-order-proof';
import {xpForLevel} from '../../../scripts/firemaking-order';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';

type Item={slot:number;id:number;count:number};
type Save={version:number;position:{x:number;z:number;level:number};skills:{index:number;rawExperience:number;xp:number;level:number}[];vars:Record<number,number>;inventories:Record<number,Item[]>};
const LOG=1511,TB=590,COINS=995,AXE=1351,FEATHER=314;
const items=(list:[number,number][])=>list.filter(([,n])=>n>0).map(([id,count],slot)=>({slot,id,count}));
function save(o:{x?:number;z?:number;fmRaw?:number;logout?:number;pack?:[number,number][];bank?:[number,number][];hp?:number}):Save{
 const skills=Array.from({length:21},(_,index)=>({index,rawExperience:0,xp:0,level:1}));
 skills[3]={index:3,rawExperience:11540,xp:1154,level:o.hp??10};skills[8]={index:8,rawExperience:108470,xp:10847,level:35};
 const raw=o.fmRaw??0,xp=Math.trunc(raw/10);let level=1;while(level<99&&xp>=xpForLevel(level+1))level++;
 skills[11]={index:11,rawExperience:raw,xp,level};
 return{version:9,position:{x:o.x??3092,z:o.z??3243,level:0},skills,vars:{134:o.logout??100},inventories:{93:items(o.pack??[]),94:[],95:items(o.bank??[])}};
}
const xpRaw=(burns:number)=>burns*RAW_PER_LOG;

test('admission uses the shared practice startup limit and free floor, and the save wait covers a killed socket',()=>{
 expect(NATIVE_ADMISSION_GB).toBe(Math.max(FREE_FLOOR_GB,PRACTICE_STARTUP_GB));
 expect(NATIVE_ADMISSION_GB).toBeGreaterThanOrEqual(FREE_FLOOR_GB);
 expect(interruptionDeadlineMs(150)).toBe(165000);
});
test('fixtures are ordinary: YewFirst bank shape, an away start with no tinderbox, and short normal-log stock',()=>{
 const a=firemakingFixture('yewfirst'),b=firemakingFixture('buy'),c=firemakingFixture('short');
 expect(a.position).toEqual({x:3092,z:3243,level:0});expect(a.bank).toContainEqual({id:LOG,count:3625});expect(a.bank).toContainEqual({id:TB,count:1});
 expect(b.position).toEqual({x:3089,z:3266,level:0});
 expect([...(b.bank??[]),...(b.inventory??[])].some(i=>i.id===TB)).toBe(false);
 expect([...(c.bank??[]),...(c.inventory??[])].some(i=>i.id===LOG)).toBe(false);
 for(const f of [a,b,c])expect(f.skills).not.toHaveProperty('Firemaking');
});
test('the child runs the installed CLI with bounded, parameterized limits and no live server',()=>{
 const c=childConfiguration('flfmxabc1','yewfirst',{PATH:'p',DEMO_OK:'1'});
 expect(c.cmd).toEqual(['bun','scripts/firemaking-order.ts','flfmxabc1']);
 expect(c.env).toMatchObject({PATH:'p',DEMO_OK:'',RANDOM_EVENTS:'0',TARGET_LEVEL:String(TARGET),LOG:'normal',TOOL_BUDGET:'50',CASH_RESERVE:'0'});
 expect(c.windowsHide).toBe(true);
 expect(childConfiguration('x','short').env.TARGET_LEVEL).toBe('10');
});
test('burns come only from whole-log saved XP effects',()=>{
 expect(savedBurns(save({}),save({fmRaw:xpRaw(29)}))).toBe(29);
 expect(savedBurns(save({}),save({fmRaw:xpRaw(29)+5}))).toBeNaN();
 expect(savedBurns(save({fmRaw:100}),save({}))).toBeNaN();
});
test('progress needs the level, an exact log and coin debit, the kept tinderbox and preserved assets',()=>{
 const start=save({x:3089,z:3266,pack:[[COINS,25]],bank:[[LOG,200],[COINS,500],[AXE,1],[FEATHER,50]]});
 const good=save({fmRaw:xpRaw(29),pack:[[COINS,20],[TB,1]],bank:[[LOG,171],[COINS,500],[AXE,1],[FEATHER,50]],logout:200});
 expect(Object.values(progressChecks(start,good,5,0)).every(Boolean)).toBe(true);
 const lostLog=save({fmRaw:xpRaw(29),pack:[[COINS,20],[TB,1]],bank:[[LOG,170],[COINS,500],[AXE,1],[FEATHER,50]]});
 expect(progressChecks(start,lostLog,5,0).logDebit).toBe(false);
 expect(progressChecks(start,good,6,0).coins).toBe(false);
 expect(progressChecks(start,good,51,0).coins).toBe(false);
 const lostTool=save({fmRaw:xpRaw(29),pack:[[COINS,20]],bank:[[LOG,171],[COINS,500],[AXE,1],[FEATHER,50]]});
 expect(progressChecks(start,lostTool,5,0).tinderbox).toBe(false);
 const lostAxe=save({fmRaw:xpRaw(29),pack:[[COINS,20],[TB,1]],bank:[[LOG,171],[COINS,500],[FEATHER,50]]});
 expect(progressChecks(start,lostAxe,5,0).assets).toBe(false);
 const short=save({fmRaw:xpRaw(28),pack:[[COINS,20],[TB,1]],bank:[[LOG,172],[COINS,500],[AXE,1],[FEATHER,50]]});
 expect(progressChecks(start,short,5,0).level).toBe(false);
 const carried=save({fmRaw:xpRaw(29),pack:[[COINS,20],[TB,1],[LOG,1]],bank:[[LOG,170],[COINS,500],[AXE,1],[FEATHER,50]]});
 expect(progressChecks(start,carried,5,0).position).toBe(false);
 expect(keptAssets(start,good,[LOG,TB,COINS])).toBe(true);
});
test('a refusal keeps every asset and skill, treating an absent container as empty',()=>{
 const before=save({bank:[[1521,5],[TB,1],[COINS,100]]});delete (before.inventories as any)[94];
 expect(Object.values(refusalChecks(before,save({bank:[[1521,5],[TB,1],[COINS,100]]}))).every(Boolean)).toBe(true);
 expect(refusalChecks(before,save({bank:[[1521,4],[TB,1],[COINS,100]]})).assets).toBe(false);
});
const ok=(burns:number,extra:Record<string,unknown>={})=>[`START 3092 3243 0`,...Array.from({length:burns},(_,i)=>`FIREMAKING_PROGRESS {"burns":${i+1}}`),
 `FIREMAKING_ORDER_RESULT ${JSON.stringify({ok:true,stop:'target',level:48,logsBurnt:burns,bankTrips:3,hpMin:10,tinderbox:{source:'bank',spent:0},...extra})}`,
 'LEDGER x bot=flfmx','LOGOUT logged-out','RESULT ok firemaking-order'].join('\n');
const refusal=(reason:string)=>[`FIREMAKING_ORDER_RESULT ${JSON.stringify({ok:false,stop:'refused',refused:reason,logsBurnt:0})}`,'LOGOUT logged-out',`RESULT fail refused: ${reason}`].join('\n');
test('child checks separate success, refusal and an abrupt interruption',()=>{
 const c={code:0,timedOut:false,interrupted:false};
 expect(Object.values(childChecks(c,ok(29),'ok')).every(Boolean)).toBe(true);
 expect(childChecks(c,ok(29)+'\nWARN logout did not complete','ok').logout).toBe(false);
 expect(childChecks(c,ok(29)+'\n'+ok(1),'ok').result).toBe(false);
 expect(Object.values(childChecks({...c,code:1},refusal('already at target'),'refusal',/^already at target$/)).every(Boolean)).toBe(true);
 expect(childChecks({...c,code:1},refusal('off plane 0'),'refusal',/^already at target$/).result).toBe(false);
 const killed='START 3089 3266 0\nFIREMAKING_PURCHASE {}\nFIREMAKING_PROGRESS {}\nFIREMAKING_PROGRESS {}\nFIREMAKING_PROGRESS {}';
 expect(Object.values(childChecks({code:1,timedOut:false,interrupted:true},killed,'killed')).every(Boolean)).toBe(true);
 expect(childChecks({code:1,timedOut:false,interrupted:true},killed+'\nLOGOUT logged-out','killed').noLogout).toBe(false);
});
// A complete synthetic delivery: every case passes, and each tamper fails exactly where expected.
function delivery(){
 const buyStart=save({x:3089,z:3266,pack:[[COINS,25]],bank:[[LOG,200],[COINS,500],[AXE,1],[FEATHER,50]]});
 const middle=save({x:3095,z:3248,fmRaw:xpRaw(4),logout:150,pack:[[COINS,20],[TB,1],[LOG,22]],bank:[[LOG,174],[COINS,500],[AXE,1],[FEATHER,50]]});
 const done=save({fmRaw:xpRaw(29),logout:200,pack:[[COINS,20],[TB,1]],bank:[[LOG,171],[COINS,500],[AXE,1],[FEATHER,50]]});
 const rerun=save({fmRaw:xpRaw(29),logout:250,pack:[[COINS,20],[TB,1]],bank:[[LOG,171],[COINS,500],[AXE,1],[FEATHER,50]]});
 const yewStart=save({bank:[[LOG,3625],[TB,1],[COINS,1000],[AXE,1]]});
 const yewDone=save({x:3093,fmRaw:xpRaw(29),logout:200,pack:[[TB,1]],bank:[[LOG,3596],[COINS,1000],[AXE,1]]});
 const shortStart=save({bank:[[1521,5],[TB,1],[COINS,100]]}),shortAfter=save({x:3093,logout:200,bank:[[1521,5],[TB,1],[COINS,100]]});
 const files:Record<Kind,{before:Save;after:Save;log:string}>={
  yewfirst:{before:yewStart,after:yewDone,log:ok(29)},
  buy:{before:buyStart,after:middle,log:'START 3089 3266 0\nFIREMAKING_PURCHASE {"bought":1,"spent":5}\n'+Array.from({length:3},(_,i)=>`FIREMAKING_PROGRESS {"burns":${i+1}}`).join('\n')},
  resume:{before:middle,after:done,log:ok(25,{tinderbox:{source:'pack',spent:0}})},
  rerun:{before:done,after:rerun,log:refusal('already at target')},
  short:{before:shortStart,after:shortAfter,log:refusal('short log stock: need 1 Logs, own 0, shortfall 1')},
 };
 const receipts:Record<Kind,any>={yewfirst:{name:'a',code:0,timedOut:false,interrupted:false,persisted:true},
  buy:{name:'b',code:1,timedOut:false,interrupted:true,persisted:true,before:'h0',after:'h1'},
  resume:{name:'b',code:0,timedOut:false,interrupted:false,persisted:true,before:'h1',after:'h2'},
  rerun:{name:'b',code:1,timedOut:false,interrupted:false,persisted:true,before:'h2',after:'h3'},
  short:{name:'c',code:1,timedOut:false,interrupted:false,persisted:true}};
 return{files,receipts};
}
const run=(d:ReturnType<typeof delivery>)=>Object.fromEntries(cases.map(id=>[id,caseChecks(id,k=>d.files[k] as any,k=>d.receipts[k])]));
test('a complete synthetic delivery passes every case check',()=>{
 const r=run(delivery());
 for(const id of cases)expect([id,Object.entries(r[id]!).filter(([,v])=>!v).map(([k])=>k)]).toEqual([id,[]]);
});
test('a reseeded resume, a lost interrupted log, a repeated purchase or an unsaved logout fails',()=>{
 let d=delivery();d.receipts.resume.before='other';expect(run(d).resume!.noReseed).toBe(false);
 d=delivery();d.files.buy.after.inventories[95]=items([[LOG,173],[COINS,500],[AXE,1],[FEATHER,50]]);expect(run(d).buy!.persisted).toBe(false);
 d=delivery();d.files.resume.log=d.files.resume.log.replace('START','FIREMAKING_PURCHASE {"bought":1,"spent":5}\nSTART');expect(run(d).resume!.receipt).toBe(false);
 d=delivery();d.files.yewfirst.after.vars[134]=100;expect(run(d).yewfirst!.savedLogout).toBe(false);
 d=delivery();d.files.rerun.after.position={x:3000,z:3000,level:0};expect(run(d).rerun!.position).toBe(false);
 d=delivery();d.files.short.after.inventories[95]=items([[1521,5],[TB,1],[COINS,99]]);expect(run(d).short!.assets).toBe(false);
});
