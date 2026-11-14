import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createBot } from './bots';
import { rsSdkRoot } from './paths';
import { startLite, stopLite } from './lite';
import { applyPreset, PRESETS } from './presets';
import { snapshotPracticeSave, verifyInitialOutcome, verifyOutcome, type OutcomeEvidence, type PracticeOutcome, type SaveSnapshot } from './prove-outcome';

export interface ProveReport {
    runs: number;
    passes: number;
    results: { ok: boolean; seconds: number; tail: string; logOk?: boolean; outcome?: OutcomeEvidence }[];
}

export interface ProveOptions {
    bot: string;
    script: string;
    runs: number;
    preset?: string;
    pass: (stdout: string) => boolean;
    timeoutMs?: number;
}

export interface ProveDeps {
    prepare(bot: string, preset?: string): Promise<void>;
    checkStart(bot: string, preset?: string): Promise<{ ok: boolean; detail: string }>;
    run(script: string, bot: string, timeoutMs: number): Promise<{ stdout: string; exitCode: number }>;
    cleanup(bot: string): Promise<void>;
}

export function wcPass(stdout: string): boolean {
    const m = stdout.match(/wcXpGained=(\d+)/);
    return m !== null && Number(m[1]) > 0;
}

// rs-sdk usernames are at most 12 alphanumeric chars. A name that played before can keep its old save over a
// fresh preset (seen: florr1 started where the previous run ended; a spar batch whose accounts started where an
// earlier batch's runners rubbed their glories), so every name gets 4 random base-36 characters (1,679,616 tokens).
// A token from the clock and a counter repeats every 46.7 s when each process starts its counter at 0.
export function runBotName(base: string, i: number): string {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => (b % 36).toString(36)).join('');
    const suffix = `${token}${i}`;
    return base.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12 - suffix.length - 1) + 'x' + suffix;
}

async function runBun(args: string[], timeoutMs: number, cwd: string = rsSdkRoot()): Promise<{ stdout: string; exitCode: number }> {
    const proc = Bun.spawn(['bun', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' ,windowsHide:true});
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    return { stdout: out + err, exitCode };
}

// In-process (openBot) workers resolve content/bots via repo-root-absolute paths or repo-root-relative
// literals (knowledge/, vendor/, .practice/). Their cwd must be the repo root, not vendor/rs-sdk
// (which only lite runner.ts needs for join(cwd, 'bots', ...)).
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');

// Each run logs in a fresh account. A dropped session stays in the engine for TIMEOUT_NO_CONNECTION
// (500 ticks), and a relogin then attaches to the in-memory player and ignores the save file
// (World.ts processLogins). A name that never logged in has no session, so its preset save is what loads.
export const realDeps: ProveDeps = {
    async prepare(bot, preset) {
        await createBot(bot);
        if (preset) {
            const p = PRESETS[preset];
            if (!p) throw new Error(`unknown preset ${preset}`);
            await applyPreset(bot, p);
        }
        await startLite(bot);
    },
    async checkStart(bot, preset) {
        const p = preset ? PRESETS[preset]?.position : undefined;
        const r = await runBun([resolve(import.meta.dir, '..', '..', '..', 'scripts', 'where.ts'), bot], 60_000);
        const m = r.stdout.match(/POS (\d+) (\d+) (\d+)/);
        if (!m) return { ok: false, detail: `no position: ${r.stdout.slice(-300)}` };
        const pos = `POS ${m[1]} ${m[2]} ${m[3]}`;
        if (!p) return { ok: true, detail: pos };
        const ok = Number(m[1]) === p.x && Number(m[2]) === p.z && Number(m[3]) === (p.level ?? 0);
        return { ok, detail: `${pos}, preset ${p.x} ${p.z} ${p.level ?? 0}` };
    },
    run: (script, bot, timeoutMs) => runBun([resolve(script), bot], timeoutMs),
    async cleanup(bot) {
        await stopLite(bot);
        rmSync(join(rsSdkRoot(), 'bots', bot), { recursive: true, force: true });
    },
};

// ---- In-process mode: the script logs in itself (no lite runner, no gateway) ----

export const okPass = (stdout: string) => /^RESULT ok\b/m.test(stdout);

export interface InProcessOptions {
    bot: string;
    script: string;
    runs: number;
    preset?: string;
    companions?: { suffix: string; preset: string }[];
    scriptArgs?: string[]; // passed after the bot name
    pass: (stdout: string) => boolean;
    timeoutMs?: number;
    parallel?: number; // runs at once; default 1. Runs that share a resource (rocks, NPCs) can affect each other.
    outcome?: PracticeOutcome;
}

export interface InProcessDeps {
    prepare(bot: string, preset?: string): Promise<void>;
    run(script: string, bot: string, timeoutMs: number, args?: string[]): Promise<{ stdout: string; exitCode: number }>;
    cleanup(bot: string): Promise<void>;
    snapshot?(bot: string, phase: 'before' | 'after', ready?: (snapshot: SaveSnapshot) => boolean): Promise<SaveSnapshot>;
}

export const realInProcessDeps: InProcessDeps = {
    snapshot: snapshotPracticeSave,
    async prepare(bot, preset) {
        await createBot(bot);
        if (preset) {
            const p = PRESETS[preset];
            if (!p) throw new Error(`unknown preset ${preset}`);
            await applyPreset(bot, p);
        }
    },
    run: (script, bot, timeoutMs, args = []) => runBun([resolve(script), bot, ...args], timeoutMs, REPO_ROOT),
    async cleanup(bot) {
        rmSync(join(rsSdkRoot(), 'bots', bot), { recursive: true, force: true });
    },
};

// The script prints `START x z level` right after login; it must equal the preset position. A pair script
// (quest-arrav.ts) prints one START per account, the companion's first, so any START line may match.
function startMatches(stdout: string, preset?: string): { ok: boolean; detail: string } {
    const all = [...stdout.matchAll(/^START (\d+) (\d+) (\d+)/gm)];
    if (!all.length) return { ok: false, detail: 'no START line' };
    const p = preset ? PRESETS[preset]?.position : undefined;
    if (!p) return { ok: true, detail: all[0]![0] };
    const m = all.find(m => Number(m[1]) === p.x && Number(m[2]) === p.z && Number(m[3]) === (p.level ?? 0));
    return { ok: !!m, detail: `${(m ?? all[0]!)[0]}, preset ${p.x} ${p.z} ${p.level ?? 0}` };
}

export async function proveInProcess(opts: InProcessOptions, deps: InProcessDeps = realInProcessDeps): Promise<ProveReport> {
    const results: ProveReport['results'] = new Array(opts.runs);
    const one = async (i: number) => {
        const bot = runBotName(opts.bot, i);
        const names = [bot, ...(opts.companions ?? []).map(c => bot + c.suffix)];
        const t0 = Date.now();
        try {
            await deps.prepare(bot, opts.preset);
            // Each companion is its own account and save file, so they are prepared at the same time.
            await Promise.all((opts.companions ?? []).map(c => deps.prepare(bot + c.suffix, c.preset)));
            let before: SaveSnapshot | undefined, outcome: OutcomeEvidence | undefined;
            if (opts.outcome) {
                try {
                    if (!deps.snapshot) throw new Error('independent save backend unavailable');
                    before = await deps.snapshot(bot, 'before');
                    outcome = verifyInitialOutcome(opts.outcome, bot, before);
                } catch (error) { outcome = { ok: false, detail: String(error) }; }
                if (!outcome.ok) {
                    results[i - 1] = { ok: false, logOk: false, outcome, seconds: (Date.now() - t0) / 1000, tail: `OUTCOME fail ${outcome.detail}` };
                    return;
                }
            }
            const { stdout, exitCode } = await deps.run(opts.script, bot, opts.timeoutMs ?? 300_000, opts.scriptArgs);
            const start = startMatches(stdout, opts.preset);
            const logOk = exitCode === 0 && start.ok && opts.pass(stdout);
            if (opts.outcome && before && deps.snapshot) {
                try {
                    const after = await deps.snapshot(bot, 'after', snapshot => verifyOutcome(opts.outcome!, bot, before!, snapshot).ok);
                    outcome = verifyOutcome(opts.outcome, bot, before, after);
                } catch (error) { outcome = { ok: false, detail: String(error), before: { bot: before.bot, sourcePath: before.sourcePath, path: before.path, sha256: before.sha256 } }; }
            }
            const ok = logOk && (!opts.outcome || outcome?.ok === true);
            const tail = stdout.split(/\r?\n/).filter(l => /^(START|RESULT|ERR|WARN|MILESTONE|RATE|LEDGER)/.test(l) || l.includes('Error')).slice(-16).join('\n');
            results[i - 1] = { ok, logOk, outcome, seconds: (Date.now() - t0) / 1000, tail: (start.ok ? tail : `preset not loaded: ${start.detail}\n${tail}`) + (outcome ? `\nOUTCOME ${outcome.ok ? 'ok' : 'fail'} ${outcome.detail}` : '') };
        } finally {
            await Promise.all(names.map(n => deps.cleanup(n)));
        }
    };
    // Each run is its own account and process, so runs can share the server. `parallel` of them run at once.
    let next = 1;
    const worker = async () => { while (next <= opts.runs) await one(next++); };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.parallel ?? 1, opts.runs)) }, worker));
    return { runs: opts.runs, passes: results.filter(r => r.ok).length, results };
}

export async function prove(opts: ProveOptions, deps: ProveDeps = realDeps): Promise<ProveReport> {
    const results: ProveReport['results'] = [];
    for (let i = 1; i <= opts.runs; i++) {
        const bot = runBotName(opts.bot, i);
        const t0 = Date.now();
        try {
            await deps.prepare(bot, opts.preset);
            const start = await deps.checkStart(bot, opts.preset);
            if (!start.ok) {
                results.push({ ok: false, seconds: (Date.now() - t0) / 1000, tail: `preset not loaded: ${start.detail}` });
                continue;
            }
            const { stdout, exitCode } = await deps.run(opts.script, bot, opts.timeoutMs ?? 300_000);
            const ok = exitCode === 0 && opts.pass(stdout);
            results.push({ ok, seconds: (Date.now() - t0) / 1000, tail: `${start.detail}\n${stdout.split(/\r?\n/).slice(-8).join('\n')}` });
        } finally {
            await deps.cleanup(bot);
        }
    }
    return { runs: opts.runs, passes: results.filter(r => r.ok).length, results };
}
