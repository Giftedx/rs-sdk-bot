import {test,expect} from 'bun:test';
import {initialState} from '../src/coordinator';
import {plannerPrompt,gameCoverage,supplyBillSummary} from '../src/coordinator-planner';
import * as planner from '../src/coordinator-planner';

import {copyFileSync,mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {snapshot} from '../../../scripts/fleet-sync';
import {supplyBill} from '../../planner/src/supply-bill';

const world={coverage:{scriptCandidates:[]},statuses:[],jobs:[],capabilities:[]} as any;

test('live status projection keeps dated stock available to the planner',()=>{
 const base=mkdtempSync(join(tmpdir(),'planner-assets-'));
 const statusDir=join(base,'.practice/status');
 mkdirSync(statusDir,{recursive:true});
 const live={server:'rs-sdk-demo.fly.dev',at:300_101,bankAt:100,inventory:[{id:565,count:50}],
  bank:[{id:995,count:1200},{id:565,count:60}],pos:{x:12,z:34}};
 for(const [name,status] of Object.entries({Helper:live,Haggis:live,Practice:{...live,practice:true},
  Other:{...live,server:'localhost'}})){
  writeFileSync(join(statusDir,name+'.json'),JSON.stringify({name,...status}));
 }
 const statuses=planner.readPlannerStatuses(base,join(base,'fleet'),'local');
 expect(statuses.map(s=>s.name).sort()).toEqual(['Haggis','Helper']);
 expect(planner.assetSummary(statuses,['haggis'],300_101)).toEqual([
  {account:'Helper',side:'local',at:'12,34',statusAt:300_101,bankAt:100,
   recent:{coins:0,stacks:['Blood rune 50']},verify:{coins:1200,stacks:['Blood rune 10']}},
 ]);
});

test('planner discovers its published and adopted accounts without local files or invented execution evidence',()=>{
 const base=mkdtempSync(join(tmpdir(),'planner-published-')),fleetDir=join(base,'fleet'),server='rs-sdk-demo.fly.dev';
 mkdirSync(join(fleetDir,'snapshots'),{recursive:true});
 writeFileSync(join(fleetDir,'owners.json'),JSON.stringify({accounts:{Helper:{side:'cloud',server},Adopted:{side:'cloud',server},Other:{side:'local',server}}}));
 const helper={name:'Helper',server,at:100,skills:[{name:'Fishing',level:99,xp:13034431}],bank:[{id:995,count:10}],bankAt:50,
  questJournal:[{id:1,name:'Cook',state:'complete'}],questsAt:40,result:'ok stale session',started:1,sessionAttemptId:'old',workRevision:'old',counters:{banked:99},ledger:{idle:100}};
 writeFileSync(join(fleetDir,'snapshots/cloud.json'),JSON.stringify({side:'cloud',at:1000,accounts:[helper]}));
 writeFileSync(join(fleetDir,'snapshots/local.json'),JSON.stringify({side:'local',at:1000,accounts:[{name:'Adopted',server,at:80,skills:[{name:'Mining',level:85}]},{name:'Other',server,at:100,skills:[{name:'Magic',level:99}]}]}));
 const statuses=planner.readPlannerStatuses(base,fleetDir,'cloud');
 expect(statuses.map(s=>s.name).sort()).toEqual(['Adopted','Helper']);
 expect(statuses.find(s=>s.name==='Helper')).toMatchObject({side:'cloud',at:100,bankAt:50,questsAt:40,quests:helper.questJournal,observation:'fleet-snapshot',snapshotOnly:true});
 for(const row of statuses){expect(row.result).toBeUndefined();expect(row.started).toBeUndefined();expect(row.sessionAttemptId).toBeUndefined();expect(row.workRevision).toBeUndefined();expect(row.counters).toBeUndefined();expect(row.ledger).toBeUndefined();}
 const coverage=gameCoverage([],[],statuses,[],[]);
 expect(coverage.skills.find(s=>s.name==='Fishing')?.bestObserved).toEqual({account:'Helper',level:99,at:100});
 expect(coverage.skills.find(s=>s.name==='Mining')?.bestObserved).toEqual({account:'Adopted',level:85,at:80});
});

test('planner selects matching live local state over its old publication and excludes former-owner and practice files',()=>{
 const base=mkdtempSync(join(tmpdir(),'planner-observation-')),fleetDir=join(base,'fleet'),statusDir=join(base,'.practice/status'),server='rs-sdk-demo.fly.dev';
 for(const dir of [join(fleetDir,'snapshots'),statusDir])mkdirSync(dir,{recursive:true});
 writeFileSync(join(fleetDir,'owners.json'),JSON.stringify({accounts:{Helper:{side:'cloud',server},Mover:{side:'local',server},Practice:{side:'cloud',server},Wrong:{side:'cloud',server}}}));
 const local={name:'Helper',server,at:200,started:150,sessionAttemptId:'150-10-1',workRevision:'a'.repeat(64),workEntry:'scripts/shop-buyer.ts',tick:20,result:'ok boughtTotal=12',counters:{boughtTotal:12},ledger:{idle:1},bankAt:160};
 for(const [file,row]of Object.entries({Helper:local,Mover:{name:'Mover',server,at:999},Practice:{name:'Practice',server,at:999,practice:true},Wrong:{name:'Wrong',server:'localhost:8888',at:999},Imposter:{name:'Victim',server,at:999}}))writeFileSync(join(statusDir,file+'.json'),JSON.stringify(row));
 writeFileSync(join(fleetDir,'snapshots/cloud.json'),JSON.stringify({side:'cloud',accounts:[{...local,at:100},{name:'Practice',server,at:100},{name:'Wrong',server,at:100},{name:'Victim',server,at:100}]}));
 const rows=planner.readPlannerStatuses(base,fleetDir,'cloud');
 expect(rows.map(s=>s.name)).toEqual(['Helper','Practice','Wrong','Victim']);
 expect(rows[0]).toMatchObject({...local,side:'cloud',snapshotOnly:false,observation:'local-status'});
 expect(rows.slice(1).map(s=>[s.at,s.snapshotOnly])).toEqual([[100,true],[100,true],[100,true]]);
});

test('planner prompt retains bounded numeric output and source bindings beyond its result excerpt',()=>{
 const status={name:'Helper',server:'rs-sdk-demo.fly.dev',at:500,started:100,sessionAttemptId:'100-10-1',workRevision:'a'.repeat(64),workEntry:'scripts/shop-buyer.ts',tick:400,
  result:'ok '+'x'.repeat(300)+' bankedTotal=123456789',skills:[],counters:{bankedTotal:123456789,targetMet:1,nested:{banked:999},negative:-1,infinite:Infinity,label:'not numeric'},ledger:{idle:5,move:3,secret:'not numeric'}};
 const compact=planner.plannerStatusSummary(status);
 expect(compact.result!.length).toBeLessThanOrEqual(163);expect(compact.result).not.toContain('bankedTotal');
 expect(compact).toMatchObject({started:100,sessionAttemptId:'100-10-1',workRevision:status.workRevision,workEntry:status.workEntry,tick:400,counters:{bankedTotal:123456789,targetMet:1},ledger:{idle:5,move:3}});
 const prompt=plannerPrompt(initialState(),{...world,statuses:[status]} as any);
 expect(prompt).toContain('"bankedTotal":123456789');expect(prompt).toContain('"sessionAttemptId":"100-10-1"');expect(prompt).toContain('advisory observations');
 expect(planner.plannerStatusSummary({counters:Object.fromEntries(Array.from({length:100},(_,i)=>['count'+i,i]))}).counters).toEqual(expect.any(Object));
 expect(Object.keys(planner.plannerStatusSummary({counters:Object.fromEntries(Array.from({length:100},(_,i)=>['count'+i,i]))}).counters).length).toBe(64);
});

test('planner asset summaries expose shared holders without refreshing their bank observations',()=>{
 const now=1_000_000;
 const assets=planner.assetSummary([{name:'Remote',side:'cloud',server:'rs-sdk-demo.fly.dev',at:now,
  bankAt:100,bank:[{id:995,count:2000}],inventory:[{id:565,count:50}]}],[],now);
 expect(assets).toEqual([{account:'Remote',side:'cloud',at:null,statusAt:now,bankAt:100,
  recent:{coins:0,stacks:['Blood rune 50']},verify:{coins:2000,stacks:[]}}]);
 const prompt=plannerPrompt(initialState(),world);
 expect(prompt).toContain('bestLive and progress count the fleet');
 expect(prompt).toContain('request another side\'s supplies through fleet orders');
 expect(planner.assetSummary([{name:'lowercase',side:'cloud',server:'rs-sdk-demo.fly.dev',at:now,bankAt:now,bank:[{id:995,count:2000}]}],[],now))
  .toEqual([{account:'lowercase',side:'cloud',at:null,statusAt:now,bankAt:now,recent:{coins:2000,stacks:[]},verify:{coins:0,stacks:[]}}]);
});

test('the live planner gets current route demand even when a legacy bill is present',()=>{
 const base=mkdtempSync(join(tmpdir(),'planner-current-demand-')),fleetDir=join(base,'snapshots');
 for(const dir of ['knowledge','research','.practice/coordinator','snapshots'])mkdirSync(join(base,dir),{recursive:true});
 const root=join(import.meta.dir,'../../..');
 copyFileSync(join(root,'knowledge/items.json'),join(base,'knowledge/items.json'));
 writeFileSync(join(base,'.practice/coordinator/supply-bill.json'),JSON.stringify({at:10,rows:[{item:'Old composite kit',need:1}]}));
 const options={base,fleetDir,source:'route' as const,now:1_000_000};
 expect(supplyBillSummary(options)).toBeNull();
 copyFileSync(join(root,'research/hiscores-live.json'),join(base,'research/hiscores-live.json'));
 const summary=supplyBillSummary(options);
 expect(summary).toMatchObject({at:options.now,scope:'overall',unmapped:[]});
 expect(summary?.snapshotAt).toEqual(expect.any(String));
 expect(summary?.overallFinish).toBeGreaterThan(0);
 expect(summary?.short.some(r=>r.item==='Old composite kit')).toBe(false);
});

test('planner separates the main Overall record from specialist board wins',()=>{
 const prompt=plannerPrompt(initialState(),world);
 expect(prompt).not.toContain('main rank1 on all24boards simultaneously');
 expect(prompt).toMatch(/Haggis rank\s*1 Overall under the record/);
 expect(prompt).toContain('specialist rank 1 on skill boards with a priced winning margin');
 expect(prompt).toContain('price each specialist route against the current board record before treating it as a target');
 expect(prompt).toContain('actual rank 1 results for the priced specialist targets');
 expect(prompt).not.toContain('rank1 on every available scoreboard');
 expect(gameCoverage([],[],[],[],[]).otherGoals).toContain('main Overall record');
});

test('planner completion requires the fresh account and bosses, not fleet coverage totals',()=>{
 const prompt=plannerPrompt(initialState(),world);
 expect(prompt).toContain('one fresh completion account');
 expect(prompt).toContain('every available boss defeated');
 expect(prompt).toContain('fleet-wide coverage, not completion proof');
 expect(prompt).toContain('current game state and scoreboards');
 expect(prompt).not.toContain('the project ends only when world.scoreboard.progress.done is true');
});

test('cross-side helper leads do not bar required completion or scored progression',()=>{
 const led={...world,statuses:[{name:'Haggis',skills:[{name:'Mining',level:1}]}],
  scoreboard:{fleet:{side:'local'},fleetSkills:[{skill:'Mining',best:85,side:'cloud',account:'OtherMiner'}]}};
 const prompt=plannerPrompt(initialState(),led as any);
 expect(prompt).toContain('For ordinary helper batches, do not queue work');
 expect(prompt).toContain('The fresh completion account and scored main/specialist routes follow their own required progression and clocks');
 expect(prompt).toContain('Ordinary helper batches target the next unlock');
 expect(prompt).toContain('Completion and scored routes may span a qualified method-switching ladder');
});

test('planner keeps old or undated supplies visible for verification and uses the original cross-side bank time', () => {
 const base=mkdtempSync(join(tmpdir(),'planner-stock-'));
 const now=1_000_000, server='rs-sdk-demo.fly.dev', fleetDir=join(base,'snapshots');
 const names=['Arrow shaft','Feather','Headless arrow'];
 const items=names.map((name,i)=>({id:i+1,name}));
 const stack=(id:number,count:number)=>({id,count});
 for (const dir of ['knowledge','.practice/coordinator','.practice/status','snapshots']) mkdirSync(join(base,dir),{recursive:true});
 writeFileSync(join(base,'knowledge/items.json'),JSON.stringify(items));
 writeFileSync(join(base,'.practice/coordinator/supply-bill.json'),JSON.stringify({
  at:now,rows:names.map(item=>({item,need:10,short:0,holders:[]})),
 }));
 writeFileSync(join(base,'.practice/status/Local.json'),JSON.stringify({
  name:'Local',server,at:now-100,bankAt:now-300_001,bank:[stack(1,10)],inventory:[stack(2,3)],
 }));
 const owners=new Map([['helper',{side:'cloud' as const,server}]]);
 const remote=snapshot([{
  name:'Helper',server,at:now-100,bankAt:now-500,bank:[stack(2,7)],
 }],'cloud',owners,now);
 expect(remote.accounts[0].bankAt).toBe(now-500);
 remote.accounts.push({name:'Legacy',server,at:now-50,bank:[stack(3,6)]});
 writeFileSync(join(fleetDir,'cloud.json'),JSON.stringify(remote));
 const summary=supplyBillSummary({base,now,fleetDir,side:'local'});
 expect(summary?.scope).toBe('unknown');
 expect(summary?.recentlyCovered).toBe(1);
 expect(summary?.verificationNeeded).toBe(2);
 expect(summary?.verify).toEqual([
  {item:'Arrow shaft',need:10,recent:0,toVerify:10,holders:[{account:'Local',count:10}]},
  {item:'Headless arrow',need:10,recent:0,toVerify:6,holders:[{account:'Legacy',count:6}]},
 ]);
 expect(summary?.short).toEqual([{item:'Headless arrow',need:10,short:4,holders:[{account:'Legacy',count:6}]}]);
});

test('a cached bill and a legacy bill report the same shortage for shared base stock', () => {
 const base=mkdtempSync(join(tmpdir(),'planner-shared-stock-'));
 const now=1_000_000,server='rs-sdk-demo.fly.dev',fleetDir=join(base,'snapshots');
 const items=[{id:1995,name:'Unfermented wine'}];
 const demands=[{item:'Unfermented wine (noted)',count:600},{item:'Unfermented wine',count:600}];
 const status={name:'Helper',server,at:now,bankAt:now,bank:[{id:1995,count:600}]};
 for(const dir of ['knowledge','.practice/coordinator','.practice/status','snapshots'])mkdirSync(join(base,dir),{recursive:true});
 writeFileSync(join(base,'knowledge/items.json'),JSON.stringify(items));
 writeFileSync(join(base,'.practice/status/Helper.json'),JSON.stringify(status));
 for(const rows of [demands.map(r=>({item:r.item,need:r.count})),supplyBill(demands,items,[status])]){
  writeFileSync(join(base,'.practice/coordinator/supply-bill.json'),JSON.stringify({at:now,rows}));
  const summary=supplyBillSummary({base,now,fleetDir,side:'local'});
  expect(summary?.recentlyCovered).toBe(0);
  expect(summary?.short).toEqual([{
   item:'Unfermented wine (noted)',aliases:['Unfermented wine'],need:1200,short:600,holders:[{account:'Helper',count:600}],
  }]);
 }
});

test('the planner keeps an exact kit ID when repricing a saved bill', () => {
 const base=mkdtempSync(join(tmpdir(),'planner-exact-kit-')),now=1_000_000,fleetDir=join(base,'snapshots');
 const items=[{id:2503,name:'Dragonhide body'},{id:2501,name:'Dragonhide body'}];
 for(const dir of ['knowledge','.practice/coordinator','.practice/status','snapshots'])mkdirSync(join(base,dir),{recursive:true});
 writeFileSync(join(base,'knowledge/items.json'),JSON.stringify(items));
 const rows=supplyBill([{item:'black dragonhide body',itemId:2503,count:1}],items,[]);
 writeFileSync(join(base,'.practice/coordinator/supply-bill.json'),JSON.stringify({at:now,rows}));
 writeFileSync(join(base,'.practice/status/Helper.json'),JSON.stringify({name:'Helper',server:'rs-sdk-demo.fly.dev',at:now,bankAt:now,bank:[{id:2501,count:4}]}));
 const summary=supplyBillSummary({base,now,fleetDir,side:'local'});
 expect(summary?.unmapped).toEqual([]);
 expect(summary?.short).toEqual([{item:'black dragonhide body',itemId:2503,need:1,short:1,holders:[]}]);
});
