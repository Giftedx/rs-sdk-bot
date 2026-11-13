// Universal Shop Buyer: buys restocked commodities (arrowtips, feathers, runes) and banks locally.
// Usage: bun scripts/shop-buyer.ts <bot> <profile: catherby | sarim | betty> [CAP ticks, default 15000]
// Environment: COIN_RESERVE/MAX_SPEND/MAX_ITEMS bound one run; defaults preserve existing unbounded jobs.
// NO_BUY_TICKS=25 opts into a clean bank-and-offline stop when shelves/budget yield no buys.
// BANK_PACK=1 banks the whole pack first; without it a pack full of items the profile does not bank stops (pack-full).
// STOCK_TARGET (default 500) is how many of each item the account may own, pack plus bank, before it stops buying
// that item; the run stops as stock-target once every item is there. MAX_ITEMS caps the units bought in one run.
// Profile jukat (Zanaris) enters by the Lumbridge swamp shed with a Dramen staff, pays the market doorman one cut
// diamond, leaves by the ladder to Al Kharid, wields the weapon the staff took the place of and banks there. Wait for
// its shelf with NO_BUY_TICKS above the 500-tick restock and STALL_TICKS=0.
// BLIND_BUY=1 is for a shelf that other players empty: each profile item with a `shelf` value gets one buy request
// each tick, whatever count the shelf shows, while the budget, the pack and the stock target allow one more unit.
// The engine adds a restocked unit at the end of a tick (World.ts processCleanup) and runs a buy when it reads the
// packet in the next tick (processClientsIn), so a request already on its way takes the unit one tick before a
// buyer that looks first. Purchases are counted from the pack and the coins, never from the requests.
// DEMO_OK=1 is required for live; funding and route admission are separate gates.
import { openBot, finish, countItems, getWorld, accountOf } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker, goTo } from '../packages/core/src/walk';
import { walkTargetPersist } from './walk-to';
import { bankCargo, courierWaiting, exactItem } from '../packages/core/src/cargo';
import { depositPack } from '../packages/core/src/deposit';
import { knownBanks } from '../packages/core/src/trip';

export const PROFILES: Record<string, {
    npc: RegExp;
    npcSpot: { x: number; z: number; level?: number };
    bankSpot: { x: number; z: number };
    // shelf: the stock count of the item in the shop's .inv. It bounds the unit price (maximumUnitCost).
    items: { re: RegExp; buyPerTick: number; shelf?: number }[];
    // A shop behind a skill door: below this level the run refuses before any walk.
    need?: { skill: string; level: number };
    // Waypoints for a trip from far away, farthest from the shop first. Each keeps one route search inside its budget.
    via?: { x: number; z: number }[];
    // Coins the far trip spends on fares. The run takes its float at the bank it stands at before it leaves.
    fare?: number;
    // A shop in a region with no walk in or out: a door that takes the player in with `wear` worn, a toll door between
    // the region's bank and its shop that takes one `item` for each pass, and beside the shop a ladder whose attendant
    // asks before the player leaves. `outBank` is the bank next to the ladder's top.
    realm?: {
        inside: (p: { worldX: number; worldZ: number }) => boolean;
        wear: RegExp;
        stand: { x: number; z: number };
        door: { id: number; x: number; z: number };
        toll: { id: number; x: number; z: number; stand: { x: number; z: number }; item: RegExp; say: RegExp };
        ladder: { id: number; x: number; z: number; say: RegExp };
        outBank: { x: number; z: number };
    };
}> = {
    // khazardshop: NPC555 at2641,3171, swamp paste1941 stock500/restock20; actual observed price governs buys.
    khazard_paste: {
        npc: /^shop keeper$/i,
        npcSpot: { x: 2641, z: 3171 },
        bankSpot: { x: 2654, z: 3283 },
        items: [{ re: /^swamp paste$/i, buyPerTick: 1 }],
    },
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
    // Dommik's Crafting Store, Al Kharid (dommik.rs2, craftingshop2: chisel 2, ring_mould 4; npc 545 spawn 3322,3194,
    // the tile black-dhide-sets.ts walks to). The ring chain of the mock Haggis run needs a ring mould and a chisel.
    dommik: {
        npc: /^dommik$/i,
        npcSpot: { x: 3320, z: 3194 },
        bankSpot: { x: 3269, z: 3167 }, // Al Kharid bank
        items: [
            { re: /^ring mould$/i, buyPerTick: 1, shelf: 4 },
            { re: /^chisel$/i, buyPerTick: 1, shelf: 2 },
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
    // Arrows for the PK army's Ranged band (scripts/gather-combat.ts TRAIN_SKILL=Ranged, about 5,400 per account 1 -> 99).
    // Lowe's Archery Emporium (varrock.inv, shared): bronze 2,000, iron 1,500, steel 1,000.
    lowe: {
        npc: /^lowe$/i,
        npcSpot: { x: 3232, z: 3423 },
        bankSpot: { x: 3253, z: 3420 }, // Varrock East Bank
        items: [
            { re: /^bronze arrow$/i, buyPerTick: 100 },
            { re: /^iron arrow$/i, buyPerTick: 100 },
            { re: /^steel arrow$/i, buyPerTick: 100 },
        ],
    },
    // Hickton's arrows (catherby.inv): bronze 1,000, iron 800. The catherby profile keeps its arrowtips only.
    catherby_arrows: {
        npc: /^hickton$/i,
        npcSpot: { x: 2821, z: 3444 },
        bankSpot: { x: 2809, z: 3441 },
        items: [
            { re: /^bronze arrow$/i, buyPerTick: 100 },
            { re: /^iron arrow$/i, buyPerTick: 100 },
        ],
    },
    // Dargaud, the Ranging Guild's bow and arrow salesman (game_ranging/configs/ranging.inv ranging_guild_bowshop): every
    // arrow from bronze to rune (bronze 1,000, iron, steel and mithril 500, adamant 450, rune 400 in stock) and willow
    // shortbows, near base price.
    // The guild door needs Ranged 40 (ranging_guild_door.rs2).
    dargaud: {
        npc: /^bow and arrow salesman$/i,
        npcSpot: { x: 2673, z: 3434 },
        bankSpot: { x: 2727, z: 3492 }, // Seers' Village Bank (preset spin_bowstrings_seers)
        items: [
            { re: /^rune arrow$/i, buyPerTick: 100 },
            { re: /^adamant arrow$/i, buyPerTick: 100 },
            { re: /^mithril arrow$/i, buyPerTick: 100 },
            { re: /^steel arrow$/i, buyPerTick: 100 },
            { re: /^iron arrow$/i, buyPerTick: 100 },
            { re: /^bronze arrow$/i, buyPerTick: 100 },
            { re: /^willow shortbow$/i, buyPerTick: 1 },
        ],
    },
    // The Magic Guild store in Yanille (magic_guild.inv magicguildshop), upstairs behind the Magic 66 door
    // (magic_guild.rs2): fire and air runes 3,000, nature runes 1,000 at base 20, law, death and blood runes 1,000, staff of fire 2.
    // From the east the route planner has no foot path past White Wolf Mountain, so a far trip goes by the Port Sarim
    // and Brimhaven boats (30 coins each) through Port Sarim dock and Ardougne dock.
    magic_guild: {
        npc: /^magic store owner$/i,
        npcSpot: { x: 2595, z: 3087, level: 1 },
        bankSpot: { x: 2612, z: 3093 }, // Yanille Bank
        items: [
            { re: /^staff of fire$/i, buyPerTick: 1 },
            { re: /^fire rune$/i, buyPerTick: 100 },
            { re: /^nature rune$/i, buyPerTick: 100 },
            { re: /^air rune$/i, buyPerTick: 100 },
            { re: /^law rune$/i, buyPerTick: 50 },
            { re: /^blood rune$/i, buyPerTick: 100 },
            { re: /^death rune$/i, buyPerTick: 100 },
        ],
        need: { skill: 'Magic', level: 66 },
        via: [{ x: 3028, z: 3221 }, { x: 2683, z: 3271 }],
        fare: 60,
    },
    zaff: {
        // Zaff's staff shop (area_varrock/configs/varrock.inv staffshop and memberstaffshop): staff_of_fire stock 2,
        // 1 back per 1,000 ticks. A fire staff replaces the fire runes of every alchemy cast (scripts/alch-train.ts).
        npc: /^zaff$/i,
        npcSpot: { x: 3203, z: 3433 },
        bankSpot: { x: 3185, z: 3436 }, // Varrock West Bank
        items: [{ re: /^staff of fire$/i, buyPerTick: 1 }],
    },
    // Jakut's dragon sword shop in Zanaris (area_lostcity/configs/lostcity.inv dragonswordshop, shared): dragon_longsword
    // stock 2, 1 back per 500 ticks, base cost 100,000 and shop_delta 10, so the first sword of a full shelf costs
    // 100,000 and each later one 101,000. Jakut spawns at 3252,9572 and the fairy bankers at 3150-3154,9577-9580
    // (maps/m50_149.jm2, m49_149.jm2). The Lumbridge swamp shed door (zanarisdoor, opened from its west side with a
    // Dramen staff worn) moves the player to 3220,9592 (quest_zanaris.rs2). The market that holds Jakut is behind the
    // doormen: the east market door at 3238,9558, opened from its west side, takes one cut diamond (doorman.rs2); from
    // the east it opens free. The ladder beside the attendant at 3253,9590, inside the market, leaves for Al Kharid
    // 3260,3171 after a choice (ladder_fairy.rs2); the shed is the only way in.
    jukat: {
        npc: /^jakut$/i,
        npcSpot: { x: 3252, z: 9572 },
        bankSpot: { x: 3152, z: 9578 },
        items: [{ re: /^dragon longsword$/i, buyPerTick: 2, shelf: 2 }],
        realm: {
            inside: p => p.worldZ > 9000,
            wear: /^dramen staff$/i,
            stand: { x: 3201, z: 3169 },
            door: { id: 2406, x: 3202, z: 3169 },
            toll: { id: 2411, x: 3238, z: 9558, stand: { x: 3237, z: 9558 }, item: /^diamond$/i, say: /^okay/i },
            ladder: { id: 2410, x: 3253, z: 9591, say: /ready to leave/i },
            outBank: { x: 3269, z: 3167 }, // Al Kharid Bank
        },
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

// poll is the ticks between two looks at an empty shelf. A shared shelf that other players also buy from needs 1:
// the unit that comes back goes to the first buyer.
export function stockWaitStatus(now: number, since: number | undefined, limit: number, poll = 15) {
    const started = since ?? now;
    const remaining = limit > 0 ? Math.max(0, limit - (now - started)) : Infinity;
    return { since: started, done: remaining === 0, waitTicks: Math.min(Math.max(1, poll), remaining) };
}

// Ticks from a blind buy request to the pack change it can cause: the request runs in the next engine tick and the
// pack update arrives with that tick's output. A request younger than this may still buy a unit.
export const BLIND_SETTLE_TICKS = 2;

// One more blind buy request this tick? Every request can buy one unit at up to `unit` coins, so the units that the
// coins above the reserve, the spend cap, the item cap, the stock target and the free pack slots allow must exceed
// the requests that are still open. With room for one unit a request goes out every BLIND_SETTLE_TICKS ticks; with
// room for two or more, every tick.
export function blindBuyNow(o: { unit: number; wallet: number; reserve: number; remainingSpend: number; remainingItems: number;
    wanted: number; freeSlots: number; pending: number }): boolean {
    if (!Number.isSafeInteger(o.unit) || o.unit <= 0) return false;
    const room = Math.min(Math.floor(Math.min(o.wallet - o.reserve, o.remainingSpend) / o.unit), o.remainingItems, o.wanted, o.freeSlots);
    return room - o.pending >= 1;
}

// What the pack and the coins show against the last counted state: units that arrived and coins that left. A purchase
// is a higher count with fewer coins; a pack read can miss items for a tick (practice: a count that fell and came back
// with the coins unchanged), so any other change counts nothing. A unit that cost more than `unit`, coins below the
// reserve or a total above the spend cap is a broken bound.
export function blindBuyObserved(base: { coins: number; held: number; unit: number }, now: { coins: number; held: number },
    reserve: number, remainingSpend: number): { bought: number; spent: number } {
    const bought = now.held - base.held, spent = base.coins - now.coins;
    if (bought <= 0 || spent <= 0) return { bought: 0, spent: 0 };
    if (spent > bought * base.unit || now.coins < reserve || spent > remainingSpend)
        throw new Error(`shop budget violated: blind buy took ${spent} coins for ${bought} units, bound ${base.unit} each`);
    return { bought, spent };
}

export function shopFinishOk(bought: number, targetMet: boolean, stop: string): boolean {
    // A clean stock-wait is quiescence, not target fulfillment. It must not trigger another login.
    return bought > 0 || targetMet || stop === 'stock-wait';
}

// shop.rs2 clamps stock adjustment at -5000 before applying the sell multiplier.
// SDK buyPrice uses stockDiff=0, so it cannot enforce a reserve when stock is depleted.
// `shelf` is the item's stock count in the shop's .inv: a unit sells only from a stock of 1 or more, so price_mod is
// at least 1 - shelf and the adjustment at most (shelf - 1) * haggle (shop.rs2 adjusted_item_cost_buying).
export function maximumUnitCost(item: { baseCost: number }, config: { sellMultiplier: number; haggle?: number } | undefined, shelf?: number): number {
    if (!Number.isSafeInteger(item.baseCost) || item.baseCost <= 0 || !config || !Number.isSafeInteger(config.sellMultiplier) || config.sellMultiplier < 0)
        throw new Error('shop budget: missing validated baseCost or shop sellMultiplier');
    const haggle = config.haggle;
    const adjustment = shelf !== undefined && Number.isSafeInteger(shelf) && shelf >= 1 && haggle !== undefined && Number.isSafeInteger(haggle) && haggle >= 0
        ? Math.min(5000, (shelf - 1) * haggle) : 5000;
    return Math.min(2_000_000_000, Math.max(1, Math.ceil(item.baseCost * (config.sellMultiplier + adjustment) / 1000)));
}

// One dialogue click of a doorman's or ladder attendant's talk: the choice that matches `say`, else the continue line.
export function dialogClick(dialog: { isOpen: boolean; isWaiting: boolean; options: { index: number; text: string }[] } | null, say: RegExp): number | null {
    if (!dialog?.isOpen || dialog.isWaiting) return null;
    return dialog.options.find(o => say.test(o.text))?.index ?? 0;
}

// ITEMS=<regex> keeps the profile lines whose pattern source it matches; no filter keeps every line.
export function selectItems<T extends { re: RegExp }>(items: T[], filter: string | undefined): T[] {
    const re = filter ? new RegExp(filter, 'i') : null;
    return re ? items.filter(i => re.test(i.re.source)) : items;
}

// The refusal for a shop behind a skill door, or null when the observed level opens it. An unobserved level refuses.
export function profileRefusal(key: string, conf: { need?: { skill: string; level: number } }, level: number | undefined): string | null {
    if (!conf.need || (level !== undefined && level >= conf.need.level)) return null;
    return `${key.replace(/_/g, ' ')} needs ${conf.need.skill} ${conf.need.level}`;
}

// The waypoints a trip from `from` walks first: only from far away, and only those that bring it nearer to `to`.
export function approachLegs(via: { x: number; z: number }[] | undefined, from: { x: number; z: number }, to: { x: number; z: number }, far = 60) {
    const d = (a: { x: number; z: number }) => Math.max(Math.abs(a.x - to.x), Math.abs(a.z - to.z));
    let left = d(from);
    if (left <= far) return [];
    return (via ?? []).filter(w => d(w) < left && (left = d(w), true));
}

export async function buyWithBudget(bot: { buyFromShop(item: RegExp, amount: number): Promise<unknown> },
    sdk: { getInventory(): { name: string; count: number }[]; getState(): { shop?: { shopItems: { name: string; count: number; baseCost: number }[]; shopConfig?: { sellMultiplier: number; haggle?: number } } } | null },
    name: string, requested: number, reserve: number, remainingSpend: number, shelf?: number): Promise<{ bought: number; spent: number }> {
    const count = (re: RegExp) => sdk.getInventory().filter(i => re.test(i.name)).reduce((n, i) => n + i.count, 0);
    const wallet = count(/^coins$/i), before = count(exactItem(name));
    const shop = sdk.getState()?.shop;
    const item = shop?.shopItems.find(i => i.name.toLowerCase() === name.toLowerCase());
    if (!item || item.count <= 0) return { bought: 0, spent: 0 };
    const unit = maximumUnitCost(item, shop?.shopConfig, shelf);
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
const BLIND_BUY = process.env.BLIND_BUY === '1';
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
const conf = { ...PROFILES[profileKey]!, items: selectItems(PROFILES[profileKey]!.items, process.env.ITEMS) };
if (!conf.items.length) throw new Error(`ITEMS=${process.env.ITEMS} matches no ${profileKey} item`);
const s = await openBot(botName).catch(e => finish([], false, `login: ${String(e)}`));
try {
    // Wait up to 10 ticks for inventory to sync
    await waitUntil(s, st => (st?.inventory?.length ?? 0) > 0, { timeoutTicks: 10 });

    const pos = () => s.sdk.getState()?.player;
    const coins = () => countItems(s, /^coins$/i);
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    // `closing`: the last bank trip runs past the cap, so a run that ends on its cap still banks what it bought
    // (practice: 250 arrows stayed in the pack, "No banker NPC or bank booth found nearby").
    let closing = false;
    const over = () => !closing && used() >= CAP;

    if (conf.need) {
        const skill = conf.need.skill;
        await waitUntil(s, () => s.sdk.getSkill(skill) != null, { timeoutTicks: 10 });
        const level = s.sdk.getSkill(skill)?.level;
        const refused = profileRefusal(profileKey, conf, level);
        if (refused) await finish([s], false, `${refused} (${skill} ${level ?? 'unobserved'}) boughtTotal=0 spentTotal=0 fareTotal=0 stop=refused`);
    }

    let boughtTotal = 0, bankedTotal = 0, spentTotal = 0, fareTotal = 0, stopReason = 'cap';
    let noBuySince: number | undefined, noBuyTicks = 0;
    let bankTrips = 0;
    let shopTrips = 0;
    let walkTicks = 0;
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const stock = new Map<string, number>();
    const stockTarget = Number(process.env.STOCK_TARGET ?? 500);

    // BLIND_BUY: the shelf items that take blind requests, the session ticks of the open requests, and the pack and
    // coins at the last look (null away from the shop, where a bank trip changes both).
    const blindTargets = BLIND_BUY ? conf.items.filter(t => t.shelf !== undefined) : [];
    const planTargets = conf.items.filter(t => !blindTargets.includes(t));
    let blindRequests = 0, blindSent: number[] = [];
    let blindBase: { coins: number; held: number; unit: number } | null = null;
    const blindHeld = () => s.sdk.getInventory().filter(i => blindTargets.some(t => t.re.test(i.name))).reduce((n, i) => n + i.count, 0);
    const blindPending = () => (blindSent = blindSent.filter(t => s.tick() - t < BLIND_SETTLE_TICKS)).length;
    const blindLook = (): number => {
        if (!blindBase) return 0;
        const now = { coins: coins(), held: blindHeld() };
        const seen = blindBuyObserved(blindBase, now, COIN_RESERVE, MAX_SPEND - spentTotal);
        if (seen.bought > 0) blindBase = { ...blindBase, ...now };
        boughtTotal += seen.bought; spentTotal += seen.spent;
        if (seen.bought > 0) console.log(`BOUGHT ${seen.bought}x ${s.sdk.getInventory().find(i => blindTargets.some(t => t.re.test(i.name)))?.name} blind t=${used()} paid=${seen.spent} requests=${blindRequests}`);
        return seen.bought;
    };
    // Before the pack or the coins change for another reason: wait for the open requests, then count.
    const blindSettle = async () => {
        if (!blindBase) return;
        while (blindPending() > 0 && !ended) await waitTicks(s, 1);
        blindLook();
        blindBase = null;
    };

    // level: an upstairs shop (the Magic Guild store is on level 1). The world walker climbs; walkPath stays on one plane.
    const walk = async (x: number, z: number, tol = 2, level = 0): Promise<boolean> => {
        const a = s.tick(), c0 = coins();
        const off = (p: ReturnType<typeof pos>) => !p ? Infinity : p.level !== level ? Infinity : Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z));
        // From far away (another town, a boat ride) or another plane the world walker plans the trip; walkPath covers the last tiles.
        // The planner has no route between Ardougne and Varrock: walkTarget takes the two ferries then, with the fare
        // from the nearest bank (scripts/walk-to.ts ferryWalk).
        const p0 = pos();
        for (const w of p0 && !over() ? approachLegs(conf.via, { x: p0.worldX, z: p0.worldZ }, { x, z }) : []) {
            const r = await goTo(s, await getWorld(), { ...w, level: 0 }, accountOf(s), { legTimeoutTicks: 100 });
            if (!r.ok) console.log(`WALK via ${w.x},${w.z} fail ${r.reason} ${r.detail}`);
        }
        if (p0 && off(pos()) > 60) {
            const r = await walkTargetPersist(s, { x, z, level });
            if (!r.ok) console.log(`WALK route fail ${r.reason} ${r.detail}`);
        }
        for (let i = 0; i < 3 && !over(); i++) {
            const p = pos();
            if (off(p) <= tol) break;
            const r = p?.level === level ? await walkPath(await sessionWalker(s), [{ x, z, tol }], { stop: over }) : { ok: false, detail: `on level ${p?.level}`, ticks: 0 };
            if (!r.ok) {
                console.log(`WALK fail ${r.detail} ticks=${r.ticks}`);
                // The local walk can be refused (a fence, a door the plan does not know): try the world walker.
                const g = await goTo(s, await getWorld(), { x, z, level }, accountOf(s), { legTimeoutTicks: 100 });
                if (!g.ok) { console.log(`WALK route fail ${g.reason} ${g.detail}`); await waitTicks(s, 1); }
            }
        }
        walkTicks += s.tick() - a;
        // A walk buys nothing: any coins it spends are fares.
        fareTotal += Math.max(0, c0 - coins());
        return off(pos()) <= tol;
    };

    const bank = async (loadFloat = true) => {
        await blindSettle();
        if (s.sdk.getState()?.shop?.isOpen) await s.bot.closeInterface();
        const spot = conf.realm && !conf.realm.inside(pos() ?? { worldX: 0, worldZ: 0 }) ? conf.realm.outBank : conf.bankSpot;
        await walk(spot.x, spot.z, 2);
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

    const realm = conf.realm;
    const inRealm = () => { const p = pos(); return !!p && !!realm && realm.inside(p); };
    // The weapon the realm's worn item took the place of (0: none, or the item was worn at the start).
    let ownWeapon = 0;
    const weapon = () => s.sdk.getEquipment().find(i => i.slot === 3)?.id ?? 0;
    // Into the realm: the worn item from the pack, or from the nearest bank, then the door from its stand tile.
    const enterRealm = async () => {
        if (!realm || inRealm()) return;
        const worn = () => (s.sdk.getState()?.equipment ?? []).some(e => realm.wear.test(e.name));
        const held = () => s.sdk.getInventory().find(i => realm.wear.test(i.name));
        if (!worn() && !held()) {
            const p = pos()!;
            const far = (t: { x: number; z: number }) => Math.max(Math.abs(t.x - p.worldX), Math.abs(t.z - p.worldZ));
            const b = knownBanks().filter(t => t.level === 0).sort((m, n) => far(m) - far(n))[0];
            if (b) await walk(b.x, b.z, 2);
            if ((await s.bot.openBank()).success) { await s.bot.withdrawItem(realm.wear, 1); await s.bot.closeInterface(); }
        }
        const item = held();
        if (!worn() && item) { ownWeapon = weapon(); await s.bot.equipItem(item); await waitUntil(s, worn, { timeoutTicks: 5 }); }
        if (!worn()) throw new Error(`realm entry: no ${realm.wear.source} worn, in the pack or in the bank`);
        await walk(realm.stand.x, realm.stand.z, 0);
        for (let i = 0; i < 4 && !inRealm() && !over(); i++) {
            await s.direct({ type: 'interactLoc', x: realm.door.x, z: realm.door.z, locId: realm.door.id, optionIndex: 1, reason: 'SDK' });
            await waitUntil(s, inRealm, { timeoutTicks: 10 });
        }
        if (!inRealm()) throw new Error(`realm entry: the door at ${realm.door.x},${realm.door.z} did not take the player in`);
        console.log(`MILESTONE realm-enter t=${used()}`);
    };
    // Operates a loc and answers the talk it starts until `done`, for at most `limit` ticks.
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
    // Through the toll door to the shop's side: the toll item from the pack, or from the realm's bank.
    const payToll = async (): Promise<boolean> => {
        if (!realm || !inRealm()) return false;
        const toll = realm.toll, has = () => s.sdk.getInventory().some(i => toll.item.test(i.name));
        if (!has()) {
            await walk(conf.bankSpot.x, conf.bankSpot.z, 2);
            if ((await s.bot.openBank()).success) { await s.bot.withdrawItem(toll.item, 1); await s.bot.closeInterface(); }
        }
        if (!has()) throw new Error(`realm toll: no ${toll.item.source} in the pack or in the bank`);
        if (!await walk(toll.stand.x, toll.stand.z, 0)) return false;
        const passed = await talkThrough(toll, toll.say, () => pos()?.worldX === toll.x && pos()?.worldZ === toll.z, 60);
        console.log(`MILESTONE realm-toll t=${used()} passed=${passed ? 1 : 0}`);
        return passed;
    };
    // Out by the ladder, so the account banks and starts its next job where the walker has routes. Outside it wields
    // its own weapon again, so the realm's worn item goes to the bank with the pack and the next job fights with the
    // weapon the account had.
    const leaveRealm = async () => {
        if (!realm || !inRealm()) return;
        if (await walk(realm.ladder.x, realm.ladder.z - 2, 2)) await talkThrough(realm.ladder, realm.ladder.say, () => !inRealm(), 100);
        const own = !inRealm() && ownWeapon ? s.sdk.getInventory().find(i => i.id === ownWeapon) : undefined;
        if (own && (await s.bot.equipItem(own)).success) await waitUntil(s, () => weapon() === ownWeapon, { timeoutTicks: 8 });
        console.log(`MILESTONE realm-leave t=${used()} out=${inRealm() ? 0 : 1} weapon=${weapon()}`);
    };
    const shelfOf = (name: string) => conf.items.find(t => t.re.test(name))?.shelf;

    console.log(`START shop-buyer ${botName} profile=${profileKey} coins=${coins()}`);
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
    // BANK_PACK=1: bank everything but coins first; a pack left full by other jobs leaves no slot to buy into.
    if (process.env.BANK_PACK === '1') {
        await walk(conf.bankSpot.x, conf.bankSpot.z, 2);
        if ((await s.bot.openBank()).success) { await waitTicks(s, 1); await depositPack(s, i => /^coins$/i.test(i.name)); await s.bot.closeInterface(); }
    }
    await bank();

    while (!over() && !ended) {
        if (process.env.STOP_AT_TARGET === '1' && shopTargetsMet(conf.items, s.sdk.getInventory(), stock, stockTarget)) {
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
            // bank() deposits only this profile's items. A pack full of other items stays full, and the loop would bank
            // forever (live and practice: 90-101 bank trips, nothing bought). Stop; BANK_PACK=1 clears the pack first.
            if (s.sdk.getInventory().length >= 27) { console.log('WARN pack full of items this profile does not bank; set BANK_PACK=1'); stopReason = 'pack-full'; break; }
            continue;
        }

        // Walk to shop
        const p = pos();
        if (!p || p.level !== (conf.npcSpot.level ?? 0) || Math.max(Math.abs(p.worldX - conf.npcSpot.x), Math.abs(p.worldZ - conf.npcSpot.z)) > 3) {
            // A walk that the realm's toll door stops: pay, then walk on.
            if (!await walk(conf.npcSpot.x, conf.npcSpot.z, 2, conf.npcSpot.level ?? 0) && realm && !over() && await payToll())
                await walk(conf.npcSpot.x, conf.npcSpot.z, 2, conf.npcSpot.level ?? 0);
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
        let blindWaits = false, blindUnit = 0;

        if (shop?.isOpen && shop.shopItems && blindTargets.length) {
            boughtInRound += blindLook();
            for (const target of blindTargets) {
                const item = shop.shopItems.find(i => target.re.test(i.name));
                if (!item) continue;
                const unit = maximumUnitCost(item, shop.shopConfig, target.shelf);
                blindBase ??= { coins: coins(), held: blindHeld(), unit };
                blindBase.unit = Math.max(blindBase.unit, unit);
                const owned = s.sdk.getInventory().filter(i => target.re.test(i.name)).reduce((n, i) => n + i.count, 0) + (stock.get(item.name.toLowerCase()) ?? 0);
                const wanted = stockTarget - owned;
                if (wanted > 0 && boughtTotal < MAX_ITEMS) { blindWaits = true; blindUnit = Math.max(blindUnit, unit); }
                if (!blindBuyNow({ unit, wallet: coins(), reserve: COIN_RESERVE, remainingSpend: MAX_SPEND - spentTotal, remainingItems: MAX_ITEMS - boughtTotal,
                    wanted, freeSlots: 28 - s.sdk.getInventory().length, pending: blindPending() })) continue;
                const sent = await s.direct({ type: 'shopBuy', slot: item.slot, amount: 1, reason: 'SDK' }) as { success?: boolean } | null;
                if (sent?.success) { blindRequests++; blindSent.push(s.tick()); }
            }
        }

        if (shop?.isOpen && shop.shopItems) {
            const purchases = planShopPurchases(planTargets, shop.shopItems, s.sdk.getInventory(), stock, Math.max(0, Math.min(coins() - COIN_RESERVE, MAX_SPEND - spentTotal)), stockTarget, MAX_ITEMS - boughtTotal);
            // Say why nothing is bought: the shelf as seen, the budget and the free slots.
            if (!purchases.length && !loggedEmpty) { loggedEmpty = true; console.log('SHOP_NONE ' + JSON.stringify({ shelf: shop.shopItems.filter(i => conf.items.some(t => t.re.test(i.name))).map(i => ({ name: i.name, count: i.count, price: i.buyPrice })), coins: coins(), free: 28 - s.sdk.getInventory().length, stockTarget: stockTarget, bank: conf.items.map(t => [...stock].find(([n]) => t.re.test(n))) })); }
            for (const purchase of purchases) {
                const remaining = Math.min(purchase.amount, MAX_ITEMS - boughtTotal);
                if (remaining <= 0) break;
                let countBought = 0;
                if (guarded) {
                    const result = await buyWithBudget(s.bot, s.sdk, purchase.name, remaining, COIN_RESERVE, MAX_SPEND - spentTotal, shelfOf(purchase.name));
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
            const needed = planShopPurchases(planTargets, s.sdk.getState()?.shop?.shopItems ?? [], s.sdk.getInventory(), stock,
                Number.MAX_SAFE_INTEGER, stockTarget);
            if ((needed.length && coins() < Math.max(1000, COIN_RESERVE + 1) && (stock.get('coins') ?? 0) > 0)
                || (guarded && needed.length && coins() < Math.min(FLOAT, COIN_RESERVE + MAX_SPEND - spentTotal) && (stock.get('coins') ?? 0) > 0)) {
                const before = coins();
                await bank();
                if (coins() > before) { noBuySince = undefined; continue; }
                // A trip that added no coins cannot unblock the purchase, so the no-buy limit keeps running.
            }
            if (guarded && needed.length && NO_BUY_TICKS === 0) { stopReason = 'bounded-purchase-unaffordable'; break; }
            // Items with a priced shelf that the wallet cannot pay after the refill above: no wait brings the coins.
            const shelves = s.sdk.getState()?.shop;
            if (guarded && needed.length && needed.every(n => {
                const item = shelves?.shopItems.find(i => i.name === n.name);
                return shelfOf(n.name) !== undefined && !!item && coins() - COIN_RESERVE < maximumUnitCost(item, shelves?.shopConfig, shelfOf(n.name));
            })) { stopReason = 'coin-reserve'; break; }
            // A blind item the coins cannot pay: the bank's coins, else stop. No wait brings the coins.
            if (blindWaits && blindPending() === 0 && Math.min(coins() - COIN_RESERVE, MAX_SPEND - spentTotal) < blindUnit) {
                if (MAX_SPEND - spentTotal < blindUnit) { stopReason = 'spend-cap'; break; }
                const before = coins();
                if ((stock.get('coins') ?? 0) > 0) await bank();
                if (coins() > before) { noBuySince = undefined; continue; }
                stopReason = 'coin-reserve'; break;
            }
            // Every item owned to STOCK_TARGET: say so, rather than wait out NO_BUY_TICKS and report stock-wait with stock on the
            // shelf (live: 500 fire runes bought, 2,533 left, "stock-wait").
            if (shopTargetsMet(conf.items, s.sdk.getInventory(), stock, stockTarget)) { stopReason = 'stock-target'; break; }
            // A blind request goes out each tick, so the loop comes back each tick.
            const waiting = stockWaitStatus(s.tick(), noBuySince, NO_BUY_TICKS, blindWaits ? 1 : Number(process.env.STOCK_POLL_TICKS ?? 15));
            if (NO_BUY_TICKS > 0) noBuySince = waiting.since;
            if (waiting.done) { noBuyTicks = s.tick() - waiting.since; stopReason = 'stock-wait'; break; }
            await waitTicks(s, waiting.waitTicks);
        } else {
            noBuySince = undefined;
            await waitTicks(s, blindWaits ? 1 : 2);
        }
    }

    closing = true;
    if (!ended) await blindSettle();
    // The ladder is on the shop's side of the toll door, so a realm run leaves first and banks at the ladder's top.
    if (!ended) await leaveRealm();
    if (!ended) await bank(false);
    const targetMet = shopTargetsMet(conf.items, s.sdk.getInventory(), stock, stockTarget);
    await finish([s], shopFinishOk(boughtTotal, targetMet, stopReason), `ticks=${used()} boughtTotal=${boughtTotal} bankedTotal=${bankedTotal} bankTrips=${bankTrips} shopTrips=${shopTrips} coinsLeft=${coins()} spentTotal=${spentTotal} coinReserve=${COIN_RESERVE} maxSpend=${MAX_SPEND} maxItems=${MAX_ITEMS} stop=${stopReason} targetMet=${targetMet ? 1 : 0} noBuyTicks=${noBuyTicks} noBuyLimit=${NO_BUY_TICKS} fareTotal=${fareTotal}${BLIND_BUY ? ` blindRequests=${blindRequests}` : ''}`);
} catch (e) {
    await finish([s], false, String(e));
}

}
if (import.meta.main) await main();
