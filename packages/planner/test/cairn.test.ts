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

test('a step priced with another step has no rows, and names a step that has rows', () => {
    const byId = new Map(CAIRN_ROUTE.steps.map(s => [s.id, s]));
    const joined = CAIRN_ROUTE.steps.filter(s => s.pricedWith);
    expect(joined.map(s => s.id)).toEqual(['air-altar']);
    for (const s of joined) {
        expect(s.ours).toEqual([]);
        expect(byId.get(s.pricedWith!)?.ours.length).toBeGreaterThan(0);
        expect(byId.get(s.pricedWith!)?.pricedWith).toBeUndefined();
    }
});

test('every step has rows of ours or is priced with a step that has them', () => {
    expect(CAIRN_ROUTE.steps.filter(s => !s.ours.length && !s.pricedWith).map(s => s.id)).toEqual([]);
});

test('the plan of a step holds the plan of each step priced with it', () => {
    const steps: CairnStep[] = [{ ...step([]), id: 'early', plan: 40, took: 45, pricedWith: 'late' }, { ...step(['a']), id: 'late', plan: 100, took: 110 }];
    const [early, late] = priceSteps([place('a', 150, 200, 10)], 300, steps, '.');
    expect(early).toMatchObject({ ours: null, plan: 40, took: 45, joined: [] });
    expect(late).toMatchObject({ ours: 160, plan: 140, took: 155, joined: ['early'] });
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
