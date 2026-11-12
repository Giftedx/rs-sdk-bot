import { expect, test } from 'bun:test';
import { parseTarget, walkTarget, walkTargetPersist, stagedBoat, walkWithFerryFallback, fareSpare, awayFrom } from './walk-to';
import { loadTravel } from '../packages/core/src/travel';
import type { Outcome } from '../packages/core/src/act';

test('the target is account, x, z and an optional level', () => {
    expect(parseTarget(['Pocketpython', '3165', '3487'])).toEqual({ account: 'Pocketpython', to: { x: 3165, z: 3487, level: 0 } });
    expect(parseTarget(['A', '1', '2', '1']).to.level).toBe(1);
    expect(() => parseTarget(['A', 'x', '2'])).toThrow();
    expect(() => parseTarget([])).toThrow();
});

test('a declared ground corridor never constructs the global route planner', async () => {
    const calls: string[] = [];
    const s = { sdk: { getState: () => ({ player: { level: 0 } }) } } as any;
    const target = { x: 3013, z: 3355, level: 0 };
    const result = await walkTarget(s, target, true, {
        planned: async () => { throw Error('global planning must stay cold'); },
        ground: async (_s, to) => { calls.push('ground'); expect(to).toEqual(target); return { ok: true }; },
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['ground']);
});

test('ground mode refuses a plane change before walking', async () => {
    const s = { sdk: { getState: () => ({ player: { level: 0 } }) } } as any;
    const refuse = async () => { throw Error('must not dispatch'); };
    await expect(walkTarget(s, { x: 1, z: 1, level: 1 }, true, { planned: refuse, ground: refuse })).rejects.toThrow('same plane');
});

test('ordinary travel retains the global route planner', async () => {
    const s = {} as any;
    const result = await walkTarget(s, { x: 1, z: 1, level: 0 }, false, {
        planned: async () => ({ ok: true }),
        ground: async () => { throw Error('ordinary travel changed'); },
    });
    expect(result.ok).toBe(true);
});

test('an explicit boat retains fare, departure and arrival checks', () => {
    const from = { x: 2679, z: 3275, level: 0 }, to = { x: 2774, z: 3232, level: 0 };
    const boat = { id: 'test-boat', kind: 'boat', from, to, coins: 30, needs: [], runes: [], run: { how: 'npc' } } as any;
    const account = { coins: 30, items: [] } as any;
    expect(stagedBoat(boat, from, to, account).travel.id).toBe('test-boat');
    expect(() => stagedBoat(boat, from, to, { ...account, coins: 29 })).toThrow('unavailable');
    expect(() => stagedBoat(boat, { ...from, x: from.x + 9 }, to, account)).toThrow('departure');
    expect(() => stagedBoat(boat, from, { ...to, x: to.x + 1 }, account)).toThrow('arrival');
    expect(() => stagedBoat({ ...boat, kind: 'teleport' }, from, to, account)).toThrow('boat');
});

test('a failed east-to-Ardougne plan uses the funded corridor and stops when funds change', async () => {
    const from = { x: 3269, z: 3164, level: 0 }, to = { x: 2615, z: 3332, level: 0 };
    const noRoute: Outcome = { ok: false, reason: 'precondition', detail: 'no route to 2615,3332,0', ticks: 0 };
    const calls: string[] = [];
    let coins = 70, loss = 0;
    const walk = async ({x,z}: {x:number;z:number}): Promise<Outcome> => {
        calls.push(x+','+z);
        if (calls.length === 1) return noRoute;
        if (x === 3222) coins -= 10 + loss;
        return {ok:true,ticks:1};
    };
    const sail = async (boat: ReturnType<typeof loadTravel>[number]): Promise<Outcome> => {
        calls.push(boat.id);coins -= boat.coins;
        return {ok:true,ticks:1};
    };
    expect(await walkWithFerryFallback(from,to,walk,sail,()=>coins)).toEqual({ok:true,ticks:7});
    expect(calls).toEqual(['2615,3332','3222,3218','3092,3243','3028,3216',
        'npc:captain_tobias:karamja-musa-point@3028,3216','2772,3225',
        'npc:customs_officer:ardougne@2772,3225','2615,3332']);
    expect(coins).toBe(0);

    calls.length = 0;coins = 70;loss = 1;
    const failed=await walkWithFerryFallback(from,to,walk,sail,()=>coins);
    expect(failed).toMatchObject({ok:false,detail:'westbound ferry needs 60 coins in the pack'});
    expect(calls.some(c=>c.startsWith('npc:'))).toBe(false);

    calls.length = 0;coins = 69;
    expect(await walkWithFerryFallback(from,to,walk,sail,()=>coins)).toMatchObject({ok:false,detail:'westbound ferry needs 70 coins in the pack'});
    expect(calls).toEqual(['2615,3332']);
    const aborted: Outcome = {ok:false,reason:'aborted',detail:'stop',ticks:3};
    expect(await walkWithFerryFallback(from,to,async()=>aborted,sail,()=>100)).toBe(aborted);
});

test('a trip east from elsewhere in Kandarin first walks to the Ardougne north bank, then takes the fare and the ferries', async () => {
    const to = { x: 3185, z: 3436, level: 0 }, home = '2619,3332';
    const noRoute: Outcome = { ok: false, reason: 'precondition', detail: 'no route to 3185,3436,0', ticks: 0 };
    for (const from of [{ x: 2809, z: 3441, level: 0 }, { x: 2727, z: 3493, level: 0 }, { x: 2612, z: 3093, level: 0 }, { x: 2529, z: 3236, level: 0 }]) {
        const calls: string[] = []; let coins = 0, plans = 0;
        const walk = async ({x,z}: {x:number;z:number}): Promise<Outcome> => { calls.push(x+','+z); return x+','+z === '3185,3436' && plans++ === 0 ? noRoute : {ok:true,ticks:1}; };
        const sail = async (boat: ReturnType<typeof loadTravel>[number]): Promise<Outcome> => { calls.push(boat.id); coins -= boat.coins; return {ok:true,ticks:1}; };
        expect(await walkWithFerryFallback(from,to,walk,sail,()=>coins,async need=>{calls.push('fare '+need);coins=need;return{ok:true,ticks:4};})).toEqual({ok:true,ticks:10});
        expect(calls).toEqual([home,'fare 60','3185,3436','2679,3275','npc:captain_barnaby:brimhaven@2679,3275','2953,3147','npc:customs_officer:port-sarim@2953,3147','3185,3436']);
    }
    // A walk home that fails ends the trip there.
    const stuck: Outcome = { ok: false, reason: 'precondition', detail: 'no route to 2619,3332,0', ticks: 3 };
    expect(await walkWithFerryFallback({ x: 2809, z: 3441, level: 0 },to,async()=>stuck,async()=>({ok:true,ticks:1}),()=>60)).toEqual(stuck);
    // Taverley, east of the mountain, has its own way east, and a trip inside Kandarin goes direct.
    const direct: string[] = [];
    const plain = async ({x,z}: {x:number;z:number}): Promise<Outcome> => { direct.push(x+','+z); return {ok:true,ticks:2}; };
    expect(await walkWithFerryFallback({ x: 2895, z: 3440, level: 0 },to,plain,async()=>({ok:true,ticks:1}),()=>0)).toEqual({ok:true,ticks:2});
    expect(await walkWithFerryFallback({ x: 2809, z: 3441, level: 0 },{ x: 2619, z: 3332, level: 0 },plain,async()=>({ok:true,ticks:1}),()=>0)).toEqual({ok:true,ticks:2});
    expect(direct).toEqual(['3185,3436','2619,3332']);
});

test('a failed Ardougne-to-east plan sails to Brimhaven and from Musa Point, with the fare checked first', async () => {
    const from = { x: 2584, z: 3293, level: 0 }, to = { x: 3185, z: 3436, level: 0 };
    const noRoute: Outcome = { ok: false, reason: 'precondition', detail: 'no route to 3185,3436,0', ticks: 0 };
    const calls: string[] = [];
    let coins = 60;
    // The first plan of each walk finds no route; every later leg arrives.
    const walk = async ({x,z}: {x:number;z:number}): Promise<Outcome> => { const first = !calls.some(c => /^\d+,\d+$/.test(c)); calls.push(x+','+z); return first ? noRoute : {ok:true,ticks:1}; };
    const sail = async (boat: ReturnType<typeof loadTravel>[number]): Promise<Outcome> => { calls.push(boat.id); coins -= boat.coins; return {ok:true,ticks:1}; };
    expect(await walkWithFerryFallback(from,to,walk,sail,()=>coins)).toEqual({ok:true,ticks:5});
    expect(calls).toEqual(['3185,3436','2679,3275','npc:captain_barnaby:brimhaven@2679,3275','2953,3147','npc:customs_officer:port-sarim@2953,3147','3185,3436']);
    expect(coins).toBe(0);

    calls.length = 0;coins = 59;
    expect(await walkWithFerryFallback(from,to,walk,sail,()=>coins)).toMatchObject({ok:false,detail:'eastbound ferry needs 60 coins in the pack'});
    expect(calls).toEqual(['3185,3436']);
    // With no fare in the pack the walker fetches it before the first plan; a fetch that fails refuses the walk with
    // no step taken, and one that brings too little is refused after the plan.
    calls.length = 0;coins = 0;
    expect(await walkWithFerryFallback(from,to,walk,sail,()=>coins,async need=>{calls.push('fare '+need);coins=need;return{ok:true,ticks:4};})).toEqual({ok:true,ticks:9});
    expect(calls.slice(0,3)).toEqual(['fare 60','3185,3436','2679,3275']);
    calls.length = 0;coins = 0;
    const empty: Outcome = { ok: false, reason: 'precondition', detail: 'ferry needs 60 coins and the bank holds 12', ticks: 3 };
    expect(await walkWithFerryFallback(from,to,walk,sail,()=>coins,async()=>empty)).toEqual(empty);
    expect(calls).toEqual([]);
    expect(await walkWithFerryFallback(from,to,walk,sail,()=>coins,async()=>({ok:true,ticks:2}))).toMatchObject({ok:false,detail:'eastbound ferry needs 60 coins in the pack'});
    expect(calls).toEqual(['3185,3436']);
    // With the fare in the pack the planner's own route is used when it finds one, and nothing is fetched.
    calls.length = 0;coins = 60;
    expect(await walkWithFerryFallback(from,to,async({x,z})=>{calls.push(x+','+z);return{ok:true,ticks:7};},sail,()=>coins,async()=>{calls.push('fare');return{ok:true,ticks:1};})).toEqual({ok:true,ticks:7});
    expect(calls).toEqual(['3185,3436']);
    // Westbound from Falador's side (live: an account parked at 3071,3347 with a trade at the Ardougne bank): no Draynor leg.
    calls.length = 0;coins = 60;
    const bank = { x: 2618, z: 3333, level: 0 };
    const west = async ({x,z}: {x:number;z:number}): Promise<Outcome> => { const first = !calls.length; calls.push(x+','+z); return first ? { ...noRoute, detail: 'no route to 2618,3333,0' } : {ok:true,ticks:1}; };
    expect(await walkWithFerryFallback({ x: 3020, z: 3347, level: 0 },bank,west,sail,()=>coins)).toEqual({ok:true,ticks:5});
    expect(calls).toEqual(['2618,3333','3028,3216','npc:captain_tobias:karamja-musa-point@3028,3216','2772,3225','npc:customs_officer:ardougne@2772,3225','2618,3333']);
    calls.length = 0;coins = 60;
    expect(await walkWithFerryFallback({ x: 3071, z: 3347, level: 0 },bank,west,sail,()=>coins)).toEqual({ok:true,ticks:6});
    expect(calls[1]).toBe('3092,3243');
    // A start outside Kandarin, or a target outside the east, keeps the plain refusal.
    calls.length = 0;coins = 60;
    expect(await walkWithFerryFallback({ x: 2400, z: 3090, level: 0 },to,walk,sail,()=>coins)).toBe(noRoute);
    calls.length = 0;
    expect(await walkWithFerryFallback(from,{ x: 2900, z: 3550, level: 0 },walk,sail,()=>coins)).toBe(noRoute);
});

test('a persistent walk retries from where a leg stopped while it gets closer, and stops when it does not', async () => {
    const player = { worldX: 3185, worldZ: 3436, level: 0 };
    const s = { sdk: { getState: () => ({ player }) } } as any;
    const to = { x: 2619, z: 3332, level: 0 };
    let calls = 0;
    const closer = async () => { calls++; if (calls < 3) { player.worldX -= 200; return { ok: false, reason: 'timeout', detail: 'leg' }; } player.worldX = to.x; player.worldZ = to.z; return { ok: true }; };
    expect((await walkTargetPersist(s, to, 4, closer)).ok).toBe(true);
    expect(calls).toBe(3);
    calls = 0; player.worldX = 3185; player.worldZ = 3436;
    const stuck = async () => { calls++; return { ok: false, reason: 'blocked', detail: 'door' }; };
    expect(await walkTargetPersist(s, to, 4, stuck)).toEqual({ ok: false, reason: 'blocked', detail: 'door' });
    expect(calls).toBe(2);
});

test('a trip out of Zanaris first takes its exit to the swamp shed, then plans from there', async () => {
    const zanaris = { x: 3220, z: 9592, level: 0 }, shed = '3201,3169', bank = { x: 2619, z: 3332, level: 0 };
    const calls: string[] = [];
    let coins = 70;
    // The planner has no route from the shed side to Ardougne without the ferries.
    const walk = async ({ x, z }: { x: number; z: number }): Promise<Outcome> => {
        calls.push(x + ',' + z);
        return calls.length === 2 ? { ok: false, reason: 'precondition', detail: 'no route to 2619,3332,0', ticks: 0 } : { ok: true, ticks: 1 };
    };
    const sail = async (boat: ReturnType<typeof loadTravel>[number]): Promise<Outcome> => { calls.push(boat.id); coins -= boat.coins; return { ok: true, ticks: 1 }; };
    expect(await walkWithFerryFallback(zanaris, bank, walk, sail, () => coins)).toMatchObject({ ok: true });
    expect(calls.slice(0, 2)).toEqual([shed, '2619,3332']);
    expect(calls.filter(c => c.startsWith('npc:'))).toEqual(['npc:captain_tobias:karamja-musa-point@3028,3216', 'npc:customs_officer:ardougne@2772,3225']);
    // A failed exit ends the trip there; a walk inside Zanaris, or to the shed itself, goes direct.
    const stuck: Outcome = { ok: false, reason: 'aborted', detail: 'stop', ticks: 2 };
    expect(await walkWithFerryFallback(zanaris, bank, async () => stuck, sail, () => 70)).toEqual(stuck);
    const direct: string[] = [], plain = async ({ x, z }: { x: number; z: number }): Promise<Outcome> => { direct.push(x + ',' + z); return { ok: true, ticks: 1 }; };
    await walkWithFerryFallback(zanaris, { x: 3238, z: 9558, level: 0 }, plain, sail, () => 0);
    await walkWithFerryFallback(zanaris, { x: 3201, z: 3169, level: 0 }, plain, sail, () => 0);
    expect(direct).toEqual(['3238,9558', shed]);
});

test('a full pack with no coins gives one item to the bank for the fare\'s slot', () => {
    const rows = (...ids: number[]) => ids.map(id => ({ id }));
    // 22 flax and 6 slices of cake: one flax goes, not the stack of anything.
    expect(fareSpare(rows(...Array(22).fill(1779), ...Array(6).fill(1897)))).toEqual({ id: 1779, all: false });
    // 28 different stacks: the whole of one.
    expect(fareSpare(rows(...Array.from({ length: 28 }, (_, n) => 100 + n)))).toEqual({ id: 100, all: true });
    // A free slot, or a coin stack the fare joins: nothing to bank.
    expect(fareSpare(rows(...Array(27).fill(1779)))).toBeNull();
    expect(fareSpare(rows(...Array(27).fill(1779), 995))).toBeNull();
});

test('a start on another floor or far from the place is away from it', () => {
    const market = { x: 2654, z: 3304, level: 0 };
    expect(awayFrom({ worldX: 2575, worldZ: 3269, level: 1 }, market, 80)).toBe(true);
    expect(awayFrom({ worldX: 2575, worldZ: 3269, level: 0 }, market, 80)).toBe(false);
    expect(awayFrom({ worldX: 2573, worldZ: 3269 }, market, 80)).toBe(true);
    expect(awayFrom(null, market, 80)).toBe(false);
});

test('a trip east from a floor above Ardougne goes to the north bank and takes the fare before the first plan', async () => {
    const house = { x: 2575, z: 3269, level: 1 }, pen = { x: 3017, z: 3288, level: 0 };
    const calls: string[] = [];
    let coins = 0;
    const walk = async ({ x, z }: { x: number; z: number }): Promise<Outcome> => { calls.push(x + ',' + z); return { ok: true, ticks: 3 }; };
    const sail = async (): Promise<Outcome> => ({ ok: true, ticks: 1 });
    expect(await walkWithFerryFallback(house, pen, walk, sail, () => coins, async need => { calls.push('fare ' + need); coins = need; return { ok: true, ticks: 4 }; })).toEqual({ ok: true, ticks: 10 });
    expect(calls).toEqual(['2619,3332', 'fare 60', '3017,3288']);
    // A walk inside Ardougne from that floor is one plan: the planner has the stairs.
    calls.length = 0;
    expect(await walkWithFerryFallback(house, { x: 2654, z: 3304, level: 0 }, walk, sail, () => 0, async () => { calls.push('fare'); return { ok: true, ticks: 1 }; })).toEqual({ ok: true, ticks: 3 });
    expect(calls).toEqual(['2654,3304']);
});
