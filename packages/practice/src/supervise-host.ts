// Keeps a bot host run going (packages/core/src/host.ts: N accounts in one process). Same rules as supervise.ts,
// applied per account: an account is done after RESULT ok, stopped after a stop file or "no food", and never run
// again after a death or no-progress block. The host is restarted with only the accounts that failed otherwise, until each account has
// an end or the restarts run out.
// CLI: bun packages/practice/src/supervise-host.ts <script> <maxRestarts> <account...> [--arg v]... [--args a,b]
//      [--env <account> KEY=value]...   (the process env passes through to every account)
// `--arg` and `--args` are the script arguments of every account; `--env` is one variable for one account. Both go
// to host.ts as given, except that a restart passes only the env of the accounts it runs.
// Prints `SUPERVISE-HOST account <name> <reason> after <n> runs` once per account, then `SUPERVISE-HOST end`.

import { isNoProgressFailure, isPrerequisiteFailure, isTransportStall } from './supervise';
import {assertWorkerRelease,isWorkerReleaseHold} from '../../core/src/worker-release';

export type AccountEnd = 'done' | 'stopped' | 'died' | 'blocked' | 'gave-up' | 'release-paused';

// The end an account's last RESULT line means, or null when the account must run again. Same order as supervise.ts.
export function classify(result: string | undefined, stopFile: boolean): AccountEnd | null {
    const r = result ?? '(no RESULT)';
    if (/^RESULT ok/.test(r)) return 'done';
    if (stopFile || /stop file/.test(r)) return 'stopped';
    // A death means the route or the food plan failed; a blind restart repeats it.
    if (/died=true|RESULT fail died/.test(r)) return 'died';
    // Out of food: a restart only logs in again and finds the same empty bank.
    if (/RESULT fail no food/.test(r)) return 'stopped';
    if (isWorkerReleaseHold(r)) return 'release-paused';
    if (!isTransportStall(r) && (isNoProgressFailure(r) || isPrerequisiteFailure(r))) return 'blocked';
    return null;
}

// The last RESULT line of each account in host output (`[name] RESULT ...`).
export function lastResults(stdout: string): Map<string, string> {
    const m = new Map<string, string>();
    for (const l of stdout.split(/\r?\n/)) {
        const x = l.match(/^\[([^\]]+)\] (RESULT .*)$/);
        if (x) m.set(x[1]!, x[2]!);
    }
    return m;
}

export interface SuperviseHostDeps {
    run(accounts: string[]): Promise<{ stdout: string; exitCode: number }>;
    stopped(account: string): boolean;
    pause(ms: number): Promise<void>;
    maxRestarts: number;
    log?(line: string): void;
}

export async function superviseHost(accounts: string[], d: SuperviseHostDeps): Promise<{ ends: Record<string, AccountEnd>; runs: number }> {
    const ends: Record<string, AccountEnd> = {};
    const end = (a: string, why: AccountEnd, runs: number) => { ends[a] = why; d.log?.(`SUPERVISE-HOST account ${a} ${why} after ${runs} runs`); };
    let fails = 0;
    let runs = 0;
    for (;;) {
        // A stop file that appeared while the host was down ends that account before the next start.
        for (const a of accounts) if (!ends[a] && d.stopped(a)) end(a, 'stopped', runs);
        const active = accounts.filter(a => !ends[a]);
        if (active.length === 0) return { ends, runs };
        runs++;
        const r = await d.run(active);
        const results = lastResults(r.stdout);
        let retry = 0;
        for (const a of active) {
            const res = results.get(a);
            d.log?.(`SUPERVISE-HOST run ${runs} exit ${r.exitCode} ${a}: ${(res ?? '(no RESULT)').slice(0, 200)}`);
            const why = classify(res, d.stopped(a));
            if (why) end(a, why, runs); else retry++;
        }
        if (retry === 0) return { ends, runs };
        if (++fails > d.maxRestarts) {
            for (const a of accounts) if (!ends[a]) end(a, 'gave-up', runs);
            return { ends, runs };
        }
        await d.pause(10_000);
    }
}

export interface SuperviseHostArgs { script: string; maxRestarts: number; accounts: string[]; args: string[]; env: Record<string, Record<string, string>> }

export function parseSuperviseHostArgs(argv: readonly string[]): SuperviseHostArgs {
    const positional: string[] = [], args: string[] = [], env: Record<string, Record<string, string>> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === '--args') { args.push(...(argv[++i] ?? '').split(',').filter(Boolean)); continue; }
        if (a === '--arg') { const v = argv[++i]; if (v === undefined) throw Error('--arg requires a value'); args.push(v); continue; }
        if (a === '--env') {
            const name = argv[++i], pair = argv[++i], m = pair?.match(/^([A-Z_][A-Z0-9_]*)=([^]*)$/);
            if (!name || name.startsWith('--') || !m) throw Error('--env requires <account> KEY=value');
            (env[name] ??= {})[m[1]!] = m[2]!;
            continue;
        }
        if (a.startsWith('--')) throw Error(`unknown option ${a}`);
        positional.push(a);
    }
    const [script, maxArg, ...accounts] = positional;
    if (!script || accounts.length === 0) throw Error('usage: supervise-host.ts <script> <maxRestarts> <account...> [--arg v]... [--env <account> KEY=value]...');
    const maxRestarts = Number(maxArg);
    if (!Number.isSafeInteger(maxRestarts) || maxRestarts < 0) throw Error(`maxRestarts must be a whole number: ${maxArg}`);
    for (const name of Object.keys(env)) if (!accounts.includes(name)) throw Error(`--env names ${name}, which is not a hosted account`);
    return { script, maxRestarts, accounts, args, env };
}

// The host options of one run: every script argument, and the env of the accounts in this run only.
export function hostOptions(p: Pick<SuperviseHostArgs, 'args' | 'env'>, active: readonly string[]): string[] {
    return [...p.args.flatMap(a => ['--arg', a]), ...active.flatMap(a => Object.entries(p.env[a] ?? {}).flatMap(([k, v]) => ['--env', a, `${k}=${v}`]))];
}

if (import.meta.main) {
    const { existsSync } = await import('node:fs');
    let parsed: SuperviseHostArgs;
    try { parsed = parseSuperviseHostArgs(process.argv.slice(2)); } catch (e) { console.log(String(e)); process.exit(2); }
    const { script, accounts } = parsed;
    const r = await superviseHost(accounts, {
        run: async active => {
            // A standing owner job has no coordinator acceptance, so it runs the current source without the release pin.
            if(process.env.DEMO_OK==='1'&&process.env.STANDING!=='1')try{assertWorkerRelease();}catch(e){return {stdout:active.map(a=>`[${a}] RESULT fail ${String(e)}`).join('\n'),exitCode:1};}
            const p = Bun.spawn(['bun', 'packages/core/src/host.ts', script, ...active, '--stagger-ms', '2000', ...hostOptions(parsed, active)], { stdout: 'pipe', stderr: 'inherit', env: process.env ,windowsHide:true});
            let text = '';
            const reader = p.stdout.getReader();
            for (;;) { const { done, value } = await reader.read(); if (done) break; const c = new TextDecoder().decode(value); text += c; process.stdout.write(c); }
            return { stdout: text, exitCode: await p.exited };
        },
        stopped: a => existsSync(`.practice/stop-${a}`),
        pause: ms => Bun.sleep(ms),
        maxRestarts: parsed.maxRestarts,
        log: l => console.log(l),
    });
    console.log(`SUPERVISE-HOST end after ${r.runs} runs ${JSON.stringify(r.ends)}`);
    process.exit(Object.values(r.ends).every(e => e === 'done') ? 0 : 1);
}
