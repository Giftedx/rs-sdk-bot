import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeAtomicFile } from '../atomic-file';
import { PF_RETRY_MS, type IfReader, type PathFinder } from './model';

const repoRoot = resolve(import.meta.dir, '..', '..', '..', '..');
const vendor = (p: string) => join(repoRoot, 'vendor', 'rs-sdk', p);
const DANGER_CACHE_FILE = join(repoRoot, '.practice', 'cache', 'danger-v1.json');

type DangerCache = {
    v: 1;
    pack: string;
    dirs: [string, string][];
    files: [string, string][];
    entries: [number, number][];
};

function fileStamp(path: string): string {
    try {
        const st = statSync(path);
        return `${st.size}:${st.mtimeMs}`;
    } catch {
        return 'missing';
    }
}

function collectNpcFiles(rootDir: string): { dirs: [string, string][]; files: string[] } {
    const dirs: [string, string][] = [['.', fileStamp(rootDir)]];
    const files: string[] = [];
    const stack: { abs: string; rel: string }[] = [{ abs: rootDir, rel: '' }];
    while (stack.length > 0) {
        const cur = stack.pop()!;
        for (const entry of readdirSync(cur.abs, { withFileTypes: true })) {
            const rel = cur.rel ? `${cur.rel}/${entry.name}` : entry.name;
            if (rel.includes('macro events')) continue;
            const full = join(cur.abs, entry.name);
            if (entry.isDirectory()) {
                dirs.push([rel, fileStamp(full)]);
                stack.push({ abs: full, rel });
            } else if (entry.name.endsWith('.npc')) {
                files.push(rel);
            }
        }
    }
    return { dirs, files };
}

function leadingNonSpace(text: string, start: number, end: number): string {
    let i = start;
    while (i < end) {
        const c = text.charCodeAt(i);
        if (c === 32 || c === 9 || c === 13) break;
        i++;
    }
    return text.slice(start, i);
}

function leadingDigits(text: string, start: number, end: number): number {
    let i = start;
    while (i < end) {
        const c = text.charCodeAt(i);
        if (c < 48 || c > 57) break;
        i++;
    }
    return i > start ? Number(text.slice(start, i)) : -1;
}

// Tiles of the maze's permanent walls (loc 3626 in maps/m45_71.jm2, LOC lines "level x z: id shape angle").
// Also the loc id of every maze door (3628-3632), keyed "x,z".
let mazeWallCache: [number, number][] | null = null;
const mazeDoorIds = new Map<string, number>();

/** Load and cache permanent maze wall coordinates and maze door loc IDs from m45_71.jm2. */
export function mazeWalls(): [number, number][] {
    if (mazeWallCache) return mazeWallCache;
    const out: [number, number][] = [];
    try {
        const text = readFileSync(vendor('server/content/maps/m45_71.jm2'), 'utf8');
        const loc = text.slice(text.indexOf('==== LOC ===='));
        for (const m of loc.matchAll(/^0 (\d+) (\d+): (36\d\d) /gm)) {
            const x = 2880 + Number(m[1]), z = 4544 + Number(m[2]), id = Number(m[3]);
            if (id === 3626) out.push([x, z]);
            else if (id >= 3628 && id <= 3632) mazeDoorIds.set(`${x},${z}`, id);
        }
    } catch { /* no content checkout */ }
    mazeWallCache = out;
    return out;
}

/** Return the loc id for the maze door at `(x, z)`, if known. */
export const mazeDoorId = (x: number, z: number): number | undefined => {
    mazeWalls();
    return mazeDoorIds.get(`${x},${z}`);
};

// NPC types that hunt players (huntmode aggressive_*, cowardly, ranged in the server's .npc configs; the same
// rule as research/route-danger.ts). Radius: huntrange + 3, at least 10 for ranged hunters.
let dangerCache: Map<number, number> | null = null;

/** Load and cache hunting NPC type IDs mapped to their danger radius in tiles. */
export function loadDanger(cacheFile = DANGER_CACHE_FILE): Map<number, number> {
    const isDefault = cacheFile === DANGER_CACHE_FILE;
    if (isDefault && dangerCache) return dangerCache;
    const packPath = vendor('server/content/pack/npc.pack');
    const dir = vendor('server/content/scripts');
    const packStamp = fileStamp(packPath);
    if (cacheFile) {
        try {
            const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as DangerCache;
            if (cached?.v === 1 && cached.pack === packStamp && Array.isArray(cached.dirs) && Array.isArray(cached.files) && Array.isArray(cached.entries)) {
                let fresh = true;
                for (let i = 0; i < cached.dirs.length; i++) {
                    const [rel, stamp] = cached.dirs[i]!;
                    if (fileStamp(rel === '.' ? dir : join(dir, rel)) !== stamp) { fresh = false; break; }
                }
                if (fresh) {
                    for (let i = 0; i < cached.files.length; i++) {
                        const [rel, stamp] = cached.files[i]!;
                        if (fileStamp(join(dir, rel)) !== stamp) { fresh = false; break; }
                    }
                }
                if (fresh) {
                    const out = new Map<number, number>(cached.entries);
                    if (isDefault) dangerCache = out;
                    return out;
                }
            }
        } catch { /* cache miss */ }
    }
    const out = new Map<number, number>();
    try {
        const ids = new Map<string, number>();
        const packText = readFileSync(packPath, 'utf8');
        let pos = 0;
        while (pos < packText.length) {
            let end = packText.indexOf('\n', pos);
            if (end < 0) end = packText.length;
            const lineEnd = end > pos && packText.charCodeAt(end - 1) === 13 ? end - 1 : end;
            const eq = packText.indexOf('=', pos);
            if (eq > pos && eq < lineEnd) {
                const parsedId = leadingDigits(packText, pos, eq);
                if (parsedId >= 0 && pos + String(parsedId).length === eq) {
                    const name = leadingNonSpace(packText, eq + 1, lineEnd);
                    if (name.length > 0 && eq + 1 + name.length === lineEnd) ids.set(name, parsedId);
                }
            }
            pos = end + 1;
        }
        const { dirs, files } = collectNpcFiles(dir);
        const fileStamps: [string, string][] = [];
        for (let fi = 0; fi < files.length; fi++) {
            const rel = files[fi]!;
            const full = join(dir, rel);
            if (cacheFile) fileStamps.push([rel, fileStamp(full)]);
            const text = readFileSync(full, 'utf8');
            let cur = '', mode = '', range = 0;
            const done = () => {
                const id = ids.get(cur);
                if (id !== undefined && (mode.startsWith('aggressive') || mode.startsWith('aa_aggressive') || mode.startsWith('cowardly') || mode.startsWith('ranged'))) {
                    out.set(id, Math.max(out.get(id) ?? 0, mode.includes('ranged') ? Math.max(10, range + 3) : (range || 1) + 3));
                }
            };
            let p = 0;
            while (p < text.length) {
                let end = text.indexOf('\n', p);
                if (end < 0) end = text.length;
                const lineEnd = end > p && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
                if (lineEnd > p) {
                    if (text.charCodeAt(p) === 91) { // '['
                        const close = text.indexOf(']', p + 1);
                        if (close > p + 1 && close < lineEnd) {
                            done();
                            cur = text.slice(p + 1, close);
                            mode = '';
                            range = 0;
                        }
                    } else if (text.startsWith('huntmode=', p)) {
                        const val = leadingNonSpace(text, p + 9, lineEnd);
                        if (val) mode = val;
                    } else if (text.startsWith('huntrange=', p)) {
                        const val = leadingDigits(text, p + 10, lineEnd);
                        if (val >= 0) range = val;
                    }
                }
                p = end + 1;
            }
            done();
        }
        if (cacheFile) {
            try {
                writeAtomicFile(cacheFile, JSON.stringify({
                    v: 1, pack: packStamp, dirs, files: fileStamps, entries: [...out],
                } satisfies DangerCache), { ensureDir: true });
            } catch { /* optional cache */ }
        }
    } catch { /* no content checkout: no danger data */ }
    if (isDefault) dangerCache = out;
    return out;
}

/** Create an interface reader accessor that lazily imports IfType only when `optReader === undefined`. */
export function createIfReaderAccessor(optReader: IfReader | null | undefined): () => IfReader | null {
    let ifReader: IfReader | null = optReader ?? null;
    if (optReader === undefined) {
        void import(vendor('server/webclient/src/config/IfType.ts')).then((m: any) => {
            const list = m.default?.list as any[] | undefined;
            if (list) {
                ifReader = {
                    text: c => list[c]?.text ?? undefined,
                    obj: c => (list[c]?.model1Type === 4 ? list[c].model1Id : undefined),
                };
            }
        }).catch(() => {});
    }
    return () => ifReader;
}

/** Create a lazy pathfinder accessor that loads on first handler use and retries failed loads after PF_RETRY_MS. */
export function createPathFinderAccessor(
    optPf: PathFinder | null | undefined,
    optLoadPf?: () => Promise<PathFinder>,
): () => PathFinder | null {
    let pf: PathFinder | null = optPf ?? null;
    let pfStarted = optPf !== undefined;
    let pfRetryAt = 0;
    const loadPf = optLoadPf ?? (() => import('../pathcache').then(m => m.loadPathfinding()).then(() => import(vendor('sdk/pathfinding.ts'))));
    return () => {
        if (!pfStarted && Date.now() >= pfRetryAt) {
            pfStarted = true;
            void loadPf().then((m: any) => { pf = m; }).catch(() => {
                pfStarted = false;
                pfRetryAt = Date.now() + PF_RETRY_MS;
            });
        }
        return pf;
    };
}
