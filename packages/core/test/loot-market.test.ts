import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileTables, unitValue, type LootTables } from '../src/loot';

function withMarket(legacy: unknown, market: unknown, check: (tables: LootTables) => void) {
    const root = mkdtempSync(join(tmpdir(), 'loot-market-'));
    try {
        mkdirSync(join(root, 'knowledge'));
        mkdirSync(join(root, '.practice/coordinator'), { recursive: true });
        writeFileSync(join(root, 'knowledge/items.json'), JSON.stringify([
            { id: 1127, name: 'Rune platebody', debugname: 'rune_platebody', cost: 65000, tradeable: true },
        ]));
        writeFileSync(join(root, '.practice/coordinator/market-prices.json'), JSON.stringify(legacy));
        writeFileSync(join(root, '.practice/market-all.json'), JSON.stringify(market));
        check(fileTables(root));
    } finally { rmSync(root, { recursive: true, force: true }); }
}

test('newer shared lower or absent market values displace stale high bids without removing the alchemy floor', () => {
    for (const [quote, value] of [
        [{ price: 5000, bid: 4000 }, 4000],
        [{ price: null, bid: null }, 0],
        [{ price: 5000, bid: null }, 5000],
    ] as const) {
        withMarket({ rune_platebody: { at: 100, bid: 90000 } }, { at: 200, items: { 1127: quote } }, tables => {
            expect(tables.bid(1127)).toBe(value);
            expect(unitValue(1127, tables)).toBe(39000);
        });
    }
});

test('newer individual observations stay authoritative, including an observed missing bid', () => {
    for (const bid of [2000, null]) {
        withMarket({ rune_platebody: { at: 300, bid } }, { at: 200, items: { 1127: { price: 80000, bid: 70000 } } }, tables => {
            expect(tables.bid(1127)).toBe(bid ?? 0);
        });
    }
});

test('undated quotes cannot hide dated observations and retain their existing fallback when both dates are unknown', () => {
    withMarket({ rune_platebody: { bid: 90000 } }, { at: 200, items: { 1127: { price: 5000, bid: 4000 } } }, tables => {
        expect(tables.bid(1127)).toBe(4000);
    });
    withMarket({ rune_platebody: { at: 200, bid: 4000 } }, { items: { 1127: { price: 90000, bid: 80000 } } }, tables => {
        expect(tables.bid(1127)).toBe(4000);
    });
    withMarket({ rune_platebody: { bid: 90000 } }, { items: { 1127: { price: 5000, bid: 4000 } } }, tables => {
        expect(tables.bid(1127)).toBe(90000);
    });
    withMarket({ rune_platebody: { at: Date.now() + 60_000, bid: 90000 } }, { at: 200, items: { 1127: { price: 5000, bid: 4000 } } }, tables => {
        expect(tables.bid(1127)).toBe(4000);
    });
});

test('shared quotes keep the VWAP guard when the individual bid has the same observation time', () => {
    withMarket({ rune_platebody: { at: 200, bid: 90000 } }, { at: 200, items: { 1127: { price: 5000, bid: 90000 } } }, tables => {
        expect(tables.bid(1127)).toBe(5000);
    });
});
