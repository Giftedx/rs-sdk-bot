// Several controllers share the demo server, each a named side: this PC is 'local' (the default), the Codex cloud
// environment 'cloud', a Claude Code cloud environment 'claude-cloud' (FLEET_SIDE=<name>).
// fleet/owners.json names the side and server of each account; credentials never enter it (bot.env stays on the
// machine that owns the account). A controller logs in only accounts of its own side (bot.ts openBot), so two
// machines never fight over one session; an account the file does not list is local. Trades trust the accounts the
// file lists on either side, besides the ones this machine proved itself (tradeguard.ts tradePartners).
// Cross-side transfers are orders in fleet/orders (scripts/fleet-trade.ts), synced through git (scripts/fleet-sync.ts);
// scripts/fleet-agent.ts syncs and runs this machine's side of each order.
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..', '..', '..');
// Fleet data lives on its own branch, fleet-data, checked out at .practice/fleet-data (scripts/fleet-sync.ts), so a sync
// never rebases the code checkout other sessions edit. fleet/ on master is the seed for a machine without it.
export const FLEET_WORKTREE = join(root, '.practice', 'fleet-data');
export const FLEET_DIR = () => resolve(process.env.FLEET_DIR ?? (existsSync(join(FLEET_WORKTREE, 'fleet', 'owners.json')) ? join(FLEET_WORKTREE, 'fleet') : join(root, 'fleet')));
export type Side = string;
export type Owner = { side: Side; server: string };
export const SIDE_NAME = /^[a-z][a-z0-9-]{0,23}$/;
export function mySide(): Side {
    const side = process.env.FLEET_SIDE || 'local';
    if (!SIDE_NAME.test(side)) throw Error(`fleet: FLEET_SIDE must be a short lower-case name, not ${side}`);
    return side;
}

export function loadOwners(file = join(FLEET_DIR(), 'owners.json')): Map<string, Owner> {
    if (!existsSync(file)) return new Map();
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { accounts?: Record<string, Owner> };
    const out = new Map<string, Owner>();
    for (const [name, o] of Object.entries(raw.accounts ?? {})) {
        if (!/^[A-Za-z0-9]{1,12}$/.test(name) || typeof o?.side !== 'string' || !SIDE_NAME.test(o.side) || typeof o.server !== 'string') throw Error(`fleet owners: bad entry ${name}`);
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

// One live controller per side across machines. fleet/leases/<side>.json names the machine whose swarm runs the side's
// jobs (host and controller pid, from its .practice/swarm-state.json heartbeat); scripts/fleet-sync.ts publishes it, and a
// swarm on another machine refuses to start while it is fresh (scripts/swarm.ts), so two containers of one side never log
// the same accounts in. A lease older than LEASE_MAX_AGE_MS has lapsed: the fleet agent syncs every 10 minutes, so a
// machine that stops syncing frees its side within 15.
export const LEASE_MAX_AGE_MS = 15 * 60_000;
export type Lease = { side: Side; host: string; pid: number; at: number };
export const thisHost = () => hostname();
export function readLease(side: Side, dir = FLEET_DIR()): Lease | null {
    try {
        const l = JSON.parse(readFileSync(join(dir, 'leases', `${side}.json`), 'utf8'));
        return typeof l?.host === 'string' && Number.isFinite(l.at) ? { side, host: l.host, pid: Number(l.pid), at: l.at } : null;
    } catch { return null; }
}
// The other machine's lease that holds this side now, or null when this machine may run the side.
export function leaseHeldElsewhere(lease: Lease | null, host: string, now = Date.now()): Lease | null {
    return lease && lease.host !== host && now - lease.at < LEASE_MAX_AGE_MS ? lease : null;
}
// The lease a sync publishes: this machine's controller heartbeat (`mine`) unless another machine holds a fresh lease;
// null leaves the file as it is, for a machine with no live controller too.
export function nextLease(current: Lease | null, mine: Lease | null, now = Date.now()): Lease | null {
    return mine && !leaseHeldElsewhere(current, mine.host, now) ? mine : null;
}
