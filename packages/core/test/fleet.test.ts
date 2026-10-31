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

test('a bad owners entry is refused', () => {
    expect(() => loadOwners(file({ 'bad name!': { side: 'local', server: 'x' } }))).toThrow();
    expect(() => loadOwners(file({ Ok: { side: 'moon', server: 'x' } }))).toThrow();
});
