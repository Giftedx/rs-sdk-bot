import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { affectedTests, failedFiles, shard } from './test-shards';

test('the slow files go to separate shards and every file runs once', () => {
    const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts'];
    const shards = shard(files, 2, { 'a.test.ts': 60, 'b.test.ts': 50 });
    expect(shards.flat().sort()).toEqual(files);
    expect(shards.find(s => s.includes('a.test.ts'))).not.toContain('b.test.ts');
    expect(shard([], 4)).toEqual([[]]);
});

test('a failed test names its file and a passing file is not named', () => {
    const output = ['scripts\\one.test.ts:', '(pass) fine', '', 'packages\\core\\test\\two.test.ts:', '(fail) broken [5.00ms]', '(fail) broken again'].join('\n');
    expect(failedFiles(output)).toEqual(['packages/core/test/two.test.ts']);
});

test('a change selects the tests that reach it by import, by a quoted path, or by a scan', () => {
    const base = mkdtempSync(join(tmpdir(), 'test-shards-'));
    const write = (path: string, text: string) => { mkdirSync(dirname(join(base, path)), { recursive: true }); writeFileSync(join(base, path), text); };
    try {
        write('scripts/worker.ts', 'export const worker = 1;');
        write('scripts/helper.ts', "import { worker } from './worker';\nexport const helper = worker;");
        write('scripts/other.ts', 'export const other = 1;');
        write('scripts/data.json', '{}');
        write('scripts/imports.test.ts', "import { helper } from './helper';");
        write('scripts/spawns.test.ts', "const cmd = ['bun', 'scripts/worker.ts'];");
        write('scripts/reads.test.ts', "const file = 'scripts/data.json';");
        write('scripts/scans.test.ts', "import { readdirSync } from 'node:fs';\nreaddirSync('scripts');");
        write('scripts/apart.test.ts', "import { other } from './other';");
        const tests = ['scripts/imports.test.ts', 'scripts/spawns.test.ts', 'scripts/reads.test.ts', 'scripts/scans.test.ts', 'scripts/apart.test.ts'];
        expect(affectedTests(tests, ['scripts/worker.ts'], base)).toEqual(['scripts/imports.test.ts', 'scripts/spawns.test.ts', 'scripts/scans.test.ts']);
        expect(affectedTests(tests, ['scripts/data.json'], base)).toEqual(['scripts/reads.test.ts', 'scripts/scans.test.ts']);
        expect(affectedTests(tests, ['scripts/apart.test.ts'], base)).toEqual(['scripts/scans.test.ts', 'scripts/apart.test.ts']);
        expect(affectedTests(tests, ['research/note.md'], base)).toEqual(['scripts/scans.test.ts']);
        expect(affectedTests(tests, ['package.json'], base)).toBeNull();
        expect(affectedTests(tests, ['patches/rs-sdk-working.patch'], base)).toBeNull();
    } finally { rmSync(base, { recursive: true, force: true }); }
});
