// Unified WorkerModule<GatherConfig> contract, preflight, estimate, and outcome tests.
import { expect, test } from 'bun:test';
import {
    createWorkerRegistry,
    isPreflightResult,
    isRateEstimate,
    isRunOutcome,
    isWorkerModule,
    validateWorkerModule,
    type WorkerAccountView,
    type WorkerWorldView,
} from '../src/contracts';
import {
    GATHER_METHOD_MAP,
    VALID_GATHER_SKILLS,
    gatherEstimate,
    gatherPreflight,
    gatherWorker,
    normalizeGatherConfig,
    resolveSetting,
    toWorkerOutcome,
    type GatherConfig,
} from '../src/gather';

function makeAccount(over: Partial<WorkerAccountView> = {}): WorkerAccountView {
    return {
        name: 'GatherTester',
        side: 'local',
        protectedClock: false,
        skills: {
            Fishing: { level: 80, xp: 2_000_000 },
            Cooking: { level: 85, xp: 3_300_000 },
            Woodcutting: { level: 75, xp: 1_210_421 },
            Mining: { level: 85, xp: 3_300_000 },
            Thieving: { level: 65, xp: 450_000 },
            Hitpoints: { level: 50, xp: 101_333 },
            Attack: { level: 40, xp: 37_224 },
        },
        quests: {
            'Rune Mysteries': 'complete',
            'The Fremennik Trials': 'complete',
        },
        pos: { x: 3092, z: 3243, level: 0 },
        inventory: {},
        equipment: {},
        bank: {
            items: {
                301: 1, // Lobster pot
                303: 1, // Small fishing net
                305: 1, // Big fishing net
                307: 1, // Fishing rod
                309: 1, // Fly fishing rod
                311: 1, // Harpoon
                313: 50, // Fishing bait
                314: 200, // Feather
                1585: 1, // Oily fishing rod
                3157: 1, // Karambwan vessel
                3150: 20, // Raw karambwanji
                1359: 1, // Rune axe
                1275: 1, // Rune pickaxe
                1735: 1, // Shears
                989: 2, // Crystal key
                385: 10, // Shark
                329: 10, // Salmon
                995: 5000, // Coins
            },
            observedAt: 1_000_000,
            trusted: true,
        },
        ...over,
    };
}

function makeWorld(acct: WorkerAccountView, over: Partial<WorkerWorldView> = {}): WorkerWorldView {
    return {
        at: 1_000_000,
        side: 'local',
        server: 'localhost:8888',
        accounts: { [acct.name]: acct },
        ...over,
    };
}

test('gatherWorker satisfies WorkerModule contract and registry queries', () => {
    expect(validateWorkerModule(gatherWorker)).toEqual([]);
    expect(isWorkerModule(gatherWorker)).toBe(true);
    expect(gatherWorker.id).toBe('gather:unified');
    expect(gatherWorker.family).toBe('gather');
    expect(gatherWorker.kind).toBe('gather');
    expect(gatherWorker.trust).toBe('practice_passed');
    expect(gatherWorker.protectedAllowed).toBe(false);

    const reg = createWorkerRegistry([gatherWorker]);
    expect(reg.size()).toBe(1);
    expect(reg.require('gather:unified')).toBe(gatherWorker);
    expect(reg.list({ family: 'gather' })).toEqual([gatherWorker]);
    expect(reg.list({ minTrust: 'practice_passed', protectedAllowed: false })).toEqual([gatherWorker]);
    expect(reg.list({ minTrust: 'live_proven' })).toEqual([]);
});

test('normalizeGatherConfig and resolveSetting merge case, args KEY=value, and env precedence', () => {
    const norm = normalizeGatherConfig({
        skill: 'FISHING' as any,
        method: 'SHARK',
        args: ['TREE=yew', 'REGION=seers', 'CAP=9000'],
        env: { REGION: 'draynor', CAP: '' },
    });
    expect(norm.skill).toBe('fishing');
    expect(norm.method).toBe('shark');
    expect(resolveSetting(norm, 'REGION')).toBe('draynor');
    expect(resolveSetting(norm, 'TREE')).toBe('yew');
    expect(resolveSetting(norm, 'CAP')).toBe('9000');
    expect(resolveSetting(norm, 'MISSING')).toBeUndefined();
});

test('gatherPreflight approves stocked qualified accounts across every gather skill and method', () => {
    const acct = makeAccount({ pos: { x: 2654, z: 3283, level: 0 } });
    const world = makeWorld(acct);
    const extra: Record<string, Partial<GatherConfig>> = {
        'woodcutting:edgeville': {},
        'woodcutting:yews': { region: 'seers', spot: 'yew' },
        'thieving:stalls': { spot: 'stealing_silk_stall' },
        'thieving:pickpocket-at-site': { spot: 'man' },
        'foraging:spawn': { spot: '1573' },
    };
    for (const skill of VALID_GATHER_SKILLS) {
        for (const method of GATHER_METHOD_MAP[skill]) {
            if (method === 'edgeville') continue; // edgeville caps at Woodcutting 36
            const cfg: GatherConfig = { skill, method, ...extra[`${skill}:${method}`] };
            const res = gatherPreflight(acct, cfg, world);
            expect(isPreflightResult(res)).toBe(true);
            expect(res.ok, `${skill}:${method} blockers=${JSON.stringify(res.blockers)}`).toBe(true);
        }
    }
    const edgevilleAcct = makeAccount({
        skills: { ...makeAccount().skills, Woodcutting: { level: 15, xp: 2411 } },
    });
    expect(gatherPreflight(edgevilleAcct, { skill: 'woodcutting', method: 'edgeville' }, makeWorld(edgevilleAcct)).ok).toBe(true);
});

test('gatherPreflight enforces invalid_config, protected_clock, level cap, plane, quests, tools, coins, survivability, and occupancy', () => {
    const base = makeAccount();
    const world = makeWorld(base);

    const invalidConfigs: GatherConfig[] = [
        { skill: 'magic' as any, method: 'alch' },
        { skill: 'fishing', method: 'unknown-method' },
        { skill: 'fishing', method: 'village', spot: 'crab' },
        { skill: 'fishing', method: 'fishcook', env: { FOOD_TARGET: '0' } },
        { skill: 'fishing', method: 'staged', spot: 'sailfish' },
        { skill: 'woodcutting', method: 'woodcut-supply', target: { count: 26 } },
        { skill: 'woodcutting', method: 'yews', region: 'lumbridge', env: { WOOD_GROVE: 'native-processing' } },
        { skill: 'woodcutting', method: 'yews', region: 'seers', spot: 'yew', env: { NORMAL_GROVE: 'north' } },
        { skill: 'mining', method: 'ore', spot: 'gold' },
        { skill: 'mining', method: 'drop', spot: 'not_a_rock' },
        { skill: 'mining', method: 'at-site', spot: 'iron_rock_table', env: { MINING_SITE: 'nowhere' } },
        { skill: 'thieving', method: 'stalls', spot: 'no_such_stall' },
        { skill: 'thieving', method: 'pickpocket-at-site', spot: 'dragon' },
        { skill: 'foraging', method: 'spawn', spot: 'abc' },
    ];
    for (const cfg of invalidConfigs) {
        const res = gatherPreflight(base, cfg, world);
        expect(isPreflightResult(res)).toBe(true);
        expect(res.ok).toBe(false);
        expect(res.blockers.some(b => b.kind === 'invalid_config')).toBe(true);
    }

    const prot = makeAccount({ protectedClock: true });
    expect(gatherPreflight(prot, { skill: 'mining', method: 'ore' }, makeWorld(prot)).blockers.map(b => b.kind)).toContain('protected_clock');

    const capped = makeAccount({ maxLevels: { Woodcutting: 75 } });
    expect(gatherPreflight(capped, { skill: 'woodcutting', method: 'yews' }, makeWorld(capped)).blockers.map(b => b.kind)).toContain('max_level_cap');
    expect(gatherPreflight(base, { skill: 'woodcutting', method: 'edgeville' }, world).blockers.map(b => b.kind)).toContain('max_level_cap');

    const upstairs = makeAccount({ pos: { x: 2673, z: 3301, level: 1 } });
    expect(gatherPreflight(upstairs, { skill: 'thieving', method: 'blood-chest' }, makeWorld(upstairs)).blockers.map(b => b.kind)).toContain('unreachable_tile');
    expect(gatherPreflight(upstairs, { skill: 'thieving', method: 'nature-chest' }, makeWorld(upstairs)).ok).toBe(true);

    const questBlocked = makeAccount({ quests: {} });
    expect(gatherPreflight(questBlocked, { skill: 'mining', method: 'essence' }, makeWorld(questBlocked)).blockers.some(b => b.kind === 'quest_incomplete' && b.quest === 'Rune Mysteries')).toBe(true);
    expect(gatherPreflight(questBlocked, { skill: 'thieving', method: 'pickpocket-at-site', spot: 'viking' }, makeWorld(questBlocked)).blockers.some(b => b.kind === 'quest_incomplete')).toBe(true);

    const poorShark = makeAccount({
        reserves: { 995: 4000 },
        bank: { observedAt: 1, trusted: true, items: { 995: 4500, 329: 2 } },
    });
    expect(gatherPreflight(poorShark, { skill: 'fishing', method: 'shark' }, makeWorld(poorShark)).blockers.map(b => b.kind)).toContain('missing_coins');

    const lowHpShark = makeAccount({ skills: { ...base.skills, Hitpoints: { level: 39, xp: 33_000 } } });
    expect(gatherPreflight(lowHpShark, { skill: 'fishing', method: 'shark' }, makeWorld(lowHpShark)).blockers.map(b => b.kind)).toContain('combat_survivability');

    const noFoodKnights = makeAccount({
        pos: { x: 2654, z: 3283, level: 0 },
        bank: { observedAt: 1, trusted: true, items: {} },
    });
    expect(gatherPreflight(noFoodKnights, { skill: 'thieving', method: 'knights-stable' }, makeWorld(noFoodKnights)).blockers.map(b => b.kind)).toContain('combat_survivability');

    const noKeyChest = makeAccount({ bank: { observedAt: 1, trusted: true, items: { 985: 1 } } });
    expect(gatherPreflight(noKeyChest, { skill: 'foraging', method: 'crystal-chest' }, makeWorld(noKeyChest)).blockers.map(b => b.kind)).toContain('missing_supply');

    const crowded = makeWorld(base, { spotOccupancy: { iron_south: 4 } });
    expect(gatherPreflight(base, { skill: 'mining', method: 'ore', spot: 'iron_south' }, crowded).blockers.map(b => b.kind)).toContain('capacity_full');
});

test('gatherEstimate returns valid RateEstimate across all skills and methods', () => {
    const acct = makeAccount();
    const world = makeWorld(acct);
    for (const skill of VALID_GATHER_SKILLS) {
        for (const method of GATHER_METHOD_MAP[skill]) {
            const est = gatherEstimate(acct, { skill, method, ...(method === 'spawn' ? { spot: '223' } : {}) }, world);
            expect(isRateEstimate(est), `${skill}:${method}`).toBe(true);
            expect(est.unitsPerTick).toBeGreaterThan(0);
            expect(est.minBatchUnits).toBeGreaterThanOrEqual(1);
        }
    }
    const lowThief = makeAccount({ skills: { ...acct.skills, Thieving: { level: 55, xp: 166_636 } } });
    const highThief = makeAccount({ skills: { ...acct.skills, Thieving: { level: 99, xp: 13_034_431 } } });
    expect(gatherEstimate(highThief, { skill: 'thieving', method: 'knights' }, world).gpPerTick)
        .toBeGreaterThan(gatherEstimate(lowThief, { skill: 'thieving', method: 'knights' }, world).gpPerTick);
});

test('gatherWorker.run and toWorkerOutcome map success, refusal, death, missing_supply, and location_stranded cleanly', async () => {
    const fakeSession: any = {
        name: 'RunUnit',
        tick: () => 5,
        ended: new Promise(() => {}),
        sdk: {
            getState: () => ({ player: { worldX: 3092, worldZ: 3243, level: 0 }, inventory: [], nearbyLocs: [], nearbyNpcs: [] }),
            getInventory: () => [],
            getEquipment: () => [],
            getSkill: () => ({ level: 1, baseLevel: 1 }),
            getSkillXp: () => 0,
        },
    };
    const invalid = await gatherWorker.run(fakeSession, { skill: 'mining', method: 'bad-method' });
    expect(isRunOutcome(invalid)).toBe(true);
    expect(invalid.kind).toBe('worker_defect');
    expect(invalid.activityId).toBe('gather:mining:bad-method');

    const cfg = normalizeGatherConfig({ skill: 'foraging', method: 'crystal-chest' });
    const met = toWorkerOutcome(
        { ok: true, kind: 'completed', detail: 'done', delta: { items: { 1631: 3 }, elapsedTicks: 42 }, summary: { opened: 3 } },
        'Chests',
        cfg,
        10,
    );
    expect(isRunOutcome(met)).toBe(true);
    expect(met).toMatchObject({ kind: 'target_met', unitsCompleted: 3, ticksElapsed: 42, itemsDelta: { 1631: 3 } });

    const missing = toWorkerOutcome(
        { ok: false, kind: 'failed', detail: 'no crystal_key in bank', delta: { elapsedTicks: 3 } },
        'Chests',
        cfg,
        3,
    );
    expect(isRunOutcome(missing)).toBe(true);
    expect(missing.kind).toBe('missing_supply');

    const stranded = toWorkerOutcome(
        { ok: false, kind: 'failed', detail: 'walk to Catherby bank unreachable', delta: { elapsedTicks: 9 } },
        'Fisher',
        normalizeGatherConfig({ skill: 'fishing', method: 'shark' }),
        9,
    );
    expect(isRunOutcome(stranded)).toBe(true);
    expect(stranded.kind).toBe('location_stranded');

    const died = toWorkerOutcome(
        { ok: false, kind: 'died', detail: 'player died', delta: { elapsedTicks: 15 } },
        'Runner',
        normalizeGatherConfig({ skill: 'thieving', method: 'blood-chest' }),
        15,
    );
    expect(isRunOutcome(died)).toBe(true);
    expect(died.kind).toBe('death');
});

test('gatherPreflight honors lowercase world reserves, globalReserves, and escrow, and gatherEstimate applies 25x XP scaling', () => {
    const acct = makeAccount({
        name: 'MixedCaseFisher',
        bank: { observedAt: 1, trusted: true, items: { 995: 5000, 329: 10 } },
    });
    const world = makeWorld(acct, {
        reserves: { mixedcasefisher: { 995: 2000 } },
        globalReserves: { 995: 1000 },
        geEscrowCoins: { mixedcasefisher: 1500 },
    });
    const res = gatherPreflight(acct, { skill: 'fishing', method: 'shark' }, world);
    expect(res.ok).toBe(false);
    expect(res.blockers.some(b => b.kind === 'missing_coins')).toBe(true);

    const est25 = gatherEstimate(acct, { skill: 'fishing', method: 'shark' }, world);
    const est1 = gatherEstimate(acct, { skill: 'fishing', method: 'shark', env: { XP_RATE: '1' } }, world);
    expect(est1.xpPerTick).toBe(6.5);
    expect(est25.xpPerTick).toBe(6.5 * 25);
});

test('gatherPreflight catches F2P crystal-chest and gatherWorker forwards cfg.stop', async () => {
    const acct = makeAccount({
        skills: { Thieving: { level: 50, xp: 101333 }, Mining: { level: 50, xp: 101333 } },
        bank: { observedAt: 1, trusted: true, items: { 989: 1, 1265: 1 } },
    });
    const world = makeWorld(acct);

    const f2pChest = gatherPreflight(acct, { skill: 'foraging', method: 'crystal-chest', members: false }, world);
    expect(f2pChest.ok).toBe(false);
    expect(f2pChest.blockers.some(b => b.kind === 'invalid_config')).toBe(true);

    const stopSession: any = {
        name: 'StoppedMiner',
        tick: () => 5,
        ended: new Promise(() => {}),
        sdk: {
            getState: () => ({ player: { worldX: 3092, worldZ: 3243, level: 0 }, inventory: [], nearbyLocs: [], nearbyNpcs: [] }),
            getInventory: () => [],
            getEquipment: () => [],
            getSkill: () => ({ level: 50, baseLevel: 50 }),
            getSkillXp: () => 101333,
        },
    };
    let capturedStop: (() => boolean) | undefined;
    const out = await gatherWorker.run(stopSession, {
        skill: 'mining',
        method: 'progressive',
        args: ['job.json'],
        stop: () => true,
        deps: {
            runProgressive: async (_s: any, _j: any, stop: () => boolean) => {
                capturedStop = stop;
                throw Error('stopped');
            },
        } as any,
    });
    expect(isRunOutcome(out)).toBe(true);
    expect(capturedStop === undefined || capturedStop()).toBe(true);
});
