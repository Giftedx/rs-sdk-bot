import {describe,expect,test} from 'bun:test';
import {xpForLevel as serverXp,levelForXp as serverLevel} from '../planner/src/curve';
import './xp-tracker.js';

const xp=(globalThis as any).atlasXp;
const bot=(skills:{name:string;xp:number}[],started:number|null=100)=>({name:'CoinCock',started,skills:skills.map(k=>({...k,level:xp.levelForXp(k.xp)}))});

describe('xp tracker',()=>{
 test('the level curve is this server\'s curve',()=>{
  for(const l of [1,2,10,50,92,99])expect(xp.xpForLevel(l)).toBe(serverXp(l));
  for(const v of [0,83,1000,273742,13034431])expect(xp.levelForXp(v)).toBe(serverLevel(v));
 });
 test('a baseline is taken once per account login and replaced when the login changes',()=>{
  const store:any={};
  const b1=xp.baseline(store,bot([{name:'Thieving',xp:1000}]),5000);
  expect(b1).toEqual({started:100,at:5000,xp:{Thieving:1000}});
  expect(xp.baseline(store,bot([{name:'Thieving',xp:1500}]),9000)).toBe(b1);
  const b2=xp.baseline(store,bot([{name:'Thieving',xp:1500}],200),9000);
  expect(b2.at).toBe(9000);expect(b2.xp.Thieving).toBe(1500);
 });
 test('rows show gained xp, a rate, level progress and time to level, most gained first',()=>{
  const base={started:100,at:0,xp:{Thieving:xp.xpForLevel(60),Cooking:500,Attack:0}};
  const now=30*60_000;
  const rows=xp.rows(bot([{name:'Thieving',xp:xp.xpForLevel(60)+50},{name:'Cooking',xp:1700},{name:'Attack',xp:0},{name:'Overall',xp:9}]),base,now,null);
  expect(rows.map((r:any)=>r.skill)).toEqual(['Cooking','Thieving']);
  const t=rows[1];
  expect(t.gained).toBe(50);expect(t.rate).toBe(100);expect(t.level).toBe(60);expect(t.next).toBe(61);
  expect(t.progress).toBeCloseTo(50/(xp.xpForLevel(61)-xp.xpForLevel(60)),5);
  expect(t.ttl).toBeCloseTo(t.left/100*3.6e6,3);
  expect(xp.total(rows)).toBe(1250);
 });
 test('the page\'s own rate for the goal skill wins, and a skill with a rate but no gain still shows',()=>{
  const base={started:100,at:0,xp:{Thieving:1000}};
  const rows=xp.rows(bot([{name:'Thieving',xp:1000}]),base,60_000,{skill:'Thieving',xpPerHour:42_000});
  expect(rows).toHaveLength(1);expect(rows[0].rate).toBe(42000);expect(rows[0].gained).toBe(0);
  expect(xp.rows(bot([{name:'Thieving',xp:1000}]),base,60_000,null)).toEqual([]);
 });
 test('level 99 has no time to level',()=>{
  const v=xp.xpForLevel(99)+10;
  const rows=xp.rows(bot([{name:'Cooking',xp:v}]),{started:100,at:0,xp:{Cooking:v-100}},3.6e6,null);
  expect(rows[0].ttl).toBeNull();expect(rows[0].progress).toBe(1);expect(rows[0].level).toBe(99);
 });
});
