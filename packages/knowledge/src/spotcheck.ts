import { readFileSync, statSync } from 'node:fs';
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
    | { kind: 'transport'; record: Edge }
    | { kind: 'door'; record: Door }
    | { kind: 'skill'; record: { level: number; xp: number | null; src: { level: string; xp?: string } } }
    | { kind: 'quest'; record: { varp: string; xp: { skill: string; xp: number; src: string }[]; src: string } }
    | { kind: 'drop'; record: { item?: string; table?: string; src: string } };

type Door = { id: number; loc: string; x: number; z: number; level: number; kind: string; trigger: string; src: string };

const fileCache = new Map<string, { sig: string; lines: string[] }>();

function statSig(absPath: string): string | null {
    try {
        const st = statSync(absPath);
        return `${st.mtimeMs}:${st.size}`;
    } catch {
        return null;
    }
}

function fileLines(file: string): string[] {
    const root = contentRoot();
    const abs = join(root, file);
    const key = `${root}\0${file}`;
    const sig = statSig(abs) ?? '';
    const cached = fileCache.get(key);
    if (cached && cached.sig === sig) return cached.lines;
    const ls = cleanLines(readFileSync(abs, 'utf8'));
    fileCache.set(key, { sig, lines: ls });
    return ls;
}

function lineAt(src: string): string {
    const i = src.lastIndexOf(':');
    const file = src.slice(0, i);
    const n = Number(src.slice(i + 1));
    return fileLines(file)[n - 1] ?? '';
}

// The config block (props by key) that starts at a [name] header line. Re-read here so the check does not
// share code with the builder it is checking.
function blockAt(src: string): { header: string; props: Record<string, string> } {
    const i = src.lastIndexOf(':');
    const file = src.slice(0, i);
    const start = Number(src.slice(i + 1));
    const lines = fileLines(file);
    const props: Record<string, string> = {};
    for (let n = start; n < lines.length; n++) {
        const l = lines[n]!;
        if (l.startsWith('[')) break;
        const eq = l.indexOf('=');
        if (eq > 0 && !(l.slice(0, eq) in props)) props[l.slice(0, eq)] = l.slice(eq + 1);
    }
    return { header: lines[start - 1] ?? '', props };
}

const packCache = new Map<string, { sig: string; entries: Set<string> }>();
function inPack(pack: string, id: number, name: string): boolean {
    const root = contentRoot();
    const abs = join(root, 'pack', `${pack}.pack`);
    const key = `${root}\0${pack}`;
    const sig = statSig(abs) ?? '';
    let cached = packCache.get(key);
    if (!cached || cached.sig !== sig) {
        const text = readFileSync(abs, 'utf8');
        const entries = new Set<string>();
        let pos = 0;
        const total = text.length;
        while (pos <= total) {
            const nl = text.indexOf('\n', pos);
            let end = nl === -1 ? total : nl;
            if (end > pos && text.charCodeAt(end - 1) === 13) end--;
            const comment = text.indexOf('//', pos);
            if (comment >= 0 && comment < end) end = comment;
            let s = pos;
            while (s < end && text.charCodeAt(s) <= 32) s++;
            while (end > s && text.charCodeAt(end - 1) <= 32) end--;
            if (end > s) entries.add(text.slice(s, end));
            if (nl === -1) break;
            pos = nl + 1;
        }
        cached = { sig, entries };
        packCache.set(key, cached);
    }
    return cached.entries.has(`${id}=${name}`);
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
        case 'skill': {
            const r = f.record;
            // dbrow lines are `data=<column>,<value>`; XP is stored in tenths.
            return {
                src: r.src.level,
                label: `level ${r.level} xp ${r.xp}`,
                ok: () => /^data=\w+,/.test(lineAt(r.src.level)) && lineAt(r.src.level).endsWith(`,${r.level}`)
                    && (r.xp === null || (!!r.src.xp && lineAt(r.src.xp).endsWith(`,${Math.round(r.xp * 10)}`))),
            };
        }
        case 'quest': {
            const r = f.record;
            return {
                src: r.src,
                label: `${r.varp} ${r.xp.map(x => `${x.skill}:${x.xp}`).join(' ')}`,
                ok: () => (lineAt(r.src).includes(`%${r.varp}`) || (r.varp === 'cogquest' && lineAt(r.src).includes('~get_cog_progress')))
                    && r.xp.every(x => lineAt(x.src).replace(/\s+/g, '').includes(`stat_advance(${x.skill},${Math.round(x.xp * 10)})`)),
            };
        }
        case 'drop': {
            const r = f.record;
            const what = r.item === 'death_drop' ? 'npc_param(death_drop)' : r.table ? `~${r.table}` : r.item;
            return { src: r.src, label: `${what}`, ok: () => lineAt(r.src).replace(/\s+/g, '').includes(`obj_add(npc_coord,${what}`) };
        }
        case 'door': {
            const r = f.record;
            const head = `${r.level} ${r.x % 64} ${r.z % 64}: ${r.id}`;
            return {
                src: r.src,
                label: `${r.loc} ${r.kind} at ${head}`,
                ok: () => {
                    const shape = Number(lineAt(r.src).slice(head.length).trim().split(' ')[0]);
                    const trig = r.trigger ? lineAt(r.trigger) : '';
                    return lineAt(r.src).startsWith(`${head} `) && shape >= 0 && shape <= 3
                        && (r.kind === 'unknown' || /^\[(oploc1|oplocu),/.test(trig));
                },
            };
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

const FACT_FILES = ['items.json', 'npcs.json', 'shops.json', 'transports.json', 'doors.json', 'skills.json', 'quests.json', 'drops.json'] as const;
let factsCache: { dir: string; sig: string; facts: Fact[] } | null = null;

function buildAllFacts(dir: string): Fact[] {
    const load = <T>(name: string): T => JSON.parse(readFileSync(join(dir, name), 'utf8'));
    const items = load<Item[]>('items.json');
    const npcs = load<Npc[]>('npcs.json');
    const shops = load<Shop[]>('shops.json');
    const edges = load<Edge[]>('transports.json');
    const doors = load<Door[]>('doors.json');
    const skills = load<any[]>('skills.json');
    const quests = load<any[]>('quests.json');
    const drops = load<any[]>('drops.json');
    const out: Fact[] = [];
    for (const record of items) out.push({ kind: 'item', record });
    for (const record of npcs) out.push({ kind: 'npc', record });
    for (const n of npcs) for (const s of n.spawns) out.push({ kind: 'spawn', record: { ...s, id: n.id } });
    for (const s of shops) for (const record of s.stock) out.push({ kind: 'stock', record });
    for (const record of edges) out.push({ kind: 'transport', record });
    for (const record of doors) out.push({ kind: 'door', record });
    for (const record of skills) out.push({ kind: 'skill', record });
    for (const record of quests) out.push({ kind: 'quest', record });
    for (const d of drops) {
        for (const record of d.rolls) out.push({ kind: 'drop', record });
        for (const record of d.always) out.push({ kind: 'drop', record });
    }
    return out;
}

function cachedAllFacts(): readonly Fact[] {
    const dir = knowledgeDir();
    const sig = FACT_FILES.map(f => statSig(join(dir, f)) ?? '').join('|');
    if (!factsCache || factsCache.dir !== dir || factsCache.sig !== sig) {
        factsCache = { dir, sig, facts: buildAllFacts(dir) };
    }
    return factsCache.facts;
}

export function allFacts(): Fact[] {
    return [...cachedAllFacts()];
}

export function spotcheck(n: number, seed: number) {
    const facts = cachedAllFacts();
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
