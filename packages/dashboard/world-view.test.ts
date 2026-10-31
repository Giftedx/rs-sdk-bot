import { expect, test } from 'bun:test';
import { contentionView, hiscoreRows, lookupView, rivalsView, rosterView } from './world-view';

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
    expect(lookupView('Zezima', [], 7, roster.get('zezima'), now)).toEqual({ name: 'Zezima', at: 7, rows: [], online: true, x: 2585, z: 3300, plane: 0, combat: 99, lastSeen: now - 1000 });
    expect(lookupView('Nobody', null, null, undefined, now).online).toBe(false);
});
