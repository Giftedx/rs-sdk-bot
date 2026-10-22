import type { LocSpawn } from './jm2';
import { cleanLines } from './text';

type Coord = { x: number; z: number; level: number };
type Offset = { dx: number; dlevel: number; dz: number };

export type Handler =
    | { locName: string; option: string; handler: string; kind: 'offset'; offset: Offset }
    | { locName: string; option: string; handler: string; kind: 'angled'; byAngle: Record<number, Offset> }
    | { locName: string; option: string; handler: string; kind: 'absolute'; to: Coord };

export interface Edge {
    locName: string;
    option: string;
    from: Coord;
    to: Coord;
    src: string; // loc spawn line
    handler: string; // script line of the [oploc] trigger
}

const MOVE = /movecoord\(coord(?:\(\))?,\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\)/;
const ABS = /\b(\d+)_(\d+)_(\d+)_(\d+)_(\d+)\b/;
const CASE = /case\s+(\d+)\s*:.*?movecoord\(coord(?:\(\))?,\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\)/;

function off(m: RegExpMatchArray, i: number): Offset {
    return { dx: Number(m[i]), dlevel: Number(m[i + 1]), dz: Number(m[i + 2]) };
}

// Reads [oplocN,name] triggers from ladders+stairs scripts. Only three shapes are understood;
// anything else is returned in `skipped`, never guessed.
export function parseTransportHandlers(text: string, file: string): { handlers: Handler[]; skipped: { locName: string; handler: string }[] } {
    const lines = cleanLines(text);
    const handlers: Handler[] = [];
    const skipped: { locName: string; handler: string }[] = [];
    const starts: number[] = [];
    lines.forEach((l, i) => { if (/^\[oploc\d,[^\]]+\]$/.test(l)) starts.push(i); });
    for (let s = 0; s < starts.length; s++) {
        const i = starts[s]!;
        const [, op, locName] = lines[i]!.match(/^\[oploc(\d),([^\]]+)\]$/)!;
        const body = lines.slice(i + 1, starts[s + 1] ?? lines.length);
        const base = { locName: locName!, option: `op${op}`, handler: `${file}:${i + 1}` };
        const joined = body.join('\n');
        if (/switch_int\s*\(loc_angle\)/.test(joined)) {
            const byAngle: Record<number, Offset> = {};
            for (const l of body) {
                const m = l.match(CASE);
                if (m) byAngle[Number(m[1])] = off(m, 2);
            }
            if (Object.keys(byAngle).length > 0) { handlers.push({ ...base, kind: 'angled', byAngle }); continue; }
        }
        const mv = joined.match(MOVE);
        if (mv) { handlers.push({ ...base, kind: 'offset', offset: off(mv, 1) }); continue; }
        const ab = joined.match(ABS);
        if (ab) {
            const [lv, mx, mz, lx, lz] = ab.slice(1).map(Number) as [number, number, number, number, number];
            handlers.push({ ...base, kind: 'absolute', to: { x: mx * 64 + lx, z: mz * 64 + lz, level: lv } });
            continue;
        }
        skipped.push({ locName: base.locName, handler: base.handler });
    }
    return { handlers, skipped };
}

export function buildTransports(handlers: Handler[], locs: LocSpawn[], locPack: Map<number, string>): { edges: Edge[]; unmatchedAngles: number } {
    const byName = new Map<string, Handler[]>();
    for (const h of handlers) byName.set(h.locName, [...(byName.get(h.locName) ?? []), h]);
    const edges: Edge[] = [];
    let unmatchedAngles = 0;
    for (const loc of locs) {
        const name = locPack.get(loc.id);
        if (!name) continue;
        for (const h of byName.get(name) ?? []) {
            const from = { x: loc.x, z: loc.z, level: loc.level };
            let to: Coord;
            if (h.kind === 'absolute') to = h.to;
            else {
                const o = h.kind === 'offset' ? h.offset : h.byAngle[loc.angle];
                if (!o) { unmatchedAngles++; continue; }
                to = { x: loc.x + o.dx, z: loc.z + o.dz, level: loc.level + o.dlevel };
            }
            edges.push({ locName: name, option: h.option, from, to, src: loc.src, handler: h.handler });
        }
    }
    return { edges, unmatchedAngles };
}
