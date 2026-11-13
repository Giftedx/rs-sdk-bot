import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchMarket, marketRows, MARKET_CACHE_MS, MARKET_FILE } from './market-cache';
import { marketStale } from './fleet-agent';
import { fileTables, marketValue, unitValue } from '../packages/core/src/loot';

test('a market row has a price only with at least 3 trades', () => {
    expect(marketRows([{ id: 1127, name: 'Rune platebody', vwap: 266666.6, trades: 3, bid: 80000, ask: null }, { id: 554, name: 'Fire rune', vwap: 9, trades: 1, bid: 4 }, { name: 'no id' }]))
        .toEqual({ 1127: { name: 'Rune platebody', price: 266666.6, bid: 80000, ask: null, trades: 3 }, 554: { name: 'Fire rune', price: null, bid: 4, ask: null, trades: 1 } });
});

test('fetchMarket reads every page of 100 and pauses between them', async () => {
    const urls: string[] = [];
    let pauses = 0;
    const page = (offset: number) => ({ total: 150, items: [{ id: offset + 1, name: `i${offset}`, vwap: 10, trades: 5 }] });
    const all = await fetchMarket(async url => { urls.push(url); return page(Number(url.match(/offset=(\d+)/)![1])); }, async () => { pauses++; });
    expect(urls.map(u => u.replace(/^.*\?/, ''))).toEqual(['limit=100&offset=0', 'limit=100&offset=100']);
    expect(pauses).toBe(1);
    expect(Object.keys(all)).toEqual(['1', '101']);
    await expect(fetchMarket(async () => ({ total: -1, items: [] }), async () => {})).rejects.toThrow('invalid market page');
});

test('market value: the lower of the VWAP and the bid; no price, no value', () => {
    expect(marketValue({ price: 266666.6, bid: 80000 })).toBe(80000);
    expect(marketValue({ price: 5000.9, bid: null })).toBe(5000);
    expect(marketValue({ price: null, bid: 80000 })).toBe(0);
    expect(marketValue(undefined)).toBe(0);
});

test('the loot tables value an item at its market price over the alchemy floor', () => {
    const root = mkdtempSync(join(tmpdir(), 'market-'));
    mkdirSync(join(root, 'knowledge')); mkdirSync(join(root, '.practice'));
    writeFileSync(join(root, 'knowledge', 'items.json'), JSON.stringify([{ id: 1127, name: 'Rune platebody', debugname: 'rune_platebody', cost: 65000, tradeable: true },
        { id: 1163, name: 'Rune full helm', debugname: 'rune_full_helm', cost: 35200, tradeable: true }]));
    writeFileSync(join(root, MARKET_FILE), JSON.stringify({ at: 1, items: { 1127: { price: 266666, bid: 80000, trades: 3 }, 1163: { price: 5000, bid: null, trades: 4 } } }));
    const t = fileTables(root);
    expect(unitValue(1127, t)).toBe(80000);
    // A market price under the alchemy floor does not lower the value.
    expect(unitValue(1163, t)).toBe(Math.floor(35200 * 0.6));
});

test('the market cache is stale when missing or older than 30 minutes', () => {
    const root = mkdtempSync(join(tmpdir(), 'market-stale-'));
    expect(marketStale(root)).toBe(true);
    mkdirSync(join(root, '.practice'));
    writeFileSync(join(root, MARKET_FILE), '{}');
    expect(marketStale(root)).toBe(false);
    const old = (Date.now() - MARKET_CACHE_MS - 60_000) / 1000;
    utimesSync(join(root, MARKET_FILE), old, old);
    expect(marketStale(root)).toBe(true);
});
