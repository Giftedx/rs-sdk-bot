// Woodpecker at Varrock West: the swarm started the same location recovery walk 7 times, and each ended
// "RESULT ok walk-to {"ok":true,"ticks":0} at=3185,3436,0" with no change.
import { expect, test } from 'bun:test';
import { NoOpRunGuard, statusFingerprint } from '../../core/src/noop-runs';
import { brainJobFor, brainPlanHold, locationRecoveryArrived, missionSignature, resultEndTile, type EndRecord } from '../src/swarm';
import { dispatchAccountPlan } from '../src/worker-dispatch';

const NOW = 1_795_784_460_670;
const offline = () => Infinity;

const recoveryPlan = () => {
    const plan = {
        account: 'Woodpecker', scorePerHour: 500_000,
        steps: [{ stepKind: 'recover' as const, recoveryKind: 'location' as const, targetHub: 'varrock_west' as const, estimatedTicks: 60, reason: 'stranded off-hub or non-ground plane' }],
    };
    return brainJobFor('Woodpecker', dispatchAccountPlan(plan), plan.steps, 'army');
};

test('a location recovery job is marked, and its RESULT line gives the end tile', () => {
    const built = recoveryPlan();
    expect(built.job?.script).toBe('scripts/aio-logistics.ts');
    expect(built.job?.env?.RECOVERY_TARGET_HUB).toBe('varrock_west');
    expect(built.job?.locationRecovery).toBe(true);
    const line = 'RESULT ok walk-to {"ok":true,"ticks":0} at=3185,3436,0 ticks=7';
    expect(resultEndTile(line)).toEqual({ x: 3185, z: 3436, level: 0 });
    expect(resultEndTile('RESULT ok walk-to {"ok":true}')).toBeUndefined();
    expect(resultEndTile(undefined)).toBeUndefined();
});

test('an ok recovery run at a tile that is not stranded has arrived; a failed one or one in the Wilderness has not', () => {
    expect(locationRecoveryArrived('done after 1 runs', { x: 3185, z: 3436, level: 0 })).toBe(true);
    expect(locationRecoveryArrived('blocked after 1 runs', { x: 3185, z: 3436, level: 0 })).toBe(false);
    expect(locationRecoveryArrived('done after 1 runs', { x: 3100, z: 3700, level: 0 })).toBe(false);
    expect(locationRecoveryArrived('done after 1 runs', undefined)).toBe(false);
});

test('the brain plan of a job held for no-op runs waits until the account state changes', () => {
    const built = recoveryPlan();
    const sig = missionSignature(built.job!);
    const ended = new Map<string, EndRecord>([['Woodpecker', { at: NOW, reason: 'done after 1 runs', revision: sig }]]);
    const status = { pos: { x: 3185, z: 3436, level: 0 }, skills: [{ name: 'Mining', xp: 2_155_812 }], inventory: [{ id: 1269, count: 1 }] };
    let current = statusFingerprint(status);
    const guard = new NoOpRunGuard();
    const hold = (a: string, s: string) => guard.hold(a, s, current);
    expect(brainPlanHold(built, ended, offline, undefined, NOW, undefined, hold)).toBeUndefined();
    for (let i = 0; i < 2; i++) guard.note({ account: 'Woodpecker', signature: sig, job: 'walk-to', ok: true, before: current, after: current, now: NOW + i });
    expect(brainPlanHold(built, ended, offline, undefined, NOW, undefined, hold)).toMatch(/^ended: no-op 2 runs in a row/);
    current = statusFingerprint({ ...status, pos: { x: 3253, z: 3420, level: 0 } });
    expect(brainPlanHold(built, ended, offline, undefined, NOW, undefined, hold)).toBeUndefined();
});
