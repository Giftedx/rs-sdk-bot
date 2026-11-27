import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePreloginFailure, type Order } from '../../core/src/fleet-trade-settlement';
import type { NoRouteFact } from '../../brain/src/no-route';
import { meetTile, PRELOGIN_RETRY_MS, routeRefusal, tradePreflight } from '../src/trade-preflight';

const NOW = 1_795_743_072_303;
// Order xfer-1795743072303-1: Quickhandjob failed "precondition no route to 3182,3440,0" four times in a row.
const VARROCK: Order = { id: 'xfer-1795743072303-1', server: 's', from: 'Shaftsinker', to: 'Quickhandjob', item: 'Lobster', count: 1, start: NOW, end: NOW + 900_000, meet: [{ x: 3183, z: 3440, level: 0 }, { x: 3182, z: 3440, level: 0 }] };
// Order xfer-1795725998186-1: Hocuspokeus failed "precondition ferry needs 60 coins and the bank holds 0".
const ARDOUGNE: Order = { id: 'xfer-1795725998186-1', server: 's', from: 'Hocuspokeus', to: 'Quickhandjob', item: 'Air rune', count: 918, start: NOW, end: NOW + 900_000, meet: [{ x: 2618, z: 3333, level: 0 }, { x: 2617, z: 3333, level: 0 }] };
const HERE = { x: 2546, z: 3325, level: 0 };
const fact: NoRouteFact = { from: HERE, to: { x: 3182, z: 3440, level: 0 }, activityId: 'logistics:trade', observedAt: NOW - 60_000, expiresAt: NOW + 3_600_000 };
// Port Sarim to Karamja, then Brimhaven to Ardougne: 30 coins each.
const travel = () => [
    { id: 'npc:captain_tobias:karamja-musa-point@3028,3216', from: { x: 3028, z: 3216, level: 0 }, coins: 30 },
    { id: 'npc:customs_officer:ardougne@2772,3225', from: { x: 2772, z: 3225, level: 0 }, coins: 30 },
] as never;

describe('trade preflight: route and fare', () => {
    test('the meet tile of each role', () => {
        expect(meetTile(VARROCK, 'from')).toEqual({ x: 3183, z: 3440, level: 0 });
        expect(meetTile(VARROCK, 'to')).toEqual({ x: 3182, z: 3440, level: 0 });
    });

    test("the account's own no-route fact refuses the meet while it stands where the search started", () => {
        expect(routeRefusal(HERE, meetTile(VARROCK, 'to')!, [fact], { pack: 0 }, NOW))
            .toBe('no route to the meet 3182,3440,0: its route search from 2546,3325,0 found none to 3182,3440,0');
        // The account moved away: the fact holds no more.
        expect(routeRefusal({ x: 3200, z: 3400, level: 0 }, meetTile(VARROCK, 'to')!, [fact], { pack: 0 }, NOW)).toBeUndefined();
        expect(routeRefusal(HERE, meetTile(VARROCK, 'to')!, [fact], { pack: 0 }, fact.expiresAt)).toBeUndefined();
    });

    test('a ferry walk to the meet needs both fares in the pack and bank together', () => {
        const varrock = { x: 3185, z: 3436, level: 0 }, tile = meetTile(ARDOUGNE, 'from')!;
        expect(routeRefusal(varrock, tile, undefined, { pack: 0, bank: 0 }, NOW, travel))
            .toBe('the walk to the meet 2618,3333,0 takes boats that need 60 coins, and the account owns 0');
        expect(routeRefusal(varrock, tile, undefined, { pack: 25, bank: 34 }, NOW, travel)).toContain('owns 59');
        expect(routeRefusal(varrock, tile, undefined, { pack: 25, bank: 35 }, NOW, travel)).toBeUndefined();
        // An unobserved bank gives no proof of a shortfall.
        expect(routeRefusal(varrock, tile, undefined, { pack: 0 }, NOW, travel)).toBeUndefined();
        // No boat on the way: no fare.
        expect(routeRefusal(varrock, meetTile(VARROCK, 'from')!, undefined, { pack: 0, bank: 0 }, NOW, travel)).toBeUndefined();
    });
});

describe('trade preflight: login admission', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trade-preflight-'));
    const base = { base: dir, dir, env: () => ({}), status: () => null, noRoutes: () => undefined };

    test('a release hold refuses every party on that server, and the check runs once a server', () => {
        let calls = 0;
        const admit = tradePreflight({ ...base, now: NOW, release: () => { calls++; throw Error('no worker progress: release peer state unknown; verify offline before rollout'); } });
        expect(admit('Shaftsinker', VARROCK, 'from')).toBe('login would fail: no worker progress: release peer state unknown; verify offline before rollout');
        expect(admit('Quickhandjob', VARROCK, 'to')).toBe('login would fail: no worker progress: release peer state unknown; verify offline before rollout');
        expect(calls).toBe(1);
    });

    test('a login refused in the last five minutes is not tried again', () => {
        writePreloginFailure(join(dir, 'prelogin-failed'), { version: 1, id: VARROCK.id, role: 'from', account: 'Shaftsinker', partner: 'Quickhandjob', server: 's', at: NOW - 90_000, detail: 'Error: account plan writer waits for its existing owner' });
        const admit = (now: number) => tradePreflight({ ...base, now, release: () => {} });
        expect(admit(NOW)('Shaftsinker', VARROCK, 'from')).toBe('login refused 90 s ago: account plan writer waits for its existing owner');
        expect(admit(NOW)('Quickhandjob', VARROCK, 'to')).toBeUndefined();
        expect(admit(NOW - 90_000 + PRELOGIN_RETRY_MS)('Shaftsinker', VARROCK, 'from')).toBeUndefined();
    });

    test("the route check reads the party's status position, coins and no-route facts", () => {
        const admit = tradePreflight({
            ...base, now: NOW, release: () => {},
            status: account => account === 'Quickhandjob' ? { pos: HERE, inventory: [{ id: 995, count: 5 }], bank: [], bankAt: NOW - 1 } : null,
            noRoutes: account => account === 'Quickhandjob' ? [fact] : undefined,
        });
        expect(admit('Quickhandjob', VARROCK, 'to')).toContain('no route to the meet 3182,3440,0');
        expect(admit('Shaftsinker', { ...VARROCK, id: 'xfer-1795743072303-2' }, 'from')).toBeUndefined();
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));
});
