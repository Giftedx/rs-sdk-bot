import { test, expect } from 'bun:test';
import { commandLine, killTree, processMatches, processMatchesRecent, processStartTimes, safeKill, sleeperCommand } from '../src/proc';

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

test('a sleeper stays alive with its label on the command line until killTree ends it', async () => {
    expect(() => sleeperCommand('bad label; rm')).toThrow('sleeper label');
    const label = 'sleeper-test-' + Date.now();
    const p = Bun.spawn(sleeperCommand(label, 30), { stdout: 'ignore', stderr: 'ignore', windowsHide: true });
    await Bun.sleep(1000);
    expect(p.exitCode).toBeNull();
    expect(processMatchesRecent(p.pid, label)).toBe(true);
    await killTree(p.pid);
    await p.exited;
    expect(alive(p.pid)).toBe(false);
}, 15000);

test.skipIf(process.platform === 'win32')('killTree ends descendants holding inherited pipes, including a child that ignores TERM, and preserves a sibling', async () => {
    const grandchild = `process.on('SIGTERM', () => console.log('IGNORED ' + process.pid)); console.log('GRANDCHILD ' + process.pid); setInterval(() => {}, 1000);`;
    const child = `Bun.spawn([process.execPath, '-e', ${JSON.stringify(grandchild)}], {stdout:'inherit',stderr:'inherit'}); console.log('CHILD ' + process.pid); setInterval(() => {}, 1000);`;
    const parent = `Bun.spawn([process.execPath, '-e', ${JSON.stringify(child)}], {stdout:'inherit',stderr:'inherit'}); console.log('ROOT ' + process.pid); setInterval(() => {}, 1000);`;
    const p = Bun.spawn([process.execPath, '-e', parent], { stdout: 'pipe', stderr: 'inherit', windowsHide: true });
    const sibling = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true });
    let output = '';
    const drained = (async () => { for await (const chunk of p.stdout) output += new TextDecoder().decode(chunk); })();
    try {
        const deadline = performance.now() + 5000;
        while (!output.includes('GRANDCHILD ') && performance.now() < deadline) await Bun.sleep(10);
        expect(output).toContain('GRANDCHILD ');
        const ids = [...output.matchAll(/^(?:ROOT|CHILD|GRANDCHILD) (\d+)$/gm)].map(m => Number(m[1]));
        expect(ids).toHaveLength(3);
        await killTree(p.pid);
        await p.exited;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([drained, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('descendant retained stdout after killTree')), 3000); })]); }
        finally { clearTimeout(timer); }
        expect(output).toContain('IGNORED ');
        for (const pid of ids) expect(commandLine(pid)).toBeNull();
        expect(alive(sibling.pid)).toBe(true);
    } finally {
        for (const match of output.matchAll(/^(?:ROOT|CHILD|GRANDCHILD) (\d+)$/gm)) try { process.kill(Number(match[1]), 'SIGKILL'); } catch {}
        if (p.exitCode === null) p.kill('SIGKILL');
        sibling.kill('SIGKILL');
        await Promise.all([p.exited, sibling.exited, drained]);
    }
}, 15000);

test('killTree ignores PIDs that would address a process group', async () => {
    for (const pid of [0, -1, -process.pid, NaN, 1.5]) await killTree(pid);
    expect(alive(process.pid)).toBe(true);
});

test.skipIf(process.platform !== 'linux')('command line observations tolerate a child exiting during repeated reads', async () => {
    const child = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 20)'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true });
    try {
        for (let i = 0; i < 200; i++) { expect(() => commandLine(child.pid)).not.toThrow(); await Bun.sleep(1); }
        await child.exited;
        expect(commandLine(child.pid)).toBeNull();
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
}, 5000);

test('processMatches checks the command line, not just the PID', () => {
    expect(processMatches(process.pid, 'bun')).toBe(true);
    expect(processMatches(process.pid, 'zzz-not-in-cmdline')).toBe(false);
    expect(processMatches(999999, 'bun')).toBe(false);
}, 30_000); // each lookup is a PowerShell CIM call of ~1.5 s

test('safeKill leaves a process alone when the marker does not match, and kills it when it does', async () => {
    const child = Bun.spawn(['bun', '-e', 'setTimeout(() => {}, 60000) // marker-sleeper'], { stdout: 'ignore' });
    await Bun.sleep(500);
    expect(await safeKill(child.pid, 'some-other-program')).toBe(false);
    expect(alive(child.pid)).toBe(true);
    expect(await safeKill(child.pid, 'marker-sleeper')).toBe(true);
    await child.exited;
    expect(alive(child.pid)).toBe(false);
}, 30_000);

test('processStartTimes reads the start of a live PID and lists no dead PID', () => {
    const child = Bun.spawn(['bun', '-e', 'setTimeout(() => {}, 60000)'], { stdout: 'ignore', windowsHide: true });
    const spawned = Date.now();
    try {
        const starts = processStartTimes([child.pid, process.pid, 999999, 0, -1]);
        if (process.platform !== 'win32') { expect(starts).toBeNull(); return; }
        expect([...starts!.keys()].sort((a, b) => a - b)).toEqual([child.pid, process.pid].sort((a, b) => a - b));
        // The swarm relies on this order: a process starts before the caller reads the clock after the spawn.
        expect(starts!.get(child.pid)!).toBeLessThanOrEqual(spawned);
        expect(spawned - starts!.get(child.pid)!).toBeLessThan(10_000);
        expect(starts!.get(process.pid)!).toBeLessThan(starts!.get(child.pid)!);
    } finally { child.kill(); }
    expect(processStartTimes([])).toEqual(new Map());
}, 30_000);
