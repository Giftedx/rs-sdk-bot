import { expect, test } from 'bun:test';
import { makeOrder, orderMeet, orderWarnings } from './fleet-order';
import { validOrder } from './fleet-trade-settlement';

const server = 'rs-sdk-demo.fly.dev';
const owners = new Map([['mmthv2350', { side: 'local', server }], ['pocketpython', { side: 'local', server }], ['thefullmonty', { side: 'claude-cloud', server }]]) as any;
const coins = (n: number) => [{ id: 995, name: 'Coins', count: n }];

test('an order warns for a party in an enabled job on its side and for a donor short of coins; a free, funded donor warns nothing', () => {
    const plans = { local: { jobs: [{ account: 'mmthv2350', script: 'scripts/shop-buyer.ts', enabled: true }, { account: 'Pocketpython', script: 'scripts/goldfarm.ts', enabled: false }] }, 'claude-cloud': { jobs: [{ accounts: ['UnderMyKilt'], script: 'scripts/ranged-train.ts', enabled: true }] } };
    const snapshots = { local: { accounts: [{ name: 'mmthv2350', bank: coins(6_368_694), inventory: [] }, { name: 'Pocketpython', bank: coins(7_000_000), inventory: coins(738_877) }] }, 'claude-cloud': { accounts: [] } };
    const busy = makeOrder('mmthv2350', 'TheFullMonty', 3_000_000, 'Coins', 1_000_000, 0, 60, owners);
    expect(orderWarnings(busy, plans, snapshots, owners)).toEqual(['mmthv2350 has an enabled job on the local side (scripts/shop-buyer.ts): its fleet agent waits until that job is off']);
    const free = makeOrder('Pocketpython', 'TheFullMonty', 3_000_000, 'Coins', 1_000_000, 0, 60, owners);
    expect(orderWarnings(free, plans, snapshots, owners)).toEqual([]);
    const short = makeOrder('Pocketpython', 'TheFullMonty', 9_000_000, 'Coins', 1_000_000, 0, 60, owners);
    expect(orderWarnings(short, plans, snapshots, owners)).toEqual(['Pocketpython held 7738877 coins at its last snapshot, fewer than the 9000000 ordered']);
    // A receiver in an enabled host job, and no published data at all.
    const hosted = makeOrder('Pocketpython', 'TheFullMonty', 10, 'Big bones', 1_000_000, 0, 60, owners);
    expect(orderWarnings(hosted, { 'claude-cloud': { jobs: [{ accounts: ['TrouserSnake', 'TheFullMonty'], script: 'scripts/quest-chain.ts', enabled: true }] } }, {}, owners)).toEqual(['TheFullMonty has an enabled job on the claude-cloud side (scripts/quest-chain.ts): its fleet agent waits until that job is off']);
    expect(orderWarnings(hosted, {}, {}, owners)).toEqual([]);
});

test('MEET puts the trade at a known bank pair: the Ardougne north bank for the army, Varrock West by default', () => {
    const owners = new Map([['thefullmonty', { side: 'claude-cloud', server: 'rs-sdk-demo.fly.dev' }], ['underMyKilt'.toLowerCase(), { side: 'claude-cloud', server: 'rs-sdk-demo.fly.dev' }]]);
    expect(orderMeet(undefined)).toBeUndefined();
    expect(orderMeet('2619,3332')).toEqual([{ x: 2618, z: 3333, level: 0 }, { x: 2617, z: 3333, level: 0 }]);
    expect(() => orderMeet('2654,3283')).toThrow('MEET must be a bank tile');
    expect(orderMeet('draynor')).toEqual([{ x: 3093, z: 3243, level: 0 }, { x: 3093, z: 3244, level: 0 }]);
    expect(orderMeet('Ardougne-North')).toEqual(orderMeet('2619,3332'));
    expect(() => orderMeet('lumbridge')).toThrow('a bank name');
    const home = makeOrder('TheFullMonty', 'UnderMyKilt', 1, 'Staff of fire', 1_000_000, 0, 60, owners, orderMeet('2619,3332'));
    expect(home.meet).toEqual([{ x: 2618, z: 3333, level: 0 }, { x: 2617, z: 3333, level: 0 }]);
    expect(validOrder(home)).toBe(true);
    expect(validOrder({ ...home, meet: [{ x: 1, z: 2 }] })).toBe(false);
    expect(makeOrder('TheFullMonty', 'UnderMyKilt', 1, 'Staff of fire', 1_000_000, 0, 60, owners).meet).toBeUndefined();
});
