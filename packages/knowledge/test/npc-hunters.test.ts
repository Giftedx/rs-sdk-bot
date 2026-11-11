import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildNpcHunters, npcHunters } from '../src/npc-hunters';
import { parsePack } from '../src/pack';
import { contentRoot } from '../src/paths';

const ids = new Map([...parsePack(readFileSync(join(contentRoot(), 'pack/npc.pack'), 'utf8'))].map(([id, name]) => [name, id] as const));
const of = (name: string) => npcHunters().get(ids.get(name)!);

test('an NPC with a too-strong rule: lesser demon and hill giant', () => {
    expect(of('giant')).toEqual({ range: 2, wander: 3, level: 28, tooStrong: true });
    expect(of('lesser_demon')).toMatchObject({ range: 2, level: 82, tooStrong: true });
});

test('an NPC with check_nottoostrong=off attacks each combat level', () => {
    expect(of('nezikchened')).toMatchObject({ range: 5, tooStrong: false });
});

test('an NPC with no hunt mode is not in the table', () => {
    expect(of('cow')).toBeUndefined();
    expect(of('man')).toBeUndefined();
});

test('each row has a hunt range above 0 and finite numbers', () => {
    const table = npcHunters();
    expect(table.size).toBeGreaterThan(200);
    for (const h of table.values()) {
        expect(h.range).toBeGreaterThan(0);
        expect(Number.isFinite(h.level) && Number.isFinite(h.wander)).toBe(true);
    }
});

test('the kept table is the built table', () => {
    expect([...npcHunters()]).toEqual([...buildNpcHunters()]);
});
