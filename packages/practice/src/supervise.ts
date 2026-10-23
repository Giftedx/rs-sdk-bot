// Keeps a live bot run going: restarts it when it ends without "RESULT ok", stops for good on a stop file, a death
// or too many failures in a row. Live runs were lost on 2026-10-23 to tick caps, a stop-and-restart by hand, and
// Claude Code ending background jobs. Each restart logs in again, so it costs a few playtime ticks.
// CLI: bun packages/practice/src/supervise.ts <bot> <script> [maxRestarts=20]  (env passes through: DEMO_OK, TARGET...)

export interface SuperviseDeps {
    run(): Promise<{ stdout: string; exitCode: number }>;
    stopped(): boolean;
    pause(ms: number): Promise<void>;
    maxRestarts: number;
    log?(line: string): void;
}

export async function supervise(d: SuperviseDeps): Promise<{ reason: 'done' | 'stopped' | 'died' | 'gave-up'; runs: number }> {
    let fails = 0;
    for (let runs = 1; ; runs++) {
        const r = await d.run();
        const result = r.stdout.split(/\r?\n/).filter(l => l.startsWith('RESULT')).pop() ?? '(no RESULT)';
        d.log?.(`SUPERVISE run ${runs} exit ${r.exitCode}: ${result.slice(0, 200)}`);
        if (/^RESULT ok/.test(result)) return { reason: 'done', runs };
        if (d.stopped() || /stop file/.test(result)) return { reason: 'stopped', runs };
        // A death means the route or the food plan failed; a blind restart repeats it.
        if (/died=true|RESULT fail died/.test(result)) return { reason: 'died', runs };
        // Out of food: a restart only logs in again and finds the same empty bank. A resupply job must run first.
        if (/RESULT fail no food/.test(result)) return { reason: 'stopped', runs };
        if (++fails > d.maxRestarts) return { reason: 'gave-up', runs };
        await d.pause(10_000);
    }
}

if (import.meta.main) {
    const { existsSync } = await import('node:fs');
    const [bot, script, maxArg] = process.argv.slice(2);
    if (!bot || !script) { console.log('usage: supervise.ts <bot> <script> [maxRestarts=20]'); process.exit(2); }
    const r = await supervise({
        run: async () => {
            const p = Bun.spawn(['bun', script, bot], { stdout: 'pipe', stderr: 'inherit', env: process.env });
            let text = '';
            const reader = p.stdout.getReader();
            for (;;) { const { done, value } = await reader.read(); if (done) break; const c = new TextDecoder().decode(value); text += c; process.stdout.write(c); }
            return { stdout: text, exitCode: await p.exited };
        },
        stopped: () => existsSync(`.practice/stop-${bot}`),
        pause: ms => Bun.sleep(ms),
        maxRestarts: Number(maxArg ?? 20),
        log: l => console.log(l),
    });
    console.log(`SUPERVISE end ${r.reason} after ${r.runs} runs`);
    process.exit(r.reason === 'done' ? 0 : 1);
}
