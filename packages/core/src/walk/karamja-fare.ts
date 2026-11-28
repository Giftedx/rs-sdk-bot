// Karamja < 30 gp ship-fare escape via Jiminua's General Store and Luthas's banana crate job
// (quests/quest_hunt/scripts/luthas.rs2, banana_crate.rs2).
// An account stranded on Karamja with fewer than 30 coins cannot pay the customs officer (2953,3147 or 2772,3225).
// With a full 28/28 pack and no bananas, it first tries selling cheap dispensable items at Jiminua's General Store
// (2767,3122) to reach 30 coins or free a slot, falling back to dropping 1 cheapest non-quest/non-gear/non-rare item.
// Picking 10 bananas from the free plantation trees (loc 2073..2077) and packing them into Luthas's crate (2072 at
// 2943,3151) pays 30 coins on completion, unlocking the Musa Point -> Port Sarim ferry route.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sharedLootTables, unitValue, type LootTables } from '../loot';
import type { Tile } from '../world';
import { waitTicks, waitUntil } from '../ticks';
import type { Walker } from '../walk-leg';
import { walkPath } from './path';
import { sessionWalker } from './session';

type Pos = { x: number; z: number; level: number };
type InvItem = { id: number; slot: number; count?: number; name?: string };
type ItemMeta = { id: number; name: string; debugname: string; cost: number; tradeable: boolean; stackable: boolean; src?: string; def?: string };

const repoRoot = resolve(import.meta.dir, '..', '..', '..', '..');

export const KARAMJA_SHIP_FARE = 30;
export const KARAMJA_BANANA_ID = 1963;
export const KARAMJA_CRATE = { id: 2072, x: 2943, z: 3151, level: 0 } as const;
export const KARAMJA_LUTHAS_TILE: Tile = { x: 2939, z: 3154, level: 0 };
export const KARAMJA_GROVE_TILE: Tile = { x: 2925, z: 3156, level: 0 };
export const KARAMJA_JIMINUA_TILE: Tile = { x: 2767, z: 3122, level: 0 };
export const KARAMJA_MAX_DISPENSABLE_COST = 50;
export const KARAMJA_MAX_DISPENSABLE_VALUE = 250;
export const KARAMJA_MAX_STACKABLE_DISPENSABLE = 5;
const BANANA_TREE_IDS = new Set([2073, 2074, 2075, 2076, 2077]);
const PROTECTED_ITEM_NAME_RE = /\b(?:coins?|rune|talisman|tiara|key|teleport|clue|casket|lamp|ring|amulet|necklace|pickaxe|axe|hatchet|tinderbox|knife|chisel|hammer|spade|rope|net|rod|harpoon|cage|staff|wand|scimitar|sword|dagger|bow|arrow|bolt|shield|helm|plate|chain|robe|cape|boot|glove|herb|seed|gem|diamond|ruby|emerald|sapphire|dragonstone|onyx)\b/i;

let itemMetaMap: Map<number, ItemMeta> | null = null;
let gearIdSet: Set<number> | null = null;

function loadItemMeta(): Map<number, ItemMeta> {
    if (itemMetaMap) return itemMetaMap;
    const raw = JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'items.json'), 'utf8')) as ItemMeta[];
    itemMetaMap = new Map(raw.map(i => [i.id, i]));
    return itemMetaMap;
}

function loadGearIds(): Set<number> {
    if (gearIdSet) return gearIdSet;
    const raw = JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'gear.json'), 'utf8')) as { id: number }[];
    gearIdSet = new Set(raw.map(g => g.id));
    return gearIdSet;
}

// Ranks cheap, non-quest, non-gear, non-rare dispensable items that are safe to sell at Jiminua's General Store
// or drop (1 unit) to free a slot for Luthas's banana crate. Never returns coins, quest items, untradeables,
// wearable gear, valuable items, or stackables above the threshold.
export function pickDispensableKaramjaItems(
    inventory: readonly InvItem[],
    opts: { allowStackable?: boolean; tables?: LootTables } = {},
): InvItem[] {
    const items = loadItemMeta();
    const gear = loadGearIds();
    const tables = opts.tables ?? sharedLootTables();
    const countsById = new Map<number, number>();
    for (const item of inventory) countsById.set(item.id, (countsById.get(item.id) ?? 0) + 1);
    const scored: { item: InvItem; value: number; cost: number; slots: number }[] = [];
    for (const item of inventory) {
        if (item.id === 995 || item.id === KARAMJA_BANANA_ID) continue;
        const meta = items.get(item.id);
        if (!meta || meta.tradeable !== true) continue;
        if (gear.has(item.id)) continue;
        if ((meta.src && /\bquest_/i.test(meta.src)) || (meta.def && /\bquest_/i.test(meta.def))) continue;
        const label = item.name || meta.name;
        if (PROTECTED_ITEM_NAME_RE.test(label) || PROTECTED_ITEM_NAME_RE.test(meta.debugname)) continue;
        const count = item.count ?? 1;
        if (meta.stackable) {
            if (!opts.allowStackable || count > KARAMJA_MAX_STACKABLE_DISPENSABLE) continue;
        } else if (count > 1) {
            continue;
        }
        const cost = Number.isFinite(meta.cost) ? meta.cost : Infinity;
        const value = unitValue(item.id, tables);
        if (cost > KARAMJA_MAX_DISPENSABLE_COST || value > KARAMJA_MAX_DISPENSABLE_VALUE) continue;
        if (value * count > KARAMJA_MAX_DISPENSABLE_VALUE) continue;
        scored.push({ item, value, cost, slots: countsById.get(item.id) ?? 1 });
    }
    scored.sort((a, b) => a.value - b.value || a.cost - b.cost || b.slots - a.slots || a.item.slot - b.item.slot);
    return scored.map(s => s.item);
}

// Covers Brimhaven (x <= 2825, z <= 3240) and Musa Point / Jiminua / Shilo (z <= 3190), excluding Rimmington and Crandor.
export const inKaramjaIsland = (p: Pos): boolean =>
    p.level === 0 && p.x >= 2750 && p.x <= 2965 && p.z >= 2880 && (p.z <= 3190 || (p.x <= 2825 && p.z <= 3240));

export function needsKaramjaFareEscape(from: Tile, to: Tile, coins: number): boolean {
    return inKaramjaIsland(from) && !inKaramjaIsland(to) && coins < KARAMJA_SHIP_FARE;
}

type KaramjaSession = Walker & {
    sdk: Walker['sdk'] & {
        getDialog?(): { isOpen: boolean; isWaiting?: boolean; text?: string; options: { index: number; text: string }[] } | null | undefined;
        sendClickDialog?(index: number): Promise<unknown>;
    };
    bot: Walker['bot'] & {
        openShop?(target?: unknown): Promise<{ success?: boolean; message?: string }>;
        sellToShop?(target: unknown, amount?: number | 'all'): Promise<{ success?: boolean; amountSold?: number; message?: string }>;
        closeShop?(): Promise<unknown>;
        dropItem?(target: unknown, amount?: number | 'all'): Promise<{ success?: boolean }>;
    };
    direct?(a: { type: string; [k: string]: unknown }): Promise<unknown>;
};

// 'none' when the account is not stranded on Karamja under 30 gp, 'earned' when it holds >= 30 coins,
// 'stuck' when neither Jiminua's store nor Luthas's banana-crate job could produce 30 coins.
export async function earnKaramjaFare(
    s: Walker,
    to: Tile,
    stop: () => boolean = () => false,
): Promise<'none' | 'earned' | 'stuck'> {
    const sess = s as KaramjaSession;
    const pos = (): Pos | null => {
        const p = s.sdk.getState()?.player;
        return p ? { x: p.worldX, z: p.worldZ, level: p.level } : null;
    };
    const inv = (): readonly InvItem[] => (s.sdk.getState()?.inventory ?? []) as InvItem[];
    const coins = () => inv().filter(i => i.id === 995).reduce((n, i) => n + (i.count ?? 1), 0);
    const bananas = () => inv().filter(i => i.id === KARAMJA_BANANA_ID);
    const start = pos();
    if (!start || !needsKaramjaFareEscape(start, to, coins())) return 'none';

    const done = (r: 'earned' | 'stuck', why: string) => {
        const p = pos();
        console.log(`WALK_KARAMJA_FARE from=${start.x},${start.z},${start.level} ${r} coins=${coins()} inv=${inv().length} at=${p?.x},${p?.z} ${why}`);
        return r;
    };

    const moveTo = async (goal: Tile, tol = 2): Promise<boolean> => {
        const p = pos();
        if (!p || p.level !== goal.level) return false;
        if (Math.max(Math.abs(p.x - goal.x), Math.abs(p.z - goal.z)) <= tol) return true;
        if (sess.client) {
            try {
                const deps = await sessionWalker(sess as unknown as Parameters<typeof sessionWalker>[0], { noFareFloat: true });
                const r = await walkPath(deps, [{ x: goal.x, z: goal.z, tol }], { maxTicks: 240, stop });
                if (r.ok) return true;
            } catch {
                // Fall back to direct walkTo when route-worker/pathfinder adapter is unavailable.
            }
        }
        await s.bot.walkTo(goal.x, goal.z, tol);
        const after = pos();
        return !!after && after.level === goal.level && Math.max(Math.abs(after.x - goal.x), Math.abs(after.z - goal.z)) <= tol;
    };

    // 0. Full 28/28 pack with no bananas: sell cheap dispensable items at Jiminua's General Store first (raising coins
    //    to >= 30 gp or freeing a slot), falling back to dropping 1 cheapest non-quest/non-gear/non-rare item.
    if (inv().length >= 28 && !bananas().length) {
        const sellCandidates = pickDispensableKaramjaItems(inv(), { allowStackable: true });
        if (!sellCandidates.length) return done('stuck', 'full inventory: no safe item to sell or drop');

        let sold = 0;
        if (typeof sess.bot.openShop === 'function' && typeof sess.bot.sellToShop === 'function') {
            if (await moveTo(KARAMJA_JIMINUA_TILE, 4)) {
                const opened = await sess.bot.openShop(/^jiminua$/i).catch(() => ({ success: false }));
                if (opened?.success) {
                    try {
                        for (let step = 0; step < 28 && !stop() && coins() < KARAMJA_SHIP_FARE; step++) {
                            const cand = pickDispensableKaramjaItems(inv(), { allowStackable: true })[0];
                            if (!cand) break;
                            const beforeCoins = coins();
                            const beforeLen = inv().length;
                            const res = await sess.bot.sellToShop(cand, 1).catch(() => ({ success: false, amountSold: 0 }));
                            if (!res?.success && (res?.amountSold ?? 0) <= 0 && inv().length >= beforeLen && coins() === beforeCoins) break;
                            if (inv().length === beforeLen && coins() === beforeCoins) await waitTicks(s, 1);
                            if (inv().length < beforeLen || coins() > beforeCoins || (res?.amountSold ?? 0) > 0) sold++;
                            else break;
                            // If the shop pays 0 gp for this item, stop once 1 slot is freed so Luthas's crate earns 30 gp.
                            if (coins() === beforeCoins && inv().length < 28) break;
                        }
                    } finally {
                        await sess.bot.closeShop?.().catch(() => {});
                    }
                    if (coins() >= KARAMJA_SHIP_FARE) return done('earned', `sold=${sold} at jiminua`);
                }
            }
        }

        if (inv().length >= 28 && !bananas().length) {
            const dropCand = pickDispensableKaramjaItems(inv(), { allowStackable: false })[0];
            if (!dropCand) return done('stuck', `full inventory after shop sold=${sold}: no safe item to drop`);
            const beforeLen = inv().length;
            if (typeof sess.direct === 'function') {
                await sess.direct({ type: 'dropItem', slot: dropCand.slot, reason: 'SDK' });
                await waitUntil(s, () => stop() || inv().length < beforeLen, { timeoutTicks: 8 });
            } else if (typeof sess.bot.dropItem === 'function') {
                await sess.bot.dropItem(dropCand, 1);
                await waitUntil(s, () => stop() || inv().length < beforeLen, { timeoutTicks: 8 });
            }
            if (inv().length >= 28) return done('stuck', `full inventory: drop unobserved id=${dropCand.id}`);
            const p = pos();
            console.log(`WALK_KARAMJA_FARE from=${start.x},${start.z},${start.level} freed coins=${coins()} inv=${inv().length} at=${p?.x},${p?.z} dropped=${dropCand.id}`);
        } else if (sold > 0) {
            const p = pos();
            console.log(`WALK_KARAMJA_FARE from=${start.x},${start.z},${start.level} freed coins=${coins()} inv=${inv().length} at=${p?.x},${p?.z} sold=${sold}`);
        }
    }

    if (typeof sess.direct !== 'function' || typeof sess.sdk.getDialog !== 'function' || typeof sess.sdk.sendClickDialog !== 'function') {
        return done('stuck', 'session missing direct/dialog controls');
    }

    const messages = () => (s.sdk.getState()?.gameMessages ?? []) as readonly { text: string; tick?: number }[];
    const talkLuthas = async (patterns: readonly RegExp[]): Promise<void> => {
        if (!(await moveTo(KARAMJA_LUTHAS_TILE, 3))) return;
        const npc = ((s.sdk.getState()?.nearbyNpcs ?? []) as { index: number; name?: string; distance?: number }[])
            .filter(n => /^luthas$/i.test(n.name ?? ''))
            .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))[0];
        if (!npc) return;
        await sess.direct!({ type: 'interactNpc', npcIndex: npc.index, optionIndex: 1, reason: 'SDK' });
        let opened = false, shut = 0;
        for (let t = 0; t < 40 && !stop(); t++) {
            const d = sess.sdk.getDialog!();
            if (d?.isOpen) {
                opened = true;
                shut = 0;
                if (!d.isWaiting) {
                    const pick = d.options.find(o => patterns.some(re => re.test(o.text)));
                    await sess.sdk.sendClickDialog!(pick ? pick.index : (d.options[0]?.index ?? 0));
                }
            } else if (opened && ++shut >= 2) {
                break;
            }
            if (coins() >= KARAMJA_SHIP_FARE && !d?.isOpen) break;
            await waitTicks(s, 1);
        }
    };

    // 1. Accept employment (or collect payment if a crate was already filled).
    await talkLuthas([/offer me employment/i, /thank you, i'll be on my way/i, /crate isn't full/i]);
    if (coins() >= KARAMJA_SHIP_FARE) return done('earned', 'already filled crate');

    // 2. Pick bananas and pack into Luthas's crate until full (10 bananas) or stopped.
    let packed = 0;
    let crateFull = false;
    for (let round = 0; round < 15 && !stop() && !crateFull && packed < 10; round++) {
        const need = Math.min(10 - packed, Math.max(0, 28 - inv().length));
        if (need > 0 && bananas().length < 10 - packed) {
            if (!(await moveTo(KARAMJA_GROVE_TILE, 4))) break;
            for (let pick = 0; pick < need && !stop() && inv().length < 28 && bananas().length < 10 - packed; pick++) {
                const tree = ((s.sdk.getState()?.nearbyLocs ?? []) as { id: number; x: number; z: number; distance?: number }[])
                    .filter(l => BANANA_TREE_IDS.has(l.id))
                    .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))[0];
                if (!tree) {
                    await waitTicks(s, 2);
                    continue;
                }
                const before = bananas().length;
                await sess.direct!({ type: 'interactLoc', x: tree.x, z: tree.z, locId: tree.id, optionIndex: 1, reason: 'SDK' });
                await waitUntil(s, () => stop() || bananas().length > before, { timeoutTicks: 10 });
            }
        }
        if (!bananas().length) break;
        if (!(await moveTo(KARAMJA_CRATE, 2))) break;
        while (bananas().length > 0 && !stop() && !crateFull && packed < 10) {
            const b = bananas()[0]!;
            const before = bananas().length;
            const msgCount = messages().length;
            await sess.direct!({ type: 'useItemOnLoc', itemSlot: b.slot, x: KARAMJA_CRATE.x, z: KARAMJA_CRATE.z, locId: KARAMJA_CRATE.id, reason: 'SDK' });
            await waitUntil(
                s,
                () => stop() || bananas().length < before || messages().length > msgCount || !!sess.sdk.getDialog!()?.isOpen,
                { timeoutTicks: 8 },
            );
            const newMsgs = messages().slice(msgCount);
            if (newMsgs.some(m => /crate is already full|crate is full/i.test(m.text))) {
                crateFull = true;
                break;
            }
            if (newMsgs.some(m => /why would i want to do that/i.test(m.text))) {
                await talkLuthas([/offer me employment/i]);
                if (!(await moveTo(KARAMJA_CRATE, 2))) break;
                continue;
            }
            if (bananas().length < before) packed++;
            const d = sess.sdk.getDialog!();
            if (d?.isOpen && !d.isWaiting) await sess.sdk.sendClickDialog!(0);
        }
    }

    // 3. Collect the 30-coin payment from Luthas.
    if (packed >= 10 || crateFull) {
        await talkLuthas([/thank you, i'll be on my way/i, /offer me employment/i]);
    }
    return coins() >= KARAMJA_SHIP_FARE ? done('earned', `packed=${packed}`) : done('stuck', `packed=${packed}`);
}
