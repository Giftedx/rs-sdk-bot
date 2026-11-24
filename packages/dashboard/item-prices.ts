// The dashboard's valuation rule: the 7-day VWAP after three trades, otherwise the item's base price.
// Exact IDs survive every projection. A name alias requires complete, agreeing catalogue evidence.
export type PriceIdentity = { id?: number; baseId?: number; name?: string };
export type ItemPrice = { name: string; value: number; ask: number | null; bid: number | null };
export type ItemPrices = { byId: Record<string, ItemPrice>; byName: Record<string, ItemPrice> };
export type PriceCatalogItem = { id: number; name: string; debugname?: string };

// Static expected-drop identities are public content, independent of the fleet's private held-item list.
export function expectedLootPrices(raw: unknown): (PriceIdentity | string)[] {
    const out: (PriceIdentity | string)[] = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const rows of Object.values(raw)) if (Array.isArray(rows)) for (const row of rows) {
        if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[0].trim()
            || typeof row[1] !== 'number' || !Number.isFinite(row[1]) || row[1] <= 0) continue;
        out.push(row.length > 2 ? { id: row[2], name: row[0] } : row[0]);
    }
    return out;
}

export const priceName = (name: unknown): string => {
    if (typeof name !== 'string') return '';
    const trimmed = name.includes('(') ? name.replace(/\s*\(noted\)\s*$/i, '').trim() : name.trim();
    return trimmed.toLowerCase();
};
export const hasPriceId = (item: PriceIdentity | string | null | undefined): boolean => !!item && typeof item === 'object'
    && (Object.hasOwn(item, 'id') || Object.hasOwn(item, 'baseId'));
export function priceItemId(item: PriceIdentity | string | null | undefined): number | null {
    if (!item || typeof item !== 'object') return null;
    const id = Object.hasOwn(item, 'baseId') ? item.baseId : item.id;
    return Number.isSafeInteger(id) && id! >= 0 ? id! : null;
}
export const priceItemKey = (item: PriceIdentity | string) => {
    const id = priceItemId(item), name = priceName(typeof item === 'string' ? item : item.name);
    return id !== null ? `id:${id}` : hasPriceId(item) ? `invalid:${name}` : name === 'coins' ? 'id:995' : `name:${name}`;
};
const COINS: ItemPrice = { name: 'Coins', value: 1, ask: null, bid: null };
const quote = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;

export function buildItemPrices(rows: readonly any[], catalogue: readonly PriceCatalogItem[]): ItemPrices {
    const byId: ItemPrices['byId'] = { 995: COINS }, byName: ItemPrices['byName'] = { coins: COINS };
    for (const row of rows) {
        if (!Number.isSafeInteger(row?.id) || row.id < 0 || typeof row.name !== 'string' || !row.name.trim()) continue;
        const value = row.vwap != null && row.trades >= 3 ? row.vwap : row.basePrice;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
        byId[row.id] = { name: row.name, value, ask: quote(row.ask), bid: quote(row.bid) };
    }
    const groups = new Map<string, Set<number>>();
    for (const item of catalogue) {
        const name = priceName(item?.name);
        if (!name || !Number.isSafeInteger(item.id) || item.id < 0 || item.debugname?.startsWith('cert_')) continue;
        const ids = groups.get(name) ?? new Set<number>(); ids.add(item.id); groups.set(name, ids);
    }
    for (const [name, ids] of groups) {
        if (name === 'coins') continue;
        const values = [...ids].map(id => byId[id]), first = values[0];
        if (!first || values.some(value => !value || value.value !== first.value)) continue;
        byName[name] = { ...first, ask: values.every(value => value!.ask === first.ask) ? first.ask : null,
            bid: values.every(value => value!.bid === first.bid) ? first.bid : null };
    }
    return { byId, byName };
}

export function itemPrice(prices: ItemPrices, item: PriceIdentity | string | null | undefined): ItemPrice | null {
    const id = priceItemId(item);
    if (id !== null) return id === 995 ? COINS : prices.byId[id] ?? null;
    if (hasPriceId(item)) return null;
    const name = priceName(typeof item === 'string' ? item : item?.name);
    return name === 'coins' ? COINS : prices.byName[name] ?? null;
}

// Project only identities already visible to the consumer. Name aliases never reveal which bank-only IDs were held.
export function projectItemPrices(prices: ItemPrices, visible: readonly (PriceIdentity | string)[]): ItemPrices {
    const out: ItemPrices = { byId: {}, byName: {} };
    for (let i = 0; i < visible.length; i++) {
        const item = visible[i]!;
        const id = priceItemId(item), name = priceName(typeof item === 'string' ? item : item?.name), value = itemPrice(prices, item);
        if (id !== null && value) out.byId[id] = value;
        if (name && prices.byName[name]) out.byName[name] = prices.byName[name]!;
        const valName = value ? priceName(value.name) : '';
        if (valName && valName !== name && prices.byName[valName]) out.byName[valName] = prices.byName[valName]!;
    }
    return out;
}
