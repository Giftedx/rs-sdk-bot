import { expect, test } from 'bun:test';
import { parseTarget, walkTarget, walkTargetPersist, stagedBoat, walkWithFerryFallback } from './walk-to';
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

test('a failed Ardougne-to-east plan sails to Brimhaven and from Musa Point, with the fare checked first', async () => {
    const from = { x: 2584, z: 3293, level: 0 }, to = { x: 3185, z: 3436, level: 0 };
    const noRoute: Outcome = { ok: false, reason: 'precondition', detail: 'no route to 3185,3436,0', ticks: 0 };
    const calls: string[] = [];
    let coins = 60;
    const walk = async ({x,z}: {x:number;z:number}): Promise<Outcome> => { calls.push(x+','+z); return calls.length === 1 ? noRoute : {ok:true,ticks:1}; };
    const sail = async (boat: ReturnType<typeof loadTravel>[number]): Promise<Outcome> => { calls.push(boat.id); coins -= boat.coins; return {ok:true,ticks:1}; };
    expect(await walkWithFerryFallback(from,to,walk,sail,()=>coins)).toEqual({ok:true,ticks:5});
    expect(calls).toEqual(['3185,3436','2679,3275','npc:captain_barnaby:brimhaven@2679,3275','2953,3147','npc:customs_officer:port-sarim@2953,3147','3185,3436']);
    expect(coins).toBe(0);

    calls.length = 0;coins = 59;
    expect(await walkWithFerryFallback(from,to,walk,sail,()=>coins)).toMatchObject({ok:false,detail:'eastbound ferry needs 60 coins in the pack'});
    expect(calls).toEqual(['3185,3436']);
    // Westbound from Falador's side (live: an account parked at 3071,3347 with a trade at the Ardougne bank): no Draynor leg.
    calls.length = 0;coins = 60;
    const bank = { x: 2618, z: 3333, level: 0 };
    const west = async ({x,z}: {x:number;z:number}): Promise<Outcome> => { calls.push(x+','+z); return calls.length === 1 ? { ...noRoute, detail: 'no route to 2618,3333,0' } : {ok:true,ticks:1}; };
    expect(await walkWithFerryFallback({ x: 3020, z: 3347, level: 0 },bank,west,sail,()=>coins)).toEqual({ok:true,ticks:5});
    expect(calls).toEqual(['2618,3333','3028,3216','npc:captain_tobias:karamja-musa-point@3028,3216','2772,3225','npc:customs_officer:ardougne@2772,3225','2618,3333']);
    calls.length = 0;coins = 60;
    expect(await walkWithFerryFallback({ x: 3071, z: 3347, level: 0 },bank,west,sail,()=>coins)).toEqual({ok:true,ticks:6});
    expect(calls[1]).toBe('3092,3243');
    // A start outside Ardougne, or a target outside the east, keeps the plain refusal.
    calls.length = 0;coins = 60;
    expect(await walkWithFerryFallback({ x: 2440, z: 3090, level: 0 },to,walk,sail,()=>coins)).toBe(noRoute);
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
