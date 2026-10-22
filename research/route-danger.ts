// Route danger check for a weak account: walks findLongPath between waypoints and lists every NPC spawn whose
// hunt range (plus a wander margin) reaches the path. Hunt data: vendor/lostcity-content/scripts/_unpack/225/all.npc
// (huntmode/huntrange), and every other .npc file under scripts/. In all.hunt, aggressive_* hunt anyone; cowardly and ranged hunt players "not too strong"
// outside the Wilderness, which includes every low-level account. gnomeball and quest modes are skipped.
// Usage: bun research/route-danger.ts x,z x,z ... [--margin 3]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadPathfinding } from '../packages/core/src/pathcache';

const root = join(import.meta.dir, '..');
const args = process.argv.slice(2);
const mi = args.indexOf('--margin');
const MARGIN = mi >= 0 ? Number(args[mi + 1]) : 3;
const pts = args.filter((a, i) => /^\d+,\d+$/.test(a) && args[i - 1] !== '--margin').map(a => a.split(',').map(Number) as [number, number]);

const hunt = new Map<string, { mode: string; range: number }>();
let cur = '';
let mode = '', range = 0;
const flush = () => { if (cur && mode && !hunt.has(cur) && !/gnomeball|mm_guard|shades|hauntedmine|battle_mage/.test(mode)) hunt.set(cur, { mode, range: range || 1 }); };
const scripts = join(root, 'vendor/lostcity-content/scripts');
const npcFiles = (readdirSync(scripts, { recursive: true }) as string[]).filter(f => f.endsWith('.npc'));
for (const line of npcFiles.flatMap(f => readFileSync(join(scripts, f), 'utf8').split(/\r?\n/))) {
    const h = line.match(/^\[([^\]]+)\]/);
    if (h) { flush(); cur = h[1]!; mode = ''; range = 0; continue; }
    const m = line.match(/^huntmode=(\S+)/); if (m) mode = m[1]!;
    const r = line.match(/^huntrange=(\d+)/); if (r) range = Number(r[1]);
}
flush();

const npcs = JSON.parse(readFileSync(join(root, 'knowledge/npcs.json'), 'utf8')) as { debugname: string; combat: number; spawns?: { x: number; z: number; level: number }[] }[];
const danger = npcs.flatMap(n => (hunt.has(n.debugname) ? (n.spawns ?? []).filter(s => s.level === 0).map(s => ({ name: n.debugname, combat: n.combat, ...s, reach: hunt.get(n.debugname)!.range + MARGIN })) : []));

await loadPathfinding();
const pf: any = await import('../vendor/rs-sdk/sdk/pathfinding');
const tiles: { x: number; z: number }[] = [];
for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i]!, [bx, bz] = pts[i + 1]!;
    const path = pf.findLongPath(0, ax, az, bx, bz);
    if (path.length === 0) { console.log(`NO PATH ${ax},${az} -> ${bx},${bz}`); process.exit(1); }
    let prev = { x: ax, z: az };
    for (const w of path) {
        const steps = Math.max(Math.abs(w.x - prev.x), Math.abs(w.z - prev.z));
        for (let k = 0; k <= steps; k++) tiles.push({ x: Math.round(prev.x + ((w.x - prev.x) * k) / (steps || 1)), z: Math.round(prev.z + ((w.z - prev.z) * k) / (steps || 1)) });
        prev = w;
    }
}
const hits = new Map<string, { name: string; combat: number; at: string; closest: number; reach: number }>();
for (const d of danger) {
    let closest = 1e9;
    for (const t of tiles) closest = Math.min(closest, Math.max(Math.abs(t.x - d.x), Math.abs(t.z - d.z)));
    if (closest <= d.reach) hits.set(`${d.name}@${d.x},${d.z}`, { name: d.name, combat: d.combat, at: `${d.x},${d.z}`, closest, reach: d.reach });
}
console.log(`ROUTE ${pts.map(p => p.join(',')).join(' -> ')}: ${tiles.length} tiles, ${hits.size} danger spawns in reach (margin ${MARGIN})`);
for (const h of [...hits.values()].sort((a, b) => a.closest - b.closest)) console.log(`  ${h.name} (${h.combat}) at ${h.at}: path passes ${h.closest} tiles, reach ${h.reach}`);
