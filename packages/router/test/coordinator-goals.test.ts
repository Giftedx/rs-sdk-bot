import {test,expect} from 'bun:test';
import {initialState} from '../src/coordinator';
import {plannerPrompt,gameCoverage,supplyBillSummary} from '../src/coordinator-planner';

import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {snapshot} from '../../../scripts/fleet-sync';
import {supplyBill} from '../../planner/src/supply-bill';

const world={coverage:{scriptCandidates:[]},statuses:[],jobs:[],capabilities:[]} as any;

test('planner separates the main Overall record from specialist board wins',()=>{
 const prompt=plannerPrompt(initialState(),world);
 expect(prompt).not.toContain('main rank1 on all24boards simultaneously');
 expect(prompt).toMatch(/Haggis rank\s*1 Overall under the record/);
 expect(prompt).toContain('specialists rank1 on every available scoreboard');
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
