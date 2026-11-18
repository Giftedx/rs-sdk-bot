import {expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {adoptArgs, deliveryFolder, originProblems, pickRun, type RunView} from '../src/adopt-proofs';

const a = 'a'.repeat(40), b = 'b'.repeat(40);

test('the run id is digits and the commit is a full hash: no value can name another folder', () => {
    expect(adoptArgs(['--run', '44258938641', '--commit', a, '--check'])).toEqual({run: '44258938641', commit: a, check: true});
    expect(adoptArgs([])).toEqual({check: false});
    for (const run of ['..', '../..', '.', '', '12/..', '12\\..', ' 12', '1e3', '-1', '12;rm', 'C:', '123456789012345678901']) expect(() => adoptArgs(['--run', run])).toThrow(/run id of digits/);
    expect(() => adoptArgs(['--run'])).toThrow(/run id of digits/);
    for (const commit of ['..', 'HEAD', a.slice(1), a.toUpperCase(), a + '0', 'master']) expect(() => adoptArgs(['--commit', commit])).toThrow(/full commit hash/);
    expect(() => adoptArgs(['--force'])).toThrow(/unknown argument/);
});

test('the folder that the tool clears stays inside .practice/hosted-proofs for every accepted run id', () => {
    const root = resolve('repo'), base = resolve(root, '.practice', 'hosted-proofs');
    for (const run of ['1', '44258938641', '00000000000000000000']) {
        const folder = join(root, '.practice', 'hosted-proofs', adoptArgs(['--run', run]).run!);
        expect(folder.startsWith(base + (process.platform === 'win32' ? '\\' : '/'))).toBe(true);
        expect(folder).not.toBe(base);
    }
});

test('origin: only a successful run of the proof workflow, for this commit, on this branch, with a successful qualification job', () => {
    const good: RunView = {workflowName: 'Progression practice', event: 'push', headBranch: 'master', headSha: a, status: 'completed', conclusion: 'success', jobs: [{name: 'qualification', conclusion: 'success'}, {name: 'ranged (7)', conclusion: 'skipped'}]};
    expect(originProblems(good, a, 'master')).toEqual([]);
    expect(originProblems({...good, event: 'workflow_dispatch'}, a, 'master')).toEqual([]);
    const refused: [Partial<RunView>, RegExp][] = [
        [{workflowName: 'CI'}, /not of "Progression practice"/],
        [{event: 'pull_request'}, /not a push or a dispatch/],
        [{event: 'workflow_run'}, /not a push or a dispatch/],
        [{headBranch: 'claude/feature'}, /ran on branch "claude\/feature" and this checkout is on "master"/],
        [{headSha: b}, /ran commit bbbbbbbbbb, not aaaaaaaaaa/],
        [{conclusion: 'failure'}, /not completed with success/],
        [{conclusion: 'cancelled'}, /not completed with success/],
        [{status: 'in_progress', conclusion: null}, /not completed with success/],
        [{jobs: [{name: 'qualification', conclusion: 'failure'}]}, /qualification job is "failure"/],
        [{jobs: [{name: 'ranged (7)', conclusion: 'success'}]}, /qualification job is missing/],
        [{jobs: [{name: 'qualification', conclusion: 'success'}, {name: 'qualification', conclusion: 'success'}]}, /qualification job is missing/],
    ];
    for (const [change, reason] of refused) { const problems = originProblems({...good, ...change}, a, 'master'); expect(problems).toHaveLength(1); expect(problems[0]).toMatch(reason); }
    // A proof made on a feature branch is taken only by a checkout on that branch, never by master.
    expect(originProblems({...good, headBranch: 'claude/feature'}, a, 'claude/feature')).toEqual([]);
    expect(originProblems({}, a, 'master').length).toBeGreaterThanOrEqual(5);
});

test('pickRun takes the newest successful finished run of the commit on the branch only', () => {
    const row = (databaseId: number, over: object = {}) => ({databaseId, headSha: a, conclusion: 'success', status: 'completed', event: 'push', headBranch: 'master', ...over});
    const runs = [row(5, {conclusion: 'failure'}), row(4), row(3), row(9, {headSha: b}), row(8, {conclusion: null, status: 'in_progress'}), row(7, {headBranch: 'claude/feature'}), row(6, {event: 'pull_request'})];
    expect(pickRun(runs, a, 'master')?.databaseId).toBe(4);
    expect(pickRun(runs, a, 'claude/feature')?.databaseId).toBe(7);
    expect(pickRun(runs, 'c'.repeat(40), 'master')).toBeNull();
    expect(pickRun([runs[0]!, runs[4]!], a, 'master')).toBeNull();
});

test('deliveryFolder needs exactly one delivery with a report and a method proof pointer', () => {
    const root = mkdtempSync(join(tmpdir(), 'adopt-'));
    try {
        expect(deliveryFolder(root)).toBeNull();
        const one = join(root, 'deliveries', 'ranged-train-1');
        mkdirSync(one, {recursive: true});
        writeFileSync(join(one, 'report.json'), '{}');
        expect(deliveryFolder(root)).toBeNull();
        writeFileSync(join(one, 'ranged-adaptive-proof.json'), '{}');
        expect(deliveryFolder(root)).toBe(one);
        const two = join(root, 'deliveries', 'ranged-train-2');
        mkdirSync(two);
        writeFileSync(join(two, 'report.json'), '{}');
        writeFileSync(join(two, 'ranged-adaptive-proof.json'), '{}');
        expect(deliveryFolder(root)).toBeNull();
    } finally { rmSync(root, {recursive: true, force: true}); }
});
