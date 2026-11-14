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

test('squadTarget takes the lowest bar of the targets in view, not a skipped one', async () => {
    const { squadTarget } = await import('./pk-squad');
    const view = [{ name: 'Goondelf', index: 1, distance: 2 }, { name: 'Ligma', index: 2, distance: 5 }, { name: 'Bystander', index: 3, distance: 1 }];
    const bars: Record<number, number> = { 1: 0.8, 2: 0.3, 3: 0.1 };
    const targets = new Set(['goondelf', 'ligma', 'sugma']);
    expect(squadTarget(view, targets, p => bars[p.index]!)?.name).toBe('Ligma');
    expect(squadTarget(view, targets, p => bars[p.index]!, new Set(['ligma']))?.name).toBe('Goondelf');
    expect(squadTarget([view[2]!], targets, p => bars[p.index]!)).toBeUndefined();
});
