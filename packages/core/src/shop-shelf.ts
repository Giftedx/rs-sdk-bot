// The latest shelf count that any account saw for each item at each NPC shop. Shop stock is shared by every player on
// the world, so one account's view of an empty shelf tells the next plan where not to walk. The shop-buy worker
// writes it (workers/src/market/shop-buy.ts cfg.onShelf, from scripts/aio-market.ts); the brain snapshot reads it
// into WorldSnapshot.shopShelves (brain/src/snapshot.ts) and the acquire planner uses it (brain/src/acquire.ts).
// One file per shop keeps the store bounded; a write merges its rows into the file and replaces it atomically.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomicFile } from './atomic-file';
import { isLocalServer } from './localserver';
import { liveRoot, repoRoot, simRoot } from './practice-paths';

export type ShelfRow = { readonly id: number; readonly count: number };
export type ShelfSeen = { readonly count: number; readonly at: number };
type ShelfFile = { shop: string; items: Record<string, ShelfSeen> };

// An observation older than this says nothing of the shelf now: shops restock and players buy.
export const SHELF_MAX_AGE_MS = 30 * 60_000;

const SHOP_ID_RE = /^[a-z0-9_-]{1,64}$/;

export const shopShelfDir = (server: string, base = repoRoot): string =>
    join(isLocalServer(server) ? simRoot(base) : liveRoot(base), 'shop-shelves');

// The store key of an item at a shop: the brain market venue key (contracts.ts marketCooldownKey).
export const shelfKey = (itemId: number, shop: string): string => `${itemId}:shop:${shop}`;

function readShelfFile(file: string): ShelfFile | null {
    try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as ShelfFile;
        return raw && typeof raw.shop === 'string' && raw.items && typeof raw.items === 'object' ? raw : null;
    } catch {
        return null;
    }
}

export function recordShopShelf(server: string, shop: string, rows: readonly ShelfRow[], at = Date.now(), base = repoRoot): void {
    const id = shop.toLowerCase();
    if (!SHOP_ID_RE.test(id)) return;
    const valid = rows.filter(r => Number.isSafeInteger(r.id) && r.id >= 0 && Number.isSafeInteger(r.count) && r.count >= 0);
    if (!valid.length) return;
    const file = join(shopShelfDir(server, base), `${id}.json`);
    const prev = existsSync(file) ? readShelfFile(file) : null;
    const items: Record<string, ShelfSeen> = { ...(prev?.items ?? {}) };
    for (const r of valid) items[String(r.id)] = { count: r.count, at };
    writeAtomicFile(file, JSON.stringify({ shop: id, items } satisfies ShelfFile), { ensureDir: true });
}

// Every fresh observation, keyed by shelfKey.
export function readShopShelves(server: string, now = Date.now(), base = repoRoot, maxAgeMs = SHELF_MAX_AGE_MS): Record<string, ShelfSeen> {
    const dir = shopShelfDir(server, base);
    const out: Record<string, ShelfSeen> = {};
    let names: string[];
    try {
        names = readdirSync(dir).filter(n => n.endsWith('.json'));
    } catch {
        return out;
    }
    for (const name of names) {
        const f = readShelfFile(join(dir, name));
        if (!f || !SHOP_ID_RE.test(f.shop)) continue;
        for (const [id, seen] of Object.entries(f.items)) {
            const itemId = Number(id);
            if (!Number.isSafeInteger(itemId) || itemId < 0 || !seen) continue;
            if (!Number.isSafeInteger(seen.count) || seen.count < 0 || !Number.isFinite(seen.at)) continue;
            if (now - seen.at > maxAgeMs || seen.at > now + 60_000) continue;
            out[shelfKey(itemId, f.shop)] = { count: seen.count, at: seen.at };
        }
    }
    return out;
}
