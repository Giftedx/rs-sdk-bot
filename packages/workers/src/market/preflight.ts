import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BankSellerPolicy, BuyListRequest, GEPricePlan, GETripRequest, ItemRequest, SaleRequest, ShopProfile } from './types';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');

export const GE_VARROCK_BANK = { x: 3185, z: 3436 };

export const orderQuantity = (r: ItemRequest) => r.quantity ?? 1;
export const orderEscrow = (r: ItemRequest) => orderQuantity(r) * r.limit;

export function validateRequest(r: ItemRequest) {
    if (r.rescueMode !== undefined && r.rescueMode !== 'npc-respawn-once') throw Error('unsupported RESCUE_MODE');
    if (!/^[a-z0-9]{1,12}$/i.test(r.actor) || !r.server || !/^[a-z0-9_-]{1,64}$/i.test(r.goal)
        || ![r.item, r.limit].every(n => Number.isSafeInteger(n) && n > 0 && n <= 2147483647)
        || (r.quantity !== undefined && !(Number.isSafeInteger(r.quantity) && r.quantity > 0))
        || (r.expectedOwned !== undefined && !(Number.isSafeInteger(r.expectedOwned) && r.expectedOwned >= 0 && r.expectedOwned <= 2147483647))
        || orderEscrow(r) > 2147483647 || !Number.isSafeInteger(r.reserve) || r.reserve < 0
        || ![r.createdAt, r.reviewAt, r.deadline].every(n => Number.isSafeInteger(n) && n > 0)
        || r.reviewAt < r.createdAt || r.deadline <= r.reviewAt) {
        throw Error('invalid item order request');
    }
}

export function orderPaths(server: string, actor: string, goal: string) {
    const base = resolve(REPO_ROOT, '.practice/market-orders', createHash('sha256').update(server).digest('hex').slice(0, 12));
    return { base, lock: base + '/' + actor.toLowerCase() + '.lock', journal: base + '/' + actor.toLowerCase() + '-' + goal + '.json' };
}

type CatalogueEntry = { id: number; name: string; tradeable?: boolean; members?: boolean; cost?: number; debugname?: string; baseId?: number };

let cachedGeItemCatalogue: readonly CatalogueEntry[] | undefined;
let cachedCatalogueNameById: ReadonlyMap<number, string> | undefined;
let cachedTradeableIds: ReadonlySet<number> | undefined;

export function getGeItemCatalogue(): readonly CatalogueEntry[] {
    return (cachedGeItemCatalogue ??= JSON.parse(readFileSync(new URL('../../../../knowledge/items.json', import.meta.url), 'utf8')) as CatalogueEntry[]);
}

export function loadGeItemCatalogue(): { id: number; name: string }[] {
    return getGeItemCatalogue().slice();
}

export function getGeCatalogueNameById(): ReadonlyMap<number, string> {
    if (!cachedCatalogueNameById) {
        const rows = getGeItemCatalogue();
        const m = new Map<number, string>();
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i]!;
            m.set(row.id, row.name);
        }
        cachedCatalogueNameById = m;
    }
    return cachedCatalogueNameById;
}

function getTradeableItemIds(): ReadonlySet<number> {
    if (!cachedTradeableIds) {
        const rows = getGeItemCatalogue();
        const ids = new Set<number>();
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i]!;
            if (row.tradeable === true) ids.add(row.id);
        }
        cachedTradeableIds = ids;
    }
    return cachedTradeableIds;
}

export function validateSale(r: SaleRequest) {
    if (!/^[a-z0-9]{1,12}$/i.test(r.actor) || !r.server || !/^[a-z0-9_-]{1,64}$/i.test(r.goal)
        || ![r.item, r.quantity, r.price, r.floor, r.deadline].every(n => Number.isSafeInteger(n) && n > 0)
        || !Number.isSafeInteger(r.reserveItems) || r.reserveItems < 0 || r.price < r.floor
        || r.price * r.quantity > 2147483647 || r.item === 995) {
        throw Error('invalid finite sale request');
    }
}

const positive = (n: number) => Number.isSafeInteger(n) && n > 0 && n <= 2147483647;
const whole = (v: number, min = 0, max = 2147483647) => Number.isSafeInteger(v) && v >= min && v <= max;

export function percentagePrice(base: number, percent: number) {
    if (!positive(base) || (percent !== 5 && percent !== 10 && percent !== 50 && percent !== 99)) {
        throw Error('unsupported native buy percentage/base');
    }
    let price = base;
    if (percent === 99) return Math.min(2147483647, base + Math.max(1, Number((BigInt(base) * 99n) / 100n)));
    for (let i = 0; i < percent / 5; i++) price = Math.min(2147483647, price + Math.max(1, Math.floor(price / 20)));
    return price;
}

export function validateBuyList(r: BuyListRequest, catalogue?: readonly { id: number; tradeable?: boolean }[]) {
    if (!r || !Array.isArray(r.entries) || !r.entries.length || r.entries.length > 32
        || !positive(r.budget)
        || !Number.isSafeInteger(r.reserve) || r.reserve < 0 || !Number.isSafeInteger(r.cap) || r.cap < 1000 || r.cap > 100000
        || !Number.isSafeInteger(r.fillWait) || r.fillWait < 0 || r.fillWait > 200
        || !Number.isSafeInteger(r.createdAt) || !Number.isSafeInteger(r.deadline) || r.createdAt <= 0 || r.deadline <= r.createdAt) {
        throw Error('invalid finite buy-list budget');
    }
    const seenItems = new Set<number>();
    for (let i = 0; i < r.entries.length; i++) {
        const item = r.entries[i]!.item;
        if (seenItems.has(item)) throw Error('invalid finite buy-list budget');
        seenItems.add(item);
    }
    let tradeableSet: ReadonlySet<number>;
    if (catalogue) {
        const s = new Set<number>();
        for (let i = 0; i < catalogue.length; i++) {
            const c = catalogue[i]!;
            if (c.tradeable === true) s.add(c.id);
        }
        tradeableSet = s;
    } else {
        tradeableSet = getTradeableItemIds();
    }
    let exposure = 0;
    for (let i = 0; i < r.entries.length; i++) {
        const e = r.entries[i]!;
        const pct = positive(e.basePrice) ? percentagePrice(e.basePrice, e.percent) : -1;
        if (!positive(e.quantity) || !positive(e.unitCap) || pct > e.unitCap || !tradeableSet.has(e.item) || e.item === 995) {
            throw Error('native item/percentage exceeds explicit unit cap');
        }
        exposure += e.quantity * pct;
    }
    if (!Number.isSafeInteger(exposure) || exposure > r.budget || r.budget + r.reserve > 2147483647) {
        throw Error('buy list exceeds explicit owned budget');
    }
    validateRequest({
        actor: r.actor,
        server: r.server,
        goal: r.goal,
        item: r.entries[0]!.item,
        quantity: 1,
        limit: 1,
        reserve: r.reserve,
        createdAt: r.createdAt,
        reviewAt: r.createdAt,
        deadline: r.deadline,
    });
    if (r.goal.length > 52) throw Error('buy-list key must leave room for child identity');
}

export function validateGETrip(r: GETripRequest) {
    validateSale({
        actor: r.actor,
        server: r.server,
        goal: r.goal,
        item: r.item,
        quantity: r.quantity,
        price: r.price,
        floor: r.floor,
        reserveItems: 0,
        deadline: r.deadline,
    });
    if (!Number.isSafeInteger(r.reserve) || r.reserve < 0 || !Number.isSafeInteger(r.fillWait) || r.fillWait < 0 || r.fillWait > 200
        || !Number.isSafeInteger(r.cap) || r.cap < 500 || r.cap > 100000 || r.quantity > 24) {
        throw Error('invalid finite bank GE lot');
    }
}

export function validateGEPlan(r: GEPricePlan) {
    if (!r || !Array.isArray(r.prices) || r.prices.length < 1 || r.prices.length > 8 || !/^[a-z0-9_-]{1,40}$/i.test(r.goal)
        || !Number.isSafeInteger(r.cap) || r.cap < 600 || r.cap > 100000) {
        throw Error('invalid finite explicit GE plan');
    }
    for (let i = 0; i < r.prices.length; i++) {
        const p = r.prices[i]!;
        validateGETrip({ ...r, goal: r.goal + '-p0', price: p.price, fillWait: p.fillWait });
    }
}

export function validateBankSeller(r: BankSellerPolicy) {
    if (!r || r.allTradeable !== true || !Array.isArray(r.protect)
        || !r.reserves
        || !whole(r.maxItems, 1, 32) || !whole(r.maxUnits, 1, 768) || !whole(r.perItem, 1, 24)
        || (r.discount !== 0 && r.discount !== 5 && r.discount !== 10 && r.discount !== 50)
        || !whole(r.floor, 1) || !whole(r.unitCap, r.floor)
        || !whole(r.childCap, 600, 100000) || !whole(r.cap, r.childCap + 200, 100000)
        || !whole(r.fillWait, 0, 200) || !whole(r.deadline, 1, Number.MAX_SAFE_INTEGER) || !/^[a-z0-9_-]{1,20}$/i.test(r.goal)) {
        throw Error('invalid finite bank-wide sale policy');
    }
    for (let i = 0; i < r.protect.length; i++) {
        if (!whole(r.protect[i]!)) throw Error('invalid finite bank-wide sale policy');
    }
    for (const id in r.reserves) {
        if (!Object.prototype.hasOwnProperty.call(r.reserves, id)) continue;
        if (!/^\d+$/.test(id) || !whole(r.reserves[id]!)) throw Error('invalid finite bank-wide sale policy');
    }
    if (r.liquidation !== undefined
        && (!r.liquidation || r.floor !== 1 || !whole(r.liquidation.waitTicks, 150, 200)
            || !whole(r.liquidation.fillWait, 0, 200) || r.childCap < 1500)) {
        throw Error('liquidation requires declared floor1,150..200tick wait and bounded recovery budget');
    }
    validateGEPlan({
        actor: r.actor,
        server: r.server,
        goal: r.goal + '-0',
        item: 1511,
        quantity: 1,
        reserve: 0,
        floor: r.floor,
        deadline: r.deadline,
        cap: r.childCap,
        prices: [{ price: r.floor, fillWait: r.fillWait }],
    });
}

export const inZanarisRealm = (p: { worldX: number; worldZ: number }): boolean =>
    p.worldX >= 3130 && p.worldX <= 3270 && p.worldZ >= 9530 && p.worldZ <= 9600;

export const PROFILES: Record<string, ShopProfile> = {
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
        bankSpot: { x: 3092, z: 3243 },
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
        bankSpot: { x: 3092, z: 3243 },
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
    harry: {
        npc: /^harry$/i,
        npcSpot: { x: 2834, z: 3445 },
        bankSpot: { x: 2809, z: 3441 },
        items: [{ re: /^lobster pot$/i, buyPerTick: 1 }],
    },
    harry_bait: {
        npc: /^harry$/i,
        npcSpot: { x: 2834, z: 3445 },
        bankSpot: { x: 2809, z: 3441 },
        items: [{ re: /^fishing bait$/i, buyPerTick: 50, shelf: 1200 }],
    },
    taverley: {
        npc: /^jatix$/i,
        npcSpot: { x: 2908, z: 3443 },
        bankSpot: { x: 2934, z: 3376 },
        items: [
            { re: /eye of newt/i, buyPerTick: 50 },
            { re: /vial of water/i, buyPerTick: 50 },
            { re: /^vial$/i, buyPerTick: 50 },
            { re: /pestle and mortar/i, buyPerTick: 1 },
        ],
    },
    dommik: {
        npc: /^dommik$/i,
        npcSpot: { x: 3320, z: 3194 },
        bankSpot: { x: 3269, z: 3167 },
        items: [
            { re: /^ring mould$/i, buyPerTick: 1, shelf: 4 },
            { re: /^chisel$/i, buyPerTick: 1, shelf: 2 },
            { re: /^sickle mould$/i, buyPerTick: 1, shelf: 6 },
        ],
    },
    silver_merchant: {
        npc: /^silver merchant$/i,
        npcSpot: { x: 2659, z: 3316 },
        bankSpot: { x: 2654, z: 3283 },
        items: [{ re: /^silver bar$/i, buyPerTick: 1, shelf: 1 }, { re: /^silver ore$/i, buyPerTick: 1, shelf: 1 }],
    },
    dommik_moulds: {
        npc: /^dommik$/i,
        npcSpot: { x: 3320, z: 3194 },
        bankSpot: { x: 3269, z: 3167 },
        items: [
            { re: /^necklace mould$/i, buyPerTick: 1, shelf: 2 },
            { re: /^amulet mould$/i, buyPerTick: 1, shelf: 2 },
        ],
    },
    general_sarim: {
        npc: /^shopkeeper$/i,
        npcSpot: { x: 3014, z: 3205 },
        bankSpot: { x: 3092, z: 3243 },
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
        bankSpot: { x: 3253, z: 3420 },
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
    lowe: {
        npc: /^lowe$/i,
        npcSpot: { x: 3232, z: 3423 },
        bankSpot: { x: 3253, z: 3420 },
        items: [
            { re: /^bronze arrow$/i, buyPerTick: 100 },
            { re: /^iron arrow$/i, buyPerTick: 100 },
            { re: /^steel arrow$/i, buyPerTick: 100 },
        ],
    },
    catherby_arrows: {
        npc: /^hickton$/i,
        npcSpot: { x: 2821, z: 3444 },
        bankSpot: { x: 2809, z: 3441 },
        items: [
            { re: /^bronze arrow$/i, buyPerTick: 100 },
            { re: /^iron arrow$/i, buyPerTick: 100 },
        ],
    },
    dargaud: {
        npc: /^bow and arrow salesman$/i,
        npcSpot: { x: 2673, z: 3434 },
        bankSpot: { x: 2727, z: 3492 },
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
    magic_guild: {
        npc: /^magic store owner$/i,
        npcSpot: { x: 2595, z: 3087, level: 1 },
        bankSpot: { x: 2612, z: 3093 },
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
    jiminua: {
        npc: /^jiminua$/i,
        npcSpot: { x: 2767, z: 3122 },
        bankSpot: { x: 2654, z: 3283 },
        items: [
            { re: /^antipoison\(3\)$/i, buyPerTick: 1, shelf: 10 },
            { re: /^tinderbox$/i, buyPerTick: 1 }, { re: /^cooked meat$/i, buyPerTick: 1 }, { re: /^bread$/i, buyPerTick: 1 },
            { re: /^pestle and mortar$/i, buyPerTick: 1 }, { re: /^knife$/i, buyPerTick: 1 }, { re: /^hammer$/i, buyPerTick: 1 },
            { re: /^chisel$/i, buyPerTick: 1 }, { re: /^bronze axe$/i, buyPerTick: 1 }, { re: /^bronze pickaxe$/i, buyPerTick: 1 },
            { re: /^bronze bar$/i, buyPerTick: 1 },
            { re: /^papyrus$/i, buyPerTick: 10 },
            { re: /^charcoal$/i, buyPerTick: 10 },
        ],
        fare: 60,
    },
    zaff: {
        npc: /^zaff$/i,
        npcSpot: { x: 3203, z: 3433 },
        bankSpot: { x: 3185, z: 3436 },
        items: [{ re: /^staff of fire$/i, buyPerTick: 1 }],
    },
    jukat: {
        npc: /^jakut$/i,
        npcSpot: { x: 3252, z: 9572 },
        bankSpot: { x: 3152, z: 9578 },
        items: [{ re: /^dragon longsword$/i, buyPerTick: 2, shelf: 2 }],
        realm: {
            inside: inZanarisRealm,
            wear: /^dramen staff$/i,
            stand: { x: 3201, z: 3169 },
            door: { id: 2406, x: 3202, z: 3169 },
            toll: { id: 2411, x: 3238, z: 9558, stand: { x: 3237, z: 9558 }, item: /^diamond$/i, say: /^okay/i },
            ladder: { id: 2410, x: 3253, z: 9591, say: /ready to leave/i },
            outBank: { x: 3269, z: 3167 },
        },
    },
    scavvo: {
        npc: /^scavvo$/i,
        npcSpot: { x: 3191, z: 3351, level: 1 },
        bankSpot: { x: 3185, z: 3436 },
        items: [
            { re: /^rune platelegs$/i, buyPerTick: 1 },
            { re: /^rune chainbody$/i, buyPerTick: 1 },
            { re: /^rune plateskirt$/i, buyPerTick: 1 },
        ],
    },
    thessalia: {
        npc: /^thessalia$/i,
        npcSpot: { x: 3204, z: 3417 },
        bankSpot: { x: 3253, z: 3420 },
        items: [{ re: /^leather gloves$/i, buyPerTick: 1 }],
    },
    thessalia_gown: {
        npc: /^thessalia$/i,
        npcSpot: { x: 3204, z: 3417 },
        bankSpot: { x: 3253, z: 3420 },
        items: [{ re: /^priest gown$/i, buyPerTick: 1 }],
    },
    baker: {
        npc: /^baker$/i,
        npcSpot: { x: 2654, z: 3311 },
        bankSpot: { x: 2654, z: 3283 },
        items: [
            { re: /^cake$/i, buyPerTick: 1, shelf: 3 },
            { re: /^bread$/i, buyPerTick: 5, shelf: 10 },
            { re: /^chocolate slice$/i, buyPerTick: 5, shelf: 8 },
        ],
    },
    wydin: {
        npc: /^wydin$/i,
        npcSpot: { x: 3014, z: 3204 },
        bankSpot: { x: 3092, z: 3243 },
        items: [{ re: /^cheese$/i, buyPerTick: 1 }],
    },
    wydin_choc: {
        npc: /^wydin$/i,
        npcSpot: { x: 3014, z: 3204 },
        bankSpot: { x: 3092, z: 3243 },
        items: [
            { re: /^chocolate bar$/i, buyPerTick: 5 },
            { re: /^cheese$/i, buyPerTick: 1 },
        ],
    },
    zeke: {
        npc: /^zeke$/i,
        npcSpot: { x: 3288, z: 3190 },
        bankSpot: { x: 3269, z: 3167 },
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
        bankSpot: { x: 3013, z: 3355 },
        items: [
            { re: /rune pickaxe/i, buyPerTick: 1 },
            { re: /adamant pickaxe/i, buyPerTick: 1 },
            { re: /mithril pickaxe/i, buyPerTick: 1 },
            { re: /steel pickaxe/i, buyPerTick: 1 },
            { re: /iron pickaxe/i, buyPerTick: 1 },
            { re: /bronze pickaxe/i, buyPerTick: 1 },
        ],
    },
    alfonse: {
        npc: /^alfonse the waiter$/i,
        npcSpot: { x: 2793, z: 3188 },
        bankSpot: { x: 2654, z: 3283 },
        items: [
            { re: /^cooked karambwan$/i, buyPerTick: 1, shelf: 3 },
            { re: /^swordfish$/i, buyPerTick: 1, shelf: 2 },
            { re: /^lobster$/i, buyPerTick: 1, shelf: 3 },
        ],
        fare: 60,
    },
    tiadeche: {
        npc: /^tiadeche$/i,
        npcSpot: { x: 2781, z: 3057 },
        bankSpot: { x: 2654, z: 3283 },
        items: [
            { re: /^raw karambwan$/i, buyPerTick: 5, shelf: 10 },
            { re: /^karambwan vessel$/i, buyPerTick: 1, shelf: 2 },
        ],
        fare: 60,
        door: {
            id: 779,
            x: 2782,
            z: 3057,
            outside: { x: 2783, z: 3057 },
            insideStand: { x: 2782, z: 3057 },
            inside: p => p.worldX >= 2779 && p.worldX <= 2782 && p.worldZ >= 3056 && p.worldZ <= 3059,
        },
        dialogOpen: /^yes\.?$/i,
    },
    oziach: {
        npc: /^oziach$/i,
        npcSpot: { x: 3069, z: 3517 },
        bankSpot: { x: 3094, z: 3491 },
        items: [
            { re: /^rune platebody$/i, buyPerTick: 1, shelf: 2 },
            { re: /^dragonhide body$/i, buyPerTick: 1, shelf: 2 },
        ],
        dialogOpen: /^can i buy a rune plate mail body/i,
    },
    gem_trader: {
        npc: /^gem trader$/i,
        npcSpot: { x: 3288, z: 3212 },
        bankSpot: { x: 3269, z: 3167 },
        items: [
            { re: /^uncut sapphire$/i, buyPerTick: 1, shelf: 1 },
            { re: /^sapphire$/i, buyPerTick: 1, shelf: 1 },
            { re: /^uncut emerald$/i, buyPerTick: 1, shelf: 1 },
            { re: /^emerald$/i, buyPerTick: 1, shelf: 1 },
        ],
    },
    herquin: {
        npc: /^herquin$/i,
        npcSpot: { x: 2944, z: 3334 },
        bankSpot: { x: 2946, z: 3368 },
        items: [
            { re: /^uncut sapphire$/i, buyPerTick: 1, shelf: 1 },
            { re: /^sapphire$/i, buyPerTick: 1, shelf: 1 },
        ],
    },
    tenzing: {
        npc: /^tenzing$/i,
        npcSpot: { x: 2820, z: 3556 },
        bankSpot: { x: 2946, z: 3368 },
        items: [{ re: /^climbing boots$/i, buyPerTick: 1 }],
        door: {
            id: 3745,
            x: 2822,
            z: 3555,
            outside: { x: 2823, z: 3555 },
            inside: p => p.worldX <= 2822,
        },
        dialogBuy: {
            choices: [/can i buy some climbing boots/i, /ok,\s*sounds good/i],
            cost: 12,
            item: /^climbing boots$/i,
        },
    },
    jukat_dagger: {
        npc: /^jakut$/i,
        npcSpot: { x: 3252, z: 9572 },
        bankSpot: { x: 3152, z: 9578 },
        items: [{ re: /^dragon dagger$/i, buyPerTick: 2, shelf: 2 }],
        realm: {
            inside: inZanarisRealm,
            wear: /^dramen staff$/i,
            stand: { x: 3201, z: 3169 },
            door: { id: 2406, x: 3202, z: 3169 },
            toll: { id: 2411, x: 3238, z: 9558, stand: { x: 3237, z: 9558 }, item: /^diamond$/i, say: /^okay/i },
            ladder: { id: 2410, x: 3253, z: 9591, say: /ready to leave/i },
            outBank: { x: 3269, z: 3167 },
        },
    },
    siegfried: {
        npc: /^siegfried erkle$/i,
        npcSpot: { x: 2725, z: 3381, level: 2 },
        bankSpot: { x: 2654, z: 3283 },
        items: [
            { re: /^cape of legends$/i, buyPerTick: 1, shelf: 3 },
            { re: /^shield right half$/i, buyPerTick: 1, shelf: 1 },
        ],
        door: {
            id: 2391,
            x: 2728,
            z: 3349,
            outside: { x: 2728, z: 3348 },
            insideStand: { x: 2728, z: 3350 },
            inside: p => (p.level ?? 0) > 0 || p.worldZ >= 3350,
        },
    },
    bob: {
        npc: /^bob$/i,
        npcSpot: { x: 3231, z: 3203 },
        bankSpot: { x: 3092, z: 3243 },
        items: [
            { re: /^steel axe$/i, buyPerTick: 1, shelf: 3 },
            { re: /^iron axe$/i, buyPerTick: 1, shelf: 5 },
            { re: /^bronze axe$/i, buyPerTick: 1, shelf: 10 },
            { re: /^bronze pickaxe$/i, buyPerTick: 1, shelf: 5 },
        ],
    },
    helemos: {
        npc: /^helemos$/i,
        npcSpot: { x: 2894, z: 3510, level: 1 },
        bankSpot: { x: 2946, z: 3368 },
        items: [
            { re: /^dragon battleaxe$/i, buyPerTick: 1, shelf: 2 },
            { re: /^dragon mace$/i, buyPerTick: 1, shelf: 1 },
        ],
        door: {
            id: 2624,
            x: 2902,
            z: 3510,
            outside: { x: 2903, z: 3510 },
            insideStand: { x: 2901, z: 3510 },
            inside: p => (p.level ?? 0) > 0 || p.worldX <= 2901,
        },
    },
    magic_guild_elemental: {
        npc: /^magic store owner$/i,
        npcSpot: { x: 2595, z: 3087, level: 1 },
        bankSpot: { x: 2612, z: 3093 },
        items: [
            { re: /^water rune$/i, buyPerTick: 100 },
            { re: /^earth rune$/i, buyPerTick: 100 },
            { re: /^chaos rune$/i, buyPerTick: 100 },
        ],
        need: { skill: 'Magic', level: 66 },
        via: [{ x: 3028, z: 3221 }, { x: 2683, z: 3271 }],
        fare: 60,
    },
    skulgrimen: {
        npc: /^skulgrimen$/i,
        npcSpot: { x: 2663, z: 3694 },
        bankSpot: { x: 2727, z: 3492 },
        items: [
            { re: /^berserker helm$/i, buyPerTick: 1, shelf: 5 },
            { re: /^warrior helm$/i, buyPerTick: 1, shelf: 5 },
            { re: /^archer helm$/i, buyPerTick: 1, shelf: 5 },
            { re: /^farseer helm$/i, buyPerTick: 1, shelf: 5 },
        ],
    },
    shantay: {
        npc: /^shantay$/i,
        npcSpot: { x: 3304, z: 3123 },
        bankSpot: { x: 3269, z: 3167 },
        items: [
            { re: /^waterskin\(4\)$/i, buyPerTick: 10 },
            { re: /^bronze bar$/i, buyPerTick: 5 },
            { re: /^feather$/i, buyPerTick: 50 },
            { re: /^knife$/i, buyPerTick: 1 },
            { re: /^hammer$/i, buyPerTick: 1 },
            { re: /^shantay pass$/i, buyPerTick: 10 },
        ],
    },
    horvik: {
        npc: /^horvik$/i,
        npcSpot: { x: 3229, z: 3438 },
        bankSpot: { x: 3253, z: 3420 },
        items: [{ re: /^black platebody$/i, buyPerTick: 1 }],
    },
    louie: {
        npc: /^louie legs$/i,
        npcSpot: { x: 3316, z: 3175 },
        bankSpot: { x: 3269, z: 3167 },
        items: [
            { re: /^black platelegs$/i, buyPerTick: 1 },
            { re: /^adamant platelegs$/i, buyPerTick: 1 },
            { re: /^mithril platelegs$/i, buyPerTick: 1 },
            { re: /^steel platelegs$/i, buyPerTick: 1 },
            { re: /^iron platelegs$/i, buyPerTick: 1 },
        ],
    },
    valaine: {
        npc: /^valaine$/i,
        npcSpot: { x: 3193, z: 3361, level: 1 },
        bankSpot: { x: 3185, z: 3436 },
        items: [
            { re: /^black full helm$/i, buyPerTick: 1 },
            { re: /^black platelegs$/i, buyPerTick: 1 },
            { re: /^adamant platebody$/i, buyPerTick: 1 },
            { re: /^blue cape$/i, buyPerTick: 1 },
        ],
    },
};

export const SWORD = 1287;
export const SWORD_PROFILES: Record<number, { cost: number; stock: number; limit: number }> = {
    1287: { cost: 2080, stock: 2, limit: 2500 },
    1301: { cost: 3200, stock: 1, limit: 4000 },
};

export function selectItems<T extends { re: RegExp }>(items: T[], filter: string | undefined): T[] {
    const re = filter ? new RegExp(filter, 'i') : null;
    return re ? items.filter(i => re.test(i.re.source)) : items;
}

export function profileRefusal(key: string, conf: { need?: { skill: string; level: number } }, level: number | undefined): string | null {
    if (!conf.need || (level !== undefined && level >= conf.need.level)) return null;
    return `${key.replace(/_/g, ' ')} needs ${conf.need.skill} ${conf.need.level}`;
}

export function resolveShopProfile(profileKey: string): ShopProfile | undefined {
    const key = profileKey.toLowerCase();
    const direct = PROFILES[key];
    if (direct) return direct;
    const { dataProfile, derivedProfile } = require('./shop-profiles') as typeof import('./shop-profiles');
    return dataProfile(key) ?? derivedProfile(key);
}
