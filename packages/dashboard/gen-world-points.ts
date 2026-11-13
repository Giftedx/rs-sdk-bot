// Writes two client assets from the knowledge files of the pinned server:
// - client-assets/agility.json for the skilling highlights (RuneLite's Agility plugin): each agility course obstacle and
//   agility shortcut (knowledge/shortcuts.json, kinds course and shortcut) as [x, z, level, label], one row a tile.
// - client-assets/npc-spawns.json for the World plugin's NPC finder: each NPC name (knowledge/npcs.json) as
//   [name, lowest combat, highest combat, [x, z, level, x, z, level, ...]], the spawns of every NPC of that name.
// Run: bun packages/dashboard/gen-world-points.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Tile = { x: number; z: number; level: number };
export type Edge = { kind: string; locName?: string; optionText?: string; from?: Tile };
export type Npc = { name?: string; combat?: number; spawns?: Tile[] };
export type Obstacle = [number, number, number, string];
export type Spawns = [string, number, number, number[]];

export function obstacles(edges: Edge[]): Obstacle[] {
    const out = new Map<string, Obstacle>();
    for (const e of edges) {
        if ((e.kind !== 'course' && e.kind !== 'shortcut') || !e.from || !Number.isInteger(e.from.x) || !Number.isInteger(e.from.z)) continue;
        const key = `${e.from.x},${e.from.z},${e.from.level ?? 0}`;
        if (out.has(key)) continue;
        // The label is the game's menu option ("Climb-over", "Walk-on"): the loc names in the content are debug names.
        const verb = String(e.optionText ?? '').trim().replace(/^./, c => c.toUpperCase());
        out.set(key, [e.from.x, e.from.z, e.from.level ?? 0, verb || 'Obstacle']);
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
    const ob = obstacles(k('shortcuts.json').edges), sp = npcSpawns(k('npcs.json'));
    writeFileSync(join(import.meta.dir, 'client-assets', 'agility.json'), JSON.stringify(ob));
    writeFileSync(join(import.meta.dir, 'client-assets', 'npc-spawns.json'), JSON.stringify(sp));
    console.log(`agility.json: ${ob.length} obstacle tiles; npc-spawns.json: ${sp.length} names, ${sp.reduce((n, s) => n + s[3].length / 3, 0)} spawns`);
}
