import { expect, test } from 'bun:test';
import { depositObserved } from '../src/deposit';
import { isNoProgressFailure } from '../../practice/src/supervise';

function fixture(mode: string, id = 995, name = 'Coins') {
    let held = 23, bank = 100, generation = 2, tick = 0, calls = 0;
    const callbacks = new Set<() => void>();
    const s: any = {
        name: 'fixture', tick: () => tick,
        sdk: { getState: () => ({ inventory: mode === 'missing-pack' && calls ? undefined : held ? [{ id, name, count: held, slot: 0 }] : [] }) },
        bankObservation: () => mode === 'missing' || mode === 'closed' && calls ? null : ({ generation, at: 1000 + tick, items: [{ id: id === 334 ? 333 : id, name, count: bank }] }),
        onTick: (cb: () => void) => { callbacks.add(cb); return () => callbacks.delete(cb); },
        bot: { depositItem: async (item: any) => {
            calls++; expect(item.id).toBe(id);
            if (mode !== 'no-debit') held = mode === 'partial' ? 3 : 0;
            if (!['no-credit', 'delayed'].includes(mode)) bank += mode === 'excess' ? 24 : 23;
            if (mode !== 'stale') generation++;
            if (mode === 'thrown') throw Error('lost reply');
            return { success: mode !== 'sdk-false', amountDeposited: 99999 };
        } },
    };
    return { s, calls: () => calls, advance: () => {
        tick++;
        if (mode === 'delayed' && tick === 3) { bank += 23; generation++; }
        for (const cb of [...callbacks]) cb();
    } };
}

for (const mode of ['matched', 'delayed', 'sdk-false', 'thrown', 'missing', 'missing-pack', 'closed', 'no-debit', 'no-credit', 'partial', 'excess', 'stale']) {
    test(`deposit receipt: ${mode}`, async () => {
        const f = fixture(mode);
        const result = depositObserved(f.s, { id: 995, name: 'Coins' }).then(value => ({ value }), error => ({ error: String(error) }));
        for (let i = 0; i < 30; i++) { await Promise.resolve(); f.advance(); }
        const r = await result;
        if (['matched', 'delayed', 'sdk-false', 'thrown'].includes(mode)) expect(r).toEqual({ value: 23 });
        else { expect('error' in r).toBe(true); expect(isNoProgressFailure('RESULT fail ' + (r as any).error)).toBe(true); }
        expect(f.calls()).toBe(mode === 'missing' ? 0 : 1);
    });
}

test('noted food debits its pack ID and credits the unnoted bank item', async () => {
    const f = fixture('matched', 334, 'Trout');
    expect(await depositObserved(f.s, { id: 334, name: 'Trout' })).toBe(23);
});
