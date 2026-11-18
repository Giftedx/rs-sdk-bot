import {expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deliveryFolder, pickRun} from '../src/adopt-proofs';

test('pickRun takes the newest successful finished run of the commit only', () => {
    const a = 'a'.repeat(40), b = 'b'.repeat(40);
    const runs = [
        {databaseId: 5, headSha: a, conclusion: 'failure', status: 'completed'},
        {databaseId: 4, headSha: a, conclusion: 'success', status: 'completed'},
        {databaseId: 3, headSha: a, conclusion: 'success', status: 'completed'},
        {databaseId: 9, headSha: b, conclusion: 'success', status: 'completed'},
        {databaseId: 8, headSha: a, conclusion: null, status: 'in_progress'},
    ];
    expect(pickRun(runs, a)?.databaseId).toBe(4);
    expect(pickRun(runs, 'c'.repeat(40))).toBeNull();
    expect(pickRun([runs[0]!, runs[4]!], a)).toBeNull();
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
