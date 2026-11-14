import {test,expect} from 'bun:test';
import {fleetSidesView,localDisplayNames,remoteBots,scoreboardView,SIDE_SYNC_MS} from './fleet-view';
import {questProgress} from './goal-details';
import {questDefinitions} from '../core/src/quest-status';

test('scoreboard keeps the remaining list, best live level per skill and the coverage counts',()=>{
 const raw={at:'2026-10-31T11:20:12.643Z',totals:{actions:10,actionsNamed:4},items:{tradeable:20,tradeableHeld:3},
  skills:[{skill:'Attack',bestLive:94,bands:[{band:'70-99',stage:'live-partial'}]},{skill:'Herblore',bands:[]}],
  progress:{skillLevels:95,skills99:0,questsLive:9,questTotal:68,done:false,remaining:['Attack 94/99','quests 9/68 live']}};
 const s:any=scoreboardView(raw);
 expect(s.available).toBe(true);expect(s.at).toBe(Date.parse(raw.at));expect(s.remaining).toEqual(['Attack 94/99','quests 9/68 live']);
 expect(s.skills[0]).toEqual({skill:'Attack',bestLive:94,bands:[{band:'70-99',stage:'live-partial'}]});expect(s.skills[1].bestLive).toBeNull();
 expect(s.quests).toEqual({live:9,total:68});expect(s.items).toEqual({held:3,total:20});expect(s.actions).toEqual({named:4,total:10});
 expect(scoreboardView(null).available).toBe(false);expect(scoreboardView({skills:[]}).available).toBe(false);
});

test('fleet sides give each side its sync age, accounts, total levels and coins; late orders and sides are marked; done orders drop out',()=>{
 const now=10_000_000;
 const v=fleetSidesView([
  {side:'cloud',at:now-60_000,accounts:[{name:'Zed',at:now-60_000,skills:[{name:'Attack',level:22},{name:'Overall',level:99}],bank:[{id:995,count:100}],inventory:[{name:'Coins',count:5}]}]},
  {side:'local',at:now-4*SIDE_SYNC_MS,accounts:[{name:'Bee',at:1},{name:'Ann',at:2,skills:[]}]},
  {bad:true}],[{id:'o1',from:'A',to:'B',item:'Air talisman',count:1,start:5,end:now-1},{from:'A'},
  {id:'o2',from:'A',to:'B',item:'Coins',count:9,start:4,end:now+1},{id:'o3',from:'A',to:'B',item:'Coins',count:9,start:3,end:now+1},{id:'o4',from:'A',to:'B',item:'Coins',count:9,start:2,end:now+1}],now,
  [{id:'o2',role:'from',ok:true},{id:'o2',role:'to',ok:true},{id:'o3',role:'from',ok:true},{id:'o4',role:'to',ok:false}]);
 expect(v.sides.map(s=>s.side)).toEqual(['local','cloud']);
 expect(v.sides[0]!.late).toBe(true);expect(v.sides[1]!.late).toBe(false);expect(v.sides[0]!.accounts.map((a:any)=>a.name)).toEqual(['Ann','Bee']);
 expect(v.sides[1]!.accounts[0]).toEqual({name:'Zed',at:now-60_000,total:22,coins:105});expect(v.sides[0]!.accounts[1]!.total).toBeNull();
 expect(v.orders[0]).toEqual({id:'o1',from:'A',to:'B',item:'Air talisman',count:1,start:5,end:now-1,state:'open',late:true});
 expect(v.orders.map(o=>o.id+':'+o.state)).toEqual(['o1:open','o3:half','o4:failed']);
});

test('other sides become fleet rows with snapshot levels and items, a world-feed position, and no XP',()=>{
 const now=1_000_000;
 const snaps=[{side:'local',at:1,accounts:[{name:'Mine'}]},{side:'cloud',at:now-5000,accounts:[{name:'TossTheCaber',server:'rs-sdk-demo.fly.dev',at:now-6000,skills:[{name:'Attack',level:22}],inventory:[{id:995,name:'Coins',count:5}],bank:[],equipment:[]},{name:'Dup'},{name:'bad name!'}]}];
 const roster=new Map([['tossthecaber',{x:3200,z:3200,level:0,combat:30,seen:now-1000}]]);
 const rows=remoteBots(snaps,new Set(['dup']),roster,new Map([['tossthecaber',5]]),now);
 expect(rows.map(r=>r.name)).toEqual(['TossTheCaber']);
 const r=rows[0];
 expect(r.side).toBe('cloud');expect(r.remote).toBe(true);expect(r.fresh).toBe(true);expect(r.operation).toBe('observed');
 expect(r.pos).toEqual({x:3200,z:3200,level:0});expect(r.combat).toBe(30);expect(r.skills).toEqual([{name:'Attack',level:22,xp:null}]);
 // The same account in two sides' snapshots is one row: the newer account time wins, in the first row's place.
 const moved=remoteBots([{side:'cloud',at:now-9000,accounts:[{name:'Mover',at:now-9000,skills:[{name:'Attack',level:5}]},{name:'Stay',at:now-9000}]},{side:'cloud-2',at:now-100,accounts:[{name:'mover',at:now-100,skills:[{name:'Attack',level:9}]}]}],new Set(),new Map(),new Map(),now);
 expect(moved.map(r=>[r.name,r.side,r.skills[0]?.level])).toEqual([['mover','cloud-2',9],['Stay','cloud',undefined]]);
 const late=remoteBots(snaps,new Set(),new Map([['tossthecaber',{x:1,z:2,level:0,combat:3,seen:now-60_000}]]),new Map(),now);
 expect(late.find(x=>x.name==='TossTheCaber').fresh).toBe(false);expect(late.find(x=>x.name==='TossTheCaber').pos).toEqual({x:1,z:2,level:0});
});

test('remote observations retain skill detail, worn slots, journal and bank ages without proving an online session',()=>{
 const now=1_000_000,old=now-400_000,quest=questDefinitions().find(q=>q.name==='Rune Mysteries Quest')!;
 const snapshot={side:'cloud',at:now-1,accounts:[{name:'Worker',server:'rs-sdk-demo.fly.dev',at:now-100,
  skills:[{name:'Magic',level:40,currentLevel:37,xp:37224},{name:'Runecraft',level:1,xp:0}],
  equipment:[{slot:3,id:1387,name:'Staff of fire',count:1}],equipmentObserved:true,
  inventory:null,bank:[{id:995,name:'Coins',count:100}],bankAt:old,
  questJournal:[{...quest,state:'complete'}],questsAt:old,
  pos:{x:2618,z:3333,level:0},combat:58,guildFacts:{varps:{qp:25},questStages:{},unlocks:[]}}]};
 const [r]=remoteBots([snapshot],new Set(),new Map(),new Map(),now);
 expect(r.skills).toEqual([{name:'Magic',level:40,currentLevel:37,xp:37224},{name:'Runecraft',level:1,xp:0}]);
 expect(r.equipment[0].slot).toBe(3);expect(r.equipmentObserved).toBe(true);expect(r.inventory).toBeNull();
 expect(r.bankAt).toBe(old);expect(r.questsAt).toBe(old);expect(r.quests).toEqual(snapshot.accounts[0]!.questJournal);
 expect(r.guildFacts.varps.qp).toBe(25);expect(r.pos).toEqual({x:2618,z:3333,level:0});expect(r.combat).toBe(58);
 expect(r.fresh).toBe(false);expect(r.inWorld).toBe(false);expect(r.operation).toBe('offline');expect(r.live).toBeNull();
 const journal=questProgress([r],now);
 expect(journal.completed).toBe(1);expect(journal.rows.find(row=>row.label==='Worker')?.value).toContain('old');
 const staleFeed=new Map([['worker',{x:1,z:2,level:0,combat:3,seen:old}]]);
 expect(remoteBots([snapshot],new Set(),staleFeed,new Map(),now)[0].pos).toEqual(r.pos);
 const freshFeed=new Map([['worker',{x:3200,z:3200,level:0,combat:60,seen:now-1}]]);
 const observed=remoteBots([snapshot],new Set(),freshFeed,new Map(),now)[0];
 expect(observed.pos).toEqual({x:3200,z:3200,level:0});expect(observed.combat).toBe(60);expect(observed.inWorld).toBe(true);
 expect(observed.bankAt).toBe(old);expect(observed.questsAt).toBe(old);
});

test('missing or invalid remote observation times stay unknown rather than borrowing the account heartbeat',()=>{
 const now=1_000_000,quest=questDefinitions()[0]!;
 for(const value of [undefined,null,0,'999999',now+1,now-1]){
  const [r]=remoteBots([{side:'cloud',at:now,accounts:[{name:'Worker',at:now-2,
   skills:[{name:'Magic',level:1}],bank:[],bankAt:value,quests:['Rune Mysteries Quest'],questJournal:[{...quest,state:'complete'}],questsAt:value}]}],new Set(),new Map(),new Map(),now);
  expect(r.bankAt).toBeNull();expect(r.questsAt).toBeNull();expect(r.skills[0].xp).toBeNull();expect(r.equipmentObserved).toBe(false);
  expect(questProgress([r],now).observed).toBe(0);
 }
 const [legacy]=remoteBots([{side:'cloud',at:now,accounts:[{name:'Worker',at:now-1,quests:['Rune Mysteries Quest']}]}],new Set(),new Map(),new Map(),now);
 expect(legacy.quests).toBeNull();expect(legacy.bank).toBeNull();expect(legacy.bankAt).toBeNull();
});

test('remote owner snapshots replace leftover local display candidates without hiding local or protected accounts',()=>{
 const now=1_000_000,server='rs-sdk-demo.fly.dev',owners=new Map([['mover','cloud'],['mine','local'],['haggis','cloud'],['practice','cloud']]);
 const snapshots=[{side:'cloud',at:now,accounts:[{name:'Mover',server,at:now-10,skills:[{name:'Magic',level:40,xp:37224}]},
  {name:'Mine',server,at:now-10},{name:'Haggis',server,at:now-10},
  {name:'Practice',server,at:now-10}]}];
 const names=localDisplayNames(['mover','Mine','Haggis','Practice','Missing'],snapshots,name=>owners.get(name.toLowerCase()),'local',now);
 expect([...names]).toEqual(['Mine','Haggis','Missing']);
 const rows=remoteBots(snapshots,new Set([...names].map(name=>name.toLowerCase())),new Map(),new Map(),now);
 expect(rows.map(row=>row.name)).toEqual(['Mover','Practice']);expect(rows[0].skills[0].xp).toBe(37224);
 for(const row of [{server:'localhost:8888',at:now-1},{server,at:now+1},{server,at:0},{server,at:now-1,practice:true}]){
  expect([...localDisplayNames(['Mover'],[{side:'cloud',accounts:[{name:'Mover',...row}]}],()=> 'cloud','local',now)]).toEqual(['Mover']);
 }
 expect([...localDisplayNames(['Mover'],snapshots,()=>undefined,'local',now)]).toEqual(['Mover']);
});


test('cross-side orders keep an uncertain transfer visible for reconciliation',()=>{
 const now=10000,order={id:'trade',from:'A',to:'B',server:'rs-sdk-demo.fly.dev',item:'Coins',count:9,start:1,end:9000};
 const state=(receipts:unknown[])=>fleetSidesView([],[order],now,receipts).orders[0]?.state;
 const from={version:2,id:'trade',role:'from',account:'A',partner:'B',server:order.server,item:'Coins',requested:9,
  state:'settled',ok:true,count:9,at:8000,claim:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',logout:{attemptId:'1000000000000-1-1',at:7000,sha256:'a'.repeat(64)},
  inventory:{before:9,after:0}};
 const to={...from,role:'to',account:'B',partner:'A',claim:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',inventory:{before:0,after:9},bank:{count:9,at:6000}};
 expect(state([from,to])).toBeUndefined();
 expect(state([from,{...to,state:'reconcile',ok:false}])).toBe('reconcile');
 expect(state([from,{...to,bank:undefined}])).toBe('reconcile');
 expect(state([{...from,version:3},{...to,version:3}])).toBe('reconcile');
 const failed={state:'failed',ok:false,count:0,inventory:undefined,bank:undefined};
 expect(state([{...from,...failed},{...to,...failed}])).toBe('failed');
});
