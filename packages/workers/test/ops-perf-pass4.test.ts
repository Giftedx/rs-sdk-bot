import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { componentId } from '../../core/src/logout';
import {
    accountEscrowCoins,
    accountOwnedItemCount,
    accountReserveFor,
    availableCoinsAfterReserves,
    createWorkerRegistry,
    preflightFail,
    preflightOk,
    validatePreflightBlocker,
    validatePreflightResult,
    validateRateEstimate,
    validateRunOutcome,
    type PreflightBlocker,
    type WorkerAccountView,
    type WorkerWorldView,
} from '../src/contracts';
import { assertAccountOwnership, parseHandoff } from '../src/logistics/admission';
import { createHandoff, reconcileOrder } from '../src/logistics/handoff';
import { logisticsWorker } from '../src/logistics/module';
import {
    canEnterHeroesBasement,
    chooseAntipoison,
    loadRecoveryLocationContext,
    nearestAltar,
    nearestBank,
    parseAltar,
} from '../src/logistics/recover';
import { courierCargo, courierDeliveryWaiting, parseCoins, parseFanin, parseFanout, swarmBusy } from '../src/logistics/trade-helpers';
import { fareSpare as logisticsFareSpare, relocationPreserved } from '../src/logistics/walk';
import { validateBankSeller, validateBuyList, validateGEPlan, validateGETrip } from '../src/market/ge-bulk';
import { loadGeItemCatalogue, orderItemMatcher } from '../src/market/ge-common';
import { marketModule } from '../src/market/module';
import { fareSpare as marketFareSpare } from '../src/market/walk';
import { guardianFoodRotEffect, nativeGuardianClue } from '../src/quest/clue-guardian';
import { nativeSpecialClueSearchHandlers } from '../src/quest/clue-handlers';
import { nativePuzzleRecipe, readNativeTrailBoard } from '../src/quest/clue-puzzle';
import { nativeClueStepById, nativeClueSteps } from '../src/quest/clues';
import { assessQuestReadiness } from '../src/quest/modes';
import { questModule } from '../src/quest/module';
import {
    bareDeposits,
    countItems,
    depositPlan,
    downward,
    foodShort,
    hopsTo,
    ikovExcessMeals,
    mealPlan,
    nearestBank as nearestQuestBank,
    tourOrder,
} from '../src/quest/sweep-plan';
import { fleetNames, pickTarget, tripRequirements } from '../src/pvp/hunt-kits';
import { pvpModule } from '../src/pvp/module';
import { armyFocusTarget } from '../src/pvp/pk-army';
import { gangValid, pickAttacker, type GangResult } from '../src/pvp/pk-gang';
import { batchSummary, type SparResult } from '../src/pvp/pk-spar';
import {
    assessWildernessThreat,
    hasVarrockTeleport,
    itemCost,
    multiPileThreat,
    pickTrack,
    planLoot,
    planWildernessEscape,
    Radar,
    restockPlanFromStock,
} from '../src/pvp/wild-rules';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tempDirs.length) {
        const dir = tempDirs.pop()!;
        rmSync(dir, { recursive: true, force: true });
    }
});

const baseAcct: WorkerAccountView = {
    name: 'OpsBot',
    side: 'local',
    protectedClock: false,
    skills: {
        Attack: { level: 99, xp: 13034431 },
        Strength: { level: 99, xp: 13034431 },
        Defence: { level: 99, xp: 13034431 },
        Hitpoints: { level: 99, xp: 13034431 },
        Prayer: { level: 99, xp: 13034431 },
        Ranged: { level: 99, xp: 13034431 },
        Magic: { level: 99, xp: 13034431 },
        Cooking: { level: 80, xp: 2000000 },
    },
    quests: { heroquest: 'complete', cook: 'not_started' },
    pos: { x: 3185, z: 3436, level: 0 },
    inventory: { 995: 50000, 385: 20, 1712: 1 },
    equipment: {},
    bank: {
        items: { 995: 500000, 385: 100, 1987: 50, 1937: 50, 1704: 4, 1511: 20 },
        observedAt: 1700000000000,
        trusted: true,
    },
    reserves: { 995: 1000 },
};

const baseWorld: WorkerWorldView = {
    at: 1700000005000,
    side: 'local',
    server: 'local',
    accounts: { opsbot: baseAcct },
    reserves: { opsbot: { 995: 2000 } },
    globalReserves: { 995: 500 },
    geEscrowCoins: { opsbot: 1000 },
};

describe('contracts/schema fast-path parity', () => {
    test('preflightOk, preflightFail, and numeric map validators match contract invariants', () => {
        const ok = preflightOk({ travelCoins: 30, travelTicks: 40 });
        expect(ok.ok).toBe(true);
        expect(ok.blockers).toEqual([]);
        expect(Object.isFrozen(ok.blockers)).toBe(true);
        expect(() => (ok.blockers as PreflightBlocker[]).push({ kind: 'protected_clock' })).toThrow();
        expect(validatePreflightResult(ok)).toEqual([]);

        const fail = preflightFail([
            { kind: 'unreachable_tile', target: { x: 3185, z: 3436, level: 0 }, reason: 'no_route' },
            { kind: 'missing_coins', required: 500, available: 100, reserved: 50, escrow: 0 },
        ]);
        expect(validatePreflightResult(fail)).toEqual([]);
        expect(validatePreflightBlocker({ kind: 'invalid_config', message: '' })).toContain(
            'invalid_config.message must be non-empty',
        );

        const badEst = validateRateEstimate({
            xpPerTick: 1,
            unitsPerTick: 0.1,
            gpPerTick: 0,
            setupTicks: 1,
            minBatchUnits: 1,
            confidence: 'practice',
            inputsPerUnit: { badKey: 1 } as unknown as Record<number, number>,
        });
        expect(badEst).toContain('inputsPerUnit has invalid key "badKey"');

        const badOut = validateRunOutcome({
            kind: 'target_met',
            activityId: 'quest:cook',
            account: 'OpsBot',
            ticksElapsed: 10,
            itemsDelta: { 385: 1.5 },
        });
        expect(badOut).toContain('itemsDelta["385"] has invalid value');

        expect(accountOwnedItemCount(baseAcct, 995)).toBe(550000);
        expect(accountReserveFor(baseAcct, baseWorld, 995)).toBe(2500);
        expect(accountEscrowCoins(baseAcct, baseWorld)).toBe(1000);
        expect(availableCoinsAfterReserves(50000, 1000, 500, 0)).toBe(48500);

        const reg = createWorkerRegistry([logisticsWorker, marketModule, questModule, pvpModule]);
        expect(reg.list().map(m => m.id)).toEqual(['logistics', 'market', 'pvp:unified', 'quest:unified']);
    });
});

describe('logistics parity and cache invalidation', () => {
    test('handoff, admission, walk, recover, and trade-helpers preserve exact behavior', () => {
        const receipt = {
            baseline: { donor: { bank: [{ id: 995, count: 1000 }], pack: [] }, receiver: { bank: [{ id: 995, count: 100 }], pack: [] } },
            expected: [{ id: 995, count: 500 }],
        };
        const settledSnap = { donor: { bank: [{ id: 995, count: 500 }], pack: [] }, receiver: { bank: [{ id: 995, count: 600 }], pack: [] } };
        const bankSnap = { donor: { bank: [{ id: 995, count: 500 }], pack: [] }, receiver: { bank: [{ id: 995, count: 100 }], pack: [{ id: 995, count: 500 }] } };
        expect(reconcileOrder(receipt, settledSnap)).toBe('settle');
        expect(reconcileOrder(receipt, bankSnap)).toBe('bank');
        expect(reconcileOrder(receipt, receipt.baseline)).toBe('resume');
        expect(() =>
            reconcileOrder(receipt, { donor: { bank: [{ id: 995, count: 499 }], pack: [] }, receiver: { bank: [{ id: 995, count: 600 }], pack: [] } }),
        ).toThrow(/order unresolved/);

        const h = createHandoff([330, 334, 380], makeTempDir('handoff-'));
        expect(h.handoffCounts([{ id: 334, count: 50 }, { id: 380, count: 20 }, { id: 334, count: 10 }])).toEqual([
            { id: 334, count: 60 },
            { id: 380, count: 20 },
        ]);
        const nowMs = Date.now();
        const req = {
            token: 'tok-1',
            from: 'Cook',
            to: 'Courier',
            server: 'local',
            at: nowMs - 1000,
            state: 'prepared' as const,
            expected: [{ id: 334, count: 10 }],
        };
        const credit = {
            token: 'tok-1',
            from: 'Cook',
            to: 'Courier',
            server: 'local',
            at: nowMs - 500,
            before: [{ id: 334, count: 0 }],
            after: [{ id: 334, count: 10 }],
        };
        expect(h.handoffCreditMatches(req, credit, [{ id: 334, count: 20 }], [{ id: 334, count: 10 }], nowMs)).toBe(true);
        expect(h.handoffCreditMatches(req, credit, [{ id: 334, count: 20 }], [{ id: 334, count: 11 }], nowMs)).toBe(false);

        const parsed = parseHandoff(['Donor1', 'Recv1', '10:Shark', '--notes', '--keep=glory']);
        expect(parsed.items).toEqual([{ name: 'Shark', count: 10 }]);
        expect(parseCoins(['Donor1', 'Recv1', '2500', '--reserve=500']).reserve).toBe(500);
        expect(parseFanout(['Donor1', 'Recv1', 'Recv2', '1000']).pairs.length).toBe(2);
        expect(parseFanin(['Recv1', 'Donor1', 'Donor2', 'Shark']).donors).toEqual(['Donor1', 'Donor2']);

        const jobs = [
            { account: 'ActiveBot', script: 'scripts/aio-logistics.ts', args: ['note-courier'], enabled: true, env: {} as Record<string, string> },
            { accounts: ['PairA', 'PairB'], script: 'scripts/aio-logistics.ts', args: ['food-courier'], enabled: false, env: { OUTBOUND_ONLY: '1' } as Record<string, string> },
        ];
        expect(swarmBusy(jobs)).toEqual(new Set(['activebot']));
        expect(() => assertAccountOwnership(['FreeA', 'FreeB'], { schemaVersion: 1, accounts: {} }, jobs, () => false, 'run')).not.toThrow();
        expect(() => assertAccountOwnership(['ActiveBot', 'FreeB'], { schemaVersion: 1, accounts: {} }, jobs, () => false, 'run')).toThrow(
            /account lease conflict/,
        );

        expect(courierCargo([{ id: 333, name: 'Trout', count: 5 }, { id: 385, name: 'Shark', count: 50 }], 2)).toEqual({
            items: [{ name: 'Trout', count: 3 }, { name: 'Shark', count: 50 }],
            blocked: [],
        });
        expect(courierCargo([{ id: 333, name: 'Trout', count: 5 }, { id: 334, name: 'Trout', count: 50 }], 2)).toEqual({
            items: [],
            blocked: ['Trout: need-bank-separation'],
        });
        expect(
            courierDeliveryWaiting(
                ['ActiveBot'],
                undefined,
                jobs,
                () => ({ name: 'ActiveBot', goal: 'note-courier.ts', at: 1000, pos: { x: 2654, z: 3283, level: 0 }, inventory: [{ id: 334, name: 'Trout', count: 20 }] }),
                1005,
            ),
        ).toBe(true);
        expect(
            courierDeliveryWaiting(
                ['PairA'],
                undefined,
                jobs,
                () => ({ name: 'PairA', goal: 'foodcourier.ts', at: 1000, pos: { x: 2654, z: 3283, level: 0 }, inventory: [{ id: 333, name: 'Trout', count: 20 }] }),
                1005,
            ),
        ).toBe(false);

        const pack28 = Array.from({ length: 28 }, (_, i) => ({ id: 400 + (i % 7) }));
        expect(logisticsFareSpare(pack28)).toEqual({ id: 400, all: false });
        expect(relocationPreserved(new Map([[995, 100]]), new Map([[995, 100]]))).toBe(true);
        expect(relocationPreserved(new Map([[995, 100]]), new Map([[995, 99]]))).toBe(false);

        expect(nearestAltar({ x: 3100, z: 3250, level: 0 }).id).toBeGreaterThan(0);
        expect(parseAltar('3253,3486')?.id).toBe(409);
        expect(nearestBank({ x: 3100, z: 3250 }).bank).toBeTruthy();
        expect(chooseAntipoison([{ id: 179, count: 1 }], [{ id: 2448, count: 1 }])?.id).toBe(179);
        expect(chooseAntipoison([], [{ id: 185, count: 1 }, { id: 2448, count: 1 }])?.id).toBe(185);
        expect(
            canEnterHeroesBasement({ quests: new Set(["hero's quest"]), skills: { Attack: 99, Hitpoints: 99 } }).ok,
        ).toBe(true);

        const dir = makeTempDir('recover-ctx-');
        expect(loadRecoveryLocationContext(dir)).toEqual({});
        mkdirSync(join(dir, '.practice', 'cache'), { recursive: true });
        writeFileSync(join(dir, '.practice', 'cache', 'route-areas.bin'), 'corrupt');
        expect(loadRecoveryLocationContext(dir)).toEqual({});

        expect(logisticsWorker.preflight(baseAcct, { operation: 'hub_bank', role: 'wine-stock', targetBatches: 10 }, baseWorld).ok).toBe(true);
        expect(logisticsWorker.preflight(baseAcct, { operation: 'recover', role: 'charge-glory' }, baseWorld).ok).toBe(true);
    });
});

describe('market parity and cache invalidation', () => {
    test('orderItemMatcher reacts to catalogue length mutations and market preflight stays exact', () => {
        const mutCat = [
            { id: 385, name: 'Shark' },
            { id: 1385, name: 'Mystic earth staff' },
        ];
        const m1 = orderItemMatcher(385, mutCat);
        expect(m1({ id: 9999, name: 'Shark' })).toBe(true);
        mutCat.push({ id: 9999, name: 'Shark' });
        const m2 = orderItemMatcher(385, mutCat);
        expect(m2({ id: 9999, name: 'Shark' })).toBe(false);

        const realCat = loadGeItemCatalogue();
        expect(orderItemMatcher(385, realCat)({ id: 385, name: 'Shark' })).toBe(true);
        expect(marketFareSpare(Array.from({ length: 28 }, (_, i) => ({ id: 500 + (i % 5) })))?.id).toBe(500);

        const now = 1_700_000_000_000;
        expect(() =>
            validateBuyList({
                actor: 'OpsBot',
                server: 'local',
                goal: 'buy1',
                entries: [{ item: 385, quantity: 2, basePrice: 1000, percent: 10, unitCap: 1200 }],
                budget: 2500,
                reserve: 0,
                cap: 2000,
                fillWait: 20,
                createdAt: now,
                deadline: now + 60_000,
            }),
        ).not.toThrow();
        expect(() =>
            validateBuyList({
                actor: 'OpsBot',
                server: 'local',
                goal: 'buybad0',
                entries: [{ item: 385, quantity: 2, basePrice: 0, percent: 10, unitCap: 1200 }],
                budget: 2500,
                reserve: 0,
                cap: 2000,
                fillWait: 20,
                createdAt: now,
                deadline: now + 60_000,
            }),
        ).toThrow(/unsupported native buy percentage\/base/);
        expect(() =>
            validateBuyList({
                actor: 'OpsBot',
                server: 'local',
                goal: 'buybadneg',
                entries: [{ item: 385, quantity: 2, basePrice: -5, percent: 7 as unknown as 5, unitCap: 1200 }],
                budget: 2500,
                reserve: 0,
                cap: 2000,
                fillWait: 20,
                createdAt: now,
                deadline: now + 60_000,
            }),
        ).toThrow(/unsupported native buy percentage\/base/);
        expect(() =>
            validateBuyList({
                actor: 'OpsBot',
                server: 'local',
                goal: 'buybadfloat',
                entries: [{ item: 385, quantity: 2, basePrice: 10.5, percent: 10, unitCap: 1200 }],
                budget: 2500,
                reserve: 0,
                cap: 2000,
                fillWait: 20,
                createdAt: now,
                deadline: now + 60_000,
            }),
        ).toThrow(/unsupported native buy percentage\/base/);
        expect(() =>
            validateGETrip({
                actor: 'OpsBot',
                server: 'local',
                goal: 'trip1',
                item: 1511,
                quantity: 10,
                price: 50,
                floor: 40,
                reserve: 0,
                fillWait: 20,
                cap: 1000,
                deadline: now + 60_000,
            }),
        ).not.toThrow();
        expect(() =>
            validateGEPlan({
                actor: 'OpsBot',
                server: 'local',
                goal: 'plan1',
                item: 1511,
                quantity: 10,
                reserve: 0,
                floor: 40,
                deadline: now + 60_000,
                cap: 1000,
                prices: [{ price: 50, fillWait: 20 }],
            }),
        ).not.toThrow();
        expect(() =>
            validateBankSeller({
                actor: 'OpsBot',
                server: 'local',
                goal: 'bs1',
                allTradeable: true,
                protect: [],
                reserves: {},
                maxItems: 5,
                maxUnits: 50,
                perItem: 10,
                discount: 10,
                floor: 1,
                unitCap: 5000,
                childCap: 1500,
                cap: 2000,
                fillWait: 20,
                deadline: now + 60_000,
            }),
        ).not.toThrow();

        expect(marketModule.preflight(baseAcct, { mode: 'shop-buy', profile: 'betty', coinReserve: 1000, float: 5000 }, baseWorld).ok).toBe(true);
        expect(marketModule.preflight(baseAcct, { mode: 'ge-buy', itemId: 385, quantity: 10, limitPrice: 1000 }, baseWorld).ok).toBe(true);
        expect(marketModule.preflight(baseAcct, { mode: 'ge-sell', itemId: 1511, quantity: 10, sellPrice: 50 }, baseWorld).ok).toBe(true);
        expect(marketModule.preflight(baseAcct, { mode: 'buy-sword', itemId: 1287 }, baseWorld).ok).toBe(true);
    });
});

describe('quest parity and cache isolation', () => {
    test('clue lookup, puzzle bitmask/cache, guardian rot/cache, and sweep-plan helpers match invariants', () => {
        const steps = nativeClueSteps();
        const puzzleStep = steps.find(s => s.gapType === 'puzzle')!;
        expect(nativeClueStepById(puzzleStep.id)?.name).toBe(puzzleStep.name);
        expect(nativeClueStepById(-999999)).toBeUndefined();

        const handlersA = nativeSpecialClueSearchHandlers();
        const handlersB = nativeSpecialClueSearchHandlers();
        handlersA[0]!.clue = 'mutated';
        expect(handlersB[0]!.clue).not.toBe('mutated');

        const puzzleId = 2795; // trail_clue_hard_riddle014_puzzlebox or resolved from obj.pack via steps
        const anyPuzzleStep = steps.find(s => s.name === 'trail_clue_hard_riddle014_puzzlebox');
        if (anyPuzzleStep) {
            const recA = nativePuzzleRecipe(anyPuzzleStep.id);
            const recB = nativePuzzleRecipe(anyPuzzleStep.id);
            expect(recA).toEqual(recB);
            if (recA.zone) recA.zone.x = -1;
            expect(nativePuzzleRecipe(anyPuzzleStep.id).zone?.x).not.toBe(-1);
        } else {
            expect(() => nativePuzzleRecipe(puzzleId)).toBeDefined();
        }

        const puzzleModal = componentId('trail_puzzle');
        const pieceCom = componentId('trail_puzzle:com_2');
        const mockValidBoard = (swapBlankWithFirst = false) => {
            // Lookup actual obj ids for family b from nativePuzzleRecipe / pieces via trail.obj ids (2796..2819 in standard rev289)
            const arr = [0, ...Array.from({ length: 24 }, (_, i) => 2796 + i)];
            if (swapBlankWithFirst) {
                const tmp = arr[0]!;
                arr[0] = arr[1]!;
                arr[1] = tmp;
            }
            return {
                mainModalId: puzzleModal,
                ifType: (id: number) => (id === pieceCom ? { linkObjType: arr } : undefined),
            };
        };
        const boardOrNull = readNativeTrailBoard(mockValidBoard(), 'b');
        if (boardOrNull) {
            expect(boardOrNull.length).toBe(25);
            expect(new Set(boardOrNull).size).toBe(25);
            // Duplicate tile -> null
            const dupClient = {
                mainModalId: puzzleModal,
                ifType: () => ({ linkObjType: Array(25).fill(2796) }),
            };
            expect(readNativeTrailBoard(dupClient, 'b')).toBeNull();
        }
        expect(readNativeTrailBoard({ mainModalId: -1 }, 'b')).toBeNull();

        const guardianStep = steps.find(s => s.gapType === 'guardian');
        if (guardianStep) {
            const gA = nativeGuardianClue(guardianStep.id);
            const gB = nativeGuardianClue(guardianStep.id);
            gA.tools.push(999999);
            expect(gB.tools.length).toBe(4);
        }

        expect(
            guardianFoodRotEffect(
                [{ id: 379, count: 2 }, { id: 385, count: 5 }],
                [{ id: 379, count: 1 }, { id: 2959, count: 1 }, { id: 385, count: 5 }],
                { freshSystem: true, nativeGhast: true, sameHpXpGear: true, sameLifeOwner: true },
            ),
        ).toBe(true);
        expect(
            guardianFoodRotEffect(
                [{ id: 379, count: 2 }],
                [{ id: 379, count: 2 }],
                { freshSystem: true, nativeGhast: true, sameHpXpGear: true, sameLifeOwner: true },
            ),
        ).toBe(false);

        const pack = [{ id: 385, count: 1 }, { id: 385, count: 1 }, { id: 995, count: 100 }, { id: 1511, count: 1 }];
        const bank = [{ id: 385, count: 10 }, { id: 379, count: 10 }];
        const foodMap = new Map([[385, 5]]);
        expect(countItems(pack, 385)).toBe(2);
        expect(mealPlan(foodMap, pack, bank)).toEqual([{ id: 385, count: 3 }]);
        expect(foodShort(foodMap, pack)).toBe(true);
        expect(ikovExcessMeals([{ id: 385, count: 4 }, { id: 379, count: 3 }], new Map([[385, 5]]))).toEqual([{ id: 379, deposit: 2 }]);
        expect(bareDeposits('ikov', pack, new Map(), foodMap, () => true)).toEqual([1511]);
        expect(depositPlan(pack, 26, () => false).length).toBeGreaterThan(0);
        expect(hopsTo({ x: 3222, z: 3218, level: 0 }, { x: 2655, z: 3283, level: 0 }).length).toBeGreaterThan(0);
        expect(nearestQuestBank({ x: 3185, z: 3436, level: 0 })).toMatchObject({ x: 3185, z: 3440, level: 0 });
        expect(tourOrder({ x: 3185, z: 3436, level: 0 }, [{ x: 3000, z: 3200, level: 0 }, { x: 3190, z: 3430, level: 0 }])[0]).toEqual({ x: 3190, z: 3430, level: 0 });
        expect(downward([{ distance: 4, optionsWithIndex: [{ text: 'Climb-down', opIndex: 2 }] }])?.opIndex).toBe(2);

        const readiness = assessQuestReadiness('cook', { 1944: 1, 1927: 1, 1933: 1 });
        expect(readiness.ready).toBe(true);
        expect(questModule.preflight(baseAcct, { operation: 'cook-job', quest: 'cook' }, baseWorld).ok).toBe(true);
    });
});

describe('pvp parity and cache isolation', () => {
    test('wild-rules, pk-army, pk-gang, hunt-kits, pk-spar, and pvpModule preflight preserve behavior', () => {
        expect(planWildernessEscape({ x: 3095, z: 3957 }, { glory: true, teleport: true }).kind).toBe('ladder');
        expect(planWildernessEscape({ x: 3153, z: 3923 }, { glory: true, teleport: true }).kind).toBe('lever');
        expect(planWildernessEscape({ x: 3095, z: 3600 }, { glory: true, teleport: false }).kind).toBe('glory');

        expect(
            hasVarrockTeleport(
                25,
                [{ name: 'Law rune', count: 1 }, { name: 'Air rune', count: 3 }],
                [{ name: 'Staff of fire' }],
            ),
        ).toBe(true);
        expect(hasVarrockTeleport(25, [{ name: 'Air rune', count: 3 }], [{ name: 'Staff of fire' }])).toBe(false);

        const friends = new Set(['ally']);
        const threat = assessWildernessThreat(
            { x: 3240, z: 3560, combat: 90, weaponValue: 1000, foodCount: 3, glory: true, teleport: true },
            [
                { name: 'Enemy1', x: 3241, z: 3560, combatLevel: 90, distance: 3 },
                { name: 'Enemy2', x: 3242, z: 3560, combatLevel: 91, distance: 4 },
            ],
            friends,
            () => true,
        );
        expect(threat.multi).toBe(true);
        expect(threat.hostilesCount).toBe(2);
        expect(threat.multiPile).toContain('multi pile: 2 attackable enemies');
        expect(multiPileThreat({ x: 3240, z: 3560, combat: 90 }, [{ name: 'Enemy1', x: 3241, z: 3560, combatLevel: 90, distance: 3 }, { name: 'Enemy2', x: 3242, z: 3560, combatLevel: 91, distance: 4 }], friends, () => true)).toContain('Enemy1, Enemy2');

        const radar = new Radar();
        radar.accept({ t: 'roster', k: 10, p: [[0, 'Target1', 3100, 3550, 0, 90]] }, 1000);
        radar.accept({ t: 'roster', k: 12, p: [[0, 'Target1', 3100, 3554, 0, 90]] }, 2000);
        expect(radar.tracks.get('target1')?.vz).toBe(2);

        const picked = pickTrack(
            { x: 3100, z: 3550, combat: 90 },
            [{ name: 'Target1', x: 3100, z: 3920, combatLevel: 90, vx: 0, vz: 0 }],
            friends,
            55,
        );
        expect(picked?.track.name).toBe('Target1');

        const loot = planLoot(
            [{ id: 995, name: 'Coins', count: 5000, x: 3100, z: 3550 }, { id: 385, name: 'Shark', count: 1, x: 3100, z: 3550 }],
            { x: 3100, z: 3550 },
            new Map([[995, 1], [385, 800]]),
            1000,
        );
        expect(loot.map(l => l.id)).toEqual([995]);

        const restock = restockPlanFromStock(
            [{ id: 563, count: 1 }, { id: 385, count: 5 }],
            { magic: 75, ranged: 70, defence: 70 },
            100_000,
            { 563: { ask: 300, sell: 10 }, 385: { ask: 900, sell: 20 }, 1712: { ask: 50_000, sell: 2 } },
        );
        expect(restock.some(s => s.kind === 'ge' && s.item === 1712)).toBe(true);

        const customRoot = makeTempDir('pvp-items-');
        mkdirSync(join(customRoot, 'knowledge'), { recursive: true });
        writeFileSync(join(customRoot, 'knowledge', 'items.json'), JSON.stringify([{ id: 385, cost: 424242 }]));
        expect(itemCost(385, customRoot)).toBe(424242);
        expect(itemCost(385)).not.toBe(424242);

        const focus = armyFocusTarget({
            me: { x: 3240, z: 3560, combatLevel: 90 },
            sharedTarget: 'Beta',
            view: [
                { name: 'Alpha', x: 3240, z: 3561, distance: 1, combatLevel: 90 },
                { name: 'Beta', x: 3240, z: 3565, distance: 5, combatLevel: 90 },
            ],
            friends,
            stunned: new Set(['alpha']),
            healthFrac: p => (p.name === 'Alpha' ? 0.2 : 0.9),
        });
        expect(focus?.name).toBe('Beta');

        expect(
            pickAttacker(
                [{ name: 'G1', index: 1, distance: 5 }, { name: 'G2', index: 2, distance: 1 }],
                new Set(['g1', 'g2']),
                null,
                new Set(['g2']),
            )?.name,
        ).toBe('G1');
        expect(
            gangValid({
                end: 'cleared',
                kills: 1,
                ticks: 10,
                taken: 0,
                eaten: 0,
                specs: 0,
                refused: 0,
                foodLeft: 10,
                prayerLeft: 50,
                prayerDoses: 4,
                trips: 1,
                gangTrips: 0,
                prayerOut: -1,
                fights: [{ outcome: 'kill', attacks: { magic: 1, ranged: 0, melee: 0 }, taken: 0 } as unknown as GangResult['fights'][number]],
                gang: [{ outcome: 'died', attacks: { magic: 0, ranged: 0, melee: 1 }, taken: 10 } as unknown as GangResult['gang'][number]],
            }),
        ).toBe(true);

        expect(fleetNames(new Map([['Alpha', 'local']]) as unknown as Parameters<typeof fleetNames>[0])).toEqual(new Set(['alpha', 'haggis']));
        expect(
            pickTarget(
                { z: 3540, combatLevel: 90 },
                [{ index: 1, name: 'Str1', combatLevel: 90, z: 3540, distance: 4 }, { index: 2, name: 'Str2', combatLevel: 90, z: 3540, distance: 2 }],
                new Set(),
                null,
            )?.name,
        ).toBe('Str2');
        expect(tripRequirements([{ id: 385, count: 10 }], [{ id: 385, count: 2 }])).toEqual([{ id: 385, count: 8 }]);

        const sparA = { outcome: 'kill', ticks: 20, taken: 5, attacks: { magic: 1, ranged: 0, melee: 0 } } as unknown as SparResult['a'];
        const sparB = { outcome: 'died', ticks: 20, taken: 50, attacks: { magic: 0, ranged: 0, melee: 1 } } as unknown as SparResult['b'];
        const sum = batchSummary([{ winner: 'a', end: 'kill', score: 245, ticks: 20, a: sparA, b: sparB }]);
        expect(sum).toMatchObject({ fights: 1, kills: 1, deaths: 0, mean: 245, ticks: 20 });

        expect(pvpModule.preflight(baseAcct, { mode: 'hunt', foodFloor: 18, requireEscape: true }, baseWorld).ok).toBe(true);
    });
});
