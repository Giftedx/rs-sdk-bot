import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultActivityCatalog } from '../src/catalog';
import type { AccountState, NoRouteFact, WorldSnapshot } from '../src/contracts';
import { NO_ROUTE_TTL_MS, parseNoRoute } from '../src/no-route';
import { OutcomeClassifier } from '../src/outcome-classifier';
import { activityPreflightFromConfig, evaluatePreflight, evaluateTileReachability } from '../src/preflight';

const NOW = 1_800_000_000_000;
const MEAT = { x: 2793, z: 3516, level: 0 };
const ARDOUGNE_NORTH = { x: 2619, z: 3332, level: 0 };
const ARDOUGNE_MARKET = { x: 2654, z: 3283, level: 0 };
const VARROCK_WEST = { x: 3185, z: 3436, level: 0 };
// MeatNTwoVeg's live failures (.practice/swarm-logs/MeatNTwoVeg.log).
const SPLASH = 'RESULT fail Error: splash: walk to the Ardougne north bank failed: precondition no route to 2619,3332,0';
const KNIGHTS = 'RESULT fail Error: travel to Ardougne from 2793,3516,0 failed: precondition no route to 2654,3283,0 chain rounds=1 ok=0 failed=1';

let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'brain-no-route-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function meat(pos: AccountState['pos'] = MEAT, noRoutes?: readonly NoRouteFact[]): AccountState {
    return {
        name: 'MeatNTwoVeg',
        side: 'local',
        role: 'auto',
        protectedClock: false,
        lifecycle: 'idle',
        skills: {
            Attack: { level: 30, xp: 8_000 },
            Strength: { level: 30, xp: 8_000 },
            Defence: { level: 30, xp: 8_000 },
            Hitpoints: { level: 43, xp: 20_000 },
            Magic: { level: 40, xp: 16_000 },
            Thieving: { level: 60, xp: 64_000 },
        },
        quests: {},
        pos,
        inventory: {},
        equipment: {},
        bank: { items: {}, observedAt: NOW - 1000, trusted: true },
        ...(noRoutes ? { noRoutes } : {}),
    };
}

const world = (acct: AccountState): WorldSnapshot => ({
    schemaVersion: 1,
    at: NOW,
    side: 'local',
    server: 'rs-sdk-demo.fly.dev',
    accounts: { [acct.name]: acct },
});

const fact = (activityId: string, to = ARDOUGNE_NORTH, from = MEAT): NoRouteFact =>
    ({ from, to, activityId, observedAt: NOW - 60_000, expiresAt: NOW - 60_000 + NO_ROUTE_TTL_MS });

test('parseNoRoute reads the target and the start of the failed search from the live failure texts', () => {
    expect(parseNoRoute(KNIGHTS)).toEqual({ from: MEAT, to: ARDOUGNE_MARKET });
    expect(parseNoRoute('RESULT fail travel to Ardougne from 2821,3552 failed: precondition no route to 2619,3332,0', MEAT))
        .toEqual({ from: { x: 2821, z: 3552, level: 0 }, to: ARDOUGNE_NORTH });
    expect(parseNoRoute('RESULT fail quest-sweep druid bank walk failed at {"x":2898,"z":3544,"level":0}: precondition no route to 2946,3368,0'))
        .toEqual({ from: { x: 2898, z: 3544, level: 0 }, to: { x: 2946, z: 3368, level: 0 } });
    expect(parseNoRoute('RESULT fail Error: market bank travel failed: position=2859,3486,0 currentHP=10 ticks=3; Error: no route to 3185,3436,0'))
        .toEqual({ from: { x: 2859, z: 3486, level: 0 }, to: VARROCK_WEST });
    // The splash text names no start: the run's end position is the start.
    expect(parseNoRoute(SPLASH, MEAT)).toEqual({ from: MEAT, to: ARDOUGNE_NORTH });
    expect(parseNoRoute(SPLASH)).toBeNull();
    // A search that used all of its budget is no proof that the route does not exist.
    expect(parseNoRoute('RESULT fail walk failed: precondition no route (search over 45000 ms) to 2619,3332,0', MEAT)).toBeNull();
    expect(parseNoRoute('RESULT fail no goldfarm progress: start in Ardougne market, not 2793,3516,0', MEAT)).toBeNull();
});

test('a "no route" failure where the run ended is a fact about the account, not a defect of the activity', () => {
    const classifier = new OutcomeClassifier({ root, persist: true });
    const res = classifier.classifyAndApplyRaw(
        { activityId: 'combat:magic-splash', account: 'MeatNTwoVeg', exitCode: 1, status: 'fail', reason: 'blocked after 1 runs', detail: SPLASH, pos: MEAT },
        { now: NOW },
    );
    expect(res.outcome.kind).toBe('worker_defect');
    expect(res.defect).toBeUndefined();
    expect(res.noRoute).toEqual({ from: MEAT, to: ARDOUGNE_NORTH, activityId: 'combat:magic-splash', observedAt: NOW, expiresAt: NOW + NO_ROUTE_TTL_MS });
    expect(classifier.quarantinedDefects(NOW)).toEqual([]);

    // The fact is saved and reaches the planner's account state after a restart.
    const reloaded = new OutcomeClassifier({ root, persist: true });
    const snap = reloaded.applyToSnapshot(world(meat()), NOW + 60_000);
    expect(snap.accounts.MeatNTwoVeg!.noRoutes).toEqual([res.noRoute!]);

    // The account walked away: the fact ends, and the saved state drops it.
    const moved = reloaded.applyToSnapshot(world(meat(VARROCK_WEST)), NOW + 120_000);
    expect(moved.accounts.MeatNTwoVeg!.noRoutes).toBeUndefined();
    expect(reloaded.snapshotState(NOW + 120_000).noRoutes).toBeUndefined();
});

test('a "no route" from a tile where the run did not end stays a defect of the activity', () => {
    const classifier = new OutcomeClassifier({ root, persist: false });
    const res = classifier.classifyAndApplyRaw(
        { activityId: 'gather:thieving-knights', account: 'MeatNTwoVeg', exitCode: 1, status: 'fail', reason: 'blocked after 1 runs', detail: KNIGHTS, pos: { x: 2900, z: 3500, level: 0 } },
        { now: NOW },
    );
    expect(res.noRoute).toBeUndefined();
    expect(res.defect?.activityId).toBe('gather:thieving-knights');
    const noPos = classifier.classifyAndApplyRaw(
        { activityId: 'combat:magic-splash', account: 'MeatNTwoVeg', exitCode: 1, status: 'fail', reason: 'blocked after 1 runs', detail: SPLASH },
        { now: NOW },
    );
    expect(noPos.noRoute).toBeUndefined();
    expect(noPos.defect?.activityId).toBe('combat:magic-splash');
});

test('one no-route fact refuses every Ardougne activity that MeatNTwoVeg was given, and only while it stands there', () => {
    const catalog = defaultActivityCatalog();
    const ids = ['combat:magic-splash', 'combat:cow', 'gather:thieving-knights', 'gather:thieving-knights-stable'];
    const facts = [fact('combat:magic-splash')];
    const refused = (acct: AccountState, id: string) => activityPreflightFromConfig(acct, catalog.get(id)!, world(acct))
        .blockers.some(b => b.kind === 'unreachable_tile' && b.reason === 'no_route');
    for (const id of ids) {
        expect([id, refused(meat(), id)]).toEqual([id, false]);
        expect([id, refused(meat(MEAT, facts), id)]).toEqual([id, true]);
        expect([id, refused(meat({ x: 2803, z: 3516, level: 0 }, facts), id)]).toEqual([id, false]);
    }
    // An activity with no location is refused by its own fact.
    const druid = { id: 'quest:druid', config: {} };
    expect(activityPreflightFromConfig(meat(), druid, world(meat())).ok).toBe(true);
    const withDruid = meat(MEAT, [fact('quest:druid', { x: 2946, z: 3368, level: 0 })]);
    expect(activityPreflightFromConfig(withDruid, druid, world(withDruid)).blockers).toContainEqual(expect.objectContaining({ kind: 'unreachable_tile', reason: 'no_route' }));
});

test('with no route to Ardougne North, a walk east from Kandarin costs no ferry fare', () => {
    // Without the fact, preflight charges the two boats by Ardougne North, and a 0-coin account is refused.
    expect(evaluateTileReachability(meat(), VARROCK_WEST, world(meat()))).toMatchObject({ reachable: true, travelCoins: 60 });
    expect(evaluatePreflight(meat(), { targetTile: VARROCK_WEST }, world(meat())).ok).toBe(false);
    const stuck = meat(MEAT, [fact('combat:magic-splash')]);
    expect(evaluateTileReachability(stuck, VARROCK_WEST, world(stuck))).toMatchObject({ reachable: true, travelCoins: 0 });
    expect(evaluatePreflight(stuck, { targetTile: VARROCK_WEST }, world(stuck)).ok).toBe(true);
});

test('a target nearer the account than the tile with no route stays reachable', () => {
    const from = { x: 2660, z: 3360, level: 0 };
    const acct = meat(from, [fact('combat:magic-splash', ARDOUGNE_NORTH, from)]);
    expect(evaluateTileReachability(acct, { x: 2655, z: 3358, level: 0 }, world(acct)).reachable).toBe(true);
    expect(evaluateTileReachability(acct, { x: 2622, z: 3330, level: 0 }, world(acct)).reachable).toBe(false);
    // An expired fact refuses nothing.
    const old = meat(MEAT, [{ ...fact('combat:magic-splash'), expiresAt: NOW - 1 }]);
    expect(evaluateTileReachability(old, ARDOUGNE_NORTH, world(old)).reachable).toBe(true);
});

test('an operator resume clears the account no-route facts', () => {
    const classifier = new OutcomeClassifier({ root, persist: true });
    classifier.classifyAndApplyRaw(
        { activityId: 'combat:magic-splash', account: 'MeatNTwoVeg', exitCode: 1, status: 'fail', reason: 'blocked after 1 runs', detail: SPLASH, pos: MEAT },
        { now: NOW },
    );
    const resume = { schemaVersion: 1, id: 'cmd-1', issuedAt: NOW, issuedBy: 'test', kind: 'resume_account', account: 'MeatNTwoVeg' } as const;
    expect(classifier.applyOperatorCommand(resume, NOW)).toBe(true);
    expect(classifier.applyToSnapshot(world(meat()), NOW).accounts.MeatNTwoVeg!.noRoutes).toBeUndefined();
});
