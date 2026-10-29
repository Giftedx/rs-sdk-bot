import { test, expect } from 'bun:test';
import { expandPath, walkPath, applyKnownDoorBlocks, type PathDeps, type PathLoc } from '../src/walk';

// A straight east-west road at z=3200. The fake bot runs 2 tiles per tick toward its last click. A shut door at
// doorX blocks the road until a loc click opens it; the open takes effect `openDelay` ticks after the bot
// stands next to it.
function road(opts: { doorX?: number; openDelay?: number; stallAt?: number } = {}) {
    let x = 3000, clickX = 3000, tick = 0;
    let doorShut = opts.doorX !== undefined;
    let doorClickAt = -1, besideSince = -1;
    let stalled = false;
    const inputs: { tick: number; what: string }[] = [];
    const listeners = new Set<() => void>();
    const door: PathLoc = { x: opts.doorX ?? 0, z: 3200, id: 1597, optionsWithIndex: [{ text: 'Open', opIndex: 1 }] };
    const deps: PathDeps = {
        pos: () => ({ x, z: 3200, level: 0 }),
        onTick: cb => { listeners.add(cb); return () => listeners.delete(cb); },
        walk: tx => { clickX = tx; doorClickAt = -1; inputs.push({ tick, what: `walk ${tx}` }); },
        interactLoc: l => { clickX = l.x - 1; doorClickAt = tick; inputs.push({ tick, what: `open ${l.x}` }); },
        locs: () => (doorShut ? [door] : []),
        plan: (_l, _f, to) => [{ x: to.x, z: to.z }],
    };
    const step = () => {
        tick++;
        // A stall: the bot loses its route once (as when a click is dropped) and stands until the next click.
        if (opts.stallAt !== undefined && x >= opts.stallAt && !stalled) { stalled = true; clickX = x; }
        const limit = doorShut && opts.doorX !== undefined ? opts.doorX - 1 : Infinity;
        for (let k = 0; k < 2; k++) {
            const nx = x + Math.sign(clickX - x);
            if (nx === x || nx > limit) break;
            x = nx;
        }
        if (doorShut && doorClickAt >= 0 && x === opts.doorX! - 1) {
            if (besideSince < 0) besideSince = tick;
            if (tick - besideSince >= (opts.openDelay ?? 1)) doorShut = false;
        }
        for (const l of [...listeners]) l();
    };
    return { deps, step, inputs, at: () => x, tick: () => tick, doorShut: () => doorShut };
}

async function run(w: ReturnType<typeof road>, to: number, maxSteps = 200) {
    const p = walkPath(w.deps, [{ x: to, z: 3200, tol: 1 }]);
    for (let i = 0; i < maxSteps; i++) {
        const r = await Promise.race([p, Promise.resolve(null)]);
        if (r) return r;
        w.step();
    }
    return p;
}

test('a named openable chest on the route is not opened as a door',async()=>{
 const w=road();w.deps.locs=()=>[{id:2566,name:'Chest',x:3010,z:3200,optionsWithIndex:[{text:'Open',opIndex:1}]}];
 const r=await run(w,3030);expect(r.ok).toBe(true);expect(r.doors).toBe(0);
 expect(w.inputs.some(i=>i.what.startsWith('open'))).toBe(false);
});

test('expandPath turns straight and diagonal corners into single tiles', () => {
    expect(expandPath({ x: 0, z: 0 }, [{ x: 2, z: 2 }, { x: 4, z: 2 }])).toEqual([{ x: 1, z: 1 }, { x: 2, z: 2 }, { x: 3, z: 2 }, { x: 4, z: 2 }]);
});

test('walkPath clicks ahead before the route runs out, so the bot gains 2 tiles every tick', async () => {
    const w = road();
    const r = await run(w, 3100);
    expect(r.ok).toBe(true);
    expect(r.still).toBe(0);
    // 100 tiles at 2 per tick, goal tolerance 1.
    expect(r.ticks).toBeLessThanOrEqual(50);
    // About one click per 7 tiles of running, never one per tile.
    expect(r.clicks).toBeLessThan(20);
    // Never more than one input in one tick.
    const perTick = new Map<number, number>();
    for (const i of w.inputs) perTick.set(i.tick, (perTick.get(i.tick) ?? 0) + 1);
    expect(Math.max(...perTick.values())).toBe(1);
});

test('walkPath opens a shut door on the path and clicks past it on the tick it opens', async () => {
    const w = road({ doorX: 3030, openDelay: 1 });
    const r = await run(w, 3060);
    expect(r.ok).toBe(true);
    expect(r.doors).toBe(1);
    expect(w.doorShut()).toBe(false);
    const open = w.inputs.find(i => i.what === 'open 3030')!;
    const after = w.inputs.find(i => i.tick > open.tick && i.what.startsWith('walk'))!;
    expect(after).toBeDefined();
    // 60 tiles = 30 ticks; the door may cost 2 ticks, never a timer wait.
    expect(r.ticks).toBeLessThanOrEqual(33);
});

test('walkPath clicks again after one tick without a step', async () => {
    const w = road({ stallAt: 3020 });
    const r = await run(w, 3060);
    expect(r.ok).toBe(true);
    expect(r.still).toBeLessThanOrEqual(1);
});

test('walkPath gives up within its budget when the bot cannot move', async () => {
    const w = road();
    w.deps.walk = () => {};
    const r = await run(w, 3100, 400);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/budget/);
});

test('walkPath walks a straight line when the planner finds no path from a tile it calls blocked', async () => {
    const w = road();
    w.deps.plan = () => [];
    const r = await run(w, 3040);
    expect(r.ok).toBe(true);
    expect(r.ticks).toBeLessThanOrEqual(21);
});

// Explicit client refusals are different from a dispatched move that has not arrived yet.
function rejectedRoad(walk: (call: number, move: (x: number) => void) => unknown) {
    let x = 3000, calls = 0;
    const listeners = new Set<() => void>();
    const deps: PathDeps = {
        pos: () => ({ x, z: 3200, level: 0 }),
        onTick: cb => { listeners.add(cb); return () => listeners.delete(cb); },
        walk: () => walk(++calls, next => { x = next; }),
        interactLoc: () => {}, locs: () => [], plan: (_level, _from, to) => [to],
    };
    return { deps, calls: () => calls, step: () => { for (const cb of [...listeners]) cb(); } };
}
async function driveRejections(w: ReturnType<typeof rejectedRoad>, afterStep?: (tick: number) => void) {
    let result: Awaited<ReturnType<typeof walkPath>> | undefined;
    const pending = walkPath(w.deps, [{ x: 3050, z: 3200, tol: 0 }], { maxTicks: 30 }).then(r => { result = r; return r; });
    for (let tick = 0; tick < 35 && !result; tick++) {
        await Promise.resolve(); await Promise.resolve();
        w.step(); afterStep?.(tick);
        await Promise.resolve(); await Promise.resolve();
    }
    return pending;
}
const rejected = { success: false, phase: 'validation', reason: 'client_rejected', message: 'Failed to walk' };

for (const asyncReply of [false, true]) test(`three ${asyncReply ? 'async' : 'sync'} client walk refusals stop before the tick budget`, async () => {
    const w = rejectedRoad(() => asyncReply ? Promise.resolve(rejected) : rejected);
    const r = await driveRejections(w);
    expect(r.ok).toBe(false);
    expect(w.calls()).toBe(3);
    expect(r.repaths).toBe(1);
    expect(r.ticks).toBeLessThanOrEqual(3);
    expect(r.detail).toContain('walk rejected 3 times');
    expect(r.detail).toContain('start=3000,3200,0 at=3000,3200,0 target=');
    expect(r.detail).toContain('client_rejected');
});

for (const asyncReply of [false, true]) test(`three ${asyncReply ? 'promise errors' : 'thrown dispatch errors'} produce a bounded diagnostic`, async () => {
    const w = rejectedRoad(() => {
        if (asyncReply) return Promise.reject(new Error('dispatch failed'));
        throw new Error('dispatch failed');
    });
    const r = await driveRejections(w);
    expect(w.calls()).toBe(3);
    expect(r.detail).toContain('exception');
    expect(r.detail).toContain('dispatch failed');
});

test('actual movement resets the count; two refusals per position do not accumulate across positions', async () => {
    const w = rejectedRoad((call, move) => {
        if (call === 3) { move(3001); return { success: true }; }
        if (call === 6) { move(3050); return { success: true }; }
        return rejected;
    });
    const r = await driveRejections(w);
    expect(r.ok).toBe(true);
    expect(w.calls()).toBe(6);
});

test('a delayed rejection from before movement cannot poison the new position', async () => {
    let release: ((value: typeof rejected) => void) | undefined;
    const w = rejectedRoad((call, move) => {
        if (call === 1) return new Promise(resolve => { release = resolve; });
        if (call === 2) { move(3001); return { success: true }; }
        if (call === 5) { move(3050); return { success: true }; }
        return rejected;
    });
    const r = await driveRejections(w, tick => { if (tick === 1) release?.(rejected); });
    expect(r.ok).toBe(true);
    expect(w.calls()).toBe(5);
});

test('two transient client refusals still allow a later move and delayed door opening', async () => {
    const w = road({ doorX: 3030, openDelay: 3 });
    const original = w.deps.walk;
    let refused = 0;
    w.deps.walk = (x, z) => ++refused <= 2 ? rejected : original(x, z);
    const r = await run(w, 3060);
    expect(r.ok).toBe(true);
    expect(r.doors).toBe(1);
    expect(w.doorShut()).toBe(false);
});


test('an async refusal arriving after the normal still replan does not add a second replan', async () => {
    const w = rejectedRoad(() => Promise.resolve(rejected));
    let result: Awaited<ReturnType<typeof walkPath>> | undefined;
    const pending = walkPath(w.deps, [{ x: 3020, z: 3200, tol: 1 }, { x: 3050, z: 3200, tol: 0 }], { maxTicks: 50 }).then(r => { result = r; return r; });
    for (let tick = 0; tick < 60 && !result; tick++) { w.step(); await Promise.resolve(); }
    const r = await pending;
    expect(w.calls()).toBe(3);
    expect(r.repaths).toBe(1);
    expect(r.detail).toContain('walk rejected 3 times');
});

test('session door policy is near-leg, same-floor and uses observed current skills/items with unknown quests', () => {
    const blocked:string[]=[];
    const sdk={getState:()=>({skills:[{name:'Thieving',baseLevel:50,level:99}],inventory:[{name:'Brass key',count:1}],varps:{quest:99}}),
        blockDoorTemporarily:(level:number,x:number,z:number)=>{blocked.push(`${x},${z},${level}`);return true;}};
    const door=(x:number,kind:string,need:any={},level=0)=>({id:x,loc:'Door',x,z:3304,level,kind,need,trigger:'Open',src:'fixture'});
    const doors=[door(2674,'one_way'),{...door(2674,'one_way'),z:3305},door(2675,'open'),
        door(2676,'skill',{skill:'thieving',level:40}),door(2677,'skill',{skill:'thieving',level:60}),
        door(2678,'key',{item:'brass_key'}),door(2679,'key',{item:'other_key'}),door(2680,'quest',{varp:'quest'}),
        door(2800,'locked'),door(2681,'locked',{},1)];
    const policy=applyKnownDoorBlocks(sdk,0,{x:2670,z:3304},{x:2690,z:3304},doors);
    expect(policy.map(d=>`${d.x},${d.z},${d.level}`)).toEqual(['2674,3304,0','2674,3305,0','2679,3304,0','2680,3304,0']);
    expect(blocked).toEqual([]);
});

test('two-sided locked gate is observed and blocked one coordinate at a time without endless Open', async () => {
    let pos={x:2670,z:3304,level:0},target={x:2670,z:3304},tick=0;
    const pending:{loc:PathLoc|null}={loc:null};const listeners=new Set<()=>void>(),messages:any[]=[],blocks=new Set<string>(),opened:number[]=[];
    const a:PathLoc={x:2674,z:3304,id:2550,optionsWithIndex:[{text:'Open',opIndex:1}]};
    const b:PathLoc={...a,z:3305,id:2551};const key=(l:{x:number;z:number})=>`${l.x},${l.z}`;
    const deps:PathDeps={pos:()=>pos,onTick:cb=>{listeners.add(cb);return()=>listeners.delete(cb);},
        walk:(x,z)=>{target={x,z};return {success:true};},
        interactLoc:l=>{opened.push(l.id);pending.loc=l;target={x:l.x-1,z:l.z};return {success:true};},
        locs:()=>[a,b],messages:()=>messages,
        blockDoor:(_level,l)=>{blocks.add(key(l));return true;},doorBlocked:(_level,l)=>blocks.has(key(l)),
        plan:(_level,_from,to)=>blocks.has(key(a))?(blocks.has(key(b))?[]:[{x:2673,z:3305},{x:2680,z:3305},to]):[to]};
    let result:any;const done=walkPath(deps,[{x:2680,z:3304,tol:0}],{maxTicks:100}).then(r=>result=r);
    for(let step=0;step<110&&!result;step++) {
        tick++;for(let k=0;k<2;k++){const nx=pos.x+Math.sign(target.x-pos.x),nz=pos.z+Math.sign(target.z-pos.z);if(nx===2674&&(nz===3304||nz===3305))break;pos.x=nx;pos.z=nz;}
        if(pending.loc&&Math.max(Math.abs(pos.x-pending.loc.x),Math.abs(pos.z-pending.loc.z))<=1){messages.push({text:'This door is locked.',tick,observationId:tick});pending.loc=null;}
        for(const cb of [...listeners])cb();await Promise.resolve();
    }
    await done;expect(result.ok).toBe(false);expect(opened).toEqual([2550,2551]);
    expect(blocks.size).toBe(2);expect(result.repaths).toBe(2);expect(result.ticks).toBeLessThan(20);
    expect(result.detail).toContain('no progress: door');expect(result.detail).toContain('2551');
});

test('a dispatched door that stays closed is bounded even without a refusal message', async () => {
    const w=road({doorX:3030,openDelay:Infinity});const r=await run(w,3060);
    expect(r.ok).toBe(false);expect(r.doors).toBe(3);expect(r.ticks).toBeLessThan(45);
    expect(r.detail).toContain('no progress: door');
});

test('door approach and delayed open remain valid; stop during an open never marks it blocked', async () => {
    const w=road({doorX:3030,openDelay:5});const r=await run(w,3060);
    expect(r.ok).toBe(true);expect(r.doors).toBe(1);
    const waiting=road({doorX:3010,openDelay:100});let blocks=0;
    waiting.deps.blockDoor=()=>{blocks++;return true;};
    let result:any;const done=walkPath(waiting.deps,[{x:3040,z:3200,tol:0}],{stop:()=>waiting.tick()>=7}).then(r=>result=r);
    for(let i=0;i<15&&!result;i++){waiting.step();await Promise.resolve();}
    await done;expect(result.detail).toBe('stopped');expect(blocks).toBe(0);
});

test('an old locked message cannot poison a normal door and adjacent unrelated Open is not probed', async () => {
    const normal=road({doorX:3030,openDelay:3});normal.deps.messages=()=>[{text:'This door is locked.',tick:-1,observationId:1}];
    const opened=await run(normal,3060);expect(opened.ok).toBe(true);expect(opened.doors).toBe(1);
    const offPath=road({stallAt:3000});let probes=0;
    offPath.deps.locs=()=>[{x:3000,z:3201,id:2550,optionsWithIndex:[{text:'Open',opIndex:1}]}];
    offPath.deps.interactLoc=()=>{probes++;};
    expect((await run(offPath,3040)).ok).toBe(true);expect(probes).toBe(0);
});

test('edge-aware planned path may run along a blocked wall anchor without opening it', async () => {
    const w=road();let opens=0;
    w.deps.locs=()=>[{x:3030,z:3200,id:2550,optionsWithIndex:[{text:'Open',opIndex:1}]}];
    w.deps.doorBlocked=(_level,l)=>l.x===3030&&l.z===3200;
    w.deps.interactLoc=()=>{opens++;};
    expect((await run(w,3060)).ok).toBe(true);expect(opens).toBe(0);
});
test('empty-planner straight fallback cannot assume a blocked wall anchor is safe', async () => {
    const w=road();w.deps.plan=()=>[];
    w.deps.doorBlocked=(_level,l)=>l.x===3030&&l.z===3200;
    const r=await run(w,3060);
    expect(r.ok).toBe(false);expect(r.ticks).toBe(0);expect(w.inputs).toHaveLength(0);
});

// Ardougne knight house, pinned findLongPath output (2026-10-28). Door 1530 at 2650,3305 has its wall on the
// south edge, so the room tiles 2650,3304 and 2651,3304 leave only through it. Each path folds back past the
// door, so several later tiles are as near as the door tile itself.
const HOUSE_CORNERS: Record<string, { x: number; z: number }[]> = {
    '2650,3304>2653,3302': [{x:2650,z:3305},{x:2652,z:3305},{x:2652,z:3303},{x:2653,z:3302}],
    '2651,3304>2653,3302': [{x:2650,z:3304},{x:2650,z:3305},{x:2652,z:3305},{x:2652,z:3303},{x:2653,z:3302}],
    '2650,3304>2654,3283': [{x:2650,z:3305},{x:2648,z:3305},{x:2648,z:3304},{x:2646,z:3304},{x:2644,z:3302},{x:2644,z:3296},
        {x:2645,z:3296},{x:2645,z:3290},{x:2644,z:3289},{x:2644,z:3284},{x:2653,z:3284},{x:2654,z:3283}],
};
function house(start: { x: number; z: number }, reshut = Infinity) {
    const pos = { ...start }, room = (p: { x: number; z: number }) => p.z === 3304 && (p.x === 2650 || p.x === 2651);
    let tick = 0, shut = true, openAt = -1, shutAt = Infinity, route: { x: number; z: number }[] = [];
    const inputs: string[] = [], rejected: string[] = [], listeners = new Set<() => void>();
    const door: PathLoc = { id: 1530, x: 2650, z: 3305, name: 'Door', optionsWithIndex: [{ text: 'Open', opIndex: 1 }] };
    const deps: PathDeps = {
        tick: () => tick, pos: () => ({ ...pos, level: 0 }),
        onTick: cb => { listeners.add(cb); return () => listeners.delete(cb); },
        plan: (_l, from, to) => HOUSE_CORNERS[`${from.x},${from.z}>${to.x},${to.z}`] ?? [to],
        locs: () => shut ? [door] : [],
        interactLoc: () => { inputs.push(`open@${tick}`); openAt = tick + 1; },
        // The client router refuses a room-to-outside click while the only exit is shut.
        walk: (x, z) => {
            inputs.push(`walk ${x},${z}@${tick}`);
            if (shut && room(pos) && !room({ x, z })) { rejected.push(`${x},${z}`); return { success: false, phase: 'validation', reason: 'client_rejected', message: 'Failed to walk' }; }
            route = expandPath(pos, room(pos) && !room({ x, z }) ? [{ x: 2650, z: 3304 }, { x: 2650, z: 3305 }, { x, z }] : [{ x, z }]);
            return { success: true };
        },
    };
    const step = () => {
        tick++;
        if (openAt >= 0 && tick >= openAt) { shut = false; openAt = -1; shutAt = tick + reshut; }
        if (tick >= shutAt) { shut = true; shutAt = Infinity; }
        for (let k = 0; k < 2 && route.length; k++) {
            const n = route[0]!;
            if (shut && room(pos) && !room(n)) break;
            route.shift(); pos.x = n.x; pos.z = n.z;
        }
        for (const l of [...listeners]) l();
    };
    return { deps, step, inputs, rejected, pos };
}

for (const [start, goal] of [[{x:2650,z:3304},{x:2653,z:3302}],[{x:2651,z:3304},{x:2653,z:3302}],[{x:2650,z:3304},{x:2654,z:3283}]] as const)
test(`folded house path from ${start.x},${start.z} opens the first shut door before clicking past it to ${goal.x},${goal.z}`, async () => {
    const h = house(start);
    let result: Awaited<ReturnType<typeof walkPath>> | undefined;
    const done = walkPath(h.deps, [{ ...goal, tol: 0 }], { maxTicks: 80 }).then(r => result = r);
    for (let i = 0; i < 90 && !result; i++) { await Promise.resolve(); h.step(); await Promise.resolve(); }
    const r = await done;
    expect(h.rejected).toEqual([]);
    expect(h.inputs[0]).toMatch(/^open@/);
    expect(r.doors).toBe(1);
    expect(r.ok).toBe(true);
    expect(h.pos).toEqual(goal);
});

// Server doors shut again 3 ticks after opening (open_and_close_doors.rs2 loc_change(inviswall, 3)).
// A faster reshut leaves the bot on the door anchor tile itself; the walker then opens it again, as before.
for (const reshut of [3, 4])
test(`a door that shuts ${reshut} ticks behind the bot is not opened again`, async () => {
    const h = house({ x: 2651, z: 3304 }, reshut);
    let result: Awaited<ReturnType<typeof walkPath>> | undefined;
    const done = walkPath(h.deps, [{ x: 2653, z: 3302, tol: 0 }], { maxTicks: 80 }).then(r => result = r);
    for (let i = 0; i < 90 && !result; i++) { await Promise.resolve(); h.step(); await Promise.resolve(); }
    const r = await done;
    expect(r.ok).toBe(true);
    expect(r.doors).toBe(1);
    expect(h.inputs.filter(i => i.startsWith('open'))).toHaveLength(1);
});
