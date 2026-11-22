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

// Reads hunt mode and ranges from each npc's own config block (npcs.json `src` is file:line).
export function parseHunter(npc: { id?: number; name: string; combat: number; spawns?: Tile[] }, block: string): Hunter | null {
    const field = (k: string) => block.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1]?.trim();
    const mode = field('huntmode');
    if (!mode || !(HUNTS_WEAKER.has(mode) || HUNTS_ALL.has(mode)) || !npc.spawns?.length) return null;
    const hunt = Number(field('huntrange') ?? 0), reach = Number(field('wanderrange') ?? 5) + hunt;
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
    if (npc.id === undefined || !npc.spawns?.length) return null;
    const field = (k: string) => { const v = block.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1]?.trim(); return v === undefined ? undefined : Number(v); };
    const wander = field('wanderrange') ?? 5, set = field('maxrange'), max = Math.max(wander, set === undefined || set < 0 ? wander + 2 : set);
    return { id: npc.id, name: npc.name, keep: max + Math.max(1, field('attackrange') ?? 0), spawns: npc.spawns };
}

let hunters: Hunter[] | undefined, roamers: Map<number, Roamer> | undefined;
export function loadRoamers(): ReadonlyMap<number, Roamer> { loadHunters(); return roamers!; }
export function loadHunters(): Hunter[] {
    if (hunters) return hunters;
    const npcs = JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'npcs.json'), 'utf8')) as { id?: number; name: string; combat: number; src: string; spawns?: Tile[] }[];
    const files = new Map<string, string[]>();
    hunters = []; roamers = new Map();
    for (const n of npcs) {
        const m = n.src?.match(/^(.*):(\d+)$/);
        if (!m || !n.spawns?.length) continue;
        let lines = files.get(m[1]!);
        if (!lines) { try { lines = readFileSync(join(repoRoot, 'vendor', 'rs-sdk', 'server', 'content', m[1]!), 'utf8').split(/\r?\n/); } catch { lines = []; } files.set(m[1]!, lines); }
        const start = Number(m[2]) - 1, block: string[] = [];
        for (let i = start + 1; i < lines.length && !lines[i]!.startsWith('['); i++) block.push(lines[i]!);
        const h = parseHunter({ ...n, spawns: n.spawns.filter(s => !caged(s)) }, block.join('\n'));
        if (h) hunters.push(h);
        const roam = parseRoamer(n, block.join('\n'));
        if (roam) roamers.set(roam.id, roam);
    }
    return hunters;
}
