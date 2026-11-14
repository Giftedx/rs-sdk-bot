import { test, expect } from 'bun:test';
import { killTree, processMatches, processMatchesRecent, processStartTimes, safeKill, sleeperCommand } from '../src/proc';

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
