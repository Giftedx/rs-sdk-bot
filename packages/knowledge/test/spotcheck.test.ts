import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFacts, spotcheck, type Fact } from '../src/spotcheck';
import { knowledgeDir } from '../src/paths';

const items = JSON.parse(readFileSync(join(knowledgeDir(), 'items.json'), 'utf8'));
const knife = items.find((i: { debugname: string }) => i.debugname === 'knife');

test('a correct item cost passes', () => {
    const fact: Fact = { kind: 'item', record: knife };
    expect(checkFacts([fact]).wrong).toEqual([]);
});

test('a wrong item cost with a real src is reported', () => {
    const fact: Fact = { kind: 'item', record: { ...knife, cost: knife.cost + 12345 } };
    const r = checkFacts([fact]);
    expect(r.wrong.length).toBe(1);
    expect(r.wrong[0]!.src).toBe(knife.def);
});

test('spotcheck samples deterministically for a seed', () => {
    const a = spotcheck(10, 7);
    const b = spotcheck(10, 7);
    expect(a.checked).toBe(10);
    expect(a.sample).toEqual(b.sample);
});

test('a wrong tradeable flag is reported', () => {
    const r = checkFacts([{ kind: 'item', record: { ...knife, tradeable: !knife.tradeable } }]);
    expect(r.wrong.length).toBe(1);
});

test('a wrong item id is reported', () => {
    const r = checkFacts([{ kind: 'item', record: { ...knife, id: knife.id + 1 } }]);
    expect(r.wrong.length).toBe(1);
});

test('a wrong stair destination is reported', () => {
    const edges = JSON.parse(readFileSync(join(knowledgeDir(), 'transports.json'), 'utf8'));
    const e = edges.find((x: { exact: boolean }) => x.exact);
    expect(checkFacts([{ kind: 'transport', record: e }]).wrong).toEqual([]);
    const bad = { ...e, to: { ...e.to, z: e.to.z - 4 } };
    expect(checkFacts([{ kind: 'transport', record: bad }]).wrong.length).toBe(1);
});

test('door facts check the spawn line and the trigger header', () => {
    const doors = JSON.parse(readFileSync(join(knowledgeDir(), 'doors.json'), 'utf8'));
    const d = doors.find((x: { kind: string }) => x.kind === 'skill');
    expect(checkFacts([{ kind: 'door', record: d } as any]).wrong).toEqual([]);
    expect(checkFacts([{ kind: 'door', record: { ...d, x: d.x + 1 } } as any]).wrong.length).toBe(1);
});
