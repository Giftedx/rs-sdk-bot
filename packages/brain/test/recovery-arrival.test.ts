// A location recovery whose target is the hub bank where the account stands: Woodpecker at Varrock West
// (3185,3436) kept a "no ore progress: cannot reach mine route" stranded hold, and each brain pass planned the same
// hub walk, which ended ok after 2 to 7 ticks where it started.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { standsAtHubBank, HUB_ARRIVAL_TILES, type AccountState, type WorldSnapshot } from '../src/contracts';
import { OutcomeClassifier } from '../src/outcome-classifier';
import { planAccount } from '../src/planner';
import { classifyAccountLifecycle } from '../src/snapshot';

const NOW = 1_795_784_000_000;
const VARROCK_WEST = { x: 3185, z: 3436, level: 0 };
// The Varrock south-east mine: a safe mainland tile, not a hub bank.
const MINE = { x: 3285, z: 3365, level: 0 };
let root = '';

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'recovery-arrival-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function acct(pos: AccountState['pos'], lifecycle: AccountState['lifecycle'] = 'idle'): AccountState {
    return {
        name: 'Woodpecker',
        side: 'local',
        role: 'army',
        protectedClock: false,
        lifecycle,
        skills: { Mining: { level: 99, xp: 2_155_812 } },
        quests: {},
        pos,
        inventory: { 1269: 1 },
        equipment: {},
        bank: { items: { 995: 1000 }, observedAt: NOW - 1000, trusted: true },
    };
}

const world = (a: AccountState): WorldSnapshot => ({ schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { [a.name]: a } });

test('standsAtHubBank holds within HUB_ARRIVAL_TILES of a hub bank tile on its floor', () => {
    expect(standsAtHubBank(VARROCK_WEST)).toBe(true);
    expect(standsAtHubBank(VARROCK_WEST, 'varrock_west')).toBe(true);
    expect(standsAtHubBank({ ...VARROCK_WEST, x: VARROCK_WEST.x + HUB_ARRIVAL_TILES })).toBe(true);
    expect(standsAtHubBank({ ...VARROCK_WEST, x: VARROCK_WEST.x + HUB_ARRIVAL_TILES + 1 })).toBe(false);
    expect(standsAtHubBank({ ...VARROCK_WEST, level: 1 })).toBe(false);
    expect(standsAtHubBank(MINE)).toBe(false);
    expect(standsAtHubBank(null)).toBe(false);
});

test('a stranded hold sends an account off a hub to recovery, and none at a hub bank', () => {
    const base = { name: 'Woodpecker', protectedClock: false, logoutProofState: 'confirmed' as const, statusSettledOffline: true, strandedHold: true };
    expect(classifyAccountLifecycle({ ...base, pos: MINE })).toBe('needs_location_recovery');
    expect(classifyAccountLifecycle({ ...base, pos: VARROCK_WEST })).toBe('idle');
    // A position that is stranded by itself still needs recovery.
    expect(classifyAccountLifecycle({ ...base, pos: { ...VARROCK_WEST, level: 1 } })).toBe('needs_location_recovery');
});

test('the planner plans no location recovery to the hub bank the account stands at', () => {
    const atHub = acct(VARROCK_WEST, 'needs_location_recovery');
    const plan = planAccount(atHub, { world: world(atHub), activities: [], demands: [] });
    expect(plan.steps).toEqual([]);
    expect(plan.idleReason).toBe('recovery_target_reached:varrock_west');
    const offHub = acct(MINE, 'needs_location_recovery');
    const step = planAccount(offHub, { world: world(offHub), activities: [], demands: [] }).steps[0];
    expect(step?.stepKind).toBe('recover');
});

test('a stranded hold ends at a hub bank, and clearLocationRecovery ends it at once after a recovery run', () => {
    const classifier = new OutcomeClassifier({ root, persist: false });
    const res = classifier.applyOutcome(
        { kind: 'location_stranded', activityId: 'gather:mining-essence', account: 'Woodpecker', ticksElapsed: 50, pos: MINE, detail: 'no ore progress: cannot reach mine route' },
        { now: NOW },
    );
    expect(res.accountLifecycle).toBe('needs_location_recovery');

    // Still at the mine: the hold sends the account to recovery.
    const atMine = classifier.applyToSnapshot(world(acct(MINE)), NOW + 1000).accounts.Woodpecker!;
    expect(atMine.lifecycle).toBe('needs_location_recovery');
    expect(atMine.systemHolds?.some((h) => h.key === 'location_stranded')).toBe(true);

    // At Varrock West the walk has arrived: no recovery lifecycle, no stranded hold.
    const atHub = classifier.applyToSnapshot(world(acct(VARROCK_WEST)), NOW + 2000).accounts.Woodpecker!;
    expect(atHub.lifecycle).toBe('idle');
    expect(atHub.systemHolds?.some((h) => h.key === 'location_stranded') ?? false).toBe(false);

    // The swarm calls this after an ok recovery run; the overlay is then gone for any later position.
    expect(classifier.clearLocationRecovery('woodpecker', NOW + 3000)).toBe(true);
    expect(classifier.snapshotState(NOW + 3000).accountOverlays.woodpecker).toBeUndefined();
    expect(classifier.applyToSnapshot(world(acct(MINE)), NOW + 4000).accounts.Woodpecker!.lifecycle).toBe('idle');
    expect(classifier.clearLocationRecovery('Woodpecker', NOW + 5000)).toBe(false);
});

test('clearLocationRecovery keeps other holds and a dead lifecycle', () => {
    const classifier = new OutcomeClassifier({ root, persist: false });
    classifier.applyOutcome(
        { kind: 'location_stranded', activityId: 'gather:mining-essence', account: 'Woodpecker', ticksElapsed: 50, pos: MINE, detail: 'stuck' },
        { now: NOW },
    );
    classifier.applyOutcome(
        { kind: 'death', activityId: 'combat:hill-giants', account: 'Woodpecker', ticksElapsed: 10, faultSignature: 'Died', pos: MINE, logPath: 'x.log' },
        { now: NOW + 10 },
    );
    expect(classifier.clearLocationRecovery('Woodpecker', NOW + 20)).toBe(true);
    expect(classifier.snapshotState(NOW + 20).accountOverlays.woodpecker?.lifecycleOverride).toBe('dead');
});
