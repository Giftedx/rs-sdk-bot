import { expect, test } from 'bun:test';
import { parseStep } from '../../core/src/chain-step';
import type { AccountPlan, ActivityDefinition } from '../src/contracts';
import { adaptAccountPlan, adaptActivityToStep, adaptPlannedStep } from '../src/script-adapter';

const CATALOG_SAMPLE: ActivityDefinition[] = [
    {
        id: 'gather:fishing-shark',
        workerId: 'gather',
        family: 'gather',
        kind: 'gather',
        label: 'Catch sharks',
        skill: 'Fishing',
        config: { aioCategory: 'skiller', aioRoute: 'fishing:shark', skill: 'fishing', method: 'shark' },
        baselineRate: { xpPerTick: 100, unitsPerTick: 0.1, gpPerTick: 50, setupTicks: 20, minBatchUnits: 50, confidence: 'practice' },
        trust: 'practice_passed',
    },
    {
        id: 'bank-artisan:cook-shark',
        workerId: 'bank-artisan',
        family: 'bank-artisan',
        kind: 'produce',
        label: 'Cook sharks',
        skill: 'Cooking',
        config: { aioCategory: 'skiller', aioRoute: 'cooking:food', defaultArgs: ['2000', 'shark'] },
        baselineRate: { xpPerTick: 210, unitsPerTick: 0.25, gpPerTick: 15, setupTicks: 20, minBatchUnits: 50, confidence: 'practice' },
        trust: 'practice_passed',
    },
    {
        id: 'combat:kbd',
        workerId: 'combat',
        family: 'combat',
        kind: 'train',
        label: 'Kill KBD',
        config: { aioCategory: 'boss', aioRoute: 'kbd', boss: 'kbd', defaultEnv: { TRIP_CAP: '2000' } },
        baselineRate: { xpPerTick: 80, unitsPerTick: 0.01, gpPerTick: 400, setupTicks: 40, minBatchUnits: 5, confidence: 'practice' },
        trust: 'practice_passed',
    },
    {
        id: 'agility:gnome',
        workerId: 'agility',
        family: 'agility',
        kind: 'train',
        label: 'Gnome agility',
        skill: 'Agility',
        config: { method: 'gnome' },
        baselineRate: { xpPerTick: 86, unitsPerTick: 0.05, gpPerTick: 0, setupTicks: 15, minBatchUnits: 10, confidence: 'practice' },
        trust: 'practice_passed',
    },
    {
        id: 'runecraft:air',
        workerId: 'runecraft',
        family: 'runecraft',
        kind: 'produce',
        label: 'Air runes',
        skill: 'Runecraft',
        config: { method: 'bank-craft', defaultEnv: { RUNE_ALTAR: 'air' } },
        baselineRate: { xpPerTick: 30, unitsPerTick: 0.5, gpPerTick: 10, setupTicks: 20, minBatchUnits: 28, confidence: 'practice' },
        trust: 'practice_passed',
    },
    {
        id: 'quest:cook',
        workerId: 'quest',
        family: 'quest',
        kind: 'quest',
        label: "Cook's Assistant",
        questSlug: 'cook',
        config: { aioCategory: 'quester', aioRoute: 'cook', questSlug: 'cook', mode: 'sweep' },
        baselineRate: { xpPerTick: 120, unitsPerTick: 0.01, gpPerTick: 0, setupTicks: 15, minBatchUnits: 1, confidence: 'practice' },
        trust: 'practice_passed',
    },
    {
        id: 'market:ge-buy',
        workerId: 'market',
        family: 'market',
        kind: 'ge_buy',
        label: 'GE buy',
        config: { aioCategory: 'market', aioRoute: 'ge-buy', mode: 'ge-buy' },
        baselineRate: { xpPerTick: 0, unitsPerTick: 10, gpPerTick: 0, setupTicks: 30, minBatchUnits: 1, confidence: 'practice' },
        trust: 'practice_passed',
    },
    {
        id: 'logistics:banker',
        workerId: 'logistics',
        family: 'logistics',
        kind: 'recover',
        label: 'Stationed banker',
        config: { aioCategory: 'logistics', aioRoute: 'banker', role: 'banker' },
        baselineRate: { xpPerTick: 0, unitsPerTick: 1, gpPerTick: 0, setupTicks: 10, minBatchUnits: 1, confidence: 'practice' },
        trust: 'practice_passed',
    },
    {
        id: 'pvp:hunt',
        workerId: 'pvp',
        family: 'pvp',
        kind: 'pk',
        label: 'Wildy PK hunt',
        config: { aioCategory: 'pvp', aioRoute: 'hunt', mode: 'hunt' },
        baselineRate: { xpPerTick: 0, unitsPerTick: 0.02, gpPerTick: 250, setupTicks: 25, minBatchUnits: 1, confidence: 'practice' },
        trust: 'practice_passed',
    },
];

test('adaptActivityToStep maps all 9 worker families onto live scripts/aio-*.ts entries', () => {
    const scripts = new Map<string, string>();
    for (const act of CATALOG_SAMPLE) {
        const res = adaptActivityToStep(act);
        expect(res.step.script).toMatch(/^scripts\/[\w./-]+\.ts$/);
        scripts.set(act.family, res.step.script);
    }

    expect(scripts.get('gather')).toBe('scripts/aio-skiller.ts');
    expect(scripts.get('bank-artisan')).toBe('scripts/aio-skiller.ts');
    expect(scripts.get('agility')).toBe('scripts/aio-skiller.ts');
    expect(scripts.get('runecraft')).toBe('scripts/aio-skiller.ts');
    expect(scripts.get('combat')).toBe('scripts/aio-boss.ts');
    expect(scripts.get('quest')).toBe('scripts/aio-quester.ts');
    expect(scripts.get('market')).toBe('scripts/aio-market.ts');
    expect(scripts.get('logistics')).toBe('scripts/aio-logistics.ts');
    expect(scripts.get('pvp')).toBe('scripts/aio-pvp.ts');
});

test('adaptPlannedStep and adaptAccountPlan compile recover, acquire, gear_upgrade, unlock, and work into chain-compatible steps', () => {
    const ctx = { activities: CATALOG_SAMPLE };

    const logoutRec = adaptPlannedStep(
        'UnloadMe',
        { stepKind: 'recover', recoveryKind: 'logout', estimatedTicks: 20, reason: 'held proof' },
        ctx,
    );
    expect(logoutRec.mode).toBe('session_recovery');
    expect(logoutRec.step.script).toBe('scripts/cloud-recover.ts');

    const locRec = adaptPlannedStep(
        'UnloadMe',
        { stepKind: 'recover', recoveryKind: 'location', targetHub: 'ardougne', estimatedTicks: 60, reason: 'stranded' },
        ctx,
    );
    expect(locRec.step.script).toBe('scripts/aio-logistics.ts');
    expect(locRec.step.args[0]).toBe('walk-to');

    const plan: AccountPlan = {
        account: 'Packhorse',
        demandId: 'd:sharks',
        scorePerHour: 18,
        steps: [
            {
                stepKind: 'acquire',
                source: 'ge',
                itemId: 383,
                quantity: 100,
                estimatedTicks: 40,
                estimatedCoinCost: 40_000,
                coinFloatPreserved: 1000,
            },
            {
                stepKind: 'gear_upgrade',
                itemId: 775,
                slot: 'hands',
                netXpPerTickGain: 2,
                remainingBandTicks: 3000,
                acquisitionTicks: 20,
                paybackNetTicks: 200,
                source: 'own_bank',
            },
            {
                stepKind: 'work',
                activityId: 'bank-artisan:cook-shark',
                demandId: 'd:sharks',
                workerId: 'bank-artisan',
                batchUnits: 100,
                estimatedTicks: 425,
                expectedValuePerHour: 18,
                config: {},
            },
        ],
    };

    const adapted = adaptAccountPlan(plan, ctx);
    expect(adapted.steps.length).toBe(3);
    expect(adapted.combinedStep?.script).toBe('scripts/chain.ts');
    expect(adapted.combinedStep?.args.length).toBe(3);
    for (const rawChainText of adapted.combinedStep!.args) {
        const parsed = parseStep(rawChainText);
        expect(parsed.script).toMatch(/^scripts\/aio-/);
    }
});
