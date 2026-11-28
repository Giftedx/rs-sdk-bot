import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ORDER_LINES } from '../../core/src/fleet-trade-settlement';
import { isItemStackable } from '../../workers/src/bank-artisan/catalog';
import { PACK_SLOTS, PVP_COMBAT_STAGE_KIT, pvpStageReadiness, stageKitSlots } from '../../workers/src/logistics/stage-kit';
import { resolveAcquireItem, type ShopCatalogEntry } from '../src/acquire';
import { createActivityCatalog } from '../src/catalog';
import { marketCooldownKey, type AccountState, type GoalDemand, type WorldSnapshot } from '../src/contracts';
import { DemandEngine, PVP_UNLOCK_QUESTS } from '../src/demand';
import { DEFAULT_PK_CONSUMABLES, DEFAULT_PK_KIT_TARGETS, loadMissionManifests } from '../src/missions';
import { activityPreflightFromConfig } from '../src/preflight';
import { scheduleFleet } from '../src/scheduler';
import { resolveActivityWorkerRoute } from '../src/worker-routing';

const NOW = 1_800_000_000_000;

function makeAccount(overrides: Partial<AccountState> = {}): AccountState {
    return {
        name: 'TestBot',
        side: 'local',
        role: 'auto',
        protectedClock: false,
        lifecycle: 'idle',
        pos: { x: 3185, z: 3436, level: 0 },
        skills: {
            Attack: { level: 70, xp: 800_000 },
            Strength: { level: 70, xp: 800_000 },
            Defence: { level: 70, xp: 800_000 },
            Hitpoints: { level: 70, xp: 800_000 },
            Ranged: { level: 70, xp: 800_000 },
            Magic: { level: 70, xp: 800_000 },
            Prayer: { level: 43, xp: 55_000 },
            Woodcutting: { level: 50, xp: 105_000 },
            Fishing: { level: 76, xp: 1_400_000 },
            Cooking: { level: 80, xp: 2_000_000 },
            Mining: { level: 85, xp: 3_300_000 },
            Smithing: { level: 85, xp: 3_300_000 },
            Crafting: { level: 84, xp: 3_000_000 },
            Fletching: { level: 80, xp: 2_000_000 },
            Herblore: { level: 66, xp: 500_000 },
            Runecraft: { level: 44, xp: 60_000 },
        },
        quests: {
            druid: 'complete',
            runemysteries: 'complete',
            hero: 'complete',
            zanaris: 'complete',
            tbwt: 'complete',
            zombiequeen: 'complete',
        },
        inventory: {},
        equipment: {},
        bank: { items: { 995: 50_000 }, observedAt: NOW - 5_000, trusted: true },
        ...overrides,
    };
}

function makeWorld(accounts: readonly AccountState[]): WorldSnapshot {
    return {
        schemaVersion: 1,
        at: NOW,
        side: 'local',
        server: 'rs-sdk-demo.fly.dev',
        accounts: Object.fromEntries(accounts.map((a) => [a.name, a])),
    };
}

describe('PvP BiS missions and self-sustaining supply chain', () => {
    test('loadMissionManifests discovers PvP participants from real swarm.jobs account fields alongside swarm.army', () => {
        const dir = mkdtempSync(join(tmpdir(), 'brain-supply-missions-'));
        try {
            const swarm = {
                army: ['ArmyOne', 'ArmyTwo'],
                jobs: [
                    { account: 'ArmyOne', role: 'pvp' },
                    { account: 'PvpAlpha', role: 'pvp' },
                    { account: 'PvpTrainee', role: 'pk-trainee' },
                    { accounts: ['HostPvp1', 'HostPvp2'], role: 'pvp' },
                    { account: 'SkillerBot', role: 'skiller' },
                ],
            };
            writeFileSync(join(dir, 'swarm.json'), JSON.stringify(swarm));
            const missions = loadMissionManifests({ root: dir });
            const pk = missions.find((m) => m.id === 'mission:pk-squad');
            expect(pk).toBeDefined();
            expect(pk!.participants).toEqual(['ArmyOne', 'ArmyTwo', 'PvpAlpha', 'PvpTrainee', 'HostPvp1', 'HostPvp2']);
            expect(pk!.state).toBe('staging');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('default PK kit and consumables include full rev-289 BiS gear, combo food, potions, and runes', () => {
        const kitIds = new Set(DEFAULT_PK_KIT_TARGETS.map((k) => k.itemId));
        for (const id of [1333, 1231, 861, 2503, 2497, 2491, 1163, 1079, 1201, 1712, 1731, 1725, 2550, 2552, 1387, 3105]) {
            expect(kitIds.has(id)).toBe(true);
        }
        const conIds = new Set(DEFAULT_PK_CONSUMABLES.map((c) => c.itemId));
        for (const id of [385, 3144, 2434, 2436, 2440, 2442, 2444, 2448, 892, 556, 555, 557, 561, 563, 564]) {
            expect(conIds.has(id)).toBe(true);
        }
    });

    test('catalog registers self-sustaining PvP supply-chain producers and DemandEngine expands multi-hop intermediates', () => {
        const catalog = createActivityCatalog();
        const mustProduce = [
            385,  // Shark
            2503, // Black d'hide body (via black-dhide-sets)
            2497, // Black d'hide chaps
            2491, // Black d'hide vambraces
            861,  // Magic shortbow
            1513, // Magic logs
            1777, // Bow string
            892,  // Rune arrow
            44,   // Rune arrowtips
            2363, // Runite bar
            1231, // Dragon dagger(p)
            187,  // Weapon poison
            1712, // Amulet of glory(4)
            1731, // Amulet of power
            1725, // Amulet of strength
            1727, // Amulet of magic
            2550, // Ring of recoil
            555,  // Water rune
            557,  // Earth rune
            554,  // Fire rune
            564,  // Cosmic rune
            561,  // Nature rune
        ];
        const missing = mustProduce.filter(
            (itemId) => catalog.findByOutputItem(itemId).filter((a) => a.trust !== 'experimental').length === 0,
        );
        expect(missing).toEqual([]);
        // Magic log gathering must pass WOOD_GROVE=native-processing to select Seers magic trees.
        const magicWc = catalog.get('gather:woodcutting-magic')!;
        expect((magicWc.config.defaultEnv as Record<string, string>)?.WOOD_GROVE).toBe('native-processing');
        // Pack-only / at-site routes stay experimental by default and promote once bench-qualified.
        const experimentalIds = [
            'gather:mining-coal',
            'gather:mining-gold',
            'bank-artisan:tanning-black-dragonhide',
            'gather:fishing-karambwanji',
            'gather:fishing-karambwan',
            'bank-artisan:cooking-karambwan',
        ];
        for (const id of experimentalIds) {
            expect(catalog.get(id)?.trust).toBe('experimental');
        }
        const promotedCatalog = createActivityCatalog({
            benchPassedIds: new Set(experimentalIds),
        });
        for (const id of experimentalIds) {
            expect(promotedCatalog.get(id)?.trust).toBe('practice_passed');
        }

        const pvpAcct = makeAccount({
            name: 'PvpHero',
            role: 'army',
            quests: {},
            bank: { items: { 995: 100_000 }, observedAt: NOW - 5_000, trusted: true },
        });
        const world = makeWorld([pvpAcct]);
        const engine = new DemandEngine({
            catalog: promotedCatalog,
            campaigns: [],
            missions: [
                {
                    id: 'mission:pk-squad',
                    participants: ['PvpHero'],
                    state: 'staging',
                    kitTargets: [
                        { itemId: 861, itemName: 'Magic shortbow', countPerParticipant: 2, slot: 'ranged_weapon' },
                        { itemId: 2503, itemName: 'Dragonhide body', countPerParticipant: 2, slot: 'body' },
                        { itemId: 1712, itemName: 'Amulet of glory(4)', countPerParticipant: 2, slot: 'neck' },
                        { itemId: 1231, itemName: 'Dragon dagger(p)', countPerParticipant: 2, slot: 'special_weapon' },
                    ],
                    consumables: [
                        { itemId: 3144, itemName: 'Cooked karambwan', countPerParticipant: 30, minReservePerParticipant: 10 },
                        { itemId: 892, itemName: 'Rune arrow', countPerParticipant: 150, minReservePerParticipant: 50 },
                    ],
                    weight: 1.0,
                },
            ],
            goalWeights: {
                main_supply: 0,
                specialist_prep: 0,
                quest_board: 1.0,
                gear_collection: 0,
                pk_army: 1.0,
                squad_supply: 1.0,
                coin_fund: 0,
            },
        });
        const report = engine.evaluate(world, { marketQuotes: {} });
        const itemDemandIds = new Set(
            report.demands
                .filter((d) => d.target.kind === 'item')
                .map((d) => (d.target.kind === 'item' ? d.target.itemId : -1)),
        );
        // Multi-hop intermediates must be emitted (including items with slow/tiny shops).
        expect(itemDemandIds.has(1513)).toBe(true); // Magic logs (for MSB)
        expect(itemDemandIds.has(1777)).toBe(true); // Bow string (for MSB)
        expect(itemDemandIds.has(1779)).toBe(true); // Flax (for bow string)
        expect(itemDemandIds.has(1747)).toBe(true); // Black dragonhide (for Black d'hide)
        expect(itemDemandIds.has(3142)).toBe(true); // Raw karambwan
        expect(itemDemandIds.has(3150)).toBe(true); // Raw karambwanji
        expect(itemDemandIds.has(44)).toBe(true);   // Rune arrowtips
        expect(itemDemandIds.has(2363)).toBe(true); // Runite bar
        expect(itemDemandIds.has(453)).toBe(true);  // Coal
        expect(itemDemandIds.has(187)).toBe(true);  // Weapon poison

        // Per-account PvP unlock quest demands must be emitted for missing quests on army accounts.
        const pvpUnlockQuests = new Set(
            report.demands
                .filter((d) => d.sourceId === 'owner:pvp_unlock' && d.assignedAccount === 'PvpHero' && d.target.kind === 'quest')
                .map((d) => (d.target.kind === 'quest' ? d.target.questSlug : '')),
        );
        expect(pvpUnlockQuests.has('druid')).toBe(true);
        expect(pvpUnlockQuests.has('zanaris')).toBe(true);
        expect(pvpUnlockQuests.has('dragon')).toBe(true);
        expect(pvpUnlockQuests.has('death')).toBe(true);
        expect(PVP_UNLOCK_QUESTS.length).toBe(9);
    });
});

describe('Sub-5-minute login churn and preflight root-cause fixes', () => {
    const catalog = createActivityCatalog();

    test('BATCH_UNITS propagates to smithing:anvil, smithing:smelt, crafting:jewellery-trip, magic:items, crafting:tanning, fletching:native-arrows, and logistics:charge-glory', () => {
        const anvil = catalog.findByOutputItem(1333).find((a) => a.config.aioRoute === 'smithing:anvil')!;
        const anvilRoute = resolveActivityWorkerRoute(anvil, { BATCH_UNITS: '12' });
        expect(anvilRoute.env.MAX_MAKE).toBe('12');

        const smelt = catalog.findByOutputItem(2363).find((a) => a.config.aioRoute === 'smithing:smelt')!;
        const smeltRoute = resolveActivityWorkerRoute(smelt, { BATCH_UNITS: '40' });
        expect(smeltRoute.env.MAX_MAKE).toBe('40');

        const jewellery = catalog.get('bank-artisan:jewellery-sapphire_ring')!;
        const jewRoute = resolveActivityWorkerRoute(jewellery, { BATCH_UNITS: '20' });
        expect(jewRoute.env.TARGET).toBe('20');

        const enchant = catalog.get('bank-artisan:magic-enchant-sapphire_ring')!;
        const enchRoute = resolveActivityWorkerRoute(enchant, { BATCH_UNITS: '18' });
        expect(enchRoute.args[4]).toBe('18');

        const glory = catalog.get('logistics:charge-glory')!;
        const gloryRoute = resolveActivityWorkerRoute(glory, { BATCH_UNITS: '14' });
        expect(gloryRoute.env.MAX_GLORIES).toBe('14');

        const tan = catalog.get('bank-artisan:tanning-black-dragonhide')!;
        const tanRoute = resolveActivityWorkerRoute(tan, { BATCH_UNITS: '54' });
        // Pack-only tanning caps at 27 unnoted hides (+ coins slot).
        expect(tanRoute.args[3]).toBe('27');

        const arrows = catalog.get('bank-artisan:fletching-rune-arrows')!;
        const arrowRoute = resolveActivityWorkerRoute(arrows, { BATCH_UNITS: '100' });
        expect(arrowRoute.env.MAX_MAKE).toBe('105');
    });

    test('preflight blocks woodcutting-fresh45 at WC >= 45, fishing-village below Fishing 20, and ranged-camp without BLUE_KIT', () => {
        const wcHigh = makeAccount({ skills: { ...makeAccount().skills, Woodcutting: { level: 45, xp: 61_512 } } });
        const wcAct = catalog.get('gather:woodcutting-fresh45')!;
        expect(wcAct.outputs).toBeUndefined();
        const wcPre = activityPreflightFromConfig(wcHigh, wcAct, makeWorld([wcHigh]));
        expect(wcPre.ok).toBe(false);
        expect(wcPre.blockers.some((b) => b.kind === 'max_level_cap')).toBe(true);

        const fishLow = makeAccount({ skills: { ...makeAccount().skills, Fishing: { level: 15, xp: 2_500 } } });
        const fishAct = catalog.get('gather:fishing-village')!;
        const fishPre = activityPreflightFromConfig(fishLow, fishAct, makeWorld([fishLow]));
        expect(fishPre.ok).toBe(false);
        expect(fishPre.blockers.some((b) => b.kind === 'skill_level' && b.skill === 'Fishing' && b.required === 20)).toBe(true);

        const naked = makeAccount({ bank: { items: { 995: 5000 }, observedAt: NOW - 5_000, trusted: true } });
        const campAct = catalog.get('combat:ranged-camp')!;
        const campPre = activityPreflightFromConfig(naked, campAct, makeWorld([naked]));
        expect(campPre.ok).toBe(false);
        expect((campPre.missingItems ?? []).some((m) => m.itemId === 385 && m.count >= 6)).toBe(true);
    });

    test('herblore:potions preflight blocks Jatix cooldown and insufficient multi-unit batch stock', () => {
        const herbAct = catalog.get('bank-artisan:herblore-potions')!;
        const jatixCooling = makeAccount({
            skills: { ...makeAccount().skills, Herblore: { level: 45, xp: 65_000 } },
            bank: { items: { 995: 5000, 199: 20 }, observedAt: NOW - 5_000, trusted: true },
            cooldowns: { [marketCooldownKey(221, 'shop:jatix')]: NOW + 60_000 },
        });
        const coolPre = activityPreflightFromConfig(jatixCooling, herbAct, makeWorld([jatixCooling]), 1);
        expect(coolPre.ok).toBe(false);
        expect(coolPre.blockers.some((b) => b.kind === 'cooldown_active')).toBe(true);

        // Only 2 paired tarromin+limpwurt potions owned, but unlock batch needs 14 -> refused before login.
        const shortBatch = makeAccount({
            skills: { ...makeAccount().skills, Herblore: { level: 45, xp: 65_000 } },
            bank: { items: { 995: 5000, 203: 20, 225: 2 }, observedAt: NOW - 5_000, trusted: true },
        });
        const batchPre = activityPreflightFromConfig(shortBatch, herbAct, makeWorld([shortBatch]), 14);
        expect(batchPre.ok).toBe(false);
        expect((batchPre.missingItems ?? []).some((m) => m.itemId === 225)).toBe(true);
    });

    test('acquire enforces economic partial-batch floor on bulk low-value requests across shop, GE, and hub_banker', () => {
        const recip = makeAccount({ name: 'Recip', bank: { items: { 995: 50_000 }, observedAt: NOW - 5_000, trusted: true } });
        const tinyDonor = makeAccount({ name: 'TinyDonor', bank: { items: { 385: 2, 995: 5_000 }, observedAt: NOW - 5_000, trusted: true } });
        const world = makeWorld([recip, tinyDonor]);

        // Bulk shark transfer (qty 100) should NOT trigger a 2-shark trade login pair.
        const tinyHub = resolveAcquireItem(
            recip,
            { itemId: 385, quantity: 100, allowOwnBank: false, allowedSources: ['hub_banker'], allowPartial: true },
            { world },
        );
        expect(tinyHub.ok).toBe(false);

        // Bulk GE buy (qty 100) should NOT trigger a 2-shark GE login when sell depth is 2.
        const tinyGe = resolveAcquireItem(
            recip,
            { itemId: 385, quantity: 100, allowOwnBank: false, allowedSources: ['ge'], allowPartial: true },
            { world, marketQuotes: { 385: { ask: 900, sell: 2, trades: 20 } } },
        );
        expect(tinyGe.ok).toBe(false);

        // Bulk shop buy (qty 100) on a slow-restock 2-stock shop should NOT trigger a 2-item micro-buy login.
        const slowShop: ShopCatalogEntry = {
            shop: 'slow_gem',
            itemId: 385,
            cost: 500,
            stock: 2,
            restockTicks: 10_000,
            tile: { x: 3185, z: 3436, level: 0 },
        };
        const tinyShop = resolveAcquireItem(
            recip,
            { itemId: 385, quantity: 100, allowOwnBank: false, allowedSources: ['npc_shop'], allowPartial: true },
            { world, customShops: [slowShop] },
        );
        expect(tinyShop.ok).toBe(false);
    });

    test('FleetScheduler consolidates multiple holder-targeted PvP demands from the same donor while excluding untradeable and cooled-down items', () => {
        const pvp = makeAccount({
            name: 'PvpFighter',
            role: 'army',
            bank: { items: { 995: 5_000 }, observedAt: NOW - 5_000, trusted: true },
            cooldowns: {
                [marketCooldownKey(2442, 'hub_banker')]: NOW + 60_000,
                [marketCooldownKey(2448, 'hub:varrock_west')]: NOW + 60_000,
            },
        });
        const supplier = makeAccount({
            name: 'SupplyDonor',
            role: 'auto',
            bank: {
                items: {
                    995: 5_000,
                    385: 80,
                    2434: 12,
                    2436: 6,
                    2440: 6,
                    2442: 6,
                    2448: 6,
                    892: 300,
                    3150: 50, // Raw karambwanji (untradeable)
                    772: 2,   // Dramen staff (untradeable)
                },
                observedAt: NOW - 5_000,
                trusted: true,
            },
        });
        const world = makeWorld([pvp, supplier]);
        const demands: GoalDemand[] = [
            { id: 'mission:pk:385', goalKind: 'squad_supply', sourceId: 'mission:pk-squad', valueScore: 900, target: { kind: 'item', itemId: 385, itemName: 'Shark', count: 40, holder: 'PvpFighter' }, fulfilled: 0, remaining: 40, priorityWeight: 1, active: true },
            { id: 'mission:pk:2434', goalKind: 'squad_supply', sourceId: 'mission:pk-squad', valueScore: 800, target: { kind: 'item', itemId: 2434, itemName: 'Prayer potion(4)', count: 6, holder: 'PvpFighter' }, fulfilled: 0, remaining: 6, priorityWeight: 1, active: true },
            { id: 'mission:pk:2436', goalKind: 'squad_supply', sourceId: 'mission:pk-squad', valueScore: 700, target: { kind: 'item', itemId: 2436, itemName: 'Super attack(4)', count: 2, holder: 'PvpFighter' }, fulfilled: 0, remaining: 2, priorityWeight: 1, active: true },
            { id: 'mission:pk:2440', goalKind: 'squad_supply', sourceId: 'mission:pk-squad', valueScore: 650, target: { kind: 'item', itemId: 2440, itemName: 'Super strength(4)', count: 2, holder: 'PvpFighter' }, fulfilled: 0, remaining: 2, priorityWeight: 1, active: true },
            { id: 'mission:pk:2442', goalKind: 'squad_supply', sourceId: 'mission:pk-squad', valueScore: 640, target: { kind: 'item', itemId: 2442, itemName: 'Super defence(4)', count: 2, holder: 'PvpFighter' }, fulfilled: 0, remaining: 2, priorityWeight: 1, active: true },
            { id: 'mission:pk:2448', goalKind: 'squad_supply', sourceId: 'mission:pk-squad', valueScore: 630, target: { kind: 'item', itemId: 2448, itemName: 'Superantipoison(4)', count: 2, holder: 'PvpFighter' }, fulfilled: 0, remaining: 2, priorityWeight: 1, active: true },
            { id: 'mission:pk:892', goalKind: 'squad_supply', sourceId: 'mission:pk-squad', valueScore: 600, target: { kind: 'item', itemId: 892, itemName: 'Rune arrow', count: 150, holder: 'PvpFighter' }, fulfilled: 0, remaining: 150, priorityWeight: 1, active: true },
            { id: 'mission:pk:3150', goalKind: 'squad_supply', sourceId: 'mission:pk-squad', valueScore: 590, target: { kind: 'item', itemId: 3150, itemName: 'Raw karambwanji', count: 20, holder: 'PvpFighter' }, fulfilled: 0, remaining: 20, priorityWeight: 1, active: true },
            { id: 'mission:pk:772', goalKind: 'squad_supply', sourceId: 'mission:pk-squad', valueScore: 580, target: { kind: 'item', itemId: 772, itemName: 'Dramen staff', count: 1, holder: 'PvpFighter' }, fulfilled: 0, remaining: 1, priorityWeight: 1, active: true },
        ];
        const plan = scheduleFleet({
            world,
            activities: [],
            demands,
            maxBots: 10,
            logoutProofs: new Map([
                ['pvpfighter', { account: 'PvpFighter', server: 'rs-sdk-demo.fly.dev', domain: 'live' as const, attemptId: 'a1', state: 'confirmed' as const, loggedOutAt: NOW - 10_000, ownerRun: null, receiptSha256: 'a'.repeat(64) }],
                ['supplydonor', { account: 'SupplyDonor', server: 'rs-sdk-demo.fly.dev', domain: 'live' as const, attemptId: 'a2', state: 'confirmed' as const, loggedOutAt: NOW - 10_000, ownerRun: null, receiptSha256: 'b'.repeat(64) }],
            ]),
        });
        expect(plan.transferOrders.length).toBe(1);
        const order = plan.transferOrders[0]!;
        expect(order.from).toBe('SupplyDonor');
        expect(order.to).toBe('PvpFighter');
        expect(order.items.length).toBe(5);
        expect(order.items.length).toBeLessThanOrEqual(MAX_ORDER_LINES);
        const ids = new Set(order.items.map((i) => i.itemId));
        for (const id of [385, 2434, 2436, 2440, 892]) expect(ids.has(id)).toBe(true);
        // Untradeables (3150, 772) and cooled-down items (2442 hub_banker, 2448 hub:varrock_west) must be excluded.
        for (const excluded of [2442, 2448, 3150, 772]) expect(ids.has(excluded)).toBe(false);
    });

    test('pvpStageReadiness flags missing kit items and drained prayer, and PVP_COMBAT_STAGE_KIT fits inside 28 pack slots', () => {
        expect(stageKitSlots(PVP_COMBAT_STAGE_KIT, [], isItemStackable)).toBeLessThanOrEqual(PACK_SLOTS);
        const fullOwned: Record<number, number> = Object.fromEntries(PVP_COMBAT_STAGE_KIT.map((k) => [k.itemId, k.count]));
        expect(pvpStageReadiness(fullOwned, 43, 43).ready).toBe(true);
        const drained = pvpStageReadiness(fullOwned, 12, 43);
        expect(drained.ready).toBe(false);
        expect(drained.needsPrayerRestore).toBe(true);
        expect(drained.missingItems.length).toBe(0);

        const missingShark = { ...fullOwned, 385: 4 };
        const short = pvpStageReadiness(missingShark, 43, 43);
        expect(short.ready).toBe(false);
        expect(short.missingItems).toEqual([{ itemId: 385, count: 5 }]);
    });
});
