import {expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {runtimeTrees} from '../../core/src/worker-release';
import {adoptedDelivery, localFacts, STORE} from '../src/adopt-delivery';
import type {DeliveryTask} from '../src/delivery';

// A fixture checkout: the release files of a worker, the router files that a delivery fingerprint names, and one
// capability. The delivery of that capability is written as a hosted runner writes it, then adopted by the checks of
// adoptedDelivery, which runs them again at each use.
const task: DeliveryTask = {id: 'fixture-cap', goal: 'Fixture capability', entry: 'scripts/worker.ts', files: ['scripts/worker.ts', 'scripts/data.json'], consumer: 'Fixture consumer', checks: [
    {id: 'regression', phase: 'regression', command: ['bun', 'test'], timeoutMs: 1000},
    {id: 'native', phase: 'practice', command: ['bun', 'packages/practice/src/proof.ts'], timeoutMs: 1000},
    {id: 'consumer', phase: 'consumer', command: ['bun', 'packages/practice/src/proof.ts', '--verify'], timeoutMs: 1000}]};

function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'adopt-e2e-'));
    for (const dir of [...runtimeTrees, 'vendor/rs-sdk/server/vendor/rsmod-pathfinder', '.practice/status', 'knowledge', 'scripts', 'packages/core/src', 'packages/practice/src', 'packages/router/src', 'packages/router/tasks', 'packages/dashboard'])
        mkdirSync(join(root, dir), {recursive: true});
    const files: Record<string, string> = {
        'package.json': '{}', 'bun.lock': '', 'tsconfig.json': '{}', 'vendor/rs-sdk/sdk/helper.ts': 'export {};', 'vendor/rs-sdk/server/webclient/src/client.ts': 'export {};',
        'vendor/rs-sdk/sdk/pathfinding.ts': "import * as rsmod from '../server/vendor/rsmod-pathfinder';",
        'vendor/rs-sdk/server/vendor/rsmod-pathfinder/package.json': '{"main":"rsmod-pathfinder.js"}',
        'vendor/rs-sdk/server/vendor/rsmod-pathfinder/rsmod-pathfinder.js': "require('node:fs').readFileSync(require('node:path').join(__dirname,'rsmod_bg.wasm'));",
        'vendor/rs-sdk/server/vendor/rsmod-pathfinder/rsmod_bg.wasm': 'wasm fixture',
        'scripts/worker.ts': "import {shared} from '../packages/core/src/shared';\nexport const worker = shared + 1;\n", 'scripts/data.json': '{"a":1}',
        'packages/core/src/shared.ts': 'export const shared = 1;\n', 'scripts/swarm.ts': 'export {};', 'packages/core/src/session-recovery.ts': 'export {};', 'packages/dashboard/server.ts': 'export {};',
        'packages/practice/src/supervise.ts': 'export {};', 'packages/practice/src/supervise-host.ts': 'export {};',
        'packages/router/src/delivery.ts': 'export {};', 'packages/router/src/delivery-cli.ts': 'export {};', 'packages/router/src/saved-proof-verifiers.json': '{}',
        'packages/router/tasks/fixture-cap.json': JSON.stringify(task),
    };
    for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
    return root;
}
// The delivery of the fixture as a runner leaves it, and the index entry that adopt-delivery.ts writes.
function adopt(root: string, over: {report?: (r: any) => any; skipLogs?: boolean} = {}): string {
    const folder = join(root, ...STORE, '123', task.id, 'fixture-cap-1');
    mkdirSync(folder, {recursive: true});
    const facts = localFacts(task, folder, root);
    const sha = (p: string) => facts.fileSha(p)!;
    let report: any = {ok: true, stage: 'delivered', evidence: 'native', id: task.id, source: facts.source, runtimeRevision: facts.runtime, at: Date.now() - 1000, directory: folder,
        checks: task.checks.map(c => ({id: c.id, phase: c.phase, exitCode: 0, timedOut: false, detail: '{}'})), files: task.files.map(path => ({path, sha256: sha(path)}))};
    if (over.report) report = over.report(report);
    writeFileSync(join(folder, 'report.json'), JSON.stringify(report));
    writeFileSync(join(folder, 'task.json'), JSON.stringify(task));
    if (!over.skipLogs) for (const i of task.checks.keys()) { writeFileSync(join(folder, `${i}.out.log`), ''); writeFileSync(join(folder, `${i}.err.log`), ''); }
    const index = join(root, ...STORE, 'adopted.json');
    mkdirSync(dirname(index), {recursive: true});
    writeFileSync(index, JSON.stringify({version: 1, capabilities: {[task.id]: {source: facts.source, run: '123', commit: 'a'.repeat(40), folder: 'fixture-cap-1', at: Date.now()}}}));
    return folder;
}

test('an adopted delivery of the same source is taken, with its origin', () => {
    const root = fixture();
    try {
        adopt(root);
        const got = adoptedDelivery(task, root);
        expect(got).not.toBeNull();
        expect(got).toMatchObject({ok: true, id: 'fixture-cap', adoptedFrom: {run: '123', commit: 'a'.repeat(40)}});
        expect(got!.source).toBe(localFacts(task, '', root).source);
    } finally { rmSync(root, {recursive: true, force: true}); }
});

test('a code edit of the entry, a helper or a declared file after the adoption ends it', () => {
    for (const [path, change] of [['scripts/worker.ts', 'export const worker = 99;\n'], ['packages/core/src/shared.ts', 'export const shared = 2;\n'], ['scripts/data.json', '{"a":2}'], ['packages/router/src/delivery-cli.ts', 'export const x = 1;']] as const) {
        const root = fixture();
        try {
            adopt(root);
            expect(adoptedDelivery(task, root)).not.toBeNull();
            writeFileSync(join(root, path), change);
            expect(adoptedDelivery(task, root)).toBeNull();
        } finally { rmSync(root, {recursive: true, force: true}); }
    }
});

test('a comment or a layout edit, which no program notices, keeps the adoption; a worker release change ends it', () => {
    const root = fixture();
    try {
        adopt(root);
        writeFileSync(join(root, 'packages/core/src/shared.ts'), '// a note\r\nexport const shared = 1;\r\n\r\n');
        expect(adoptedDelivery(task, root)).not.toBeNull();
        // A runtime tree file changes the worker release (and the report's runtime revision no longer fits).
        writeFileSync(join(root, 'vendor/rs-sdk/sdk/helper.ts'), 'export const helper = 1;');
        expect(adoptedDelivery(task, root)).toBeNull();
    } finally { rmSync(root, {recursive: true, force: true}); }
});

test('an incomplete or altered delivery is never taken', () => {
    const cases: [string, Parameters<typeof adopt>[1]][] = [
        ['report not ok', {report: r => ({...r, ok: false, stage: 'failed', failedCheck: 'native'})}],
        ['other capability', {report: r => ({...r, id: 'other-cap'})}],
        ['source of other code', {report: r => ({...r, source: '9'.repeat(64)})}],
        ['release of other code', {report: r => ({...r, runtimeRevision: '9'.repeat(64)})}],
        ['a failed check', {report: r => ({...r, checks: r.checks.map((c: any, i: number) => i === 1 ? {...c, exitCode: 1} : c)})}],
        ['a missing check', {report: r => ({...r, checks: r.checks.slice(0, 2)})}],
        ['a changed file hash', {report: r => ({...r, files: r.files.map((f: any, i: number) => i === 0 ? {...f, sha256: '9'.repeat(64)} : f)})}],
        ['no check logs', {skipLogs: true}],
    ];
    for (const [name, over] of cases) {
        const root = fixture();
        try { adopt(root, over); expect([name, adoptedDelivery(task, root)]).toEqual([name, null]); } finally { rmSync(root, {recursive: true, force: true}); }
    }
});

test('no index, an index of another source, and an index entry that leaves its folder give no delivery', () => {
    const root = fixture();
    try {
        expect(adoptedDelivery(task, root)).toBeNull();
        const folder = adopt(root);
        const index = join(root, ...STORE, 'adopted.json'), entry = JSON.parse(readFileSync(index, 'utf8'));
        for (const change of [{source: '9'.repeat(64)}, {run: '..'}, {run: '12/..'}, {folder: '../../..'}, {folder: '/etc'}, {folder: ''}]) {
            writeFileSync(index, JSON.stringify({version: 1, capabilities: {[task.id]: {...entry.capabilities[task.id], ...change}}}));
            expect([change, adoptedDelivery(task, root)]).toEqual([change, null]);
        }
        writeFileSync(index, 'not json');
        expect(adoptedDelivery(task, root)).toBeNull();
        expect(folder.includes('hosted-deliveries')).toBe(true);
    } finally { rmSync(root, {recursive: true, force: true}); }
});
