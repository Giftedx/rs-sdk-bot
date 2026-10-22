import { test, expect } from 'bun:test';
import { createWorld, type Tile, type Account } from '../src/world';

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
