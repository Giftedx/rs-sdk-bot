import { expect, test } from 'bun:test';
import { parseRun, parseTicks, row } from './pk-gang-climb';

test('a run is the RESULT line of the squad script, with the ticks of the bench table', () => {
    const run = parseRun('START 3093 3501 0\nRESULT ok squad accounts=4 kills=3 gangDied=3 died=0 taken=72 trips=4 picked={"385":2,"884":33}\n', 2, 580);
    expect(run).toEqual({ seed: 2, accounts: 4, kills: 3, gangDied: 3, died: 0, taken: 72, trips: 4, ticks: 580 });
    expect(parseRun('no result here', 1, null)).toBeNull();
});

test('the bench table gives the ticks of a case at each seed', () => {
    const ticks = parseTicks('case                         pass  seed 1  seed 2  seed 3\n---\nextra:clone-squad-4-chainbind-x1   2/3     580    FAIL     611\n');
    expect(ticks.get('extra:clone-squad-4-chainbind-x1')).toEqual([580, null, 611]);
});

test('a row sums its runs: the cost of a kill, and the kills of an hour with the wait for a dead gang account', () => {
    const r = row('size', 'extra:clone-squad-4-chainbind-x1', [
        { seed: 1, accounts: 4, kills: 3, gangDied: 3, died: 0, taken: 120, trips: 4, ticks: 600 },
        { seed: 2, accounts: 4, kills: 2, gangDied: 2, died: 0, taken: 180, trips: 4, ticks: 800 },
        { seed: 3, accounts: 4, kills: 3, gangDied: 3, died: 1, taken: 100, trips: 4, ticks: 700 },
    ], 1154);
    expect(r).toMatchObject({ kills: 8, gang: 9, deaths: 1, hpAKill: 50, ticksARun: 700, accountTicksAKill: 1050, coinsAKill: 750 });
    // 8 kills in 3 runs, each run 700 ticks and a wait of 1,154 ticks: 9,000 * (8 / 3) / 1,854.
    expect(r.killsAnHour).toBe(12.9);
});
