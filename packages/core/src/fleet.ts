// Two controllers share the demo server: this PC (side 'local') and a cloud agent (side 'cloud', FLEET_SIDE=cloud).
// fleet/owners.json names the side and server of each account; credentials never enter it (bot.env stays on the
// machine that owns the account). A controller logs in only accounts of its own side (bot.ts openBot), so two
// machines never fight over one session; an account the file does not list is local. Trades trust the accounts the
// file lists on either side, besides the ones this machine proved itself (tradeguard.ts tradePartners).
// Cross-side transfers are orders in fleet/orders (scripts/fleet-trade.ts), synced through git (scripts/fleet-sync.ts).
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..', '..', '..');
export const FLEET_DIR = () => resolve(process.env.FLEET_DIR ?? join(root, 'fleet'));
export type Side = 'local' | 'cloud';
export type Owner = { side: Side; server: string };
export const mySide = (): Side => (process.env.FLEET_SIDE === 'cloud' ? 'cloud' : 'local');

export function loadOwners(file = join(FLEET_DIR(), 'owners.json')): Map<string, Owner> {
    if (!existsSync(file)) return new Map();
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { accounts?: Record<string, Owner> };
    const out = new Map<string, Owner>();
    for (const [name, o] of Object.entries(raw.accounts ?? {})) {
        if (!/^[A-Za-z0-9]{1,12}$/.test(name) || (o?.side !== 'local' && o?.side !== 'cloud') || typeof o.server !== 'string') throw Error(`fleet owners: bad entry ${name}`);
        out.set(name.toLowerCase(), { side: o.side, server: o.server.toLowerCase() });
    }
    return out;
}

export const sideOf = (name: string, owners = loadOwners()): Side => owners.get(name.toLowerCase())?.side ?? 'local';

// Refuses a login on an account the other side owns.
export function assertSideOwns(name: string, side = mySide(), owners = loadOwners()): void {
    const owner = sideOf(name, owners);
    if (owner !== side) throw Error(`fleet: ${name} belongs to the ${owner} side; this controller is ${side}`);
}

// Accounts on `server` that the owners file lists, on either side.
export function listedAccounts(server: string, owners = loadOwners()): Set<string> {
    return new Set([...owners].filter(([, o]) => o.server === server.toLowerCase()).map(([n]) => n));
}
