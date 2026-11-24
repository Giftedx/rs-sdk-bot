import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildItemSources } from '../src/item-sources';
import { parseJm2 } from '../src/jm2';
import { contentRoot } from '../src/paths';
import { cachedValue } from '../src/table-cache';

test('parseJm2 skips MAP sections, preserves comment line numbers, and filters LOC/OBJ spawns cleanly', () => {
    const fixture = [
        '==== MAP ====',
        '0 0 0: h1 u75 // ==== OBJ ====',
        '0 0 1: h1 u75',
        '',
        '==== NPC ====',
        '0 1 2: 50 // guard',
        '==== LOC ====',
        '1 3 4: 2090 10 2',
        '0 5 6: 9999',
        '==== OBJ ====',
        '0 7 8: 526 3',
        '0 9 10: 995',
    ].join('\r\n');

    const full = parseJm2('m50_50.jm2', fixture);
    expect(full).toEqual({
        npcs: [{ id: 50, x: 3201, z: 3202, level: 0, src: 'maps/m50_50.jm2:6' }],
        locs: [
            { id: 2090, x: 3203, z: 3204, level: 1, src: 'maps/m50_50.jm2:8', shape: 10, angle: 2 },
            { id: 9999, x: 3205, z: 3206, level: 0, src: 'maps/m50_50.jm2:9', shape: 10, angle: 0 },
        ],
        objs: [
            { id: 526, x: 3207, z: 3208, level: 0, src: 'maps/m50_50.jm2:11', count: 3 },
            { id: 995, x: 3209, z: 3210, level: 0, src: 'maps/m50_50.jm2:12', count: 1 },
        ],
    });

    const filtered = parseJm2('m50_50.jm2', fixture, {
        locIds: new Set([2090]),
        objIds: new Set([526]),
        npcs: false,
    });
    expect(filtered).toEqual({
        npcs: [],
        locs: [full.locs[0]!],
        objs: [full.objs[0]!],
    });

    const realText = readFileSync(join(contentRoot(), 'maps', 'm49_53.jm2'), 'utf8');
    const realFull = parseJm2('m49_53.jm2', realText);
    const realFiltered = parseJm2('m49_53.jm2', realText, {
        locIds: new Set([2783]),
        objIds: new Set([526]),
        npcs: false,
    });
    expect(realFiltered.npcs).toEqual([]);
    expect(realFiltered.locs).toEqual(realFull.locs.filter(l => l.id === 2783));
    expect(realFiltered.objs).toEqual(realFull.objs.filter(o => o.id === 526));
});

test('cachedValue invalidates on tag change and respects KNOWLEDGE_CACHE=0', () => {
    const name = `perf-parity-test-${process.pid}`;
    let builds = 0;
    const build = (v: number) => { builds++; return { v }; };
    const prevEnv = process.env.KNOWLEDGE_CACHE;
    try {
        delete process.env.KNOWLEDGE_CACHE;
        expect(cachedValue(name, 1, 'tag-a', () => build(1))).toEqual({ v: 1 });
        expect(builds).toBe(1);
        expect(cachedValue(name, 1, 'tag-a', () => build(2))).toEqual({ v: 1 });
        expect(builds).toBe(1);
        expect(cachedValue(name, 1, 'tag-b', () => build(3))).toEqual({ v: 3 });
        expect(builds).toBe(2);

        process.env.KNOWLEDGE_CACHE = '0';
        expect(cachedValue(name, 1, 'tag-b', () => build(4))).toEqual({ v: 4 });
        expect(builds).toBe(3);
    } finally {
        if (prevEnv === undefined) delete process.env.KNOWLEDGE_CACHE;
        else process.env.KNOWLEDGE_CACHE = prevEnv;
        const cacheDir = join(import.meta.dir, '..', '..', '..', '.practice', 'cache', 'knowledge');
        if (existsSync(cacheDir)) {
            for (const entry of readdirSync(cacheDir)) {
                if (entry.startsWith(`${name}-`)) rmSync(join(cacheDir, entry), { force: true });
            }
        }
    }
});

test('buildItemSources cached output matches KNOWLEDGE_CACHE=0 uncached output identically', () => {
    const market = {
        at: new Date(10_000).toISOString(),
        file: 'research/test-market.json',
        prices: { copper_ore: { ask: 10, bid: 8, sell: 12 } },
    };
    const cached = buildItemSources({ market });
    const prev = process.env.KNOWLEDGE_CACHE;
    let uncached: ReturnType<typeof buildItemSources>;
    try {
        process.env.KNOWLEDGE_CACHE = '0';
        uncached = buildItemSources({ market });
    } finally {
        if (prev === undefined) delete process.env.KNOWLEDGE_CACHE;
        else process.env.KNOWLEDGE_CACHE = prev;
    }
    expect(cached).toEqual(uncached);
}, 20000);
