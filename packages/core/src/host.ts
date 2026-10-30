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
//   import.meta.main                         -> true (parser define on this entry only, never its helpers)
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
import ts from 'typescript';
import { openBot, settle } from './bot';
import type { Session } from './inprocess';
import { noteStatusLine } from './status';
import { workerExecution } from './worker-execution';
import { executionContext } from '../../../vendor/rs-sdk/sdk/execution-context';

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
    const parsed = ts.createSourceFile('host-entry.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const edits: { start: number; end: number; value: string }[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
            const owner = node.expression;
            const property = ts.isPropertyAccessExpression(node) ? node.name.text
                : node.argumentExpression && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : null;
            if (ts.isIdentifier(owner) && property) {
                const replacement = owner.text === 'process' && ['argv', 'env', 'exit'].includes(property) ? `__host.${property}`
                    : owner.text === 'console' && ['log', 'error', 'warn', 'info'].includes(property) ? `__host.console.${property}` : null;
                if (replacement) edits.push({ start: node.getStart(parsed), end: node.getEnd(), value: replacement });
            }
        } else if (ts.isStringLiteral(node)) {
            const parent = node.parent;
            const module = ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node)
                || (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword && parent.arguments[0] === node);
            if (module && /^\.{1,2}\//.test(node.text) && norm(resolve(scriptDir, node.text)) === target) {
                const path = `${botModule}?${BOT_Q}=${id}`.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                edits.push({ start: node.getStart(parsed), end: node.getEnd(), value: `'${path}'` });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(parsed);
    let out = src;
    for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.value + out.slice(edit.end);
    // Import declarations are hoisted, so this line runs before the script body wherever it stands.
    return `const __host = globalThis.__rsBotHost.get(${JSON.stringify(id)});\n${out}`;
}

// Only the ?hostscript entry is passed here. A parser define avoids changing the
// same text inside a string/comment or making an imported helper a main module.
export function hostedEntrySource(src: string, id: string, scriptDir: string): string {
    const entry = new Bun.Transpiler({ loader: 'ts', target: 'bun', define: { 'import.meta.main': 'true' } }).transformSync(src);
    const rewritten = rewriteScript(entry, id, scriptDir);
    const split = rewritten.indexOf('\n');
    const prefix = rewritten.slice(0, split);
    const body = rewritten.slice(split + 1);
    // Bun module evaluation does not inherit the import caller's async scope.
    // Keep static imports at module level and start the worker body in its own
    // scope. Entry exports are private to this hosted query, never helper imports.
    const parsed = ts.createSourceFile('host-entry.js', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const imports: string[] = [], statements: string[] = [];
    for (const statement of parsed.statements) {
        if (ts.isImportDeclaration(statement) || (ts.isExportDeclaration(statement) && statement.moduleSpecifier)) {
            imports.push(statement.getFullText(parsed));
        } else if (ts.isExportDeclaration(statement)) {
            continue;
        } else if (ts.isExportAssignment(statement)) {
            statements.push(`void (${statement.expression.getText(parsed)});`);
        } else {
            let text = statement.getFullText(parsed);
            const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
            const remove = modifiers.filter(m => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword);
            for (const modifier of [...remove].reverse()) {
                const from = modifier.getStart(parsed) - statement.getFullStart();
                const to = modifier.getEnd() - statement.getFullStart();
                text = text.slice(0, from) + text.slice(to);
            }
            if (remove.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) &&
                (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && !statement.name) text = `void (${text});`;
            statements.push(text);
        }
    }
    return `${imports.join('\n')}\n${prefix}\nawait __host.execution.run(async () => {\n${statements.join('\n')}\n});`;
}

type OpenOptions = NonNullable<Parameters<typeof openBot>[1]>;
export function hostedOpenOptions(log: (line: string) => void, defaultStop: NonNullable<OpenOptions['onStop']>, opts: OpenOptions = {}): OpenOptions {
    // A custom callback cancels work/banks products before the worker calls its
    // own finish. Only scripts without that policy use the host's final stop.
    return { log, ...opts, onStop: opts.onStop ?? defaultStop, onSessionEnd: opts.onSessionEnd ?? defaultStop };
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
    openBot(name: string, opts?: OpenOptions): Promise<Session>;
    finish(sessions: Session[], ok: boolean, detail: string): Promise<never>;
    sessions: Session[];
    result: string;
    done: Promise<number>;
    execution: ReturnType<typeof workerExecution>;
    openings: Set<Promise<Session>>;
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
                return { contents: hostedEntrySource(readFileSync(file, 'utf8'), id, dirname(file)), loader: 'js' };
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
        const hit = memo.get(k);
        if (hit) return hit;
        const p: Promise<unknown> = orig(opts);
        memo.set(k, p);
        p.catch(() => memo.delete(k));
        return p;
    };
    L.__hostShared = true;
}

export function memLine(tag = ''): string {
    const m = process.memoryUsage();
    const mb = (n: number) => Math.round(n / 2 ** 20);
    return `MEM${tag ? ' ' + tag : ''} rss=${mb(m.rss)} heapUsed=${mb(m.heapUsed)} external=${mb(m.external)} arrayBuffers=${mb(m.arrayBuffers)}`;
}

export async function runHost(bots: HostedBot[], opts: { staggerMs?: number; out?: (line: string) => void; logDir?: string; guard?: boolean; open?: typeof openBot } = {}): Promise<HostedResult[]> {
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
                inst.execution.stop(new Error(`worker exited ${code}`));
                if (!finished) {
                    finished = true;
                    const pending = [...inst.openings];
                    if (inst.sessions.length || pending.length) {
                        void inst.execution.cleanup(async () => {
                            await Promise.allSettled(pending);
                            return settle(inst.sessions, code === 0 && !pending.length, `script exit ${code}`, { log: l => inst.log(l) });
                        })
                            .then(ok => resolveDone(code || (ok ? 0 : 1)), e => { inst.log(`WARN exit cleanup failed: ${fmt([e])}`); resolveDone(code || 1); });
                    } else resolveDone(code);
                }
                throw new HostExit(code);
            },
            async openBot(name, o) {
                if (finished || inst.execution.signal.aborted || executionContext.getStore()?.signal.aborted) return never;
                const opening = (async () => {
                    const s = await (opts.open ?? openBot)(name, hostedOpenOptions(l => inst.log(l), (s,detail) => inst.finish([s], false, detail), o));
                    if (finished || inst.execution.signal.aborted) {
                        await inst.execution.cleanup(() => settle([s], false, 'session opened after worker stopped', { log: l => inst.log(l) }));
                        throw inst.execution.signal.reason ?? new Error('worker stopped during open');
                    }
                    inst.execution.bind(s);
                    inst.sessions.push(s);
                    return s;
                })();
                inst.openings.add(opening);
                try { return await opening; } finally { inst.openings.delete(opening); }
            },
            async finish(sessions, ok, detail) {
                if (finished) return never;
                finished = true;
                const pending = [...inst.openings];
                inst.execution.stop(new Error(`worker finished: ${detail}`));
                // Same steps as finish() in bot.ts, without the process exit: RESULT, ledgers, logout, close.
                const final = await inst.execution.cleanup(async () => {
                    await Promise.allSettled(pending);
                    return settle([...new Set([...sessions, ...inst.sessions])], ok && !pending.length, detail, { log: l => inst.log(l) });
                }).catch(e => { inst.log(`WARN settle failed: ${fmt([e])}`); return false; });
                resolveDone(final ? 0 : 1);
                // Like process.exit: nothing after finish() in the script runs.
                return never;
            },
            sessions: [],
            result: '',
            done,
            execution: workerExecution((level, args) => inst.console[level](...args)),
            openings: new Set(),
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
    for (const inst of instances) registry.delete(inst.id);
    return instances.map((inst, k) => ({ name: inst.name, ok: codes[k] === 0, code: codes[k]!, result: inst.result }));
}

// jopt-simple's required argument + typed conversion boundary, rewritten for
// the two host flags. Reject bad values before opening any worker sessions.
export function parseHostArgs(argv: string[]) {
    const positional: string[] = [], values = new Map<string, number>();
    let args: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (!arg.startsWith('--')) { positional.push(arg); continue; }
        // --args a,b: the same script arguments for every bot, after its name (bun <script> <bot> a b).
        if (arg === '--args') { const raw = argv[++i]; if (raw === undefined) throw new Error('--args requires a value'); args = raw.split(',').filter(Boolean); continue; }
        if (!['--stagger-ms', '--mem-every-s'].includes(arg)) throw new Error(`unknown option ${arg}`);
        if (values.has(arg)) throw new Error(`duplicate option ${arg}`);
        const raw = argv[++i];
        if (!raw?.trim() || raw.startsWith('--')) throw new Error(`${arg} requires a number`);
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0 || (arg === '--stagger-ms' && value > 2_147_483_647)) throw new Error(`${arg} is out of range`);
        if (arg === '--mem-every-s' && !Number.isSafeInteger(value)) throw new Error(`${arg} requires whole seconds`);
        values.set(arg, value);
    }
    const [script, ...names] = positional;
    return { script, names, args, stagger: values.get('--stagger-ms') ?? 0, memEvery: values.get('--mem-every-s') ?? 0 };
}

if (import.meta.main) {
    let parsed: ReturnType<typeof parseHostArgs>;
    try { parsed = parseHostArgs(process.argv.slice(2)); }
    catch (error) { console.error(`invalid host arguments: ${String(error)}`); process.exit(2); }
    const { script, names, args, stagger, memEvery } = parsed;
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
    const results = await runHost(names.map(name => ({ name, script, args })), { staggerMs: stagger });
    clearInterval(timer);
    peak = Math.max(peak, process.memoryUsage().rss);
    const ok = results.every(r => r.ok);
    console.log(`HOST done ok=${results.filter(r => r.ok).length}/${results.length} seconds=${Math.round((Date.now() - t0) / 1000)} peakRssMB=${Math.round(peak / 2 ** 20)} ${memLine()}`);
    process.exit(ok ? 0 : 1);
}
