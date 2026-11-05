import { test, expect } from 'bun:test';
import { parseBoard, boardGaps } from '../src/scout';

const span = (t: number, s: string) => `<span title="${t.toLocaleString()} ticks" style="font-variant-numeric: tabular-nums">${s}</span>`;
const PAGE = `<html><body><table><tr>
<td>1<br>
2<br>
</td><td><a href="/hiscores/player/stunbaron?profile=main" class="c">stunbaron</a><br>
<a href="/hiscores/player/claudefable5?profile=main" class="c">claudefable5</a><br>
</td><td>99<br>
98<br>
</td><td>${span(35912, '2h 59m 33s')}<br>
${span(670400, '55h 52m 00s')}<br>
</td></tr></table></body></html>`;

test('parseBoard reads rank, name, level and exact ticks from the title attribute', () => {
    expect(parseBoard(PAGE)).toEqual([
        { rank: 1, name: 'stunbaron', level: 99, ticks: 35912 },
        { rank: 2, name: 'claudefable5', level: 98, ticks: 670400 },
    ]);
});

test('target snapshots require a readable leader and explicit matching tick units', () => {
    const normalized = PAGE.replaceAll(' ticks"', ' ticks normalized to 400 ms per tick"');
    expect(parseBoard(normalized, 400)).toEqual(parseBoard(PAGE));
    expect(() => parseBoard(PAGE, 400)).toThrow('400 ms');
    expect(() => parseBoard(normalized.replace('400 ms', '300 ms'), 400)).toThrow('400 ms');
    expect(() => parseBoard(normalized.replace('>1<br>', '>2<br>'), 400)).toThrow('leader');
    expect(() => parseBoard('<html>Board unavailable</html>', 400)).toThrow('leader');
});
test('boardGaps ranks boards by how much faster our plan is than the current #1', () => {
    const gaps = boardGaps([
        { board: 'fishing', leader: { rank: 1, name: 'a', level: 99, ticks: 20_000 }, ourTicks: 10_000 },
        { board: 'mining', leader: { rank: 1, name: 'b', level: 99, ticks: 9_000 }, ourTicks: 10_000 },
        { board: 'cooking', leader: null, ourTicks: 5_000 },
    ]);
    expect(gaps.map(g => [g.board, g.winnable, g.marginTicks])).toEqual([
        ['cooking', true, Infinity],
        ['fishing', true, 10_000],
        ['mining', false, -1_000],
    ]);
});
