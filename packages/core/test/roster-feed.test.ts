import { expect, test } from 'bun:test';
import { RosterFeed } from '../src/roster-feed';

test('a change frame becomes a full frame: slots leave, rows join or change, players move', () => {
    const feed = new RosterFeed();
    const first = { t: 'roster', k: 10, p: [[1, 'Ann', 3200, 3200, 0, 3], [2, 'Bob', 3210, 3210, 0, 50], [3, 'Cat', 3220, 3220, 1, 126]], npcs: 9 };
    expect(feed.expand(first)).toBe(first);
    const next: any = feed.expand({ t: 'roster', k: 20, d: 1, lv: [2], j: [[4, 'Dan', 3000, 3000, 0, 10], [3, 'Cat', 3220, 3220, 1, 100]], m: [[1, 3201, 3202, 2], [9, 1, 1, 0]], npcs: 8 });
    expect(next).toEqual({ t: 'roster', k: 20, p: [[1, 'Ann', 3201, 3202, 2, 3], [3, 'Cat', 3220, 3220, 1, 100], [4, 'Dan', 3000, 3000, 0, 10]], npcs: 8 });
    expect(first.p[0]).toEqual([1, 'Ann', 3200, 3200, 0, 3]);
    next.p[0][2] = 0;
    expect((feed.expand({ t: 'roster', k: 30, d: 1, lv: [], j: [], m: [] }) as any).p[0]).toEqual([1, 'Ann', 3201, 3202, 2, 3]);
});

test('a full frame replaces the rows; other messages and a change frame with no full frame stay as they are', () => {
    const feed = new RosterFeed(), tick = { t: 'tick', p: [] }, early = { t: 'roster', k: 5, d: 1, lv: [], j: [], m: [] };
    expect(feed.expand(tick)).toBe(tick);
    expect(feed.expand(early)).toBe(early);
    feed.expand({ t: 'roster', k: 10, p: [[1, 'Ann', 1, 1, 0, 3]] });
    feed.expand({ t: 'roster', k: 20, p: [[7, 'Eve', 2, 2, 0, 4]] });
    expect((feed.expand({ t: 'roster', k: 30, d: 1, m: [[7, 5, 6, 0]] }) as any).p).toEqual([[7, 'Eve', 5, 6, 0, 4]]);
});

test('a move row with a fifth value changes the combat level', () => {
    const feed = new RosterFeed();
    feed.expand({ t: 'roster', k: 1, p: [[2, 'Bob', 1, 1, 0, 50]] });
    expect((feed.expand({ t: 'roster', k: 2, d: 1, m: [[2, 1, 1, 0, 51]] }) as any).p).toEqual([[2, 'Bob', 1, 1, 0, 51]]);
});
