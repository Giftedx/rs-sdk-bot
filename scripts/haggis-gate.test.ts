import { test, expect } from 'bun:test';
import { overallWins } from './haggis-gate';

const act = (id: string, evidence: string) => ({ id, evidence, source: 'test' }) as any;
const plan = (slack: number, order: { id: string; end: number }[]) => ({
    order,
    boards: [
        { id: 'overall', deadline: 35_000, finish: 35_000 - slack, slack, status: slack > 0 ? 'WIN' : 'LATE' },
        { id: 'agility', deadline: 6_000, finish: 30_000, slack: -24_000, status: 'LATE' },
    ],
}) as any;

test('Overall alone gates the main launch; late skill boards do not', () => {
    expect(overallWins(plan(800, [{ id: 'a', end: 10_000 }]), [act('a', 'MEASURED')])).toContain('Overall wins by 800');
});

test('Overall needs a 2% margin', () => {
    expect(() => overallWins(plan(500, []), [])).toThrow('700-tick margin');
    expect(() => overallWins(plan(-5_000, []), [])).toThrow('margin');
});

test('only activities that end by the Overall finish need MEASURED inputs', () => {
    const order = [{ id: 'a', end: 10_000 }, { id: 'b', end: 20_000 }, { id: 'late', end: 90_000 }];
    const acts = [act('a', 'MEASURED'), act('b', 'ESTIMATE'), act('late', 'CODE-READ')];
    expect(() => overallWins(plan(800, order), acts)).toThrow('1 activities before Overall lack MEASURED inputs: b');
    expect(overallWins(plan(800, order.filter(p => p.id !== 'b')), acts)).toContain('with measured inputs');
});
