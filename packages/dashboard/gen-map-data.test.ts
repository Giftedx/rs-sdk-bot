import { expect, test } from 'bun:test';
import { actionLabel, itemSources, mapIcons, npcDrops, pretty } from './gen-map-data';

test('npc drops: the route items each NPC drops, most likely first, the higher chance for two NPCs of one name', () => {
    expect(npcDrops([
        { item: 'big_bones', sources: [{ kind: 'drop', npc: 'giant', chance: 1 }, { kind: 'shop', owners: [] }] },
        { item: 'iron_bar', sources: [{ kind: 'drop', npc: 'giant', chance: 0.01 }, { kind: 'drop', npc: 'giant', chance: 0.02 }, { kind: 'drop', npc: 'hickton', chance: 0, blocked: null }] },
    ], { npc: (d: string) => pretty(d), item: (d: string) => pretty(d) })).toEqual({ Giant: [['Big bones', 'always'], ['Iron bar', '1/50']] });
});

const names = { npc: (d: string) => ({ hickton: 'Hickton', giant: 'Giant' } as Record<string, string>)[d] ?? pretty(d), item: (d: string) => ({ iron_bar: 'Iron bar', rune_arrow: 'Rune arrow' } as Record<string, string>)[d] ?? pretty(d) };

test('map icons: teleport destinations, agility shortcuts with their level and shop keepers, one row a tile and kind', () => {
    const icons = mapIcons(
        [{ kind: 'spell', name: 'Varrock teleport', to: [{ candidates: [{ x: 3213, z: 3424, level: 0 }] }] }, { name: 'Broken', to: [] }],
        [{ kind: 'shortcut', optionText: 'walk-across', from: { x: 2580, z: 9513, level: 0 }, requires: { skill: { level: 40 } } }, { kind: 'course', from: { x: 1, z: 1, level: 0 } }],
        [{ sources: [{ kind: 'shop', owners: [{ npc: 'hickton', tiles: [{ x: 2822, z: 3442, level: 0 }, { x: 2822, z: 3442, level: 0 }] }] }] }],
        names);
    expect(icons).toEqual([[2580, 9513, 0, 'a', 'Agility shortcut (level 40): Walk-across', ['agility', 40]], [2822, 3442, 0, 's', 'Shop: Hickton'], [3213, 3424, 0, 't', 'Varrock teleport']]);
});

test('map icons: a lever, a portal or the Ring of life is a fixed transport (p), not a teleport from anywhere (t)', () => {
    const to = (x: number) => [{ candidates: [{ x, z: 3000, level: 0 }] }];
    const icons = mapIcons([{ kind: 'lever', name: 'Ardougne lever to Wilderness', to: to(1) }, { kind: 'jewellery', name: 'Ring of life', to: to(2) }, { kind: 'spell', name: 'Falador teleport', to: to(3) }], [], [], names);
    expect(icons.map(i => i[3])).toEqual(['p', 'p', 't']);
});

test('map icons: a teleport spell carries its Magic level', () => {
    const icons = mapIcons([{ kind: 'spell', name: 'Varrock teleport', requires: [{ type: 'skill', skill: 'magic', level: 25 }, { type: 'note', text: 'x' }], to: [{ candidates: [{ x: 3213, z: 3424, level: 0 }] }] }], [], [], names);
    expect(icons).toEqual([[3213, 3424, 0, 't', 'Varrock teleport', ['magic', 25]]]);
});

test('action labels: talk, use an item on, interact, quest reward; debug and tutorial triggers are no action', () => {
    expect([
        actionLabel('opnpc1', 'head_wizard', names), actionLabel('opnpcu', 'sheep', names), actionLabel('oplocu', 'crystal_chestclosed', names),
        actionLabel('opheldu', 'iron_bar', names), actionLabel('oploc2', 'flax', names), actionLabel('queue', 'waterfall_quest_complete', names),
        actionLabel('debugproc', 'giverunes', names), actionLabel('tutorial', '_', names),
    ]).toEqual(['Talk to Head wizard', 'Use an item on Sheep', 'Use an item on Crystal chestclosed', 'Use an item on Iron bar', 'Interact with Flax', 'Quest reward: Waterfall quest', null, null]);
});

test('map icons: one icon for each destination option of a teleport, named with the option', () => {
    const icons = mapIcons([{ kind: 'jewellery', name: 'Amulet of glory', to: [{ option: 'Edgeville', candidates: [{ x: 3087, z: 3496, level: 0 }] }, { option: 'Karamja', candidates: [{ x: 2918, z: 3176, level: 0 }] }] }], [], [], names);
    expect(icons.map(i => i[4])).toEqual(['Amulet of glory: Karamja', 'Amulet of glory: Edgeville']);
});

test('item sources: by item id, with a label for each kind and the places as flat tiles; blocked sources left out', () => {
    const out = itemSources([{ item: 'rune_arrow', id: 892, sources: [
        { kind: 'shop', shop: 'archeryshop2', basePrice: 40, owners: [{ npc: 'hickton', tiles: [{ x: 2822, z: 3442, level: 0 }] }] },
        { kind: 'drop', npc: 'giant', combat: 28, chance: 0.0078125, places: [{ tiles: [{ x: 3100, z: 9840, level: 0 }] }] },
        { kind: 'make', skill: 'smithing', level: 75, inputs: [{ item: 'iron_bar', count: 1 }] },
        { kind: 'ge', blocked: '0 sellers' },
    ] }], names);
    expect(out).toEqual({ '892': [
        ['shop', 'Shop: Hickton · 40 gp', [2822, 3442, 0]],
        ['make', 'Smithing 75: from Iron bar', []],
        ['drop', 'Drop: Giant (level 28) · 1/128', [3100, 9840, 0]],
    ] });
});

test('item sources: drops by chance, and two NPC variants of one name are one row with both places', () => {
    const out = itemSources([{ item: 'big_bones', id: 532, sources: [
        { kind: 'drop', npc: 'giant', combat: 28, chance: 0.5, places: [{ tiles: [{ x: 1, z: 1, level: 0 }] }] },
        { kind: 'drop', npc: 'jogre', combat: 53, chance: 1, places: [{ tiles: [{ x: 2, z: 2, level: 0 }] }] },
        { kind: 'drop', npc: 'jogre', combat: 53, chance: 1, places: [{ tiles: [{ x: 3, z: 3, level: 0 }] }] },
        { kind: 'gather', skill: 'mining', level: 30, rung: 'mining/coal', places: [{ loc: 'coalrock1', tiles: [] }, { loc: 'macro_coalrock', tiles: [] }] },
    ] }], names);
    expect(out['532']).toEqual([
        ['gather', 'Mining 30: Coal rock', []],
        ['drop', 'Drop: Jogre (level 53) · always', [2, 2, 0, 3, 3, 0]],
        ['drop', 'Drop: Giant (level 28) · 1/2', [1, 1, 0]],
    ]);
});
