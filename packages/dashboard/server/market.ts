import { existsSync, readFileSync, statSync } from 'node:fs';
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
    const logLen = log.length, logLast = logLen ? log[logLen - 1] : undefined;
    const cacheHost = vault as unknown as {
        _logCache?: { log: Transfer[]; len: number; last: Transfer | undefined; logByAccount: Map<string, Transfer[]>; logSpellings: Map<string, string>; lastLogAt: Map<string, number>; overallLastTransfer: number; recentLog: Transfer[] };
        _flowCache?: { log: Transfer[]; len: number; last: Transfer | undefined; pricesAt: number; priceOf: unknown; accounts: string[]; flow: any[] };
    };
    let idx = cacheHost._logCache;
    if (!idx || idx.log !== log || idx.len !== logLen || idx.last !== logLast) {
        const logByAccount = new Map<string, Transfer[]>();
        const logSpellings = new Map<string, string>();
        const lastLogAt = new Map<string, number>();
        let overallLastTransfer = 0;
        for (let i = 0; i < logLen; i++) {
            const t = log[i]!;
            const fk = keyName(t.from), tk = keyName(t.to);
            if (!logSpellings.has(fk)) logSpellings.set(fk, t.from);
            if (!logSpellings.has(tk)) logSpellings.set(tk, t.to);
            let fl = logByAccount.get(fk); if (!fl) { fl = []; logByAccount.set(fk, fl); } fl.push(t);
            if (tk !== fk) { let tl = logByAccount.get(tk); if (!tl) { tl = []; logByAccount.set(tk, tl); } tl.push(t); }
            lastLogAt.set(fk, Math.max(lastLogAt.get(fk) ?? 0, t.at));
            lastLogAt.set(tk, Math.max(lastLogAt.get(tk) ?? 0, t.at));
            if (t.at > overallLastTransfer) overallLastTransfer = t.at;
        }
        idx = { log, len: logLen, last: logLast, logByAccount, logSpellings, lastLogAt, overallLastTransfer, recentLog: log.slice(-20).reverse() };
        cacheHost._logCache = idx;
    }
    const { logByAccount, logSpellings, lastLogAt, overallLastTransfer, recentLog } = idx;
    const byKey = new Map<string, any>();
    const names = new Set<string>(logSpellings.keys());
    for (let i = 0; i < bots.length; i++) {
        const b = bots[i];
        if (isLocalServer(b.server)) continue;
        const k = keyName(b.name);
        byKey.set(k, b);
        if (b.at) names.add(k);
    }
    const totals = new Map<string, VaultItem & { holders: Map<string, number> }>();
    const holders = [];
    const bankerKey = keyName(BANKER);
    for (const k of names) {
        const b = byKey.get(k);
        const name = b?.name ?? logSpellings.get(k) ?? k;
        const isBanker = bankerKey === k;
        const mine = createVaultItems(), add = mine.add;
        const mineLog = logByAccount.get(k) ?? [];
        const lastLog = lastLogAt.get(k) ?? 0;
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
            let hadAfter = false;
            for (const t of mineLog) if (t.at > since) { add(t.items, keyName(t.to) === k ? 1 : -1); hadAfter = true; }
            source = hadAfter ? 'snapshot+log' : 'snapshot';
        }
        const held = mine.rows();
        const mineUnconfirmed = mine.unconfirmed();
        let value = 0, unpriced = 0, holderCoins = 0;
        const nonCoins: VaultItem[] = [];
        for (let hi = 0; hi < held.length; hi++) {
            const it = held[hi]!;
            const pKey = priceItemKey(it);
            const key = (it.unconfirmed ? 'unconfirmed:' : '') + pKey;
            let t = totals.get(key);
            if (!t) { t = { ...it, count: 0, holders: new Map<string, number>() }; totals.set(key, t); }
            t.count += it.count; t.holders.set(name, it.count);
            const p = it.unconfirmed ? null : priceOf(it);
            if (p == null) unpriced++; else value += p * it.count;
            if (!it.unconfirmed && pKey === 'id:995') holderCoins += it.count;
            else nonCoins.push(it);
        }
        nonCoins.sort((a, z) => z.count - a.count);
        holders.push({
            name, banker: isBanker, age: b?.at ? now - b.at : null, bankSeen: !!b?.bank || source === 'log', bankAt: b?.bankAt ?? null, source,
            coins: holderCoins, value, unpriced, valueComplete: !unpriced && !mineUnconfirmed, countsComplete: !mineUnconfirmed,
            items: nonCoins,
        });
    }
    holders.sort((a, z) => Number(z.banker) - Number(a.banker) || z.value - a.value || a.name.localeCompare(z.name));
    const items = [];
    let itemValueSum = 0, unpricedItems = 0;
    for (const [key, t] of totals) {
        if (key === 'id:995') continue;
        const p = t.unconfirmed ? null : priceOf(t);
        const val = p != null ? p * t.count : null;
        if (val != null) itemValueSum += val; else unpricedItems++;
        items.push({ ...t, price: p, value: val, holders: [...t.holders].sort((a, z) => z[1] - a[1]).map(([n, c]) => ({ name: n, count: c })) });
    }
    items.sort((a, z) => (z.value ?? 0) - (a.value ?? 0) || z.count - a.count || a.name.localeCompare(z.name));
    const coins = totals.get('id:995')?.count ?? 0;
    // Flow: one link per giver -> receiver pair, with coins, value and item counts.
    const accounts = liveAccounts();
    const fc = cacheHost._flowCache;
    let flow: any[];
    if (fc && fc.log === log && fc.len === logLen && fc.last === logLast && fc.pricesAt === pricesAt && fc.priceOf === priceOf
        && fc.accounts.length === accounts.length && fc.accounts.every((a, i) => a === accounts[i])) {
        flow = fc.flow;
    } else {
        const links = new Map<string, { from: string; to: string; coins: number; value: number; unpriced: number; items: Map<string, Item>; n: number; last: number }>();
        // The vault log spells some accounts with a capital first letter; use the account's own spelling.
        const canonByLower = new Map(accounts.map(a => [a.toLowerCase(), a]));
        const canon = (n: string) => canonByLower.get(n.toLowerCase()) ?? n;
        for (let ti = 0; ti < logLen; ti++) {
            const t0 = log[ti]!;
            const from = canon(t0.from), to = canon(t0.to);
            const k = from + '>' + to;
            let l = links.get(k);
            if (!l) { l = { from, to, coins: 0, value: 0, unpriced: 0, items: new Map<string, Item>(), n: 0, last: 0 }; links.set(k, l); }
            for (let ii = 0; ii < t0.items.length; ii++) {
                const it = t0.items[ii]!;
                const key = priceItemKey(it);
                let held = l.items.get(key);
                if (!held) { held = { ...it, count: 0 }; l.items.set(key, held); }
                held.count += it.count;
                const p = it.unconfirmed ? null : priceOf(it);
                if (p == null) l.unpriced++; else l.value += p * it.count;
                if (key === 'id:995' && !it.unconfirmed) l.coins += it.count;
            }
            l.n++;
            if (t0.at > l.last) l.last = t0.at;
        }
        flow = [...links.values()].map(l => ({ ...l, valueComplete: !l.unpriced, items: [...l.items.values()].sort((a, z) => z.count - a.count) }));
        cacheHost._flowCache = { log, len: logLen, last: logLast, pricesAt, priceOf, accounts: [...accounts], flow };
    }
    return {
        coins, value: coins + itemValueSum, unpriced: unpricedItems,
        valueComplete: holders.every(h => h.valueComplete), countsComplete: holders.every(h => h.countsComplete),
        items, holders, log: recentLog, logExists: existsSync(FILES.vault), banker: BANKER, pricesAt,
        lastTransferAt: overallLastTransfer || null,
        flow,
    };
}

// ---------- gear catalog ----------
let gearCatalogCache: { mtimeMs: number; size: number; body: string; tag: string } | null = null;
function gearCatalogResponse(): { body: string; tag: string } {
    const file = join(sourceRoot, 'knowledge', 'gear.json');
    let st: { mtimeMs: number; size: number } | null = null;
    try { st = statSync(file); } catch { st = null; }
    if (!st) {
        const body = '[]';
        const tag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
        gearCatalogCache = null;
        return { body, tag };
    }
    if (gearCatalogCache && Date.now() - st.mtimeMs > 1000 && gearCatalogCache.mtimeMs === st.mtimeMs && gearCatalogCache.size === st.size) {
        return { body: gearCatalogCache.body, tag: gearCatalogCache.tag };
    }
    let body = '[]';
    try {
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
    } catch { body = '[]'; }
    const tag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
    gearCatalogCache = { mtimeMs: st.mtimeMs, size: st.size, body, tag };
    return { body, tag };
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
