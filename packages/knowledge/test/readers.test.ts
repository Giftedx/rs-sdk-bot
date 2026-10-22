import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanLines } from '../src/text';
import { parsePack } from '../src/pack';
import { parseConfigs, listConfigFiles } from '../src/config';
import { parseJm2 } from '../src/jm2';
import { contentRoot } from '../src/paths';

test('cleanLines strips CR and line comments but keeps line positions', () => {
    const lines = cleanLines('a=1 // c\r\n// whole\r\nb=2');
    expect(lines).toEqual(['a=1', '', 'b=2']);
});

test('parsePack reads id=name lines', () => {
    const m = parsePack('0=hans\n1=man\r\n');
    expect(m.get(0)).toBe('hans');
    expect(m.get(1)).toBe('man');
});

test('parseConfigs reads blocks with repeated keys and source lines', () => {
    const b = parseConfigs('[knife]\nname=Knife\ncost=6\n\n[shop]\nstock1=a,1,5\nstock2=b,2,6\n', 'f.obj');
    expect(b[0]).toMatchObject({ name: 'knife', file: 'f.obj', line: 1 });
    expect(b[0]!.props.cost).toEqual(['6']);
    expect(b[1]!.props.stock1).toEqual(['a,1,5']);
    expect(b[1]!.line).toBe(5);
});

test('parseJm2 converts local coords to world coords', () => {
    const r = parseJm2('m35_74.jm2', '==== NPC ====\n0 30 23: 1070\n');
    expect(r.npcs).toEqual([{ id: 1070, x: 2270, z: 4759, level: 0, src: 'maps/m35_74.jm2:2' }]);
});

test('parseJm2 reads loc shape and angle, and obj counts', () => {
    const r = parseJm2('m50_50.jm2', '==== LOC ====\n0 14 6: 3738 10 3\n==== OBJ ====\n1 2 3: 995 50\n');
    expect(r.locs[0]).toMatchObject({ id: 3738, x: 3214, z: 3206, level: 0, shape: 10, angle: 3 });
    expect(r.objs[0]).toMatchObject({ id: 995, x: 3202, z: 3203, level: 1, count: 50 });
});

test('parseJm2 on empty text returns empty arrays', () => {
    expect(parseJm2('m1_1.jm2', '')).toEqual({ npcs: [], locs: [], objs: [] });
});

test('every non-cert item name in obj.pack has a config block', () => {
    const pack = parsePack(readFileSync(join(contentRoot(), 'pack', 'obj.pack'), 'utf8'));
    const names = new Set<string>();
    for (const f of listConfigFiles('.obj')) {
        for (const b of parseConfigs(readFileSync(join(contentRoot(), f), 'utf8'), f)) names.add(b.name);
    }
    const missing = [...pack.values()].filter(n => !n.startsWith('cert_') && !names.has(n));
    expect(missing).toEqual([]);
    expect(names.size).toBeGreaterThan(2000);
});
