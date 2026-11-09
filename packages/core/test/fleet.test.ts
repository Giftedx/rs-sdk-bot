import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LEASE_MAX_AGE_MS, assertSideOwns, leaseHeldElsewhere, listedAccounts, loadOwners, nextLease, readLease, sideOf } from '../src/fleet';

const file = (accounts: unknown) => { const f = join(mkdtempSync(join(tmpdir(), 'fleet-')), 'owners.json'); writeFileSync(f, JSON.stringify({ accounts })); return f; };
const owners = loadOwners(file({ Haggis: { side: 'local', server: 'rs-sdk-demo.fly.dev' }, CloudOne: { side: 'cloud', server: 'rs-sdk-demo.fly.dev' }, Prac: { side: 'cloud', server: 'localhost:8888' } }));

test('each account has one side; an unlisted one is local', () => {
    expect(sideOf('cloudone', owners)).toBe('cloud');
    expect(sideOf('Haggis', owners)).toBe('local');
    expect(sideOf('Unlisted', owners)).toBe('local');
});

test('a controller refuses to log in the other side’s account', () => {
    expect(() => assertSideOwns('CloudOne', 'local', owners)).toThrow(/cloud side/);
    expect(() => assertSideOwns('Haggis', 'cloud', owners)).toThrow(/local side/);
    expect(() => assertSideOwns('CloudOne', 'cloud', owners)).not.toThrow();
    expect(() => assertSideOwns('Unlisted', 'local', owners)).not.toThrow();
});

test('listed accounts on a server are trade partners on both sides', () => {
    expect([...listedAccounts('rs-sdk-demo.fly.dev', owners)].sort()).toEqual(['cloudone', 'haggis']);
    expect([...listedAccounts('localhost:8888', owners)]).toEqual(['prac']);
});

test('a third controller is its own side and refuses both others', () => {
    const three = loadOwners(file({ A: { side: 'local', server: 's' }, B: { side: 'cloud', server: 's' }, C: { side: 'claude-cloud', server: 's' } }));
    expect(() => assertSideOwns('C', 'claude-cloud', three)).not.toThrow();
    expect(() => assertSideOwns('B', 'claude-cloud', three)).toThrow(/cloud side/);
    expect(() => assertSideOwns('C', 'cloud', three)).toThrow(/claude-cloud side/);
    expect([...listedAccounts('s', three)].sort()).toEqual(['a', 'b', 'c']);
});

test('FLEET_SIDE must be a short lower-case name; unset is local', async () => {
    const { mySide } = await import('../src/fleet');
    const old = process.env.FLEET_SIDE;
    try {
        delete process.env.FLEET_SIDE; expect(mySide()).toBe('local');
        process.env.FLEET_SIDE = 'claude-cloud'; expect(mySide()).toBe('claude-cloud');
        process.env.FLEET_SIDE = 'Bad Side!'; expect(() => mySide()).toThrow();
    } finally { if (old === undefined) delete process.env.FLEET_SIDE; else process.env.FLEET_SIDE = old; }
});

test('a bad owners entry is refused', () => {
    expect(() => loadOwners(file({ 'bad name!': { side: 'local', server: 'x' } }))).toThrow();
    expect(() => loadOwners(file({ Ok: { side: 'Moon Base!', server: 'x' } }))).toThrow();
});

test("one controller per side: another machine's fresh lease holds it; a lapsed lease or this machine's own does not", () => {
    const lease = { side: 'claude-cloud', host: 'box-a', pid: 7, at: 1_000_000 };
    expect(leaseHeldElsewhere(lease, 'box-b', 1_000_000 + 60_000)).toEqual(lease);
    expect(leaseHeldElsewhere(lease, 'box-a', 1_000_000 + 60_000)).toBeNull();
    expect(leaseHeldElsewhere(lease, 'box-b', 1_000_000 + LEASE_MAX_AGE_MS)).toBeNull();
    expect(leaseHeldElsewhere(null, 'box-b')).toBeNull();
    // A sync publishes this machine's heartbeat unless another machine's lease is fresh; no controller here publishes nothing.
    const mine = { side: 'claude-cloud', host: 'box-b', pid: 9, at: 1_000_000 + 60_000 };
    expect(nextLease(lease, mine, 1_000_000 + 60_000)).toBeNull();
    expect(nextLease(lease, mine, 1_000_000 + LEASE_MAX_AGE_MS)).toEqual(mine);
    expect(nextLease({ ...lease, host: 'box-b' }, mine, 1_000_000 + 60_000)).toEqual(mine);
    expect(nextLease(null, mine, 1_000_000 + 60_000)).toEqual(mine);
    expect(nextLease(lease, null, 1_000_000 + 60_000)).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'lease-')); mkdirSync(join(dir, 'leases'));
    writeFileSync(join(dir, 'leases', 'claude-cloud.json'), JSON.stringify(lease));
    expect(readLease('claude-cloud', dir)).toEqual(lease);
    expect(readLease('cloud', dir)).toBeNull();
});
