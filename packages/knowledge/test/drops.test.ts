import { test, expect } from 'bun:test';
import { parseDrops, parseDropProcs, expandProcItems } from '../src/drops';

const SCRIPT = `[ai_queue3,testgiant]
gosub(npc_death);
if (npc_findhero = ^false) {
    return;
}
obj_add(npc_coord, npc_param(death_drop), 1, ^lootdrop_duration);
def_int $random = random(128);
if ($random < 4) {
    obj_add(npc_coord, iron_dagger, 1, ^lootdrop_duration);
} else if ($random < 10) {
    obj_add(npc_coord, coins, 25, ^lootdrop_duration);
} else if ($random < 12) {
    obj_add(npc_coord, ~randomherb, ^lootdrop_duration);
} else if ($random < 20) {
    if (map_members = ^true) {
        obj_add(npc_coord, limpwurt_root, 1, ^lootdrop_duration);
    } else {
        obj_add(npc_coord, coins, 5, ^lootdrop_duration);
    }
}

[ai_queue3,_cow]
gosub(npc_death);
obj_add(npc_coord, npc_param(death_drop), 1, ^lootdrop_duration);
obj_add(npc_coord, cow_hide, 1, ^lootdrop_duration);

[ai_queue3,goblin_armed] @goblin_drop_table;
`;

test('always-drops, roll slots with chances out of the die, sub-tables and conditional slots', () => {
    const d = parseDrops(SCRIPT, 'scripts/x.rs2');
    const g = d.find(x => x.trigger === 'testgiant')!;
    expect(g.always.map(a => [a.item, a.count])).toEqual([['death_drop', 1]]);
    expect(g.rolls.map(r => [r.chance, r.item ?? r.table, r.count ?? null, r.conditional])).toEqual([
        [4 / 128, 'iron_dagger', 1, false],
        [6 / 128, 'coins', 25, false],
        [2 / 128, 'randomherb', null, false],
        [8 / 128, 'limpwurt_root', 1, true],
        [8 / 128, 'coins', 5, true],
    ]);
    expect(g.src).toBe('scripts/x.rs2:1');
});

test('category triggers and shared-table labels are kept', () => {
    const d = parseDrops(SCRIPT, 'scripts/x.rs2');
    expect(d.find(x => x.trigger === '_cow')!.always.map(a => a.item)).toEqual(['death_drop', 'cow_hide']);
    expect(d.find(x => x.trigger === 'goblin_armed')!.uses).toBe('goblin_drop_table');
});

test('shared [label,...] drop tables are parsed too, so ai_queue3 users of @label get real rolls', () => {
    const text = `[ai_queue3,goblin_greenarmour] @goblin_village_drop_table;

[label,goblin_village_drop_table]
gosub(npc_death);
def_int $dropint = random(128);
if ($dropint < 106) {
    obj_add(npc_coord, goblin_armour, 1, ^lootdrop_duration);
} else if ($dropint < 107) {
    obj_add(npc_coord, grapes, 1, ^lootdrop_duration);
}
`;
    const d = parseDrops(text, 'g.rs2');
    const table = d.find(x => x.trigger === 'label:goblin_village_drop_table')!;
    expect(table.rolls.map(r => [r.item, r.chance * 128])).toEqual([['goblin_armour', 106], ['grapes', 1]]);
    expect(d.find(x => x.trigger === 'goblin_greenarmour')!.uses).toBe('goblin_village_drop_table');
});

test('brace-on-next-line tables with independent if blocks ending in return are roll slots', () => {
    const text = `[ai_queue3,testdragon]
gosub(npc_death);
obj_add(npc_coord, npc_param(death_drop), 1, ^lootdrop_duration);
if (random(1024) = 0) {
    obj_add(npc_coord, dragon_platelegs, 1, ^lootdrop_duration);
}
def_int $dropint = random(128);
if ($dropint < 1)
{
    obj_add(npc_coord, ~ultrarare_getitem, ^lootdrop_duration);
    return();
}
if ($dropint < 5)
{
    obj_add(npc_coord, rune_longsword, 1, ^lootdrop_duration);
    return();
}
`;
    const d = parseDrops(text, 'd.rs2').find(x => x.trigger === 'testdragon')!;
    expect(d.rolls.map(r => [r.table ?? r.item, r.chance * 128])).toEqual([['ultrarare_getitem', 1], ['rune_longsword', 4]]);
    expect(d.always.map(a => [a.item, a.conditional])).toEqual([['death_drop', false], ['dragon_platelegs', true]]);
});

test('a ~random_range(a, b) count keeps both ends instead of becoming 1', () => {
    const text = `[ai_queue3,testkbd]
def_int $r = random(128);
if ($r < 10) {
    obj_add(npc_coord, coins, ~random_range(100, 500), ^lootdrop_duration);
}
`;
    const roll = parseDrops(text, 'k.rs2').find(x => x.trigger === 'testkbd')!.rolls[0]!;
    expect([roll.item, roll.count, roll.countMax]).toEqual(['coins', 100, 500]);
});

// The shapes of drop tables/scripts/shared_droptables.rs2: an early return before the roll, a die set in both arms of
// an if, a nested `$random < T &` narrowing inside a slot, a `$drop = item` chain read by a later return, and a switch.
const PROCS = `[proc,herbs]()(namedobj, int)
if(map_members = ^false) {
    return (coins, 10);
}
def_int $random = 0;
$random = random(128);
if ($random < 32) {
    return (unidentified_guam, 1);
} else if ($random < 128) {
    return (unidentified_dwarf_weed, 1);
}

[proc,jewels]()(namedobj, int)
def_int $random = 0;
if (inv_total(worn, ring_of_wealth) > 0 & map_members = ^true) {
    $random = random(65);
} else {
    $random = random(128);
}
if ($random < 32) {
    return (uncut_sapphire, 1);
} else if ($random < 59) {
    if (map_members = ^true) {
        return (rune_javelin, 5);
    }
} else if ($random < 65) {
    if (map_members = ^true) {
        if ($random < 62 & %legendsquest = ^legends_complete) {
            return (~mega);
        }
        if (coordz(coord) > 6400) {
            return (chaos_talisman, 1);
        }
    }
}

[proc,ultra]()(namedobj, int)
def_int $random = 0;
$random = random(128);
if ($random < 113) {
    return (~jewels);
} else if ($random < 128) {
    return (~mega);
}

[proc,mega]()(namedobj, int)
def_int $random = random(128);
def_namedobj $drop = null;
if ($random < 8) { $drop = rune_spear; }
else if ($random < 12) { $drop = dragonshield_a; }
else if ($random < 15) { $drop = dragon_spear; }
if ($drop ! null) {
    session_log(^log_adventure, "x");
    return ($drop, 1);
}

[proc,junk]()(namedobj, int)
switch_int (random(8)) {
    case 0 : return(digsitearrow, 1);
    case 1 : return(old_boot, 1);
    case default : return(pot_empty, 1);
}

[proc,helper](namedobj $obj)(namedobj, int)
return($obj, 1);
`;

test('shared drop procs: slot chances, early returns, nested narrowing, $drop chains and switch cases', () => {
    const p = parseDropProcs(PROCS, 's.rs2');
    const rows = (k: string) => p.get(k)!.map(r => [r.item ?? '~' + r.table, r.count, r.chance * (k === 'junk' ? 8 : 128), r.conditional]);
    expect(rows('herbs')).toEqual([['coins', 10, 128, true], ['unidentified_guam', 1, 32, false], ['unidentified_dwarf_weed', 1, 96, false]]);
    expect(rows('jewels')).toEqual([['uncut_sapphire', 1, 32, false], ['rune_javelin', 5, 27, true], ['~mega', 1, 3, true], ['chaos_talisman', 1, 6, true]]);
    expect(rows('mega')).toEqual([['rune_spear', 1, 8, false], ['dragonshield_a', 1, 4, false], ['dragon_spear', 1, 3, false]]);
    expect(rows('junk')).toEqual([['digsitearrow', 1, 1, false], ['old_boot', 1, 1, false], ['pot_empty', 1, 6, false]]);
    expect(p.get('mega')!.map(r => r.src)).toEqual(['s.rs2:49', 's.rs2:50', 's.rs2:51']);
    expect(p.get('herbs')![0]!.step).toBe('herbs: if map_members = ^false then coins 1/1');
    expect(p.has('helper')).toBe(false);
});

test('a roll on a shared proc lists every item reachable through it, with the chance and steps of each path', () => {
    const drops = parseDrops(`[ai_queue3,testdemon]
def_int $random = random(128);
if ($random < 127) {
    obj_add(npc_coord, coins, 132, ^lootdrop_duration);
} else if ($random < 128) {
    obj_add(npc_coord, ~ultra, ^lootdrop_duration);
}
`, 'd.rs2');
    expandProcItems(drops, parseDropProcs(PROCS, 's.rs2'));
    const [coins, ultra] = drops[0]!.rolls;
    expect(coins!.items).toBeUndefined();
    expect(ultra!.src).toBe('d.rs2:6');
    const spears = ultra!.items!.filter(i => i.item === 'dragon_spear');
    expect(spears.map(i => [i.chance, i.conditional, i.path])).toEqual([
        [(1 / 128) * (113 / 128) * (3 / 128) * (3 / 128), true, 'ultra: random(128) < 113 then jewels 113/128; jewels: random(128) < 62 then mega 3/128; mega: random(128) < 15 then dragon_spear 3/128'],
        [(1 / 128) * (15 / 128) * (3 / 128), false, 'ultra: random(128) < 128 then mega 15/128; mega: random(128) < 15 then dragon_spear 3/128'],
    ]);
    expect(spears[0]!.src).toBe('s.rs2:51');
});
