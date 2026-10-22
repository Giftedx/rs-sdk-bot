import type { LocSpawn } from './jm2';
import { cleanLines } from './text';

type Coord = { x: number; z: number; level: number };
type Offset = { dx: number; dlevel: number; dz: number; line: number };

export type Handler =
    | { locName: string; option: string; handler: string; file: string; kind: 'offset'; offset: Offset }
    | { locName: string; option: string; handler: string; file: string; kind: 'angled'; byAngle: Record<number, Offset> }
    | { locName: string; option: string; handler: string; file: string; kind: 'absolute'; to: Coord; line: number }
    | { locName: string; option: string; handler: string; file: string; kind: 'table'; cases: { from: Coord; to: Coord; line: number }[] };

export interface Edge {
    locName: string;
    option: string;
    from: Coord;
    to: Coord;
    // true: `to` is written in the script. false: `to` = loc tile + a player-relative offset, so it is
    // within about one tile of the real arrival tile (movecoord(coord, ...) is relative to the player).
    exact: boolean;
    src: string; // line that proves `from` (loc spawn line, or the switch_coord case line)
    toSrc: string; // line that proves `to`
    handler: string; // line of the [oploc] trigger
}

const MOVE = /movecoord\(coord(?:\(\))?,\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\)/;
const ABS = /\b(\d+)_(\d+)_(\d+)_(\d+)_(\d+)\b/;
const ABS_ALL = /\b(\d+)_(\d+)_(\d+)_(\d+)_(\d+)\b/g;
const CASE_ANGLE = /case\s+(\d+)\s*:.*?movecoord\(coord(?:\(\))?,\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\)/;
const CASE_COORD = /^case\s+\d+_\d+_\d+_\d+_\d+\s*:/;

// RuneScript coord literal level_mx_mz_lx_lz.
export function parseCoord(s: string): Coord {
    const [lv, mx, mz, lx, lz] = s.split('_').map(Number) as [number, number, number, number, number];
    return { x: mx * 64 + lx, z: mz * 64 + lz, level: lv };
}

export function coordString(c: Coord): string {
    return `${c.level}_${c.x >> 6}_${c.z >> 6}_${c.x & 63}_${c.z & 63}`;
}

// Reads [oplocN,name] triggers from ladders+stairs scripts. Understood shapes: a switch_coord table,
// a switch_int(loc_angle) offset table, one movecoord offset, one absolute destination. Anything else
// is returned in `skipped`, never guessed. A switch_coord default case is not used: it applies only to
// locs no case lists, and its offset is player-relative.
export function parseTransportHandlers(text: string, file: string): { handlers: Handler[]; skipped: { locName: string; handler: string }[] } {
    const lines = cleanLines(text);
    const handlers: Handler[] = [];
    const skipped: { locName: string; handler: string }[] = [];
    const starts: number[] = [];
    lines.forEach((l, i) => { if (/^\[oploc\d,[^\]]+\]$/.test(l)) starts.push(i); });
    for (let s = 0; s < starts.length; s++) {
        const i = starts[s]!;
        const [, op, locName] = lines[i]!.match(/^\[oploc(\d),([^\]]+)\]$/)!;
        const end = starts[s + 1] ?? lines.length;
        const body = lines.slice(i + 1, end).map((text, k) => ({ text, line: i + 2 + k }));
        const base = { locName: locName!, option: `op${op}`, handler: `${file}:${i + 1}`, file };
        const joined = body.map(b => b.text).join('\n');

        if (/switch_coord\s*\(loc_coord\)/.test(joined)) {
            const cases: { from: Coord; to: Coord; line: number }[] = [];
            for (const b of body) {
                if (!CASE_COORD.test(b.text)) continue;
                const coords = [...b.text.matchAll(ABS_ALL)].map(m => m[0]);
                if (coords.length >= 2) cases.push({ from: parseCoord(coords[0]!), to: parseCoord(coords[1]!), line: b.line });
            }
            if (cases.length > 0) handlers.push({ ...base, kind: 'table', cases });
            else skipped.push({ locName: base.locName, handler: base.handler });
            continue;
        }
        if (/switch_int\s*\(loc_angle\)/.test(joined)) {
            const byAngle: Record<number, Offset> = {};
            for (const b of body) {
                const m = b.text.match(CASE_ANGLE);
                if (m) byAngle[Number(m[1])] = { dx: Number(m[2]), dlevel: Number(m[3]), dz: Number(m[4]), line: b.line };
            }
            if (Object.keys(byAngle).length > 0) { handlers.push({ ...base, kind: 'angled', byAngle }); continue; }
        }
        const mv = body.find(b => MOVE.test(b.text));
        if (mv) {
            const m = mv.text.match(MOVE)!;
            handlers.push({ ...base, kind: 'offset', offset: { dx: Number(m[1]), dlevel: Number(m[2]), dz: Number(m[3]), line: mv.line } });
            continue;
        }
        const ab = body.find(b => ABS.test(b.text));
        if (ab) {
            handlers.push({ ...base, kind: 'absolute', to: parseCoord(ab.text.match(ABS)![0]), line: ab.line });
            continue;
        }
        skipped.push({ locName: base.locName, handler: base.handler });
    }
    return { handlers, skipped };
}

export function buildTransports(handlers: Handler[], locs: LocSpawn[], locPack: Map<number, string>): { edges: Edge[]; unmatchedAngles: number } {
    const edges: Edge[] = [];
    const byName = new Map<string, Handler[]>();
    for (const h of handlers) {
        if (h.kind === 'table') {
            for (const c of h.cases) {
                const src = `${h.file}:${c.line}`;
                edges.push({ locName: h.locName, option: h.option, from: c.from, to: c.to, exact: true, src, toSrc: src, handler: h.handler });
            }
            continue;
        }
        byName.set(h.locName, [...(byName.get(h.locName) ?? []), h]);
    }
    let unmatchedAngles = 0;
    for (const loc of locs) {
        const name = locPack.get(loc.id);
        if (!name) continue;
        for (const h of byName.get(name) ?? []) {
            const from = { x: loc.x, z: loc.z, level: loc.level };
            if (h.kind === 'absolute') {
                edges.push({ locName: name, option: h.option, from, to: h.to, exact: true, src: loc.src, toSrc: `${h.file}:${h.line}`, handler: h.handler });
                continue;
            }
            if (h.kind === 'table') continue;
            const o = h.kind === 'offset' ? h.offset : h.byAngle[loc.angle];
            if (!o) { unmatchedAngles++; continue; }
            edges.push({
                locName: name, option: h.option, from,
                to: { x: loc.x + o.dx, z: loc.z + o.dz, level: loc.level + o.dlevel },
                exact: false, src: loc.src, toSrc: `${h.file}:${o.line}`, handler: h.handler,
            });
        }
    }
    return { edges, unmatchedAngles };
}
