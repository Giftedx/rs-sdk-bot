import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { listConfigFiles, listConfigFilesByExt } from '../src/config';
import { parseDropProcs, parseDrops } from '../src/drops';
import { parseStaffItems } from '../src/gear';
import { buildItemSources } from '../src/item-sources';
import { parseJm2 } from '../src/jm2';
import { block, loadContent, modelRung } from '../src/method-model';
import { contentRoot } from '../src/paths';
import { buildShortcuts, movingScripts, parseScripts, stripComments } from '../src/shortcuts';
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

test('listConfigFilesByExt matches listConfigFiles identically for multiple extensions', () => {
    const exts = ['.obj', '.param', '.dbtable', '.loc'] as const;
    const grouped = listConfigFilesByExt(exts);
    for (const ext of exts) {
        expect(grouped.get(ext)).toEqual(listConfigFiles(ext));
    }
});

test('stripComments preserves line counts, string literals, and CRLF across fast and comment paths', () => {
    const noComments = '  [oploc1,foo]  \r\n  p_teleport(0_50_50_1_1);  \n';
    expect(stripComments(noComments)).toEqual(['[oploc1,foo]', 'p_teleport(0_50_50_1_1);', '']);

    const withComments = [
        'mes("keep // and /* inside \\"quotes\\""); // trailing',
        '/* block start',
        '   ignored middle */ code_after();',
        'plain_line();',
    ].join('\r\n');
    expect(stripComments(withComments)).toEqual([
        'mes("keep // and /* inside \\"quotes\\"");',
        '',
        'code_after();',
        'plain_line();',
    ]);
});

test('shortcuts movingScripts and buildShortcuts merge complementary branches and detect twoWay pairs', () => {
    const scriptText = [
        '[proc,hop_helper](coord $dest)',
        'p_teleport($dest);',
        '',
        '[oploc1,portal_a]',
        'if (%misc_flag = 1) { ~hop_helper(0_50_50_10_10); } else { ~hop_helper(0_50_50_10_10); }',
        '',
        '[oploc1,portal_b]',
        'p_teleport(0_50_50_1_1);',
    ].join('\n');
    const scripts = parseScripts([{ text: scriptText, file: 'scripts/areas/test/portals.rs2' }]);
    const moving = movingScripts(scripts);
    expect(moving.has('proc,hop_helper')).toBe(true);
    expect(moving.has('oploc1,portal_a')).toBe(true);
    expect(moving.has('oploc1,portal_b')).toBe(true);

    const out = buildShortcuts({
        scriptFiles: [{ text: scriptText, file: 'scripts/areas/test/portals.rs2' }],
        constantFiles: [],
        locConfigs: new Map([
            ['portal_a', { name: 'portal_a', props: { op1: ['Enter'] }, propLines: { op1: [2] }, file: 'test.loc', line: 1 }],
            ['portal_b', { name: 'portal_b', props: { op1: ['Enter'] }, propLines: { op1: [5] }, file: 'test.loc', line: 4 }],
        ]),
        locPack: new Map([[101, 'portal_a'], [102, 'portal_b'], [103, 'irrelevant_tree']]),
        locs: [
            { id: 103, x: 3200, z: 3200, level: 0, shape: 10, angle: 0, src: 'maps/m50_50.jm2:1' },
            { id: 101, x: 3201, z: 3201, level: 0, shape: 10, angle: 0, src: 'maps/m50_50.jm2:2' },
            { id: 102, x: 3210, z: 3210, level: 0, shape: 10, angle: 0, src: 'maps/m50_50.jm2:3' },
        ],
        questVarps: new Set(),
        excludeLocNames: new Set(),
        dbTables: [],
    });
    expect(out.edges).toHaveLength(2);
    const a = out.edges.find(e => e.locName === 'portal_a')!;
    expect(a.to).toEqual({ x: 3210, z: 3210, level: 0 });
    expect(a.conditions).toBeUndefined();
    expect(a.twoWay).toBe(true);
    expect(out.edges.find(e => e.locName === 'portal_b')!.twoWay).toBe(true);
});

test('knowledge prefilters and method-model facade indexes preserve exact results', () => {
    expect(parseDrops('[proc,noop]\nreturn;', 'noop.rs2')).toEqual([]);
    expect(parseDropProcs('[oploc1,foo]\nmes("hi");', 'foo.rs2').size).toBe(0);
    expect(parseStaffItems([{ text: '[oploc1,foo]\nmes("no staff check");' }]).size).toBe(0);

    const c = loadContent();
    const smithBlock = block(c, 'scripts/skill_smithing/scripts/smithing/smithing.rs2', 'smithing_anvil');
    expect(smithBlock).not.toBeNull();
    expect(smithBlock!.to).toBeGreaterThan(smithBlock!.from);
    const smeltFacts = modelRung(c, {
        id: 'smithing/smelt-bronze',
        skill: 'smithing',
        kind: 'smelt',
        level: 1,
        label: 'Bronze',
        row: null,
        outputs: ['bronze_bar'],
        inputs: [],
    });
    expect(smeltFacts.xpPerAction).toBe(6.2);
});
