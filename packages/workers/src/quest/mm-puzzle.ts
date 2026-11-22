// The Monkey Madness reinitialisation puzzle (mm_puzzle.rs2): a 5x5 sliding puzzle in inventory
// reinitialisation_inv, shown on reinitialisation_puzzle:com_3. Slot i holds tile i+1 when solved; slot 24 is empty
// (reinit_puzzle_complete checks slots 0-23). The scramble is a 255-step random walk of the empty slot
// (shuffle_reinit_puzzle). A click on a tile next to the empty slot moves it there ([opheld5,_mm_reinit]).
// The board is an array of 25 numbers: tile number 1-24, 0 for the empty slot.

const N = 5;

function manhattan(b: number[]): number {
    let h = 0;
    for (let i = 0; i < 25; i++) {
        const t = b[i]!;
        if (t === 0) continue;
        const g = t - 1;
        h += Math.abs((i % N) - (g % N)) + Math.abs(Math.floor(i / N) - Math.floor(g / N));
    }
    return h;
}

// Linear conflict on rows and columns (2 moves for each pair of tiles in their goal line but in reverse order).
function conflict(b: number[]): number {
    let c = 0;
    for (let r = 0; r < N; r++) {
        for (let a = 0; a < N; a++) {
            const ta = b[r * N + a]!;
            if (ta === 0 || Math.floor((ta - 1) / N) !== r) continue;
            for (let k = a + 1; k < N; k++) {
                const tb = b[r * N + k]!;
                if (tb !== 0 && Math.floor((tb - 1) / N) === r && tb < ta) c += 2;
            }
        }
    }
    for (let col = 0; col < N; col++) {
        for (let a = 0; a < N; a++) {
            const ta = b[a * N + col]!;
            if (ta === 0 || (ta - 1) % N !== col) continue;
            for (let k = a + 1; k < N; k++) {
                const tb = b[k * N + col]!;
                if (tb !== 0 && (tb - 1) % N === col && tb < ta) c += 2;
            }
        }
    }
    return c;
}

const heur = (b: number[]): number => manhattan(b) + conflict(b);

export function solved(b: number[]): boolean {
    for (let i = 0; i < 24; i++) if (b[i] !== i + 1) return false;
    return true;
}

function neighbours(e: number): number[] {
    const out: number[] = [];
    if (e % N !== 0) out.push(e - 1);
    if (e % N !== N - 1) out.push(e + 1);
    if (e >= N) out.push(e - N);
    if (e < 20) out.push(e + N);
    return out;
}

// Binary heap on f.
class Heap<T> {
    private a: { f: number; v: T }[] = [];
    get size(): number { return this.a.length; }
    push(f: number, v: T): void {
        const a = this.a;
        a.push({ f, v });
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (a[p]!.f <= a[i]!.f) break;
            [a[p], a[i]] = [a[i]!, a[p]!];
            i = p;
        }
    }
    pop(): T | undefined {
        const a = this.a;
        if (a.length === 0) return undefined;
        const top = a[0]!.v;
        const last = a.pop()!;
        if (a.length > 0) {
            a[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                if (l < a.length && a[l]!.f < a[m]!.f) m = l;
                if (r < a.length && a[r]!.f < a[m]!.f) m = r;
                if (m === i) break;
                [a[m], a[i]] = [a[i]!, a[m]!];
                i = m;
            }
        }
        return top;
    }
}

// Weighted A*: returns the slots to click, in order (each click moves that slot's tile into the empty slot).
export function solve(start: number[], weight = 1.6, maxNodes = 3_000_000): number[] | null {
    if (solved(start)) return [];
    type Node = { b: number[]; e: number; g: number; prev: Node | null; click: number };
    const key = (b: number[]): string => String.fromCharCode(...b.map(x => x + 65));
    const root: Node = { b: start, e: start.indexOf(0), g: 0, prev: null, click: -1 };
    const open = new Heap<Node>();
    const best = new Map<string, number>([[key(start), 0]]);
    open.push(weight * heur(start), root);
    let n = 0;
    while (open.size > 0 && n < maxNodes) {
        const cur = open.pop()!;
        n++;
        if (solved(cur.b)) {
            const path: number[] = [];
            for (let x: Node | null = cur; x && x.click >= 0; x = x.prev) path.push(x.click);
            return path.reverse();
        }
        for (const s of neighbours(cur.e)) {
            if (cur.prev && s === cur.prev.e) continue;
            const b = cur.b.slice();
            b[cur.e] = b[s]!;
            b[s] = 0;
            const k = key(b);
            const g = cur.g + 1;
            const old = best.get(k);
            if (old !== undefined && old <= g) continue;
            best.set(k, g);
            open.push(g + weight * heur(b), { b, e: s, g, prev: cur, click: s });
        }
    }
    return null;
}

// Same scramble as shuffle_reinit_puzzle: 255 steps of the empty slot from the solved board.
export function scramble(moves = 255, rnd: () => number = Math.random): number[] {
    const b = Array.from({ length: 25 }, (_, i) => (i < 24 ? i + 1 : 0));
    let e = 24;
    for (let m = 0; m < moves; m++) {
        const ns = neighbours(e);
        const s = ns[Math.floor(rnd() * ns.length)]!;
        b[e] = b[s]!;
        b[s] = 0;
        e = s;
    }
    return b;
}

export function applyClick(b: number[], slot: number): boolean {
    const e = b.indexOf(0);
    if (!neighbours(e).includes(slot)) return false;
    b[e] = b[slot]!;
    b[slot] = 0;
    return true;
}

if (import.meta.main) {
    const lens: number[] = [];
    let worst = 0;
    for (let i = 0; i < Number(process.argv[2] ?? 30); i++) {
        const b = scramble();
        const t0 = performance.now();
        const p = solve(b);
        const ms = performance.now() - t0;
        worst = Math.max(worst, ms);
        if (!p) { console.log('FAIL', b.join(',')); continue; }
        const c = b.slice();
        for (const s of p) if (!applyClick(c, s)) throw new Error('bad click');
        if (!solved(c)) throw new Error('not solved');
        lens.push(p.length);
    }
    lens.sort((a, b) => a - b);
    console.log(`n=${lens.length} min=${lens[0]} median=${lens[lens.length >> 1]} max=${lens[lens.length - 1]} worstMs=${worst.toFixed(0)}`);
}
