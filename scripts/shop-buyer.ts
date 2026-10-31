// Universal Shop Buyer: buys restocked commodities (arrowtips, feathers, runes) and banks locally.
// Usage: bun scripts/shop-buyer.ts <bot> <profile: catherby | sarim | betty> [CAP ticks, default 15000]
// Environment: COIN_RESERVE/MAX_SPEND/MAX_ITEMS bound one run; defaults preserve existing unbounded jobs.
// NO_BUY_TICKS=25 opts into a clean bank-and-offline stop when shelves/budget yield no buys.
// DEMO_OK=1 is required for live; funding and route admission are separate gates.
import { openBot, finish, countItems, getWorld, accountOf } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker, goTo } from '../packages/core/src/walk';
import { bankCargo, courierWaiting, exactItem } from '../packages/core/src/cargo';
import { depositPack } from '../packages/core/src/deposit';

export const PROFILES: Record<string, {
    npc: RegExp;
    npcSpot: { x: number; z: number };
    bankSpot: { x: number; z: number };
    items: { re: RegExp; buyPerTick: number }[];
}> = {
    ardy: {
        npc: /^aemad$/i,
        npcSpot: { x: 2613, z: 3294 },
        bankSpot: { x: 2654, z: 3283 },
        items: [
            { re: /^vial of water$/i, buyPerTick: 25 },
            { re: /^ball of wool$/i, buyPerTick: 20 },
            { re: /^rope$/i, buyPerTick: 10 },
            { re: /^papyrus$/i, buyPerTick: 10 },
            { re: /^bronze arrow$/i, buyPerTick: 100 },
            { re: /^iron axe$/i, buyPerTick: 1 },
            { re: /^bronze pickaxe$/i, buyPerTick: 1 },
            { re: /^tinderbox$/i, buyPerTick: 1 },
        ],
    },
    catherby: {
        npc: /^hickton$/i,
        npcSpot: { x: 2821, z: 3444 },
        bankSpot: { x: 2809, z: 3441 },
        items: [
            { re: /rune arrowtips/i, buyPerTick: 10 },
            { re: /adamant arrowtips/i, buyPerTick: 10 },
            { re: /mithril arrowtips/i, buyPerTick: 10 },
            { re: /steel arrowtips/i, buyPerTick: 10 },
        ],
    },
    sarim: {
        npc: /^gerrant$/i,
        npcSpot: { x: 3013, z: 3225 },
        bankSpot: { x: 3092, z: 3243 }, // Draynor Bank
        items: [
            { re: /^feather$/i, buyPerTick: 50 },
            { re: /^lobster pot$/i, buyPerTick: 1 },
            { re: /^harpoon$/i, buyPerTick: 1 },
            { re: /^fishing bait$/i, buyPerTick: 50 },
        ],
    },
    betty: {
        npc: /^betty$/i,
        npcSpot: { x: 3012, z: 3259 },
        bankSpot: { x: 3092, z: 3243 }, // Draynor Bank
        items: [
            { re: /chaos rune/i, buyPerTick: 50 },
            { re: /death rune/i, buyPerTick: 50 },
            { re: /air rune/i, buyPerTick: 50 },
            { re: /fire rune/i, buyPerTick: 50 },
            { re: /water rune/i, buyPerTick: 50 },
            { re: /earth rune/i, buyPerTick: 50 },
            { re: /mind rune/i, buyPerTick: 50 },
            { re: /^body rune$/i, buyPerTick: 50 },
            { re: /eye of newt/i, buyPerTick: 50 },
        ],
    },
    // Harry's Catherby fishing shop (fishingshop2): a lobster pot for the Catherby lobster chain.
    harry: {
        npc: /^harry$/i,
        npcSpot: { x: 2834, z: 3445 },
        bankSpot: { x: 2809, z: 3441 }, // Catherby Bank
        items: [{ re: /^lobster pot$/i, buyPerTick: 1 }],
    },
    // Aubury's rune shop (runeshop: 2000 fire, 2000 earth): the route bill's fire and earth runes.
    aubury: {
        npc: /^aubury$/i,
        npcSpot: { x: 3253, z: 3402 },
        bankSpot: { x: 3253, z: 3420 }, // Varrock East Bank
        items: [
            { re: /^fire rune$/i, buyPerTick: 50 },
            { re: /^earth rune$/i, buyPerTick: 50 },
            { re: /^air rune$/i, buyPerTick: 50 },
            { re: /^water rune$/i, buyPerTick: 50 },
        ],
    },
    taverley: {
        npc: /^jatix$/i,
        npcSpot: { x: 2908, z: 3443 },
        bankSpot: { x: 2934, z: 3376 }, // Falador West Bank
        items: [
            { re: /eye of newt/i, buyPerTick: 50 },
            { re: /vial of water/i, buyPerTick: 50 },
            { re: /^vial$/i, buyPerTick: 50 },
            { re: /pestle and mortar/i, buyPerTick: 1 },
        ],
    },
    general_sarim: {
        npc: /^shopkeeper$/i,
        npcSpot: { x: 3014, z: 3205 },
        bankSpot: { x: 3092, z: 3243 }, // Draynor Bank
        items: [
            { re: /^chisel$/i, buyPerTick: 1 },
            { re: /^hammer$/i, buyPerTick: 1 },
            { re: /^tinderbox$/i, buyPerTick: 1 },
            { re: /^jug$/i, buyPerTick: 10 },
            { re: /^pot$/i, buyPerTick: 10 },
        ],
    },
    aubury: {
        npc: /^aubury$/i,
        npcSpot: { x: 3253, z: 3402 },
        bankSpot: { x: 3253, z: 3420 }, // Varrock East Bank
        items: [
            { re: /chaos rune/i, buyPerTick: 50 },
            { re: /death rune/i, buyPerTick: 50 },
            { re: /air rune/i, buyPerTick: 50 },
            { re: /fire rune/i, buyPerTick: 50 },
            { re: /water rune/i, buyPerTick: 50 },
            { re: /earth rune/i, buyPerTick: 50 },
            { re: /mind rune/i, buyPerTick: 50 },
            { re: /body rune/i, buyPerTick: 50 },
        ],
    },
    thessalia: {
        // NPC548, Trade3 -> clotheshop; leather_gloves1059 stock10.
        npc: /^thessalia$/i,
        npcSpot: { x: 3204, z: 3417 },
        bankSpot: { x: 3253, z: 3420 }, // Varrock East Bank
        items: [{ re: /^leather gloves$/i, buyPerTick: 1 }],
    },
    wydin: {
        // NPC557, Trade3 -> wydinstore; cheese1985 stock3.
        npc: /^wydin$/i,
        npcSpot: { x: 3014, z: 3204 },
        bankSpot: { x: 3092, z: 3243 }, // Draynor Bank
        items: [{ re: /^cheese$/i, buyPerTick: 1 }],
    },
    zeke: {
        npc: /^zeke$/i,
        npcSpot: { x: 3288, z: 3190 },
        bankSpot: { x: 3269, z: 3167 }, // Al Kharid Bank
        items: [
            { re: /mithril scimitar/i, buyPerTick: 1 },
            { re: /steel scimitar/i, buyPerTick: 1 },
            { re: /iron scimitar/i, buyPerTick: 1 },
            { re: /bronze scimitar/i, buyPerTick: 1 },
        ],
    },
    nurmof: {
        npc: /^nurmof$/i,
        npcSpot: { x: 2998, z: 9844 },
        bankSpot: { x: 3013, z: 3355 }, // Falador East Bank
        items: [
            { re: /rune pickaxe/i, buyPerTick: 1 },
            { re: /adamant pickaxe/i, buyPerTick: 1 },
            { re: /mithril pickaxe/i, buyPerTick: 1 },
            { re: /steel pickaxe/i, buyPerTick: 1 },
            { re: /iron pickaxe/i, buyPerTick: 1 },
            { re: /bronze pickaxe/i, buyPerTick: 1 },
        ],
    },
};

export interface ShopPurchaseTarget { re: RegExp; buyPerTick: number }
export interface ShopStock { name: string; count: number; buyPrice: number }
// Allocate slots among targets that can still be bought. Full tools consume no share.
export function planShopPurchases(targets: ShopPurchaseTarget[], shop: ShopStock[], inventory: { name: string; count: number }[],
    bank: ReadonlyMap<string, number>, budget: number, stockTarget = 500, maxItems = Infinity): { name: string; amount: number }[] {
    let slots = Math.max(0, 28 - inventory.length);
    let units = Math.max(0, maxItems);
    const choices = targets.flatMap(target => {
        const item = shop.find(i => target.re.test(i.name));
        if (!item || item.count <= 0 || !Number.isFinite(item.buyPrice) || item.buyPrice < 0) return [];
        const held = inventory.filter(i => target.re.test(i.name)).reduce((n, i) => n + i.count, 0);
        const limit = /axe|pickaxe|tinderbox|hammer|chisel|mould|knife|pestle|harpoon|lobster pot/i.test(item.name) ? 2 : stockTarget;
        const desired = Math.max(0, Math.min(item.count, target.buyPerTick, limit - held - (bank.get(item.name.toLowerCase()) ?? 0)));
        return desired > 0 ? [{ ...item, desired, amount: 0, stackable: /arrow|rune|feather|thread|fishing bait/i.test(item.name), held }] : [];
    });
    // One unit of each available type first, then fill remaining capacity round-robin.
    let progress = true;
    while (progress) {
        progress = false;
        for (const c of choices) {
            const slotCost = c.stackable && (c.held > 0 || c.amount > 0) ? 0 : 1;
            if (units <= 0 || c.amount >= c.desired || slots < slotCost || budget < c.buyPrice) continue;
            c.amount++;
            units--;
            budget -= c.buyPrice;
            slots -= slotCost;
            progress = true;
        }
    }
    return choices.filter(c => c.amount > 0).map(c => ({ name: c.name, amount: c.amount }));
}

export function shopTargetsMet(targets: ShopPurchaseTarget[], inventory: { name: string; count: number }[],
    bank: ReadonlyMap<string, number>, stockTarget: number): boolean {
    return targets.length > 0 && targets.every(t => {
        const banked = [...bank].filter(([name]) => t.re.test(name));
        const held = inventory.filter(i => t.re.test(i.name));
        const name = banked[0]?.[0] ?? held[0]?.name ?? '';
        const goal = /axe|pickaxe|tinderbox|hammer|chisel|mould|knife|pestle|harpoon|lobster pot/i.test(name) ? 2 : stockTarget;
        return !!name && banked.reduce((n, [, count]) => n + count, 0) + held.reduce((n, i) => n + i.count, 0) >= goal;
    });
}

export function stockWaitStatus(now: number, since: number | undefined, limit: number) {
    const started = since ?? now;
    const remaining = limit > 0 ? Math.max(0, limit - (now - started)) : Infinity;
    return { since: started, done: remaining === 0, waitTicks: Math.min(15, remaining) };
}

export function shopFinishOk(bought: number, targetMet: boolean, stop: string): boolean {
    // A clean stock-wait is quiescence, not target fulfillment. It must not trigger another login.
    return bought > 0 || targetMet || stop === 'stock-wait';
}

// shop.rs2 clamps stock adjustment at -5000 before applying the sell multiplier.
// SDK buyPrice uses stockDiff=0, so it cannot enforce a reserve when stock is depleted.
export function maximumUnitCost(item: { baseCost: number }, config: { sellMultiplier: number } | undefined): number {
    if (!Number.isSafeInteger(item.baseCost) || item.baseCost <= 0 || !config || !Number.isSafeInteger(config.sellMultiplier) || config.sellMultiplier < 0)
        throw new Error('shop budget: missing validated baseCost or shop sellMultiplier');
    return Math.min(2_000_000_000, Math.max(1, Math.ceil(item.baseCost * (config.sellMultiplier + 5000) / 1000)));
}

export async function buyWithBudget(bot: { buyFromShop(item: RegExp, amount: number): Promise<unknown> },
    sdk: { getInventory(): { name: string; count: number }[]; getState(): { shop?: { shopItems: { name: string; count: number; baseCost: number }[]; shopConfig?: { sellMultiplier: number } } } | null },
    name: string, requested: number, reserve: number, remainingSpend: number): Promise<{ bought: number; spent: number }> {
    const count = (re: RegExp) => sdk.getInventory().filter(i => re.test(i.name)).reduce((n, i) => n + i.count, 0);
    const wallet = count(/^coins$/i), before = count(exactItem(name));
    const shop = sdk.getState()?.shop;
    const item = shop?.shopItems.find(i => i.name.toLowerCase() === name.toLowerCase());
    if (!item || item.count <= 0) return { bought: 0, spent: 0 };
    const unit = maximumUnitCost(item, shop?.shopConfig);
    const amount = Math.max(0, Math.min(requested, item.count, Math.floor(Math.min(wallet - reserve, remainingSpend) / unit)));
    if (amount === 0) return { bought: 0, spent: 0 };
    const re = exactItem(name);
    await bot.buyFromShop(re, amount);
    const spent = Math.max(0, wallet - count(/^coins$/i));
    if (count(/^coins$/i) < reserve || spent > remainingSpend) throw new Error('shop budget violated: observed server cost exceeded reserved maximum');
    return { bought: Math.max(0, count(re) - before), spent };
}

async function main() {
const botName = process.argv[2];
const profileKey = (process.argv[3] ?? process.env.PROFILE ?? 'catherby').toLowerCase();
const CAP = Number(process.argv[4] ?? process.env.CAP ?? 15000);
const BANK_AT = Number(process.argv[5] ?? process.env.BANK_AT ?? 100);
const COIN_RESERVE = Number(process.env.COIN_RESERVE ?? 0);
const MAX_SPEND = Number(process.env.MAX_SPEND ?? Infinity);
const MAX_ITEMS = Number(process.env.MAX_ITEMS ?? Infinity);
const FLOAT = Number(process.env.FLOAT ?? 20000);
const NO_BUY_TICKS = Number(process.env.NO_BUY_TICKS ?? 0);
const guarded = COIN_RESERVE > 0 || Number.isFinite(MAX_SPEND);
for (const [key, value] of Object.entries({ COIN_RESERVE, MAX_SPEND, MAX_ITEMS, FLOAT, NO_BUY_TICKS })) {
    if ((!Number.isSafeInteger(value) && !(value === Infinity && ['MAX_SPEND', 'MAX_ITEMS'].includes(key))) || value < 0)
        throw new Error(`invalid shop budget ${key}`);
}
if (FLOAT <= COIN_RESERVE || MAX_SPEND === 0 || MAX_ITEMS === 0) throw new Error('shop budget needs FLOAT>COIN_RESERVE and positive MAX_SPEND/MAX_ITEMS');

if (!botName || !PROFILES[profileKey]) {
    console.error(`Usage: bun scripts/shop-buyer.ts <botName> <${Object.keys(PROFILES).join(' | ')}> [CAP] [BANK_AT]`);
    process.exit(1);
}

// ITEMS=<regex> keeps only the profile items a run needs (ITEMS='fire rune' buys no other rune).
const itemFilter = process.env.ITEMS ? new RegExp(process.env.ITEMS, 'i') : null;
const conf = itemFilter ? { ...PROFILES[profileKey]!, items: PROFILES[profileKey]!.items.filter(i => itemFilter.test(i.re.source)) } : PROFILES[profileKey]!;
if (!conf.items.length) throw new Error(`ITEMS=${process.env.ITEMS} matches no ${profileKey} item`);
const s = await openBot(botName).catch(e => finish([], false, `login: ${String(e)}`));
try {
    // Wait up to 10 ticks for inventory to sync
    await waitUntil(s, st => (st?.inventory?.length ?? 0) > 0, { timeoutTicks: 10 });

    const pos = () => s.sdk.getState()?.player;
    const coins = () => countItems(s, /^coins$/i);
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    const over = () => used() >= CAP;

    let boughtTotal = 0, bankedTotal = 0, spentTotal = 0, stopReason = 'cap';
    let noBuySince: number | undefined, noBuyTicks = 0;
    let bankTrips = 0;
    let shopTrips = 0;
    let walkTicks = 0;
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const stock = new Map<string, number>();

    const walk = async (x: number, z: number, tol = 2): Promise<boolean> => {
        const a = s.tick();
        // From far away (another town, a boat ride) the world walker plans the trip; walkPath covers the last tiles.
        const p0 = pos();
        if (p0 && Math.max(Math.abs(p0.worldX - x), Math.abs(p0.worldZ - z)) > 60) {
            const r = await goTo(s, await getWorld(), { x, z, level: 0 }, accountOf(s), { legTimeoutTicks: 100 });
            if (!r.ok) console.log(`WALK route fail ${r.reason} ${r.detail}`);
        }
        for (let i = 0; i < 3 && !over(); i++) {
            const p = pos();
            if (p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol) break;
            const r = await walkPath(await sessionWalker(s), [{ x, z, tol }], { stop: over });
            if (!r.ok) {
                console.log(`WALK fail ${r.detail} ticks=${r.ticks}`);
                // The local walk can be refused (a fence, a door the plan does not know): try the world walker.
                const g = await goTo(s, await getWorld(), { x, z, level: 0 }, accountOf(s), { legTimeoutTicks: 100 });
                if (!g.ok) { console.log(`WALK route fail ${g.reason} ${g.detail}`); await waitTicks(s, 1); }
            }
        }
        walkTicks += s.tick() - a;
        const p = pos();
        return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
    };

    const bank = async (loadFloat = true) => {
        if (s.sdk.getState()?.shop?.isOpen) await s.bot.closeInterface();
        await walk(conf.bankSpot.x, conf.bankSpot.z, 2);
        const b = await s.bot.openBank();
        if (!b.success) {
            console.log(`WARN openBank: ${b.message}`);
            await waitTicks(s, 2);
            return;
        }
        const desiredFloat = Math.min(FLOAT, COIN_RESERVE + MAX_SPEND - spentTotal);
        if (loadFloat && (guarded ? coins() < desiredFloat : coins() < 1000) && desiredFloat > coins())
            await s.bot.withdrawItem(/^coins$/i, desiredFloat - coins());
        // Deposit configured products once per ID; keep unrelated tools and working food.
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

    console.log(`START shop-buyer ${botName} profile=${profileKey} coins=${coins()}`);
    // BANK_PACK=1: bank everything but coins first; a pack left full by other jobs leaves no slot to buy into.
    if (process.env.BANK_PACK === '1') {
        await walk(conf.bankSpot.x, conf.bankSpot.z, 2);
        if ((await s.bot.openBank()).success) { await waitTicks(s, 1); await depositPack(s, i => /^coins$/i.test(i.name)); await s.bot.closeInterface(); }
    }
    await bank();

    while (!over() && !ended) {
        if (process.env.STOP_AT_TARGET === '1' && shopTargetsMet(conf.items, s.sdk.getInventory(), stock, Number(process.env.STOCK_TARGET ?? 500))) {
            stopReason = 'stock-target'; break;
        }
        if (NO_BUY_TICKS > 0 && noBuySince !== undefined && stockWaitStatus(s.tick(), noBuySince, NO_BUY_TICKS).done) {
            noBuyTicks = s.tick() - noBuySince;
            stopReason = 'stock-wait'; break;
        }
        if (boughtTotal >= MAX_ITEMS || spentTotal >= MAX_SPEND) { stopReason = boughtTotal >= MAX_ITEMS ? 'item-cap' : 'spend-cap'; break; }
        if (courierWaiting(s.name)) { await bank(); continue; }
        if (coins() <= COIN_RESERVE || (!guarded && coins() < 50)) {
            await bank();
            if (coins() <= COIN_RESERVE || (!guarded && coins() < 50)) {
                if (NO_BUY_TICKS > 0) {
                    // Empty owned funding is already observed. Wait once without bank/shop reopen spam.
                    const since = s.tick();
                    await waitTicks(s, NO_BUY_TICKS);
                    noBuyTicks = s.tick() - since; stopReason = 'stock-wait';
                } else stopReason = 'coin-reserve';
                break;
            }
        }

        const inv = s.sdk.getInventory();
        const nonCoinCount = inv.filter(i => !/^coins$/i.test(i.name)).reduce((sum, i) => sum + i.count, 0);
        if (inv.length >= 27 || (BANK_AT > 0 && nonCoinCount >= BANK_AT)) {
            await bank();
            continue;
        }

        // Walk to shop
        const p = pos();
        if (!p || Math.max(Math.abs(p.worldX - conf.npcSpot.x), Math.abs(p.worldZ - conf.npcSpot.z)) > 3) {
            await walk(conf.npcSpot.x, conf.npcSpot.z, 2);
        }

        if (!s.sdk.getState()?.shop?.isOpen) {
            const shopRes = await s.bot.openShop(conf.npc);
            if (!shopRes.success) {
                console.log(`WARN openShop failed: ${shopRes.message}`);
                await waitTicks(s, 5);
                continue;
            }
            shopTrips++;
        }

        // Buy each configured item that has stock
        const shop = s.sdk.getState()?.shop;
        let boughtInRound = 0;

        if (shop?.isOpen && shop.shopItems) {
            const purchases = planShopPurchases(conf.items, shop.shopItems, s.sdk.getInventory(), stock, Math.max(0, Math.min(coins() - COIN_RESERVE, MAX_SPEND - spentTotal)), Number(process.env.STOCK_TARGET ?? 500), MAX_ITEMS - boughtTotal);
            for (const purchase of purchases) {
                const remaining = Math.min(purchase.amount, MAX_ITEMS - boughtTotal);
                if (remaining <= 0) break;
                let countBought = 0;
                if (guarded) {
                    const result = await buyWithBudget(s.bot, s.sdk, purchase.name, remaining, COIN_RESERVE, MAX_SPEND - spentTotal);
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

        if (boughtInRound === 0) {
            // Refill only when banked coins can unblock an available, still-needed purchase.
            const needed = planShopPurchases(conf.items, s.sdk.getState()?.shop?.shopItems ?? [], s.sdk.getInventory(), stock,
                Number.MAX_SAFE_INTEGER, Number(process.env.STOCK_TARGET ?? 500));
            if ((needed.length && coins() < Math.max(1000, COIN_RESERVE + 1) && (stock.get('coins') ?? 0) > 0)
                || (guarded && needed.length && coins() < Math.min(FLOAT, COIN_RESERVE + MAX_SPEND - spentTotal) && (stock.get('coins') ?? 0) > 0)) {
                const before = coins();
                await bank();
                if (coins() > before) noBuySince = undefined;
                continue;
            }
            if (guarded && needed.length && NO_BUY_TICKS === 0) { stopReason = 'bounded-purchase-unaffordable'; break; }
            const waiting = stockWaitStatus(s.tick(), noBuySince, NO_BUY_TICKS);
            if (NO_BUY_TICKS > 0) noBuySince = waiting.since;
            if (waiting.done) { noBuyTicks = s.tick() - waiting.since; stopReason = 'stock-wait'; break; }
            await waitTicks(s, waiting.waitTicks);
        } else {
            noBuySince = undefined;
            await waitTicks(s, 2);
        }
    }

    if (!ended) await bank(false);
    const targetMet = shopTargetsMet(conf.items, s.sdk.getInventory(), stock, Number(process.env.STOCK_TARGET ?? 500));
    await finish([s], shopFinishOk(boughtTotal, targetMet, stopReason), `ticks=${used()} boughtTotal=${boughtTotal} bankedTotal=${bankedTotal} bankTrips=${bankTrips} shopTrips=${shopTrips} coinsLeft=${coins()} spentTotal=${spentTotal} coinReserve=${COIN_RESERVE} maxSpend=${MAX_SPEND} maxItems=${MAX_ITEMS} stop=${stopReason} targetMet=${targetMet ? 1 : 0} noBuyTicks=${noBuyTicks} noBuyLimit=${NO_BUY_TICKS}`);
} catch (e) {
    await finish([s], false, String(e));
}

}
if (import.meta.main) await main();
