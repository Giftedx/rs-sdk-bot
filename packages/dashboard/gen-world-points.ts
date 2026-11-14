// Writes two client assets from the knowledge files of the pinned server:
// - client-assets/agility.json for the skilling highlights (RuneLite's Agility plugin): each agility course obstacle and
//   agility shortcut (knowledge/shortcuts.json, kinds course and shortcut) as [x, z, level, label], one row a tile,
//   with [low, high] fifth when the obstacle can fail: the literal stat_random(agility, low, high) of its handler block
//   (the edge's handler, file:line, up to the next [ block). A roll from loc params or a called label is left out.
// - client-assets/npc-spawns.json for the World plugin's NPC finder: each NPC name (knowledge/npcs.json) as
//   [name, lowest combat, highest combat, [x, z, level, x, z, level, ...]], the spawns of every NPC of that name.
// Run: bun packages/dashboard/gen-world-points.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Tile = { x: number; z: number; level: number };
export type Edge = { kind: string; locName?: string; optionText?: string; from?: Tile; handler?: string };
export type Npc = { name?: string; combat?: number; spawns?: Tile[] };
export type Obstacle = [number, number, number, string] | [number, number, number, string, [number, number]];

// The fail roll of a handler block: its first literal stat_random(agility, low, high).
export function failRoll(block: string): [number, number] | null {
    const m = block.match(/stat_random\(\s*agility\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
    return m ? [Number(m[1]), Number(m[2])] : null;
}
export type Spawns = [string, number, number, number[]];

export function obstacles(edges: Edge[], handlerBlock: (handler: string) => string = () => ''): Obstacle[] {
    const out = new Map<string, Obstacle>();
    for (const e of edges) {
        if ((e.kind !== 'course' && e.kind !== 'shortcut') || !e.from || !Number.isInteger(e.from.x) || !Number.isInteger(e.from.z)) continue;
        const key = `${e.from.x},${e.from.z},${e.from.level ?? 0}`;
        if (out.has(key)) continue;
        // The label is the game's menu option ("Climb-over", "Walk-on"): the loc names in the content are debug names.
        const verb = String(e.optionText ?? '').trim().replace(/^./, c => c.toUpperCase());
        const roll = e.handler ? failRoll(handlerBlock(e.handler)) : null;
        out.set(key, roll ? [e.from.x, e.from.z, e.from.level ?? 0, verb || 'Obstacle', roll] : [e.from.x, e.from.z, e.from.level ?? 0, verb || 'Obstacle']);
    }
    return [...out.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

export function npcSpawns(npcs: Npc[]): Spawns[] {
    const by = new Map<string, { lo: number; hi: number; tiles: Set<string> }>();
    for (const n of npcs) {
        const name = String(n.name ?? '').trim();
        if (!name || name === 'null' || !n.spawns?.length) continue;
        const c = Number.isFinite(n.combat) ? n.combat! : 0, row = by.get(name) ?? { lo: c, hi: c, tiles: new Set<string>() };
        row.lo = Math.min(row.lo, c); row.hi = Math.max(row.hi, c);
        for (const s of n.spawns) if (Number.isInteger(s.x) && Number.isInteger(s.z)) row.tiles.add(`${s.x},${s.z},${s.level ?? 0}`);
        by.set(name, row);
    }
    return [...by].map(([name, r]): Spawns => [name, r.lo, r.hi, [...r.tiles].flatMap(t => t.split(',').map(Number))]).sort((a, b) => a[0].localeCompare(b[0]));
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..'), k = (f: string) => JSON.parse(readFileSync(join(root, 'knowledge', f), 'utf8'));
    // A handler is scripts/...:line under the content folder; its block runs to the next line that opens a [ block.
    const content = join(root, 'vendor', 'rs-sdk', 'server', 'content'), cache = new Map<string, string[]>();
    const block = (h: string) => { const m = h.match(/^(.*):(\d+)$/); if (!m) return ''; let lines = cache.get(m[1]!); if (!lines) { try { lines = readFileSync(join(content, m[1]!), 'utf8').split(/\r?\n/); } catch { lines = []; } cache.set(m[1]!, lines); } const from = Number(m[2]) - 1, end = lines.findIndex((l, i) => i > from && l.startsWith('[')); return lines.slice(from, end < 0 ? undefined : end).join('\n'); };
    const ob = obstacles(k('shortcuts.json').edges, block), sp = npcSpawns(k('npcs.json'));
    writeFileSync(join(import.meta.dir, 'client-assets', 'agility.json'), JSON.stringify(ob));
    writeFileSync(join(import.meta.dir, 'client-assets', 'npc-spawns.json'), JSON.stringify(sp));
    console.log(`agility.json: ${ob.length} obstacle tiles; npc-spawns.json: ${sp.length} names, ${sp.reduce((n, s) => n + s[3].length / 3, 0)} spawns`);
}
