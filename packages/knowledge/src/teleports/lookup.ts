import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listConfigFiles, parseConfigs, type ConfigBlock } from '../config';
import { parseJm2 } from '../jm2';
import { parsePack } from '../pack';
import { contentRoot, knowledgeDir } from '../paths';
import { cleanLines } from '../text';
import { parseCoord } from '../transports';
import { FS_TYPES, WILD_DB } from './tables';
import type { BlockRange, Destination, FindsquareSpec, Kind, Requirement, Teleport, TeleportContext, Tile } from './types';

export function baseTeleport(id: string, kind: Kind, name: string, trigger: string, triggerSrc: string): Teleport {
    return { id, kind, name, trigger, triggerSrc, from: null, requires: [], wildernessMax: null, runes: [], charges: [], xp: null, to: [], gaps: [] };
}

export function dest(
    option: string | null,
    candidates: Tile[],
    fs: { min: number; max: number; type: Destination['findsquare'] } | null,
    moveSrc: string,
    when?: string,
): Destination {
    const min = fs?.min ?? 0, max = fs?.max ?? 0;
    const one = candidates.length === 1 ? candidates[0]! : null;
    return {
        option, candidates, minRadius: min, maxRadius: max, findsquare: fs?.type ?? null,
        box: one ? { minX: one.x - max, maxX: one.x + max, minZ: one.z - max, maxZ: one.z + max, level: one.level } : null,
        ...(when ? { when } : {}), moveSrc,
    };
}

// map_findsquare(<coord>, min, max, ^map_findsquare_x) on one line.
export function findsquareArgs(text: string): FindsquareSpec | null {
    const m = text.match(/map_findsquare\((.+), (\d+), (\d+), \^(\w+)\)/);
    if (!m) return null;
    return { coord: m[1]!, min: Number(m[2]), max: Number(m[3]), type: FS_TYPES[m[4]!] ?? null };
}

// "label", n pairs of a ~p_choiceN call.
export function choiceLabels(text: string): Map<number, string> {
    const out = new Map<number, string>();
    for (const m of text.matchAll(/"([^"]+)", (\d+)/g)) out.set(Number(m[2]), m[1]!.replace(/\.$/, ''));
    return out;
}

export function createTeleportContext(): TeleportContext {
    const root = contentRoot();
    const fileCache = new Map<string, string[]>();
    const cleanCache = new Map<string, string[]>();
    const lines = (rel: string): string[] => {
        let l = fileCache.get(rel);
        if (!l) { l = readFileSync(join(root, rel), 'utf8').split('\n').map(s => s.replace(/\r$/, '')); fileCache.set(rel, l); }
        return l;
    };
    const clean = (rel: string): string[] => {
        let c = cleanCache.get(rel);
        if (!c) { c = cleanLines(lines(rel).join('\n')); cleanCache.set(rel, c); }
        return c;
    };
    const at = (rel: string, i: number) => `${rel}:${i + 1}`;

    // First line index >= start whose code (comments removed) matches re. Throws: a missing anchor is a content change.
    const find = (rel: string, re: RegExp, start = 0, end?: number): { i: number; m: RegExpMatchArray } => {
        const c = clean(rel);
        for (let i = start; i < (end ?? c.length); i++) {
            const m = c[i]!.match(re);
            if (m) return { i, m };
        }
        throw new Error(`${rel}: no line matches ${re}`);
    };
    const findAll = (rel: string, re: RegExp, start = 0, end?: number): { i: number; m: RegExpMatchArray }[] => {
        const c = clean(rel);
        const out: { i: number; m: RegExpMatchArray }[] = [];
        for (let i = start; i < (end ?? c.length); i++) { const m = c[i]!.match(re); if (m) out.push({ i, m }); }
        return out;
    };
    const blockEnd = (rel: string, h: number): number => {
        const l = lines(rel);
        for (let i = h + 1; i < l.length; i++) if (l[i]!.startsWith('[')) return i;
        return l.length;
    };
    const block = (rel: string, header: RegExp): BlockRange => {
        const { i } = find(rel, header);
        return { start: i, end: blockEnd(rel, i), head: lines(rel)[i]!.replace(/\s*\/\/.*$/, '') };
    };

    // Constants: ^name = value from every .constant file.
    const constants = new Map<string, { value: string; src: string }>();
    for (const f of listConfigFiles('.constant')) {
        cleanLines(readFileSync(join(root, f), 'utf8')).forEach((l, i) => {
            const m = l.match(/^\^(\w+)\s*=\s*(.+?);?$/);
            if (m) constants.set(m[1]!, { value: m[2]!.trim(), src: `${f}:${i + 1}` });
        });
    }
    const constant = (name: string): { value: string; src: string } => {
        const c = constants.get(name);
        if (!c) throw new Error(`constant ^${name} not found`);
        return c;
    };

    const objIds = new Map([...parsePack(readFileSync(join(root, 'pack', 'obj.pack'), 'utf8'))].map(([id, n]) => [n, id]));
    const itemId = (n: string) => objIds.get(n) ?? null;

    // Wilderness level: wilderness_levels.rs2 returns (z - z1)/8 + 1 inside a coord_pair zone, else 0.
    const wildernessZones = findAll(WILD_DB, /^data=coord_pair,(\S+),(\S+)$/).map(({ i, m }) => {
        const a = parseCoord(m[1]!), b = parseCoord(m[2]!);
        return { from: a, to: b, src: at(WILD_DB, i) };
    });
    const wildernessLevel = (c: { x: number; z: number; level: number }): number => {
        for (const zn of wildernessZones) {
            const { from: a, to: b } = zn;
            if (c.x >= a.x && c.x <= b.x && c.z >= a.z && c.z <= b.z && c.level >= a.level && c.level <= b.level) return Math.trunc((c.z - a.z) / 8) + 1;
        }
        return 0;
    };

    const tile = (coord: string, src: string): Tile => {
        const c = parseCoord(coord);
        return { ...c, src, wilderness: wildernessLevel(c) };
    };
    const coordTile = (token: string, src: string): Tile => {
        if (token.startsWith('^')) { const c = constant(token.slice(1)); return tile(c.value, c.src); }
        return tile(token, src);
    };

    const fsByNum: Record<string, 'lineofwalk' | 'lineofsight' | 'none'> = {};
    for (const [k, v] of Object.entries(FS_TYPES)) fsByNum[constant(k).value] = v;

    const wildLimit = (rel: string, start: number, end: number): Teleport['wildernessMax'] => {
        const r = findAll(rel, /~wilderness_level\(coord\) > (\d+)/, start, end)[0];
        return r ? { level: Number(r.m[1]), src: at(rel, r.i) } : null;
    };

    const questByVarp = new Map<string, string>();
    try {
        for (const q of JSON.parse(readFileSync(join(knowledgeDir(), 'quests.json'), 'utf8')) as { varp: string; folder: string }[]) {
            questByVarp.set(q.varp, q.folder);
        }
    } catch { /* quests.json absent: quest stays null */ }

    const varpReq = (varp: string, op: '>=' | '<' | '=', constName: string, src: string[], message: string | null): Requirement => {
        const c = constant(constName);
        return { type: 'varp', varp, op, value: Number(c.value), quest: questByVarp.get(varp) ?? null, message, src: [...src, c.src] };
    };
    const mesText = (rel: string, i: number): string | null => {
        const m = lines(rel)[i]?.match(/mes(?:box)?\("([^"]*)"/);
        return m ? m[1]! : null;
    };

    // Map spawns of named locs and npcs.
    const locPack = parsePack(readFileSync(join(root, 'pack', 'loc.pack'), 'utf8'));
    const npcPack = parsePack(readFileSync(join(root, 'pack', 'npc.pack'), 'utf8'));
    const locSpawns = new Map<string, Tile[]>();
    const npcSpawns = new Map<string, Tile[]>();
    for (const f of readdirSync(join(root, 'maps')).filter(f => f.endsWith('.jm2'))) {
        const r = parseJm2(f, readFileSync(join(root, 'maps', f), 'utf8'));
        for (const l of r.locs) {
            const n = locPack.get(l.id);
            if (n) (locSpawns.get(n) ?? locSpawns.set(n, []).get(n)!).push({ x: l.x, z: l.z, level: l.level, src: l.src, wilderness: wildernessLevel(l) });
        }
        for (const n of r.npcs) {
            const nm = npcPack.get(n.id);
            if (nm) (npcSpawns.get(nm) ?? npcSpawns.set(nm, []).get(nm)!).push({ x: n.x, z: n.z, level: n.level, src: n.src, wilderness: wildernessLevel(n) });
        }
    }
    const spawnsOf = (map: Map<string, Tile[]>, name: string, gaps: string[], what: string): Tile[] => {
        const s = map.get(name) ?? [];
        if (s.length === 0) gaps.push(`${what} ${name} has no map spawn`);
        return s;
    };

    const objBlocks: ConfigBlock[] = listConfigFiles('.obj').flatMap(f => parseConfigs(readFileSync(join(root, f), 'utf8'), f));
    const objByName = new Map(objBlocks.map(b => [b.name, b]));
    const param = (b: ConfigBlock, key: string): { value: string; src: string } | null => {
        const idx = (b.props.param ?? []).findIndex(p => p.startsWith(`${key},`));
        return idx < 0 ? null : { value: b.props.param![idx]!.slice(key.length + 1), src: `${b.file}:${b.propLines.param![idx]}` };
    };

    return {
        root, wildernessZones, fsByNum, locSpawns, npcSpawns, objBlocks, objByName,
        lines, clean, at, find, findAll, blockEnd, block, constant, itemId,
        tile, coordTile, wildLimit, varpReq, mesText, spawnsOf, param,
    };
}
