import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultActivityCatalog } from '../src/catalog';
import type { AccountState, ActivityDefinition, GoalDemand, NoRouteFact, WorldSnapshot } from '../src/contracts';
import { planAccount } from '../src/planner';
import { enclosedAt, NO_ROUTE_TTL_MS, noRouteState, noRouteTo, parseNoRoute } from '../src/no-route';
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
    expect(snap.accounts.MeatNTwoVeg!.noRoutes).toEqual([{ ...res.noRoute!, state: noRouteState(meat()) }]);

    // The account walked away: the fact ends, and the saved state drops it.
    const moved = reloaded.applyToSnapshot(world(meat(VARROCK_WEST)), NOW + 120_000);
    expect(moved.accounts.MeatNTwoVeg!.noRoutes).toBeUndefined();
    expect(reloaded.snapshotState(NOW + 120_000).noRoutes).toEqual({});
});

test('the first load of a state saved before no-route facts turns a no-route defect text into a fact, once', () => {
    const file = join(root, 'outcome-state.json');
    const classifier = new OutcomeClassifier({ filePath: file, persist: true });
    // MeatNTwoVeg's saved thieving-knights defect: its text names the start of the search.
    classifier.classifyAndApplyRaw(
        { activityId: 'gather:thieving-knights', account: 'MeatNTwoVeg', exitCode: 1, status: 'fail', reason: 'blocked after 1 runs', detail: KNIGHTS },
        { now: NOW },
    );
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.noRoutes).toEqual({});
    delete saved.noRoutes;
    writeFileSync(file, JSON.stringify(saved));

    const migrated = new OutcomeClassifier({ filePath: file, persist: true });
    const expected: NoRouteFact = { from: MEAT, to: ARDOUGNE_MARKET, activityId: 'gather:thieving-knights', observedAt: NOW, expiresAt: NOW + NO_ROUTE_TTL_MS };
    expect(migrated.applyToSnapshot(world(meat()), NOW + 60_000).accounts.MeatNTwoVeg!.noRoutes).toEqual([{ ...expected, state: noRouteState(meat()) }]);
    expect(migrated.quarantinedDefects(NOW + 60_000).map(d => d.activityId)).toEqual(['gather:thieving-knights']);

    // A resume clears the fact for good: the state now holds `noRoutes`, so a later load does not convert again.
    migrated.applyOperatorCommand({ schemaVersion: 1, id: 'cmd-2', issuedAt: NOW, issuedBy: 'test', kind: 'resume_account', account: 'MeatNTwoVeg' }, NOW + 60_000);
    const again = new OutcomeClassifier({ filePath: file, persist: true });
    expect(again.applyToSnapshot(world(meat()), NOW + 120_000).accounts.MeatNTwoVeg!.noRoutes).toBeUndefined();
});

test('a fact ends when the account gains coins, items or levels that a route search reads', () => {
    const fail = { activityId: 'combat:magic-splash', account: 'MeatNTwoVeg', exitCode: 1, status: 'fail', reason: 'blocked after 1 runs', detail: SPLASH, pos: MEAT };
    const holds = (classifier: OutcomeClassifier, acct: AccountState, at: number) =>
        classifier.applyToSnapshot(world(acct), at).accounts.MeatNTwoVeg!.noRoutes?.length ?? 0;
    const broke = meat();
    const paid: AccountState = { ...broke, bank: { ...broke.bank, items: { 995: 60 } } };
    const stronger: AccountState = { ...broke, skills: { ...broke.skills, Defence: { level: 45, xp: 61_000 } } };
    for (const [name, changed] of [['coins', paid], ['levels', stronger]] as const) {
        const classifier = new OutcomeClassifier({ persist: false });
        classifier.classifyAndApplyRaw(fail, { now: NOW });
        // The first snapshot after the run gives the fact the account's state, and the same state keeps it.
        expect([name, holds(classifier, broke, NOW + 1_000), holds(classifier, broke, NOW + 2_000)]).toEqual([name, 1, 1]);
        expect([name, holds(classifier, changed, NOW + 3_000)]).toEqual([name, 0]);
        // The fact is gone, not hidden: the old state does not bring it back.
        expect([name, holds(classifier, broke, NOW + 4_000)]).toEqual([name, 0]);
    }
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
    // The quest sweep sails from Brimhaven for this start whatever the route to Ardougne North (crossEast), so a
    // quest east still needs the fare.
    const quest = defaultActivityCatalog().get('quest:priest')!;
    expect(activityPreflightFromConfig(stuck, quest, world(stuck)).blockers)
        .toContainEqual(expect.objectContaining({ kind: 'missing_coins', ferryFare: 60 }));
    const essence = defaultActivityCatalog().get('gather:mining-essence')!;
    expect(activityPreflightFromConfig(stuck, essence, world(stuck)).blockers.filter(b => b.kind === 'missing_coins' || b.kind === 'unreachable_tile')).toEqual([]);
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

// KnightRider, shut in the West Ardougne Mourner HQ (.practice/swarm-logs/KnightRider.log, .practice/fleet-agent.log).
const MOURNER_HQ = { x: 2546, z: 3325, level: 0 };
const KARAMJA_JIMINUA = { x: 2767, z: 3122, level: 0 };
const ARDOUGNE_HUB = { x: 2617, z: 3333, level: 0 };

test('a shop buy and a fleet trade with no route from where the run ended each record a no-route fact', () => {
    const classifier = new OutcomeClassifier({ root, persist: true });
    const shop = classifier.classifyAndApplyRaw(
        { activityId: 'market:shop-buy', account: 'KnightRider', exitCode: 1, status: 'fail', reason: 'blocked after 1 runs', detail: 'RESULT fail Error: shop travel failed: position=2546,3325,0; no route to 2767,3122,0', pos: MOURNER_HQ },
        { now: NOW },
    );
    expect(shop.outcome.kind).toBe('worker_defect');
    expect(shop.defect).toBeUndefined();
    expect(shop.noRoute).toEqual({ from: MOURNER_HQ, to: KARAMJA_JIMINUA, activityId: 'market:shop-buy', observedAt: NOW, expiresAt: NOW + NO_ROUTE_TTL_MS });
    const trade = classifier.classifyAndApplyRaw(
        { activityId: 'logistics:trade', account: 'KnightRider', exitCode: 1, status: 'fail', reason: 'fail', detail: 'RESULT fail fleet-trade xfer-1795730863043-1 failed 0/1: Error: route to 2617, 3333: precondition no route to 2617,3333,0', pos: MOURNER_HQ },
        { now: NOW },
    );
    expect(trade.outcome.kind).toBe('worker_defect');
    expect(trade.noRoute?.to).toEqual(ARDOUGNE_HUB);
});

test('an account with no route from its tile to two far-apart places needs location recovery, not a job elsewhere', () => {
    const knight = (pos: AccountState['pos'], noRoutes?: readonly NoRouteFact[]): AccountState => ({ ...meat(pos, noRoutes), name: 'KnightRider' });
    expect(enclosedAt([fact('market:shop-buy', KARAMJA_JIMINUA, MOURNER_HQ), fact('logistics:trade', VARROCK_WEST, MOURNER_HQ)], MOURNER_HQ, NOW)?.to).toEqual(VARROCK_WEST);
    // Two targets in one place say the obstacle is there, not at the start.
    expect(enclosedAt([fact('market:shop-buy', ARDOUGNE_NORTH, MOURNER_HQ), fact('logistics:trade', ARDOUGNE_MARKET, MOURNER_HQ)], MOURNER_HQ, NOW)).toBeUndefined();
    // Away from the start, the facts hold nothing.
    expect(enclosedAt([fact('market:shop-buy', KARAMJA_JIMINUA, MOURNER_HQ), fact('logistics:trade', VARROCK_WEST, MOURNER_HQ)], VARROCK_WEST, NOW)).toBeUndefined();

    const classifier = new OutcomeClassifier({ root, persist: true });
    for (const [activityId, detail] of [
        ['market:shop-buy', 'RESULT fail Error: shop travel failed: position=2546,3325,0; no route to 2767,3122,0'],
        ['market:ge-buy', 'RESULT fail Error: market bank travel failed: position=2546,3325,0 currentHP=10 ticks=3; Error: no route to 3185,3436,0'],
    ] as const) {
        classifier.classifyAndApplyRaw({ activityId, account: 'KnightRider', exitCode: 1, status: 'fail', detail, pos: MOURNER_HQ }, { now: NOW });
    }
    expect(classifier.applyToAccount(knight(MOURNER_HQ), NOW + 1_000).lifecycle).toBe('needs_location_recovery');
    expect(classifier.applyToAccount(knight(VARROCK_WEST), NOW + 2_000).lifecycle).toBe('idle');
});

test('an account at a hub bank with no route to two far-apart places stays idle, since the recovery walk ends there', () => {
    const classifier = new OutcomeClassifier({ root, persist: true });
    for (const [activityId, detail] of [
        ['market:shop-buy', 'RESULT fail Error: shop travel failed: position=3185,3436,0; no route to 2767,3122,0'],
        ['market:ge-buy', 'RESULT fail Error: market bank travel failed: position=3185,3436,0; Error: no route to 2619,3332,0'],
    ] as const) {
        classifier.classifyAndApplyRaw({ activityId, account: 'MeatNTwoVeg', exitCode: 1, status: 'fail', detail, pos: VARROCK_WEST }, { now: NOW });
    }
    const atHub = classifier.applyToAccount(meat(VARROCK_WEST), NOW + 1_000);
    expect(enclosedAt(atHub.noRoutes, VARROCK_WEST, NOW + 1_000)).toBeDefined();
    expect(atHub.lifecycle).toBe('idle');
});

// A search that started 5 tiles from its target: the obstacle (the Shantay Pass gate) is at the target.
const SHANTAY_NORTH = { x: 3303, z: 3117, level: 0 };
const SHANTAY_GATE = { x: 3303, z: 3112, level: 0 };
const DESERT = 'RESULT fail quest-sweep desertrescue Error: start walk failed to {"x":3303,"z":3112,"level":0}: precondition no route to 3303,3112,0';

test('a no-route fact found at its target keeps its activity refused after the account walks away', () => {
    const classifier = new OutcomeClassifier({ root, persist: false });
    const res = classifier.classifyAndApplyRaw(
        { activityId: 'quest:desertrescue', account: 'MeatNTwoVeg', exitCode: 1, status: 'fail', reason: 'blocked after 1 runs', detail: DESERT, pos: SHANTAY_NORTH },
        { now: NOW },
    );
    expect(res.noRoute).toMatchObject({ from: SHANTAY_NORTH, to: SHANTAY_GATE, activityId: 'quest:desertrescue' });
    const quest = { id: 'quest:desertrescue', config: {} };
    const refused = (acct: AccountState) => activityPreflightFromConfig(acct, quest, world(acct)).blockers
        .some(b => b.kind === 'unreachable_tile' && b.reason === 'no_route');
    expect(refused(classifier.applyToAccount(meat(SHANTAY_NORTH), NOW + 1_000))).toBe(true);
    // The walk home to Varrock West does not open the gate.
    const home = classifier.applyToAccount(meat(VARROCK_WEST), NOW + 2_000);
    expect(home.noRoutes?.map(f => f.activityId)).toEqual(['quest:desertrescue']);
    expect(refused(home)).toBe(true);
    // Other targets near the gate stay open: the fact refuses its activity only.
    expect(noRouteTo(home.noRoutes, VARROCK_WEST, { x: 3280, z: 3157, level: 0 }, NOW + 2_000)).toBeUndefined();
    // A pass in the bank changes the state, and the fact ends.
    const paid: AccountState = { ...meat(VARROCK_WEST), bank: { ...meat().bank, items: { 1854: 1 } } };
    expect(classifier.applyToAccount(paid, NOW + 3_000).noRoutes).toBeUndefined();
    expect(refused(meat(VARROCK_WEST, [{ ...res.noRoute!, expiresAt: NOW }]))).toBe(false);
    // The sweep also fails 11 tiles north of the gate, and that fact holds after the walk away too.
    const far = { x: 3302, z: 3123, level: 0 };
    expect(refused(meat(VARROCK_WEST, [{ ...res.noRoute!, from: far }]))).toBe(true);
    // A start far from the target is a fact about the start: the walk away ends it.
    expect(refused(meat(VARROCK_WEST, [{ ...res.noRoute!, from: MEAT }]))).toBe(false);
});

// A 10 HP account at Catherby whose walker refused the walk over White Wolf Mountain (core/src/walk/harm.ts).
const CATHERBY = { x: 2809, z: 3436, level: 0 };
const TAVERLEY = { x: 2895, z: 3445, level: 0 };
const DANGER = 'RESULT fail Error: shop walk failed: precondition walk danger from 2809,3436,0: route danger to 2895,3445,0: Big Wolf 2840,3497 needs 42 heal of food (expected damage 30.2)';
const weak = (noRoutes?: readonly NoRouteFact[], bankItems: Record<number, number> = {}): AccountState => ({
    ...meat(CATHERBY, noRoutes),
    name: 'Tenhp',
    skills: { Attack: { level: 1, xp: 0 }, Strength: { level: 1, xp: 0 }, Defence: { level: 1, xp: 0 }, Hitpoints: { level: 10, xp: 1_154 } },
    bank: { items: bankItems, observedAt: NOW - 1000, trusted: true },
});

test('a walk danger refusal is a route-danger fact: the 10 HP account is not dispatched to the job until food is staged', () => {
    expect(parseNoRoute(DANGER)).toEqual({ from: CATHERBY, to: TAVERLEY, danger: 'Big Wolf 2840,3497', needHeal: 42 });
    // A walk that holds its food but did not eat above the floor line names no food short: no food need is recorded.
    expect(parseNoRoute('RESULT fail walk danger from 2809,3436,0: route danger to 2895,3445,0: Big Wolf 2840,3497 must eat above 14 Hitpoints before the walk (expected damage 3)')).toBeNull();
    const classifier = new OutcomeClassifier({ root, persist: false });
    const res = classifier.classifyAndApplyRaw(
        { activityId: 'market:shop-buy', account: 'Tenhp', exitCode: 1, status: 'fail', reason: 'blocked after 1 runs', detail: DANGER, pos: CATHERBY },
        { now: NOW },
    );
    expect(res.defect).toBeUndefined();
    expect(res.noRoute).toMatchObject({ from: CATHERBY, to: TAVERLEY, danger: 'Big Wolf 2840,3497', needHeal: 42 });
    expect(res.summary).toContain('route danger');
    const acct = classifier.applyToAccount(weak(), NOW + 1_000);
    expect(acct.noRoutes?.[0]?.danger).toBe('Big Wolf 2840,3497');
    // The job at Taverley is blocked on food, not refused as unreachable.
    const job = { id: 'market:shop-buy', config: { targetTile: TAVERLEY } };
    const pre = activityPreflightFromConfig(acct, job as any, world(acct));
    expect(pre.ok).toBe(false);
    expect(pre.blockers).toContainEqual(expect.objectContaining({ kind: 'combat_survivability', reason: 'food', required: 42 }));
    expect(pre.blockers.some(b => b.kind === 'unreachable_tile')).toBe(false);
    expect(noRouteTo(acct.noRoutes, CATHERBY, TAVERLEY, NOW + 1_000)).toBeUndefined();
    expect(enclosedAt([...acct.noRoutes!, { ...acct.noRoutes![0]!, to: VARROCK_WEST }], CATHERBY, NOW + 1_000)).toBeUndefined();
    // Food in the bank changes the account state, and the fact ends.
    expect(classifier.applyToAccount(weak(undefined, { 379: 10 }), NOW + 2_000).noRoutes).toBeUndefined();
    // A refusal that food cannot fix (needHeal 0) refuses the job as unreachable.
    const hopeless = weak([{ ...acct.noRoutes![0]!, needHeal: 0 }]);
    expect(activityPreflightFromConfig(hopeless, job as any, world(hopeless)).blockers).toContainEqual(expect.objectContaining({ kind: 'unreachable_tile', reason: 'no_route' }));
});

test('the planner stages food before the refused walk, and gives no job whose route food cannot make safe', () => {
    const OUT = 99_998;
    const taverley: ActivityDefinition = {
        id: 'gather:taverley-probe', workerId: 'gather', family: 'gather', kind: 'train', label: 'Work at Taverley', skill: 'Woodcutting',
        location: TAVERLEY, config: {},
        baselineRate: { xpPerTick: 10, unitsPerTick: 0.1, gpPerTick: 5, setupTicks: 10, minBatchUnits: 1, confidence: 'live' },
        outputs: [{ itemId: OUT, countPerUnit: 1 }], trust: 'live_proven',
    };
    const demand: GoalDemand = {
        id: 'demand:taverley', goalKind: 'pk_army', valueScore: 100, valuePerHour: 1000,
        target: { kind: 'item', itemId: OUT, itemName: 'probe output', count: 5 }, fulfilled: 0, remaining: 5, priorityWeight: 1, active: true,
    };
    const fact: NoRouteFact = { from: CATHERBY, to: TAVERLEY, activityId: taverley.id, observedAt: NOW - 60_000, expiresAt: NOW + NO_ROUTE_TTL_MS, danger: 'Big Wolf 2840,3497', needHeal: 42 };
    const rich = (noRoutes: readonly NoRouteFact[]): AccountState => ({ ...weak(noRoutes), inventory: { 995: 20_000 }, bank: { items: { 995: 200_000 }, observedAt: NOW - 1000, trusted: true } });
    const plan = (acct: AccountState) => planAccount(acct, { world: world(acct), activities: [taverley], demands: [demand] });
    const free = plan(rich([]));
    expect(free.steps.some(s => 'activityId' in s && s.activityId === taverley.id)).toBe(true);
    const staged = plan(rich([fact]));
    expect(staged.steps[0]?.stepKind).toBe('acquire');
    expect(staged.steps.some(s => 'activityId' in s && s.activityId === taverley.id)).toBe(true);
    const hopeless = plan(rich([{ ...fact, needHeal: 0 }]));
    expect(hopeless.steps.some(s => 'activityId' in s && s.activityId === taverley.id)).toBe(false);
});
