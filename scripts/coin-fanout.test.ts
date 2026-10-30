import { expect, test } from 'bun:test';
import { parseFanout } from './coin-fanout';

test('one donor, several receivers, each named once', () => {
    const f = parseFanout(['Pocketpython', 'Shaftmaker', 'YewFirst', '20000']);
    expect(f.receivers).toEqual(['Shaftmaker', 'YewFirst']);
    expect(f.pairs.map(p => [p.donor, p.receiver, p.amount])).toEqual([['Pocketpython', 'Shaftmaker', 20000], ['Pocketpython', 'YewFirst', 20000]]);
    expect(() => parseFanout(['A', 'A', '10'])).toThrow();
    expect(() => parseFanout(['A', '10'])).toThrow();
});
