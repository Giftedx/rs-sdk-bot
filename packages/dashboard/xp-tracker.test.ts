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

test('combat level and next-level needs match the 2004 formula and the world feed',()=>{
 const X=(globalThis as any).atlasXp;
 // Live accounts: the world feed's combat level beside the levels from their status files.
 expect(X.combat({Attack:72,Strength:1,Defence:1,Hitpoints:56,Ranged:1,Prayer:1,Magic:1}).level).toBe(37);
 expect(X.combat({Attack:65,Strength:11,Defence:10,Hitpoints:56,Ranged:57,Prayer:1,Magic:1}).level).toBe(44);
 expect(X.combat({Attack:5,Strength:1,Defence:1,Hitpoints:10,Ranged:1,Prayer:1,Magic:37}).level).toBe(20);
 expect(X.combat({Attack:1,Strength:1,Defence:1,Hitpoints:10,Ranged:1,Prayer:1,Magic:1}).level).toBe(3);
 const c=X.combat({Attack:72,Strength:1,Defence:1,Hitpoints:56,Ranged:1,Prayer:1,Magic:1});
 for(const [k,n] of Object.entries(c.next) as [string,number][]){
  const lv:any={Attack:72,Strength:1,Defence:1,Hitpoints:56,Ranged:1,Prayer:1,Magic:1};
  const key={melee:'Strength',defence:'Defence',prayer:'Prayer',ranged:'Ranged',magic:'Magic'}[k]!;
  expect(X.combat({...lv,[key]:lv[key]+n}).level).toBe(38);expect(X.combat({...lv,[key]:lv[key]+n-1}).level).toBe(37);
 }
 expect(X.combat({Attack:99,Strength:99,Defence:99,Hitpoints:99,Ranged:99,Prayer:99,Magic:99})).toEqual({level:126,next:null});
});

test('the virtual level goes past 99 by the server XP formula, to the level of the XP cap',()=>{
 const X=(globalThis as any).atlasXp;
 expect(X.virtualLevel(0)).toBe(1);
 expect(X.virtualLevel(998458)).toBe(99);
 expect(X.virtualLevel(1070139)).toBe(99);
 expect(X.virtualLevel(1070140)).toBe(100);
 expect(X.virtualLevel(39856802)).toBe(152);
 expect(X.virtualLevel(200000000)).toBe(175);
 expect(X.virtualLevel(2000000000)).toBe(175);
});

test('the goal bar runs from the floor of the level now to the goal level, with a mark at each level between',()=>{
 const X=(globalThis as any).atlasXp,floor=X.xpForLevel(50),ceil=X.xpForLevel(53);
 const g=X.goalBar({level:50,next:51,xp:floor+(ceil-floor)/2,rate:1000},53);
 expect(g.goal).toBe(53);expect(g.progress).toBeCloseTo(0.5,5);expect(g.left).toBeCloseTo((ceil-floor)/2,5);
 expect(g.marks).toHaveLength(2);expect(g.marks[0]).toBeGreaterThan(0);expect(g.marks[1]).toBeGreaterThan(g.marks[0]);expect(g.marks[1]).toBeLessThan(100);
 expect(g.ttl).toBeCloseTo((ceil-floor)/2/1000*3.6e6,3);
 expect(X.goalBar({level:50,next:51,xp:floor,rate:0},51)).toBeNull();
 expect(X.goalBar({level:50,next:51,xp:floor,rate:0},undefined)).toBeNull();
 expect(X.goalBar({level:50,next:51,xp:floor,rate:0},60).ttl).toBeNull();
});

test('a skill that the baseline did not hold is counted from its first reading',()=>{
 const base={started:100,at:0,xp:{} as Record<string,number>};
 xp.rows(bot([{name:'Mining',xp:1000}]),base,60_000,null);
 expect(base.xp.Mining).toBe(1000);
 expect(xp.rows(bot([{name:'Mining',xp:1400}]),base,120_000,null)[0].gained).toBe(400);
});
test('tick efficiency counts each kind of tick and names the biggest waste',()=>{
 const e=xp.efficiency('xxxxmmmiiv'+'?');
 expect(e.ticks).toBe(10);
 expect(e.counts).toEqual({xp:4,inventory:1,move:3,anim:0,dialog:0,stun:0,idle:2});
 expect(e.work).toBe(50);expect(e.idle).toBe(20);
 expect(e.waste).toEqual({kind:'move',share:30});
 expect(xp.efficiency('')).toBeNull();expect(xp.efficiency(undefined)).toBeNull();
 expect(xp.efficiency('xxxx').waste).toBeNull();
});
