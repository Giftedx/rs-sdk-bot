import {expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deliveryFolderOf, deliveryProblems, roundOriginProblems, safeFolder, type LocalFacts} from '../src/adopt-delivery';
import type {DeliveryTask} from '../src/delivery';
import type {RunView} from '../src/adopt-proofs';

const a = 'a'.repeat(40), b = 'b'.repeat(40), source = '1'.repeat(64), runtime = '2'.repeat(64), fileSha = '3'.repeat(64);
const task: DeliveryTask = {id: 'ammo-order', goal: 'Bank arrows', entry: 'scripts/ammo.ts', files: ['scripts/ammo.ts'], consumer: 'Ranged supply', checks: [
    {id: 'regression', phase: 'regression', command: ['bun', 'test'], timeoutMs: 1000},
    {id: 'native', phase: 'practice', command: ['bun', 'proof.ts'], timeoutMs: 1000},
    {id: 'banked', phase: 'consumer', command: ['bun', 'verify.ts'], timeoutMs: 1000}]};
const report = () => ({ok: true, stage: 'delivered', evidence: 'native', id: 'ammo-order', source, runtimeRevision: runtime, at: Date.now() - 1000,
    checks: task.checks.map(c => ({id: c.id, phase: c.phase, exitCode: 0, timedOut: false, detail: '{}'})), files: [{path: 'scripts/ammo.ts', sha256: fileSha}]});
const local = (over: Partial<LocalFacts> = {}): LocalFacts => ({source, runtime, task: structuredClone(task), fileSha: () => fileSha, hasLog: () => true, ...over});

test('a complete delivery of this checkout has no problem', () => {
    expect(deliveryProblems(report(), structuredClone(task), task, local())).toEqual([]);
});

test('each difference from this checkout refuses the delivery', () => {
    const cases: [string, () => string[]][] = [
        ['not complete', () => deliveryProblems({...report(), ok: false}, task, task, local())],
        ['not complete', () => deliveryProblems({...report(), stage: 'failed'}, task, task, local())],
        ['not complete', () => deliveryProblems({...report(), failedCheck: 'native'}, task, task, local())],
        ['not complete', () => deliveryProblems({...report(), hostDeferred: true}, task, task, local())],
        ['not complete', () => deliveryProblems({...report(), diagnostic: {checkId: 'native', complete: true}}, task, task, local())],
        ['a delivery of "magic-order"', () => deliveryProblems({...report(), id: 'magic-order'}, task, task, local())],
        // The source of the runner is not the source of this checkout: a code edit after the round.
        ['source differs', () => deliveryProblems(report(), task, task, local({source: '9'.repeat(64)}))],
        ['worker release differs', () => deliveryProblems(report(), task, task, local({runtime: '9'.repeat(64)}))],
        ['worker release differs', () => deliveryProblems(report(), task, task, local({runtime: null}))],
        ['task differs', () => deliveryProblems(report(), {...task, goal: 'other'}, task, local())],
        ['task differs', () => deliveryProblems(report(), task, task, local({task: {...task, checks: task.checks.slice(0, 2)}}))],
        ['completion time', () => deliveryProblems({...report(), at: Date.now() + 60_000}, task, task, local())],
        ['checks are not the checks', () => deliveryProblems({...report(), checks: report().checks.slice(0, 2)}, task, task, local())],
        ['checks are not the checks', () => deliveryProblems({...report(), checks: report().checks.map((c, i) => i === 1 ? {...c, exitCode: 1} : c)}, task, task, local())],
        ['checks are not the checks', () => deliveryProblems({...report(), checks: report().checks.map((c, i) => i === 1 ? {...c, timedOut: true} : c)}, task, task, local())],
        ['checks are not the checks', () => deliveryProblems({...report(), checks: [...report().checks].reverse()}, task, task, local())],
        ['check log is missing', () => deliveryProblems(report(), task, task, local({hasLog: name => name !== '1.err.log'}))],
        ['declared file differs', () => deliveryProblems(report(), task, task, local({fileSha: () => '9'.repeat(64)}))],
        ['declared file differs', () => deliveryProblems(report(), task, task, local({fileSha: () => null}))],
        ['declared file differs', () => deliveryProblems({...report(), files: []}, task, task, local())],
    ];
    for (const [text, run] of cases) { const problems = run(); expect(problems.length).toBeGreaterThanOrEqual(1); expect(problems.join('; ')).toContain(text); }
    for (const bad of [null, undefined, 'text', 7, [], {}]) expect(deliveryProblems(bad, task, task, local()).length).toBeGreaterThanOrEqual(4);
});

test('origin: a dispatch of the proof workflow on this branch, for this commit, with a successful job of this capability', () => {
    const good: RunView = {workflowName: 'Progression practice', event: 'workflow_dispatch', headBranch: 'master', headSha: a, status: 'completed', conclusion: 'failure',
        jobs: [{name: 'capability ammo-order', conclusion: 'success'}, {name: 'capability magic-order', conclusion: 'failure'}, {name: 'capability-plan', conclusion: 'success'}]};
    // The run as a whole failed, because another capability failed: this capability's job decides.
    expect(roundOriginProblems(good, a, 'master', 'ammo-order')).toEqual([]);
    expect(roundOriginProblems(good, a, 'master', 'magic-order')).toEqual(['its job "capability magic-order" is "failure", not success']);
    expect(roundOriginProblems(good, a, 'master', 'wine-order')).toEqual(['its job "capability wine-order" is missing, not success']);
    const refused: [Partial<RunView>, RegExp][] = [
        [{workflowName: 'CI'}, /not of "Progression practice"/], [{event: 'push'}, /not a dispatch/], [{event: 'pull_request'}, /not a dispatch/],
        [{headBranch: 'claude/feature'}, /this checkout is on "master"/], [{headSha: b}, /ran commit bbbbbbbbbb/], [{status: 'in_progress'}, /not completed/]];
    for (const [change, reason] of refused) { const problems = roundOriginProblems({...good, ...change}, a, 'master', 'ammo-order'); expect(problems).toHaveLength(1); expect(problems[0]).toMatch(reason); }
});

test('a folder name of an artifact cannot leave its artifact', () => {
    for (const ok of ['ammo-order-1794969132886-MYdVtO', 'deliveries/ammo-order-1', 'a.b_c-d']) expect(safeFolder(ok)).toBe(true);
    for (const bad of ['', '..', '.', 'a/..', '../a', 'a//b', '/a', 'a/', 'C:', 'a\\b', 'a b', 7, null]) expect(safeFolder(bad)).toBe(false);
});

test('deliveryFolderOf needs exactly one folder with a report and a task', () => {
    const root = mkdtempSync(join(tmpdir(), 'adopt-delivery-'));
    try {
        expect(deliveryFolderOf(root)).toBeNull();
        const one = join(root, 'ammo-order-1');
        mkdirSync(one);
        writeFileSync(join(one, 'report.json'), '{}');
        expect(deliveryFolderOf(root)).toBeNull();
        writeFileSync(join(one, 'task.json'), '{}');
        expect(deliveryFolderOf(root)).toBe(one);
        const two = join(root, 'deliveries', 'ammo-order-2');
        mkdirSync(two, {recursive: true});
        writeFileSync(join(two, 'report.json'), '{}');
        writeFileSync(join(two, 'task.json'), '{}');
        expect(deliveryFolderOf(root)).toBeNull();
    } finally { rmSync(root, {recursive: true, force: true}); }
});
