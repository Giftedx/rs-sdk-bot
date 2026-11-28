import { test, expect } from 'bun:test';
import { join, resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { botWrapper, hostedEntrySource, hostedOpenOptions, rewriteScript, runHost } from '../src/host';
import type {Session} from '../src/inprocess';

test('unexpected session end uses the hosted finisher even with a separate custom stop callback',async()=>{
    const calls:string[]=[];
    const options=hostedOpenOptions(()=>{},async()=>{calls.push('finish only this bot');},{onStop:async()=>{calls.push('custom work cancellation');}});
    await options.onSessionEnd!({} as Session,'session ended: logged-out');
    expect(calls).toEqual(['finish only this bot']);
});

test('rewriteScript points the bot import at a per-bot copy and the process globals at the host', () => {
    const src = `import { openBot, finish } from '../../packages/core/src/bot';\nconst n = process.argv[2];\nconsole.log(process.env.TICKS);\nprocess.exit(1);\n`;
    const base = resolve(tmpdir(), 'rs-host-rewrite');
    const bot = join(base, 'packages/core/src/bot.ts').replaceAll('\\', '/');
    const out = rewriteScript(src, 'a-1', join(base, 'scripts/measure'), bot);
    expect(out).toContain(`from '${bot}?hostbot=a-1'`);
    expect(out).toContain('const n = __host.argv[2];');
    expect(out).toContain('__host.console.log(__host.env.TICKS);');
    expect(out).toContain('__host.exit(1);');
    expect(out).not.toContain('process.');
    expect(out.split('\n')[0]).toBe('const __host = globalThis.__rsBotHost.get("a-1");');
});

test('rewriteScript leaves other imports alone', () => {
    const src = `import { waitTicks } from '../packages/core/src/ticks';\nimport { x } from '../packages/core/src/botlike';\n`;
    const out = rewriteScript(src, 'b', 'F:/r/scripts', 'F:/r/packages/core/src/bot.ts');
    expect(out).toContain(`'../packages/core/src/ticks'`);
    expect(out).toContain(`'../packages/core/src/botlike'`);
});

test('botWrapper re-exports bot.ts and overrides only openBot and finish', () => {
    const w = botWrapper('z', 'X/bot.ts');
    expect(w).toContain(`export * from 'X/bot.ts';`);
    expect(w).toContain('export const openBot');
    expect(w).toContain('export const finish');
});

test('hosted entry define changes code, not import.meta.main string data', () => {
    const source = `const text = "import.meta.main"; // import.meta.main is also in a comment
if (import.meta.main) console.log(text);`;
    const out = hostedEntrySource(source, 'entry', 'F:/r/scripts');
    expect(out).toContain('"import.meta.main"');
    expect(out).not.toContain('if (import.meta.main)');
    expect(out).toContain('__host.console.log(text)');
});

test('host custom onStop owns deferred cleanup and is not replaced by default finish', async () => {
    const session = {} as Session;
    let released!: () => void;
    const pending = new Promise<void>(resolve => { released = resolve; });
    const events: string[] = [];
    const custom = async (s: Session, detail: string) => {
        expect(s).toBe(session); expect(detail).toBe('stop file');
        events.push('cancel work'); await pending; events.push('bank products');
    };
    const log = () => {};
    const options = hostedOpenOptions(log, async () => { events.push('default finish'); }, { onStop: custom, log });
    expect(options.onStop).toBe(custom);
    expect(options.log).toBe(log);
    const stopped = options.onStop!(session, 'stop file');
    expect(events).toEqual(['cancel work']);
    released(); await stopped;
    expect(events).toEqual(['cancel work', 'bank products']);
});

test('host default onStop finishes only its supplied session when no custom callback exists', async () => {
    const session = {} as Session;
    const calls: [Session, string][] = [];
    const options = hostedOpenOptions(() => {}, async (s, reason) => { calls.push([s, reason]); });
    await options.onStop!(session, 'died');
    expect(calls).toEqual([[session, 'died']]);
});

test('host executes guarded entry for each actor while imported helper stays non-main', async () => {
    const lines: string[] = [];
    const logDir = join(tmpdir(), `host-main-test-${process.pid}`);
    try {
        const script = join(import.meta.dir, 'fixtures', 'host-main.ts');
        const results = await runHost([{ name: 'mainalpha', script }, { name: 'mainbeta', script }], { out: l => lines.push(l), logDir, guard: false });
        expect(results.map(r => [r.name, r.ok])).toEqual([['mainalpha', true], ['mainbeta', true]]);
        expect(lines).toContain('[mainalpha] MAIN mainalpha helper=false literal=import.meta.main');
        expect(lines).toContain('[mainbeta] MAIN mainbeta helper=false literal=import.meta.main');
        expect(lines.some(l => l.includes('HELPER MAIN') || l.includes('NEVER'))).toBe(false);
    } finally { rmSync(logDir, { recursive: true, force: true }); }
});

test('guarded entry that falls through without finish still fails', async () => {
    const lines: string[] = [];
    const logDir = join(tmpdir(), `host-fallthrough-test-${process.pid}`);
    try {
        const results = await runHost([{ name: 'fallthrough', script: join(import.meta.dir, 'fixtures', 'host-main-fallthrough.ts') }], { out: l => lines.push(l), logDir, guard: false });
        expect(lines).toContain('[fallthrough] MAIN falls through');
        expect(results.map(r => r.ok)).toEqual([false]);
        expect(results[0]!.result).toBe('RESULT fail script ended without finish');
    } finally { rmSync(logDir, { recursive: true, force: true }); }
});


test('runHost runs one script per bot in one process, each with its own argv, log and exit', async () => {
    const lines: string[] = [];
    const logDir = join(tmpdir(), `host-test-${process.pid}`);
    process.env.HOST_TEST_TAG = 'shared';
    const script = join(import.meta.dir, 'fixtures', 'host-echo.ts');
    const r = await runHost(
        [{ name: 'alpha', script }, { name: 'beta', script, env: { HOST_TEST_TAG: 'own' } }, { name: 'failer', script }, { name: 'exiter', script }],
        { out: l => lines.push(l), logDir, guard: false },
    );
    rmSync(logDir, { recursive: true, force: true });
    expect(r.map(x => [x.name, x.code])).toEqual([['alpha', 0], ['beta', 0], ['failer', 1], ['exiter', 3]]);
    expect(lines).toContain('[alpha] HELLO alpha env=shared');
    expect(lines).toContain('[beta] HELLO beta env=own');
    expect(lines).toContain('[alpha] AFTER alpha');
    expect(lines).toContain('[beta] AFTER beta');
    expect(lines).toContain('[alpha] RESULT ok bot=alpha');
    expect(lines).toContain('[failer] RESULT fail bot=failer');
    expect(r.find(x => x.name === 'alpha')!.result).toBe('RESULT ok bot=alpha');
    expect(lines.some(l => l.includes('NEVER'))).toBe(false);
    expect(lines.some(l => l.startsWith('[exiter] RESULT'))).toBe(false);
});

test('a helper module ends, prints, opens and exits for the hosted bot that runs it', async () => {
    const lines: string[] = [];
    const logDir = join(tmpdir(), `host-helper-test-${process.pid}`);
    let opens = 0, closed = false;
    const session = { name: 'helperopen', sdk: {}, bot: {}, direct: async () => ({}), onTick: () => () => {}, ended: Promise.resolve({ reason: 'logged-out' }), close: async () => { closed = true; } } as unknown as Session;
    const script = join(import.meta.dir, 'fixtures', 'host-helper.ts');
    try {
        const r = await runHost(
            ['helperok', 'helperfail', 'helperexit', 'helperopen'].map(name => ({ name, script })),
            { out: l => lines.push(l), logDir, guard: false, open: async (_name, opts) => { opens++; expect(typeof opts?.log).toBe('function'); return session; } },
        );
        expect(r.map(x => [x.name, x.code])).toEqual([['helperok', 0], ['helperfail', 1], ['helperexit', 4], ['helperopen', 0]]);
        expect(lines).toContain('[helperok] HELPER helperok');
        expect(lines).toContain('[helperexit] HELPER helperexit');
        expect(lines).toContain('[helperok] RESULT ok helper bot=helperok');
        expect(lines).toContain('[helperfail] RESULT fail helper bot=helperfail');
        expect(lines).toContain('[helperopen] RESULT ok helper bot=helperopen');
        expect(opens).toBe(1);
        expect(closed).toBe(true);
        expect(lines.some(l => l.includes('NEVER') || l.includes('without a runner hook'))).toBe(false);
    } finally { rmSync(logDir, { recursive: true, force: true }); }
});

test('a chain bot runs its steps in order inside the host, repeats rounds and ends with the chain RESULT', async () => {
    const lines: string[] = [];
    const logDir = join(tmpdir(), `host-chain-test-${process.pid}`);
    const script = 'packages/core/test/fixtures/host-echo.ts';
    try {
        const r = await runHost([
            { name: 'alpha', script: 'scripts/chain.ts', env: { ROUNDS: '2' }, steps: [{ script, args: [], env: { HOST_TEST_TAG: 'one' } }, { script, args: [], env: { HOST_TEST_TAG: 'two' } }] },
            { name: 'failer', script: 'scripts/chain.ts', steps: [{ script, args: [], env: {} }] },
        ], { out: l => lines.push(l), logDir, guard: false });
        expect(r.map(x => [x.name, x.code, x.result])).toEqual([['alpha', 0, 'RESULT ok chain rounds=2 ok=4 failed=0'], ['failer', 1, 'RESULT fail bot=failer chain rounds=1 ok=0 failed=1']]);
        const alpha = lines.filter(l => l.startsWith('[alpha] HELLO') || l.startsWith('[alpha] CHAIN') || l.startsWith('[alpha] RESULT'));
        const step = (round: number) => `[alpha] CHAIN round=${round} ${script} ok RESULT ok bot=alpha`;
        expect(alpha).toEqual([
            '[alpha] HELLO alpha env=one', '[alpha] RESULT ok bot=alpha', step(1),
            '[alpha] HELLO alpha env=two', '[alpha] RESULT ok bot=alpha', step(1),
            '[alpha] HELLO alpha env=one', '[alpha] RESULT ok bot=alpha', step(2),
            '[alpha] HELLO alpha env=two', '[alpha] RESULT ok bot=alpha', step(2),
            '[alpha] RESULT ok chain rounds=2 ok=4 failed=0',
        ]);
        expect(lines).toContain(`[failer] CHAIN round=1 ${script} fail RESULT fail bot=failer`);
        expect(lines.some(l => l.includes('NEVER'))).toBe(false);
    } finally { rmSync(logDir, { recursive: true, force: true }); }
});

test('a stop file ends a chain bot before its next step', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const name = `chainstop${process.pid}`;
    const root = resolve(import.meta.dir, '..', '..', '..');
    const stop = join(root, '.practice', `stop-${name}`);
    const logDir = join(tmpdir(), `host-chain-stop-${process.pid}`);
    mkdirSync(join(root, '.practice'), { recursive: true });
    writeFileSync(stop, 'test');
    try {
        const [r] = await runHost([{ name, script: 'scripts/chain.ts', env: { ROUNDS: '0' }, steps: [{ script: 'packages/core/test/fixtures/host-echo.ts', args: [], env: {} }] }], { out: () => {}, logDir, guard: false });
        expect(r!.result).toBe('RESULT fail stop file chain rounds=0 ok=0 failed=0');
    } finally { rmSync(stop, { force: true }); rmSync(logDir, { recursive: true, force: true }); }
});

test('invalid chain rounds refuse one hosted actor without rejecting its peers', async () => {
    const logDir = join(tmpdir(), `host-chain-invalid-${process.pid}`);
    const step = { script: 'packages/core/test/fixtures/host-echo.ts', args: [], env: {} };
    try {
        const results = await runHost([
            { name: 'alpha', script: 'scripts/chain.ts', steps: [step] },
            { name: 'beta', script: 'scripts/chain.ts', env: { ROUNDS: 'bad' }, steps: [step] },
        ], { out: () => {}, logDir, guard: false });
        expect(results.map(r => [r.name, r.code])).toEqual([['alpha', 0], ['beta', 1]]);
        expect(results[1]!.result).toBe('RESULT fail chain needs steps and nonnegative integer ROUNDS');
    } finally { rmSync(logDir, { recursive: true, force: true }); }
});

test('hostedEntrySource escapes newline and separator characters in bot ids cleanly', () => {
    const src = `import { openBot } from '../packages/core/src/bot';\nvoid openBot('x');\n`;
    const rendered = hostedEntrySource(src, "bot\nline\r'\u2028", resolve(import.meta.dir, '..', '..', '..', 'scripts'));
    expect(() => new Bun.Transpiler({ loader: 'js', target: 'bun' }).transformSync(rendered)).not.toThrow();
    expect(rendered).toContain('hostbot=bot\\nline\\r\\\'\\u2028');
});

test('zero-ts rewriter handles regexes, templates, bracket access, property chains, dynamic imports and exports', () => {
    const src = [
        `import { openBot } from '../packages/core/src/bot';`,
        `const re = /process\\.env|console\\.log/;`,
        `const tpl = \`v=\${process.env.A} literal process.exit(9)\`;`,
        `const kept = obj.process.env.X + obj?.console.log('keep');`,
        `const arg = process['argv'][2];`,
        `console["warn"](arg, tpl, re, kept);`,
        `const dyn = () => import('../packages/core/src/bot');`,
        `export { arg };`,
        `export default class { run() { return openBot; } }`,
    ].join('\n');
    const scriptsDir = resolve('/r/scripts');
    const botFile = resolve('/r/packages/core/src/bot.ts').replace(/\\/g, '/');
    const out = rewriteScript(src, 'edge1', scriptsDir, botFile);
    expect(out).toContain('/process\\.env|console\\.log/');
    expect(out).toContain('${__host.env.A} literal process.exit(9)');
    expect(out).toContain('obj.process.env.X');
    expect(out).toContain("obj?.console.log('keep')");
    expect(out).toContain('const arg = __host.argv[2];');
    expect(out).toContain('__host.console.warn(arg');
    expect(out).toContain(`import('${botFile}?hostbot=edge1')`);

    const entry = hostedEntrySource(src, 'edge1', resolve(import.meta.dir, '..', '..', '..', 'scripts'));
    expect(() => new Bun.Transpiler({ loader: 'js', target: 'bun' }).transformSync(entry)).not.toThrow();
    expect(entry).not.toContain('export { arg }');
    expect(entry).toContain('void (class');
});

test('process.env Proxy isolates per-bot reads, spreads, keys, mutations and Bun.spawnSync env', async () => {
    const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
    const { relative } = await import('node:path');
    const prac = resolve(import.meta.dir, '..', '..', '..', '.practice');
    mkdirSync(prac, { recursive: true });
    const dir = mkdtempSync(join(prac, 'host-env-proxy-'));
    const helper = join(dir, 'helper.ts');
    const script = join(dir, 'worker.ts');
    const botRel = relative(dir, resolve(import.meta.dir, '../src/bot')).replaceAll('\\', '/');
    const botImport = botRel.startsWith('.') ? botRel : `./${botRel}`;
    writeFileSync(helper, `export function inspectEnv(tag: string) {
    process.env.MUTATED_BY_BOT = tag;
    const spread = { ...process.env };
    const hasOwn = 'BOT_SECRET_TAG' in process.env;
    const keysHas = Object.keys(process.env).includes('BOT_SECRET_TAG');
    const spawned = Bun.spawnSync(['bun', '-e', 'console.log(process.env.BOT_SECRET_TAG + ":" + process.env.MUTATED_BY_BOT)'], { env: process.env }).stdout.toString().trim();
    return { direct: process.env.BOT_SECRET_TAG, spread: spread.BOT_SECRET_TAG, mutated: process.env.MUTATED_BY_BOT, hasOwn, keysHas, spawned };
}\n`);
    writeFileSync(script, `import { inspectEnv } from './helper';
import { finish } from '${botImport}';
const tag = process.argv[2]!;
await Bun.sleep(tag === 'alpha' ? 15 : 5);
const res = inspectEnv(tag);
await Bun.sleep(10);
const afterMut = process.env.MUTATED_BY_BOT;
console.log('ENV_CHECK ' + JSON.stringify({ ...res, afterMut }));
await finish([], true, 'ok');\n`);
    const lines: string[] = [];
    const logDir = join(dir, 'logs');
    try {
        const results = await runHost([
            { name: 'alpha', script, env: { BOT_SECRET_TAG: 'A_VAL' } },
            { name: 'beta', script, env: { BOT_SECRET_TAG: 'B_VAL' } },
        ], { out: l => lines.push(l), logDir, guard: false });
        expect(results.every(r => r.ok)).toBe(true);
        const parse = (bot: string) => JSON.parse(lines.find(l => l.startsWith(`[${bot}] ENV_CHECK `))!.slice(`[${bot}] ENV_CHECK `.length));
        expect(parse('alpha')).toEqual({ direct: 'A_VAL', spread: 'A_VAL', mutated: 'alpha', hasOwn: true, keysHas: true, spawned: 'A_VAL:alpha', afterMut: 'alpha' });
        expect(parse('beta')).toEqual({ direct: 'B_VAL', spread: 'B_VAL', mutated: 'beta', hasOwn: true, keysHas: true, spawned: 'B_VAL:beta', afterMut: 'beta' });
        // Neither bot's mutation or overlay leaks into the host process env.
        expect(process.env.MUTATED_BY_BOT).toBeUndefined();
        expect(process.env.BOT_SECRET_TAG).toBeUndefined();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('runHostedBot cancel and stall isolation stop only the affected bot while peers complete', async () => {
    const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
    const { relative } = await import('node:path');
    const { runHostedBot } = await import('../src/host');
    const prac = resolve(import.meta.dir, '..', '..', '..', '.practice');
    mkdirSync(prac, { recursive: true });
    const dir = mkdtempSync(join(prac, 'host-isolate-'));
    const script = join(dir, 'waiter.ts');
    const botRel = relative(dir, resolve(import.meta.dir, '../src/bot')).replaceAll('\\', '/');
    const botImport = botRel.startsWith('.') ? botRel : `./${botRel}`;
    writeFileSync(script, `import { finish } from '${botImport}';
const mode = process.argv[3];
if (mode === 'stall' || mode === 'cancel') {
    await new Promise(() => {});
}
await Bun.sleep(60);
await finish([], true, 'peer-done');\n`);
    const cancel = new AbortController();
    setTimeout(() => cancel.abort('stop file'), 40);
    try {
        const [canceled, stalled, healthy] = await Promise.all([
            runHostedBot({ name: 'cancelbot', script, args: ['cancel'] }, { logFile: null, out: () => {}, guard: false, cancel: cancel.signal }),
            runHostedBot({ name: 'stallbot', script, args: ['stall'] }, { logFile: null, out: () => {}, guard: false, stallMs: 80, checkMs: 20, newestStatus: () => 0 }),
            runHostedBot({ name: 'healthybot', script, args: ['ok'] }, { logFile: null, out: () => {}, guard: false }),
        ]);
        expect(canceled.ok).toBe(false);
        expect(canceled.result).toContain('stop file');
        expect(stalled.ok).toBe(false);
        expect(stalled.stalled).toBe(true);
        expect(stalled.result).toContain('stalled with no output and no status write');
        expect(healthy.ok).toBe(true);
        expect(healthy.result).toBe('RESULT ok peer-done');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
