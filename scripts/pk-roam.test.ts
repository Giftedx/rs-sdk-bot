import { test, expect } from 'bun:test';
import { bestFireSpell, canAttack, escapeZ, freezeSpell, intercept, itemCost, kitFrom, makeValuer, pickTrack, planLoot, Radar, spellId, sweep, wildLevel, type Track } from './pk-roam';

test('wildLevel: 8 tiles per level from z 3520 inside x 2944-3391', () => {
    expect(wildLevel(3094, 3519)).toBe(0);
    expect(wildLevel(3094, 3520)).toBe(1);
    expect(wildLevel(3094, 3527)).toBe(1);
    expect(wildLevel(3094, 3528)).toBe(2);
    expect(wildLevel(3058, 3884)).toBe(46); // rune rocks
    expect(wildLevel(2943, 3700)).toBe(0);
    expect(wildLevel(3392, 3700)).toBe(0);
});

test('canAttack uses the lower of the two Wilderness levels', () => {
    const me = { x: 3058, z: 3884, combat: 126 };
    expect(canAttack(me, { x: 3058, z: 3880, combatLevel: 95 })).toBe(true);
    expect(canAttack(me, { x: 3094, z: 3530, combatLevel: 120 })).toBe(false);
    expect(canAttack({ ...me, z: 3500 }, { x: 3058, z: 3880, combatLevel: 126 })).toBe(false);
});

const track = (o: Partial<Track>): Track => ({ name: 'T', x: 3060, z: 3700, combatLevel: 100, vx: 0, vz: 0, ...o });

test('intercept: a still target is met where it stands', () => {
    const at = intercept({ x: 3060, z: 3660 }, track({}));
    expect([at.x, at.z]).toEqual([3060, 3700]);
    expect(at.ticks).toBe(20); // 40 tiles at 2 per tick
});

test('intercept cuts off a target walking south: the meeting tile is south of where it stands', () => {
    const at = intercept({ x: 3100, z: 3640 }, track({ vz: -1 }));
    expect(at.z).toBeLessThan(3700);
    expect(Math.max(Math.abs(at.x - 3100), Math.abs(at.z - 3640))).toBeLessThanOrEqual(2 * at.ticks);
});

test('intercept: a target running away at full speed from behind gets a tile ahead on its line', () => {
    const at = intercept({ x: 3060, z: 3600 }, track({ z: 3640, vz: 2 }));
    expect(at.z).toBeGreaterThan(3640);
    expect(at.ticks).toBeGreaterThan(120);
});

test('pickTrack takes the target met first, skips ours, skipped, out of range and outside', () => {
    const me = { x: 3060, z: 3700, combat: 100 };
    const tracks = [
        track({ name: 'Moneyshot', z: 3702 }),
        track({ name: 'Ran', z: 3704 }),
        track({ name: 'Gap', z: 3706, combatLevel: 140 }),
        track({ name: 'Outside', z: 3510 }),
        track({ name: 'Far', z: 3760 }),
        track({ name: 'Near', z: 3720 }),
    ];
    expect(pickTrack(me, tracks, new Set(['moneyshot']), 56, new Set(['ran']))?.track.name).toBe('Near');
    expect(pickTrack(me, tracks, new Set(['moneyshot']), 20, new Set(['ran']))).toBeNull(); // all deeper than 20
    expect(pickTrack(me, [], new Set(), 56)).toBeNull();
});

test('Radar keeps surface players and their speed between roster frames', () => {
    const r = new Radar();
    r.accept({ t: 'roster', k: 100, p: [[1, 'Goondelf', 3000, 3800, 0, 126], [2, 'Upstairs', 3000, 3800, 1, 50]] }, 1000);
    expect(r.tracks.get('goondelf')).toMatchObject({ x: 3000, z: 3800, vx: 0, vz: 0 });
    expect(r.tracks.has('upstairs')).toBe(false);
    r.accept({ t: 'roster', k: 110, p: [[1, 'Goondelf', 3010, 3780, 0, 126]] }, 2000);
    expect(r.tracks.get('goondelf')).toMatchObject({ vx: 1, vz: -2 });
    expect(r.fresh(2000 + 14_000)).toBe(true);
    expect(r.fresh(2000 + 16_000)).toBe(false);
    r.accept({ t: 'tick', k: 111 } as any, 3000);
    expect(r.tick).toBe(110);
});

test('freezeSpell picks the strongest freeze by Magic level', () => {
    expect(freezeSpell(91)).toBe(1592); // Entangle
    expect(freezeSpell(60)).toBe(1582); // Snare
    expect(freezeSpell(20)).toBe(1572); // Bind
    expect(freezeSpell(19)).toBeNull();
});

test('sweep covers the Wilderness inside the depth limit, west-east then back', () => {
    const deep = sweep(56);
    expect(deep.length).toBe(30);
    expect(deep.every(p => wildLevel(p.x, p.z) >= 1)).toBe(true);
    expect(deep[4]).toEqual({ x: 3330, z: 3540 });
    expect(deep[5]).toEqual({ x: 3330, z: 3620 });
    expect(sweep(15).every(p => wildLevel(p.x, p.z) <= 15)).toBe(true);
    expect(sweep(1)).toEqual([{ x: 3090, z: 3524 }]);
});

test('pickTrack skips a target that can run out of range before a freeze lands', () => {
    expect(escapeZ(6)).toBe(3560);
    expect(escapeZ(0)).toBe(3520);
    const me = { x: 3094, z: 3570, combat: 97 };
    // Gap 6: out of range south of z 3560. At 3570 it is 10 tiles from escape: skipped. At 3600: 40 tiles, taken.
    expect(pickTrack(me, [track({ name: 'Edge', x: 3094, z: 3570, combatLevel: 91 })], new Set(), 56)).toBeNull();
    expect(pickTrack(me, [track({ name: 'Mid', x: 3094, z: 3590, combatLevel: 91 })], new Set(), 56)).toBeNull(); // 30 tiles
    expect(pickTrack(me, [track({ name: 'Deep', x: 3094, z: 3600, combatLevel: 91 })], new Set(), 56)?.track.name).toBe('Deep'); // 40 tiles
});

test('kitFrom: worn weapon and shield for melee, a carried bow, a carried staff; magic always usable', () => {
    const worn = [{ id: 1215, name: 'Dragon dagger', slot: 3 }, { id: 1540, name: 'Anti-dragon shield', slot: 5 }, { id: 1127, name: 'Rune platebody', slot: 4 }];
    const carried = [{ id: 861, name: 'Magic shortbow' }, { id: 1401, name: 'Mystic fire staff' }, { id: 385, name: 'Shark' }];
    expect(kitFrom(worn, carried)).toEqual({ magic: [1401], melee: [1215, 1540], ranged: [861] });
    expect(kitFrom([{ id: 1333, name: 'Rune scimitar', slot: 3 }], [])).toEqual({ magic: [], melee: [1333] });
    expect(kitFrom([{ id: 1387, name: 'Staff of fire', slot: 3 }], [])).toEqual({ magic: [1387] });
});

test('spellId maps names and ids, and falls back to Fire Bolt', () => {
    expect(spellId('FIRE_WAVE')).toBe(1189);
    expect(spellId('fire_blast')).toBe(1181);
    expect(spellId('1158')).toBe(1158);
    expect(spellId('nonsense')).toBe(1169);
});

test('planLoot keeps stacks on or next to the kill tile worth the floor, most valuable first', () => {
    const at = { x: 3060, z: 3700 };
    const ground = [
        { id: 526, name: 'Bones', count: 1, x: 3060, z: 3700 },
        { id: 1215, name: 'Dragon dagger', count: 1, x: 3061, z: 3700 },
        { id: 995, name: 'Coins', count: 5000, x: 3060, z: 3701 },
        { id: 385, name: 'Shark', count: 1, x: 3060, z: 3700 },
        { id: 1079, name: 'Rune platelegs', count: 1, x: 3065, z: 3700 },
    ];
    const price = new Map([[526, 1], [1215, 300000], [995, 1], [385, 900], [1079, 38000]]);
    expect(planLoot(ground, at, price, 1000).map(g => [g.name, g.value])).toEqual([['Dragon dagger', 300000], ['Coins', 5000]]);
    expect(planLoot(ground, at, price, 500).map(g => g.name)).toEqual(['Dragon dagger', 'Coins', 'Shark']);
});

test('makeValuer: live market price, cost fallback, coins at 1, local server skips the market', async () => {
    const calls: string[] = [];
    const live = makeValuer('rs-sdk-demo.fly.dev', async url => { calls.push(url); if (url.endsWith('/1215')) return { referencePrice: 300000, basePrice: 30000 }; throw Error('down'); });
    expect(await live(1215)).toBe(300000);
    expect(await live(1215)).toBe(300000);
    expect(calls.length).toBe(1); // cached
    expect(await live(526)).toBe(itemCost(526)); // market down: items.json cost
    expect(await live(995)).toBe(1);
    const local = makeValuer('localhost:8888', async () => { throw Error('must not call'); });
    expect(await local(1215)).toBe(itemCost(1215));
    expect(itemCost(1215)).toBe(30000);
});

test('bestFireSpell picks by Magic level and the runes carried', () => {
    expect(bestFireSpell(91, [{ id: 565, count: 10 }, { id: 560, count: 10 }])).toBe(1189);
    expect(bestFireSpell(91, [{ id: 560, count: 10 }, { id: 562, count: 10 }])).toBe(1181);
    expect(bestFireSpell(70, [{ id: 565, count: 10 }, { id: 562, count: 10 }])).toBe(1169);
    expect(bestFireSpell(91, [{ id: 560, count: 0 }])).toBe(1158);
});
