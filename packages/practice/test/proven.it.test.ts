import { test, expect } from 'bun:test';
import { okPass, proveInProcess } from '../src/prove';
import { startStack } from '../src/stack';

// Phase 2 done-check: each proven script passes RUNS times in a row, in-process, at 300 ms ticks.
// Run with PRACTICE_IT=1 (RUNS defaults to 10; ONLY=gather,bank limits the set).
const RUNS = Number(process.env.RUNS ?? 10);
const ALL = [
    { name: 'gather', bot: 'gath', preset: 'wc_lumbridge' },
    { name: 'bank', bot: 'bank', preset: 'bank_draynor' },
    { name: 'floors', bot: 'flor', preset: 'floors_lumbridge' },
    { name: 'fight', bot: 'figt', preset: 'fight_lumbridge' },
    { name: 'trade', bot: 'trad', preset: 'trade_giver', companions: [{ suffix: 'b', preset: 'trade_receiver' }] },
];
const ONLY = process.env.ONLY?.split(',');
const SET = ALL.filter(s => !ONLY || ONLY.includes(s.name));

test.skipIf(!process.env.PRACTICE_IT)('proven scripts pass every run', async () => {
    const stack = await startStack();
    const summary: string[] = [];
    try {
        for (const s of SET) {
            const r = await proveInProcess({ bot: s.bot, script: `scripts/proven/${s.name}.ts`, runs: RUNS, preset: s.preset, companions: s.companions, pass: okPass });
            for (const [i, x] of r.results.entries()) summary.push(`${s.name} run ${i + 1} ${x.ok ? 'PASS' : 'FAIL'} ${x.seconds.toFixed(1)}s | ${x.tail.replace(/\n/g, ' | ')}`);
            summary.push(`${s.name}: ${r.passes}/${r.runs}`);
        }
    } finally {
        console.log(summary.join('\n'));
        await stack.stop();
    }
    expect(summary.filter(l => / FAIL /.test(l))).toEqual([]);
}, 7_200_000);
