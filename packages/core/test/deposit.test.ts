import { expect, test, spyOn } from 'bun:test';
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

test('carried 1902 coins with bank 15606 records dispatch and containers without accepting debit alone', async () => {
    let tick = 0, held = 1902;
    const callbacks = new Set<() => void>(), rows: string[] = [];
    const pack = () => ({ linkObjType: held ? [996] : [0], linkObjNumber: [held] });
    const bank = { linkObjType: [996], linkObjNumber: [15606] };
    const s: any = {
        name: 'fixture', tick: () => tick,
        client: { ifType: (id: number) => id === 5382 ? bank : pack() },
        sdk: { getState: () => ({ inventory: held ? [{ id: 995, name: 'Coins', slot: 0, count: held }] : [] }) },
        bankObservation: () => ({ generation: 1, at: 1000, items: [{ id: 995, name: 'Coins', count: 15606 }] }),
        onTick: (cb: () => void) => { callbacks.add(cb); return () => callbacks.delete(cb); },
        bot: { depositItem: async (item: any, amount: number) => {
            expect(item).toEqual({ id: 995, name: 'Coins', slot: 0, count: 1902 });expect(amount).toBe(-1);
            held = 0;return { success: true };
        } },
    };
    const log = spyOn(console, 'log').mockImplementation(line => { rows.push(String(line)); });
    try {
        const work = depositObserved(s, { id: 995, name: 'Coins' }).then(() => 'accepted', e => String(e));
        for (let i = 0; i < 30; i++) { await Promise.resolve(); tick++; for (const cb of [...callbacks]) cb(); }
        expect(await work).toContain('no deposit progress: pack debit/bank credit unobserved 995');
        const observations = rows.filter(l => l.startsWith('DEPOSIT_OBSERVATION ')).map(l => JSON.parse(l.slice('DEPOSIT_OBSERVATION '.length)));
        expect(observations[0]).toMatchObject({ phase: 'dispatch', amount: 1902, bankBefore: 15606, target: { id: 995, slot: 0 } });
        expect(observations.at(-1)).toMatchObject({ phase: 'exit', pack: [], bank: { generation: 1, items: [{ id: 995, name: 'Coins', count: 15606 }] } });
        expect(observations[0].containers).toContainEqual({ componentId: 2006, items: [{ slot: 0, id: 995, count: 1902 }] });
        expect(rows.some(l => l.startsWith('DEPOSIT_RECEIPT '))).toBe(false);
        expect(callbacks.size).toBe(0);
    } finally { log.mockRestore(); }
});
