import { expect, test } from 'bun:test';
import { parseSquadLog, run1Fidelity, runTable } from './pk-gang-run1';

const log = (taken: number[], kills: number, kt: number[]) => [
    ...kt.map(t => `[a] PK kill Goondelf after ${t} ticks`),
    ...taken.map((t, i) => `SQUAD ${JSON.stringify({ name: `m${i}`, fights: 3, kills: 0, taken: t, died: false })}`),
    `RESULT ok squad accounts=${taken.length} kills=${kills} killReceipts=${kills} receiptDomain=practice died=0 taken=${taken.reduce((a, b) => a + b, 0)} trips=4`,
].join('\n');

test('the measures of a squad log: kills, Hitpoints lost a kill, kill ticks and the members that lost Hitpoints', () => {
    const r = parseSquadLog(log([74, 117, 0, 0], 3, [66, 33, 81]));
    expect(r).toMatchObject({ kills: 3, taken: 191, hpAKill: 64, killTicks: [66, 33, 81], meanKillTicks: 60, takenBy: [74, 117, 0, 0], membersHit: 2, deaths: 0 });
    // A run with a death of ours reads RESULT fail died squad.
    expect(parseSquadLog('RESULT fail died squad accounts=3 kills=1 died=1 taken=136 trips=3')).toMatchObject({ kills: 1, taken: 136, deaths: 1 });
});

test('the table gives the error of the bench mean against the live run', () => {
    const live = parseSquadLog(log([181, 98, 0, 0], 5, [54, 37, 27, 22, 28]));
    const rows = runTable(live, [parseSquadLog(log([74, 117, 0, 0], 3, [66, 33, 81])), parseSquadLog(log([79, 104, 0, 0], 3, [53, 59, 64]))]);
    expect(rows).toContain('| Hitpoints lost a kill | 56 | 62.5 | +12% |');
    expect(rows).toContain('| members that lost Hitpoints | 2 | 2 | +0% |');
});

test('the fidelity band: a replay that goes soft by half again, hits no member or kills too little is refused', () => {
    expect(run1Fidelity(log([74, 117, 0, 0], 3, [66, 33, 81]))).toBeNull();
    // 15 Hitpoints a kill is soft: below the 28 of the band (half the live 56).
    expect(run1Fidelity(log([20, 25, 0, 0], 3, [60, 60, 60]))).toContain('outside 28 to 112');
    expect(run1Fidelity(log([300, 100, 0, 0], 3, [60, 60, 60]))).toContain('outside 28 to 112');
    // One kill gives no verdict on the Hitpoints; no kill is a failure.
    expect(run1Fidelity(log([300, 85, 0, 0], 1, [60]))).toBeNull();
    expect(run1Fidelity(log([60, 60, 0, 0], 0, []))).toBe('no kill');
    expect(run1Fidelity(log([60, 60, 60, 60], 3, [60, 60, 60]), { hpAKill: [28, 112], kills: 2, membersHit: [1, 3] })).toContain('members hit 4');
});
