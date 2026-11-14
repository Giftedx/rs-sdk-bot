import { hasPriceId, priceItemId, priceItemKey, priceName, type PriceIdentity } from './item-prices';

export type VaultItem = PriceIdentity & { name: string; count: number; unconfirmed?: true };

// Transfers without an item ID cannot choose which same-name variant left an account.
// Keep their aggregate subtraction, but do not retain an exact identity for the remainder.
export function createVaultItems() {
    const items = new Map<string, VaultItem>(), uncertainNames = new Set<string>();
    const legacyKey = (name: string) => `name:${name}`;
    const collapse = (item: VaultItem) => {
        const name = priceName(item.name);
        let count = 0;
        for (const [key, held] of items) if (priceName(held.name) === name) { count += held.count; items.delete(key); }
        const held: VaultItem = { name: item.name.replace(/\s*\(noted\)\s*$/i, '').trim(), count, unconfirmed: true };
        items.set(legacyKey(name), held); uncertainNames.add(name);
        return held;
    };
    const add = (list: readonly VaultItem[] | null | undefined, sign = 1) => {
        for (const raw of list ?? []) {
            if (!raw?.name || !(raw.count > 0)) continue;
            const key = priceItemKey(raw), item = key === 'id:995' ? { ...raw, id: 995, name: 'Coins' } : raw;
            const name = priceName(item.name), delta = sign * item.count;
            let held = items.get(key);
            if (uncertainNames.has(name)) {
                held = items.get(legacyKey(name))!;
            } else if (delta < 0) {
                const sameName = [...items.values()].filter(row => priceName(row.name) === name);
                const exact = priceItemId(item) !== null || key === 'id:995';
                const touchesExact = !exact && sameName.some(row => hasPriceId(row));
                if (touchesExact || !held || held.count + delta < 0) held = collapse(item);
            }
            if (!held) {
                held = key === 'id:995' ? { ...item, id: 995, name: 'Coins', count: 0 } : { ...item, count: 0 };
                items.set(key, held);
            }
            held.count += delta;
            if (item.unconfirmed) held.unconfirmed = true;
            if (held.count <= 0 && !held.unconfirmed) items.delete(key);
        }
    };
    return {
        add,
        // A zero/negative unresolved row still proves the account's stock is incomplete.
        rows: () => [...items.values()].filter(item => item.count > 0 || item.unconfirmed),
        unconfirmed: () => [...items.values()].some(item => item.unconfirmed === true),
    };
}
