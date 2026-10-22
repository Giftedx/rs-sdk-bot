import { test, expect } from 'bun:test';
import { okPass, proveInProcess } from '../src/prove';
import { startStack } from '../src/stack';

// Phase 2 done-check: each proven script passes RUNS times in a row, in-process, at 300 ms ticks.
// Run with PRACTICE_IT=1 (RUNS defaults to 10; ONLY=gather,bank limits the set; PARALLEL=5 runs 5 at once).
const RUNS = Number(process.env.RUNS ?? 10);
// shared: the script uses world things other runs also use (trees, monsters). Its runs go one at a time:
// 5 at once measured gather 3/10, bank 8/10, fight 9/10 (2026-10-22). The scripts themselves run side by side.
const ALL: { name: string; bot: string; preset: string; shared?: boolean; companions?: { suffix: string; preset: string }[] }[] = [
    { name: 'gather', bot: 'gath', preset: 'wc_lumbridge', shared: true },
    { name: 'bank', bot: 'bank', preset: 'bank_draynor', shared: true },
    { name: 'floors', bot: 'flor', preset: 'floors_lumbridge' },
    { name: 'fight', bot: 'figt', preset: 'fight_lumbridge', shared: true },
    { name: 'trade', bot: 'trad', preset: 'trade_giver', companions: [{ suffix: 'b', preset: 'trade_receiver' }] },
];
const ONLY = process.env.ONLY?.split(',');
const SET = ALL.filter(s => !ONLY || ONLY.includes(s.name));

test.skipIf(!process.env.PRACTICE_IT)('proven scripts pass every run', async () => {
    const stack = await startStack();
    const summary: string[] = [];
    try {
        const parallel = Number(process.env.PARALLEL ?? 1);
        const reports = await Promise.all(SET.map(s => proveInProcess({ bot: s.bot, script: `scripts/proven/${s.name}.ts`, runs: RUNS, preset: s.preset, companions: s.companions, pass: okPass, parallel: s.shared ? 1 : parallel })));
        for (const [k, s] of SET.entries()) {
            const r = reports[k]!;
            for (const [i, x] of r.results.entries()) summary.push(`${s.name} run ${i + 1} ${x.ok ? 'PASS' : 'FAIL'} ${x.seconds.toFixed(1)}s | ${x.tail.replace(/\n/g, ' | ')}`);
            summary.push(`${s.name}: ${r.passes}/${r.runs}`);
        }
    } finally {
        console.log(summary.join('\n'));
        await stack.stop();
    }
    expect(summary.filter(l => / FAIL /.test(l))).toEqual([]);
}, 7_200_000);
