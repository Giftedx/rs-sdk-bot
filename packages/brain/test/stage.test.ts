import { describe, expect, test } from 'bun:test';
import type { AccountState, GoalDemand, WorldSnapshot } from '../src/contracts';
import { createActivityCatalog } from '../src/catalog';
import { planAccount, xpForLevel } from '../src/planner';
import { stageForStart } from '../src/stage';
import { resolvePlannedStepWorkerRoute } from '../src/worker-routing';

// A route that runs only in place (imps at the Ardougne south bank, the trawler at the Port Khazard dock) gets a stage
// step in front of its work: the account becomes eligible instead of refused.

const NOW = 1_800_000_000_000;
const catalog = createActivityCatalog().list();
const byId = (id: string) => catalog.find((a) => a.id === id)!;
const lv = (n: number) => ({ level: n, xp: xpForLevel(n) });

function account(o: { pos?: { x: number; z: number }; inventory?: Record<number, number>; bank?: Record<number, number>; fishing?: number } = {}): AccountState {
    return {
        name: 'StageProbe',
        side: 'local',
        role: 'auto',
        protectedClock: false,
        lifecycle: 'idle',
        skills: { Attack: lv(40), Strength: lv(40), Defence: lv(40), Hitpoints: lv(40), Fishing: lv(o.fishing ?? 20), Crafting: lv(10) },
        quests: {},
        pos: { ...(o.pos ?? { x: 2618, z: 3332 }), level: 0 },
        inventory: { 995: 5_000, ...o.inventory },
        equipment: { 1323: 1 },
        bank: { items: { 995: 50_000, ...o.bank }, observedAt: NOW - 1000, trusted: true },
    };
}

const demand = (itemId: number): GoalDemand => ({
    id: `demand:stage:${itemId}`,
    goalKind: 'main_supply',
    valueScore: 100,
    valuePerHour: 1000,
    target: { kind: 'item', itemId, count: 1 },
    fulfilled: 0,
    remaining: 1,
    priorityWeight: 1,
    active: true,
});

function plan(acct: AccountState, activityId: string, itemId: number) {
    const world: WorldSnapshot = { schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { StageProbe: acct } };
    return planAccount(acct, { world, activities: [byId(activityId)], demands: [demand(itemId)] });
}

describe('stageForStart', () => {
    test('an account away from the imp bank with trout in its bank gets a stage step', () => {
        const r = stageForStart(account({ bank: { 333: 10 } }), byId('combat:imp'))!;
        expect(r.step).toMatchObject({ stepKind: 'recover', recoveryKind: 'stage', targetTile: { x: 2655, z: 3283, level: 0 }, kit: [{ itemId: 333, count: 2 }] });
        expect(r.staged.pos).toEqual({ x: 2655, z: 3283, level: 0 });
        expect(r.staged.inventory[333]).toBe(2);
        expect(r.staged.bank.items[333]).toBe(8);
    });

    test('an account staged in place needs no step; a bank without the kit gives none', () => {
        expect(stageForStart(account({ pos: { x: 2655, z: 3283 }, inventory: { 333: 2 } }), byId('combat:imp'))).toBeUndefined();
        expect(stageForStart(account({ bank: { 333: 1 } }), byId('combat:imp'))).toBeUndefined();
        expect(stageForStart(account({ bank: { 333: 10 } }), byId('combat:cow'))).toBeUndefined();
    });

    test('a full pack deposits what the route does not keep, then takes the kit', () => {
        // Coins, 16 bronze daggers, a stack of swamp paste and 10 ropes (one slot each) fill 28 slots; the bucket
        // needs one more, so the stage deposits the daggers.
        const full = account({ inventory: { 1205: 16, 1941: 100, 954: 10 }, bank: { 583: 1 } });
        const r = stageForStart(full, byId('combat:boss-trawler'))!;
        expect(r.step.keep).toEqual([583, 954, 995, 1941]);
        expect(r.staged.inventory).toEqual({ 995: 5_000, 1941: 100, 954: 10, 583: 1 });
        expect(r.staged.bank.items[1205]).toBe(16);
        expect(resolvePlannedStepWorkerRoute('StageProbe', r.step).env.STAGE_KEEP).toBe('583,954,995,1941');
        const room = account({ inventory: { 1205: 15, 1941: 100, 954: 10 }, bank: { 583: 1 } });
        const fits = stageForStart(room, byId('combat:boss-trawler'))!;
        expect(fits.step.keep).toBeUndefined();
        expect(fits.staged.inventory[1205]).toBe(15);
    });

    test('a reserve keeps only its count: the surplus copies go to the bank', () => {
        const reserved = { ...account({ inventory: { 1205: 16, 1941: 100, 954: 10 }, bank: { 583: 1 } }), reserves: { 1205: 1 } };
        const r = stageForStart(reserved, byId('combat:boss-trawler'))!;
        expect(r.step.keepCounts).toEqual([{ itemId: 1205, count: 1 }]);
        expect(r.staged.inventory[1205]).toBe(1);
        expect(r.staged.bank.items[1205]).toBe(15);
        expect(resolvePlannedStepWorkerRoute('StageProbe', r.step).env.STAGE_KEEP).toBe('583,954,995,1941,1205:1');
    });

    test('a pack whose kept items leave no room for the kit gives no step', () => {
        const reserved = { ...account({ inventory: { 1205: 16, 1941: 100, 954: 10 }, bank: { 583: 1 } }), reserves: { 1205: 16 } };
        expect(stageForStart(reserved, byId('combat:boss-trawler'))).toBeUndefined();
    });
});

describe('the planner chains the stage step in front of the work', () => {
    test('imps: stage, then the hunt; the stage step walks with the trout kit', () => {
        const p = plan(account({ bank: { 333: 10 } }), 'combat:imp', 1472);
        expect(p.steps.map((s) => s.stepKind)).toEqual(['recover', 'work']);
        const route = resolvePlannedStepWorkerRoute('StageProbe', p.steps[0]!);
        expect(route.args.slice(0, 4)).toEqual(['walk-to', '2655', '3283', '0']);
        expect(route.env.STAGE_KIT).toBe('333:2');
    });

    test('imps without trout anywhere stay refused', () => {
        expect(plan(account(), 'combat:imp', 1472).steps.some((s) => s.stepKind === 'recover')).toBe(false);
    });

    test('the trawler stage walks to the dock with its whole kit', () => {
        const s = stageForStart(account({ bank: { 1941: 100, 954: 10, 583: 1 } }), byId('combat:boss-trawler'))!;
        expect(s.step.targetTile).toEqual({ x: 2675, z: 3170, level: 0 });
        expect(s.step.kit).toEqual([{ itemId: 1941, count: 100 }, { itemId: 954, count: 10 }, { itemId: 583, count: 1 }]);
        expect(resolvePlannedStepWorkerRoute('StageProbe', s.step).env.STAGE_KIT).toBe('1941:100,954:10,583:1');
    });
});
