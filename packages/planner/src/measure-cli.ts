import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { proveInProcess } from '../../practice/src/prove';
import { parseRate, summarize, type MeasuredRate } from './measure';

// Usage: bun packages/planner/src/measure-cli.ts <method> <preset> <runs> <ticks> [tickMs=300]
// Needs a running practice stack. Merges the result into knowledge/rates.json.
const [method, preset, runsArg, ticksArg, tickMsArg] = process.argv.slice(2);
const tickMs = Number(tickMsArg ?? 300);
const samples: { xp: number; ticks: number }[] = [];
let skill = '';
const r = await proveInProcess({
    bot: `m${method!.slice(0, 4)}`,
    script: 'scripts/measure/gather.ts',
    scriptArgs: [method!, ticksArg ?? '600'],
    runs: Number(runsArg ?? 3),
    preset,
    pass: out => {
        const rate = parseRate(out);
        if (rate && rate.xp > 0) { samples.push({ xp: rate.xp, ticks: rate.ticks }); skill = rate.skill; return true; }
        return false;
    },
});
for (const [i, x] of r.results.entries()) console.log(`run ${i + 1} ${x.ok ? 'PASS' : 'FAIL'} ${x.seconds.toFixed(1)}s | ${x.tail.replace(/\n/g, ' | ')}`);
if (samples.length === 0) { console.log('no samples'); process.exit(1); }
const s: MeasuredRate = summarize(method!, skill, samples, tickMs);
const file = join(resolve(import.meta.dir, '..', '..', '..'), 'knowledge', 'rates.json');
const all: MeasuredRate[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
writeFileSync(file, JSON.stringify([...all.filter(x => x.method !== s.method), s], null, 1) + '\n');
console.log(JSON.stringify(s));
