import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
    PVP_MODES,
    assessGodSpellReadiness,
    assessTribridReadiness,
    dispatchPvpCli,
    pvpCombatBracket,
    pvpModule,
    pvpRuntime,
    resolveMageArenaWorkflow,
    resolvePvpStep,
    wildernessAgilityEscapeGuard,
    type PvpConfig,
} from '../src/pvp';
import {
    createWorkerRegistry,
    isWorkerModule,
    validatePreflightResult,
    validateRateEstimate,
    validateRunOutcome,
    type SessionCore,
    type WorkerAccountView,
    type WorkerWorldView,
} from '../src/contracts';
import {
    PVP_MODES as SHIM_MODES,
    resolvePvpStep as shimResolve,
} from '../../../scripts/aio-pvp';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

function makeAccount(overrides: Partial<WorkerAccountView> = {}): WorkerAccountView {
    return {
        name: 'PvpBot',
        side: 'local',
        protectedClock: false,
        skills: {
            Hitpoints: { level: 99, xp: 13_034_431 },
            Attack: { level: 99, xp: 13_034_431 },
            Strength: { level: 99, xp: 13_034_431 },
            Defence: { level: 99, xp: 13_034_431 },
            Ranged: { level: 99, xp: 13_034_431 },
            Prayer: { level: 99, xp: 13_034_431 },
            Magic: { level: 99, xp: 13_034_431 },
        },
        quests: {},
        pos: { x: 3094, z: 3492, level: 0 },
        inventory: { 385: 20, 1712: 1 },
        equipment: {},
        bank: {
            items: { 385: 50, 1712: 2, 995: 100_000 },
            observedAt: 1_700_000_000_000,
            trusted: true,
        },
        ...overrides,
    };
}

function makeWorld(
    acct: WorkerAccountView,
    reserves: WorkerWorldView['reserves'] = {},
    geEscrowCoins: WorkerWorldView['geEscrowCoins'] = {},
): WorkerWorldView {
    return {
        at: 1_700_000_005_000,
        side: 'local',
        server: 'local',
        accounts: { [acct.name.toLowerCase()]: acct },
        reserves,
        globalReserves: {},
        geEscrowCoins,
    };
}

function makeSession(overrides: {
    name?: string;
    tick?: number;
    hp?: number;
    inventory?: Array<{ id: number; count: number; name?: string }>;
    equipment?: Array<{ id: number; count: number; name?: string }>;
} = {}): SessionCore {
    let t = overrides.tick ?? 100;
    const inv = overrides.inventory ?? [{ id: 385, count: 20, name: 'Shark' }, { id: 1712, count: 1, name: 'Amulet of glory(4)' }];
    const equip = overrides.equipment ?? [];
    return {
        name: overrides.name ?? 'PvpBot',
        tick: () => ++t,
        sdk: {
            getState: () => ({
                player: { worldX: 3094, worldZ: 3492, level: 0 },
                skills: [{ name: 'Hitpoints', baseLevel: overrides.hp ?? 99, level: overrides.hp ?? 99, experience: 13_034_431 }],
            }),
            getInventory: () => inv,
            getEquipment: () => equip,
        },
    } as unknown as SessionCore;
}

describe('pvp WorkerModule contract & mode routing', () => {
    test('registers cleanly with @rsbot/workers registry and keeps pk kind + practice_passed trust', () => {
        expect(isWorkerModule(pvpModule)).toBe(true);
        expect(pvpModule.id).toBe('pvp:unified');
        expect(pvpModule.family).toBe('pvp');
        expect(pvpModule.kind).toBe('pk');
        expect(pvpModule.trust).toBe('practice_passed');
        expect(pvpModule.protectedAllowed).toBe(false);

        const reg = createWorkerRegistry();
        reg.register(pvpModule);
        expect(reg.get('pvp:unified')).toBe(pvpModule);
        expect(reg.list({ family: 'pvp' })).toEqual([pvpModule]);
        expect(reg.list({ kind: 'pk' })).toEqual([pvpModule]);
    });

    test('retains core foundation scripts and resolves all 15 consolidated PvP modes cleanly', () => {
        for (const rel of ['scripts/pk.ts', 'scripts/pk-squad.ts', 'scripts/pk-live/live-pilot.ts', 'scripts/pk-kits.ts']) {
            expect(existsSync(join(REPO_ROOT, rel))).toBe(true);
        }
        expect(SHIM_MODES).toEqual(PVP_MODES);
        expect(PVP_MODES.map(m => m.mode)).toEqual([
            'fight',
            'spar',
            'gang',
            'army',
            'squad',
            'team',
            'hunt',
            'roam',
            'pilot',
            'standby',
            'stage-kit',
            'escort-ore',
            'microbot-pvp',
            'special-swap',
            'monitor',
        ]);

        expect(resolvePvpStep('fight', ['target', '900'])).toEqual({
            script: 'scripts/pk.ts',
            args: ['target', '900'],
            env: {},
        });
        expect(resolvePvpStep('squad', ['target'])).toEqual({
            script: 'scripts/pk-squad.ts',
            args: ['target'],
            env: {},
        });
        expect(shimResolve('roam', ['HUNT_CAP=600'])).toEqual({
            script: 'scripts/aio-pvp.ts',
            args: ['roam', 'HUNT_CAP=600'],
            env: {},
        });
        expect(resolvePvpStep('pilot')).toEqual({
            script: 'scripts/pk-live/live-pilot.ts',
            args: ['10', '20'],
            env: {},
        });
        expect(resolvePvpStep('escort-ore', ['mine'])).toEqual({
            script: 'scripts/aio-pvp.ts',
            args: ['__escort-ore', 'mine'],
            env: {},
        });
        expect(() => resolvePvpStep('not-a-mode')).toThrow('unknown mode');
    });

    test('computes combat brackets, tribrid & god spell readiness, Mage Arena step, and agility escape guard', () => {
        const bracket = pvpCombatBracket({
            Attack: 99,
            Strength: 99,
            Defence: 99,
            Hitpoints: 99,
            Prayer: 99,
            Ranged: 99,
            Magic: 99,
        }, 3680);
        expect(bracket).toEqual({
            combatLevel: 126,
            wildernessLevel: 21,
            minTargetCombat: 105,
            maxTargetCombat: 126,
            gloryUsable: true,
            spellTeleportUsable: false,
            dominantStyle: 'melee',
        });

        expect(assessTribridReadiness({ 385: 5 })).toMatchObject({
            ready: false,
            missing: expect.objectContaining({ 385: 13 }),
        });

        const zamorakReady = assessGodSpellReadiness({
            god: 'zamorak',
            magicLevel: 80,
            prayerLevel: 43,
            wornIds: [2414, 2417],
            inventory: [{ id: 554, count: 8 }, { id: 565, count: 5 }, { id: 556, count: 4 }],
        });
        expect(zamorakReady).toMatchObject({ ready: true, conflict: null, maxHit: 30, prayerReady: true });
        expect(resolveMageArenaWorkflow('guthix', { mode: 'leash', charge: true })).toEqual({
            script: 'scripts/generated/quest-magearena.ts',
            args: [],
            env: { MA_GOD: 'guthix', MA_MODE: 'leash', MA_CHARGE: '1' },
        });

        const pitThreat = wildernessAgilityEscapeGuard({
            me: { x: 3005, z: 9925, level: 0, hp: 70, maxHp: 99, combatLevel: 100 },
            nearby: [{ name: 'Pker', x: 3005, z: 9927, combatLevel: 101, distance: 2, wornWeapon: 4587 }],
            hasGlory: true,
            hasVarrockTele: false,
            foodCount: 10,
        });
        expect(pitThreat.inPit).toBe(true);
        expect(pitThreat.action).toBe('climb-pit-then-escape');
    });

    test('preflight enforces protected clock, invalid config, skills, coins/reserves, supplies, food, and escape items', () => {
        const acct = makeAccount();
        const world = makeWorld(acct);

        const ok = pvpModule.preflight(acct, { mode: 'hunt', foodFloor: 18, requireEscape: true, minCoins: 50_000 }, world);
        expect(validatePreflightResult(ok)).toEqual([]);
        expect(ok).toEqual({ ok: true, blockers: [], travelTicks: 25 });

        const prot = pvpModule.preflight(makeAccount({ protectedClock: true }), { mode: 'hunt' }, world);
        expect(prot.ok).toBe(false);
        if (!prot.ok) expect(prot.blockers[0]!.kind).toBe('protected_clock');

        const badCfg = pvpModule.preflight(acct, { mode: 'fight', target: '   ', capTicks: 0, maxWilderness: 70, requireBankTrusted: true }, {
            ...world,
            accounts: { pvpbot: makeAccount({ bank: { items: {}, observedAt: 0, trusted: false } }) },
        });
        expect(badCfg.ok).toBe(false);

        const untrusted = pvpModule.preflight(
            makeAccount({ bank: { items: {}, observedAt: 0, trusted: false } }),
            { mode: 'hunt', requireBankTrusted: true },
            world,
        );
        expect(untrusted.ok).toBe(false);
        if (!untrusted.ok) expect(untrusted.blockers.some(b => b.kind === 'invalid_config')).toBe(true);

        const lowHp = pvpModule.preflight(
            makeAccount({ skills: { Hitpoints: { level: 40, xp: 37_224 } } }),
            { mode: 'hunt', minHitpointsLevel: 70 },
            world,
        );
        expect(lowHp.ok).toBe(false);
        if (!lowHp.ok) expect(lowHp.blockers.some(b => b.kind === 'skill_level')).toBe(true);

        const reservedCoins = pvpModule.preflight(
            acct,
            { mode: 'hunt', minCoins: 50_000 },
            makeWorld(acct, { pvpbot: { 995: 40_000 } }, { pvpbot: 25_000 }),
        );
        expect(reservedCoins.ok).toBe(false);
        if (!reservedCoins.ok) expect(reservedCoins.blockers[0]!.kind).toBe('missing_coins');

        const noFoodOrEscape = pvpModule.preflight(
            makeAccount({ inventory: {}, equipment: {}, bank: { items: {}, observedAt: 1, trusted: true } }),
            { mode: 'hunt', foodFloor: 18, requireEscape: true, requiredItems: [{ id: 1215, itemName: 'dragon_dagger_p', count: 1 }] },
            world,
        );
        expect(noFoodOrEscape.ok).toBe(false);
        if (!noFoodOrEscape.ok) {
            expect(noFoodOrEscape.blockers.some(b => b.kind === 'combat_survivability')).toBe(true);
            expect(noFoodOrEscape.blockers.filter(b => b.kind === 'missing_supply').length).toBeGreaterThanOrEqual(2);
        }
    });

    test('estimate produces bounded practice estimates across duel, wilderness, and preparation modes', () => {
        const acct = makeAccount();
        const world = makeWorld(acct);
        for (const cfg of [
            { mode: 'spar' },
            { mode: 'hunt' },
            { mode: 'stage-kit' },
        ] satisfies PvpConfig[]) {
            const est = pvpModule.estimate(acct, cfg, world);
            expect(validateRateEstimate(est)).toEqual([]);
            expect(est.confidence).toBe('practice');
            expect(est.unitsPerTick).toBeGreaterThan(0);
        }
    });

    test('run covers dry-run, stop/missing_supply/preflight failures, and dispatchPvpCli hooks cleanly', async () => {
        const stopped = await pvpModule.run(makeSession(), { mode: 'hunt', stop: () => true });
        expect(validateRunOutcome(stopped)).toEqual([]);
        expect(stopped.kind).toBe('session_unsettled');

        const missingSupply = await pvpModule.run(makeSession({ inventory: [{ id: 385, count: 20 }] }), {
            mode: 'hunt',
            requireEscape: true,
        });
        expect(validateRunOutcome(missingSupply)).toEqual([]);
        expect(missingSupply.kind).toBe('missing_supply');

        const badSkill = await pvpModule.run(makeSession({ hp: 40 }), { mode: 'hunt', minHitpointsLevel: 70 });
        expect(validateRunOutcome(badSkill)).toEqual([]);
        expect(badSkill).toMatchObject({ kind: 'worker_defect', faultSignature: 'preflight:skill_level' });

        const dry = await pvpModule.run(makeSession(), { mode: 'hunt', execute: false, foodFloor: 18 });
        expect(validateRunOutcome(dry)).toEqual([]);
        expect(dry.kind).toBe('target_met');

        const prevFight = pvpRuntime.runPkFightCli;
        const prevSquad = pvpRuntime.runPkSquadCli;
        const prevChild = pvpRuntime.runDirectChild;
        const seenFight: string[][] = [];
        const seenChild: Array<{ args: readonly string[]; env?: Record<string, string | undefined> }> = [];
        try {
            pvpRuntime.runPkFightCli = async (args) => {
                seenFight.push([...args]);
                return 0;
            };
            pvpRuntime.runPkSquadCli = async () => 2;
            pvpRuntime.runDirectChild = async (args, env) => {
                seenChild.push({ args, env });
                return 'RESULT ok kills=1';
            };

            const fightOk = await pvpModule.run(makeSession({ name: 'Alpha' }), { mode: 'fight', target: 'Beta', capTicks: 120 });
            expect(validateRunOutcome(fightOk)).toEqual([]);
            expect(fightOk.kind).toBe('target_met');
            expect(seenFight).toEqual([['Alpha', 'Beta', '120']]);

            const squadRefused = await pvpModule.run(makeSession({ name: 'Alpha' }), { mode: 'squad' });
            expect(validateRunOutcome(squadRefused)).toEqual([]);
            expect(squadRefused).toMatchObject({ kind: 'worker_defect', faultSignature: 'pvp:squad:requires_cli_orchestrator' });

            const squadCliCode = await dispatchPvpCli('Alpha', 'squad', []);
            expect(squadCliCode).toBe(2);

            const pilotOk = await dispatchPvpCli('Alpha', 'pilot', ['5', '10']);
            expect(pilotOk).toBe(0);
            expect(seenChild[0]!.args).toEqual(['scripts/pk-live/live-pilot.ts', 'Alpha', '5', '10']);
        } finally {
            pvpRuntime.runPkFightCli = prevFight;
            pvpRuntime.runPkSquadCli = prevSquad;
            pvpRuntime.runDirectChild = prevChild;
        }

        const endedOut = await pvpModule.run({ ...makeSession(), ended: Promise.resolve() } as unknown as SessionCore, { mode: 'hunt' });
        expect(validateRunOutcome(endedOut)).toEqual([]);
        expect(endedOut.kind).toBe('session_unsettled');
    });
});
