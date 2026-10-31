import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { goalPlan,goalProgress,type GoalInputs } from './goals';
test('dashboard goals come from the current plan, not the historical request ledger', () => {
    const text=readFileSync(new URL('../../docs/plans/joined-plan.md',import.meta.url),'utf8');
    const plan=goalPlan(text);
    expect(plan.available).toBe(true);expect(plan.paused).toBe(false);
    expect(plan.lanes.map(l=>l.title)).toContain('Specialist hiscores');
    expect(plan.lanes.every(l=>l.target.length>0&&l.next.length>0)).toBe(true);
    expect(goalPlan('').available).toBe(false);
    const paused=text.replace(/^\*\*Live work authorized.*$/m,'**Execution paused by the user.**').replace('## Goals and next evidence','## Goals and next evidence after resume');
    expect(goalPlan(paused)).toEqual({...plan,paused:true});
    expect(goalPlan(text.replace(/^## Lanes\s*$/m,'## Historical goals')).available).toBe(false);
    const legacy=text.replace(/^## Lanes\s*$/m,'## Goals and next evidence');
    expect(goalPlan(legacy)).toEqual(plan);
    expect(goalPlan(legacy.replace('## Goals and next evidence','## Goals and next evidence after resume'))).toEqual(plan);
    // A later unrelated table must not fill a missing lane in the owning section.
    expect(goalPlan(text.replace(/^\| Specialist hiscores.*\r?\n/m,'')+'\n## Archive\n| Specialist hiscores | Old | Old |\n').available).toBe(false);
});

const now=1_000_000;
const bot=(name='Worker')=>({name,server:'rs-sdk-demo.fly.dev',at:now-1000,bankAt:now-1000,bank:[{id:314,name:'Feather',count:100}],equipment:[],skills:[{name:'Mining',level:99,xp:2_000_000},{name:'Stat18',level:99,xp:2_000_000}],ranks:[],operation:'observed'});
const inputs=():GoalInputs=>({requirements:[{item:'Feathers',count:100},{item:'Bronze sword',count:1}],items:[{id:314,name:'Feather'},{id:1277,name:'Bronze sword'}],quests:[{questPoints:1}],questConstants:'^first_questpoints = 1\n^second_questpoints = 2',receipts:{}});
const state=(bots:any[]=[bot()]):any=>({now,bots,boards:[{board:'Mining'},{board:'Equipment',kind:'value'}],objectives:{paused:true},race:null,gates:null});
test('supply coverage uses resolved IDs and recent owned banks; missing stock is not an unknown item',()=>{
 const s=state(),g=goalProgress(s,inputs());expect(g[1]!.metric).toBe('1/2');
 expect(g[1]!.rows.find(r=>r.label==='Bronze sword')?.value).toBe('0/1 recent · 0 old');
 expect(g[1]!.blocker).toContain('0 input IDs unresolved');
 s.bots[0].bankAt=now-300001;expect(goalProgress(s,inputs())[1]!.metric).toBe('0/2');
 s.bots[0].bankAt=now+1;expect(goalProgress(s,inputs())[1]!.rows.find(r=>r.label==='Feathers')?.value).toBe('0/100 recent · 0 old');
 const foreign=[{...bot(),practice:true},{...bot('Main'),reserved:true},{...bot('Local'),server:'localhost:8888'}];expect(goalProgress(state(foreign),inputs())[1]!.metric).toBe('0/2');
});
test('catalog completeness, account skill progress and unlock proof are distinct',()=>{
 const i=inputs();i.receipts.guildPractice={ok:true,code:0,assetCheck:true,result:{gained:6,bankAfter:{at:now-1000}}};i.receipts.guildLive={at:now-500,ok:false,baseline:{ok:true}};
 const g=goalProgress(state(),i)[2]!;expect(g.metric).toBe('1/19 at 99');
 expect(g.rows.find(r=>r.label==='Reward extract')?.value).toBe('1/2 · 1/3 QP');
 expect(g.rows.find(r=>r.label==='Guild chain · live')?.value).toBe('failed / stopped');
 expect(g.rows.find(r=>r.label==='Guild chain · practice')?.value).toContain('cloned inputs');
 expect(g.blocker).toContain('0/1 account journals observed');
});
test('failed or future receipt cannot supply a completed delivery or output rate',()=>{
 const i=inputs();i.receipts.delivery={at:now-1000,ok:true,result:{ok:true,results:[{name:'Worker',target:50,result:{incoming:50}}]},after:[{...bot(),bank:[{id:333,count:50}]}]};
 i.receipts.production={at:now-1000,status:{...bot(),result:'ok banked=100'},logTail:['RESULT ok banked=100 ticks=20 eaten=2 died=false','LOGOUT logged-out']};
 let g=goalProgress(state(),i);expect(g[0]!.metric).toBe('50 fish');expect(g[5]!.metric).toBe('5 c/t');expect(g[5]!.blocker).toContain('Net-cost');expect(g[0]!.next).toContain('After resume');
 i.receipts.delivery.after=[{...bot('Other'),bank:[{id:333,count:50}]}];expect(goalProgress(state([bot(),bot('Other')]),i)[0]!.metric).toBe('No proof');
 i.receipts.apron={at:now-1000,ok:true,assetCheck:true,code:0,after:bot(),result:{bank:{items:{}}}};expect(()=>goalProgress(state(),i)).not.toThrow();
 i.receipts.apron.result.bank.items=[null];i.receipts.delivery.after=[{...bot(),bank:[null]}];expect(()=>goalProgress(state(),i)).not.toThrow();
 i.receipts.delivery.ok=false;i.receipts.production.at=now+1;g=goalProgress(state(),i);expect(g[0]!.metric).toBe('No proof');expect(g[5]!.metric).toBe('Unknown');
 i.receipts.delivery.result.results=[null];expect(()=>goalProgress(state(),i)).not.toThrow();
});
test('specialist selection excludes stale, future, main and practice ranks; model is not live progress',()=>{
 const s=state([{...bot(),ranksAt:now-1000,ranks:[{board:'Mining',rank:12,level:99}]},{...bot('Old'),ranksAt:1,ranks:[{board:'Mining',rank:1,level:99}]},{...bot('Future'),ranksAt:now+1,ranks:[{board:'Mining',rank:1,level:99}]}]);
 s.race={wins:1,unmeasured:9,sourceAt:now-5000,rows:[{id:'overall',deadline:100,real:{finish:125,slack:-25}}]};
 const g=goalProgress(s,inputs());expect(g[3]!.metric).toBe('0 #1');expect(g[3]!.next).toContain('Worker');expect(g[3]!.next).toContain('#12');expect(g[4]!.metric).toBe('25 late');expect(g[4]!.level).toBe('MODEL');
});

test('catalog aliases resolve real coins and strung bows without counting lookalikes',()=>{
 const i=inputs();i.requirements=[{item:'coins',count:10},{item:'magic shortbow',count:1}];i.items=[{id:617,name:'Coins',debugname:'fake_coins'},{id:995,name:'Coins',debugname:'coins'},{id:72,name:'Magic shortbow',debugname:'unstrung_magic_shortbow'},{id:861,name:'Magic shortbow',debugname:'magic_shortbow'}];
 const b={...bot(),bank:[{id:617,count:100},{id:72,count:1}]};expect(goalProgress(state([b]),i)[1]!.metric).toBe('0/2');b.bank=[{id:995,count:10},{id:861,count:1}];expect(goalProgress(state([b]),i)[1]!.metric).toBe('2/2');
 const malformed={...i,items:null,quests:{},questConstants:null} as any;expect(()=>goalProgress(state(),malformed)).not.toThrow();expect(goalProgress(state(),malformed)[2]!.blocker).toContain('Quest source unavailable');
});

test('owner columns and operational lanes preserve the six dashboard goal targets and positions',()=>{
 const titles=['Main Overall','Coverage','Specialist hiscores','Wealth / logistics / GE','Gear / collection','Efficiency / visibility'];
 const legacy='## Lanes\n| Lane | Target | Next |\n|---|---|---|\n'+titles.map(t=>`| ${t} | target ${t} | next ${t} |`).join('\n');
 const named='## Lanes\n| Lane | Owner | Target | Next |\n|---|---|---|---|\n| Autopilot | Claude cloud | automate jobs | planner |\n'+[...titles].reverse().map(t=>`| ${t} | worker | target ${t} | next ${t} |`).join('\n');
 expect(goalPlan(named).lanes.map(({owner,...row})=>row)).toEqual(goalPlan(legacy).lanes);expect(goalPlan(named).available).toBe(true);
 expect(goalPlan(named).lanes[2]).toEqual({title:'Specialist hiscores',target:'target Specialist hiscores',next:'next Specialist hiscores',owner:'worker'});
});
