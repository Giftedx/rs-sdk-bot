import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { affectedTests, failedFiles, runShard, shard, shardCount, partFiles, parsePart } from './test-shards';

test.skipIf(process.platform !== 'win32')('Windows shards run every file in a fresh process before any retry', async () => {
    const root = resolve(import.meta.dir, '..'), scratch = join(root, '.practice');
    mkdirSync(scratch, { recursive: true });
    const base = mkdtempSync(join(scratch, 'shard-context-'));
    const junit = process.env.TEST_SHARDS_JUNIT;
    try {
        process.env.TEST_SHARDS_JUNIT = join(base, 'fixture-junit');
        const files = ['first', 'second'].map(name => {
            const file = join(base, `${name}.test.ts`);
            writeFileSync(file, `import {expect,test} from 'bun:test';test('${name} context is fresh',()=>{expect((globalThis as any).__shardFixture).toBeUndefined();(globalThis as any).__shardFixture=true;});`);
            return relative(root, file).replaceAll('\\', '/');
        });
        const result = await runShard(files);
        if (result.code !== 0) console.error(result.output);
        expect(result.code).toBe(0);
        expect(result.unknownFailure).toBe(false);
        for (const name of ['first', 'second']) expect(result.output).toContain(`(pass) ${name} context is fresh`);
        writeFileSync(join(base, 'first.test.ts'), "import {test} from 'bun:test';test('first reports failure',()=>{throw Error('fixture refusal');});");
        const failed = await runShard(files);
        expect(failed.code).not.toBe(0);
        expect(failed.unknownFailure).toBe(false);
        expect(failed.output).toContain('(fail) first reports failure');
        expect(failed.output).toContain('(pass) second context is fresh');
        writeFileSync(join(base, 'first.test.ts'), "import './missing-fixture.ts';");
        writeFileSync(join(base, 'second.test.ts'), "import {test} from 'bun:test';test('second reports failure',()=>{throw Error('fixture refusal');});");
        const third = join(base, 'third.test.ts');
        writeFileSync(third, "import {test} from 'bun:test';test('third still runs',()=>{});");
        const mixed = await runShard([...files, relative(root, third).replaceAll('\\', '/')]);
        expect(mixed.code).not.toBe(0);
        expect(mixed.unknownFailure).toBe(true);
        expect(mixed.output).toContain('(fail) second reports failure');
        expect(mixed.output).toContain('(pass) third still runs');
    } finally {
        if (junit === undefined) delete process.env.TEST_SHARDS_JUNIT;
        else process.env.TEST_SHARDS_JUNIT = junit;
        expect(dirname(base)).toBe(scratch);
        rmSync(base, { recursive: true, force: true });
    }
}, 15000);

test('shards fit the requested cap, CPU capacity and memory floor independently', () => {
    expect(shardCount(12, 16, 1, 4)).toBe(4);
    expect(shardCount(2, 16, 1, 4)).toBe(2);
    expect(shardCount(12, 6, 4, 8)).toBe(2);
    expect(shardCount(12, 0.5, 1, 4)).toBe(1);
    expect(shardCount(12, NaN, 1, 4)).toBe(1);
    expect(shardCount(12, 64, 1, 1)).toBe(1);
    expect(shardCount(4, 64, 1, 16)).toBe(4);
    expect(shardCount(12, 64, 1, NaN)).toBe(1);
});

test('the slow files go to separate shards and every file runs once', () => {
    const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts'];
    const shards = shard(files, 2, { 'a.test.ts': 60, 'b.test.ts': 50 });
    expect(shards.flat().sort()).toEqual(files);
    expect(shards.find(s => s.includes('a.test.ts'))).not.toContain('b.test.ts');
    expect(shard([], 4)).toEqual([[]]);
});

test('the parts of n runners hold every file once, and a bad part is refused', () => {
    const files = Array.from({ length: 11 }, (_, i) => `f${i}.test.ts`), seconds = { 'f3.test.ts': 40, 'f7.test.ts': 30 };
    const parts = [1, 2, 3].map(index => partFiles(files, { index, count: 3 }, seconds));
    expect(parts.flat().sort()).toEqual([...files].sort());
    expect(parts.find(p => p.includes('f3.test.ts'))).not.toContain('f7.test.ts');
    expect(partFiles(files, { index: 2, count: 3 }, seconds)).toEqual(parts[1]!);
    expect(parsePart('2/4')).toEqual({ index: 2, count: 4 });
    for (const bad of ['0/4', '5/4', '1/0', 'x', undefined]) expect(() => parsePart(bad)).toThrow();
});

test('a failed test names its file and a passing file is not named', () => {
    const output = ['scripts\\one.test.ts:', '(pass) fine', '', 'packages\\core\\test\\two.test.ts:', '(fail) broken [5.00ms]', '(fail) broken again'].join('\n');
    expect(failedFiles(output)).toEqual(['packages/core/test/two.test.ts']);
});

test('GitHub Actions groups retain the failed filename without their command prefix', () => {
    const output = [
        '  ::group::scripts\\passing.test.ts:  ', '(pass) fine', '::endgroup::',
        '::group::packages\\practice\\test\\goldfarm-order-proof.test.ts:', '(fail) proof [5.00ms]', '(fail) another proof', '::endgroup::',
        '::group::packages/dashboard/panel.test.tsx:', '(fail) panel [5.00ms]', '::endgroup::',
        'scripts/plain.test.ts:', '(fail) plain [5.00ms]',
    ].join('\r\n');
    expect(failedFiles(output)).toEqual([
        'packages/practice/test/goldfarm-order-proof.test.ts', 'packages/dashboard/panel.test.tsx', 'scripts/plain.test.ts',
    ]);
});

test('a change selects the tests that reach it by import, by a quoted path, or by a scan', () => {
    const base = mkdtempSync(join(tmpdir(), 'test-shards-'));
    const write = (path: string, text: string) => { mkdirSync(dirname(join(base, path)), { recursive: true }); writeFileSync(join(base, path), text); };
    try {
        write('scripts/worker.ts', 'export const worker = 1;');
        write('scripts/helper.ts', "import { worker } from './worker';\nexport const helper = worker;");
        write('scripts/other.ts', 'export const other = 1;');
        write('scripts/data.json', '{}');
        write('knowledge/gear.json', '[]');
        write('scripts/imports.test.ts', "import { helper } from './helper';");
        write('scripts/spawns.test.ts', "const cmd = ['bun', 'scripts/worker.ts'];");
        write('scripts/reads.test.ts', "const file = 'scripts/data.json';");
        write('scripts/reads-knowledge.test.ts', "const gear = 'knowledge/gear.json';");
        write('scripts/scans.test.ts', "import { readdirSync } from 'node:fs';\nreaddirSync('scripts');");
        write('scripts/apart.test.ts', "import { other } from './other';");
        write('packages/dashboard/panel.js', 'export const panel = 1;');
        write('packages/dashboard/index.html', '<html></html>');
        write('packages/dashboard/panel.test.ts', "import { readFileSync } from 'node:fs';\nconst js = readFileSync(new URL('./panel.js', import.meta.url), 'utf8');\nconst html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');");
        const tests = ['scripts/imports.test.ts', 'scripts/spawns.test.ts', 'scripts/reads.test.ts', 'scripts/reads-knowledge.test.ts', 'scripts/scans.test.ts', 'scripts/apart.test.ts', 'packages/dashboard/panel.test.ts'];
        expect(affectedTests(tests, ['scripts/worker.ts'], base)).toEqual(['scripts/imports.test.ts', 'scripts/spawns.test.ts', 'scripts/scans.test.ts']);
        expect(affectedTests(tests, ['scripts/data.json'], base)).toEqual(['scripts/reads.test.ts', 'scripts/scans.test.ts']);
        expect(affectedTests(tests, ['knowledge/gear.json'], base)).toEqual(['scripts/reads-knowledge.test.ts', 'scripts/scans.test.ts']);
        expect(affectedTests(tests, ['scripts/apart.test.ts'], base)).toEqual(['scripts/scans.test.ts', 'scripts/apart.test.ts']);
        expect(affectedTests(tests, ['research/note.md'], base)).toEqual(['scripts/scans.test.ts']);
        expect(affectedTests(tests, ['packages/dashboard/panel.js'], base)).toEqual(['scripts/scans.test.ts', 'packages/dashboard/panel.test.ts']);
        expect(affectedTests(tests, ['packages/dashboard/index.html'], base)).toEqual(['scripts/scans.test.ts', 'packages/dashboard/panel.test.ts']);
        expect(affectedTests(tests, ['package.json'], base)).toBeNull();
        expect(affectedTests(tests, ['patches/rs-sdk-working.patch'], base)).toBeNull();
        // Per-call caches do not leak across calls when a file's imports change on disk.
        write('scripts/apart.test.ts', "import { worker } from './worker';");
        expect(affectedTests(tests, ['scripts/worker.ts'], base)).toEqual(['scripts/imports.test.ts', 'scripts/spawns.test.ts', 'scripts/scans.test.ts', 'scripts/apart.test.ts']);
    } finally { rmSync(base, { recursive: true, force: true }); }
});
