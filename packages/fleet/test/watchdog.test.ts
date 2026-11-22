import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    STALL_MS,
    publisherRepo,
    recoveryLog,
    restartCommand,
    runWatchdogPass,
    stalled,
} from '../src/watchdog';
import { launcherScript } from '../src/watchdog-install';

const dirs: string[] = [];
const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), 'fleet-watchdog-test-'));
    dirs.push(d);
    return d;
};

afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('fleet watchdog', () => {
    test('detects stalled progress, builds controller restart commands, parses publisher repo and recovery log', () => {
        const t0 = 1_000_000;
        expect(stalled([
            { at: t0, progress: { goalVersion: 1, goalMetrics: { quests: 10 } } },
            { at: t0 + STALL_MS - 1_000, progress: { goalVersion: 1, goalMetrics: { quests: 10 } } },
        ], t0 + STALL_MS - 1_000)).toBeNull();

        expect(stalled([
            { at: t0, progress: { goalVersion: 1, goalMetrics: { quests: 10 } } },
            { at: t0 + STALL_MS + 1_000, progress: { goalVersion: 1, goalMetrics: { quests: 10 } } },
        ], t0 + STALL_MS + 1_000)?.since).toBe(t0);

        expect(restartCommand('fleet-agent', { args: [], env: {} })).toEqual(['scripts/fleet-agent.ts', '--daemon']);
        expect(restartCommand('swarm', { args: ['plans/p1.json'], env: {} }, () => true)).toEqual([
            'scripts/swarm.ts',
            'plans/p1.json',
        ]);
        expect(restartCommand('swarm', { args: ['plans/missing.json'], env: {} }, () => false)).toContain(
            'its recorded plan is not a file',
        );

        expect(publisherRepo('https://github.com/Giftedx/rs-fleet-dashboard.git')).toBe('Giftedx/rs-fleet-dashboard');
        expect(publisherRepo('git@github.com:Giftedx/rs-fleet-dashboard.git')).toBe('Giftedx/rs-fleet-dashboard');
        expect(publisherRepo('https://example.com/other/repo.git')).toBeNull();

        expect(recoveryLog('FLEET_RECOVERY worker1 recovered\nCLOUD_RECOVER worker2 ok\n', '', 0)).toEqual([
            'session recovery: worker1 recovered',
            'session recovery: worker2 ok',
        ]);
        expect(recoveryLog('', 'boom', 2)).toEqual(['session recovery call exit 2: boom']);
    });

    test('honors owner stops without coordinator restart or coordinator dependency', async () => {
        const root = scratch();
        mkdirSync(join(root, '.practice', 'fleet'), { recursive: true });
        writeFileSync(join(root, '.practice', 'stop-coordinator'), 'owner pause');

        const logs: string[] = [];
        const restarted: string[] = [];
        let recoverCalled = false;

        const res = await runWatchdogPass(root, {
            now: () => 2_000_000,
            hasStop: flag => flag === 'coordinator',
            prune: () => ({ moved: [], kept: 0, failed: 0 }),
            restartController: c => restarted.push(c.name),
            recover: async () => { recoverCalled = true; },
            log: line => logs.push(line),
        });

        expect(res).toEqual({ stoppedByOwner: true, pruned: 0 });
        expect(restarted).toEqual([]);
        expect(recoverCalled).toBe(false);
        expect(logs).toContain('owner stop present; nothing started');
    });

    test('restarts down controllers from saved launch record and invokes standalone recovery with zero coordinator source reference', async () => {
        const root = scratch();
        mkdirSync(join(root, '.practice', 'autopilot'), { recursive: true });
        mkdirSync(join(root, '.practice', 'fleet'), { recursive: true });
        writeFileSync(join(root, '.practice', 'fleet-agent.launch.json'), JSON.stringify({ args: [], env: { FLEET_SIDE: 'local' } }));
        utimesSync(join(root, '.practice', 'fleet-agent.launch.json'), new Date(1_000_000), new Date(1_000_000));

        const restarted: { name: string; start: string[] }[] = [];
        let recoverCount = 0;

        const res = await runWatchdogPass(root, {
            now: () => 2_000_000,
            hasStop: () => false,
            prune: () => ({ moved: ['sim.json'], kept: 1, failed: 0 }),
            restartController: (c, start) => restarted.push({ name: c.name, start }),
            recover: async () => { recoverCount++; },
            log: () => {},
        });

        expect(res.stoppedByOwner).toBe(false);
        expect(res.pruned).toBe(1);
        expect(restarted).toEqual([{ name: 'fleet-agent', start: ['scripts/fleet-agent.ts', '--daemon'] }]);
        expect(recoverCount).toBe(1);

        const watchdogSrc = readFileSync(join(import.meta.dir, '..', 'src', 'watchdog.ts'), 'utf8');
        expect(watchdogSrc).not.toContain('coordinator-cli');
        expect(watchdogSrc).not.toContain('packages/router');
        expect(launcherScript('C:\\bun.exe', 'D:\\repo')).toContain('watchdog.ts');
    });
});
