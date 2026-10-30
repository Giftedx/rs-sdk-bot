import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { parseHostArgs } from '../src/host';

test('host keeps account order and zero values when flags appear between accounts', () => {
    expect(parseHostArgs(['worker.ts', 'first', '--stagger-ms', '0', 'second', '--mem-every-s', '5'])).toEqual({ script: 'worker.ts', names: ['first', 'second'], args: [], stagger: 0, memEvery: 5 });
});

for (const args of [
    ['--stagger-ms'],
    ['--stagger-ms', '--mem-every-s', '1'],
    ['--stagger-ms', 'NaN'],
    ['--mem-every-s', '-1'],
    ['--mem-every-s', 'Infinity'],
    ['--mem-every-s', '0.3'],
    ['--stagger-ms', ' '],
    ['--stagger-ms', '0', '--stagger-ms', '2'],
    ['--stager-ms', '2'],
]) test(`host rejects invalid launch options before running workers: ${args.join(' ')}`, async () => {
    const child = Bun.spawn(['bun', join(import.meta.dir, '../src/host.ts'), join(import.meta.dir, 'fixtures/host-main.ts'), 'testonly', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const timeout = setTimeout(() => child.kill(), 10_000);
    try {
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(code).toBe(2);
        expect(stdout).not.toContain('HOST start');
        expect(stderr).toContain('invalid host arguments:');
    } finally { clearTimeout(timeout); }
});
