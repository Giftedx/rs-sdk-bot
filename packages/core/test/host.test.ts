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
