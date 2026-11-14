// Writes three client assets from the knowledge files of the pinned server:
// - client-assets/map-icons.json for the minimap's World Map icons (RuneLite's World Map plugin): each teleport
//   destination (knowledge/teleports.json), agility shortcut with its level (knowledge/shortcuts.json, kind shortcut)
//   and shop keeper (knowledge/item-sources.json shop owners), as [x, z, level, kind, label]. Kind t is a teleport the
//   player casts from anywhere (a spell, jewellery, an item; not the Ring of life, which fires by itself), p a transport
//   used at a fixed spot (a lever, a portal, mysterious ruins, a spirit tree, an NPC), a an agility shortcut, s a shop.
// - client-assets/npc-drops.json for the opponent box: the route items each NPC drops (npcDrops below).
// - client-assets/item-sources.json for the Grand Exchange plugin's item sources: for each route item of
//   knowledge/item-sources.json, by item id (items that share a display name, such as the four dragonhides, keep
//   their own sources), up to 12 sources as [kind, label, [x, z, level, ...]].
// Run: bun packages/dashboard/gen-map-data.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Tile = { x: number; z: number; level?: number };
// An icon may end with its skill requirement [skill, level] (a teleport spell's Magic level, a shortcut's Agility level).
export type Icon = [number, number, number, 't' | 'p' | 'a' | 's', string] | [number, number, number, 't' | 'p' | 'a' | 's', string, [string, number]];
const ANYWHERE = new Set(['spell', 'jewellery', 'item']);
export type Source = [string, string, number[]];
type Names = { npc: (d: string) => string; item: (d: string) => string };

const cap = (s: string) => s.replace(/^./, c => c.toUpperCase());
// A debug name as words: "coalrock1" is "Coal rock", "magic_tree" is "Magic tree".
export const pretty = (d: string) => cap(String(d).replace(/\d+$/, '').replace(/_/g, ' ').replace(/([a-z])(rock|tree)$/, '$1 $2').trim());
// Shops, skills, floor spawns and actions first, then drops by chance (most likely first).
const ORDER: Record<string, number> = { shop: 0, gather: 1, make: 2, pickup: 3, action: 4, drop: 5 };
const flat = (tiles: Tile[]) => tiles.filter(t => Number.isInteger(t?.x) && Number.isInteger(t?.z)).flatMap(t => [t.x, t.z, t.level ?? 0]);

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
        const rows: Source[] = [];
        const sorted = (it.sources ?? []).filter((s: any) => !s.blocked).sort((a: any, b: any) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9) || (b.chance ?? 0) - (a.chance ?? 0));
        for (const s of sorted) {
            if (s.kind === 'shop') rows.push(['shop', `Shop: ${(s.owners ?? []).map((o: any) => names.npc(o.npc)).join(', ') || pretty(s.shop)} · ${s.basePrice} gp`, places(s.owners)]);
            else if (s.kind === 'drop') rows.push(['drop', `Drop: ${names.npc(s.npc)}${s.combat ? ' (level ' + s.combat + ')' : ''} · ${s.chance >= 1 ? 'always' : '1/' + Math.round(1 / s.chance)}`, places(s.places)]);
            else if (s.kind === 'gather') rows.push(['gather', `${cap(s.skill)} ${s.level}: ${(s.places ?? []).filter((p: any) => !/^macro_|dummy/.test(p.loc ?? '')).map((p: any) => pretty(p.loc ?? p.npc ?? '')).filter((v: string, i: number, a: string[]) => v && v !== 'Loc' && a.indexOf(v) === i).slice(0, 2).join(', ') || pretty(s.rung.split('/')[1] ?? '')}`, places(s.places)]);
            else if (s.kind === 'make') rows.push(['make', `${cap(s.skill)} ${s.level}: from ${(s.inputs ?? []).map((i: any) => (i.count > 1 ? i.count + ' ' : '') + names.item(i.item)).join(', ') || 'nothing'}`, []]);
            else if (s.kind === 'pickup') rows.push(['pickup', `Floor spawn${s.spawns > 1 ? 's (' + s.spawns + ')' : ''}`, flat(s.tiles ?? [])]);
            else if (s.kind === 'action') { const label = actionLabel(String(s.trigger), String(s.subject), names); if (label) rows.push(['action', label, places(s.places)]); }
        }
        // Two NPC variants of one name give one row, with the places of both.
        const byLabel = new Map<string, Source>();
        for (const r of rows) { const seen = byLabel.get(r[1]); if (seen) seen[2].push(...r[2]); else byLabel.set(r[1], [r[0], r[1], [...r[2]]]); }
        if (byLabel.size && Number.isInteger(it.id)) out[String(it.id)] = [...byLabel.values()].slice(0, 12);
    }
    return out;
}

// The route items each NPC drops, for the opponent box: by NPC display name, up to 8 as [item name, chance text],
// most likely first. Two NPCs of one name give the higher chance of each item.
export function npcDrops(items: any[], names: Names): Record<string, [string, string][]> {
    const by = new Map<string, Map<string, number>>();
    for (const it of items) for (const s of it.sources ?? []) {
        if (s.kind !== 'drop' || s.blocked || !(s.chance > 0)) continue;
        const npc = names.npc(s.npc), item = names.item(it.item), m = by.get(npc) ?? new Map<string, number>();
        m.set(item, Math.max(m.get(item) ?? 0, s.chance)); by.set(npc, m);
    }
    const out: Record<string, [string, string][]> = {};
    for (const [npc, m] of [...by].sort((a, b) => a[0].localeCompare(b[0])))
        out[npc] = [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([item, c]) => [item, c >= 1 ? 'always' : '1/' + Math.round(1 / c)]);
    return out;
}

if (import.meta.main) {
    const root = join(import.meta.dir, '..', '..'), k = (f: string) => JSON.parse(readFileSync(join(root, 'knowledge', f), 'utf8'));
    const npcName = new Map<string, string>((k('npcs.json') as any[]).map(n => [n.debugname, n.name]));
    const itemName = new Map<string, string>((k('items.json') as any[]).filter(i => i.debugname && i.name).map(i => [i.debugname, i.name]));
    const names: Names = { npc: d => npcName.get(d) ?? pretty(d), item: d => itemName.get(d) ?? pretty(d) };
    const items = k('item-sources.json').items;
    const icons = mapIcons(k('teleports.json').teleports, k('shortcuts.json').edges, items, names), sources = itemSources(items, names);
    writeFileSync(join(import.meta.dir, 'client-assets', 'map-icons.json'), JSON.stringify(icons));
    writeFileSync(join(import.meta.dir, 'client-assets', 'item-sources.json'), JSON.stringify(sources));
    const drops = npcDrops(items, names);
    writeFileSync(join(import.meta.dir, 'client-assets', 'npc-drops.json'), JSON.stringify(drops));
    const by = (kind: string) => icons.filter(i => i[3] === kind).length;
    console.log(`map-icons.json: ${by('t')} teleports, ${by('p')} fixed transports, ${by('a')} shortcuts, ${by('s')} shops; item-sources.json: ${Object.keys(sources).length} items; npc-drops.json: ${Object.keys(drops).length} npcs`);
}
