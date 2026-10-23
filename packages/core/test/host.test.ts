import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { botWrapper, rewriteScript, runHost } from '../src/host';

test('rewriteScript points the bot import at a per-bot copy and the process globals at the host', () => {
    const src = `import { openBot, finish } from '../../packages/core/src/bot';\nconst n = process.argv[2];\nconsole.log(process.env.TICKS);\nprocess.exit(1);\n`;
    const out = rewriteScript(src, 'a-1', 'F:/r/scripts/measure', 'F:/r/packages/core/src/bot.ts');
    expect(out).toContain(`from 'F:/r/packages/core/src/bot.ts?hostbot=a-1'`);
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
