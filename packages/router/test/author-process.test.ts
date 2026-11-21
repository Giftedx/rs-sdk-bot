import { test, expect } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { commandLine, safeKill } from '../../core/src/proc';

// A fake CLI exercises the real runner in a separate process, keeping PATH and model configuration out of other tests.
async function model(mode: string, inherited: NodeJS.ProcessEnv = process.env) {
    const dir = mkdtempSync(join(tmpdir(), 'author-process-'));
    const fixture = join(dir, 'cli.ts'), runner = join(dir, 'runner.ts'), traceFile = join(dir, 'trace.jsonl');
    const traceSource = `import {appendFileSync} from 'node:fs';
        const trace=(phase,extra={})=>appendFileSync(${JSON.stringify(traceFile)},JSON.stringify({phase,pid:process.pid,at:Date.now(),monotonicMs:performance.now(),...extra})+'\\n');`;
    writeFileSync(fixture, `
        ${traceSource}
        trace('fixture-entry');
        const prompt = await new Response(Bun.stdin.stream()).text();
        trace('stdin-complete');
        console.log(JSON.stringify({is_error: false, result: prompt, total_cost_usd: 0.12}));
        trace('output-written');
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
    const expectedCli = join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    writeFileSync(runner, `${traceSource}
        const resolved=Bun.which('claude'),expected=${JSON.stringify(expectedCli)};
        trace('runner-entry',{resolved,expected});
        if(resolved!==expected)throw Error('model fixture CLI mismatch: '+JSON.stringify({resolved,expected}));
        const {runClaude}=await import(${JSON.stringify(author)});
        const result=await runClaude('fixture prompt',1000,true);
        trace('runner-return',{costUsd:result.costUsd});
        console.log(JSON.stringify(result));`);
    const inheritedPath = inherited.PATH ?? Object.entries(inherited).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
    const childEnv = Object.fromEntries(Object.entries(inherited).filter(([key]) => key.toLowerCase() !== 'path'));
    childEnv.PATH = dir + delimiter + inheritedPath;
    const child = Bun.spawn([process.execPath, runner], {
        env: { ...childEnv, CLAUDE_FIXTURE_MODE: mode, CLAUDE_FIXTURE_PID: join(dir, 'descendant.pid') },
        stdout: 'pipe', stderr: 'pipe', windowsHide: true,
    });
    try {
        const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ exit, err }).toEqual({ exit: 0, err: '' });
        const result = JSON.parse(out.trim());
        if (result.costUsd === 0) throw Error('model fixture returned no cost: ' + JSON.stringify({ mode, result,
            trace: existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : '(missing)' }));
        return result;
    } finally {
        if (child.exitCode === null) child.kill();
        if (existsSync(join(dir, 'descendant.pid'))) await safeKill(Number(readFileSync(join(dir, 'descendant.pid'), 'utf8')), 'author-output-fixture');
        rmSync(dir, { recursive: true, force: true });
    }
}

test('the model runner retains successful output and cost after a clean CLI exit', async () => {
    expect(await model('ok')).toEqual({ ok: true, text: 'fixture prompt', costUsd: 0.12 });
}, 15000);

test('the model fixture resolves its own CLI with colliding inherited PATH aliases', async () => {
    const inheritedPath = process.env.PATH ?? process.env.Path ?? '';
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
    inherited.PATH = inheritedPath;
    inherited.Path = inheritedPath;
    expect(await model('ok', inherited)).toEqual({ ok: true, text: 'fixture prompt', costUsd: 0.12 });
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
