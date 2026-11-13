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
