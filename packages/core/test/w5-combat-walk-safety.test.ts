import { expect, test } from 'bun:test';
import { crossesWildernessCeiling, inWilderness, nearestSafeTile, safeCandidates } from '../src/combat-end';
import { fareCrossings, loadTravel } from '../src/travel';
import { FARE_FLOAT, knownBanks } from '../src/trip';
import {
    IKOV_SECRET_DOOR,
    IKOV_SHINY_KEY_ID,
    IKOV_SHINY_KEY_TILE,
    KARAMJA_BANANA_ID,
    KARAMJA_CRATE,
    KARAMJA_LUTHAS_TILE,
    fareFloatNeed,
    goTo,
    inIkovArmadylPocket,
    inKaramjaIsland,
    needsIkovShinyKeyExit,
    needsKaramjaFareEscape,
    unreadJournalQuests,
} from '../src/walk';
import type { Account, Tile, World } from '../src/world';

const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

test('combat-end Wilderness ceiling blocks surface and Edgeville Dungeon Wilderness entry and deeper north retreat', () => {
    expect(inWilderness({ x: 3133, z: 9947 })).toBe(true);
    expect(inWilderness({ x: 3091, z: 9933 })).toBe(true);
    expect(inWilderness({ x: 3131, z: 9918 })).toBe(true);
    expect(inWilderness({ x: 3131, z: 9916 })).toBe(false);
    expect(inWilderness({ x: 3117, z: 9850 })).toBe(false);
    expect(inWilderness({ x: 3095, z: 3520 })).toBe(true);
    expect(inWilderness({ x: 3095, z: 3519 })).toBe(false);

    // Non-Wilderness start just south of Edgeville Dungeon Wilderness gate must never pick z >= 9918.
    const southOfGate: Tile = { x: 3131, z: 9914, level: 0 };
    const squares = [{ x: 3131, z: 9912, r: 6, name: 'Test mob' }];
    const southCands = safeCandidates(southOfGate, squares, 20);
    expect(southCands.length).toBeGreaterThan(0);
    expect(southCands.every(c => !inWilderness(c))).toBe(true);

    // Already inside Edgeville Dungeon Wilderness (3113,9929): safe retreat never walks deeper north (z > 9929).
    const insideWildy: Tile = { x: 3113, z: 9929, level: 0 };
    const wildySquares = [{ x: 3113, z: 9929, r: 8, name: 'Chaos druid' }];
    const wildyCands = safeCandidates(insideWildy, wildySquares, 24);
    expect(wildyCands.length).toBeGreaterThan(0);
    expect(wildyCands.every(c => !crossesWildernessCeiling(insideWildy, c) && c.z <= insideWildy.z)).toBe(true);
    const chosen = nearestSafeTile(insideWildy, wildySquares, (a, b) => cheb(a, b))!;
    expect(chosen.z).toBeLessThanOrEqual(insideWildy.z);
});

test('Temple of Ikov pocket detection and goTo Shiny key acquisition escape 2645,9893,0', async () => {
    const start: Tile = { x: 2645, z: 9893, level: 0 };
    const bank: Tile = { x: 2727, z: 3492, level: 0 };
    expect(inIkovArmadylPocket(start)).toBe(true);
    expect(needsIkovShinyKeyExit(start, bank, { items: [] })).toBe(true);
    expect(needsIkovShinyKeyExit(start, bank, { items: ['ikov_shinykey'] })).toBe(false);
    expect(needsIkovShinyKeyExit(start, { x: 2659, z: 9892, level: 0 }, { items: [] })).toBe(false);

    let tick = 0;
    let pos = { worldX: 2645, worldZ: 9893, level: 0 };
    const inv: { id: number; name: string; count: number; slot: number }[] = [];
    const groundItems = [{ id: IKOV_SHINY_KEY_ID, name: 'Shiny key', x: IKOV_SHINY_KEY_TILE.x, z: IKOV_SHINY_KEY_TILE.z }];
    const listeners = new Set<() => void>();
    const timer = setInterval(() => { tick++; for (const fn of [...listeners]) fn(); }, 1);
    const actions: string[] = [];
    let routeCalls = 0;

    const world: World = {
        route(from: Tile, _to: Tile, acct: Account) {
            routeCalls++;
            if (!acct.items.includes('ikov_shinykey')) return { ok: false, reason: 'no_route' };
            return { ok: true, cost: 10, legs: [{ kind: 'walk', to: { x: from.x + 1, z: from.z, level: from.level }, tolerance: 2 }] };
        },
        navigationGraph: () => ({ transports: [], travel: [] }),
    } as unknown as World;

    const walker: any = {
        tick: () => tick,
        onTick: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
        sdk: {
            getState: () => ({ player: pos, inventory: inv, groundItems, nearbyLocs: [], skills: [] }),
            getInventory: () => inv,
        },
        bot: {
            walkTo: async (x: number, z: number) => {
                actions.push(`walk:${x},${z}`);
                pos = { worldX: x, worldZ: z, level: 0 };
                return { success: true };
            },
            pickupItem: async (item: { id: number }) => {
                actions.push(`pickup:${item.id}`);
                if (item.id === IKOV_SHINY_KEY_ID && !inv.some(i => i.id === IKOV_SHINY_KEY_ID)) {
                    inv.push({ id: IKOV_SHINY_KEY_ID, name: 'Shiny key', count: 1, slot: 0 });
                }
                return { success: true };
            },
        },
        direct: async (a: { type: string; locId?: number; x?: number; z?: number }) => {
            actions.push(`${a.type}:${a.locId ?? ''}`);
            if (a.type === 'interactLoc' && a.locId === IKOV_SECRET_DOOR.id) {
                pos = { worldX: IKOV_SECRET_DOOR.x, worldZ: IKOV_SECRET_DOOR.z, level: 0 };
            }
            return { success: true };
        },
    };

    try {
        const acct: Account = { skills: {}, varps: {}, items: [], coins: 0 };
        const res = await goTo(walker, world, bank, acct, { noHarmCheck: true, noFareFloat: true });
        expect(res.ok).toBe(true);
        expect(routeCalls).toBe(2);
        expect(actions).toContain(`interactLoc:${IKOV_SECRET_DOOR.id}`);
        expect(actions).toContain(`pickup:${IKOV_SHINY_KEY_ID}`);
    } finally {
        clearInterval(timer);
    }
});

test('Karamja < 30 gp detection and goTo Luthas banana crate escape from Jiminua shop', async () => {
    const jiminua: Tile = { x: 2767, z: 3123, level: 0 };
    const brimhaven: Tile = { x: 2772, z: 3225, level: 0 };
    const rimmington: Tile = { x: 2932, z: 3214, level: 0 };
    const crandor: Tile = { x: 2851, z: 3235, level: 0 };
    const bank: Tile = { x: 3092, z: 3243, level: 0 };
    expect(inKaramjaIsland(jiminua)).toBe(true);
    expect(inKaramjaIsland(brimhaven)).toBe(true);
    expect(inKaramjaIsland(rimmington)).toBe(false);
    expect(inKaramjaIsland(crandor)).toBe(false);
    expect(needsKaramjaFareEscape(jiminua, bank, 12)).toBe(true);
    expect(needsKaramjaFareEscape(jiminua, rimmington, 12)).toBe(true);
    expect(needsKaramjaFareEscape(rimmington, bank, 12)).toBe(false);
    expect(needsKaramjaFareEscape(jiminua, bank, 30)).toBe(false);
    expect(needsKaramjaFareEscape(jiminua, { x: 2939, z: 3154, level: 0 }, 12)).toBe(false);

    let tick = 0;
    let pos = { worldX: 2767, worldZ: 3123, level: 0 };
    const inv: { id: number; name: string; count: number; slot: number }[] = [{ id: 995, name: 'Coins', count: 12, slot: 0 }];
    let employed = false;
    let packed = 0;
    let dialog: { isOpen: boolean; isWaiting: boolean; options: { index: number; text: string }[] } = { isOpen: false, isWaiting: false, options: [] };
    const listeners = new Set<() => void>();
    const timer = setInterval(() => { tick++; for (const fn of [...listeners]) fn(); }, 1);
    let routeCalls = 0;

    const world: World = {
        route(from: Tile, _to: Tile, acct: Account) {
            routeCalls++;
            if ((acct.coins ?? 0) < 30) return { ok: false, reason: 'no_route' };
            return { ok: true, cost: 20, legs: [{ kind: 'walk', to: { x: from.x + 1, z: from.z, level: from.level }, tolerance: 2 }] };
        },
        navigationGraph: () => ({ transports: [], travel: [] }),
    } as unknown as World;

    const walker: any = {
        tick: () => tick,
        onTick: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
        sdk: {
            getState: () => ({
                player: pos,
                inventory: inv,
                gameMessages: [],
                nearbyNpcs: [{ index: 7, name: 'Luthas', distance: 1 }],
                nearbyLocs: [{ id: 2073, x: 2925, z: 3156, distance: 1 }],
                skills: [],
            }),
            getInventory: () => inv,
            getDialog: () => dialog,
            sendClickDialog: async () => {
                if (!employed) {
                    employed = true;
                } else if (packed >= 10) {
                    inv[0]!.count += 30;
                }
                dialog = { isOpen: false, isWaiting: false, options: [] };
                return { success: true };
            },
        },
        bot: {
            walkTo: async (x: number, z: number) => {
                pos = { worldX: x, worldZ: z, level: 0 };
                return { success: true };
            },
        },
        direct: async (a: { type: string; locId?: number; npcIndex?: number; itemSlot?: number }) => {
            if (a.type === 'interactNpc' && a.npcIndex === 7) {
                dialog = {
                    isOpen: true,
                    isWaiting: false,
                    options: employed
                        ? [{ index: 0, text: "Thank you, I'll be on my way" }]
                        : [{ index: 0, text: 'Could you offer me employment on your plantation?' }],
                };
            } else if (a.type === 'interactLoc' && a.locId === 2073) {
                inv.push({ id: KARAMJA_BANANA_ID, name: 'Banana', count: 1, slot: inv.length });
            } else if (a.type === 'useItemOnLoc' && a.locId === KARAMJA_CRATE.id) {
                const idx = inv.findIndex(i => i.id === KARAMJA_BANANA_ID);
                if (idx >= 0) {
                    inv.splice(idx, 1);
                    packed++;
                }
            }
            return { success: true };
        },
    };

    try {
        const acct: Account = { skills: {}, varps: {}, items: ['coins'], counts: { coins: 12 }, coins: 12 };
        const res = await goTo(walker, world, bank, acct, { noHarmCheck: true, noFareFloat: true });
        expect(res.ok).toBe(true);
        expect(routeCalls).toBe(2);
        expect(packed).toBe(10);
        expect(inv[0]!.count).toBe(42);
    } finally {
        clearInterval(timer);
    }
});

test('unreadJournalQuests deduplicates already-known stages and fareFloatNeed covers bank offsets up to 12 tiles', () => {
    const fakeClient = {};
    expect(unreadJournalQuests(fakeClient, ['priestperil', 'legendsquest'], { priestperil: 3 })).toEqual(['legendsquest']);
    expect(unreadJournalQuests(fakeClient, ['priestperil'], { priestperil: 3 })).toEqual([]);

    // 10 tiles from Al Kharid bank (3269,3167) heading to Lumbridge with 0 coins now takes FARE_FLOAT instead of detouring.
    const nearAlKharid: Tile = { x: 3279, z: 3167, level: 0 };
    const lumbridge: Tile = { x: 3222, z: 3218, level: 0 };
    const need = fareFloatNeed({
        from: nearAlKharid,
        to: lumbridge,
        held: 0,
        bankCoins: 5000,
        coinSlot: true,
        travel: loadTravel(),
        crossings: fareCrossings(),
        banks: knownBanks(),
    });
    expect(need).toMatchObject({ fare: 10, take: FARE_FLOAT });
    expect(KARAMJA_LUTHAS_TILE).toEqual({ x: 2939, z: 3154, level: 0 });
});
