import {describe,expect,test} from 'bun:test';
import {controlView,publicView,trimState,withSides,MAIN_MARK,WHY_LIMIT,FINISHED_KEEP,stateWarm} from './publish-relay';

const state=()=>({now:1,bots:[
  {name:'CoinCock',env:{target:null},sessionAttemptId:'1-2',workRevision:'abc',inputs:{},coordinatorRunId:null,bank:[{name:'Coins',count:5}],pos:{x:1,z:2},reserved:false},
  {name:MAIN_MARK,reserved:true,bank:[],env:{}},
 ],coordination:{available:true,tasks:[{id:'t1',why:'w'.repeat(1000),detail:'d'.repeat(1000),status:'pending'}]},
 sys:{freeGB:5,procs:[{pid:1,script:'swarm.ts'}]},viewerTimings:[{ms:1}],vault:{coins:9},collection:{items:[]},economy:{supplies:[{name:'Lobster',ask:100}],pricesAt:7,goldPerTick:3,farmers:[{name:'CoinCock'}],trend:[1]},mainPlan:{rows:[{board:'Overall',note:`${MAIN_MARK} first`}]},requests:{open:[{id:'1',request:'owner words'}]},race:{rows:[]},gates:{go:false},
 fleetSides:{at:1,sides:[{side:'cloud',at:1,late:false,accounts:[{name:'TossTheCaber',at:1,total:40,coins:900},{name:MAIN_MARK,at:1,total:1,coins:1}]}],orders:[{from:'BowBeforeMe',to:'Shaftsinker',item:'Air talisman',count:1}]},
 roster:[['Zezima',1,2,0,99],[MAIN_MARK,3,4,0,3]],rivals:[{board:'Attack',at:1,ours:{rank:2,name:MAIN_MARK},rows:[{rank:1,name:'Zezima'},{rank:2,name:MAIN_MARK}]}],
 contention:[{side:'local',resource:'knight:1,2',others:['Zezima',MAIN_MARK],ours:[MAIN_MARK]}],lookups:{zezima:{name:'Zezima'},[MAIN_MARK]:{name:MAIN_MARK}},
 farms:[{label:'Money ##',names:['Money 01',MAIN_MARK]}],overtake:[{board:'Attack',account:'CoinCock'},{board:'Magic',account:MAIN_MARK}]});
const meta={nonce:'secret-nonce',goals:['wealth'],roles:['supply'],paused:false,fleetPaused:false,capabilities:[],accountHolds:[{name:'AFKnight',owner:'other'}],requests:[{id:'r1',action:'plan',at:1,status:'plan-requested'}]};

describe('hosted views',()=>{
 test('trimState caps task texts and leaves the rest',()=>{
  const t=trimState(state());
  expect(t.coordination.tasks[0].why).toHaveLength(WHY_LIMIT);
  expect(t.coordination.available).toBe(true);
  expect(trimState({bots:[]})).toEqual({bots:[]});
  const many=Array.from({length:FINISHED_KEEP+50},(_,i)=>({id:'f'+i,status:i%2?'failed':'succeeded',finishedAt:i}));
  const kept=trimState({coordination:{tasks:[{id:'p',status:'pending'},...many,{id:'r',status:'running'}]}}).coordination.tasks;
  expect(kept).toHaveLength(FINISHED_KEEP+2);
  expect(kept.slice(0,2).map((t:any)=>t.id)).toEqual(['p','r']);
  expect(kept[2].id).toBe('f'+(FINISHED_KEEP+49));
 });
 test('control keeps every bot and holding, carries the operator metadata without its nonce, and the reveal name',()=>{
  const c=controlView(state(),meta);
  expect(c.mainPlan.rows[0].note).toBe(`${MAIN_MARK} first`);expect(c.requests.open[0].request).toBe('owner words');
  expect(c.bots).toHaveLength(2);
  expect(c.bots[0].bank[0].count).toBe(5);
  expect(c.control).toEqual({goals:['wealth'],roles:['supply'],paused:false,fleetPaused:false,capabilities:[],accountHolds:[{name:'AFKnight',owner:'other'}],requests:meta.requests});
  expect(JSON.stringify(c)).not.toContain('secret-nonce');
  expect(c.revealName).toBe('Haggis');
  expect(controlView(state(),null).control).toBeNull();
 });
 test('public drops the main account row, private bot fields, the process list and viewer timings; keeps the map data',()=>{
  const p=publicView(state());
  expect(p.bots.map((b:any)=>b.name)).toEqual(['CoinCock']);
  for(const f of ['env','sessionAttemptId','workRevision','inputs','coordinatorRunId','bank','bankAt'])expect(f in p.bots[0]).toBe(false);
  expect(p.bots[0].pos).toEqual({x:1,z:2});
  expect(p.economy).toEqual({supplies:[{name:'Lobster',ask:100}],pricesAt:7,itemValues:{},itemExamine:{},goldPerTick:0,farmers:[],trend:[]});
  // Everything outside the whitelist is absent: banks, the plan, host resources, scripts, pull requests.
  for(const k of ['vault','collection','sys','viewerTimings','mainPlan','race','gates','requests','objectives','gapHistory','scripts','prs','capacity','swarm','scoreboard','overtake','chain'])expect(k in p).toBe(false);
  expect(p.coordination.tasks).toEqual([]);expect(p.coordination.available).toBe(true);expect(JSON.stringify(p)).not.toContain('w'.repeat(50));
  expect(JSON.stringify(p)).not.toContain('owner words');
  expect(p.fleetSides.sides[0].accounts).toEqual([{name:'TossTheCaber',at:1,total:40}]);
  // Orders between our own accounts are the owner's logistics.
  expect('orders' in p.fleetSides).toBe(false);
  expect(p.roster).toEqual([['Zezima',1,2,0,99]]);expect(p.rivals[0].ours).toBeNull();expect(p.rivals[0].rows).toEqual([{rank:1,name:'Zezima'}]);
  expect(p.contention[0].others).toEqual(['Zezima']);expect(p.contention[0].ours).toEqual([]);expect(Object.keys(p.lookups)).toEqual(['zezima']);
  expect(p.farms[0].names).toEqual(['Money 01']);
  expect(p.hosted.kind).toBe('public');
 });
 test('a state that still names the main account is refused',()=>{
  expect(()=>publicView({bots:[{name:'CoinCock',goal:'give to Haggis'}]})).toThrow('nothing published');
  expect(()=>publicView({bots:[],roster:[['x',1,2,0,3]],farms:[{names:['n'],label:'haggis ##'}]})).toThrow('nothing published');
  // A field outside the whitelist cannot trip the check: it never reaches the public file.
  expect('mainPlan' in publicView({bots:[],mainPlan:{note:'haggis route'},objectives:{lanes:[{next:'haggis route'}]}})).toBe(false);
 });
 test('public bots keep game-visible fields and lose run counters, banks and coordinator internals',()=>{
  const b={name:'CoinCock',pos:{x:1,z:2},skills:[{name:'Attack',level:5,xp:400}],inventory:[{name:'Coins',count:9}],equipment:[],ranks:[],goal:'coins [task-1a2b] buy (607 short): 1630 bronze in the bank',currentGoal:'run-ranged-coincock-owned-band50',
   phase:'banked=15000 packCoins=5100',phaseShort:'banked 15.0K',result:'ok banked=15000',lastRes:{text:'ok banked=15000'},ledger:{coins:1},counters:{banked:15000},job:{script:'x'},planJob:{next:'y'},nativeProof:{ok:true},timeline:'xxi',role4:{coinsPerTick:3},bank:[{name:'Coins',count:1}],bankAt:1,env:{a:1}};
  const p=publicView({bots:[b],results:[{at:1,name:'CoinCock',ok:true,goal:'coins [task-9]',text:'ok banked=15000 packCoins=5100',counters:{banked:15000}}],events:[{at:1,name:'CoinCock',text:'banked 15.0K',full:'banked=15000'}]});
  expect(Object.keys(p.bots[0]).sort()).toEqual(['currentGoal','equipment','goal','inventory','name','pos','ranks','skills']);
  expect(p.bots[0].goal).toBe('coins buy');expect(p.bots[0].currentGoal).toBe('Ranged training');
  expect(p.results).toEqual([{at:1,name:'CoinCock',ok:true,practice:undefined,text:'coins'}]);expect(p.events).toEqual([]);
  expect(JSON.stringify(p)).not.toMatch(/banked|packCoins|15000/);
 });
});

describe('withSides',()=>{
 test('each bot names its side; unlisted accounts are local; other state is untouched',()=>{
  const s=withSides({now:1,bots:[{name:'CoinCock'},{name:'CloudBot'}]},new Map([['cloudbot',{side:'cloud'}]]));
  expect(s.bots.map((b:any)=>b.side)).toEqual(['local','cloud']);
  expect(s.now).toBe(1);
  expect(withSides({bots:null},new Map())).toEqual({bots:null});
 });
});

test('public item values cover only what public bots carry or wear',()=>{
 const p=publicView({bots:[{name:'CoinCock',inventory:[{name:'Lobster',count:2}],equipment:[{name:'Bronze axe'}],bank:[{name:'Rune bar',count:9}]}],
  economy:{supplies:[],pricesAt:1,itemValues:{Lobster:150,'Bronze axe':16,'Rune bar':5000},itemExamine:{Lobster:'This looks tasty.','Rune bar':'A bar of rune.'}}});
 expect(p.economy.itemValues).toEqual({Lobster:150,'Bronze axe':16});expect(p.economy.itemExamine).toEqual({Lobster:'This looks tasty.'});
});

test('a state is warm once the server has read the market and the board tops',()=>{
 expect(stateWarm({rivals:[],economy:{pricesAt:1}})).toBe(false);
 expect(stateWarm({rivals:[{board:'Overall'}],economy:{pricesAt:null}})).toBe(false);
 // The server's value before its first market read.
 expect(stateWarm({rivals:[{board:'Overall'}],economy:{pricesAt:0}})).toBe(false);
 expect(stateWarm({rivals:[{board:'Overall'}],economy:{pricesAt:1}})).toBe(true);
});
