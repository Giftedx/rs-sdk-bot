import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { actionLabel, compactItemSources, compactNpcDrops, itemSources, mapIcons, npcDrops, pretty, thinSourceTiles, type SourceCost } from './gen-map-data';

test('npc drops retain exact spawn identities and separate source facts instead of the highest chance', () => {
    const out = npcDrops([
        { item: 'big_bones', id: 532, sources: [{ kind: 'drop', npc: 'death_drop', chance: 1, countMin: 1, countMax: 1, conditional: false, places: [{ npc: 'giant' }] }] },
        { item: 'iron_bar', id: 2351, sources: [0.01, 0.02].map((chance, i) => ({ kind: 'drop', npc: 'giant', chance, countMin: 1, countMax: 1, conditional: false, src: 'table:' + i, places: [{ npc: 'giant' }] })) },
    ], names, [{ id: 111, debugname: 'giant', name: 'Giant' }, { id: 112, debugname: 'giant2', name: 'Giant' }]);
    expect(Object.keys(out.byId)).toEqual(['111']);
    expect(out.byId['111']![0]).toMatchObject({ id: 532, name: 'Big bones', summary: 'quantity 1 · always' });
    const iron = out.byId['111']![1]!;
    expect(iron.summary).toBe('multiple table entries');expect(iron.facts.map(f => f.chance)).toEqual([0.01, 0.02]);
    expect(out.byName.giant).toBeUndefined();
});

test('NPC names alias only complete equal facts across every catalogue variant, including unspawned variants', () => {
    const catalogue = [{ id: 1, debugname: 'one', name: 'Same' }, { id: 2, debugname: 'two', name: 'Same' }];
    const source = { kind: 'drop', npc: 'death_drop', chance: 1, countMin: 1, countMax: 1, conditional: false, src: 'table:1', places: [{ npc: 'one' }, { npc: 'two' }] };
    const item = { item: 'big_bones', id: 532, sources: [source] };
    const equal = npcDrops([item], names, catalogue);
    expect(equal.byName.same).toEqual(equal.byId['1']);
    expect(npcDrops([item], names, [...catalogue, { id: 3, debugname: 'unspawned', name: 'Same' }]).byName.same).toBeUndefined();
    const differing = npcDrops([{ ...item, sources: [{ ...source, places: [{ npc: 'one' }] }, { ...source, countMin: 3, countMax: 3, places: [{ npc: 'two' }] }] }], names, catalogue);
    expect(differing.byName.same).toBeUndefined();
    expect(differing.byId['1']![0]!.facts[0]!.quantity).toBe('quantity 1');
    expect(differing.byId['2']![0]!.facts[0]!.quantity).toBe('quantity 3');
    const unresolved = npcDrops([{ ...item, sources: [{ ...source, npc: 'one', places: [{ npc: 'unknown' }] }] }], names, catalogue);
    expect(unresolved).toEqual({ byId: {}, byName: {} });
});

test('drop display keeps common entries before alphabetical rare entries without combining their rates', () => {
    const rows = npcDrops([
        { id: 1, item: 'aardvark', sources: [{ kind: 'drop', chance: 0.01, conditional: false, places: [{ npc: 'one' }] }] },
        { id: 2, item: 'zebra', sources: [0.5, 0.1].map(chance => ({ kind: 'drop', chance, conditional: false, places: [{ npc: 'one' }] })) },
    ], names, [{ id: 1, name: 'One', debugname: 'one' }]).byId['1']!;
    expect(rows.map(row => row.id)).toEqual([2, 1]);
    expect(rows[0]!.summary).toBe('multiple table entries');
    expect(rows[0]!.facts.map(fact => fact.chance).sort()).toEqual([0.1, 0.5]);
});

test('pinned Jogre big-bone branches remain conditional quantity facts with their source traces', () => {
    const knowledge = JSON.parse(readFileSync(new URL('../../knowledge/item-sources.json', import.meta.url), 'utf8'));
    const catalogue = JSON.parse(readFileSync(new URL('../../knowledge/npcs.json', import.meta.url), 'utf8'));
    const item = knowledge.items.find((i: any) => i.item === 'big_bones');
    const row = npcDrops([item], names, catalogue).byId['113']!.find(r => r.id === item.id)!;
    expect(row.summary).toBe('multiple table entries');expect(row.facts).toHaveLength(2);
    expect(row.facts.map(f => f.countMin).sort()).toEqual([1, 3]);
    expect(row.facts.every(f => f.chance === 1 && f.conditional === true && f.countMin === f.countMax)).toBe(true);
    expect(row.facts.map(f => f.condition).sort()).toEqual(['} else if ($random < 75) {', '} else if ($random < 77) {']);
    for (const fact of row.facts) {
        expect(fact.text).toContain('conditional');expect(fact.text).not.toContain('always');
        expect(fact.src).toMatch(/jogre\.rs2:/);expect(fact.text).toContain(fact.src!);
    }
    const sources = item.sources.filter((s: any) => s.kind === 'drop' && !s.blocked && s.places?.some((p: any) => p.npc === 'jogre'));
    const labels = itemSources([{ ...item, sources }], names)[String(item.id)]!.map(r => r[1]);
    expect(labels).toHaveLength(2);expect(labels.some(label => label.includes('quantity 1'))).toBe(true);
    expect(labels.some(label => label.includes('quantity 3'))).toBe(true);
    expect(labels.every(label => label.includes('conditional') && !label.includes('always'))).toBe(true);
});

test('drop source provenance, gates and quantity ranges stay attached to each separate fact', () => {
    const source = { kind: 'drop', npc: 'category', chance: 0.5, countMin: 2, countMax: 5, conditional: true,
        condition: 'quest stage < 5', gate: 'members access', src: 'table:1', via: 'rare_table', places: [{ npc: 'one' }] };
    const row = npcDrops([{ item: 'big_bones', id: 532, sources: [source, { ...source, via: 'other_table' }] }], names,
        [{ id: 1, name: 'One', debugname: 'one' }]).byId['1']![0]!;
    expect(row.summary).toBe('multiple table entries');expect(row.facts).toHaveLength(2);
    for (const fact of row.facts) {
        expect(fact).toMatchObject({ chance: 0.5, countMin: 2, countMax: 5, quantity: 'quantity 2–5', conditional: true,
            condition: source.condition, gate: source.gate, src: source.src, trigger: source.npc });
        expect(fact.text).toContain('Condition: quest stage < 5');expect(fact.text).toContain('Requires: members access');
        expect(fact.text).toContain('Source: table:1');expect(fact.text).toContain('Via: ' + fact.via);
    }
    const single = npcDrops([{ item: 'big_bones', id: 532, sources: [source] }], names,
        [{ id: 1, name: 'One', debugname: 'one' }]).byId['1']![0]!;
    expect(single.summary).toBe('quantity 2–5 · 1/2 · conditional');
    expect(single.summary).not.toMatch(/stage|access|table/);
});

test('drop facts retain full long conditions for identity and aliases while display strings stay bounded', () => {
    const prefix = '<condition> '.repeat(100), catalogue = [{ id: 1, debugname: 'one', name: 'Same' }, { id: 2, debugname: 'two', name: 'Same' }];
    const source = { kind: 'drop', npc: 'death_drop', chance: 1, countMin: 1, countMax: 1, conditional: true, src: 'table:1' };
    const sources = ['one', 'two'].map((npc, i) => ({ ...source, condition: prefix + i, places: [{ npc, tiles: [{ x: i + 1, z: 2, level: 0 }] }] }));
    const item = { item: 'big_bones', id: 532, sources };
    const out = npcDrops([item], names, catalogue);
    expect(out.byName.same).toBeUndefined();
    expect(out.byId['1']![0]!.facts[0]!.condition).toBe(prefix + '0');
    expect(out.byId['2']![0]!.facts[0]!.condition).toBe(prefix + '1');
    expect(out.byId['1']![0]!.summary.length).toBeLessThanOrEqual(201);
    const rows = itemSources([item], names)['532']!;
    expect(rows).toHaveLength(2);expect(rows.map(r => r[2])).toEqual([[1, 2, 0], [2, 2, 0]]);
    expect(rows[0]![1]).toContain(prefix.slice(0, 800) + '…');expect(rows[0]![1]).not.toContain('always');
});

test('unknown drop chances and conditions do not become guarantees and blocked sources stay excluded', () => {
    const catalogue = [{ id: 1, debugname: 'one', name: 'One' }], source = { kind: 'drop', npc: 'category', places: [{ npc: 'one' }] };
    for (const chance of [-1, NaN, Infinity, '1', undefined, 2]) {
        const fact = npcDrops([{ item: 'big_bones', id: 532, sources: [{ ...source, chance }] }], names, catalogue).byId['1']![0]!.facts[0]!;
        expect(fact.chance).toBeNull();expect(fact.text).toContain('chance unknown');expect(fact.text).not.toContain('always');
    }
    const missing = npcDrops([{ item: 'big_bones', id: 532, sources: [{ ...source, chance: 1 }] }], names, catalogue).byId['1']![0]!;
    expect(missing.summary).toContain('conditions unknown');expect(missing.summary).not.toContain('always');
    expect(npcDrops([{ item: 'big_bones', id: 532, sources: [{ ...source, chance: 1, blocked: 'no spawn' }] }], names, catalogue)).toEqual({ byId: {}, byName: {} });
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
        { kind: 'drop', npc: 'giant', combat: 28, chance: 0.0078125, countMin: 1, countMax: 1, conditional: false, places: [{ tiles: [{ x: 3100, z: 9840, level: 0 }] }] },
        { kind: 'make', skill: 'smithing', level: 75, inputs: [{ item: 'iron_bar', count: 1 }] },
        { kind: 'ge', blocked: '0 sellers' },
    ] }], names);
    expect(out).toEqual({ '892': [
        ['shop', 'Shop: Hickton · base value 40 gp', [2822, 3442, 0]],
        ['make', 'Smithing 75: from Iron bar', []],
        ['drop', 'Drop: Giant (level 28) · quantity 1 · 1/128', [3100, 9840, 0]],
    ] });
});

test('item sources: drops by chance, and two NPC variants of one name are one row with both places', () => {
    const out = itemSources([{ item: 'big_bones', id: 532, sources: [
        { kind: 'drop', npc: 'giant', combat: 28, chance: 0.5, countMin: 1, countMax: 1, conditional: false, places: [{ tiles: [{ x: 1, z: 1, level: 0 }] }] },
        { kind: 'drop', npc: 'jogre', combat: 53, chance: 1, countMin: 1, countMax: 1, conditional: false, places: [{ tiles: [{ x: 2, z: 2, level: 0 }] }] },
        { kind: 'drop', npc: 'jogre', combat: 53, chance: 1, countMin: 1, countMax: 1, conditional: false, places: [{ tiles: [{ x: 3, z: 3, level: 0 }] }] },
        { kind: 'gather', skill: 'mining', level: 30, rung: 'mining/coal', places: [{ loc: 'coalrock1', tiles: [] }, { loc: 'macro_coalrock', tiles: [] }] },
    ] }], names);
    expect(out['532']).toEqual([
        ['gather', 'Mining 30: Coal rock', []],
        ['drop', 'Drop: Jogre (level 53) · quantity 1 · always', [2, 2, 0, 3, 3, 0]],
        ['drop', 'Drop: Giant (level 28) · quantity 1 · 1/2', [1, 1, 0]],
    ]);
});

test('item sources retain helper-time evidence without changing their labels, gates or pins', () => {
    const note = 'mine_copper, measured level 1, bronze pickaxe; three practice runs, including travel';
    const cost = { helperTicksPerUnit: 16.6, ticksBasis: 'measured', ticksNote: note, privateValue: 'private-cost' };
    const source = { kind: 'gather', skill: 'mining', level: 1, rung: 'mining/copper_rock_table', gate: 'access gate',
        places: [{ loc: 'copperrock1', tiles: [{ x: 3229, z: 3145, level: 0 }] }], cost };
    const row = itemSources([{ item: 'copper_ore', id: 436, sources: [source] }], names)['436']![0]!;
    expect(row.slice(0, 3)).toEqual(['gather', 'Mining 1: Copper rock · Requires: access gate', [3229, 3145, 0]]);
    expect(row[3]).toEqual({ helperTicksPerUnit: 16.6, ticksBasis: 'measured', ticksNote: note });
});

test('item sources combine places only when the source timing basis, value and conditions agree', () => {
    const base = { helperTicksPerUnit: 1, ticksBasis: 'model' as const, ticksNote: 'ready stock; travel excluded' };
    const costs = [base, base, { ...base, ticksBasis: 'measured' as const }, { ...base, helperTicksPerUnit: 2 }, { ...base, ticksNote: 'travel included' }];
    const sources = costs.map((cost, index) => ({ kind: 'shop', shop: 'shop', basePrice: 10, cost,
        owners: [{ npc: 'hickton', tiles: [{ x: index + 1, z: 3000, level: 0 }] }] }));
    const rows = itemSources([{ item: 'rune_arrow', id: 892, sources }], names)['892']!;
    expect(rows).toHaveLength(4);
    expect(rows.map(r => r[2])).toEqual([[1, 3000, 0, 2, 3000, 0], [3, 3000, 0], [4, 3000, 0], [5, 3000, 0]]);
    expect(rows.map(r => r[3])).toEqual([base, costs[2], costs[3], costs[4]]);
});

test('conditions beyond the display-note limit keep different sources and their coordinates separate', () => {
    const prefix = 'shared condition; '.repeat(60);
    const sources = ['travel included', 'travel excluded'].map((condition, index) => ({
        kind: 'shop', shop: 'shop', basePrice: 10, owners: [{ npc: 'hickton', tiles: [{ x: index + 1, z: 3000, level: 0 }] }],
        cost: { helperTicksPerUnit: 1, ticksBasis: 'model', ticksNote: prefix + condition },
    }));
    const rows = itemSources([{ item: 'rune_arrow', id: 892, sources }], names)['892']!;
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r[2])).toEqual([[1, 3000, 0], [2, 3000, 0]]);
    expect(rows.map(r => r[3]?.ticksNote)).toEqual([prefix.slice(0, 800) + '…', prefix.slice(0, 800) + '…']);
});

test('unknown or malformed helper times never become zero-cost facts and notes stay bounded', () => {
    const source = (cost: unknown) => itemSources([{ item: 'rune_arrow', id: 892,
        sources: [{ kind: 'make', skill: 'smithing', level: 75, inputs: [], cost }] }], names)['892']![0]!;
    for (const helperTicksPerUnit of [undefined, null, '0', -1, NaN, Infinity])
        expect(source({ helperTicksPerUnit, ticksBasis: 'model' })).toHaveLength(3);
    for (const ticksBasis of [undefined, null, 'unknown', 'estimated', 1])
        expect(source({ helperTicksPerUnit: 0, ticksBasis })).toHaveLength(3);
    expect(source({ helperTicksPerUnit: 0, ticksBasis: 'measured' })[3]).toEqual({ helperTicksPerUnit: 0, ticksBasis: 'measured' });
    expect(source({ helperTicksPerUnit: 1, ticksBasis: 'content', ticksNote: 'x'.repeat(1000) })[3]?.ticksNote).toBe('x'.repeat(800) + '…');
});

test('the apple pie shop keeps its modeled purchase cost and conditional restock apart from base value', () => {
    const knowledge = JSON.parse(readFileSync(new URL('../../knowledge/item-sources.json', import.meta.url), 'utf8'));
    const item = knowledge.items.find((i: any) => i.item === 'apple_pie');
    const shop = item.sources.find((s: any) => s.kind === 'shop' && s.shop === 'generallegends');
    expect(shop.basePrice).toBe(30);
    expect(shop.priceAtFullStock).toBe(46);
    const row = itemSources([{ ...item, sources: [shop] }], names)['2323']![0]!;
    expect(row[1]).toBe('Shop: Fionella · base value 30 gp');
    expect(row[2]).toEqual([2725, 3378, 1]);
    expect(row[3]).toEqual({
        helperTicksPerUnit: 0.1, ticksBasis: 'model', ticksNote: 'buy-10 button at one click per tick; travel and banking not included',
        coinsPerUnit: 46.6, coinsBasis: 'model', coinsNote: 'mean price of the first 5 bought from full stock (shop.rs2 calc_shop_value, obj cost 30, sell 1550, delta 10)',
        realSecondsPerUnit: 80, realBasis: 'content', realNote: 'after the 5 in stock: +1 unit per 200 ticks (World.ts restock) at 0.4 s per tick',
    });
    expect(row[3]).not.toHaveProperty('risk');
});

test('known cash and wall wait survive unknown helper timing independently, including explicit zero', () => {
    const cost = { helperTicksPerUnit: null, ticksBasis: 'unknown', ticksNote: 'trip not measured',
        coinsPerUnit: 0, coinsBasis: 'content', coinsNote: 'no coins spent',
        realSecondsPerUnit: 0, realBasis: 'model', realNote: 'no additional wait under this condition',
        risk: 0, riskBasis: 'content', privateValue: 'excluded' };
    const row = itemSources([{ id: 526, sources: [{ kind: 'pickup', spawns: 1, tiles: [], cost }] }], names)['526']![0]!;
    expect(row[3]).toEqual({ coinsPerUnit: 0, coinsBasis: 'content', coinsNote: 'no coins spent',
        realSecondsPerUnit: 0, realBasis: 'model', realNote: 'no additional wait under this condition' });
    const priced = { coinsPerUnit: 12, coinsBasis: 'measured', coinsNote: 'source snapshot', realSecondsPerUnit: null, realBasis: 'unknown' };
    expect(itemSources([{ id: 526, sources: [{ kind: 'pickup', tiles: [], cost: priced }] }], names)['526']![0]![3])
        .toEqual({ coinsPerUnit: 12, coinsBasis: 'measured', coinsNote: 'source snapshot' });
});

test('unknown or malformed cash and wall wait do not become zero or suppress valid helper evidence', () => {
    const project = (cost: unknown) => itemSources([{ id: 526, sources: [{ kind: 'pickup', tiles: [], cost }] }], names)['526']![0]!;
    const ticks: SourceCost = { helperTicksPerUnit: 1, ticksBasis: 'content' };
    for (const [valueKey, basisKey] of [['coinsPerUnit', 'coinsBasis'], ['realSecondsPerUnit', 'realBasis']]) {
        for (const value of [undefined, null, '0', -1, NaN, Infinity]) {
            expect(project({ [valueKey!]: value, [basisKey!]: 'model' })).toHaveLength(3);
            expect(project({ ...ticks, [valueKey!]: value, [basisKey!]: 'model' })[3]).toEqual(ticks);
        }
        for (const basis of [undefined, null, 'unknown', 'estimated', 1])
            expect(project({ [valueKey!]: 0, [basisKey!]: basis })).toHaveLength(3);
    }
    expect(itemSources([{ id: 526, sources: [{ kind: 'shop', shop: 'shop', basePrice: -1, owners: [] }] }], names)['526']![0]![1]).toBe('Shop: Shop');
});

test('same shop labels retain distinct cash and restock facts with their own places', () => {
    const base: SourceCost = { helperTicksPerUnit: 0.1, ticksBasis: 'model', coinsPerUnit: 4.107, coinsBasis: 'model', coinsNote: 'first 28 bought from full stock',
        realSecondsPerUnit: 4, realBasis: 'content', realNote: 'after the 2000 in stock' };
    const costs: SourceCost[] = [base, base, { ...base, coinsPerUnit: 5.179 }, { ...base, coinsBasis: 'measured' }, { ...base, coinsNote: 'first 5 bought from full stock' },
        { ...base, realSecondsPerUnit: 20 }, { ...base, realBasis: 'model' }, { ...base, realNote: 'after the 200 in stock' }];
    const sources = costs.map((cost, index) => ({ kind: 'shop', shop: 'shop', basePrice: 4, cost,
        owners: [{ npc: 'hickton', tiles: [{ x: index + 1, z: 3000, level: 0 }] }] }));
    const rows = itemSources([{ id: 556, sources }], names)['556']!;
    expect(rows).toHaveLength(7);
    expect(rows.map(r => r[2])).toEqual([[1, 3000, 0, 2, 3000, 0], [3, 3000, 0], [4, 3000, 0], [5, 3000, 0], [6, 3000, 0], [7, 3000, 0], [8, 3000, 0]]);
    expect(rows.map(r => r[3])).toEqual([base, ...costs.slice(2)]);
});

test('full cash and wall-wait conditions identify sources while their emitted notes stay bounded', () => {
    const prefix = 'shared condition; '.repeat(60);
    for (const noteKey of ['coinsNote', 'realNote']) {
        const sources = ['full stock', 'depleted stock'].map((condition, index) => ({
            kind: 'shop', shop: 'shop', basePrice: 10, owners: [{ npc: 'hickton', tiles: [{ x: index + 1, z: 3000, level: 0 }] }],
            cost: { coinsPerUnit: 10, coinsBasis: 'model', realSecondsPerUnit: 40, realBasis: 'content', [noteKey]: prefix + condition },
        }));
        const rows = itemSources([{ id: 526, sources }], names)['526']!;
        expect(rows).toHaveLength(2);
        expect(rows.map(r => r[2])).toEqual([[1, 3000, 0], [2, 3000, 0]]);
        expect(rows.map(r => r[3]?.[noteKey as 'coinsNote' | 'realNote'])).toEqual([prefix.slice(0, 800) + '…', prefix.slice(0, 800) + '…']);
    }
});

test('item-source labels retain access gates and map pins while blocked sources remain excluded', () => {
    const gate = 'quest script: may give the item once or only at a quest stage';
    const out = itemSources([{ item: 'blankrune', id: 1436, sources: [
        { kind: 'gather', skill: 'mining', level: 1, rung: 'mining/blankrunestone', gate: 'quest Rune Mysteries', places: [{ loc: 'blankrunestone', tiles: [{ x: 2891, z: 4847, level: 0 }] }] },
        { kind: 'action', trigger: 'opnpc1', subject: 'head_wizard', gate, places: [{ tiles: [{ x: 3100, z: 3100, level: 0 }] }] },
        { kind: 'action', trigger: 'opnpc1', subject: 'head_wizard', places: [{ tiles: [{ x: 3200, z: 3200, level: 0 }] }] },
        { kind: 'shop', gate: 'quest access', blocked: 'no owner spawn' },
    ] }], names);
    expect(out['1436']).toEqual([
        ['gather', 'Mining 1: Blankrunestone · Requires: quest Rune Mysteries', [2891, 4847, 0]],
        ['action', `Talk to Head wizard · Requires: ${gate}`, [3100, 3100, 0]],
        ['action', 'Talk to Head wizard', [3200, 3200, 0]],
    ]);
    const shipped = JSON.parse(readFileSync(new URL('./client-assets/item-sources.json', import.meta.url), 'utf8'));
    expect(shipped['1436'][0][1]).toContain('quest Rune Mysteries');
});

test('thinSourceTiles leaves small sources intact and thins dense tile lists by 16x16 grid and floor', () => {
    const small = [3000, 3000, 0, 3001, 3001, 0];
    expect(thinSourceTiles(small)).toEqual(small);

    const dense: number[] = [];
    for (let i = 0; i < 60; i++) dense.push(3200 + (i % 8), 3200 + Math.floor(i / 8), 0);
    dense.push(3201, 3201, 1); // same X/Z cell on floor 1 stays distinct
    dense.push(3220, 3220, 0); // next 16x16 cell on floor 0 stays distinct
    expect(thinSourceTiles(dense)).toEqual([3200, 3200, 0, 3201, 3201, 1, 3220, 3220, 0]);
    const full = { '1511': [['gather', 'Tree', dense] as [string, string, number[]]] };
    expect(compactItemSources(full)).toEqual({ '1511': [['gather', 'Tree', [3200, 3200, 0, 3201, 3201, 1, 3220, 3220, 0]]] });
});

test('compactNpcDrops retains byId rows, summaries, and fact display text while shedding unused structured fields', () => {
    const full = npcDrops([
        { item: 'big_bones', id: 532, sources: [{ kind: 'drop', npc: 'death_drop', chance: 1, countMin: 1, countMax: 1, conditional: false, src: 'table:1', places: [{ npc: 'one' }] }] },
    ], names, [{ id: 1, debugname: 'one', name: 'One' }]);
    const compacted = compactNpcDrops(full);
    expect(compacted.byName).toEqual({});
    expect(compacted.byId['1']).toEqual([{
        id: 532,
        name: 'Big bones',
        summary: 'quantity 1 · always',
        facts: [{ text: full.byId['1']![0]!.facts[0]!.text }],
    }]);
});
