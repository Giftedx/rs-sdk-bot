import { expect, test } from 'bun:test';
import { createWorld, routeFares, type Tile } from '../src/world';
import type { Travel } from '../src/travel';

const tile = (x: number): Tile => ({ x, z: 3200, level: 0 });
const account = (coins: number) => ({ skills: {}, varps: {}, items: [], coins });
const boat = (id: string, from: number, to: number, coins: number, cost = 40): Travel => ({
    id, kind: 'boat', name: id, from: tile(from), to: tile(to), coins, cost,
    needs: [], runes: [], run: { how: 'npc', npc: 'Captain', op: 1, options: [] },
});
// Separate islands have no walking edge. All examples use exact dock tiles.
const islandWalk = (a: Tile, b: Tile) => a.x === b.x && a.z === b.z && a.level === b.level ? 0 : null;
const world = (travel: Travel[]) => createWorld({ transports: [], doors: [], travel, pathLength: islandWalk });

test('a trip funds every boat, including a third fare', () => {
    const w = world([boat('one', 0, 1000, 30), boat('two', 1000, 2000, 30), boat('three', 2000, 3000, 30)]);
    expect(w.route(tile(0), tile(3000), account(60))).toEqual({ ok: false, reason: 'no_route' });
    const funded = w.route(tile(0), tile(3000), account(90));
    expect(funded.ok && routeFares(funded.legs)).toBe(90);
    expect(funded.ok && funded.cost).toBe(120);
});

test('a slower affordable prefix survives a faster prefix that cannot fund the final boat', () => {
    const w = world([
        boat('fast-expensive', 0, 1000, 60, 5),
        boat('slow-affordable', 0, 1000, 20, 15),
        boat('final', 1000, 2000, 50, 5),
    ]);
    const result = w.route(tile(0), tile(2000), account(70));
    expect(result.ok && result.cost).toBe(20);
    expect(result.ok && result.legs.filter(l => l.kind === 'travel').map(l => l.travel.id)).toEqual(['slow-affordable', 'final']);
    expect(result.ok && routeFares(result.legs)).toBe(70);
    const rich = w.route(tile(0), tile(2000), account(110));
    expect(rich.ok && rich.cost).toBe(10);
});

test('fare feasibility and cheapest cost agree with an exhaustive small directed graph', () => {
    const edges = [
        boat('ab-fast', 0, 1000, 35, 5), boat('ab-cheap', 0, 1000, 5, 20),
        boat('bc', 1000, 2000, 20, 5), boat('cd', 2000, 3000, 25, 5),
        boat('ac', 0, 2000, 40, 25), boat('bd', 1000, 3000, 15, 30),
        boat('ad-free', 0, 3000, 0, 90),
    ];
    const w = world(edges);
    const enumerate = (at: number, cash: number): number => at === 3000 ? 0 : Math.min(Infinity,
        ...edges.filter(e => e.from!.x === at && e.coins <= cash).map(e => e.cost + enumerate(e.to.x, cash - e.coins)));
    for (const coins of [0, 5, 19, 20, 34, 40, 49, 50, 59, 60, 79, 80, 100]) {
        const result = w.route(tile(0), tile(3000), account(coins));
        expect(result.ok && result.cost).toBe(enumerate(0, coins));
        expect(result.ok && routeFares(result.legs) <= coins).toBe(true);
    }
});

test('lazy walking legs preserve affordable alternatives in both travel directions', () => {
    const edges = [
        boat('ab-fast', 10, 1000, 35, 5), boat('ab-cheap', 20, 1010, 5, 20),
        boat('bc', 1020, 2000, 25, 5), boat('ac-free', 30, 2010, 0, 90),
    ];
    const reversed = edges.map(e => ({ ...e, id: e.id + '-back', from: e.to, to: e.from! }));
    const links = [...edges, ...reversed];
    const localWalk = (a: Tile, b: Tile, _blocks: unknown[], tolerance: number) => Math.floor(a.x / 1000) === Math.floor(b.x / 1000)
        ? Math.max(0, Math.abs(a.x - b.x) - tolerance) : null;
    const w = createWorld({ transports: [], doors: [], travel: links, pathLength: localWalk });
    for (const [start, goal] of [[tile(0), tile(2020)], [tile(2020), tile(0)]] as const) for (const coins of [0, 5, 24, 25, 29, 30, 59, 60]) {
        const nodes = [...new Map([start, goal, ...links.flatMap(e => [e.from!, e.to])].map(t => [t.x, t])).values()];
        // Independent relaxation over every tile/remaining-coin state, including
        // measured directed walks. It does not use the route search or heuristic.
        const distances = new Map<string, number>([[`${start.x}:${coins}`, 0]]);
        const relax = (to: Tile, cash: number, cost: number) => {
            const key = `${to.x}:${cash}`;
            if (cost >= (distances.get(key) ?? Infinity)) return false;
            distances.set(key, cost);
            return true;
        };
        for (let pass = 0; pass < nodes.length * (coins + 1); pass++) {
            let changed = false;
            for (const from of nodes) for (let cash = 0; cash <= coins; cash++) {
                const cost = distances.get(`${from.x}:${cash}`);
                if (cost === undefined) continue;
                for (const to of nodes) {
                    const walk = localWalk(from, to, [], to.x === goal.x ? 1 : 0);
                    if (walk !== null) changed = relax(to, cash, cost + walk) || changed;
                }
                for (const link of links) if (link.from!.x === from.x && link.coins <= cash)
                    changed = relax(link.to, cash - link.coins, cost + link.cost) || changed;
            }
            if (!changed) break;
        }
        const optimum = Math.min(...Array.from({ length: coins + 1 }, (_, cash) => distances.get(`${goal.x}:${cash}`) ?? Infinity));
        const result = w.route(start, goal, account(coins));
        expect(result.ok && result.cost).toBe(optimum);
        expect(result.ok && routeFares(result.legs) <= coins).toBe(true);
    }
});
