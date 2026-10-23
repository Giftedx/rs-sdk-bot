// Firemaking line search: scan the level-0 map for west-running rows of tiles where a fire can be lit, then join rows
// with short turns and rank the chains. Deterministic; reads only vendor data.
// Usage: bun scripts/measure/fm-line-search.ts [--need 157] [--top 10] [--turn 3] [--json out.json]
//
// A tile is lightable when skill_firemaking/scripts/firemaking.rs2 ~area_allow_loc_add passes:
//   - map_locaddunsafe is false: no ACTIVE loc covers the tile (engine ServerOps.ts MAP_LOCADDUNSAFE; LocType.ts
//     postDecode: active = config active=, else 1 when the loc has an op or a centrepiece model, i.e. a model file
//     with no shape suffix, tools/pack/config/LocConfig.ts LocShapeSuffix._8);
//   - map_blocked is false: no WALK_BLOCKED flag (LOC | FLOOR_DECORATION | FLOOR) in sdk/collision-data.json;
//   - the tile is not in a bank zone (skill_firemaking/configs/bank_zones.dbrow).
// The push after a fire is a teleport one tile west when lineofwalk allows it (firemaking.rs2 push_player), so a row
// is a run of lightable tiles where each westward step is open (the west tile has no BLOCK_WEST flag).
// Fires (cooking_sources.loc [fire]) are blockwalk=no, so a lit tile never stops the push; it only refuses a second
// fire on the same tile.
// Danger: NPC spawns from the map NPC sections whose config has a huntmode (same rule as research/route-danger.ts),
// within huntrange + wanderrange (default 5) of any tile on the chain; and Wilderness tiles (z >= 3520, x 2944-3391).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const content = join(root, 'vendor/rs-sdk/server/content');
const args = process.argv.slice(2);
const arg = (k: string, d: number) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const NEED = arg('--need', 157), TOP = arg('--top', 10), TURN = arg('--turn', 4), MAXTURNS = arg('--turns', 3), MARGIN = 3;
const SAFE = args.includes('--safe'); // drop Wilderness and desert-heat candidates
// --from x,z: rank by the distance from that tile to the line start (where the burner stands when it starts), and
// only start chains within --radius tiles of it. A row may then start at any of its tiles.
const FROM = args.includes('--from') ? args[args.indexOf('--from') + 1]!.split(',').map(Number) as [number, number] : undefined;
const RADIUS = arg('--radius', 40);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : undefined;

const F = { WALL_EAST: 0x8, LOC: 0x100, FLOOR_DECORATION: 0x40000, FLOOR: 0x200000 };
const WALK_BLOCKED = F.LOC | F.FLOOR_DECORATION | F.FLOOR;
const BLOCK_WEST = F.WALL_EAST | WALK_BLOCKED; // rsmod CollisionFlag.BLOCK_WEST = 2359560
const BLOCK = { W: BLOCK_WEST, E: 0x80 | WALK_BLOCKED, S: 0x2 | WALK_BLOCKED, N: 0x20 | WALK_BLOCKED };
const key = (x: number, z: number) => x * 16384 + z;

// ---- Collision (level 0).
const col = JSON.parse(readFileSync(join(root, 'vendor/rs-sdk/sdk/collision-data.json'), 'utf8')) as { tiles: number[][]; zones: number[][] };
const flags = new Map<number, number>();
for (const [lv, x, z, f] of col.tiles) if (lv === 0) flags.set(key(x!, z!), f! >>> 0);
const zones = new Set<number>();
for (const [lv, x, z] of col.zones) if (lv === 0) zones.add(key(x!, z!));
const loaded = (x: number, z: number) => zones.has(key(x & ~7, z & ~7));
const flag = (x: number, z: number) => flags.get(key(x, z)) ?? 0;

// ---- Packs: id -> name.
const pack = (f: string) => {
    const m = new Map<number, string>();
    for (const l of readFileSync(join(content, 'pack', f), 'utf8').split(/\r?\n/)) { const i = l.indexOf('='); if (i > 0) m.set(Number(l.slice(0, i)), l.slice(i + 1)); }
    return m;
};
const locNames = pack('loc.pack'), npcNames = pack('npc.pack');
const modelNames = new Set(pack('model.pack').values());

// ---- Configs (.loc and .npc anywhere under scripts/).
const files = (readdirSync(join(content, 'scripts'), { recursive: true }) as string[]).map(f => join(content, 'scripts', f));
type LocCfg = { models: string[]; op: boolean; active?: boolean; width: number; length: number; name?: string };
const locCfg = new Map<string, LocCfg>();
type NpcCfg = { hunt?: string; range: number; wander?: number };
const npcCfg = new Map<string, NpcCfg>();
for (const f of files) {
    const isLoc = f.endsWith('.loc'), isNpc = f.endsWith('.npc');
    if (!isLoc && !isNpc) continue;
    let cur: any = null;
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
        const h = line.match(/^\[([^\]]+)\]/);
        if (h) {
            const n = h[1]!;
            if (isLoc) { cur = locCfg.get(n) ?? { models: [], op: false, width: 1, length: 1 }; locCfg.set(n, cur); }
            else { cur = npcCfg.get(n) ?? { range: 0 }; npcCfg.set(n, cur); }
            continue;
        }
        if (!cur) continue;
        const kv = line.match(/^(\w+)=(.*)$/);
        if (!kv) continue;
        const [, k, v] = kv as unknown as [string, string, string];
        if (isLoc) {
            if (/^model\d?$/.test(k)) cur.models.push(v.trim());
            else if (/^op[1-5]$/.test(k) && v.trim() !== 'hidden') cur.op = true;
            else if (k === 'active') cur.active = v.trim() === 'yes';
            else if (k === 'width') cur.width = Number(v);
            else if (k === 'length') cur.length = Number(v);
            else if (k === 'name') cur.name = v.trim();
        } else {
            if (k === 'huntmode') cur.hunt = v.trim();
            else if (k === 'huntrange') cur.range = Number(v);
            else if (k === 'wanderrange') cur.wander = Number(v);
        }
    }
}
const locActive = (c: LocCfg | undefined) => {
    if (!c) return true; // unknown loc: treat as unsafe
    if (c.active !== undefined) return c.active;
    if (c.op) return true;
    return c.models.some(m => modelNames.has(m)); // a model with no shape suffix is shape 10 (centrepiece)
};

// ---- Map files: locs (unsafe tiles, bank booths) and NPC spawns.
const unsafe = new Map<number, string>();
const booths: { x: number; z: number }[] = [];
const spawns: { name: string; x: number; z: number; reach: number }[] = [];
const huntSkip = /gnomeball|mm_guard|shades|hauntedmine|battle_mage/;
for (const f of readdirSync(join(content, 'maps')).filter(f => /^m\d+_\d+\.jm2$/.test(f))) {
    const [, mxs, mzs] = f.match(/^m(\d+)_(\d+)/)!;
    const bx = Number(mxs) * 64, bz = Number(mzs) * 64;
    let sec = '';
    for (const line of readFileSync(join(content, 'maps', f), 'utf8').split(/\r?\n/)) {
        if (line.startsWith('====')) { sec = line; continue; }
        if (sec.includes('LOC')) {
            const m = line.match(/^(\d+) (\d+) (\d+): (\d+) (\d+)(?: (\d+))?/);
            if (!m || m[1] !== '0') continue;
            const name = locNames.get(Number(m[4])) ?? `loc${m[4]}`;
            const c = locCfg.get(name);
            const x = bx + Number(m[2]), z = bz + Number(m[3]), angle = Number(m[6] ?? 0);
            if (/bankbooth|bank_booth/i.test(name) || /bank booth/i.test(c?.name ?? '')) booths.push({ x, z });
            if (!locActive(c)) continue;
            const w = angle === 1 || angle === 3 ? (c?.length ?? 1) : (c?.width ?? 1);
            const l = angle === 1 || angle === 3 ? (c?.width ?? 1) : (c?.length ?? 1);
            for (let dx = 0; dx < w; dx++) for (let dz = 0; dz < l; dz++) if (!unsafe.has(key(x + dx, z + dz))) unsafe.set(key(x + dx, z + dz), name);
        } else if (sec.includes('NPC')) {
            const m = line.match(/^(\d+) (\d+) (\d+): (\d+)/);
            if (!m || m[1] !== '0') continue;
            const name = npcNames.get(Number(m[4])) ?? '';
            const c = npcCfg.get(name);
            if (c?.hunt && !huntSkip.test(c.hunt)) spawns.push({ name, x: bx + Number(m[2]), z: bz + Number(m[3]), reach: (c.range || 1) + (c.wander ?? 5) });
        }
    }
}

// ---- Bank zones.
const bankRects: [number, number, number, number][] = [];
for (const l of readFileSync(join(content, 'scripts/skill_firemaking/configs/bank_zones.dbrow'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/coord_pair,(\d+)_(\d+)_(\d+)_(\d+)_(\d+),(\d+)_(\d+)_(\d+)_(\d+)_(\d+)/);
    if (!m) continue;
    const n = m.slice(1).map(Number);
    const [ax, az, bx2, bz2] = [n[1]! * 64 + n[3]!, n[2]! * 64 + n[4]!, n[6]! * 64 + n[8]!, n[7]! * 64 + n[9]!];
    if (n[0] === 0) bankRects.push([Math.min(ax, bx2), Math.min(az, bz2), Math.max(ax, bx2), Math.max(az, bz2)]);
}
const inBank = (x: number, z: number) => bankRects.some(([a, b, c, d]) => x >= a && x <= c && z >= b && z <= d);
// Desert heat (areas/area_desert/configs/desert_heat_zones.dbrow desert_zones minus desertheat_disabled_zones): a
// heat hit every 150 ticks or less without water, so a 650-tick burn there needs waterskins. Counted as a hazard.
const rectTable = (file: string, table: string) => {
    const out: [number, number, number, number][] = [];
    let on = false;
    for (const l of readFileSync(join(content, file), 'utf8').split(/\r?\n/)) {
        if (l.startsWith('[')) on = l === `[${table}]`;
        const m = on && l.match(/coord_pair,(\d+)_(\d+)_(\d+)_(\d+)_(\d+),(\d+)_(\d+)_(\d+)_(\d+)_(\d+)/);
        if (!m) continue;
        const n = m.slice(1).map(Number);
        out.push([n[1]! * 64 + n[3]!, n[2]! * 64 + n[4]!, n[6]! * 64 + n[8]!, n[7]! * 64 + n[9]!]);
    }
    return out;
};
const inRects = (r: [number, number, number, number][], x: number, z: number) => r.some(([a, b, c, d]) => x >= a && x <= c && z >= b && z <= d);
const desertOn = rectTable('scripts/areas/area_desert/configs/desert_heat_zones.dbrow', 'desert_zones');
const desertOff = rectTable('scripts/areas/area_desert/configs/desert_heat_zones.dbrow', 'desertheat_disabled_zones');
const desert = (x: number, z: number) => inRects(desertOn, x, z) && !inRects(desertOff, x, z);
const wild = (x: number, z: number) => z >= 3520 && z < 4000 && x >= 2944 && x < 3392;

const lightable = (x: number, z: number) => reach.has(key(x, z)) && (flag(x, z) & WALK_BLOCKED) === 0 && !unsafe.has(key(x, z)) && !inBank(x, z);
const westOpen = (x: number, z: number) => (flag(x - 1, z) & BLOCK_WEST) === 0 && (flag(x, z) & 0x80) === 0 && loaded(x - 1, z);

// ---- Reachable from Lumbridge spawn (3222,3218) on foot, doors counted as open (collision-data.json doors list).
const doorTiles = new Set<number>();
for (const d of (col as any).doors as number[][]) if (d[0] === 0) { doorTiles.add(key(d[1]!, d[2]!)); }
const reach = new Set<number>();
{
    const q: number[] = [key(3222, 3218)]; reach.add(q[0]!);
    const dirs: [number, number, number, number][] = [[-1, 0, BLOCK.W, 0x80], [1, 0, BLOCK.E, 0x8], [0, -1, BLOCK.S, 0x20], [0, 1, BLOCK.N, 0x2]];
    while (q.length) {
        const k = q.pop()!; const x = Math.floor(k / 16384), z = k % 16384;
        for (const [dx, dz, b, own] of dirs) {
            const nx = x + dx, nz = z + dz, nk = key(nx, nz);
            if (reach.has(nk) || !loaded(nx, nz)) continue;
            const door = doorTiles.has(k) || doorTiles.has(nk);
            const wallMask = door ? WALK_BLOCKED : b;
            if ((flag(nx, nz) & wallMask) !== 0) continue;
            if (!door && (flag(x, z) & own) !== 0) continue;
            reach.add(nk); q.push(nk);
        }
    }
}

// ---- Rows: maximal west runs. A row starts at its east end (sx) and ends at its west end (ex).
type Row = { z: number; sx: number; ex: number; len: number };
const rows: Row[] = [];
const zoneKeys = [...zones].map(k => ({ x: Math.floor(k / 16384), z: k % 16384 }));
const zs = new Set<number>(), xsByZ = new Map<number, number[]>();
for (const zk of zoneKeys) for (let dz = 0; dz < 8; dz++) {
    const z = zk.z + dz;
    zs.add(z);
    const a = xsByZ.get(z) ?? []; for (let dx = 0; dx < 8; dx++) a.push(zk.x + dx); xsByZ.set(z, a);
}
for (const z of zs) {
    const xs = [...new Set(xsByZ.get(z)!)].sort((a, b) => b - a); // east to west
    let start = -1, prev = -1;
    for (const x of xs) {
        const ok = lightable(x, z);
        if (start >= 0 && ok && x === prev - 1 && westOpen(prev, z)) { prev = x; continue; }
        if (start >= 0 && start - prev + 1 >= 20) rows.push({ z, sx: start, ex: prev, len: start - prev + 1 });
        start = ok ? x : -1; prev = x;
    }
    if (start >= 0 && start - prev + 1 >= 20) rows.push({ z, sx: start, ex: prev, len: start - prev + 1 });
}

// ---- Short walk between the end of one row and the start of the next (BFS on walk flags, at most TURN steps,
// 8-way steps). MEASURED on practice (scripts/measure/floor-fm-line.ts): with run on and the next op sent when the push
// shows, a turn of up to 4 steps (2 ticks running) costs 0 ticks; 6 steps (3 ticks) cost 4 ticks (a fresh 3-tick attempt).
// One step, rsmod rules: a diagonal needs both orthogonal steps open as well.
const stepOk = (x: number, z: number, dx: number, dz: number) => {
    const b = dx < 0 ? BLOCK.W : dx > 0 ? BLOCK.E : dz < 0 ? BLOCK.S : BLOCK.N;
    return (flag(x + dx, z + dz) & b) === 0;
};
const step = (x: number, z: number, dx: number, dz: number): boolean => {
    if (dx === 0 || dz === 0) return stepOk(x, z, dx, dz);
    return stepOk(x, z, dx, 0) && stepOk(x + dx, z, 0, dz) && stepOk(x, z, 0, dz) && stepOk(x, z + dz, dx, 0);
};
const walkSteps = (ax: number, az: number, bx: number, bz: number, max: number) => {
    let frontier = [[ax, az]], seen = new Set([key(ax, az)]);
    for (let d = 0; d <= max; d++) {
        const next: number[][] = [];
        for (const [x, z] of frontier) {
            if (x === bx && z === bz) return d;
            for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
                const nx = x! + dx, nz = z! + dz;
                if (seen.has(key(nx, nz)) || !loaded(nx, nz) || !step(x!, z!, dx, dz)) continue;
                seen.add(key(nx, nz)); next.push([nx, nz]);
            }
        }
        frontier = next;
    }
    return -1;
};

// ---- Chains: a row, plus up to 3 more rows whose east start is a short walk from the previous row's west end. A
// later row may be used from any tile, so its useful start is the tile nearest the previous end.
type Chain = { rows: { z: number; sx: number; ex: number; len: number }[]; len: number; turns: number; walk: number };
const byZ = new Map<number, Row[]>();
for (const r of rows) { const a = byZ.get(r.z) ?? []; a.push(r); byZ.set(r.z, a); }
const chains: Chain[] = [];
const extend = (c: Chain) => {
    chains.push(c);
    if (c.len >= NEED || c.turns >= MAXTURNS) return;
    const last = c.rows[c.rows.length - 1]!;
    // After the last fire of a row the push goes west if that step is open (onto an unlightable tile), else east
    // onto the fire just lit (fires do not block walking).
    const px = westOpen(last.ex, last.z) ? last.ex - 1 : last.ex + 1;
    for (let dz = -TURN; dz <= TURN; dz++) for (const r of byZ.get(last.z + dz) ?? []) {
        // Start the next row at the tile nearest the player (at most TURN walk steps).
        for (let sx = Math.min(r.sx, px + TURN); sx >= Math.max(r.ex, px - TURN); sx--) {
            if (sx - r.ex + 1 < 10) break;
            if (c.rows.some(q => q.z === r.z && !(sx < q.ex || r.ex > q.sx))) continue; // no tile twice
            const w = walkSteps(px, last.z, sx, r.z, TURN);
            if (w < 0) continue;
            extend({ rows: [...c.rows, { z: r.z, sx, ex: r.ex, len: sx - r.ex + 1 }], len: c.len + sx - r.ex + 1, turns: c.turns + 1, walk: c.walk + w });
            break;
        }
    }
};
if (FROM) {
    const [ax, az] = FROM;
    for (const r of rows) {
        if (Math.abs(r.z - az) > RADIUS) continue;
        for (let sx = Math.min(r.sx, ax + RADIUS); sx - r.ex + 1 >= 20 && sx >= ax - RADIUS; sx -= 2)
            extend({ rows: [{ ...r, sx, len: sx - r.ex + 1 }], len: sx - r.ex + 1, turns: 0, walk: 0 });
    }
} else for (const r of rows) if (r.len >= 40) extend({ rows: [r], len: r.len, turns: 0, walk: 0 });

// ---- Score: the first NEED tiles of the chain (a long row is cut at its best NEED-tile window later).
const nearBooth = (x: number, z: number) => booths.reduce((b, p) => Math.min(b, Math.max(Math.abs(p.x - x), Math.abs(p.z - z))), 1e9);
const dangerOf = (tiles: { x: number; z: number }[]) => {
    const hits = new Map<string, number>();
    for (const s of spawns) for (const t of tiles) {
        const d = Math.max(Math.abs(s.x - t.x), Math.abs(s.z - t.z));
        if (d <= s.reach) { hits.set(`${s.name}@${s.x},${s.z}`, d); break; }
    }
    return { count: hits.size, wild: tiles.some(t => wild(t.x, t.z)), desert: tiles.some(t => desert(t.x, t.z)), list: [...hits.keys()].slice(0, 6) };
};
type Cand = Chain & { tiles: number; bank: number; from: number; danger: ReturnType<typeof dangerOf>; start: { x: number; z: number }; end: { x: number; z: number } };
const cands: Cand[] = [];
for (const c of chains.filter(c => c.len >= NEED || c.turns === 0)) {
    // A single long row: try every NEED-tile window and keep the one nearest a bank.
    const windows: Chain[] = [];
    if (c.turns === 0 && c.len > NEED) {
        const r = c.rows[0]!;
        for (let sx = r.sx; sx - NEED + 1 >= r.ex; sx -= 4) windows.push({ ...c, rows: [{ z: r.z, sx, ex: sx - NEED + 1, len: NEED }], len: NEED });
    } else windows.push(c);
    let best: Cand | undefined;
    for (const w of windows) {
        const tiles: { x: number; z: number }[] = [];
        for (const r of w.rows) for (let x = r.sx; x >= r.ex; x--) tiles.push({ x, z: r.z });
        const used = tiles.slice(0, NEED);
        const start = used[0]!, end = used[used.length - 1]!;
        const bank = Math.min(nearBooth(start.x, start.z), ...w.rows.map(r => nearBooth(r.sx, r.z)));
        const from = FROM ? Math.max(Math.abs(start.x - FROM[0]), Math.abs(start.z - FROM[1])) : 0;
        const cand = { ...w, tiles: Math.min(w.len, NEED), bank, from, danger: dangerOf(used), start, end };
        const key2 = (c: Cand) => (FROM ? c.from : c.bank) * 10 + c.danger.count;
        if (!best || key2(cand) < key2(best)) best = cand;
    }
    if (best) cands.push(best);
}
// Rank: enough tiles, no Wilderness, fewest danger spawns, fewest turns, nearest bank.
const score = (c: Cand) => (c.tiles >= NEED ? 0 : 1e6 * (NEED - c.tiles)) + (c.danger.wild ? 1e5 : 0) + (c.danger.desert ? 5e4 : 0) + c.danger.count * 1000 + c.turns * 20 + c.walk * 5 + (FROM ? c.from * 20 : c.bank);
cands.sort((a, b) => score(a) - score(b));
// One candidate per area (start tile within 10 tiles of a better one counts as the same line).
const picked: Cand[] = [];
for (const c of cands) {
    if (SAFE && (c.danger.wild || c.danger.desert)) continue;
    if (picked.some(p => Math.abs(p.start.x - c.start.x) <= 10 && Math.abs(p.start.z - c.start.z) <= 10)) continue;
    picked.push(c);
    if (picked.length >= TOP) break;
}
console.log(`SCAN rows>=20: ${rows.length}, longest row ${Math.max(...rows.map(r => r.len))}, chains ${chains.length}, reachable ${reach.size}, booths ${booths.length}, danger spawns ${spawns.length}, unsafe-loc tiles ${unsafe.size}`);
picked.forEach((c, i) => {
    const rs = c.rows.map(r => `z${r.z}:x${r.sx}->${r.ex}(${r.len})`).join(' + ');
    console.log(`LINE ${i + 1} tiles=${c.tiles} turns=${c.turns} turnWalk=${c.walk} start=${c.start.x},${c.start.z} end=${c.end.x},${c.end.z} bank=${c.bank}${FROM ? ` from=${c.from}` : ''} danger=${c.danger.count}${c.danger.wild ? ' WILD' : ''}${c.danger.desert ? ' DESERT' : ''} rows=${rs}${c.danger.list.length ? ` npcs=${c.danger.list.join(',')}` : ''}`);
});
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(picked, null, 1));
