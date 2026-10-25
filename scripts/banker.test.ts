import { expect, test } from 'bun:test';
import { payoutItems, preparePayout, ourAccounts } from './banker';
import { isNoProgressFailure } from '../packages/practice/src/supervise';
import type { Session } from '../packages/core/src/inprocess';
test('banker roster uses authenticated ownership on its exact server, including local pairs',()=>{
    const calls:string[]=[];
    const lookup=(server:string)=>{calls.push(server);return new Set(server==='localhost:8888'?['flpayoutlocal','flreceiverlocal']:server==='rs-sdk-demo.fly.dev'?['moneyshot','pocketrocket']:[]);};
    expect(ourAccounts('localhost:8888',lookup)).toEqual(['flpayoutlocal','flreceiverlocal']);
    expect(ourAccounts('rs-sdk-demo.fly.dev',lookup)).toEqual(['moneyshot','pocketrocket']);
    expect(ourAccounts('rs-sdk-demo.fly.dev',lookup)).not.toContain('flreceiverlocal');
    expect(ourAccounts('localhost:8888',lookup)).not.toContain('moneyshot');
    expect(ourAccounts('different.example',lookup)).toEqual([]);
    expect(ourAccounts(undefined,lookup)).toEqual(['moneyshot','pocketrocket']);
    expect(calls).toEqual(['localhost:8888','rs-sdk-demo.fly.dev','rs-sdk-demo.fly.dev','localhost:8888','different.example','rs-sdk-demo.fly.dev']);
});
function fixture(partial = false, failSecond = false) {
    const inventory = [{ id: 1735, name: 'Shears', count: 1, slot: 0 }, { id: 315, name: 'Shrimps', count: 1, slot: 1 }, { id: 315, name: 'Shrimps', count: 1, slot: 2 }];
    const bank = new Map([[1779, 750], [1737, 50]]);
    const calls: unknown[][] = [], deposits: { id: number; count: number }[] = [];
    let closed = 0;
    const s = { sdk: { getInventory: () => inventory }, bot: {
        openBank: async () => ({ success: true }), closeBank: async () => { closed++; },
        withdrawItem: async (...args: [RegExp, number, { asNote: boolean }?]) => {
            calls.push(args); const name = args[0].test('Flax') ? 'Flax' : 'Wool';
            const raw = name === 'Flax' ? 1779 : 1737;
            const amount = failSecond && calls.length === 2 ? 0 : partial || !args[2]?.asNote ? Math.min(25, args[1]) : args[1];
            bank.set(raw, bank.get(raw)! - amount);
            if (amount) inventory.push({ id: args[2]?.asNote ? raw + 1 : raw, name, count: amount, slot: inventory.length });
            return { success: true }; // Deliberately misleading: only actual held count may authorize a trade.
        },
        depositItem: async (item: { id: number }, count: number) => {
            deposits.push({ id: item.id, count }); const i = inventory.findIndex(v => v.id === item.id);
            const raw = item.id === 1780 ? 1779 : item.id === 1738 ? 1737 : item.id;
            bank.set(raw, bank.get(raw)! + count); inventory[i]!.count -= count;
            if (!inventory[i]!.count) inventory.splice(i, 1);
        }
    } } as unknown as Session;
    return { s, bank, calls, deposits, inventory, closed: () => closed };
}
test('existing request format validates and merges duplicate names without lost quantities', () => {
    expect(payoutItems([{ name: 'Flax', count: 100 }, { name: 'flax', count: 6 }])).toEqual([{ name: 'Flax', count: 106 }]);
    for (const raw of [[], null, [{ name: 'Flax', count: -1 }], [{ name: 'Flax', count: 1.5 }]]) expect(() => payoutItems(raw)).toThrow('no payout progress');
});
test('opt-in notes prepares all106Flax in one stack and retains kit', async () => {
    const f = fixture();
    expect(await preparePayout(f.s, [{ name: 'Flax', count: 106 }], true, /shears|shrimps/i)).toEqual({ want: [{ name: 'Flax', count: 106 }], notes: true, withdrawn: 106 });
    expect(f.calls[0]![2]).toEqual({ asNote: true }); expect(f.inventory.at(-1)).toMatchObject({ id: 1780, count: 106 });
    expect(f.inventory.slice(0, 3).map(i => i.count)).toEqual([1, 1, 1]); expect(f.bank.get(1779)).toBe(644); expect(f.closed()).toBe(1);
});
test('default passes no options and keeps the existing small unnoted payout behavior', async () => {
    const f = fixture();
    expect(await preparePayout(f.s, [{ name: 'Flax', count: 20 }])).toMatchObject({ notes: false, withdrawn: 20 });
    expect(f.calls[0]!.length).toBe(2); expect(f.inventory.at(-1)).toMatchObject({ id: 1779, count: 20 });
});
test('unnoted106partial is banked and blocks before caller can serve an impossible trade', async () => {
    const f = fixture(); let served = false, error = '';
    try { await preparePayout(f.s, [{ name: 'Flax', count: 106 }]); served = true; } catch (e) { error = String(e); }
    expect(served).toBe(false); expect(error).toContain('requested=106 actual=25');
    expect(isNoProgressFailure(`RESULT fail ${error}`)).toBe(true);
    expect(f.bank.get(1779)).toBe(750); expect(f.inventory.length).toBe(3); expect(f.closed()).toBe(1);
});
test('partial noted withdrawal also cleans up despite API success=true', async () => {
    const f = fixture(true);
    await expect(preparePayout(f.s, [{ name: 'Flax', count: 106 }], true)).rejects.toThrow('actual=25');
    expect(f.deposits).toEqual([{ id: 1780, count: 25 }]); expect(f.bank.get(1779)).toBe(750); expect(f.inventory.length).toBe(3);
});
test('second item shortfall banks the first complete withdrawal too', async () => {
    const f = fixture(false, true);
    await expect(preparePayout(f.s, [{ name: 'Flax', count: 106 }, { name: 'Wool', count: 30 }], true)).rejects.toThrow('Wool requested=30 actual=0');
    expect(f.bank.get(1779)).toBe(750); expect(f.bank.get(1737)).toBe(50); expect(f.inventory.length).toBe(3);
});
test('protected KEEP item cannot be requested even when a bank copy exists', async () => {
    const f = fixture();
    await expect(preparePayout(f.s, [{ name: 'Shears', count: 1 }], true, /^shears$/i)).rejects.toThrow('protected KEEP');
    expect(f.calls.length).toBe(0); expect(f.inventory[0]!.count).toBe(1);
});
