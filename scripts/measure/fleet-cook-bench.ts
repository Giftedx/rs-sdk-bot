// Matched bank-to-fire route trial. One practice bot at a time; never connects live.
// bun scripts/measure/fleet-cook-bench.ts [runs=3] [near|north|far|both]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createBot } from '../../packages/practice/src/bots';
import { applyPreset } from '../../packages/practice/src/presets';
import { runBotName } from '../../packages/practice/src/prove';
import { startStack } from '../../packages/practice/src/stack';
import { rsSdkRoot } from '../../packages/practice/src/paths';

const repo = resolve(import.meta.dir, '../..');
const runs = Number(process.argv[2] ?? 3), mode = process.argv[3] ?? 'both';
if (!Number.isSafeInteger(runs) || runs < 1 || !['near', 'north', 'far', 'both'].includes(mode)) throw new Error('usage: fleet-cook-bench.ts [positive runs] [near|north|far|both]');
const outDir = join(repo, '.practice', `fleet-cook-${Date.now()}`);
mkdirSync(outDir, { recursive: true });
const stack = await startStack({ tickMs: 150 });
try {
    const results: object[] = [];
    // Interleave matched arms so slow changes in host load do not always favor one arm.
    for (let i = 1; i <= runs; i++) for (const route of mode === 'both' ? ['near', 'far'] : [mode]) {
        const monitor = join(repo, '.practice/monitor.json');
        if (existsSync(monitor)) {
            const m = JSON.parse(readFileSync(monitor, 'utf8'));
            if (m.practiceBots >= 6 || m.freeGB < 5) throw new Error(`practice load: bots=${m.practiceBots} freeGB=${m.freeGB}`);
        }
        const name = runBotName(route === 'far' ? 'willyfar' : 'willycook', i);
        await createBot(name);
        await applyPreset(name, {
            position: { x: 3092, z: 3243, level: 0 }, skills: { Cooking: 99 }, coins: 200,
            inventory: [{ id: 309, count: 1 }, { id: 946, count: 1 }, { id: 1511, count: 1 }, { id: 1511, count: 1 }, { id: 314, count: 100 }, { id: 2140, count: 1 }, { id: 2140, count: 1 }],
            bank: [{ id: 335, count: 80 }, { id: 331, count: 80 }, { id: 2140, count: 133 }],
        });
        const started = Date.now();
        const proc = Bun.spawn(['bun', join(repo, 'scripts/cook-stock.ts'), name, '1500'], {
            cwd: rsSdkRoot(), env: { ...process.env, DEMO_OK: '0', COOK_ROUTE: route, MAX_COOK: '60', RAW_RESERVE: '50', RANDOM_EVENTS: '0' }, stdout: 'pipe', stderr: 'pipe',
        windowsHide:true});
        const timeout = setTimeout(() => proc.kill(), 300_000);
        let text: string, exit: number;
        try {
            const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
            exit = await proc.exited;
            text = (out + err).replace(/^.*PASSWORD.*$/gm, '[redacted]');
        } finally { clearTimeout(timeout); }
        const file = join(outDir, `${route}-${i}-${name}.log`);
        writeFileSync(file, text);
        const result = text.split(/\r?\n/).find(l => /^RESULT /.test(l)) ?? 'RESULT missing';
        const row = { route, run: i, name, exit, elapsedMs: Date.now() - started, result, file };
        results.push(row);
        writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
        console.log(`COOK_TRIAL ${JSON.stringify(row)}`);
        // Keep account saves and failed logs for inspection; all names are unique local accounts.
        if (exit !== 0 || !/^RESULT ok\b/.test(result)) throw new Error(`failed trial retained at ${file}`);
    }
} finally { await stack.stop(); }
