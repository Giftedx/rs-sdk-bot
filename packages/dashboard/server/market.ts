import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildItemExamine, catalogueIconAliases } from '../item-examine';
import { buildItemPrices, expectedLootPrices, itemPrice, priceItemKey, type ItemPrices, type PriceCatalogItem, type PriceIdentity } from '../item-prices';
import { createVaultItems, type VaultItem } from '../vault-items';
import { isLocalServer } from '../../core/src/localserver';
import { marketRows, writeMarketCache, type MarketItem } from '../../core/src/market-cache';
import { gameDialAddress } from '../../core/src/websocket-proxy';
import { BANKER, cached, dashboardDir, DEMO, FILES, liveAccounts, NL, OBJS, root, sourceRoot, type Item } from './config';

// ---------- Grand Exchange prices and item icons ----------
// Icons: export-item-icons.ts renders items.png from the installed game config and models.
// The sheet has 64 32x32 cells per row, indexed by item id; items.json maps lower-case names to ids.
// The live market API ids win over items.json when both know a name.
const itemIds = new Map<string, number>(Object.entries((() => { try { return JSON.parse(readFileSync(join(dashboardDir, 'items.json'), 'utf8')) as Record<string, number>; } catch { return {}; } })()));
const marketIds = new Map<string, number>();
const iconId = (name: string) => marketIds.get(name.toLowerCase()) ?? itemIds.get(name.toLowerCase()) ?? null;
const prices = new Map<string, number>();
const priceCatalogue = cached<PriceCatalogItem[]>(join(root, 'knowledge', 'items.json'), JSON.parse, []);
let itemPrices: ItemPrices = buildItemPrices([], priceCatalogue);
const marketById = new Map<number, { name: string; ask: number | null; bid: number | null; stock: number; vwap: number | null; base: number | null }>();
// Key supplies for the main run: the ids in research/market-2026-10-23.json.
const KEY_SUPPLY_FILE = join(root, 'research', 'market-2026-10-23.json');
const keySupplyIds = () => cached<number[]>(KEY_SUPPLY_FILE, t => Object.values(JSON.parse(t).items ?? {}).map((x: any) => Number(x.id)).filter(n => !isNaN(n)), []);
// Finder loot estimates need prices even when no account currently holds the expected drop.
const npcLootPrices = () => cached<(PriceIdentity | string)[]>(join(dashboardDir, 'client-assets', 'npc-loot.json'), text => expectedLootPrices(JSON.parse(text)), []);
let pricesAt = 0;
async function refreshPrices() {
    try {
        const nextIds = new Map<string, number>(), nextMarket = new Map<number, typeof marketById extends Map<number, infer T> ? T : never>();
        const rows: any[] = [];
        const shared: Record<number, MarketItem> = {};
        // 100 items per page (the API refuses more); about 15 pages.
        for (let offset = 0, total = 1; offset < total; offset += 100) {
            const response = await fetch(gameDialAddress(`${DEMO}/api/market/items?limit=100&offset=${offset}`), { signal: AbortSignal.timeout(15_000) });
            if (!response.ok) throw Error(`Market HTTP ${response.status}`);
            const j = await response.json() as { items: any[]; total: number };
            if (!Number.isSafeInteger(j.total) || j.total < 0 || !Array.isArray(j.items)) throw Error('Invalid market page');
            total = Math.min(j.total ?? 0, 5000);
            Object.assign(shared, marketRows(j.items));
            rows.push(...j.items);
            // The market is thin: one trade set Bread's lastPrice to 1,000,000. Use the 7-day VWAP when the item
            // traded at least 3 times, else the shop base price.
            for (const i of j.items ?? []) {
                if (i.id != null) { nextIds.set(String(i.name).toLowerCase(), Number(i.id)); nextMarket.set(Number(i.id), { name: i.name, ask: i.ask ?? null, bid: i.bid ?? null, stock: i.sellQuantity ?? 0, vwap: i.vwap ?? null, base: i.basePrice ?? null }); }
            }
            await Bun.sleep(500); // 2 requests a second at most
        }
        const nextPrices = buildItemPrices(rows, priceCatalogue);
        marketIds.clear();for (const [key,value] of nextIds) marketIds.set(key,value);
        marketById.clear();for (const [key,value] of nextMarket) marketById.set(key,value);
        itemPrices = nextPrices;
        prices.clear();for (const [key,value] of Object.entries(nextPrices.byName)) if (key !== 'coins') prices.set(key,value.value);
        pricesAt = Date.now();
        try { writeMarketCache(root, shared, pricesAt); } catch { /* Dashboard prices remain available when the cache cannot be written. */ }
    } catch { /* next round */ }
}
const priceOf = (item: PriceIdentity | string) => itemPrice(itemPrices, item)?.value ?? null;
const getItemPrices = () => itemPrices;
const getPricesAt = () => pricesAt;
const itemExamines = buildItemExamine(OBJS);
const icons = catalogueIconAliases(OBJS);

// ---------- vault ----------
// Holdings per account = last snapshot (pack at the status time, bank at bankAt) plus every vault-log transfer
// after that snapshot. The banker's bank snapshot is often older than the deposits, so when no bank snapshot is
// newer than its last logged transfer, the log is its truth: everything received minus everything paid.
type Transfer = { at: number; from: string; to: string; items: Item[] };
const keyName = (n: string) => n.toLowerCase();
function vault(bots: any[], now: number) {
    const log = cached<Transfer[]>(FILES.vault, t => t.split(NL).filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as Transfer]; } catch { return []; } }), []);
    const live = bots.filter(b => !isLocalServer(b.server));
    const byKey = new Map(live.map(b => [keyName(b.name), b]));
    const names = new Set<string>([...live.filter(b => b.at).map(b => keyName(b.name))]);
    for (const t of log) { names.add(keyName(t.from)); names.add(keyName(t.to)); }
    const totals = new Map<string, VaultItem & { holders: Map<string, number> }>();
    const holders = [];
    for (const k of names) {
        const b = byKey.get(k);
        const name = b?.name ?? log.find(t => keyName(t.from) === k)?.from ?? log.find(t => keyName(t.to) === k)?.to ?? k;
        const isBanker = keyName(BANKER) === k;
        const mine = createVaultItems(), add = mine.add;
        const mineLog = log.filter(t => keyName(t.from) === k || keyName(t.to) === k);
        const lastLog = mineLog.reduce((n, t) => Math.max(n, t.at), 0);
        let source: 'snapshot' | 'log' | 'snapshot+log';
        if (isBanker && !(b?.bankAt && b.bankAt > lastLog) && mineLog.length) {
            // Base: the banker's last bank snapshot (what it held before the log, or at bankAt), then every logged
            // flow after that snapshot. Without bankAt the snapshot's time is unknown, so every flow is added.
            add(b?.bank);
            for (const t of mineLog) if (!b?.bankAt || t.at > b.bankAt) add(t.items, keyName(t.to) === k ? 1 : -1);
            source = 'log';
        } else {
            const since = b?.at ?? 0;
            add((b?.inventory ?? []).filter(Boolean));
            add(b?.bank);
            const after = mineLog.filter(t => t.at > since);
            for (const t of after) add(t.items, keyName(t.to) === k ? 1 : -1);
            source = after.length ? 'snapshot+log' : 'snapshot';
        }
        const held = mine.rows();
        let value = 0, unpriced = 0;
        for (const i of held) {
            const key = (i.unconfirmed ? 'unconfirmed:' : '') + priceItemKey(i), t = totals.get(key) ?? { ...i, count: 0, holders: new Map<string,number>() };
            t.count += i.count; t.holders.set(name, i.count); totals.set(key, t);
            const p = i.unconfirmed ? null : priceOf(i);
            if(p == null) unpriced++; else value += p * i.count;
        }
        holders.push({
            name, banker: isBanker, age: b?.at ? now - b.at : null, bankSeen: !!b?.bank || source === 'log', bankAt: b?.bankAt ?? null, source,
            coins: held.filter(i => !i.unconfirmed && priceItemKey(i) === 'id:995').reduce((n,i) => n+i.count,0), value, unpriced, valueComplete: !unpriced && !mine.unconfirmed(), countsComplete: !mine.unconfirmed(),
            items: held.filter(i => i.unconfirmed || priceItemKey(i) !== 'id:995').sort((a, z) => z.count - a.count),
        });
    }
    holders.sort((a, z) => Number(z.banker) - Number(a.banker) || z.value - a.value || a.name.localeCompare(z.name));
    const items = [...totals].filter(([key]) => key !== 'id:995').map(([, t]) => {
        const p = t.unconfirmed ? null : priceOf(t);
        return { ...t, price: p, value: p != null ? p * t.count : null, holders: [...t.holders].sort((a, z) => z[1] - a[1]).map(([n, c]) => ({ name: n, count: c })) };
    }).sort((a, z) => (z.value ?? 0) - (a.value ?? 0) || z.count - a.count || a.name.localeCompare(z.name));
    const coins = totals.get('id:995')?.count ?? 0;
    // Flow: one link per giver -> receiver pair, with coins, value and item counts.
    const links = new Map<string, { from: string; to: string; coins: number; value: number; unpriced: number; items: Map<string, Item>; n: number; last: number }>();
    // The vault log spells some accounts with a capital first letter; use the account's own spelling.
    const accts = liveAccounts(), canon = (n: string) => accts.find(a => a.toLowerCase() === n.toLowerCase()) ?? n;
    for (const t0 of log) {
        const t = { ...t0, from: canon(t0.from), to: canon(t0.to) };
        const k = t.from + '>' + t.to, l = links.get(k) ?? { from: t.from, to: t.to, coins: 0, value: 0, unpriced: 0, items: new Map<string,Item>(), n: 0, last: 0 };
        for (const i of t.items) { const key=priceItemKey(i),held=l.items.get(key)??{...i,count:0};held.count+=i.count;l.items.set(key,held);const p=i.unconfirmed?null:priceOf(i);if(p==null)l.unpriced++;else l.value+=p*i.count;if(key==='id:995'&&!i.unconfirmed)l.coins+=i.count; }
        l.n++; l.last = Math.max(l.last, t.at); links.set(k, l);
    }
    return {
        coins, value: coins + items.reduce((n, i) => n + (i.value ?? 0), 0), unpriced: items.filter(i => i.price == null).length,
        valueComplete: holders.every(h => h.valueComplete), countsComplete: holders.every(h => h.countsComplete),
        items, holders, log: log.slice(-20).reverse(), logExists: existsSync(FILES.vault), banker: BANKER, pricesAt,
        lastTransferAt: log.reduce((n, t) => Math.max(n, t.at), 0) || null,
        flow: [...links.values()].map(l => ({ ...l, valueComplete: !l.unpriced, items: [...l.items.values()].sort((a, z) => z.count - a.count) })),
    };
}

// ---------- gear catalog ----------
let gearCatalogCache: { body: string; tag: string } | null = null;
function gearCatalogResponse(): { body: string; tag: string } {
    if (gearCatalogCache) return gearCatalogCache;
    let body = '[]';
    try {
        const file = join(sourceRoot, 'knowledge', 'gear.json');
        if (existsSync(file)) {
            const raw = JSON.parse(readFileSync(file, 'utf8')) as any[];
            const compact = (Array.isArray(raw) ? raw : [])
                .filter(g => g && Number.isSafeInteger(g.id) && g.id >= 0 && typeof g.name === 'string' && g.name && typeof g.slot === 'string')
                .map(g => ({
                    id: g.id,
                    name: g.name,
                    slot: g.slot,
                    ...(Number.isFinite(g.attackRate) && g.attackRate > 0 ? { attackRate: g.attackRate } : {}),
                    ...(g.bonuses ? { bonuses: g.bonuses } : {}),
                    ...(g.requires ? { requires: { ...(g.requires.skills ? { skills: g.requires.skills } : {}), ...(g.requires.quest ? { quest: g.requires.quest } : {}) } } : {}),
                    ...(g.special ? { special: g.special } : {}),
                    ...(g.staffOnly ? { staffOnly: true } : {}),
                }));
            body = JSON.stringify(compact);
        }
    } catch { body = '[]'; }
    const tag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
    gearCatalogCache = { body, tag };
    return gearCatalogCache;
}

function startMarketRefresh() {
    setInterval(() => void refreshPrices(), 600_000);
    void refreshPrices();
}

export {
    gearCatalogResponse,
    getItemPrices,
    getPricesAt,
    iconId,
    icons,
    itemExamines,
    itemIds,
    keySupplyIds,
    marketById,
    marketIds,
    npcLootPrices,
    priceOf,
    prices,
    refreshPrices,
    startMarketRefresh,
    vault,
};
