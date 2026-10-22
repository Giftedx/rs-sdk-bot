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

// The config block (props by key) that starts at a [name] header line. Re-read here so the check does not
// share code with the builder it is checking.
function blockAt(src: string): { header: string; props: Record<string, string> } {
    const i = src.lastIndexOf(':');
    const file = src.slice(0, i);
    const start = Number(src.slice(i + 1));
    lineAt(src);
    const lines = fileCache.get(file)!;
    const props: Record<string, string> = {};
    for (let n = start; n < lines.length; n++) {
        const l = lines[n]!;
        if (l.startsWith('[')) break;
        const eq = l.indexOf('=');
        if (eq > 0 && !(l.slice(0, eq) in props)) props[l.slice(0, eq)] = l.slice(eq + 1);
    }
    return { header: lines[start - 1] ?? '', props };
}

const packCache = new Map<string, Set<string>>();
function inPack(pack: string, id: number, name: string): boolean {
    if (!packCache.has(pack)) packCache.set(pack, new Set(cleanLines(readFileSync(join(contentRoot(), 'pack', `${pack}.pack`), 'utf8'))));
    return packCache.get(pack)!.has(`${id}=${name}`);
}

const fmt = (c: { x: number; z: number; level: number }) => `${c.level}_${c.x >> 6}_${c.z >> 6}_${c.x & 63}_${c.z & 63}`;

// Each check returns the src it read and whether every field of the record matches the source text.
function expected(f: Fact): { src: string; ok: () => boolean; label: string } {
    switch (f.kind) {
        case 'item': {
            const r = f.record;
            return {
                src: r.def,
                label: `${r.id} ${r.debugname} name=${r.name} cost=${r.cost} members=${r.members} tradeable=${r.tradeable}`,
                ok: () => {
                    const b = blockAt(r.def);
                    return b.header === `[${r.debugname}]`
                        && inPack('obj', r.id, r.debugname)
                        && (b.props.name ?? r.debugname) === r.name
                        && Number(b.props.cost ?? 1) === r.cost
                        && (b.props.members === 'yes') === r.members
                        && (b.props.tradeable !== 'no') === r.tradeable;
                },
            };
        }
        case 'npc': {
            const r = f.record;
            return {
                src: r.src,
                label: `${r.id} ${r.debugname} name=${r.name} combat=${r.combat}`,
                ok: () => {
                    const b = blockAt(r.src);
                    const v = b.props.vislevel;
                    const combat = v === undefined ? 1 : v === 'hide' ? 0 : Number(v);
                    return b.header === `[${r.debugname}]` && inPack('npc', r.id, r.debugname) && (b.props.name ?? r.debugname) === r.name && combat === r.combat;
                },
            };
        }
        case 'spawn': {
            const r = f.record;
            const head = `${r.level} ${r.x % 64} ${r.z % 64}: ${r.id}`;
            const file = r.src.slice(0, r.src.lastIndexOf(':'));
            const m = file.match(/m(\d+)_(\d+)\.jm2$/);
            return {
                src: r.src,
                label: head,
                ok: () => !!m && Number(m[1]) === r.x >> 6 && Number(m[2]) === r.z >> 6 && (lineAt(r.src) === head || lineAt(r.src).startsWith(`${head} `)),
            };
        }
        case 'stock': {
            const r = f.record;
            const want = r.restockTicks === null ? `${r.item},${r.count}` : `${r.item},${r.count},${r.restockTicks}`;
            return { src: r.src, label: want, ok: () => /^stock\d+=/.test(lineAt(r.src)) && lineAt(r.src).split('=')[1] === want };
        }
        case 'transport': {
            const r = f.record;
            return {
                src: r.toSrc,
                label: `${r.locName} ${fmt(r.from)} -> ${fmt(r.to)} exact=${r.exact}`,
                ok: () => {
                    const toLine = lineAt(r.toSrc);
                    if (!r.exact) {
                        const d = `${r.to.x - r.from.x}, ${r.to.level - r.from.level}, ${r.to.z - r.from.z}`;
                        const head = `${r.from.level} ${r.from.x % 64} ${r.from.z % 64}:`;
                        return toLine.includes(`movecoord(`) && toLine.replace(/\s+/g, ' ').includes(d.replace(/\s+/g, ' ')) && lineAt(r.src).startsWith(head);
                    }
                    if (r.src === r.toSrc) return toLine.includes(`case ${fmt(r.from)}`) && toLine.includes(fmt(r.to));
                    return toLine.includes(fmt(r.to)) && lineAt(r.src).startsWith(`${r.from.level} ${r.from.x % 64} ${r.from.z % 64}:`);
                },
            };
        }
    }
}

export function checkFacts(facts: Fact[]): { checked: number; wrong: { fact: string; src: string; line: string }[] } {
    const wrong: { fact: string; src: string; line: string }[] = [];
    for (const f of facts) {
        const e = expected(f);
        if (!e.ok()) wrong.push({ fact: `${f.kind}: ${e.label}`, src: e.src, line: lineAt(e.src) });
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
