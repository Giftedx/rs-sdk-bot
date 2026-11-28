import { describe, expect, test } from 'bun:test';
import {
    CHARGED_GLORY_ID,
    DHIDE_TIERS,
    FOUNTAIN_OF_HEROES,
    GRINDABLE_SECONDARIES,
    PESTLE_AND_MORTAR,
    PVP_DECANT_FAMILIES,
    PVP_FLETCH_RECIPES,
    PVP_JEWELLERY_PIPELINES,
    PVP_POTION_KEYS,
    RECIPES,
    RUNE_PVP_SMITH_PRODUCTS,
    UNCHARGED_GLORY_IDS,
    decantInventoryPotions,
    dhideSetPlan,
    effectiveSecondaryCount,
    itemMagicRecipe,
    planDecantPair,
    planMagicShortbowBatch,
    planPvpJewelleryChain,
    planRuneArrowBatch,
    rechargeGloriesAtFountain,
    runCookFood,
    runItemMagic,
    selectTanChunk,
    shopBuyChunk,
    smithBatchClickOption,
    smithMultiEffect,
    smithRecipe,
    tanInventory,
    tanningBatchEffect,
    tanningRecipes,
} from '../src/bank-artisan';
import {
    HEROES_RUNITE_ROCKS,
    LAVA_MAZE_RUNITE_ROCKS,
    MINING_SITES,
    RUNITE_ROCK_IDS,
    SHARK_TRAVEL_FOOD_IDS,
    escortInterceptDecision,
    escortProvokedByThreat,
    runiteDepletionAction,
    selectAvailableRuniteRock,
} from '../src/gather';
import {
    LAW_ALTAR,
    NATURE_ALTAR,
    PVP_RUNE_ALTARS,
    ZANARIS_BANK,
    chooseRuneAltar,
    entranaContraband,
    nearestBankForAltar,
    ruinTarget,
} from '../src/runecraft';

describe('Sharks & cooking zero-waste behavior', () => {
    test('shark travel food list includes sharks, swordfish, lobsters, salmon, and trout', () => {
        expect(SHARK_TRAVEL_FOOD_IDS).toEqual([333, 329, 379, 373, 385]);
    });

    test('runCookFood advances immediately when a raw fish burns instead of waiting for cooked count', async () => {
        let tick = 0;
        const listeners = new Set<() => void>();
        const step = () => {
            tick++;
            for (const fn of [...listeners]) fn();
        };
        const inv: { id: number; name: string; count: number; slot: number }[] = [
            { id: 383, name: 'Raw shark', count: 1, slot: 0 },
            { id: 383, name: 'Raw shark', count: 1, slot: 1 },
        ];
        const bankItems: { id: number; name: string; count: number }[] = [];
        let bankOpen = false;
        let cookCalls = 0;
        const s: any = {
            name: 'CookProbe',
            tick: () => tick,
            onTick: (fn: () => void) => {
                listeners.add(fn);
                return () => listeners.delete(fn);
            },
            ended: new Promise(() => {}),
            sdk: {
                getState: () => ({
                    player: { worldX: 2817, worldZ: 3443, level: 0, lifeId: 1, respawnCount: 0, isDead: false },
                    inventory: inv,
                    nearbyLocs: [{ id: 2728, name: 'Range', x: 2817, z: 3444, level: 0, distance: 1, options: ['Cook'], optionsWithIndex: [{ opIndex: 1, text: 'Cook' }] }],
                    bank: { isOpen: bankOpen, items: bankItems },
                    dialog: { isOpen: false },
                    gameMessages: [],
                }),
                getInventory: () => inv,
                getSkill: () => ({ level: 80, baseLevel: 80 }),
                getSkillXp: () => 2_000_000,
                findNearbyLoc: () => ({ id: 2728, name: 'Range', x: 2817, z: 3444, level: 0, distance: 1 }),
                sendUseItemOnLoc: async () => {
                    cookCalls++;
                    const rawIdx = inv.findIndex(i => i.id === 383);
                    if (rawIdx >= 0) {
                        // First raw shark burns into Burnt shark (387); second cooks into Shark (385).
                        inv[rawIdx] = cookCalls === 1
                            ? { id: 387, name: 'Burnt shark', count: 1, slot: rawIdx }
                            : { id: 385, name: 'Shark', count: 1, slot: rawIdx };
                    }
                    step();
                    return { success: true };
                },
            },
            bot: {
                openBank: async () => {
                    bankOpen = true;
                    return { success: true };
                },
                closeInterface: async () => {
                    bankOpen = false;
                    return { success: true };
                },
                depositItem: async (matcher: RegExp | string) => {
                    const re = typeof matcher === 'string' ? new RegExp(`^${matcher}$`, 'i') : matcher;
                    for (let i = inv.length - 1; i >= 0; i--) {
                        if (re.test(inv[i]!.name)) inv.splice(i, 1);
                    }
                    return { success: true };
                },
                withdrawItem: async () => ({ success: false }),
            },
        };

        const r = await runCookFood(s, 'shark', 30, () => cookCalls >= 2);
        expect(cookCalls).toBe(2);
        // Each shark finishes in 1 tick rather than stalling 10 ticks on the burnt shark.
        expect(r.ticks).toBeLessThan(8);
    });
});

describe('Runite mining safety, depletion rotation, and rune smithing', () => {
    test('Heroes Guild and Lava Maze runite rocks use verified server loc IDs and coordinates', () => {
        expect(RUNITE_ROCK_IDS).toEqual([2106, 2107]);
        expect(HEROES_RUNITE_ROCKS).toEqual([
            { id: 2107, x: 2937, z: 9882, level: 0 },
            { id: 2106, x: 2941, z: 9884, level: 0 },
        ]);
        expect(LAVA_MAZE_RUNITE_ROCKS).toEqual([
            { id: 2106, x: 3059, z: 3885, level: 0 },
            { id: 2107, x: 3060, z: 3884, level: 0 },
        ]);
        expect(MINING_SITES.some(m => m.key === 'heroes-guild-runite')).toBe(true);
    });

    test('runite rock selection and depletion action switch immediately with zero dead waiting', () => {
        const rock2106 = {
            id: 2106,
            name: 'Rocks',
            x: 2941,
            z: 9884,
            level: 0,
            distance: 3,
            options: ['Mine'],
            optionsWithIndex: [{ opIndex: 1, text: 'Mine' }],
        };
        const rocks = selectAvailableRuniteRock(
            [
                {
                    id: 451,
                    name: 'Rocks',
                    x: 2937,
                    z: 9882,
                    level: 0,
                    distance: 1,
                    options: ['Mine'],
                    optionsWithIndex: [{ opIndex: 1, text: 'Mine' }],
                },
                rock2106,
            ],
            HEROES_RUNITE_ROCKS,
        );
        expect(rocks?.id).toBe(2106);
        expect(runiteDepletionAction({ activeRock: rock2106, heldOre: 0, targetOre: 27, wilderness: false })).toEqual({
            action: 'mine',
            rock: rock2106,
        });
        expect(runiteDepletionAction({ fallbackRock: rock2106, heldOre: 0, targetOre: 27, wilderness: false })).toEqual({
            action: 'switch-rock',
            rock: rock2106,
        });
        expect(runiteDepletionAction({ heldOre: 4, targetOre: 27, wilderness: true })).toEqual({ action: 'bank' });
        expect(runiteDepletionAction({ heldOre: 0, targetOre: 27, wilderness: false })).toEqual({ action: 'rotate-or-hop' });
    });

    test('escortInterceptDecision enforces neverSkull on non-aggressors and retaliates only on attackers', () => {
        const base = {
            escortTile: [3059, 3885] as [number, number],
            escortCombat: 70,
            hasWeapon: true,
            hasFood: true,
            prayerPoints: 30,
            neverSkull: true,
            threat: { name: 'Pker', x: 3061, z: 3885, combatLevel: 65, attackingSelf: false },
        };
        const foe = { index: 12, combatTargetType: 'player', combatTargetIndex: 7 };
        expect(escortProvokedByThreat(7, 50, foe, [])).toBe(false);
        expect(escortProvokedByThreat(7, 50, foe, [{ type: 'damage_taken', sourceType: 'npc', sourceIndex: 12, targetType: 'player', tick: 49 }])).toBe(false);
        // Different player hitting the escort cannot provoke retaliation against foe #12.
        expect(escortProvokedByThreat(7, 50, foe, [{ type: 'damage_taken', sourceType: 'other_player', sourceIndex: 99, targetType: 'player', tick: 49 }])).toBe(false);
        // Foe #12 hitting an NPC cannot provoke retaliation.
        expect(escortProvokedByThreat(7, 50, foe, [{ type: 'damage_taken', sourceType: 'other_player', sourceIndex: 12, targetType: 'npc', tick: 49 }])).toBe(false);
        expect(escortProvokedByThreat(7, 50, foe, [{ type: 'damage_taken', sourceType: 'other_player', sourceIndex: 12, targetType: 'player', tick: 49 }])).toBe(true);
        // Raw faceEntity fallback also requires matching sourceIndex + recent player damage.
        expect(escortProvokedByThreat(7, 50, { index: 12, faceEntity: 32768 + 7 }, [{ type: 'damage_taken', sourceType: 'other_player', sourceIndex: 12, tick: 48 }])).toBe(true);
        expect(escortInterceptDecision(base).action).toBe('screen-retreat');
        expect(
            escortInterceptDecision({
                ...base,
                threat: { ...base.threat, attackingSelf: true },
            }).action,
        ).toBe('intercept');
    });

    test('every Rune PvP smithing product resolves in smithRecipe and batch click uses Make 1/5/10', () => {
        for (const id of Object.values(RUNE_PVP_SMITH_PRODUCTS)) {
            const recipe = smithRecipe(id);
            expect(recipe.bar).toBe(2363);
            expect(recipe.level).toBeGreaterThanOrEqual(85);
        }
        expect(smithBatchClickOption(1, 20, true)).toEqual({ option: 1, count: 1 });
        expect(smithBatchClickOption(3, 20, true)).toEqual({ option: 1, count: 1 });
        expect(smithBatchClickOption(5, 20, true)).toEqual({ option: 2, count: 5 });
        expect(smithBatchClickOption(10, 20, true)).toEqual({ option: 3, count: 10 });
        expect(smithBatchClickOption(10, 10, false)).toEqual({ option: 1, count: 1 });
        const recipe = smithRecipe(RUNE_PVP_SMITH_PRODUCTS.rune_arrowtips);
        expect(
            smithMultiEffect(
                recipe,
                [{ id: 2363, count: 10 }],
                [{ id: 2363, count: 5 }, { id: 44, count: 75 }],
                0,
                9375,
            ),
        ).toBe(5);
    });
});

describe('Herblore PvP potions, grinding, shop batching, and decanting', () => {
    test('all PvP potions including super_antipoison and weapon_poison are defined with grindable secondaries', () => {
        for (const key of PVP_POTION_KEYS) {
            expect(RECIPES[key]).toBeDefined();
        }
        expect(RECIPES.super_antipoison).toMatchObject({ level: 48, unf: 101, sec: 235, pot: 181 });
        expect(RECIPES.weapon_poison).toMatchObject({ level: 60, unf: 105, sec: 241, pot: 187 });
        expect(GRINDABLE_SECONDARIES[235]).toEqual({ raw: 237, tool: PESTLE_AND_MORTAR });
        expect(GRINDABLE_SECONDARIES[241]).toEqual({ raw: 243, tool: PESTLE_AND_MORTAR });
        expect(effectiveSecondaryCount(235, { 237: 4, 233: 1 })).toBe(4);
        expect(effectiveSecondaryCount(235, { 237: 4 })).toBe(0);
    });

    test('shopBuyChunk uses Buy 10 / Buy 5 / Buy 1 bounded by stock and affordable count', () => {
        expect(shopBuyChunk(27, 50, 27)).toBe(10);
        expect(shopBuyChunk(7, 50, 7)).toBe(5);
        expect(shopBuyChunk(4, 50, 4)).toBe(1);
        expect(shopBuyChunk(10, 6, 10)).toBe(5);
        expect(shopBuyChunk(10, 0, 10)).toBe(0);
    });

    test('planDecantPair and decantInventoryPotions merge partial PvP doses cleanly into 4-dose potions', async () => {
        expect(PVP_DECANT_FAMILIES.map(f => f.key)).toEqual([
            'prayer',
            'super_attack',
            'super_str',
            'super_def',
            'ranging',
            'antipoison',
            'super_antipoison',
        ]);
        const prayer = PVP_DECANT_FAMILIES[0]!;
        expect(planDecantPair({ 139: 2, 2434: 1 }, prayer)).toEqual({ a: 139, b: 139 });
        expect(planDecantPair({ 2434: 1, 139: 1 }, prayer)).toBeUndefined();

        let tick = 0;
        const listeners = new Set<() => void>();
        const inv = [
            { id: 139, slot: 0, count: 1 },
            { id: 139, slot: 1, count: 1 },
        ];
        const s: any = {
            tick: () => tick,
            onTick: (fn: () => void) => {
                listeners.add(fn);
                return () => listeners.delete(fn);
            },
            ended: new Promise(() => {}),
            sdk: {
                getState: () => ({}),
                getInventory: () => inv,
                sendUseItemOnItem: async (a: number, b: number) => {
                    inv[a] = { id: 2434, slot: a, count: 1 };
                    inv[b] = { id: 141, slot: b, count: 1 };
                    tick++;
                    for (const fn of [...listeners]) fn();
                    return { success: true };
                },
            },
        };
        const merged = await decantInventoryPotions(s, prayer);
        expect(merged).toBe(1);
        expect(inv.map(i => i.id)).toEqual([2434, 141]);
    });
});

describe('Runecraft PvP altars, nearest banks, and Entrana safety', () => {
    test('all PvP rune altars have nearest banks and Entrana contraband filter catches weapons/armour', () => {
        expect(LAW_ALTAR).toMatchObject({ name: 'law', rune: 563, talisman: 1458, level: 54, portal: 2472 });
        expect(NATURE_ALTAR).toMatchObject({ name: 'nature', rune: 561, talisman: 1462, level: 44, portal: 2473 });
        expect(chooseRuneAltar(54, new Set([1458]), 'law').altar?.name).toBe('law');
        expect(chooseRuneAltar(44, new Set([1462]), 'nature').altar?.name).toBe('nature');
        expect(() => chooseRuneAltar(44, new Set([1462]), 'death')).toThrow('unknown rune altar');
        expect(ruinTarget(LAW_ALTAR).q.id).toBe(2459);
        expect(ruinTarget(NATURE_ALTAR).q.id).toBe(2460);
        expect(PVP_RUNE_ALTARS.map(a => a.name)).toEqual(['air', 'water', 'earth', 'fire', 'cosmic', 'nature', 'law']);
        expect(nearestBankForAltar('water')).toEqual({ x: 3092, z: 3243, level: 0 });
        expect(nearestBankForAltar('fire')).toEqual({ x: 3269, z: 3167, level: 0 });
        expect(nearestBankForAltar('law')).toEqual({ x: 3092, z: 3243, level: 0 });
        expect(nearestBankForAltar('cosmic')).toEqual(ZANARIS_BANK);
        expect(
            entranaContraband(
                [
                    { id: 1436, name: 'Rune essence' },
                    { id: 1333, name: 'Rune scimitar' },
                    { id: 1458, name: 'Law talisman' },
                ],
                [{ id: 2503, name: "Black d'hide body" }],
            ).map(i => i.name),
        ).toEqual(['Rune scimitar', "Black d'hide body"]);
    });
});

describe('PvP jewelry, Heroes Fountain glory recharge, dhide tiers, tanning, and fletching BiS', () => {
    test('every PvP jewelry chain resolves enchant recipe and plans crafting + rune shortfalls', () => {
        for (const [key, spec] of Object.entries(PVP_JEWELLERY_PIPELINES)) {
            const enchant = itemMagicRecipe(spec.enchantMode);
            expect(enchant.product).toBe(spec.productId);
            expect(enchant.target).toBe(spec.enchantTargetId);
            const plan = planPvpJewelleryChain(
                key as keyof typeof PVP_JEWELLERY_PIPELINES,
                { [spec.enchantTargetId]: 2, 564: 10, 555: 30, 556: 30, 557: 30, 554: 30 },
                { crafting: 85, magic: 75 },
                2,
                true,
            );
            expect(plan.needCraft).toBe(0);
            expect(plan.canEnchantNow).toBe(true);
        }
    });

    test('rechargeGloriesAtFountain recharges all uncharged/partial glories in 1 tick each', async () => {
        let tick = 0;
        const listeners = new Set<() => void>();
        const step = () => {
            tick++;
            for (const fn of [...listeners]) fn();
        };
        const inv: { id: number; slot: number; count: number }[] = [
            { id: UNCHARGED_GLORY_IDS[0], slot: 0, count: 1 },
            { id: UNCHARGED_GLORY_IDS[2], slot: 1, count: 1 },
        ];
        let dialogOpen = false;
        let dialogClicks = 0;
        const s: any = {
            tick: () => tick,
            onTick: (fn: () => void) => {
                listeners.add(fn);
                return () => listeners.delete(fn);
            },
            sdk: {
                getInventory: () => inv,
                getState: () => ({
                    nearbyLocs: [{ id: FOUNTAIN_OF_HEROES.locId, name: 'Fountain of Heroes', x: FOUNTAIN_OF_HEROES.x, z: FOUNTAIN_OF_HEROES.z }],
                    dialog: { isOpen: dialogOpen },
                }),
                sendUseItemOnLoc: async (slot: number) => {
                    inv[slot] = { id: CHARGED_GLORY_ID, slot, count: 1 };
                    dialogOpen = true;
                    step();
                    return { success: true };
                },
                sendClickDialog: async () => {
                    dialogOpen = false;
                    dialogClicks++;
                    return { success: true };
                },
            },
        };
        const res = await rechargeGloriesAtFountain(s, { cap: 20 });
        expect(res).toMatchObject({ ok: true, recharged: 2, remaining: 0, ticks: 2 });
        expect(dialogClicks).toBe(2);
    });

    test('bulk tanning uses Tan-All for full pack and Tan-5 for partial >= 5', async () => {
        expect(selectTanChunk(27, 27, tanningRecipes.black)).toEqual({ button: 'tanner:com_118', qty: 27 });
        expect(selectTanChunk(10, 12, tanningRecipes.black)).toEqual({ button: 'tanner:com_120', qty: 5 });
        expect(selectTanChunk(3, 3, tanningRecipes.black)).toEqual({ button: 'tanner:com_121', qty: 1 });
        expect(tanningBatchEffect({ input: 27, output: 0, coins: 600 }, { input: 0, output: 27, coins: 60 }, 20, 27)).toBe(true);

        const items = [{ id: 1747, count: 10 }, { id: 2509, count: 0 }, { id: 995, count: 500 }];
        let clicks = 0;
        const s: any = {
            tick: () => 0,
            sdk: {
                getSkill: () => ({ level: 84 }),
                getInventory: () => items,
                getState: () => ({ player: { lifeId: 1 }, nearbyNpcs: [{ name: 'Tanner', index: 4 }], interface: { isOpen: true } }),
                sendInteractNpc: async () => ({ success: true }),
                sendClickComponent: async () => {
                    clicks++;
                    items[0]!.count -= 10;
                    items[1]!.count += 10;
                    items[2]!.count -= 200;
                    return { success: true };
                },
            },
        };
        const res = await tanInventory(s, 'black', 10, 20);
        expect(res).toMatchObject({ ok: true, made: 10, coinsSpent: 200, conserved: true });
        expect(clicks).toBe(1);
    });

    test('dragonhide tier specs cover green, blue, red, and black sets', () => {
        expect(Object.keys(DHIDE_TIERS)).toEqual(['green', 'blue', 'red', 'black']);
        expect(DHIDE_TIERS.black.pieces[0]).toMatchObject({ product: 2503, level: 84, leather: 3 });
        expect(DHIDE_TIERS.black.pieces[1]).toMatchObject({ product: 2497, level: 82, leather: 2 });
        expect(DHIDE_TIERS.black.pieces[2]).toMatchObject({ product: 2491, level: 79, leather: 1 });
        const plan = dhideSetPlan('black', 2, 12, 0, 10, 1000, false);
        expect(plan).toMatchObject({ sets: 2, tan: 12, coins: 240 });
    });

    test('BiS fletching plans magic shortbows and rune arrows cleanly', () => {
        expect(PVP_FLETCH_RECIPES.magic_shortbow).toMatchObject({ logId: 1513, unstrungId: 72, bowStringId: 1777, productId: 861, level: 80 });
        expect(PVP_FLETCH_RECIPES.rune_arrow).toMatchObject({ tipId: 44, headlessId: 53, productId: 892, level: 75 });
        expect(planMagicShortbowBatch({ 1513: 5, 72: 2, 1777: 6 }, 80, 6)).toMatchObject({
            cutLogs: 4,
            stringTotal: 6,
            shortfallLogs: 0,
            shortfallStrings: 0,
            productId: 861,
        });
        expect(planRuneArrowBatch({ 44: 150, 53: 300 }, 75, 150)).toMatchObject({
            craftable: 150,
            actions: 10,
            shortfallHeadless: 0,
            shortfallTips: 0,
            productId: 892,
        });
    });

    test('runItemMagic respects cast gap without stacking extra dead ticks', async () => {
        let tick = 0;
        const listeners = new Set<() => void>();
        const step = () => {
            tick++;
            for (const fn of [...listeners]) fn();
        };
        const inv = [
            { id: 1637, count: 1, slot: 0 },
            { id: 1637, count: 1, slot: 1 },
            { id: 564, count: 10, slot: 2 },
            { id: 555, count: 10, slot: 3 },
        ];
        let xp = 1000;
        const castTicks: number[] = [];
        const s: any = {
            tick: () => tick,
            onTick: (fn: () => void) => {
                listeners.add(fn);
                return () => listeners.delete(fn);
            },
            ended: new Promise(() => {}),
            direct: async (cmd: { type: string; slot: number }) => {
                expect(cmd.type).toBe('spellOnItem');
                castTicks.push(tick);
                inv[cmd.slot] = { id: 2550, count: 1, slot: cmd.slot };
                inv[2]!.count -= 1;
                inv[3]!.count -= 1;
                xp += 17.5;
                step();
                return { success: true };
            },
            sdk: {
                getState: () => ({ player: { lifeId: 1, isDead: false }, equipment: [] }),
                getInventory: () => inv,
                getEquipment: () => [],
                getSkill: () => ({ level: 60 }),
                getSkillXp: () => xp,
            },
        };
        const r = await runItemMagic(s, itemMagicRecipe('enchant:sapphire_ring'), { count: 2, cap: 20 });
        expect(r).toMatchObject({ ok: true, casts: 2, produced: 2 });
        expect(castTicks).toEqual([0, 1]);
    });
});
