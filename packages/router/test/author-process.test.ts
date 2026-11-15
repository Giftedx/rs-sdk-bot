import { test, expect } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { commandLine, safeKill } from '../../practice/src/proc';

// A fake CLI exercises the real runner in a separate process, keeping PATH and model configuration out of other tests.
async function model(mode: string) {
    const dir = mkdtempSync(join(tmpdir(), 'author-process-'));
    const fixture = join(dir, 'cli.ts'), runner = join(dir, 'runner.ts');
    writeFileSync(fixture, `
        const prompt = await new Response(Bun.stdin.stream()).text();
        console.log(JSON.stringify({is_error: false, result: prompt, total_cost_usd: 0.12}));
        if (process.env.CLAUDE_FIXTURE_MODE === 'exit') { console.error('fixture exit failure'); process.exit(7); }
        if (process.env.CLAUDE_FIXTURE_MODE === 'timeout') setInterval(() => {}, 1000);
        if (['orphan', 'escaped'].includes(process.env.CLAUDE_FIXTURE_MODE ?? '')) {
            const child = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 5000); // author-output-fixture'], {stdout: 'inherit', stderr: 'inherit', detached: process.env.CLAUDE_FIXTURE_MODE === 'escaped'});
            await Bun.write(process.env.CLAUDE_FIXTURE_PID!, String(child.pid));
            console.error('DESCENDANT ' + child.pid);
            process.exit(0);
        }
    `);
    writeFileSync(join(dir, 'claude'), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fixture.replaceAll("'", "'\\''")}' "$@"\n`);
    chmodSync(join(dir, 'claude'), 0o755);
    writeFileSync(join(dir, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
    const author = resolve(import.meta.dir, '../src/author.ts');
    writeFileSync(runner, `import {runClaude} from ${JSON.stringify(author)}; console.log(JSON.stringify(await runClaude('fixture prompt', 1000, true)));`);
    const child = Bun.spawn([process.execPath, runner], {
        env: { ...process.env, PATH: dir + delimiter + process.env.PATH, CLAUDE_FIXTURE_MODE: mode, CLAUDE_FIXTURE_PID: join(dir, 'descendant.pid') },
        stdout: 'pipe', stderr: 'pipe', windowsHide: true,
    });
    try {
        const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ exit, err }).toEqual({ exit: 0, err: '' });
        return JSON.parse(out.trim());
    } finally {
        if (child.exitCode === null) child.kill();
        if (existsSync(join(dir, 'descendant.pid'))) await safeKill(Number(readFileSync(join(dir, 'descendant.pid'), 'utf8')), 'author-output-fixture');
        rmSync(dir, { recursive: true, force: true });
    }
}

test('the model runner retains successful output and cost after a clean CLI exit', async () => {
    expect(await model('ok')).toEqual({ ok: true, text: 'fixture prompt', costUsd: 0.12 });
}, 15000);

test('a success envelope cannot hide a nonzero model CLI exit', async () => {
    const result = await model('exit');
    expect(result.ok).toBe(false);
    expect(result.text).toContain('model exit 7');
    expect(result.text).toContain('fixture exit failure');
    expect(result.costUsd).toBe(0.12);
}, 15000);

test('a success envelope cannot hide an expired model deadline', async () => {
    const result = await model('timeout');
    expect(result.ok).toBe(false);
    expect(result.text).toContain('model deadline exceeded');
    expect(result.costUsd).toBe(0.12);
}, 15000);

test.skipIf(process.platform === 'win32')('the model deadline ends inherited output pipes after the CLI has exited', async () => {
    const result = await model('orphan');
    expect(result.ok).toBe(false);
    expect(result.text).toContain('model deadline exceeded');
    const pid = Number(/DESCENDANT (\d+)/.exec(result.text)?.[1]);
    expect(pid).toBeGreaterThan(0);
    // A zombie has no command line and no open pipes; the host reaps it independently.
    expect(commandLine(pid)).toBeNull();
}, 15000);

test.skipIf(process.platform === 'win32')('the model deadline cancels output held by a descendant outside its process group', async () => {
    const started = performance.now(), result = await model('escaped');
    expect(result.ok).toBe(false);
    expect(result.text).toContain('model deadline exceeded');
    expect(performance.now() - started).toBeLessThan(4000);
}, 15000);
