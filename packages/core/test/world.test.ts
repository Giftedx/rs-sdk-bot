import { test, expect } from 'bun:test';
import { createWorld, blockedDoorsNear, type Door, type Tile, type Account } from '../src/world';

const acct = (skills: Record<string, number> = {}): Account => ({ skills, varps: {}, items: [] });
// Flat world: walking costs Chebyshev distance on the same level, never across levels.
const flat = (from: Tile, to: Tile) => (from.level === to.level ? Math.max(Math.abs(from.x - to.x), Math.abs(from.z - to.z)) : null);

const stairA = { locName: 'stairs', option: 'op1', from: { x: 10, z: 0, level: 0 }, to: { x: 10, z: 2, level: 1 }, exact: true, src: 'a', toSrc: 'a', handler: 'a' };
const stairB = { locName: 'stairs', option: 'op1', from: { x: 50, z: 0, level: 0 }, to: { x: 50, z: 2, level: 1 }, exact: true, src: 'b', toSrc: 'b', handler: 'b' };

test('a goal on another level is reached through the stair edge', () => {
    const w = createWorld({ transports: [stairA], doors: [], pathLength: flat });
    const r = w.route({ x: 0, z: 0, level: 0 }, { x: 12, z: 5, level: 1 }, acct());
    expect(r.ok).toBe(true);
    if (r.ok) {
        expect(r.legs.map(l => l.kind)).toEqual(['walk', 'transport', 'walk']);
        expect(r.legs[1]).toMatchObject({ kind: 'transport', loc: 'stairs', at: { x: 10, z: 0, level: 0 }, to: { x: 10, z: 2, level: 1 } });
    }
});

test('the cheaper of two stairs wins', () => {
    const w = createWorld({ transports: [stairA, stairB], doors: [], pathLength: flat });
    const r = w.route({ x: 48, z: 0, level: 0 }, { x: 49, z: 4, level: 1 }, acct());
    expect(r.ok && r.legs[1]!.kind === 'transport' && (r.legs[1] as any).at.x).toBe(50);
});

test('a stair behind a skill door the account fails gives no_route', () => {
    // The door blocks the only walk from the start to the stair; pathLength sees blocked doors.
    const door = { id: 1, loc: 'guilddoor', x: 5, z: 0, level: 0, kind: 'skill', need: { skill: 'mining', level: 60 }, trigger: 't', src: 's' };
    const gated = (from: Tile, to: Tile, blocked: Tile[]) => {
        const crosses = blocked.some(b => b.level === from.level && Math.min(from.x, to.x) < b.x && b.x < Math.max(from.x, to.x));
        return crosses ? null : flat(from, to);
    };
    const w = createWorld({ transports: [stairA], doors: [door as any], pathLength: gated });
    expect(w.route({ x: 0, z: 0, level: 0 }, { x: 10, z: 2, level: 1 }, acct({ mining: 10 }))).toEqual({ ok: false, reason: 'no_route' });
    expect(w.route({ x: 0, z: 0, level: 0 }, { x: 10, z: 2, level: 1 }, acct({ mining: 60 })).ok).toBe(true);
});

test('blocked doors: open passes, skill and key follow the account, locked and unknown never pass', async () => {
    const { doorBlocks } = await import('../src/world');
    const d = (kind: string, need?: object) => ({ id: 1, loc: 'd', x: 1, z: 1, level: 0, kind, need, trigger: '', src: '' }) as any;
    const a: Account = { skills: { magic: 70 }, varps: {}, items: ['brass_key'] };
    expect(doorBlocks(d('open'), a)).toBe(false);
    expect(doorBlocks(d('skill', { skill: 'magic', level: 66 }), a)).toBe(false);
    expect(doorBlocks(d('skill', { skill: 'magic', level: 80 }), a)).toBe(true);
    expect(doorBlocks(d('key', { item: 'brass_key' }), a)).toBe(false);
    expect(doorBlocks(d('key', { item: 'other_key' }), a)).toBe(true);
    expect(doorBlocks(d('locked'), a)).toBe(true);
    expect(doorBlocks(d('unknown'), a)).toBe(true);
});

test('a stair tile that cannot be stood on is reached from next to it', () => {
    // Walking may end at most `tol` tiles from the target; the stair tile itself is never walkable.
    const nearOnly = (from: Tile, to: Tile, _b: Tile[], tol: number) => {
        if (from.level !== to.level) return null;
        const unwalkable = to.x === 10 && to.z === 0;
        if (unwalkable && !(tol >= 1)) return null;
        return Math.max(Math.abs(from.x - to.x), Math.abs(from.z - to.z));
    };
    const w = createWorld({ transports: [stairA], doors: [], pathLength: nearOnly });
    expect(w.route({ x: 0, z: 0, level: 0 }, { x: 10, z: 2, level: 1 }, acct()).ok).toBe(true);
});

test('a short route does not measure every far-away stair (lazy search)', () => {
    let calls = 0;
    const counted = (from: Tile, to: Tile, b: Tile[], tol: number) => { calls++; return flat(from, to); };
    const many = Array.from({ length: 200 }, (_, i) => ({ ...stairA, from: { x: 100 + i, z: 100 + (i % 50), level: 0 }, to: { x: 100 + i, z: 102, level: 1 }, src: `s${i}` }));
    const w = createWorld({ transports: many, doors: [], pathLength: counted });
    const r = w.route({ x: 0, z: 0, level: 0 }, { x: 5, z: 5, level: 0 }, acct());
    expect(r.ok).toBe(true);
    expect(calls).toBeLessThanOrEqual(10);
});

test('a menu op1 is dropped when the same stair has direct op2/op3 links', () => {
    const mid = { x: 10, z: 0, level: 1 };
    const t = [
        { ...stairA },
        { locName: 'mid', option: 'op1', from: mid, to: { x: 10, z: 2, level: 2 }, exact: true, src: 'm1', toSrc: 'm1', handler: 'm' },
        { locName: 'mid', option: 'op2', from: mid, to: { x: 10, z: 6, level: 2 }, exact: true, src: 'm2', toSrc: 'm2', handler: 'm' },
    ];
    const w = createWorld({ transports: t, doors: [], pathLength: flat });
    const r = w.route({ x: 0, z: 0, level: 0 }, { x: 10, z: 2, level: 2 }, acct());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.legs.filter(l => l.kind === 'transport').map(l => (l as any).option)).toEqual(['op1', 'op2']);
    // the first op1 is stairA (no op2 sibling), the second climb must be op2, never mid's op1 menu
});

test('dungeon tiles (z + 6400) do not mislead the search into a far exit', () => {
    // Optimal: walk 60 in the dungeon to exit A, land 5 tiles from the goal. Exit B is a shorter dungeon walk
    // but lands 250 tiles away (inside the 300-tile walk limit). With a raw Chebyshev bound, B's dungeon tile looks closer to the surface goal.
    const exitA = { locName: 'ladderA', option: 'op1', from: { x: 100, z: 6560, level: 0 }, to: { x: 100, z: 105, level: 0 }, exact: true, src: 'a', toSrc: 'a', handler: 'a' };
    const exitB = { locName: 'ladderB', option: 'op1', from: { x: 100, z: 6450, level: 0 }, to: { x: 350, z: 100, level: 0 }, exact: true, src: 'b', toSrc: 'b', handler: 'b' };
    const w = createWorld({ transports: [exitA, exitB], doors: [], pathLength: (a, b) => (Math.abs(a.z - b.z) > 3200 ? null : flat(a, b)) });
    const r = w.route({ x: 100, z: 6500, level: 0 }, { x: 100, z: 100, level: 0 }, acct());
    expect(r.ok).toBe(true);
    if (r.ok) {
        expect(r.legs.find(l => l.kind === 'transport')).toMatchObject({ loc: 'ladderA' });
        expect(r.cost).toBeLessThan(100);
    }
});


test('near-leg blocked doors share account policy and exclude other floors/far tiles', () => {
    const make = (x: number, kind: string, need?: Door['need'], level = 0): Door => ({ id: x, loc: 'door', x, z: 10, level, kind, need, trigger: '', src: '' });
    const doors = [make(5, 'open'), make(6, 'locked'), make(7, 'one_way'), make(8, 'conditional'), make(9, 'unknown'),
        make(10, 'skill', { skill: 'crafting', level: 10 }), make(11, 'key', { item: 'brass_key' }), make(12, 'quest', { varp: 'quest' }),
        make(5000, 'locked'), make(13, 'locked', undefined, 1)];
    const account = { skills: { crafting: 10 }, varps: {}, items: ['brass_key'] };
    const from = { x: 0, z: 0, level: 0 }, to = { x: 20, z: 20, level: 0 };
    expect(blockedDoorsNear(from, to, account, doors).map(d => d.x)).toEqual([6, 7, 8, 9, 12]);
    expect(blockedDoorsNear(from, to, { ...account, varps: { quest: 1 } }, doors).map(d => d.x)).toEqual([6, 7, 8, 9]);
    expect(blockedDoorsNear(from, { ...to, level: 1 }, account, doors)).toEqual([]);
});

test('generated Ardougne side-locked pair blocks the Catherby leg before the building is entered', () => {
    const blocked = blockedDoorsNear({ x: 2654, z: 3283, level: 0 }, { x: 2809, z: 3441, level: 0 }, acct());
    expect(blocked).toContainEqual({ x: 2674, z: 3304, level: 0 });
    expect(blocked).toContainEqual({ x: 2674, z: 3305, level: 0 });
});
