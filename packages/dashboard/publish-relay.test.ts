import {describe,expect,test} from 'bun:test';
import {controlView,publicView,trimState,withSides,MAIN_MARK,WHY_LIMIT,FINISHED_KEEP} from './publish-relay';

const state=()=>({now:1,bots:[
  {name:'CoinCock',env:{target:null},sessionAttemptId:'1-2',workRevision:'abc',inputs:{},coordinatorRunId:null,bank:[{name:'Coins',count:5}],pos:{x:1,z:2},reserved:false},
  {name:MAIN_MARK,reserved:true,bank:[],env:{}},
 ],coordination:{available:true,tasks:[{id:'t1',why:'w'.repeat(1000),detail:'d'.repeat(1000),status:'pending'}]},
 sys:{freeGB:5,procs:[{pid:1,script:'swarm.ts'}]},viewerTimings:[{ms:1}],vault:{coins:9},collection:{items:[]},economy:{supplies:[{name:'Lobster',ask:100}],pricesAt:7,goldPerTick:3,farmers:[{name:'CoinCock'}],trend:[1]},mainPlan:{rows:[{board:'Overall',note:`${MAIN_MARK} first`}]},requests:{open:[{id:'1',request:'owner words'}]},race:{rows:[]},gates:{go:false},
 fleetSides:{at:1,sides:[{side:'cloud',at:1,late:false,accounts:[{name:'TossTheCaber',at:1,total:40,coins:900},{name:MAIN_MARK,at:1,total:1,coins:1}]}],orders:[]}});
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
  expect(p.vault).toBeNull();expect(p.collection).toBeNull();expect(p.economy).toEqual({supplies:[{name:'Lobster',ask:100}],pricesAt:7,goldPerTick:0,farmers:[],trend:[]});
  expect(p.sys.procs).toEqual([]);
  expect('viewerTimings' in p).toBe(false);
  expect(p.mainPlan).toBeNull();expect(p.race).toBeNull();expect(p.gates).toBeNull();expect(p.requests).toEqual({});
  expect(p.coordination.tasks).toEqual([]);expect(p.coordination.available).toBe(true);expect(JSON.stringify(p)).not.toContain('w'.repeat(50));
  expect(JSON.stringify(p)).not.toContain('owner words');
  expect(p.fleetSides.sides[0].accounts).toEqual([{name:'TossTheCaber',at:1,total:40}]);
  expect(p.hosted.kind).toBe('public');
 });
 test('a state that still names the main account is refused',()=>{
  expect(()=>publicView({bots:[{name:'CoinCock',goal:'give to Haggis'}]})).toThrow('nothing published');
  expect(()=>publicView({bots:[],objectives:{lanes:[{next:'haggis route'}]}})).toThrow('nothing published');
  // A field the public view removes cannot trip the check: it is gone before the check runs.
  expect(publicView({bots:[],mainPlan:{note:'haggis route'}}).mainPlan).toBeNull();
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
