import {test,expect} from 'bun:test';
import {fleetSidesView,scoreboardView,SIDE_SYNC_MS} from './fleet-view';

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

test('fleet sides give each side its sync age, accounts, total levels and coins; late orders and sides are marked',()=>{
 const now=10_000_000;
 const v=fleetSidesView([
  {side:'cloud',at:now-60_000,accounts:[{name:'Zed',at:now-60_000,skills:[{name:'Attack',level:22},{name:'Overall',level:99}],bank:[{id:995,count:100}],inventory:[{name:'Coins',count:5}]}]},
  {side:'local',at:now-4*SIDE_SYNC_MS,accounts:[{name:'Bee',at:1},{name:'Ann',at:2,skills:[]}]},
  {bad:true}],[{id:'o1',from:'A',to:'B',item:'Air talisman',count:1,start:5,end:now-1},{from:'A'}],now);
 expect(v.sides.map(s=>s.side)).toEqual(['local','cloud']);
 expect(v.sides[0]!.late).toBe(true);expect(v.sides[1]!.late).toBe(false);expect(v.sides[0]!.accounts.map(a=>a.name)).toEqual(['Ann','Bee']);
 expect(v.sides[1]!.accounts[0]).toEqual({name:'Zed',at:now-60_000,total:22,coins:105});expect(v.sides[0]!.accounts[1]!.total).toBeNull();
 expect(v.orders).toEqual([{id:'o1',from:'A',to:'B',item:'Air talisman',count:1,start:5,end:now-1,late:true}]);
});
