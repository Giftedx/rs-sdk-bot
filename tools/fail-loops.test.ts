import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorKey, failLoops, loopLines, readRecentResults, type ResultRow } from './fail-loops';

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
