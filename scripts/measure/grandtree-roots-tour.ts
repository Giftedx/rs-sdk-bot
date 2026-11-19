// The Grand Tree: the least mean search tour of the 15 Daconia roots from King Narnode in the roots (each root is equally
// likely). bun scripts/measure/grandtree-roots-tour.ts prints the mean of the east-first tour (CURRENT) and of the best order.
import { findLongPath, isTileWalkable } from '../../vendor/rs-sdk/sdk/pathfinding';

const START = { x: 2464, z: 9895 };
// daconia_coords.enum values 1..15 (0_38_154_x_z -> 2432+x, 9856+z)
const ROOTS: [number, number][] = [[2456, 9886], [2457, 9881], [2455, 9874], [2443, 9878], [2439, 9881], [2444, 9893], [2452, 9893],
    [2465, 9891], [2468, 9890], [2467, 9896], [2473, 9897], [2481, 9904], [2485, 9885], [2490, 9889], [2467, 9872]];
const CURRENT: [number, number][] = [[2467, 9896], [2473, 9897], [2481, 9904], [2490, 9889], [2485, 9885], [2468, 9890], [2465, 9891],
    [2456, 9886], [2457, 9881], [2455, 9874], [2467, 9872], [2443, 9878], [2439, 9881], [2444, 9893], [2452, 9893]];

// The stand tile of each root: the walkable neighbour nearest the start (a root loc blocks its own tile).
const stand = ROOTS.map(([x, z]) => {
    const n: { x: number; z: number }[] = [];
    for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) if (isTileWalkable(0, x + dx, z + dz)) n.push({ x: x + dx, z: z + dz });
    return n.length ? n : [{ x, z }];
});
const pathLen = (a: { x: number; z: number }, b: { x: number; z: number }): number => {
    const p = findLongPath(0, a.x, a.z, b.x, b.z);
    if (!p.length) return 999;
    const end = p[p.length - 1]!;
    if (end.x !== b.x || end.z !== b.z) return 999;
    let d = 0, c = a;
    for (const w of p) { d += Math.max(Math.abs(w.x - c.x), Math.abs(w.z - c.z)); c = w; }
    return d;
};
// Distance from a point to root j: the nearest stand tile of j.
const toRoot = (a: { x: number; z: number }, j: number) => Math.min(...stand[j]!.map(s => pathLen(a, s)));
const N = ROOTS.length;
const pos = stand.map(s => s[0]!);
const D = pos.map(a => ROOTS.map((_, j) => toRoot(a, j)));
const D0 = ROOTS.map((_, j) => toRoot(START, j));
console.log('stand', JSON.stringify(stand));
console.log('start dists', D0.join(' '));
// Ticks: running is 2 tiles a tick; a search costs SEARCH ticks.
const SEARCH = 3;
const ticks = (d: number) => Math.ceil(d / 2);
const latency = (order: number[]) => {
    let t = 0, sum = 0, prev = -1;
    for (const j of order) { t += ticks(prev < 0 ? D0[j]! : D[prev]![j]!) + SEARCH; sum += t; prev = j; }
    return sum / N;
};
const idx = (x: number, z: number) => ROOTS.findIndex(r => r[0] === x && r[1] === z);
const cur = CURRENT.map(([x, z]) => idx(x, z));
console.log('east-first expected', latency(cur).toFixed(1), 'worst', (() => { let t = 0, p = -1; for (const j of cur) { t += ticks(p < 0 ? D0[j]! : D[p]![j]!) + SEARCH; p = j; } return t; })());
// DP: f[mask][last] = least sum of arrival times, weighted by the roots still unsearched.
const FULL = 1 << N, INF = 1e9;
const f = new Float64Array(FULL * N).fill(INF), from = new Int32Array(FULL * N).fill(-1);
for (let j = 0; j < N; j++) f[(1 << j) * N + j] = N * (ticks(D0[j]!) + SEARCH);
for (let m = 1; m < FULL; m++) {
    let left = N; for (let b = m; b; b &= b - 1) left--;
    for (let j = 0; j < N; j++) {
        const v = f[m * N + j]!; if (v >= INF || !(m & (1 << j))) continue;
        for (let k = 0; k < N; k++) {
            if (m & (1 << k)) continue;
            const nm = m | (1 << k), nv = v + left * (ticks(D[j]![k]!) + SEARCH);
            if (nv < f[nm * N + k]!) { f[nm * N + k] = nv; from[nm * N + k] = j; }
        }
    }
}
let best = INF, last = -1;
for (let j = 0; j < N; j++) if (f[(FULL - 1) * N + j]! < best) { best = f[(FULL - 1) * N + j]!; last = j; }
const order: number[] = [];
for (let m = FULL - 1, j = last; j >= 0;) { order.unshift(j); const p = from[m * N + j]!; m &= ~(1 << j); j = p; }
console.log('best expected', (best / N).toFixed(1), 'check', latency(order).toFixed(1));
console.log('order', JSON.stringify(order.map(j => ROOTS[j])));
