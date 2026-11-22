import { describe, expect, test } from 'bun:test';
import {
    isWorkerModule,
    validatePreflightResult,
    validateRateEstimate,
    validateRunOutcome,
    type WorkerAccountView,
    type WorkerWorldView,
} from '../src/contracts';
import {
    COMBAT_MODE_SET,
    COMBAT_SITES,
    ORDINARY_COMBAT_MODES,
    assessBossReadiness,
    combatEstimate,
    combatPreflight,
    combatWorkerModule,
    runCombatModuleSession,
    type CombatConfig,
    type CombatSession,
} from '../src/combat';
import { BOSS_ENCOUNTERS, resolveBossStep } from '../../../scripts/aio-boss';
import {
    FIGHTER_PROFILES,
    planAuthoredFighterBand,
    planAutoFighterBand,
    resolveFighterStep,
} from '../../../scripts/aio-fighter';

function makeAccount(overrides: Partial<WorkerAccountView> = {}): WorkerAccountView {
    return {
        name: 'CombatTester',
        side: 'local',
        protectedClock: false,
        skills: {
            Attack: { level: 80, xp: 2_000_000 },
            Strength: { level: 80, xp: 2_000_000 },
            Defence: { level: 75, xp: 1_300_000 },
            Hitpoints: { level: 95, xp: 9_000_000 },
            Ranged: { level: 75, xp: 1_300_000 },
            Magic: { level: 75, xp: 1_300_000 },
            Prayer: { level: 60, xp: 300_000 },
            Fishing: { level: 70, xp: 800_000 },
            Agility: { level: 50, xp: 105_000 },
        },
        quests: {
            'Waterfall Quest': 'complete',
            'Nature Spirit': 'complete',
            'Big Chompy Bird Hunting': 'complete',
            'Dwarf Cannon': 'complete',
            'Dragon Slayer': 'complete',
            'Fishing Contest': 'complete',
        },
        inventory: {},
        equipment: {},
        bank: {
            items: {
                385: 50, // Shark
                329: 50, // Salmon
                333: 50, // Trout
                379: 50, // Lobster
                995: 50_000, // Coins
                1540: 1, // Anti-dragon shield
                1289: 1, // Rune sword
                2448: 2, // Super antipoison(4)
                2452: 2, // Antifire potion(4)
                2434: 5, // Prayer potion(4)
                563: 20, // Law rune
                556: 30, // Air rune
                554: 20, // Fire rune
                1590: 1, // Dusty key
                837: 1, // Crossbow
                877: 500, // Bronze bolts
                6: 1, // Cannon base
                8: 1, // Cannon stand
                10: 1, // Cannon barrels
                12: 1, // Cannon furnace
                2: 500, // Cannonball
                1941: 200, // Swamp paste
                954: 20, // Rope
                583: 1, // Bailing bucket
                294: 1, // Glarial's pebble
                295: 1, // Glarial's amulet
                1171: 1, // Wooden shield
                3465: 1, // Mort'ton shade key
                2958: 50, // Druid pouch
                2883: 1, // Ogre bow
                2866: 100, // Ogre arrow
                2874: 1, // Ogre bellows (3)
            },
            observedAt: Date.now(),
            trusted: true,
        },
        pos: { x: 2655, z: 3283, level: 0 },
        ...overrides,
    };
}

const emptyWorld: WorkerWorldView = { at: Date.now(), side: 'local', server: 'localhost:8888', accounts: {} };

describe('combatWorkerModule contracts and preflight', () => {
    test('combatWorkerModule satisfies WorkerModule interface and covers every CombatMode', () => {
        expect(isWorkerModule(combatWorkerModule)).toBe(true);
        expect(combatWorkerModule.id).toBe('combat:aio');
        expect(combatWorkerModule.family).toBe('combat');
        expect(combatWorkerModule.trust).toBe('practice_passed');
        expect(COMBAT_MODE_SET.size).toBe(ORDINARY_COMBAT_MODES.length);
        for (const mode of ORDINARY_COMBAT_MODES) {
            expect(COMBAT_SITES[mode]).toBeDefined();
            expect(COMBAT_SITES[mode].mode).toBe(mode);
            expect(COMBAT_SITES[mode].activityId).toBe(`combat:${mode}`);
        }
    });

    test('preflight approves well-provisioned accounts across ordinary, ranged, cannon, minigame, and boss modes', () => {
        const acct = makeAccount();
        for (const mode of ORDINARY_COMBAT_MODES) {
            const res = combatPreflight(acct, { mode }, emptyWorld);
            expect(() => validatePreflightResult(res)).not.toThrow();
            expect(res.ok, `mode=${mode} blockers=${JSON.stringify(res.blockers)}`).toBe(true);
            expect(res.blockers).toEqual([]);
        }
    });

    test('preflight rejects invalid config fields cleanly', () => {
        const acct = makeAccount();
        const invalidMode = combatPreflight(acct, { mode: 'bogus' as CombatConfig['mode'] }, emptyWorld);
        expect(invalidMode.ok).toBe(false);
        expect(invalidMode.blockers[0]?.kind).toBe('invalid_config');
        expect(() => validatePreflightResult(invalidMode)).not.toThrow();

        const badCap = combatPreflight(acct, { mode: 'cow', capTicks: 0 }, emptyWorld);
        expect(badCap.ok).toBe(false);
        expect(badCap.blockers[0]?.kind).toBe('invalid_config');

        const badKills = combatPreflight(acct, { mode: 'cow', maxKills: -2 }, emptyWorld);
        expect(badKills.ok).toBe(false);
        expect(badKills.blockers[0]?.kind).toBe('invalid_config');

        const badTargetLevel = combatPreflight(acct, { mode: 'cow', targetLevel: 100 }, emptyWorld);
        expect(badTargetLevel.ok).toBe(false);
        expect(badTargetLevel.blockers[0]?.kind).toBe('invalid_config');
    });

    test('preflight enforces protectedClock, membersOnly, maxRiskPerHour, maxLevels, and spot occupancy', () => {
        const protectedAcct = makeAccount({ protectedClock: true });
        expect(combatPreflight(protectedAcct, { mode: 'chicken' }, emptyWorld).blockers.some(b => b.kind === 'protected_clock')).toBe(true);

        const acct = makeAccount();
        const nonMemberBoss = combatPreflight(acct, { mode: 'kbd', members: false }, emptyWorld);
        expect(nonMemberBoss.ok).toBe(false);
        expect(nonMemberBoss.blockers.some(b => b.kind === 'invalid_config' && b.message.includes('members'))).toBe(true);

        const risky = combatPreflight(acct, { mode: 'green-dragon', maxRiskPerHour: 0.05 }, emptyWorld);
        expect(risky.ok).toBe(false);
        expect(risky.blockers.some(b => b.kind === 'invalid_config' && b.message.includes('maxRiskPerHour'))).toBe(true);

        const pure = makeAccount({ maxLevels: { Defence: 1 } });
        const defCapped = combatPreflight(pure, { mode: 'cow', targetSkill: 'Defence', targetLevel: 20 }, emptyWorld);
        expect(defCapped.ok).toBe(false);
        expect(defCapped.blockers.some(b => b.kind === 'max_level_cap')).toBe(true);

        const crowdedWorld: WorkerWorldView = {
            at: Date.now(),
            side: 'local',
            server: 'localhost:8888',
            accounts: {},
            spotOccupancy: { 'combat:trooper': 4 },
        };
        const full = combatPreflight(acct, { mode: 'trooper' }, crowdedWorld);
        expect(full.ok).toBe(false);
        expect(full.blockers.some(b => b.kind === 'capacity_full' && b.limit === 4)).toBe(true);
    });

    test('preflight enforces quest gates, survivability floors, supplies, reserves, and travel coins', () => {
        const unquested = makeAccount({ quests: { 'Nature Spirit': 'started' } });
        // Shade allows Nature Spirit started, whereas Cannon requires Dwarf Cannon complete.
        expect(combatPreflight(unquested, { mode: 'shade' }, emptyWorld).ok).toBe(true);
        const cannonUnquested = combatPreflight(unquested, { mode: 'cannon' }, emptyWorld);
        expect(cannonUnquested.ok).toBe(false);
        expect(cannonUnquested.blockers.some(b => b.kind === 'quest_incomplete' && b.quest === 'Dwarf Cannon')).toBe(true);

        const lowHp = makeAccount({
            skills: {
                Hitpoints: { level: 10, xp: 1154 },
                Prayer: { level: 1, xp: 0 },
                Attack: { level: 1, xp: 0 },
                Magic: { level: 1, xp: 0 },
            },
        });
        const kbdFail = combatPreflight(lowHp, { mode: 'kbd' }, emptyWorld);
        expect(kbdFail.ok).toBe(false);
        expect(kbdFail.blockers.some(b => b.kind === 'combat_survivability' && b.reason === 'hitpoints')).toBe(true);
        expect(kbdFail.blockers.some(b => b.kind === 'combat_survivability' && b.reason === 'prayer')).toBe(true);
        expect(kbdFail.blockers.some(b => b.kind === 'skill_level' && b.skill === 'Attack')).toBe(true);

        const broke = makeAccount({ bank: { items: { 1540: 1, 385: 10, 995: 400 }, observedAt: Date.now(), trusted: true } });
        const wildFail = combatPreflight(broke, { mode: 'green-dragon' }, emptyWorld);
        expect(wildFail.ok).toBe(false);
        expect(wildFail.blockers.some(b => b.kind === 'missing_coins' && b.ferryFare === 500)).toBe(true);

        const reservedWorld: WorkerWorldView = {
            at: Date.now(),
            side: 'local',
            server: 'localhost:8888',
            accounts: {},
            globalReserves: { 385: 48, 373: 50, 379: 50, 329: 50, 333: 50 }, // Only 2 sharks left unreserved across all dragon foods; black-dragon requires 3
        };
        const foodShort = combatPreflight(makeAccount(), { mode: 'black-dragon' }, reservedWorld);
        expect(foodShort.ok).toBe(false);
        expect(foodShort.blockers.some(b => b.kind === 'combat_survivability' && b.reason === 'food')).toBe(true);
    });

    test('estimate produces valid RateEstimate across all combat modes and fallback unknown mode', () => {
        const acct = makeAccount();
        for (const mode of ORDINARY_COMBAT_MODES) {
            const est = combatEstimate(acct, { mode }, emptyWorld);
            expect(() => validateRateEstimate(est)).not.toThrow();
            expect(est.minBatchUnits).toBeGreaterThanOrEqual(1);
            expect(est.setupTicks).toBeGreaterThanOrEqual(10);
        }
        const unknownEst = combatEstimate(acct, { mode: 'unknown' as CombatConfig['mode'] }, emptyWorld);
        expect(() => validateRateEstimate(unknownEst)).not.toThrow();
        expect(unknownEst.xpPerTick).toBe(75);
    });

    test('runCombatModuleSession & combatWorkerModule.run validate outcomes for invalid mode, preflight rejection, cow completion, and failures', async () => {
        const invalidOut = await combatWorkerModule.run({ name: 'Mock' } as CombatSession, { mode: 'bogus' as CombatConfig['mode'] });
        expect(() => validateRunOutcome(invalidOut)).not.toThrow();
        expect(invalidOut.kind).toBe('worker_defect');

        let tick = 0;
        let hp = 10;
        let lifeId = 1;
        let open = false;
        let generation = 0;
        const listeners = new Set<() => void>();
        const timer = setInterval(() => {
            tick++;
            for (const f of [...listeners]) f();
        }, 1);
        const inv: Array<{ id: number; name: string; count: number; slot: number; optionsWithIndex?: Array<{ text: string; opIndex: number }> }> = [
            { id: 1277, name: 'Bronze sword', count: 1, slot: 0, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
            { id: 1171, name: 'Wooden shield', count: 1, slot: 1, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
            { id: 333, name: 'Trout', count: 2, slot: 2 },
        ];
        const equipment: typeof inv = [];
        const bank: typeof inv = [{ id: 333, name: 'Trout', count: 5, slot: 0 }];
        const xp: Record<string, number> = { Attack: 0, Strength: 0, Defence: 0 };
        let ground: Array<{ id: number; name: string; count: number; x: number; z: number }> = [];
        let npc: { id: number; index: number; name: string; tileX: number; tileZ: number; x: number; z: number; hp: number; maxHp: number; inCombat: boolean } | null = {
            id: 81, index: 7, name: 'Cow', tileX: 2664, tileZ: 3344, x: 2664, z: 3344, hp: 8, maxHp: 8, inCombat: false,
        };
        const session: CombatSession = {
            name: 'MockCow',
            tick: () => tick,
            onTick: (cb: () => void) => {
                listeners.add(cb);
                return () => listeners.delete(cb);
            },
            ended: new Promise(() => {}),
            bankObservation: () => (open ? { generation, at: Date.now(), items: bank } : null),
            sdk: {
                getState: () => ({
                    player: { worldX: 2654, worldZ: 3283, level: 0, lifeId, respawnCount: 0, hp },
                    inventory: inv,
                    equipment,
                    nearbyPlayers: [],
                    nearbyNpcs: npc ? [npc] : [],
                    groundItems: ground,
                    bank: { isOpen: open, items: bank },
                    combatStyle: {
                        known: true,
                        currentStyle: 0,
                        weaponName: 'Bronze sword',
                        styles: [
                            { index: 0, trainsSkills: ['Attack'] },
                            { index: 1, trainsSkills: ['Strength'] },
                            { index: 3, trainsSkills: ['Defence'] },
                        ],
                    },
                }),
                getInventory: () => inv,
                getEquipment: () => equipment,
                getSkill: (n: string) => ({ level: n === 'Hitpoints' ? hp : 1, baseLevel: n === 'Hitpoints' ? 10 : 1 }),
                getSkillXp: (n: string) => xp[n] ?? 0,
                sendSetCombatStyle: async () => ({ success: true }),
            },
            bot: {
                openBank: async () => { open = true; generation++; return { success: true }; },
                closeBank: async () => { open = false; return { success: true }; },
                equipItem: async (item: typeof inv[number]) => {
                    equipment.push(item);
                    const idx = inv.indexOf(item);
                    if (idx >= 0) inv.splice(idx, 1);
                    return { success: true };
                },
                attack: async () => {
                    xp.Attack += 800;
                    ground = [
                        { id: 1739, name: 'Cowhide', count: 1, x: 2664, z: 3344 },
                        { id: 526, name: 'Bones', count: 1, x: 2664, z: 3344 },
                        { id: 2132, name: 'Raw beef', count: 1, x: 2664, z: 3344 },
                    ];
                    npc = null;
                    return { success: true };
                },
                pickupItem: async (item: typeof ground[number]) => {
                    ground = ground.filter(g => g !== item);
                    const held = inv.find(i => i.id === item.id);
                    if (held) held.count++;
                    else inv.push({ ...item, count: 1, slot: inv.length });
                    if (!ground.length) npc = { id: 81, index: 7, name: 'Cow', tileX: 2664, tileZ: 3344, x: 2664, z: 3344, hp: 8, maxHp: 8, inCombat: false };
                    return { success: true };
                },
                depositItem: async (item: typeof inv[number], amount = -1) => {
                    const held = inv.find(i => i.id === item.id);
                    if (!held) return { success: false };
                    const take = amount < 0 ? held.count : Math.min(held.count, amount);
                    const row = bank.find(b => b.id === item.id);
                    if (row) row.count += take;
                    else bank.push({ id: held.id, name: held.name, count: take, slot: bank.length });
                    held.count -= take;
                    if (held.count <= 0) inv.splice(inv.indexOf(held), 1);
                    generation++;
                    return { success: true };
                },
            },
        } as unknown as CombatSession;

        try {
            const cowOutcome = await runCombatModuleSession(
                session,
                { mode: 'cow', targetSkill: 'Attack', targetLevel: 40, maxKills: 1, capTicks: 300 },
                { walk: async () => true },
            );
            expect(() => validateRunOutcome(cowOutcome)).not.toThrow();
            expect(cowOutcome.kind, JSON.stringify(cowOutcome)).toBe('target_met');
            expect(cowOutcome.unitsCompleted).toBe(1);

            const preflightRejected = await runCombatModuleSession(session, { mode: 'shade' });
            expect(() => validateRunOutcome(preflightRejected)).not.toThrow();
            expect(preflightRejected.kind).toBe('worker_defect');
        } finally {
            clearInterval(timer);
        }
    });

    test('router steps, fighter profiles, boss encounters, and readiness assessment match unified dispatch', () => {
        expect(FIGHTER_PROFILES.some(p => p.target === 'chicken' && p.script === 'scripts/aio-fighter.ts')).toBe(true);
        expect(FIGHTER_PROFILES.some(p => p.target === 'cannon' && p.script === 'scripts/aio-fighter.ts')).toBe(true);
        expect(BOSS_ENCOUNTERS.map(b => b.boss)).toEqual(['kbd', 'black-dragon', 'green-dragon', 'trawler', 'trawler-at-site']);

        expect(resolveFighterStep('cow', ['3000'])).toEqual({
            script: 'scripts/aio-fighter.ts',
            args: ['cow', '3000'],
            env: { TARGET: 'cow', CAP: '3000', TRAIN_SKILL: 'Defence', TARGET_LEVEL: '40' },
        });
        expect(resolveFighterStep('cannon', ['SPOT=battlefield'])).toEqual({
            script: 'scripts/aio-fighter.ts',
            args: ['cannon'],
            env: { SPOT: 'battlefield' },
        });
        expect(() => resolveFighterStep('unknown-target')).toThrow('aio-fighter: unknown target');

        expect(resolveBossStep('kbd', ['500'])).toEqual({
            script: 'scripts/aio-boss.ts',
            args: ['kbd'],
            env: { CAP: '500' },
        });
        expect(() => resolveBossStep('kbd', ['2000'])).toThrow('1..1000');
        expect(() => resolveBossStep('unknown-boss')).toThrow('aio-boss: unknown encounter');

        const earlyBand = planAuthoredFighterBand({ Attack: 10, Strength: 10, Defence: 10, Hitpoints: 15 });
        expect(earlyBand.target).toBe('cow');
        const lateBand = planAuthoredFighterBand({ Attack: 60, Strength: 60, Defence: 60, Hitpoints: 60 });
        expect(lateBand.target).toBe('trooper');
        expect(planAutoFighterBand({ Attack: 10, Strength: 10, Defence: 10, Hitpoints: 15 }).progression).toBeNull();

        const unreadyTrawler = assessBossReadiness('trawler', { skills: { Fishing: 10 }, ownedItems: {} });
        expect(unreadyTrawler.ready).toBe(false);
        expect(unreadyTrawler.missingSkills.length).toBeGreaterThan(0);

        const readyBlackDragon = assessBossReadiness('black-dragon', {
            skills: { Attack: 50, Strength: 50, Defence: 50, Hitpoints: 60, Ranged: 60, Prayer: 43, Magic: 30 },
            ownedItems: {
                861: 1, 888: 700, 1590: 1, 563: 1, 556: 3, 554: 1, 385: 8, 2434: 1,
            },
            members: true,
        });
        expect(readyBlackDragon.ready).toBe(true);
    });
});
