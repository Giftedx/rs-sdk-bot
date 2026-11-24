import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildItemSources } from '../packages/knowledge/src/item-sources';
import { defaultLiveMarket, readLiveMarket, readOwned } from './item-sources';

function fixture(run: (dir: string, write: (path: string, value: unknown) => void) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'item-sources-live-'));
    const write = (path: string, value: unknown) => {
        const file = join(dir, path);
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, JSON.stringify(value));
    };
    try { run(dir, write); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('owned sourcing selects the current owner and freshest own publication, counting adopted accounts once', () => fixture((dir, write) => {
    const server = 'rs-sdk-demo.fly.dev', now = 10000;
    const account = (name: string, at: number, count: number) => ({ name, server, at, inventory: [{ id: 436, count }] });
    write('status/Worker.json', account('Worker', now - 1, 999));
    write('synced/owners.json', { accounts: { Worker: { side: 'cloud', server }, Mine: { side: 'local', server } } });
    write('synced/snapshots/local.json', { side: 'local', at: now, accounts: [account('Worker', now - 2, 888), account('Mine', now - 3, 7)] });
    write('synced/snapshots/cloud.json', { side: 'cloud', at: now, accounts: [account('worker', now - 4, 12)] });
    const owned = readOwned(dir, join(dir, 'synced/snapshots'), 'local', now);
    expect(owned.accounts.map(a => [a.name, a.side, a.items.get(436)])).toEqual([['worker', 'cloud', 12], ['Mine', 'local', 7]]);
    expect(owned.at).toBe(new Date(now - 4).toISOString());
}));

test('owned sourcing honors configured fleet location and side in a fresh container', () => fixture((dir, write) => {
    const priorDir = process.env.FLEET_DIR, priorSide = process.env.FLEET_SIDE, server = 'rs-sdk-demo.fly.dev';
    write('synced/owners.json', { accounts: { Worker: { side: 'cloud', server } } });
    write('synced/snapshots/cloud.json', { side: 'cloud', accounts: [{ name: 'Worker', server, at: 5000, inventory: [{ id: 436, count: 9 }] }] });
    process.env.FLEET_DIR = join(dir, 'synced'); process.env.FLEET_SIDE = 'cloud';
    try {
        const owned = readOwned(dir);
        expect(owned.accounts.map(a => [a.name, a.side, a.items.get(436)])).toEqual([['Worker', 'cloud', 9]]);
    } finally {
        if (priorDir === undefined) delete process.env.FLEET_DIR; else process.env.FLEET_DIR = priorDir;
        if (priorSide === undefined) delete process.env.FLEET_SIDE; else process.env.FLEET_SIDE = priorSide;
    }
}));

test('owned source timestamps follow each contributing container and remain unknown when undated', () => fixture((dir, write) => {
    const server = 'rs-sdk-demo.fly.dev', now = 10000;
    write('status/Worker.json', { name: 'Worker', server, at: 9000, inventory: [{ id: 436, count: 2 }], bank: [{ id: 436, count: 3 }, { id: 438, count: 1 }], bankAt: 1000 });
    write('status/Unknown.json', { name: 'Unknown', server, at: 9000, bank: [{ id: 438, count: 4 }] });
    const owned = readOwned(dir, join(dir, 'snapshots'), 'cloud', now);
    const sources = buildItemSources({ owned });
    const copper = sources.find(r => r.id === 436)!.sources.find(s => s.kind === 'owned')!;
    expect(copper).toMatchObject({ total: 5, at: new Date(1000).toISOString(), holders: [{ account: 'Worker', side: 'cloud', count: 5, at: new Date(1000).toISOString() }] });
    const tin = sources.find(r => r.id === 438)!.sources.find(s => s.kind === 'owned')!;
    expect(tin).toMatchObject({ total: 5, at: null });
    expect(owned.at).toBeNull();
}), 20000);

test('owned sourcing excludes practice, other servers and the main account', () => fixture((dir, write) => {
    for (const [name, server, practice] of [['Practice', 'rs-sdk-demo.fly.dev', true], ['Other', 'localhost:8888', false], ['Haggis', 'rs-sdk-demo.fly.dev', false]] as const) {
        write(`status/${name}.json`, { name, server, practice, at: 9000, inventory: [{ id: 436, count: 99 }] });
    }
    expect(readOwned(dir, join(dir, 'snapshots'), 'local', 10000).accounts).toEqual([]);
}));

test('shared quotes reach item sourcing with seller quantities and source ages, including an empty book', () => fixture((dir, write) => {
    const now = 10000;
    write('market-all.json', { at: now - 1, items: { 436: { ask: 8, bid: 5, sell: 100 }, 438: { ask: null, bid: 4, sell: 0 } } });
    const market = readLiveMarket(join(dir, 'market-all.json'));
    expect(market.prices.copper_ore).toEqual({ ask: 8, bid: 5, sell: 100 });
    const sources = buildItemSources({ market });
    expect(sources.find(r => r.id === 436)!.sources.find(s => s.kind === 'ge')).toMatchObject({ ask: 8, sellers: 100, at: new Date(now - 1).toISOString(), blocked: null });
    expect(sources.find(r => r.id === 438)!.sources.find(s => s.kind === 'ge')).toMatchObject({ ask: null, sellers: 0, at: new Date(now - 1).toISOString(), blocked: expect.any(String) });
}), 20000);

test('default market keeps the newest quote per item without refreshing older quotes', () => fixture((dir, write) => {
    const now = 10_000_000;
    write('coordinator/market-prices.json', { copper_ore: { at: now - 1, ask: 15, bid: 10, sell: 6 }, tin_ore: { at: now - 2000, ask: 9, bid: 8, sell: 3 } });
    write('market-all.json', { at: now - 1000, items: { 436: { ask: 8, bid: 5, sell: 100 }, 438: { ask: null, bid: 4, sell: 0 } } });
    const market = defaultLiveMarket(dir, join(dir, 'research'), now)!;
    expect(market.prices.copper_ore).toMatchObject({ ask: 15, at: new Date(now - 1).toISOString() });
    expect(market.prices.tin_ore).toMatchObject({ ask: null, sell: 0, at: new Date(now - 1000).toISOString() });
    // A stale or future shared cache cannot displace the coordinator's observations.
    for (const at of [now - 30 * 60_000, now + 1]) {
        write('market-all.json', { at, items: { 438: { ask: 1, bid: 1, sell: 999 } } });
        expect(defaultLiveMarket(dir, join(dir, 'research'), now)!.prices.tin_ore).toMatchObject({ ask: 9, sell: 3, at: new Date(now - 2000).toISOString() });
    }
}));

test('owned sourcing reads live/status and prefers newer live status over legacy status', () => fixture((dir, write) => {
    const server = 'rs-sdk-demo.fly.dev', now = 10000;
    write('status/Worker.json', { name: 'Worker', server, at: 5000, inventory: [{ id: 436, count: 2 }] });
    write('live/status/Worker.json', { name: 'Worker', server, at: 9000, inventory: [{ id: 436, count: 15 }] });
    write('live/status/LiveOnly.json', { name: 'LiveOnly', server, at: 9500, inventory: [{ id: 438, count: 7 }] });
    const owned = readOwned(dir, join(dir, 'snapshots'), 'local', now);
    const byName = new Map(owned.accounts.map(a => [a.name, a]));
    expect(byName.get('Worker')?.items.get(436)).toBe(15);
    expect(byName.get('LiveOnly')?.items.get(438)).toBe(7);
}));
