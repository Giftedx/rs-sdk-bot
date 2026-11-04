import { expect, test } from 'bun:test';
import { parseTarget, walkTarget, stagedBoat } from './walk-to';

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
