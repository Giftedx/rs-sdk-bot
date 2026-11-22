import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    applyPhase0Hygiene,
    isProtectedStopEntry,
    scanPhase0Hygiene,
} from '../src/hygiene';
import { applyPhase0Hygiene as cliExportApply } from '../../../tools/practice-hygiene';

const dirs: string[] = [];
const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), 'fleet-hygiene-test-'));
    dirs.push(d);
    return d;
};

afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('Phase 0 fleet hygiene', () => {
    test('dry-run and apply clear leaked fixture stops, stale auto-stops, expired holds, and dead locks while strictly preserving owner and specialist stops', () => {
        const root = scratch();
        const prac = join(root, '.practice');
        const live = join(prac, 'live');
        const simStops = join(prac, 'sim', 'stops');
        const holdsDir = join(prac, 'holds');
        const jobLocks = join(prac, 'job-locks');
        const acctLeases = join(prac, 'account-leases');
        const recoveryLeaseDir = join(prac, 'session-recovery', 'accounts', 'deadacct');
        const liveRecoveryLeaseDir = join(prac, 'session-recovery', 'accounts', 'liveacct');
        const scratchDir = join(prac, 'recovery-permit-abc123');
        const gateDir = join(prac, 'fleet-agent.lock.gate');

        for (const d of [live, simStops, holdsDir, jobLocks, acctLeases, recoveryLeaseDir, liveRecoveryLeaseDir, scratchDir, gateDir]) {
            mkdirSync(d, { recursive: true });
        }

        const now = 1_800_000_000_000;

        // Plan declaring one disabled job.
        writeFileSync(join(root, 'swarm.json'), JSON.stringify({
            jobs: [
                { id: 'disabled-woodcut', name: 'disabled-woodcut', account: 'worker1', script: 'scripts/wc.ts', enabled: false },
                { id: 'active-cook', name: 'active-cook', account: 'worker2', script: 'scripts/cook.ts', enabled: true },
            ],
        }));

        // 1. Leaked fixture stops and proof stop markers across legacy, live, and sim paths.
        const leakedFl = join(prac, 'stop-fltest01');
        const leakedFb = join(live, 'stop-fb99');
        const leakedRng = join(prac, 'stop-rngex77');
        const proofMarker = join(prac, 'stop-worker1');
        const simStop = join(simStops, 'stop-worker3');
        writeFileSync(leakedFl, '');
        writeFileSync(leakedFb, 'temporary fixture stop');
        writeFileSync(leakedRng, 'native recovery proof stop for rngex77');
        writeFileSync(proofMarker, 'native completed stop from local check');
        writeFileSync(simStop, 'sim practice stop');

        // 2. Stale auto-stops.
        const stopPlanner = join(prac, 'stop-planner');
        const stopCloudLaunch = join(prac, 'stop-cloud-launch');
        const autoPausedHealth = join(live, 'stop-worker4');
        const autoSwarmStopped = join(prac, 'stop-worker5');
        const autoSwarmPlanRemoved = join(prac, 'stop-worker6');
        writeFileSync(stopPlanner, 'planner paused during stall');
        writeFileSync(stopCloudLaunch, 'auto paused after timeout');
        writeFileSync(autoPausedHealth, 'fleet-health auto-paused: proxy timeout');
        writeFileSync(autoSwarmStopped, 'swarm stopped');
        writeFileSync(autoSwarmPlanRemoved, 'swarm plan removed or stopped');

        // 3. Strictly protected owner and specialist pause files + active specialist/owner markers.
        const protectedPaths = [
            join(prac, 'stop-coordinator'),
            join(prac, 'stop-swarm'),
            join(prac, 'stop-dashboard-publish'),
            join(prac, 'stop-pk-squad'),
            join(prac, 'stop-runite-radar'),
            join(prac, 'stop-BraveHardon'),
            join(prac, 'stop-UnloadMe'),
            join(prac, 'stop-hiltsdeep'),
            join(prac, 'stop-flowner01'),
            join(live, 'stop-specialist-holder'),
        ];
        writeFileSync(protectedPaths[0]!, 'owner pause');
        writeFileSync(protectedPaths[1]!, '');
        writeFileSync(protectedPaths[2]!, 'manual pause');
        writeFileSync(protectedPaths[3]!, 'owner pause');
        writeFileSync(protectedPaths[4]!, '');
        writeFileSync(protectedPaths[5]!, '');
        writeFileSync(protectedPaths[6]!, '');
        writeFileSync(protectedPaths[7]!, '');
        writeFileSync(protectedPaths[8]!, 'Owner pause prevents deletion even with fl prefix');
        writeFileSync(protectedPaths[9]!, 'manual lock before trade');

        // 4. Expired and preserved holds.
        const holdsFile = join(prac, 'swarm-script-holds.json');
        writeFileSync(holdsFile, JSON.stringify([
            { account: 'worker1', script: 'scripts/old.ts', at: now - 5_000, heldAt: now - 5_000, expiresAt: now - 1_000, reason: 'agent-hold' },
            { account: 'worker2', script: 'scripts/stale.ts', at: now - 48 * 3600_000, heldAt: now - 48 * 3600_000, reason: 'controller-hold' },
            { account: 'worker2', script: 'scripts/died.ts', at: now - 10_000, heldAt: now - 10_000, reason: 'died on step 2' },
            { account: 'specialist-holder', script: 'scripts/wc.ts', at: now - 10_000, heldAt: now - 10_000, expiresAt: now + 60_000, reason: 'active specialist hold' },
            { account: 'hiltsdeep', script: 'scripts/att.ts', at: now - 90 * 3600_000, heldAt: now - 90 * 3600_000, reason: 'reserved board' },
        ], null, 2));

        const expiredHoldJson = join(holdsDir, 'expired-ctrl.json');
        const activeHoldJson = join(holdsDir, 'owner-hold.json');
        writeFileSync(expiredHoldJson, JSON.stringify({ account: 'worker4', expiresAt: now - 500, reason: 'backoff' }));
        writeFileSync(activeHoldJson, JSON.stringify({ account: 'worker-owner', owner: true, reason: 'owner hold' }));

        // 5. Expired leases, obsolete disabled job locks, and live active leases.
        const deadFleetLease = join(prac, 'fleet-agent.lock');
        const deadPubLock = join(prac, 'dashboard-publish.lock');
        const liveSwarmLease = join(prac, 'swarm.lock');
        const staleGateTicket = join(gateDir, '999991.ticket-1');
        const disabledJobLock = join(jobLocks, 'disabled-woodcut.lock');
        const activeJobLock = join(jobLocks, 'active-cook.lock');
        const deadAcctLease = join(acctLeases, 'worker1.lock');
        const deadRecoveryLease = join(recoveryLeaseDir, 'lease.json');
        const liveRecoveryLease = join(liveRecoveryLeaseDir, 'lease.json');

        writeFileSync(deadFleetLease, '999991');
        utimesSync(deadFleetLease, new Date(now - 60_000), new Date(now - 60_000));
        writeFileSync(deadPubLock, JSON.stringify({ pid: 999992 }));
        writeFileSync(liveSwarmLease, String(process.pid));
        utimesSync(liveSwarmLease, new Date(now - 5_000), new Date(now - 5_000));
        writeFileSync(staleGateTicket, '');
        utimesSync(staleGateTicket, new Date(now - 120_000), new Date(now - 120_000));
        writeFileSync(disabledJobLock, JSON.stringify({ job: 'disabled-woodcut', pid: 999993 }));
        writeFileSync(activeJobLock, JSON.stringify({ job: 'active-cook', pid: process.pid }));
        writeFileSync(deadAcctLease, JSON.stringify({ account: 'worker1', pid: 999994 }));
        writeFileSync(deadRecoveryLease, JSON.stringify({ pid: 999995, runId: 'r1' }));
        writeFileSync(liveRecoveryLease, JSON.stringify({ pid: process.pid, runId: 'r2' }));

        const alive = (pid: number) => pid === process.pid;

        // Dry run must leave every file intact.
        const dry = scanPhase0Hygiene(root, { now, alive });
        expect(dry.dry).toBe(true);
        expect(dry.applied).toBe(0);
        expect(dry.counts['fixture-stop']).toBe(5);
        expect(dry.counts['stale-auto-stop']).toBe(5);
        expect(dry.counts['expired-hold']).toBe(3); // 2 array items + 1 holds/*.json file
        expect(dry.counts['obsolete-job-lock']).toBe(2); // disabled-woodcut.lock + deadAcctLease(worker1 disabled)
        expect(dry.counts['expired-lease']).toBe(4); // deadFleetLease, deadPubLock, staleGateTicket, deadRecoveryLease
        expect(dry.counts['scratch-dir']).toBe(1);
        expect(existsSync(leakedFl)).toBe(true);
        expect(existsSync(stopPlanner)).toBe(true);

        // Apply clears findings while leaving all protected stops, active holds, and live leases intact.
        const applied = applyPhase0Hygiene(root, { dry: false, now, alive });
        expect(applied.errors).toEqual([]);
        expect(applied.dry).toBe(false);
        expect(applied.applied).toBeGreaterThanOrEqual(20);

        for (const gone of [
            leakedFl,
            leakedFb,
            leakedRng,
            proofMarker,
            simStop,
            stopPlanner,
            stopCloudLaunch,
            autoPausedHealth,
            autoSwarmStopped,
            autoSwarmPlanRemoved,
            expiredHoldJson,
            deadFleetLease,
            deadPubLock,
            staleGateTicket,
            disabledJobLock,
            deadAcctLease,
            deadRecoveryLease,
            scratchDir,
        ]) {
            expect(existsSync(gone)).toBe(false);
        }

        for (const kept of [
            ...protectedPaths,
            activeHoldJson,
            liveSwarmLease,
            activeJobLock,
            liveRecoveryLease,
        ]) {
            expect(existsSync(kept)).toBe(true);
        }

        const remainingHolds = JSON.parse(readFileSync(holdsFile, 'utf8')) as any[];
        expect(remainingHolds.map(h => h.account)).toEqual(['worker2', 'specialist-holder', 'hiltsdeep']);
    });

    test('tools/practice-hygiene.ts re-export and --phase0 CLI flag operate safely in dry-run and apply on scratch root', () => {
        const root = scratch();
        const prac = join(root, '.practice');
        mkdirSync(prac, { recursive: true });
        writeFileSync(join(prac, 'stop-coordinator'), 'owner hold');
        writeFileSync(join(prac, 'stop-fltemp01'), '');

        expect(isProtectedStopEntry('BraveHardon', '').protected).toBe(true);
        expect(isProtectedStopEntry('pk-squad', 'fleet-health auto-paused: test').protected).toBe(true);

        const dry = cliExportApply(root, { dry: true });
        expect(dry.counts['fixture-stop']).toBe(1);
        expect(existsSync(join(prac, 'stop-fltemp01'))).toBe(true);

        const out = Bun.spawnSync(
            ['bun', 'tools/practice-hygiene.ts', '--phase0', '--root', root, '--apply'],
            { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', windowsHide: true },
        );
        expect(out.exitCode).toBe(0);
        expect(out.stdout.toString()).toContain('RESULT ok practice-hygiene phase0 cleared 1 items');
        expect(existsSync(join(prac, 'stop-fltemp01'))).toBe(false);
        expect(existsSync(join(prac, 'stop-coordinator'))).toBe(true);
    });
});
