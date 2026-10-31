import {describe,expect,test} from 'bun:test';
import {controlView,publicView,trimState,MAIN_MARK,WHY_LIMIT,FINISHED_KEEP} from './publish-relay';

const state=()=>({now:1,bots:[
  {name:'CoinCock',env:{target:null},sessionAttemptId:'1-2',workRevision:'abc',inputs:{},coordinatorRunId:null,bank:[{name:'Coins',count:5}],pos:{x:1,z:2},reserved:false},
  {name:MAIN_MARK,reserved:true,bank:[],env:{}},
 ],coordination:{available:true,tasks:[{id:'t1',why:'w'.repeat(1000),detail:'d'.repeat(1000),status:'pending'}]},
 sys:{freeGB:5,procs:[{pid:1,script:'swarm.ts'}]},viewerTimings:[{ms:1}],mainPlan:{rows:[{board:'Overall',note:`${MAIN_MARK} first`}]}});
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
  for(const f of ['env','sessionAttemptId','workRevision','inputs','coordinatorRunId'])expect(f in p.bots[0]).toBe(false);
  expect(p.bots[0].pos).toEqual({x:1,z:2});
  expect(p.bots[0].bank).toEqual([{name:'Coins',count:5}]);
  expect(p.sys.procs).toEqual([]);
  expect('viewerTimings' in p).toBe(false);
  expect(p.mainPlan.rows[0].note).toBe(`${MAIN_MARK} first`);
  expect(p.hosted.kind).toBe('public');
 });
 test('a state that still names the main account is refused',()=>{
  expect(()=>publicView({bots:[{name:'CoinCock',goal:'give to Haggis'}]})).toThrow('nothing published');
  expect(()=>publicView({bots:[],mainPlan:{note:'haggis route'}})).toThrow('nothing published');
 });
});
