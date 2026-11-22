import type { ConfigBlock } from '../config';

export type TravelKind = 'boat' | 'charter' | 'carpet' | 'glider' | 'cart' | 'npc-teleport' | 'toll' | 'other';
export interface Tile { x: number; z: number; level: number }
export interface SrcTile extends Tile { src: string }
export interface Requirement { varp: string; op: '>=' | '>' | '<' | '=' | '!=' | 'in' | 'not-in'; value: number | number[]; constant: string | string[]; src: string }
export interface TravelRecord {
    id: string;
    kind: TravelKind;
    destination: string;
    npc: { debugname: string; name: string; id: number; src: string };
    op: { index: number; label: string | null; src: string | null; trigger: string };
    options: { text: string; src: string }[];
    button?: { component: string; src: string };
    from: SrcTile[];
    fromFilter?: { rule: string; src: string };
    to: (SrcTile & { raw: string; radius?: number; radiusSrc?: string; steps?: string[] }) | null;
    toCandidates?: SrcTile[];
    candidateRadius?: { radius: number; src: string };
    returnTo?: SrcTile & { radius: number; radiusSrc: string };
    fare: { coins: number | null; src: string | null; rule?: string; ruleSrc?: string[] };
    items: { item: string; use: 'consumed' | 'required' | 'confiscated' | 'forbidden'; src: string }[];
    requires: Requirement[];
    members: { checked: boolean; src?: string };
    deck: { onDeck: boolean; gangplank?: { loc: string; id: number; x: number; z: number; level: number; distance: number; src: string; handler: string } };
    notes: string[];
    gaps: string[];
}
export interface ExcludedRecord { npc: string; src: string; reason: string }

export type Hit = { n: number; text: string; src: string };
export type At = { file: string; needle: string; after?: string };
export type ReqSpec = { varp: string; op: Requirement['op']; constant: string | string[]; at: At };
export interface Spec {
    kind: TravelKind;
    destination: string;
    npc: string;
    op: number;
    trigger: At;
    options?: (string | { text: string; file: string; after?: string })[];
    optionsFile?: string;
    button?: At & { component: string };
    from?: { rule: string; at: At; keep: (t: Tile) => boolean };
    to?: { at: At; offsets?: At[]; radius?: At };
    candidates?: { file: string; returnConst: string; returnRadius: At };
    fare: { coins: number; at: At } | { coins: 0; free: string } | { coins: null; rule: string; at: At[] };
    items?: { item: string; use: TravelRecord['items'][number]['use']; at: At }[];
    requires?: ReqSpec[];
    members?: At;
    notes?: string[];
    gaps?: string[];
}
export interface ExcludedSpec { npc: string; at: At; reason: string }
export type NpcRow = { id: number; name: string; debugname: string; src: string; spawns: SrcTile[] };
export type GangplankSpawn = { name: string; id: number; x: number; z: number; level: number; src: string };
export interface NpcTravelEnv {
    npcBlocks: Map<string, ConfigBlock>;
    npcs: Map<string, NpcRow>;
    planks: GangplankSpawn[];
}
