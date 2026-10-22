// Finds the standing tiles that touch the most iron rocks (Chebyshev distance 1), from the map files.
// Usage: bun research/iron-spots.ts [rockNameRegex=^(ironrock1|ironrock2)$]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseJm2 } from '../packages/knowledge/src/jm2';
import { parsePack } from '../packages/knowledge/src/pack';

const content = join(import.meta.dir, '..', 'vendor', 'rs-sdk', 'server', 'content');
const names = parsePack(readFileSync(join(content, 'pack', 'loc.pack'), 'utf8'));
const re = new RegExp(process.argv[2] ?? '^(ironrock1|ironrock2)$');
const rocks: { x: number; z: number; level: number }[] = [];
for (const f of readdirSync(join(content, 'maps')).filter(f => f.endsWith('.jm2'))) {
    for (const l of parseJm2(f, readFileSync(join(content, 'maps', f), 'utf8')).locs) if (re.test(names.get(l.id) ?? '')) rocks.push(l);
}
const key = (x: number, z: number, lv: number) => `${lv}:${x}:${z}`;
const rockSet = new Set(rocks.map(r => key(r.x, r.z, r.level)));
const score = new Map<string, number>();
for (const r of rocks) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    if (!dx && !dz) continue;
    const k = key(r.x + dx, r.z + dz, r.level);
    if (!rockSet.has(k)) score.set(k, (score.get(k) ?? 0) + 1);
}
console.log(`${rocks.length} rocks`);
for (const [k, n] of [...score].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(n, k);
