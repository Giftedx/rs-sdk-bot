import { expect, test } from 'bun:test';
import { parseRichRun, parseRun, parseSquadMetrics, parseTicks, richRow, row } from './pk-gang-climb';

test('a run is the RESULT line of the squad script, with the ticks of the bench table', () => {
    const run = parseRun('START 3093 3501 0\nRESULT ok squad accounts=4 kills=3 gangDied=3 died=0 taken=72 trips=4 picked={"385":2,"884":33}\n', 2, 580);
    expect(run).toEqual({ seed: 2, accounts: 4, kills: 3, gangDied: 3, died: 0, taken: 72, trips: 4, ticks: 580 });
    expect(parseRun('no result here', 1, null)).toBeNull();
    // A run with a death of ours is a run of the table too.
    expect(parseRun('RESULT fail died squad accounts=3 kills=1 gangDied=1 died=1 taken=136 trips=3 picked={"385":1,"884":6}', 6, 766)).toMatchObject({ kills: 1, died: 1, taken: 136, ticks: 766 });
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

test('parseSquadMetrics and richRow aggregate freeze rate, minHp, kill ticks, and supplies per kill', () => {
    const m1 = { accounts: 4, kills: 3, deaths: 0, taken: 120, trips: 4, avgKillTicks: 40, minHp: 61, sharksEaten: 3, karamEaten: 1, freezesCast: 4, freezesLanded: 3, escapes: 0 };
    const m2 = { accounts: 4, kills: 2, deaths: 0, taken: 80, trips: 4, avgKillTicks: 50, minHp: 42, sharksEaten: 2, karamEaten: 2, freezesCast: 2, freezesLanded: 1, escapes: 1 };
    const log1 = `SQUAD_METRICS ${JSON.stringify(m1)}\nRESULT ok squad accounts=4 kills=3 gangDied=3 died=0 taken=120 trips=4 picked={}\n`;
    const log2 = `SQUAD_METRICS ${JSON.stringify(m2)}\nRESULT ok squad accounts=4 kills=2 gangDied=2 died=0 taken=80 trips=4 picked={}\n`;
    expect(parseSquadMetrics('no metrics')).toBeNull();
    expect(parseSquadMetrics(log1)).toEqual(m1);
    const r1 = parseRichRun(log1, 1, 200)!;
    const r2 = parseRichRun(log2, 2, 250)!;
    const agg = richRow('b', 'c', [r1, r2], 1154);
    expect(agg).toMatchObject({
        kills: 5,
        deaths: 0,
        hpAKill: 40,
        avgKillTicks: 44,
        ticksPerKill: 44,
        minHp: 42,
        sharksEaten: 5,
        karamEaten: 3,
        freezesCast: 6,
        freezesLanded: 4,
        freezePct: 66.7,
        suppliesPerKill: 1.6,
        escapes: 1,
        hasMetrics: true,
    });
});
