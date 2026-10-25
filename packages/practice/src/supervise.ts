// Keeps a live bot run going: restarts it when it ends without "RESULT ok", stops for good on a stop file, a death
// no progress or too many failures in a row. Live runs were lost on 2026-10-23 to tick caps, a stop-and-restart by hand, and
// Claude Code ending background jobs. Each restart logs in again, so it costs a few playtime ticks.
// CLI: bun packages/practice/src/supervise.ts <bot> <script> [maxRestarts=20]  (env passes through: DEMO_OK, TARGET...)

export interface SuperviseDeps {
    run(): Promise<{ stdout: string; exitCode: number }>;
    stopped(): boolean;
    pause(ms: number): Promise<void>;
    maxRestarts: number;
    log?(line: string): void;
}

// Match failure text, not metrics such as stallTicks=0 or a successful run mentioning progress.
// Worker guards emit "no ore/wood progress", "made no progress", or "stalled".
export function isNoProgressFailure(result: string): boolean {
    return /^RESULT fail\b/.test(result)
        && /\b(?:no(?:[ -]+[a-z]+){0,3}[ -]+progress|stalled|stall(?:[ :]|$)|no woolly sheep within 120 ticks\b)/i.test(result);
}

// These exact worker guards require staging, gear or a config change. Retrying
// the same command logs in again without repairing any of those prerequisites.
export function isPrerequisiteFailure(result: string): boolean {
    return /^RESULT fail\b/.test(result) && /\b(?:cow prerequisite:|cow kit equip failed (?:1277|1171):|oak PREPARE requires known Draynor bank start\b|cow needs positive CAP and MAX_KILLS1\.\.5\b|oak needs CAP>0 and MAX_MAKE1\.\.25\b|TRAIN_SKILL must be Attack, Strength or Defence\b|TARGET_LEVEL must be1\.\.99\b|missing shears\b|low HP during tool bootstrap\b|worker ended or cap\b)/.test(result);
}

export async function supervise(d: SuperviseDeps): Promise<{ reason: 'done' | 'stopped' | 'died' | 'blocked' | 'gave-up'; runs: number }> {
    let fails = 0;
    for (let runs = 1; ; runs++) {
        if (d.stopped()) return { reason: 'stopped', runs: runs - 1 };
        const r = await d.run();
        const result = r.stdout.split(/\r?\n/).filter(l => l.startsWith('RESULT')).pop() ?? '(no RESULT)';
        d.log?.(`SUPERVISE run ${runs} exit ${r.exitCode}: ${result.slice(0, 200)}`);
        if (r.exitCode === 0 && /^RESULT ok\b/.test(result)) return { reason: 'done', runs };
        if (d.stopped() || /stop file/.test(result)) return { reason: 'stopped', runs };
        // A death means the route or the food plan failed; a blind restart repeats it.
        if (/died=true|RESULT fail died/.test(result)) return { reason: 'died', runs };
        // Out of food: a restart only logs in again and finds the same empty bank. A resupply job must run first.
        if (/RESULT fail no food/.test(result)) return { reason: 'stopped', runs };
        if (isNoProgressFailure(result) || isPrerequisiteFailure(result)) return { reason: 'blocked', runs };
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
