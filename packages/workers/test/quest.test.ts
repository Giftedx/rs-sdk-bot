import { describe, expect, test } from 'bun:test';
import {
    QUESTER_MODES,
    assessQuestReadiness,
    listGeneratedQuestScripts,
    prioritizeQuestsForAccount,
    questCatalogSummary,
    questModule,
    resolveQuestScript,
    resolveQuesterStep,
    type QuestConfig,
} from '../src/quest';
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
    QUESTER_MODES as SHIM_MODES,
    assessQuestReadiness as shimReadiness,
    resolveQuesterStep as shimResolve,
} from '../../../scripts/aio-quester';

function makeAccount(overrides: Partial<WorkerAccountView> = {}): WorkerAccountView {
    return {
        name: 'QuesterBot',
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
        pos: { x: 3222, z: 3218, level: 0 },
        inventory: {},
        equipment: {},
        bank: {
            items: { 1944: 1, 1927: 1, 1933: 1 },
            observedAt: 1_700_000_000_000,
            trusted: true,
        },
        ...overrides,
    };
}

function makeWorld(acct: WorkerAccountView): WorkerWorldView {
    return {
        at: 1_700_000_005_000,
        side: 'local',
        server: 'local',
        accounts: { [acct.name.toLowerCase()]: acct },
        reserves: {},
        globalReserves: {},
        geEscrowCoins: {},
    };
}

describe('quest WorkerModule contract & mode routing', () => {
    test('registers cleanly with @rsbot/workers registry and exposes practice_passed trust', () => {
        expect(isWorkerModule(questModule)).toBe(true);
        expect(questModule.id).toBe('quest:unified');
        expect(questModule.family).toBe('quest');
        expect(questModule.kind).toBe('quest');
        expect(questModule.trust).toBe('practice_passed');
        expect(questModule.protectedAllowed).toBe(false);

        const reg = createWorkerRegistry();
        reg.register(questModule);
        expect(reg.get('quest:unified')).toBe(questModule);
        expect(reg.list({ family: 'quest' })).toEqual([questModule]);
        expect(reg.list({ kind: 'quest' })).toEqual([questModule]);
    });

    test('lists >= 68 retained generated quest scripts and resolves CLI aliases via shim', () => {
        const generated = listGeneratedQuestScripts();
        expect(generated.length).toBeGreaterThanOrEqual(68);
        expect(resolveQuestScript('romeojuliet')).toBe('scripts/generated/quest-rj.ts');
        expect(resolveQuestScript('waterfall')).toBe('scripts/generated/waterfall.ts');
        expect(resolveQuestScript('mcannon')).toBe('scripts/generated/dwarfcannon.ts');

        expect(SHIM_MODES).toEqual(QUESTER_MODES);
        expect(shimResolve('sweep', ['cook'])).toEqual({
            script: 'scripts/aio-quester.ts',
            args: ['sweep', 'cook'],
            env: {},
        });
        expect(resolveQuesterStep('order', ['cook', '--timeout-ms=300000'])).toEqual({
            script: 'scripts/aio-quester.ts',
            args: ['order', 'cook', '--timeout-ms=300000'],
            env: {},
        });
        expect(resolveQuesterStep('hero-owned', ['pair.json'])).toEqual({
            script: 'scripts/aio-quester.ts',
            args: ['hero-owned', 'pair.json'],
            env: {},
        });
        expect(resolveQuesterStep('cook')).toEqual({
            script: 'scripts/generated/quest-cook.ts',
            args: [],
            env: {},
        });
        expect(shimReadiness('cook', { 1944: 1 })).toMatchObject({ ready: false, missingItems: { 1927: 1, 1933: 1 } });
        expect(questCatalogSummary().generatedScripts).toBeGreaterThanOrEqual(68);
    });

    test('prioritizeQuestsForAccount emits sweep steps routed through aio-quester.ts', () => {
        const prioritized = prioritizeQuestsForAccount({ 1944: 1, 1927: 1, 1933: 1 }, new Set(), ['cook', 'hetty']);
        expect(prioritized.readyNow.map((q) => q.slug)).toEqual(['cook']);
        expect(prioritized.readyNow[0]!.step).toEqual({
            script: 'scripts/aio-quester.ts',
            args: ['sweep', 'cook'],
            env: {},
        });
        expect(prioritized.needsItems.map((q) => q.slug)).toEqual(['hetty']);
    });

    test('preflight validates protected clock, supplies, skills, prerequisites, and clue bounds', () => {
        const acct = makeAccount();
        const world = makeWorld(acct);

        const okCook = questModule.preflight(acct, { operation: 'sweep', quest: 'cook' }, world);
        expect(validatePreflightResult(okCook)).toEqual([]);
        expect(okCook.ok).toBe(true);

        const protectedAcct = makeAccount({ protectedClock: true });
        const protRes = questModule.preflight(protectedAcct, { operation: 'sweep', quest: 'cook' }, makeWorld(protectedAcct));
        expect(protRes.ok).toBe(false);
        if (!protRes.ok) expect(protRes.blockers[0]!.kind).toBe('protected_clock');

        const missingSupply = questModule.preflight(
            makeAccount({ bank: { items: { 1944: 1 }, observedAt: 1, trusted: true } }),
            { operation: 'sweep', quest: 'cook' },
            world,
        );
        expect(missingSupply.ok).toBe(false);
        if (!missingSupply.ok) {
            expect(missingSupply.blockers.some((b) => b.kind === 'missing_supply')).toBe(true);
        }

        const missingOrder = questModule.preflight(acct, { operation: 'order', quest: 'unknown' }, world);
        expect(missingOrder.ok).toBe(false);
        if (!missingOrder.ok) expect(missingOrder.blockers[0]!.kind).toBe('invalid_config');

        const badClue = questModule.preflight(acct, { operation: 'clue', clueId: -1 }, world);
        expect(badClue.ok).toBe(false);

        const lowGuardian = questModule.preflight(
            makeAccount({ skills: { Hitpoints: { level: 40, xp: 37224 }, Prayer: { level: 1, xp: 0 }, Magic: { level: 1, xp: 0 } } }),
            { operation: 'clue-guardian', clueId: 2743, spell: 'fire_blast' },
            world,
        );
        expect(lowGuardian.ok).toBe(false);
        if (!lowGuardian.ok) {
            expect(lowGuardian.blockers.some((b) => b.kind === 'combat_survivability')).toBe(true);
            expect(lowGuardian.blockers.some((b) => b.kind === 'skill_level')).toBe(true);
        }
    });

    test('estimate produces valid practice estimates across quest operations', () => {
        const acct = makeAccount();
        const world = makeWorld(acct);
        for (const cfg of [
            { operation: 'sweep', quest: 'cook' },
            { operation: 'clue', clueId: 3511, cap: 60 },
            { operation: 'clue-guardian', clueId: 2743, cap: 350 },
        ] satisfies QuestConfig[]) {
            const est = questModule.estimate(acct, cfg, world);
            expect(validateRateEstimate(est)).toEqual([]);
            expect(est.confidence).toBe('practice');
            expect(est.unitsPerTick).toBeGreaterThan(0);
        }
    });

    test('run returns structured worker_defect on unsupported and CLI-only orchestrator operations without touching live sessions', async () => {
        const session = { name: 'QuesterBot', tick: () => 42 } as unknown as SessionCore;
        const out = await questModule.run(session, { operation: 'nope' as QuestConfig['operation'] });
        expect(validateRunOutcome(out)).toEqual([]);
        expect(out.kind).toBe('worker_defect');

        for (const op of ['order', 'chain', 'hero-owned', 'legends-owned'] as const) {
            const refused = await questModule.run(session, { operation: op, quest: 'cook', quests: ['cook'] });
            expect(validateRunOutcome(refused)).toEqual([]);
            expect(refused).toMatchObject({ kind: 'worker_defect', faultSignature: `quest:${op}:requires_cli_orchestrator` });
        }
    });
});
