// The ways an account can obtain a wearable item now, from the generated content tables:
//   shop  knowledge/shops.json (the open shops), with the shop's tile from knowledge/gear-sources.json shopNpcs
//   npc   knowledge/gear-sources.json npc: a dialogue sale or hand-out, with its gate
//   quest knowledge/gear-sources.json quest: a reward or step item of a named quest
//   craft knowledge/skills.json: a skill action that outputs the item
//   drop  knowledge/drops.json: an NPC drop table that holds the item
//   clue  knowledge/gear-sources.json clue: a clue scroll reward proc
//   ge    the market ask of .practice/market-all.json (scripts/market-cache.ts marketQuotes), only with a seller and an
//         ask within GEAR_ASK_LIMIT times the item's content value
// An item with none of these is not a want.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Gear } from '../../knowledge/src/gear';
import type { GearSources, NpcGate } from '../../knowledge/src/gear-sources';

const ROOT = resolve(import.meta.dir, '..', '..', '..');

/** The highest market ask, in multiples of the item's content value, that counts as obtainable (scripts/autopilot.ts gearLimit). */
export const GEAR_ASK_LIMIT = 5;
/** The lowest market ask, in multiples of the item's content value, that is a real seller: an ask of 1 coin never fills. */
export const GEAR_ASK_FLOOR = 0.2;
/** Coins of cost that halve the value of a gain: a free or shop item beats a market item of a slightly higher gain. */
export const GEAR_COST_SCALE = 25_000;

export type Tile = { x: number; z: number; level: number };
export type GearSource =
    | { kind: 'shop'; shop: string; cost: number; tile?: Tile; distance?: number }
    | { kind: 'npc'; npc: string; cost: number; gate?: NpcGate; src: string; tile?: Tile; distance?: number }
    | { kind: 'quest'; quest: string; src: string }
    | { kind: 'craft'; skill: string; level: number; inputs: string[] }
    | { kind: 'drop'; npc: string; chance: number }
    | { kind: 'clue'; tier: string; src: string }
    | { kind: 'ge'; ask: number; sell: number };
export type GearSourceKind = GearSource['kind'];
export const GEAR_SOURCE_KINDS: readonly GearSourceKind[] = ['shop', 'npc', 'quest', 'craft', 'drop', 'clue', 'ge'];

export type MarketAsks = Readonly<Record<number, { ask: number | null; sell: number; trades?: number } | undefined>>;

/**
 * The market ask of the item when the market can supply it, else null: a seller, an ask from GEAR_ASK_FLOOR to
 * GEAR_ASK_LIMIT times the content value, and, when the cache says, at least one recent trade. The one place for both bounds.
 */
export function obtainableAsk(item: Gear, q: MarketAsks[number]): number | null {
    if (!item.tradeable || !q?.ask || q.sell <= 0 || q.trades === 0) return null;
    const value = Math.max(item.cost, 1);
    return q.ask >= GEAR_ASK_FLOOR * value && q.ask <= GEAR_ASK_LIMIT * value ? q.ask : null;
}
export interface SourceContext {
    /** Lower-case skill name to level. A skill that is absent is unknown. */
    skills: Partial<Record<string, number>>;
    /** Completed quest names (normalizeCompletedQuests). */
    done: ReadonlySet<string>;
    market?: MarketAsks;
    position?: { x: number; z: number } | null;
    /** The shops of the item that the account can use. */
    openShops: readonly { shop: string; cost: number }[];
}

type SkillRow = { skill: string; level: number; inputs: string[]; outputs: string[] };
type DropRoll = { chance: number; item?: string; items?: { item: string; chance: number }[] };
type DropTable = { trigger: string; always: { item: string }[]; rolls: DropRoll[] };
let tables: {
    sources: GearSources;
    npcById: Map<number, GearSources['npc'][number][]>;
    questById: Map<number, GearSources['quest'][number]>;
    clueById: Map<number, GearSources['clue'][number]>;
    craft: Map<string, SkillRow[]>;
    bestDrop: Map<string, { npc: string; chance: number }>;
    shopTiles: Map<string, Tile[]>;
} | undefined;

function load() {
    if (tables) return tables;
    const read = <T>(f: string) => JSON.parse(readFileSync(resolve(ROOT, 'knowledge', f), 'utf8')) as T;
    const sources = read<GearSources>('gear-sources.json');
    const npcById = new Map<number, GearSources['npc'][number][]>();
    for (const n of sources.npc) {
        let list = npcById.get(n.id);
        if (!list) { list = []; npcById.set(n.id, list); }
        list.push(n);
    }
    const questById = new Map<number, GearSources['quest'][number]>();
    for (const q of sources.quest) if (!questById.has(q.id)) questById.set(q.id, q);
    const clueById = new Map<number, GearSources['clue'][number]>();
    for (const c of sources.clue) if (!clueById.has(c.id)) clueById.set(c.id, c);
    const craft = new Map<string, SkillRow[]>();
    for (const r of read<SkillRow[]>('skills.json')) for (const o of r.outputs) {
        let list = craft.get(o);
        if (!list) { list = []; craft.set(o, list); }
        list.push(r);
    }
    const bestDrop = new Map<string, { npc: string; chance: number }>();
    const add = (item: string, npc: string, chance: number) => {
        const cur = bestDrop.get(item);
        if (!cur || chance > cur.chance) bestDrop.set(item, { npc, chance });
    };
    for (const t of read<DropTable[]>('drops.json')) {
        for (const a of t.always) add(a.item, t.trigger, 1);
        for (const r of t.rolls) {
            if (r.item) add(r.item, t.trigger, r.chance);
            for (const p of r.items ?? []) add(p.item, t.trigger, p.chance);
        }
    }
    const shopTiles = new Map<string, Tile[]>();
    for (const n of sources.shopNpcs) {
        let list = shopTiles.get(n.shop);
        if (!list) { list = []; shopTiles.set(n.shop, list); }
        list.push(...n.spawns);
    }
    return tables = { sources, npcById, questById, clueById, craft, bestDrop, shopTiles };
}

const distance = (from: { x: number; z: number } | null | undefined, tiles: readonly Tile[] | undefined): { tile: Tile; distance: number } | undefined => {
    if (!tiles?.length) return undefined;
    let best: { tile: Tile; distance: number } | undefined;
    for (const t of tiles) {
        const d = from ? Math.max(Math.abs(t.x - from.x), Math.abs(t.z - from.z)) : 0;
        if (!best || d < best.distance) best = { tile: t, distance: d };
    }
    return best;
};

/** Estimates, in coins, of the work behind a source that has no price. They rank sources; they are not measured costs. */
export const QUEST_SOURCE_COST = 100_000;
export const CLUE_SOURCE_COST_FACTOR = 20;
export const DROP_SOURCE_MAX_FACTOR = 1_000;

/**
 * The coin cost of the source. A shop, an NPC and the market have a price. A craft counts at the item's content value
 * (the materials), a clue reward at CLUE_SOURCE_COST_FACTOR times it, a drop at the value divided by its chance per kill
 * (at most DROP_SOURCE_MAX_FACTOR times), and a quest reward at QUEST_SOURCE_COST plus the value.
 */
export function sourceCost(item: Gear, s: GearSource): number {
    const value = Math.max(item.cost, 1);
    switch (s.kind) {
        case 'shop': case 'npc': return s.cost;
        case 'ge': return s.ask;
        case 'craft': return value;
        case 'clue': return value * CLUE_SOURCE_COST_FACTOR;
        case 'drop': return value * Math.min(DROP_SOURCE_MAX_FACTOR, 1 / Math.max(s.chance, 1 / DROP_SOURCE_MAX_FACTOR));
        case 'quest': return QUEST_SOURCE_COST + value;
    }
}
const KIND_ORDER = Object.fromEntries(GEAR_SOURCE_KINDS.map((k, i) => [k, i])) as Record<GearSourceKind, number>;

/** The sources of the item that the account can use now, the best first (the lowest price; with a known tile the nearest shop). */
export function gearSources(item: Gear, ctx: SourceContext): GearSource[] {
    const t = load(), out: GearSource[] = [];
    // The nearest shop with the item: with a known tile the distance picks among them, then the cost.
    const shops = ctx.openShops.map(sh => {
        const near = distance(ctx.position, t.shopTiles.get(sh.shop));
        return { kind: 'shop', shop: sh.shop, cost: sh.cost, ...(near ? { tile: near.tile, distance: near.distance } : {}) } as GearSource & { kind: 'shop' };
    }).sort((a, b) => ctx.position ? (a.distance ?? Infinity) - (b.distance ?? Infinity) || a.cost - b.cost : a.cost - b.cost || a.shop.localeCompare(b.shop));
    if (shops[0]) out.push(shops[0]);
    for (const n of t.npcById.get(item.id) ?? []) {
        if (n.gate && !(n.gate.quest && ctx.done.has(n.gate.quest))) continue;
        const spawn = distance(ctx.position, n.at?.map(a => ({ ...a })));
        out.push({ kind: 'npc', npc: n.npc, cost: n.cost, ...(n.gate ? { gate: n.gate } : {}), src: n.src, ...(spawn ? { tile: spawn.tile } : {}) });
    }
    const quest = t.questById.get(item.id);
    if (quest) out.push({ kind: 'quest', quest: quest.quest, src: quest.src });
    for (const r of t.craft.get(item.debugname) ?? []) {
        const have = ctx.skills[r.skill];
        if (have !== undefined && have < r.level) continue;
        out.push({ kind: 'craft', skill: r.skill, level: r.level, inputs: r.inputs });
        break;
    }
    const drop = t.bestDrop.get(item.debugname);
    if (drop) out.push({ kind: 'drop', npc: drop.npc.replace(/^_/, ''), chance: drop.chance });
    const clue = t.clueById.get(item.id);
    if (clue) out.push({ kind: 'clue', tier: clue.tier, src: clue.src });
    const q = ctx.market?.[item.id], ask = obtainableAsk(item, q);
    if (ask !== null) out.push({ kind: 'ge', ask, sell: q!.sell });
    return out.sort((a, b) => sourceCost(item, a) - sourceCost(item, b) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

/** The value of a gain at a price: the gain, halved for each GEAR_COST_SCALE coins. */
export const valueOf = (gain: number, cost: number): number => gain / (1 + cost / GEAR_COST_SCALE);

/** Test hook: forget the loaded tables. */
export function resetGearSourceTables(): void { tables = undefined; }
