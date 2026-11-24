import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateBankRouteJob, type BankProfile, type BankRouteJob } from '../../../core/src/bank-trip';
import type { Session } from '../../../core/src/inprocess';
import { componentId } from '../../../core/src/logout';
import { waitUntil } from '../../../core/src/ticks';
import { listConfigFiles, parseConfigs, type ConfigBlock } from '../../../knowledge/src/config';
import { contentRoot } from '../../../knowledge/src/paths';
import { runMarketBankProfile } from './bank-runner';
import type { ShopContract, ShopSaleOptions, ShopTripJob } from './types';
import { watchProductionLife } from './walk';

export type { ShopContract, ShopSaleOptions, ShopTripJob };

const KNOWLEDGE_NPCS = resolve(import.meta.dir, '../../../../knowledge/npcs.json');

function parsePackMaps(text: string): { byName: Map<string, number>; byId: Map<number, string> } {
    const byName = new Map<string, number>();
    const byId = new Map<number, string>();
    let pos = 0;
    while (pos < text.length) {
        let end = text.indexOf('\n', pos);
        if (end < 0) end = text.length;
        const lineEnd = end > pos && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
        const eq = text.indexOf('=', pos);
        if (eq > pos && eq < lineEnd) {
            const id = Number(text.slice(pos, eq));
            if (Number.isInteger(id) && id >= 0) {
                const name = text.slice(eq + 1, lineEnd);
                byName.set(name, id);
                if (!byId.has(id)) byId.set(id, name);
            }
        }
        pos = end + 1;
    }
    return { byName, byId };
}

function nativeData() {
    const root = contentRoot();
    const configs = (ext: string) => listConfigFiles(ext).flatMap(file => parseConfigs(readFileSync(join(root, file), 'utf8'), file));
    const blocks = (ext: string) => new Map(configs(ext).map(v => [v.name, v]));
    const npcPack = parsePackMaps(readFileSync(join(root, 'pack', 'npc.pack'), 'utf8')).byName;
    const objPacks = parsePackMaps(readFileSync(join(root, 'pack', 'obj.pack'), 'utf8'));
    const spawnRows = JSON.parse(readFileSync(KNOWLEDGE_NPCS, 'utf8')) as {
        id: number;
        debugname: string;
        spawns: { x: number; z: number; level: number }[];
    }[];
    const spawnsByKey = new Map<string, { x: number; z: number; level: number }[]>();
    for (let i = 0; i < spawnRows.length; i++) {
        const row = spawnRows[i]!;
        const k = `${row.id}:${row.debugname}`;
        if (!spawnsByKey.has(k)) spawnsByKey.set(k, row.spawns);
    }
    const opnpc3Handlers = new Map<string, string>();
    let hasDefaultShopKeeper = false;
    for (const file of listConfigFiles('.rs2')) {
        const text = readFileSync(join(root, file), 'utf8');
        if (!text.includes('[opnpc3,')) continue;
        if (!hasDefaultShopKeeper && text.includes('[opnpc3,_shop_keeper] ~openshop_activenpc;')) {
            hasDefaultShopKeeper = true;
        }
        for (const m of text.matchAll(/\[opnpc3,\s*([a-z0-9_]+)\s*\]([^]*?)(?=\n\[|$)/g)) {
            const npcName = m[1]!;
            if (!opnpc3Handlers.has(npcName)) opnpc3Handlers.set(npcName, m[2]!);
        }
    }
    return {
        npcs: blocks('.npc'),
        invs: blocks('.inv'),
        npcPack,
        objPack: objPacks.byName,
        objNameById: objPacks.byId,
        spawnsByKey,
        opnpc3Handlers,
        hasDefaultShopKeeper,
    };
}

let data: ReturnType<typeof nativeData> | undefined;
const native = () => (data ??= nativeData());
const param = (b: ConfigBlock, key: string) => b.props.param?.find(v => v.startsWith(key + ','))?.slice(key.length + 1);

export function validateShopSale(o: ShopSaleOptions) {
    if (![o.item, o.quantity, o.minimumUnit, o.reserve, o.cap].every(Number.isSafeInteger)
        || o.item < 1 || o.item === 995 || o.quantity < 1 || o.quantity > 1000
        || o.minimumUnit < 1 || o.minimumUnit > 2147483647 || o.reserve < 0 || o.cap < 1 || o.cap > 100000
        || !o.shopTitle || o.shopTitle.length > 100) {
        throw Error('invalid finite merchant sale');
    }
    return o;
}

export function shopSaleEffect(item: number, quote: number, b: Record<number, number>, a: Record<number, number>) {
    const ids = new Set([...Object.keys(b), ...Object.keys(a)].map(Number));
    return [...ids].every(id => (a[id] ?? 0) - (b[id] ?? 0) === (id === item ? -1 : id === 995 ? quote : 0));
}

export async function observeMerchantQuote(s: Session, item: { id: number; slot: number; name: string }, stop: () => boolean, ticks: number) {
    const state = () => s.sdk.getState();
    const cursor = Math.max(-1, ...(state()?.gameMessages ?? []).map(m => m.observationId ?? m.tick));
    const quote = () => {
        const message = (state()?.gameMessages ?? []).find(
            m => m.type === 0 && (m.observationId ?? m.tick) > cursor && m.text.startsWith(item.name + ': shop will buy for '),
        );
        const match = message?.text.match(/: shop will buy for (\d+)gp\.$/);
        return match ? Number(match[1]) : undefined;
    };
    if (stop()) throw Error('merchant quote stopped');
    if (!(await s.sdk.sendClickComponentWithOption(componentId('shop_template_side:inv'), 1, item.slot)).success) {
        throw Error('merchant native Value refused');
    }
    if (!await waitUntil(s, () => stop() || quote() !== undefined, { timeoutTicks: ticks }) || stop() || !Number.isSafeInteger(quote())) {
        throw Error('fresh native merchant Value missing');
    }
    return quote()!;
}

export async function runShopSale(s: Session, o: ShopSaleOptions) {
    validateShopSale(o);
    const life = watchProductionLife(s, o.stop);
    const start = s.tick();
    const state = () => s.sdk.getState();
    const counts = () => {
        const r: Record<number, number> = {};
        for (const i of s.sdk.getInventory()) r[i.id] = (r[i.id] ?? 0) + i.count;
        return r;
    };
    const over = () => life.stopped() || s.tick() - start >= o.cap;
    const initial = counts();
    if ((initial[o.item] ?? 0) - o.quantity < o.reserve) throw Error('sale quantity would spend reserved stock');
    let sold = 0;
    let coins = 0;
    let failure = '';
    let stop = 'target';
    try {
        while (sold < o.quantity && !over()) {
            const shop = state()?.shop;
            if (!shop?.isOpen || shop.title !== o.shopTitle) throw Error('exact staged shop is not open');
            const item = shop.playerItems.find(i => i.id === o.item);
            if (!item) {
                stop = 'reserve';
                break;
            }
            const quote = await observeMerchantQuote(s, item, over, Math.min(10, Math.max(1, o.cap - (s.tick() - start))));
            if (quote < o.minimumUnit) {
                stop = 'price floor';
                break;
            }
            const before = counts();
            if ((before[o.item] ?? 0) <= o.reserve) {
                stop = 'reserve';
                break;
            }
            const result = await s.bot.sellToShop(item, 1);
            await waitUntil(
                s,
                () => over() || ((counts()[o.item] ?? 0) === (before[o.item] ?? 0) - 1 && (counts()[995] ?? 0) === (before[995] ?? 0) + quote!),
                { timeoutTicks: Math.min(10, Math.max(1, o.cap - (s.tick() - start))) },
            );
            if (result.amountSold !== 1 || !shopSaleEffect(o.item, quote!, before, counts())) {
                throw Error('merchant exact item debit/coin credit missing');
            }
            sold++;
            coins += quote!;
            console.log('MERCHANT_SALE ' + JSON.stringify({ item: o.item, sold, unitPrice: quote, coins, tick: s.tick() }));
        }
        if (sold !== o.quantity && stop === 'target') stop = life.reason() || 'cap';
    } catch (e) {
        failure = String(e);
        stop = 'failure';
    } finally {
        try {
            if (!life.stopped()) {
                await s.bot.closeShop();
                if (!await waitUntil(s, () => !state()?.shop.isOpen, { timeoutTicks: 8 })) throw Error('merchant shop close missing');
            }
        } catch (e) {
            failure += '; ' + String(e);
        }
    }
    const final = counts();
    const ids = new Set([...Object.keys(initial), ...Object.keys(final)].map(Number));
    const conserved = [...ids].every(id => (final[id] ?? 0) - (initial[id] ?? 0) === (id === o.item ? -sold : id === 995 ? coins : 0));
    return {
        ok: !failure && !life.stopped() && sold === o.quantity && conserved,
        stop,
        failure,
        item: o.item,
        requested: o.quantity,
        sold,
        coins,
        reserve: o.reserve,
        remaining: final[o.item] ?? 0,
        conserved,
        ticks: s.tick() - start,
    };
}

export function nativeMerchant(
    key: string,
    bank?: BankRouteJob['bank'],
    site?: BankRouteJob['site'],
    declared?: ShopContract,
    members?: boolean,
) {
    if (typeof key !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(key)) throw Error('invalid native merchant name');
    const d = native();
    const name = key === 'alkharid-general' ? 'generalshopkeeper3' : key;
    const b = d.npcs.get(name);
    const npc = d.npcPack.get(name);
    let inventory = b && param(b, 'owned_shop');
    let title = b && param(b, 'shop_title');
    let contractSource = 'native-params';
    if (!b || npc === undefined || !Object.entries(b.props).some(([k, v]) => /^op[1-5]$/.test(k) && v[0] === 'Trade')) {
        throw Error('merchant lacks native Trade option');
    }
    const handler = d.opnpc3Handlers.get(name);
    if (declared) {
        if (!bank || !site || typeof members !== 'boolean' || typeof declared.title !== 'string' || !declared.title.trim()
            || declared.title.length > 100 || !declared.inventory || !d.invs.has(declared.inventory)) {
            throw Error('custom merchant needs explicit native shop, route and member scope');
        }
        const calls = [...(handler ?? '').matchAll(/~openshop\(\s*(\w+)\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*"([^"]+)"\s*\)/g)].map(
            m => ({ inventory: m[1]!, title: m[2]! }),
        );
        if (calls.length) {
            const candidates = /if\s*\(\s*map_members\s*=\s*\^true\s*\)/.test(handler!) && calls.length === 2
                ? [calls[members ? 0 : 1]!]
                : calls;
            if (!candidates.some(v => v.inventory === declared.inventory && v.title === declared.title)) {
                throw Error('declared shop conflicts with native handler/member branch');
            }
            contractSource = 'native-handler';
        } else if (inventory && title) {
            if (inventory !== declared.inventory || title !== declared.title) throw Error('declared shop conflicts with native NPC params');
        } else {
            contractSource = 'caller-declared';
        }
        inventory = declared.inventory;
        title = declared.title;
    } else {
        if (!b.props.category?.includes('shop_keeper') || b.props.op3?.[0] !== 'Trade' || handler
            || !d.hasDefaultShopKeeper) {
            throw Error('custom native merchant requires a declared shop contract');
        }
        for (const pKey of ['shop_buy_multiplier', 'shop_sell_multiplier', 'shop_delta']) {
            if (!/^\d+$/.test(param(b, pKey) ?? '')) throw Error('native merchant price contract missing');
        }
    }
    if (!inventory || !title || !d.invs.has(inventory)) throw Error('native shop contract absent');
    const convenience = name === 'generalshopkeeper3';
    bank ??= convenience ? { x: 3269, z: 3167, level: 0 } : undefined;
    site ??= convenience ? { x: 3314, z: 3180, level: 0 } : undefined;
    if (!bank || !site) throw Error('merchant requires explicit bank and site');
    const spawn = d.spawnsByKey
        .get(`${npc}:${name}`)
        ?.some(p => p.level === site!.level && Math.max(Math.abs(p.x - site!.x), Math.abs(p.z - site!.z)) <= 8);
    if (!spawn) throw Error('merchant site has no matching native spawn within eight tiles');
    return {
        npc,
        title,
        inventory,
        bank,
        site,
        contractSource,
        inventoryObserved: false,
        alkharidSilkBan: ['generalshopkeeper3', 'generalassistant3'].includes(name),
    };
}

export function validateShopTrip(j: ShopTripJob) {
    const merchant = nativeMerchant(j.merchant, j.bank, j.site, j.shop, j.members);
    validateBankRouteJob({ ...j, family: 'merchant', recipe: String(j.item), ...merchant });
    if (!Number.isSafeInteger(j.item) || j.item < 1) throw Error('invalid native merchant item');
    const d = native();
    const name = d.objNameById.get(j.item);
    const inv = d.invs.get(merchant.inventory)!;
    if (j.item === 995 || !name || name.startsWith('cert_') || (merchant.alkharidSilkBan && name === 'silk')
        || !Number.isSafeInteger(j.minimumUnit) || j.minimumUnit < 1 || j.minimumUnit > 2147483647 || j.batch > 1000) {
        throw Error('invalid native merchant surplus');
    }
    if (inv.props.allstock?.[0] !== 'yes'
        && !Object.entries(inv.props).some(([k, values]) => /^stock\d+$/.test(k) && values.some(v => v.split(',')[0] === name))) {
        throw Error('native merchant does not accept this item');
    }
    return merchant;
}

export function shopTripProfile(s: Session, j: ShopTripJob): BankProfile {
    const merchant = validateShopTrip(j);
    if (j.shop && (s.client as { membersAccount?: number } | undefined)?.membersAccount !== (j.members ? 1 : 0)) {
        throw Error('custom merchant member connection disagrees with declared scope');
    }
    return {
        bank: merchant.bank,
        site: merchant.site,
        inputs: { [j.item]: 1 },
        outputs: [995],
        capacityOutputs: { 995: 1 },
        tools: [],
        run: async (n, cap, stop) => {
            const start = s.tick();
            if (stop()) throw Error('merchant stopped before shop entry');
            await s.sdk.sendCloseModal();
            const npc = s.sdk.getState()?.nearbyNpcs.find(v => v.id === merchant.npc && v.reachable !== false);
            if (!npc) throw Error('exact native merchant unobserved');
            const opened = await s.bot.openShop(npc);
            if (!opened.success || !await waitUntil(s, () => stop() || !!s.sdk.getState()?.shop.isOpen, { timeoutTicks: Math.min(12, cap) })) {
                throw Error('native merchant shop unavailable');
            }
            if (stop()) throw Error('merchant stopped after shop entry');
            if (s.sdk.getState()?.shop.title !== merchant.title) throw Error('native merchant title mismatch');
            const remaining = cap - (s.tick() - start);
            if (remaining < 1) throw Error('merchant entry budget exhausted');
            const result = await runShopSale(s, { item: j.item, quantity: n, minimumUnit: j.minimumUnit, reserve: 0, shopTitle: merchant.title, cap: remaining, stop });
            if (!result.ok) throw Error('merchant sale ' + JSON.stringify(result));
            return result.sold;
        },
    };
}

export async function runShopTrip(s: Session, j: ShopTripJob, stop: () => boolean = () => false) {
    const p = shopTripProfile(s, j);
    const merchant = validateShopTrip(j);
    const result = await runMarketBankProfile(s, { ...j, family: 'merchant', recipe: String(j.item) }, p, stop);
    return {
        ...result,
        merchant: {
            npc: merchant.npc,
            title: merchant.title,
            inventory: merchant.inventory,
            contractSource: merchant.contractSource,
            inventoryObserved: false,
        },
    };
}

export function shopTripStop(account: string, stopped = false, exists: (p: string) => boolean = existsSync) {
    return stopped || [`.practice/stop-${account}`, '.practice/stop-all', '.practice/stop-microbot-shop-trip'].some(exists);
}
