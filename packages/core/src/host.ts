// Bot host: runs N bot scripts in ONE bun process, so the bots share one pathfinder (rsmod wasm memory and the
// collision data), one world graph, one webclient config cache and one loc index. A bot in its own process pays
// all of that again (research/bot-host.md).
//
// Usage (local practice server, same as a script run):
//   bun packages/core/src/host.ts <script> <bot1> [bot2 ...] [--stagger-ms N] [--mem-every-s N]
// Each bot runs <script> as if started with `bun <script> <bot>`. Output lines go to stdout as `[bot] line` and,
// without the prefix, to .practice/logs/host-<bot>.log. The host exits when every script has finished, with 0 when
// every script finished ok.
//
// Scripts run unchanged. When the host loads a script it rewrites the source of that one file:
//   process.argv / process.env / process.exit  -> per-bot values (argv[2] is the bot name; env is a copy)
//   console.log / error / warn / info          -> per-bot log
//   the import of packages/core/src/bot        -> a per-bot copy of the module that re-exports bot.ts unchanged,
//                                                  except openBot (per-bot START log) and finish (no process.exit)
// Limits: only the script file itself is rewritten. A helper module that calls finish() or reads process.argv[2]
// for the bot name sees the host values, not the bot's. Scripts that call process.exit() directly stop there (the
// rest of that script does not run), as in a real exit.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { inspect } from 'node:util';
import { openBot, settle } from './bot';
import type { Session } from './inprocess';
import { noteStatusLine } from './status';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const BOT_MODULE = resolve(import.meta.dir, 'bot.ts').replace(/\\/g, '/');
const SCRIPT_Q = 'hostscript';
const BOT_Q = 'hostbot';

export interface HostedBot {
    name: string;
    script: string;
    args?: string[];
    env?: Record<string, string>;
}

export interface HostedResult {
    name: string;
    ok: boolean;
    code: number;
    result: string;
}

class HostExit extends Error {
    constructor(readonly code: number) { super(`host exit ${code}`); }
}

// Rewrites one script's source for the host. Pure, so the unit test checks it without a server.
// scriptDir resolves relative specifiers: one that names botModule (with or without .ts) is redirected.
export function rewriteScript(src: string, id: string, scriptDir: string, botModule: string = BOT_MODULE): string {
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\.ts$/, '').toLowerCase();
    const target = norm(botModule);
    const out = src
        .replace(/(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (m, pre: string, _q: string, spec: string) =>
            norm(resolve(scriptDir, spec)) === target ? `${pre}'${botModule}?${BOT_Q}=${id}'` : m)
        .replace(/\bprocess\.argv\b/g, '__host.argv')
        .replace(/\bprocess\.env\b/g, '__host.env')
        .replace(/\bprocess\.exit\(/g, '__host.exit(')
        .replace(/\bconsole\.(log|error|warn|info)\b/g, '__host.console.$1');
    // Import declarations are hoisted, so this line runs before the script body wherever it stands.
    return `const __host = globalThis.__rsBotHost.get(${JSON.stringify(id)});\n${out}`;
}

// The per-bot copy of bot.ts: everything from the shared module, with openBot and finish bound to one bot.
export function botWrapper(id: string, botModule: string = BOT_MODULE): string {
    return `export * from '${botModule}';
const __host = globalThis.__rsBotHost.get(${JSON.stringify(id)});
export const openBot = (name, opts) => __host.openBot(name, opts);
export const finish = (sessions, ok, detail) => __host.finish(sessions, ok, detail);
`;
}

const fmt = (args: unknown[]) => args.map(a => (typeof a === 'string' ? a : inspect(a, { depth: 4 }))).join(' ');

interface Instance {
    id: string;
    name: string;
    argv: string[];
    env: Record<string, string | undefined>;
    console: Record<'log' | 'error' | 'warn' | 'info', (...a: unknown[]) => void>;
    log(line: string): void;
    exit(code?: number): never;
    openBot(name: string, opts?: { log?: (line: string) => void }): Promise<Session>;
    finish(sessions: Session[], ok: boolean, detail: string): Promise<never>;
    sessions: Session[];
    result: string;
    done: Promise<number>;
}

let installed = false;
const registry = new Map<string, Instance>();

function install(out: (line: string) => void, guard: boolean): void {
    if (installed) return;
    installed = true;
    (globalThis as any).__rsBotHost = registry;
    Bun.plugin({
        name: 'rs-bot-host',
        setup(build) {
            build.onLoad({ filter: new RegExp(`[?&]${SCRIPT_Q}=`) }, args => {
                const [file, query] = args.path.split('?') as [string, string];
                const id = new URLSearchParams(query).get(SCRIPT_Q)!;
                return { contents: rewriteScript(readFileSync(file, 'utf8'), id, dirname(file)), loader: 'ts' };
            });
            build.onLoad({ filter: new RegExp(`[?&]${BOT_Q}=`) }, args => {
                const id = new URLSearchParams(args.path.split('?')[1]).get(BOT_Q)!;
                return { contents: botWrapper(id), loader: 'js' };
            });
        },
    });
    // One bot's stray error must not end the other bots' sessions.
    if (guard) process.on('unhandledRejection', e => { if (!(e instanceof HostExit)) out(`[host] unhandled rejection: ${fmt([e])}`); });
    if (guard) process.on('uncaughtException', e => { if (!(e instanceof HostExit)) out(`[host] uncaught exception: ${fmt([e])}`); });
}

// Every session shares one loc index (read only, about 14 MB each; LocIndex.ts:9-10 says it is meant to be shared),
// instead of one copy per session (session.ts:119 loads it per session).
async function shareLocIndex(): Promise<void> {
    const mod: any = await import(join(repoRoot, 'vendor', 'rs-sdk', 'server', 'webclient', 'src', 'lite', 'world', 'LocIndex.ts'));
    const L = mod.LocIndex;
    if (L.__hostShared) return;
    const orig = L.load.bind(L);
    const memo = new Map<string, Promise<unknown>>();
    L.load = (opts: { cacheDir: string; versionlistCrc: number }) => {
        const k = `${opts.cacheDir}|${opts.versionlistCrc >>> 0}`;
        let p = memo.get(k);
        if (!p) { p = orig(opts); memo.set(k, p); p.catch(() => memo.delete(k)); }
        return p;
    };
    L.__hostShared = true;
}

export function memLine(tag = ''): string {
    const m = process.memoryUsage();
    const mb = (n: number) => Math.round(n / 2 ** 20);
    return `MEM${tag ? ' ' + tag : ''} rss=${mb(m.rss)} heapUsed=${mb(m.heapUsed)} external=${mb(m.external)} arrayBuffers=${mb(m.arrayBuffers)}`;
}

export async function runHost(bots: HostedBot[], opts: { staggerMs?: number; out?: (line: string) => void; logDir?: string; guard?: boolean } = {}): Promise<HostedResult[]> {
    const out = opts.out ?? ((l: string) => process.stdout.write(l + '\n'));
    const logDir = opts.logDir ?? join(repoRoot, '.practice', 'logs');
    mkdirSync(logDir, { recursive: true });
    install(out, opts.guard ?? true);
    await shareLocIndex();
    const names = new Set<string>();
    for (const b of bots) {
        if (names.has(b.name)) throw new Error(`bot ${b.name} listed twice`);
        names.add(b.name);
    }

    const instances: Instance[] = [];
    for (const [i, b] of bots.entries()) {
        const script = resolve(b.script);
        const id = `${b.name}-${Date.now().toString(36)}-${i}`;
        const logFile = join(logDir, `host-${b.name}.log`);
        writeFileSync(logFile, '');
        let resolveDone!: (code: number) => void;
        const done = new Promise<number>(r => { resolveDone = r; });
        let finished = false;
        const never = new Promise<never>(() => {});
        const inst: Instance = {
            id,
            name: b.name,
            argv: [process.argv[0]!, script, b.name, ...(b.args ?? [])],
            env: { ...process.env, ...(b.env ?? {}) },
            console: {
                log: (...a) => inst.log(fmt(a)),
                info: (...a) => inst.log(fmt(a)),
                warn: (...a) => inst.log(fmt(a)),
                error: (...a) => inst.log(fmt(a)),
            },
            log(line) {
                for (const l of line.split(/\r?\n/)) {
                    if (l.startsWith('RESULT ')) inst.result = l;
                    noteStatusLine(b.name, l);
                    try { appendFileSync(logFile, l + '\n'); } catch { /* the log file is optional */ }
                    out(`[${b.name}] ${l}`);
                }
            },
            exit(code = 0) {
                if (!finished) { finished = true; resolveDone(code); }
                throw new HostExit(code);
            },
            async openBot(name, o) {
                const s = await openBot(name, { log: l => inst.log(l), ...o });
                inst.sessions.push(s);
                return s;
            },
            async finish(sessions, ok, detail) {
                if (finished) return never;
                finished = true;
                // Same steps as finish() in bot.ts, without the process exit: RESULT, ledgers, logout, close.
                const final = await settle(sessions, ok, detail, { log: l => inst.log(l) }).catch(e => { inst.log(`WARN settle failed: ${fmt([e])}`); return false; });
                resolveDone(final ? 0 : 1);
                // Like process.exit: nothing after finish() in the script runs.
                return never;
            },
            sessions: [],
            result: '',
            done,
        };
        registry.set(id, inst);
        instances.push(inst);
    }

    for (const [i, inst] of instances.entries()) {
        if (i > 0 && opts.staggerMs) await Bun.sleep(opts.staggerMs);
        const url = `${inst.argv[1]!.replace(/\\/g, '/')}?${SCRIPT_Q}=${encodeURIComponent(inst.id)}`;
        import(url).then(
            // The script body ended without finish() or exit(): like a script process with nothing left to run.
            () => { void inst.finish(inst.sessions, false, 'script ended without finish'); },
            async e => {
                if (e instanceof HostExit) return;
                inst.log(`ERROR script threw: ${fmt([e])}`);
                // A script process that crashes drops its sessions; here they are logged out first.
                await inst.finish(inst.sessions, false, `script threw: ${String(e).slice(0, 200)}`);
            },
        );
    }

    const codes = await Promise.all(instances.map(i => i.done));
    return instances.map((inst, k) => ({ name: inst.name, ok: codes[k] === 0, code: codes[k]!, result: inst.result }));
}

if (import.meta.main) {
    const argv = process.argv.slice(2);
    const flag = (f: string) => { const i = argv.indexOf(f); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
    const stagger = Number(flag('--stagger-ms') ?? 0);
    const memEvery = Number(flag('--mem-every-s') ?? 0);
    const [script, ...names] = argv;
    if (!script || names.length === 0) {
        console.log('usage: bun packages/core/src/host.ts <script> <bot1> [bot2 ...] [--stagger-ms N] [--mem-every-s N]');
        process.exit(2);
    }
    const t0 = Date.now();
    console.log(`HOST start bots=${names.length} script=${script} pid=${process.pid} ${memLine()}`);
    let peak = 0;
    const timer = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
        if (memEvery > 0 && Math.round((Date.now() - t0) / 1000) % memEvery === 0) console.log(`HOST ${memLine(`t=${Math.round((Date.now() - t0) / 1000)}s`)}`);
    }, 1000);
    const results = await runHost(names.map(name => ({ name, script })), { staggerMs: stagger });
    clearInterval(timer);
    peak = Math.max(peak, process.memoryUsage().rss);
    const ok = results.every(r => r.ok);
    console.log(`HOST done ok=${results.filter(r => r.ok).length}/${results.length} seconds=${Math.round((Date.now() - t0) / 1000)} peakRssMB=${Math.round(peak / 2 ** 20)} ${memLine()}`);
    process.exit(ok ? 0 : 1);
}
