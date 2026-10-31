import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertSideOwns, listedAccounts, loadOwners, sideOf } from '../src/fleet';

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
