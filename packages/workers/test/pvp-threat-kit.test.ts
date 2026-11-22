import { expect, test } from 'bun:test';
import { MIN_SWAP_GAIN, nearestSingleWay, planCounterSwap, restoreFor, wearIds } from '../src/pvp/pk-threat-kit';

// Rune platebody 1127 and platelegs 1079; dragonhide body 1135 and chaps 1099 (knowledge/gear.json).
const RUNE = [1127, 1079], DHIDE = [1135, 1099];
const levels = { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 99 };

test('against a mage the pack\'s dragonhide replaces the rune body and legs, by the gain in magic defence', () => {
    // body -6 -> 20 and legs -4 -> 8
    expect(planCounterSwap({ worn: RUNE, pack: DHIDE, style: 'magic', levels })).toEqual({ wear: [1135, 1099], gain: 38 });
});

test('no swap when the worn armour already defends best against the style, or the pack has none', () => {
    expect(planCounterSwap({ worn: RUNE, pack: DHIDE, style: 'ranged', levels })).toBeNull();
    expect(planCounterSwap({ worn: RUNE, pack: DHIDE, style: 'melee', levels })).toBeNull();
    expect(planCounterSwap({ worn: RUNE, pack: [], style: 'magic', levels })).toBeNull();
});

test('the account levels gate the swap: dragonhide needs ranged 40 and defence 40', () => {
    expect(planCounterSwap({ worn: RUNE, pack: DHIDE, style: 'magic', levels: { ...levels, ranged: 30 } })).toBeNull();
    // The body needs ranged 40 and defence 40, the chaps only ranged 40: at defence 39 the chaps alone are worn.
    expect(planCounterSwap({ worn: RUNE, pack: DHIDE, style: 'magic', levels: { ...levels, defence: 39 } })).toEqual({ wear: [1099], gain: 12 });
});

test('a swap below the minimum gain is not worth the tick', () => {
    expect(planCounterSwap({ worn: RUNE, pack: DHIDE, style: 'magic', levels, minGain: 39 })).toBeNull();
    expect(MIN_SWAP_GAIN).toBeGreaterThan(0);
});

test('restoreFor names the worn items in the slots that the swap takes', () => {
    expect(restoreFor([1127, 1079, 1163], [1135])).toEqual([1127]);
    expect(restoreFor([1127, 1079, 1163], [1135, 1099])).toEqual([1127, 1079]);
});

test('wearIds uses the Wear or Wield option of each pack item, one input and one tick each, and returns what it could not wear', async () => {
    const used: [number, number][] = [];
    const s = { sdk: { getInventory: () => [{ id: 1135, slot: 3, optionsWithIndex: [{ text: 'Wear', opIndex: 2 }] }, { id: 1099, slot: 4, optionsWithIndex: [{ text: 'Drop', opIndex: 5 }] }], sendUseItem: async (slot: number, op: number) => { used.push([slot, op]); } } };
    let ticks = 0;
    expect(await wearIds(s, [1135, 1099, 9999], async () => { ticks++; return true; })).toEqual([1099, 9999]);
    expect(used).toEqual([[3, 2]]);
    expect(ticks).toBe(1);
});

test('nearestSingleWay: the nearest single-way Wilderness tile, away from the threats', () => {
    // Multi-way from x 3000 on; single-way to the west.
    const o = { multiAt: (x: number) => x >= 3000, wildAt: (_x: number, z: number) => (z >= 3520 ? 1 : 0) };
    const at = { x: 3005, z: 3650 };
    expect(nearestSingleWay(at, o)).toMatchObject({ x: 2999 });
    expect(nearestSingleWay(at, { ...o, avoid: [{ x: 3020, z: 3650 }] })).toMatchObject({ x: 2999 });
    // Threats at the west edge: the far corner of the ring is chosen, and it is still single-way.
    const away = nearestSingleWay({ x: 3000, z: 3650 }, { ...o, avoid: [{ x: 2990, z: 3640 }] })!;
    expect(o.multiAt(away.x)).toBe(false);
    expect(nearestSingleWay(at, { ...o, multiAt: () => true })).toBeNull();
    // Outside the Wilderness is not a tile for the squad.
    expect(nearestSingleWay({ x: 3005, z: 3530 }, { ...o, wildAt: () => 0 })).toBeNull();
});
