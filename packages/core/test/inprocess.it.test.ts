import { test, expect } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createBot } from '../../practice/src/bots';
import { applyPreset, PRESETS } from '../../practice/src/presets';
import { rsSdkRoot } from '../../practice/src/paths';
import { startStack } from '../../practice/src/stack';
import { connectInProcess } from '../src/inprocess';

// Live: needs the built vendor stack and free ports. Run with PRACTICE_IT=1.
test.skipIf(!process.env.PRACTICE_IT)('in-process session chops a tree with no gateway', async () => {
    const stack = await startStack();
    const name = `core${Date.now() % 100000}`;
    try {
        const { envPath } = await createBot(name);
        await applyPreset(name, PRESETS.wc_lumbridge!);
        const password = readFileSync(envPath, 'utf8').match(/^PASSWORD=(.*)$/m)![1]!.trim();
        const s = await connectInProcess({ name, password });
        await s.sdk.waitForCondition(st => st.inGame && st.skills.length > 0, 30_000);
        const p = s.sdk.getState()!.player!;
        console.log(`START ${p.worldX} ${p.worldZ} ${p.level}`);
        expect([p.worldX, p.worldZ]).toEqual([3224, 3245]);

        // Round-trip of one cheap action, in ticks and ms.
        const t0 = Date.now(); const k0 = s.tick();
        await s.bot.walkTo(p.worldX + 1, p.worldZ, 0);
        console.log(`walk 1 tile: ${s.tick() - k0} ticks, ${Date.now() - t0} ms`);

        const t1 = Date.now(); const k1 = s.tick();
        const r = await s.bot.chopTree(/^tree$/i);
        console.log(`chopTree: ${r.success} ${r.message} | ${s.tick() - k1} ticks, ${Date.now() - t1} ms`);
        expect(r.success).toBe(true);
        await s.close();
    } finally {
        await stack.stop();
        rmSync(join(rsSdkRoot(), 'bots', name), { recursive: true, force: true });
    }
}, 300_000);
