import { expect, test } from 'bun:test';
import { parseTarget, walkTarget, stagedBoat, walkWithFerryFallback } from './walk-to';
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
