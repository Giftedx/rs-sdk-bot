import { expect, test } from 'bun:test';
import { itemSources, mapIcons, pretty } from './gen-map-data';

const names = { npc: (d: string) => ({ hickton: 'Hickton', giant: 'Giant' } as Record<string, string>)[d] ?? pretty(d), item: (d: string) => ({ iron_bar: 'Iron bar', rune_arrow: 'Rune arrow' } as Record<string, string>)[d] ?? pretty(d) };

test('map icons: teleport destinations, agility shortcuts with their level and shop keepers, one row a tile and kind', () => {
    const icons = mapIcons(
        [{ name: 'Varrock teleport', to: [{ candidates: [{ x: 3213, z: 3424, level: 0 }] }] }, { name: 'Broken', to: [] }],
        [{ kind: 'shortcut', optionText: 'walk-across', from: { x: 2580, z: 9513, level: 0 }, requires: { skill: { level: 40 } } }, { kind: 'course', from: { x: 1, z: 1, level: 0 } }],
        [{ sources: [{ kind: 'shop', owners: [{ npc: 'hickton', tiles: [{ x: 2822, z: 3442, level: 0 }, { x: 2822, z: 3442, level: 0 }] }] }] }],
        names);
    expect(icons).toEqual([[2580, 9513, 0, 'a', 'Agility shortcut (level 40): Walk-across'], [2822, 3442, 0, 's', 'Shop: Hickton'], [3213, 3424, 0, 't', 'Varrock teleport']]);
});

test('item sources: by display name, with a label for each kind and the places as flat tiles; blocked sources left out', () => {
    const out = itemSources([{ item: 'rune_arrow', sources: [
        { kind: 'shop', shop: 'archeryshop2', basePrice: 40, owners: [{ npc: 'hickton', tiles: [{ x: 2822, z: 3442, level: 0 }] }] },
        { kind: 'drop', npc: 'giant', combat: 28, chance: 0.0078125, places: [{ tiles: [{ x: 3100, z: 9840, level: 0 }] }] },
        { kind: 'make', skill: 'smithing', level: 75, inputs: [{ item: 'iron_bar', count: 1 }] },
        { kind: 'ge', blocked: '0 sellers' },
    ] }], names);
    expect(out).toEqual({ 'Rune arrow': [
        ['shop', 'Shop: Hickton · 40 gp', [2822, 3442, 0]],
        ['make', 'Smithing 75: from Iron bar', []],
        ['drop', 'Drop: Giant (level 28) · 1/128', [3100, 9840, 0]],
    ] });
});

test('item sources: drops by chance, and two NPC variants of one name are one row with both places', () => {
    const out = itemSources([{ item: 'big_bones', sources: [
        { kind: 'drop', npc: 'giant', combat: 28, chance: 0.5, places: [{ tiles: [{ x: 1, z: 1, level: 0 }] }] },
        { kind: 'drop', npc: 'jogre', combat: 53, chance: 1, places: [{ tiles: [{ x: 2, z: 2, level: 0 }] }] },
        { kind: 'drop', npc: 'jogre', combat: 53, chance: 1, places: [{ tiles: [{ x: 3, z: 3, level: 0 }] }] },
        { kind: 'gather', skill: 'mining', level: 30, rung: 'mining/coal', places: [{ loc: 'coalrock1', tiles: [] }, { loc: 'macro_coalrock', tiles: [] }] },
    ] }], names);
    expect(out['Big bones']).toEqual([
        ['gather', 'Mining 30: Coal rock', []],
        ['drop', 'Drop: Jogre (level 53) · always', [2, 2, 0, 3, 3, 0]],
        ['drop', 'Drop: Giant (level 28) · 1/2', [1, 1, 0]],
    ]);
});
