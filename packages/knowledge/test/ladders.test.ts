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
