// Monster hunt-range and leash-range definitions loaded from knowledge/npcs.json and server NPC configs.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Tile } from '../world-types';

const repoRoot = resolve(import.meta.dir, '..', '..', '..', '..');
const HUNTS_WEAKER = new Set(['cowardly', 'ranged']);
export const HUNTS_ALL = new Set(['aggressive_melee']);
// `hunt` is the huntrange alone: the square around the monster's current tile in which it picks a target.
export type Hunter = { id?: number; name: string; combat: number; mode: string; reach: number; hunt?: number; spawns: Tile[] };

export function combatLevel(skills: Record<string, number>): number {
    const s = (k: string, d = 1) => skills[k] ?? d;
    const base = (s('defence') + s('hitpoints', 10) + Math.floor(s('prayer') / 2)) / 4;
    const melee = (s('attack') + s('strength')) * 0.325, range = Math.floor(s('ranged') * 1.5) * 0.325, mage = Math.floor(s('magic') * 1.5) * 0.325;
    return Math.floor(base + Math.max(melee, range, mage));
}

function parseFields(lines: readonly string[], start: number, end: number): { huntmode?: string; huntrange?: number; wanderrange?: number; maxrange?: number; attackrange?: number } {
    const out: { huntmode?: string; huntrange?: number; wanderrange?: number; maxrange?: number; attackrange?: number } = {};
    for (let i = start; i < end; i++) {
        const l = lines[i]!;
        const eq = l.indexOf('=');
        if (eq <= 0) continue;
        const k = l.slice(0, eq);
        if (k === 'huntmode') out.huntmode = l.slice(eq + 1).trim();
        else if (k === 'huntrange') out.huntrange = Number(l.slice(eq + 1).trim());
        else if (k === 'wanderrange') out.wanderrange = Number(l.slice(eq + 1).trim());
        else if (k === 'maxrange') out.maxrange = Number(l.slice(eq + 1).trim());
        else if (k === 'attackrange') out.attackrange = Number(l.slice(eq + 1).trim());
    }
    return out;
}

function parseBlockFields(block: string) {
    const lines = block.split(/\r?\n/);
    return parseFields(lines, 0, lines.length);
}

// Reads hunt mode and ranges from each npc's own config block (npcs.json `src` is file:line).
export function parseHunter(npc: { id?: number; name: string; combat: number; spawns?: Tile[] }, block: string): Hunter | null {
    return buildHunter(npc, parseBlockFields(block));
}

function buildHunter(npc: { id?: number; name: string; combat: number; spawns?: Tile[] }, f: ReturnType<typeof parseFields>): Hunter | null {
    const mode = f.huntmode;
    if (!mode || !(HUNTS_WEAKER.has(mode) || HUNTS_ALL.has(mode)) || !npc.spawns?.length) return null;
    const hunt = f.huntrange ?? 0, reach = (f.wanderrange ?? 5) + hunt;
    return { ...(npc.id === undefined ? {} : { id: npc.id }), name: npc.name, combat: npc.combat, mode, reach, hunt, spawns: npc.spawns };
}

// Spawns the map walls in: the monster hunts, but no player tile is in its reach. The Wizards' Tower lesser demon
// (combat 82) stands in a cage on the top floor; counted, it closed the whole floor, with Mizgog's room and the
// Imp Catcher start, to a 37 HP account (TheFullMonty: `no route to 3104,3163,2`).
export const CAGED: readonly Tile[] = [{ x: 3110, z: 3157, level: 2 }];
const caged = (s: Tile) => CAGED.some(c => c.x === s.x && c.z === s.z && c.level === s.level);

// How far from its spawn a monster of this kind still keeps a target: `keep` tiles in each direction. The engine ends
// the fight of a monster whose target is farther than maxrange + 1 from the monster's spawn, or maxrange + attackrange
// for a monster that attacks from a distance (engine Npc.ts, the OpTrigger and ApTrigger maxrange checks). maxrange is
// wanderrange + 2 when the config sets none, and never under wanderrange (NpcType.ts).
export type Roamer = { id: number; name: string; keep: number; spawns: Tile[] };
export function parseRoamer(npc: { id?: number; name: string; spawns?: Tile[] }, block: string): Roamer | null {
    return buildRoamer(npc, parseBlockFields(block));
}

function buildRoamer(npc: { id?: number; name: string; spawns?: Tile[] }, f: ReturnType<typeof parseFields>): Roamer | null {
    if (npc.id === undefined || !npc.spawns?.length) return null;
    const wander = f.wanderrange ?? 5, set = f.maxrange, max = Math.max(wander, set === undefined || set < 0 ? wander + 2 : set);
    return { id: npc.id, name: npc.name, keep: max + Math.max(1, f.attackrange ?? 0), spawns: npc.spawns };
}

let hunters: Hunter[] | undefined, roamers: Map<number, Roamer> | undefined;
export function loadRoamers(): ReadonlyMap<number, Roamer> { loadHunters(); return roamers!; }
export function loadHunters(): Hunter[] {
    if (hunters) return hunters;
    const npcs = JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'npcs.json'), 'utf8')) as { id?: number; name: string; combat: number; src: string; spawns?: Tile[] }[];
    const files = new Map<string, string[]>();
    hunters = []; roamers = new Map();
    for (const n of npcs) {
        if (!n.spawns?.length || !n.src) continue;
        const colon = n.src.lastIndexOf(':');
        if (colon <= 0) continue;
        const file = n.src.slice(0, colon), lineNum = Number(n.src.slice(colon + 1));
        if (!Number.isInteger(lineNum)) continue;
        let lines = files.get(file);
        if (!lines) { try { lines = readFileSync(join(repoRoot, 'vendor', 'rs-sdk', 'server', 'content', file), 'utf8').split(/\r?\n/); } catch { lines = []; } files.set(file, lines); }
        const start = lineNum;
        let end = start;
        while (end < lines.length && !lines[end]!.startsWith('[')) end++;
        const fields = parseFields(lines, start, end);
        const uncagedSpawns = n.spawns.some(caged) ? n.spawns.filter(s => !caged(s)) : n.spawns;
        const h = buildHunter(uncagedSpawns === n.spawns ? n : { ...n, spawns: uncagedSpawns }, fields);
        if (h) hunters.push(h);
        const roam = buildRoamer(n, fields);
        if (roam) roamers.set(roam.id, roam);
    }
    return hunters;
}
