import { describe, expect, test } from 'bun:test';
import { bankNear, leaveWilderness, rescueDropped, squadTarget, VARROCK_WEST_BANK, watchSquadTicks } from './pk-squad';
import { escapeCastable } from './pk';

const session = (z: number) => ({ sdk: { getState: () => ({ player: { worldX: 3092, worldZ: z, hp: 50, maxHp: 99 } }), getInventory: () => [] } }) as any;

describe('leaveWilderness', () => {
    test('missing player state cannot prove an exit', async () => {
        expect(await leaveWilderness({ sdk: { getState: () => null } } as any, false)).toEqual({ died: false, why: 'player state unavailable at squad exit' });
    });
    test('an account out of the Wilderness stays where it is', async () => {
        expect(await leaveWilderness(session(3496), false)).toEqual({ died: false, why: null });
    });
    test('an account the hold saw die does not walk', async () => {
        expect(await leaveWilderness(session(3640), true)).toEqual({ died: false, why: null });
    });
    test('a death on the way out is reported, not taken for an escape', async () => {
        let reads = 0;
        const s = { sdk: { getState: () => ({ player: { worldX: 3092, worldZ: 3640, hp: 5, maxHp: 99, lifeId: reads++ === 0 ? 1 : 2 } }), getInventory: () => [] } } as any;
        expect(await leaveWilderness(s, false)).toEqual({ died: true, why: 'died walking out of the Wilderness' });
    });
});

test('a rescue session remains owned for logout when retreat fails or throws', async () => {
    const opened = ['failed', 'threw', 'safe'].map(name => ({ name }) as any), sessions: any[] = [];
    const stranded = await rescueDropped(['failed', 'threw', 'safe'], sessions,
        async name => opened.find(s => s.name === name)!, () => {}, async s => {
            if (s.name === 'threw') throw Error('walk failed');
            return s.name === 'safe' ? s : null;
        });
    expect(sessions).toEqual(opened);
    expect(stranded).toEqual(['failed', 'threw']);
});

test('a surviving squad member advances coordination after the first disconnects', () => {
    const dropped = new Set<string>(), ticks: number[] = [];
    const clocks = ['first', 'second'].map(name => {
        let tick = 0;
        const listeners = new Set<() => void>();
        return { name, tick: () => tick, onTick: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
            advance: (next: number) => { tick = next; for (const listener of listeners) listener(); } };
    });
    const stop = watchSquadTicks(clocks as any, name => dropped.has(name), tick => ticks.push(tick));
    clocks[0]!.advance(10); clocks[1]!.advance(10);
    dropped.add('first');
    clocks[0]!.advance(11); clocks[1]!.advance(11);
    stop(); clocks[1]!.advance(12);
    expect(ticks).toEqual([10, 11]);
});

describe('squadTarget', () => {
    test('takes the lowest health bar of the targets in view', () => {
        const view = [{ name: 'Ligma', index: 1, distance: 2 }, { name: 'Sugma', index: 2, distance: 5 }, { name: 'Other', index: 3, distance: 1 }];
        const hp: Record<number, number> = { 1: 0.8, 2: 0.3, 3: 0.1 };
        expect(squadTarget(view, new Set(['ligma', 'sugma']), p => hp[p.index]!)?.name).toBe('Sugma');
    });
});

describe('escapeCastable', () => {
    test('Camelot Teleport needs its law and air runes', () => {
        expect(escapeCastable(1174, [], [], 99)).toBe(false);
        expect(escapeCastable(1174, [{ id: 563, count: 1 }, { id: 556, count: 5 }], [], 99)).toBe(true);
    });
    test('a staff of air stands in for the air runes, and the level counts', () => {
        expect(escapeCastable(1174, [{ id: 563, count: 1 }], [1381], 99)).toBe(true);
        expect(escapeCastable(1174, [{ id: 563, count: 1 }, { id: 556, count: 5 }], [], 40)).toBe(false);
    });
});

test('bankNear: Varrock West for the east multi-way zone, Edgeville west of it', () => {
    expect(bankNear(3200)).toEqual(VARROCK_WEST_BANK);
    expect(bankNear(3136)).toEqual(VARROCK_WEST_BANK);
    expect(bankNear(3067)).toEqual({ x: 3092, z: 3496 });
});
