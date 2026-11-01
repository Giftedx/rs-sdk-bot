import { expect, test } from 'bun:test';
import { contentionView, farmsView, hiscoreRows, lookupView, overtakeView, rivalsView, rosterView, valueBoardRows } from './world-view';

const now = 1_000_000;
const roster = new Map([
    ['zezima', { name: 'Zezima', x: 2585, z: 3300, level: 0, combat: 99, seen: now - 1000 }],
    ['mybot', { name: 'MyBot', x: 2583, z: 3296, level: 0, combat: 40, seen: now - 2000 }],
    ['upstairs', { name: 'Upstairs', x: 2582, z: 3297, level: 1, combat: 10, seen: now - 1000 }],
    ['gone', { name: 'Gone', x: 2582, z: 3297, level: 0, combat: 10, seen: now - 60_000 }],
]);
const fleet = new Set(['mybot']);

test('hiscore player rows keep skill boards above level 1', () => {
    const html = '<td>Overall</td> <td>12</td> <td>1,881</td> <td>3h 58m 1s</td> <td>Attack</td> <td>1,234</td> <td>75</td> <td>3h 2m 1s</td> <td>Defence</td> <td>9</td> <td>1</td> <td>5s</td>';
    expect(hiscoreRows(html, ['Overall', 'Attack', 'Defence', 'Magic'])).toEqual([{ board: 'Overall', rank: 12, level: 1881, time: '3h 58m 1s' }, { board: 'Attack', rank: 1234, level: 75, time: '3h 2m 1s' }]);
});
test('the roster lists players seen in the last 30 seconds', () => {
    expect(rosterView(roster, now).map(r => r[0])).toEqual(['MyBot', 'Upstairs', 'Zezima']);
    expect(rosterView(roster, now)[2]).toEqual(['Zezima', 2585, 3300, 0, 99]);
});
test('rivals mark fleet accounts, online players and their tile', () => {
    const v = rivalsView(new Map([['Attack', { at: 5, rows: [{ rank: 1, name: 'Zezima', level: 99, ticks: 100 }, { rank: 2, name: 'MyBot', level: 90, ticks: 200 }, { rank: 3, name: 'Gone', level: 80, ticks: 300 }] }]]), roster, fleet, new Map([['Attack', { rank: 2, name: 'MyBot' }]]), now);
    expect(v[0]!.ours).toEqual({ rank: 2, name: 'MyBot' });
    expect(v[0]!.rows.map(r => [r.name, r.fleet, r.online, r.x])).toEqual([['Zezima', false, true, 2585], ['MyBot', true, true, 2583], ['Gone', false, false, null]]);
});
test('spot contention counts other players near a claimed tile on the ground floor only', () => {
    const v = contentionView([{ side: 'local', resources: ['knight:2582,3297', 'shop:aubury'] }, { bad: 1 }], roster, fleet, now);
    expect(v[0]).toEqual({ side: 'local', resource: 'knight:2582,3297', kind: 'knight', x: 2582, z: 3297, others: ['Zezima'], ours: ['MyBot'] });
    expect(v[1]).toEqual({ side: 'local', resource: 'shop:aubury', kind: 'shop', x: null, z: null, others: [], ours: [] });
});
test('a lookup carries the hiscore rows and the last world-feed sighting', () => {
    expect(lookupView('Zezima', [], 7, roster.get('zezima'), now)).toEqual({ name: 'Zezima', at: 7, rows: [], online: true, x: 2585, z: 3300, plane: 0, combat: 99, lastSeen: now - 1000, worn: null, wornAt: null });
    expect(lookupView('Zezima', [], 7, roster.get('zezima'), now, [{ slot: 'Weapon', name: 'Bronze sword' }], 8)).toMatchObject({ worn: [{ slot: 'Weapon', name: 'Bronze sword' }], wornAt: 8 });
    expect(lookupView('Nobody', null, null, undefined, now).online).toBe(false);
});

test('farms group numbered series and random names, without fleet accounts, and count them at our spots', () => {
    const r = new Map<string, any>([
        ...[1, 2, 3, 40].map(i => [`money ${i}`, { name: `Money ${String(i).padStart(2, '0')}`, x: 2660, z: 3300, level: 0, combat: 3, seen: now }] as [string, any]),
        ...['671nb2fxy', '6728br6td', '67297mfwb'].map(n => [n, { name: n, x: 1, z: 2, level: 0, combat: 3, seen: now }] as [string, any]),
        ['mmthv2350', { name: 'mmthv2350', x: 1, z: 2, level: 0, combat: 3, seen: now }], ['solo1', { name: 'Solo1', x: 1, z: 2, level: 0, combat: 3, seen: now }],
    ]);
    const f = farmsView(r, new Set(['mmthv2350']), [{ resource: 'knight:2660,3300', others: ['Money 01', 'Money 02', 'Zed'] }], now);
    expect(f.map(g => [g.label, g.count])).toEqual([['Money ##', 4], ['67… (9 characters, random)', 3]]);
    expect(f[0]!.range).toEqual([1, 40]);expect(f[0]!.atSpots).toEqual([{ resource: 'knight:2660,3300', count: 2 }]);
    expect(f.flatMap(g => g.names)).not.toContain('mmthv2350');
});
test('overtake gives the XP and hours to pass the next rows; a 99 that is slower needs a new account', () => {
    const xpFor = (l: number) => l * 1000;
    const tops = new Map([['Attack', { rows: [{ rank: 1, name: 'Top', level: 99, ticks: 9000 }, { rank: 2, name: 'Next', level: 80, ticks: 5000 }, { rank: 3, name: 'Same', level: 70, ticks: 100 }] }], ['Overall', { rows: [] }]]);
    const acct = { name: 'Mine', skills: [{ name: 'Attack', level: 70, xp: 70_500 }], ranks: [{ board: 'Attack', rank: 4, level: 70, time: '1h 0m 0s' }], goalSkill: 'Attack', xpPerHour: 4750 };
    const [v] = overtakeView(tops, [acct], xpFor);
    expect([v.board, v.account, v.rank, v.seconds, v.xpPerHour]).toEqual(['Attack', 'Mine', 4, 3600, 4750]);
    expect(v.targets.map((x: any) => [x.rank, x.newAccount, x.goal, x.xpNeeded, x.hours])).toEqual([[3, false, 71, 500, 500 / 4750], [1, true, null, null, null]]);
    const maxed = overtakeView(tops, [{ ...acct, skills: [{ name: 'Attack', level: 99, xp: 99_000 }], ranks: [{ board: 'Attack', rank: 2, level: 99, time: '9h 0m 0s' }] }], xpFor)[0];
    expect(maxed.targets).toEqual([{ rank: 1, name: 'Top', level: 99, seconds: 3600, newAccount: true, goal: null, xpNeeded: null, hours: null, deadline: null }]);
    // Our 1 h of board time is already over theirs (800 s): level 80 does not pass them, 81 does; a 99 we are slower than needs a new account.
    const slow = overtakeView(new Map([['Attack', { rows: [{ rank: 1, name: 'Top', level: 99, ticks: 7500 }, { rank: 2, name: 'Quick', level: 80, ticks: 2000 }] }]]), [acct], xpFor)[0];
    expect(slow.targets.map((x: any) => [x.name, x.goal, x.newAccount])).toEqual([['Quick', 81, false], ['Top', null, true]]);
    // With time to spare, their level is enough, before the deadline: 10 XP at 4,750 XP/hr is about 8 s; 2 h are left.
    const roomy = overtakeView(new Map([['Attack', { rows: [{ rank: 1, name: 'Far', level: 71, ticks: 27000 }] }]]), [{ ...acct, skills: [{ name: 'Attack', level: 70, xp: 70_990 }] }], xpFor)[0].targets[0];
    expect([roomy.goal, roomy.xpNeeded, roomy.deadline]).toEqual([71, 10, 7200]);
    expect(overtakeView(tops, [{ ...acct, goalSkill: 'Mining' }], xpFor)[0].targets[1].hours).toBeNull();
});

test('value boards: rank, name and exact value per row; only the first table (Runite adds This week and Today)', () => {
    const row = (rank: number, name: string, cell: string, img = '') => `<tr>\n<td align="right">${rank}</td>\n${img}<td><a href="/hiscores/player/${name}?profile=main" class="c">${name}</a></td>\n${cell}\n</tr>`;
    const outfit = row(1, 'soko', '<td align="right" class="yellow" title="1,366,450 gp">1366K</td>', '<td><img src="/sprite/player/x.png"></td>\n') + row(2, 'brotha', '<td align="right" class="yellow" title="1,149,713 gp">1149K</td>');
    expect(valueBoardRows('<table>' + outfit + '</table>')).toEqual([{ rank: 1, name: 'soko', value: 1366450, text: '1366K' }, { rank: 2, name: 'brotha', value: 1149713, text: '1149K' }]);
    const runite = row(1, 'xulvexi', '<td align="right" class="yellow">2,463</td>') + row(2, 'goo001', '<td align="right" class="yellow">1,948</td>') + row(1, 'ukwih8pbm', '<td align="right" class="yellow">338</td>');
    expect(valueBoardRows(runite).map(r => [r.rank, r.name, r.value])).toEqual([[1, 'xulvexi', 2463], [2, 'goo001', 1948]]);
});
