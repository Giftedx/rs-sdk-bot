import { expect, test } from 'bun:test';
import { flowView, trackFlow } from './flow';

const status = (at: number, inventory: any[], extra: any = {}) => ({ name: 'Alpha', server: 'demo', started: 1, at, inventory, equipment: [], bankAt: 50, hp: { now: 50, max: 99 }, ...extra });

test('loot is what the pack gains and supplies what it loses, within one session', () => {
    const flows = new Map();
    trackFlow(flows, status(100, [{ name: 'Shark', count: 10 }, { name: 'Coins', count: 100 }]));
    trackFlow(flows, status(103, [{ name: 'Shark', count: 8 }, { name: 'Coins', count: 160 }, { name: 'Bones', count: 1 }]));
    trackFlow(flows, status(106, [{ name: 'Shark', count: 7 }, { name: 'Coins', count: 160 }, { name: 'Bones', count: 2 }]));
    expect(flowView(flows, 'Alpha')).toEqual({ since: 100, at: 106, loot: [{ name: 'Coins', count: 60 }, { name: 'Bones', count: 2 }], used: [{ name: 'Shark', count: 3 }] });
});

test('a bank visit, a death, a mass loss and an equip are not loot or supplies', () => {
    const flows = new Map();
    trackFlow(flows, status(100, [{ name: 'Shark', count: 10 }, { name: 'Rune scimitar', count: 1 }]));
    // Equip: the scimitar moves from the pack to worn gear.
    trackFlow(flows, status(103, [{ name: 'Shark', count: 10 }], { equipment: [{ name: 'Rune scimitar', count: 1 }] }));
    // A deposit: the bank was seen between the files.
    trackFlow(flows, status(106, [], { bankAt: 105, equipment: [{ name: 'Rune scimitar', count: 1 }] }));
    // A death: 0 hitpoints.
    trackFlow(flows, status(109, [{ name: 'Lobster', count: 5 }], { bankAt: 105, hp: { now: 0, max: 99 } }));
    trackFlow(flows, status(112, [{ name: 'Lobster', count: 5 }], { bankAt: 105 }));
    expect(flowView(flows, 'Alpha')).toBeNull();
    // After a bank visit, more than half of the kinds vanish at once.
    trackFlow(flows, status(115, [{ name: 'A', count: 1 }, { name: 'B', count: 1 }, { name: 'C', count: 1 }, { name: 'D', count: 1 }], { bankAt: 114 }));
    trackFlow(flows, status(118, [{ name: 'A', count: 1 }], { bankAt: 114 }));
    expect(flowView(flows, 'Alpha')?.used ?? []).toEqual([]);
});

test('a new session starts the counts again', () => {
    const flows = new Map();
    trackFlow(flows, status(100, [{ name: 'Shark', count: 10 }]));
    trackFlow(flows, status(103, [{ name: 'Shark', count: 9 }]));
    trackFlow(flows, status(200, [{ name: 'Shark', count: 9 }], { started: 2 }));
    expect(flowView(flows, 'Alpha')).toBeNull();
});

test('the flow keeps every item kind, so a valuable item past the 40 biggest stacks still counts', () => {
    const flows = new Map();
    const many = Array.from({ length: 41 }, (_, i) => ({ name: 'Cheap' + i, count: 100 }));
    trackFlow(flows, status(100, []));
    trackFlow(flows, status(103, [...many, { name: 'Dragon chainbody', count: 1 }]));
    const v = flowView(flows, 'Alpha')!;
    expect(v.loot.length).toBe(42);
    expect(v.loot.some(i => i.name === 'Dragon chainbody')).toBe(true);
});

test('unknown worn gear is not empty gear: known, unknown, known counts nothing', () => {
    const flows = new Map();
    trackFlow(flows, status(100, [{ name: 'Shark', count: 5 }], { equipment: [{ name: 'Rune scimitar', count: 1 }] }));
    trackFlow(flows, status(103, [{ name: 'Shark', count: 5 }], { equipment: null }));
    trackFlow(flows, status(106, [{ name: 'Shark', count: 5 }], { equipment: [{ name: 'Rune scimitar', count: 1 }] }));
    expect(flowView(flows, 'Alpha')).toBeNull();
});

test('same-name exact variants retain separate gains and consumed identities even when aggregate quantity does not change', () => {
    const flows = new Map();
    trackFlow(flows, status(100, [{ id: 1135, name: 'Dragonhide body', count: 3 }, { id: 2503, name: 'Dragonhide body', count: 2 }]));
    trackFlow(flows, status(103, [{ id: 1135, name: 'Dragonhide body', count: 1 }, { id: 2503, name: 'Dragonhide body', count: 4 }]));
    expect(flowView(flows, 'Alpha')).toEqual({ since: 100, at: 103,
        loot: [{ id: 2503, name: 'Dragonhide body', count: 2 }], used: [{ id: 1135, name: 'Dragonhide body', count: 2 }] });
    trackFlow(flows, status(106, [{ id: 2503, name: 'Dragonhide body', count: 5 }]));
    expect(flowView(flows, 'Alpha')?.loot).toEqual([{ id: 2503, name: 'Dragonhide body', count: 3 }]);
    expect(flowView(flows, 'Alpha')?.used).toEqual([{ id: 1135, name: 'Dragonhide body', count: 3 }]);
});

test('an equal-count swap between exact variants is both an observed gain and loss', () => {
    const flows = new Map();
    trackFlow(flows, status(100, [{ id: 1135, name: 'Dragonhide body', count: 1 }]));
    trackFlow(flows, status(103, [{ id: 2503, name: 'Dragonhide body', count: 1 }]));
    expect(flowView(flows, 'Alpha')?.loot).toEqual([{ id: 2503, name: 'Dragonhide body', count: 1 }]);
    expect(flowView(flows, 'Alpha')?.used).toEqual([{ id: 1135, name: 'Dragonhide body', count: 1 }]);
});

test('canonical note and pack-to-worn moves do not become activity while their observed delta metadata survives', () => {
    const flows = new Map();
    trackFlow(flows, status(100, [{ id: 1136, baseId: 1135, name: 'Dragonhide body (noted)', count: 2 }],
        { equipment: [{ id: 1135, baseId: 1135, name: 'Dragonhide body', count: 1 }] }));
    trackFlow(flows, status(103, [{ id: 1135, baseId: 1135, name: 'Dragonhide body', count: 1 }],
        { equipment: [{ id: 1136, baseId: 1135, name: 'Dragonhide body (noted)', count: 2 }] }));
    expect(flowView(flows, 'Alpha')).toBeNull();
    trackFlow(flows, status(106, [], { equipment: [{ id: 1135, baseId: 1135, name: 'Dragonhide body', count: 1 }] }));
    expect(flowView(flows, 'Alpha')?.used).toEqual([{ baseId: 1135, name: 'Dragonhide body', count: 2 }]);
    trackFlow(flows, status(109, [{ id: 1136, baseId: 1135, name: 'Dragonhide body (noted)', count: 2 }], { equipment: [] }));
    expect(flowView(flows, 'Alpha')?.loot).toEqual([{ id: 1136, baseId: 1135, name: 'Dragonhide body', count: 1 }]);
});

test('mixed raw forms retain only canonical metadata regardless of current row order', () => {
    const note = (count: number) => ({ id: 1136, baseId: 1135, name: 'Dragonhide body (noted)', count });
    const base = (count: number) => ({ id: 1135, name: 'Dragonhide body', count });
    for (const reverse of [false, true]) {
        const order = (rows: any[]) => reverse ? rows.reverse() : rows;
        const flows = new Map();
        trackFlow(flows, status(100, order([note(2), base(1)])));
        trackFlow(flows, status(103, order([note(1), base(1)])));
        expect(flowView(flows, 'Alpha')?.used).toEqual([{ baseId: 1135, name: 'Dragonhide body', count: 1 }]);
        trackFlow(flows, status(106, order([note(2), base(2)])));
        expect(flowView(flows, 'Alpha')?.loot).toEqual([{ baseId: 1135, name: 'Dragonhide body', count: 2 }]);
    }
});

test('accumulated flow cannot replace a historical raw form with a later gain or loss form', () => {
    const note = (count: number) => ({ id: 1136, baseId: 1135, name: 'Dragonhide body (noted)', count });
    const base = (count: number) => ({ id: 1135, name: 'Dragonhide body', count });
    for (const forms of [[note, base], [base, note]]) {
        const flows = new Map(), [first, next] = forms;
        trackFlow(flows, status(100, []));
        trackFlow(flows, status(103, [first!(1)]));
        expect(flowView(flows, 'Alpha')?.loot[0]?.id).toBe(first!(1).id);
        // Converting the raw form at the same quantity is not a gain or loss.
        trackFlow(flows, status(106, [next!(1)]));
        expect(flowView(flows, 'Alpha')?.loot[0]?.id).toBe(first!(1).id);
        expect(flowView(flows, 'Alpha')?.used).toEqual([]);
        trackFlow(flows, status(109, [next!(2)]));
        expect(flowView(flows, 'Alpha')?.loot).toEqual([{ baseId: 1135, name: 'Dragonhide body', count: 2 }]);
        trackFlow(flows, status(112, [next!(1)]));
        expect(flowView(flows, 'Alpha')?.used[0]?.id).toBe(next!(1).id);
        trackFlow(flows, status(115, [first!(1)]));
        trackFlow(flows, status(118, []));
        expect(flowView(flows, 'Alpha')?.used).toEqual([{ baseId: 1135, name: 'Dragonhide body', count: 2 }]);
    }
});

test('the sudden-loss threshold still counts display-name kinds rather than variant IDs', () => {
    const flows = new Map();
    const herbs = [199, 201, 203, 205].map(id => ({ id, name: 'Herb', count: 1 }));
    trackFlow(flows, status(100, herbs));
    trackFlow(flows, status(103, [{ id: 207, name: 'Herb', count: 1 }]));
    expect(flowView(flows, 'Alpha')?.used).toEqual(herbs);
    expect(flowView(flows, 'Alpha')?.loot).toEqual([{ id: 207, name: 'Herb', count: 1 }]);
    const massLoss = new Map();
    trackFlow(massLoss, status(100, ['A', 'B', 'C', 'D'].map((name, id) => ({ id, name, count: 1 }))));
    trackFlow(massLoss, status(103, [{ id: 0, name: 'A', count: 1 }]));
    expect(flowView(massLoss, 'Alpha')).toBeNull();
});

test('identity enrichment rebaselines its display-name family while unrelated supplies still count', () => {
    const flows = new Map();
    trackFlow(flows, status(100, [{ name: 'Dragonhide body', count: 2 }, { id: 385, name: 'Shark', count: 5 }]));
    trackFlow(flows, status(103, [{ id: 1135, name: 'Dragonhide body', count: 2 }, { id: 385, name: 'Shark', count: 4 }]));
    expect(flowView(flows, 'Alpha')?.loot).toEqual([]);
    expect(flowView(flows, 'Alpha')?.used).toEqual([{ id: 385, name: 'Shark', count: 1 }]);
    trackFlow(flows, status(106, [{ id: 1135, name: 'Dragonhide body', count: 3 }, { id: 385, name: 'Shark', count: 4 }]));
    expect(flowView(flows, 'Alpha')?.loot).toEqual([{ id: 1135, name: 'Dragonhide body', count: 1 }]);
    trackFlow(flows, status(109, [{ name: 'Dragonhide body', count: 3 }, { id: 385, name: 'Shark', count: 4 }]));
    trackFlow(flows, status(112, [{ id: 2503, name: 'Dragonhide body', count: 3 }, { id: 385, name: 'Shark', count: 4 }]));
    expect(flowView(flows, 'Alpha')?.loot).toEqual([{ id: 1135, name: 'Dragonhide body', count: 1 }]);
});

test('legacy accumulated rows keep their unknown identity when later observations gain IDs', () => {
    const flows = new Map();
    trackFlow(flows, status(100, []));
    trackFlow(flows, status(103, [{ name: 'Dragonhide body', count: 1 }]));
    trackFlow(flows, status(106, [{ id: 1135, name: 'Dragonhide body', count: 1 }]));
    trackFlow(flows, status(109, [{ id: 1135, name: 'Dragonhide body', count: 2 }]));
    expect(flowView(flows, 'Alpha')?.loot).toEqual([{ name: 'Dragonhide body', count: 1 }, { id: 1135, name: 'Dragonhide body', count: 1 }]);
});

test('mixed and malformed name families cannot assign ambiguous changes to an exact variant', () => {
    for (const ambiguous of [
        [{ name: 'Dragonhide body', count: 1 }, { id: 1135, name: 'Dragonhide body', count: 1 }],
        [{ id: -1, name: 'Dragonhide body', count: 2 }],
        [{ id: 1135, baseId: undefined, name: 'Dragonhide body', count: 2 }],
    ]) {
        const flows = new Map();
        trackFlow(flows, status(100, [{ id: 1135, name: 'Dragonhide body', count: 2 }]));
        trackFlow(flows, status(103, ambiguous));
        trackFlow(flows, status(106, ambiguous.map(i => ({ ...i, count: i.count + 1 }))));
        trackFlow(flows, status(109, [{ id: 2503, name: 'Dragonhide body', count: 4 }]));
        expect(flowView(flows, 'Alpha')).toBeNull();
        trackFlow(flows, status(112, [{ id: 2503, name: 'Dragonhide body', count: 5 }]));
        expect(flowView(flows, 'Alpha')?.loot).toEqual([{ id: 2503, name: 'Dragonhide body', count: 1 }]);
    }
});

test('explicit unknown worn gear rebaselines even with an equipment array; legacy undefined remains observed', () => {
    const flows = new Map();
    const worn = { id: 1333, name: 'Rune scimitar', count: 1 };
    trackFlow(flows, status(100, [{ id: 385, name: 'Shark', count: 5 }], { equipment: [worn], equipmentObserved: true }));
    trackFlow(flows, status(103, [{ id: 385, name: 'Shark', count: 4 }], { equipment: [], equipmentObserved: false }));
    trackFlow(flows, status(106, [{ id: 385, name: 'Shark', count: 3 }], { equipment: [worn], equipmentObserved: true }));
    expect(flowView(flows, 'Alpha')).toBeNull();
    trackFlow(flows, status(109, [{ id: 385, name: 'Shark', count: 2 }], { equipment: [worn] }));
    expect(flowView(flows, 'Alpha')?.used).toEqual([{ id: 385, name: 'Shark', count: 1 }]);
});

test('exact rows keep bank, death, session and repeated-observation guards', () => {
    const flows = new Map();
    const shark = (count: number) => [{ id: 385, baseId: 385, name: 'Shark', count }];
    trackFlow(flows, status(100, shark(5)));
    trackFlow(flows, status(103, shark(4), { bankAt: 102 }));
    trackFlow(flows, status(106, shark(3), { bankAt: 102, hp: { now: 0, max: 99 } }));
    trackFlow(flows, status(109, shark(2), { bankAt: 102 }));
    expect(flowView(flows, 'Alpha')).toBeNull();
    trackFlow(flows, status(112, shark(1), { bankAt: 102 }));
    trackFlow(flows, status(112, shark(8), { bankAt: 102 }));
    expect(flowView(flows, 'Alpha')?.used).toEqual([{ id: 385, baseId: 385, name: 'Shark', count: 1 }]);
    expect(flowView(flows, 'Alpha')?.loot).toEqual([]);
    trackFlow(flows, status(115, shark(1), { bankAt: 102, server: 'another-world' }));
    expect(flowView(flows, 'Alpha')).toBeNull();
});
