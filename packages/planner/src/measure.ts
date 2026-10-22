// Measured XP rates for the planner. A measure script runs one method for a fixed number of game ticks
// and prints `RATE <skill> <xpGained> <ticks>`. Rates are per hour of the account's own playtime, which is
// what the time-ranked hiscore boards count (one tick = NODE_TICKRATE ms; demo server 300 ms).

export function xpPerHour(xp: number, ticks: number, tickMs: number): number {
    const hours = (ticks * tickMs) / 3_600_000;
    return hours > 0 ? xp / hours : 0;
}

export function parseRate(stdout: string): { skill: string; xp: number; ticks: number } | null {
    const m = stdout.match(/^RATE (\w+) (\d+(?:\.\d+)?) (\d+)$/m);
    return m ? { skill: m[1]!, xp: Number(m[2]), ticks: Number(m[3]) } : null;
}

export interface MeasuredRate {
    method: string;
    skill: string;
    runs: number;
    xpPerHour: number; // median of the runs
    min: number;
    max: number;
    tickMs: number;
    source: 'measured';
}

export function summarize(method: string, skill: string, samples: { xp: number; ticks: number }[], tickMs: number): MeasuredRate {
    const rates = samples.map(s => xpPerHour(s.xp, s.ticks, tickMs)).sort((a, b) => a - b);
    const mid = Math.floor(rates.length / 2);
    const median = rates.length % 2 === 1 ? rates[mid]! : (rates[mid - 1]! + rates[mid]!) / 2;
    return { method, skill, runs: rates.length, xpPerHour: median, min: rates[0] ?? 0, max: rates[rates.length - 1] ?? 0, tickMs, source: 'measured' };
}
