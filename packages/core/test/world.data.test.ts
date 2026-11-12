import { beforeAll, test, expect } from 'bun:test';
import { loadPathfinding } from '../src/pathcache';
import { createWorld, rsPathLength, type Account } from '../src/world';

// Build the same collision grid as production before the world caches region labels.
beforeAll(async () => { await loadPathfinding(); }, 120_000);

const acct: Account = { skills: {}, varps: {}, items: [] };

test('Varrock Museum: ground floor to level 1 uses the museum stairs from transports.json', async () => {
    const w = createWorld({ pathLength: await rsPathLength() });
    const t0 = Date.now();
    const r = w.route({ x: 3258, z: 3444, level: 0 }, { x: 3259, z: 3449, level: 1 }, acct);
    console.log(`museum: ${Date.now() - t0} ms`, JSON.stringify(r));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.legs.some(l => l.kind === 'transport' && l.loc === 'stairs' && l.at.x === 3259 && l.at.z === 3446)).toBe(true);
}, 120_000);

test('the Observatory has a route out: its ladder down, the cavern, the ladder up to the reception', async () => {
    const w = createWorld({ pathLength: await rsPathLength() });
    const t0 = Date.now();
    // The telescope side of the Observatory, where its quest ends, to the East Ardougne market. The walk from the
    // reception passes ground that the danger rule closes for a level 1 account, so this account has combat levels.
    const fighter: Account = { ...acct, skills: { attack: 37, strength: 1, defence: 1, hitpoints: 26, prayer: 47, ranged: 1, magic: 1 } };
    const r = w.route({ x: 2439, z: 3158, level: 0 }, { x: 2654, z: 3283, level: 0 }, fighter);
    console.log(`observatory->ardougne: ${Date.now() - t0} ms`, r.ok ? `cost ${r.cost}, legs ${r.legs.map(l => l.kind === 'transport' ? l.loc : l.kind).join(' ')}` : r.reason);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.legs.filter(l => l.kind === 'transport').map(l => l.loc)).toEqual(['domeladderdown', 'loc_2188']);
}, 120_000);

test('Lumbridge to Varrock square is one walk under 400 tiles', async () => {
    const w = createWorld({ pathLength: await rsPathLength() });
    const t0 = Date.now();
    const r = w.route({ x: 3222, z: 3218, level: 0 }, { x: 3213, z: 3424, level: 0 }, acct);
    console.log(`lumbridge->varrock: ${Date.now() - t0} ms`, r.ok ? `cost ${r.cost}, legs ${r.legs.length}` : r.reason);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cost).toBeLessThan(400);
}, 120_000);
