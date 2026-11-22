import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionCore } from '../../core/src/session-types';
import {
    createWorkerRegistry,
    validateWorkerModule,
    type WorkerAccountView,
    type WorkerWorldView,
} from '../src/contracts';
import {
    LOGISTICS_OPERATIONS,
    LOGISTICS_ROLES,
    findLogisticsRole,
    importAioLoadout,
    logisticsWorker,
    planFleetDistribution,
    resolveLogisticsStep,
    type LogisticsConfig,
} from '../src/logistics';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function baseAccount(overrides: Partial<WorkerAccountView> = {}): WorkerAccountView {
    return {
        name: 'LogisticsTester',
        side: 'local',
        protectedClock: false,
        skills: {
            Hitpoints: { level: 99, xp: 13_034_431 },
            Cooking: { level: 80, xp: 2_000_000 },
            Prayer: { level: 43, xp: 55_000 },
        },
        quests: {
            heroquest: 'complete',
        },
        pos: { x: 3185, z: 3436, level: 0 },
        inventory: {},
        bank: {
            trusted: true,
            observedAt: 1_700_000_000_000,
            items: {
                995: 100_000,
                1987: 50,
                1937: 50,
                1704: 3,
            },
        },
        equipment: {},
        ...overrides,
    };
}

function baseWorld(overrides: Partial<WorkerWorldView> = {}): WorkerWorldView {
    return {
        at: 1_700_000_000_000,
        side: 'local',
        server: 'localhost:8888',
        accounts: {},
        reserves: {},
        geEscrowCoins: {},
        ...overrides,
    };
}

function makeFakeSessionCore(opts: {
    name?: string;
    pos?: { worldX: number; worldZ: number; level: number };
    skills?: Record<string, { level: number; baseLevel: number; xp?: number }>;
    inventory?: { id: number; name: string; count: number; slot: number; optionsWithIndex?: { text: string; opIndex: number }[] }[];
    bankItems?: { id: number; name: string; count: number; slot: number }[];
    bankNear?: boolean;
    quests?: { name: string; state: string }[];
} = {}) {
    let tick = 1;
    let gen = 1;
    let open = false;
    const listeners = new Set<() => void>();
    const pos = opts.pos ?? { worldX: 3092, worldZ: 3243, level: 0 };
    const skills = opts.skills ?? {
        Hitpoints: { level: 99, baseLevel: 99, xp: 13_034_431 },
        Prayer: { level: 43, baseLevel: 43, xp: 55_000 },
        Cooking: { level: 82, baseLevel: 82, xp: 2_500_000 },
    };
    const inv = [...(opts.inventory ?? [])];
    const bank = [...(opts.bankItems ?? [{ id: 995, name: 'Coins', count: 1000, slot: 0 }])];
    const timer = setInterval(() => {
        tick++;
        for (const cb of [...listeners]) cb();
    }, 2);
    const core = {
        name: opts.name ?? 'LogisticsTester',
        tick: () => tick,
        onTick: (cb: () => void) => {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        ended: new Promise(() => {}),
        bankObservation: () => (open ? { generation: gen, at: Date.now(), items: bank.map(i => ({ ...i })) } : null),
        sdk: {
            getInventory: () => inv,
            getEquipment: () => [],
            getBankItems: () => bank,
            getSkill: (n: string) => skills[n] ?? { level: 1, baseLevel: 1, xp: 0 },
            getSkillXp: (n: string) => skills[n]?.xp ?? 0,
            getState: () => ({
                player: { ...pos, lifeId: 1, respawnCount: 0, isDead: false, hp: skills.Hitpoints?.level ?? 99 },
                skills: Object.entries(skills).map(([name, s]) => ({ name, level: s.level, baseLevel: s.baseLevel, experience: s.xp ?? 0 })),
                quests: opts.quests ?? [],
                inventory: inv,
                equipment: [],
                bank: { isOpen: open, items: bank, noteMode: false },
                interface: { isOpen: false, interfaceId: -1 },
                dialog: { isOpen: false, options: [] },
                nearbyNpcs: opts.bankNear === false ? [] : [{ name: 'Banker', x: pos.worldX + 1, z: pos.worldZ }],
                nearbyLocs: opts.bankNear === false ? [] : [{ id: 2213, name: 'Bank booth', x: pos.worldX + 1, z: pos.worldZ, level: pos.level, optionsWithIndex: [{ text: 'Use', opIndex: 1 }] }],
            }),
            sendUseItem: async (slot: number) => {
                const item = inv[slot];
                if (item) {
                    item.count -= 1;
                    if (item.count <= 0) inv.splice(slot, 1);
                }
                tick++;
                return { success: true };
            },
            sendWalk: async (x: number, z: number) => { pos.worldX = x; pos.worldZ = z; return { success: true }; },
            sendCloseModal: async () => { open = false; return { success: true }; },
        },
        bot: {
            openBank: async () => { open = true; gen++; return { success: true }; },
            closeBank: async () => { open = false; return { success: true }; },
            walkTo: async (x: number, z: number) => { pos.worldX = x; pos.worldZ = z; return { success: true }; },
            skipTutorial: async () => ({ success: true }),
        },
    } as unknown as SessionCore;
    return {
        core,
        dispose: () => clearInterval(timer),
    };
}

describe('WorkerModule logistics contract and dispatch', () => {
    test('registers and validates logistics WorkerModule with required identity and vocabulary', () => {
        expect(() => validateWorkerModule(logisticsWorker)).not.toThrow();
        const registry = createWorkerRegistry([logisticsWorker]);
        expect(registry.get('logistics')).toBe(logisticsWorker);
        expect(logisticsWorker.id).toBe('logistics');
        expect(logisticsWorker.family).toBe('logistics');
        expect(logisticsWorker.kind).toBe('recover');
        expect(logisticsWorker.trust).toBe('practice_passed');
        expect(logisticsWorker.protectedAllowed).toBe(false);
        expect(LOGISTICS_OPERATIONS).toEqual(['trade', 'hub_bank', 'stage', 'walk', 'recover', 'inspect']);
    });

    test('LOGISTICS_ROLES covers all 29 roles and resolveLogisticsStep maps aliases and env overrides', () => {
        expect(LOGISTICS_ROLES).toHaveLength(29);
        for (const spec of LOGISTICS_ROLES) {
            expect(spec.script).toBe('scripts/aio-logistics.ts');
            expect(LOGISTICS_OPERATIONS).toContain(spec.operation);
        }
        expect(findLogisticsRole('pray-at-altar')?.role).toBe('restore-prayer');
        expect(findLogisticsRole('foodcourier')?.role).toBe('food-courier');
        expect(findLogisticsRole('make-wine-order')?.role).toBe('wine-stock');
        expect(findLogisticsRole('fleet-inspect')?.role).toBe('inspect');
        expect(resolveLogisticsStep('pray-at-altar', ['ALTAR=3243,3205'])).toEqual({
            script: 'scripts/aio-logistics.ts',
            args: ['restore-prayer'],
            env: { ALTAR: '3243,3205' },
        });
        expect(resolveLogisticsStep('recover-trapped', ['600', 'CAP=700'])).toEqual({
            script: 'scripts/aio-logistics.ts',
            args: ['recover-trapped', '600'],
            env: { CAP: '700' },
        });
        expect(() => resolveLogisticsStep('no-such-logistics-role')).toThrow('unknown role');
    });

    test('planFleetDistribution pairs donor surplus above reserve with receiver deficits', () => {
        expect(planFleetDistribution(
            [{ account: 'Treasury', held: 100, reserve: 30 }, { account: 'Extra', held: 40 }],
            [{ account: 'WorkerA', held: 10, target: 60 }, { account: 'Treasury', held: 5, target: 50 }],
        )).toEqual({
            transfers: [
                { from: 'Treasury', to: 'WorkerA', amount: 50 },
                { from: 'Extra', to: 'Treasury', amount: 40 },
            ],
            unmet: [{ account: 'Treasury', shortfall: 5 }],
        });
    });

    test('preflight validates operations, role mismatches, reserves, supplies, skills, quests, and safety limits', () => {
        const acct = baseAccount();
        const world = baseWorld();

        expect(logisticsWorker.preflight(acct, { operation: 'unknown' } as unknown as LogisticsConfig, world)).toMatchObject({
            ok: false,
            blockers: [{ kind: 'invalid_config' }],
        });
        expect(logisticsWorker.preflight(acct, { operation: 'trade', role: 'banker' } as LogisticsConfig, world)).toMatchObject({
            ok: false,
            blockers: [{ kind: 'invalid_config' }],
        });
        expect(logisticsWorker.preflight(acct, { operation: 'walk', role: 'walk-to', target: { x: 3092, z: 3243, level: 0 }, capTicks: 0 }, world)).toMatchObject({
            ok: false,
            blockers: [{ kind: 'invalid_config' }],
        });

        // Trade coins reserve & escrow
        expect(logisticsWorker.preflight(acct, { operation: 'trade', role: 'coin-courier', coins: 60_000, reserve: 50_000 }, world)).toMatchObject({
            ok: false,
            blockers: [{ kind: 'missing_coins', required: 60_000 }],
        });
        expect(logisticsWorker.preflight(acct, { operation: 'trade', role: 'coin-courier', coins: 50_000, reserve: 10_000 }, world)).toEqual({ ok: true, blockers: [] });
        expect(logisticsWorker.preflight(acct, { operation: 'trade', role: 'coin-courier', args: ['Receiver', 'not-an-amount'] }, world)).toMatchObject({
            ok: false,
            blockers: [{ kind: 'invalid_config' }],
        });

        // Hub bank & wine-stock skill + supplies
        const lowCook = baseAccount({ skills: { Cooking: { level: 30, xp: 14_000 }, Hitpoints: { level: 99, xp: 13_034_431 } } });
        expect(logisticsWorker.preflight(lowCook, { operation: 'hub_bank', role: 'wine-stock', targetBatches: 5 }, world)).toMatchObject({
            ok: false,
            blockers: [{ kind: 'skill_level', skill: 'Cooking', required: 35, current: 30 }],
        });
        expect(logisticsWorker.preflight(acct, { operation: 'hub_bank', role: 'wine-stock', targetBatches: 40, reserveBatches: 15 }, world)).toMatchObject({
            ok: false,
            blockers: expect.arrayContaining([
                expect.objectContaining({ kind: 'missing_supply', itemId: 1987, required: 55 }),
            ]),
        });
        expect(logisticsWorker.preflight(acct, { operation: 'hub_bank', role: 'wine-stock', targetBatches: 10, reserveBatches: 5 }, world)).toEqual({ ok: true, blockers: [] });

        // Stage
        expect(logisticsWorker.preflight(acct, { operation: 'stage', role: 'loadout-import' }, world)).toMatchObject({
            ok: false,
            blockers: [{ kind: 'invalid_config' }],
        });
        expect(logisticsWorker.preflight(acct, { operation: 'stage', role: 'bank-sort', args: ['200', '999'] }, world)).toMatchObject({
            ok: false,
            blockers: [{ kind: 'invalid_config' }],
        });

        // Walk & Recover safety
        expect(logisticsWorker.preflight(acct, { operation: 'walk', role: 'walk-to' }, world)).toMatchObject({
            ok: false,
            blockers: [{ kind: 'invalid_config' }],
        });
        expect(logisticsWorker.preflight(acct, { operation: 'walk', role: 'walk-to', target: { x: 3092, z: 3243, level: 0 } }, world)).toEqual({ ok: true, blockers: [] });

        expect(logisticsWorker.preflight(acct, { operation: 'recover', role: 'recover-trapped', target: { x: 3100, z: 3600, level: 0 } }, world)).toMatchObject({
            ok: false,
            blockers: [{ kind: 'unreachable_tile' }],
        });
        expect(logisticsWorker.preflight(
            baseAccount({ quests: {} }),
            { operation: 'recover', role: 'charge-glory' },
            world,
        )).toMatchObject({
            ok: false,
            blockers: [{ kind: 'quest_incomplete', quest: 'heroquest' }],
        });
        expect(logisticsWorker.preflight(
            baseAccount({ bank: { trusted: true, observedAt: 1_700_000_000_000, items: { 995: 1000 } } }),
            { operation: 'recover', role: 'charge-glory' },
            world,
        )).toMatchObject({
            ok: false,
            blockers: [{ kind: 'missing_supply' }],
        });
        expect(logisticsWorker.preflight(acct, { operation: 'recover', role: 'restore-prayer', args: ['ALTAR=1,2'] }, world)).toMatchObject({
            ok: false,
            blockers: [{ kind: 'invalid_config' }],
        });
        expect(logisticsWorker.preflight(acct, { operation: 'inspect' }, world)).toEqual({ ok: true, blockers: [] });
    });

    test('estimate produces bounded non-zero RateEstimates across all logistics operations', () => {
        const acct = baseAccount();
        const world = baseWorld();
        for (const cfg of [
            { operation: 'trade', role: 'coin-courier' },
            { operation: 'hub_bank', role: 'wine-stock', targetBatches: 12 },
            { operation: 'stage', role: 'bank-sort' },
            { operation: 'walk', role: 'walk-to', target: { x: 3092, z: 3243, level: 0 } },
            { operation: 'recover', role: 'charge-glory' },
            { operation: 'recover', role: 'recover-trapped' },
            { operation: 'inspect' },
        ] satisfies LogisticsConfig[]) {
            const est = logisticsWorker.estimate(acct, cfg, world);
            expect(est.unitsPerTick).toBeGreaterThan(0);
            expect(est.setupTicks).toBeGreaterThanOrEqual(0);
            expect(est.minBatchUnits).toBeGreaterThanOrEqual(1);
            expect(est.confidence).toBe('practice');
        }
    });

    test('run executes inspect, recover (prayer, antipoison, trapped), and stage (loadout-import) cleanly', async () => {
        const inspectSess = makeFakeSessionCore();
        try {
            const out = await logisticsWorker.run(inspectSess.core, { operation: 'inspect', env: { REQUIRE_BANK: '1' } });
            expect(out).toMatchObject({ kind: 'target_met', activityId: 'logistics:inspect', unitsCompleted: 1 });
        } finally {
            inspectSess.dispose();
        }

        const praySess = makeFakeSessionCore();
        try {
            const out = await logisticsWorker.run(praySess.core, { operation: 'recover', role: 'restore-prayer' });
            expect(out).toMatchObject({ kind: 'target_met', activityId: 'logistics:restore-prayer', unitsCompleted: 1 });
        } finally {
            praySess.dispose();
        }

        const poisonOkSess = makeFakeSessionCore({
            inventory: [{ id: 175, name: 'Antipoison(3)', count: 1, slot: 0, optionsWithIndex: [{ text: 'Drink', opIndex: 1 }] }],
        });
        try {
            const out = await logisticsWorker.run(poisonOkSess.core, { operation: 'recover', role: 'cure-poison' });
            expect(out).toMatchObject({ kind: 'target_met', activityId: 'logistics:cure-poison', unitsCompleted: 1 });
        } finally {
            poisonOkSess.dispose();
        }

        const poisonMissingSess = makeFakeSessionCore({ pos: { worldX: 3093, worldZ: 3243, level: 0 }, bankNear: false, inventory: [], bankItems: [] });
        try {
            const out = await logisticsWorker.run(poisonMissingSess.core, { operation: 'recover', role: 'cure-poison' });
            expect(out).toMatchObject({ kind: 'missing_supply', activityId: 'logistics:cure-poison' });
        } finally {
            poisonMissingSess.dispose();
        }

        const hubOkSess = makeFakeSessionCore({ pos: { worldX: 3185, worldZ: 3436, level: 0 } });
        try {
            const out = await logisticsWorker.run(hubOkSess.core, { operation: 'recover', role: 'recover-trapped' });
            expect(out).toMatchObject({ kind: 'location_stranded', activityId: 'logistics:recover-trapped' });
        } finally {
            hubOkSess.dispose();
        }

        const dir = makeTempDir('logistics-loadout-');
        const sourceFile = join(dir, 'source.json');
        const bindingsFile = join(dir, 'bindings.json');
        writeFileSync(sourceFile, JSON.stringify({ inv: [{ id: 10001 }], eq: [] }));
        writeFileSync(bindingsFile, JSON.stringify({ items: { 10001: 385 }, bank: { x: 3092, z: 3243, level: 0 }, cap: 300, maximumMoves: 64, packPolicy: 'exact-counts' }));
        expect(importAioLoadout([sourceFile, bindingsFile]).pack).toEqual([{ id: 385, count: 1 }]);
        const stageSess = makeFakeSessionCore();
        try {
            const okOut = await logisticsWorker.run(stageSess.core, {
                operation: 'stage',
                role: 'loadout-import',
                setupFile: sourceFile,
                bindingsFile,
            });
            expect(okOut).toMatchObject({ kind: 'target_met', activityId: 'logistics:loadout-import', unitsCompleted: 1 });
            const badOut = await logisticsWorker.run(stageSess.core, { operation: 'stage', role: 'loadout-import' });
            expect(badOut).toMatchObject({ kind: 'worker_defect', faultSignature: 'invalid_loadout_import_args' });
        } finally {
            stageSess.dispose();
        }
    });
});
