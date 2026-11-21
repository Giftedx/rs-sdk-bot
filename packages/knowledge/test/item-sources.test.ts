import { test, expect } from 'bun:test';
import { buildItemSources, defaultMarket, ownedStockFromRows, readMarket, serializeItemSources, shopUnitPrice, sourceTiles, type DropSource, type GatherSource, type MakeSource, type PickupSource, type ShopSource, type Tile } from '../src/item-sources';
import { lines } from '../src/skill-tools';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJm2 } from '../src/jm2';
import { parsePack } from '../src/pack';
import { contentRoot, knowledgeDir } from '../src/paths';
import { itemSources as mapItemSources } from '../../dashboard/gen-map-data';

const rows = buildItemSources();
const row = (item: string) => rows.find(r => r.item === item)!;

// The text of a `path:line` citation, read from the content tree.
function at(src: string | null): string {
    expect(src).toMatch(/^(scripts|maps)\/.+:\d+$/);
    const i = src!.lastIndexOf(':');
    return (lines(src!.slice(0, i))[Number(src!.slice(i + 1)) - 1] ?? '').trim();
}

test('air runes: Aubury sells 2000 at 4 coins, restocking 1 per 10 ticks', () => {
    const s = row('airrune').sources.find((x): x is ShopSource => x.kind === 'shop' && x.shop === 'runeshop')!;
    expect(at(s.src)).toBe('stock3=airrune,2000,10');
    expect(s.owners.map(o => o.npc)).toEqual(['aubury']);
    expect(s.owners[0]!.spawns).toBeGreaterThan(0);
    expect(at(s.sellMultiplierSrc)).toBe('param=shop_sell_multiplier,1000');
    expect(s.priceAtFullStock).toBe(4);
    expect(s.cost.coinsPerUnit).toBeGreaterThanOrEqual(4);
    expect(s.cost.realSecondsPerUnit).toBe(4);
    expect(s.cost.risk).toBe(0);
    expect(row('airrune').substitutes.find(x => x.group === 'magic_staff_table')?.items).toContain('staff_of_air');
});

test('shop price rises by delta per mille of cost for each unit below normal stock, up to 6x (shop.rs2 calc_shop_value)', () => {
    expect(shopUnitPrice(100, 1000, 10, 50, 50)).toBe(100);
    expect(shopUnitPrice(100, 1000, 10, 40, 50)).toBe(110);
    expect(shopUnitPrice(100, 1000, 10, 0, 50)).toBe(150);
    expect(shopUnitPrice(100, 1000, 10, -999, 50)).toBe(600);
    expect(shopUnitPrice(100, 1000, 10, 60, 50)).toBe(90);
});

test('copper ore: mined from copper rocks with any pickaxe; respawn and rate from content and rates.json', () => {
    const s = row('copper_ore').sources.find((x): x is GatherSource => x.kind === 'gather')!;
    expect(s.rung).toBe('mining/copper_rock_table');
    expect(at(s.src)).toBe('[copper_rock_table]');
    expect(s.tools[0]).toContain('bronze_pickaxe');
    expect(s.tools[0]).toContain('rune_pickaxe');
    expect(s.places.find(p => p.loc === 'copperrock1')!.spawns).toBeGreaterThan(0);
    expect(at(s.respawnSrc)).toBe(`data=rock_respawnrate,${s.respawnTicks}`);
    expect(at(s.successChance!.src)).toBe(`data=rock_successchance,${s.successChance!.low},${s.successChance!.high}`);
    // rates.json mine_copper: 26.35 XP per tick at 25x; 17.5 base XP per ore.
    expect(s.cost.ticksBasis).toBe('measured');
    expect(s.cost.helperTicksPerUnit).toBeCloseTo((17.5 * 25) / 26.35, 2);
    expect(s.cost.ticksNote).toContain('mine_copper, measured level 1, 3 runs, 300 ms ticks');
    expect(s.cost.ticksNote).toContain('scripts/generated/copper5.ts');
    expect(s.cost.ticksNote).toContain('bronze pickaxe, rocks deplete after one ore');
    expect(s.cost.coinsPerUnit).toBe(0);
});

test('source tiles retain distant locations and distinct planes while collapsing overlapping spawn pins', () => {
    expect(sourceTiles([{ x: 10, z: 20, level: 0 }, { x: 10, z: 21, level: 0 }, { x: 11, z: 20, level: 0 },
        { x: 3200, z: 3200, level: 0 }, { x: 10, z: 20, level: 0 }, { x: 10, z: 20, level: 1 }])).toEqual([
        { x: 10, z: 20, level: 0 }, { x: 10, z: 21, level: 0 }, { x: 11, z: 20, level: 0 },
        { x: 3200, z: 3200, level: 0 }, { x: 10, z: 20, level: 1 },
    ]);
});

test('NPC sources retain every catalogue spawn location', () => {
    const giant = (JSON.parse(readFileSync(join(knowledgeDir(), 'npcs.json'), 'utf8')) as { debugname: string; spawns: Tile[] }[])
        .find(n => n.debugname === 'giant')!;
    const source = row('big_bones').sources.find((s): s is DropSource => s.kind === 'drop' && s.npc === 'giant')!;
    const place = source.places.find(p => p.npc === 'giant')!;
    const expected = [...new Map(giant.spawns.map(({ x, z, level }) => [`${x},${z},${level}`, { x, z, level }])).values()];
    expect(place.spawns).toBe(giant.spawns.length);
    expect(place.tiles).toEqual(expected);
    expect(place.tiles).toContainEqual({ x: 3042, z: 10317, level: 0 });
    expect(place.tiles.length).toBeGreaterThan(3);
});

test('loc and floor sources forward complete pinned-map locations to map-source consumers', () => {
    const locPack = parsePack(readFileSync(join(contentRoot(), 'pack/loc.pack'), 'utf8'));
    const locs: Tile[] = [], bones: Tile[] = [];
    for (const file of readdirSync(join(contentRoot(), 'maps')).filter(f => f.endsWith('.jm2')).sort()) {
        const map = parseJm2(file, readFileSync(join(contentRoot(), 'maps', file), 'utf8'));
        for (const spawn of map.locs) if (locPack.get(spawn.id) === 'copperrock1') locs.push(spawn);
        for (const spawn of map.objs) if (spawn.id === 526) bones.push(spawn);
    }
    const unique = (tiles: Tile[]) => [...new Map(tiles.map(({ x, z, level }) => [`${x},${z},${level}`, { x, z, level }])).values()];
    const copper = row('copper_ore').sources.find((s): s is GatherSource => s.kind === 'gather')!;
    const rock = copper.places.find(p => p.loc === 'copperrock1')!;
    const pickup = row('bones').sources.find((s): s is PickupSource => s.kind === 'pickup')!;
    expect(rock.spawns).toBe(locs.length); expect(rock.tiles).toEqual(unique(locs));
    expect(pickup.spawns).toBe(bones.length); expect(pickup.tiles).toEqual(unique(bones));
    expect(rock.tiles.length).toBeGreaterThan(3); expect(pickup.tiles.length).toBeGreaterThan(3);
    const mapped = mapItemSources([row('copper_ore'), row('bones')], { item: s => s, npc: s => s });
    const mappedBones = mapped['526']!.find(s => s[0] === 'pickup')![2];
    expect(mappedBones).toEqual(pickup.tiles.flatMap(t => [t.x, t.z, t.level]));
    const mappedCopper = mapped['436']!.find(s => s[0] === 'gather')![2];
    const fourth = rock.tiles[3]!;
    expect(mappedCopper.some((x, i) => i % 3 === 0 && x === fourth.x && mappedCopper[i + 1] === fourth.z && mappedCopper[i + 2] === fourth.level)).toBe(true);
});

function fixture(run: (dir: string, write: (path: string, value: unknown) => void) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'item-sources-'));
    const write = (path: string, value: unknown) => {
        const file = join(dir, path);
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, JSON.stringify(value));
    };
    try { run(dir, write); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('ownedStockFromRows aggregates counts, filters Haggis, and keeps oldest container timestamps', () => {
    const now = 10000;
    const owned = ownedStockFromRows([
        { name: 'Haggis', side: 'local', at: 9000, inventory: [{ id: 436, count: 99 }] },
        { name: 'Worker', side: 'cloud', at: 9000, inventory: [{ id: 436, count: 2 }], bank: [{ baseId: 436, count: 3 }, { id: 438, count: 1 }], bankAt: 1000 },
        { name: 'Unknown', side: 'cloud', at: 9000, bank: [{ id: 438, count: 4 }] },
    ], now);
    expect(owned.accounts.map(a => a.name)).toEqual(['Worker', 'Unknown']);
    expect(owned.at).toBeNull();
    const sources = buildItemSources({ owned });
    const copper = sources.find(r => r.id === 436)!.sources.find(s => s.kind === 'owned')!;
    expect(copper).toMatchObject({ total: 5, at: new Date(1000).toISOString(), holders: [{ account: 'Worker', side: 'cloud', count: 5, at: new Date(1000).toISOString() }] });
    const tin = sources.find(r => r.id === 438)!.sources.find(s => s.kind === 'owned')!;
    expect(tin).toMatchObject({ total: 5, at: null });
}, 20000);

test('readMarket maps injected shared-cache quotes and rejects shared caches without a parser', () => fixture((dir, write) => {
    const now = 10000;
    const sharedFile = join(dir, 'market-all.json');
    write('market-all.json', { at: now - 1, items: { 436: { ask: 8, bid: 5, sell: 100 }, 438: { ask: null, bid: 4, sell: 0 } } });
    expect(() => readMarket(sharedFile)).toThrow('shared market cache requires a quote parser');
    const market = readMarket(sharedFile, (raw: any) => raw.items);
    expect(market.prices.copper_ore).toEqual({ ask: 8, bid: 5, sell: 100 });
    const sources = buildItemSources({ market });
    expect(sources.find(r => r.id === 436)!.sources.find(s => s.kind === 'ge')).toMatchObject({ ask: 8, sellers: 100, at: new Date(now - 1).toISOString(), blocked: null });
    expect(sources.find(r => r.id === 438)!.sources.find(s => s.kind === 'ge')).toMatchObject({ ask: null, sellers: 0, at: new Date(now - 1).toISOString(), blocked: expect.any(String) });
}), 20000);

test('defaultMarket combines coordinator and research snapshots and serializeItemSources formats metadata', () => fixture((dir, write) => {
    const now = 10_000_000;
    write('coordinator/market-prices.json', { copper_ore: { at: now - 1, ask: 15, bid: 10, sell: 6 }, tin_ore: { at: now - 2000, ask: 9, bid: 8, sell: 3 } });
    write('research/market-snapshot.json', { takenAt: new Date(now - 1000).toISOString(), items: { tin_ore: { market: { ask: 11, bid: 7, sellQuantity: 4 } } } });
    const market = defaultMarket(dir, join(dir, 'research'), now)!;
    expect(market.prices.copper_ore).toMatchObject({ ask: 15, at: new Date(now - 1).toISOString() });
    expect(market.prices.tin_ore).toMatchObject({ ask: 11, sell: 4, at: new Date(now - 1000).toISOString() });
    const serialized = JSON.parse(serializeItemSources([row('copper_ore')], market, null));
    expect(serialized).toMatchObject({ generatedBy: 'bun packages/knowledge/src/item-sources.ts', market: { at: market.at }, owned: null });
}));

test('bronze bar: smelted from 1 copper ore and 1 tin ore, linked to the ladder rung', () => {
    const s = row('bronze_bar').sources.find((x): x is MakeSource => x.kind === 'make' && x.rung === 'smithing/smelt-bronze')!;
    expect(s.inputs).toEqual([{ item: 'copper_ore', count: 1 }, { item: 'tin_ore', count: 1 }]);
    expect(at(s.src)).toMatch(/Bronze|copper_ore/);
    expect(s.level).toBe(1);
    expect(row('copper_ore').neededBy).toContain('smithing/smelt-bronze (makes bronze_bar)');
});

test('big bones: giants drop their death_drop param on every kill', () => {
    const s = row('big_bones').sources.find((x): x is DropSource => x.kind === 'drop' && x.npc === 'giant')!;
    expect(at(s.src)).toContain('npc_param(death_drop)');
    expect(s.via).toMatch(/^death_drop param \(scripts\/.+\.npc:\d+\)$/);
    expect(at(s.via!.match(/\((.+)\)/)![1]!)).toBe('param=death_drop,big_bones');
    expect(s.chance).toBe(1);
    expect(s.places[0]!.spawns).toBeGreaterThan(0);
    expect(s.combat).toBeGreaterThan(0);
    expect(s.gate).toBeNull();
    expect(s.cost.coinsPerUnit).toBe(0);
});

test('every source cites content or a snapshot, and costs keep ticks, coins and risk apart', () => {
    for (const r of rows) for (const s of r.sources) {
        expect(s.src).toMatch(/:\d+$|^\.practice|^research/);
        expect(Object.keys(s.cost)).toEqual(expect.arrayContaining(['helperTicksPerUnit', 'coinsPerUnit', 'risk', 'ticksBasis', 'coinsBasis', 'riskBasis']));
    }
});
