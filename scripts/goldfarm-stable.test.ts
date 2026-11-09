import { expect, test } from 'bun:test';
import { ARDOUGNE_RADIUS, BANK_SPOT, COURIER_COOLDOWN, COURIER_WANT_BELOW, courierCheckDue, farmStartProblem, replenishFarmFood, farmProgressTick, foodWaitLimit, farmPickTarget, farmFinishCheckpoint } from './goldfarm-stable';
import { isNoProgressFailure } from '../packages/practice/src/supervise';
import { classify } from '../packages/practice/src/supervise-host';
import { farmEatReceipt, farmErrorCheckpoint, farmSettlePicks, farmPickCancellation, isFoodItem, healOf, selectFoodToEat, WITHDRAW_FOOD } from './goldfarm-stable';
import {settle} from '../packages/core/src/bot';
import {walkPath} from '../packages/core/src/walk';
import {resolve} from 'node:path';

test('actual lite cancellation sends MOVE_GAMECLICK while same-tile success sends no packet',async()=>{
 const root=resolve(import.meta.dir,'../vendor/rs-sdk/server/webclient/src');
 await import(resolve(root,'lite/dom-shim.ts'));
 const {findPathToTile}=await import(resolve(root,'lite/movement.ts'));
 const {default:CollisionMap}=await import(resolve(root,'dash3d/CollisionMap.ts'));
 const writes:number[]=[];
 const client:any={ensureCollision(){},collision:[new CollisionMap()],minusedlevel:0,
  localPlayer:{routeX:[50],routeZ:[50]},mapBuildBaseX:2604,mapBuildBaseZ:3233,
  out:{p1Enc(n:number){writes.push(n);},p1(){},p2(){}}};
 expect(findPathToTile(client,50,50,false)).toBe(true);expect(writes).toEqual([]);
 const p={worldX:2654,worldZ:3283,level:0};let pending:any;
 const s:any={sdk:{getState:()=>({player:p})},direct:async(a:any)=>{
  pending=a;return {success:findPathToTile(client,a.x-client.mapBuildBaseX,a.z-client.mapBuildBaseZ,false)};
 }};
 const cancel=farmPickCancellation(s,async()=>({plan:(_l,_f,to)=>[to]}));
 expect(await cancel()).toBe(false);expect(writes).toEqual([234]);
 p.worldX=pending.x;p.worldZ=pending.z;
 expect(await cancel()).toBe(true);expect(writes).toEqual([234]);
});

test('pick cancellation requires an observed adjacent step, never same-tile SDK success',async()=>{
 const p={worldX:2654,worldZ:3283,level:0};let calls=0,pending:any;
 const s:any={sdk:{getState:()=>({player:p})},direct:async(a:any)=>{
  calls++;expect(a.x!==p.worldX||a.z!==p.worldZ).toBe(true);expect(a.running).toBe(false);pending=a;return {success:true};
 }};
 const cancel=farmPickCancellation(s,async()=>({plan:(_l,_f,to)=>[to]}));
 expect(await cancel()).toBe(false);expect(await cancel()).toBe(false);expect(calls).toBe(2);
 p.worldX=pending.x;p.worldZ=pending.z;
 expect(await cancel()).toBe(true);expect(await cancel()).toBe(true);expect(calls).toBe(2);
 const blocked=farmPickCancellation(s,async()=>({plan:()=>[]}));
 expect(await blocked()).toBe(false);expect(calls).toBe(2);
});

test('error settlement observes a late pick credit before logout instead of reading a frozen cache',async()=>{
 let tick=600,coins=10300,xp=1000,cancels=0,closed=false;
 const result=await farmSettlePicks({
  read:()=>({tick,coins,xp,busy:tick<608,inFlight:tick<602,available:!closed}),
  cancel:async()=>{cancels++;return true;},
  wait:async()=>{tick++;if(tick===603){coins+=50;xp+=2107.5;}return true;},
 });
 // Logout freezes the client cache. The server's saved balance already includes the late pick.
 closed=true;
 expect(result.exact).toBe(true);expect(result.coins).toBe(10350);
 expect(result.xp).toBe(3107.5);expect(tick).toBeGreaterThanOrEqual(618);
 expect(cancels).toBeGreaterThan(1);expect(tick).toBeLessThanOrEqual(632);
});

test('error settlement is bounded and never calls a stale or rejected observation exact',async()=>{
 for(const mode of ['credits','xp','busy','cancel','ended','frozen','skipped','throw'] as const){
  let tick=0,waits=0;
  const result=await farmSettlePicks({
   read:()=>({tick,coins:mode==='credits'?tick*50:100,xp:mode==='xp'?tick:1000,busy:mode==='busy',inFlight:false,available:mode!=='ended'}),
   cancel:async()=>mode!=='cancel',
   wait:async()=>{waits++;if(mode==='throw')throw Error('lost tick stream');if(mode!=='frozen')tick+=mode==='skipped'?2:1;return mode!=='ended';},
  });
  expect(result.exact).toBe(false);expect(waits).toBeLessThanOrEqual(32);
 }
});

test('the recorded bank path opens the north door although its next tile is equally near',async()=>{
 const p={x:2650,z:3304,level:0};let tick=100,callback:(()=>void)|undefined,opens=0;
 const targets:string[]=[];
 const corners=[{x:2650,z:3305},{x:2648,z:3305},{x:2648,z:3304},{x:2646,z:3304},
  {x:2644,z:3302},{x:2644,z:3296},{x:2645,z:3296},{x:2645,z:3290},
  {x:2644,z:3289},{x:2644,z:3284},{x:2653,z:3284},{x:2654,z:3283}];
 const done=walkPath({tick:()=>tick,pos:()=>p,onTick:f=>{callback=f;return()=>{callback=undefined;};},
  plan:()=>corners,locs:()=>[{id:1530,x:2650,z:3305,name:'Door',optionsWithIndex:[{text:'Open',opIndex:1}]}],
  interactLoc:()=>{opens++;},walk:(x,z)=>{targets.push(`${x},${z}`);return {success:false,phase:'validation',reason:'client_rejected',message:'Failed to walk'};}
 },[{...BANK_SPOT,tol:2}],{maxTicks:20});
 for(let i=0;i<20&&callback;i++){tick++;callback();}
 const result=await done;
 // The door never opens in this fake, so the walk stays bounded and fails, but it never clicks past the door.
 expect(result.ok).toBe(false);expect(opens).toBeGreaterThan(0);
 expect(targets).toEqual([]);expect(result.detail).toContain('door 1530@2650,3305');
});

test('logout reports once but cannot refresh a frozen client cache, and failed logout stays false',async()=>{
 for(const reason of ['logged-out','disconnected']){
  let end!:(v:{reason:string})=>void,coins=10150,serverCoins=10150,reports=0;
  const lines:string[]=[];
  const s:any={name:'goldfarm-error',ended:new Promise(r=>{end=r;}),
   direct:async()=>{serverCoins+=50;end({reason});return {success:true};},close:async()=>{}};
  const done=settle([s],reason==='disconnected',ok=>{reports++;expect(ok).toBe(false);expect(serverCoins).toBe(10200);expect(lines).toContain('LOGOUT '+reason);return `original route error packCoins=${coins}`;},{log:l=>lines.push(l)});
  const duplicate=settle([s],true,()=>{throw Error('second result');});
  expect(await done).toBe(false);expect(await duplicate).toBe(false);expect(reports).toBe(1);
  expect(lines.at(-1)).toBe('RESULT fail original route error packCoins=10150');
 }
});

test('installed farmWalk uses shared walkPath from both recorded house interiors to the bank', async () => {
    // Isolate the adapter mock in a child. The worker and shared walkPath are the installed source.
    // Native --door-repro separately checks the real adapter, client movement and saved bank effects.
    const code = `
import {mock,expect} from 'bun:test';
const module=${JSON.stringify(resolve(import.meta.dir,'../packages/core/src/walk.ts'))};
const real=await import(module);
let deps,adapted=0;
mock.module(module,()=>({...real,sessionWalker:async()=>{adapted++;return deps;}}));
const {farmWalk,BANK_SPOT}=await import(${JSON.stringify(resolve(import.meta.dir,'goldfarm-stable.ts'))});
for(const startX of [2650,2651])for(const blocked of [false,true]){
 const p={x:startX,z:3304,level:0},listeners=new Set(),actions=[],plans=[];
 const door={id:1530,x:2650,z:3305,name:'Door',optionsWithIndex:[{text:'Open',opIndex:1}]};
 let tick=0,shut=true,pending=false,finished=false,result,error;
 const state=()=>({player:{worldX:p.x,worldZ:p.z,level:p.level},nearbyLocs:shut?[door]:[]});
 const s={sdk:{getState:state},bot:{interactLoc:async()=>{throw Error('worker bypassed shared walker');}}};
 deps={tick:()=>tick,pos:()=>p,onTick:f=>{listeners.add(f);return()=>listeners.delete(f);},
  locs:()=>state().nearbyLocs,
  plan:(_level,from,to)=>{
   plans.push({from:{...from},to:{...to}});
   return [...(from.x===2651?[{x:2650,z:3304}]:[]),
    {x:2650,z:3305},{x:2648,z:3305},{x:2648,z:3304},{x:2646,z:3304},
    {x:2644,z:3302},{x:2644,z:3296},{x:2645,z:3296},{x:2645,z:3290},
    {x:2644,z:3289},{x:2644,z:3284},{x:2653,z:3284},{...to}];
  },
  interactLoc:(loc,op)=>{expect(loc).toBe(door);expect(op).toBe(1);actions.push('open');pending=true;},
  walk:(x,z)=>{actions.push('walk');expect(shut).toBe(false);p.x=x;p.z=z;return {success:true};}
 };
 const before=adapted;
 const done=farmWalk(s,BANK_SPOT,2).then(r=>{result=r;},e=>{error=e;}).finally(()=>{finished=true;});
 for(let i=0;i<190&&!finished;i++){
  await Promise.resolve();tick++;
  if(pending&&!blocked){shut=false;pending=false;}
  for(const f of [...listeners])f();
  await Promise.resolve();
 }
 expect(finished).toBe(true);await done;
 expect(adapted-before).toBe(1);
 expect(plans[0]).toEqual({from:{x:startX,z:3304,level:0},to:{...BANK_SPOT,tol:2}});
 expect(plans.every(plan=>plan.to.x===BANK_SPOT.x&&plan.to.z===BANK_SPOT.z)).toBe(true);
 expect(actions[0]).toBe('open');expect(listeners.size).toBe(0);
 if(blocked){
  expect(String(error)).toContain('no farm route progress: no progress: door 1530@2650,3305');
  expect(result).toBeUndefined();expect(actions).toEqual(['open','open','open']);
  expect(p).toEqual({x:startX,z:3304,level:0});
 }else{
  expect(error).toBeUndefined();expect(result.ok).toBe(true);expect(result.doors).toBe(1);
  expect(Math.max(Math.abs(p.x-BANK_SPOT.x),Math.abs(p.z-BANK_SPOT.z))).toBeLessThanOrEqual(2);
 }
}
console.log('shared farm route checked');`;
    const child = Bun.spawn([process.execPath, '-e', code], { timeout: 8000, windowsHide: true, stdout:'pipe', stderr:'pipe' });
    const [exitCode,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('shared farm route checked');
});

test('error cleanup preserves the original failure and attempts supported recovery only once',async()=>{
    const original=Error('route rejected at 2650,3304');
    for(const supported of [true,false])for(const fail of [true,false]){
        let calls=0,coins=10150,banked=37;
        const outcome=await farmErrorCheckpoint(original,()=>supported,async()=>{
            calls++;if(fail)throw Error('bank refused');banked+=coins;coins=0;
        });
        expect(outcome.reason).toBe(String(original));expect(calls).toBe(supported?1:0);
        expect(outcome.recovery).toBe(!supported?'unsupported':fail?'failed: Error: bank refused':'banked');
        expect(banked+coins-37).toBe(10150);
        if(!supported||fail)expect(coins).toBe(10150);
    }
});

const fish = (name: string, id: number) => ({ id, name, count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] });
test('high HP shark eating has an exact food debit and the pinned20HP rule',async()=>{
    const source=await Bun.file(new URL('../vendor/rs-sdk/server/content/scripts/player/configs/consumption/consume_normal.dbrow',import.meta.url)).text();
    expect(source).toMatch(/data=consumable,shark\r?\ndata=stat_heal,hitpoints,20,0/);
    const shark=fish('Shark',385);let hp=40,held=1;const rows:string[]=[];
    expect(selectFoodToEat([shark,fish('Trout',333)],35)).toBe(shark);
    expect(await farmEatReceipt({itemId:385,count:()=>held,hp:()=>hp,tick:()=>1,eat:async()=>{held--;hp+=healOf(shark);return {success:true};},wait:async()=>{},log:l=>rows.push(l)})).toBe(true);
    expect(hp).toBe(60);expect(held).toBe(0);expect(rows[0]).toContain('"consumed":1');
});
test('owned sharks are edible food with the pinned 20 HP heal and are used after cheaper fish', () => {
    const shark = fish('Shark', 385), trout = fish('Trout', 333);
    expect(isFoodItem(shark)).toBe(true);
    expect(isFoodItem({ ...shark, optionsWithIndex: [] })).toBe(false); // a noted shark is not eaten
    expect(healOf(shark)).toBe(20);
    expect(selectFoodToEat([shark, trout], 6)).toBe(trout); // HP10 thief at eat threshold 4
    expect(selectFoodToEat([shark], 6)).toBe(shark); // premium stock still keeps a hungry thief alive
    expect(selectFoodToEat([shark, trout], 20)).toBe(shark); // a high-HP thief takes the full heal
    expect(WITHDRAW_FOOD.at(-1)!.test('Shark')).toBe(true);
    expect(WITHDRAW_FOOD.findIndex(re => re.test('Shark'))).toBe(WITHDRAW_FOOD.length - 1);
});

test('without a configured courier an exhausted supply exits at once and stays resumable', () => {
    expect(foodWaitLimit('', undefined, 100000)).toBe(0);
    expect(foodWaitLimit('', { name: '', server: 'rs-sdk-demo.fly.dev', role: 'courier', at: 100000, result: '' }, 100000)).toBe(0);
    expect(classify('RESULT fail no food supply: waited 0 ticks at bank ticks=40', false)).toBe('stopped');
});

test('eat receipts require item depletion, not an SDK success caused by HP regeneration',async()=>{
 for(const scenario of ['regen','delayed','sdk-failure','multiple','cake']){
  let count=3,hp=4,tick=10;const logs:string[]=[];
  const result=await farmEatReceipt({itemId:333,count:()=>count,hp:()=>hp,tick:()=>tick,
   eat:async()=>{hp++;tick++;if(scenario==='sdk-failure'||scenario==='cake')count--;if(scenario==='multiple')count-=2;return {success:scenario!=='sdk-failure'};},
   wait:async()=>{tick++;if(scenario==='delayed')count--;else throw Error('timeout');},log:l=>logs.push(l)});
  expect(result).toBe(['delayed','sdk-failure','cake'].includes(scenario));
  expect(logs).toHaveLength(1);const receipt=JSON.parse(logs[0]!.slice('EAT_RECEIPT '.length));
  expect(receipt.confirmed).toBe(result);expect(receipt.before-receipt.after).toBe(3-count);
 }
});

const at = (worldX: number, worldZ: number, level = 0) => ({ worldX, worldZ, level });

test('nearby knights cannot lead a chain beyond the fixed market range',()=>{
 const n={index:7,name:'Knight of Ardougne',x:2669,z:3321,distance:1,reachable:true,optionsWithIndex:[{text:'Pickpocket',opIndex:3}]};
 expect(farmPickTarget([n],at(2669,3320))).toEqual({npc:undefined,recenter:true,tol:3});
 expect(farmPickTarget([{...n,x:2654,z:3303}],at(2653,3302)).npc?.index).toBe(7);
});

test('normal completion banks the last pending pickpocket before the final coin snapshot',async()=>{
 let held=1200,banked=22400;
 await farmFinishCheckpoint({ok:true,died:()=>false,coins:()=>held,bank:async()=>{held+=50;banked+=held;held=0;}});
 expect(banked+held-17350).toBe(6300);expect(held).toBe(0);
});

test('completion refuses unbanked coins and never adds a bank walk to a failed or dead farm',async()=>{
 await expect(farmFinishCheckpoint({ok:true,died:()=>false,coins:()=>50,bank:async()=>{}})).rejects.toThrow('final coin deposit');
 for(const [ok,died]of [[false,false],[true,true]]){
  let calls=0;await farmFinishCheckpoint({ok:ok!,died:()=>died!,coins:()=>50,bank:async()=>{calls++;}});expect(calls).toBe(0);
 }
});

test('a knight behind a wall does not keep beating an available reachable pickpocket target',()=>{
    const blocked={index:3572,name:'Knight of Ardougne',x:2666,z:3291,distance:1,reachable:false,optionsWithIndex:[{text:'Pickpocket',opIndex:3}]};
    const clear={...blocked,index:3573,x:2653,z:3302,distance:15,reachable:true};
    expect(farmPickTarget([blocked,clear],at(2665,3291)).npc?.index).toBe(3573);
    expect(farmPickTarget([blocked],at(2665,3291))).toEqual({npc:undefined,recenter:true,tol:3});
    expect(farmPickTarget([blocked],at(2653,3302)).recenter).toBe(false);
});
test('recorded 2651,3304 room restart walks onto the knight spot when every knight is unreachable',()=>{
    const knight={index:3572,name:'Knight of Ardougne',x:2655,z:3300,distance:4,reachable:false,optionsWithIndex:[{text:'Pickpocket',opIndex:3}]};
    for(const [x,z] of [[2651,3304],[2650,3304]]) expect(farmPickTarget([knight],at(x!,z!))).toEqual({npc:undefined,recenter:true,tol:0});
    // No visible knight is not evidence of a shut room: keep the bounded idle wait near the spot.
    expect(farmPickTarget([],at(2651,3304)).recenter).toBe(false);
    expect(farmPickTarget([{...knight,reachable:true}],at(2651,3304)).npc?.index).toBe(3572);
});
test('farm target selection preserves random-event exclusion and requires the real pickpocket option',()=>{
    const n={index:1,name:'Knight of Ardougne',x:2653,z:3302,distance:1,optionsWithIndex:[{text:'Pickpocket',opIndex:3}]};
    expect(farmPickTarget([n],at(2653,3302)).npc).toBe(n); // Unknown reach is still allowed.
    expect(farmPickTarget([n],at(2653,3302),new Set([1])).npc).toBeUndefined();
    expect(farmPickTarget([{...n,optionsWithIndex:[]}],at(2653,3302)).npc).toBeUndefined();
});

test('the farm starts only in Ardougne market with Thieving 55 or more', () => {
    expect(farmStartProblem(at(BANK_SPOT.x, BANK_SPOT.z), 99)).toBeNull();
    expect(farmStartProblem(at(2653, 3302), 99)).toBeNull(); // knights
    expect(farmStartProblem(at(2655, 3310), 55)).toBeNull(); // stall
    expect(farmStartProblem(at(BANK_SPOT.x + ARDOUGNE_RADIUS, BANK_SPOT.z), 99)).toBeNull();
});

test('a completed farm can restart where its roaming knight left it', () => {
    // Pocketpython completed 9001 ticks, then its next run rejected this market tile.
    expect(farmStartProblem(at(2656, 3325), 99)).toBeNull();
});

test('food recovery counts as work but walking, empty banks and failed attempts do not', () => {
    const before = { picks: 197, fails: 20, food: 1, banked: 20300 };
    expect(farmProgressTick(630, 921, before, { ...before, food: 9 })).toBe(921);
    expect(farmProgressTick(630, 921, before, { ...before, picks: 198 })).toBe(921);
    const bankMove = { ...before, banked: 25000 };
    expect(farmProgressTick(630, 921, before, bankMove)).toBe(630);
    expect(farmProgressTick(630, 921, before, before)).toBe(630);
    expect(farmProgressTick(630, 921, before, { ...before, food: 0 })).toBe(630);
});

test('repeated failed picks exhaust the useful-work window instead of renewing it', () => {
    let last = 10;
    let before = { picks: 0, fails: 0, food: 20 };
    for (let tick = 12; tick <= 310; tick += 2) {
        const after = { ...before, picks: before.picks + 1, fails: before.fails + 1 };
        last = farmProgressTick(last, tick, before, after);
        before = after;
    }
    expect(last).toBe(10);
    expect(310 - last).toBe(300);
    expect(farmProgressTick(last, 311, before, { ...before, picks: before.picks + 1 })).toBe(311);
    expect(farmProgressTick(last, 312, before, { ...before, food: 25 })).toBe(312);
});

test('starts that killed or idled live thieves on 2026-10-25 are refused before any walk', () => {
    expect(farmStartProblem(at(3096, 3279), 99)).toMatch(/start in Ardougne market/); // Draynor: walked, died
    expect(farmStartProblem(at(3222, 3218), 99)).toMatch(/start in Ardougne market/); // Lumbridge respawn
    expect(farmStartProblem(at(3044, 3276), 99)).toMatch(/start in Ardougne market/);
    expect(farmStartProblem(at(BANK_SPOT.x, BANK_SPOT.z, 1), 99)).toMatch(/start in Ardougne market/);
    expect(farmStartProblem(undefined, 99)).toMatch(/position unknown/);
    expect(farmStartProblem(at(2654, 3312), 1)).toMatch(/below 55/); // mmsmk1232: idle 2400 ticks, RESULT ok
});

test('a refused start blocks the account in both supervisors instead of logging it in again', () => {
    for (const why of [farmStartProblem(at(3096, 3279), 99)!, farmStartProblem(at(2654, 3312), 1)!, 'no goldfarm progress: idle 300 ticks with no pickpocket']) {
        const line = `RESULT fail ${why} ticks=1`;
        expect(isNoProgressFailure(line)).toBe(true);
        expect(classify(line, false)).toBe('blocked');
    }
});

test('an idle farm with no food stops (resumable); with food it is a stuck farm (blocked)', () => {
    expect(classify('RESULT fail no food: waited 300 ticks with no pickpocket and no food ticks=300', false)).toBe('stopped');
    expect(classify('RESULT fail no goldfarm progress: idle 300 ticks with no pickpocket ticks=300', false)).toBe('blocked');
});

test('a thief at the knights answers the courier only when it is in view, once per cooldown', () => {
    const here = [{ name: 'Knight' }, { name: 'bigpackage' }];
    expect(courierCheckDue(1000, -100_000, 'Bigpackage', here)).toBe(true);
    expect(courierCheckDue(1000, 1000 - COURIER_COOLDOWN + 1, 'Bigpackage', here)).toBe(false);
    expect(courierCheckDue(1000, 1000 - COURIER_COOLDOWN, 'Bigpackage', here)).toBe(true);
    expect(courierCheckDue(1000, -100_000, 'Bigpackage', [{ name: 'Bigpackage2' }, {}])).toBe(false);
    expect(courierCheckDue(1000, -100_000, '', here)).toBe(false);
    // A fed thief (26 food) keeps picking; the wait is for one that is running short.
    expect(COURIER_WANT_BELOW).toBeGreaterThan(2);
    expect(COURIER_WANT_BELOW).toBeLessThan(26);
});

test('the recorded zero-food and one-food recoveries use bank and courier only', async () => {
    for (const food of [0, 1]) {
        const actions: string[] = [];
        await replenishFarmFood(async () => { actions.push('bank'); }, () => food, async () => { actions.push('courier'); });
        expect(actions).toEqual(['bank', 'courier']);
    }
    let food = 1;
    const actions: string[] = [];
    await replenishFarmFood(async () => { food = 26; actions.push('bank'); }, () => food, async () => { actions.push('courier'); });
    expect(actions).toEqual(['bank']);
});

test('a real returning courier permits a bounded food wait; stale or wrong evidence does not', () => {
    const now = 100000, courier = { name: 'Bigpackage', server: 'rs-sdk-demo.fly.dev', role: 'courier', at: now, result: '' };
    expect(foodWaitLimit('Bigpackage', courier, now)).toBe(1500);
    for (const s of [undefined, {...courier, at: now - 30000}, {...courier, at: now + 1}, {...courier, name: 'Stranger'}, {...courier, result: 'fail'}, {...courier, role: 'bank'}, {...courier, server: 'localhost:8888'}]) {
        expect(foodWaitLimit('Bigpackage', s, now)).toBe(300);
    }
});

test('the courier service may wait between trips for the next cooked pack without stranding a hungry thief', () => {
    const now = 100000;
    const service = { at: now, jobs: [{ account: 'Bigpackage', script: 'scripts/foodcourier.ts', enabled: true, state: 'waiting offline: no fresh low-food farm or dated source food stock' }] };
    expect(foodWaitLimit('Bigpackage', undefined, now, service)).toBe(1500);
    expect(foodWaitLimit('Bigpackage', undefined, now, { ...service, at: now - 30000 })).toBe(300);
    for (const patch of [{ enabled: false }, { state: 'ended: died after 1 runs' }, { account: 'Stranger' }, { script: 'scripts/banker.ts' }]) {
        expect(foodWaitLimit('Bigpackage', undefined, now, { ...service, jobs: [{ ...service.jobs[0], ...patch }] })).toBe(300);
    }
});

test('a bank containing owned cake portions can replenish the same food the farm eats',()=>{
    for(const name of ['2/3 cake','Slice of cake']){
        const item={id:name==='2/3 cake'?1893:1895,name,count:3,optionsWithIndex:[{text:'Eat',opIndex:1}]};
        expect(isFoodItem(item)).toBe(true);
        const selected=WITHDRAW_FOOD.flatMap(pattern=>[item].filter(row=>pattern.test(row.name)));
        expect(selected).toHaveLength(1);
        expect(selected[0]!.count).toBeGreaterThanOrEqual(2);
    }
});
