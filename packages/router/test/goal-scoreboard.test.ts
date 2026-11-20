import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {buildOwnerGoals,COMBAT_SKILLS} from '../src/goal-scoreboard';
import {improved,type Progress} from '../src/coverage';
import {writeKillReceipt,type KillInput} from '../../core/src/kill-receipt';
import {SPECIALIST_BOARDS} from '../../core/src/specialist-boards';

const NOW=1_800_000_000_000,SERVER='rs-sdk-demo.fly.dev';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function put(root:string,path:string,value:unknown){const file=join(root,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(value));}
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'owner-goals-'));roots.push(root);
 const skills=['attack','strength','defence','hitpoints','ranged','prayer','magic','cooking','woodcutting','fletching','fishing','firemaking','crafting','smithing','mining','herblore','agility','thieving','runecraft'];
 put(root,'research/hiscores-live.json',{base:'https://'+SERVER,tickMs:400,takenAt:new Date(NOW-1000).toISOString(),boards:[{board:'Overall',category:0,rows:[{rank:1,name:'Record',level:1881,ticks:100}]}]});
 put(root,'packages/planner/src/haggis-boards.json',{places:{},activities:[{id:'all-skills',label:'all skills',serves:skills,ticks:{floor:100,realistic:100},xp:Object.fromEntries(skills.map(s=>[s,'to99'])),supplies:[{item:'Shark',itemId:385,count:10}],evidence:'MEASURED',source:'fixture'}]});
 put(root,'knowledge/items.json',[{id:385,name:'Shark',debugname:'shark'},{id:995,name:'Coins',debugname:'coins'},{id:1,name:'Unrelated item'}]);
 put(root,'swarm.json',{army:[],jobs:[]});
 return root;
}
const status=(name:string,extra:Record<string,unknown>={})=>({name,server:SERVER,at:NOW-1000,bankAt:NOW-1000,inventory:[],equipment:[],bank:[],...extra});
const progress=(metrics:Record<string,number>):Progress=>({skillLevels:0,skills99:0,questsLive:0,questTotal:0,itemsHeld:0,actionsNamed:0,goalVersion:1,goalMetrics:metrics,done:false,remaining:[]});
const moved=(a:ReturnType<typeof buildOwnerGoals>,b:ReturnType<typeof buildOwnerGoals>)=>improved(progress(a.metrics),progress(b.metrics));
const collectionKey=(g:ReturnType<typeof buildOwnerGoals>,target:string)=>Object.keys(g.metrics).find(key=>key===target||key.startsWith(target+':observations='));
const collectionValue=(g:ReturnType<typeof buildOwnerGoals>,target:string)=>{const key=collectionKey(g,target);return key===undefined?undefined:g.metrics[key];};

test('Overall gap uses the two percent launch margin and model evidence cannot claim a recorded win',()=>{
 const root=fixture(),g=buildOwnerGoals({root,now:NOW,statuses:[],questNames:['Cook']});
 expect(g.main).toMatchObject({modelTicks:100,recordTicks:100,launchTargetTicks:98,gapTicks:2,rank:null,rank1:null});
 expect(g.metrics['main.gapTicks:record=100']).toBe(-2);
 expect(g.done).toBe(false);
 expect(g.remaining.some(s=>/Overall/.test(s))).toBe(true);
});

test('only capped supply for a named consumer moves collection progress',()=>{
 const root=fixture();
 const run=(sharks:number,coins:number,unrelated:number)=>buildOwnerGoals({root,now:NOW,questNames:[],statuses:[status('Supplier',{bank:[{id:385,count:sharks},{id:995,count:coins},{id:1,count:unrelated}]})]});
 const empty=run(1,1,1),supply=run(10,1,1),surplus=run(100,999999,999);
 expect(empty.collection.missing).toContainEqual({item:'Shark',id:385,need:10,owned:1,consumer:'main Overall'});
 expect(collectionValue(supply,'collection.units:main Overall:id=385:need=10')).toBe(10);
 expect(surplus.metrics).toEqual(supply.metrics);
 expect(surplus.collection.scopeKnown).toBe(false);
 expect(surplus.done).toBe(false);
});

test('a proved Overall win retires the launch supply consumer',()=>{
 const root=fixture(),g=buildOwnerGoals({root,now:NOW,questNames:[],statuses:[status('Haggis',{ranksAt:NOW-1000,ranks:[{board:'Overall',rank:1,level:1881}]})]});
 expect(g.main.rank1).toBe(true);
 expect(g.collection.missing).toEqual([]);
 expect(g.collection.targets).toBe(0);
});

test('army tracks seven base skills on each declared account and rejects practice or boosted observations',()=>{
 const root=fixture();put(root,'swarm.json',{army:['First','Second','Haggis'],jobs:[]});
 const skills=COMBAT_SKILLS.map(name=>({name,level:99}));
 const g=buildOwnerGoals({root,now:NOW,questNames:[],statuses:[status('First',{skills}),status('Second',{skills:skills.map(s=>s.name==='Prayer'?{...s,level:98,currentLevel:120}:s)}),status('Helper',{skills}),status('Second',{practice:true,at:NOW,skills})]});
 expect(g.army.roster).toEqual(['first','second']);
 expect(g.army.maxed).toBe(1);
 expect(g.army.missingLevels).toBe(1);
 expect(g.army.accounts.find(a=>a.account==='second')?.levels.Prayer).toBe(98);
 expect(g.army.creditedKills).toBeNull();expect(g.army.wildernessControl).toBeNull();
 expect(g.metrics['army.level:first:Prayer:target=99']).toBe(99);
 expect(g.metrics['army.level:second:Prayer:target=99']).toBe(98);
 expect(g.metrics['army.levels']).toBeUndefined();
});

test('old pack, worn and bank stock cannot cover a current named supply consumer',()=>{
 const root=fixture(),g=buildOwnerGoals({root,now:NOW,questNames:[],statuses:[
  status('OldPack',{at:NOW-300_001,inventory:[{id:385,count:10}],equipment:[{id:385,count:10}]}),
  status('OldBank',{bankAt:NOW-300_001,bank:[{id:385,count:10}]}),
 ]});
 expect(g.collection.missing).toContainEqual({item:'Shark',id:385,need:10,owned:0,verifyOwned:10,consumer:'main Overall'});
 expect(g.collection.evidence.some(e=>/old|stale|refresh/i.test(e.gap??''))).toBe(true);
});

test('changing the record or supply target starts a new metric baseline',()=>{
 const root=fixture(),before=buildOwnerGoals({root,now:NOW,questNames:[],statuses:[status('Supplier',{bank:[{id:385,count:5}]})]});
 put(root,'research/hiscores-live.json',{base:'https://'+SERVER,tickMs:400,takenAt:new Date(NOW-1000).toISOString(),boards:[{board:'Overall',category:0,rows:[{rank:1,name:'Record',level:1881,ticks:200}]}]});
 put(root,'packages/planner/src/haggis-boards.json',{places:{},activities:[{id:'all-skills',label:'all skills',serves:['overall'],ticks:{floor:100,realistic:100},xp:Object.fromEntries(['attack','strength','defence','hitpoints','ranged','prayer','magic','cooking','woodcutting','fletching','fishing','firemaking','crafting','smithing','mining','herblore','agility','thieving','runecraft'].map(s=>[s,'to99'])),supplies:[{item:'Shark',itemId:385,count:20}],evidence:'MEASURED',source:'fixture'}]});
 const after=buildOwnerGoals({root,now:NOW,questNames:[],statuses:[status('Supplier',{bank:[{id:385,count:5}]})]});
 expect(before.metrics['main.gapTicks:record=100']).toBe(-2);
 expect(after.metrics['main.gapTicks:record=100']).toBeUndefined();
 expect(after.metrics['main.gapTicks:record=200']).toBe(0);
 expect(collectionValue(after,'collection.units:main Overall:id=385:need=10')).toBeUndefined();
 expect(collectionValue(after,'collection.units:main Overall:id=385:need=20')).toBe(5);
});

test('fresh owned skill ranks count wins and stale or foreign rank claims cannot count',()=>{
 const root=fixture(),g=buildOwnerGoals({root,now:NOW,questNames:[],statuses:[
  status('Winner',{ranksAt:NOW-1000,ranks:[{board:'Ranged',rank:1,level:99}]}),
  status('Old',{ranksAt:NOW-3_600_001,ranks:[{board:'Agility',rank:1,level:99}]}),
  status('Wrong',{ranksAt:NOW-1000,ranks:[{board:'Magic',rank:1,level:99,server:'localhost:8888'}]}),
 ]});
 expect(g.specialists.rank1s.map(r=>[r.account,r.board])).toEqual([['winner','Ranged']]);
 expect(g.specialists.targets.map(t=>t.board).sort()).toEqual(Object.values(SPECIALIST_BOARDS).map(b=>b.name).sort());
 expect(g.metrics['specialists.rank1:winner:Ranged']).toBe(1);
});

test('quest completion is the union of implemented journal names, with absent observations kept unknown',()=>{
 const root=fixture(),g=buildOwnerGoals({root,now:NOW,questNames:['Cook','Sheep'],statuses:[
  status('First',{quests:[{name:'Cook',state:'complete'},{name:'Not implemented',state:'complete'}],questsAt:NOW-1000}),
  status('Second',{quests:[{name:'Cook',state:'complete'},{name:'Sheep',state:'started'}],questsAt:NOW-1000}),
 ]});
 expect(g.quests).toMatchObject({complete:1,total:2,remaining:['Sheep'],observedAccounts:2});
 expect(g.metrics['quests.complete:Cook']).toBe(1);
 expect(g.metrics['quests.complete:Sheep']).toBeUndefined();
});

test('canonical owner plans keep a former side from reassigning army or kit targets',()=>{
 const root=fixture(),fleetDir=join(root,'fleet');
 put(root,'fleet/owners.json',{accounts:{Moved:{side:'cloud',server:SERVER}}});
 put(root,'swarm.json',{army:['Moved'],builds:{Moved:'tribrid'},jobs:[]});
 put(root,'fleet/plans/cloud.json',{side:'cloud',army:[],builds:{},jobs:[]});
 // Levels under the roster rule (Attack, Strength, Defence 90): only a plan list could admit the account.
 const g=buildOwnerGoals({root,fleetDir,now:NOW,questNames:[],statuses:[status('Moved',{side:'cloud',skills:COMBAT_SKILLS.map(name=>({name,level:50}))})]});
 expect(g.army.roster).toEqual([]);
 expect(g.collection.missing.every(m=>!m.consumer.startsWith('army:'))).toBe(true);
});

test('the roster rule counts the observed melee-90 accounts that no hand job holds, and other sides only as they publish',()=>{
 const root=fixture(),fleetDir=join(root,'fleet');
 put(root,'fleet/owners.json',{accounts:{Maxed:{side:'local',server:SERVER},Low:{side:'local',server:SERVER},Held:{side:'local',server:SERVER},Theirs:{side:'claude-cloud',server:SERVER},Published:{side:'claude-cloud',server:SERVER},Haggis:{side:'local',server:SERVER},Shaftshooter:{side:'local',server:SERVER},Reserved:{side:'local',server:SERVER}}});
 put(root,'swarm.json',{army:[],jobs:[{account:'Held',script:'scripts/goldfarm.ts',enabled:true},{account:'Reserved',role:'pvp',enabled:false,goal:'reserved: gang squad'}]});
 put(root,'fleet/plans/claude-cloud.json',{side:'claude-cloud',army:['Published'],jobs:[]});
 const all=(level:number)=>COMBAT_SKILLS.map(name=>({name,level}));
 const g=buildOwnerGoals({root,fleetDir,now:NOW,questNames:[],statuses:[status('Maxed',{side:'local',skills:all(99)}),status('Low',{side:'local',skills:all(89)}),status('Held',{side:'local',skills:all(99)}),
  status('Theirs',{side:'claude-cloud',skills:all(99)}),status('Published',{side:'claude-cloud',skills:all(99)}),status('Haggis',{side:'local',skills:all(99)}),status('Shaftshooter',{side:'local',skills:all(99)}),status('Reserved',{side:'local',skills:all(99)})]});
 expect(g.army.roster).toEqual(['maxed','published']);
 expect(g.army.maxed).toBe(2);
 expect(g.metrics['army.maxed:maxed']).toBe(1);
});

test('refreshing the same expired bank stock cannot reset the useful-progress watchdog',()=>{
 const root=fixture(),metric='collection.units:main Overall:id=385:need=10';
 const first=buildOwnerGoals({root,now:NOW,questNames:[],statuses:[status('Supplier',{bank:[{id:385,count:10}]})]});
 const agedAt=NOW+300_001,aged=buildOwnerGoals({root,now:agedAt,questNames:[],statuses:[status('Supplier',{at:agedAt,bank:[{id:385,count:10}]})]});
 const refreshed=buildOwnerGoals({root,now:agedAt+1,questNames:[],statuses:[status('Supplier',{at:agedAt+1,bankAt:agedAt+1,bank:[{id:385,count:10}]})]});
 expect(collectionValue(first,metric)).toBe(10);
 expect(aged.collection.missing[0]?.verifyOwned).toBe(10);
 expect(collectionValue(aged,metric)).toBeUndefined();
 expect(collectionValue(refreshed,metric)).toBe(10);
 expect(moved(aged,refreshed)).toBe(false);
});

test('restoring a missing army observation does not count the same levels or maxed account twice',()=>{
 const root=fixture();put(root,'swarm.json',{army:['Soldier'],jobs:[]});
 const observed=status('Soldier',{skills:COMBAT_SKILLS.map(name=>({name,level:99}))});
 const first=buildOwnerGoals({root,now:NOW,questNames:[],statuses:[observed]}),missing=buildOwnerGoals({root,now:NOW+1,questNames:[],statuses:[]}),restored=buildOwnerGoals({root,now:NOW+2,questNames:[],statuses:[observed]});
 expect(first.metrics['army.level:soldier:Prayer:target=99']).toBe(99);
 expect(missing.metrics['army.level:soldier:Prayer:target=99']).toBeUndefined();
 expect(missing.metrics['army.maxed:soldier']).toBeUndefined();
 expect(restored.metrics['army.maxed:soldier']).toBe(1);
 expect(moved(missing,restored)).toBe(false);
});

test('restoring unchanged expired rank wins does not count a new Overall or specialist win',()=>{
 const root=fixture(),ranks=(at:number)=>[status('Winner',{at,ranksAt:at,ranks:[{board:'Ranged',rank:1}]}),status('Haggis',{at,ranksAt:at,ranks:[{board:'Overall',rank:1}]})];
 const first=buildOwnerGoals({root,now:NOW,questNames:[],statuses:ranks(NOW-1000)}),later=NOW+3_600_001;
 const expired=buildOwnerGoals({root,now:later,questNames:[],statuses:ranks(NOW-1000)}),restored=buildOwnerGoals({root,now:later+1,questNames:[],statuses:ranks(later+1)});
 expect(first.metrics['main.rank1']).toBe(1);
 expect(expired.metrics['main.rank1']).toBeUndefined();
 expect(expired.metrics['specialists.rank1:winner:Ranged']).toBeUndefined();
 expect(restored.metrics['specialists.rank1:winner:Ranged']).toBe(1);
 expect(moved(expired,restored)).toBe(false);
});

test('restoring quest journal evidence does not count its durable completion again',()=>{
 const root=fixture(),observed=status('Quester',{questsAt:NOW-1000,quests:[{name:'Cook',state:'complete'}]});
 const first=buildOwnerGoals({root,now:NOW,questNames:['Cook'],statuses:[observed]}),missing=buildOwnerGoals({root,now:NOW+1,questNames:['Cook'],statuses:[]}),restored=buildOwnerGoals({root,now:NOW+2,questNames:['Cook'],statuses:[observed]});
 expect(first.metrics['quests.complete:Cook']).toBe(1);
 expect(missing.metrics['quests.complete:Cook']).toBeUndefined();
 expect(moved(missing,restored)).toBe(false);
});

test('known empty supply, incomplete quest and non-winning rank baselines still detect actual gains',()=>{
 const root=fixture();put(root,'swarm.json',{army:['Soldier'],jobs:[]});
 const run=(gain:boolean)=>buildOwnerGoals({root,now:NOW,questNames:['Cook'],statuses:[status('Supplier',{bank:gain?[{id:385,count:1}]:[],questsAt:NOW-1000,quests:[{name:'Cook',state:gain?'complete':'started'}],ranksAt:NOW-1000,ranks:[{board:'Ranged',rank:gain?1:2}]}),status('Soldier',{skills:COMBAT_SKILLS.map(name=>({name,level:name==='Prayer'&&!gain?98:99})),questsAt:NOW-1000,quests:[{name:'Cook',state:'not started'}]})]});
 const before=run(false),after=run(true);
 expect(collectionValue(before,'collection.units:main Overall:id=385:need=10')).toBe(0);
 expect(collectionValue(after,'collection.units:main Overall:id=385:need=10')).toBe(1);
 expect(before.metrics['quests.complete:Cook']).toBe(0);expect(after.metrics['quests.complete:Cook']).toBe(1);
 expect(before.metrics['specialists.rank1:supplier:Ranged']).toBe(0);expect(after.metrics['specialists.rank1:supplier:Ranged']).toBe(1);
 expect(before.metrics['army.level:soldier:Prayer:target=99']).toBe(98);expect(after.metrics['army.level:soldier:Prayer:target=99']).toBe(99);
 expect(moved(before,after)).toBe(true);
});

test('first stock observations from an already owned holder change the baseline instead of inventing an acquisition',()=>{
 const root=fixture(),fleetDir=join(root,'fleet'),target='collection.units:main Overall:id=385:need=10';
 put(root,'fleet/owners.json',{accounts:{Empty:{side:'local',server:SERVER},Unknown:{side:'local',server:SERVER}}});
 const empty=status('Empty'),before=buildOwnerGoals({root,fleetDir,now:NOW,questNames:[],statuses:[empty]});
 const known=(count:number,at:number)=>status('Unknown',{at,bankAt:at,bank:[{id:385,count}]});
 const observed=buildOwnerGoals({root,fleetDir,now:NOW+1,questNames:[],statuses:[empty,known(7,NOW+1)]});
 const gained=buildOwnerGoals({root,fleetDir,now:NOW+2,questNames:[],statuses:[empty,known(8,NOW+2)]});
 expect(collectionValue(before,target)).toBe(0);
 expect(collectionValue(observed,target)).toBe(7);
 expect(collectionKey(before,target)).not.toBe(collectionKey(observed,target));
 expect(moved(before,observed)).toBe(false);
 expect(collectionKey(observed,target)).toBe(collectionKey(gained,target));
 expect(moved(observed,gained)).toBe(true);
});

test('only a live kill receipt of an own account for a stranger gives a credited player kill',()=>{
 const root=fixture(),killRoot=join(root,'.practice/kill-receipts');put(root,'swarm.json',{army:['First'],jobs:[]});
 const statuses=[status('First'),status('Second')];
 const build=()=>buildOwnerGoals({root,now:NOW,questNames:[],statuses});
 const kill=(patch:Partial<KillInput>={}):KillInput=>({session:{server:SERVER},account:'First',victim:'Goondelf',tick:730,tile:{x:3078,z:3640,level:0},wilderness:16,multi:true,
  message:'You have defeated Goondelf.',victimCombat:90,victimTile:{x:3079,z:3640},kit:{worn:[{slot:3,id:1215}],switches:{magic:[],ranged:[],melee:[1215]}},fight:{ticks:41,dealt:99,taken:30,eaten:2,specs:1},...patch});
 const none=build();
 expect(none.army.creditedKills).toBeNull();expect(none.army.kills).toEqual([]);expect(none.metrics['army.creditedKills']).toBe(0);
 expect(none.remaining).toContain('Credited player kills unknown');
 // A practice receipt stays in the practice tree. The same file copied into the live tree is refused by its own marks.
 const practice=writeKillReceipt(kill({session:{server:'localhost:43594'}}),{root:killRoot,now:()=>NOW-9000});
 expect(build().army.creditedKills).toBeNull();
 put(root,`.practice/kill-receipts/live/${SERVER}/first/${practice.receipt.id}.json`,practice.receipt);
 // A kill of an own account is a spar, and a receipt with a time after the observation is not accepted.
 writeKillReceipt(kill({victim:'Second',message:'You have defeated Second.'}),{root:killRoot,now:()=>NOW-8000});
 writeKillReceipt(kill(),{root:killRoot,now:()=>NOW+1});
 const refused=build();
 expect(refused.army.creditedKills).toBeNull();expect(refused.metrics['army.creditedKills']).toBe(0);
 expect(refused.army.evidence.find(e=>e.source==='.practice/kill-receipts/live')?.gap).toBe('No credited live player-kill receipt on this machine; 3 refused (practice receipt, time is not in the past, victim is an own account); receipts of other fleet sides are not read');
 const live=writeKillReceipt(kill(),{root:killRoot,now:()=>NOW-7000});
 writeKillReceipt(kill({account:'Second',victim:'Ligma',message:'Ligma falls before your might.',multi:false,wilderness:3}),{root:killRoot,now:()=>NOW-6000});
 const credited=build();
 expect(credited.army.creditedKills).toBe(2);expect(credited.metrics['army.creditedKills']).toBe(2);
 expect(credited.army.kills).toEqual([
  {account:'first',victim:'Goondelf',at:NOW-7000,wilderness:16,multi:true,feedMatched:null,receipt:`.practice/kill-receipts/live/${SERVER}/first/${live.receipt.id}.json`},
  expect.objectContaining({account:'second',victim:'Ligma',at:NOW-6000,wilderness:3,multi:false}),
 ]);
 expect(credited.army.evidence.find(e=>e.source==='.practice/kill-receipts/live')).toMatchObject({at:NOW-6000,ageMs:6000});
 expect(credited.remaining).not.toContain('Credited player kills unknown');expect(credited.remaining).toContain('Wilderness control unknown');
 expect(credited.army.wildernessControl).toBeNull();expect(credited.done).toBe(false);
 expect(moved(refused,credited)).toBe(true);
});
