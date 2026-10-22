import { test, expect } from 'bun:test';
import { processMatches, safeKill } from '../src/proc';

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

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
