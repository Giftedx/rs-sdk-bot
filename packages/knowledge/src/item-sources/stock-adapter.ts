import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { knowledgeDir } from '../paths';
import {
    PACK_SLOTS,
    TRADE_TICKS,
    cost,
    json,
    oldest,
    r3,
    repoRoot,
    type GeSource,
    type Market,
    type OwnedAccountStock,
    type OwnedSource,
    type OwnedStatusRow,
    type OwnedStock,
    type SharedMarketParser,
} from './model';

interface OwnedItemRow { id?: number; baseId?: number; count?: number }

export function readMarket(file: string, parseSharedQuotes?: SharedMarketParser): Market {
    const raw = json(file);
    // Shown relative to the checkout that holds it, so the output does not name this machine's folders.
    const norm = file.replace(/\\/g, '/'), cut = norm.search(/\/(\.practice|research)\//);
    const rel = cut >= 0 ? norm.slice(cut + 1) : norm;
    if (raw.items && Number.isSafeInteger(raw.at) && raw.at > 0) {
        if (!parseSharedQuotes) throw Error('shared market cache requires a quote parser; use tools/item-sources.ts');
        const quotes = parseSharedQuotes(raw, raw.at), prices: Market['prices'] = {};
        const items = json(join(knowledgeDir(), 'items.json')) as { id: number; debugname: string }[];
        for (const item of items) if (quotes[item.id]) {
            const q = quotes[item.id]!;
            prices[item.debugname] = { ask: q.ask, bid: q.bid, sell: q.sell };
        }
        return { at: new Date(raw.at).toISOString(), file: rel, prices };
    }
    if (raw.items && raw.takenAt) {
        const prices: Market['prices'] = {};
        for (const [k, v] of Object.entries<any>(raw.items)) prices[k] = { ask: v.market?.ask ?? null, bid: v.market?.bid ?? null, sell: v.market?.sellQuantity ?? 0 };
        return { at: raw.takenAt, file: rel, prices };
    }
    const prices: Market['prices'] = {};
    let at = 0;
    for (const [k, v] of Object.entries<any>(raw)) { prices[k] = { ask: v.ask ?? null, bid: v.bid ?? null, sell: v.sell ?? 0, at: new Date(v.at ?? 0).toISOString() }; at = Math.max(at, v.at ?? 0); }
    return { at: new Date(at).toISOString(), file: rel, prices };
}

// Prefer the newest observation of each item; preserve that quote's source and age when combining caches.
export function defaultMarket(practice: string, research = join(repoRoot, 'research'), now = Date.now(), parseSharedQuotes?: SharedMarketParser): Market | null {
    const historical = existsSync(research) ? readdirSync(research).filter(f => /^market-.*\.json$/.test(f)).sort().pop() : undefined;
    const shared = join(practice, 'market-all.json'), files = [join(practice, 'coordinator/market-prices.json'), ...(historical ? [join(research, historical)] : [])];
    if (parseSharedQuotes) {
        try { if (Object.keys(parseSharedQuotes(json(shared), now)).length) files.push(shared); } catch { /* no shared cache */ }
    }
    let newest: Market | null = null;
    const prices: Market['prices'] = {};
    for (const file of files) {
        let market: Market;
        try { market = readMarket(file, parseSharedQuotes); } catch { continue; }
        const at = Date.parse(market.at);
        if (!Number.isFinite(at) || at > now) continue;
        if (!newest || at > Date.parse(newest.at)) newest = market;
        for (const [name, quote] of Object.entries(market.prices)) {
            const quoteAt = quote.at ?? market.at, time = Date.parse(quoteAt);
            if (!Number.isFinite(time) || time > now || (prices[name]?.at && Date.parse(prices[name]!.at!) >= time)) continue;
            prices[name] = { ...quote, at: quoteAt, file: market.file };
        }
    }
    return newest ? { ...newest, prices } : null;
}

// Aggregate already-resolved account status rows into per-account item counts and oldest contributing timestamps, so a
// heartbeat or report run cannot make an undated bank look recent.
export function ownedStockFromRows(rows: readonly OwnedStatusRow[], now = Date.now()): OwnedStock {
    const dated = (at: unknown, limit = now): string | null => typeof at === 'number' && Number.isFinite(at) && at > 0 && at <= limit ? new Date(at).toISOString() : null;
    const accounts: OwnedAccountStock[] = rows.filter(s => s.name.toLowerCase() !== 'haggis').map(s => {
        const items = new Map<number, number>(), itemAt = new Map<number, string | null>();
        const at = dated(s.at), bankAt = at === null ? null : dated(s.bankAt, s.at as number);
        for (const [containers, observedAt] of [[s.inventory, at], [s.equipment, at], [s.bank, bankAt]] as const) {
            for (const r of Array.isArray(containers) ? containers as OwnedItemRow[] : []) {
                const id = r?.baseId ?? r?.id;
                if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || typeof r?.count !== 'number' || !Number.isSafeInteger(r.count) || r.count <= 0) continue;
                itemAt.set(id, items.has(id) ? oldest([itemAt.get(id) ?? null, observedAt]) : observedAt);
                items.set(id, (items.get(id) ?? 0) + r.count);
            }
        }
        return { name: s.name, side: s.side, items, itemAt };
    });
    return { at: oldest(accounts.flatMap(a => [...a.itemAt.values()])), accounts };
}

export function geSource(item: string, tradeable: boolean | undefined, market: Market | null | undefined): GeSource | null {
    if (!market || !tradeable) return null;
    const m = market.prices[item];
    return {
        kind: 'ge', at: m?.at ?? market.at, ask: m?.ask ?? null, bid: m?.bid ?? null, sellers: m?.sell ?? 0, src: m?.file ?? market.file, gate: null,
        blocked: (m?.sell ?? 0) > 0 ? null : `0 sellers in the snapshot of ${m?.at ?? market.at}`,
        cost: cost({
            ticksNote: 'GE trip not measured', coinsPerUnit: m?.ask ?? null, coinsBasis: m?.ask ? 'measured' : 'unknown', coinsNote: m?.ask ? `lowest ask in the snapshot; ${m.sell} for sale` : 'no ask',
            risk: 0, riskBasis: 'content', riskNote: 'no combat', realNote: 'the wait for new sellers is not modelled',
        }),
    };
}

export function ownedSource(item: string, id: number | undefined, owned: OwnedStock | null | undefined, stackable: ReadonlySet<string>): OwnedSource | null {
    if (!owned || id === undefined) return null;
    const holders = owned.accounts
        .map(a => ({ account: a.name, side: a.side, count: a.items.get(id) ?? 0, at: a.itemAt.get(id) ?? null }))
        .filter(h => h.count > 0)
        .sort((a, b) => b.count - a.count);
    const total = holders.reduce((a, h) => a + h.count, 0);
    if (total <= 0) return null;
    return {
        kind: 'owned', at: oldest(holders.map(h => h.at)), total, holders, src: '.practice/status/*.json + synced fleet/snapshots', gate: null, blocked: null,
        cost: cost({
            helperTicksPerUnit: stackable.has(item) ? 0 : r3(TRADE_TICKS / PACK_SLOTS), ticksBasis: 'measured', ticksNote: `one ${TRADE_TICKS}-tick trade per pack (scripts/measure/trade-supply.ts)`,
            coinsPerUnit: 0, coinsBasis: 'measured', coinsNote: 'already held', risk: 0, riskBasis: 'content', riskNote: 'no combat',
        }),
    };
}
