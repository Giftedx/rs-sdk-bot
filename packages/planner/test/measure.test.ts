import { test, expect } from 'bun:test';
import { xpPerHour, parseRate, summarize } from '../src/measure';

test('XP per hour of scored playtime from XP gained over game ticks', () => {
    // 12,000 ticks of 300 ms is exactly one hour.
    expect(xpPerHour(5000, 12_000, 300)).toBe(5000);
    expect(xpPerHour(100, 600, 300)).toBe(2000);
});

test('parseRate reads the RATE line a measure script prints', () => {
    expect(parseRate('START 1 2 0\nRATE woodcutting 4375 600\nRESULT ok')).toEqual({ skill: 'woodcutting', xp: 4375, ticks: 600 });
    expect(parseRate('RESULT ok')).toBeNull();
});

test('summarize uses the median of the runs and keeps the spread', () => {
    const s = summarize('trees', 'woodcutting', [{ xp: 100, ticks: 600 }, { xp: 300, ticks: 600 }, { xp: 200, ticks: 600 }], 300);
    expect(s).toMatchObject({ method: 'trees', skill: 'woodcutting', runs: 3, xpPerHour: 4000, min: 2000, max: 6000, source: 'measured' });
});
