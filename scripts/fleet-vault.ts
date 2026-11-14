// The fleet credential vault (packages/core/src/fleet-vault.ts) from the command line. No command prints a password.
//   status                         each listed account: bot.env here, vault entry, key match
//   put <name...> | --side <side> | --all-here   seal this machine's bot.env files, then sync (unless --no-sync)
//   restore <name...> | --side <side> | --all     write each missing bot.env from the vault
//   keygen                         write a new key to .practice/fleet-vault-key.txt for the owner to copy into the
//                                  environment secrets (FLEET_VAULT_KEY); it refuses to replace an existing file
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { loadOwners, FLEET_WORKTREE } from '../packages/core/src/fleet';
import { BOTS_DIR, keyId, listEntries, putCredential, readEntry, restoreCredential, vaultKey } from '../packages/core/src/fleet-vault';
import { MAIN_ACCOUNT } from '../packages/core/src/haggisgate';
import { withFleetDataWrite } from './fleet-owner-claim';
import { runSync } from './fleet-sync';

const root = resolve(import.meta.dir, '..');

// The registry spelling of each listed account (Linux credential directories are case sensitive), main excluded.
export function listedNames(owners: ReturnType<typeof loadOwners>, raw: Record<string, unknown>): Map<string, { name: string; side: string }> {
    const out = new Map<string, { name: string; side: string }>();
    for (const name of Object.keys(raw)) {
        const o = owners.get(name.toLowerCase());
        if (o && name.toLowerCase() !== MAIN_ACCOUNT) out.set(name.toLowerCase(), { name, side: o.side });
    }
    return out;
}

export function selectNames(args: string[], listed: Map<string, { name: string; side: string }>, here: (name: string) => boolean): string[] {
    const side = args.indexOf('--side');
    if (side >= 0) return [...listed.values()].filter(a => a.side === args[side + 1]).map(a => a.name);
    if (args.includes('--all')) return [...listed.values()].map(a => a.name);
    if (args.includes('--all-here')) return [...listed.values()].map(a => a.name).filter(here);
    return args.filter(a => !a.startsWith('--')).map(a => listed.get(a.toLowerCase())?.name ?? a);
}

if (import.meta.main) {
    const [cmd, ...args] = process.argv.slice(2);
    const ownersFile = join(FLEET_WORKTREE, 'fleet', 'owners.json');
    const raw = existsSync(ownersFile) ? (JSON.parse(await Bun.file(ownersFile).text()).accounts ?? {}) : {};
    const listed = listedNames(loadOwners(ownersFile), raw);
    const here = (n: string) => existsSync(join(BOTS_DIR, n, 'bot.env'));
    try {
        if (cmd === 'keygen') {
            const file = join(root, '.practice', 'fleet-vault-key.txt');
            if (existsSync(file)) throw Error(`${file} exists; delete it only once its key is in every environment, or keep using it`);
            mkdirSync(join(root, '.practice'), { recursive: true });
            writeFileSync(file, randomBytes(32).toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
            console.log(`VAULT key written to ${file}: copy it into FLEET_VAULT_KEY on the PC and in every cloud environment's secrets`);
        } else if (cmd === 'status') {
            let key: Buffer | null = null;
            try { key = vaultKey(); } catch (e) { console.log(`VAULT key invalid: ${String(e)}`); }
            const entries = new Set(listEntries());
            console.log(`VAULT key=${key ? keyId(key) : 'none'} entries=${entries.size} listed=${listed.size}`);
            for (const { name, side } of [...listed.values()].sort((a, b) => a.side.localeCompare(b.side) || a.name.localeCompare(b.name))) {
                const entry = entries.has(name.toLowerCase()) ? readEntry(name) : null;
                console.log(`${side.padEnd(14)} ${name.padEnd(12)} bot.env=${here(name) ? 'yes' : 'no '} vault=${entry ? (key && entry.kid === keyId(key) ? 'yes' : 'other-key') : 'no'}`);
            }
        } else if (cmd === 'put') {
            const key = vaultKey();
            if (!key) throw Error('FLEET_VAULT_KEY is not set');
            const names = selectNames(args, listed, here);
            if (!names.length) throw Error('no accounts selected');
            const counts: Record<string, number> = {};
            for (const n of names) {
                const r = here(n) ? putCredential(n, key) : 'no bot.env here';
                counts[r] = (counts[r] ?? 0) + 1;
                if (r === 'no bot.env here') console.log(`VAULT skip ${n}: no bot.env here`);
            }
            console.log(`VAULT put ${JSON.stringify(counts)}`);
            if (!args.includes('--no-sync') && counts.sealed) console.log(`VAULT sync ${await withFleetDataWrite(root, () => runSync(true))}`);
        } else if (cmd === 'restore') {
            const names = selectNames(args, listed, here);
            if (!names.length) throw Error('no accounts selected');
            const counts: Record<string, number> = {};
            for (const n of names) { const r = restoreCredential(n); counts[r] = (counts[r] ?? 0) + 1; if (r !== 'present' && r !== 'restored') console.log(`VAULT ${n}: ${r}`); }
            console.log(`VAULT restore ${JSON.stringify(counts)}`);
        } else {
            console.log('usage: bun scripts/fleet-vault.ts status | put <name...>|--side <side>|--all-here [--no-sync] | restore <name...>|--side <side>|--all | keygen');
            process.exit(2);
        }
    } catch (e) { console.log(`RESULT fail fleet-vault ${String(e)}`); process.exit(1); }
}
