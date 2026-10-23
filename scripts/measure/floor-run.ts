// Runs one floor script N times on the LOCAL practice server, one bot at a time, each on a fresh account with a
// preset. Usage: RANDOM_EVENTS=0 bun scripts/measure/floor-run.ts <script> <preset> <runs> [script args...]
// Prints each run's START / BAND / FLOOR / CYCLE / NOTE / WARN / RESULT lines.
// FLOOR_HELPER=<preset> also prepares a helper account <bot>b with that preset (the script logs it in);
// FLOOR_HELPER2=<preset> a second helper <bot>c.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { realInProcessDeps, runBotName } from '../../packages/practice/src/prove';

// Shared-machine rule (watchdog): launch only while .practice/monitor.json shows practiceBots < 6 and freeGB >= 5.
async function waitForRoom(): Promise<void> {
    const f = join(resolve(import.meta.dir, '..', '..'), '.practice', 'monitor.json');
    for (;;) {
        const m = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
        if (!m || (m.practiceBots < 6 && m.freeGB >= 5)) return;
        console.log(`NOTE waiting: practiceBots=${m.practiceBots} freeGB=${m.freeGB.toFixed(1)}`);
        await Bun.sleep(30_000);
    }
}

const [script, preset, runsArg, ...rest] = process.argv.slice(2);
const runs = Number(runsArg ?? 3);
const helper = process.env.FLOOR_HELPER;
const helper2 = process.env.FLOOR_HELPER2;
let passes = 0;
for (let i = 1; i <= runs; i++) {
    await waitForRoom();
    const bot = runBotName('floor', i);
    const t0 = Date.now();
    try {
        await realInProcessDeps.prepare(bot, preset);
        if (helper) await realInProcessDeps.prepare(bot + 'b', helper);
        if (helper2) await realInProcessDeps.prepare(bot + 'c', helper2);
        const { stdout, exitCode } = await realInProcessDeps.run(script!, bot, 900_000, rest);
        for (const l of stdout.split(/\r?\n/)) if (/^(START|BAND|FLOOR|LEVELUP|CYCLE|RESULT|WARN|NOTE|LEDGER)/.test(l) || /error/i.test(l)) console.log(`run${i} ${l}`);
        const ok = exitCode === 0 && /^RESULT ok/m.test(stdout);
        if (ok) passes++;
        console.log(`run${i} ${ok ? 'PASS' : 'FAIL'} exit=${exitCode} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } finally {
        await realInProcessDeps.cleanup(bot);
        if (helper) await realInProcessDeps.cleanup(bot + 'b');
        if (helper2) await realInProcessDeps.cleanup(bot + 'c');
    }
}
console.log(`passed ${passes}/${runs}`);
