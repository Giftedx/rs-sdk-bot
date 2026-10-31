import { test, expect } from 'bun:test';
import { buildItemSources, shopUnitPrice, type DropSource, type GatherSource, type MakeSource, type ShopSource } from '../src/item-sources';
import { lines } from '../src/skill-tools';

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
    expect(s.cost.coinsPerUnit).toBe(0);
});

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
