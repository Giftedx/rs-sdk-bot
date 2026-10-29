import { expect, test } from 'bun:test';
import { settle } from '../src/bot';
import type { Session } from '../src/inprocess';

test('an old settled session cannot hide a new owned session or its prior failure', async () => {
    const closed: string[] = [], lines: string[] = [];
    const session = (name: string) => ({ name, ended: Promise.resolve({ reason: 'logged-out' }), close: async () => { closed.push(name); } }) as unknown as Session;
    const first = session('first'), next = session('next');
    expect(await settle([first], false, 'first failed', { log: line => lines.push(line) })).toBe(false);
    expect(await settle([first, next], true, 'both ended', { log: line => lines.push(line) })).toBe(false);
    expect(closed).toEqual(['first', 'next']);
    expect(lines.filter(line => line.startsWith('RESULT')).at(-1)).toBe('RESULT fail both ended');
});
