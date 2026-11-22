// Specialist & gathering supply staging, withdrawal, trade handoff, and kit validation.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { accountOf, finish, getWorld, openBot } from '../../../core/src/bot';
import type { Session } from '../../../core/src/inprocess';
import { isLocalServer } from '../../../core/src/localserver';
import { planTripOffThread } from '../../../core/src/route-plan';
import { RESERVED_ACCOUNTS } from '../../../core/src/specialist-boards';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { goTo, sessionWalker, walkPath, walkRoute, withoutTeleports } from '../../../core/src/walk';
import nativeItems from '../../../../knowledge/items.json';
import { ACCOUNT_NAME_RE } from './admission';
import { REPO_ROOT } from './types';

export const EDGEVILLE_BANK = { x: 3094, z: 3491, level: 0 } as const;
export const LUMBRIDGE_HANDOFF = { x: 3222, z: 3222, level: 0 } as const;
export const DEFAULT_STAGE_BANK = { x: 3092, z: 3243, level: 0 } as const;
export const EDGEVILLE_SUPPLIER_STAND = { x: 3089, z: 3496, level: 0 } as const;
export const BODY_RUINS = { x: 3050, z: 3442, level: 0 } as const;
export const BODY_ALTAR_STAND = { x: 2523, z: 4833, level: 0 } as const;
export const VARROCK_WEST_BANK = { x: 3185, z: 3436, level: 0 } as const;
export const VARROCK_WEST_ANVIL = { x: 3188, z: 3426, level: 0 } as const;
export const HERBLORE_BANK_HELPER_SPOT = { x: 3094, z: 3492, level: 0 } as const;
export const LUMBRIDGE_SAFE_SPOT = { x: 3222, z: 3222, level: 0 } as const;
export const GATHERING_HELPER_SPAWN = { x: 3223, z: 3222, level: 0 } as const;

const TRADE_OFFER_INV = 3322;
const TRADE_MAIN_ACCEPT = 3420;
const TRADE_CONFIRM_ACCEPT = 3546;
const PRAYER_BONES_NEEDED = 555;

export const SPECIALIST_ITEM_IDS = {
    chisel: 1755,
    uncut_opal: 1625,
    uncut_jade: 1627,
    uncut_red_topaz: 1629,
    uncut_sapphire: 1623,
    uncut_emerald: 1621,
    uncut_ruby: 1619,
    uncut_diamond: 1617,
    uncut_dragonstone: 1631,
    opal: 1609,
    jade: 1611,
    red_topaz: 1613,
    sapphire: 1607,
    emerald: 1605,
    ruby: 1603,
    diamond: 1601,
    dragonstone: 1615,
    necklace_of_minigames_8: 3853,
    raw_beef: 2132,
    raw_rat_meat: 2134,
    raw_bear_meat: 2136,
    raw_chicken: 2138,
    guamvial: 91,
    marrentillvial: 93,
    tarrominvial: 95,
    harralandervial: 97,
    ranarrvial: 99,
    iritvial: 101,
    avantoevial: 103,
    kwuarmvial: 105,
    cadantinevial: 107,
    dwarfweedvial: 109,
    torstolvial: 111,
    lantadymevial: 2483,
    toadflaxvial: 3002,
    snapdragonvial: 3004,
    eye_of_newt: 221,
    red_spiders_eggs: 223,
    limpwurt_root: 225,
    snape_grass: 231,
    unicorn_horn_dust: 235,
    white_berries: 239,
    dragon_scale_dust: 241,
    wine_of_zamorak: 245,
    jangerberries: 247,
    chocolate_dust: 1975,
    toads_legs: 2152,
    mortmyremushroom: 2970,
    cactus_potato: 3138,
    zamorak_brew_3: 189,
    dragon_bones: 536,
    hammer: 2347,
    bronze_bar: 2349,
    iron_bar: 2351,
    steel_bar: 2353,
    mithril_bar: 2359,
    adamantite_bar: 2361,
    blankrune: 1436,
    air_talisman: 1438,
    body_talisman: 1446,
    bodyrune: 559,
    airrune: 556,
    waterrune: 555,
    earthrune: 557,
    firerune: 554,
    mindrune: 558,
    cosmicrune: 564,
    lawrune: 563,
    bloodrune: 565,
    staff_of_fire: 1387,
    knife: 946,
    amulet_of_glory_4: 1712,
    amulet_of_magic: 1727,
    boots_wizard: 2579,
    sapphire_ring: 1637,
    emerald_ring: 1639,
    ruby_ring: 1641,
    diamond_ring: 1643,
    dragonstone_ring: 1645,
    ring_of_recoil: 2550,
    ring_of_dueling_8: 2552,
    ring_of_forging: 2568,
    ring_of_life: 2570,
    ring_of_wealth: 2572,
    prayer_potion_4: 2434,
    super_energy_4: 3016,
    shark: 385,
} as const;

const GLORY_IDS = [1712, 1710, 1708, 1706] as const;

export interface KitSpecItem {
    readonly id: number;
    readonly name: string;
    readonly count: number;
    readonly stackable: boolean;
    readonly altIds?: readonly number[];
}

export interface SpecialistSupplyRuntime {
    restockAtBank?: (
        s: Session,
        bankTile: { x: number; z: number; level?: number },
        itemId: number,
        targetCount: number,
        keepIds: ReadonlySet<number>,
        done: () => boolean,
        deadline: number,
    ) => Promise<boolean>;
    serveFiremakingSupplier?: (
        s: Session,
        specialist: string,
        role: 'starter' | 'runner' | 'all',
        stop: () => boolean,
        opts: {
            onWave1Ready?: () => void;
            tradeWave0?: (batch: readonly { id: number; count: number }[]) => Promise<boolean>;
        },
    ) => Promise<{ ok: boolean }>;
    startHelperTradeArm?: (s: Session, specialist: string, stop: () => boolean) => { close(): void };
    firemakingSupplies?: Readonly<Record<number, number>>;
}

let runtimeHooks: SpecialistSupplyRuntime = {};
export function registerSpecialistSupplyRuntime(hooks: SpecialistSupplyRuntime) {
    runtimeHooks = { ...runtimeHooks, ...hooks };
}

export const ATTACK_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: 1387, name: 'Staff of fire', count: 1, stackable: false },
    { id: 558, name: 'Mind rune', count: 50, stackable: true },
    { id: 556, name: 'Air rune', count: 1300, stackable: true },
    { id: 563, name: 'Law rune', count: 30, stackable: true },
    { id: 562, name: 'Chaos rune', count: 240, stackable: true },
    { id: 995, name: 'Coins', count: 200, stackable: true },
    { id: 536, name: 'Dragon bones', count: 11, stackable: false },
    { id: 1511, name: 'Logs', count: 6, stackable: false },
    { id: 2434, name: 'Prayer potion(4)', count: 3, stackable: false },
    { id: 379, name: 'Lobster', count: 2, stackable: false },
] as const;

export const AGILITY_SPECIALIST_NOPOT_KIT: readonly KitSpecItem[] = [
    { id: 1712, name: 'Amulet of glory(4)', count: 1, stackable: false },
    { id: 995, name: 'Coins', count: 500, stackable: true },
    { id: 536, name: 'Dragon bones', count: 11, stackable: false },
    { id: 2434, name: 'Prayer potion(4)', count: 3, stackable: false },
    { id: 1897, name: 'Chocolate cake', count: 5, stackable: false },
] as const;

export const AGILITY_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: 1712, name: 'Amulet of glory(4)', count: 1, stackable: false },
    { id: 995, name: 'Coins', count: 500, stackable: true },
    { id: 536, name: 'Dragon bones', count: 11, stackable: false },
    { id: 2434, name: 'Prayer potion(4)', count: 3, stackable: false },
    { id: 3032, name: 'Agility potion(4)', count: 6, stackable: false },
    { id: 3016, name: 'Super energy(4)', count: 2, stackable: false },
    { id: 1897, name: 'Chocolate cake', count: 4, stackable: false },
] as const;

export const AGILITY_SPECIALIST_POTION_KIT: readonly KitSpecItem[] = AGILITY_SPECIALIST_KIT;

export const FLETCHING_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: 39, name: 'Bronze arrowtips', count: 60, stackable: true },
    { id: 40, name: 'Iron arrowtips', count: 90, stackable: true },
    { id: 41, name: 'Steel arrowtips', count: 135, stackable: true },
    { id: 42, name: 'Mithril arrowtips', count: 225, stackable: true },
    { id: 43, name: 'Adamant arrowtips', count: 495, stackable: true },
    { id: 44, name: 'Rune arrowtips', count: 2595, stackable: true },
    { id: 53, name: 'Headless arrow', count: 3600, stackable: true },
] as const;

export const FLETCHING_SPECIALIST_LIVE_KIT: readonly KitSpecItem[] = FLETCHING_SPECIALIST_KIT;

export const FISHING_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: 309, name: 'Fly fishing rod', count: 1, stackable: false },
    { id: 314, name: 'Feather', count: 1200, stackable: true },
    { id: 596, name: 'Torch', count: 1, stackable: false },
    { id: 946, name: 'Knife', count: 1, stackable: false },
    { id: 995, name: 'Coins', count: 100, stackable: true },
    { id: 1511, name: 'Logs', count: 4, stackable: false },
    { id: 1521, name: 'Oak logs', count: 4, stackable: false },
    { id: 1712, name: 'Amulet of glory(4)', count: 1, stackable: false, altIds: [1710, 1708] },
    { id: 1941, name: 'Swamp paste', count: 1, stackable: false },
    { id: 3016, name: 'Super energy(4)', count: 1, stackable: false },
] as const;

export const MINING_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: 434, name: 'Clay', count: 6, stackable: false },
    { id: 436, name: 'Copper ore', count: 4, stackable: false },
    { id: 440, name: 'Iron ore', count: 2, stackable: false },
    { id: 946, name: 'Knife', count: 1, stackable: false },
    { id: 995, name: 'Coins', count: 150, stackable: true },
    { id: 1275, name: 'Rune pickaxe', count: 1, stackable: false },
    { id: 1511, name: 'Logs', count: 2, stackable: false },
    { id: 1712, name: 'Amulet of glory(4)', count: 1, stackable: false },
    { id: 3016, name: 'Super energy(4)', count: 2, stackable: false },
    { id: 3853, name: 'Games necklace(8)', count: 1, stackable: false },
] as const;

export const MINING_SPECIALIST_LIVE_KIT: readonly KitSpecItem[] = [
    { id: 434, name: 'Clay', count: 6, stackable: false },
    { id: 436, name: 'Copper ore', count: 4, stackable: false },
    { id: 440, name: 'Iron ore', count: 2, stackable: false },
    { id: 946, name: 'Knife', count: 1, stackable: false },
    { id: 1275, name: 'Rune pickaxe', count: 1, stackable: false },
    { id: 1511, name: 'Logs', count: 2, stackable: false },
    { id: 1712, name: 'Amulet of glory(4)', count: 1, stackable: false },
    { id: 2552, name: 'Ring of dueling(8)', count: 1, stackable: false },
] as const;

export const THIEVING_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: 995, name: 'Coins', count: 200, stackable: true },
    { id: 1712, name: 'Amulet of glory(4)', count: 1, stackable: false },
    { id: 2301, name: 'Pineapple pizza', count: 25, stackable: false },
    { id: 3016, name: 'Super energy(4)', count: 1, stackable: false },
] as const;

export const THIEVING_SPECIALIST_LIVE_KIT: readonly KitSpecItem[] = [
    { id: 1897, name: 'Chocolate cake', count: 26, stackable: false },
    { id: 2552, name: 'Ring of dueling(8)', count: 1, stackable: false },
    { id: 3016, name: 'Super energy(4)', count: 1, stackable: false },
] as const;

export const COOKING_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: 1996, name: 'Unfermented wine', count: 6000, stackable: true },
    { id: 2552, name: 'Ring of dueling(8)', count: 1, stackable: false },
    { id: 2082, name: 'Unfinished cocktail', count: 4, stackable: false },
    { id: 2106, name: 'Lemon slices', count: 4, stackable: false },
] as const;

export const COOKING_SPECIALIST_LIVE_KIT: readonly KitSpecItem[] = COOKING_SPECIALIST_KIT;

export const WOODCUTTING_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: 1359, name: 'Rune axe', count: 1, stackable: false },
    { id: 946, name: 'Knife', count: 1, stackable: false },
    { id: 1511, name: 'Logs', count: 1, stackable: false },
    { id: 1712, name: 'Amulet of glory(4)', count: 1, stackable: false, altIds: [1710, 1708, 1706] },
    { id: 542, name: "Monk's robe", count: 1, stackable: false },
    { id: 544, name: "Monk's robe", count: 1, stackable: false },
    { id: 1718, name: 'Holy symbol', count: 1, stackable: false },
    { id: 556, name: 'Air rune', count: 150, stackable: true },
    { id: 558, name: 'Mind rune', count: 150, stackable: true },
    { id: 536, name: 'Dragon bones', count: 11, stackable: false },
    { id: 2434, name: 'Prayer potion(4)', count: 4, stackable: false },
] as const;

export const WOODCUTTING_SPECIALIST_LIVE_KIT: readonly KitSpecItem[] = WOODCUTTING_SPECIALIST_KIT;

export const HP_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: 556, name: 'Air rune', count: 2500, stackable: true },
    { id: 558, name: 'Mind rune', count: 140, stackable: true },
    { id: 562, name: 'Chaos rune', count: 220, stackable: true },
    { id: 560, name: 'Death rune', count: 220, stackable: true },
    { id: 563, name: 'Law rune', count: 60, stackable: true },
    { id: 555, name: 'Water rune', count: 35, stackable: true },
    { id: 995, name: 'Coins', count: 5000, stackable: true },
    { id: 1387, name: 'Staff of fire', count: 1, stackable: false },
    { id: 1059, name: 'Leather gloves', count: 1, stackable: false },
    { id: 1985, name: 'Cheese', count: 1, stackable: false },
    { id: 2552, name: 'Ring of dueling(8)', count: 1, stackable: false },
    { id: 536, name: 'Dragon bones', count: 11, stackable: false },
    { id: 1512, name: 'Logs', count: 6, stackable: true },
    { id: 2435, name: 'Prayer potion(4)', count: 18, stackable: true },
    { id: 386, name: 'Shark', count: 20, stackable: true },
    { id: 2358, name: 'Gold bar', count: 1, stackable: true },
    { id: 1760, name: 'Ball of wool', count: 1, stackable: true },
    { id: 2449, name: 'Superantipoison(4)', count: 2, stackable: true },
] as const;

export const MELEE_PVP_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: 556, name: 'Air rune', count: 6, stackable: true },
    { id: 557, name: 'Earth rune', count: 6, stackable: true },
    { id: 555, name: 'Water rune', count: 6, stackable: true },
    { id: 1319, name: 'Rune 2h sword', count: 1, stackable: false },
    { id: 1725, name: 'Amulet of strength', count: 1, stackable: false },
    { id: 2552, name: 'Ring of dueling(8)', count: 1, stackable: false },
    { id: 954, name: 'Rope', count: 1, stackable: false },
    { id: 2434, name: 'Prayer potion(4)', count: 2, stackable: false },
    { id: 385, name: 'Shark', count: 1, stackable: false },
    { id: 3016, name: 'Super energy(4)', count: 7, stackable: false },
    { id: 536, name: 'Dragon bones', count: 11, stackable: false },
] as const;

export const STRENGTH_SPECIALIST_KIT: readonly KitSpecItem[] = MELEE_PVP_SPECIALIST_KIT;
export const DEFENCE_SPECIALIST_KIT: readonly KitSpecItem[] = MELEE_PVP_SPECIALIST_KIT;

export const RANGED_SPECIALIST_TRADE1: readonly KitSpecItem[] = [
    { id: 536, name: 'Dragon bones', count: 11, stackable: false },
    { id: 6, name: 'Cannon base', count: 1, stackable: false },
    { id: 8, name: 'Cannon stand', count: 1, stackable: false },
    { id: 10, name: 'Cannon barrels', count: 1, stackable: false },
    { id: 12, name: 'Cannon furnace', count: 1, stackable: false },
    { id: 2, name: 'Cannonball', count: 2000, stackable: true },
    { id: 2552, name: 'Ring of dueling(8)', count: 1, stackable: false },
    { id: 1712, name: 'Amulet of glory(4)', count: 1, stackable: false },
    { id: 863, name: 'Iron knife', count: 250, stackable: true },
    { id: 1129, name: 'Leather body', count: 1, stackable: false },
    { id: 3024, name: 'Super restore(4)', count: 1, stackable: false },
    { id: 3016, name: 'Super energy(4)', count: 5, stackable: false },
    { id: 1897, name: 'Chocolate cake', count: 2, stackable: false },
] as const;

export const RANGED_SPECIALIST_TRADE2: readonly KitSpecItem[] = [
    { id: 868, name: 'Rune knife', count: 2000, stackable: true },
    { id: 2581, name: 'Robin hood hat', count: 1, stackable: false },
    { id: 2577, name: 'Ranger boots', count: 1, stackable: false },
    { id: 2497, name: 'Dragonhide chaps', count: 1, stackable: false },
    { id: 2491, name: 'Dragon vambraces', count: 1, stackable: false },
    { id: 2448, name: 'Superantipoison(4)', count: 2, stackable: false },
    { id: 2444, name: 'Ranging potion(4)', count: 2, stackable: false },
    { id: 3024, name: 'Super restore(4)', count: 7, stackable: false },
    { id: 3016, name: 'Super energy(4)', count: 2, stackable: false },
    { id: 1897, name: 'Chocolate cake', count: 1, stackable: false },
] as const;

export const RANGED_SPECIALIST_MSB_TRADE1: readonly KitSpecItem[] = RANGED_SPECIALIST_TRADE1;
export const RANGED_SPECIALIST_MSB_TRADE2: readonly KitSpecItem[] = [
    { id: 861, name: 'Magic shortbow', count: 1, stackable: false },
    { id: 892, name: 'Rune arrow', count: 1000, stackable: true },
    { id: 2581, name: 'Robin hood hat', count: 1, stackable: false },
    { id: 2577, name: 'Ranger boots', count: 1, stackable: false },
    { id: 2497, name: 'Dragonhide chaps', count: 1, stackable: false },
    { id: 2491, name: 'Dragon vambraces', count: 1, stackable: false },
    { id: 2448, name: 'Superantipoison(4)', count: 2, stackable: false },
    { id: 2444, name: 'Ranging potion(4)', count: 2, stackable: false },
    { id: 3024, name: 'Super restore(4)', count: 7, stackable: false },
    { id: 3016, name: 'Super energy(4)', count: 2, stackable: false },
    { id: 1897, name: 'Chocolate cake', count: 1, stackable: false },
] as const;

export const RANGED_SPECIALIST_LIVE_TRADE1: readonly KitSpecItem[] = [
    { id: 536, name: 'Dragon bones', count: 11, stackable: false },
    { id: 6, name: 'Cannon base', count: 1, stackable: false },
    { id: 8, name: 'Cannon stand', count: 1, stackable: false },
    { id: 10, name: 'Cannon barrels', count: 1, stackable: false },
    { id: 12, name: 'Cannon furnace', count: 1, stackable: false },
    { id: 2, name: 'Cannonball', count: 1500, stackable: true },
    { id: 2552, name: 'Ring of dueling(8)', count: 1, stackable: false },
    { id: 841, name: 'Shortbow', count: 1, stackable: false },
    { id: 884, name: 'Iron arrow', count: 300, stackable: true },
    { id: 1129, name: 'Leather body', count: 1, stackable: false },
    { id: 2434, name: 'Prayer potion(4)', count: 1, stackable: false },
    { id: 379, name: 'Lobster', count: 3, stackable: false },
] as const;

export const RANGED_SPECIALIST_LIVE_TRADE2: readonly KitSpecItem[] = [
    { id: 861, name: 'Magic shortbow', count: 1, stackable: false },
    { id: 892, name: 'Rune arrow', count: 1000, stackable: true },
    { id: 2497, name: 'Dragonhide chaps', count: 1, stackable: false },
    { id: 2491, name: 'Dragon vambraces', count: 1, stackable: false },
    { id: 175, name: 'Antipoison(3)', count: 8, stackable: false },
    { id: 2434, name: 'Prayer potion(4)', count: 7, stackable: false },
    { id: 379, name: 'Lobster', count: 2, stackable: false },
] as const;

function mergeKitSpecs(a: readonly KitSpecItem[], b: readonly KitSpecItem[]): readonly KitSpecItem[] {
    const order: KitSpecItem[] = [];
    const byId = new Map<number, KitSpecItem>();
    for (const item of [...a, ...b]) {
        const cur = byId.get(item.id);
        if (cur) {
            const merged = { ...cur, count: cur.count + item.count };
            byId.set(item.id, merged);
            order[order.findIndex(x => x.id === item.id)] = merged;
        } else {
            const copy = { ...item };
            byId.set(item.id, copy);
            order.push(copy);
        }
    }
    return order;
}

export const RANGED_SPECIALIST_KIT: readonly KitSpecItem[] = mergeKitSpecs(RANGED_SPECIALIST_TRADE1, RANGED_SPECIALIST_TRADE2);
export const RANGED_SPECIALIST_MSB_KIT: readonly KitSpecItem[] = mergeKitSpecs(RANGED_SPECIALIST_MSB_TRADE1, RANGED_SPECIALIST_MSB_TRADE2);
export const RANGED_SPECIALIST_LIVE_KIT: readonly KitSpecItem[] = mergeKitSpecs(RANGED_SPECIALIST_LIVE_TRADE1, RANGED_SPECIALIST_LIVE_TRADE2);

const STACKABLE_IDS = new Set<number>([
    995,
    SPECIALIST_ITEM_IDS.airrune, SPECIALIST_ITEM_IDS.waterrune, SPECIALIST_ITEM_IDS.earthrune,
    SPECIALIST_ITEM_IDS.firerune, SPECIALIST_ITEM_IDS.mindrune, SPECIALIST_ITEM_IDS.cosmicrune,
    SPECIALIST_ITEM_IDS.lawrune, SPECIALIST_ITEM_IDS.bloodrune, SPECIALIST_ITEM_IDS.bodyrune,
]);

const SMITHING_RUNNER_QUEUE: readonly { barId: number; count: number }[] = [
    { barId: SPECIALIST_ITEM_IDS.iron_bar, count: 25 },
    ...Array.from({ length: 4 }, () => ({ barId: SPECIALIST_ITEM_IDS.steel_bar, count: 25 })),
    ...Array.from({ length: 11 }, () => ({ barId: SPECIALIST_ITEM_IDS.mithril_bar, count: 25 })),
    ...Array.from({ length: 15 }, () => ({ barId: SPECIALIST_ITEM_IDS.adamantite_bar, count: 25 })),
];

export const PRAYER_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: SPECIALIST_ITEM_IDS.dragon_bones, name: 'Dragon bones', count: PRAYER_BONES_NEEDED, stackable: false },
];

export const SMITHING_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: SPECIALIST_ITEM_IDS.hammer, name: 'Hammer', count: 1, stackable: false },
    { id: SPECIALIST_ITEM_IDS.amulet_of_glory_4, name: 'Amulet of glory(4)', count: 1, stackable: false },
    { id: SPECIALIST_ITEM_IDS.bronze_bar, name: 'Bronze bar', count: 9, stackable: false },
    { id: SPECIALIST_ITEM_IDS.iron_bar, name: 'Iron bar', count: 42, stackable: false },
    { id: SPECIALIST_ITEM_IDS.steel_bar, name: 'Steel bar', count: 100, stackable: false },
    { id: SPECIALIST_ITEM_IDS.mithril_bar, name: 'Mithril bar', count: 275, stackable: false },
    { id: SPECIALIST_ITEM_IDS.adamantite_bar, name: 'Adamantite bar', count: 375, stackable: false },
];

export const RUNECRAFT_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: SPECIALIST_ITEM_IDS.amulet_of_glory_4, name: 'Amulet of glory(4)', count: 1, stackable: false },
    { id: SPECIALIST_ITEM_IDS.air_talisman, name: 'Air talisman', count: 1, stackable: false },
    { id: SPECIALIST_ITEM_IDS.body_talisman, name: 'Body talisman', count: 1, stackable: false },
    { id: SPECIALIST_ITEM_IDS.blankrune, name: 'Rune essence', count: 25 + 205 * 26, stackable: false },
];

const CRAFTING_BATCHES = [
    {
        give: [
            { id: SPECIALIST_ITEM_IDS.chisel, count: 1 },
            { id: SPECIALIST_ITEM_IDS.uncut_opal, count: 18 },
            { id: SPECIALIST_ITEM_IDS.uncut_sapphire, count: 3 },
            { id: SPECIALIST_ITEM_IDS.uncut_emerald, count: 6 },
        ],
        returnIds: [] as number[],
    },
    {
        give: [
            { id: SPECIALIST_ITEM_IDS.uncut_ruby, count: 3 },
            { id: SPECIALIST_ITEM_IDS.uncut_diamond, count: 9 },
            { id: SPECIALIST_ITEM_IDS.uncut_dragonstone, count: 15 },
        ],
        returnIds: [SPECIALIST_ITEM_IDS.opal, 1633, SPECIALIST_ITEM_IDS.sapphire, SPECIALIST_ITEM_IDS.emerald],
    },
    ...Array.from({ length: 9 }, (_, idx) => ({
        give: [{ id: SPECIALIST_ITEM_IDS.uncut_dragonstone, count: 27 }],
        returnIds: idx === 0 ? [SPECIALIST_ITEM_IDS.ruby, SPECIALIST_ITEM_IDS.diamond, SPECIALIST_ITEM_IDS.dragonstone] : [SPECIALIST_ITEM_IDS.dragonstone],
    })),
    {
        give: [{ id: SPECIALIST_ITEM_IDS.uncut_dragonstone, count: 19 }],
        returnIds: [SPECIALIST_ITEM_IDS.dragonstone],
    },
] as const;

export const CRAFTING_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: SPECIALIST_ITEM_IDS.chisel, name: 'Chisel', count: 1, stackable: false },
    { id: SPECIALIST_ITEM_IDS.uncut_opal, name: 'Uncut opal', count: 18, stackable: false },
    { id: SPECIALIST_ITEM_IDS.uncut_sapphire, name: 'Uncut sapphire', count: 3, stackable: false },
    { id: SPECIALIST_ITEM_IDS.uncut_emerald, name: 'Uncut emerald', count: 6, stackable: false },
    { id: SPECIALIST_ITEM_IDS.uncut_ruby, name: 'Uncut ruby', count: 3, stackable: false },
    { id: SPECIALIST_ITEM_IDS.uncut_diamond, name: 'Uncut diamond', count: 9, stackable: false },
    { id: SPECIALIST_ITEM_IDS.uncut_dragonstone, name: 'Uncut dragonstone', count: 277, stackable: false },
];

const HERBLORE_STARTER_GIVE = [
    { id: SPECIALIST_ITEM_IDS.necklace_of_minigames_8, count: 1 },
    { id: SPECIALIST_ITEM_IDS.raw_beef, count: 1 },
    { id: SPECIALIST_ITEM_IDS.raw_rat_meat, count: 1 },
    { id: SPECIALIST_ITEM_IDS.raw_bear_meat, count: 1 },
    { id: SPECIALIST_ITEM_IDS.raw_chicken, count: 1 },
    { id: SPECIALIST_ITEM_IDS.amulet_of_glory_4, count: 1 },
] as const;

const HERBLORE_NOTED_SUPPLIES = [
    { id: SPECIALIST_ITEM_IDS.harralandervial, certId: 98, count: 10 },
    { id: SPECIALIST_ITEM_IDS.chocolate_dust, certId: 1976, count: 10 },
    { id: SPECIALIST_ITEM_IDS.iritvial, certId: 102, count: 10 },
    { id: SPECIALIST_ITEM_IDS.eye_of_newt, certId: 222, count: 10 },
    { id: SPECIALIST_ITEM_IDS.kwuarmvial, certId: 106, count: 30 },
    { id: SPECIALIST_ITEM_IDS.limpwurt_root, certId: 226, count: 10 },
    { id: SPECIALIST_ITEM_IDS.dragon_scale_dust, certId: 242, count: 50 },
    { id: SPECIALIST_ITEM_IDS.lantadymevial, certId: 2484, count: 30 },
    { id: SPECIALIST_ITEM_IDS.torstolvial, certId: 112, count: 170 },
    { id: SPECIALIST_ITEM_IDS.jangerberries, certId: 248, count: 170 },
] as const;

const itemCatalogMap = new Map<number, { id: number; name: string }>(nativeItems.map(i => [i.id, i]));

export const HERBLORE_SPECIALIST_KIT: readonly KitSpecItem[] = (() => {
    const counts = new Map<number, number>();
    for (const item of HERBLORE_STARTER_GIVE) counts.set(item.id, (counts.get(item.id) ?? 0) + item.count);
    for (const item of HERBLORE_NOTED_SUPPLIES) counts.set(item.id, (counts.get(item.id) ?? 0) + item.count);
    return [...counts.entries()].map(([id, count]) => ({
        id,
        name: itemCatalogMap.get(id)?.name ?? `Item ${id}`,
        count,
        stackable: STACKABLE_IDS.has(id),
    }));
})();

const MAGIC_BATCHES = [
    {
        give: [
            { id: SPECIALIST_ITEM_IDS.staff_of_fire, count: 1 },
            { id: SPECIALIST_ITEM_IDS.mindrune, count: 25 },
            { id: SPECIALIST_ITEM_IDS.cosmicrune, count: 150 },
            { id: SPECIALIST_ITEM_IDS.waterrune, count: 20 },
            { id: SPECIALIST_ITEM_IDS.airrune, count: 1500 },
            { id: SPECIALIST_ITEM_IDS.earthrune, count: 400 },
            { id: SPECIALIST_ITEM_IDS.sapphire_ring, count: 12 },
            { id: SPECIALIST_ITEM_IDS.emerald_ring, count: 9 },
            { id: SPECIALIST_ITEM_IDS.shark, count: 1 },
        ],
        returnIds: [] as number[],
    },
    {
        give: [{ id: SPECIALIST_ITEM_IDS.emerald_ring, count: 18 }, { id: SPECIALIST_ITEM_IDS.ruby_ring, count: 5 }],
        returnIds: [SPECIALIST_ITEM_IDS.ring_of_recoil, SPECIALIST_ITEM_IDS.ring_of_dueling_8],
    },
    {
        give: [{ id: SPECIALIST_ITEM_IDS.ruby_ring, count: 13 }, { id: SPECIALIST_ITEM_IDS.diamond_ring, count: 10 }],
        returnIds: [SPECIALIST_ITEM_IDS.ring_of_dueling_8, SPECIALIST_ITEM_IDS.ring_of_forging],
    },
    {
        give: [{ id: SPECIALIST_ITEM_IDS.diamond_ring, count: 23 }],
        returnIds: [SPECIALIST_ITEM_IDS.ring_of_forging, SPECIALIST_ITEM_IDS.ring_of_life],
    },
    {
        give: [{ id: SPECIALIST_ITEM_IDS.diamond_ring, count: 3 }, { id: SPECIALIST_ITEM_IDS.ruby_ring, count: 21 }],
        returnIds: [SPECIALIST_ITEM_IDS.ring_of_life],
    },
    {
        give: [{ id: SPECIALIST_ITEM_IDS.ruby_ring, count: 25 }],
        returnIds: [SPECIALIST_ITEM_IDS.ring_of_forging],
    },
    {
        give: [
            { id: SPECIALIST_ITEM_IDS.ruby_ring, count: 8 },
            { id: SPECIALIST_ITEM_IDS.lawrune, count: 12 },
            { id: SPECIALIST_ITEM_IDS.bloodrune, count: 850 },
            { id: SPECIALIST_ITEM_IDS.knife, count: 1 },
            { id: SPECIALIST_ITEM_IDS.dragon_bones, count: 8 },
            { id: SPECIALIST_ITEM_IDS.prayer_potion_4, count: 2 },
            { id: SPECIALIST_ITEM_IDS.amulet_of_magic, count: 1 },
            { id: SPECIALIST_ITEM_IDS.super_energy_4, count: 1 },
            { id: SPECIALIST_ITEM_IDS.shark, count: 2 },
        ],
        returnIds: [SPECIALIST_ITEM_IDS.ring_of_forging],
    },
] as const;

export const MAGIC_SPECIALIST_KIT: readonly KitSpecItem[] = (() => {
    const counts = new Map<number, number>();
    for (const batch of MAGIC_BATCHES) for (const item of batch.give) counts.set(item.id, (counts.get(item.id) ?? 0) + item.count);
    return [...counts.entries()].map(([id, count]) => ({
        id,
        name: itemCatalogMap.get(id)?.name ?? `Item ${id}`,
        count,
        stackable: STACKABLE_IDS.has(id),
    }));
})();

const DEFAULT_FM_SUPPLIES: Readonly<Record<number, number>> = { 1511: 2, 1521: 4, 1519: 7, 1517: 13, 1515: 24, 1513: 107 };
export const FIREMAKING_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: 1511, name: 'Logs', count: DEFAULT_FM_SUPPLIES[1511]!, stackable: false },
    { id: 1521, name: 'Oak logs', count: DEFAULT_FM_SUPPLIES[1521]!, stackable: false },
    { id: 1519, name: 'Willow logs', count: DEFAULT_FM_SUPPLIES[1519]!, stackable: false },
    { id: 1517, name: 'Maple logs', count: DEFAULT_FM_SUPPLIES[1517]!, stackable: false },
    { id: 1515, name: 'Yew logs', count: DEFAULT_FM_SUPPLIES[1515]!, stackable: false },
    { id: 1513, name: 'Magic logs', count: DEFAULT_FM_SUPPLIES[1513]!, stackable: false },
] as const;

export const SPECIALIST_KITS = {
    attack: ATTACK_SPECIALIST_KIT,
    agility: AGILITY_SPECIALIST_KIT,
    hitpoints: HP_SPECIALIST_KIT,
    strength: STRENGTH_SPECIALIST_KIT,
    defence: DEFENCE_SPECIALIST_KIT,
    ranged: RANGED_SPECIALIST_KIT,
    'ranged-msb': RANGED_SPECIALIST_MSB_KIT,
    'ranged-live': RANGED_SPECIALIST_LIVE_KIT,
    fletching: FLETCHING_SPECIALIST_KIT,
    'fletching-live': FLETCHING_SPECIALIST_LIVE_KIT,
    fishing: FISHING_SPECIALIST_KIT,
    mining: MINING_SPECIALIST_KIT,
    'mining-live': MINING_SPECIALIST_LIVE_KIT,
    thieving: THIEVING_SPECIALIST_KIT,
    'thieving-live': THIEVING_SPECIALIST_LIVE_KIT,
    cooking: COOKING_SPECIALIST_KIT,
    'cooking-live': COOKING_SPECIALIST_LIVE_KIT,
    woodcutting: WOODCUTTING_SPECIALIST_KIT,
    'woodcutting-live': WOODCUTTING_SPECIALIST_LIVE_KIT,
    firemaking: FIREMAKING_SPECIALIST_KIT,
    prayer: PRAYER_SPECIALIST_KIT,
    smithing: SMITHING_SPECIALIST_KIT,
    runecraft: RUNECRAFT_SPECIALIST_KIT,
    crafting: CRAFTING_SPECIALIST_KIT,
    herblore: HERBLORE_SPECIALIST_KIT,
    magic: MAGIC_SPECIALIST_KIT,
} as const satisfies Record<string, readonly KitSpecItem[]>;

export type SpecialistKitName = keyof typeof SPECIALIST_KITS;
export type SupplierKitName = SpecialistKitName;

export function parseKitOption(args: readonly string[]): { name: SpecialistKitName; kit: readonly KitSpecItem[] } | null;
export function parseKitOption(args: readonly string[], defaultName: SpecialistKitName): { name: SpecialistKitName; kit: readonly KitSpecItem[] };
export function parseKitOption(args: readonly string[], defaultName?: SpecialistKitName): { name: SpecialistKitName; kit: readonly KitSpecItem[] } | null {
    const rawInput = args.find(a => a.startsWith('--kit='))?.slice(6).trim().toLowerCase();
    const raw = rawInput === 'hp' ? 'hitpoints' : rawInput;
    if (!raw) return defaultName ? { name: defaultName, kit: SPECIALIST_KITS[defaultName] } : null;
    if (!(raw in SPECIALIST_KITS)) throw Error(`specialist-supplier: unknown --kit=${rawInput}; expected ${Object.keys(SPECIALIST_KITS).join('|')}`);
    const name = raw as SpecialistKitName;
    return { name, kit: SPECIALIST_KITS[name] };
}

export function parseKitArg(args: readonly string[], env: Record<string, string | undefined> = process.env): SpecialistKitName {
    const rawInput = (args.find(a => a.startsWith('--kit='))?.slice(6) ?? env.SUPPLIER_KIT ?? 'attack').trim().toLowerCase();
    const raw = rawInput === 'hp' ? 'hitpoints' : rawInput;
    if (raw in SPECIALIST_KITS) return raw as SpecialistKitName;
    throw Error(`unknown --kit: ${rawInput} (expected ${Object.keys(SPECIALIST_KITS).join('|')})`);
}

export function resolveSupplierKit(kitName: SpecialistKitName): readonly KitSpecItem[] {
    return SPECIALIST_KITS[kitName];
}

let certToBaseMap: Map<number, number> | null = null;
export function resolveBaseId(id: number): number {
    if (!certToBaseMap) {
        const packPath = resolve(REPO_ROOT, 'vendor/rs-sdk/server/content/pack/obj.pack');
        const byName = new Map<string, number>();
        const certs: Array<[number, string]> = [];
        for (const line of readFileSync(packPath, 'utf8').split(/\r?\n/)) {
            const eq = line.indexOf('=');
            if (eq <= 0) continue;
            const parsedId = Number(line.slice(0, eq));
            const name = line.slice(eq + 1).trim();
            if (!Number.isFinite(parsedId) || !name) continue;
            if (name.startsWith('cert_')) certs.push([parsedId, name.slice(5)]);
            else byName.set(name, parsedId);
        }
        const map = new Map<number, number>();
        for (const [certId, baseName] of certs) {
            const base = byName.get(baseName);
            if (base !== undefined) map.set(certId, base);
        }
        certToBaseMap = map;
    }
    return certToBaseMap.get(id) ?? id;
}

const isNotedId = (id: number): boolean => resolveBaseId(id) !== id;

function invSpec(id: number, count: number, altIds?: readonly number[]): KitSpecItem {
    return {
        id,
        name: itemCatalogMap.get(id)?.name ?? `Item ${id}`,
        count,
        stackable: STACKABLE_IDS.has(id) || isNotedId(id),
        ...(altIds?.length ? { altIds } : {}),
    };
}

export interface SupplierTradeLeg {
    readonly kit: readonly KitSpecItem[];
    readonly handoff: { readonly x: number; readonly z: number; readonly level: number };
    readonly bank: { readonly x: number; readonly z: number; readonly level: number };
    readonly noted?: boolean;
}

export interface SupplierKitPlan {
    readonly name: SupplierKitName;
    readonly legs: readonly SupplierTradeLeg[];
    readonly combined: readonly KitSpecItem[];
}

export function resolveSupplierKitPlan(kitName: string | undefined = process.env.SUPPLIER_KIT): SupplierKitPlan {
    const rawInput = (kitName ?? 'attack').trim().toLowerCase() || 'attack';
    const raw = rawInput === 'hp' ? 'hitpoints' : rawInput;
    const rangedVariant = raw === 'ranged' || raw === 'ranged-knives' ? 'knives'
        : raw === 'ranged-msb' ? 'msb'
        : raw === 'ranged-live' ? 'live'
        : null;
    if (rangedVariant) {
        const name: SupplierKitName = rangedVariant === 'knives' ? 'ranged' : rangedVariant === 'msb' ? 'ranged-msb' : 'ranged-live';
        const trade1 = rangedVariant === 'msb' ? RANGED_SPECIALIST_MSB_TRADE1 : rangedVariant === 'live' ? RANGED_SPECIALIST_LIVE_TRADE1 : RANGED_SPECIALIST_TRADE1;
        const trade2 = rangedVariant === 'msb' ? RANGED_SPECIALIST_MSB_TRADE2 : rangedVariant === 'live' ? RANGED_SPECIALIST_LIVE_TRADE2 : RANGED_SPECIALIST_TRADE2;
        return {
            name,
            legs: [
                { kit: trade1, handoff: LUMBRIDGE_HANDOFF, bank: DEFAULT_STAGE_BANK },
                { kit: trade2, handoff: EDGEVILLE_SUPPLIER_STAND, bank: EDGEVILLE_BANK },
            ],
            combined: SPECIALIST_KITS[name],
        };
    }
    if (raw === 'herblore') {
        return {
            name: 'herblore',
            legs: [
                { kit: HERBLORE_STARTER_GIVE.map(g => invSpec(g.id, g.count)), handoff: LUMBRIDGE_HANDOFF, bank: DEFAULT_STAGE_BANK },
                { kit: HERBLORE_NOTED_SUPPLIES.map(g => invSpec(g.id, g.count)), handoff: HERBLORE_BANK_HELPER_SPOT, bank: EDGEVILLE_BANK, noted: true },
            ],
            combined: SPECIALIST_KITS.herblore,
        };
    }
    if (raw in SPECIALIST_KITS) {
        const name = raw as SupplierKitName;
        const kit = SPECIALIST_KITS[name];
        return {
            name,
            legs: [{ kit, handoff: LUMBRIDGE_HANDOFF, bank: DEFAULT_STAGE_BANK }],
            combined: kit,
        };
    }
    throw Error(`specialist-supplier: unknown kit "${kitName}" (expected ${Object.keys(SPECIALIST_KITS).join('|')})`);
}

export function buildLegDeliveryReceipt(o: {
    kitName: SupplierKitName;
    leg: number;
    totalLegs: number;
    server: string;
    from: string;
    to: string;
    at: number;
    before: readonly { id: number; count: number }[];
    after: readonly { id: number; count: number }[];
    kit: readonly KitSpecItem[];
    legs?: readonly string[];
}) {
    return {
        ok: true,
        observed: true,
        kit: o.kitName,
        leg: o.leg,
        totalLegs: o.totalLegs,
        ...(o.legs ? { legs: o.legs } : {}),
        server: o.server,
        from: o.from,
        to: o.to,
        at: o.at,
        before: o.before.map(i => ({ id: i.id, count: i.count })),
        after: o.after.map(i => ({ id: i.id, count: i.count })),
        items: o.kit.map(k => ({ id: resolveBaseId(k.id), count: k.count })),
    };
}

export type SupplierRole = 'auto' | 'starter' | 'runner';

export function parseSupplierRole(args: readonly string[], env: Record<string, string | undefined> = process.env): SupplierRole {
    const raw = (args.find(a => a.startsWith('--role='))?.slice(7) ?? env.SUPPLIER_ROLE ?? 'auto').trim().toLowerCase();
    if (!raw || raw === 'auto') return 'auto';
    if (raw === 'starter' || raw === 'runner') return raw;
    throw Error(`specialist-supplier: unknown --role=${raw}; expected starter|runner|auto`);
}

export function parseSupplierCliArgs(args: readonly string[]): {
    kitArg: string | undefined;
    cap: number | undefined;
    outArg: string | undefined;
    bankX: number | undefined;
    bankZ: number | undefined;
    batchIndex?: number;
    runnerIndex?: number;
    runnerCount?: number;
    positional: string[];
} {
    const kitArg = args.find(a => a.startsWith('--kit='))?.slice(6);
    const outArg = args.find(a => a.startsWith('--out='))?.slice(6);
    const bxRaw = args.find(a => a.startsWith('--bank-x='))?.slice(9);
    const bzRaw = args.find(a => a.startsWith('--bank-z='))?.slice(9);
    const batchRaw = args.find(a => a.startsWith('--batch='))?.slice(8);
    const runnerRaw = args.find(a => a.startsWith('--runner='))?.slice(9);
    let batchIndex: number | undefined;
    if (batchRaw !== undefined) {
        if (!/^\d+$/.test(batchRaw)) throw Error(`specialist-supplier: invalid --batch=${batchRaw}`);
        batchIndex = Number(batchRaw);
    }
    let runnerIndex: number | undefined;
    let runnerCount: number | undefined;
    if (runnerRaw !== undefined) {
        const m = runnerRaw.match(/^(\d+)\/(\d+)$/);
        if (!m) throw Error(`specialist-supplier: invalid --runner=${runnerRaw} (expected <index>/<count>)`);
        runnerIndex = Number(m[1]);
        runnerCount = Number(m[2]);
        if (runnerCount < 1 || runnerIndex < 0 || runnerIndex >= runnerCount) throw Error(`specialist-supplier: invalid --runner=${runnerRaw} (index out of bounds)`);
    }
    const positional = args.filter(a => !a.startsWith('--'));
    const capCandidate = positional.length >= 3 && /^\d+$/.test(positional[2]!) ? Number(positional[2]) : undefined;
    return {
        kitArg,
        cap: capCandidate,
        outArg,
        bankX: bxRaw !== undefined ? Number(bxRaw) : undefined,
        bankZ: bzRaw !== undefined ? Number(bzRaw) : undefined,
        ...(batchIndex !== undefined ? { batchIndex } : {}),
        ...(runnerIndex !== undefined ? { runnerIndex } : {}),
        ...(runnerCount !== undefined ? { runnerCount } : {}),
        positional,
    };
}

export const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const exactNameRe = (name: string): RegExp => new RegExp('^' + escapeRe(name) + '$', 'i');

export function kitRequirements(kit: readonly KitSpecItem[] = ATTACK_SPECIALIST_KIT) {
    return [...kit].sort((a, b) => a.id - b.id).map(item => ({ item: item.name, count: item.count, itemId: item.id }));
}

export function kitSlotTotal(kit: readonly KitSpecItem[] = ATTACK_SPECIALIST_KIT): number {
    return kit.reduce((sum, item) => sum + (item.stackable ? 1 : item.count), 0);
}

export function countById(items: readonly { id: number; baseId?: number; count?: number }[], id: number): number {
    const want = resolveBaseId(id);
    let total = 0;
    for (const item of items) if ((item.baseId ?? resolveBaseId(item.id)) === want) total += item.count ?? 0;
    return total;
}

const specIds = (spec: KitSpecItem): readonly number[] => (spec.altIds?.length ? [spec.id, ...spec.altIds] : [spec.id]);
const countForSpec = (items: readonly { id: number; baseId?: number; count?: number }[], spec: KitSpecItem): number =>
    specIds(spec).reduce((sum, id) => sum + countById(items, id), 0);

export function resolveConcreteKit(kit: readonly KitSpecItem[], items: readonly { id: number; baseId?: number; count?: number }[]): readonly KitSpecItem[] {
    return kit.map(spec => {
        if (!spec.altIds?.length) return spec;
        const matchedId = specIds(spec).find(id => countById(items, id) >= spec.count);
        if (matchedId === undefined || matchedId === spec.id) return spec;
        return { id: matchedId, name: itemCatalogMap.get(matchedId)?.name ?? spec.name, count: spec.count, stackable: spec.stackable };
    });
}

export function hasExactKit(items: readonly { id: number; baseId?: number; count?: number }[], kit: readonly KitSpecItem[] = ATTACK_SPECIALIST_KIT): boolean {
    const allowed = new Set(kit.flatMap(k => specIds(k).map(resolveBaseId)));
    if (items.some(i => !allowed.has(i.baseId ?? resolveBaseId(i.id)))) return false;
    return kit.every(spec => countForSpec(items, spec) === spec.count && (!isNotedId(spec.id) || items.some(i => i.id === spec.id && (i.count ?? 0) >= spec.count)));
}

export function hasAtLeastKit(items: readonly { id: number; baseId?: number; count?: number }[], kit: readonly KitSpecItem[] = ATTACK_SPECIALIST_KIT): boolean {
    return kit.every(spec => countForSpec(items, spec) >= spec.count);
}

export function assertSupplierAccount(name: string, label = 'account'): string {
    if (!name || !ACCOUNT_NAME_RE.test(name)) throw Error(`specialist-supplier: invalid ${label}: ${name}`);
    if (RESERVED_ACCOUNTS.includes(name.toLowerCase())) throw Error(`specialist-supplier: refuses reserved ${label}: ${name}`);
    return name;
}

function posNear(s: Session, to: { x: number; z: number; level: number }, tol = 2): boolean {
    const p = s.sdk.getState()?.player;
    return !!p && p.level === to.level && Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) <= tol;
}

export async function moveGroundTo(s: Session, to: { x: number; z: number; level: number }, tol = 2, stop: () => boolean = () => false, legTimeoutTicks = 150): Promise<void> {
    if (posNear(s, to, tol)) return;
    const p = s.sdk.getState()?.player;
    if (p && p.level === to.level && Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) <= 24) {
        const w = await sessionWalker(s);
        const r = await walkPath(w, [{ x: to.x, z: to.z, tol }], { maxTicks: 120, stop });
        if (r.ok && posNear(s, to, tol)) return;
    }
    const cur = s.sdk.getState()?.player;
    if (!cur) throw Error('walk failed: no player state');
    const from = { x: cur.worldX, z: cur.worldZ, level: cur.level };
    const plan = await planTripOffThread(from, to, withoutTeleports(accountOf(s)), undefined);
    if (!plan) throw Error(`ground route to ${to.x},${to.z},${to.level} unavailable from ${from.x},${from.z},${from.level}`);
    const r = await walkRoute(s, plan.legs, { legTimeoutTicks });
    if (!r.ok || !posNear(s, to, tol)) throw Error(`walk to ${to.x},${to.z},${to.level} failed: ${r.ok ? 'not at target' : r.detail}`);
}

async function moveTo(s: Session, to: { x: number; z: number; level: number }, tol = 2, stop: () => boolean): Promise<void> {
    if (posNear(s, to, tol)) return;
    const p = s.sdk.getState()?.player;
    if (p && p.level === to.level && Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) <= 24) {
        const w = await sessionWalker(s);
        const r = await walkPath(w, [{ x: to.x, z: to.z, tol }], { maxTicks: 120, stop });
        if (r.ok && posNear(s, to, tol)) return;
    }
    const world = await getWorld();
    const r = await goTo(s, world, to, accountOf(s), { legTimeoutTicks: 150, noJewelry: true });
    if (!r.ok || !posNear(s, to, tol)) throw Error(`walk to ${to.x},${to.z},${to.level} failed: ${r.ok ? 'not at target' : r.detail}`);
}

async function openFreshBank(s: Session) {
    if (s.sdk.getState()?.bank?.isOpen) {
        await s.bot.closeBank();
        await waitUntil(s, () => !s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 8 });
    }
    const gen = s.bankObservation?.()?.generation ?? 0;
    await s.bot.dismissBlockingUI();
    const res = await s.bot.openBank();
    if (!res.success) throw Error(`openBank failed: ${res.message ?? res.reason}`);
    const ok = await waitUntil(s, () => !!s.sdk.getState()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > gen, { timeoutTicks: 20 });
    const obs = s.bankObservation?.();
    if (!ok || !obs) throw Error('fresh bank observation unavailable');
    return obs;
}

async function depositAllInventory(s: Session): Promise<void> {
    while (s.sdk.getInventory().length > 0) {
        const first = s.sdk.getInventory()[0];
        if (!first) break;
        const r = await s.bot.depositItem(first, -1);
        if (!r.success) throw Error(`deposit failed for ${first.name}: ${r.message ?? r.reason}`);
        await waitUntil(s, () => !s.sdk.getInventory().some(i => i.id === first.id), { timeoutTicks: 10 });
    }
}

export async function withdrawExactKit(s: Session, kit: readonly KitSpecItem[], bankAt: { x: number; z: number; level: number }, stop: () => boolean, allowNoted = false): Promise<readonly KitSpecItem[]> {
    await moveTo(s, bankAt, 2, stop);
    await openFreshBank(s);
    await depositAllInventory(s);
    const concreteKit = resolveConcreteKit(kit, s.sdk.getState()?.bank?.items ?? []);
    for (const spec of concreteKit) {
        const baseId = resolveBaseId(spec.id);
        const bankRow = s.sdk.getState()?.bank?.items.find(i => i.id === spec.id || i.id === baseId);
        if (!bankRow || bankRow.count < spec.count) {
            await s.bot.closeBank().catch(() => {});
            throw Error(`missing bank stock for ${spec.name} (${spec.id}): need ${spec.count}, have ${bankRow?.count ?? 0}`);
        }
        const before = countById(s.sdk.getInventory(), spec.id);
        const asNote = isNotedId(spec.id) || (allowNoted && !spec.stackable && spec.count > 1);
        const w = await s.bot.withdrawItem(bankRow, spec.count, { asNote });
        if (!w.success || !await waitUntil(s, () => countById(s.sdk.getInventory(), spec.id) === before + spec.count, { timeoutTicks: 12 })) {
            await s.bot.closeBank().catch(() => {});
            throw Error(`withdraw failed for ${spec.name}: ${w.message ?? w.reason ?? 'count mismatch'}`);
        }
    }
    await s.bot.closeBank();
    await waitUntil(s, () => !s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 8 });
    if (!hasExactKit(s.sdk.getInventory(), concreteKit)) throw Error('withdrawn inventory does not match exact specialist kit');
    return concreteKit;
}

function uniqueSlotsForBatch(inv: readonly { id: number; count: number; slot: number }[], batch: readonly KitSpecItem[], alreadyOffered: readonly { id: number; count: number }[]): number[] {
    const offeredCounts = new Map<number, number>();
    for (const o of alreadyOffered) offeredCounts.set(o.id, (offeredCounts.get(o.id) ?? 0) + o.count);
    const needed = new Map<number, number>();
    for (const k of batch) needed.set(k.id, (needed.get(k.id) ?? 0) + k.count);
    const slots: number[] = [];
    for (const [id, want] of needed) {
        if ((offeredCounts.get(id) ?? 0) >= want) continue;
        const hit = inv.find(i => i.id === id);
        if (hit) slots.push(hit.slot);
    }
    return slots;
}

async function serveFastBatch(
    s: Session,
    specialist: string,
    batch: readonly KitSpecItem[],
    t0: number,
    CAP: number,
    stop: () => boolean,
    opts?: { allowedReturnIds?: readonly number[]; exitAfterAbsenceTicks?: number; insideCheck?: () => boolean; primeOnArrival?: boolean },
): Promise<'ok' | 'finished' | 'aborted'> {
    const specLower = specialist.toLowerCase();
    const specReqRe = new RegExp('^' + specialist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+wishes to trade', 'i');
    const allowedReturns = new Set(opts?.allowedReturnIds ?? []);
    const acceptReturn = (offer: readonly { id: number; baseId?: number }[]) =>
        allowedReturns.size === 0 ? offer.length === 0 : offer.every(o => allowedReturns.has(o.baseId ?? resolveBaseId(o.id)));
    const getMsgs = () => s.sdk.getState()?.gameMessages ?? [];
    const startObsId = getMsgs().reduce((mx, m) => Math.max(mx, m.observationId ?? 0), 0);
    let tradeObsBaseline = startObsId, tradeStartTick = s.tick(), lastReqObsId = startObsId, lastReplyTick = -10, sawConfirm = false, closedAfterConfirmTicks = 0, sawSpecialist = false, lastSeenSpecTick = s.tick(), primeRemaining = opts?.primeOnArrival ? 2 : 0, lastPrimeTick = -10;
    const startCounts = new Map(batch.map(k => [k.id, countById(s.sdk.getInventory(), k.id)]));
    const hasTradeMsg = (re: RegExp) => getMsgs().some(m => re.test(m.text) && (m.observationId !== undefined ? m.observationId > tradeObsBaseline : m.tick > tradeStartTick));

    while (!stop() && s.tick() - t0 < CAP) {
        const specNearby = s.sdk.getNearbyPlayers().find(p => p.name.toLowerCase() === specLower);
        if (specNearby && (!opts?.insideCheck || opts.insideCheck())) {
            sawSpecialist = true;
            lastSeenSpecTick = s.tick();
        }
        const ht = s.sdk.getTradeState();
        if (!ht.isOpen) {
            if (sawConfirm) {
                if (hasTradeMsg(/Accepted trade\./i)) return 'ok';
                if (hasTradeMsg(/(?:declined trade|enough inventory space)/i)) {
                    sawConfirm = false;
                    closedAfterConfirmTicks = 0;
                    tradeObsBaseline = getMsgs().reduce((mx, m) => Math.max(mx, m.observationId ?? 0), 0);
                    tradeStartTick = s.tick();
                } else {
                    closedAfterConfirmTicks++;
                    if (closedAfterConfirmTicks >= 3) {
                        if (batch.every(k => countById(s.sdk.getInventory(), k.id) <= (startCounts.get(k.id) ?? 0) - k.count)) return 'ok';
                        sawConfirm = false;
                        closedAfterConfirmTicks = 0;
                    }
                    await waitTicks(s, 1);
                    continue;
                }
            }
            if (opts?.exitAfterAbsenceTicks !== undefined && sawSpecialist && s.tick() - lastSeenSpecTick >= opts.exitAfterAbsenceTicks) return 'finished';
            const reqMsg = [...getMsgs()].reverse().find(m =>
                (m.type === 4 || /wishes to trade/i.test(m.text)) && (m.sender?.toLowerCase() === specLower || specReqRe.test(m.text))
                && ((m.observationId !== undefined && m.observationId > lastReqObsId) || s.tick() - m.tick <= 2));
            if (reqMsg && specNearby && s.tick() - lastReplyTick >= 2) {
                lastReqObsId = Math.max(lastReqObsId, reqMsg.observationId ?? 0);
                lastReplyTick = s.tick();
                primeRemaining = 0;
                tradeObsBaseline = getMsgs().reduce((mx, m) => Math.max(mx, m.observationId ?? 0), 0);
                tradeStartTick = s.tick();
                await s.direct({ type: 'interactPlayer', playerIndex: specNearby.index, optionIndex: 4, reason: 'SDK' });
            } else if (primeRemaining > 0 && specNearby && s.tick() - lastReplyTick >= 2 && s.tick() - lastPrimeTick >= 3 && (primeRemaining === 2 || hasTradeMsg(/is busy at the moment/i))) {
                primeRemaining--;
                lastPrimeTick = s.tick();
                lastReplyTick = s.tick();
                tradeObsBaseline = getMsgs().reduce((mx, m) => Math.max(mx, m.observationId ?? 0), 0);
                tradeStartTick = s.tick();
                await s.direct({ type: 'interactPlayer', playerIndex: specNearby.index, optionIndex: 4, reason: 'SDK' });
            } else if (s.sdk.getState()?.dialog?.isOpen) {
                await s.direct({ type: 'closeModal', reason: 'SDK' });
            }
            await waitTicks(s, 1);
            continue;
        }
        closedAfterConfirmTicks = 0;
        if (ht.partner && ht.partner.toLowerCase() !== specLower) {
            await s.direct({ type: 'closeModal', reason: 'SDK' });
            sawConfirm = false;
            await waitTicks(s, 1);
            continue;
        }
        if (ht.screen === 'confirm') {
            sawConfirm = true;
            if (!acceptReturn(ht.theirOffer)) await s.direct({ type: 'closeModal', reason: 'SDK' });
            else if (!ht.myAccepted) await s.direct({ type: 'clickComponent', componentId: TRADE_CONFIRM_ACCEPT, reason: 'SDK' });
            await waitTicks(s, 1);
            continue;
        }
        const offerSlots = uniqueSlotsForBatch(s.sdk.getInventory(), batch, ht.myOffer);
        const maxOffers = offerSlots.length > 4 ? 5 : 4;
        const toOffer = offerSlots.slice(0, maxOffers);
        const allOffered = offerSlots.length <= toOffer.length;
        const acts: Promise<unknown>[] = [];
        for (const slot of toOffer) acts.push(s.direct({ type: 'clickComponentWithOption', componentId: TRADE_OFFER_INV, optionIndex: 4, slot, reason: 'SDK' }));
        if (allOffered && toOffer.length <= 4 && acceptReturn(ht.theirOffer)) {
            if (!ht.myAccepted) acts.push(s.direct({ type: 'clickComponent', componentId: TRADE_MAIN_ACCEPT, reason: 'SDK' }));
            if (ht.myAccepted || (toOffer.length <= 3 && ht.partnerAccepted)) {
                sawConfirm = true;
                acts.push(s.direct({ type: 'clickComponent', componentId: TRADE_CONFIRM_ACCEPT, reason: 'SDK' }));
            }
        }
        if (acts.length) await Promise.all(acts);
        await waitTicks(s, 1);
    }
    return 'aborted';
}

async function fallbackRestockAtBank(
    s: Session,
    bankTile: { x: number; z: number; level?: number },
    itemId: number,
    targetCount: number,
    keepIds: ReadonlySet<number>,
    done: () => boolean,
    deadline: number,
    stop: () => boolean,
): Promise<boolean> {
    if (countById(s.sdk.getInventory(), itemId) >= targetCount) return true;
    await moveTo(s, { x: bankTile.x, z: bankTile.z, level: bankTile.level ?? 0 }, 2, stop);
    if (done() || s.tick() >= deadline) return false;
    await openFreshBank(s);
    const seenUnwanted = new Set<number>();
    for (const item of s.sdk.getInventory()) {
        if (item.id === itemId || keepIds.has(item.id) || seenUnwanted.has(item.id)) continue;
        seenUnwanted.add(item.id);
        const current = s.sdk.getInventory().find(i => i.id === item.id);
        if (current) await s.bot.depositItem(current, -1);
    }
    const need = targetCount - countById(s.sdk.getInventory(), itemId);
    if (need > 0) {
        const bankRow = s.sdk.getState()?.bank?.items?.find((i: any) => i.id === itemId);
        if (bankRow && bankRow.count >= 1) {
            await s.bot.withdrawItem(bankRow, Math.min(need, bankRow.count), { asNote: false });
            await waitUntil(s, () => countById(s.sdk.getInventory(), itemId) >= targetCount, { timeoutTicks: 10 });
        }
    }
    await s.bot.closeBank().catch(() => {});
    return countById(s.sdk.getInventory(), itemId) > 0;
}

async function enterAltar(s: Session, talismanId: number, ruinsId: number, stop: () => boolean, inside: () => boolean): Promise<void> {
    while (!stop() && !inside()) {
        const ruins = (s.sdk.getState()?.nearbyLocs ?? []).find(l => l.id === ruinsId || /mysterious ruins/i.test(l.name));
        const talisman = s.sdk.getInventory().find(i => i.id === talismanId);
        if (ruins && talisman) await s.direct({ type: 'useItemOnLoc', itemSlot: talisman.slot, x: ruins.x, z: ruins.z, locId: ruins.id, reason: 'SDK' });
        await waitTicks(s, 1);
    }
}

async function exitPortal(s: Session, stop: () => boolean, inside: () => boolean): Promise<void> {
    while (!stop() && inside()) {
        const portal = (s.sdk.getState()?.nearbyLocs ?? []).find(l => l.id === 2470 || /portal/i.test(l.name));
        if (portal) await s.direct({ type: 'interactLoc', x: portal.x, z: portal.z, locId: portal.id, optionIndex: 1, reason: 'SDK' });
        await waitTicks(s, 1);
    }
}

export async function runSpecialistServe(args: readonly string[], env: Record<string, string | undefined> = process.env): Promise<void> {
    const parsed = parseSupplierCliArgs(args);
    const holder = assertSupplierAccount(parsed.positional[0] ?? '', 'holder');
    const specialist = parsed.positional[1] ?? '';
    if (!specialist || !ACCOUNT_NAME_RE.test(specialist)) {
        throw Error(`usage: specialist-supplier <holder> <specialist> [--kit=${Object.keys(SPECIALIST_KITS).join('|')}] [cap]`);
    }
    const plan = resolveSupplierKitPlan(parsed.kitArg ?? env.SUPPLIER_KIT);
    const CAP = Number(parsed.cap ?? env.CAP ?? (plan.legs.length > 1 ? 6000 : 4000));
    if (!Number.isSafeInteger(CAP) || CAP < 50 || CAP > 50000) throw Error(`invalid CAP: ${CAP}`);
    const serverHost = (readFileSync(join(REPO_ROOT, 'vendor', 'rs-sdk', 'bots', holder, 'bot.env'), 'utf8').match(/^SERVER=(.*)$/m)?.[1] ?? '').trim();
    if (!serverHost) throw Error(`missing SERVER in bot.env for ${holder}`);
    const stopFile = () => existsSync(join(REPO_ROOT, '.practice', `stop-${holder}`)) || (!isLocalServer(serverHost) && existsSync(join(REPO_ROOT, '.practice', 'stop-swarm')));
    const bankTile = { x: parsed.bankX ?? DEFAULT_STAGE_BANK.x, z: parsed.bankZ ?? DEFAULT_STAGE_BANK.z, level: 0 };

    const s = await openBot(holder);
    const stop = () => stopFile();
    try {
        await waitUntil(s, st => (st?.inGame ?? false) && !!st?.player, { timeoutTicks: 20 });
        const t0 = s.tick();
        let activePlan = plan;
        if (!parsed.kitArg && !env.SUPPLIER_KIT) {
            for (const [kName, kItems] of Object.entries(SPECIALIST_KITS)) {
                if (hasExactKit(s.sdk.getInventory(), kItems)) {
                    activePlan = resolveSupplierKitPlan(kName);
                    break;
                }
            }
        }
        const kitName = activePlan.name;
        if (kitName !== 'prayer' && kitName !== 'smithing' && kitName !== 'runecraft' && kitName !== 'crafting' && kitName !== 'herblore' && kitName !== 'magic' && kitName !== 'firemaking' && kitName !== 'agility') {
            const peerRe = exactNameRe(specialist);
            for (let legIdx = 0; legIdx < activePlan.legs.length; legIdx++) {
                const leg = activePlan.legs[legIdx]!;
                const legBank = legIdx === 0 && (parsed.bankX !== undefined || parsed.bankZ !== undefined) ? bankTile : leg.bank;
                const concreteKit = hasExactKit(s.sdk.getInventory(), leg.kit)
                    ? resolveConcreteKit(leg.kit, s.sdk.getInventory())
                    : await withdrawExactKit(s, leg.kit, legBank, stop, !!leg.noted);
                await moveGroundTo(s, leg.handoff, 2, stop);
                const p = s.sdk.getState()!.player!;
                console.log('SUPPLIER_READY ' + JSON.stringify({
                    holder, specialist, kit: activePlan.name, trade: legIdx + 1, totalTrades: activePlan.legs.length, server: serverHost,
                    at: { x: p.worldX, z: p.worldZ, level: p.level }, slots: s.sdk.getInventory().length,
                }));
                const giveList = concreteKit.map(k => ({ item: exactNameRe(k.name), amount: k.count }));
                let handoffDone = false;
                while (!stop() && s.tick() - t0 < CAP && !handoffDone) {
                    const served = await s.bot.serveTrades({
                        from: peerRe, give: giveList, accept: offer => offer.length === 0, maxTrades: 1, tradeTimeout: 60_000, timeout: 30_000,
                        until: () => stop() || s.tick() - t0 >= CAP,
                    });
                    const done = served.trades.find(t => t.success && concreteKit.every(k => countById(t.gave, k.id) === k.count) && t.received.length === 0);
                    if (done) {
                        handoffDone = true;
                        console.log('SUPPLIER_HANDOFF ' + JSON.stringify({
                            holder, specialist, kit: activePlan.name, trade: legIdx + 1, totalTrades: activePlan.legs.length,
                            tick: s.tick() - t0, items: concreteKit.map(k => ({ id: k.id, count: k.count })),
                        }));
                        break;
                    }
                    if (served.trades.length > 0) console.log('WARN supplier trade retry: ' + JSON.stringify(served.trades.map(t => ({ success: t.success, reason: t.reason, message: t.message }))));
                    await waitTicks(s, 1);
                }
                if (!handoffDone) {
                    await finish([s], false, `supplier did not complete ${activePlan.name} trade ${legIdx + 1}/${activePlan.legs.length} within ${CAP} ticks`);
                    return;
                }
            }
            await finish([s], true, `supplied ${specialist} (${activePlan.name}, ${activePlan.legs.length} trade(s)) in ${s.tick() - t0} ticks`);
            return;
        }

        let readyPrinted = false;
        const emitReady = () => {
            if (readyPrinted) return;
            readyPrinted = true;
            const p = s.sdk.getState()!.player!;
            console.log('SUPPLIER_READY ' + JSON.stringify({ holder, specialist, server: serverHost, kit: kitName, at: { x: p.worldX, z: p.worldZ, level: p.level }, slots: s.sdk.getInventory().length }));
        };
        const restock = (bankSpot: { x: number; z: number; level?: number }, itemId: number, count: number, keep: ReadonlySet<number>) =>
            runtimeHooks.restockAtBank
                ? runtimeHooks.restockAtBank(s, bankSpot, itemId, count, keep, () => stop() || s.tick() - t0 >= CAP, t0 + CAP)
                : fallbackRestockAtBank(s, bankSpot, itemId, count, keep, () => stop() || s.tick() - t0 >= CAP, t0 + CAP, stop);

        let allDone = false;
        if (kitName === 'prayer') {
            let delivered = 0;
            while (!stop() && s.tick() - t0 < CAP && delivered < PRAYER_BONES_NEEDED) {
                const need = Math.min(28, PRAYER_BONES_NEEDED - delivered);
                const batch = [invSpec(SPECIALIST_ITEM_IDS.dragon_bones, need)];
                if (!hasExactKit(s.sdk.getInventory(), batch)) await withdrawExactKit(s, batch, bankTile, stop);
                await moveGroundTo(s, LUMBRIDGE_HANDOFF, 2, stop);
                emitReady();
                const res = await serveFastBatch(s, specialist, batch, t0, CAP, stop, { exitAfterAbsenceTicks: 120 });
                if (res === 'ok') delivered += need;
                else if (res === 'finished') { delivered = PRAYER_BONES_NEEDED; break; }
                else break;
            }
            allDone = delivered >= PRAYER_BONES_NEEDED;
        } else if (kitName === 'smithing') {
            const role = parseSupplierRole(args, env);
            let ok = true;
            if (role !== 'runner') {
                const starter = [
                    invSpec(SPECIALIST_ITEM_IDS.hammer, 1),
                    invSpec(SPECIALIST_ITEM_IDS.amulet_of_glory_4, 1),
                    invSpec(SPECIALIST_ITEM_IDS.bronze_bar, 9),
                    invSpec(SPECIALIST_ITEM_IDS.iron_bar, 17),
                ];
                if (!hasExactKit(s.sdk.getInventory(), starter)) await withdrawExactKit(s, starter, bankTile, stop);
                await moveGroundTo(s, LUMBRIDGE_HANDOFF, 2, stop);
                emitReady();
                ok = (await serveFastBatch(s, specialist, starter, t0, CAP, stop)) === 'ok';
            }
            if (ok && role !== 'starter') {
                const runnerIdx = role === 'runner' ? (parsed.runnerIndex ?? 0) : 0;
                const runnerCount = role === 'runner' ? (parsed.runnerCount ?? 1) : 1;
                const runnerBank = role === 'runner' && (parsed.bankX !== undefined || parsed.bankZ !== undefined) ? bankTile : VARROCK_WEST_BANK;
                let idx = runnerIdx, finishedEarly = false;
                while (ok && !stop() && s.tick() - t0 < CAP && idx < SMITHING_RUNNER_QUEUE.length) {
                    const delivery = SMITHING_RUNNER_QUEUE[idx]!;
                    const batch = [invSpec(delivery.barId, delivery.count)];
                    if (!hasExactKit(s.sdk.getInventory(), batch)) await withdrawExactKit(s, batch, idx === runnerIdx ? runnerBank : VARROCK_WEST_BANK, stop);
                    await moveGroundTo(s, VARROCK_WEST_ANVIL, 1, stop);
                    emitReady();
                    const res = await serveFastBatch(s, specialist, batch, t0, CAP, stop, { exitAfterAbsenceTicks: 180 });
                    if (res === 'ok') idx += runnerCount;
                    else if (res === 'finished') { finishedEarly = true; break; }
                    else { ok = false; break; }
                }
                allDone = ok && (finishedEarly || idx >= SMITHING_RUNNER_QUEUE.length);
            } else {
                allDone = ok;
            }
        } else if (kitName === 'runecraft') {
            const role = parseSupplierRole(args, env);
            const insideBody = () => { const p = s.sdk.getState()?.player; return !!p && p.worldZ > 4500 && p.worldX < 2600; };
            let ok = true, readyEmitted = false;
            const markReady = () => { if (!readyEmitted) { readyEmitted = true; emitReady(); } };
            if (role !== 'runner') {
                const starter = [
                    invSpec(SPECIALIST_ITEM_IDS.amulet_of_glory_4, 1, GLORY_IDS.filter(id => id !== SPECIALIST_ITEM_IDS.amulet_of_glory_4)),
                    invSpec(SPECIALIST_ITEM_IDS.air_talisman, 1),
                    invSpec(SPECIALIST_ITEM_IDS.body_talisman, 1),
                    invSpec(SPECIALIST_ITEM_IDS.blankrune, 25),
                ];
                const concreteStarter = hasExactKit(s.sdk.getInventory(), starter) ? resolveConcreteKit(starter, s.sdk.getInventory()) : await withdrawExactKit(s, starter, bankTile, stop);
                await moveGroundTo(s, LUMBRIDGE_HANDOFF, 2, stop);
                markReady();
                ok = (await serveFastBatch(s, specialist, concreteStarter, t0, CAP, stop)) === 'ok';
            }
            if (ok && role !== 'starter') {
                const runnerBank = role === 'runner' && (parsed.bankX !== undefined || parsed.bankZ !== undefined) ? bankTile : EDGEVILLE_BANK;
                const keep = new Set<number>([SPECIALIST_ITEM_IDS.body_talisman]);
                let trips = 0, sawSpecialist = false, autoHasRunnerStock = role === 'runner';
                if (role === 'auto') {
                    await moveTo(s, runnerBank, 2, stop);
                    const bankObs = await openFreshBank(s);
                    autoHasRunnerStock = (bankObs.items.find(i => i.id === SPECIALIST_ITEM_IDS.body_talisman)?.count ?? 0) >= 1
                        && (bankObs.items.find(i => i.id === SPECIALIST_ITEM_IDS.blankrune)?.count ?? 0) >= 1;
                    await s.bot.closeBank().catch(() => {});
                    await waitUntil(s, () => !s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 8 });
                }
                while (autoHasRunnerStock && !stop() && s.tick() - t0 < CAP && trips < 205) {
                    const inv = s.sdk.getInventory();
                    const heldTalisman = countById(inv, SPECIALIST_ITEM_IDS.body_talisman), heldEss = countById(inv, SPECIALIST_ITEM_IDS.blankrune);
                    if (!insideBody() && (heldTalisman < 1 || heldEss < 26)) {
                        if (heldTalisman < 1) {
                            await moveTo(s, trips === 0 ? runnerBank : EDGEVILLE_BANK, 2, stop);
                            const bankObs = await openFreshBank(s);
                            if ((bankObs.items.find(i => i.id === SPECIALIST_ITEM_IDS.body_talisman)?.count ?? 0) < 1) { await s.bot.closeBank().catch(() => {}); break; }
                            const taliItem = s.sdk.getState()?.bank?.items?.find((i: any) => i.id === SPECIALIST_ITEM_IDS.body_talisman);
                            if (taliItem) {
                                await s.bot.withdrawItem(taliItem, 1, { asNote: false });
                                await waitUntil(s, () => countById(s.sdk.getInventory(), SPECIALIST_ITEM_IDS.body_talisman) >= 1, { timeoutTicks: 8 });
                            }
                            await s.bot.closeBank().catch(() => {});
                        }
                        if (countById(s.sdk.getInventory(), SPECIALIST_ITEM_IDS.body_talisman) < 1) break;
                        await restock(trips === 0 ? runnerBank : EDGEVILLE_BANK, SPECIALIST_ITEM_IDS.blankrune, 26, keep);
                    }
                    if (!insideBody() && (countById(s.sdk.getInventory(), SPECIALIST_ITEM_IDS.body_talisman) < 1 || countById(s.sdk.getInventory(), SPECIALIST_ITEM_IDS.blankrune) === 0)) break;
                    if (!insideBody()) {
                        markReady();
                        await moveGroundTo(s, BODY_RUINS, 2, stop);
                        await enterAltar(s, SPECIALIST_ITEM_IDS.body_talisman, 2457, stop, insideBody);
                    }
                    if (countById(s.sdk.getInventory(), SPECIALIST_ITEM_IDS.blankrune) === 0) { await exitPortal(s, stop, insideBody); continue; }
                    markReady();
                    await moveGroundTo(s, BODY_ALTAR_STAND, 0, stop);
                    const batchCount = Math.min(26, countById(s.sdk.getInventory(), SPECIALIST_ITEM_IDS.blankrune));
                    const res = await serveFastBatch(s, specialist, [invSpec(SPECIALIST_ITEM_IDS.blankrune, batchCount)], t0, CAP, stop, {
                        exitAfterAbsenceTicks: 120, insideCheck: insideBody, primeOnArrival: trips > 0,
                    });
                    if (res === 'ok') { sawSpecialist = true; trips++; await exitPortal(s, stop, insideBody); }
                    else if (res === 'finished') { sawSpecialist = true; break; }
                    else { ok = false; break; }
                }
                allDone = ok && (role === 'auto' ? (!autoHasRunnerStock || trips > 0 || sawSpecialist) : (trips > 0 || sawSpecialist));
            } else {
                allDone = ok;
            }
        } else if (kitName === 'herblore') {
            const starterBatch = HERBLORE_STARTER_GIVE.map(g => invSpec(g.id, g.count));
            const notedBatch = HERBLORE_NOTED_SUPPLIES.map(g => invSpec(g.id, g.count));
            if (parsed.batchIndex !== undefined && parsed.batchIndex > 1) throw Error(`herblore --batch=${parsed.batchIndex} out of range (0..1)`);
            let ok = true;
            if (parsed.batchIndex === undefined || parsed.batchIndex === 0) {
                if (!hasExactKit(s.sdk.getInventory(), starterBatch)) await withdrawExactKit(s, starterBatch, bankTile, stop);
                await moveGroundTo(s, LUMBRIDGE_HANDOFF, 2, stop);
                emitReady();
                ok = (await serveFastBatch(s, specialist, starterBatch, t0, CAP, stop)) === 'ok';
            }
            if (ok && (parsed.batchIndex === undefined || parsed.batchIndex === 1)) {
                if (!hasExactKit(s.sdk.getInventory(), notedBatch)) await withdrawExactKit(s, notedBatch, EDGEVILLE_BANK, stop, true);
                await moveGroundTo(s, HERBLORE_BANK_HELPER_SPOT, 2, stop);
                emitReady();
                ok = (await serveFastBatch(s, specialist, notedBatch, t0, CAP, stop)) === 'ok';
            }
            allDone = ok;
        } else if (kitName === 'crafting') {
            const batchIndices = parsed.batchIndex !== undefined ? [parsed.batchIndex] : CRAFTING_BATCHES.map((_, i) => i);
            let ok = true;
            for (const idx of batchIndices) {
                const specBatch = CRAFTING_BATCHES[idx];
                if (!specBatch) throw Error(`crafting --batch=${idx} out of range (0..${CRAFTING_BATCHES.length - 1})`);
                const batch = specBatch.give.map(g => invSpec(g.id, g.count));
                if (!hasExactKit(s.sdk.getInventory(), batch)) await withdrawExactKit(s, batch, bankTile, stop);
                await moveGroundTo(s, LUMBRIDGE_HANDOFF, 2, stop);
                emitReady();
                ok = (await serveFastBatch(s, specialist, batch, t0, CAP, stop, { allowedReturnIds: specBatch.returnIds })) === 'ok';
                if (!ok || stop() || s.tick() - t0 >= CAP) break;
            }
            allDone = ok;
        } else if (kitName === 'magic') {
            const batchIndices = parsed.batchIndex !== undefined ? [parsed.batchIndex] : MAGIC_BATCHES.map((_, i) => i);
            let ok = true;
            for (const idx of batchIndices) {
                const specBatch = MAGIC_BATCHES[idx];
                if (!specBatch) throw Error(`magic --batch=${idx} out of range (0..${MAGIC_BATCHES.length - 1})`);
                const stand = idx === 0 ? LUMBRIDGE_HANDOFF : LUMBRIDGE_SAFE_SPOT;
                const batch = specBatch.give.map(g => invSpec(g.id, g.count));
                if (!hasExactKit(s.sdk.getInventory(), batch)) await withdrawExactKit(s, batch, bankTile, stop);
                await moveGroundTo(s, stand, 2, stop);
                emitReady();
                ok = (await serveFastBatch(s, specialist, batch, t0, CAP, stop, { allowedReturnIds: specBatch.returnIds })) === 'ok';
                if (!ok || stop() || s.tick() - t0 >= CAP) break;
            }
            allDone = ok;
        } else if (kitName === 'firemaking') {
            if (!runtimeHooks.serveFiremakingSupplier) throw Error('specialist-supplier firemaking runtime handler missing');
            const roleRaw = parseSupplierRole(args, env);
            const role = roleRaw === 'starter' ? 'starter' : roleRaw === 'runner' ? 'runner' : 'all';
            const res = await runtimeHooks.serveFiremakingSupplier(s, specialist, role, () => stop() || s.tick() - t0 >= CAP, {
                onWave1Ready: emitReady,
                tradeWave0: async batch =>
                    (await serveFastBatch(s, specialist, batch.map(b => invSpec(b.id, b.count)), t0, CAP, () => stop() || s.tick() - t0 >= CAP)) === 'ok',
            });
            allDone = res.ok;
        } else if (kitName === 'agility') {
            const batch = AGILITY_SPECIALIST_KIT.map(g => invSpec(g.id, g.count));
            if (!hasExactKit(s.sdk.getInventory(), batch)) await withdrawExactKit(s, batch, bankTile, stop);
            await moveGroundTo(s, LUMBRIDGE_HANDOFF, 2, stop);
            emitReady();
            allDone = (await serveFastBatch(s, specialist, batch, t0, CAP, stop)) === 'ok';
        } else {
            throw Error(`unhandled serve kit: ${kitName}`);
        }

        if (allDone) {
            const kit = resolveSupplierKit(kitName);
            console.log('SUPPLIER_HANDOFF ' + JSON.stringify({ holder, specialist, kit: kitName, tick: s.tick() - t0, items: kit.map(k => ({ id: k.id, count: k.count })) }));
        }
        await finish([s], allDone, allDone ? `supplied ${kitName} for ${specialist} in ${s.tick() - t0} ticks` : `supplier did not complete ${kitName} handoff within ${CAP} ticks`);
    } catch (e) {
        await finish([s], false, String(e));
    }
}

export async function runSpecialistStage(args: readonly string[], env: Record<string, string | undefined> = process.env): Promise<void> {
    const parsed = parseSupplierCliArgs(args.filter(a => a !== '--stage'));
    const bx = parsed.bankX ?? DEFAULT_STAGE_BANK.x, bz = parsed.bankZ ?? DEFAULT_STAGE_BANK.z;
    const donor = assertSupplierAccount(parsed.positional[0] ?? '', 'donor');
    const holder = assertSupplierAccount(parsed.positional[1] ?? '', 'holder');
    if (donor.toLowerCase() === holder.toLowerCase()) throw Error('donor and holder must be different accounts');
    if (!parsed.outArg) throw Error(`usage: specialist-supplier --stage <donor> <holder> [--kit=${Object.keys(SPECIALIST_KITS).join('|')}] --out=<.practice-dir>`);
    const plan = resolveSupplierKitPlan(parsed.kitArg ?? env.SUPPLIER_KIT);
    const allowNoted = plan.legs.length === 1 && kitSlotTotal(plan.combined) > 28;
    const outDir = resolve(REPO_ROOT, parsed.outArg), relOut = relative(REPO_ROOT, outDir).replaceAll('\\', '/');
    if (!relOut.startsWith('.practice/') || relOut.includes('..')) throw Error('--out must be inside .practice/');
    mkdirSync(outDir, { recursive: true });

    const bankTile = { x: bx, z: bz, level: 0 };
    const server = (readFileSync(join(REPO_ROOT, 'vendor', 'rs-sdk', 'bots', holder, 'bot.env'), 'utf8').match(/^SERVER=(.*)$/m)?.[1] ?? '').trim();
    const donorSession = await openBot(donor), holderSession = await openBot(holder);
    const stop = () => existsSync(join(REPO_ROOT, '.practice', `stop-${donor}`)) || existsSync(join(REPO_ROOT, '.practice', `stop-${holder}`)) || (!isLocalServer(server) && existsSync(join(REPO_ROOT, '.practice', 'stop-swarm')));
    try {
        await Promise.all([
            waitUntil(donorSession, st => (st?.inGame ?? false) && !!st?.player, { timeoutTicks: 20 }),
            waitUntil(holderSession, st => (st?.inGame ?? false) && !!st?.player, { timeoutTicks: 20 }),
        ]);
        await Promise.all([moveTo(donorSession, bankTile, 2, stop), moveTo(holderSession, bankTile, 2, stop)]);
        await openFreshBank(holderSession);
        await depositAllInventory(holderSession);
        await holderSession.bot.closeBank();
        await waitUntil(holderSession, () => !holderSession.sdk.getState()?.bank?.isOpen, { timeoutTicks: 8 });
        let lastTransferAt = Date.now();
        const legFiles: string[] = [], legReceipts: ReturnType<typeof buildLegDeliveryReceipt>[] = [];
        for (let legIdx = 0; legIdx < plan.legs.length; legIdx++) {
            const leg = plan.legs[legIdx]!;
            const legBefore = holderSession.sdk.getInventory().map(i => ({ id: resolveBaseId(i.id), count: i.count }));
            const concreteKit = hasExactKit(donorSession.sdk.getInventory(), leg.kit)
                ? resolveConcreteKit(leg.kit, donorSession.sdk.getInventory())
                : await withdrawExactKit(donorSession, leg.kit, bankTile, stop, allowNoted || !!leg.noted);
            const giveList = concreteKit.map(k => ({ item: exactNameRe(k.name), amount: k.count }));
            const allowed = new Set(concreteKit.map(k => resolveBaseId(k.id)));
            const [served, given] = await Promise.all([
                holderSession.bot.serveTrades({
                    from: exactNameRe(donor),
                    accept: offer => offer.every(o => allowed.has(resolveBaseId(o.id))) && concreteKit.every(k => countById(offer, k.id) === k.count),
                    maxTrades: 1,
                    timeout: 60_000,
                }),
                donorSession.bot.trade(exactNameRe(holder), { give: giveList, accept: offer => offer.length === 0, requestTimeout: 20_000, timeout: 60_000 }),
            ]);
            const rx = served.trades.find(t => t.success);
            if (!given.success || !rx || !concreteKit.every(k => countById(rx.received, k.id) === k.count)) {
                throw Error(`stage transfer mismatch (${plan.name} leg ${legIdx + 1}): given=${given.success} rx=${!!rx}`);
            }
            await waitUntil(holderSession, () => hasExactKit(holderSession.sdk.getInventory(), concreteKit), { timeoutTicks: 10 });
            const legAfter = holderSession.sdk.getInventory().map(i => ({ id: resolveBaseId(i.id), count: i.count }));
            lastTransferAt = Date.now();
            for (const spec of concreteKit) if (countById(legAfter, spec.id) - countById(legBefore, spec.id) !== spec.count) throw Error(`recipient delta mismatch (${plan.name} leg ${legIdx + 1}) for ${spec.name}`);
            const receipt = buildLegDeliveryReceipt({ kitName: plan.name, leg: legIdx + 1, totalLegs: plan.legs.length, server, from: donor, to: holder, at: lastTransferAt, before: legBefore, after: legAfter, kit: concreteKit });
            legReceipts.push(receipt);
            if (plan.legs.length > 1) {
                const legFile = `delivery-leg${legIdx + 1}.json`;
                legFiles.push(legFile);
                writeFileSync(join(outDir, legFile), JSON.stringify(receipt, null, 2) + '\n');
            }
            await openFreshBank(holderSession);
            await depositAllInventory(holderSession);
            await holderSession.bot.closeBank();
            await waitUntil(holderSession, () => !holderSession.sdk.getState()?.bank?.isOpen, { timeoutTicks: 8 });
        }
        const bankObs = await openFreshBank(holderSession);
        await holderSession.bot.closeBank();
        const bankAt = bankObs.at;
        if (bankAt < lastTransferAt) throw Error(`bank observation (${bankAt}) older than transfer (${lastTransferAt})`);
        if (!hasAtLeastKit(bankObs.items, plan.combined)) throw Error(`holder final bank observation lacks full ${plan.name} kit`);
        const primaryDelivery = plan.legs.length > 1 ? { ...legReceipts[0]!, legs: legFiles } : legReceipts[0]!;
        const bank = { name: holder, server, bankAt, bank: bankObs.items.map(i => ({ id: i.id, count: i.count })) };
        writeFileSync(join(outDir, 'delivery.json'), JSON.stringify(primaryDelivery, null, 2) + '\n');
        writeFileSync(join(outDir, 'bank.json'), JSON.stringify(bank, null, 2) + '\n');
        console.log('SPECIALIST_STAGED ' + JSON.stringify({ out: relOut, kit: plan.name, legs: legFiles, donor, holder, transferAt: lastTransferAt, bankAt }));
        await finish([donorSession, holderSession], true, `staged ${plan.name} kit from ${donor} to ${holder} into ${relOut}`);
    } catch (e) {
        await finish([donorSession, holderSession], false, String(e));
    }
}

export async function runGatheringSupplierServe(args: readonly string[], env: Record<string, string | undefined> = process.env): Promise<void> {
    if (args.includes('--stage')) {
        await runSpecialistStage(args, env);
        return;
    }
    const kitSpec = parseKitOption(args);
    const positional = args.filter(a => !a.startsWith('--'));
    const holder = assertSupplierAccount(positional[0] ?? '', 'holder');
    const specialist = (positional[1] ?? '').trim();
    if (!specialist) throw Error('usage: gathering-supplier <holder> <specialist> [--kit=fletching|fletching-live|fishing|mining|mining-live|thieving|thieving-live] [cap]');
    const capArg = positional.slice(2).find(a => /^\d+$/.test(a));
    const CAP = Number(capArg ?? env.CAP ?? (kitSpec ? 1500 : 600));
    if (!Number.isSafeInteger(CAP) || CAP < 50 || CAP > 50000) throw Error(`invalid CAP: ${CAP}`);
    const serverHost = (readFileSync(join(REPO_ROOT, 'vendor', 'rs-sdk', 'bots', holder, 'bot.env'), 'utf8').match(/^SERVER=(.*)$/m)?.[1] ?? '').trim();
    if (!serverHost) throw Error(`missing SERVER in bot.env for ${holder}`);
    const stopFile = () => existsSync(join(REPO_ROOT, '.practice', `stop-${holder}`)) || (!isLocalServer(serverHost) && existsSync(join(REPO_ROOT, '.practice', 'stop-swarm')));

    const s = await openBot(holder);
    const t0 = s.tick();
    const stop = () => stopFile() || s.tick() - t0 >= CAP;
    let handoffDone = false;
    try {
        await waitUntil(s, st => (st?.inGame ?? false) && !!st?.player, { timeoutTicks: 20 });
        if (kitSpec && !hasExactKit(s.sdk.getInventory(), kitSpec.kit)) await withdrawExactKit(s, kitSpec.kit, DEFAULT_STAGE_BANK, stop);
        const kit = s.sdk.getInventory().map(i => i.id);
        if (kit.length === 0) throw Error(`${holder} carries no kit to hand over`);
        const p = s.sdk.getState()?.player;
        const dist = p ? Math.max(Math.abs(p.worldX - GATHERING_HELPER_SPAWN.x), Math.abs(p.worldZ - GATHERING_HELPER_SPAWN.z)) : Infinity;
        if (!p || p.level !== 0 || dist > 2) await moveGroundTo(s, GATHERING_HELPER_SPAWN, 2, stop, 240);
        const at = s.sdk.getState()!.player!;
        console.log('SUPPLIER_READY ' + JSON.stringify({
            holder, specialist, ...(kitSpec ? { kit: kitSpec.name } : {}), server: serverHost,
            at: { x: at.worldX, z: at.worldZ, level: at.level }, slots: kit.length,
        }));
        if (!runtimeHooks.startHelperTradeArm) throw Error('gathering-supplier helper trade arm runtime missing');
        const arm = runtimeHooks.startHelperTradeArm(s, specialist, stop);
        try {
            while (!stop() && !handoffDone) {
                if (s.sdk.getInventory().length === 0 && !s.sdk.getTradeState().isOpen) {
                    handoffDone = true;
                    console.log('SUPPLIER_HANDOFF ' + JSON.stringify({ holder, specialist, ...(kitSpec ? { kit: kitSpec.name } : {}), tick: s.tick() - t0, items: kit.length }));
                    break;
                }
                await waitTicks(s, 1);
            }
        } finally {
            arm.close();
        }
        await finish([s], handoffDone, handoffDone ? `supplied ${specialist} in ${s.tick() - t0} ticks` : `supplier did not complete handoff within ${CAP} ticks`);
    } catch (e) {
        await finish([s], false, String(e));
    }
}
