import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createBot } from './bots';
import { rsSdkRoot } from './paths';
import { startLite, stopLite } from './lite';
import { applyPreset, PRESETS } from './presets';

export interface ProveReport {
    runs: number;
    passes: number;
    results: { ok: boolean; seconds: number; tail: string }[];
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
// fresh preset (seen 2026-10-22: florr1 started where the previous run ended), so every name gets a token
// from the clock and a counter and is never reused.
let nameCounter = 0;
export function runBotName(base: string, i: number): string {
    const token = ((Date.now() % 1_679_616) * 36 + (nameCounter++ % 36)).toString(36).slice(-4);
    const suffix = `${token}${i}`;
    return base.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12 - suffix.length - 1) + 'x' + suffix;
}

async function runBun(args: string[], timeoutMs: number): Promise<{ stdout: string; exitCode: number }> {
    const proc = Bun.spawn(['bun', ...args], { cwd: rsSdkRoot(), stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    return { stdout: out + err, exitCode };
}

// Each run logs in a fresh account. A dropped session stays in the engine for TIMEOUT_NO_CONNECTION
// (500 ticks), and a relogin then takes over the in-memory player and discards the save file
// (World.ts:988-1035). A name that never logged in has no session, so its preset save is what loads.
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
}

export interface InProcessDeps {
    prepare(bot: string, preset?: string): Promise<void>;
    run(script: string, bot: string, timeoutMs: number, args?: string[]): Promise<{ stdout: string; exitCode: number }>;
    cleanup(bot: string): Promise<void>;
}

export const realInProcessDeps: InProcessDeps = {
    async prepare(bot, preset) {
        await createBot(bot);
        if (preset) {
            const p = PRESETS[preset];
            if (!p) throw new Error(`unknown preset ${preset}`);
            await applyPreset(bot, p);
        }
    },
    run: (script, bot, timeoutMs, args = []) => runBun([resolve(script), bot, ...args], timeoutMs),
    async cleanup(bot) {
        rmSync(join(rsSdkRoot(), 'bots', bot), { recursive: true, force: true });
    },
};

// The script prints `START x z level` right after login; it must equal the preset position.
function startMatches(stdout: string, preset?: string): { ok: boolean; detail: string } {
    const m = stdout.match(/^START (\d+) (\d+) (\d+)/m);
    if (!m) return { ok: false, detail: 'no START line' };
    const p = preset ? PRESETS[preset]?.position : undefined;
    if (!p) return { ok: true, detail: m[0] };
    const ok = Number(m[1]) === p.x && Number(m[2]) === p.z && Number(m[3]) === (p.level ?? 0);
    return { ok, detail: `${m[0]}, preset ${p.x} ${p.z} ${p.level ?? 0}` };
}

export async function proveInProcess(opts: InProcessOptions, deps: InProcessDeps = realInProcessDeps): Promise<ProveReport> {
    const results: ProveReport['results'] = [];
    for (let i = 1; i <= opts.runs; i++) {
        const bot = runBotName(opts.bot, i);
        const names = [bot, ...(opts.companions ?? []).map(c => bot + c.suffix)];
        const t0 = Date.now();
        try {
            await deps.prepare(bot, opts.preset);
            for (const c of opts.companions ?? []) await deps.prepare(bot + c.suffix, c.preset);
            const { stdout, exitCode } = await deps.run(opts.script, bot, opts.timeoutMs ?? 300_000, opts.scriptArgs);
            const start = startMatches(stdout, opts.preset);
            const ok = exitCode === 0 && start.ok && opts.pass(stdout);
            const tail = stdout.split(/\r?\n/).filter(l => /^(START|RESULT|ERR|WARN)/.test(l) || l.includes('Error')).slice(-8).join('\n');
            results.push({ ok, seconds: (Date.now() - t0) / 1000, tail: start.ok ? tail : `preset not loaded: ${start.detail}\n${tail}` });
        } finally {
            for (const n of names) await deps.cleanup(n);
        }
    }
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
