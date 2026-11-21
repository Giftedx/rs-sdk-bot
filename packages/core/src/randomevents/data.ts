import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PF_RETRY_MS, type IfReader, type PathFinder } from './model';

const repoRoot = resolve(import.meta.dir, '..', '..', '..', '..');
const vendor = (p: string) => join(repoRoot, 'vendor', 'rs-sdk', p);

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
export function loadDanger(): Map<number, number> {
    if (dangerCache) return dangerCache;
    const out = new Map<number, number>();
    try {
        const ids = new Map<string, number>();
        for (const line of readFileSync(vendor('server/content/pack/npc.pack'), 'utf8').split(/\r?\n/)) {
            const m = line.match(/^(\d+)=(\S+)$/);
            if (m) ids.set(m[2]!, Number(m[1]));
        }
        const dir = vendor('server/content/scripts');
        const files = (readdirSync(dir, { recursive: true }) as string[]).filter(f => f.endsWith('.npc') && !f.includes('macro events'));
        for (const f of files) {
            let cur = '', mode = '', range = 0;
            const done = () => {
                const id = ids.get(cur);
                if (id !== undefined && /^(aggressive|aa_aggressive|cowardly|ranged)/.test(mode)) {
                    out.set(id, Math.max(out.get(id) ?? 0, /ranged/.test(mode) ? Math.max(10, range + 3) : (range || 1) + 3));
                }
            };
            for (const line of readFileSync(join(dir, f), 'utf8').split(/\r?\n/)) {
                const h = line.match(/^\[([^\]]+)\]/);
                if (h) { done(); cur = h[1]!; mode = ''; range = 0; continue; }
                const m = line.match(/^huntmode=(\S+)/);
                if (m) mode = m[1]!;
                const r = line.match(/^huntrange=(\d+)/);
                if (r) range = Number(r[1]);
            }
            done();
        }
    } catch { /* no content checkout: no danger data */ }
    dangerCache = out;
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
