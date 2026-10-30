// Travel the route search can use besides walking, ladders and stairs: NPC boats, gliders, carts and tolls
// (knowledge/npc-travel.json), teleports by spell, jewellery, lever and spirit tree (knowledge/teleports.json), and
// agility shortcuts and passages (knowledge/shortcuts.json).
// Each edge says what the account needs (coins, quest stages, skills, runes, items held or worn) and how the
// walker runs it. Left out: Entrana boats (no weapon or armour may be carried), moves into the Wilderness,
// jails and random-tile teleports (essence mine), runecraft ruins and portals; shortcuts with a failure roll (a
// fall hurts a low-level account), a use-item, a first step (via) or a held-item check.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Account, Tile } from './world';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const content = join(repoRoot, 'vendor', 'rs-sdk', 'server', 'content');

export type TravelNeed =
    | { varp: string; op: string; value: number }
    | { skill: string; level: number }
    | { held: string; count: number }            // item debugname held in the pack
    | { worn: string };
export type TravelRun =
    | { how: 'npc'; npc: string; op: number; options: string[]; deck?: boolean }
    | { how: 'spell'; component: string }
    | { how: 'rub'; items: string[]; option: string | null }
    | { how: 'loc'; loc: string; op: number; option: string | null; id?: number; at?: Tile };
export interface Travel {
    id: string; kind: string; name: string;
    from: Tile | null;                   // null: from anywhere outside the Wilderness
    to: Tile;                            // where the player stands after it, on the ground
    coins: number;                       // coins the account must hold
    needs: TravelNeed[];
    runes: { item: string; count: number }[];
    run: TravelRun;
    cost: number;                        // estimate in ticks
}

const TELEPORT_COST = 5, NPC_COST = 15, BOAT_COST = 40;

// The ground tile the gangplank's disembark puts the player on (general_use/scripts/gangplank.rs2): two tiles
// from the plank, away from the ship, one level down. Map lines read "level x z: id shape angle".
export function landing(plank: { x: number; z: number; level: number }, angle: number): Tile {
    const dir = angle === 0 || angle === 1 ? 1 : -1;
    return angle === 0 || angle === 2 ? { x: plank.x - 2 * dir, z: plank.z, level: plank.level - 1 } : { x: plank.x, z: plank.z + 2 * dir, level: plank.level - 1 };
}
function mapAngle(src: string): number | null {
    const m = src.match(/^(.*):(\d+)$/);
    if (!m) return null;
    try { return Number(readFileSync(join(content, m[1]!), 'utf8').split(/\r?\n/)[Number(m[2]) - 1]!.trim().split(/\s+/)[5]); } catch { return null; }
}

type NpcRecord = { id: string; kind: string; destination: string; npc: { name: string; debugname: string }; op: { index: number }; options: { text: string }[];
    from: (Tile & { src: string })[]; to: (Tile & { src: string }) | null; fare?: { coins: number | null; rule?: string }; items?: { item: string; use: string }[];
    requires: { varp: string; op: string; value: number }[]; deck?: { onDeck: boolean; gangplank?: Tile & { src: string } } };
export function npcTravel(records: NpcRecord[]): Travel[] {
    const out: Travel[] = [];
    for (const r of records) {
        if (!r.to || /entrana|jail/i.test(`${r.id} ${r.destination}`)) continue;
        if (r.items?.some(i => i.use === 'forbidden')) continue;
        let to: Tile = { x: r.to.x, z: r.to.z, level: r.to.level }, deck = false;
        if (r.deck?.onDeck) {
            const g = r.deck.gangplank, angle = g ? mapAngle(g.src) : null;
            if (!g || angle === null) continue;
            to = landing(g, angle); deck = true;
        }
        const coins = r.fare?.coins ?? (r.fare?.rule ? 200 : 0);
        const held = (r.items ?? []).filter(i => i.use === 'consumed' && /^[a-z0-9_]+$/.test(i.item)).map(i => ({ held: i.item, count: 1 }));
        for (const f of r.from) out.push({
            id: `npc:${r.id}@${f.x},${f.z}`, kind: r.kind, name: `${r.npc.name} to ${r.destination}`, from: { x: f.x, z: f.z, level: f.level }, to, coins,
            needs: [...r.requires.map(q => ({ varp: q.varp, op: q.op, value: q.value })), ...held], runes: [],
            run: { how: 'npc', npc: r.npc.name, op: r.op.index, options: r.options.map(o => o.text), ...(deck ? { deck } : {}) },
            cost: r.kind === 'boat' ? BOAT_COST : NPC_COST,
        });
    }
    return out;
}

type TeleRecord = { id: string; kind: string; name: string; trigger: string; from: (Tile & { wilderness?: number })[] | null;
    requires: { type: string; skill?: string; level?: number; varp?: string; op?: string; value?: number; item?: string }[];
    runes?: { item: string; count: number }[]; charges?: { item: string }[];
    to: { option: string | null; candidates: (Tile & { wilderness?: number })[]; maxRadius?: number }[] };
export function teleportTravel(records: TeleRecord[]): Travel[] {
    const out: Travel[] = [];
    for (const r of records) {
        if (!['spell', 'jewellery', 'lever', 'spirit_tree', 'loc'].includes(r.kind)) continue;
        const needs: TravelNeed[] = [];
        for (const q of r.requires) {
            if (q.type === 'skill' && q.skill && q.level !== undefined) needs.push({ skill: q.skill, level: q.level });
            else if (q.type === 'varp' && q.varp && q.op && q.value !== undefined) needs.push({ varp: q.varp, op: q.op, value: q.value });
            else if (q.type === 'worn' && q.item) needs.push({ worn: q.item });
            else if (q.type === 'held' && q.item) needs.push({ held: q.item, count: 1 });
        }
        const op = Number(r.trigger.match(/^\[op(?:loc|npc)(\d)/)?.[1] ?? 1), loc = r.trigger.match(/^\[oploc\d,([a-z0-9_]+)\]/)?.[1];
        for (const d of r.to) {
            if (d.candidates.length !== 1 || (d.candidates[0]!.wilderness ?? 0) > 0) continue;
            const c = d.candidates[0]!, to = { x: c.x, z: c.z, level: c.level };
            const run: TravelRun | null = r.kind === 'spell' ? { how: 'spell', component: r.trigger.match(/\[if_button,([a-z0-9_:]+)\]/)?.[1] ?? '' }
                : r.kind === 'jewellery' ? { how: 'rub', items: (r.charges ?? []).map(c => c.item), option: d.option }
                : loc ? { how: 'loc', loc, op, option: d.option } : null;
            if (!run || (run.how === 'spell' && !run.component) || (run.how === 'rub' && !run.items.length)) continue;
            const froms = r.from?.filter(f => (f.wilderness ?? 0) === 0) ?? [null];
            for (const f of froms) out.push({
                id: `${r.id}:${d.option ?? 'to'}${f ? `@${f.x},${f.z}` : ''}`, kind: r.kind, name: d.option ? `${r.name}: ${d.option}` : r.name,
                from: f ? { x: f.x, z: f.z, level: f.level } : null, to, coins: 0, needs, runes: r.runes ?? [], run,
                cost: r.kind === 'spirit_tree' ? NPC_COST : TELEPORT_COST,
            });
        }
    }
    return out;
}

type ShortcutRecord = { kind: string; locName: string; id: number; option: string; from: Tile; to: Tile; exact: boolean; via?: unknown; failure?: unknown;
    requires?: { skills?: { name: string; level: number }[]; varps?: { varp: string; op: string; value: number }[]; items?: unknown[]; useItem?: unknown; coins?: number | null } };
export function shortcutTravel(edges: ShortcutRecord[]): Travel[] {
    const out: Travel[] = [];
    for (const e of edges) {
        if ((e.kind !== 'shortcut' && e.kind !== 'passage') || e.via || e.failure || e.requires?.useItem || e.requires?.items?.length) continue;
        if (e.from.level !== e.to.level && Math.abs(e.from.level - e.to.level) > 3) continue;
        const op = Number(e.option.match(/^op(\d)$/)?.[1]);
        if (!op) continue;
        out.push({
            id: `loc:${e.locName}@${e.from.x},${e.from.z},${e.from.level}>${e.to.x},${e.to.z}`, kind: e.kind, name: `${e.locName} ${e.option}`,
            from: e.from, to: e.to, coins: e.requires?.coins ?? 0,
            needs: [...(e.requires?.skills ?? []).map(k => ({ skill: k.name, level: k.level })), ...(e.requires?.varps ?? []).map(v => ({ varp: v.varp, op: v.op, value: v.value }))],
            runes: [], run: { how: 'loc', loc: e.locName, op, option: null, id: e.id, at: e.from },
            cost: Math.max(Math.abs(e.from.x - e.to.x), Math.abs(e.from.z - e.to.z)) + 3,
        });
    }
    return out;
}

let all: Travel[] | undefined;
export function loadTravel(): Travel[] {
    if (all) return all;
    const npc = JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'npc-travel.json'), 'utf8')) as { records: NpcRecord[] };
    const tele = JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'teleports.json'), 'utf8')) as { teleports: TeleRecord[]; staffs: { rune: string; staffs: string[] }[] };
    staffs = tele.staffs;
    const cuts = JSON.parse(readFileSync(join(repoRoot, 'knowledge', 'shortcuts.json'), 'utf8')) as { edges: ShortcutRecord[] };
    return all = [...npcTravel(npc.records), ...teleportTravel(tele.teleports), ...shortcutTravel(cuts.edges)];
}
let staffs: { rune: string; staffs: string[] }[] = [];

const compare = (have: number, op: string, want: number) => op === '>=' ? have >= want : op === '>' ? have > want : op === '=' ? have === want : op === '<' ? have < want : op === '<=' ? have <= want : false;
// Whether this account can take this travel now. An unknown quest stage counts as not met.
export function travelAllowed(t: Travel, a: Account): boolean {
    if ((a.coins ?? 0) < t.coins) return false;
    const count = (item: string) => a.counts?.[item] ?? (a.items.includes(item) ? 1 : 0);
    for (const n of t.needs) {
        if ('varp' in n) { const v = a.questStages?.[n.varp] ?? a.varps[n.varp]; if (v === undefined || !compare(v, n.op, n.value)) return false; }
        else if ('skill' in n) { if ((a.skills[n.skill] ?? 1) < n.level) return false; }
        else if ('held' in n) { if (count(n.held) < n.count) return false; }
        else if (!a.worn?.includes(n.worn)) return false;
    }
    for (const r of t.runes) {
        if (staffs.some(s => s.rune === r.item && s.staffs.some(st => a.worn?.includes(st)))) continue;
        if (count(r.item) < r.count) return false;
    }
    if (t.run.how === 'rub' && !t.run.items.some(i => count(i) > 0)) return false;
    return true;
}
