import { test, expect } from 'bun:test';
import { bestFireSpell, canAttack, castableFreeze, restockPlan, CLAIM_TTL_MS, escapeStep, escapeZ, isMulti, preyScore, freezeSpell, intercept, itemCost, kitFrom, makeValuer, pickTrack, planLoot, Radar, spellId, sweep, wildLevel, type Track } from './pk-roam';

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

test('isMulti reads maps/multiway.csv zones: rune rocks single-way, west of them multi', () => {
    expect(isMulti(3058, 3884)).toBe(false);
    expect(isMulti(3040, 3900)).toBe(true);
    expect(isMulti(3094, 3540)).toBe(false);
});

test('preyScore favours skulled, busy, hurt, unprotected and no-teleport prey', () => {
    const t = track({ z: 3600 }); // level 11
    expect(preyScore(t, 20)).toBe(20);
    expect(preyScore({ ...t, skulled: true }, 20)).toBe(-20);
    expect(preyScore({ ...t, fighting: 'npc' }, 20)).toBe(-10);
    expect(preyScore({ ...t, hpFrac: 0.5 }, 20)).toBe(-10);
    expect(preyScore({ ...t, protect: [] }, 20)).toBe(10);
    expect(preyScore({ ...t, z: 3700 }, 20)).toBe(10);  // level 23: no normal teleport
    expect(preyScore({ ...t, z: 3800 }, 20)).toBe(-5);  // level 36: no glory either
    expect(preyScore(t, 20, true)).toBe(-10);           // ganged in multi-combat
});

test('pickTrack: single-way leaves fighters and other hunters\' claims; multi-combat gangs them', () => {
    const me = { x: 3060, z: 3700, combat: 100, name: 'hunter1' };
    const single = () => false, multi = () => true;
    const busy = [track({ name: 'Busy', z: 3705, fighting: 'player' })];
    expect(pickTrack(me, busy, new Set(), 56, new Set(), 40, new Map(), 0, single)).toBeNull();
    expect(pickTrack(me, busy, new Set(), 56, new Set(), 40, new Map(), 0, multi)?.track.name).toBe('Busy');
    const claims = new Map([['near', { hunter: 'hunter2', at: 1000 }]]);
    const two = [track({ name: 'Near', z: 3702 }), track({ name: 'Far', z: 3740 })];
    expect(pickTrack(me, two, new Set(), 56, new Set(), 40, claims, 2000, single)?.track.name).toBe('Far');
    expect(pickTrack(me, two, new Set(), 56, new Set(), 40, claims, 2000, multi)?.track.name).toBe('Near');
    // A stale claim (older than CLAIM_TTL_MS) is ignored; my own claim never blocks me.
    expect(pickTrack(me, two, new Set(), 56, new Set(), 40, claims, 1000 + CLAIM_TTL_MS + 1, single)?.track.name).toBe('Near');
    expect(pickTrack({ ...me, name: 'hunter2' }, two, new Set(), 56, new Set(), 40, claims, 2000, single)?.track.name).toBe('Near');
});

test('pickTrack prefers a skulled target a little further away', () => {
    const me = { x: 3060, z: 3700, combat: 100 };
    const pair = [track({ name: 'Close', z: 3710 }), track({ name: 'Skull', z: 3760, skulled: true })];
    expect(pickTrack(me, pair, new Set(), 56, new Set(), 40, new Map(), 0, () => false)?.track.name).toBe('Skull');
});

test('escapeStep: glory to level 30, teleport to 20, else run south', () => {
    expect(escapeStep(0, { glory: false, teleport: false })).toBe('out');
    expect(escapeStep(30, { glory: true, teleport: true })).toBe('glory');
    expect(escapeStep(31, { glory: true, teleport: true })).toBe('run');
    expect(escapeStep(20, { glory: false, teleport: true })).toBe('teleport');
    expect(escapeStep(21, { glory: false, teleport: true })).toBe('run');
    expect(escapeStep(5, { glory: false, teleport: false })).toBe('run');
});

test('pickTrack skips a target that outclasses us or stands in a pile', () => {
    const me = { x: 3060, z: 3700, combat: 100 };
    expect(pickTrack(me, [track({ name: 'Big', z: 3705, combatLevel: 104 })], new Set(), 56, new Set(), 40, new Map(), 0, () => false)).toBeNull();
    expect(pickTrack(me, [track({ name: 'Even', z: 3705, combatLevel: 103 })], new Set(), 56, new Set(), 40, new Map(), 0, () => false)?.track.name).toBe('Even');
    const pile = [track({ name: 'Mark', z: 3705 }), track({ name: 'A', x: 3062, z: 3706 }), track({ name: 'B', x: 3058, z: 3704 })];
    // Each of the three has two strangers within 6 tiles: all skipped.
    expect(pickTrack(me, pile, new Set(), 56, new Set(), 40, new Map(), 0, () => false)).toBeNull();
    // Our own accounts near a target are not a pile.
    expect(pickTrack(me, pile, new Set(['a', 'b']), 56, new Set(), 40, new Map(), 0, () => false)?.track.name).toBe('Mark');
});

test('castableFreeze needs the level and the runes', () => {
    const runes = (earth: number, water: number, nature: number) => [{ id: 557, count: earth }, { id: 555, count: water }, { id: 561, count: nature }];
    expect(castableFreeze(91, runes(67, 1, 0))).toBeNull();      // live Mightyrod: 1 water, no nature
    expect(castableFreeze(91, runes(10, 10, 10))).toBe(1592);    // Entangle
    expect(castableFreeze(91, runes(4, 4, 3))).toBe(1582);       // runes for Snare only
    expect(castableFreeze(60, runes(10, 10, 10))).toBe(1582);    // level for Snare only
    expect(castableFreeze(19, runes(10, 10, 10))).toBeNull();
});

test('pickTrack skips a target at our level whose weapon is worth over twice ours', () => {
    const me = { x: 3060, z: 3700, combat: 126, weaponValue: itemCost(1331) }; // adamant scimitar
    const goondelf = track({ name: 'Goondelf', z: 3705, combatLevel: 126, weapon: 1215 }); // dragon dagger
    expect(pickTrack(me, [goondelf], new Set(), 56, new Set(), 40, new Map(), 0, () => false)).toBeNull();
    expect(pickTrack({ ...me, weaponValue: itemCost(1215) }, [goondelf], new Set(), 56, new Set(), 40, new Map(), 0, () => false)?.track.name).toBe('Goondelf');
    // A much weaker player with a good weapon is still prey.
    expect(pickTrack(me, [{ ...goondelf, combatLevel: 110 }], new Set(), 56, new Set(), 40, new Map(), 0, () => false)?.track.name).toBe('Goondelf');
});

test('restockPlan: law runes first, then freeze runes, within the coins', () => {
    // Live Mightyrod after its first trip: 9 law, 0 nature, 1 water, about 4,900 coins: nothing for law; 11 nature, 500 gp kept for water.
    expect(restockPlan({ law: 9, nature: 0, water: 1, coins: 4943, magic: 91 })).toEqual([
        { kind: 'ge', item: 561, quantity: 11, limit: 300, owned: 0 },
        { kind: 'shop', profile: 'betty', maxSpend: 500 },
    ]);
    expect(restockPlan({ law: 1, nature: 20, water: 50, coins: 20000, magic: 72 })).toEqual([{ kind: 'ge', item: 563, quantity: 10, limit: 1600, owned: 1 }]);
    expect(restockPlan({ law: 0, nature: 0, water: 0, coins: 3000, magic: 40 })).toEqual([{ kind: 'ge', item: 563, quantity: 1, limit: 1600, owned: 0 }]);
    expect(restockPlan({ law: 0, nature: 0, water: 0, coins: 2000, magic: 91 })).toEqual([]);
    expect(restockPlan({ law: 5, nature: 10, water: 20, coins: 99999, magic: 91 })).toEqual([]);
});
