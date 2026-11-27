import { describe, expect, test } from 'bun:test';
import type { AccountState, ActivityDefinition, GoalDemand, WorldSnapshot } from '../src/contracts';
import { COMBAT_FLOOR_EXEMPT_TARGETS, createActivityCatalog } from '../src/catalog';
import { planAccount, xpForLevel } from '../src/planner';
import { activityPreflightFromConfig } from '../src/preflight';

// Hitpoints rises only in a fight. Every account from 10 Hitpoints up must have a fight that the combat floors and the
// admission (packages/core/src/combat-admission.ts) allow, or a Hitpoints gate idles it for ever
// (missing_skill_unlock:Hitpoints).

const NOW = 1_800_000_000_000;
const OUTPUT_ITEM = 99_999;
const catalog = createActivityCatalog().list();
const lv = (n: number) => ({ level: n, xp: xpForLevel(n) });

function account(hp: number, defence: number): AccountState {
    const melee = Math.max(1, hp - 10);
    return {
        name: 'HpProbe',
        side: 'local',
        role: 'auto',
        protectedClock: false,
        lifecycle: 'idle',
        skills: { Attack: lv(melee), Strength: lv(melee), Defence: lv(defence), Hitpoints: lv(hp) },
        quests: {},
        pos: { x: 3185, z: 3436, level: 0 },
        inventory: { 995: 20_000 },
        equipment: { 1323: 1 },
        bank: { items: { 995: 200_000 }, observedAt: NOW - 1000, trusted: true },
    };
}

// Work that needs 3 Hitpoints more than the account has: the plan must unlock Hitpoints first.
function hitpointsGated(hp: number): ActivityDefinition {
    return {
        id: 'combat:hp-gated',
        workerId: 'combat',
        family: 'combat',
        kind: 'train',
        label: 'Work behind a Hitpoints gate',
        skill: 'Attack',
        location: { x: 3185, z: 3436, level: 0 },
        config: { requiredSkills: { Hitpoints: hp + 3 } },
        baselineRate: { xpPerTick: 10, unitsPerTick: 0.1, gpPerTick: 5, setupTicks: 10, minBatchUnits: 1, confidence: 'live' },
        outputs: [{ itemId: OUTPUT_ITEM, countPerUnit: 1 }],
        trust: 'live_proven',
    };
}

const demand: GoalDemand = {
    id: 'demand:hp-gated',
    goalKind: 'pk_army',
    valueScore: 100,
    valuePerHour: 1000,
    target: { kind: 'item', itemId: OUTPUT_ITEM, itemName: 'gated output', count: 5 },
    fulfilled: 0,
    remaining: 5,
    priorityWeight: 1,
    active: true,
};

function hitpointsUnlock(hp: number, defence: number, excludedActivityIds?: ReadonlySet<string>) {
    const acct = account(hp, defence);
    const world: WorldSnapshot = { schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { HpProbe: acct } };
    const plan = planAccount(acct, {
        world,
        activities: [...catalog, hitpointsGated(hp)],
        demands: [demand],
        ...(excludedActivityIds ? { excludedActivityIds } : {}),
    });
    const unlock = plan.steps.find((s) => s.stepKind === 'unlock' && s.unlockKind === 'skill' && s.skill === 'Hitpoints');
    const act = unlock && 'activityId' in unlock ? catalog.find((a) => a.id === unlock.activityId) : undefined;
    return { acct, world, plan, unlock, act };
}

// Each profile: base Hitpoints from 10 up; Defence 1 (a pure Attack or Strength account) or Defence at Hitpoints.
const PROFILES: { hp: number; defence: number }[] = [];
for (let hp = 10; hp <= 96; hp++) {
    PROFILES.push({ hp, defence: 1 });
    PROFILES.push({ hp, defence: Math.min(hp, 99) });
}

describe('every account has a fight that raises Hitpoints', () => {
    test('from 10 Hitpoints up the planner unlocks Hitpoints on a combat target that the floors admit', () => {
        const failed: string[] = [];
        for (const { hp, defence } of PROFILES) {
            const { acct, world, plan, unlock, act } = hitpointsUnlock(hp, defence);
            if (!unlock || !act || act.family !== 'combat') {
                failed.push(`HP ${hp} Def ${defence}: ${plan.idleReason ?? plan.steps.map((s) => s.stepKind).join('>')}`);
                continue;
            }
            // The fight is open to the account, or only short of the food that an earlier step of the plan buys.
            const pre = activityPreflightFromConfig(acct, act, world, 1);
            const unstaged = pre.blockers.filter((b) => !(b.kind === 'combat_survivability' && b.reason === 'food'));
            if (unstaged.length > 0) failed.push(`HP ${hp} Def ${defence}: ${act.id} ${unstaged.map((b) => b.message).join('; ')}`);
            if (pre.blockers.length > 0 && plan.steps[0]?.stepKind !== 'acquire') failed.push(`HP ${hp} Def ${defence}: ${act.id} food not staged`);
        }
        expect(failed).toEqual([]);
    });

    // A run of faults can hold every target that needs no food (cows, imps, chompies, the Ranged camps). An account
    // with the Hitpoints for a food floor then fights a floored target with its food bought first.
    test('with the food-free targets held, an account at 20 Hitpoints or more fights a floored target with staged food', () => {
        const held = new Set(catalog.filter((a) => a.family === 'combat' && COMBAT_FLOOR_EXEMPT_TARGETS.has(a.id.replace(/^combat:/, ''))).map((a) => a.id));
        expect(held.has('combat:cow')).toBe(true);
        const failed: string[] = [];
        for (const { hp, defence } of PROFILES.filter((p) => p.hp >= 20)) {
            const { plan, unlock, act } = hitpointsUnlock(hp, defence, held);
            if (!unlock || !act || held.has(act.id)) {
                failed.push(`HP ${hp} Def ${defence}: ${plan.idleReason ?? plan.steps.map((s) => s.stepKind).join('>')}`);
                continue;
            }
            expect(act.config?.combatSurvivability).toBeDefined();
            if (plan.steps[0]?.stepKind !== 'acquire') failed.push(`HP ${hp} Def ${defence}: ${act.id} food not staged`);
        }
        expect(failed).toEqual([]);
    });

    test('a target whose floor the account fails is no Hitpoints unlock, also with food', () => {
        // Druids, unicorns and wizards need 20 Hitpoints; the giants need 25. With the food-free targets held a
        // 12-Hitpoints account has no admitted fight, and the planner names the gate.
        const held = new Set(catalog.filter((a) => a.family === 'combat' && COMBAT_FLOOR_EXEMPT_TARGETS.has(a.id.replace(/^combat:/, ''))).map((a) => a.id));
        const { plan, unlock } = hitpointsUnlock(12, 1, held);
        expect(unlock).toBeUndefined();
        expect(plan.idleReason).toBe('missing_skill_unlock:Hitpoints');
    });
});
