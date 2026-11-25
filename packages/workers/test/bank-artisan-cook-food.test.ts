import { expect, test } from 'bun:test';
import { isNoProgressFailure } from '../../practice/src/supervise';
import {
    cookedFoodPattern,
    cookLevelRefusal,
    cookLevelShortfall,
    foodDepositPattern,
    foodRule,
    runCookFood,
} from '../src/bank-artisan/cooking';

const REFUSAL = 'You need a Cooking level of 40 to cook lobsters.';

// A Catherby range fixture: three raw lobsters and a lobster pot in the pack. The server answers each cook with the
// level message box, as in the tick record of the Cooking 30 account that looped for 14,882 ticks.
function cookFixture(cooking: number) {
    let tick = 0;
    let sends = 0;
    const listeners = new Set<() => void>();
    const inventory = [
        ...[0, 1, 2].map(slot => ({ slot, id: 377, name: 'Raw lobster', count: 1 })),
        { slot: 3, id: 301, name: 'Lobster pot', count: 1 },
    ];
    let dialog: { isOpen: boolean; text?: string; options: []; isWaiting: boolean } = { isOpen: false, options: [], isWaiting: false };
    const state = () => ({ player: { worldX: 2816, worldZ: 3444, level: 0 }, inventory, dialog, gameMessages: [] });
    const s: any = {
        name: 'Fixture',
        tick: () => tick,
        ended: new Promise(() => {}),
        onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
        sdk: {
            getState: state,
            getSkill: (name: string) => (name === 'Cooking' ? { level: cooking, baseLevel: cooking } : undefined),
            getInventory: () => inventory,
            getDialog: () => dialog,
            findNearbyLoc: () => ({ id: 2728, x: 2817, z: 3444 }),
            sendUseItemOnLoc: async () => { sends++; dialog = { isOpen: true, text: REFUSAL, options: [], isWaiting: false }; return { success: true }; },
        },
        bot: {},
    };
    const timer = setInterval(() => { tick++; for (const cb of [...listeners]) cb(); }, 1);
    return { s, sends: () => sends, stop: () => clearInterval(timer) };
}

test('food levels come from the server cook rows', () => {
    // vendor/rs-sdk/server/content/scripts/skill_cooking/configs/cooking_source/cooking_generic.dbrow data=levelrequired
    expect(Object.fromEntries(['trout', 'salmon', 'lobster', 'swordfish', 'shark'].map(f => [f, foodRule(f).level])))
        .toEqual({ trout: 15, salmon: 25, lobster: 40, swordfish: 45, shark: 80 });
    expect(foodRule('lobster')).toMatchObject({ rawId: 377, cookedId: 379 });
    expect(cookLevelShortfall('lobster', 40)).toBeNull();
    expect(cookLevelShortfall('lobster', 30)).toBe('no cooking progress: Cooking 30 is below level 40 for lobster');
});

test('a Cooking 30 account ends a lobster cook at once with a no-progress fail line', async () => {
    const f = cookFixture(30);
    try {
        const r = await runCookFood(f.s, 'lobster', 500);
        expect(r.ok).toBe(false);
        expect(r.failure).toBe('no cooking progress: Cooking 30 is below level 40 for lobster');
        expect(f.sends()).toBe(0);
        expect(r.ticks).toBeLessThan(5);
        expect(isNoProgressFailure(`RESULT fail ${r.summary}`)).toBe(true);
    } finally { f.stop(); }
});

test('the server level message during a cook ends the run after one use', async () => {
    const f = cookFixture(40);
    try {
        const r = await runCookFood(f.s, 'lobster', 500);
        expect(f.sends()).toBe(1);
        expect(r.ok).toBe(false);
        expect(r.total).toBe(0);
        expect(r.failure).toBe('no cooking progress: the server needs Cooking 40 for lobster and the account has 40');
        expect(isNoProgressFailure(`RESULT fail ${r.summary}`)).toBe(true);
    } finally { f.stop(); }
});

test('the level message counts only from an open dialog or a new game message', () => {
    expect(cookLevelRefusal({ dialog: { isOpen: true, text: REFUSAL } }, 10)).toBe(40);
    expect(cookLevelRefusal({ dialog: { isOpen: true, allComponents: [{ text: REFUSAL }] } }, 10)).toBe(40);
    expect(cookLevelRefusal({ dialog: { isOpen: false, text: REFUSAL } }, 10)).toBeNull();
    expect(cookLevelRefusal({ gameMessages: [{ text: REFUSAL, tick: 9 }] }, 10)).toBeNull();
    expect(cookLevelRefusal({ gameMessages: [{ text: REFUSAL, tick: 10 }] }, 10)).toBe(40);
    expect(cookLevelRefusal({ dialog: { isOpen: true, text: 'You cook the lobster.' } }, 10)).toBeNull();
});

test('a lobster pot is neither cooked food nor deposited with it', () => {
    expect(cookedFoodPattern('lobster').test('Lobster')).toBe(true);
    expect(cookedFoodPattern('lobster').test('Lobster pot')).toBe(false);
    const deposit = foodDepositPattern('lobster');
    expect(['Lobster', 'Burnt lobster', 'Burnt fish'].every(n => deposit.test(n))).toBe(true);
    expect(['Lobster pot', 'Raw lobster'].some(n => deposit.test(n))).toBe(false);
});
