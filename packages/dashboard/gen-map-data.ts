// Writes three client assets from the knowledge files of the pinned server:
// - client-assets/map-icons.json for the minimap's World Map icons (RuneLite's World Map plugin): each teleport
//   destination (knowledge/teleports.json), agility shortcut with its level (knowledge/shortcuts.json, kind shortcut)
//   and shop keeper (knowledge/item-sources.json shop owners), as [x, z, level, kind, label]. Kind t is a teleport the
//   player casts from anywhere (a spell, jewellery, an item; not the Ring of life, which fires by itself), p a transport
//   used at a fixed spot (a lever, a portal, mysterious ruins, a spirit tree, an NPC), a an agility shortcut, s a shop.
// - client-assets/npc-drops.json for the opponent box: the route items each NPC drops (npcDrops below).
// - client-assets/item-sources.json for the Grand Exchange plugin's item sources: for each route item of
//   knowledge/item-sources.json, by item id (items that share a display name, such as the four dragonhides, keep
//   their own sources), up to 12 sources as [kind, label, [x, z, level, ...], optional cost evidence].
// Run: bun packages/dashboard/gen-map-data.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Tile = { x: number; z: number; level?: number };
// An icon may end with its skill requirement [skill, level] (a teleport spell's Magic level, a shortcut's Agility level).
export type Icon = [number, number, number, 't' | 'p' | 'a' | 's', string] | [number, number, number, 't' | 'p' | 'a' | 's', string, [string, number]];
const ANYWHERE = new Set(['spell', 'jewellery', 'item']);
const SOURCE_THIN_LIMIT = 48 * 3;
const SOURCE_THIN_CELL = 16;

// Thin only dense world-wide tile lists (>48 tiles) to one tile per 16x16 cell per floor so minimap/3D pins keep full coverage without thousands of redundant log/tree tiles.
export function thinSourceTiles(tiles: number[], limit = SOURCE_THIN_LIMIT, cell = SOURCE_THIN_CELL): number[] {
    if (tiles.length <= limit) return tiles;
    const seen = new Set<string>(), out: number[] = [];
    for (let i = 0; i + 2 < tiles.length; i += 3) {
        const x = tiles[i]!, z = tiles[i + 1]!, level = tiles[i + 2]!;
        const key = `${level}:${Math.floor(x / cell)}:${Math.floor(z / cell)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(x, z, level);
    }
    return out;
}

// Shipped npc-drops.json omits byName and structured metadata because client-shell.js reads only byId[id] rows' {name, summary, facts[].text}.
export function compactNpcDrops(drops: NpcDrops): { byId: Record<string, { id: number; name: string; summary: string; facts: { text: string }[] }[]>; byName: Record<string, never> } {
    const byId: Record<string, { id: number; name: string; summary: string; facts: { text: string }[] }[]> = {};
    for (const [id, rows] of Object.entries(drops.byId)) {
        byId[id] = rows.map(row => ({ id: row.id, name: row.name, summary: row.summary, facts: row.facts.map(f => ({ text: f.text })) }));
    }
    return { byId, byName: {} };
}
type CostBasis = 'content' | 'model' | 'measured';
// Each known dimension has its own basis and conditions; helper time and conditional wall wait stay separate.
export type SourceCost = {
    helperTicksPerUnit?: number; ticksBasis?: CostBasis; ticksNote?: string;
    coinsPerUnit?: number; coinsBasis?: CostBasis; coinsNote?: string;
    realSecondsPerUnit?: number; realBasis?: CostBasis; realNote?: string;
};
export type Source = [string, string, number[], SourceCost?];
export type DropFact = {
    chance: number | null; countMin: number | null; countMax: number | null; quantity: string;
    conditional: boolean | null; condition: string | null; gate: string | null;
    src: string | null; via: string | null; trigger: string | null; text: string;
};
export type NpcDropRow = { id: number; name: string; summary: string; facts: DropFact[] };
export type NpcDrops = { byId: Record<string, NpcDropRow[]>; byName: Record<string, NpcDropRow[]> };
export type DropNpc = { id: number; name: string; debugname: string };
type Names = { npc: (d: string) => string; item: (d: string) => string };

const cap = (s: string) => s.replace(/^./, c => c.toUpperCase());
// A debug name as words: "coalrock1" is "Coal rock", "magic_tree" is "Magic tree".
export const pretty = (d: string) => cap(String(d).replace(/\d+$/, '').replace(/_/g, ' ').replace(/([a-z])(rock|tree)$/, '$1 $2').trim());
// Shops, skills, floor spawns and actions first, then drops by chance (most likely first).
const ORDER: Record<string, number> = { shop: 0, gather: 1, make: 2, pickup: 3, action: 4, drop: 5 };
const flat = (tiles: Tile[]) => tiles.filter(t => Number.isInteger(t?.x) && Number.isInteger(t?.z)).flatMap(t => [t.x, t.z, t.level ?? 0]);
const bounded = (s: string, limit = 800) => s.length > limit ? s.slice(0, limit) + '…' : s;
const factString = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const dropRate = (chance: number | null) => chance === null ? 'chance unknown' : chance === 0 ? 'chance 0' : chance === 1 ? 'always' : '1/' + Math.round(1 / chance);
function dropDescription(fact: DropFact, includeCondition = true) {
    const conditional = fact.conditional === true || fact.condition !== null || fact.gate !== null;
    const rate = conditional ? fact.chance === 1 ? 'conditional' : `${dropRate(fact.chance)} · conditional`
        : fact.conditional === false ? dropRate(fact.chance)
        : `${fact.chance === 1 ? 'table chance 1' : dropRate(fact.chance)} · conditions unknown`;
    return `${fact.quantity} · ${rate}${includeCondition && fact.condition ? ' · Condition: ' + bounded(fact.condition) : ''}`;
}
function dropFact(source: any): DropFact {
    const count = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) >= 0 ? value as number : null;
    const countMin = count(source.countMin), countMax = count(source.countMax);
    const quantity = countMin !== null && countMax !== null && countMin <= countMax
        ? `quantity ${countMin === countMax ? countMin : countMin + '–' + countMax}` : 'quantity unknown';
    const fact: DropFact = {
        chance: typeof source.chance === 'number' && Number.isFinite(source.chance) && source.chance >= 0 && source.chance <= 1 ? source.chance : null,
        countMin, countMax, quantity, conditional: typeof source.conditional === 'boolean' ? source.conditional : null,
        condition: factString(source.condition), gate: factString(source.gate), src: factString(source.src),
        via: factString(source.via), trigger: factString(source.npc), text: '',
    };
    fact.text = bounded(dropDescription(fact) + (fact.gate ? ' · Requires: ' + fact.gate : '')
        + (fact.src ? ' · Source: ' + fact.src : '') + (fact.via ? ' · Via: ' + fact.via : '')
        + (fact.trigger ? ' · Trigger: ' + fact.trigger : ''), 1600);
    return fact;
}
function sourceCost(raw: any, boundedNotes = true): SourceCost | undefined {
    const out: SourceCost = {};
    for (const [valueKey, basisKey, noteKey] of [
        ['helperTicksPerUnit', 'ticksBasis', 'ticksNote'],
        ['coinsPerUnit', 'coinsBasis', 'coinsNote'],
        ['realSecondsPerUnit', 'realBasis', 'realNote'],
    ] as const) {
        const value = raw?.[valueKey], basis = raw?.[basisKey], note = raw?.[noteKey];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
            || !['content', 'model', 'measured'].includes(basis)) continue;
        Object.assign(out, { [valueKey]: value, [basisKey]: basis },
            typeof note === 'string' && note.trim()
                ? { [noteKey]: boundedNotes && note.length > 800 ? note.slice(0, 800) + '…' : note } : {});
    }
    return Object.keys(out).length ? out : undefined;
}

export function mapIcons(teleports: any[], edges: any[], items: any[], names: Names): Icon[] {
    const out = new Map<string, Icon>();
    const add = (t: Tile | undefined, kind: Icon[3], label: string, req?: [string, number]) => {
        if (!t || !Number.isInteger(t.x) || !Number.isInteger(t.z)) return;
        const key = `${t.x},${t.z},${t.level ?? 0},${kind}`;
        if (!out.has(key)) out.set(key, req ? [t.x, t.z, t.level ?? 0, kind, label, req] : [t.x, t.z, t.level ?? 0, kind, label]);
    };
    // Each destination option of a teleport (Amulet of glory: Edgeville, Karamja, Draynor Village, Al Kharid).
    for (const tp of teleports) {
        const sk = (tp.requires ?? []).find((r: any) => r.type === 'skill' && r.skill && Number.isFinite(r.level));
        for (const o of tp.to ?? []) add(o?.candidates?.[0], ANYWHERE.has(tp.kind) && tp.name !== 'Ring of life' ? 't' : 'p', String(tp.name ?? 'Teleport') + (o?.option ? ': ' + o.option : ''), sk ? [String(sk.skill), Number(sk.level)] : undefined);
    }
    for (const e of edges) if (e.kind === 'shortcut') {
        const lv = e.requires?.skill?.level;
        add(e.from, 'a', `Agility shortcut${lv ? ' (level ' + lv + ')' : ''}: ${cap(String(e.optionText ?? 'use'))}`, lv ? ['agility', Number(lv)] : undefined);
    }
    for (const it of items) for (const s of it.sources ?? []) if (s.kind === 'shop') for (const o of s.owners ?? []) for (const t of o.tiles ?? []) add(t, 's', `Shop: ${names.npc(o.npc)}`);
    return [...out.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

// What the player does, by the script trigger: opnpc1 talks; opnpcu, oplocu and opheldu use an item on the subject;
// another op is a menu option; queue is a quest reward. debugproc and tutorial are no player action, so null.
export function actionLabel(trigger: string, subject: string, names: Names): string | null {
    const held = trigger.startsWith('opheld'), what = held ? names.item(subject) : names.npc(subject);
    if (trigger === 'opnpc1') return `Talk to ${what}`;
    if (/^op(npc|loc|held)u$/.test(trigger)) return `Use an item on ${what}`;
    if (/^op(npc|loc|held)\d$/.test(trigger)) return `Interact with ${what}`;
    if (trigger === 'queue') return `Quest reward: ${pretty(subject.replace(/_complete$/, ''))}`;
    return null;
}

export function itemSources(items: any[], names: Names): Record<string, Source[]> {
    const out: Record<string, Source[]> = {};
    const places = (ps: any[]) => flat((ps ?? []).flatMap((p: any) => p.tiles ?? []));
    for (const it of items) {
        const rows: { row: Source; key: string }[] = [];
        const sorted = (it.sources ?? []).filter((s: any) => !s.blocked).sort((a: any, b: any) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9) || (b.chance ?? 0) - (a.chance ?? 0));
        for (const s of sorted) {
            const cost = sourceCost(s.cost);
            const add = (kind: string, label: string, tiles: number[]) => {
                const title = label + (typeof s.gate === 'string' && s.gate.trim() ? ` · Requires: ${kind === 'drop' ? bounded(s.gate.trim()) : s.gate.trim()}` : '');
                // Full conditions identify a fact even when its display note needs truncation.
                const identity = sourceCost(s.cost, false);
                rows.push({ row: cost ? [kind, title, tiles, cost] : [kind, title, tiles], key: JSON.stringify([title, identity ?? null, kind === 'drop' ? dropFact(s) : null]) });
            };
            if (s.kind === 'shop') {
                const base = typeof s.basePrice === 'number' && Number.isFinite(s.basePrice) && s.basePrice >= 0
                    ? ` · base value ${s.basePrice} gp` : '';
                add('shop', `Shop: ${(s.owners ?? []).map((o: any) => names.npc(o.npc)).join(', ') || pretty(s.shop)}${base}`, places(s.owners));
            }
            else if (s.kind === 'drop') add('drop', `Drop: ${names.npc(s.npc)}${s.combat ? ' (level ' + s.combat + ')' : ''} · ${dropDescription(dropFact(s))}`, places(s.places));
            else if (s.kind === 'gather') add('gather', `${cap(s.skill)} ${s.level}: ${(s.places ?? []).filter((p: any) => !/^macro_|dummy/.test(p.loc ?? '')).map((p: any) => pretty(p.loc ?? p.npc ?? '')).filter((v: string, i: number, a: string[]) => v && v !== 'Loc' && a.indexOf(v) === i).slice(0, 2).join(', ') || pretty(s.rung.split('/')[1] ?? '')}`, places(s.places));
            else if (s.kind === 'make') add('make', `${cap(s.skill)} ${s.level}: from ${(s.inputs ?? []).map((i: any) => (i.count > 1 ? i.count + ' ' : '') + names.item(i.item)).join(', ') || 'nothing'}`, []);
            else if (s.kind === 'pickup') add('pickup', `Floor spawn${s.spawns > 1 ? 's (' + s.spawns + ')' : ''}`, flat(s.tiles ?? []));
            else if (s.kind === 'action') { const label = actionLabel(String(s.trigger), String(s.subject), names); if (label) add('action', label, places(s.places)); }
        }
        // Variants share places only when their labels and each cost dimension describe the same fact.
        const byLabel = new Map<string, Source>();
        for (const { row: r, key } of rows) {
            const seen = byLabel.get(key);
            if (seen) seen[2].push(...r[2]);
            else byLabel.set(key, r[3] ? [r[0], r[1], [...r[2]], r[3]] : [r[0], r[1], [...r[2]]]);
        }
        const outRows = [...byLabel.values()].slice(0, 12).map((row): Source => {
            const thinned = thinSourceTiles(row[2]);
            return row[3] ? [row[0], row[1], thinned, row[3]] : [row[0], row[1], thinned];
        });
        if (outRows.length && Number.isInteger(it.id)) out[String(it.id)] = outRows;
    }
    return out;
}

// Exact spawn variants own their source facts. Separate table entries have no known roll relationship.
export function npcDrops(items: any[], names: Names, catalogue: readonly DropNpc[]): NpcDrops {
    const debugIds = new Map<string, Set<number>>(), variants = new Map<string, Set<number>>();
    for (const npc of catalogue) {
        if (!Number.isSafeInteger(npc?.id) || npc.id < 0 || typeof npc.debugname !== 'string' || typeof npc.name !== 'string') continue;
        const ids = debugIds.get(npc.debugname) ?? new Set<number>(); ids.add(npc.id); debugIds.set(npc.debugname, ids);
        const name = npc.name.trim().toLowerCase(), group = variants.get(name) ?? new Set<number>(); group.add(npc.id); variants.set(name, group);
    }
    const by = new Map<number, Map<number, { name: string; facts: Map<string, DropFact> }>>();
    for (const it of items) for (const s of it.sources ?? []) {
        if (s.kind !== 'drop' || s.blocked || !Number.isSafeInteger(it.id) || it.id < 0) continue;
        const fact = dropFact(s), key = JSON.stringify(fact), ids = new Set<number>();
        for (const place of Array.isArray(s.places) ? s.places : []) {
            const resolved = debugIds.get(place?.npc);
            if (resolved?.size === 1) ids.add([...resolved][0]!);
        }
        for (const id of ids) {
            const rows = by.get(id) ?? new Map(), row = rows.get(it.id) ?? { name: names.item(it.item), facts: new Map<string, DropFact>() };
            row.facts.set(key, fact); rows.set(it.id, row); by.set(id, rows);
        }
    }
    const out: NpcDrops = { byId: {}, byName: {} };
    // Chance orders the display only; every separate fact keeps its own probability and conditions.
    const displayChance = (row: NpcDropRow) => Math.max(0, ...row.facts.map(fact => fact.chance ?? 0));
    for (const [id, rows] of [...by].sort((a, b) => a[0] - b[0])) out.byId[id] = [...rows].map(([itemId, row]) => {
        const facts = [...row.facts].sort((a, b) => a[0].localeCompare(b[0])).map(([, fact]) => fact);
        return { id: itemId, name: row.name, summary: facts.length === 1 ? bounded(dropDescription(facts[0]!, false), 200) : 'multiple table entries', facts };
    }).sort((a, b) => displayChance(b) - displayChance(a) || a.name.localeCompare(b.name) || a.id - b.id);
    for (const [name, ids] of variants) {
        const rows = [...ids].map(id => out.byId[id]), first = rows[0];
        if (name && first && rows.every(row => row && JSON.stringify(row) === JSON.stringify(first))) out.byName[name] = first;
    }
    return out;
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..'), k = (f: string) => JSON.parse(readFileSync(join(root, 'knowledge', f), 'utf8'));
    const npcs = k('npcs.json'), npcName = new Map<string, string>((npcs as any[]).map(n => [n.debugname, n.name]));
    const itemName = new Map<string, string>((k('items.json') as any[]).filter(i => i.debugname && i.name).map(i => [i.debugname, i.name]));
    const names: Names = { npc: d => npcName.get(d) ?? pretty(d), item: d => itemName.get(d) ?? pretty(d) };
    const items = k('item-sources.json').items;
    const icons = mapIcons(k('teleports.json').teleports, k('shortcuts.json').edges, items, names), sources = itemSources(items, names);
    writeFileSync(join(import.meta.dir, 'client-assets', 'map-icons.json'), JSON.stringify(icons));
    writeFileSync(join(import.meta.dir, 'client-assets', 'item-sources.json'), JSON.stringify(sources));
    const drops = npcDrops(items, names, npcs);
    writeFileSync(join(import.meta.dir, 'client-assets', 'npc-drops.json'), JSON.stringify(compactNpcDrops(drops)));
    const by = (kind: string) => icons.filter(i => i[3] === kind).length;
    console.log(`map-icons.json: ${by('t')} teleports, ${by('p')} fixed transports, ${by('a')} shortcuts, ${by('s')} shops; item-sources.json: ${Object.keys(sources).length} items; npc-drops.json: ${Object.keys(drops.byId).length} npcs`);
}
