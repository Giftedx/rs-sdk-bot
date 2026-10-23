// Runs scripts/measure/floor-fm-line.ts N times on the LOCAL practice server, one firemaker (plus its helpers) at a
// time, each on fresh accounts with saves built here from the line (no entry in packages/practice/src/presets.ts).
// Usage: RANDOM_EVENTS=0 bun scripts/measure/fm-line-run.ts "<z,sx,ex;...>" <runs>
// Firemaker: Firemaking 1 on the first tile, tinderbox + the first 27 logs. Helper k (<bot>b, c, ...): on the first
// tile of its 28-log chunk with that chunk in the pack.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createBot } from '../../packages/practice/src/bots';
import { applyPreset } from '../../packages/practice/src/presets';
import { rsSdkRoot } from '../../packages/practice/src/paths';
import { runBotName } from '../../packages/practice/src/prove';
import { planOf, PACK, CHUNK } from './floor-fm-line';

const repo = resolve(import.meta.dir, '..', '..');
async function waitForRoom(): Promise<void> {
    const f = join(repo, '.practice', 'monitor.json');
    for (;;) {
        const m = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
        if (!m || (m.practiceBots < 6 && m.freeGB >= 5)) return;
        console.log(`NOTE waiting: practiceBots=${m.practiceBots} freeGB=${m.freeGB.toFixed(1)}`);
        await Bun.sleep(30_000);
    }
}

const [rows, runsArg] = process.argv.slice(2);
const runs = Number(runsArg ?? 3);
const plan = planOf(rows!);
const nHelpers = Math.ceil((plan.length - PACK) / CHUNK);
let passes = 0;
for (let i = 1; i <= runs; i++) {
    await waitForRoom();
    const bot = runBotName('fml', i);
    const names = [bot, ...Array.from({ length: nHelpers }, (_, k) => bot + 'bcdefgh'[k])];
    const t0 = Date.now();
    try {
        await createBot(bot);
        await applyPreset(bot, { position: { x: plan[0]!.x, z: plan[0]!.z, level: 0 }, inventory: [{ id: 590, count: 1 }, ...plan.slice(0, PACK).map(p => ({ id: p.id, count: 1 }))] });
        for (let k = 0; k < nHelpers; k++) {
            const chunk = plan.slice(PACK + k * CHUNK, PACK + (k + 1) * CHUNK);
            await createBot(names[k + 1]!);
            await applyPreset(names[k + 1]!, { position: { x: chunk[0]!.x, z: chunk[0]!.z, level: 0 }, inventory: chunk.map(p => ({ id: p.id, count: 1 })) });
        }
        const proc = Bun.spawn(['bun', join(import.meta.dir, 'floor-fm-line.ts'), bot, rows!, String(nHelpers)], { cwd: repo, stdout: 'pipe', stderr: 'pipe', env: process.env });
        const timer = setTimeout(() => proc.kill(), 900_000);
        const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        const exitCode = await proc.exited;
        clearTimeout(timer);
        const stdout = out + err;
        for (const l of stdout.split(/\r?\n/)) if (/^(START|BAND|FLOOR|LEVELUP|CYCLE|RESULT|WARN|NOTE|LEDGER)/.test(l) || /error/i.test(l)) if (!/PASSWORD/i.test(l)) console.log(`run${i} ${l}`);
        const ok = exitCode === 0 && /^RESULT ok/m.test(stdout);
        if (ok) passes++;
        console.log(`run${i} ${ok ? 'PASS' : 'FAIL'} exit=${exitCode} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } finally {
        for (const n of names) rmSync(join(rsSdkRoot(), 'bots', n), { recursive: true, force: true });
    }
}
console.log(`passed ${passes}/${runs}`);
