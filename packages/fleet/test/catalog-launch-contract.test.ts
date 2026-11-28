import { describe, expect, test } from 'bun:test';
import { createActivityCatalog } from '../../brain/src/catalog';
import type { ActivityDefinition } from '../../brain/src/contracts';
import { smithOrderFromEnv } from '../../workers/src/bank-artisan/smithing';
import { chickenCliOptions } from '../../workers/src/combat/chickens';
import { bloodOptions, chestOptions } from '../../workers/src/gather/thieving';
import { dispatchPlannedStep } from '../src/worker-dispatch';

// The planner launches a catalog activity with only the args and env that the catalog and the router give. A route's
// bench case can pass because the case names the order (PRODUCT_ID, a spell and NPC, a job file, a tick cap) while a
// catalog launch of the same route lacks it. This runs each worker's own argument check on every launch the planner can
// make of a trusted activity.
type Launch = { script: string; args: string[]; env: Record<string, string> };

function launches(act: ActivityDefinition): { tag: string; launch: Launch }[] {
    const steps: any[] = [{ stepKind: 'work', activityId: act.id, demandId: 'contract', workerId: act.workerId, batchUnits: 3, estimatedTicks: 1, expectedValuePerHour: 1, config: { ...act.config } }];
    for (const skill of act.skills ?? (act.skill ? [act.skill] : [])) {
        steps.push({ stepKind: 'unlock', unlockKind: 'skill', activityId: act.id, skill, targetLevel: 40, estimatedTicks: 1 });
    }
    return steps.map(step => {
        const { script, args, env } = dispatchPlannedStep('Contract', step, { catalog: createActivityCatalog() }).step as unknown as Launch;
        return { tag: `${act.id} ${step.stepKind}${step.skill ? ':' + step.skill : ''}`, launch: { script, args: [...args], env: { ...env } } };
    });
}

// The worker's own check for the launch, or null when this test has none for its worker.
function refusal({ script, args: a, env: e }: Launch): string | null {
    try {
        if (a[0] === 'smithing' && a[1] === 'anvil' && (e.ORDER_ACTION ?? 'smelt').toLowerCase() === 'smith') smithOrderFromEnv(Number(a[2] ?? e.CAP ?? 15000), e);
        if (a[0] === 'thieving' && a[1] === 'blood-chest') bloodOptions(a[2], e);
        if (a[0] === 'thieving' && a[1] === 'nature-chest') chestOptions(e);
        if (a[0] === 'mining' && a[1] === 'loot' && !e.LOOT_IDS && !e.LOOT_NAMES && !e.LOOT_MIN_VALUE && !e.LOOT_MODE) {
            throw Error('invalid finite ground-loot policy');
        }
        // packages/workers/src/combat/special-mobs.ts loot-trip: [account, job.json].
        if (script === 'scripts/aio-fighter.ts' && a[0] === 'loot-trip' && !a[1]) throw Error('usage: aio-fighter.ts loot-trip account job.json');
        // packages/workers/src/combat/magic.ts runNpcMagicCli: [account, spell, npc, ...].
        if (a[0] === 'magic' && a[1] === 'npc' && (!a[2] || a[3] === undefined)) throw Error('account, native spell and NPC ID required');
        // packages/workers/src/bank-artisan/magic.ts trip: the job file path.
        if (a[0] === 'magic' && a[1] === 'trip' && !a[2]) throw Error('usage: microbot-magic-trip.ts account job.json');
        if (script === 'scripts/aio-fighter.ts' && a[0] === 'chicken') chickenCliOptions(e);
        return null;
    } catch (err) {
        return String(err);
    }
}

describe('catalog launch contract', () => {
    test('every launch of a trusted activity passes its worker argument check', () => {
        const qualified = createActivityCatalog().list().filter(a => a.trust !== 'experimental');
        expect(qualified.length).toBeGreaterThan(100);
        const refused: string[] = [];
        for (const act of qualified) {
            for (const { tag, launch } of launches(act)) {
                const why = refusal(launch);
                if (why) refused.push(`${tag}: ${why} args=${JSON.stringify(launch.args)} env=${JSON.stringify(launch.env)}`);
            }
        }
        expect(refused).toEqual([]);
    });

    test('routes that need an order the catalog cannot give stay experimental', () => {
        const catalog = createActivityCatalog();
        for (const id of [
            'combat:magic-npc',
            'bank-artisan:magic-trip',
            'gather:thieving-blood-chest',
            'gather:thieving-nature-chest',
            'gather:mining-loot',
            'gather:fishing-staged',
            'gather:woodcutting-edgeville',
            'combat:chompy',
            'combat:loot-trip',
        ]) {
            const act = catalog.get(id);
            expect(act, id).toBeDefined();
            expect(act!.trust, id).toBe('experimental');
        }
        // An anvil launch needs its product: only the per-product rows, which name it, smith, and they stay trusted.
        expect(catalog.get('bank-artisan:smithing-anvil')).toBeUndefined();
        expect(catalog.get('bank-artisan:skill:smithing:bronze_dagger')?.trust).toBe('practice_passed');
        // Banked karambwanji/karambwan producers pass BANKED=1 + METHOD and stay trusted while bare fishing:staged stays experimental.
        expect(catalog.get('gather:fishing-karambwanji')?.trust).toBe('practice_passed');
        expect(catalog.get('gather:fishing-karambwan')?.trust).toBe('practice_passed');
        expect(catalog.get('gather:woodcutting-edgeville')?.config?.requiredLevel).toBe(15);
        expect(refusal({ script: 'scripts/aio-skiller.ts', args: ['smithing', 'anvil', '600'], env: { ORDER_ACTION: 'smith', PRODUCT_ID: '1205', MAX_MAKE: '1', BAR_RESERVE: '0' } })).toBeNull();
        expect(refusal({ script: 'scripts/aio-skiller.ts', args: ['smithing', 'anvil'], env: { ORDER_ACTION: 'smith', BAR_RESERVE: '0' } })).toContain('smith refused');
        expect(refusal({ script: 'scripts/aio-fighter.ts', args: ['chicken'], env: { TRAIN_SKILL: 'Defence', TARGET_LEVEL: '40' } })).toContain('explicit Strength target');
        expect(refusal({ script: 'scripts/aio-fighter.ts', args: ['chicken'], env: { TRAIN_SKILL: 'Strength', TARGET_LEVEL: '40' } })).toBeNull();
    });
});
