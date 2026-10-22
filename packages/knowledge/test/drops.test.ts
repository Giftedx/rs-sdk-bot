import { test, expect } from 'bun:test';
import { parseDrops } from '../src/drops';

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
