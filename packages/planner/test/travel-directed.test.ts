import { test, expect } from 'bun:test';
import { bankTrips, leg, START_TICKS, type TravelModel } from '../src/travel';

const model = (): TravelModel => ({
    places: { mine: { x: 0, z: 0 }, bank: { x: 100, z: 0 } },
    cache: { legs: {}, nearestBank: {}, banks: { bank: { x: 100, z: 0 } } },
});

test('a nearest-bank observation applies in its recorded direction', () => {
    const m = model();
    m.cache.nearestBank.mine = { bank: 'bank', runTicks: 10, method: 'world.json' };
    expect(leg(m, 'mine', 'bank')).toEqual({ ticks: 10 + START_TICKS, method: 'world.json' });
    expect(leg(m, 'bank', 'mine')).toEqual({ ticks: 62, method: 'estimate' });
});

test('a one-way cost does not become evidence for the reverse trip', () => {
    const m = model();
    m.cache.nearestBank.mine = { bank: 'bank', runTicks: 10, method: 'path' };
    expect(leg(m, 'mine', 'bank').ticks).toBe(12);
    expect(leg(m, 'bank', 'mine')).toEqual({ ticks: 62, method: 'estimate' });
});

test('bank trips sum outbound and return instead of doubling outbound', () => {
    const m = model();
    m.cache.nearestBank.mine = { bank: 'bank', runTicks: 10, method: 'world.json' };
    expect(bankTrips(m, 'mine', 2).ticks).toBe(2 * (12 + 62));
});

test('legacy symmetric caches still work in each direction', () => {
    const m = model();
    m.cache.legs['bank>mine'] = { runTicks: 15, tiles: 30 };
    expect(leg(m, 'mine', 'bank').ticks).toBe(17);
    expect(leg(m, 'bank', 'mine').ticks).toBe(17);
    expect(bankTrips(m, 'mine', 2).ticks).toBe(68);
});

test('a reverse nearest-bank lookup can still use an explicit legacy symmetric path', () => {
    const m = model();
    m.cache.nearestBank.mine = { bank: 'bank', runTicks: 10, method: 'world.json' };
    m.cache.legs['bank>mine'] = { runTicks: 15, tiles: 30 };
    expect(leg(m, 'mine', 'bank')).toEqual({ ticks: 12, method: 'world.json' });
    expect(leg(m, 'bank', 'mine')).toEqual({ ticks: 17, method: 'path' });
    expect(bankTrips(m, 'mine', 2).ticks).toBe(58);
});
