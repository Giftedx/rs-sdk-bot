import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAIRN_ROUTE, deliveredCapabilities, priceSteps, type CairnStep } from '../src/cairn-cli';
import { haggisActivities, type Placed } from '../src/haggis';

test('Cairn route sums to the published plan and record', () => {
    expect(CAIRN_ROUTE.steps.length).toBe(25);
    expect(CAIRN_ROUTE.steps.reduce((n, s) => n + s.plan, 0)).toBe(34_143);
    expect(CAIRN_ROUTE.steps.reduce((n, s) => n + s.took, 0)).toBe(35_787);
});

test('every mapped row is a planner activity and maps to one step only', () => {
    const ids = new Set(haggisActivities().map(a => a.id));
    const mapped = CAIRN_ROUTE.steps.flatMap(s => s.ours);
    expect(mapped.filter(id => !ids.has(id))).toEqual([]);
    expect(new Set(mapped).size).toBe(mapped.length);
});

const place = (id: string, ticks: number, end: number, travel?: number): Placed => ({ id, label: id, start: end - ticks, end, landsAt: end, ticks, deadline: Infinity, travel });
const step = (ours: string[], scripts: string[] = []): CairnStep => ({ id: 's', label: 's', skills: '', plan: 100, took: 100, ours, scripts });

test('a step price adds the walk into each row and flags late, unplaced and missing parts', () => {
    const order = [place('a', 50, 60, 10), place('b', 30, 500)];
    const [p] = priceSteps(order, 100, [step(['a', 'b', 'c'], ['package.json', 'scripts/no-such-worker.ts'])], join(import.meta.dir, '..', '..', '..'));
    expect(p!.ours).toBe(90);
    expect(p!.late).toEqual(['b']);
    expect(p!.unplaced).toEqual(['c']);
    expect(p!.missingScripts).toEqual(['scripts/no-such-worker.ts']);
});

test('a step with no placed rows has no price', () => {
    const [p] = priceSteps([], 100, [step([])], '.');
    expect(p!.ours).toBeNull();
});

test('only succeeded builds and qualifies count as a delivered capability', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cairn-'));
    const path = join(dir, 'state.json');
    writeFileSync(path, JSON.stringify({ tasks: [
        { spec: { kind: 'build', capability: 'x' }, status: 'succeeded' },
        { spec: { kind: 'qualify', capability: 'y' }, status: 'failed' },
        { spec: { kind: 'run', capability: 'z' }, status: 'succeeded' },
    ] }));
    expect([...deliveredCapabilities(path)]).toEqual(['x']);
    expect(deliveredCapabilities(join(dir, 'missing.json')).size).toBe(0);
});
