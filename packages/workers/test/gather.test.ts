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
    grapeEntryProblem,
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
                1949: 1, // Chef's hat
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
        { skill: 'mining', method: 'ore', spot: 'blurite' },
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

    // The stable farm walks to the market bank itself, so a start in Varrock or upstairs is no unreachable tile.
    for (const pos of [{ x: 3185, z: 3436, level: 0 }, { x: 2654, z: 3283, level: 1 }]) {
        const away = makeAccount({ pos, bank: { observedAt: 1, trusted: true, items: { 379: 10 } } });
        expect(gatherPreflight(away, { skill: 'thieving', method: 'knights-stable' }, makeWorld(away)).blockers.map(b => b.kind)).not.toContain('unreachable_tile');
    }

    const noKeyChest = makeAccount({ bank: { observedAt: 1, trusted: true, items: { 985: 1 } } });
    expect(gatherPreflight(noKeyChest, { skill: 'foraging', method: 'crystal-chest' }, makeWorld(noKeyChest)).blockers.map(b => b.kind)).toContain('missing_supply');

    const grapes = { skill: 'foraging', method: 'grapes' } as const;
    const noHat = makeAccount({ bank: { observedAt: 1, trusted: true, items: {} } });
    expect(gatherPreflight(noHat, grapes, makeWorld(noHat)).blockers).toContainEqual(expect.objectContaining({ kind: 'missing_supply', itemId: 1949 }));
    const lowCook = makeAccount({ skills: { ...base.skills, Cooking: { level: 30, xp: 13_363 } }, equipment: { 1949: 1 } });
    expect(gatherPreflight(lowCook, grapes, makeWorld(lowCook)).blockers).toContainEqual(expect.objectContaining({ kind: 'skill_level', skill: 'Cooking', required: 32, current: 30 }));
    const wornHat = makeAccount({ bank: { observedAt: 1, trusted: true, items: {} }, equipment: { 1949: 1 } });
    expect(gatherPreflight(wornHat, grapes, makeWorld(wornHat)).ok).toBe(true);

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

    const noHat = toWorkerOutcome(
        { ok: false, kind: 'failed', detail: "Error: missing item 1949 Chef's hat for the guild door at=3185,3436,0 ticks=40 lost=0", delta: { elapsedTicks: 40 } },
        'Grapes',
        normalizeGatherConfig({ skill: 'foraging', method: 'grapes' }),
        40,
    );
    expect(noHat).toMatchObject({ kind: 'missing_supply', missing: [{ itemId: 1949, required: 1, available: 0 }] });

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

    const oreFail = toWorkerOutcome(
        { ok: false, kind: 'failed', detail: 'ticks=120 died=false mined=0 stop=no-progress oreWaitTicks=40', delta: { elapsedTicks: 120 } },
        'Miner',
        normalizeGatherConfig({ skill: 'mining', method: 'ore' }),
        120,
    );
    expect(oreFail.kind).not.toBe('death');
    expect(oreFail.kind).not.toBe('session_unsettled');
    const essenceFail = toWorkerOutcome(
        { ok: false, kind: 'failed', detail: 'essence {"ok":false,"died":false,"mined":0}', delta: { elapsedTicks: 50 } },
        'Miner',
        normalizeGatherConfig({ skill: 'mining', method: 'essence' }),
        50,
    );
    expect(essenceFail.kind).not.toBe('death');
    const oreDied = toWorkerOutcome(
        { ok: false, kind: 'failed', detail: 'died=true no ore progress: hp lost', delta: { elapsedTicks: 30 } },
        'Miner',
        normalizeGatherConfig({ skill: 'mining', method: 'ore' }),
        30,
    );
    expect(oreDied.kind).toBe('death');
    const ended = toWorkerOutcome(
        { ok: false, kind: 'failed', detail: 'session ended: disconnected', delta: { elapsedTicks: 30 } },
        'Thief',
        normalizeGatherConfig({ skill: 'thieving', method: 'pickpocket' }),
        30,
    );
    expect(ended.kind).toBe('session_unsettled');
});

test('gatherEstimate prices an at-site mining job by its PROFILE setting', () => {
    const acct = makeAccount();
    const world = makeWorld(acct);
    const iron = gatherEstimate(acct, { skill: 'mining', method: 'at-site' }, world);
    const runite = gatherEstimate(acct, { skill: 'mining', method: 'at-site', env: { PROFILE: 'runite_rock_table' } }, world);
    expect(runite.unitsPerTick).toBe(0.06);
    expect(iron.unitsPerTick).toBe(0.25);
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
    const endedOut = await gatherWorker.run({ ...stopSession, ended: Promise.resolve() }, {
        skill: 'mining',
        method: 'progressive',
        args: ['job.json'],
    });
    expect(isRunOutcome(endedOut)).toBe(true);
    expect(endedOut.kind).toBe('session_unsettled');

    let midRunCalls = 0;
    const notStoppedOut = await gatherWorker.run(stopSession, {
        skill: 'mining',
        method: 'bad-method',
        stop: () => false,
    });
    expect(isRunOutcome(notStoppedOut)).toBe(true);
    expect(notStoppedOut.kind).toBe('worker_defect');

    const stoppedMidRun = await gatherWorker.run(stopSession, {
        skill: 'foraging',
        method: 'spawn',
        args: ['1573'],
        stop: () => midRunCalls++ > 0,
    });
    expect(isRunOutcome(stoppedMidRun)).toBe(true);
    expect(stoppedMidRun.kind).toBe('session_unsettled');
    expect(midRunCalls).toBeGreaterThan(1);

    const mappedStop = toWorkerOutcome(
        { ok: false, kind: 'failed', detail: 'session interrupted during walk', delta: { elapsedTicks: 4 } },
        'Runner',
        normalizeGatherConfig({ skill: 'fishing', method: 'shark' }),
        4,
        { stopped: true },
    );
    expect(isRunOutcome(mappedStop)).toBe(true);
    expect(mappedStop.kind).toBe('session_unsettled');
}, 20_000);

test('woodcutting:loop and woodcut-supply honor caller stop signals without chopping', async () => {
    const { runWcLoop, runWoodSupply } = await import('../src/gather/woodcutting');
    let chopCalls = 0;
    const wcSession: any = {
        name: 'StoppedWc',
        tick: () => 5,
        onTick: () => () => {},
        ended: new Promise(() => {}),
        sdk: {
            getState: () => ({ player: { worldX: 3200, worldZ: 3240, level: 0 }, inventory: [], nearbyLocs: [], nearbyNpcs: [] }),
            getInventory: () => [],
            getEquipment: () => [],
            getSkill: (name: string) => ({ level: name === 'Hitpoints' ? 10 : 1, baseLevel: name === 'Hitpoints' ? 10 : 1 }),
            getSkillXp: () => 0,
        },
        bot: {
            chopTree: async () => {
                chopCalls++;
                return { success: false };
            },
        },
    };

    const wcDirect = await runWcLoop(wcSession, () => true, 100);
    expect(wcDirect.ok).toBe(false);
    expect(wcDirect.kind).toBe('aborted');
    expect(chopCalls).toBe(0);

    const wcWorkerOut = await gatherWorker.run(wcSession, { skill: 'woodcutting', method: 'loop', stop: () => true });
    expect(isRunOutcome(wcWorkerOut)).toBe(true);
    expect(wcWorkerOut.kind).toBe('session_unsettled');

    const supplyOut = await runWoodSupply(wcSession, 1, 0, 100, undefined, () => true);
    expect(supplyOut.ok).toBe(false);
    expect(chopCalls).toBe(0);
});

test("grapeEntryProblem names the Cooks' Guild door requirement that blocks entry", () => {
    expect(grapeEntryProblem(30, { worn: true, held: false, banked: false })).toBe('guild requires Cooking 32, has 30');
    expect(grapeEntryProblem(64, { worn: false, held: false, banked: false })).toBe("missing item 1949 Chef's hat for the guild door");
    expect(grapeEntryProblem(32, { worn: false, held: false, banked: true })).toBeNull();
    expect(grapeEntryProblem(32, { worn: true, held: false, banked: false })).toBeNull();
});
