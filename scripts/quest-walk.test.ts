import {beforeAll,expect,test} from 'bun:test';
import {walkQuestCorridor,walkClockTowerTrough,CLOCK_TROUGH,openKojoDoor,KOJO_DOOR} from './quest-walk';
import * as pf from '../vendor/rs-sdk/sdk/pathfinding';
import * as grid from '../vendor/rs-sdk/server/vendor/rsmod-pathfinder';
import {withDoorPolicy} from '../packages/core/src/door-policy';
import {blockedDoorsNear} from '../packages/core/src/world';
import {loadPathfinding} from '../packages/core/src/pathcache';
// initPathfinding() alone takes about 14 s for each process (packages/core/src/pathcache.ts). The snapshot loader makes
// the same grid first, so the calls in the tests return at once.
beforeAll(async()=>{await loadPathfinding();},120_000);
const points=[{x:10,z:0,tol:0},{x:10,z:10,tol:0},{x:20,z:10,tol:1}];
const result=(next:number,ok=false)=>({ok,next,ticks:5,still:0,clicks:1,repaths:0,doors:0});
test('failed corridor resumes its first unfinished point and preserves every remaining bend',async()=>{
 let tick=0,atGoal=false;const calls:any[]=[];
 const r=await walkQuestCorridor({tick:()=>tick,stop:()=>false,near:()=>atGoal,walk:async(p,o)=>{calls.push({p,budget:o.maxTicks});tick+=5;if(calls.length===1)return result(1);atGoal=true;return result(p.length,true);}},points,20);
 expect(r.ok).toBe(true);expect(calls).toEqual([{p:points,budget:20},{p:points.slice(1),budget:15}]);
});
test('a route that never advances repeats the same corridor, then fails without a direct fallback',async()=>{
 const calls:any[]=[];const r=await walkQuestCorridor({tick:()=>0,stop:()=>false,near:()=>false,walk:async p=>{calls.push(p);return result(0);}},points,20);
 expect(r.ok).toBe(false);expect(calls).toEqual([points,points,points]);
});
test('cancellation or exhausted global deadline stops before another route attempt',async()=>{
 let tick=0,calls=0,stopped=false;
 const r=await walkQuestCorridor({tick:()=>tick,stop:()=>stopped,near:()=>false,walk:async()=>{calls++;tick=10;stopped=true;return result(1);}},points,10);
 expect(r.ok).toBe(false);expect(calls).toBe(1);expect(r.detail).toContain('stopped');
});
test('invalid progress and a false arrival cannot discard unfinished corridor points',async()=>{
 for(const next of [-1,4,1.5]){
  const r=await walkQuestCorridor({tick:()=>0,stop:()=>false,near:()=>false,walk:async()=>result(next)},points,20);
  expect(r.ok).toBe(false);expect(r.detail).toContain('cursor');
 }
 const r=await walkQuestCorridor({tick:()=>0,stop:()=>false,near:()=>false,walk:async()=>result(3,true)},points,20);
 expect(r.ok).toBe(false);expect(r.detail).toContain('arrival');
});
test('the lever-opened rat cage gate stays shut to the door policy, so the trough leg is one client-routed click',async()=>{
 const lever={x:2591,z:9661,level:0},acct={skills:{},coins:0,counts:{},items:[],varps:{}};
 pf.initPathfinding();
 const blocks=blockedDoorsNear(lever,{...CLOCK_TROUGH,level:0},acct).map(b=>b.whenAxis===undefined?{...b,...pf.getDoorAt(b.level,b.x,b.z)}:b);
 expect(blocks.map(b=>`${b.x},${b.z}`)).toContain('2595,9657');
 // clock-stage.log: walk 2588,9661, then the straight fallback through the bars to 2588,9656, re-plan: off path by 4.
 const plan=(from:{x:number;z:number},to:{x:number;z:number})=>withDoorPolicy(grid as any,blocks,()=>pf.findLongPath(0,from.x,from.z,to.x,to.z,500)).map((p:any)=>`${p.x},${p.z}`);
 expect(plan(lever,CLOCK_TROUGH)).toEqual(['2588,9661']);
 expect(plan({x:2588,z:9661},CLOCK_TROUGH)).toEqual([]);
 const clicks:unknown[]=[];
 await walkClockTowerTrough({dash:async(...a)=>{clicks.push(a);}});
 expect(clicks).toEqual([['to trough',2588,9656,1]]);
},60000);
// Wandwaver.log: me 2570,3248,0, Kojo 2568,3245; three "[bot] cant_reach ... nothing was sent" lines, then talk kojo failed.
test('Kojo across the shut middle door is reached only through that door, which is opened from the bot side first',async()=>{
 pf.initPathfinding();
 const route=pf.findLongPath(0,2570,3248,2568,3245);
 expect(route.at(-1)).toMatchObject({x:2568,z:3245});
 expect(route.map(p=>`${p.x},${p.z}`)).toContain(`${KOJO_DOOR.x},${KOJO_DOOR.z}`);
 const run=async(me:{x:number;z:number},shutAtStart:boolean)=>{
  let pos={worldX:me.x,worldZ:me.z,level:0},shut=shutAtStart;const calls:string[]=[];
  const q:Parameters<typeof openKojoDoor>[0]={
   pos:()=>pos,near:(x:number,z:number,r:number)=>Math.max(Math.abs(pos.worldX-x),Math.abs(pos.worldZ-z))<=r,
   walk:async(_label:string,pts:{x:number;z:number;tol?:number}[])=>{calls.push(`walk ${pts.map(p=>`${p.x},${p.z},${p.tol}`).join(';')}`);pos={...pos,worldX:pts.at(-1)!.x,worldZ:pts.at(-1)!.z};},
   shutAt:(x:number,z:number)=>x===KOJO_DOOR.x&&z===KOJO_DOOR.z&&shut?{id:1530,x,z}:undefined,
   openDoor:async(_label:string,x:number,z:number)=>{calls.push(`open ${x},${z}`);shut=false;},
   npc:()=>({x:2568,z:3245}),
  };
  await openKojoDoor(q);
  return calls;
 };
 expect(await run({x:2570,z:3248},true)).toEqual(['walk 2567,3246,0','open 2567,3245']);
 expect(await run({x:2567,z:3243},true)).toEqual(['walk 2567,3245,0','open 2567,3245']);
 expect(await run({x:2567,z:3246},false)).toEqual(['open 2567,3245']);
},60000);
test('a stalled tick transport is surfaced once, not retried as a blocked corridor',async()=>{
 let calls=0;const detail='tick stream stalled: no game tick for15000ms';
 const r=await walkQuestCorridor({tick:()=>0,stop:()=>false,near:()=>false,walk:async()=>{calls++;return{...result(0),detail};}},points,20);
 expect(r).toEqual({ok:false,detail});expect(calls).toBe(1);
});
