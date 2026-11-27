import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readShopShelves, recordShopShelf, SHELF_MAX_AGE_MS, shelfKey, shopShelfDir } from '../src/shop-shelf';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const root = () => { const r = mkdtempSync(join(tmpdir(), 'shop-shelf-')); roots.push(r); return r; };
const LIVE = 'rs-sdk-demo.fly.dev';
const NOW = 1_795_771_260_000;

test('the latest shelf count of each item at each shop reaches every reader, keyed like the market venue', () => {
    const base = root();
    recordShopShelf(LIVE, 'GemShop2', [{ id: 1621, count: 0 }, { id: 1623, count: 3 }], NOW - 60_000, base);
    recordShopShelf(LIVE, 'gemshop2', [{ id: 1623, count: 1 }], NOW, base);
    expect(existsSync(join(shopShelfDir(LIVE, base), 'gemshop2.json'))).toBe(true);
    expect(readShopShelves(LIVE, NOW, base)).toEqual({
        [shelfKey(1621, 'gemshop2')]: { count: 0, at: NOW - 60_000 },
        [shelfKey(1623, 'gemshop2')]: { count: 1, at: NOW },
    });
    expect(shelfKey(1621, 'gemshop2')).toBe('1621:shop:gemshop2');
    // An old observation says nothing of the shelf now.
    expect(readShopShelves(LIVE, NOW + SHELF_MAX_AGE_MS + 1, base)).toEqual({});
    // The local practice server keeps its own store.
    expect(readShopShelves('localhost', NOW, base)).toEqual({});
});

test('a bad shop id or row writes nothing', () => {
    const base = root();
    recordShopShelf(LIVE, '../escape', [{ id: 1, count: 0 }], NOW, base);
    recordShopShelf(LIVE, 'runeshop', [{ id: -1, count: 0 }, { id: 557, count: 1.5 }], NOW, base);
    expect(readShopShelves(LIVE, NOW, base)).toEqual({});
});
