import { test, expect } from 'bun:test';
import { checked, xpGained, atTile, levelIs, invGained } from '../src/act';
import { fakeSession, at } from './fake';

const wc = (xp: number) => [{ name: 'Woodcutting', level: 1, baseLevel: 1, experience: xp }];

test('checked succeeds when the effect appears on tick 2', async () => {
    const s = fakeSession([at(0, 0), at(0, 0), at(0, 0, 0, { skills: wc(25) })]);
    const p = checked(s as any, { name: 'chop', send: async () => {}, effect: xpGained('Woodcutting'), timeoutTicks: 10 });
    await s.run(3);
    expect(await p).toEqual({ ok: true, ticks: 2 });
});

test('a silent server refusal is reported as rejected, not timeout', async () => {
    const s = fakeSession([at(0, 0), at(0, 0, 0, { opFeedback: { opRejectedCount: 1 } })]);
    const p = checked(s as any, { name: 'chop', send: async () => {}, effect: xpGained('Woodcutting'), timeoutTicks: 10 });
    await s.run(2);
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('rejected');
});

test('a failed precondition never calls send', async () => {
    const s = fakeSession([at(0, 0)]);
    let sent = false;
    const r = await checked(s as any, { name: 'chop', pre: () => 'no axe', send: async () => { sent = true; }, effect: () => true, timeoutTicks: 5 });
    expect(r).toMatchObject({ ok: false, reason: 'precondition', detail: 'no axe' });
    expect(sent).toBe(false);
});

test('no effect within the budget is a timeout', async () => {
    const s = fakeSession([at(0, 0)]);
    const p = checked(s as any, { name: 'chop', send: async () => {}, effect: xpGained('Woodcutting'), timeoutTicks: 3 });
    await s.run(4);
    expect(await p).toMatchObject({ ok: false, reason: 'timeout' });
});

test('an abort signal ends the action as aborted', async () => {
    const s = fakeSession([at(0, 0)]);
    const ac = new AbortController();
    const p = checked(s as any, { name: 'chop', send: async () => {}, effect: xpGained('Woodcutting'), timeoutTicks: 50, signal: ac.signal });
    await s.run(1);
    ac.abort('reflex');
    await s.run(1);
    expect(await p).toMatchObject({ ok: false, reason: 'aborted' });
});

test('effect helpers read tiles, levels and inventory', () => {
    const before = at(0, 0) as any;
    expect(atTile(3, 4, 0, 1)(before, at(3, 5) as any)).toBe(true);
    expect(atTile(3, 4, 0, 1)(before, at(3, 6) as any)).toBe(false);
    expect(levelIs(1)(before, at(0, 0, 1) as any)).toBe(true);
    expect(invGained(/logs/i)(before, at(0, 0, 0, { inventory: [{ slot: 0, id: 1511, name: 'Logs', count: 1 }] }) as any)).toBe(true);
});

test('a send that itself reports failure ends at once as rejected, with its message', async () => {
    const s = fakeSession([at(0, 0)]);
    const p = checked(s as any, { name: 'climb', send: async () => ({ success: false, message: "I can't reach that!" }), effect: xpGained('Woodcutting'), timeoutTicks: 50 });
    await s.run(1);
    const r = await p;
    expect(r).toMatchObject({ ok: false, reason: 'rejected' });
    if (!r.ok) expect(r.detail).toContain("I can't reach that!");
});
