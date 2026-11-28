// Pinned runecraft altars, carrier staging tables, Shilo Nature data, and spatial predicates.
import type { Tile } from '../../../core/src/world';
import type { InteractionTarget } from '../../../knowledge/src/transports';

export const ESSENCE = 1436;
export const AIR = 556;
export const TALISMAN = 1438;
export const DRAMEN_STAFF = 772;

export const BANK: Tile = { x: 3013, z: 3355, level: 0 };
export const RUINS: Tile = { x: 2986, z: 3294, level: 0 };
export const ZANARIS_BANK: Tile = { x: 3152, z: 9578, level: 0 };
export const DRAYNOR_BANK: Tile = { x: 3092, z: 3243, level: 0 };

export const inZanarisCosmic = (p: { worldX: number; worldZ: number; level: number } | null | undefined): boolean =>
    !!p && p.level === 0 && p.worldX >= 3130 && p.worldX <= 3270 && p.worldZ >= 9472 && p.worldZ <= 9600;

export interface RuneAltar {
    name: string;
    level: number;
    xp: number;
    multiplier: number;
    rune: number;
    talisman: number;
    ruins: Tile;
    inside: Tile;
    outside: Tile;
    portal: number;
}

const tile = (x: number, z: number, level = 0): Tile => ({ x, z, level });

// Pinned skill_runecraft/configs/runecraft.dbrow and content/pack/{obj,loc}.pack.
export const RUNE_ALTARS: readonly RuneAltar[] = [
    { name: 'air', level: 1, xp: 5, multiplier: 11, rune: 556, talisman: 1438, ruins: tile(2985, 3292), inside: tile(2841, 4830), outside: tile(2983, 3288), portal: 2465 },
    { name: 'mind', level: 2, xp: 5.5, multiplier: 14, rune: 558, talisman: 1448, ruins: tile(2982, 3514), inside: tile(2793, 4829), outside: tile(2980, 3511), portal: 2466 },
    { name: 'water', level: 5, xp: 6, multiplier: 19, rune: 555, talisman: 1444, ruins: tile(3185, 3165), inside: tile(2725, 4832), outside: tile(3182, 3162), portal: 2467 },
    { name: 'earth', level: 9, xp: 6.5, multiplier: 26, rune: 557, talisman: 1440, ruins: tile(3306, 3474), inside: tile(2657, 4830), outside: tile(3303, 3477), portal: 2468 },
    { name: 'fire', level: 14, xp: 7, multiplier: 35, rune: 554, talisman: 1442, ruins: tile(3313, 3255), inside: tile(2576, 4848), outside: tile(3310, 3252), portal: 2469 },
    { name: 'body', level: 20, xp: 7.5, multiplier: 46, rune: 559, talisman: 1446, ruins: tile(3053, 3445), inside: tile(2523, 4838), outside: tile(3050, 3442), portal: 2470 },
];

// Pinned members Cosmic altar (runecraft_cosmic in runecraft.dbrow; m49_148/m33_75.jm2); selectable explicitly via RUNE_ALTAR=cosmic.
export const COSMIC_ALTAR: RuneAltar = {
    name: 'cosmic',
    level: 27,
    xp: 8,
    multiplier: 59,
    rune: 564,
    talisman: 1454,
    ruins: tile(3176, 9497),
    inside: tile(2142, 4831),
    outside: tile(3173, 9501),
    portal: 2471,
};

export const COSMIC_EXIT_APPROACH: Tile = tile(2142, 4815);

// Pinned members Law altar (runecraft_law in runecraft.dbrow; loc.pack 2459=lawtemple_ruined, 2472=lawtemple_exit_portal).
export const LAW_ALTAR: RuneAltar = {
    name: 'law',
    level: 54,
    xp: 9.5,
    multiplier: 100,
    rune: 563,
    talisman: 1458,
    ruins: tile(2858, 3381),
    inside: tile(2464, 4819),
    outside: tile(2858, 3378),
    portal: 2472,
};

// Pinned members Nature altar (runecraft_nature in runecraft.dbrow; loc.pack 2460=naturetemple_ruined, 2473=naturetemple_exit_portal).
export const NATURE_ALTAR: RuneAltar = {
    name: 'nature',
    level: 44,
    xp: 9,
    multiplier: 91,
    rune: 561,
    talisman: 1462,
    ruins: tile(2869, 3019),
    inside: tile(2400, 4835),
    outside: tile(2865, 3022),
    portal: 2473,
};

export const ALL_ALTARS: readonly RuneAltar[] = [...RUNE_ALTARS, COSMIC_ALTAR];
export const PVP_RUNE_ALTARS: readonly RuneAltar[] = [
    ...RUNE_ALTARS.filter(a => ['air', 'water', 'earth', 'fire'].includes(a.name)),
    COSMIC_ALTAR,
    NATURE_ALTAR,
    LAW_ALTAR,
];

const ALTAR_NEAREST_BANK: Readonly<Record<string, Tile>> = {
    air: BANK,
    mind: tile(3094, 3491),
    water: DRAYNOR_BANK,
    earth: tile(3254, 3420),
    fire: tile(3269, 3167),
    body: tile(3094, 3491),
    cosmic: ZANARIS_BANK,
    nature: tile(2852, 2955),
    law: DRAYNOR_BANK,
};

export function nearestBankForAltar(altarName: string): Tile {
    return ALTAR_NEAREST_BANK[altarName] ?? BANK;
}

const ENTRANA_CONTRABAND_RE = /\b(sword|scimitar|dagger|mace|axe|pickaxe|bow|arrow|bolt|dart|knife|spear|halberd|claw|staff|wand|helm|hat|hood|body|plate|chain|legs|skirt|shield|sq|kiteshield|gauntlets|gloves|boots|vamb|chaps|coif|cowl|armour|armor|battleaxe|warhammer|flail|crossbow|javelin|thrownaxe)\b/i;

// Entrana monks reject any weapon or armour in inventory or equipment before boarding the boat to the Law altar.
export function entranaContraband(
    inventory: readonly { id: number; name: string }[],
    equipment: readonly { id: number; name: string }[],
): { id: number; name: string }[] {
    return [...inventory, ...equipment].filter(i => i.id !== 1458 && i.id !== 1436 && i.id !== 563 && ENTRANA_CONTRABAND_RE.test(i.name));
}

export function insideAirAltar(p: { worldX: number; worldZ: number; level: number } | null | undefined): boolean {
    return !!p && p.level === 0 && p.worldX >= 2830 && p.worldX <= 2855 && p.worldZ >= 4820 && p.worldZ <= 4845;
}

export const outsideAirAltar = (p: { worldX: number; worldZ: number; level: number } | null | undefined): boolean =>
    !!p && p.level === 0 && p.worldX === 2983 && p.worldZ === 3288;

export const insideRuneAltar = (a: RuneAltar, p: { worldX: number; worldZ: number; level: number } | null | undefined): boolean =>
    a.name === 'air'
        ? insideAirAltar(p)
        : !!p && p.level === a.inside.level && Math.floor(p.worldX / 64) === Math.floor(a.inside.x / 64) && Math.floor(p.worldZ / 64) === 75;

const RUNE_ALTARS_BY_XP_DESC: readonly RuneAltar[] = [...RUNE_ALTARS].sort((a, b) => b.xp - a.xp);
export const ALL_ALTARS_BY_NAME = new Map<string, RuneAltar>(ALL_ALTARS.map(a => [a.name, a]));

export function chooseRuneAltar(level: number, owned: ReadonlySet<number>, forced?: string): { altar?: RuneAltar; wanted: string[] } {
    if (forced !== undefined) {
        const altar = ALL_ALTARS_BY_NAME.get(forced);
        if (!altar) throw Error(`unknown rune altar: ${forced}`);
        if (!Number.isSafeInteger(level) || level < altar.level) throw Error(`${forced} altar requires Runecraft${altar.level}, observed${level}`);
        if (!owned.has(altar.talisman)) throw Error(`next acquisition: ${forced} talisman${altar.talisman} required for requested altar`);
        return { altar, wanted: [] };
    }
    let altar: RuneAltar | undefined;
    const wanted: string[] = [];
    for (let i = 0; i < RUNE_ALTARS_BY_XP_DESC.length; i++) {
        const a = RUNE_ALTARS_BY_XP_DESC[i]!;
        if (a.level > level) continue;
        if (owned.has(a.talisman)) {
            if (!altar) altar = a;
        } else if (!altar || a.xp > altar.xp) {
            wanted.push(a.name);
        }
    }
    return { altar, wanted };
}

type RuinTargetEntry = { at: Tile; q: InteractionTarget };
const RUIN_TARGETS_BY_NAME = new Map<string, RuinTargetEntry>(
    ALL_ALTARS.map((a, idx) => {
        const at = tile(a.ruins.x - 1, a.ruins.z - 1, a.ruins.level);
        return [
            a.name,
            {
                at,
                q: {
                    id: 2452 + idx,
                    shape: 10,
                    angle: a.name === 'cosmic' ? 2 : 0,
                    width: 3,
                    height: 3,
                    blockAccessFlags: 0,
                    src: `maps/m${Math.floor(at.x / 64)}_${Math.floor(at.z / 64)}.jm2`,
                    configSrc: 'scripts/skill_runecraft/configs/runecraft.loc',
                },
            },
        ];
    }),
);

// Pinned maps/*.jm2 place each ruin (runecraft.loc 3x3, no forceapproach) as shape 10, origin one tile south-west of its centre.
export function ruinTarget(a: RuneAltar): { at: Tile; q: InteractionTarget } {
    const cached = RUIN_TARGETS_BY_NAME.get(a.name);
    if (cached) return { at: { ...cached.at }, q: { ...cached.q } };
    const at = tile(a.ruins.x - 1, a.ruins.z - 1, a.ruins.level);
    const id = 2452 + ALL_ALTARS.indexOf(a);
    return {
        at,
        q: {
            id,
            shape: 10,
            angle: a.name === 'cosmic' ? 2 : 0,
            width: 3,
            height: 3,
            blockAccessFlags: 0,
            src: `maps/m${Math.floor(at.x / 64)}_${Math.floor(at.z / 64)}.jm2`,
            configSrc: 'scripts/skill_runecraft/configs/runecraft.loc',
        },
    };
}

export const inRuinFootprint = (a: RuneAltar, t: Tile): boolean => {
    const cached = RUIN_TARGETS_BY_NAME.get(a.name);
    if (cached) {
        const { at, q } = cached;
        return t.level === at.level && t.x >= at.x && t.x < at.x + q.width && t.z >= at.z && t.z < at.z + q.height;
    }
    const { at, q } = ruinTarget(a);
    return t.level === at.level && t.x >= at.x && t.x < at.x + q.width && t.z >= at.z && t.z < at.z + q.height;
};

export const runeAltarStaging = (a: RuneAltar): Tile => (a.name === 'air' ? RUINS : a.outside);

// Carrier altar rows for multi-account essence delivery.
export type Point = { x: number; z: number };
export type CarrierAltarName = 'air' | 'mind' | 'water' | 'earth' | 'fire' | 'body';

export interface RuneCarrierAltar {
    name: CarrierAltarName;
    level: number;
    xpTenths: number;
    rune: number;
    talisman: number;
    multiplier: number | null;
    altar: { id: number; x: number; z: number };
    enter: Point;
    bank: Point & { site: string };
    crafter: Point;
    staging: Point;
}

const carrierRow = (
    name: CarrierAltarName,
    level: number,
    xpTenths: number,
    rune: number,
    talisman: number,
    multiplier: number | null,
    altar: { id: number; x: number; z: number },
    enter: Point,
    bank: Point & { site: string },
): RuneCarrierAltar => ({
    name,
    level,
    xpTenths,
    rune,
    talisman,
    multiplier,
    altar,
    enter,
    bank,
    crafter: { x: altar.x - 1, z: altar.z + 1 },
    staging: { x: altar.x - 1, z: altar.z + 2 },
});

const FALADOR_EAST_BANK = { x: 3013, z: 3355, site: 'bank:falador-east-bank:0' };
const EDGEVILLE_BANK = { x: 3094, z: 3491, site: 'bank:edgeville-bank:0' };
const DRAYNOR_VILLAGE_BANK = { x: 3092, z: 3243, site: 'bank:draynor-bank:0' };
const VARROCK_EAST_BANK = { x: 3254, z: 3420, site: 'bank:varrock-east-bank:0' };
const AL_KHARID_BANK = { x: 3269, z: 3167, site: 'bank:al-kharid-bank:0' };

export const RUNE_CARRIER_ALTARS: readonly RuneCarrierAltar[] = [
    carrierRow('air', 1, 50, 556, 1438, 11, { id: 2478, x: 2843, z: 4833 }, { x: 2841, z: 4830 }, FALADOR_EAST_BANK),
    carrierRow('mind', 2, 55, 558, 1448, 14, { id: 2479, x: 2785, z: 4840 }, { x: 2793, z: 4829 }, EDGEVILLE_BANK),
    carrierRow('water', 5, 60, 555, 1444, 19, { id: 2480, x: 2715, z: 4835 }, { x: 2725, z: 4832 }, DRAYNOR_VILLAGE_BANK),
    carrierRow('earth', 9, 65, 557, 1440, 26, { id: 2481, x: 2657, z: 4840 }, { x: 2657, z: 4830 }, VARROCK_EAST_BANK),
    carrierRow('fire', 14, 70, 554, 1442, 35, { id: 2482, x: 2584, z: 4837 }, { x: 2576, z: 4848 }, AL_KHARID_BANK),
    carrierRow('body', 20, 75, 559, 1446, 46, { id: 2483, x: 2524, z: 4831 }, { x: 2523, z: 4838 }, EDGEVILLE_BANK),
];

export const UNSUPPORTED_CARRIER_ALTARS: readonly { name: string; reason: string }[] = [
    { name: 'cosmic', reason: 'members; the ruins are in Zanaris (Lost City quest gate) and the travel cache has no Zanaris leg' },
    { name: 'chaos', reason: 'members; Wilderness ruins (players attack carriers) and a multi-level maze: enter_coord is on level 3' },
    { name: 'nature', reason: 'members; Karamja ruins whose nearest bank is in Shilo Village (Shilo Village quest gate); no RUNE_ALTARS row' },
    { name: 'law', reason: 'members; Entrana ruins: a boat each trip, no weapons or armour, and no bank on the island' },
    { name: 'death', reason: 'members; the row puts altar, entry and exit on one Lumbridge tile (3221,3218): this content has no death temple' },
];

const CARRIER_ALTARS_BY_NAME = new Map<string, RuneCarrierAltar>(RUNE_CARRIER_ALTARS.map(r => [r.name, r]));
const UNSUPPORTED_CARRIER_BY_NAME = new Map<string, string>(UNSUPPORTED_CARRIER_ALTARS.map(r => [r.name, r.reason]));

export const BODY_CARRIER_ALTAR: RuneCarrierAltar = carrierAltar('body');

export function carrierAltar(name: string): RuneCarrierAltar {
    const a = CARRIER_ALTARS_BY_NAME.get(name);
    if (!a) {
        throw Error(
            `no rune carrier altar ${name}: ${UNSUPPORTED_CARRIER_BY_NAME.get(name) ?? 'not a runecraft altar'}`,
        );
    }
    return a;
}

export const runesPerEssence = (a: Pick<RuneCarrierAltar, 'multiplier'>, level: number): number =>
    a.multiplier === null ? 1 : Math.floor(level / a.multiplier) + 1;

export const carrierXpPerEssence = (a: Pick<RuneCarrierAltar, 'xpTenths'>, rate: number): number =>
    (rate * a.xpTenths) / 10;

export const insideCarrierAltar = (
    a: Pick<RuneCarrierAltar, 'enter'>,
    p: { worldX: number; worldZ: number; level: number } | null | undefined,
): boolean => !!p && p.level === 0 && Math.floor(p.worldX / 64) === Math.floor(a.enter.x / 64) && Math.floor(p.worldZ / 64) === Math.floor(a.enter.z / 64);

// Shilo Village Nature altar constants.
export const NATURE = {
    bank: { x: 2852, z: 2955, level: 0 },
    site: { x: 2865, z: 3022, level: 0 },
    ruins: { id: 2460, x: 2868, z: 3018, angle: 0 },
    altar: { id: 2486, x: 2399, z: 4840, angle: 1 },
    portal: { id: 2473, x: 2400, z: 4834, angle: 0 },
    essence: 1436,
    talisman: 1462,
    rune: 561,
} as const;

export const insideNature = (p: { worldX: number; worldZ: number; level: number } | null | undefined): boolean =>
    !!p && p.level === 0 && Math.floor(p.worldX / 64) === 37 && Math.floor(p.worldZ / 64) === 75;
