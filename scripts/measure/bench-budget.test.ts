import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UNKNOWN_CASE_MS, budgetRefusal, estimateRun, parseAckStats, parseSimStat, readElapsed, readSince, recordElapsed } from './bench-budget';

test('the estimate puts the longest case first on the engine that is free first', () => {
    const e = estimateRun(['a', 'b', 'c', 'd'], { a: 300_000, b: 200_000, c: 100_000, d: 100_000 }, 2);
    // a | b+c, then d to the lane with b+c (300) or a (300): makespan 400 s.
    expect(e.ms).toBe(400_000);
    expect(estimateRun(['a', 'x'], { a: 10_000 }, 1)).toMatchObject({ ms: 10_000 + UNKNOWN_CASE_MS, unknown: 1 });
    expect(estimateRun([], {}, 6).ms).toBe(0);
});

test('a run over its budget is refused with its heaviest cases; one under it is not', () => {
    const big = estimateRun(['quester:quest:mm', 'small'], { 'quester:quest:mm': 700_000, small: 20_000 }, 6);
    const line = budgetRefusal(big, 10, 6)!;
    expect(line).toContain('BENCH_BUDGET refused');
    expect(line).toContain('quester:quest:mm 700 s');
    expect(line).toContain('--over-budget');
    expect(budgetRefusal(estimateRun(['small'], { small: 20_000 }, 6), 10, 6)).toBeNull();
});

test('the time record keeps the last wall time of each case', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'bench-budget-')), 'elapsed.json');
    expect(readElapsed(file)).toEqual({});
    recordElapsed('b', 1200.4, file); recordElapsed('a', 500, file); recordElapsed('b', 900, file); recordElapsed('z', 0, file);
    expect(readElapsed(file)).toEqual({ a: 500, b: 900 });
});

test('the profile parsers sum the client sessions and split the engine waits', () => {
    const ack = 'x\nACK_STAT {"ticks":400,"held":10,"heldMs":50,"capped":2,"pumpMs":30,"stateMs":20,"scriptMs":40}\nACK_STAT {"ticks":380,"held":0,"heldMs":0,"capped":0,"pumpMs":10,"stateMs":5,"scriptMs":1}\nACK_STAT {cut';
    expect(parseAckStats(ack)).toEqual({ sessions: 2, ticks: 780, held: 10, heldMs: 50, capped: 2, pumpMs: 40, stateMs: 25, scriptMs: 41 });
    const sim = '[sim] tick 25: last 25 ticks waited 666.4 ms each (24 for an ack, 2 for login or logout, 1 with no client)\n'
        + '[sim] tick 50: last 25 ticks waited 4.8 ms each (25 for an ack, 0 for login or logout, 0 with no client)\n'
        + '[sim] tick 75: last 25 ticks waited 5.2 ms each (25 for an ack, 0 for login or logout, 0 with no client)\n';
    expect(parseSimStat(sim)).toEqual({ windows: 3, startupMs: 16660, gameMs: 250, gameMsPerTick: 5 });
    const file = join(mkdtempSync(join(tmpdir(), 'bench-budget-')), 'stat.log');
    writeFileSync(file, 'old\nnew\n');
    expect(readSince(file, 4)).toBe('new\n');
    expect(readSince(join(file, 'missing'), 0)).toBe('');
});
