import { test, expect } from 'bun:test';
import { prove, wcPass } from '../src/prove';
import { startStack } from '../src/stack';

// Phase 0 done-check. Needs the built vendor stack and free ports 8888/7780. Run with PRACTICE_IT=1.
test.skipIf(!process.env.PRACTICE_IT)('wc-loop proves 10/10 on a fresh local stack', async () => {
    const stack = await startStack();
    try {
        const r = await prove({ bot: 'practice', script: 'scripts/wc-loop.ts', runs: 10, preset: 'wc_lumbridge', pass: wcPass });
        console.log(r.results.map((x, i) => `run ${i + 1} ${x.ok ? 'PASS' : 'FAIL'} ${x.seconds.toFixed(1)}s | ${x.tail.split('\n').filter(l => l.includes('RESULT') || l.includes('failed')).join(' | ')}`).join('\n'));
        expect(r.passes).toBe(10);
    } finally {

        await stack.stop();
    }
}, 3_600_000);
