import { expect, test } from 'bun:test';
import { catalogue, plan, unitValue, type Acct, type Inputs, type Template } from '../src/autopilot';

const side = 'cloud';
const account = (name: string, skills: Record<string, number> = {}, items: Record<string, number> = {}): Acct =>
    ({ name, side, skills: { Hitpoints: 30, ...skills }, items });
const row = (item: string, short: number) => ({ item, need: short, owned: 0, short, ids: [1], holders: [] });
const supply = (id: string, item: string, perTick: number): Template =>
    ({ id, family: id, script: `scripts/${id}.ts`, role: 'supply', goal: `supply ${item}`, yields: () => [{ item, perTick }] });
const inputs = (accounts: Acct[], extra: Partial<Inputs> = {}): Inputs => ({
    side, accounts, owners: new Map(accounts.map(a => [a.name.toLowerCase(), { side }])),
    templates: catalogue(), bill: [], prices: {}, ...extra,
});

test('autopilot gives no goal value to surplus stock or unneeded coins', () => {
    expect(unitValue('lobster', [row('lobster', 0)], { lobster: 150 })).toBe(0);
    expect(unitValue('coins', [], {})).toBe(0);
    expect(plan(inputs([account('Idle', { Thieving: 99 })]))[0]).toMatchObject({
        value: 0, reason: expect.stringMatching(/^vacant: .*no .*demand/),
    });
    expect(plan(inputs([account('Idle', { Thieving: 99 })]))[0]!.template).toBeUndefined();
});

test('autopilot does not train a helper for a coin farm with no finite consumer', () => {
    const templates = catalogue().filter(t => t.id === 'thieving55' || t.family === 'goldfarm');
    const [out] = plan(inputs([account('Fresh')], { templates }));
    expect(out!.template).toBeUndefined();
    expect(out!.value).toBe(0);
});

test('autopilot chooses a needed output over a faster expensive surplus output', () => {
    const templates = [supply('surplus', 'rune scimitar', 10), supply('food', 'shark', 0.01)];
    const [out] = plan(inputs([account('Helper')], { templates, bill: [row('shark', 10)], prices: { shark: 1, 'rune scimitar': 15_000 } }));
    expect(out!.template!.id).toBe('food');
});

test('autopilot reserves a finite shortfall across workers and keeps larger supply work parallel', () => {
    const templates = [supply('food', 'shark', 1)];
    const accounts = [account('A'), account('B'), account('C')];
    const assignments = (short: number) => plan(inputs(accounts, { templates, bill: [row('shark', short)], prices: { shark: 10 } }));
    const small = assignments(1);
    expect(small.filter(x => x.template)).toHaveLength(1);
    expect(small.find(x => x.template)!.value).toBeLessThanOrEqual(20 / 1000);
    expect(assignments(3000).filter(x => x.template)).toHaveLength(3);
});

test('autopilot keeps coin acquisition useful for a priced army kit and stops at funded stock', () => {
    const farmer = supply('coin-farm', 'coins', 1);
    const band: Template = { id: 'army-magic', family: 'combat', script: 'scripts/train.ts', role: 'combat', goal: 'train Magic to 99',
        tier: 'goal', band: 1, trains: { skill: 'Magic', to: 99, unlocks: [] },
        needs: { items: { 'mind rune': 10 } }, yields: () => [] };
    const army = new Set(['soldier']);
    const market = { 'mind rune': { id: 558, name: 'Mind rune', limit: 4 } };
    const run = (coin: number) => plan(inputs([account('Soldier', { Magic: 1 }, { coin })], { templates: [farmer, band], army, market }))[0]!;
    expect(run(0).template!.id).toBe('coin-farm');
    expect(run(1540).template!.id).toBe('kit-buy:army-magic');
    const complete = plan(inputs([account('Soldier', { Magic: 99 }, { coin: 1000 })], { templates: [farmer, band], army, market }))[0]!;
    expect(complete.template).toBeUndefined();
});

test('autopilot does not let excluded or reserved wealth hide a poor army buyers funding gap', () => {
    const farmer = supply('coin-farm', 'coins', 1);
    const band: Template = { id: 'army-magic', family: 'combat', script: 'scripts/train.ts', role: 'combat', goal: 'train Magic to 99',
        tier: 'goal', band: 1, trains: { skill: 'Magic', to: 99, unlocks: [] }, needs: { items: { 'mind rune': 10 } }, yields: () => [] };
    const soldier = account('Soldier');
    const base = { templates: [farmer, band], army: new Set(['soldier']), market: { 'mind rune': { id: 558, name: 'Mind rune', limit: 4 } } };
    for (const extra of [
        { sideCoins: 1_000_000 },
        { donors: [{ name: 'Reserved', coins: 50_000 }] },
        { stock: [{ name: 'Stopped', side, items: { coin: 1_000_000 } }] },
    ]) {
        const [out] = plan(inputs([soldier], { ...base, ...extra }));
        expect(out!.template?.id).toBe('coin-farm');
        expect(out!.value).toBeGreaterThan(0);
    }
    const blocked = plan(inputs([soldier, account('Zed', {}, { coin: 1_000_000 })], { ...base, unfundable: new Set(['zed']) }));
    expect(blocked.find(x => x.account === soldier.name)!.template?.id).toBe('coin-farm');
});

test('autopilot uses a free compatible donor for an army kit without earning extra coins', () => {
    const farmer = supply('coin-farm', 'coins', 1);
    const band: Template = { id: 'army-magic', family: 'combat', script: 'scripts/train.ts', role: 'combat', goal: 'train Magic to 99',
        tier: 'goal', band: 1, trains: { skill: 'Magic', to: 99, unlocks: [] }, needs: { items: { 'mind rune': 10 } }, yields: () => [] };
    const out = plan(inputs([account('Soldier'), account('Donor', {}, { coin: 51_540 })], {
        templates: [farmer, band], army: new Set(['soldier']), market: { 'mind rune': { id: 558, name: 'Mind rune', limit: 4 } },
        donors: [{ name: 'Donor', coins: 51_540 }],
    }));
    const soldier = out.find(x => x.account === 'Soldier')!;
    expect(soldier.template?.id).toBe('kit-buy:army-magic');
    expect(soldier.fund).toMatchObject({ from: 'Donor', to: 'Soldier', coins: 1540 });
    expect(out.some(x => x.template?.id === 'coin-farm')).toBe(false);
});

test('autopilot does not credit a coin donor that cannot fund the recipients meeting', () => {
    const farmer = supply('coin-farm', 'coins', 1);
    const band: Template = { id: 'army-magic', family: 'combat', script: 'scripts/train.ts', role: 'combat', goal: 'train Magic to 99',
        tier: 'goal', band: 1, trains: { skill: 'Magic', to: 99, unlocks: [] }, needs: { items: { 'mind rune': 10 } }, yields: () => [] };
    const [out] = plan(inputs([{ ...account('Soldier'), pos: { x: 2920, z: 3160, level: 0 } }], {
        templates: [farmer, band], army: new Set(['soldier']), market: { 'mind rune': { id: 558, name: 'Mind rune', limit: 4 } },
        donors: [{ name: 'Donor', coins: 51_540 }],
    }));
    expect(out!.template?.id).toBe('coin-farm');
    expect(out!.fund).toBeUndefined();
});

test('autopilot assigns one qualified helper to earn a transferable army kit fund', () => {
    const farmer = { ...supply('coin-farm', 'coins', 1), needs: { skills: { Thieving: 55 } } };
    const band: Template = { id: 'army-magic', family: 'combat', script: 'scripts/train.ts', role: 'combat', goal: 'train Magic to 99',
        tier: 'goal', band: 1, trains: { skill: 'Magic', to: 99, unlocks: [] }, needs: { items: { 'mind rune': 10 } }, yields: () => [] };
    const base = { templates: [farmer, band], army: new Set(['soldier']), market: { 'mind rune': { id: 558, name: 'Mind rune', limit: 4 } } };
    const run = (coin: number, extra: Partial<Inputs> = {}) => plan(inputs([
        account('Soldier'), account('HelperA', { Thieving: 99 }, { coin }), account('HelperB', { Thieving: 99 }),
    ], { ...base, ...extra }));
    const first = run(0), farms = first.filter(x => x.template?.id === 'coin-farm');
    expect(farms).toHaveLength(1);
    expect(farms[0]!.account).toBe('HelperA');
    expect(farms[0]!.value).toBeGreaterThan(0);
    expect(first.find(x => x.account === 'Soldier')!.template).toBeUndefined();
    const almost = run(51_400).find(x => x.account === 'HelperA')!;
    expect(almost.template?.id).toBe('coin-farm');
    expect(almost.value).toBeCloseTo(140 / 1000);
    expect(run(51_540).some(x => x.template?.id === 'coin-farm')).toBe(false);
    const funded = run(51_540, { donors: [{ name: 'HelperA', coins: 51_540 }] });
    expect(funded.find(x => x.account === 'Soldier')!.fund).toMatchObject({ from: 'HelperA', coins: 1540 });
    expect(funded.some(x => x.template?.id === 'coin-farm')).toBe(false);
});

test('autopilot keeps cheaper own army funding ahead of a helpers transfer reserve', () => {
    const farmer = { ...supply('coin-farm', 'coins', 1), needs: { skills: { Thieving: 55 } } };
    const band: Template = { id: 'army-magic', family: 'combat', script: 'scripts/train.ts', role: 'combat', goal: 'train Magic to 99',
        tier: 'goal', band: 1, trains: { skill: 'Magic', to: 99, unlocks: [] }, needs: { items: { 'mind rune': 10 } }, yields: () => [] };
    const out = plan(inputs([account('Soldier', { Thieving: 99 }), account('Helper', { Thieving: 99 })], {
        templates: [farmer, band], army: new Set(['soldier']), market: { 'mind rune': { id: 558, name: 'Mind rune', limit: 4 } },
    }));
    expect(out.filter(x => x.template?.id === 'coin-farm').map(x => x.account)).toEqual(['Soldier']);
});

test('autopilot counts army kit output as useful even when the route bill is empty', () => {
    const band: Template = { id: 'army-magic', family: 'combat', script: 'scripts/train.ts', role: 'combat', goal: 'train Magic to 99',
        tier: 'goal', band: 1, trains: { skill: 'Magic', to: 99, unlocks: [] },
        needs: { items: { 'mind rune': 10 } }, yields: () => [] };
    const out = plan(inputs([account('Helper'), account('Soldier')], { templates: [supply('runes', 'mind rune', 1), band], army: new Set(['soldier']), prices: { 'mind rune': 2 } }));
    expect(out.filter(x => x.template?.id === 'runes')).toHaveLength(1);
});

test('autopilot does not farm coins when held coins cover the finite route acquisition bill', () => {
    const farmer = supply('coin-farm', 'coins', 1);
    const run = (coin: number) => plan(inputs([account('Helper', {}, { coin })], { templates: [farmer], bill: [row('shark', 10)], prices: { shark: 5 } }))[0]!;
    expect(run(0).template!.id).toBe('coin-farm');
    expect(run(50).template).toBeUndefined();
});

test('autopilot does not also fund a route purchase after assigning its missing supply', () => {
    const out = plan(inputs([account('A'), account('B')], {
        templates: [supply('food', 'shark', 1), supply('coin-farm', 'coins', 1)], bill: [row('shark', 1)], prices: { shark: 5 },
    }));
    expect(out.filter(x => x.template?.id === 'food')).toHaveLength(1);
    expect(out.filter(x => x.template?.id === 'coin-farm')).toHaveLength(0);
});

test('autopilot keeps an admitted running army band through a transient kit shortfall', () => {
    const band: Template = { id: 'army-magic', family: 'combat', script: 'scripts/train.ts', role: 'combat', goal: 'train Magic to 99',
        tier: 'goal', band: 1, trains: { skill: 'Magic', to: 99, unlocks: [] },
        needs: { items: { 'mind rune': 10 } }, yields: () => [] };
    const [out] = plan(inputs([account('Soldier', { Magic: 80 }, { 'mind rune': 5 })], {
        templates: [band], army: new Set(['soldier']), current: new Map([['soldier', band.id]]), unfundable: new Set(['soldier']),
        running: new Set(['soldier']),
    }));
    expect(out!.template!.id).toBe('army-magic');
    for (const extra of [{ running: new Set<string>() }, { retired: new Set(['soldier:army-magic']) }]) {
        const [parked] = plan(inputs([account('Soldier', { Magic: 80 }, { 'mind rune': 5 })], {
            templates: [band], army: new Set(['soldier']), current: new Map([['soldier', band.id]]), unfundable: new Set(['soldier']),
            running: new Set(['soldier']), ...extra,
        }));
        expect(parked!.template).toBeUndefined();
    }
});
