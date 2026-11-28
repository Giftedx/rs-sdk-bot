// Unified cooking recipes and workers: cookingRecipes (native table), batch cooking, food, stock, wine, mixed-wine, ge-cook.
// Supports FOOD_TYPE: lobster | swordfish | trout | salmon | shark and Cook banked trout/salmon routes.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBot, finish, countItems, randomEventsOf, settle } from '../../../core/src/bot';
import { bankCargo, exactItem } from '../../../core/src/cargo';
import { depositObserved } from '../../../core/src/deposit';
import type { Session } from '../../../core/src/inprocess';
import { componentId } from '../../../core/src/logout';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { sessionWalker, walkPath } from '../../../core/src/walk';
import type { BotWorldState } from '../../../../vendor/rs-sdk/sdk/types';
import { CONTENT_DIR, itemById, packMap } from './catalog';
import { cookingRecipes, DEFAULT_FOOD_TYPE, foodRecipe, foodRule, type CookRecipe, type Heat } from './recipes';
import { actionSessionOwner, finishActionSession, productionStopRequested } from './runtime';
import { geFiremakingOptions, lineTiles, LOGS, runGeFiremaking, type LogKind } from './firemaking';

export { cookingRecipes, DEFAULT_FOOD_TYPE, foodRecipe, foodRule, type CookRecipe, type Heat };

let heatSources: Map<number, Heat> | undefined;

export function nativeHeatSources(): ReadonlyMap<number, Heat> {
    if (heatSources) return heatSources;
    heatSources = new Map();
    const loc = packMap('loc');
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (entry.name !== '_unpack') walk(resolve(dir, entry.name));
            } else if (entry.name.endsWith('.loc')) {
                const text = readFileSync(resolve(dir, entry.name), 'utf8');
                for (const m of text.matchAll(/^\[([^\]]+)\]\r?\n([^\[]*)/gm)) {
                    const category = m[2]!.match(/^category=(cooking_oven|cooking_fire)\r?$/m)?.[1];
                    const value = loc.get(m[1]!);
                    if (category && value !== undefined) heatSources!.set(value, category === 'cooking_oven' ? 'range' : 'fire');
                }
            }
        }
    };
    walk(resolve(CONTENT_DIR, 'scripts'));
    return heatSources;
}

export function cookSnapshot(s: BotWorldState) {
    const items: Record<number, number> = {};
    for (const i of s.inventory) items[i.id] = (items[i.id] ?? 0) + i.count;
    return { items, xp: s.skills.find(k => k.name === 'Cooking')?.experience ?? 0 };
}

export function cookingEffect(
    r: CookRecipe,
    b: ReturnType<typeof cookSnapshot>,
    a: ReturnType<typeof cookSnapshot>,
): { kind: 'cooked' | 'burnt'; product: number } | null {
    const keys = new Set([...Object.keys(b.items), ...Object.keys(a.items)].map(Number));
    if ([...keys].every(id => (a.items[id] ?? 0) === (b.items[id] ?? 0)) && a.xp >= b.xp) return null;
    for (const [kind, products] of [['cooked', r.products], ['burnt', r.burnt === undefined ? [] : [r.burnt]]] as const) {
        for (const product of products) {
            const expected = new Map([[r.raw, -1]]);
            expected.set(product, (expected.get(product) ?? 0) + 1);
            if (r.additional !== undefined && (kind === 'burnt' || !r.noAdditionalSuccess)) {
                expected.set(r.additional, (expected.get(r.additional) ?? 0) + 1);
            }
            if (![...new Set([...keys, ...expected.keys()])].every(id => (a.items[id] ?? 0) - (b.items[id] ?? 0) === (expected.get(id) ?? 0))) {
                continue;
            }
            if (kind === 'cooked' ? (r.xp > 0 ? a.xp <= b.xp : a.xp < b.xp) : a.xp !== b.xp) continue;
            return { kind, product };
        }
    }
    throw Error('cooking raw, product, returned container or XP does not reconcile');
}

export interface CookingDriver {
    state: () => BotWorldState | null;
    tick: () => number;
    stop: () => boolean;
    heat: (slot: number, source: Heat, r: CookRecipe) => Promise<boolean>;
    wait: (test: () => boolean, ticks: number) => Promise<boolean>;
    step: () => Promise<void>;
    close: () => Promise<void>;
}

export async function runCookingBatch(
    d: CookingDriver,
    r: CookRecipe,
    o: { maximum: number; cap: number; heat: Heat; expectedProduct?: number },
) {
    if (!Number.isSafeInteger(o.maximum) || o.maximum < 1 || !Number.isSafeInteger(o.cap) || o.cap < 1 || !['range', 'fire'].includes(o.heat)) {
        throw Error('invalid cooking batch bounds');
    }
    if (!r[o.heat]) throw Error('native recipe forbids ' + o.heat);
    if (o.expectedProduct !== undefined && !r.products.includes(o.expectedProduct)) {
        throw Error('expected cooked product is not native recipe variant');
    }
    const initial = d.state();
    if (!initial?.player) throw Error('cooking state unknown');
    const initialHp = initial.skills.find(k => k.name === 'Hitpoints')?.level ?? 0;
    if (initialHp < 1) throw Error('cooking health unknown');
    if ((initial.skills.find(k => k.name === 'Cooking')?.level ?? 0) < r.level) throw Error('Cooking level insufficient');
    const start = d.tick();
    let cooked = 0;
    let burnt = 0;
    const products: Record<number, number> = {};
    const state = () => {
        const s = d.state();
        if (!s?.player) throw Error('cooking session ended');
        if (d.stop()) throw Error('cooking stopped');
        if (d.tick() - start >= o.cap) throw Error('cooking cap');
        if (s.player.lifeId !== initial.player!.lifeId || s.player.level !== initial.player!.level || s.player.isDead || (s.skills.find(k => k.name === 'Hitpoints')?.level ?? 0) !== initialHp) {
            throw Error('cooking life, floor or health changed');
        }
        return s;
    };
    try {
        while (cooked + burnt < o.maximum) {
            const before = state();
            const raw = before.inventory.find(i => i.id === r.raw);
            if (!raw) throw Error('staged cooking input exhausted');
            const snapshot = cookSnapshot(before);
            if (r.additional !== undefined && before.inventory.length >= 28) throw Error('cooking needs space for returned container');
            if (before.dialog?.isOpen || before.interface?.isOpen || before.modalOpen) await d.close();
            if (!await d.heat(raw.slot, o.heat, r)) throw Error('cooking heat action refused');
            let effect: ReturnType<typeof cookingEffect> = null;
            if (!await d.wait(() => !!(effect = cookingEffect(r, snapshot, cookSnapshot(state()))), Math.min(12, o.cap - (d.tick() - start)))) {
                throw Error('cooking effect unobserved');
            }
            const observed = effect as unknown as { kind: 'cooked' | 'burnt'; product: number };
            if (observed.kind === 'cooked') {
                cooked++;
                if (o.expectedProduct !== undefined && observed.product !== o.expectedProduct) {
                    throw Error('cooking produced a different native staged variant');
                }
            } else {
                burnt++;
            }
            products[observed.product] = (products[observed.product] ?? 0) + 1;
            if (cooked + burnt < o.maximum) await d.step();
        }
        return { processed: cooked + burnt, cooked, burnt, products, xp: cookSnapshot(state()).xp - cookSnapshot(initial).xp, ticks: d.tick() - start };
    } finally {
        await d.close();
    }
}

export async function runSessionCookingBatch(
    s: Session,
    recipe: CookRecipe,
    heat: Heat,
    maximum: number,
    cap: number,
    stop: () => boolean = () => false,
    expectedProduct?: number,
) {
    let ended = false;
    void s.ended?.then(() => { ended = true; });
    const start = s.tick();
    const isStopped = () => ended || stop() || productionStopRequested(s.name);
    return runCookingBatch(
        {
            state: () => s.sdk.getState(),
            tick: () => s.tick(),
            stop: isStopped,
            close: async () => { await s.sdk.sendCloseModal(); },
            heat: async (slot, kind, r) => {
                if (isStopped() || s.tick() - start >= cap) return false;
                const before = s.sdk.getState()!;
                const target = before.nearbyLocs
                    .filter(l => nativeHeatSources().get(l.id) === kind && l.distance <= 2 && l.reachable !== false)
                    .sort((a, b) => a.distance - b.distance)[0];
                if (!target) throw Error('stage beside native ' + kind);
                if (!(await s.sdk.sendUseItemOnLoc(slot, target.x, target.z, target.id)).success) return false;
                if (r.karambwanChoice) {
                    await waitUntil(
                        s,
                        st => isStopped() || !!st.dialog?.isOpen || (st.inventory ?? []).filter((i: { id: number }) => i.id === r.raw).length < before.inventory.filter(i => i.id === r.raw).length,
                        { timeoutTicks: Math.min(6, Math.max(1, cap - (s.tick() - start))) },
                    );
                    const dialog = s.sdk.getState()?.dialog;
                    if (dialog?.isOpen) {
                        if (isStopped()) return false;
                        return (await s.sdk.sendClickComponent(componentId(`multiobj2:objtext${r.karambwanChoice}`))).success;
                    }
                }
                return true;
            },
            wait: (test, ticks) => waitUntil(s, test, { timeoutTicks: ticks }),
            step: () => waitTicks(s, 1),
        },
        recipe,
        { maximum, cap, heat, expectedProduct },
    );
}

// ---- Shark cooking & Catherby food cooking (cook-food.ts) ----

export function sharkCookDelta(before: { raw: number; cooked: number; burnt: number }, after: typeof before) {
    const raw = before.raw - after.raw;
    const cooked = after.cooked - before.cooked;
    const burnt = after.burnt - before.burnt;
    if (raw < 1 || cooked < 0 || burnt < 0 || raw !== cooked + burnt) throw Error('shark cook deltas do not reconcile');
    return { raw, cooked, burnt };
}

export async function cookSharks(s: Session, stop: () => boolean) {
    if ((s.sdk.getSkill('Cooking')?.level ?? 0) < 80) throw Error('sharks require Cooking80');
    const counts = () => {
        const n = (id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((v, i) => v + i.count, 0);
        return { raw: n(383), cooked: n(385), burnt: n(387) };
    };
    const before = counts();
    let progress = s.tick();
    let last = before.raw;
    while (counts().raw > 0) {
        if (stop()) throw Error('shark cooking budget/health stop');
        if (s.tick() - progress >= 40) throw Error('shark cooking no progress');
        const st = s.sdk.getState();
        if (st?.dialog?.isOpen) {
            await s.sdk.sendCloseModal?.();
        }
        const range = st?.nearbyLocs.find(l => /^(range|cooking range)$/i.test(l.name) && l.x === 2817 && l.z === 3443)
            ?? st?.nearbyLocs.find(l => /^(range|cooking range)$/i.test(l.name) && Math.max(Math.abs(l.x - 2816), Math.abs(l.z - 3443)) <= 2);
        if (!range) throw Error('Catherby range unobserved');
        const raw = s.sdk.getInventory().find(i => i.id === 383)!;
        await s.sdk.sendUseItemOnLoc(raw.slot, range.x, range.z, range.id);
        await waitUntil(s, () => stop() || counts().raw < last || !!s.sdk.getState()?.dialog?.isOpen, { timeoutTicks: 10 });
        if (counts().raw < last) {
            last = counts().raw;
            progress = s.tick();
        }
    }
    return before.raw ? sharkCookDelta(before, counts()) : { raw: 0, cooked: 0, burnt: 0 };
}

// The fail words match isNoProgressFailure (packages/practice/src/supervise.ts): a new login does not raise the level.
export function cookLevelShortfall(foodType: string, cookingLevel: number): string | null {
    const need = foodRule(foodType).level;
    return cookingLevel >= need ? null : `no cooking progress: Cooking ${cookingLevel} is below level ${need} for ${foodType}`;
}

// Below the level the server opens a message box and cooks nothing (cooking.rs2: ~mesbox($levelrequired_message)).
const COOK_LEVEL_REFUSAL = /You need a Cooking level of (\d+)/i;

export interface CookRefusalView {
    dialog?: { isOpen?: boolean; text?: string; allComponents?: readonly { text: string }[] };
    gameMessages?: readonly { text: string; tick: number }[];
}

// The level that the server asked for, from the open dialog or from a game message at or after sinceTick.
export function cookLevelRefusal(state: CookRefusalView | null | undefined, sinceTick: number): number | null {
    const dialog = state?.dialog?.isOpen ? state.dialog : undefined;
    const texts = [
        dialog?.text,
        ...(dialog?.allComponents ?? []).map(c => c.text),
        ...(state?.gameMessages ?? []).filter(m => m.tick >= sinceTick).map(m => m.text),
    ];
    for (const text of texts) {
        const m = text?.match(COOK_LEVEL_REFUSAL);
        if (m) return Number(m[1]);
    }
    return null;
}

const escapeName = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Exact item names of the server row: "shrimp" cooks "Raw shrimps" into "Shrimps", "chicken" makes "Cooked chicken".
// A lobster pot is not a cooked lobster.
export function foodNames(food: string): { raw: string; cooked: string } {
    const rule = foodRecipe(food) ? foodRule(food) : undefined;
    const raw = rule ? itemById(rule.rawId)?.name : undefined;
    const cooked = rule?.cookedId !== undefined ? itemById(rule.cookedId)?.name : undefined;
    return { raw: raw ?? `raw ${food}`, cooked: cooked ?? food };
}

export const rawFoodPattern = (food: string) => new RegExp(`^${escapeName(foodNames(food).raw)}$`, 'i');
export const cookedFoodPattern = (food: string) => new RegExp(`^${escapeName(foodNames(food).cooked)}$`, 'i');
// The cooked food and any burnt item, not a tool such as a lobster pot.
export const foodDepositPattern = (food: string) => new RegExp(`^(?:${escapeName(foodNames(food).cooked)}|burnt .+)$`, 'i');

const CATHERBY_RANGE = { x: 2816, z: 3443 };
const CATHERBY_BANK = { x: 2809, z: 3441 };

export async function runCookFood(
    s: Session,
    foodTypeInput = DEFAULT_FOOD_TYPE,
    cap = 15000,
    stop: () => boolean = () => false,
    maximum = Infinity,
) {
    const FOOD_TYPE = foodTypeInput.toLowerCase();
    const recipe = foodRecipe(FOOD_TYPE);
    const karambwanChoice = recipe?.karambwanChoice;
    const cookedId = recipe?.products[0];
    const pos = () => s.sdk.getState()?.player;
    const rawRe = rawFoodPattern(FOOD_TYPE);
    const cookedRe = cookedFoodPattern(FOOD_TYPE);
    const rawCount = () => countItems(s, rawRe);
    // Thoroughly cooked karambwan (3144) shares display name with poorly cooked karambwan (3146); count by ID for karambwan.
    const cookedCount = () =>
        FOOD_TYPE === 'karambwan' && cookedId !== undefined
            ? s.sdk.getInventory().filter(i => i.id === cookedId).reduce((n, i) => n + i.count, 0)
            : countItems(s, cookedRe);
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    const over = () => stop() || used() >= cap;

    let cookedTotal = 0;
    let bankTrips = 0;
    let walkTicks = 0;
    const counters = () => `cookedTotal=${cookedTotal} heldCooked=${cookedCount()} heldRaw=${rawCount()} bankTrips=${bankTrips} walkTicks=${walkTicks}`;

    let cachedWalker: ReturnType<typeof sessionWalker> | undefined;
    const walk = async (x: number, z: number, tol = 1): Promise<boolean> => {
        const a = s.tick();
        const walker = await (cachedWalker ??= sessionWalker(s));
        for (let i = 0; i < 3 && !over(); i++) {
            const p = pos();
            if (p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol) break;
            const r = await walkPath(walker, [{ x, z, tol }], { stop: over });
            if (!r.ok) {
                console.log(`WALK fail ${r.detail} ticks=${r.ticks}`);
                await waitTicks(s, 1);
            }
        }
        walkTicks += s.tick() - a;
        const p = pos();
        return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
    };

    const bank = async (): Promise<'ok' | 'empty' | 'failed'> => {
        await walk(CATHERBY_BANK.x, CATHERBY_BANK.z, 2);
        const b = await s.bot.openBank();
        if (!b.success) {
            console.log(`WARN openBank failed: ${b.message}`);
            await waitTicks(s, 1);
            return 'failed';
        }
        await s.bot.depositItem(foodDepositPattern(FOOD_TYPE), -1);
        const loaded = (s.sdk.getState()?.bank?.items?.length ?? 0) > 0
            || await waitUntil(s, () => (s.sdk.getState()?.bank?.items?.length ?? 0) > 0, { timeoutTicks: 5 });
        const empty = loaded && !(s.sdk.getState()?.bank?.items ?? []).some((i: { name: string; count: number }) => rawRe.test(i.name) && i.count > 0);
        const wantWithdraw = Number.isFinite(maximum) ? Math.min(28, Math.max(1, maximum - cookedTotal)) : 28;
        if (!empty && wantWithdraw > 0) await s.bot.withdrawItem(rawRe, wantWithdraw);
        bankTrips++;
        await s.bot.closeInterface();
        return empty ? 'empty' : 'ok';
    };

    console.log(`START food cooker ${s.name} at=${pos()?.worldX},${pos()?.worldZ} food=${FOOD_TYPE}`);
    const cookingLevel = () => s.sdk.getSkill('Cooking')?.level ?? 0;
    let failure: string | undefined;
    if (await waitUntil(s, () => cookingLevel() > 0, { timeoutTicks: 15 })) {
        failure = cookLevelShortfall(FOOD_TYPE, cookingLevel()) ?? undefined;
    }
    if (failure) console.log(`STOP ${failure}`);
    while (!failure && !over() && cookedTotal < maximum) {
        if (rawCount() === 0) {
            const banked = await bank();
            if (banked === 'empty' && rawCount() === 0) {
                console.log(`STOP no raw ${FOOD_TYPE} left in the pack or the bank`);
                break;
            }
            if (rawCount() === 0) {
                await waitTicks(s, 2);
                continue;
            }
        }
        const p = pos();
        if (!p) { await waitTicks(s, 1); continue; }
        if (Math.max(Math.abs(p.worldX - CATHERBY_RANGE.x), Math.abs(p.worldZ - CATHERBY_RANGE.z)) > 2) {
            await walk(CATHERBY_RANGE.x, CATHERBY_RANGE.z, 1);
            continue;
        }
        const range = s.sdk.findNearbyLoc(/range|oven/i);
        if (!range) {
            await waitTicks(s, 1);
            continue;
        }
        const rawItem = s.sdk.getInventory().find(i => rawRe.test(i.name));
        if (!rawItem) continue;
        if (s.sdk.getState()?.dialog?.isOpen && cookLevelRefusal(s.sdk.getState(), 0) === null) {
            await s.sdk.sendCloseModal?.();
        }
        const rawBefore = rawCount();
        const before = cookedCount();
        const sentTick = s.tick();
        await s.sdk.sendUseItemOnLoc(rawItem.slot, range.x, range.z, range.id);
        if (karambwanChoice) {
            await waitUntil(
                s,
                () => over() || !!s.sdk.getState()?.dialog?.isOpen || rawCount() < rawBefore || cookedCount() > before || cookLevelRefusal(s.sdk.getState(), sentTick) !== null,
                { timeoutTicks: 6 },
            );
            const dlg = s.sdk.getState()?.dialog;
            if (dlg?.isOpen && cookLevelRefusal(s.sdk.getState(), sentTick) === null && !over()) {
                await s.sdk.sendClickComponent(componentId(`multiobj2:objtext${karambwanChoice}`));
            }
        }
        await waitUntil(
            s,
            () => over() || rawCount() < rawBefore || cookedCount() > before || rawCount() === 0 || cookLevelRefusal(s.sdk.getState(), sentTick) !== null,
            { timeoutTicks: 10 },
        );
        const gained = cookedCount() - before;
        if (gained > 0) cookedTotal += gained;
        const refused = cookLevelRefusal(s.sdk.getState(), sentTick);
        if (refused !== null && gained <= 0) {
            failure = `no cooking progress: the server needs Cooking ${refused} for ${FOOD_TYPE} and the account has ${cookingLevel()}`;
            console.log(`STOP ${failure}`);
        }
    }
    if (bankTrips > 0 && !failure && !over() && countItems(s, foodDepositPattern(FOOD_TYPE)) > 0) {
        if (await walk(CATHERBY_BANK.x, CATHERBY_BANK.z, 2)) {
            const b = await s.bot.openBank();
            if (b.success) {
                await s.bot.depositItem(foodDepositPattern(FOOD_TYPE), -1);
                await s.bot.closeInterface();
            }
        }
    }

    // cookedTotal already holds the cooked food still in the pack.
    const total = cookedTotal;
    const perK = (total * 1000 / Math.max(1, used())).toFixed(2);
    const counts = `ticks=${used()} ${counters()} cookedPer1kTicks=${perK}`;
    const summary = failure ? `${failure} ${counts}` : counts;
    return { ok: !failure && total > 0, summary, total, cookedTotal, ticks: used(), ...(failure ? { failure } : {}) };
}

// ---- Banked stock cooking (cook-stock.ts) ----

const RAW_LEVEL: Record<string, number> = { 'raw trout': 15, 'raw salmon': 25 };
const RAW_STOCK_RE = /^raw (trout|salmon)$/i;
const PRODUCT_STOCK_RE = /^(trout|salmon|burnt fish)$/i;
const FOOD_STOCK_RE = /^(trout|salmon)$/i;
const DRAYNOR_COOK_BANK = { x: 3092, z: 3243 };
type StockItem = { id: number; name: string; count: number };

export function selectRawStock(bank: StockItem[], level: number, slots: number, reserve = 50, limit = Infinity): { id: number; name: string; amount: number }[] {
    let left = Math.max(0, Math.min(slots, limit));
    return bank
        .filter(i => level >= (RAW_LEVEL[i.name.toLowerCase()] ?? Infinity))
        .sort((a, b) => RAW_LEVEL[b.name.toLowerCase()]! - RAW_LEVEL[a.name.toLowerCase()]!)
        .flatMap(i => {
            const amount = Math.min(left, Math.max(0, i.count - Math.max(50, reserve)));
            left -= amount;
            return amount > 0 ? [{ id: i.id, name: i.name, amount }] : [];
        });
}

export function depositPlan(inventory: StockItem[], protectedCounts: ReadonlyMap<number, number>): { item: StockItem; amount: number }[] {
    const seen = new Set<number>();
    return inventory.flatMap(item => {
        if (seen.has(item.id) || !PRODUCT_STOCK_RE.test(item.name)) return [];
        seen.add(item.id);
        const amount = inventory.filter(i => i.id === item.id).reduce((n, i) => n + i.count, 0) - (protectedCounts.get(item.id) ?? 0);
        return amount > 0 ? [{ item, amount }] : [];
    });
}

export async function runCookStock(
    s: Session,
    options: { cap: number; reserve: number; maximum: number; route: 'near' | 'north' | 'far'; stop?: () => boolean },
) {
    const { cap, reserve, maximum, route } = options;
    if (!Number.isSafeInteger(cap) || cap <= 0 || !Number.isSafeInteger(reserve) || !Number.isSafeInteger(maximum) || maximum <= 0 || !['near', 'north', 'far'].includes(route)) {
        throw new Error('usage: cooking:stock requires positive CAP, RAW_RESERVE>=50, MAX_COOK>0, COOK_ROUTE=near|north|far');
    }
    const fire = route === 'far' ? { x: 3214, z: 3249 } : route === 'north' ? { x: 3101, z: 3281 } : { x: 3100, z: 3256 };
    const synced = await waitUntil(s, () => (s.sdk.getSkill('Hitpoints')?.level ?? 0) > 0 && (s.sdk.getSkill('Cooking')?.baseLevel ?? 0) > 0, { timeoutTicks: 15 });
    if (!synced) throw Error('skill sync timed out');
    const st = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const countId = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const rawCount = () => inv().filter(i => RAW_STOCK_RE.test(i.name)).reduce((n, i) => n + i.count, 0);
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    let died = false;
    let ended = false;
    let returning = false;
    const life = st()?.player?.lifeId;
    const respawns = st()?.player?.respawnCount ?? 0;
    let hpMin = s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const off = s.onTick(() => {
        const p = st()?.player;
        hpMin = Math.min(hpMin, s.sdk.getSkill('Hitpoints')?.level ?? hpMin);
        if (p?.isDead || hpMin <= 0 || (p?.respawnCount ?? 0) > respawns || (life !== undefined && (p?.lifeId ?? life) !== life)) died = true;
    });
    void s.ended?.then(() => { ended = true; });
    const over = () => died || ended || (!returning && !!options.stop?.()) || used() >= cap + (returning ? 200 : 0);
    const protectedCounts = new Map<number, number>();
    for (const i of inv()) if (!RAW_STOCK_RE.test(i.name)) protectedCounts.set(i.id, (protectedCounts.get(i.id) ?? 0) + i.count);

    let processed = 0;
    let banked = 0;
    let burntBanked = 0;
    let trips = 0;
    let walkTicks = 0;
    let cookTicks = 0;
    let bankTicks = 0;
    let lastBank: StockItem[] = [];
    let failure = '';

    const walk = async (points: { x: number; z: number; tol: number }[]) => {
        const t = s.tick();
        try {
            const r = await walkPath(await sessionWalker(s), points, { stop: over });
            if (!r.ok) throw new Error(`walk ${r.detail}`);
        } finally {
            walkTicks += s.tick() - t;
        }
    };
    const bankPath = route === 'far'
        ? [{ x: 3180, z: 3258, tol: 3 }, { x: 3100, z: 3285, tol: 3 }, { x: 3089, z: 3266, tol: 2 }, { x: 3092, z: 3250, tol: 1 }, { ...DRAYNOR_COOK_BANK, tol: 2 }]
        : [{ x: 3092, z: 3250, tol: 1 }, { ...DRAYNOR_COOK_BANK, tol: 2 }];
    const toFire = route === 'far'
        ? [...bankPath.slice(0, -1).reverse(), { x: fire.x + 1, z: fire.z, tol: 1 }]
        : [{ x: 3092, z: 3250, tol: 1 }, { x: fire.x - 1, z: fire.z, tol: 1 }];

    const bank = async (initial = false) => {
        const p = st()?.player;
        if (!p || p.level !== 0) throw new Error('cook-stock requires ground floor');
        if (route === 'near' && p.worldX === fire.x - 1 && p.worldZ === fire.z) {
            await walk([{ x: fire.x - 2, z: fire.z, tol: 0 }]);
        }
        if (Math.max(Math.abs(p.worldX - DRAYNOR_COOK_BANK.x), Math.abs(p.worldZ - DRAYNOR_COOK_BANK.z)) > 2) await walk(bankPath);
        const t = s.tick();
        try {
            const b = await s.bot.openBank();
            if (!b.success) throw new Error(`bank: ${b.message}`);
            const rawIds = [...new Set(inv().filter(i => RAW_STOCK_RE.test(i.name)).map(i => i.id))];
            for (const id of rawIds) {
                const item = inv().find(i => i.id === id)!;
                const result = await s.bot.depositItem(item, -1);
                if (countId(id) > 0) throw new Error(`raw deposit: ${result.message}`);
            }
            for (const { item, amount } of depositPlan(inv(), protectedCounts)) {
                const before = countId(item.id);
                await s.bot.depositItem(inv().find(i => i.id === item.id)!, amount);
                const actual = before - countId(item.id);
                if (FOOD_STOCK_RE.test(item.name)) banked += actual;
                else burntBanked += actual;
                if (actual !== amount) throw new Error(`partial product deposit ${item.name}: ${actual}/${amount}`);
            }
            lastBank = (st()?.bank?.items ?? []).map(i => ({ ...i }));
            trips++;
            if (!initial) console.log(`MILESTONE banked=${banked} burntBanked=${burntBanked} processed=${processed} trips=${trips} ticks=${used()}`);
            const cargoStopped = () => !!options.stop?.() || died || ended || used() >= cap;
            if (!cargoStopped()) await bankCargo(s, [FOOD_STOCK_RE], 0, { stopped: cargoStopped });
            lastBank = (st()?.bank?.items ?? []).map(i => ({ ...i }));
        } finally {
            bankTicks += s.tick() - t;
        }
    };

    try {
        console.log(`START cook-stock route=${route} reserve=${reserve} maximum=${maximum} cooking=${s.sdk.getSkill('Cooking')?.level}`);
        await bank(true);
        while (!over() && processed < maximum) {
            const choices = selectRawStock(lastBank, s.sdk.getSkill('Cooking')?.level ?? 1, 28 - inv().length, reserve, maximum - processed);
            if (!choices.length) break;
            for (const choice of choices) await s.bot.withdrawItem(exactItem(choice.name), choice.amount, { asNote: false });
            await s.bot.closeBank();
            if (rawCount() === 0) throw new Error('withdraw made no progress');
            await walk(toFire);
            let stall = 0;
            let previous = rawCount();
            const t = s.tick();
            while (rawCount() > 0 && !over() && stall < 12) {
                if (randomEventsOf(s)?.busy()) {
                    await waitTicks(s, 1);
                    continue;
                }
                const locTarget = st()?.nearbyLocs.find(l => l.id === 2724 && l.x === fire.x && l.z === fire.z);
                if (!locTarget) throw new Error(`missing fireplace2724 at ${fire.x},${fire.z}`);
                const raw = inv().find(i => RAW_STOCK_RE.test(i.name) && (s.sdk.getSkill('Cooking')?.level ?? 1) >= RAW_LEVEL[i.name.toLowerCase()]!);
                if (!raw) throw new Error('no eligible raw in inventory');
                if (s.sdk.getDialog()?.isOpen || st()?.interface?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
                await s.direct({ type: 'useItemOnLoc', itemSlot: raw.slot, x: locTarget.x, z: locTarget.z, locId: locTarget.id, reason: 'SDK' });
                await waitTicks(s, 1);
                const current = rawCount();
                processed += Math.max(0, previous - current);
                stall = current < previous ? 0 : stall + 1;
                previous = current;
            }
            cookTicks += s.tick() - t;
            if (stall >= 12) throw new Error('cooking made no progress for12 ticks');
            returning = true;
            if (!died && !ended) await bank();
            returning = false;
        }
    } catch (e) {
        failure = String(e);
    }
    returning = true;
    if (!died && !ended && !st()?.bank?.isOpen) {
        try {
            await bank();
        } catch (e) {
            failure ||= `final bank ${String(e)}`;
        }
    }
    off();
    const preserved = [...protectedCounts].every(([id, count]) => countId(id) >= count);
    if (!preserved) failure ||= 'held asset shortfall';
    const rawLeft = lastBank.filter(i => RAW_STOCK_RE.test(i.name)).map(i => `${i.name.replaceAll(' ', '_')}:${i.count}`).join(',') || '-';
    const cookedStock = lastBank.filter(i => FOOD_STOCK_RE.test(i.name)).map(i => `${i.name}:${i.count}`).join(',') || '-';
    const ok = !failure && !died && !ended && banked > 0;
    const summary = `route=${route} ticks=${used()} processed=${processed} banked=${banked} burntBanked=${burntBanked} rawLeft=${rawLeft} cookedStock=${cookedStock} trips=${trips} walkTicks=${walkTicks} cookTicks=${cookTicks} bankTicks=${bankTicks} hpMin=${hpMin} preserved=${preserved} died=${died} failure=${failure || '-'}`;
    return { ok, summary, banked, processed, ticks: used(), failure: failure || undefined };
}

// ---- Wine fermentation (cook-wine.ts & microbot-wine.ts) ----

type WineOrderOptions = { target: number; cap: number; stop?: () => boolean };
type WineStageResult = { ok: boolean; targetMet: boolean; level: number; ticks: number; banked: number; detail: string };
export type WineStage = (name: string, options: WineOrderOptions, phase: 'starter' | 'finish') => Promise<WineStageResult>;

export function starterConsumed(stock: { bankRaw: number; heldRaw: number } | null): boolean {
    return stock !== null && stock.bankRaw === 0 && stock.heldRaw === 0;
}

const playWineStage: WineStage = async (name, options, phase) => {
    const s = await openBot(name);
    const start = s.tick();
    const level = () => s.sdk.getSkill('Cooking')?.baseLevel ?? 0;
    const xp = () => s.sdk.getSkillXp('Cooking') ?? 0;
    let banked = 0;
    let detail = '';
    let ok = false;
    try {
        if (level() < options.target) {
            if (phase === 'starter') {
                const xp0 = xp();
                if (!await waitUntil(s, () => level() >= options.target || xp() > xp0, { timeoutTicks: Math.min(options.cap, 25) })) {
                    if (!(await s.bot.openBank()).success) throw Error('starter outcome bank refused');
                    if (!await waitUntil(s, () => !!s.bankObservation?.(), { timeoutTicks: 10 })) throw Error('starter outcome unknown');
                    const bank = s.bankObservation?.();
                    const bankRaw = bank?.items.filter(i => i.id === 1995).reduce((n, i) => n + i.count, 0) ?? NaN;
                    const heldRaw = s.sdk.getInventory().filter(i => i.id === 1995).reduce((n, i) => n + i.count, 0);
                    if (!starterConsumed(bank ? { bankRaw, heldRaw } : null)) throw Error('starter wine has not settled');
                }
                if (level() < options.target) {
                    const notes = s.sdk.getInventory().find(i => i.id === 1996);
                    if (!notes || notes.count < 1) throw Error('wine order needs more owned bulk stock');
                    const amount = notes.count;
                    if (!s.sdk.getState()?.bank.isOpen && !(await s.bot.openBank()).success) throw Error('wine bulk bank refused');
                    banked = await depositObserved(s, notes);
                    if (banked !== amount) throw Error('wine bulk credit mismatch');
                }
            } else if (!await waitUntil(s, () => level() >= options.target, { timeoutTicks: options.cap })) {
                throw Error('wine order short of target; acquire more stock');
            }
        }
        ok = phase === 'starter' ? (level() >= options.target || banked > 0) : level() >= options.target;
        detail = `phase=${phase} level=${level()} target=${options.target} banked=${banked} ticks=${s.tick() - start}`;
    } catch (error) {
        detail = String(error);
    }
    const result = { ok, targetMet: level() >= options.target, level: level(), ticks: s.tick() - start, banked, detail };
    result.ok = await settle([s], ok, detail);
    return result;
};

export async function runWineSession(s: Session, options: WineOrderOptions): Promise<WineStageResult> {
    if (!Number.isSafeInteger(options.target) || options.target < 1 || options.target > 99 || !Number.isSafeInteger(options.cap) || options.cap < 1) {
        throw Error('invalid wine order');
    }
    const start = s.tick();
    let ended = false;
    void s.ended?.then(() => {
        ended = true;
    });
    const stopped = () => ended || productionStopRequested(s.name, options.stop);
    const level = () => s.sdk.getSkill('Cooking')?.baseLevel ?? 0;
    const xp = () => s.sdk.getSkillXp('Cooking') ?? 0;
    let banked = 0;
    let detail = '';
    let ok = false;
    try {
        if (stopped()) throw Error('wine session stopped');
        if (level() < options.target) {
            const xp0 = xp();
            if (!await waitUntil(s, () => stopped() || level() >= options.target || xp() > xp0, { timeoutTicks: Math.min(options.cap, 25) })) {
                if (stopped()) throw Error('wine session stopped');
                if (!(await s.bot.openBank()).success) throw Error('starter outcome bank refused');
                if (!await waitUntil(s, () => stopped() || !!s.bankObservation?.(), { timeoutTicks: 10 })) throw Error('starter outcome unknown');
                if (stopped()) throw Error('wine session stopped');
                const bank = s.bankObservation?.();
                const bankRaw = bank?.items.filter(i => i.id === 1995).reduce((n, i) => n + i.count, 0) ?? NaN;
                const heldRaw = s.sdk.getInventory().filter(i => i.id === 1995).reduce((n, i) => n + i.count, 0);
                if (!starterConsumed(bank ? { bankRaw, heldRaw } : null)) throw Error('starter wine has not settled');
            }
            if (stopped()) throw Error('wine session stopped');
            if (level() < options.target) {
                const notes = s.sdk.getInventory().find(i => i.id === 1996);
                if (notes && notes.count >= 1) {
                    const amount = notes.count;
                    if (!s.sdk.getState()?.bank.isOpen && !(await s.bot.openBank()).success) throw Error('wine bulk bank refused');
                    banked = await depositObserved(s, notes);
                    if (banked !== amount) throw Error('wine bulk credit mismatch');
                }
            }
            if (stopped()) throw Error('wine session stopped');
            if (level() < options.target) {
                const remaining = Math.max(1, options.cap - (s.tick() - start));
                if (!await waitUntil(s, () => stopped() || level() >= options.target, { timeoutTicks: remaining })) {
                    throw Error('wine order short of target; acquire more stock');
                }
            }
        }
        if (stopped() && level() < options.target) throw Error('wine session stopped');
        ok = level() >= options.target;
        detail = `phase=session level=${level()} target=${options.target} banked=${banked} ticks=${s.tick() - start}`;
    } catch (error) {
        detail = String(error);
    }
    return { ok, targetMet: level() >= options.target, level: level(), ticks: s.tick() - start, banked, detail };
}

export async function runWineOrder(name: string, options: WineOrderOptions, stage: WineStage = playWineStage) {
    if (!name || !Number.isSafeInteger(options.target) || options.target < 1 || options.target > 99 || !Number.isSafeInteger(options.cap) || options.cap < 1) {
        throw Error('invalid wine order');
    }
    let ticks = 0;
    const stages: WineStageResult[] = [];
    for (const phase of ['starter', 'finish'] as const) {
        const result = await stage(name, options, phase);
        stages.push(result);
        ticks += result.ticks;
        if (!result.ok) return { ok: false, targetMet: false, level: result.level, ticks, stages };
        if (result.targetMet && result.level >= options.target) return { ok: true, targetMet: true, level: result.level, ticks, stages };
    }
    return { ok: false, targetMet: false, level: stages.at(-1)?.level ?? 0, ticks, stages };
}

export function wineOutcome(
    before: { good: number; bad: number },
    after: { good: number; bad: number; raw: number },
    made: number,
    allowAllBad = false,
) {
    const good = after.good - before.good;
    const bad = after.bad - before.bad;
    return { ok: after.raw === 0 && good >= 0 && bad >= 0 && good + bad === made && (good > 0 || allowAllBad), good, bad };
}

export interface InventoryCombineRecipe {
    name: string;
    inputs: { id: number; units: number }[];
    tools: number[];
    product: number;
    productUnits?: number;
    optionalInputs?: number[];
    skill: 'Cooking' | 'Fletching' | 'Crafting' | 'Herblore';
    level: number;
    xp: boolean;
    members: boolean;
    source: string;
}

export type RunInventoryBankFn = (
    s: Session,
    r: InventoryCombineRecipe,
    o: {
        maximum: number;
        cap: number;
        maxAttempts?: number;
        partial?: boolean;
        reserve?: number;
        inputReserves?: Readonly<Record<number, number>>;
        members?: boolean;
        stop?: () => boolean;
    },
) => Promise<{ ok: boolean; made: number; banked: number; ticks: number; failure: string; consumed?: number; xp?: number; stop?: string }>;

// Mixed-wine recipe descriptor matches wine-unfermented in crafting inventory recipes.
export const WINE_UNFERMENTED_RECIPE: InventoryCombineRecipe = {
    name: 'wine-unfermented',
    inputs: [{ id: 1987, units: 1 }, { id: 1937, units: 1 }],
    tools: [],
    product: 1995,
    skill: 'Cooking',
    level: 35,
    xp: false,
    members: false,
    source: 'scripts/skill_cooking/scripts/cooking_inv/wine.rs2',
};

let defaultMixedWineRunner: RunInventoryBankFn | undefined;
export function registerDefaultInventoryBankRunner(fn: RunInventoryBankFn) {
    defaultMixedWineRunner = fn;
}

export async function runMixedWine(
    s: Session,
    maximum: number,
    cap: number,
    stop: () => boolean = () => false,
    reserve = 0,
    options: { allowAllBad?: boolean; runInventoryBank?: RunInventoryBankFn } = {},
) {
    if (!Number.isSafeInteger(reserve) || reserve < 0) throw Error('invalid wine reserve');
    if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(cap) || cap < 35) {
        throw Error('wine requires positive count and at least 35 ticks');
    }
    const runner = options.runInventoryBank ?? defaultMixedWineRunner;
    if (!runner) throw Error('wine inventory runner unavailable');
    let ended = false;
    void s.ended?.then(() => { ended = true; });
    const initial = s.sdk.getState()?.player;
    const stopped = () => {
        const p = s.sdk.getState()?.player;
        return ended || stop() || !initial || !p || p.isDead || p.lifeId !== initial.lifeId;
    };
    const start = s.tick();
    const count = (id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const bank = (id: number) => s.bankObservation?.()?.items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0) ?? NaN;
    const openFresh = async () => {
        if (stopped()) throw Error('wine session stopped');
        const state = () => s.sdk.getState();
        if (state()?.interface?.isOpen || state()?.dialog?.isOpen) {
            await s.direct({ type: 'closeModal', reason: 'wine fresh bank audit' });
            if (!await waitUntil(s, () => !state()?.interface?.isOpen && !state()?.dialog?.isOpen, { timeoutTicks: 8 })) {
                throw Error('wine blocking interface remains');
            }
        }
        const generation = s.bankObservation?.()?.generation ?? -1;
        if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!state()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? -1) > generation, { timeoutTicks: 10 })) {
            throw Error('wine fresh bank unavailable');
        }
    };
    await openFresh();
    for (const input of WINE_UNFERMENTED_RECIPE.inputs) {
        if (bank(input.id) + count(input.id) - maximum * input.units < reserve) throw Error('wine inputs short of order and reserve');
    }
    if (bank(1995) || count(1995) || count(1993) || count(1991)) {
        throw Error('wine order requires no existing raw wine and finished pack wines banked');
    }
    const before = { good: bank(1993), bad: bank(1991) };
    await s.bot.closeBank();
    const productionTicks = cap - (s.tick() - start) - 35;
    if (productionTicks < 1) throw Error('wine budget leaves no production time after fermentation/audit reserve');
    const production = await runner(s, WINE_UNFERMENTED_RECIPE, {
        maximum,
        cap: productionTicks,
        maxAttempts: maximum,
        reserve,
        stop: stopped,
    });
    if (!production.ok) return { ...production, good: 0, bad: 0 };
    const fermentUntil = s.tick() + 22;
    await waitUntil(s, () => stopped() || s.tick() >= fermentUntil, { timeoutTicks: 22 });
    if (stopped() || s.tick() - start >= cap) {
        return { ...production, ok: false, good: 0, bad: 0, failure: 'wine stopped before fermentation audit' };
    }
    await openFresh();
    if (!await waitUntil(s, () => stopped() || bank(1995) === 0, { timeoutTicks: 8 }) || stopped() || s.tick() - start >= cap) {
        throw Error('wine fermentation unfinished');
    }
    const after = { good: bank(1993), bad: bank(1991), raw: bank(1995) };
    const outcome = wineOutcome(before, after, maximum, options.allowAllBad);
    await s.bot.closeBank();
    return { ...production, ...outcome, ticks: s.tick() - start, failure: outcome.ok ? '-' : 'wine output accounting or useful product failed' };
}

// ---- GE Cooking (microbot-ge-cooking.ts) ----

export const NATIVE_GE_FIREMAKING_SITE_FOR_COOKING = { name: 'Native GE / Varrock', bank: { x: 3185, z: 3436 }, rows: [{ z: 3431, sx: 3193, ex: 3167 }, { z: 3456, sx: 3180, ex: 3154 }], localEntry: true };

export type GeCookingOrder = {
    recipe: string;
    target: number;
    batch: number;
    cap: number;
    returnTicks: number;
    members: boolean;
    reserve?: number;
    log: LogKind;
    maximumFires: number;
};

export interface GeCookingDeps {
    light: (s: Session, options: any, stop: () => boolean) => Promise<{ ok: boolean; logsBurnt: number }>;
    cook: (s: Session, job: any, stop: () => boolean) => Promise<{ ok: boolean; completed: number; trips: number; atBank: boolean; failure: string }>;
}

const geBank = { ...NATIVE_GE_FIREMAKING_SITE_FOR_COOKING.bank, level: 0 };
const geFireTiles = new Set(lineTiles(NATIVE_GE_FIREMAKING_SITE_FOR_COOKING.rows).map(({ x, z }) => `${x},${z}`));

function geCookingJob(order: GeCookingOrder) {
    return {
        family: 'cooking' as const,
        heat: 'fire' as const,
        bank: geBank,
        recipe: order.recipe,
        target: order.target,
        batch: order.batch,
        cap: order.cap,
        returnTicks: order.returnTicks,
        members: order.members,
        reserve: order.reserve,
    };
}

export function validateGeCookingOrder(order: GeCookingOrder, validateJob?: (j: any) => void) {
    const job = geCookingJob(order);
    if (validateJob) {
        validateJob(job);
    } else {
        if (!job.recipe || !Number.isSafeInteger(job.target) || job.target < 1 || !Number.isSafeInteger(job.batch) || job.batch < 1 || !Number.isSafeInteger(job.cap) || job.cap < 1 || !Number.isSafeInteger(job.returnTicks) || job.returnTicks < 0) {
            throw Error('invalid GE cooking bank job');
        }
    }
    const recipe = cookingRecipes().recipes.find(r => r.name === order.recipe && r.fire);
    if (
        !Object.hasOwn(LOGS, order.log)
        || !Number.isSafeInteger(order.maximumFires)
        || order.maximumFires < 0
        || order.maximumFires > 1000
        || order.target > 1000
        || order.batch > 28
        || !recipe
    ) {
        throw Error('GE cooking requires a finite Native fire recipe and owned fire budget');
    }
    return recipe;
}

export async function runGeCooking(
    raw: Session,
    order: GeCookingOrder,
    stop: () => boolean = () => false,
    deps?: GeCookingDeps,
) {
    const recipe = validateGeCookingOrder(order);
    const job = geCookingJob(order);
    if (!deps) throw Error('GE cooking requires firemaking/cooking dependencies');
    const owner = actionSessionOwner(raw, stop);
    const start = raw.tick();
    const remaining = () => order.cap - (raw.tick() - start);
    const position = () => raw.sdk.getState()?.player;
    const atBank = () => {
        const p = position();
        return !!p && p.level === 0 && Math.max(Math.abs(p.worldX - geBank.x), Math.abs(p.worldZ - geBank.z)) <= 3;
    };
    const observedFire = () =>
        raw.sdk.getState()?.nearbyLocs
            .filter(locItem => locItem.id === 2732 && locItem.level === 0 && locItem.reachable !== false && geFireTiles.has(`${locItem.x},${locItem.z}`))
            .sort((a, b) => a.distance - b.distance)[0];

    let completed = 0;
    let fires = 0;
    let trips = 0;
    let failure = '';
    try {
        if (!atBank()) throw Error('GE cooking requires the observed Varrock bank at entry');
        if ((raw.sdk.getSkill('Cooking')?.level ?? 0) < recipe.level) throw Error('Cooking level insufficient');
        while (completed < order.target) {
            if (owner.stopped() || remaining() <= order.returnTicks) throw Error('GE cooking stopped or return budget reached');
            let fire = observedFire();
            if (!fire) {
                if (fires >= order.maximumFires || remaining() < order.returnTicks + 120) throw Error('GE cooking fire budget exhausted');
                const options = geFiremakingOptions({ LOG: order.log, MAX_LOGS: '1', CAP: String(Math.min(4000, remaining() - order.returnTicks)) });
                const lit = await deps.light(raw, options, owner.stopped);
                fires += lit.logsBurnt;
                if (!lit.ok || lit.logsBurnt !== 1 || owner.stopped() || !atBank()) throw Error('GE cooking fire creation did not settle at the bank');
                fire = observedFire();
                if (!fire) throw Error('GE cooking Native fire unobserved after lighting');
            }
            if (remaining() <= order.returnTicks) throw Error('GE cooking return budget reached');
            const amount = Math.min(order.batch, order.target - completed);
            const batch = await deps.cook(
                owner.cleanup,
                { ...job, target: amount, batch: amount, cap: remaining(), site: { x: fire.x - 1, z: fire.z, level: 0 } },
                owner.stopped,
            );
            completed += batch.completed;
            trips += batch.trips;
            if (!batch.ok) throw Error(batch.failure);
            if (batch.completed !== amount || !batch.atBank || !atBank()) throw Error('GE cooking batch did not settle at the bank');
        }
    } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
    }
    return {
        ok: !failure && completed === order.target && atBank() && !owner.stopped(),
        completed,
        fires,
        trips,
        ticks: raw.tick() - start,
        failure: failure || '-',
    };
}

export async function runGeCookingCli(
    account: string,
    args: readonly string[],
    deps?: Partial<GeCookingDeps> & { runBankJob?: GeCookingDeps['cook']; validateBankJob?: (j: unknown) => void },
): Promise<number> {
    const [path] = args;
    if (!account || !path || args.length !== 1) throw Error('usage: cooking:ge-cook <account> <order.json>');
    const order = JSON.parse(readFileSync(path, 'utf8')) as GeCookingOrder;
    validateGeCookingOrder(order, deps?.validateBankJob);
    const light = deps?.light ?? runGeFiremaking;
    const cook = deps?.cook ?? deps?.runBankJob;
    if (!cook) throw Error('GE cooking requires bank job runner');
    let stopped = false;
    const session = await openBot(account, { onStop: async () => { stopped = true; } });
    const owner = actionSessionOwner(session);
    let ok = false;
    let detail = '';
    try {
        const result = await runGeCooking(session, order, () => stopped, { light, cook });
        console.log('GE_COOKING_RESULT ' + JSON.stringify(result));
        ok = result.ok;
        detail = JSON.stringify(result);
    } catch (error) {
        detail = String(error);
    }
    await finishActionSession(owner, ok, detail);
    return ok ? 0 : 1;
}

export async function runCookingCli(
    method: string,
    account: string,
    args: readonly string[],
    env: Readonly<Record<string, string | undefined>>,
    deps?: { runBankJob?: GeCookingDeps['cook']; validateBankJob?: (j: unknown) => void },
    stopFlag?: () => boolean,
): Promise<number> {
    if (method === 'wine') {
        const target = Number(args[0] ?? env.TARGET_LEVEL ?? 99);
        const cap = Number(args[1] ?? env.CAP ?? 80);
        const result = await runWineOrder(account, { target, cap });
        console.log('WINE_ORDER_RESULT ' + JSON.stringify(result));
        return result.ok ? 0 : 1;
    }
    if (method === 'ge-cook') {
        return runGeCookingCli(account, args, deps);
    }
    if (method === 'food') {
        const arg0IsCap = args[0] !== undefined && /^\d+$/.test(args[0]);
        const cap = Number(arg0IsCap ? args[0] : env.CAP ?? 15000);
        const foodType = (arg0IsCap ? args[1] : args[0]) ?? env.FOOD_TYPE ?? DEFAULT_FOOD_TYPE;
        const rawMax = env.MAX_MAKE ?? env.TARGET_COUNT ?? env.BATCH_UNITS;
        const maximum = rawMax !== undefined && rawMax !== '' ? Number(rawMax) : Infinity;
        let stopped = false;
        const s = await openBot(account, { onStop: async () => { stopped = true; } }).catch(e => finish([], false, `login: ${String(e)}`));
        try {
            const r = await runCookFood(s, foodType, cap, () => stopped || !!stopFlag?.(), maximum);
            await finish([s], r.ok, r.summary);
            return r.ok ? 0 : 1;
        } catch (e) {
            await finish([s], false, String(e));
            return 1;
        }
    }
    if (method === 'stock') {
        const cap = Number(args[0] ?? env.CAP ?? 3000);
        const reserve = Math.max(50, Number(env.RAW_RESERVE ?? 50));
        const maximum = Number(env.MAX_COOK ?? Number.MAX_SAFE_INTEGER);
        const route = (env.COOK_ROUTE ?? 'near') as 'near' | 'north' | 'far';
        let requestedStop = false;
        const s = await openBot(account, { onStop: async () => { requestedStop = true; } }).catch(e => finish([], false, `login: ${String(e)}`));
        try {
            const r = await runCookStock(s, { cap, reserve, maximum, route, stop: () => requestedStop || !!stopFlag?.() });
            await finish([s], r.ok, r.summary);
            return r.ok ? 0 : 1;
        } catch (e) {
            await finish([s], false, String(e));
            return 1;
        }
    }
    if (method === 'mixed-wine') {
        const maximum = Number(env.MAX_MAKE ?? args[0] ?? 14);
        const cap = Number(env.CAP ?? args[1] ?? 1000);
        const reserve = Number(env.RAW_RESERVE ?? 0);
        if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(cap) || cap < 35) {
            throw Error('wine requires positive count and at least 35 ticks');
        }
        let stopped = false;
        const s = await openBot(account, { onStop: async () => { stopped = true; } });
        try {
            const result = await runMixedWine(s, maximum, cap, () => stopped || !!stopFlag?.(), reserve);
            await finish([s], result.ok, JSON.stringify(result));
            return result.ok ? 0 : 1;
        } catch (e) {
            await finish([s], false, String(e));
            return 1;
        }
    }
    if (method === 'batch') {
        const [recipeName, heatArg, maxArg, capArg] = args;
        const foodType = env.FOOD_TYPE?.trim().toLowerCase();
        if (!recipeName && !env.RECIPE && foodType && env.BANKED !== '0') {
            const cap = Number(capArg ?? env.CAP ?? 3000);
            const rawMax = maxArg ?? env.MAX_MAKE ?? env.TARGET_COUNT ?? env.BATCH_UNITS;
            const maximum = rawMax !== undefined && rawMax !== '' ? Number(rawMax) : Infinity;
            let stopped = false;
            const s = await openBot(account, { onStop: async () => { stopped = true; } }).catch(e => finish([], false, `login: ${String(e)}`));
            try {
                const r = await runCookFood(s, foodType, cap, () => stopped || !!stopFlag?.(), maximum);
                await finish([s], r.ok, r.summary);
                return r.ok ? 0 : 1;
            } catch (e) {
                await finish([s], false, String(e));
                return 1;
            }
        }
        const heat = (heatArg ?? env.HEAT ?? 'range') as Heat;
        const maximum = Number(maxArg ?? env.MAX_MAKE ?? env.TARGET_COUNT ?? env.BATCH_UNITS ?? 1);
        const cap = Number(capArg ?? env.CAP ?? 200);
        const resolvedName = recipeName ?? env.RECIPE;
        const recipe = resolvedName
            ? cookingRecipes().recipes.find(r => r.name === resolvedName)
            : foodType
              ? foodRecipe(foodType)
              : undefined;
        if (!recipe) throw Error('account and native cooking table recipe name required');
        let ended = false;
        const s = await openBot(account).catch(e => finish([], false, `login: ${String(e)}`));
        void s.ended?.then(() => { ended = true; });
        try {
            const result = await runSessionCookingBatch(
                s,
                recipe,
                heat,
                maximum,
                cap,
                () => ended || !!stopFlag?.() || existsSync(join('.practice', `stop-${account}`)) || existsSync('.practice/stop-all'),
                env.EXPECTED_PRODUCT ? Number(env.EXPECTED_PRODUCT) : undefined,
            );
            await finish([s], true, JSON.stringify(result));
            return 0;
        } catch (e) {
            await finish([s], false, String(e));
            return 1;
        }
    }
    throw Error(`unknown cooking method: ${method}`);
}
