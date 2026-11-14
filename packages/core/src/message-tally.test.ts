import { describe, expect, test } from 'bun:test';
import { messageTally, type TallyMessage } from './message-tally';

const WINDOW = 50;
// A client window: the last 50 of all messages sent so far.
function client() {
    const all: TallyMessage[] = [];
    let id = 0;
    return {
        send: (text: string, tick: number, shared = false) => all.push({ type: 0, text, tick, observationId: shared ? id : ++id }),
        window: () => all.slice(-WINDOW),
    };
}

describe('messageTally', () => {
    test('a count keeps rising after the window is full', () => {
        const c = client(), t = messageTally(c.window);
        for (let i = 0; i < WINDOW; i++) c.send(i % 10 === 0 ? 'After some tinkering you manage to fix it.' : `filler ${i}`, i);
        t.pull();
        const before = t.count(/manage to fix it/);
        // The oldest message (a fix line) drops out as the new fix line comes in: the window count stays at 5.
        c.send('After some tinkering you manage to fix it.', WINDOW);
        expect(c.window().filter(m => /manage to fix it/.test(m.text)).length).toBe(before);
        expect(t.count(/manage to fix it/)).toBe(before + 1);
    });

    test('a message read twice counts once', () => {
        const c = client(), t = messageTally(c.window);
        c.send('You inspect the multi cannon.', 1);
        expect(t.count(/inspect/)).toBe(1);
        expect(t.count(/inspect/)).toBe(1);
    });

    test('two equal messages in one publication count twice', () => {
        const c = client(), t = messageTally(c.window);
        c.send('Maybe you should try again.', 1);
        c.send('Maybe you should try again.', 1, true);
        expect(t.count(/try again/)).toBe(2);
    });

    test('without observationId, equal messages of one tick count by place', () => {
        const rows: TallyMessage[] = [{ type: 0, text: 'a', tick: 3 }];
        const t = messageTally(() => rows);
        expect(t.count(/^a$/)).toBe(1);
        rows.push({ type: 0, text: 'a', tick: 3 });
        expect(t.count(/^a$/)).toBe(2);
    });

    test('other message types are not counted', () => {
        const t = messageTally(() => [{ type: 2, text: 'fix it', tick: 1, observationId: 1 }]);
        expect(t.count(/fix it/)).toBe(0);
    });
});
