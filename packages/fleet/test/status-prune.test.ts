import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATUS_ROW_MAX_AGE_MS, keptAccounts, prunable, pruneStatus } from '../src/status-prune';
import { liveStatusArchiveDir, liveStatusDir, simRoot, simStatusDir } from '../../core/src/practice-paths';

const dirs: string[] = [];
const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), 'fleet-status-prune-'));
    dirs.push(d);
    return d;
};

afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('fleet status-prune', () => {
    test('identifies prunable local rows across legacy, live, and sim directories while preserving live accounts', () => {
        const root = scratch();
        const now = 1_800_000_000_000;
        const oldAt = new Date(now - STATUS_ROW_MAX_AGE_MS - 1_000);
        const freshAt = new Date(now - 60_000);

        mkdirSync(join(root, '.practice', 'status'), { recursive: true });
        mkdirSync(liveStatusDir(root), { recursive: true });
        mkdirSync(simStatusDir(root), { recursive: true });

        writeFileSync(join(root, '.practice', 'owned-accounts.json'), JSON.stringify({
            livebot: { server: 'rs-sdk-demo.fly.dev' },
            simonly: { server: 'localhost:8880' },
        }));

        const keep = keptAccounts(root, new Map([['ownerbot', {}]]));
        expect(keep.has('livebot')).toBe(true);
        expect(keep.has('ownerbot')).toBe(true);
        expect(keep.has('simonly')).toBe(false);

        expect(prunable({ name: 'tmpbot', server: 'localhost:8880' }, 'tmpbot.json', keep)).toBe(true);
        expect(prunable({ name: 'livebot', server: 'localhost:8880' }, 'livebot.json', keep)).toBe(false);
        expect(prunable({ name: 'tmpbot', server: 'rs-sdk-demo.fly.dev' }, 'tmpbot.json', keep)).toBe(false);

        const simOld = join(simStatusDir(root), 'simonly.json');
        const legacyOld = join(root, '.practice', 'status', 'oldlocal.json');
        const liveKeep = join(liveStatusDir(root), 'livebot.json');
        const simFresh = join(simStatusDir(root), 'freshsim.json');

        writeFileSync(simOld, JSON.stringify({ name: 'simonly', server: 'localhost:8880' }));
        utimesSync(simOld, oldAt, oldAt);

        writeFileSync(legacyOld, JSON.stringify({ name: 'oldlocal', server: '127.0.0.1:8881' }));
        utimesSync(legacyOld, oldAt, oldAt);

        writeFileSync(liveKeep, JSON.stringify({ name: 'livebot', server: 'localhost:8880' }));
        utimesSync(liveKeep, oldAt, oldAt);

        writeFileSync(simFresh, JSON.stringify({ name: 'freshsim', server: 'localhost:8880' }));
        utimesSync(simFresh, freshAt, freshAt);

        const dry = pruneStatus(root, { now, keep, dry: true });
        expect(dry.moved.sort()).toEqual(['oldlocal.json', 'simonly.json']);
        expect(existsSync(simOld)).toBe(true);

        const applied = pruneStatus(root, { now, keep, dry: false });
        expect(applied.moved.sort()).toEqual(['oldlocal.json', 'simonly.json']);
        expect(applied.failed).toBe(0);
        expect(existsSync(simOld)).toBe(false);
        expect(existsSync(join(simRoot(root), 'status-archive', 'simonly.json'))).toBe(true);
        expect(existsSync(legacyOld)).toBe(false);
        expect(existsSync(join(root, '.practice', 'status-archive', 'oldlocal.json'))).toBe(true);
        expect(existsSync(liveKeep)).toBe(true);
        expect(existsSync(simFresh)).toBe(true);
        expect(liveStatusArchiveDir(root)).toContain('status-archive');
    });
});
