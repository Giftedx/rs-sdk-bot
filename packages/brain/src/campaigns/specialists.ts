import { levelForXp, xpForLevel } from '../../../core/src/xp-curve';
import { RESERVED_ACCOUNTS, SPECIALIST_BOARDS } from '../../../core/src/specialist-boards';
import type { Campaign, CampaignSupplyRequirement } from '../contracts';

export interface SpecialistCampaignSpec {
    readonly account: string;
    readonly board: string;
    readonly category: number;
    readonly protectedClock: true;
    readonly status: 'reserved' | 'retired';
    readonly script: string;
    readonly defaultArgs?: readonly string[];
    readonly defaultEnv?: Readonly<Record<string, string>>;
    readonly planTicks?: number;
    readonly weight: number;
    readonly defaultStagingHolder: string | null;
    readonly defaultRehearsalReportPath?: string;
    readonly requiredSupplies: readonly CampaignSupplyRequirement[];
}

function supply(
    itemId: number,
    itemName: string,
    count: number,
    stage: string,
): CampaignSupplyRequirement {
    return { itemId, itemName, count, stage };
}

function firemakingSupplyRequirements(stage = 'Firemaking'): readonly CampaignSupplyRequirement[] {
    const tiers = [
        { itemId: 1511, itemName: 'Logs', reqLevel: 1, xp25x: 1000 },
        { itemId: 1521, itemName: 'Oak logs', reqLevel: 15, xp25x: 1500 },
        { itemId: 1519, itemName: 'Willow logs', reqLevel: 30, xp25x: 2250 },
        { itemId: 1517, itemName: 'Maple logs', reqLevel: 45, xp25x: 3375 },
        { itemId: 1515, itemName: 'Yew logs', reqLevel: 60, xp25x: 5062.5 },
        { itemId: 1513, itemName: 'Magic logs', reqLevel: 75, xp25x: 7595 },
    ] as const;
    const goalXp = xpForLevel(99);
    const counts = new Map<number, { itemName: string; count: number }>();
    let xp = 0;
    let idx = 0;
    while (xp < goalXp + 25 && idx < 165) {
        const lvl = levelForXp(xp);
        let tier: (typeof tiers)[number] = tiers[0];
        for (let i = tiers.length - 1; i >= 0; i--) {
            if (lvl >= tiers[i]!.reqLevel) {
                tier = tiers[i]!;
                break;
            }
        }
        const prev = counts.get(tier.itemId);
        if (prev) prev.count += 1;
        else counts.set(tier.itemId, { itemName: tier.itemName, count: 1 });
        xp += tier.xp25x;
        idx++;
        if (xp >= goalXp && idx >= 157 && xp < goalXp + 10) {
            continue;
        }
        if (xp >= goalXp) break;
    }
    return [...counts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([itemId, info]) => supply(itemId, info.itemName, info.count, stage));
}

const MELEE_PVP_SPECIALIST_SUPPLIES = (stage: string): readonly CampaignSupplyRequirement[] => [
    supply(385, 'Shark', 1, stage),
    supply(536, 'Dragon bones', 11, stage),
    supply(555, 'Water rune', 6, stage),
    supply(556, 'Air rune', 6, stage),
    supply(557, 'Earth rune', 6, stage),
    supply(954, 'Rope', 1, stage),
    supply(1319, 'Rune 2h sword', 1, stage),
    supply(1725, 'Amulet of strength', 1, stage),
    supply(2434, 'Prayer potion(4)', 2, stage),
    supply(2552, 'Ring of dueling(8)', 1, stage),
];

/**
 * Declarative launch specifications for all 19 reserved specialist accounts
 * (replacing ad-hoc `.practice/specialist-launch/*.ts` and `.json` scripts).
 */
export const SPECIALIST_CAMPAIGN_SPECS: readonly SpecialistCampaignSpec[] = [
    {
        account: 'hiltsdeep',
        board: SPECIALIST_BOARDS.hiltsdeep!.name,
        category: SPECIALIST_BOARDS.hiltsdeep!.category,
        protectedClock: true,
        status: 'reserved',
        script: 'scripts/attack-specialist.ts',
        defaultEnv: { CAP: '5000' },
        planTicks: 3815,
        weight: 1.0,
        defaultStagingHolder: 'Quickhandjob',
        defaultRehearsalReportPath: '.practice/specialist-launch/rehearsal-live-3/hiltsdeep-attack-99.receipt.json',
        requiredSupplies: [
            supply(379, 'Lobster', 2, 'Attack'),
            supply(536, 'Dragon bones', 11, 'Attack'),
            supply(556, 'Air rune', 1300, 'Attack'),
            supply(558, 'Mind rune', 50, 'Attack'),
            supply(562, 'Chaos rune', 240, 'Attack'),
            supply(563, 'Law rune', 30, 'Attack'),
            supply(995, 'Coins', 200, 'Attack'),
            supply(1387, 'Staff of fire', 1, 'Attack'),
            supply(1511, 'Logs', 6, 'Attack'),
            supply(2434, 'Prayer potion(4)', 3, 'Attack'),
        ],
    },
    {
        account: 'rocksolid',
        board: SPECIALIST_BOARDS.rocksolid!.name,
        category: SPECIALIST_BOARDS.rocksolid!.category,
        protectedClock: true,
        status: 'reserved',
        script: 'scripts/defence-specialist.ts',
        weight: 1.0,
        defaultStagingHolder: null,
        requiredSupplies: MELEE_PVP_SPECIALIST_SUPPLIES('Defence'),
    },
    {
        account: 'bigswinger',
        board: SPECIALIST_BOARDS.bigswinger!.name,
        category: SPECIALIST_BOARDS.bigswinger!.category,
        protectedClock: true,
        status: 'reserved',
        script: 'scripts/strength-specialist.ts',
        weight: 1.0,
        defaultStagingHolder: null,
        requiredSupplies: MELEE_PVP_SPECIALIST_SUPPLIES('Strength'),
    },
    {
        account: 'fullblooded',
        board: SPECIALIST_BOARDS.fullblooded!.name,
        category: SPECIALIST_BOARDS.fullblooded!.category,
        protectedClock: true,
        status: 'reserved',
        script: 'scripts/hp-specialist.ts',
        defaultEnv: { CAP: '12000' },
        planTicks: 8900,
        weight: 1.0,
        defaultStagingHolder: 'Woodenstaff',
        defaultRehearsalReportPath: '.practice/specialist-launch/rehearsal-hp/fullblooded-hitpoints.receipt.json',
        requiredSupplies: [
            supply(386, 'Shark', 20, 'Hitpoints'),
            supply(536, 'Dragon bones', 11, 'Hitpoints'),
            supply(555, 'Water rune', 35, 'Hitpoints'),
            supply(556, 'Air rune', 2500, 'Hitpoints'),
            supply(558, 'Mind rune', 140, 'Hitpoints'),
            supply(560, 'Death rune', 220, 'Hitpoints'),
            supply(562, 'Chaos rune', 220, 'Hitpoints'),
            supply(563, 'Law rune', 60, 'Hitpoints'),
            supply(995, 'Coins', 5000, 'Hitpoints'),
            supply(1059, 'Leather gloves', 1, 'Hitpoints'),
            supply(1387, 'Staff of fire', 1, 'Hitpoints'),
            supply(1512, 'Logs', 6, 'Hitpoints'),
            supply(1760, 'Ball of wool', 1, 'Hitpoints'),
            supply(1985, 'Cheese', 1, 'Hitpoints'),
            supply(2358, 'Gold bar', 1, 'Hitpoints'),
            supply(2435, 'Prayer potion(4)', 18, 'Hitpoints'),
            supply(2449, 'Superantipoison(4)', 2, 'Hitpoints'),
            supply(2552, 'Ring of dueling(8)', 1, 'Hitpoints'),
        ],
    },
    {
        account: 'shaftshooter',
        board: SPECIALIST_BOARDS.shaftshooter!.name,
        category: SPECIALIST_BOARDS.shaftshooter!.category,
        protectedClock: true,
        status: 'reserved',
        script: 'scripts/ranged-specialist.ts',
        defaultArgs: ['--live'],
        planTicks: 4660,
        weight: 1.0,
        defaultStagingHolder: 'Shaftsinker',
        defaultRehearsalReportPath: '.practice/specialist-launch/rehearsal-ranged/shaftshooter-ranged.receipt.json',
        requiredSupplies: [
            supply(2, 'Cannonball', 1500, 'Ranged'),
            supply(6, 'Cannon base', 1, 'Ranged'),
            supply(8, 'Cannon stand', 1, 'Ranged'),
            supply(10, 'Cannon barrels', 1, 'Ranged'),
            supply(12, 'Cannon furnace', 1, 'Ranged'),
            supply(175, 'Antipoison(3)', 8, 'Ranged'),
            supply(379, 'Lobster', 5, 'Ranged'),
            supply(536, 'Dragon bones', 11, 'Ranged'),
            supply(841, 'Shortbow', 1, 'Ranged'),
            supply(861, 'Magic shortbow', 1, 'Ranged'),
            supply(884, 'Iron arrow', 300, 'Ranged'),
            supply(892, 'Rune arrow', 1000, 'Ranged'),
            supply(1129, 'Leather body', 1, 'Ranged'),
            supply(2434, 'Prayer potion(4)', 8, 'Ranged'),
            supply(2491, 'Dragon vambraces', 1, 'Ranged'),
            supply(2497, 'Dragonhide chaps', 1, 'Ranged'),
            supply(2552, 'Ring of dueling(8)', 1, 'Ranged'),
        ],
    },
    {
        account: 'bigboner',
        board: SPECIALIST_BOARDS.bigboner!.name,
        category: SPECIALIST_BOARDS.bigboner!.category,
        protectedClock: true,
        status: 'reserved',
        script: 'scripts/prayer-specialist.ts',
        planTicks: 1213,
        weight: 1.0,
        defaultStagingHolder: null,
        requiredSupplies: [supply(536, 'Dragon bones', 555, 'Prayer')],
    },
    {
        account: 'castmyload',
        board: SPECIALIST_BOARDS.castmyload!.name,
        category: SPECIALIST_BOARDS.castmyload!.category,
        protectedClock: true,
        status: 'reserved',
        script: 'scripts/magic-specialist.ts',
        planTicks: 1170,
        weight: 1.0,
        defaultStagingHolder: null,
        requiredSupplies: [
            supply(385, 'Shark', 3, 'Magic'),
            supply(536, 'Dragon bones', 8, 'Magic'),
            supply(555, 'Water rune', 20, 'Magic'),
            supply(556, 'Air rune', 1500, 'Magic'),
            supply(557, 'Earth rune', 400, 'Magic'),
            supply(558, 'Mind rune', 25, 'Magic'),
            supply(563, 'Law rune', 12, 'Magic'),
            supply(564, 'Cosmic rune', 150, 'Magic'),
            supply(565, 'Blood rune', 850, 'Magic'),
            supply(946, 'Knife', 1, 'Magic'),
            supply(1387, 'Staff of fire', 1, 'Magic'),
            supply(1637, 'Sapphire ring', 12, 'Magic'),
            supply(1639, 'Emerald ring', 27, 'Magic'),
            supply(1641, 'Ruby ring', 72, 'Magic'),
            supply(1643, 'Diamond ring', 36, 'Magic'),
            supply(1727, 'Amulet of magic', 1, 'Magic'),
            supply(2434, 'Prayer potion(4)', 2, 'Magic'),
        ],
    },
    {
        account: 'saltysausage',
        board: SPECIALIST_BOARDS.saltysausage!.name,
        category: SPECIALIST_BOARDS.saltysausage!.category,
        protectedClock: true,
        status: 'reserved',
        script: 'scripts/cooking-specialist.ts',
        weight: 1.0,
        defaultStagingHolder: null,
        requiredSupplies: [
            supply(1996, 'Unfermented wine', 6000, 'Cooking'),
            supply(2082, 'Unfinished cocktail', 4, 'Cooking'),
            supply(2106, 'Lemon slices', 4, 'Cooking'),
            supply(2552, 'Ring of dueling(8)', 1, 'Cooking'),
        ],
    },
    {
        account: 'morningwood',
        board: SPECIALIST_BOARDS.morningwood!.name,
        category: SPECIALIST_BOARDS.morningwood!.category,
        protectedClock: true,
        status: 'reserved',
        script: 'scripts/woodcutting-specialist.ts',
        weight: 1.0,
        defaultStagingHolder: null,
        requiredSupplies: [
            supply(536, 'Dragon bones', 11, 'Woodcutting'),
            supply(542, "Monk's robe", 1, 'Woodcutting'),
            supply(544, "Monk's robe", 1, 'Woodcutting'),
            supply(556, 'Air rune', 150, 'Woodcutting'),
            supply(558, 'Mind rune', 150, 'Woodcutting'),
            supply(946, 'Knife', 1, 'Woodcutting'),
            supply(1359, 'Rune axe', 1, 'Woodcutting'),
            supply(1511, 'Logs', 1, 'Woodcutting'),
            supply(1712, 'Amulet of glory(4)', 1, 'Woodcutting'),
            supply(1718, 'Holy symbol', 1, 'Woodcutting'),
            supply(2434, 'Prayer potion(4)', 4, 'Woodcutting'),
        ],
    },
    {
        account: 'tipmyshaft',
        board: SPECIALIST_BOARDS.tipmyshaft!.name,
        category: SPECIALIST_BOARDS.tipmyshaft!.category,
        protectedClock: true,
        status: 'reserved',
        script: 'scripts/fletching-specialist.ts',
        weight: 1.0,
        defaultStagingHolder: null,
        requiredSupplies: [
            supply(39, 'Bronze arrowtips', 60, 'Fletching'),
            supply(40, 'Iron arrowtips', 90, 'Fletching'),
            supply(41, 'Steel arrowtips', 135, 'Fletching'),
            supply(42, 'Mithril arrowtips', 225, 'Fletching'),
            supply(43, 'Adamant arrowtips', 495, 'Fletching'),
            supply(44, 'Rune arrowtips', 2595, 'Fletching'),
            supply(53, 'Headless arrow', 3600, 'Fletching'),
        ],
    },
    {
        account: 'lochnessrod',
        board: SPECIALIST_BOARDS.lochnessrod!.name,
        category: SPECIALIST_BOARDS.lochnessrod!.category,
        protectedClock: true,
        status: 'reserved',
        script: 'scripts/fishing-specialist.ts',
        planTicks: 2915,
        weight: 1.0,
        defaultStagingHolder: 'Moneyshot',
        defaultRehearsalReportPath: '.practice/specialist-launch/rehearsal-fishing/lochnessrod-fishing-99.receipt.json',
        requiredSupplies: [
            supply(303, 'Small fishing net', 1, 'Fishing'),
            supply(307, 'Fishing rod', 1, 'Fishing'),
            supply(309, 'Fly fishing rod', 1, 'Fishing'),
            supply(313, 'Fishing bait', 60, 'Fishing'),
            supply(314, 'Feather', 1500, 'Fishing'),
            supply(946, 'Knife', 1, 'Fishing'),
            supply(1511, 'Logs', 5, 'Fishing'),
            supply(1712, 'Amulet of glory(4)', 1, 'Fishing'),
        ],
    },
    {
        account: 'lightmylog',
        board: SPECIALIST_BOARDS.lightmylog!.name,
        category: SPECIALIST_BOARDS.lightmylog!.category,
        protectedClock: true,
        status: 'reserved',
        script: 'scripts/firemaking-specialist.ts',
        weight: 1.0,
        defaultStagingHolder: null,
        requiredSupplies: firemakingSupplyRequirements('Firemaking'),
    },
    {
        account: 'cutmyjewels',
        board: SPECIALIST_BOARDS.cutmyjewels!.name,
        category: SPECIALIST_BOARDS.cutmyjewels!.category,
        protectedClock: true,
        status: 'reserved',
        script: 'scripts/crafting-specialist.ts',
        weight: 1.0,
        defaultStagingHolder: null,
        requiredSupplies: [
            supply(1617, 'Uncut diamond', 9, 'Crafting'),
            supply(1619, 'Uncut ruby', 3, 'Crafting'),
            supply(1621, 'Uncut emerald', 6, 'Crafting'),
            supply(1623, 'Uncut sapphire', 3, 'Crafting'),
            supply(1625, 'Uncut opal', 18, 'Crafting'),
            supply(1631, 'Uncut dragonstone', 277, 'Crafting'),
            supply(1755, 'Chisel', 1, 'Crafting'),
        ],
    },
    {
        account: 'steelrod',
        board: SPECIALIST_BOARDS.steelrod!.name,
        category: SPECIALIST_BOARDS.steelrod!.category,
        protectedClock: true,
        status: 'reserved',
        script: 'scripts/smithing-specialist.ts',
        planTicks: 1230,
        weight: 1.0,
        defaultStagingHolder: null,
        requiredSupplies: [
            supply(1712, 'Amulet of glory(4)', 1, 'Smithing'),
            supply(2347, 'Hammer', 1, 'Smithing'),
            supply(2349, 'Bronze bar', 9, 'Smithing'),
            supply(2351, 'Iron bar', 42, 'Smithing'),
            supply(2353, 'Steel bar', 100, 'Smithing'),
            supply(2359, 'Mithril bar', 275, 'Smithing'),
            supply(2361, 'Adamantite bar', 375, 'Smithing'),
        ],
    },
    {
        account: 'mineshafted',
        board: SPECIALIST_BOARDS.mineshafted!.name,
        category: SPECIALIST_BOARDS.mineshafted!.category,
        protectedClock: true,
        status: 'reserved',
        script: 'scripts/mining-specialist.ts',
        defaultArgs: ['--live'],
        planTicks: 3830,
        weight: 1.0,
        defaultStagingHolder: 'Moneyshot',
        defaultRehearsalReportPath: '.practice/specialist-launch/rehearsal-mining/mineshafted-mining-99.receipt.json',
        requiredSupplies: [
            supply(434, 'Clay', 6, 'Mining'),
            supply(436, 'Copper ore', 4, 'Mining'),
            supply(440, 'Iron ore', 2, 'Mining'),
            supply(946, 'Knife', 1, 'Mining'),
            supply(1275, 'Rune pickaxe', 1, 'Mining'),
            supply(1511, 'Logs', 2, 'Mining'),
            supply(1712, 'Amulet of glory(4)', 1, 'Mining'),
            supply(2552, 'Ring of dueling(8)', 1, 'Mining'),
        ],
    },
    {
        account: 'grindmyherb',
        board: SPECIALIST_BOARDS.grindmyherb!.name,
        category: SPECIALIST_BOARDS.grindmyherb!.category,
        protectedClock: true,
        status: 'reserved',
        script: 'scripts/herblore-specialist.ts',
        weight: 1.0,
        defaultStagingHolder: null,
        requiredSupplies: [
            supply(97, 'Harralander potion (unf)', 10, 'Herblore'),
            supply(101, 'Irit potion (unf)', 10, 'Herblore'),
            supply(105, 'Kwuarm potion (unf)', 30, 'Herblore'),
            supply(111, 'Torstol potion (unf)', 170, 'Herblore'),
            supply(221, 'Eye of newt', 10, 'Herblore'),
            supply(225, 'Limpwurt root', 10, 'Herblore'),
            supply(241, 'Dragon scale dust', 50, 'Herblore'),
            supply(247, 'Jangerberries', 170, 'Herblore'),
            supply(1712, 'Amulet of glory(4)', 1, 'Herblore'),
            supply(1975, 'Chocolate dust', 10, 'Herblore'),
            supply(2132, 'Raw beef', 1, 'Herblore'),
            supply(2134, 'Raw rat meat', 1, 'Herblore'),
            supply(2136, 'Raw bear meat', 1, 'Herblore'),
            supply(2138, 'Raw chicken', 1, 'Herblore'),
            supply(2483, 'Lantadyme potion (unf)', 30, 'Herblore'),
            supply(3853, 'Games necklace(8)', 1, 'Herblore'),
        ],
    },
    {
        account: 'polevaulter',
        board: SPECIALIST_BOARDS.polevaulter!.name,
        category: SPECIALIST_BOARDS.polevaulter!.category,
        protectedClock: true,
        status: 'reserved',
        script: 'scripts/agility-specialist.ts',
        defaultEnv: { AGI_ROUTE: 'monkeybars', AGI_POTION: '1', AGI_PRAY: '1' },
        planTicks: 5913,
        weight: 1.0,
        defaultStagingHolder: null,
        requiredSupplies: [
            supply(536, 'Dragon bones', 11, 'Agility'),
            supply(995, 'Coins', 500, 'Agility'),
            supply(1712, 'Amulet of glory(4)', 1, 'Agility'),
            supply(1897, 'Chocolate cake', 4, 'Agility'),
            supply(2434, 'Prayer potion(4)', 3, 'Agility'),
            supply(3032, 'Agility potion(4)', 6, 'Agility'),
        ],
    },
    {
        account: 'stickyfinger',
        board: SPECIALIST_BOARDS.stickyfinger!.name,
        category: SPECIALIST_BOARDS.stickyfinger!.category,
        protectedClock: true,
        status: 'reserved',
        script: 'scripts/thieving-specialist.ts',
        defaultArgs: ['--live'],
        planTicks: 2142,
        weight: 1.0,
        defaultStagingHolder: null,
        requiredSupplies: [
            supply(1897, 'Chocolate cake', 26, 'Thieving'),
            supply(2552, 'Ring of dueling(8)', 1, 'Thieving'),
        ],
    },
    {
        account: 'pouchstuffed',
        board: SPECIALIST_BOARDS.pouchstuffed!.name,
        category: SPECIALIST_BOARDS.pouchstuffed!.category,
        protectedClock: true,
        status: 'reserved',
        script: 'scripts/runecraft-specialist.ts',
        planTicks: 2155,
        weight: 1.0,
        defaultStagingHolder: null,
        requiredSupplies: [
            supply(1436, 'Rune essence', 5355, 'Runecraft'),
            supply(1438, 'Air talisman', 1, 'Runecraft'),
            supply(1446, 'Body talisman', 1, 'Runecraft'),
            supply(1712, 'Amulet of glory(4)', 1, 'Runecraft'),
        ],
    },
];

/**
 * Retired specialist launches recorded in `.practice/specialist-launch/` that keep
 * protected clocks offline (`RESERVED_ACCOUNTS`).
 */
export const RETIRED_SPECIALIST_CAMPAIGN_SPECS: readonly SpecialistCampaignSpec[] = [
    {
        account: 'justthetip',
        board: 'Fletching',
        category: 10,
        protectedClock: true,
        status: 'retired',
        script: 'scripts/fletching-specialist.ts',
        planTicks: 54,
        weight: 1.0,
        defaultStagingHolder: 'Moneyshot',
        defaultRehearsalReportPath: '.practice/specialist-launch/rehearsal-fletching/justthetip-fletching-99.receipt.json',
        requiredSupplies: [
            supply(39, 'Bronze arrowtips', 75, 'Fletching'),
            supply(40, 'Iron arrowtips', 105, 'Fletching'),
            supply(41, 'Steel arrowtips', 150, 'Fletching'),
            supply(42, 'Mithril arrowtips', 240, 'Fletching'),
            supply(43, 'Adamant arrowtips', 510, 'Fletching'),
            supply(44, 'Rune arrowtips', 2640, 'Fletching'),
            supply(53, 'Headless arrow', 3720, 'Fletching'),
        ],
    },
    {
        account: 'dipyourwick',
        board: 'Thieving',
        category: 18,
        protectedClock: true,
        status: 'retired',
        script: 'scripts/thieving-specialist.ts',
        defaultArgs: ['--live'],
        planTicks: 2145,
        weight: 1.0,
        defaultStagingHolder: 'Moneyshot',
        defaultRehearsalReportPath: '.practice/specialist-launch/rehearsal-thieving/dipyourwick-thieving-99.receipt.json',
        requiredSupplies: [
            supply(1897, 'Chocolate cake', 27, 'Thieving'),
            supply(2552, 'Ring of dueling(8)', 1, 'Thieving'),
        ],
    },
    {
        account: 'nockandload',
        board: 'Fletching',
        category: 10,
        protectedClock: true,
        status: 'retired',
        script: 'scripts/fletching-specialist.ts',
        planTicks: 54,
        weight: 1.0,
        defaultStagingHolder: 'NabTheKnob',
        defaultRehearsalReportPath: '.practice/specialist-launch/rehearsal-fletching/nockandload-fletching.receipt.json',
        requiredSupplies: [
            supply(39, 'Bronze arrowtips', 60, 'Fletching'),
            supply(40, 'Iron arrowtips', 90, 'Fletching'),
            supply(41, 'Steel arrowtips', 135, 'Fletching'),
            supply(42, 'Mithril arrowtips', 225, 'Fletching'),
            supply(43, 'Adamant arrowtips', 495, 'Fletching'),
            supply(44, 'Rune arrowtips', 2595, 'Fletching'),
            supply(53, 'Headless arrow', 3600, 'Fletching'),
        ],
    },
    {
        account: 'halfinch',
        board: 'Thieving',
        category: 18,
        protectedClock: true,
        status: 'retired',
        script: 'scripts/thieving-specialist.ts',
        defaultArgs: ['--live'],
        planTicks: 2117,
        weight: 1.0,
        defaultStagingHolder: 'Moneyshot',
        defaultRehearsalReportPath: '.practice/specialist-launch/rehearsal-thieving/halfinch-thieving-99.receipt.json',
        requiredSupplies: [
            supply(1897, 'Chocolate cake', 27, 'Thieving'),
            supply(2552, 'Ring of dueling(8)', 1, 'Thieving'),
        ],
    },
];

export const ALL_SPECIALIST_CAMPAIGN_SPECS: readonly SpecialistCampaignSpec[] = [
    ...SPECIALIST_CAMPAIGN_SPECS,
    ...RETIRED_SPECIALIST_CAMPAIGN_SPECS,
];

const RESERVED_ACCOUNT_SET: ReadonlySet<string> = new Set(RESERVED_ACCOUNTS.map((a) => a.toLowerCase()));

export const SPECIALIST_CAMPAIGN_BY_ACCOUNT: ReadonlyMap<string, SpecialistCampaignSpec> = (() => {
    const map = new Map<string, SpecialistCampaignSpec>();
    for (let i = 0; i < ALL_SPECIALIST_CAMPAIGN_SPECS.length; i++) {
        const spec = ALL_SPECIALIST_CAMPAIGN_SPECS[i]!;
        map.set(spec.account.toLowerCase(), spec);
    }
    return map;
})();

export function getSpecialistCampaignSpec(account: string): SpecialistCampaignSpec | undefined {
    return SPECIALIST_CAMPAIGN_BY_ACCOUNT.get(account.toLowerCase());
}

export function isReservedSpecialistAccount(account: string): boolean {
    return RESERVED_ACCOUNT_SET.has(account.toLowerCase());
}

export function toDefaultSpecialistCampaign(spec: SpecialistCampaignSpec): Campaign {
    return {
        id: `campaign:${spec.account.toLowerCase()}`,
        account: spec.account.toLowerCase(),
        protectedClock: true,
        board: spec.board,
        requiredSupplies: spec.requiredSupplies.map((req) => ({ ...req })),
        stagingHolder: spec.defaultStagingHolder,
        rehearsalProof: null,
        hiscoreMargin: null,
        state: 'staging',
        weight: spec.weight,
    };
}
