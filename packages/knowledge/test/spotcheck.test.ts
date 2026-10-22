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
    expect(r.wrong[0]!.src).toBe(knife.src);
});

test('spotcheck samples deterministically for a seed', () => {
    const a = spotcheck(10, 7);
    const b = spotcheck(10, 7);
    expect(a.checked).toBe(10);
    expect(a.sample).toEqual(b.sample);
});
