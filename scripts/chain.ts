// Several bot scripts in a row on one account, as one swarm job: fish then cook, gather then fletch. Each step is
// its own child process (packages/core/src/run-child.ts) with its own login and logout, so every step keeps its
// own checks. ROUNDS repeats the list (0: until a stop file or a round with no ok step).
// Usage: bun scripts/chain.ts <account> "<script> [arg ...] [KEY=value ...]" ["<step>" ...]
//   e.g. bun scripts/chain.ts Masterbaiter "scripts/gather-fish.ts cage 3000" "scripts/cook-food.ts 2000 lobster"
// The account goes in as each script's first argument. KEY=value tokens set that step's environment.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runChild } from '../packages/core/src/run-child';

export type Step = { script: string; args: string[]; env: Record<string, string> };
export function parseStep(text: string): Step {
    const [script, ...rest] = text.trim().split(/\s+/);
    if (!script || !/^scripts\/[\w./-]+\.ts$/.test(script)) throw Error(`chain step needs a scripts/*.ts path: ${text}`);
    const env: Record<string, string> = {}, args: string[] = [];
    for (const t of rest) { const m = t.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if (m) env[m[1]!] = m[2]!; else args.push(t); }
    return { script, args, env };
}

if (import.meta.main) {
    const [account, ...texts] = process.argv.slice(2);
    if (!account || !texts.length) { console.log('RESULT fail usage: chain.ts <account> "<script> [args] [KEY=value]" ...'); process.exit(2); }
    const steps = texts.map(parseStep), rounds = Number(process.env.ROUNDS ?? 1), root = resolve(import.meta.dir, '..');
    const stopped = () => existsSync(join(root, '.practice', `stop-${account}`));
    let ok = 0, failed = 0, round = 0;
    while ((rounds === 0 || round < rounds) && !stopped()) {
        round++;
        let roundOk = 0;
        for (const st of steps) {
            if (stopped()) break;
            const result = await runChild([st.script, account, ...st.args], { ...process.env, ...st.env });
            const good = result.startsWith('RESULT ok');
            good ? (ok++, roundOk++) : failed++;
            console.log(`CHAIN round=${round} ${st.script} ${good ? 'ok' : 'fail'} ${result.slice(0, 200)}`);
        }
        if (!roundOk) break;
    }
    console.log(`RESULT ${ok ? 'ok' : 'fail'} chain rounds=${round} ok=${ok} failed=${failed}${stopped() ? ' stop file' : ''}`);
    process.exit(ok ? 0 : 1);
}
