import { expect, test } from 'bun:test';
import { settle } from '../src/bot';
import type { Session } from '../src/inprocess';
import { tickWaits } from '../src/tick-stream';

test('an old settled session cannot hide a new owned session or its prior failure', async () => {
    const closed: string[] = [], lines: string[] = [];
    const session = (name: string) => ({ name, ended: Promise.resolve({ reason: 'logged-out' }), close: async () => { closed.push(name); } }) as unknown as Session;
    const first = session('first'), next = session('next');
    expect(await settle([first], false, 'first failed', { log: line => lines.push(line) })).toBe(false);
    expect(await settle([first, next], true, 'both ended', { log: line => lines.push(line) })).toBe(false);
    expect(closed).toEqual(['first', 'next']);
    expect(lines.filter(line => line.startsWith('RESULT')).at(-1)).toBe('RESULT fail both ended');
});

test('settle restores tickWaits.active on both normal completion and logout error', async () => {
    const before = tickWaits.active;
    const okSession = { name: 'okbot', ended: Promise.resolve({ reason: 'logged-out' }), close: async () => {} } as unknown as Session;
    expect(await settle([okSession], true, 'done', { log: () => {}, logout: async () => 'logged-out' })).toBe(true);
    expect(tickWaits.active).toBe(before);

    const errSession = { name: 'errbot', ended: Promise.resolve({ reason: 'disconnected' }), close: async () => {} } as unknown as Session;
    await expect(settle([errSession], true, 'boom', {
        log: () => {},
        logout: async () => { throw Error('logout exploded'); },
    })).rejects.toThrow('logout exploded');
    expect(tickWaits.active).toBe(before);
});
