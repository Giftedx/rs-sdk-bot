import { test, expect } from 'bun:test';
import { walkRoute } from '../src/walk';
import { fakeGame } from './fakegame';

test('same-floor exact CW landing cannot pass at its unmoved start two tiles away',async()=>{
 const g=fakeGame({x:2418,z:3074,level:0,nearbyLocs:[{id:1,x:2417,z:3074,level:0}]});g.state.equipment=[];g.quirks.climbFails=1;
 try{const result=await walkRoute(g as any,[{kind:'transport',loc:'castlewars_outsidestairs_saradomin_linked',option:'op1',at:{x:2417,z:3074,level:0},entry:{x:2418,z:3074,level:0},to:{x:2416,z:3074,level:0},exact:true}],{maxRetriesPerLeg:1,legTimeoutTicks:3});expect(result).toMatchObject({ok:false,reason:'timeout'});}finally{g.stop();}
});
test('same-floor exact transport waits for its actual delayed landing',async()=>{
 const g=fakeGame({x:2418,z:3074,level:0,nearbyLocs:[{id:1,x:2417,z:3074,level:0}]});g.state.equipment=[];g.quirks.climbTo={x:2416,z:3074,level:0};g.quirks.climbDelayTicks=4;
 try{const result=await walkRoute(g as any,[{kind:'transport',loc:'castlewars_outsidestairs_saradomin_linked',option:'op1',at:{x:2417,z:3074,level:0},entry:{x:2418,z:3074,level:0},to:{x:2416,z:3074,level:0},exact:true}],{maxRetriesPerLeg:1,legTimeoutTicks:8});expect(result.ok).toBe(true);expect(result.ticks).toBeGreaterThanOrEqual(4);expect(g.state.player.worldX).toBe(2416);}finally{g.stop();}
});

test('goTo plans from the observed floor after its ordinary Prayer membership probe already climbed',async()=>{
 const {goTo}=await import('../src/walk');
 const p={worldX:3045,worldZ:3483,level:0};const client={ingame:true,mainModalId:-1};
 const state={player:p,skills:[],inventory:[],equipment:[],nearbyLocs:[{id:2641,x:3046,z:3483,level:0,distance:1}]};
 const session:any={client,tick:()=>0,onTick:()=>()=>{},sdk:{getState:()=>state,getDialog:()=>null},direct:async(a:any)=>{expect(a.type).toBe('interactLoc');p.level=1;return{success:true};},bot:{}};
 let planned:any;const world:any={route:(from:any,_to:any,actor:any)=>{planned={from,actor};return{ok:true,legs:[],cost:0};}};
 const result=await goTo(session,world,{x:3045,z:3483,level:1},{skills:{},varps:{},items:[]});
 expect(result.ok).toBe(true);expect(planned.from).toEqual({x:3045,z:3483,level:1});expect(planned.actor.unlocks).toContain('prayer-guild');
});

test('a walk leg that lands 3 tiles off is retried, then succeeds', async () => {
    const g = fakeGame({ x: 0, z: 0, level: 0 });
    g.quirks.walkOffBy = 3;
    const r = await walkRoute(g as any, [{ kind: 'walk', to: { x: 10, z: 10, level: 0 } }]);
    g.stop();
    expect(r.ok).toBe(true);
    expect(g.calls.filter(c => c.startsWith('walk')).length).toBe(2);
});

test('a transport leg climbs using the loc found at its tile and the op number', async () => {
    const g = fakeGame({ x: 3259, z: 3445, level: 0, nearbyLocs: [{ id: 1, name: 'Staircase', x: 3259, z: 3446, level: 0, optionsWithIndex: [{ text: 'Climb-up', opIndex: 1 }] }] });
    g.quirks.climbTo = { x: 3259, z: 3449, level: 1 };
    const r = await walkRoute(g as any, [{ kind: 'transport', loc: 'stairs', option: 'op1', at: { x: 3259, z: 3446, level: 0 }, to: { x: 3259, z: 3449, level: 1 }, exact: true }]);
    g.stop();
    expect(r.ok).toBe(true);
    expect(g.calls).toContain('interact 3259,3446 op1');
});

test('a climb that never changes level fails after its retries, as timeout', async () => {
    const g = fakeGame({ x: 3259, z: 3445, level: 0, nearbyLocs: [{ id: 1, name: 'Staircase', x: 3259, z: 3446, level: 0, optionsWithIndex: [] }] });
    g.quirks.climbFails = 99;
    const r = await walkRoute(g as any, [{ kind: 'transport', loc: 'stairs', option: 'op1', at: { x: 3259, z: 3446, level: 0 }, to: { x: 3259, z: 3449, level: 1 }, exact: true }], { maxRetriesPerLeg: 2, legTimeoutTicks: 5 });
    g.stop();
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
    expect(g.calls.filter(c => c.startsWith('interact')).length).toBe(2);
});

test('a missing stair loc at the tile is reported, not clicked blindly', async () => {
    const g = fakeGame({ x: 0, z: 0, level: 0 });
    const r = await walkRoute(g as any, [{ kind: 'transport', loc: 'stairs', option: 'op1', at: { x: 5, z: 5, level: 0 }, to: { x: 5, z: 7, level: 1 }, exact: true }], { maxRetriesPerLeg: 1, legTimeoutTicks: 3 });
    g.stop();
    expect(r).toMatchObject({ ok: false, reason: 'precondition' });
});

test('a climb that needs 40 ticks (interactLoc walks around a 2x2 stair first) succeeds with the default budget', async () => {
    const g = fakeGame({ x: 3205, z: 3206, level: 0, nearbyLocs: [{ id: 1738, name: 'Staircase', x: 3204, z: 3207, level: 0, optionsWithIndex: [] }] });
    g.quirks.climbTo = { x: 3205, z: 3209, level: 1 };
    g.quirks.climbDelayTicks = 40;
    const r = await walkRoute(g as any, [{ kind: 'transport', loc: 'spiralstairs', option: 'op1', at: { x: 3204, z: 3207, level: 0 }, to: { x: 3205, z: 3209, level: 1 }, exact: true }], { maxRetriesPerLeg: 1 });
    g.stop();
    expect(r.ok).toBe(true);
});

test('a climb refused with can\'t reach opens the closed door nearest the stairs, then climbs', async () => {
    const g = fakeGame({ x: 3205, z: 3206, level: 0, nearbyLocs: [
        { id: 1738, name: 'Staircase', x: 3204, z: 3207, level: 0, options: ['Climb-up'], optionsWithIndex: [] },
        { id: 1530, name: 'Door', x: 3208, z: 3211, level: 0, options: ['Open'], optionsWithIndex: [] },
        { id: 1530, name: 'Door', x: 3230, z: 3230, level: 0, options: ['Open'], optionsWithIndex: [] },
    ] });
    g.quirks.climbTo = { x: 3205, z: 3209, level: 1 };
    g.quirks.doorShut = true;
    const r = await walkRoute(g as any, [{ kind: 'transport', loc: 'spiralstairs', option: 'op1', at: { x: 3204, z: 3207, level: 0 }, to: { x: 3205, z: 3209, level: 1 }, exact: true }], { maxRetriesPerLeg: 3 });
    g.stop();
    expect(r.ok).toBe(true);
    expect(g.calls).toContain('open 3208,3211');
    expect(g.calls).not.toContain('open 3230,3230');
});

test('after a can\'t-reach climb the walker also walks up to the stair tile before retrying', async () => {
    const g = fakeGame({ x: 3205, z: 3206, level: 0, nearbyLocs: [{ id: 1738, name: 'Staircase', x: 3204, z: 3207, level: 0, options: ['Climb-up'], optionsWithIndex: [] }] });
    g.quirks.climbTo = { x: 3205, z: 3209, level: 1 };
    g.quirks.doorShut = true; // no door in range to open, so only the walk can help
    const origWalk = g.bot.walkTo;
    g.bot.walkTo = async (x: number, z: number) => { const r = await origWalk(x, z); if (x === 3204 && z === 3207) g.quirks.doorShut = false; return r; };
    const r = await walkRoute(g as any, [{ kind: 'transport', loc: 'spiralstairs', option: 'op1', at: { x: 3204, z: 3207, level: 0 }, to: { x: 3205, z: 3209, level: 1 }, exact: true }], { maxRetriesPerLeg: 3 });
    g.stop();
    expect(g.calls).toContain('walk 3204,3207');
    expect(r.ok).toBe(true);
});

test('aborting the walk (reflex) cancels the in-flight bot.walkTo through the SDK execution context', async () => {
    const { executionContext } = await import('../../../vendor/rs-sdk/sdk/execution-context');
    const g = fakeGame({ x: 0, z: 0, level: 0 });
    let cancelled = false;
    g.bot.walkTo = async () => new Promise(resolve => {
        const sig = executionContext.getStore()?.signal;
        sig?.addEventListener('abort', () => { cancelled = true; resolve({ success: false }); });
    });
    const ac = new AbortController();
    const p = walkRoute(g as any, [{ kind: 'walk', to: { x: 50, z: 50, level: 0 } }], { signal: ac.signal, maxRetriesPerLeg: 1 });
    await Bun.sleep(10);
    ac.abort('reflex');
    const r = await p;
    g.stop();
    expect(r).toMatchObject({ ok: false, reason: 'aborted' });
    expect(cancelled).toBe(true);
});

test('goTo does not turn account policy into persistent SDK refusal walls', async () => {
    const { goTo } = await import('../src/walk');
    const g = fakeGame({ x: 0, z: 0, level: 0 });
    const blocked: string[] = [];
    (g.sdk as any).blockDoorTemporarily = (level: number, x: number, z: number) => { blocked.push(`${x},${z},${level}`); return true; };
    const world: any = {
        route: () => ({ ok: true, cost: 10, legs: [{ kind: 'walk', to: { x: 10, z: 10, level: 0 } }] }),
        blockedDoors: () => [{ x: 5, z: 5, level: 0 }, { x: 900, z: 900, level: 0 }],
    };
    const r = await goTo(g as any, world, { x: 10, z: 10, level: 0 }, { skills: {}, varps: {}, items: [] });
    g.stop();
    expect(r.ok).toBe(true);
    expect(blocked).toEqual([]); // Synchronous per-actor query masks own policy; TTLs own actual refusals only.
});

test('a walk refused right after a climb (arrival delay) waits before retrying, then succeeds', async () => {
    const g = fakeGame({ x: 3205, z: 3209, level: 0 });
    const startTick = g.tick();
    const origWalk = g.bot.walkTo;
    // The server refuses movement for the first 6 ticks, signalled as a silent op rejection.
    g.bot.walkTo = async (x: number, z: number) => {
        if (g.tick() - startTick < 6) { g.state.opFeedback.opRejectedCount++; return { success: true }; }
        return origWalk(x, z);
    };
    const r = await walkRoute(g as any, [{ kind: 'walk', to: { x: 3222, z: 3218, level: 0 } }], { maxRetriesPerLeg: 3 });
    g.stop();
    expect(r.ok).toBe(true);
});

test('a walk leg lets walkTo deal with a refused step (a shut door) instead of stopping on the refusal', async () => {
    const g = fakeGame({ x: 3205, z: 3209, level: 0 });
    // walkTo first bumps into a shut door (server refuses a step), then opens it and arrives, as rs-sdk walkTo does.
    g.bot.walkTo = async (x: number, z: number) => {
        g.state.opFeedback.opRejectedCount++;
        await Bun.sleep(5);
        g.state.player.worldX = x; g.state.player.worldZ = z;
        return { success: true };
    };
    const r = await walkRoute(g as any, [{ kind: 'walk', to: { x: 3222, z: 3218, level: 0 } }], { maxRetriesPerLeg: 1 });
    g.stop();
    expect(r.ok).toBe(true);
});

test('a map-flag clear during stair approach does not cancel the later floor arrival', async () => {
    const g=fakeGame({x:3209,z:3220,level:2,nearbyLocs:[{id:1740,name:'Staircase',x:3205,z:3229,level:2,optionsWithIndex:[]}]});
    g.quirks.climbTo={x:3205,z:3228,level:1}; g.quirks.climbDelayTicks=8;
    const original=g.bot.interactLoc;
    g.bot.interactLoc=async(loc:any,op:number)=>{const reply=await original(loc,op); g.state.opFeedback.opRejectedCount++; return reply;};
    const result=await walkRoute(g as any,[{kind:'transport',loc:'spiralstairstop',option:'op1',at:{x:3205,z:3229,level:2},to:{x:3205,z:3228,level:1},exact:true}],{maxRetriesPerLeg:1,legTimeoutTicks:20});
    g.stop(); expect(result.ok).toBe(true); expect(g.calls.filter(c=>c.startsWith('interact')).length).toBe(1);
});

test('an ambiguous SDK timeout reply does not cancel an already pending stair transition', async () => {
    const g=fakeGame({x:3209,z:3220,level:2,nearbyLocs:[{id:1740,name:'Staircase',x:3205,z:3229,level:2,optionsWithIndex:[]}]});
    g.quirks.climbTo={x:3205,z:3228,level:1}; g.quirks.climbDelayTicks=8;
    const original=g.bot.interactLoc;
    g.bot.interactLoc=async(loc:any,op:number)=>{await original(loc,op); return {success:false,reason:'timeout',message:'Nothing happened interacting with Staircase'};};
    const result=await walkRoute(g as any,[{kind:'transport',loc:'spiralstairstop',option:'op1',at:{x:3205,z:3229,level:2},to:{x:3205,z:3228,level:1},exact:true}],{maxRetriesPerLeg:1,legTimeoutTicks:20});
    g.stop(); expect(result.ok).toBe(true); expect(g.calls.filter(c=>c.startsWith('interact')).length).toBe(1);
});

test('a generic discarded stair reply waits for the required arrival', async () => {
    const g=fakeGame({x:3209,z:3220,level:2,nearbyLocs:[{id:1740,name:'Staircase',x:3205,z:3229,level:2,optionsWithIndex:[]}]});
    g.quirks.climbTo={x:3205,z:3228,level:1}; g.quirks.climbDelayTicks=8;
    const original=g.bot.interactLoc;
    g.bot.interactLoc=async(loc:any,op:number)=>{await original(loc,op); return {success:false,reason:'rejected',message:'Server discarded the interaction with Staircase - mid-action, stunned, or a modal is open'};};
    const result=await walkRoute(g as any,[{kind:'transport',loc:'spiralstairstop',option:'op1',at:{x:3205,z:3229,level:2},to:{x:3205,z:3228,level:1},exact:true}],{maxRetriesPerLeg:1,legTimeoutTicks:20});
    g.stop(); expect(result.ok).toBe(true);
});

test('an explicit stair refusal stays a rejection', async () => {
    const g=fakeGame({x:3209,z:3220,level:2,nearbyLocs:[{id:1740,name:'Staircase',x:3205,z:3229,level:2,optionsWithIndex:[]}]});
    g.bot.interactLoc=async()=>({success:false,reason:'rejected',message:'You need a key to use these stairs'});
    const result=await walkRoute(g as any,[{kind:'transport',loc:'spiralstairstop',option:'op1',at:{x:3205,z:3229,level:2},to:{x:3205,z:3228,level:1},exact:true}],{maxRetriesPerLeg:1,legTimeoutTicks:20});
    g.stop(); expect(result).toMatchObject({ok:false,reason:'rejected'});
});

test('ambiguous stair replies cannot pass on the right floor at the wrong landing', async () => {
    const g=fakeGame({x:3209,z:3220,level:2,nearbyLocs:[{id:1740,name:'Staircase',x:3205,z:3229,level:2,optionsWithIndex:[]}]});
    g.quirks.climbTo={x:3215,z:3228,level:1}; g.quirks.climbDelayTicks=2;
    const original=g.bot.interactLoc;
    g.bot.interactLoc=async(loc:any,op:number)=>{await original(loc,op); return {success:false,reason:'timeout',message:'Nothing happened interacting with Staircase'};};
    const result=await walkRoute(g as any,[{kind:'transport',loc:'spiralstairstop',option:'op1',at:{x:3205,z:3229,level:2},to:{x:3205,z:3228,level:1},exact:true}],{maxRetriesPerLeg:1,legTimeoutTicks:10});
    g.stop(); expect(result).toMatchObject({ok:false,reason:'timeout'});
});

test('a scripted gate two tiles from its recorded entrance is clicked, its dialogue answered, and clicked again until the player is through', async () => {
    // gnome_areagate 190 at 2459,3383 with the record's south entrance 2461,3382: Femi's box dialogue first, then the gate.
    const gate = { id: 190, name: 'Gate', x: 2459, z: 3383, level: 0, optionsWithIndex: [{ text: 'Open', opIndex: 1 }] };
    const g = fakeGame({ x: 2460, z: 3381, level: 0, nearbyLocs: [gate] });
    let clicks = 0;
    g.quirks.onDirectLoc = () => {
        clicks++;
        if (clicks === 1) g.state.dialog = { isOpen: true, isWaiting: false, options: [{ index: 1, text: "Sorry, I'm a bit busy." }, { index: 2, text: 'OK then.' }] };
        else { g.state.player.worldX = 2461; g.state.player.worldZ = 3385; }
    };
    const travel = { id: 'gate:test', kind: 'gate', name: 'Gnome Stronghold gate (Femi boxes)', from: { x: 2460, z: 3381, level: 0 }, to: { x: 2459, z: 3385, level: 0 }, coins: 0, needs: [], runes: [],
        run: { how: 'gate', loc: 'Gate', action: 'Open', at: { x: 2461, z: 3382, level: 0 }, choices: ['OK then'] }, cost: 8 } as any;
    const r = await walkRoute(g as any, [{ kind: 'travel', travel, at: travel.from, to: travel.to }], { maxRetriesPerLeg: 1, legTimeoutTicks: 150 });
    g.stop();
    expect(r.ok).toBe(true);
    expect(clicks).toBe(2);
    expect(g.calls.filter(c => c.startsWith('direct interact 2459,3383 op1'))).toHaveLength(2);
    expect(g.calls).toContain('dialog 2');
    expect(g.calls).toContain('walk 2459,3385');
});

test('a short passage on one floor ends on its landing, not within 8 tiles of it', async () => {
    // treedoorl 1967 at 2464,3492 from inside the Grand Tree (2464,3493) to the landing 2465,3490: a click that moves nothing fails the leg.
    const door = { id: 1967, name: 'Door', x: 2464, z: 3492, level: 0, optionsWithIndex: [{ text: 'Open', opIndex: 1 }] };
    const travel = { id: 'loc:treedoorl', kind: 'passage', name: 'treedoorl op1', from: { x: 2464, z: 3493, level: 0 }, to: { x: 2465, z: 3490, level: 0 }, coins: 0, needs: [], runes: [],
        run: { how: 'loc', loc: 'treedoorl', op: 1, option: null, id: 1967, at: { x: 2464, z: 3492, level: 0 } }, cost: 5 } as any;
    const leg = { kind: 'travel', travel, at: travel.from, to: travel.to } as any;
    const stuck = fakeGame({ x: 2464, z: 3493, level: 0, nearbyLocs: [door] });
    const r1 = await walkRoute(stuck as any, [leg], { maxRetriesPerLeg: 1, legTimeoutTicks: 150 });
    stuck.stop();
    expect(r1).toMatchObject({ ok: false, reason: 'timeout' });
    expect(stuck.calls).toContain('direct interact 2464,3492 op1');
    const g = fakeGame({ x: 2464, z: 3493, level: 0, nearbyLocs: [door] });
    g.quirks.onDirectLoc = () => { g.state.player.worldX = 2465; g.state.player.worldZ = 3490; };
    const r2 = await walkRoute(g as any, [leg], { maxRetriesPerLeg: 1, legTimeoutTicks: 150 });
    g.stop();
    expect(r2.ok).toBe(true);
});
