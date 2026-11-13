// Writes client-assets/multiway.json for Multi-Lines (World highlights and the minimap): the outer edges of the
// multi-combat zones as [x0, z0, x1, z1, level] lines in tile coordinates. The pinned server lists each multi-combat
// zone of 8 by 8 tiles in maps/multiway.csv as level_mx_mz_lx_lz (engine GameMap.loadCsvMap); an edge is a zone side
// whose neighbour is not multi-combat, and edges in one line are joined.
// Run: bun packages/dashboard/gen-multiway.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Line = [number, number, number, number, number];

export function multiZones(csv: string): Set<string> {
    const zones = new Set<string>();
    for (const raw of csv.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('//')) continue;
        const [l, mx, mz, lx, lz] = line.split('_').map(Number);
        if ([l, mx, mz, lx, lz].some(n => !Number.isInteger(n))) continue;
        zones.add(`${l},${(mx! * 64 + lx!) >> 3},${(mz! * 64 + lz!) >> 3}`);
    }
    return zones;
}

export function multiEdges(zones: Set<string>): Line[] {
    const has = (l: number, zx: number, zz: number) => zones.has(`${l},${zx},${zz}`);
    // Unit edges by line: horizontal edges keyed by level and z, vertical ones by level and x.
    const across = new Map<string, number[]>(), down = new Map<string, number[]>();
    const push = (m: Map<string, number[]>, k: string, v: number) => { const a = m.get(k) ?? []; a.push(v); m.set(k, a); };
    for (const key of zones) {
        const [l, zx, zz] = key.split(',').map(Number) as [number, number, number];
        if (!has(l, zx, zz - 1)) push(across, `${l},${zz * 8}`, zx);
        if (!has(l, zx, zz + 1)) push(across, `${l},${zz * 8 + 8}`, zx);
        if (!has(l, zx - 1, zz)) push(down, `${l},${zx * 8}`, zz);
        if (!has(l, zx + 1, zz)) push(down, `${l},${zx * 8 + 8}`, zz);
    }
    const out: Line[] = [];
    const join = (m: Map<string, number[]>, horizontal: boolean) => {
        for (const [k, cells] of m) {
            const [l, at] = k.split(',').map(Number) as [number, number];
            cells.sort((a, b) => a - b);
            let start = cells[0]!, prev = start;
            const flush = () => out.push(horizontal ? [start * 8, at, prev * 8 + 8, at, l] : [at, start * 8, at, prev * 8 + 8, l]);
            for (const c of cells.slice(1)) { if (c === prev + 1) { prev = c; continue; } flush(); start = prev = c; }
            flush();
        }
    };
    join(across, true); join(down, false);
    return out.sort((a, b) => a[4] - b[4] || a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
}

if (import.meta.main) {
    const csv = readFileSync(join(import.meta.dir, '..', '..', 'vendor', 'rs-sdk', 'server', 'content', 'maps', 'multiway.csv'), 'utf8');
    const zones = multiZones(csv), lines = multiEdges(zones);
    writeFileSync(join(import.meta.dir, 'client-assets', 'multiway.json'), JSON.stringify(lines));
    console.log(`multiway.json: ${zones.size} zones, ${lines.length} edge lines`);
}
