import { expect, test } from 'bun:test';
import { pickEnemy, shouldStopUnseen } from '../src/pvp/pk-team';

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
    const { squadTarget } = await import('../src/pvp/squad');
    const view = [{ name: 'Goondelf', index: 1, distance: 2 }, { name: 'Ligma', index: 2, distance: 5 }, { name: 'Bystander', index: 3, distance: 1 }];
    const bars: Record<number, number> = { 1: 0.8, 2: 0.3, 3: 0.1 };
    const targets = new Set(['goondelf', 'ligma', 'sugma']);
    expect(squadTarget(view, targets, p => bars[p.index]!)?.name).toBe('Ligma');
    expect(squadTarget(view, targets, p => bars[p.index]!, new Set(['ligma']))?.name).toBe('Goondelf');
    expect(squadTarget([view[2]!], targets, p => bars[p.index]!)).toBeUndefined();
});

test('meetTile: the nearest multi-way tile by the targets, under the depth limit', async () => {
    const { meetTile } = await import('../src/pvp/squad');
    const multi = (x: number, z: number) => x <= 3071 && x >= 3064 && z >= 3624 && z <= 3663;
    expect(meetTile([{ x: 3078, z: 3640 }, { x: 3080, z: 3642 }], 20, 24, multi)).toEqual({ x: 3071, z: 3641 });
    expect(meetTile([{ x: 3066, z: 3640 }], 20, 24, multi)).toEqual({ x: 3066, z: 3640 });
    expect(meetTile([{ x: 3078, z: 3640 }], 10, 24, multi)).toBeNull();
    expect(meetTile([], 20, 24, multi)).toBeNull();
});

test('marchRoute: a step each `step` tiles on the line, the goal last', async () => {
    const { marchRoute } = await import('../src/pvp/squad');
    expect(marchRoute({ x: 3094, z: 3500 }, { x: 3067, z: 3640 }, 50)).toEqual([{ x: 3085, z: 3547 }, { x: 3076, z: 3593 }, { x: 3067, z: 3640 }]);
    expect(marchRoute({ x: 0, z: 0 }, { x: 3, z: 0 }, 12)).toEqual([{ x: 3, z: 0 }]);
});

test('multiEntry: the nearest multi-way tile toward the post', async () => {
    const { multiEntry } = await import('../src/pvp/squad');
    const multi = (x: number, z: number) => x <= 3071 && x >= 3040 && z >= 3600;
    expect(multiEntry({ x: 3094, z: 3500 }, { x: 3067, z: 3640 }, 150, multi)).toEqual({ x: 3071, z: 3600 });
    expect(multiEntry({ x: 3066, z: 3620 }, { x: 3067, z: 3640 }, 150, multi)).toBeNull();
});

test('multiEntry takes the multi-way area connected to the post, not a nearer one', async () => {
    const { multiEntry, marchPlan } = await import('../src/pvp/squad');
    // Two areas: the post's (x 3040 to 3071, z 3600 and up) and a nearer one east (x 3130 to 3140, z 3530 to 3550).
    const multi = (x: number, z: number) => (x <= 3071 && x >= 3040 && z >= 3600) || (x >= 3130 && x <= 3140 && z >= 3530 && z <= 3550);
    expect(multiEntry({ x: 3094, z: 3500 }, { x: 3067, z: 3640 }, 150, multi)).toEqual({ x: 3071, z: 3600 });
    // The real map: the post area starts at z 3600 and its tile nearest the Edgeville bank is the corner (the east zone is no entry).
    expect(multiEntry({ x: 3094, z: 3497 }, { x: 3067, z: 3640 })).toEqual({ x: 3071, z: 3600 });
    // From outside the Wilderness the march goes along the edge to the entry's x, then north to the area, then to the post.
    const plan = marchPlan({ x: 3094, z: 3497 }, { x: 3067, z: 3640 }, 12);
    expect(plan.every(s => s.x <= 3094 && s.x >= 3067)).toBe(true);
    expect(plan.find(s => s.z >= 3519 && s.z <= 3525)?.x).toBe(3071);
    expect(plan[plan.length - 1]).toEqual({ x: 3067, z: 3640 });
});

test('a pull may run 20 ticks and half a tick a tile of the distance', async () => {
    const { pullTicks, pullDistance, PULL_RANGE } = await import('../src/pvp/squad');
    expect(pullTicks(0)).toBe(20);
    expect(pullTicks(66)).toBe(53);
    expect(pullTicks(PULL_RANGE)).toBe(60);
    expect(pullTicks(500)).toBe(60);
    expect(pullDistance({ worldX: 3107, worldZ: 3574 }, { x: 3067, z: 3640 })).toBe(66);
    expect(PULL_RANGE).toBeGreaterThan(66);
});

test('the march waits for a member that holds, and not for a dropped, tripping or finished one', async () => {
    const { marchClose } = await import('../src/pvp/squad');
    const post = { x: 3071, z: 3519 }, near = { x: 3072, z: 3520 }, bank = { x: 3094, z: 3492 };
    const members = [{ name: 'a', at: near }, { name: 'b', at: bank }, { name: 'c', at: undefined }];
    expect(marchClose(members, post, new Set())).toBe(false);
    expect(marchClose(members, post, new Set(['b']))).toBe(true);
    expect(marchClose(members, post, new Set(['a']))).toBe(false);
    // The member that is outside the Wilderness is waited for like any other (the first walkers went in alone).
    expect(marchClose([{ name: 'a', at: near }, { name: 'b', at: bank }], { x: 3071, z: 3560 }, new Set())).toBe(false);
});

test('marchLegs: the edge, the entry of the connected area and the post', async () => {
    const { marchLegs } = await import('../src/pvp/squad');
    expect(marchLegs({ x: 3093, z: 3503 }, { x: 3067, z: 3640 })).toEqual([{ x: 3071, z: 3519 }, { x: 3071, z: 3600 }, { x: 3067, z: 3640 }]);
    // From inside the Wilderness there is no edge leg; a post that is not multi-way has no entry.
    expect(marchLegs({ x: 3090, z: 3560 }, { x: 3067, z: 3640 })).toEqual([{ x: 3071, z: 3600 }, { x: 3067, z: 3640 }]);
    expect(marchLegs({ x: 3093, z: 3503 }, { x: 3090, z: 3560 })).toEqual([{ x: 3090, z: 3560 }]);
});

test('an idle member keeps its prayer on near a target of the squad or after damage, and switches it off otherwise', async () => {
    const { keepPrayer } = await import('../src/pvp/squad');
    const targets = new Set(['goondelf', 'ligma']);
    const near = [{ name: 'Goondelf', distance: 5 }], far = [{ name: 'Goondelf', distance: 20 }], other = [{ name: 'Steve301', distance: 2 }];
    expect(keepPrayer({ view: near, targets, now: 100, damagedAt: -100 })).toBe(true);
    expect(keepPrayer({ view: far, targets, now: 100, damagedAt: -100 })).toBe(false);
    expect(keepPrayer({ view: other, targets, now: 100, damagedAt: -100 })).toBe(false);
    expect(keepPrayer({ view: [], targets, now: 100, damagedAt: 91 })).toBe(true);
    expect(keepPrayer({ view: [], targets, now: 100, damagedAt: 89 })).toBe(false);
});

test('squadTarget leaves out a target the game will not let it attack', async () => {
    const { squadTarget } = await import('../src/pvp/squad');
    const view = [{ name: 'Goondelf', index: 1, distance: 3, z: 3515, combatLevel: 126 }, { name: 'Ligma', index: 2, distance: 5, z: 3640, combatLevel: 125 }];
    const bar: Record<number, number> = { 1: 0.2, 2: 0.9 };
    expect(squadTarget(view, new Set(['goondelf', 'ligma']), p => bar[p.index]!, new Set(), { z: 3640, combatLevel: 126 })?.name).toBe('Ligma');
});

test('shouldStopUnseen keeps waiting when enemies are in view under refusal cooldown', () => {
    expect(shouldStopUnseen(true, 101, 100)).toBe(false);
    expect(shouldStopUnseen(false, 100, 100)).toBe(false);
    expect(shouldStopUnseen(false, 101, 100)).toBe(true);
});

test('keepPrayer stays off under the start floor of Prayer, and the memory gate asks for the floor plus one GiB a bot', async () => {
    const { keepPrayer, squadMemoryGate } = await import('../src/pvp/squad');
    const targets = new Set(['goondelf']), near = [{ name: 'Goondelf', distance: 3 }];
    expect(keepPrayer({ view: near, targets, now: 100, damagedAt: -100, points: 80, base: 99 })).toBe(true);
    expect(keepPrayer({ view: near, targets, now: 100, damagedAt: -100, points: 70, base: 99 })).toBe(false);
    expect(keepPrayer({ view: near, targets, now: 100, damagedAt: 95, points: 30, base: 99 })).toBe(false);
    expect(squadMemoryGate(8, 4)).toEqual({ ok: true, needGB: 8 });
    expect(squadMemoryGate(7.9, 4)).toEqual({ ok: false, needGB: 8 });
    expect(squadMemoryGate(4.1, 4).ok).toBe(false);
});
