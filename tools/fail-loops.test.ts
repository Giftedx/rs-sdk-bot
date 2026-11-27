import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crossAccountFaults, crossAccountLines, errorKey, failLoops, loopLines, readRecentResults, type ResultRow } from './fail-loops';

const now = 1_800_000_000_000;
const run = (name: string, endAgo: number, secs: number, text: string, ok = false, goal = 'headless arrows'): ResultRow =>
    ({ name, goal, ok, text, at: now - endAgo, started: now - endAgo - secs * 1000 });

test('errorKey drops the fail prefix and reads numbers as #', () => {
    expect(errorKey('fail Error: headless BANK_PACK: bank did not open')).toBe('Error: headless BANK_PACK: bank did not open');
    expect(errorKey('RESULT fail {"loots":0,"ticks":6}')).toBe('{"loots":#,"ticks":#}');
});

test('three short failed runs with one error on one account are a loop; long, old, passed or mixed runs are not', () => {
    const bank = 'fail Error: headless BANK_PACK: bank did not open';
    const rows = [run('Shaftmaker', 60_000, 3, bank), run('Shaftmaker', 120_000, 5, bank), run('Shaftmaker', 180_000, 3, bank),
        // A long run, an old run, a passed run and another account do not count.
        run('BowBeforeMe', 60_000, 300, bank), run('BowBeforeMe', 3 * 3600_000, 3, bank), run('BowBeforeMe', 90_000, 3, 'RESULT ok', true),
        run('BowBeforeMe', 100_000, 3, bank), run('BowBeforeMe', 110_000, 3, bank)];
    const loops = failLoops(rows, now);
    expect(loops).toEqual([{ name: 'Shaftmaker', goal: 'headless arrows', error: 'Error: headless BANK_PACK: bank did not open', runs: 3, medianSec: 3, lastAt: now - 60_000 }]);
    expect(loopLines(loops)).toEqual(['Shaftmaker 3x 3 s: headless arrows | Error: headless BANK_PACK: bank did not open']);
    // Two errors on one account are two groups, each under the run count.
    expect(failLoops([run('A', 1, 3, 'fail x'), run('A', 2, 3, 'fail y'), run('A', 3, 3, 'fail x')], now)).toEqual([]);
    // A row with no start time proves no run length.
    expect(failLoops([{ name: 'A', ok: false, text: 'fail x', at: now }, { name: 'A', ok: false, text: 'fail x', at: now }, { name: 'A', ok: false, text: 'fail x', at: now }], now)).toEqual([]);
});

test('readRecentResults reads the tail and skips a cut first line and bad lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fail-loops-')), file = join(dir, 'results.jsonl');
    writeFileSync(file, [JSON.stringify({ name: 'Old', text: 'x'.repeat(200) }), 'not json', JSON.stringify({ name: 'New', ok: false }), ''].join('\n'));
    expect(readRecentResults(file).map(r => r.name)).toEqual(['Old', 'New']);
    expect(readRecentResults(file, 40).map(r => r.name)).toEqual(['New']);
    expect(readRecentResults(join(dir, 'missing.jsonl'))).toEqual([]);
});

test('an error that ends short runs of three accounts in 24 h is a cross-account fault, whatever the goal', () => {
    const tree = 'fail quest-sweep tree missing 2434:2 (unsold; others in shops)';
    const rows = [run('Fatstack', 60_000, 20, tree, false, 'goal:quest_board:tree'), run('Fingerblastr', 7200_000, 7, tree, false, 'goal:quest_board:tree'),
        run('Earlyshooter', 20 * 3600_000, 22, tree.replace('2434:2', '2434:3'), false, 'goal:quest_board:arena'),
        // A long run, a run older than 24 h and a passed run do not count; two accounts are not enough.
        run('Billionaire', 60_000, 300, tree), run('Billionaire', 25 * 3600_000, 5, tree), run('Billionaire', 90_000, 5, 'RESULT ok', true),
        run('A', 1, 3, 'fail x'), run('B', 2, 3, 'fail x')];
    const faults = crossAccountFaults(rows, now);
    expect(faults).toEqual([{ error: 'quest-sweep tree missing #:# (unsold; others in shops)', runs: 3, accounts: 3, goals: 2, lostSec: 49, lastAt: now - 60_000 }]);
    expect(crossAccountLines(faults)).toEqual(['3x on 3 accounts, 2 goals, 49 s in runs: quest-sweep tree missing #:# (unsold; others in shops)']);
});
