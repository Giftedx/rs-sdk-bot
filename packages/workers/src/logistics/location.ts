// Shared world location classification, hub selection, and bank meeting coordinates.
import type { Labels } from '../../../core/src/components';
import type { Tile } from '../../../core/src/world';

export type TilePos = { worldX: number; worldZ: number; level: number };

export type LocationKind =
    | 'ok'
    | 'wilderness'
    | 'tutorial_island'
    | 'paterdomus_trapped'
    | 'ship_deck'
    | 'ship_hold'
    | 'upstairs_stranded'
    | 'edgeville_dungeon'
    | 'dwarven_mine'
    | 'entrana_dungeon'
    | 'zanaris'
    | 'lumber_yard'
    | 'off_hub_area';

export interface LocationClassification {
    kind: LocationKind;
    stranded: boolean;
    autoFixable: boolean;
    targetHub?: { x: number; z: number; level: number };
    summary: string;
}

export type CourierTile = { x: number; z: number };
export const ARDY_BANK: CourierTile = { x: 2654, z: 3283 };
export const DRAYNOR_BANK: CourierTile = { x: 3092, z: 3243 };

export const HUB_BANKS = {
    ardougneNorth: { x: 2619, z: 3332, level: 0 },
    faladorEast: { x: 3013, z: 3355, level: 0 },
    varrockWest: { x: 3185, z: 3436, level: 0 },
} as const;

export const FLUFFS_FENCE = { id: 2618, x: 3305, z: 3493 } as const;

type Box = readonly [minX: number, maxX: number, minZ: number, maxZ: number];
const inBox = (p: TilePos, minX: number, maxX: number, minZ: number, maxZ: number) =>
    p.worldX >= minX && p.worldX <= maxX && p.worldZ >= minZ && p.worldZ <= maxZ;
const inBoxes = (p: TilePos, boxes: readonly Box[]) => boxes.some(([x0, x1, z0, z1]) => inBox(p, x0, x1, z0, z1));

const SHIP_DECK_BOXES: readonly Box[] = [
    [2675, 2688, 3264, 3274],
    [2768, 2782, 3228, 3240],
    [2950, 2962, 3138, 3150],
    [3028, 3042, 3212, 3224],
    [3042, 3054, 3226, 3238],
    [2830, 2840, 3328, 3340],
    [2845, 2860, 3328, 3342],
];

const SHIP_HOLD_BOXES: readonly Box[] = [
    [2679, 2686, 3264, 3271],
    [2770, 2778, 3231, 3237],
    [2952, 2958, 3140, 3146],
    [3032, 3038, 3214, 3220],
];

export const isWildernessTile = (p: TilePos): boolean =>
    p.worldX >= 2944 && p.worldX <= 3391 && ((p.worldZ >= 3520 && p.worldZ < 6400) || p.worldZ >= 9920);

export function inPaterdomusTemple(x: number, z: number, level = 0): boolean {
    if (level !== 0 || z < 3480 || z > 3500 || x > 3420) return false;
    if (x >= 3409) return true;
    return x === 3408 && (z < 3488 || z > 3489);
}

export function inLumberYard(p?: { worldX: number; worldZ: number; level: number } | null): boolean {
    return !!p && p.level >= 0 && p.level <= 1 && p.worldX >= 3293 && p.worldX <= 3313 && p.worldZ >= FLUFFS_FENCE.z && p.worldZ <= 3517;
}

export function hubTargetFor(p: TilePos): { x: number; z: number; level: number } {
    if (p.worldZ < 6400 && p.worldX < 2870) return { ...HUB_BANKS.ardougneNorth };
    if (p.worldX >= 2870 && p.worldX <= 3070) return { ...HUB_BANKS.faladorEast };
    return { ...HUB_BANKS.varrockWest };
}

export function classifyLocation(
    pos: TilePos,
    opts: { labels?: Labels; hubAreas?: ReadonlySet<number>; area?: number } = {},
): LocationClassification {
    const area = opts.area ?? opts.labels?.area(pos.level, pos.worldX, pos.worldZ);
    const hubs = opts.hubAreas;
    const offHub = !!hubs && hubs.size > 0 && area !== undefined && area >= 0 && !hubs.has(area);
    const targetHub = hubTargetFor(pos);

    if (isWildernessTile(pos)) {
        return {
            kind: 'wilderness',
            stranded: true,
            autoFixable: false,
            summary: `Wilderness at ${pos.worldX},${pos.worldZ},${pos.level} (manual hold avoids live Wilderness login)`,
        };
    }
    if (pos.level === 0 && inBox(pos, 3055, 3155, 3055, 3136)) {
        return { kind: 'tutorial_island', stranded: true, autoFixable: true, targetHub: { x: 3222, z: 3218, level: 0 }, summary: `Tutorial Island at ${pos.worldX},${pos.worldZ}` };
    }
    if (inPaterdomusTemple(pos.worldX, pos.worldZ, pos.level)) {
        return { kind: 'paterdomus_trapped', stranded: true, autoFixable: true, targetHub: HUB_BANKS.varrockWest, summary: `Paterdomus Temple trapped at ${pos.worldX},${pos.worldZ}` };
    }
    if (pos.level === 1 && inBoxes(pos, SHIP_DECK_BOXES)) {
        return { kind: 'ship_deck', stranded: true, autoFixable: true, targetHub, summary: `ship deck level=1 at ${pos.worldX},${pos.worldZ}` };
    }
    if (pos.level === 0 && inBoxes(pos, SHIP_HOLD_BOXES) && (!hubs || area === undefined || !hubs.has(area))) {
        return { kind: 'ship_hold', stranded: true, autoFixable: true, targetHub, summary: `ship hold level=0 at ${pos.worldX},${pos.worldZ}` };
    }
    if (pos.level !== 0) {
        return { kind: 'upstairs_stranded', stranded: true, autoFixable: true, targetHub, summary: `upper plane level=${pos.level} at ${pos.worldX},${pos.worldZ}` };
    }
    if (inBox(pos, 3070, 3155, 9820, 9919)) {
        return { kind: 'edgeville_dungeon', stranded: true, autoFixable: true, targetHub: HUB_BANKS.varrockWest, summary: `Edgeville Dungeon at ${pos.worldX},${pos.worldZ}` };
    }
    if (inBox(pos, 2985, 3070, 9730, 9855) || inBox(pos, 3070, 3085, 9730, 9819)) {
        return { kind: 'dwarven_mine', stranded: true, autoFixable: true, targetHub: HUB_BANKS.faladorEast, summary: `Dwarven Mine at ${pos.worldX},${pos.worldZ}` };
    }
    if (inBox(pos, 2816, 2880, 9720, 9790)) {
        return {
            kind: 'entrana_dungeon',
            stranded: true,
            autoFixable: false,
            summary: `Entrana Dungeon at ${pos.worldX},${pos.worldZ} (manual recovery avoids Wilderness magic door exit)`,
        };
    }
    if (inBox(pos, 3136, 3263, 9536, 9599)) {
        return { kind: 'zanaris', stranded: true, autoFixable: true, targetHub: HUB_BANKS.varrockWest, summary: `Zanaris at ${pos.worldX},${pos.worldZ}` };
    }
    // The fenced yard sits inside a hub area, but no walk leaves it: recovery climbs FLUFFS_FENCE.
    if (pos.level === 0 && inLumberYard(pos)) {
        return { kind: 'lumber_yard', stranded: true, autoFixable: true, targetHub: HUB_BANKS.varrockWest, summary: `Lumber Yard fenced in at ${pos.worldX},${pos.worldZ}` };
    }
    if (offHub) {
        return { kind: 'off_hub_area', stranded: true, autoFixable: true, targetHub, summary: `off-hub area=${area} at ${pos.worldX},${pos.worldZ}` };
    }
    return { kind: 'ok', stranded: false, autoFixable: false, summary: 'mainland hub' };
}

const pair = (a: [number, number], b: [number, number]): [Tile, Tile] => [
    { x: a[0], z: a[1], level: 0 },
    { x: b[0], z: b[1], level: 0 },
];
const VARROCK_WEST = pair([3183, 3440], [3182, 3440]);
const ARDOUGNE_NORTH = pair([2618, 3333], [2617, 3333]);

export const BANK_MEETS: readonly { bank: string; tiles: readonly [number, number][]; meet: [Tile, Tile] }[] = [
    { bank: 'varrock-west', tiles: [[3185, 3436], [3185, 3440]], meet: VARROCK_WEST },
    { bank: 'ardougne-north', tiles: [[2619, 3332], [2618, 3332]], meet: ARDOUGNE_NORTH },
    { bank: 'draynor', tiles: [[3092, 3243]], meet: pair([3093, 3243], [3093, 3244]) },
    { bank: 'al-kharid', tiles: [[3269, 3167]], meet: pair([3270, 3167], [3270, 3168]) },
    { bank: 'varrock-east', tiles: [[3254, 3420]], meet: pair([3254, 3421], [3253, 3421]) },
    { bank: 'falador-east', tiles: [[3013, 3355]], meet: pair([3013, 3356], [3014, 3356]) },
    { bank: 'falador-west', tiles: [[2947, 3368]], meet: pair([2947, 3369], [2946, 3369]) },
    { bank: 'edgeville', tiles: [[3094, 3491]], meet: pair([3093, 3491], [3093, 3492]) },
    { bank: 'ardougne-south', tiles: [[2655, 3283]], meet: pair([2654, 3283], [2654, 3284]) },
    { bank: 'catherby', tiles: [[2809, 3441]], meet: pair([2809, 3440], [2810, 3440]) },
    { bank: 'seers', tiles: [[2727, 3493]], meet: pair([2727, 3492], [2728, 3492]) },
];

export function meetingTiles(bank: { x: number; z: number }): [Tile, Tile] | null {
    const row = BANK_MEETS.find(r => r.tiles.some(([x, z]) => x === bank.x && z === bank.z));
    return row ? [{ ...row.meet[0] }, { ...row.meet[1] }] : null;
}
