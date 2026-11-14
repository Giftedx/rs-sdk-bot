import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hasCredential, keyId, putCredential, readEntry, restoreCredential, seal, unseal, vaultKey } from './fleet-vault';

const ENV = 'SERVER=rs-sdk-demo.fly.dev\nPASSWORD=abcDEF123_-xyz\n';
const dirs = () => { const d = mkdtempSync(join(tmpdir(), 'vault-')); return { botsDir: join(d, 'bots'), dir: join(d, 'vault') }; };
const writeEnv = (botsDir: string, name: string, text = ENV) => { mkdirSync(join(botsDir, name), { recursive: true }); writeFileSync(join(botsDir, name, 'bot.env'), text); };

describe('fleet vault', () => {
    const key = randomBytes(32);

    test('seals and opens a bot.env, and the ciphertext holds no password text', () => {
        const e = seal('Fatstack', ENV, key, 1);
        expect(JSON.stringify(e)).not.toContain('abcDEF123');
        expect(e.server).toBe('rs-sdk-demo.fly.dev');
        expect(unseal(e, key)).toBe(ENV);
    });

    test('refuses another key, a renamed entry and a tampered text', () => {
        const e = seal('Fatstack', ENV, key, 1);
        expect(() => unseal(e, randomBytes(32))).toThrow('another FLEET_VAULT_KEY');
        expect(() => unseal({ ...e, name: 'Fingersmith' }, key)).toThrow();
        const ct = Buffer.from(e.ct, 'base64'); ct[0] ^= 1;
        expect(() => unseal({ ...e, ct: ct.toString('base64') }, key)).toThrow();
    });

    test('never seals the main account', () => {
        expect(() => seal('Haggis', ENV, key)).toThrow('main account');
        expect(() => restoreCredential('haggis', { key, ...dirs() })).toThrow('main account');
    });

    test('a key must be 32 bytes; no key reads as none', () => {
        expect(vaultKey({})).toBeNull();
        expect(vaultKey({ FLEET_VAULT_KEY: key.toString('base64') })?.equals(key)).toBe(true);
        expect(() => vaultKey({ FLEET_VAULT_KEY: 'c2hvcnQ=' })).toThrow('32 bytes');
    });

    test('put then restore on another machine writes the same bot.env; a repeat put changes nothing', () => {
        const a = dirs(), b = { ...dirs(), dir: a.dir };
        writeEnv(a.botsDir, 'Fatstack');
        expect(putCredential('Fatstack', key, a)).toBe('sealed');
        const first = readFileSync(join(a.dir, 'fatstack.json'), 'utf8');
        expect(putCredential('Fatstack', key, a)).toBe('unchanged');
        expect(readFileSync(join(a.dir, 'fatstack.json'), 'utf8')).toBe(first);
        expect(hasCredential('Fatstack', { ...b, key })).toBe(true);
        expect(hasCredential('Fatstack', { ...b, key: null })).toBe(false);
        expect(restoreCredential('Fatstack', { ...b, key })).toBe('restored');
        expect(readFileSync(join(b.botsDir, 'Fatstack', 'bot.env'), 'utf8')).toBe(ENV);
        expect(restoreCredential('Fatstack', { ...b, key })).toBe('present');
    });

    test('restore never overwrites a bot.env, and reports one that differs from the vault', () => {
        const a = dirs();
        writeEnv(a.botsDir, 'Fatstack');
        putCredential('Fatstack', key, a);
        writeEnv(a.botsDir, 'Fatstack', 'SERVER=rs-sdk-demo.fly.dev\nPASSWORD=seedguess\n');
        expect(restoreCredential('Fatstack', { ...a, key })).toBe('differs');
        expect(readFileSync(join(a.botsDir, 'Fatstack', 'bot.env'), 'utf8')).toContain('seedguess');
    });

    test('without the key or an entry nothing is written', () => {
        const a = dirs();
        expect(restoreCredential('Fatstack', { ...a, key })).toBe('missing');
        writeEnv(a.botsDir, 'Other'); putCredential('Other', key, a);
        const b = { ...dirs(), dir: a.dir };
        expect(restoreCredential('Other', { ...b, key: null })).toBe('no-key');
        expect(existsSync(join(b.botsDir, 'Other', 'bot.env'))).toBe(false);
        expect(readEntry('Other', a.dir)?.kid).toBe(keyId(key));
    });
});
