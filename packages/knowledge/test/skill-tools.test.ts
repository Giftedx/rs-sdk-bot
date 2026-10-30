import { test, expect } from 'bun:test';
import { buildSkillTools, lines } from '../src/skill-tools';

const out = buildSkillTools();

// The text of a `path:line` citation, read from the content tree.
function at(src: string | null): string {
    expect(src).toMatch(/^scripts\/.+:\d+$/);
    const i = src!.lastIndexOf(':');
    return lines(src!.slice(0, i))[Number(src!.slice(i + 1)) - 1] ?? '';
}

test('rune pickaxe needs Mining 41, checked by pickaxe_checker, held or worn', () => {
    const p = out.pickaxes.find(x => x.item === 'rune_pickaxe')!;
    expect(p.miningLevel).toBe(41);
    expect(at(p.miningLevelSrc)).toBe('param=levelrequire,41');
    expect(at(p.holdSrc)).toContain('$lvl0 >= oc_param(rune_pickaxe, levelrequire) & ($obj1 = rune_pickaxe | inv_total(inv, rune_pickaxe) > 0)');
    expect(p.hold).toBe('either');
    expect(p.wieldAttack).toBe(40);
    expect(at(p.wieldSrc)).toContain('[opheld2,rune_pickaxe] @levelrequire_attack(40');
    expect(p.miningRate).toBe(2);
    expect(at(p.miningRateSrc)).toBe('param=mining_rate,2');
    expect(out.pickaxes[0].item).toBe('rune_pickaxe');
});

test('rune axe levelrequire is 41; woodcutting does not check it', () => {
    const a = out.axes.find(x => x.item === 'rune_axe')!;
    expect(a.paramLevelrequire).toBe(41);
    expect(at(a.paramSrc)).toBe('param=levelrequire,41');
    expect(a.woodcuttingLevel).toBeNull();
    expect(at(a.woodcuttingLevelSrc)).toContain('no wc req in 2004');
    expect(at(a.holdSrc)).toBe('if (($obj1 = rune_axe | inv_total(inv, rune_axe) > 0)) {');
    expect(a.wieldAttack).toBe(40);
    expect(at(a.wieldSrc)).toContain('[opheld2,rune_axe] @levelrequire_attack(40');
    expect(a.successChance.normal_tree_table).toMatchObject({ low: 224, high: 700 });
    expect(at(a.successChance.normal_tree_table.src)).toBe('data=successchance,rune_axe,224,700');
    expect(out.axes.map(x => x.item)).toEqual(['rune_axe', 'adamant_axe', 'mithril_axe', 'black_axe', 'steel_axe', 'iron_axe', 'bronze_axe']);
});

test('sharks need a harpoon and Fishing 76', () => {
    const r = out.records.find(x => x.id.startsWith('fishing/spot/') && x.catches?.some(c => c.item === 'raw_shark'))!;
    const tool = r.items.find(i => i.role === 'tool')!;
    expect(tool.anyOf).toEqual(['harpoon']);
    expect(at(tool.src)).toBe('if (~check_fish_equipment(harpoon) = false) {');
    expect(r.minLevel).toBe(76);
    expect(at(r.levelSrc)).toBe('if (stat(fishing) < 76) {');
    expect(r.items.some(i => i.role === 'bait')).toBe(false);
    expect(r.appliesTo.rungs).toContain('fishing/catch-shark');
});

test('fly fishing consumes feathers, one per catch', () => {
    const r = out.records.find(x => x.id === 'fishing/spot/freshfish/op1')!;
    expect(r.option?.name).toBe('Lure');
    expect(r.items.find(i => i.role === 'tool')!.anyOf).toEqual(['fly_fishing_rod']);
    const bait = r.items.find(i => i.role === 'bait')!;
    expect(bait.anyOf).toEqual(['feather']);
    expect(at(bait.src)).toBe('param=baitrequired,feather');
    const c = r.consumed.find(x => x.item === 'feather')!;
    expect(at(c.src)).toContain('~fish_roll(raw_trout, raw_salmon, fly_fishing_rod, feather);');
    expect(r.catches!.find(x => x.item === 'raw_salmon')!.level).toBe(30);
});

test('smithing at an anvil needs a held hammer', () => {
    const r = out.records.find(x => x.id === 'smithing/anvil')!;
    const h = r.items.find(i => i.anyOf.includes('hammer'))!;
    expect(h.hold).toBe('held');
    expect(at(h.src)).toBe('if (inv_total(inv, hammer) < 1) {');
    expect(at(r.locs[0].src)).toBe('[oplocu,_anvil]');
    expect(r.appliesTo.rungs.length).toBeGreaterThan(0);
});

test('every record and table row cites a content line', () => {
    for (const r of out.records) {
        for (const i of r.items) expect(at(i.src)).not.toBe('');
        for (const c of r.consumed) expect(at(c.src)).not.toBe('');
        for (const l of r.locs) expect(at(l.src)).not.toBe('');
        if (r.levelSrc) expect(at(r.levelSrc)).not.toBe('');
    }
    for (const a of out.axes) expect(at(a.holdSrc)).toContain(a.item);
    for (const p of out.pickaxes) expect(at(p.holdSrc)).toContain(p.item);
});
