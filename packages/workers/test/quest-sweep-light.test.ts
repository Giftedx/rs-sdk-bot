import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Session } from '../../core/src/inprocess';
import { spawnsByDistance } from '../../core/src/spawn-index';
import { LIGHT_SOURCES, lightPlan, questGatherPlan } from '../src/quest/sweep-plan';
import { lightAtBank } from '../src/quest/sweep-travel';

const ARDOUGNE_NORTH_BANK = { x: 2618, z: 3332, level: 0 };
const TINDERBOX = 590, CANDLE = 36, LIT_CANDLE = 33;

test('the light sources are the light_source_unlit objs and their product', () => {
    const items = JSON.parse(readFileSync('knowledge/items.json', 'utf8')) as { id: number; debugname: string }[];
    const id = (debugname: string) => items.find((i) => i.debugname === debugname)!.id;
    const found: Record<number, number> = {};
    for (const file of new Bun.Glob('vendor/rs-sdk/server/content/scripts/**/configs/*.obj').scanSync('.')) {
        for (const block of readFileSync(file, 'utf8').split(/^(?=\[)/m)) {
            const name = /^\[([a-z0-9_]+)\]/.exec(block)?.[1];
            const product = /^param=product,([a-z0-9_]+)\s*$/m.exec(block)?.[1];
            if (name && product && /^category=light_source_unlit\s*$/m.test(block)) found[id(product)] = id(name);
        }
    }
    expect(found).toEqual({ ...LIGHT_SOURCES });
});

test('the light plan lights an owned unlit candle with an owned tinderbox', () => {
    const need = new Map([[LIT_CANDLE, 1]]);
    expect(lightPlan(need, [], [{ id: CANDLE, count: 1 }, { id: TINDERBOX, count: 1 }])).toEqual([{ lit: LIT_CANDLE, unlit: CANDLE, count: 1 }]);
    expect(lightPlan(need, [{ id: TINDERBOX, count: 1 }], [{ id: CANDLE, count: 3 }])).toEqual([{ lit: LIT_CANDLE, unlit: CANDLE, count: 1 }]);
    // No tinderbox, a lit candle already owned, or no unlit candle: nothing to light.
    expect(lightPlan(need, [], [{ id: CANDLE, count: 1 }])).toEqual([]);
    expect(lightPlan(need, [], [{ id: LIT_CANDLE, count: 1 }, { id: CANDLE, count: 1 }, { id: TINDERBOX, count: 1 }])).toEqual([]);
    expect(lightPlan(need, [], [{ id: TINDERBOX, count: 1 }])).toEqual([]);
    // An unlit candle that the pack itself needs is not lit.
    expect(lightPlan(new Map([[LIT_CANDLE, 1], [CANDLE, 1]]), [], [{ id: CANDLE, count: 1 }, { id: TINDERBOX, count: 1 }])).toEqual([]);
});

test('with no unlit candle the gather plan takes the lit candle in the Ardougne monastery', () => {
    expect(spawnsByDistance(LIT_CANDLE, ARDOUGNE_NORTH_BANK)[0]).toEqual({ x: 2598, z: 3211, level: 0 });
    expect(questGatherPlan('ikov', [{ id: LIT_CANDLE, count: 1 }], ARDOUGNE_NORTH_BANK, () => Infinity).gathers).toEqual([{ id: LIT_CANDLE, count: 1, how: 'spawn' }]);
});

function fakeBank(inventory: { id: number; count: number; slot: number }[], bank: { id: number; count: number }[]) {
    const state = { inventory, bank: { isOpen: true, items: bank }, interface: { isOpen: true } };
    const calls: string[] = [];
    const reslot = () => inventory.forEach((it, i) => (it.slot = i));
    const s = {
        sdk: { getState: () => state },
        bot: {
            withdrawItem: async (row: { id: number }, count: number) => {
                calls.push(`withdraw ${row.id}`);
                const b = bank.find((i) => i.id === row.id)!;
                b.count -= count;
                for (let i = 0; i < count; i++) inventory.push({ id: row.id, count: 1, slot: 0 });
                reslot();
                return { success: true };
            },
            closeBank: async () => { calls.push('close'); state.bank.isOpen = false; state.interface.isOpen = false; return { success: true, message: 'Bank closed' }; },
            openBank: async () => { calls.push('open'); state.bank.isOpen = true; state.interface.isOpen = true; return { success: true }; },
            depositItem: async (row: { id: number }) => {
                calls.push(`deposit ${row.id}`);
                const n = inventory.filter((i) => i.id === row.id).length;
                for (let i = inventory.length - 1; i >= 0; i--) if (inventory[i]!.id === row.id) inventory.splice(i, 1);
                reslot();
                const b = bank.find((i) => i.id === row.id);
                if (b) b.count += n; else bank.push({ id: row.id, count: n });
                return { success: true };
            },
        },
        direct: async (a: { type: string; sourceSlot: number; targetSlot: number }) => {
            calls.push(`use ${inventory[a.sourceSlot]!.id} on ${inventory[a.targetSlot]!.id}`);
            // [opheldu,tinderbox] with the bank shut: the unlit candle becomes the lit one in its slot.
            if (!state.bank.isOpen && inventory[a.targetSlot]!.id === TINDERBOX && inventory[a.sourceSlot]!.id === CANDLE) inventory[a.sourceSlot]!.id = LIT_CANDLE;
            return { success: true };
        },
    } as unknown as Session;
    return { s, calls, state };
}

test('the sweep lights the candle with the bank shut and banks the tinderbox again', async () => {
    const inventory: { id: number; count: number; slot: number }[] = [], bank = [{ id: CANDLE, count: 1 }, { id: TINDERBOX, count: 1 }];
    const { s, calls, state } = fakeBank(inventory, bank);
    expect(await lightAtBank(s, [{ lit: LIT_CANDLE, unlit: CANDLE, count: 1 }], false)).toBeNull();
    expect(calls).toEqual([`withdraw ${TINDERBOX}`, `withdraw ${CANDLE}`, 'close', `use ${CANDLE} on ${TINDERBOX}`, 'open', `deposit ${TINDERBOX}`]);
    expect(inventory.map((i) => i.id)).toEqual([LIT_CANDLE]);
    expect(bank).toEqual([{ id: CANDLE, count: 0 }, { id: TINDERBOX, count: 1 }]);
    expect(state.bank.isOpen).toBe(true);
});

test('a tinderbox that the quest needs stays in the pack, and a full pack skips the light', async () => {
    const kept = fakeBank([], [{ id: CANDLE, count: 1 }, { id: TINDERBOX, count: 1 }]);
    expect(await lightAtBank(kept.s, [{ lit: LIT_CANDLE, unlit: CANDLE, count: 1 }], true)).toBeNull();
    expect(kept.calls).not.toContain(`deposit ${TINDERBOX}`);
    expect(kept.state.inventory.map((i) => i.id).sort()).toEqual([LIT_CANDLE, TINDERBOX]);
    const full = fakeBank(Array.from({ length: 27 }, (_, slot) => ({ id: 225, count: 1, slot })), [{ id: CANDLE, count: 1 }, { id: TINDERBOX, count: 1 }]);
    expect(await lightAtBank(full.s, [{ lit: LIT_CANDLE, unlit: CANDLE, count: 1 }], false)).toBeNull();
    expect(full.calls).toEqual([]);
});
