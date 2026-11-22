import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPin } from './check-pin';

function tempRepo(): { dir: string; sha: string } {
    const dir = mkdtempSync(join(tmpdir(), 'pin-'));
    const run = (...args: string[]) => Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'pipe' });
    run('init', '-q');
    run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
    const sha = run('rev-parse', 'HEAD').stdout.toString().trim();
    return { dir, sha };
}

test('checkPin reports mismatch', () => {
    const { dir, sha } = tempRepo();
    const pin = join(dir, 'pin.txt');
    writeFileSync(pin, 'b565f2d920bf6f5ec427bc6f66dc6fd64a2e15c1\n');
    const r = checkPin(dir, pin);
    expect(r.ok).toBe(false);
    expect(r.expected).toBe('b565f2d920bf6f5ec427bc6f66dc6fd64a2e15c1');
    expect(r.actual).toBe(sha);
});

test('checkPin reports match', () => {
    const { dir, sha } = tempRepo();
    const pin = join(dir, 'pin.txt');
    writeFileSync(pin, `${sha}\n`);
    expect(checkPin(dir, pin).ok).toBe(true);
});
