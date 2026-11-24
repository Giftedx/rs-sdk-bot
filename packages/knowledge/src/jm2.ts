export interface Spawn {
    id: number;
    x: number;
    z: number;
    level: number;
    src: string;
}
export type LocSpawn = Spawn & { shape: number; angle: number };
export type ObjSpawn = Spawn & { count: number };

export interface Jm2Filter {
    locIds?: ReadonlySet<number>;
    objIds?: ReadonlySet<number>;
    npcs?: boolean;
}

const HEAD_RE = /^==== (\w+) ====$/;
const ROW_RE = /^(\d+) (\d+) (\d+): (\d+)(?: (\d+))?(?: (\d+))?$/;

function cleanLineSlice(text: string, start: number, end: number): string {
    if (end > start && text.charCodeAt(end - 1) === 13) end--;
    const comment = text.indexOf('//', start);
    if (comment >= 0 && comment < end) end = comment;
    while (start < end && text.charCodeAt(start) <= 32) start++;
    while (end > start && text.charCodeAt(end - 1) <= 32) end--;
    return text.slice(start, end);
}

function parseUint(s: string, pos: number, len: number): [number, number] {
    if (pos >= len) return [-1, pos];
    let c = s.charCodeAt(pos);
    if (c < 48 || c > 57) return [-1, pos];
    let n = c - 48;
    pos++;
    while (pos < len) {
        c = s.charCodeAt(pos);
        if (c < 48 || c > 57) break;
        n = n * 10 + (c - 48);
        pos++;
    }
    return [n, pos];
}

// File m<MX>_<MZ>.jm2. Sections: ==== MAP / LOC / NPC / OBJ ====. Lines: `level x z: id [a b]`.
export function parseJm2(fileName: string, text: string, filter?: Jm2Filter): { npcs: Spawn[]; locs: LocSpawn[]; objs: ObjSpawn[] } {
    const out = { npcs: [] as Spawn[], locs: [] as LocSpawn[], objs: [] as ObjSpawn[] };
    const m = fileName.match(/m(\d+)_(\d+)\.jm2$/);
    if (!m) return out;
    const baseX = Number(m[1]) * 64;
    const baseZ = Number(m[2]) * 64;
    const wantNpc = filter?.npcs ?? true;
    const locIds = filter?.locIds;
    const objIds = filter?.objIds;
    const wantLoc = !locIds || locIds.size > 0;
    const wantObj = !objIds || objIds.size > 0;

    let section = '';
    let lineNo = 0;
    let pos = 0;
    const total = text.length;

    while (pos <= total) {
        const nl = text.indexOf('\n', pos);
        const end = nl === -1 ? total : nl;
        lineNo++;

        const wantCur = (section === 'NPC' && wantNpc)
            || (section === 'LOC' && wantLoc)
            || (section === 'OBJ' && wantObj);

        if (!wantCur) {
            // Skip MAP and filtered-out sections without per-line allocations or regexes.
            // Jump directly to the next line that contains '====' if any.
            const mark = text.indexOf('====', pos);
            if (mark === -1) break;
            if (mark >= end) {
                const lineStart = text.lastIndexOf('\n', mark) + 1;
                let idx = end + 1;
                while (idx < lineStart) {
                    const nxt = text.indexOf('\n', idx);
                    if (nxt === -1 || nxt >= lineStart) break;
                    lineNo++;
                    idx = nxt + 1;
                }
                pos = lineStart;
                if (nl === -1) break;
                continue;
            }
            const clean = cleanLineSlice(text, pos, end);
            if (clean.startsWith('====')) {
                const head = HEAD_RE.exec(clean);
                if (head) section = head[1]!;
            }
            if (nl === -1) break;
            pos = nl + 1;
            continue;
        }

        // Fast check for empty or header or comment-stripped line
        if (end > pos) {
            const first = text.charCodeAt(pos);
            if (first === 61 /* '=' */) {
                const clean = cleanLineSlice(text, pos, end);
                const head = HEAD_RE.exec(clean);
                if (head) {
                    section = head[1]!;
                    if (nl === -1) break;
                    pos = nl + 1;
                    continue;
                }
            }
            // Fast path for standard `level x z: id [a b]` lines without comments/leading spaces
            if (first >= 48 && first <= 57 && text.indexOf('//', pos) === -1) {
                let pEnd = end;
                if (pEnd > pos && text.charCodeAt(pEnd - 1) === 13) pEnd--;
                while (pEnd > pos && text.charCodeAt(pEnd - 1) <= 32) pEnd--;
                const [lv, p1] = parseUint(text, pos, pEnd);
                if (lv >= 0 && p1 < pEnd && text.charCodeAt(p1) === 32) {
                    const [lx, p2] = parseUint(text, p1 + 1, pEnd);
                    if (lx >= 0 && p2 < pEnd && text.charCodeAt(p2) === 32) {
                        const [lz, p3] = parseUint(text, p2 + 1, pEnd);
                        if (lz >= 0 && p3 + 1 < pEnd && text.charCodeAt(p3) === 58 && text.charCodeAt(p3 + 1) === 32) {
                            const [id, p4] = parseUint(text, p3 + 2, pEnd);
                            if (id >= 0) {
                                let a = -1, b = -1, ok = p4 === pEnd;
                                if (!ok && text.charCodeAt(p4) === 32) {
                                    const [va, p5] = parseUint(text, p4 + 1, pEnd);
                                    if (va >= 0) {
                                        a = va;
                                        ok = p5 === pEnd;
                                        if (!ok && text.charCodeAt(p5) === 32) {
                                            const [vb, p6] = parseUint(text, p5 + 1, pEnd);
                                            if (vb >= 0 && p6 === pEnd) { b = vb; ok = true; }
                                        }
                                    }
                                }
                                if (ok) {
                                    if (section === 'NPC') {
                                        out.npcs.push({ id, x: baseX + lx, z: baseZ + lz, level: lv, src: `maps/${fileName}:${lineNo}` });
                                    } else if (section === 'LOC') {
                                        if (!locIds || locIds.has(id)) {
                                            out.locs.push({ id, x: baseX + lx, z: baseZ + lz, level: lv, src: `maps/${fileName}:${lineNo}`, shape: a >= 0 ? a : 10, angle: b >= 0 ? b : 0 });
                                        }
                                    } else if (section === 'OBJ') {
                                        if (!objIds || objIds.has(id)) {
                                            out.objs.push({ id, x: baseX + lx, z: baseZ + lz, level: lv, src: `maps/${fileName}:${lineNo}`, count: a >= 0 ? a : 1 });
                                        }
                                    }
                                    if (nl === -1) break;
                                    pos = nl + 1;
                                    continue;
                                }
                            }
                        }
                    }
                }
            }

            const clean = cleanLineSlice(text, pos, end);
            if (clean) {
                if (clean.startsWith('====')) {
                    const head = HEAD_RE.exec(clean);
                    if (head) {
                        section = head[1]!;
                        if (nl === -1) break;
                        pos = nl + 1;
                        continue;
                    }
                }
                const row = ROW_RE.exec(clean);
                if (row) {
                    const id = Number(row[4]);
                    if (section === 'NPC') {
                        out.npcs.push({ id, x: baseX + Number(row[2]), z: baseZ + Number(row[3]), level: Number(row[1]), src: `maps/${fileName}:${lineNo}` });
                    } else if (section === 'LOC') {
                        if (!locIds || locIds.has(id)) {
                            out.locs.push({ id, x: baseX + Number(row[2]), z: baseZ + Number(row[3]), level: Number(row[1]), src: `maps/${fileName}:${lineNo}`, shape: Number(row[5] ?? 10), angle: Number(row[6] ?? 0) });
                        }
                    } else if (section === 'OBJ') {
                        if (!objIds || objIds.has(id)) {
                            out.objs.push({ id, x: baseX + Number(row[2]), z: baseZ + Number(row[3]), level: Number(row[1]), src: `maps/${fileName}:${lineNo}`, count: Number(row[5] ?? 1) });
                        }
                    }
                }
            }
        }

        if (nl === -1) break;
        pos = nl + 1;
    }
    return out;
}
