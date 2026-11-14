// The fleet credential vault: one AES-256-GCM sealed bot.env per account in fleet/vault/<lower-case name>.json on the
// fleet-data branch, so any session of any side can log in any account it is given (fleet/owners.json), whatever
// machine created it. The key is FLEET_VAULT_KEY (32 random bytes, base64), a secret in each environment's settings
// and on the PC, never in git and never printed. The main account is never sealed: it logs in only on its own gate.
// One file per account keeps two sides that seal different accounts from conflicting on one JSON file.
// The authenticated data binds each sealed text to its account and server, so a file cannot be renamed onto another
// account. Without the key the vault is inert: logins keep using the bot.env files this machine already has.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FLEET_WORKTREE } from './fleet';
import { MAIN_ACCOUNT } from './haggisgate';

const root = resolve(import.meta.dir, '..', '..', '..');
export const BOTS_DIR = join(root, 'vendor', 'rs-sdk', 'bots');
// Always the fleet-data worktree, never the code checkout's fleet/ seed: master is public, and .gitignore keeps
// fleet/vault/ out of it; scripts/fleet-sync.ts adds the directory on the fleet-data branch by name.
export const VAULT_DIR = join(FLEET_WORKTREE, 'fleet', 'vault');
export const vaultDir = () => VAULT_DIR;
const NAME = /^[A-Za-z0-9]{1,12}$/;
const SERVER = /^[a-z0-9][a-z0-9.:-]{0,252}$/;

export type VaultEntry = { v: 1; name: string; server: string; kid: string; iv: string; tag: string; ct: string; at: number };

// The key from the environment, or null when this machine has none. A key of the wrong length is an error, not null:
// a mistyped secret must not look like an absent one.
export function vaultKey(env: Record<string, string | undefined> = process.env): Buffer | null {
    const raw = env.FLEET_VAULT_KEY?.trim();
    if (!raw) return null;
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw Error('fleet vault: FLEET_VAULT_KEY must be 32 bytes of base64');
    return key;
}

// A short public digest of the key: it tells a wrong key from a damaged file without revealing anything.
export const keyId = (key: Buffer) => createHash('sha256').update('rs-fleet-vault-kid').update(key).digest('hex').slice(0, 12);
const aad = (name: string, server: string) => Buffer.from(`rs-fleet-vault:v1:${server}:${name.toLowerCase()}`);

function checkName(name: string) {
    if (!NAME.test(name)) throw Error(`fleet vault: invalid account name ${name}`);
    if (name.toLowerCase() === MAIN_ACCOUNT) throw Error('fleet vault: the main account is never sealed');
}

export function serverOf(envText: string): string {
    const server = envText.match(/^SERVER=(.*)$/m)?.[1]?.trim().toLowerCase();
    if (!server || !SERVER.test(server)) throw Error('fleet vault: bot.env has no valid SERVER');
    return server;
}

export function seal(name: string, envText: string, key: Buffer, now = Date.now()): VaultEntry {
    checkName(name);
    if (!/^PASSWORD=.+$/m.test(envText)) throw Error('fleet vault: bot.env has no PASSWORD');
    const server = serverOf(envText), iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(name, server));
    const ct = Buffer.concat([cipher.update(envText, 'utf8'), cipher.final()]);
    return { v: 1, name, server, kid: keyId(key), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64'), at: now };
}

export function unseal(entry: VaultEntry, key: Buffer): string {
    checkName(entry.name);
    if (entry.v !== 1 || !SERVER.test(entry.server)) throw Error(`fleet vault: ${entry.name} has an unreadable entry`);
    if (entry.kid !== keyId(key)) throw Error(`fleet vault: ${entry.name} was sealed with another FLEET_VAULT_KEY`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
    decipher.setAAD(aad(entry.name, entry.server));
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
    const text = Buffer.concat([decipher.update(Buffer.from(entry.ct, 'base64')), decipher.final()]).toString('utf8');
    if (serverOf(text) !== entry.server) throw Error(`fleet vault: ${entry.name} entry names another server`);
    return text;
}

export function readEntry(name: string, dir = vaultDir()): VaultEntry | null {
    const file = join(dir, `${name.toLowerCase()}.json`);
    if (!existsSync(file)) return null;
    const entry = JSON.parse(readFileSync(file, 'utf8')) as VaultEntry;
    if (entry?.name?.toLowerCase() !== name.toLowerCase()) throw Error(`fleet vault: ${file} names another account`);
    return entry;
}

export function listEntries(dir = vaultDir()): string[] {
    return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)) : [];
}

function writeAtomic(file: string, text: string) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
}

export type PutResult = 'sealed' | 'unchanged';
// Seals this machine's bot.env of `name` into the vault directory. An entry that already opens to the same text is
// left alone, so a repeated put makes no commit.
export function putCredential(name: string, key: Buffer, opts: { botsDir?: string; dir?: string; now?: number } = {}): PutResult {
    checkName(name);
    const envText = readFileSync(join(opts.botsDir ?? BOTS_DIR, name, 'bot.env'), 'utf8'), dir = opts.dir ?? vaultDir();
    if (!opts.dir && !existsSync(join(FLEET_WORKTREE, '.git'))) throw Error('fleet vault: no fleet-data worktree; run scripts/fleet-sync.ts first');
    const prior = readEntry(name, dir);
    if (prior && prior.kid === keyId(key)) { try { if (unseal(prior, key) === envText) return 'unchanged'; } catch { /* reseal below */ } }
    mkdirSync(dir, { recursive: true });
    writeAtomic(join(dir, `${name.toLowerCase()}.json`), JSON.stringify(seal(name, envText, key, opts.now)) + '\n');
    return 'sealed';
}

export type RestoreResult = 'present' | 'restored' | 'missing' | 'no-key' | 'differs';
// Writes the vault's bot.env for `name` when this machine has none. An existing bot.env is never overwritten; with
// the key, one whose text differs from the vault's is reported, so a seed-derived guess is visible.
export function restoreCredential(name: string, opts: { botsDir?: string; dir?: string; key?: Buffer | null } = {}): RestoreResult {
    checkName(name);
    const envFile = join(opts.botsDir ?? BOTS_DIR, name, 'bot.env'), key = opts.key === undefined ? vaultKey() : opts.key;
    const entry = readEntry(name, opts.dir ?? vaultDir());
    if (existsSync(envFile)) {
        if (!entry || !key) return 'present';
        return unseal(entry, key) === readFileSync(envFile, 'utf8') ? 'present' : 'differs';
    }
    if (!entry) return 'missing';
    if (!key) return 'no-key';
    const text = unseal(entry, key);
    mkdirSync(join(opts.botsDir ?? BOTS_DIR, name), { recursive: true });
    writeAtomic(envFile, text);
    return 'restored';
}

// Whether this machine can log `name` in: a bot.env here, or a vault entry it holds the key for.
export function hasCredential(name: string, opts: { botsDir?: string; dir?: string; key?: Buffer | null } = {}): boolean {
    if (!NAME.test(name) || name.toLowerCase() === MAIN_ACCOUNT) return existsSync(join(opts.botsDir ?? BOTS_DIR, name, 'bot.env'));
    if (existsSync(join(opts.botsDir ?? BOTS_DIR, name, 'bot.env'))) return true;
    let key: Buffer | null;
    try { key = opts.key === undefined ? vaultKey() : opts.key; } catch { return false; }
    const entry = readEntry(name, opts.dir ?? vaultDir());
    return !!entry && !!key && entry.kid === keyId(key);
}

// openBot's hook: a missing bot.env is restored from the vault before the login reads it. Any failure leaves the
// file missing, so the login fails with its usual "no bot.env" error rather than a vault one.
export function ensureCredential(name: string): void {
    if (!NAME.test(name) || name.toLowerCase() === MAIN_ACCOUNT || existsSync(join(BOTS_DIR, name, 'bot.env'))) return;
    try {
        const result = restoreCredential(name);
        if (result === 'restored') console.log(`FLEET vault restored the credential of ${name}`);
    } catch (e) { console.log(`FLEET vault could not restore ${name}: ${String(e).replace(/\s+/g, ' ').slice(0, 160)}`); }
}
