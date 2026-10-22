import { test, expect } from 'bun:test';
import { startReflexes } from '../src/reflex';
import { fakeGame } from './fakegame';

const rules = { eatBelowHp: 5, fleeBelowHp: 3, foods: /shrimps/i, safeTile: { x: 3222, z: 3218, level: 0 } };

test('the reflex eats when HP is low and food exists', async () => {
    const g = fakeGame({ x: 0, z: 0, level: 0, hp: 10, inventory: [{ slot: 0, id: 315, name: 'Shrimps', count: 1 }] });
    const r = startReflexes(g as any, rules);
    g.setHp(4);
    await Bun.sleep(20);
    r.stop(); g.stop();
    expect(g.calls).toContain('eat');
    expect(r.aborted.aborted).toBe(false);
});

test('the reflex aborts and flees when HP is very low and there is no food', async () => {
    const g = fakeGame({ x: 0, z: 0, level: 0, hp: 10 });
    const r = startReflexes(g as any, rules);
    g.setHp(2);
    await Bun.sleep(20);
    r.stop(); g.stop();
    expect(r.aborted.aborted).toBe(true);
    expect(g.calls).toContain('walk 3222,3218');
});

test('missing Hitpoints state counts as unknown, not as full health: the reflex still flees', async () => {
    const g = fakeGame({ x: 0, z: 0, level: 0, hp: 10 });
    g.state.skills = []; // no Hitpoints entry
    const r = startReflexes(g as any, rules);
    await Bun.sleep(20);
    r.stop(); g.stop();
    expect(r.aborted.aborted).toBe(true);
});
