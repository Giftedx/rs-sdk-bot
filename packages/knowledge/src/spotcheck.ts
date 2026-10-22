import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentRoot, knowledgeDir } from './paths';
import { cleanLines } from './text';
import type { Item } from './items';
import type { Npc } from './npcs';
import type { Shop } from './shops';
import type { Edge } from './transports';

type Spawn = Npc['spawns'][number] & { id: number };
type Stock = Shop['stock'][number];

export type Fact =
    | { kind: 'item'; record: Item }
    | { kind: 'npc'; record: Npc }
    | { kind: 'spawn'; record: Spawn }
    | { kind: 'stock'; record: Stock }
    | { kind: 'transport'; record: Edge };

const fileCache = new Map<string, string[]>();
function lineAt(src: string): string {
    const i = src.lastIndexOf(':');
    const file = src.slice(0, i);
    const n = Number(src.slice(i + 1));
    if (!fileCache.has(file)) fileCache.set(file, cleanLines(readFileSync(join(contentRoot(), file), 'utf8')));
    return fileCache.get(file)![n - 1] ?? '';
}

// The raw value the source line must contain for the fact to be true.
function expected(f: Fact): { src: string; test: (line: string) => boolean; label: string } {
    switch (f.kind) {
        case 'item': {
            const r = f.record;
            return { src: r.src, label: `${r.debugname} cost=${r.cost}`, test: l => l === `cost=${r.cost}` || (r.cost === 1 && l === `[${r.debugname}]`) };
        }
        case 'npc':
            return { src: f.record.src, label: `[${f.record.debugname}]`, test: l => l === `[${f.record.debugname}]` };
        case 'spawn': {
            const r = f.record;
            const head = `${r.level} ${r.x % 64} ${r.z % 64}: ${r.id}`;
            return { src: r.src, label: head, test: l => l === head || l.startsWith(`${head} `) };
        }
        case 'stock': {
            const r = f.record;
            return { src: r.src, label: `${r.item},${r.count}`, test: l => l.includes(`=${r.item},${r.count}`) };
        }
        case 'transport': {
            const r = f.record;
            const head = `${r.from.level} ${r.from.x % 64} ${r.from.z % 64}:`;
            return { src: r.src, label: `${r.locName} at ${head}`, test: l => l.startsWith(head) };
        }
    }
}

export function checkFacts(facts: Fact[]): { checked: number; wrong: { fact: string; src: string; line: string }[] } {
    const wrong: { fact: string; src: string; line: string }[] = [];
    for (const f of facts) {
        const e = expected(f);
        const line = lineAt(e.src);
        if (!e.test(line)) wrong.push({ fact: `${f.kind}: ${e.label}`, src: e.src, line });
    }
    return { checked: facts.length, wrong };
}

// Small deterministic PRNG so a seed always picks the same sample.
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function allFacts(): Fact[] {
    const load = <T>(name: string): T => JSON.parse(readFileSync(join(knowledgeDir(), name), 'utf8'));
    const items = load<Item[]>('items.json');
    const npcs = load<Npc[]>('npcs.json');
    const shops = load<Shop[]>('shops.json');
    const edges = load<Edge[]>('transports.json');
    return [
        ...items.map(record => ({ kind: 'item', record }) as Fact),
        ...npcs.map(record => ({ kind: 'npc', record }) as Fact),
        ...npcs.flatMap(n => n.spawns.map(s => ({ kind: 'spawn', record: { ...s, id: n.id } }) as Fact)),
        ...shops.flatMap(s => s.stock.map(record => ({ kind: 'stock', record }) as Fact)),
        ...edges.map(record => ({ kind: 'transport', record }) as Fact),
    ];
}

export function spotcheck(n: number, seed: number) {
    const facts = allFacts();
    const rand = mulberry32(seed);
    const sample: Fact[] = [];
    const used = new Set<number>();
    while (sample.length < Math.min(n, facts.length)) {
        const i = Math.floor(rand() * facts.length);
        if (!used.has(i)) { used.add(i); sample.push(facts[i]!); }
    }
    return { ...checkFacts(sample), sample: sample.map(f => `${f.kind}:${expected(f).src}`) };
}

if (import.meta.main) {
    const n = Number(process.argv[2] ?? 50);
    const seed = Number(process.argv[3] ?? 1);
    const r = spotcheck(n, seed);
    for (const w of r.wrong) console.log(`WRONG ${w.fact} @ ${w.src}: "${w.line}"`);
    console.log(`checked ${r.checked}, wrong ${r.wrong.length}`);
    process.exit(r.wrong.length === 0 ? 0 : 1);
}
