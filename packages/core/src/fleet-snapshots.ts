// The fleet snapshots (fleet/snapshots/<side>.json, written by scripts/fleet-sync.ts) as one view. An account that
// changed side (fleet adoption, packages/core/src/fleet-assign.ts) can stand in two files: the last row its old side
// published, which a side that has stopped never removes, and its new side's. Every reader takes one canonical row
// for each account: the row in the file of the side that owns the account now (fleet/owners.json), else the freshest
// row. So the planner, the supply bill, the scoreboard and the dashboard count each account once, wherever it last ran.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadOwners } from './fleet';

export type SnapshotFile = { side: string; at?: number; accounts?: any[] };
export type OwnerOf = (name: string) => string | undefined;

export function readSnapshotFiles(dir: string): SnapshotFile[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f => f.endsWith('.json')).flatMap(f => {
        try { const s = JSON.parse(readFileSync(join(dir, f), 'utf8')); return typeof s?.side === 'string' ? [s as SnapshotFile] : []; } catch { return []; }
    });
}

// The owner side of each account from the registry beside a snapshots directory (fleet/owners.json).
export function ownerOfIn(fleetDir: string): OwnerOf {
    let owners: ReturnType<typeof loadOwners>;
    try { owners = loadOwners(join(fleetDir, 'owners.json')); } catch { owners = new Map(); }
    return name => owners.get(name.toLowerCase())?.side;
}

const rowAt = (row: any, file: SnapshotFile) => Number(row?.at ?? file.at) || 0;

// Each account's canonical row, with the side whose file holds it, keyed by lower-case name.
export function canonicalRows(files: readonly SnapshotFile[], ownerOf: OwnerOf): Map<string, any> {
    const best = new Map<string, { row: any; file: SnapshotFile; owned: boolean }>();
    for (const file of files) for (const row of file.accounts ?? []) {
        if (typeof row?.name !== 'string') continue;
        const key = row.name.toLowerCase(), owned = ownerOf(row.name) === file.side, prior = best.get(key);
        if (!prior || (owned && !prior.owned) || (owned === prior.owned && rowAt(row, file) > rowAt(prior.row, prior.file))) best.set(key, { row, file, owned });
    }
    return new Map([...best].map(([k, v]) => [k, { ...v.row, side: v.file.side }]));
}

// Local observations and published observations use the same ownership rule. Filter before choosing a row so a
// practice file cannot hide live stock; include this side's published rows when a fresh container has no status yet.
export function fleetStatusRows(local: readonly any[], files: readonly SnapshotFile[], ownerOf: OwnerOf, side: string, server = 'rs-sdk-demo.fly.dev'): any[] {
    const valid = (row: any) => typeof row?.name === 'string' && /^[A-Za-z0-9]{1,12}$/.test(row.name)
        && typeof row.server === 'string' && row.server.toLowerCase() === server.toLowerCase() && !row.practice;
    return [...canonicalRows([
        { side, accounts: local.filter(valid) },
        // A sync's publication time cannot make an undated account observation newer than a dated local one.
        ...files.map(file => ({ ...file, at: undefined, accounts: (file.accounts ?? []).filter(valid) })),
    ], ownerOf).values()];
}

// The same files with each account kept only in the file of its canonical row, rows in their published order.
export function canonicalSnapshots(files: readonly SnapshotFile[], ownerOf: OwnerOf): SnapshotFile[] {
    const keep = canonicalRows(files, ownerOf);
    return files.map(f => ({ ...f, accounts: (f.accounts ?? []).filter(r => typeof r?.name === 'string' && keep.get(r.name.toLowerCase())?.side === f.side) }));
}
