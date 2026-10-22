import { cleanLines } from './text';

export interface Spawn {
    id: number;
    x: number;
    z: number;
    level: number;
    src: string;
}
export type LocSpawn = Spawn & { shape: number; angle: number };
export type ObjSpawn = Spawn & { count: number };

// File m<MX>_<MZ>.jm2. Sections: ==== MAP / LOC / NPC / OBJ ====. Lines: `level x z: id [a b]`.
export function parseJm2(fileName: string, text: string): { npcs: Spawn[]; locs: LocSpawn[]; objs: ObjSpawn[] } {
    const out = { npcs: [] as Spawn[], locs: [] as LocSpawn[], objs: [] as ObjSpawn[] };
    const m = fileName.match(/m(\d+)_(\d+)\.jm2$/);
    if (!m) return out;
    const baseX = Number(m[1]) * 64;
    const baseZ = Number(m[2]) * 64;
    let section = '';
    cleanLines(text).forEach((line, i) => {
        const head = line.match(/^==== (\w+) ====$/);
        if (head) { section = head[1]!; return; }
        const row = line.match(/^(\d+) (\d+) (\d+): (\d+)(?: (\d+))?(?: (\d+))?$/);
        if (!row) return;
        const base: Spawn = {
            id: Number(row[4]),
            x: baseX + Number(row[2]),
            z: baseZ + Number(row[3]),
            level: Number(row[1]),
            src: `maps/${fileName}:${i + 1}`,
        };
        if (section === 'NPC') out.npcs.push(base);
        else if (section === 'LOC') out.locs.push({ ...base, shape: Number(row[5] ?? 10), angle: Number(row[6] ?? 0) });
        else if (section === 'OBJ') out.objs.push({ ...base, count: Number(row[5] ?? 1) });
    });
    return out;
}
