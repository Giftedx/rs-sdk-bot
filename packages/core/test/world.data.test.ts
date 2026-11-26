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

// Quest areas that quest jobs leave accounts in. Each needs one table fact: a door rule, a gate stage or a named ladder.
const maxed: Account = { ...acct, skills: { attack: 99, strength: 99, defence: 99, hitpoints: 99, prayer: 99, ranged: 99, magic: 99 } };
const legsOf = (r: ReturnType<ReturnType<typeof createWorld>['route']>) => r.ok ? r.legs.map(l => l.kind === 'transport' ? l.loc : l.kind).join(' ') : r.reason;

test('the Witch\'s House basement has a route out without the key, and the house stays shut to a player outside', async () => {
    const w = createWorld({ pathLength: await rsPathLength() });
    const out = w.route({ x: 2907, z: 9873, level: 0 }, { x: 3185, z: 3436, level: 0 }, maxed);
    console.log(`witch basement->varrock: ${legsOf(out)}`);
    expect(out.ok).toBe(true);
    expect(w.route({ x: 2900, z: 3480, level: 0 }, { x: 2907, z: 3475, level: 0 }, maxed).ok).toBe(false);
}, 120_000);

test('the pocket below the Ikov dark stairs has a route out up those stairs', async () => {
    const w = createWorld({ pathLength: await rsPathLength() });
    const r = w.route({ x: 2639, z: 9737, level: 0 }, { x: 2619, z: 3332, level: 0 }, maxed);
    console.log(`ikov pocket->ardougne: ${legsOf(r)}`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.legs.some(l => l.kind === 'transport' && l.loc === 'ikov_darkstairs')).toBe(true);
}, 120_000);

test('the jungle east of the Tai Bwo Wannai river has a route out across the river log', async () => {
    const w = createWorld({ pathLength: await rsPathLength() });
    // Where Shilo Village left an account (north of its stepping stones) to Trufitus, west of the river.
    const out = w.route({ x: 2889, z: 3090, level: 0 }, { x: 2809, z: 3086, level: 0 }, maxed);
    const logs = (r: typeof out) => r.ok ? r.legs.flatMap(l => l.kind === 'travel' && l.travel.run.how === 'loc' && l.travel.run.loc === 'zq_logbalance' ? [l.travel.id] : []) : [];
    console.log(`east jungle->trufitus: ${legsOf(out)} ${logs(out).join(' ')}`);
    expect(out.ok).toBe(true);
    expect(logs(out)).toEqual(['loc:zq_logbalance@2909,3049,0>2906,3049']);
    const back = w.route({ x: 2809, z: 3086, level: 0 }, { x: 2917, z: 3058, level: 0 }, maxed);
    expect(back.ok).toBe(true);
    expect(logs(back)).toEqual(['loc:zq_logbalance@2907,3049,0>2910,3049']);
}, 120_000);

test('the room between the Paterdomus gates has a route out from priestperil stage 5 only', async () => {
    const w = createWorld({ pathLength: await rsPathLength() });
    const at = (stage: number | undefined) => w.route({ x: 3428, z: 9891, level: 0 }, { x: 3185, z: 3436, level: 0 }, { ...maxed, questStages: stage === undefined ? {} : { priestperil: stage } });
    expect(at(undefined).ok).toBe(false);
    expect(at(4).ok).toBe(false);
    expect(at(5).ok).toBe(true);
}, 120_000);
