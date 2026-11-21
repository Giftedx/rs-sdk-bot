import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ItemInfo, LootTables } from './valuation';

// One set of tables for all sessions of a process.
let shared: LootTables | null = null;
export const sharedLootTables = (): LootTables => (shared ??= fileTables());

// The tables from disk: knowledge/items.json, the market (.practice/market-all.json, scripts/market-cache.ts), the
// older GE file and the supply bill (.practice/coordinator). The .practice files are read again when they change, at
// most each RELOAD_MS. A missing file gives no prices or no bill.
// The market value of an item is the lower of its 7-day VWAP (when it traded at least 3 times) and its current bid:
// the market is thin, and the bid is what a buyer pays now.
// An item with no bid has no buyer, and a few trades between two accounts set its VWAP (Jug 29,076 coins, base 1). It is
// then worth the lowest of the VWAP, the ask and UNBID_BASE_MULT times the shop price; the alchemy floor of unitValue
// still applies.
// The newest dated quote wins between the two files, even when its value falls. Undated files are fallback evidence.
const RELOAD_MS = 600_000;
const UNBID_BASE_MULT = 4;

export const marketValue = (m: { price?: number | null; bid?: number | null; ask?: number | null; base?: number | null } | undefined): number => {
    const pos = (v: unknown): number | null => typeof v === 'number' && v > 0 ? v : null;
    const price = pos(m?.price), bid = pos(m?.bid), ask = pos(m?.ask), base = pos(m?.base);
    if (price === null) return 0;
    if (bid !== null) return Math.floor(Math.min(price, bid));
    return Math.floor(Math.min(price, ask ?? Infinity, base === null ? Infinity : base * UNBID_BASE_MULT));
};

export function fileTables(root = resolve(import.meta.dir, '..', '..', '..', '..')): LootTables {
    const items = new Map<number, ItemInfo>();
    try {
        for (const i of JSON.parse(readFileSync(join(root, 'knowledge', 'items.json'), 'utf8')) as any[])
            items.set(i.id, { name: i.name ?? '', debugname: i.debugname ?? '', cost: i.cost ?? 0, tradeable: i.tradeable === true });
    } catch { /* no item file: every item is worth 0 */ }
    const byDebug = new Map([...items].map(([id, i]) => [i.debugname, id]));
    const pricesFile = join(root, '.practice', 'coordinator', 'market-prices.json');
    const marketFile = join(root, '.practice', 'market-all.json');
    const billFile = join(root, '.practice', 'coordinator', 'supply-bill.json');
    let bids = new Map<number, number>(), wanted = new Set<number>(), checked = 0, stamp = '';
    const load = () => {
        const now = Date.now();
        if (now - checked < RELOAD_MS && checked) return;
        checked = now;
        const mtime = (f: string) => { try { return String(statSync(f).mtimeMs); } catch { return '-'; } };
        const next = `${mtime(pricesFile)}|${mtime(marketFile)}|${mtime(billFile)}`;
        if (next === stamp) return;
        stamp = next;
        const b = new Map<number, number>(), observed = new Map<number, number>(), w = new Set<number>();
        const quoteNumber = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0);
        const remember = (id: number, value: number, rawAt: unknown) => {
            const at = typeof rawAt === 'number' && Number.isFinite(rawAt) && rawAt > 0 && rawAt <= now ? rawAt : 0;
            const prior = observed.get(id);
            // Shared rows include the VWAP guard, so they win a dated tie with their projected legacy bid.
            // With neither observation dated, retain the existing higher-value fallback.
            if (prior === undefined || at > prior || (at === prior && (at > 0 || value > (b.get(id) ?? 0)))) {
                observed.set(id, at); b.set(id, value);
            }
        };
        try {
            for (const [name, p] of Object.entries(JSON.parse(readFileSync(pricesFile, 'utf8')) as Record<string, any>)) {
                const id = byDebug.get(name);
                if (id !== undefined && quoteNumber(p?.bid)) remember(id, p.bid ?? 0, p.at);
            }
        } catch { /* no prices */ }
        try {
            const market = JSON.parse(readFileSync(marketFile, 'utf8'));
            for (const [id, m] of Object.entries(market.items ?? {}) as [string, any][]) {
                if (Number.isSafeInteger(Number(id)) && quoteNumber(m?.price) && quoteNumber(m?.bid))
                    remember(Number(id), marketValue(m), market.at);
            }
        } catch { /* no market file */ }
        try {
            for (const row of (JSON.parse(readFileSync(billFile, 'utf8')).rows ?? []) as any[])
                if ((row?.short ?? 0) > 0) for (const id of row.ids ?? []) w.add(id);
        } catch { /* no bill */ }
        bids = b; wanted = w;
    };
    return {
        info: id => items.get(id),
        bid: id => { load(); return bids.get(id) ?? 0; },
        wanted: id => { load(); return wanted.has(id); },
    };
}
