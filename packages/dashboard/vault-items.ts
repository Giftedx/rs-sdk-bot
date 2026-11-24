import { hasPriceId, priceItemId, priceItemKey, priceName, type PriceIdentity } from './item-prices';

export type VaultItem = PriceIdentity & { name: string; count: number; unconfirmed?: true };

// Transfers without an item ID cannot choose which same-name variant left an account.
// Keep their aggregate subtraction, but do not retain an exact identity for the remainder.
export function createVaultItems() {
    const items = new Map<string, VaultItem>(), uncertainNames = new Set<string>();
    const keysByName = new Map<string, Set<string>>();
    let hasUnconfirmed = false;
    const legacyKey = (name: string) => `name:${name}`;
    const indexKey = (name: string, key: string) => {
        let bucket = keysByName.get(name);
        if (!bucket) { bucket = new Set(); keysByName.set(name, bucket); }
        bucket.add(key);
    };
    const unindexKey = (name: string, key: string) => {
        const bucket = keysByName.get(name);
        if (!bucket) return;
        bucket.delete(key);
        if (bucket.size === 0) keysByName.delete(name);
    };
    const collapse = (item: VaultItem, name: string) => {
        let count = 0;
        const bucket = keysByName.get(name);
        if (bucket) {
            for (const key of bucket) {
                const held = items.get(key);
                if (held) { count += held.count; items.delete(key); }
            }
            keysByName.delete(name);
        }
        const key = legacyKey(name);
        const held: VaultItem = { name: item.name.includes('(') ? item.name.replace(/\s*\(noted\)\s*$/i, '').trim() : item.name.trim(), count, unconfirmed: true };
        items.set(key, held);
        indexKey(name, key);
        uncertainNames.add(name);
        hasUnconfirmed = true;
        return held;
    };
    const add = (list: readonly VaultItem[] | null | undefined, sign = 1) => {
        if (!list) return;
        for (let i = 0; i < list.length; i++) {
            const raw = list[i];
            if (!raw?.name || !(raw.count > 0)) continue;
            const key = priceItemKey(raw), item = key === 'id:995' ? { ...raw, id: 995, name: 'Coins' } : raw;
            const name = priceName(item.name), delta = sign * item.count;
            let held = items.get(key);
            if (uncertainNames.has(name)) {
                held = items.get(legacyKey(name))!;
            } else if (delta < 0) {
                const exact = priceItemId(item) !== null || key === 'id:995';
                let touchesExact = false;
                if (!exact) {
                    const bucket = keysByName.get(name);
                    if (bucket) {
                        for (const k of bucket) {
                            const row = items.get(k);
                            if (row && hasPriceId(row)) { touchesExact = true; break; }
                        }
                    }
                }
                if (touchesExact || !held || held.count + delta < 0) held = collapse(item, name);
            }
            if (!held) {
                held = key === 'id:995' ? { ...item, id: 995, name: 'Coins', count: 0 } : { ...item, count: 0 };
                items.set(key, held);
                indexKey(name, key);
            }
            held.count += delta;
            if (item.unconfirmed) { held.unconfirmed = true; hasUnconfirmed = true; }
            if (held.count <= 0 && !held.unconfirmed) {
                items.delete(key);
                unindexKey(name, key);
            }
        }
    };
    return {
        add,
        // A zero/negative unresolved row still proves the account's stock is incomplete.
        rows: () => {
            const out: VaultItem[] = [];
            for (const item of items.values()) if (item.count > 0 || item.unconfirmed) out.push(item);
            return out;
        },
        unconfirmed: () => hasUnconfirmed,
    };
}
