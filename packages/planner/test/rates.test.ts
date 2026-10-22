import { test, expect } from 'bun:test';
import { loadRates, toMethods } from '../src/rates';

test('rates.json holds only measured entries, each with a source and a sample count', () => {
    const r = loadRates();
    expect(r.length).toBeGreaterThan(0);
    for (const x of r) {
        expect(x.source).toBe('measured');
        expect(x.evidence.length).toBeGreaterThan(5);
        expect(x.runs).toBeGreaterThan(0);
        expect(x.xpPerTick).toBeGreaterThan(0);
    }
});

test('toMethods turns per-tick rates into planner methods (XP per hour of 300 ms ticks)', () => {
    const m = toMethods([{ method: 'pickpocket_man', skill: 'thieving', level: 1, xpPerTick: 20, runs: 3, tickMs: 300, source: 'measured', evidence: 'x.log' }]);
    expect(m).toEqual([{ id: 'pickpocket_man', skill: 'thieving', level: 1, xpPerHour: 240_000, source: 'measured' }]);
});
