import { expect, test } from 'bun:test';
import { pickEnemy } from './pk-team';

test('pickEnemy: pair takes its own enemy while in view, else the lowest bar; near the nearest', () => {
    const live = [{ f: 'a', p: { distance: 1 }, h: 0.9 }, { f: 'b', p: { distance: 3 }, h: 0.2 }, { f: 'c', p: { distance: 2 }, h: 0.5 }];
    const health = (x: { h: number }) => x.h;
    expect(pickEnemy(live, 'c', 'pair', health)?.f).toBe('c');
    expect(pickEnemy(live, 'd', 'pair', health)?.f).toBe('b');
    expect(pickEnemy(live, 'c', 'low', health)?.f).toBe('b');
    expect(pickEnemy(live, 'c', 'near', health)?.f).toBe('a');
    expect(pickEnemy([], 'c', 'pair', health)).toBeUndefined();
});

test('squadTarget takes the lowest bar of the targets in view, not a skipped one', async () => {
    const { squadTarget } = await import('./pk-squad');
    const view = [{ name: 'Goondelf', index: 1, distance: 2 }, { name: 'Ligma', index: 2, distance: 5 }, { name: 'Bystander', index: 3, distance: 1 }];
    const bars: Record<number, number> = { 1: 0.8, 2: 0.3, 3: 0.1 };
    const targets = new Set(['goondelf', 'ligma', 'sugma']);
    expect(squadTarget(view, targets, p => bars[p.index]!)?.name).toBe('Ligma');
    expect(squadTarget(view, targets, p => bars[p.index]!, new Set(['ligma']))?.name).toBe('Goondelf');
    expect(squadTarget([view[2]!], targets, p => bars[p.index]!)).toBeUndefined();
});

test('meetTile: the nearest multi-way tile by the targets, under the depth limit', async () => {
    const { meetTile } = await import('./pk-squad');
    const multi = (x: number, z: number) => x <= 3071 && x >= 3064 && z >= 3624 && z <= 3663;
    expect(meetTile([{ x: 3078, z: 3640 }, { x: 3080, z: 3642 }], 20, 24, multi)).toEqual({ x: 3071, z: 3641 });
    expect(meetTile([{ x: 3066, z: 3640 }], 20, 24, multi)).toEqual({ x: 3066, z: 3640 });
    expect(meetTile([{ x: 3078, z: 3640 }], 10, 24, multi)).toBeNull();
    expect(meetTile([], 20, 24, multi)).toBeNull();
});

test('marchRoute: a step each `step` tiles on the line, the goal last', async () => {
    const { marchRoute } = await import('./pk-squad');
    expect(marchRoute({ x: 3094, z: 3500 }, { x: 3067, z: 3640 }, 50)).toEqual([{ x: 3085, z: 3547 }, { x: 3076, z: 3593 }, { x: 3067, z: 3640 }]);
    expect(marchRoute({ x: 0, z: 0 }, { x: 3, z: 0 }, 12)).toEqual([{ x: 3, z: 0 }]);
});

test('multiEntry: the nearest multi-way tile toward the post', async () => {
    const { multiEntry } = await import('./pk-squad');
    const multi = (x: number, z: number) => x <= 3071 && x >= 3040 && z >= 3600;
    expect(multiEntry({ x: 3094, z: 3500 }, { x: 3067, z: 3640 }, 150, multi)).toEqual({ x: 3071, z: 3600 });
    expect(multiEntry({ x: 3066, z: 3620 }, { x: 3067, z: 3640 }, 150, multi)).toBeNull();
});

test('squadTarget leaves out a target the game will not let it attack', async () => {
    const { squadTarget } = await import('./pk-squad');
    const view = [{ name: 'Goondelf', index: 1, distance: 3, z: 3515, combatLevel: 126 }, { name: 'Ligma', index: 2, distance: 5, z: 3640, combatLevel: 125 }];
    const bar: Record<number, number> = { 1: 0.2, 2: 0.9 };
    expect(squadTarget(view, new Set(['goondelf', 'ligma']), p => bar[p.index]!, new Set(), { z: 3640, combatLevel: 126 })?.name).toBe('Ligma');
});
