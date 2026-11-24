import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { brainCycleDue, clearAutoStop, DEFAULT_BRAIN_CYCLE_MS, isAutoStopText } from '../src/swarm';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');

describe('root swarm.json validity and Brain throttle helpers', () => {
    test('root swarm.json has no legacy coordination block, no deleted script refs, and keeps protected reservations', () => {
        const raw = JSON.parse(readFileSync(join(REPO_ROOT, 'swarm.json'), 'utf8')) as {
            maxBots: number;
            minFreeGB: number;
            coordination?: unknown;
            jobs: Array<{ account?: string; accounts?: string[]; script?: string; args?: string[]; enabled?: boolean }>;
        };

        expect(raw.coordination).toBeUndefined();
        expect(raw.maxBots).toBeGreaterThan(0);
        expect(raw.minFreeGB).toBeGreaterThanOrEqual(4);
        expect(Array.isArray(raw.jobs)).toBe(true);

        const byAccount = new Map(raw.jobs.map((j) => [j.account?.toLowerCase(), j]));
        for (const reserved of ['haggis', 'shaftshooter', 'polevaulter', 'mightyrod']) {
            const job = byAccount.get(reserved);
            expect(job).toBeDefined();
            expect(job!.enabled).toBe(false);
            expect(job!.script).toBe('');
        }

        for (const job of raw.jobs) {
            if (job.script) {
                expect(existsSync(join(REPO_ROOT, job.script))).toBe(true);
            }
            if (job.script === 'scripts/chain.ts' && Array.isArray(job.args)) {
                for (const arg of job.args) {
                    const first = arg.trim().split(/\s+/)[0];
                    if (first?.startsWith('scripts/')) {
                        expect(existsSync(join(REPO_ROOT, first))).toBe(true);
                    }
                }
            }
        }
    });

    test('brainCycleDue refreshes on first tick, worker exit, pending commands, plan mtime change, or interval expiry', () => {
        const base = {
            hasCached: true,
            dirty: false,
            now: 100_000,
            lastAt: 95_000,
            intervalMs: DEFAULT_BRAIN_CYCLE_MS,
            hasPendingCommands: false,
            planMtime: 500,
            lastPlanMtime: 500,
        };
        expect(brainCycleDue(base)).toBe(false);
        expect(brainCycleDue({ ...base, hasCached: false })).toBe(true);
        expect(brainCycleDue({ ...base, dirty: true })).toBe(true);
        expect(brainCycleDue({ ...base, hasPendingCommands: true })).toBe(true);
        expect(brainCycleDue({ ...base, planMtime: 501 })).toBe(true);
        expect(brainCycleDue({ ...base, now: 95_000 + DEFAULT_BRAIN_CYCLE_MS })).toBe(true);
    });

    test('isAutoStopText and clearAutoStop clear stale auto-stops while preserving owner pauses', () => {
        expect(isAutoStopText('swarm stopped')).toBe(true);
        expect(isAutoStopText('fleet-health auto-paused: fail Error: combat travel original owner/life/stop')).toBe(true);
        expect(isAutoStopText('owner pause 2026-11-22')).toBe(false);
        expect(isAutoStopText('')).toBe(false);

        const dir = mkdtempSync(join(tmpdir(), 'swarm-autostop-'));
        try {
            const autoFile = join(dir, 'stop-BotA');
            const ownerFile = join(dir, 'stop-BotB');
            writeFileSync(autoFile, 'fleet-health auto-paused: fail Error: owner/life/stop');
            writeFileSync(ownerFile, 'owner stop: manual pause');
            expect(clearAutoStop(autoFile)).toBe(true);
            expect(existsSync(autoFile)).toBe(false);
            expect(clearAutoStop(ownerFile)).toBe(false);
            expect(existsSync(ownerFile)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
