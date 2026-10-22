import { resolve } from 'node:path';
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
    run(script: string, bot: string, timeoutMs: number): Promise<{ stdout: string; exitCode: number }>;
}

export function wcPass(stdout: string): boolean {
    const m = stdout.match(/wcXpGained=(\d+)/);
    return m !== null && Number(m[1]) > 0;
}

// Each run starts from a clean login: stop the client, write the preset, log in again.
export const realDeps: ProveDeps = {
    async prepare(bot, preset) {
        await stopLite(bot);
        if (preset) {
            const p = PRESETS[preset];
            if (!p) throw new Error(`unknown preset ${preset}`);
            await Bun.sleep(1500); // let the engine finish the logout save before we overwrite it
            await applyPreset(bot, p);
        }
        await startLite(bot);
    },
    async run(script, bot, timeoutMs) {
        const proc = Bun.spawn(['bun', resolve(script), bot], { cwd: rsSdkRoot(), stdout: 'pipe', stderr: 'pipe' });
        const timer = setTimeout(() => proc.kill(), timeoutMs);
        const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        const exitCode = await proc.exited;
        clearTimeout(timer);
        return { stdout: out + err, exitCode };
    },
};

export async function prove(opts: ProveOptions, deps: ProveDeps = realDeps): Promise<ProveReport> {
    const results: ProveReport['results'] = [];
    for (let i = 0; i < opts.runs; i++) {
        const t0 = Date.now();
        await deps.prepare(opts.bot, opts.preset);
        const { stdout, exitCode } = await deps.run(opts.script, opts.bot, opts.timeoutMs ?? 300_000);
        const ok = exitCode === 0 && opts.pass(stdout);
        results.push({ ok, seconds: (Date.now() - t0) / 1000, tail: stdout.split(/\r?\n/).slice(-8).join('\n') });
    }
    return { runs: opts.runs, passes: results.filter(r => r.ok).length, results };
}
