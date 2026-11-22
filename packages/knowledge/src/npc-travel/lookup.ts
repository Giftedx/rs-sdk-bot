import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { listConfigFiles, parseConfigs, type ConfigBlock } from '../config';
import { parseJm2 } from '../jm2';
import { parsePack } from '../pack';
import { contentRoot, knowledgeDir } from '../paths';
import type { At, GangplankSpawn, Hit, NpcRow, NpcTravelEnv, SrcTile, Tile } from './types';

const root = contentRoot();
const fileCache = new Map<string, string[]>();
let constantMap: Map<string, { value: string; src: string }> | undefined;

export function lines(file: string): string[] {
    let l = fileCache.get(file);
    if (!l) { l = readFileSync(join(root, file), 'utf8').split(/\r?\n/); fileCache.set(file, l); }
    return l;
}

// First line at or after `after` (1-based) that contains `needle`. Throws when absent so a content change fails the build.
export function find(file: string, needle: string, after = 1): Hit {
    const l = lines(file);
    for (let i = Math.max(0, after - 1); i < l.length; i++) if (l[i]!.includes(needle)) return { n: i + 1, text: l[i]!, src: `${file}:${i + 1}` };
    throw new Error(`npc-travel: needle not found in ${file} (after line ${after}): ${needle}`);
}

export function parseCoord(raw: string): Tile {
    const m = raw.match(/^(\d+)_(\d+)_(\d+)_(\d+)_(\d+)$/);
    if (!m) throw new Error(`npc-travel: not a coord literal: ${raw}`);
    const [level, mx, mz, lx, lz] = m.slice(1).map(Number) as [number, number, number, number, number];
    return { x: mx * 64 + lx, z: mz * 64 + lz, level };
}

function getConstants(): Map<string, { value: string; src: string }> {
    if (!constantMap) {
        constantMap = new Map();
        for (const f of listConfigFiles('.constant')) lines(f).forEach((t, i) => {
            const m = t.match(/^\^(\w+)\s*=\s*(\S+)/);
            if (m && !constantMap!.has(m[1]!)) constantMap!.set(m[1]!, { value: m[2]!, src: `${f}:${i + 1}` });
        });
    }
    return constantMap;
}

export function constant(name: string): { value: string; src: string } {
    const c = getConstants().get(name);
    if (!c) throw new Error(`npc-travel: constant ^${name} not found`);
    return c;
}

export const num = (name: string) => Number(constant(name).value);

// A coordinate on a cited line: the first coord literal, or the first ^constant that holds one.
export function coordOn(hit: Hit): SrcTile & { raw: string; steps: string[] } {
    const lit = hit.text.match(/\b(\d+_\d+_\d+_\d+_\d+)\b/);
    if (lit) return { ...parseCoord(lit[1]!), raw: lit[1]!, src: hit.src, steps: [hit.src] };
    const constants = getConstants();
    for (const m of hit.text.matchAll(/\^(\w+)/g)) {
        const c = constants.get(m[1]!);
        if (c && /^\d+_\d+_\d+_\d+_\d+$/.test(c.value)) return { ...parseCoord(c.value), raw: c.value, src: c.src, steps: [hit.src, c.src] };
    }
    throw new Error(`npc-travel: no coord on ${hit.src}: ${hit.text.trim()}`);
}

export const MOVE_COORD_RE = /movecoord\([^,]+,\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\)/;

export function radiusOn(hit: Hit): number {
    const m = hit.text.match(/map_findsquare\([^,]+,\s*(\d+),\s*(\d+)/);
    if (!m) throw new Error(`npc-travel: no map_findsquare on ${hit.src}`);
    return Number(m[2]);
}

export const hitAt = (a: At) => find(a.file, a.needle, a.after ? find(a.file, a.after).n : 1);

export const zone = (c: string, r: number) => {
    let t: Tile | undefined;
    return (p: Tile) => {
        t ??= parseCoord(constant(c).value);
        return p.level === t.level && Math.abs(p.x - t.x) <= r && Math.abs(p.z - t.z) <= r;
    };
};

export const box = (lo: string, hi: string) => {
    const a = parseCoord(lo), b = parseCoord(hi);
    return (p: Tile) => p.x >= a.x && p.x <= b.x && p.z >= a.z && p.z <= b.z && p.level >= a.level && p.level <= b.level;
};

function gangplanks(): GangplankSpawn[] {
    const locBlocks = listConfigFiles('.loc').flatMap(f => parseConfigs(readFileSync(join(root, f), 'utf8'), f));
    const names = new Set(locBlocks.filter(b => b.props.category?.[0] === 'gangplank_disembark').map(b => b.name));
    const ids = new Map<number, string>();
    for (const [id, name] of parsePack(readFileSync(join(root, 'pack/loc.pack'), 'utf8'))) if (names.has(name)) ids.set(id, name);
    const out: GangplankSpawn[] = [];
    for (const f of readdirSync(join(root, 'maps')).filter(f => f.endsWith('.jm2'))) {
        for (const l of parseJm2(f, readFileSync(join(root, 'maps', f), 'utf8')).locs) {
            const name = ids.get(l.id);
            if (name) out.push({ name, id: l.id, x: l.x, z: l.z, level: l.level, src: l.src });
        }
    }
    return out;
}

export function loadNpcTravelEnv(): NpcTravelEnv {
    const npcBlocks = new Map<string, ConfigBlock>();
    for (const f of listConfigFiles('.npc')) for (const b of parseConfigs(readFileSync(join(root, f), 'utf8'), f)) npcBlocks.set(b.name, b);
    const npcs = new Map<string, NpcRow>((JSON.parse(readFileSync(join(knowledgeDir(), 'npcs.json'), 'utf8')) as NpcRow[]).map(n => [n.debugname, n]));
    return { npcBlocks, npcs, planks: gangplanks() };
}
