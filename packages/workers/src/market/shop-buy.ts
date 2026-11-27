import { existsSync } from 'node:fs';
import { accountOf, countItems, getWorld, sessionDied } from '../../../core/src/bot';
import { pickDisembarkPlank, type BoatSession } from '../../../core/src/boat';
import { bankCargo, courierWaiting, exactItem } from '../../../core/src/cargo';
import { depositObserved, depositPack } from '../../../core/src/deposit';
import type { Session } from '../../../core/src/inprocess';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { knownBanks } from '../../../core/src/trip';
import { expandPath, goTo, leaveDeck, sessionWalker, walkPath, type Walker } from '../../../core/src/walk';
import type { ShopConfig, ShopItem as SdkShopItem } from '../../../../vendor/rs-sdk/sdk/types';
import { contentUnitBound, shopRules } from './shop-price';
import {
    inZanarisRealm,
    PROFILES,
    profileRefusal,
    resolveShopProfile,
    selectItems,
    SWORD,
    SWORD_PROFILES,
} from './preflight';
import type { BuySwordConfig, EarthShopConfig, ShopBuyConfig, ShopProfile, ShopPurchaseTarget, ShopRule, ShopStock } from './types';
import { walkTargetPersist } from './walk';

export {
    inZanarisRealm,
    PROFILES,
    profileRefusal,
    resolveShopProfile,
    selectItems,
    SWORD,
    SWORD_PROFILES,
};

const SHOP_TOOL_LIMIT_RE = /axe|pickaxe|tinderbox|hammer|chisel|mould|knife|pestle|harpoon|lobster pot/i;
const SHOP_STACKABLE_RE = /arrow|rune|feather|thread|fishing bait/i;

export function planShopPurchases(
    targets: ShopPurchaseTarget[],
    shop: ShopStock[],
    inventory: { name: string; count: number }[],
    bank: ReadonlyMap<string, number>,
    budget: number,
    stockTarget = 500,
    maxItems = Infinity,
): { name: string; amount: number }[] {
    let slots = Math.max(0, 28 - inventory.length);
    let units = Math.max(0, maxItems);
    const choices: { name: string; buyPrice: number; desired: number; amount: number; stackable: boolean; held: number }[] = [];
    for (let ti = 0; ti < targets.length; ti++) {
        const target = targets[ti]!;
        let item: ShopStock | undefined;
        for (let si = 0; si < shop.length; si++) {
            const candidate = shop[si]!;
            if (target.re.test(candidate.name)) {
                item = candidate;
                break;
            }
        }
        if (!item || item.count <= 0 || !Number.isFinite(item.buyPrice) || item.buyPrice < 0) continue;
        let held = 0;
        for (let ii = 0; ii < inventory.length; ii++) {
            const invItem = inventory[ii]!;
            if (target.re.test(invItem.name)) held += invItem.count;
        }
        const limit = SHOP_TOOL_LIMIT_RE.test(item.name) ? Math.min(2, stockTarget) : stockTarget;
        const desired = Math.max(0, Math.min(item.count, target.buyPerTick, limit - held - (bank.get(item.name.toLowerCase()) ?? 0)));
        if (desired > 0) {
            choices.push({
                name: item.name,
                buyPrice: item.buyPrice,
                desired,
                amount: 0,
                stackable: SHOP_STACKABLE_RE.test(item.name),
                held,
            });
        }
    }
    let progress = true;
    while (progress) {
        progress = false;
        for (let ci = 0; ci < choices.length; ci++) {
            const c = choices[ci]!;
            const slotCost = c.stackable && (c.held > 0 || c.amount > 0) ? 0 : 1;
            if (units <= 0 || c.amount >= c.desired || slots < slotCost || budget < c.buyPrice) continue;
            c.amount++;
            units--;
            budget -= c.buyPrice;
            slots -= slotCost;
            progress = true;
        }
    }
    const out: { name: string; amount: number }[] = [];
    for (let ci = 0; ci < choices.length; ci++) {
        const c = choices[ci]!;
        if (c.amount > 0) out.push({ name: c.name, amount: c.amount });
    }
    return out;
}

export function shopTargetsMet(
    targets: ShopPurchaseTarget[],
    inventory: { name: string; count: number }[],
    bank: ReadonlyMap<string, number>,
    stockTarget: number,
): boolean {
    if (targets.length === 0) return false;
    for (let ti = 0; ti < targets.length; ti++) {
        const t = targets[ti]!;
        let firstName = '';
        let total = 0;
        for (const [name, count] of bank) {
            if (t.re.test(name)) {
                if (!firstName) firstName = name;
                total += count;
            }
        }
        for (let ii = 0; ii < inventory.length; ii++) {
            const item = inventory[ii]!;
            if (t.re.test(item.name)) {
                if (!firstName) firstName = item.name;
                total += item.count;
            }
        }
        if (!firstName) return false;
        const goal = SHOP_TOOL_LIMIT_RE.test(firstName) ? Math.min(2, stockTarget) : stockTarget;
        if (total < goal) return false;
    }
    return true;
}

export function stockWaitStatus(now: number, since: number | undefined, limit: number, poll = 15) {
    const started = since ?? now;
    const remaining = limit > 0 ? Math.max(0, limit - (now - started)) : Infinity;
    return { since: started, done: remaining === 0, waitTicks: Math.min(Math.max(1, poll), remaining) };
}

export const BLIND_SETTLE_TICKS = 2;

export function blindBuyNow(o: {
    unit: number;
    wallet: number;
    reserve: number;
    remainingSpend: number;
    remainingItems: number;
    wanted: number;
    freeSlots: number;
    pending: number;
}): boolean {
    if (!Number.isSafeInteger(o.unit) || o.unit <= 0) return false;
    const room = Math.min(Math.floor(Math.min(o.wallet - o.reserve, o.remainingSpend) / o.unit), o.remainingItems, o.wanted, o.freeSlots);
    return room - o.pending >= 1;
}

export function blindBuyObserved(
    base: { coins: number; held: number; unit: number },
    now: { coins: number; held: number },
    reserve: number,
    remainingSpend: number,
): { bought: number; spent: number } {
    const bought = now.held - base.held;
    const spent = base.coins - now.coins;
    if (bought <= 0 || spent <= 0) return { bought: 0, spent: 0 };
    if (spent > bought * base.unit || now.coins < reserve || spent > remainingSpend) {
        throw new Error(`shop budget violated: blind buy took ${spent} coins for ${bought} units, bound ${base.unit} each`);
    }
    return { bought, spent };
}

// orderUnits marks a planned order: it passes only with all units bought or the stock target met,
// so a chain does not start its consumer without the inputs.
export function shopFinishOk(bought: number, targetMet: boolean, stop: string, orderUnits?: number): boolean {
    if (orderUnits !== undefined) return targetMet || bought >= orderUnits;
    return bought > 0 || targetMet || stop === 'stock-wait';
}

// The failure text of a short planned order, in the phrases the brain outcome classifier reads:
// "out of stock" is a market cooldown on the shop, "insufficient coins" a coin shortfall, and
// "missing supply" with itemId and need a supply shortfall that the planner replans without a
// penalty. Only an empty shelf is a venue fault: a tick cap or a full pack says nothing of the shop.
export function shopOrderShortText(bought: number, orderUnits: number, stop: string, itemId?: number): string {
    const units = Number.isFinite(orderUnits) ? String(orderUnits) : 'target';
    if (stop === 'coin-reserve' || stop === 'spend-cap' || stop === 'bounded-purchase-unaffordable') {
        return `order short bought=${bought}/${units}: insufficient coins`;
    }
    if (stop === 'stock-wait') return `order short bought=${bought}/${units}: shop out of stock`;
    const need = Number.isFinite(orderUnits) ? ` need=${Math.max(1, orderUnits - bought)}` : '';
    return `order short${itemId !== undefined ? ` itemId=${itemId}` : ''}${need} bought=${bought}/${units}: missing supply after stop=${stop || 'none'}`;
}

// The walker's route search found no route from where the account stands. Every retry searches the same route
// table and fails the same way, so the run ends now and names the start and target in the words the brain reads
// (no-route.ts parseNoRoute "position=" and "no route to"): the outcome classifier records a no-route fact, and the
// planner sends no more jobs from this tile to that place. Null for any other walk failure.
export function shopNoRouteError(
    r: { reason?: string; detail?: string },
    p: { worldX: number; worldZ: number; level: number } | null | undefined,
): Error | null {
    if (r.reason !== 'precondition' || !/^no route to -?\d+,-?\d+,\d+\b/.test(r.detail ?? '')) return null;
    return Error(`shop travel failed: position=${p ? `${p.worldX},${p.worldZ},${p.level}` : 'unknown'}; ${r.detail}`);
}

export function maximumUnitCost(
    item: { baseCost: number },
    config: { sellMultiplier: number; haggle?: number } | undefined,
    shelf?: number,
): number {
    if (!Number.isSafeInteger(item.baseCost) || item.baseCost <= 0 || !config || !Number.isSafeInteger(config.sellMultiplier) || config.sellMultiplier < 0) {
        throw new Error('shop budget: missing validated baseCost or shop sellMultiplier');
    }
    const haggle = config.haggle;
    const adjustment = shelf !== undefined && Number.isSafeInteger(shelf) && shelf >= 1 && haggle !== undefined && Number.isSafeInteger(haggle) && haggle >= 0
        ? Math.min(5000, (shelf - 1) * haggle)
        : 5000;
    return Math.min(2_000_000_000, Math.max(1, Math.ceil(item.baseCost * (config.sellMultiplier + adjustment) / 1000)));
}

export function unitBound(
    item: { name: string; baseCost: number },
    config: { sellMultiplier: number; haggle?: number } | undefined,
    shelf: number | undefined,
    rules: readonly ShopRule[] | null | undefined,
): number {
    return (rules?.length ? contentUnitBound(rules, item.name) : null) ?? maximumUnitCost(item, config, shelf);
}

export function dialogClick(dialog: { isOpen: boolean; isWaiting: boolean; options: { index: number; text: string }[] } | null, say: RegExp): number | null {
    if (!dialog?.isOpen || dialog.isWaiting) return null;
    return dialog.options.find(o => say.test(o.text))?.index ?? 0;
}

// Why a static walk plan cannot reach its goal, or undefined: its last corner (the start for an empty plan) lies over
// `tol` tiles from the goal.
export function planShortOf(from: { x: number; z: number }, goal: { x: number; z: number }, corners: readonly { x: number; z: number }[], tol: number): string | undefined {
    const end = corners.at(-1) ?? from;
    const gap = Math.max(Math.abs(end.x - goal.x), Math.abs(end.z - goal.z));
    return gap > tol ? `plan ends short: ${end.x},${end.z} is ${gap} tiles from ${goal.x},${goal.z}` : undefined;
}

export function approachLegs(via: { x: number; z: number }[] | undefined, from: { x: number; z: number }, to: { x: number; z: number }, far = 60) {
    const d = (a: { x: number; z: number }) => Math.max(Math.abs(a.x - to.x), Math.abs(a.z - to.z));
    let left = d(from);
    if (left <= far) return [];
    return (via ?? []).filter(w => d(w) < left && ((left = d(w)), true));
}

export async function approachShop(
    conf: Pick<ShopProfile, 'npcSpot' | 'realm'>,
    from: { worldX: number; worldZ: number } | null | undefined,
    walk: (x: number, z: number, tol: number, level: number) => Promise<boolean>,
    payToll: () => Promise<boolean>,
    stopped: () => boolean = () => false,
): Promise<boolean> {
    if (stopped()) return false;
    if (conf.realm && from && conf.realm.inside(from) && from.worldX < conf.realm.toll.x && !await payToll()) {
        throw new Error('realm toll: crossing unobserved');
    }
    if (stopped()) return false;
    return walk(conf.npcSpot.x, conf.npcSpot.z, 2, conf.npcSpot.level ?? 0);
}

export async function buyWithBudget(
    bot: { buyFromShop(item: RegExp, amount: number): Promise<unknown> },
    sdk: { getInventory(): { name: string; count: number }[]; getState(): { shop?: { shopItems: { name: string; count: number; baseCost: number }[]; shopConfig?: { sellMultiplier: number; haggle?: number } } } | null },
    name: string,
    requested: number,
    reserve: number,
    remainingSpend: number,
    shelf?: number,
    rules?: readonly ShopRule[] | null,
): Promise<{ bought: number; spent: number }> {
    const count = (re: RegExp) => sdk.getInventory().filter(i => re.test(i.name)).reduce((n, i) => n + i.count, 0);
    const wallet = count(/^coins$/i);
    const before = count(exactItem(name));
    const shop = sdk.getState()?.shop;
    const item = shop?.shopItems.find(i => i.name.toLowerCase() === name.toLowerCase());
    if (!item || item.count <= 0) return { bought: 0, spent: 0 };
    const unit = unitBound(item, shop?.shopConfig, shelf, rules);
    const amount = Math.max(0, Math.min(requested, item.count, Math.floor(Math.min(wallet - reserve, remainingSpend) / unit)));
    if (amount === 0) return { bought: 0, spent: 0 };
    const re = exactItem(name);
    await bot.buyFromShop(re, amount);
    const spent = Math.max(0, wallet - count(/^coins$/i));
    if (count(/^coins$/i) < reserve || spent > remainingSpend) throw new Error('shop budget violated: observed server cost exceeded reserved maximum');
    return { bought: Math.max(0, count(re) - before), spent };
}

export async function handleDialogShopOpen(
    sdk: {
        getState(): { shop?: { isOpen: boolean }; dialog?: { isOpen: boolean; isWaiting: boolean; options: { index: number; text: string }[] } | null } | null;
        getDialog(): { isOpen: boolean; isWaiting: boolean; options: { index: number; text: string }[] } | null;
        sendClickDialog(index: number): Promise<unknown>;
    },
    choiceRe: RegExp,
    wait: () => Promise<unknown>,
    maxSteps = 12,
): Promise<boolean> {
    for (let i = 0; i < maxSteps; i++) {
        if (sdk.getState()?.shop?.isOpen) return true;
        const d = sdk.getDialog();
        if (!d?.isOpen) return !!sdk.getState()?.shop?.isOpen;
        if (!d.isWaiting) {
            const click = dialogClick(d, choiceRe);
            if (click !== null) await sdk.sendClickDialog(click);
        }
        await wait();
    }
    return !!sdk.getState()?.shop?.isOpen;
}

export async function runDialogBuyStep(
    sdk: {
        getInventory(): { name: string; count: number }[];
        getDialog(): { isOpen: boolean; isWaiting: boolean; options: { index: number; text: string }[] } | null;
        sendClickDialog(index: number): Promise<unknown>;
        sendCloseModal?(): Promise<unknown>;
    },
    bot: { talkTo(npc: RegExp): Promise<{ success: boolean }> },
    npc: RegExp,
    spec: { choices: readonly RegExp[]; cost: number; item: RegExp },
    reserve: number,
    remainingSpend: number,
    remainingItems: number,
    wait: () => Promise<unknown>,
    maxSteps = 20,
): Promise<{ bought: number; spent: number }> {
    const count = (re: RegExp) => sdk.getInventory().filter(i => re.test(i.name)).reduce((n, i) => n + i.count, 0);
    const coinsBefore = count(/^coins$/i);
    const heldBefore = count(spec.item);
    if (remainingItems < 1 || 28 - sdk.getInventory().length < 1 || coinsBefore - reserve < spec.cost || remainingSpend < spec.cost) {
        return { bought: 0, spent: 0 };
    }
    if (!sdk.getDialog()?.isOpen) {
        const talk = await bot.talkTo(npc);
        if (!talk.success) return { bought: 0, spent: 0 };
        await wait();
    }
    const choiceRe = new RegExp(spec.choices.map(r => r.source).join('|'), 'i');
    for (let step = 0; step < maxSteps; step++) {
        if (count(spec.item) > heldBefore) break;
        const d = sdk.getDialog();
        if (!d?.isOpen) break;
        if (!d.isWaiting) {
            const matched = d.options.find(o => choiceRe.test(o.text));
            const click = matched ? matched.index : d.options.length === 1 ? 0 : null;
            if (click === null) break;
            await sdk.sendClickDialog(click);
        }
        await wait();
    }
    const coinsNow = count(/^coins$/i);
    const spent = Math.max(0, coinsBefore - coinsNow);
    const bought = Math.max(0, count(spec.item) - heldBefore);
    if (coinsNow < reserve || spent > remainingSpend) throw new Error('shop budget violated: dialogue buy exceeded reserved maximum');
    return { bought, spent };
}

export type ShopBuyRunResult = {
    ok: boolean;
    refused?: string;
    strandedOnDeck: boolean;
    ticks: number;
    boughtTotal: number;
    bankedTotal: number;
    bankTrips: number;
    shopTrips: number;
    coinsLeft: number;
    spentTotal: number;
    coinReserve: number;
    maxSpend: number;
    maxItems: number;
    stop: string;
    targetMet: boolean;
    noBuyTicks: number;
    noBuyLimit: number;
    fareTotal: number;
    blindRequests: number;
    blindBuy: boolean;
    summary: string;
};

export async function runShopBuy(s: Session, cfg: ShopBuyConfig, stop: () => boolean = () => false): Promise<ShopBuyRunResult> {
    const profileKey = cfg.profile.toLowerCase();
    const CAP = cfg.cap ?? 15000;
    const BANK_AT = cfg.bankAt ?? 100;
    const COIN_RESERVE = cfg.coinReserve ?? 0;
    const MAX_SPEND = cfg.maxSpend ?? Infinity;
    const MAX_ITEMS = cfg.maxItems ?? Infinity;
    const FLOAT = cfg.float ?? 20000;
    const NO_BUY_TICKS = cfg.noBuyTicks ?? 0;
    const BLIND_BUY = cfg.blindBuy === true;
    const STOP_AT_TARGET = cfg.stopAtTarget === true;
    const FILL_ORDER = cfg.fillOrder === true;
    const BANK_PACK = cfg.bankPack === true;
    const STOCK_POLL_TICKS = cfg.stockPollTicks ?? 15;
    const stockTarget = cfg.stockTarget ?? 500;
    const guarded = COIN_RESERVE > 0 || Number.isFinite(MAX_SPEND);

    for (const [key, value] of Object.entries({ COIN_RESERVE, MAX_SPEND, MAX_ITEMS, FLOAT, NO_BUY_TICKS })) {
        if ((!Number.isSafeInteger(value) && !(value === Infinity && ['MAX_SPEND', 'MAX_ITEMS'].includes(key))) || value < 0) {
            throw new Error(`invalid shop budget ${key}`);
        }
    }
    if (FLOAT <= COIN_RESERVE || MAX_SPEND === 0 || MAX_ITEMS === 0) {
        throw new Error('shop budget needs FLOAT>COIN_RESERVE and positive MAX_SPEND/MAX_ITEMS');
    }

    const PROFILE = resolveShopProfile(profileKey);
    if (!PROFILE) throw new Error(`unknown shop profile: ${profileKey}`);
    const conf = { ...PROFILE, items: selectItems(PROFILE.items, cfg.items) };
    const priceRules = shopRules(conf.npc, conf.npcSpot);
    if (!conf.items.length) throw new Error(`ITEMS=${cfg.items} matches no ${profileKey} item`);

    await waitUntil(s, st => (st?.inventory?.length ?? 0) > 0, { timeoutTicks: 10 });
    const pos = () => s.sdk.getState()?.player;
    const coins = () => countItems(s, /^coins$/i);
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    let closing = false;
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const over = () => !closing && (used() >= CAP || stop());

    if (conf.need) {
        const skill = conf.need.skill;
        await waitUntil(s, () => s.sdk.getSkill(skill) != null, { timeoutTicks: 10 });
        const level = s.sdk.getSkill(skill)?.level;
        const refused = profileRefusal(profileKey, conf, level);
        if (refused) {
            const summary = `${refused} (${skill} ${level ?? 'unobserved'}) boughtTotal=0 spentTotal=0 fareTotal=0 stop=refused`;
            return {
                ok: false,
                refused,
                strandedOnDeck: false,
                ticks: used(),
                boughtTotal: 0,
                bankedTotal: 0,
                bankTrips: 0,
                shopTrips: 0,
                coinsLeft: coins(),
                spentTotal: 0,
                coinReserve: COIN_RESERVE,
                maxSpend: MAX_SPEND,
                maxItems: MAX_ITEMS,
                stop: 'refused',
                targetMet: false,
                noBuyTicks: 0,
                noBuyLimit: NO_BUY_TICKS,
                fareTotal: 0,
                blindRequests: 0,
                blindBuy: BLIND_BUY,
                summary,
            };
        }
    }

    let boughtTotal = 0;
    let bankedTotal = 0;
    let spentTotal = 0;
    let fareTotal = 0;
    let stopReason = 'cap';
    let noBuySince: number | undefined;
    let noBuyTicks = 0;
    let bankTrips = 0;
    let shopTrips = 0;
    const stock = new Map<string, number>();

    const blindTargets = BLIND_BUY ? conf.items.filter(t => t.shelf !== undefined) : [];
    const planTargets = conf.items.filter(t => !blindTargets.includes(t));
    let blindRequests = 0;
    let blindSent: number[] = [];
    let blindBase: { coins: number; held: number; unit: number } | null = null;
    const blindHeld = () => s.sdk.getInventory().filter(i => blindTargets.some(t => t.re.test(i.name))).reduce((n, i) => n + i.count, 0);
    const blindPending = () => (blindSent = blindSent.filter(t => s.tick() - t < BLIND_SETTLE_TICKS)).length;
    const blindLook = (): number => {
        if (!blindBase) return 0;
        const now = { coins: coins(), held: blindHeld() };
        const seen = blindBuyObserved(blindBase, now, COIN_RESERVE, MAX_SPEND - spentTotal);
        if (seen.bought > 0) blindBase = { ...blindBase, ...now };
        boughtTotal += seen.bought;
        spentTotal += seen.spent;
        if (seen.bought > 0) {
            console.log(`BOUGHT ${seen.bought}x ${s.sdk.getInventory().find(i => blindTargets.some(t => t.re.test(i.name)))?.name} blind t=${used()} paid=${seen.spent} requests=${blindRequests}`);
        }
        return seen.bought;
    };
    const blindSettle = async () => {
        if (!blindBase) return;
        while (blindPending() > 0 && !ended) await waitTicks(s, 1);
        blindLook();
        blindBase = null;
    };

    // A static plan that stops short of the goal (a guild door the map keeps shut) ends in rejected clicks at a wall;
    // goTo routes through the door instead, so such a walk goes to it at once.
    const walkPlanned = async (x: number, z: number, tol: number) => {
        const deps = await sessionWalker(s);
        const plan = deps.plan;
        let short: string | undefined;
        deps.plan = (lv, from, goal, avoid) => {
            const corners = avoid ? plan(lv, from, goal, avoid) : plan(lv, from, goal);
            short = planShortOf(from, goal, corners, tol);
            if (short) throw Error(short);
            return corners;
        };
        try {
            return await walkPath(deps, [{ x, z, tol }], { stop: over });
        } catch (error) {
            if (!short) throw error;
            return { ok: false, detail: short, ticks: 0 };
        } finally {
            deps.plan = plan;
        }
    };
    const walk = async (x: number, z: number, tol = 2, level = 0): Promise<boolean> => {
        const c0 = coins();
        const off = (p: ReturnType<typeof pos>) => (!p ? Infinity : p.level !== level ? Infinity : Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)));
        const p0 = pos();
        for (const w of p0 && !over() ? approachLegs(conf.via, { x: p0.worldX, z: p0.worldZ }, { x, z }) : []) {
            const r = await goTo(s, await getWorld(), { ...w, level: 0 }, accountOf(s), { legTimeoutTicks: 100 });
            if (!r.ok) console.log(`WALK via ${w.x},${w.z} fail ${r.reason} ${r.detail}`);
        }
        if (p0 && off(pos()) > 60) {
            const r = await walkTargetPersist(s, { x, z, level });
            if (!r.ok) {
                console.log(`WALK route fail ${r.reason} ${r.detail}`);
                const noRoute = shopNoRouteError(r, pos());
                if (noRoute) throw noRoute;
            }
        }
        for (let i = 0; i < 3 && !over(); i++) {
            const p = pos();
            if (off(p) <= tol) break;
            if (p?.level === 1 && pickDisembarkPlank(s as unknown as BoatSession)) {
                await leaveDeck(s as unknown as Walker, over);
            }
            const cur = pos();
            if (off(cur) <= tol) break;
            const r = cur?.level === level ? await walkPlanned(x, z, tol) : { ok: false, detail: `on level ${cur?.level}`, ticks: 0 };
            if (!r.ok) {
                console.log(`WALK fail ${r.detail} ticks=${r.ticks}`);
                const g = await goTo(s, await getWorld(), { x, z, level }, accountOf(s), { legTimeoutTicks: 100 });
                if (!g.ok) {
                    console.log(`WALK route fail ${g.reason} ${g.detail}`);
                    const noRoute = shopNoRouteError(g, pos());
                    if (noRoute) throw noRoute;
                    await waitTicks(s, 1);
                }
            }
        }
        fareTotal += Math.max(0, c0 - coins());
        return off(pos()) <= tol;
    };

    const passDoor = async (enter: boolean) => {
        const door = conf.door;
        if (!door) return;
        const p = pos();
        if (!p || enter === door.inside(p)) return;
        const stand = enter ? door.outside : (door.insideStand ?? { x: door.x, z: door.z });
        await walk(stand.x, stand.z, 0);
        for (let i = 0; i < 4 && !over(); i++) {
            const cur = pos();
            if (cur && enter === door.inside(cur)) break;
            await s.direct({ type: 'interactLoc', x: door.x, z: door.z, locId: door.id, optionIndex: 1, reason: 'SDK' });
            await waitUntil(s, () => {
                const now = pos();
                return over() || (!!now && enter === door.inside(now));
            }, { timeoutTicks: 10 });
        }
    };

    const bank = async (loadFloat = true) => {
        await blindSettle();
        if (s.sdk.getState()?.shop?.isOpen) await s.bot.closeInterface();
        await passDoor(false);
        const spot = conf.realm && !conf.realm.inside(pos() ?? { worldX: 0, worldZ: 0 }) ? conf.realm.outBank : conf.bankSpot;
        await walk(spot.x, spot.z, 2);
        const b = await s.bot.openBank();
        if (!b.success) {
            console.log(`WARN openBank: ${b.message}`);
            await waitTicks(s, 2);
            return;
        }
        const desiredFloat = Math.min(FLOAT, COIN_RESERVE + MAX_SPEND - spentTotal);
        if (loadFloat && (guarded ? coins() < desiredFloat : coins() < 1000) && desiredFloat > coins()) {
            await s.bot.withdrawItem(/^coins$/i, desiredFloat - coins());
        }
        for (const id of new Set(s.sdk.getInventory().filter(i => conf.items.some(t => t.re.test(i.name))).map(i => i.id))) {
            const item = s.sdk.getInventory().find(i => i.id === id);
            if (item) {
                const quantity = () => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
                const before = quantity();
                await s.bot.depositItem(item, -1);
                bankedTotal += Math.max(0, before - quantity());
                if (quantity() > 0) throw new Error(`shop deposit incomplete: ${item.name}`);
            }
        }
        await waitTicks(s, 1);
        await bankCargo(s, conf.items.map(i => i.re));
        stock.clear();
        for (const item of s.sdk.getState()?.bank?.items ?? []) stock.set(item.name.toLowerCase(), item.count);
        await s.bot.closeInterface();
        bankTrips++;
        console.log(`MILESTONE bank t=${used()} boughtTotal=${boughtTotal} bankTrips=${bankTrips}`);
    };

    const realm = conf.realm;
    const inRealm = () => {
        const p = pos();
        return !!p && !!realm && realm.inside(p);
    };
    let ownWeapon = 0;
    const weapon = () => s.sdk.getEquipment().find(i => i.slot === 3)?.id ?? 0;
    const enterRealm = async () => {
        if (!realm || inRealm()) return;
        const worn = () => (s.sdk.getState()?.equipment ?? []).some(e => realm.wear.test(e.name));
        const held = () => s.sdk.getInventory().find(i => realm.wear.test(i.name));
        if (!worn() && !held()) {
            const p = pos()!;
            const far = (t: { x: number; z: number }) => Math.max(Math.abs(t.x - p.worldX), Math.abs(t.z - p.worldZ));
            const b = knownBanks().filter(t => t.level === 0).sort((m, n) => far(m) - far(n))[0];
            if (b) await walk(b.x, b.z, 2);
            if ((await s.bot.openBank()).success) {
                await s.bot.withdrawItem(realm.wear, 1);
                await s.bot.closeInterface();
            }
        }
        const item = held();
        if (!worn() && item) {
            ownWeapon = weapon();
            await s.bot.equipItem(item);
            await waitUntil(s, worn, { timeoutTicks: 5 });
        }
        if (!worn()) throw new Error(`realm entry: no ${realm.wear.source} worn, in the pack or in the bank`);
        await walk(realm.stand.x, realm.stand.z, 0);
        for (let i = 0; i < 4 && !inRealm() && !over(); i++) {
            await s.direct({ type: 'interactLoc', x: realm.door.x, z: realm.door.z, locId: realm.door.id, optionIndex: 1, reason: 'SDK' });
            await waitUntil(s, inRealm, { timeoutTicks: 10 });
        }
        if (!inRealm()) throw new Error(`realm entry: the door at ${realm.door.x},${realm.door.z} did not take the player in`);
        console.log(`MILESTONE realm-enter t=${used()}`);
    };
    const talkThrough = async (loc: { id: number; x: number; z: number }, say: RegExp, done: () => boolean, limit: number) => {
        const t = s.tick();
        for (let sent = -10; !done() && s.tick() - t < limit;) {
            const click = dialogClick(s.sdk.getDialog(), say);
            if (click !== null) await s.sdk.sendClickDialog(click);
            else if (s.tick() - sent >= 10) {
                sent = s.tick();
                await s.direct({ type: 'interactLoc', x: loc.x, z: loc.z, locId: loc.id, optionIndex: 1, reason: 'SDK' });
            }
            await waitTicks(s, 1);
        }
        return done();
    };
    const payToll = async (): Promise<boolean> => {
        if (!realm || !inRealm()) return false;
        const toll = realm.toll;
        const has = () => s.sdk.getInventory().some(i => toll.item.test(i.name));
        if (!has()) {
            await walk(conf.bankSpot.x, conf.bankSpot.z, 2);
            if ((await s.bot.openBank()).success) {
                await s.bot.withdrawItem(toll.item, 1);
                await s.bot.closeInterface();
            }
        }
        if (!has()) throw new Error(`realm toll: no ${toll.item.source} in the pack or in the bank`);
        if (!await walk(toll.stand.x, toll.stand.z, 0)) return false;
        const passed = await talkThrough(toll, toll.say, () => pos()?.worldX === toll.x && pos()?.worldZ === toll.z, 60);
        console.log(`MILESTONE realm-toll t=${used()} passed=${passed ? 1 : 0}`);
        return passed;
    };
    const leaveRealm = async () => {
        if (!realm || !inRealm()) return;
        if (await walk(realm.ladder.x, realm.ladder.z - 2, 2)) await talkThrough(realm.ladder, realm.ladder.say, () => !inRealm(), 100);
        const own = !inRealm() && ownWeapon ? s.sdk.getInventory().find(i => i.id === ownWeapon) : undefined;
        if (own && (await s.bot.equipItem(own)).success) await waitUntil(s, () => weapon() === ownWeapon, { timeoutTicks: 8 });
        console.log(`MILESTONE realm-leave t=${used()} out=${inRealm() ? 0 : 1} weapon=${weapon()}`);
    };
    const shelfOf = (name: string) => conf.items.find(t => t.re.test(name))?.shelf;
    let shelfSent = '';
    const reportShelf = (items: readonly { id: number; name: string; count: number }[]) => {
        if (!cfg.onShelf) return;
        const rows = items.filter(i => conf.items.some(t => t.re.test(i.name))).map(i => ({ id: i.id, count: i.count }));
        const sig = JSON.stringify(rows);
        if (!rows.length || sig === shelfSent) return;
        shelfSent = sig;
        try { cfg.onShelf(profileKey, rows); } catch (e) { console.log(`WARN shelf record failed: ${String(e)}`); }
    };

    console.log(`START shop-buyer ${s.name} profile=${profileKey} coins=${coins()}`);
    let loggedEmpty = false;
    const start = pos();
    if (conf.fare && coins() < conf.fare && start && approachLegs(conf.via, { x: start.worldX, z: start.worldZ }, conf.bankSpot).length) {
        const b = await s.bot.openBank();
        if (b.success) {
            const float = Math.min(FLOAT, COIN_RESERVE + MAX_SPEND);
            if (float > coins()) await s.bot.withdrawItem(/^coins$/i, float - coins());
            await s.bot.closeInterface();
        }
        if (coins() < conf.fare) console.log(`WARN far trip fares: ${conf.fare} coins needed, ${coins()} in pack${b.success ? '' : `; openBank: ${b.message}`}`);
    }
    await enterRealm();
    if (BANK_PACK) {
        await walk(conf.bankSpot.x, conf.bankSpot.z, 2);
        if ((await s.bot.openBank()).success) {
            await waitTicks(s, 1);
            await depositPack(s, i => /^coins$/i.test(i.name));
            await s.bot.closeInterface();
        }
    }
    await bank();

    while (!over() && !ended) {
        if (STOP_AT_TARGET && shopTargetsMet(conf.items, s.sdk.getInventory(), stock, stockTarget)) {
            stopReason = 'stock-target';
            break;
        }
        if (NO_BUY_TICKS > 0 && noBuySince !== undefined && stockWaitStatus(s.tick(), noBuySince, NO_BUY_TICKS).done) {
            noBuyTicks = s.tick() - noBuySince;
            stopReason = 'stock-wait';
            break;
        }
        if (boughtTotal >= MAX_ITEMS || spentTotal >= MAX_SPEND) {
            stopReason = boughtTotal >= MAX_ITEMS ? 'item-cap' : 'spend-cap';
            break;
        }
        if (courierWaiting(s.name)) {
            await bank();
            continue;
        }
        if (coins() <= COIN_RESERVE || (!guarded && coins() < 50)) {
            await bank();
            if (coins() <= COIN_RESERVE || (!guarded && coins() < 50)) {
                if (NO_BUY_TICKS > 0) {
                    const since = s.tick();
                    await waitTicks(s, NO_BUY_TICKS);
                    noBuyTicks = s.tick() - since;
                    // This wait is for coins, not shelf stock: a planned order names the coin shortfall.
                    stopReason = FILL_ORDER ? 'coin-reserve' : 'stock-wait';
                } else {
                    stopReason = 'coin-reserve';
                }
                break;
            }
        }

        const inv = s.sdk.getInventory();
        const nonCoinCount = inv.filter(i => !/^coins$/i.test(i.name)).reduce((sum, i) => sum + i.count, 0);
        if (inv.length >= 27 || (BANK_AT > 0 && nonCoinCount >= BANK_AT)) {
            await bank();
            if (s.sdk.getInventory().length >= 27) {
                console.log('WARN pack full of items this profile does not bank; set BANK_PACK=1');
                stopReason = 'pack-full';
                break;
            }
            continue;
        }

        const p = pos();
        if (!p || p.level !== (conf.npcSpot.level ?? 0) || Math.max(Math.abs(p.worldX - conf.npcSpot.x), Math.abs(p.worldZ - conf.npcSpot.z)) > 3) {
            await passDoor(true);
            await approachShop(conf, pos(), walk, payToll, over);
        }

        if (over() || ended) break;
        let boughtInRound = 0;
        let blindWaits = false;
        let blindUnit = 0;

        if (conf.dialogBuy) {
            const owned = countItems(s, conf.dialogBuy.item) + ([...stock.entries()].find(([k]) => conf.dialogBuy!.item.test(k))?.[1] ?? 0);
            const wanted = Math.max(0, stockTarget - owned);
            if (wanted > 0 && boughtTotal < MAX_ITEMS && spentTotal < MAX_SPEND) {
                const res = await runDialogBuyStep(
                    s.sdk,
                    s.bot,
                    conf.npc,
                    conf.dialogBuy,
                    COIN_RESERVE,
                    MAX_SPEND - spentTotal,
                    Math.min(wanted, MAX_ITEMS - boughtTotal),
                    () => waitTicks(s, 1),
                );
                if (res.bought > 0) {
                    boughtInRound += res.bought;
                    boughtTotal += res.bought;
                    spentTotal += res.spent;
                    console.log(`BOUGHT ${res.bought}x ${conf.dialogBuy.item.source}`);
                }
            }
        } else {
            if (!s.sdk.getState()?.shop?.isOpen) {
                const shopRes = await s.bot.openShop(conf.npc);
                if (!s.sdk.getState()?.shop?.isOpen && conf.dialogOpen) {
                    if (!s.sdk.getDialog()?.isOpen) await s.bot.talkTo(conf.npc);
                    await handleDialogShopOpen(s.sdk, conf.dialogOpen, () => waitTicks(s, 1));
                }
                if (!s.sdk.getState()?.shop?.isOpen && !shopRes.success) {
                    console.log(`WARN openShop failed: ${shopRes.message}`);
                    await waitTicks(s, 5);
                    continue;
                }
                if (s.sdk.getState()?.shop?.isOpen) shopTrips++;
            }

            const shop = s.sdk.getState()?.shop;
            if (shop?.isOpen && shop.shopItems && blindTargets.length) {
                boughtInRound += blindLook();
                for (const target of blindTargets) {
                    const item = shop.shopItems.find(i => target.re.test(i.name));
                    if (!item) continue;
                    const unit = unitBound(item, shop.shopConfig, target.shelf, priceRules);
                    blindBase ??= { coins: coins(), held: blindHeld(), unit };
                    blindBase.unit = Math.max(blindBase.unit, unit);
                    const owned = s.sdk.getInventory().filter(i => target.re.test(i.name)).reduce((n, i) => n + i.count, 0) + (stock.get(item.name.toLowerCase()) ?? 0);
                    const wanted = stockTarget - owned;
                    if (wanted > 0 && boughtTotal < MAX_ITEMS) {
                        blindWaits = true;
                        blindUnit = Math.max(blindUnit, unit);
                    }
                    if (!blindBuyNow({
                        unit,
                        wallet: coins(),
                        reserve: COIN_RESERVE,
                        remainingSpend: MAX_SPEND - spentTotal,
                        remainingItems: MAX_ITEMS - boughtTotal,
                        wanted,
                        freeSlots: 28 - s.sdk.getInventory().length,
                        pending: blindPending(),
                    })) continue;
                    const sent = await s.direct({ type: 'shopBuy', slot: item.slot, amount: 1, reason: 'SDK' }) as { success?: boolean } | null;
                    if (sent?.success) {
                        blindRequests++;
                        blindSent.push(s.tick());
                    }
                }
            }

            if (shop?.isOpen && shop.shopItems) {
                reportShelf(shop.shopItems);
                const purchases = planShopPurchases(
                    planTargets,
                    shop.shopItems,
                    s.sdk.getInventory(),
                    stock,
                    Math.max(0, Math.min(coins() - COIN_RESERVE, MAX_SPEND - spentTotal)),
                    stockTarget,
                    MAX_ITEMS - boughtTotal,
                );
                if (!purchases.length && !loggedEmpty) {
                    loggedEmpty = true;
                    console.log('SHOP_NONE ' + JSON.stringify({
                        shelf: shop.shopItems.filter(i => conf.items.some(t => t.re.test(i.name))).map(i => ({ name: i.name, count: i.count, price: i.buyPrice })),
                        coins: coins(),
                        free: 28 - s.sdk.getInventory().length,
                        stockTarget,
                        bank: conf.items.map(t => [...stock].find(([n]) => t.re.test(n))),
                    }));
                }
                for (const purchase of purchases) {
                    const remaining = Math.min(purchase.amount, MAX_ITEMS - boughtTotal);
                    if (remaining <= 0) break;
                    let countBought = 0;
                    if (guarded) {
                        const result = await buyWithBudget(s.bot, s.sdk, purchase.name, remaining, COIN_RESERVE, MAX_SPEND - spentTotal, shelfOf(purchase.name), priceRules);
                        countBought = result.bought;
                        spentTotal += result.spent;
                    } else {
                        const before = coins();
                        const b = await s.bot.buyFromShop(purchase.name, remaining);
                        countBought = b.amountBought ?? 0;
                        spentTotal += Math.max(0, before - coins());
                    }
                    if (countBought > 0) {
                        boughtInRound += countBought;
                        boughtTotal += countBought;
                        console.log(`BOUGHT ${countBought}x ${purchase.name}`);
                    }
                }
            }
        }

        if (boughtInRound === 0) {
            const needed = planShopPurchases(planTargets, s.sdk.getState()?.shop?.shopItems ?? [], s.sdk.getInventory(), stock, Number.MAX_SAFE_INTEGER, stockTarget);
            if ((needed.length && coins() < Math.max(1000, COIN_RESERVE + 1) && (stock.get('coins') ?? 0) > 0)
                || (guarded && needed.length && coins() < Math.min(FLOAT, COIN_RESERVE + MAX_SPEND - spentTotal) && (stock.get('coins') ?? 0) > 0)) {
                const before = coins();
                await bank();
                if (coins() > before) {
                    noBuySince = undefined;
                    continue;
                }
            }
            if (guarded && needed.length && NO_BUY_TICKS === 0) {
                stopReason = 'bounded-purchase-unaffordable';
                break;
            }
            const shelves = s.sdk.getState()?.shop;
            if (guarded && needed.length && needed.every(n => {
                const item = shelves?.shopItems.find(i => i.name === n.name);
                return shelfOf(n.name) !== undefined && !!item && coins() - COIN_RESERVE < unitBound(item, shelves?.shopConfig, shelfOf(n.name), priceRules);
            })) {
                stopReason = 'coin-reserve';
                break;
            }
            if (!guarded && NO_BUY_TICKS === 0 && (stock.get('coins') ?? 0) === 0 && needed.length && needed.every(n => {
                const item = shelves?.shopItems.find(i => i.name === n.name);
                return !!item && coins() < item.buyPrice;
            })) {
                stopReason = 'coin-reserve';
                break;
            }
            if (blindWaits && blindPending() === 0 && Math.min(coins() - COIN_RESERVE, MAX_SPEND - spentTotal) < blindUnit) {
                if (MAX_SPEND - spentTotal < blindUnit) {
                    stopReason = 'spend-cap';
                    break;
                }
                const before = coins();
                if ((stock.get('coins') ?? 0) > 0) await bank();
                if (coins() > before) {
                    noBuySince = undefined;
                    continue;
                }
                stopReason = 'coin-reserve';
                break;
            }
            if (shopTargetsMet(conf.items, s.sdk.getInventory(), stock, stockTarget)) {
                stopReason = 'stock-target';
                break;
            }
            const waiting = stockWaitStatus(s.tick(), noBuySince, NO_BUY_TICKS, blindWaits ? 1 : STOCK_POLL_TICKS);
            if (NO_BUY_TICKS > 0) noBuySince = waiting.since;
            if (waiting.done) {
                noBuyTicks = s.tick() - waiting.since;
                stopReason = 'stock-wait';
                break;
            }
            await waitTicks(s, waiting.waitTicks);
        } else {
            noBuySince = undefined;
            await waitTicks(s, blindWaits ? 1 : 2);
        }
    }

    closing = true;
    if (!ended) await blindSettle();
    if (!ended) await leaveRealm();
    if (!ended) await bank(false);
    if (!ended && (pos()?.level ?? 0) === 1 && !conf.realm?.inside(pos() ?? { worldX: 0, worldZ: 0 }) && pickDisembarkPlank(s as unknown as BoatSession)) {
        await leaveDeck(s as unknown as Walker, () => ended);
        if (!ended && pos()?.level === 0) await bank(false);
    }
    const strandedOnDeck = !ended && (pos()?.level ?? 0) === 1 && !conf.realm?.inside(pos() ?? { worldX: 0, worldZ: 0 }) && !!pickDisembarkPlank(s as unknown as BoatSession);
    const targetMet = shopTargetsMet(conf.items, s.sdk.getInventory(), stock, stockTarget);
    const ok = !strandedOnDeck && shopFinishOk(boughtTotal, targetMet, stopReason, FILL_ORDER ? MAX_ITEMS : undefined);
    const ticks = used();
    const coinsLeft = coins();
    const orderShort = FILL_ORDER && !ok && !strandedOnDeck ? `${shopOrderShortText(boughtTotal, MAX_ITEMS, stopReason, cfg.itemId)} ` : '';
    const summary = `${strandedOnDeck ? `stranded on deck level=${pos()?.level} ` : ''}${orderShort}ticks=${ticks} boughtTotal=${boughtTotal} bankedTotal=${bankedTotal} bankTrips=${bankTrips} shopTrips=${shopTrips} coinsLeft=${coinsLeft} spentTotal=${spentTotal} coinReserve=${COIN_RESERVE} maxSpend=${MAX_SPEND} maxItems=${MAX_ITEMS} stop=${stopReason} targetMet=${targetMet ? 1 : 0} noBuyTicks=${noBuyTicks} noBuyLimit=${NO_BUY_TICKS} fareTotal=${fareTotal}${BLIND_BUY ? ` blindRequests=${blindRequests}` : ''}`;
    return {
        ok,
        strandedOnDeck,
        ticks,
        boughtTotal,
        bankedTotal,
        bankTrips,
        shopTrips,
        coinsLeft,
        spentTotal,
        coinReserve: COIN_RESERVE,
        maxSpend: MAX_SPEND,
        maxItems: MAX_ITEMS,
        stop: stopReason,
        targetMet,
        noBuyTicks,
        noBuyLimit: NO_BUY_TICKS,
        fareTotal,
        blindRequests,
        blindBuy: BLIND_BUY,
        summary,
    };
}

// --- Earth shop refill (from scripts/earth-shop.ts) ---

export function earthRefillAmount(shelf: number, missing: number) {
    if (![shelf, missing].every(n => Number.isSafeInteger(n) && n >= 0)) throw Error('earth refill quantities unknown');
    return Math.min(1, missing);
}

export const earthSeedNeeded = (shelf: number, carried: number, seeded: boolean) =>
    Number.isSafeInteger(shelf) && shelf >= 0 && carried >= 1 && !seeded;

export const earthRefillStop = (idle: number, affordable: boolean): 'budget' | 'stock-wait' | undefined =>
    !affordable ? 'budget' : idle >= 25 ? 'stock-wait' : undefined;

export function retainedEarthBank(read: () => { items: readonly { id: number; count: number }[] } | null | undefined) {
    let confirmed: { id: number; count: number }[] = [];
    return () => {
        const live = read();
        if (live) confirmed = live.items.map(i => ({ id: i.id, count: i.count }));
        return confirmed;
    };
}

export async function openEarthBankObserved(s: Session) {
    const previous = s.bankObservation?.();
    if (s.sdk.getState()?.bank.isOpen && previous) return;
    const generation = previous?.generation ?? 0;
    if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!s.sdk.getState()?.bank.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 15 })) {
        throw Error('earth refill bank unobserved');
    }
}

export async function sellEarthSeedObserved(s: Session, stop: () => boolean) {
    const count = (id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((v, i) => v + i.count, 0);
    const earth = count(557);
    const coins = count(995);
    if (earth < 1) throw Error('earth seed is not owned');
    await s.bot.sellToShop(/^earth rune$/i, 1);
    const paired = () => count(557) === earth - 1 && count(995) > coins;
    if (!await waitUntil(s, () => stop() || paired(), { timeoutTicks: 10 }) || stop() || !paired()) {
        throw Error('earth seed debit/positive credit unobserved; zero-price sale remains unresolved');
    }
    return count(995) - coins;
}

export async function buyEarthObserved(s: Session, n: number, reserve: number, remaining: number, stop: () => boolean) {
    if (n !== 1) throw Error('earth settlement requires one purchase packet');
    const count = (id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((v, i) => v + i.count, 0);
    const coins = count(995);
    const earth = count(557);
    const state = s.sdk.getState();
    const item = state?.shop.shopItems.find(i => i.id === 557);
    if (!state?.shop.isOpen || !item || !Number.isSafeInteger(item.slot)) throw Error('earth purchase slot unobserved');
    const unit = maximumUnitCost(item, state.shop.shopConfig);
    if (Math.min(coins - reserve, remaining) < unit) throw Error('earth purchase worst-price funding unavailable');
    const messageAfter = Math.max(0, ...(state.gameMessages ?? []).map(m => m.observationId ?? 0));
    const refused = () => (s.sdk.getState()?.gameMessages ?? []).some(
        m => m.type === 0 && m.sender === '' && Number.isSafeInteger(m.observationId) && (m.observationId ?? 0) > messageAfter && /^The shop has run out of stock\.$/i.test(m.text),
    );
    const paired = () => count(557) === earth + 1 && count(995) < coins;
    if (!(await s.sdk.sendShopBuy(item.slot, 1)).success) throw Error('earth purchase dispatch refused');
    if (!await waitUntil(s, () => stop() || paired() || refused(), { timeoutTicks: 6 })) {
        throw Error('earth purchase unacknowledged; retain unresolved intent');
    }
    if (stop()) throw Error('earth purchase stopped before settlement');
    const bought = count(557) - earth;
    const spent = coins - count(995);
    if (!Number.isSafeInteger(bought) || bought < 0 || bought > n || !Number.isSafeInteger(spent) || spent < 0 || spent > Math.min(unit, remaining) || count(995) < reserve
        || (bought === 0 && spent !== 0) || (bought > 0 && spent < bought)) {
        throw Error('earth purchase paired accounting unresolved');
    }
    return { bought, spent };
}

export async function runEarthRefill(
    s: Session,
    o: { profile: string; cap: number; target: number; maximum: number; spend: number; reserve: number; seedUsed: number; stop: () => boolean },
) {
    const conf = PROFILES[o.profile];
    if (!['aubury', 'betty'].includes(o.profile) || !conf || ![o.cap, o.target, o.maximum, o.spend, o.reserve].every(n => Number.isSafeInteger(n) && n >= 0) || ![0, 1].includes(o.seedUsed) || o.cap < 1 || o.cap > 16000 || o.target < 1) {
        throw Error('invalid earth refill bounds');
    }
    const start = s.tick();
    const st = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const pos = () => st()?.player;
    if (!await waitUntil(s, () => !!pos() && (s.sdk.getSkill('Hitpoints')?.level ?? 0) > 6, { timeoutTicks: 20 })) throw Error('earth refill life unknown');
    const life = pos();
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const terminal = () => ended || sessionDied(life, pos()) || hp() <= 6;
    const stopped = () => o.stop() || existsSync(`.practice/stop-${s.name}`);
    const over = () => terminal() || stopped() || s.tick() - start >= o.cap;
    const held = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const bankItems = retainedEarthBank(() => s.bankObservation?.());
    const banked = (id: number) => bankItems().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const assets = () => {
        const m = new Map<number, number>();
        for (const i of [...inv(), ...s.sdk.getEquipment(), ...bankItems()]) m.set(i.id, (m.get(i.id) ?? 0) + i.count);
        return m;
    };
    const shelf = () => st()?.shop.shopItems.find(i => i.id === 557)?.count;
    let boughtTotal = 0;
    let spentTotal = 0;
    let seeded = 0;
    let seedCredit = 0;
    let stockGrowth = false;
    let stop = 'cap';
    let failure = '';
    let uncertain = false;
    let initial: Map<number, number> | undefined;
    let hpMin = hp();
    let lastProgress = start;
    const off = s.onTick(() => { hpMin = Math.min(hpMin, hp()); });
    const walk = async (to: { x: number; z: number }, cleanup = false) => {
        if (terminal() || (!cleanup && over())) throw Error('earth refill stopped before travel');
        const abort = new AbortController();
        const cancel = () => { if (terminal() || (!cleanup && over())) abort.abort(); };
        const tickOff = s.onTick(cancel);
        let r;
        try {
            cancel();
            r = await goTo(s, await getWorld(), { ...to, level: 0 }, accountOf(s), { legTimeoutTicks: 100, signal: abort.signal });
        } finally {
            tickOff();
        }
        if (!r.ok || terminal() || (!cleanup && over())) throw Error('earth refill route refused: ' + JSON.stringify(r));
    };
    const openBank = () => openEarthBankObserved(s);
    const bank = async (cleanup = false) => {
        await s.bot.dismissBlockingUI();
        await walk(conf.bankSpot, cleanup);
        await openBank();
        for (const i of [...inv()]) if (cleanup || i.id !== 995) await depositObserved(s, i);
        bankItems();
    };
    const withdraw = async (id: number, n: number) => {
        if (over()) throw Error('earth refill stopped before withdrawal');
        if (!n) return;
        const item = st()?.bank.items.find(i => i.id === id);
        const before = held(id);
        const stored = banked(id);
        if (!item || stored < n) throw Error('earth refill missing owned item ' + id);
        await s.bot.withdrawItem(item, n);
        if (!await waitUntil(s, () => held(id) === before + n && banked(id) === stored - n, { timeoutTicks: 10 })) {
            throw Error('earth refill withdrawal unobserved');
        }
    };
    try {
        await bank();
        initial = assets();
        const missing = Math.max(0, o.target - (initial.get(557) ?? 0));
        if (missing > o.maximum + o.seedUsed) throw Error('earth refill existing stock below authorized order');
        if (missing) {
            const needed = Math.max(0, o.reserve + o.spend - held(995));
            await withdraw(995, Math.min(needed, banked(995)));
            if (held(995) <= o.reserve) throw Error('earth refill reserve unavailable');
            if (banked(557) > 0) await withdraw(557, 1);
            await s.bot.closeBank();
            await walk(conf.npcSpot);
            if (!(await s.bot.openShop(conf.npc)).success || !await waitUntil(s, () => st()?.shop.isOpen === true && shelf() !== undefined, { timeoutTicks: 10 })) {
                throw Error('earth refill shop unobserved');
            }
            console.log('EARTH_REFILL_SHELF ' + JSON.stringify({ tick: s.tick(), count: shelf(), carried: held(557) }));
            if (earthSeedNeeded(shelf()!, held(557), o.seedUsed === 1)) {
                uncertain = true;
                seedCredit = await sellEarthSeedObserved(s, over);
                seeded = 1;
                uncertain = false;
                lastProgress = s.tick();
                console.log('EARTH_REFILL_SEED ' + JSON.stringify({ tick: s.tick(), seeded, seedCredit, count: shelf() }));
            }
            lastProgress = s.tick();
            let previous = shelf();
            while (!over() && banked(557) + held(557) < o.target && boughtTotal < o.maximum + o.seedUsed + seeded && spentTotal < o.spend) {
                const count = shelf();
                if (count === undefined) throw Error('earth shelf observation lost');
                if (previous !== count) {
                    console.log('EARTH_REFILL_STOCK ' + JSON.stringify({ tick: s.tick(), count, boughtTotal, spentTotal }));
                    if (count > (previous ?? count)) stockGrowth = true;
                    previous = count;
                }
                const n = earthRefillAmount(count, Math.min(o.target - banked(557) - held(557), o.maximum + o.seedUsed + seeded - boughtTotal));
                if (n > 0) {
                    const item = st()!.shop.shopItems.find(i => i.id === 557)!;
                    const unit = maximumUnitCost(item, st()!.shop.shopConfig);
                    const unavailable = earthRefillStop(s.tick() - lastProgress, held(995) - o.reserve >= unit && o.spend - spentTotal >= unit);
                    if (unavailable) {
                        stop = unavailable;
                        break;
                    }
                    uncertain = true;
                    const result = await buyEarthObserved(s, n, o.reserve, o.spend - spentTotal, over);
                    boughtTotal += result.bought;
                    spentTotal += result.spent;
                    uncertain = false;
                    if (result.bought) {
                        lastProgress = s.tick();
                        continue;
                    }
                    if (result.spent) throw Error('earth debit without observed runes');
                }
                if (s.tick() - lastProgress >= 25) {
                    stop = 'stock-wait';
                    break;
                }
                await waitTicks(s, 1);
            }
        }
    } catch (error) {
        failure = String(error);
    } finally {
        try {
            if (!terminal()) {
                await bank(true);
                await s.bot.closeBank();
            }
        } catch (error) {
            failure += '; ' + String(error);
        }
        off();
    }
    const final = assets();
    const before = initial;
    const conserved = !!before && (final.get(557) ?? 0) === (before.get(557) ?? 0) + boughtTotal - seeded
        && (final.get(995) ?? 0) === (before.get(995) ?? 0) + seedCredit - spentTotal
        && [...before].every(([id, n]) => [557, 995].includes(id) || (final.get(id) ?? 0) === n);
    const targetMet = banked(557) >= o.target && held(557) === 0;
    const atBank = held(995) === 0 && !!pos() && pos()!.level === 0 && Math.max(Math.abs(pos()!.worldX - conf.bankSpot.x), Math.abs(pos()!.worldZ - conf.bankSpot.z)) <= 4;
    if (uncertain || !conserved) throw Error('earth refill accounting unresolved; retain running intent: ' + failure);
    const safeOffline = !failure && !terminal() && !stopped() && atBank;
    return {
        ok: safeOffline && targetMet,
        safeOffline,
        targetMet: targetMet ? 1 : 0,
        bank: atBank,
        conserved,
        boughtTotal,
        spentTotal,
        seeded,
        seedCredit,
        stockGrowth,
        hpMin,
        stop,
        target: o.target,
        finalEarth: final.get(557) ?? 0,
        finalCoins: final.get(995) ?? 0,
        ticks: s.tick() - start,
        failure: failure || '-',
    };
}

export async function runEarthShopSession(s: Session, cfg: EarthShopConfig, stop: () => boolean = () => false) {
    const r = await runEarthRefill(s, {
        profile: cfg.profile,
        cap: cfg.cap,
        target: cfg.target,
        maximum: cfg.maximum,
        spend: cfg.spend,
        reserve: cfg.reserve,
        seedUsed: cfg.seedUsed ?? 0,
        stop,
    });
    const quiescent = r.safeOffline && shopFinishOk(0, false, r.stop);
    return { ...r, quiescent };
}

// --- Owned Varrock sword buyer (from scripts/buy-owned-sword.ts) ---

function swordBudget(o: { itemId?: number; cap: number; maximumSpend: number }) {
    const id = o.itemId ?? SWORD;
    const profile = SWORD_PROFILES[id];
    if (!profile || !Number.isSafeInteger(o.cap) || o.cap < 1 || !Number.isSafeInteger(o.maximumSpend) || o.maximumSpend < 1 || o.maximumSpend > profile.limit) {
        throw Error('requires positive CAP and item-specific MAX_SPEND limit');
    }
    return id;
}

const SWORD_BANK = { x: 3185, z: 3436 };
export const SWORD_ROUTE = [[3185, 3420], [3195, 3418], [3204, 3400], [3204, 3398]] as const;
export const swordTileSafe = (p: { x: number; z: number; level?: number }) => (p.level ?? 0) === 0 && (
    (p.x >= 3182 && p.x <= 3208 && p.z >= 3394 && p.z <= 3440 && (p.z >= 3410 || p.x >= 3195))
    || (p.x >= 3209 && p.x <= 3210 && p.z >= 3399 && p.z <= 3406)
);

export function swordQuote(item: SdkShopItem, config: ShopConfig | undefined) {
    const profile = SWORD_PROFILES[item.id];
    if (!profile || !Number.isSafeInteger(item.count) || item.count < 1 || item.baseCost !== profile.cost
        || item.buyPrice !== profile.cost || !config || config.sellMultiplier !== 1000 || config.haggle !== 10) {
        throw new Error('unknown sword shop price/config/stock');
    }
    const price = Math.max(1, Math.floor(profile.cost * Math.max(100, 1000 - Math.min(1000, Math.max(-5000, (item.count - profile.stock) * config.haggle))) / 1000));
    return { reportedBuyPrice: item.buyPrice, price };
}

export async function runOwnedSword(
    s: Session,
    o: { itemId?: number; cap: number; maximumSpend: number; stop?: () => boolean; walk?: (x: number, z: number, tol: number) => Promise<boolean> },
) {
    const itemId = swordBudget(o);
    const state = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const count = (items: readonly { id: number; count: number }[], id: number) => items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const held = (id: number) => count(inv(), id);
    const start = s.tick();
    const initial = state()?.player;
    const initialHp = hp();
    if (!initial || initial.level !== 0 || Math.max(Math.abs(initial.worldX - SWORD_BANK.x), Math.abs(initial.worldZ - SWORD_BANK.z)) > 2
        || initialHp <= 6 || held(995) !== 0 || held(itemId) !== 0 || inv().length > 26) {
        throw new Error('requires known Varrock West bank, empty wallet/output and2free pack slots');
    }
    let ended = false;
    let died = false;
    let damaged = false;
    let stopped = false;
    let hpMin = initialHp;
    let failure = '';
    let spent = 0;
    let bought = 0;
    let banked = 0;
    let price = 0;
    let reportedBuyPrice = 0;
    let bankObservedAt = 0;
    let cleanupDeadline = 0;
    let routeReached = 0;
    let snapshot: { id: number; count: number }[] = [];
    let original = new Map<number, number>();
    void s.ended.then(() => { ended = true; });
    const terminal = () => ended || died || (stopped ||= !!o.stop?.());
    const over = () => terminal() || damaged || s.tick() - start >= o.cap;
    const off = s.onTick(() => {
        const p = state()?.player;
        hpMin = Math.min(hpMin, hp());
        damaged ||= hp() < initialHp;
        stopped ||= !!o.stop?.();
        died ||= !!p?.isDead || (p?.lifeId ?? initial.lifeId) !== initial.lifeId || (p?.respawnCount ?? 0) > (initial.respawnCount ?? 0);
    });
    const capture = () => {
        const b = s.bankObservation?.();
        if (!b || !state()?.bank.isOpen) throw new Error('sword bank data unknown');
        snapshot = b.items.map(i => ({ id: i.id, count: i.count }));
        bankObservedAt = b.at;
    };
    const bankCount = (id: number) => count(snapshot, id);
    const assets = () => {
        const m = new Map<number, number>();
        for (const i of [...snapshot, ...inv(), ...(state()?.equipment ?? [])]) m.set(i.id, (m.get(i.id) ?? 0) + i.count);
        return m;
    };
    const open = async () => {
        if (state()?.bank.isOpen && s.bankObservation?.()) {
            capture();
            return;
        }
        await s.bot.dismissBlockingUI();
        const gen = s.bankObservation?.()?.generation ?? 0;
        if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!state()?.bank.isOpen && (s.bankObservation?.()?.generation ?? 0) > gen || terminal(), { timeoutTicks: 15 }) || terminal()) {
            throw new Error('sword bank readiness unobserved');
        }
        capture();
    };
    const walk = async (x: number, z: number, tol: number, cleanup = false) => {
        const stopWalk = () => terminal() || s.tick() >= (cleanup ? cleanupDeadline : start + o.cap) || (!cleanup && damaged);
        if (stopWalk()) throw new Error('sword route stopped');
        const current = state()?.player;
        if (current?.level === 0 && Math.max(Math.abs(current.worldX - x), Math.abs(current.worldZ - z)) <= tol) return;
        if (o.walk) {
            if (!await o.walk(x, z, tol)) throw new Error('sword route refused');
            return;
        }
        const deps = await sessionWalker(s);
        const plan = deps.plan;
        deps.plan = (level, from, to) => {
            const corners = plan(level, from, to);
            const tiles = expandPath(from, corners);
            const offending = [from, ...tiles].filter(p => !swordTileSafe({ ...p, level }));
            if (level !== 0 || !corners.length || offending.length) {
                console.log('SWORD_ROUTE_REFUSED ' + JSON.stringify({ level, from, to, corners, offending }));
                throw new Error('sword route unsafe/unknown full path');
            }
            return corners;
        };
        if (!(await walkPath(deps, [{ x, z, tol }], { stop: stopWalk, maxTicks: Math.min(180, Math.max(1, (cleanup ? cleanupDeadline : start + o.cap) - s.tick())) })).ok) {
            throw new Error('sword route failed');
        }
    };
    try {
        await open();
        original = assets();
        if (bankCount(995) < o.maximumSpend || bankCount(itemId) !== 0) throw new Error('owned budget missing or sword already owned');
        const coins = state()!.bank.items.find(i => i.id === 995)!;
        if (!(await s.bot.withdrawItem(coins, o.maximumSpend, { asNote: false })).success
            || !await waitUntil(s, () => held(995) === o.maximumSpend || terminal(), { timeoutTicks: 10 }) || terminal()) {
            throw new Error('owned coin withdrawal unobserved');
        }
        capture();
        if (bankCount(995) !== (original.get(995) ?? 0) - o.maximumSpend) throw new Error('owned coin bank debit mismatch');
        await s.bot.closeBank();
        for (const [x, z] of SWORD_ROUTE) {
            await walk(x, z, 1);
            routeReached++;
        }
        if (over()) throw new Error('sword production cap/stop');
        const npc = state()?.nearbyNpcs.find(n => [551, 552].includes(n.id) && n.distance <= 8 && n.optionsWithIndex.some(p => /^trade$/i.test(p.text)));
        if (!npc || !swordTileSafe({ x: npc.tileX ?? npc.x, z: npc.tileZ ?? npc.z, level: 0 })) throw new Error('exact swordshop NPC not observed in range');
        await walk(npc.tileX ?? npc.x, npc.tileZ ?? npc.z, 1);
        if (!(await s.bot.openShop(npc)).success) throw new Error('sword shop did not open');
        const shop = state()?.shop;
        const item = shop?.shopItems.find(i => i.id === itemId);
        if (!shop?.isOpen || !item) throw new Error('sword not observed on shelf');
        console.log('ACTUAL_SHOP ' + JSON.stringify({ item, config: shop.shopConfig }));
        ({ price, reportedBuyPrice } = swordQuote(item, shop.shopConfig));
        if (price > o.maximumSpend || price > held(995) || over()) throw new Error('sword price exceeds owned spending cap');
        console.log('SWORD_QUOTE ' + JSON.stringify({ npc: npc.id, item: itemId, stock: item.count, reportedBuyPrice, price, maximumSpend: o.maximumSpend }));
        const before = held(995);
        const r = await s.bot.buyFromShop(item, 1);
        await waitUntil(s, () => (held(itemId) === 1 && held(995) < before) || ended || died, { timeoutTicks: 10 });
        spent = before - held(995);
        bought = held(itemId);
        if (!r.success || r.amountBought !== 1 || bought !== 1 || spent !== price || spent > o.maximumSpend) {
            throw new Error('one sword/actual price debit mismatch');
        }
    } catch (e) {
        failure = String(e);
    } finally {
        cleanupDeadline = s.tick() + 240;
        if (!terminal()) {
            try {
                if (state()?.shop?.isOpen) await s.bot.closeShop();
                for (const [x, z] of SWORD_ROUTE.slice(0, routeReached).reverse()) await walk(x, z, 1, true);
                await walk(SWORD_BANK.x, SWORD_BANK.z, 2, true);
                await open();
                for (const id of [itemId, 995]) {
                    const item = inv().find(i => i.id === id);
                    if (!item) continue;
                    const n = held(id);
                    const before = bankCount(id);
                    const gen = s.bankObservation?.()?.generation ?? 0;
                    if (!(await s.bot.depositItem(item, -1)).success
                        || !await waitUntil(s, () => (held(id) === 0 && (s.bankObservation?.()?.generation ?? 0) > gen) || terminal(), { timeoutTicks: 10 }) || terminal()) {
                        throw new Error('sword/cash final deposit unobserved');
                    }
                    capture();
                    if (bankCount(id) !== before + n) throw new Error('sword/cash bank delta mismatch');
                }
                capture();
                banked = bankCount(itemId) - (original.get(itemId) ?? 0);
                await s.bot.closeBank();
            } catch (e) {
                failure = [failure, String(e)].filter(Boolean).join('; ');
            }
        }
        off();
    }
    const final = assets();
    const preserved = original.size > 0 && [...new Set([...original.keys(), ...final.keys()])].every(
        id => (final.get(id) ?? 0) === (original.get(id) ?? 0) + (id === itemId ? bought : 0) - (id === 995 ? spent : 0),
    );
    const targetMet = bought === 1 && banked === 1 && held(itemId) === 0 && held(995) === 0;
    return {
        itemId,
        ok: !failure && !terminal() && !damaged && preserved && targetMet,
        targetMet,
        bought,
        banked,
        spent,
        price,
        reportedBuyPrice,
        maximumSpend: o.maximumSpend,
        coinsRemaining: final.get(995) ?? 0,
        hpMin,
        died,
        damaged,
        stopped,
        preserved,
        bankObservedAt,
        ticks: s.tick() - start,
        failure: failure || (!targetMet ? 'one sword goal unmet' : !preserved ? 'asset conservation failed' : '-'),
    };
}

const EAST_BUYER_ROUTE = [{ x: 3252, z: 3420 }, { x: 3253, z: 3420 }, { x: 3212, z: 3424 }, { x: 3185, z: 3436 }];
const EAST_BUYER_PATHS = [
    { from: { x: 3252, z: 3420 }, corners: [{ x: 3253, z: 3420 }] },
    { from: { x: 3253, z: 3420 }, corners: [{ x: 3253, z: 3428 }, { x: 3218, z: 3428 }, { x: 3216, z: 3426 }, { x: 3215, z: 3426 }, { x: 3214, z: 3425 }, { x: 3213, z: 3425 }, { x: 3212, z: 3424 }] },
    { from: { x: 3212, z: 3424 }, corners: [{ x: 3209, z: 3424 }, { x: 3205, z: 3428 }, { x: 3189, z: 3428 }, { x: 3188, z: 3429 }, { x: 3185, z: 3429 }, { x: 3182, z: 3432 }, { x: 3182, z: 3435 }, { x: 3183, z: 3436 }, { x: 3185, z: 3436 }] },
];

export async function runOwnedSwordFromEast(
    s: Session,
    o: { itemId?: number; cap: number; maximumSpend: number; stop?: () => boolean },
) {
    const itemId = swordBudget(o);
    const start = s.tick();
    const p = s.sdk.getState()?.player;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    if (o.stop?.() || !p || p.level !== 0 || p.worldX !== 3252 || p.worldZ !== 3420 || hp() <= 6) {
        throw Error('Eastbank preparation requires checked start and healthy active account');
    }
    let damaged = false;
    let ended = false;
    let previous = hp();
    let refused = false;
    void s.ended.then(() => { ended = true; });
    const off = s.onTick(() => {
        if (hp() < previous) damaged = true;
        previous = hp();
    });
    const terminal = () => !!o.stop?.() || ended;
    const over = () => terminal() || damaged || s.tick() - start >= o.cap;
    try {
        if (!(await s.bot.openBank()).success) throw Error('Eastbank preparation bank failed');
        const coins = s.sdk.getInventory().find(i => i.id === 995);
        let deposited = 0;
        if (coins) deposited = await depositObserved(s, coins);
        if (over()) throw Error('Eastbank preparation ended after deposit');
        await s.bot.closeBank();
        const deps = await sessionWalker(s);
        const plan = deps.plan;
        const allowed = new Set(EAST_BUYER_PATHS.flatMap(l => [l.from, ...expandPath(l.from, l.corners)].map(pt => pt.x + ',' + pt.z)));
        deps.plan = (level, from, to) => {
            const path = from.x === to.x && from.z === to.z ? [to] : plan(level, from, to);
            const tiles = [from, ...expandPath(from, path)];
            const bad = tiles.filter(pt => !allowed.has(pt.x + ',' + pt.z));
            if (level !== 0 || !path.length || bad.length) {
                refused = true;
                console.log('SWORD_TRANSIT_REFUSED ' + JSON.stringify({ level, from, to, path, bad }));
                return [];
            }
            return path;
        };
        const sendWalk = deps.walk;
        const sendLoc = deps.interactLoc;
        deps.walk = (x, z) => (refused || over() ? { success: false } : sendWalk(x, z));
        deps.interactLoc = (l, op) => (refused || over() ? { success: false } : sendLoc(l, op));
        for (const point of EAST_BUYER_ROUTE.slice(1)) {
            const r = await walkPath(deps, [{ ...point, tol: 0 }], { maxTicks: 180, stop: () => refused || over() || s.tick() - start >= 250 });
            if (!r.ok || refused || over()) throw Error('Eastbank preparation route incomplete');
        }
        const transitTicks = s.tick() - start;
        const remaining = o.cap - transitTicks;
        if (remaining < 1) throw Error('Eastbank preparation exhausted purchase budget');
        const result = await runOwnedSword(s, { itemId, cap: remaining, maximumSpend: o.maximumSpend, stop: terminal });
        return { ...result, ticks: s.tick() - start, preparation: { deposited, transitTicks } };
    } finally {
        off();
    }
}

export async function runBuySwordSession(s: Session, cfg: BuySwordConfig, stop: () => boolean = () => false) {
    const run = cfg.prepareEast ? runOwnedSwordFromEast : runOwnedSword;
    const itemId = cfg.itemId ?? SWORD;
    return run(s, {
        itemId,
        cap: cfg.cap ?? 900,
        maximumSpend: cfg.maximumSpend ?? SWORD_PROFILES[itemId]?.limit ?? 2500,
        stop,
    });
}
