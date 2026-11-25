import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeOrder, orderMeet, orderWarnings, parseWith, withdrawFleetOrder } from './fleet-order';
import { validOrder } from './fleet-trade-settlement';

const server = 'rs-sdk-demo.fly.dev';
const owners = new Map([['mmthv2350', { side: 'local', server }], ['pocketpython', { side: 'local', server }], ['thefullmonty', { side: 'claude-cloud', server }]]) as any;
const coins = (n: number) => [{ id: 995, name: 'Coins', count: n }];

test('an order warns for a party in an enabled job on its side and for a donor short of coins; a free, funded donor warns nothing', () => {
    const plans = { local: { jobs: [{ account: 'mmthv2350', script: 'scripts/aio-market.ts', enabled: true }, { account: 'Pocketpython', script: 'scripts/goldfarm.ts', enabled: false }] }, 'claude-cloud': { jobs: [{ accounts: ['UnderMyKilt'], script: 'scripts/ranged-train.ts', enabled: true }] } };
    const snapshots = { local: { accounts: [{ name: 'mmthv2350', bank: coins(6_368_694), inventory: [] }, { name: 'Pocketpython', bank: coins(7_000_000), inventory: coins(738_877) }] }, 'claude-cloud': { accounts: [] } };
    const busy = makeOrder('mmthv2350', 'TheFullMonty', 3_000_000, 'Coins', 1_000_000, 0, 60, owners);
    expect(orderWarnings(busy, plans, snapshots, owners)).toEqual(['mmthv2350 has an enabled job on the local side (scripts/aio-market.ts): its fleet agent waits until that job is off']);
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

test('--with adds lines that move in the same trade, and a coin line on any line is checked against the snapshot', () => {
    const { rest, extra } = parseWith(['Pocketpython', 'TheFullMonty', '40', 'Sapphire', 'ring', '--with', '74 Cosmic rune', '--with', ' 2000000 Coins ']);
    expect(rest).toEqual(['Pocketpython', 'TheFullMonty', '40', 'Sapphire', 'ring']);
    expect(extra).toEqual([{ item: 'Cosmic rune', count: 74 }, { item: 'Coins', count: 2_000_000 }]);
    expect(() => parseWith(['a', '--with', 'Cosmic rune'])).toThrow('--with takes');
    expect(() => parseWith(['a', '--with'])).toThrow('--with takes');
    const order = makeOrder('Pocketpython', 'TheFullMonty', 40, 'Sapphire ring', 1_000_000, 0, 60, owners, undefined, extra);
    expect(validOrder(order)).toBe(true);
    expect(order.extra).toEqual(extra);
    expect(makeOrder('Pocketpython', 'TheFullMonty', 40, 'Sapphire ring', 1_000_000, 0, 60, owners, undefined, []).extra).toBeUndefined();
    expect(() => makeOrder('Pocketpython', 'TheFullMonty', 40, 'Sapphire ring', 1_000_000, 0, 60, owners, undefined, [{ item: 'sapphire ring', count: 1 }])).toThrow('invalid order');
    const snapshots = { local: { accounts: [{ name: 'Pocketpython', bank: coins(1_000_000), inventory: [] }] } };
    expect(orderWarnings(order, {}, snapshots, owners)).toEqual(['Pocketpython held 1000000 coins at its last snapshot, fewer than the 2000000 ordered']);
});

test('--id and --with-id bind exact itemId without altering plain --with behavior', async () => {
    const { parseOrderArgs } = await import('./fleet-order');
    const parsed = parseOrderArgs(['Pocketpython', 'TheFullMonty', '2', 'Dragon', 'vambraces', '--id', '2491', '--with-id', '2497', '1 Dragonhide chaps']);
    expect(parsed).toEqual({
        rest: ['Pocketpython', 'TheFullMonty', '2', 'Dragon', 'vambraces'],
        itemId: 2491,
        extra: [{ item: 'Dragonhide chaps', count: 1, itemId: 2497 }],
    });
    const order = makeOrder('Pocketpython', 'TheFullMonty', 2, 'Dragon vambraces', 1_000_000, 0, 60, owners, undefined, parsed.extra, parsed.itemId);
    expect(order.itemId).toBe(2491);
    expect(order.extra).toEqual([{ item: 'Dragonhide chaps', count: 1, itemId: 2497 }]);
    expect(validOrder(order)).toBe(true);
    // Same display name with two distinct explicit itemIds is valid; colliding without IDs remains invalid.
    const twoVambs = makeOrder('Pocketpython', 'TheFullMonty', 1, 'Dragon vambraces', 1_000_000, 0, 60, owners, undefined, [{ item: 'Dragon vambraces', count: 1, itemId: 1065 }], 2491);
    expect(validOrder(twoVambs)).toBe(true);
});

test('CLI rejects missing arguments and invalid IN/MINUTES windows cleanly with exit 2', () => {
    const missing = Bun.spawnSync([process.execPath, 'scripts/fleet-order.ts', 'Pocketpython', 'TheFullMonty'], {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
    });
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr.toString()).toContain('usage: bun scripts/fleet-order.ts');

    const badWindow = Bun.spawnSync([process.execPath, 'scripts/fleet-order.ts', 'Pocketpython', 'TheFullMonty', '10', 'Shark'], {
        cwd: process.cwd(),
        env: { ...process.env, MINUTES: '-5' },
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
    });
    expect(badWindow.exitCode).toBe(2);
    expect(badWindow.stderr.toString()).toContain('MINUTES must be finite > 0');
});

test('--withdraw deletes an order file that no held trade claim names, and keeps one that a claim names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-order-withdraw-'));
    const claim = { account: 'woodenstaff', server, side: 'local', orderId: 'xfer-1795587227524-3', role: 'from' as const, nonce: 'n1', phase: 'held' as const, at: 1 };
    try {
        for (const id of ['xfer-1795587227524-3', '1795584021244-dipstick-yewfirst-2ad00dbbd11b7d21']) writeFileSync(join(dir, `${id}.json`), '{}\n');
        expect(withdrawFleetOrder(dir, '1795584021244-dipstick-yewfirst-2ad00dbbd11b7d21.json', [claim])).toBe(join(dir, '1795584021244-dipstick-yewfirst-2ad00dbbd11b7d21.json'));
        expect(existsSync(join(dir, '1795584021244-dipstick-yewfirst-2ad00dbbd11b7d21.json'))).toBe(false);
        // The claim names the order in lower case; the id typed in upper case still matches it.
        expect(() => withdrawFleetOrder(dir, 'XFER-1795587227524-3', [claim])).toThrow('a held trade claim names order XFER-1795587227524-3 (woodenstaff from)');
        expect(existsSync(join(dir, 'xfer-1795587227524-3.json'))).toBe(true);
        expect(() => withdrawFleetOrder(dir, 'xfer-1795587227524-3', [{ ...claim, orderId: 'xfer-1795587227524-2' }])).not.toThrow();
        expect(existsSync(join(dir, 'xfer-1795587227524-3.json'))).toBe(false);
        expect(() => withdrawFleetOrder(dir, 'xfer-1795587227524-3', [])).toThrow('no order xfer-1795587227524-3');
        expect(() => withdrawFleetOrder(dir, '../owners', [])).toThrow('not an order id: ../owners');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--withdraw without an order id prints its usage and exits 2', () => {
    const r = Bun.spawnSync([process.execPath, 'scripts/fleet-order.ts', '--withdraw'], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain('usage: bun scripts/fleet-order.ts --withdraw <order id>...');
});
