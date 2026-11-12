import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keptAccounts, prunable, pruneStatus, STATUS_ROW_MAX_AGE_MS } from '../src/status-prune';

const now = 1_800_000_000_000, old = now - STATUS_ROW_MAX_AGE_MS, fresh = now - STATUS_ROW_MAX_AGE_MS + 1000;
const LIVE = 'rs-sdk-demo.fly.dev', keep = new Set(['rod', 'haggis']);

function fixture(files: Record<string, { text: string; at: number }>) {
    const root = mkdtempSync(join(tmpdir(), 'status-prune-')), dir = join(root, '.practice', 'status');
    mkdirSync(dir, { recursive: true });
    for (const [name, f] of Object.entries(files)) { writeFileSync(join(dir, name), f.text); utimesSync(join(dir, name), f.at / 1000, f.at / 1000); }
    return { root, dir, archive: join(root, '.practice', 'status-archive') };
}
const row = (name: string, server: string) => JSON.stringify({ name, server, result: 'done' });

test('only a row of this machine with an account that is not kept can move', () => {
    expect(prunable({ name: 'aiobfx1', server: 'localhost:43594' }, 'aiobfx1.json', keep)).toBe(true);
    expect(prunable({ name: 'aiobfx1', server: '127.0.0.1:8888' }, 'aiobfx1.json', keep)).toBe(true);
    expect(prunable({ name: 'aiobfx1', server: LIVE }, 'aiobfx1.json', keep)).toBe(false);
    expect(prunable({ name: 'aiobfx1', server: 'localhost.example.com' }, 'aiobfx1.json', keep)).toBe(false);
    expect(prunable({ name: 'Rod', server: 'localhost' }, 'Rod.json', keep)).toBe(false);
    expect(prunable({ name: 'other', server: 'localhost' }, 'ROD.json', keep)).toBe(false);
    expect(prunable({ name: 'Rod', server: 'localhost' }, 'other.json', keep)).toBe(false);
    for (const bad of [null, 'text', 7, [], { name: 'x' }, { name: 'x', server: 5 }]) expect(prunable(bad, 'x.json', keep)).toBe(false);
});

test('an old practice row of an account outside the fleet moves to the archive and each other file stays', () => {
    const f = fixture({
        'aiobfx1.json': { text: row('aiobfx1', 'localhost:43594'), at: old },
        'pvptst2.json': { text: row('pvptst2', '127.0.0.1'), at: old - 9 * STATUS_ROW_MAX_AGE_MS },
        'freshbot.json': { text: row('freshbot', 'localhost'), at: fresh },
        'Rod.json': { text: row('Rod', 'localhost'), at: old },
        'stranger.json': { text: row('stranger', LIVE), at: old },
        'torn.json': { text: '{"name":"torn","server":"localho', at: old },
        'notes.txt': { text: 'localhost', at: old },
        'aiobfx1.json.tmp': { text: row('aiobfx1', 'localhost'), at: old },
    });
    try {
        const dry = pruneStatus(f.root, { now, keep, dry: true });
        expect(dry.moved.sort()).toEqual(['aiobfx1.json', 'pvptst2.json']);
        expect(existsSync(f.archive)).toBe(false);
        expect(readdirSync(f.dir).length).toBe(8);

        // A row of the same name in the archive is replaced.
        mkdirSync(f.archive); writeFileSync(join(f.archive, 'aiobfx1.json'), 'earlier');
        const r = pruneStatus(f.root, { now, keep });
        expect(r.moved.sort()).toEqual(['aiobfx1.json', 'pvptst2.json']);
        expect({ kept: r.kept, failed: r.failed }).toEqual({ kept: 6, failed: 0 });
        expect(readdirSync(f.dir).sort()).toEqual(['Rod.json', 'aiobfx1.json.tmp', 'freshbot.json', 'notes.txt', 'stranger.json', 'torn.json']);
        expect(readdirSync(f.archive).sort()).toEqual(['aiobfx1.json', 'pvptst2.json']);
        expect(readFileSync(join(f.archive, 'aiobfx1.json'), 'utf8')).toBe(row('aiobfx1', 'localhost:43594'));
        expect(pruneStatus(f.root, { now, keep })).toEqual({ moved: [], kept: 6, failed: 0 });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('no status folder gives an empty result, and the kept set joins the fleet owners with the verified logins', () => {
    const root = mkdtempSync(join(tmpdir(), 'status-prune-'));
    try {
        expect(pruneStatus(root, { now, keep })).toEqual({ moved: [], kept: 0, failed: 0 });
        mkdirSync(join(root, '.practice'));
        // A registry entry for a practice server does not keep a row. An entry with no server does.
        writeFileSync(join(root, '.practice', 'owned-accounts.json'), JSON.stringify({ Haggis: {}, WoodPecker: { server: LIVE, at: 1 }, flrmnexe6801: { server: 'localhost:8888', at: 2 }, aiobfx1: { server: '127.0.0.1', at: 3 } }));
        expect([...keptAccounts(root, new Map([['rod', {}]]))].sort()).toEqual(['haggis', 'rod', 'woodpecker']);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
