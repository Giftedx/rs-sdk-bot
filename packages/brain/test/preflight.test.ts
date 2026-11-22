import { expect, test } from 'bun:test';
import type { World } from '../../core/src/world';
import type { AccountState, WorldSnapshot } from '../src/contracts';
import {
    activityPreflightFromConfig,
    availableSpendableCoins,
    availableStockAfterReserves,
    canWearItem,
    evaluateCombatSurvivability,
    evaluatePreflight,
    evaluateTileReachability,
} from '../src/preflight';

const NOW = 1_700_000_000_000;

function makeAcct(overrides: Partial<AccountState> = {}): AccountState {
    return {
        name: 'Packhorse',
        side: 'local',
        role: 'helper',
        protectedClock: false,
        lifecycle: 'idle',
        skills: {
            Attack: { level: 60, xp: 280_000 },
            Strength: { level: 65, xp: 450_000 },
            Defence: { level: 50, xp: 105_000 },
            Hitpoints: { level: 60, xp: 280_000 },
            Ranged: { level: 50, xp: 105_000 },
            Magic: { level: 55, xp: 170_000 },
            Prayer: { level: 43, xp: 51_000 },
            Fishing: { level: 76, xp: 1_350_000 },
        },
        quests: {
            cook: 'complete',
            'Dragon Slayer': 'complete',
        },
        pos: { x: 3185, z: 3436, level: 0 },
        inventory: { 995: 5000, 385: 5 },
        equipment: { 1333: 1 },
        bank: {
            items: { 995: 20_000, 385: 50, 379: 30 },
            observedAt: NOW - 60_000,
            trusted: true,
        },
        ...overrides,
    };
}

function makeWorld(acct: AccountState, overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
    return {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: { [acct.name]: acct },
        ...overrides,
    };
}

test('reserve-adjusted stock and untrusted bank invariants', () => {
    const acct = makeAcct({
        reserves: { 385: 10 },
    });
    const world = makeWorld(acct, {
        reserves: { packhorse: { 385: 15 } },
        globalReserves: { 385: 5 },
    });

    // Owned sharks: 5 inv + 50 bank = 55; effective reserve = max(10, 15) + 5 = 20 -> 35 available.
    const trusted = availableStockAfterReserves(acct, world, 385);
    expect(trusted).toEqual({ owned: 55, reserved: 20, available: 35 });

    // Untrusted bank excludes bank sharks (50), leaving only 5 inventory sharks vs 20 reserve -> 0 available.
    const untrustedAcct = makeAcct({
        reserves: { 385: 10 },
        bank: { items: { 385: 50 }, observedAt: NOW - 10_000, trusted: false },
    });
    const untrusted = availableStockAfterReserves(untrustedAcct, world, 385);
    expect(untrusted).toEqual({ owned: 5, reserved: 20, available: 0 });
});

test('GE escrow, reserve, operating float, and ferry fare coin math', () => {
    const acct = makeAcct({
        inventory: { 995: 2000 },
        bank: { items: { 995: 8000 }, observedAt: NOW - 5000, trusted: true },
        reserves: { 995: 3000 },
    });
    const world = makeWorld(acct, {
        geEscrowCoins: { Packhorse: 4000 },
    });

    // Total 10,000 - 3,000 reserve - 4,000 escrow = 3,000 totalUnreserved; minus 1,000 float = 2,000 spendable.
    const bal = availableSpendableCoins(acct, world, 1000);
    expect(bal.owned).toBe(10_000);
    expect(bal.reserved).toBe(3000);
    expect(bal.escrow).toBe(4000);
    expect(bal.totalUnreserved).toBe(3000);
    expect(bal.spendable).toBe(2000);

    // Purchasing 2500 fails while preserving 1000 gp float.
    const failPurchase = evaluatePreflight(acct, { coinsRequired: 2500, operatingCoinFloat: 1000 }, world);
    expect(failPurchase.ok).toBe(false);
    expect(failPurchase.blockers[0]?.kind).toBe('missing_coins');

    // Purchasing 1500 succeeds and still covers a 30 gp Karamja ferry fare from the float.
    const karamjaOk = evaluatePreflight(
        acct,
        {
            coinsRequired: 1500,
            operatingCoinFloat: 1000,
            targetTile: { x: 2918, z: 3176, level: 0 },
        },
        world,
    );
    expect(karamjaOk.ok).toBe(true);
    expect(karamjaOk.travelCoins).toBe(30);
});

test('wearable skill/quest gates and rev-289 requirement fixes', () => {
    const midAcct = makeAcct({
        skills: { Attack: { level: 35, xp: 25_000 }, Defence: { level: 45, xp: 65_000 } },
        quests: {},
    });

    // Rune scimitar (1333) needs Attack 40.
    const runeScim = canWearItem(midAcct, 1333);
    expect(runeScim.ok).toBe(false);
    expect(runeScim.missingSkills.attack).toBe(40);

    // Rune platebody (1127) needs Defence 40 + Dragon Slayer.
    const runePlate = canWearItem(midAcct, 1127);
    expect(runePlate.ok).toBe(false);
    expect(runePlate.missingQuest).toBe('Dragon Slayer');

    // Berserker helm (3751) has rev-289 fix: Defence 45 + The Fremennik Trials.
    const zerk = canWearItem(midAcct, 3751);
    expect(zerk.ok).toBe(false);
    expect(zerk.missingQuest).toBe('The Fremennik Trials');

    const unlocked = makeAcct({
        skills: { Attack: { level: 60, xp: 280_000 }, Defence: { level: 45, xp: 65_000 } },
        quests: { dragon: 'complete', viking: 'complete' },
    });
    expect(canWearItem(unlocked, 1333).ok).toBe(true);
    expect(canWearItem(unlocked, 1127).ok).toBe(true);
    expect(canWearItem(unlocked, 3751).ok).toBe(true);
});

test('tile reachability uses World.route when present and enforces offline restrictions', () => {
    const acct = makeAcct();
    const mockWorldGraph: World = {
        blockedDoors: () => [],
        route: (_from, to, wAcct) => {
            if ((wAcct.coins ?? 0) < 30) return { ok: false, reason: 'no_route' };
            return {
                ok: true,
                cost: 42,
                legs: [
                    { kind: 'walk', to: { x: 3028, z: 3216, level: 0 } },
                    {
                        kind: 'travel',
                        at: { x: 3028, z: 3216, level: 0 },
                        to,
                        travel: {
                            id: 'npc:captain_tobias:karamja',
                            kind: 'boat',
                            name: 'Captain Tobias to Karamja',
                            from: { x: 3028, z: 3216, level: 0 },
                            to,
                            coins: 30,
                            needs: [],
                            runes: [],
                            run: { how: 'npc', npc: 'Captain Tobias', op: 1, options: ['Yes please.'] },
                            cost: 40,
                        },
                    },
                ],
            };
        },
    };
    const worldWithGraph = makeWorld(acct, { world: mockWorldGraph });
    const reach = evaluateTileReachability(acct, { x: 2918, z: 3176, level: 0 }, worldWithGraph);
    expect(reach.reachable).toBe(true);
    expect(reach.travelCoins).toBe(30);
    expect(reach.travelTicks).toBe(42);

    // Offline checks: unknown position & Entrana weapon restriction.
    const noPos = makeAcct({ pos: null });
    const unknown = evaluateTileReachability(noPos, { x: 3185, z: 3436, level: 0 }, makeWorld(noPos));
    expect(unknown.reachable).toBe(false);
    expect(unknown.reason).toBe('unknown_pos');

    const entranaBlocked = evaluateTileReachability(acct, { x: 2834, z: 3335, level: 0 }, makeWorld(acct));
    expect(entranaBlocked.reachable).toBe(false);
    expect(entranaBlocked.reason).toBe('no_route');
});

test('combat survivability floors, maxLevels, cooldowns, capacity, and protectedClock', () => {
    const lowAcct = makeAcct({
        protectedClock: true,
        maxLevels: { Defence: 1 },
        skills: { Defence: { level: 1, xp: 0 }, Hitpoints: { level: 25, xp: 8000 }, Prayer: { level: 10, xp: 1200 } },
        inventory: { 385: 1 },
        bank: { items: {}, observedAt: NOW - 1000, trusted: true },
        cooldowns: { '385:ge': NOW + 60_000 },
    });
    const world = makeWorld(lowAcct, {
        spotOccupancy: { 'kbd-lair': 2 },
    });

    const survBlockers = evaluateCombatSurvivability(
        lowAcct,
        {
            minDefence: 40,
            minHitpoints: 50,
            minFoodHeal: 100,
            requireProtectionPrayer: true,
            requireAntiDragonShield: true,
            requireAntipoison: true,
        },
        world,
    );
    expect(survBlockers.map((b) => b.reason)).toEqual(['defence', 'hitpoints', 'protection', 'protection', 'protection', 'food']);

    const fullPre = evaluatePreflight(
        lowAcct,
        {
            protectedAllowed: false,
            trainingSkills: ['Defence'],
            cooldownKeys: ['385:ge'],
            spotId: 'kbd-lair',
            maxConcurrentAccounts: 2,
        },
        world,
    );
    expect(fullPre.ok).toBe(false);
    expect(fullPre.blockers.map((b) => b.kind)).toEqual([
        'protected_clock',
        'cooldown_active',
        'capacity_full',
        'max_level_cap',
    ]);

    const actPre = activityPreflightFromConfig(
        makeAcct(),
        {
            id: 'gather:fishing-shark',
            skill: 'Fishing',
            config: { requiredLevel: 80 },
            location: { x: 2835, z: 3432, level: 0 },
        },
        world,
    );
    expect(actPre.ok).toBe(false);
    expect(actPre.blockers[0]).toMatchObject({ kind: 'skill_level', skill: 'Fishing', required: 80, current: 76 });
});
