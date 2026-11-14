import { expect, test } from 'bun:test';
import { pickEnemy } from './pk-team';

test('pickEnemy: pair takes its own enemy while in view, else the lowest bar; near the nearest', () => {
    const live = [{ f: 'a', p: { distance: 1 }, h: 0.9 }, { f: 'b', p: { distance: 3 }, h: 0.2 }, { f: 'c', p: { distance: 2 }, h: 0.5 }];
    const health = (x: { h: number }) => x.h;
    expect(pickEnemy(live, 'c', 'pair', health)?.f).toBe('c');
    expect(pickEnemy(live, 'd', 'pair', health)?.f).toBe('b');
    expect(pickEnemy(live, 'c', 'low', health)?.f).toBe('b');
    expect(pickEnemy(live, 'c', 'near', health)?.f).toBe('a');
    expect(pickEnemy([], 'c', 'pair', health)).toBeUndefined();
});
