import type { ConfigBlock } from '../config';

export type Kind = 'spell' | 'jewellery' | 'item' | 'lever' | 'npc' | 'spirit_tree' | 'runecraft_ruins' | 'runecraft_portal' | 'loc';
export interface Tile { x: number; z: number; level: number; src: string; wilderness: number }
export interface Box { minX: number; maxX: number; minZ: number; maxZ: number; level: number }
export interface Destination {
    option: string | null;       // dialogue option text that selects this destination
    candidates: Tile[];          // the script picks one at random when there are several
    minRadius: number;           // map_findsquare ring around the candidate (0/0 = exact tile)
    maxRadius: number;
    findsquare: 'lineofwalk' | 'lineofsight' | 'none' | null; // null: exact tile, no map_findsquare
    box: Box | null;             // bounding box of possible arrival tiles for one candidate
    when?: string;               // condition that selects this destination
    moveSrc: string;             // the line that moves the player
}
export type Requirement =
    | { type: 'skill'; skill: string; level: number; src: string }
    | { type: 'members'; src: string }
    | { type: 'varp'; varp: string; op: '>=' | '<' | '='; value: number; quest: string | null; message: string | null; src: string[] }
    | { type: 'worn'; item: string; id: number | null; src: string }
    | { type: 'held'; item: string; id: number | null; src: string }
    | { type: 'note'; text: string; src: string };
export interface Rune { item: string; id: number | null; count: number; src: string }
export interface Charge { item: string; id: number | null; charges: number; next: string | null; src: string }
export interface Teleport {
    id: string;
    kind: Kind;
    name: string;
    trigger: string;
    triggerSrc: string;
    from: Tile[] | null;          // null: usable anywhere the limits allow
    requires: Requirement[];
    wildernessMax: { level: number; src: string } | null; // blocked when wilderness level > level
    runes: Rune[];
    charges: Charge[];
    xp: { skill: string; xp: number; tenths: number; src: string } | null;
    to: Destination[];
    gaps: string[];
}
export interface TeleportsOut {
    rev: number;
    teleports: Teleport[];
    staffs: { rune: string; staffs: string[]; src: string }[];
    rules: { text: string; src: string }[];
    wildernessZones: { from: { x: number; z: number; level: number }; to: { x: number; z: number; level: number }; src: string }[];
    counts: Record<string, number>;
    unplaced: string[];          // teleport loc configs with no map spawn
    gaps: string[];
}

export interface BlockRange { start: number; end: number; head: string }
export interface FindsquareSpec { coord: string; min: number; max: number; type: Destination['findsquare'] }
export interface StagedJewelSpec { id: string; name: string; rel: string; header: RegExp; category: string; options: number[] }
export interface LocTeleportSpec { id: string; kind: Kind; name: string; rel: string; locName: string; opt: string; zanarisExtra?: boolean }
export type EssenceWizardSpec = readonly [npc: string, rel: string, name: string];

export interface TeleportContext {
    root: string;
    wildernessZones: { from: { x: number; z: number; level: number }; to: { x: number; z: number; level: number }; src: string }[];
    fsByNum: Record<string, 'lineofwalk' | 'lineofsight' | 'none'>;
    locSpawns: Map<string, Tile[]>;
    npcSpawns: Map<string, Tile[]>;
    objBlocks: ConfigBlock[];
    objByName: Map<string, ConfigBlock>;
    lines(rel: string): string[];
    clean(rel: string): string[];
    at(rel: string, i: number): string;
    find(rel: string, re: RegExp, start?: number, end?: number): { i: number; m: RegExpMatchArray };
    findAll(rel: string, re: RegExp, start?: number, end?: number): { i: number; m: RegExpMatchArray }[];
    blockEnd(rel: string, h: number): number;
    block(rel: string, header: RegExp): BlockRange;
    constant(name: string): { value: string; src: string };
    itemId(n: string): number | null;
    tile(coord: string, src: string): Tile;
    coordTile(token: string, src: string): Tile;
    wildLimit(rel: string, start: number, end: number): Teleport['wildernessMax'];
    varpReq(varp: string, op: '>=' | '<' | '=', constName: string, src: string[], message: string | null): Requirement;
    mesText(rel: string, i: number): string | null;
    spawnsOf(map: Map<string, Tile[]>, name: string, gaps: string[], what: string): Tile[];
    param(b: ConfigBlock, key: string): { value: string; src: string } | null;
}
