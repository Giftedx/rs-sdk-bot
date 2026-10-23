// Makes haggis-travel.json: path legs between the places of haggis-boards.json, the nearest bank of each place,
// and the calibration legs. Offline: it reads knowledge/ubermouse/world.json and runs the rs-sdk pathfinder on its
// bundled collision data (no server, no bot). Run it again after you add or move a place:
//   bun packages/planner/src/travel-gen.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BOARDS_FILE } from './haggis';
import { MEASURED_LEGS, TRAVEL_FILE, type Place, type TravelCache } from './travel';

const root = resolve(import.meta.dir, '..', '..', '..');
const pf: any = await import(join(root, 'vendor/rs-sdk/sdk/pathfinding.ts'));

interface WorldSite { id: string; kind: string; reach?: string[][]; centre: { x: number; z: number; level: number }; stand?: { x: number; z: number; level: number }; nearest?: { bank?: { site: string; runTicks: number; requires: string[] } } }
const world = JSON.parse(readFileSync(join(root, 'knowledge/ubermouse/world.json'), 'utf8')) as { generatedFrom: string; sites: WorldSite[] };
const places = (JSON.parse(readFileSync(BOARDS_FILE, 'utf8')) as { places: Record<string, Place> }).places;

const tile = (s: WorldSite) => s.stand ?? s.centre;
const banks: Record<string, Place> = {};
// Only banks that a fresh account can reach (a world.json reach set with no requirement).
for (const s of world.sites) if (s.kind === 'bank' && (s.reach ?? []).some(r => r.length === 0)) { const t = tile(s); banks[s.id] = { x: t.x, z: t.z, level: t.level, site: s.id }; }
const siteById = new Map(world.sites.map(s => [s.id, s]));

// Gates on the path (world.json gates). A gate a fresh account opens with coins (the Al Kharid toll, helper coins)
// adds TOLL_TICKS; a gate behind a quest or skill is listed in `locked` (the leg is kept: the run may meet it).
const TOLL_TICKS = 10; // ESTIMATE: 4 dialogue pages at 2 ticks + p_delay(2) pass (border_gate.rs2:20-75)
interface WorldGate { loc: string; tile: { x: number; z: number; level: number }; requires?: string[][] }
const gates = new Map<string, WorldGate>();
// Met by a fresh account on this members server (vendor/rs-sdk/fly.toml NODE_MEMBERS) with every level at 1.
const met = (q: string) => q === 'members' || /^skill:[a-z]+:1$/.test(q);
for (const g of (JSON.parse(readFileSync(join(root, 'knowledge/ubermouse/world.json'), 'utf8')) as { gates: WorldGate[] }).gates)
    if (g.requires && g.requires.length > 0 && !g.requires.some(r => r.every(met))) gates.set(`${g.tile.level},${g.tile.x},${g.tile.z}`, g);
interface PathLeg { tiles: number; runTicks: number; toll?: number; locked?: string[] }

// Path from a to b on one level, or null when the path does not reach b (water, other level, no data).
function pathTiles(a: Place, b: Place): PathLeg | null {
    const level = a.level ?? 0;
    if (level !== (b.level ?? 0)) return null;
    if (Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) > 900) return null;
    const corners: { x: number; z: number }[] = pf.findLongPath(level, a.x, a.z, b.x, b.z, 500);
    if (corners.length === 0) return a.x === b.x && a.z === b.z ? { tiles: 0, runTicks: 0 } : null;
    const end = corners[corners.length - 1]!;
    if (Math.max(Math.abs(end.x - b.x), Math.abs(end.z - b.z)) > 2) return null;
    let n = 0, cx = a.x, cz = a.z, toll = 0;
    const locked = new Set<string>();
    for (const c of corners) while (cx !== c.x || cz !== c.z) {
        cx += Math.sign(c.x - cx); cz += Math.sign(c.z - cz); n++;
        const g = gates.get(`${level},${cx},${cz}`);
        if (!g) continue;
        if (g.requires!.some(r => r.every(q => q.startsWith('coins:')))) toll = TOLL_TICKS;
        else locked.add(g.loc);
    }
    const out: PathLeg = { tiles: n, runTicks: n / 2 + toll };
    if (toll) out.toll = toll;
    if (locked.size) out.locked = [...locked].sort();
    return out;
}
const island = (id: string) => (places[id] ?? banks[id])?.island?.id ?? '';
const all = (id: string) => (places[id] ?? banks[id])!;

const cache: TravelCache = { generatedFrom: `world.json ${world.generatedFrom}; rs-sdk findLongPath`, legs: {}, nearestBank: {}, banks: {} };

// Nearest bank: world.json for a place with a site; else the bank with the shortest path on the same island.
for (const [id, p] of Object.entries(places)) {
    const nb = p.site ? siteById.get(p.site)?.nearest?.bank : undefined;
    if (nb && nb.requires.length === 0) { cache.nearestBank[id] = { bank: nb.site, runTicks: nb.runTicks, method: 'world.json' }; continue; }
    let best: { bank: string; runTicks: number } | null = null;
    for (const [b, bp] of Object.entries(banks)) {
        if ((bp.island?.id ?? '') !== (p.island?.id ?? '')) continue;
        if (Math.max(Math.abs(bp.x - p.x), Math.abs(bp.z - p.z)) > 300) continue;
        const t = pathTiles(p, bp);
        if (t !== null && !t.locked && (!best || t.runTicks < best.runTicks)) best = { bank: b, runTicks: t.runTicks };
    }
    if (best) cache.nearestBank[id] = { ...best, method: 'path' };
}
const usedBanks = new Set(Object.values(cache.nearestBank).map(n => n.bank));
for (const b of usedBanks) cache.banks[b] = banks[b]!;

// Legs between every pair on the same island.
const ids = [...Object.keys(places), ...usedBanks].sort();
let ok = 0, miss = 0;
for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = ids[i]!, b = ids[j]!;
    if (island(a) !== island(b)) continue;
    const t = pathTiles(all(a), all(b));
    if (t === null) { miss++; continue; }
    cache.legs[`${a}>${b}`] = t;
    ok++;
}
cache.calibration = {};
for (const l of MEASURED_LEGS) {
    const t = pathTiles({ x: l.from[0], z: l.from[1] }, { x: l.to[0], z: l.to[1] });
    if (t !== null) cache.calibration[l.id] = { runTicks: t.runTicks, tiles: t.tiles };
}
writeFileSync(TRAVEL_FILE, JSON.stringify(cache, null, 1) + '\n');
console.log(`TRAVEL places=${Object.keys(places).length} banks=${usedBanks.size} legs=${ok} noPath=${miss} file=${TRAVEL_FILE}`);
