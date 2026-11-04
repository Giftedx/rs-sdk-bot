import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildLadders, loadData, SKILLS } from '../src/ladders';
import { knowledgeDir } from '../src/paths';

const data = loadData();
const out = buildLadders(data);
const all = Object.values(out.ladders).flat();

test('every one of the 19 skills has a non-empty ladder', () => {
    expect(SKILLS.length).toBe(19);
    for (const s of SKILLS) expect(out.ladders[s]?.length ?? 0).toBeGreaterThan(0);
});

test('methods are sorted by unlock level and ids are unique', () => {
    for (const s of SKILLS) {
        const levels = out.ladders[s].map(m => m.level);
        expect(levels).toEqual([...levels].sort((a, b) => a - b));
    }
    expect(new Set(all.map(m => m.id)).size).toBe(all.length);
});

test('every method names a knowledge source and a content line', () => {
    for (const m of all) {
        expect(m.source).toMatch(/^knowledge\/[a-z]+\.json/);
        expect(m.src).toMatch(/:\d+$/);
    }
});

test('xpPerTick comes only from knowledge/rates.json', () => {
    const rated = all.filter(m => m.xpPerTick !== null);
    expect(rated.length).toBeGreaterThan(0);
    for (const m of rated) {
        const r = data.rates.find(x => x.method === m.rateMethod);
        expect(r?.xpPerTick).toBe(m.xpPerTick!);
        expect(r?.skill).toBe(m.skill);
    }
    for (const m of all.filter(x => x.xpPerTick === null)) expect(m.rateMethod).toBeNull();
});

test('a worker is a scripts/*.ts file or a capability with an existing entry', () => {
    const caps = new Map(data.capabilities.map(c => [c.id, c]));
    for (const m of all.filter(x => x.worker)) {
        const entry = m.worker!.startsWith('scripts/') ? m.worker! : caps.get(m.worker!)?.entry;
        expect(entry).toBeDefined();
        expect(data.readFile(entry!)).not.toBeNull();
        expect(m.workers).toContain(m.worker!);
    }
});

test('the written ladders.json matches a fresh build', () => {
    const written = JSON.parse(readFileSync(join(knowledgeDir(), 'ladders.json'), 'utf8'));
    expect(written.counts).toEqual(out.counts);
});

test('all eight native smelting rungs name both existing workers', () => {
    const metals = ['bronze', 'iron', 'silver', 'steel', 'gold', 'mithril', 'adamant', 'runite'];
    for (const metal of metals) {
        const rung = all.find(m => m.id === `smithing/smelt-${metal}`);
        expect(rung).toBeDefined();
        expect(rung!.workers).toContain('scripts/smelt-bars.ts');
        expect(rung!.workers).toContain('scripts/smelt-batch.ts');
    }
    // The native guide labels this rung Adamant; the CLI recipe is Adamantite.
    expect(all.some(m => m.id === 'smithing/smelt-adamantite')).toBe(false);
    expect(data.readFile('scripts/smelt-bars.ts')).toContain('adamantite | runite');
});

test('unsupported guide metals do not inherit a smelting worker', () => {
    const changed = {
        ...data,
        dbtables: data.dbtables.map(t => t.table !== 'skill_guides' ? t : {
            ...t, rows: t.rows.map(r => r.name !== 'skill_guide_smithing_smelting' ? r : {
                ...r, data: { ...r.data, unlock: r.data.unlock!.map(u => u.map(v => v.replace('Silver', 'Blurite'))) },
            }),
        }),
    };
    const unsupported = Object.values(buildLadders(changed).ladders).flat()
        .find(m => m.id === 'smithing/smelt-blurite');
    expect(unsupported).toBeDefined();
    expect(unsupported!.workers).toEqual([]);
    expect(unsupported!.worker).toBeNull();
});

test('native CLI recipe names resolve the rung products without accepting the guide alias', async () => {
    const { smeltRecipe } = await import('../../../scripts/smelt-batch');
    for (const metal of ['bronze', 'iron', 'silver', 'steel', 'gold', 'mithril', 'adamant', 'runite']) {
        const rung = all.find(m => m.id === `smithing/smelt-${metal}`)!;
        expect(smeltRecipe(metal === 'adamant' ? 'adamantite' : metal).product).toBe(rung.outputs[0]!.id!);
    }
    expect(() => smeltRecipe('adamant')).toThrow('unsupported smelt recipe: adamant');
    expect(() => smeltRecipe('blurite')).toThrow('unsupported smelt recipe: blurite');
});
