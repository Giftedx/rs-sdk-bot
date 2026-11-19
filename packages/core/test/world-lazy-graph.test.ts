import { test, expect } from 'bun:test';
import { createWorld, type Account, type Tile } from '../src/world';

const acct = (skills: Record<string, number> = {}): Account => ({ skills, varps: {}, items: [] });
const flat = (from: Tile, to: Tile) => (from.level === to.level ? Math.max(Math.abs(from.x - to.x), Math.abs(from.z - to.z)) : null);
const stair = { locName: 'stairs', option: 'op1', from: { x: 10, z: 0, level: 0 }, to: { x: 10, z: 2, level: 1 }, exact: true, src: 'a', toSrc: 'a', handler: 'a', interaction: { id: 1, shape: 10, angle: 0, width: 1, height: 1 } };

// A transports list that counts how often the world reads it to build its route graph.
const counted = () => {
    const state = { reads: 0 };
    const list: any = new Proxy([stair] as any[], { get: (target, key, receiver) => { if (key === 'map') state.reads++; return Reflect.get(target, key, receiver); } });
    return { state, list };
};

test('the route graph builds on the first route call, not at createWorld or blockedDoors', () => {
    const { state, list } = counted();
    const door = { id: 1, loc: 'guilddoor', x: 5, z: 0, level: 0, kind: 'skill', need: { skill: 'mining', level: 60 }, trigger: 't', src: 's' };
    const w = createWorld({ transports: list, doors: [door as any], pathLength: flat });
    expect(state.reads).toBe(0);
    expect(w.blockedDoors(acct({ mining: 1 }))).toHaveLength(1);
    expect(w.blockedDoors(acct({ mining: 99 }))).toHaveLength(0);
    expect(state.reads).toBe(0);
    const r = w.route({ x: 0, z: 0, level: 0 }, { x: 12, z: 5, level: 1 }, acct({ mining: 99 }));
    expect(r.ok).toBe(true);
    const built = state.reads;
    expect(built).toBeGreaterThan(0);
    w.route({ x: 0, z: 0, level: 0 }, { x: 12, z: 5, level: 1 }, acct({ mining: 99 }));
    expect(state.reads).toBe(built);
});

test('navigationGraph and routeGain build the graph once, with the same answers as a built world', () => {
    const { state, list } = counted();
    const w = createWorld({ transports: list, doors: [], pathLength: flat });
    expect(state.reads).toBe(0);
    expect(w.navigationGraph!().transports).toHaveLength(1);
    const built = state.reads;
    expect(built).toBeGreaterThan(0);
    expect(w.routeGain!(acct(), acct())).toBe(false);
    expect(state.reads).toBe(built);
});
