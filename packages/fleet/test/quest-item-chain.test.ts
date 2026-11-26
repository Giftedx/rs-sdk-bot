import { expect, test } from 'bun:test';
import { benchCases } from '../../../scripts/measure/aio-bench-cases';
import type { AccountState, WorldSnapshot } from '../../brain/src/contracts';
import { createActivityCatalog } from '../../brain/src/catalog';
import { planAccount, xpForLevel } from '../../brain/src/planner';
import { dispatchAccountPlan } from '../src/worker-dispatch';

// The hosted case extra:chain-squire-smelt-bars runs the chain.ts command that the swarm builds for this plan: a
// Knight's Sword account with the pie, the pickaxe and 8 iron ore banked and no iron bars.
test('the swarm command for a quest that lacks a bank-only item smelts it, then runs the quest sweep', () => {
    const now = 1_700_000_000_000;
    const catalog = createActivityCatalog();
    const lv = (n: number) => ({ level: n, xp: xpForLevel(n) });
    const acct: AccountState = {
        name: 'QuestBot',
        side: 'local',
        role: 'auto',
        protectedClock: false,
        lifecycle: 'idle',
        skills: { Attack: lv(20), Strength: lv(20), Defence: lv(20), Hitpoints: lv(20), Mining: lv(20), Smithing: lv(20) },
        quests: {},
        pos: { x: 2946, z: 3368, level: 0 },
        inventory: {},
        equipment: {},
        bank: { items: { 995: 200_000, 2325: 1, 1275: 1, 440: 10 }, observedAt: now - 10_000, trusted: true },
    };
    const world: WorldSnapshot = { schemaVersion: 1, at: now, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { QuestBot: acct } };
    const plan = planAccount(acct, {
        world,
        activities: catalog.list(),
        marketQuotes: {},
        demands: [{
            id: 'goal:quest_board:squire', goalKind: 'quest_board', valueScore: 300, valuePerHour: 1000,
            target: { kind: 'quest', questSlug: 'squire' }, fulfilled: 0, remaining: 1, priorityWeight: 1, active: true,
        }],
    });
    expect(plan.steps.map((s) => `${s.stepKind}:${'activityId' in s ? s.activityId : ''}`)).toEqual([
        'acquire:bank-artisan:skill:smelting.struct:smelting_iron_bar',
        'work:quest:squire',
    ]);
    const dispatched = dispatchAccountPlan(plan, { catalog });
    expect(dispatched.combinedStep?.script).toBe('scripts/chain.ts');
    const bench = benchCases().find((c) => c.key === 'extra:chain-squire-smelt-bars');
    expect(bench?.script).toBe('scripts/chain.ts');
    expect(dispatched.combinedStep?.args).toEqual(bench?.scriptArgs);
});
