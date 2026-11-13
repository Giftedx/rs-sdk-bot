// Ground-item pickup rules for every bot. The random-event watcher (randomevents.ts) runs the pickup job; this file
// holds the pure rules it calls. An item is taken when it is worth the detour, the pickup adds no risk that the
// script did not already take, and the pack has room. A record run (Haggis, a specialist board) never loots: its
// playtime clock counts each tick.
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MAIN_ACCOUNT } from './haggisgate';
import { wildernessLevel } from './prayer-guard';
import { SPECIALIST_BOARDS } from './specialist-launch';

export type Ground = { id: number; name?: string; count: number; x: number; z: number; distance: number; reachable?: boolean };
export type Held = { slot: number; id: number; name?: string; count: number };
export type ItemInfo = { name: string; debugname: string; cost: number; tradeable: boolean };
export interface LootTables {
    info(id: number): ItemInfo | undefined;
    // The GE bid for one item, 0 when the price file has none.
    bid(id: number): number;
    // True when the supply bill is short of the item: a route needs it, whatever its price.
    wanted(id: number): boolean;
}
export interface LootRules {
    // Coins of value for each tick of detour. A guess, not a measurement: about 100 times the goldfarm rate.
    perTick: number;
    // The farthest pile (Chebyshev tiles) the job walks to.
    maxDistance: number;
    // The job does not start below this share of the maximum Hitpoints.
    minHp: number;
}
export const LOOT_RULES: LootRules = { perTick: 1000, maxDistance: 15, minHp: 0.5 };

export const COINS = 995;
// High alchemy pays 60% of the item cost: the value floor of a tradeable item that the GE file does not price.
export const ALCH_SHARE = 0.6;
// Ticks after a hit on the player in which the player counts as in a fight (the engine's 8-tick combat lock).
export const COMBAT_TICKS = 8;
// Players within this many tiles count as a threat in the Wilderness.
export const PLAYER_RANGE = 15;

// A record run: the main account, a specialist board account, or any run with HAGGIS_RUN=1.
export const recordRun = (name: string, env: Record<string, string | undefined> = process.env): boolean =>
    name.toLowerCase() === MAIN_ACCOUNT || Object.hasOwn(SPECIALIST_BOARDS, name.toLowerCase()) || env.HAGGIS_RUN === '1';

// The value of one item. Coins are worth 1. Others take the GE bid or the alchemy floor, whichever is higher.
// An item that cannot be traded is worth 0: the bill (`wanted`) is its only reason to be taken.
export function unitValue(id: number, t: LootTables): number {
    if (id === COINS) return 1;
    const i = t.info(id);
    if (!i?.tradeable) return 0;
    return Math.max(t.bid(id), Math.floor(i.cost * ALCH_SHARE));
}
export const pileValue = (g: Pick<Ground, 'id' | 'count'>, t: LootTables) => unitValue(g.id, t) * g.count;

// Ticks the pickup costs the script: running there and back takes about the distance, plus a pickup and a start.
export const detourTicks = (distance: number) => distance + 2;

// A pile the supply bill is short of needs a tenth of the value, and an untradeable one counts at its item cost.
// A wanted pile still needs some value: a cheap bill item (feathers) would pull every bot near a chicken pen off its
// work for each feather.
export const WANTED_SHARE = 10;
export function worthIt(g: Ground, t: LootTables, r: LootRules = LOOT_RULES): boolean {
    if (g.distance > r.maxDistance) return false;
    const need = r.perTick * detourTicks(g.distance);
    if (!t.wanted(g.id)) return pileValue(g, t) >= need;
    return Math.max(pileValue(g, t), (t.info(g.id)?.cost ?? 0) * g.count) * WANTED_SHARE >= need;
}

const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
const tileOf = (n: any) => ({ x: n.tileX ?? n.x, z: n.tileZ ?? n.z });

// Null when the pickup is safe, else the reason it is not. Rule: the pickup adds no risk that the script does not
// already take. The player goes no deeper into the Wilderness, meets no stranger there, and walks into the range
// of no hunting NPC that does not already have the player in range.
export function lootRisk(st: any, g: Ground, danger: ReadonlyMap<number, number>, friends: ReadonlySet<string>, r: LootRules = LOOT_RULES): string | null {
    const p = st?.player;
    if (!p) return 'no-state';
    if (g.reachable === false) return 'unreachable';
    const hp = p.hp ?? 0, max = p.maxHp ?? 0;
    if (max <= 0 || hp / max < r.minHp) return 'hp';
    const tick = st.tick ?? 0, hit = p.combat?.lastDamageTick ?? -1;
    if (p.combat?.inCombat || (hit >= 0 && tick - hit <= COMBAT_TICKS)) return 'combat';
    const me = { x: p.worldX ?? p.x, z: p.worldZ ?? p.z };
    const wildMe = wildernessLevel(me.x, me.z), wildThere = wildernessLevel(g.x, g.z);
    if (wildThere > wildMe) return 'deeper';
    if (Math.max(wildMe, wildThere) > 0 && (st.nearbyPlayers ?? []).some((q: any) => !friends.has(String(q.name ?? '').toLowerCase()) && (q.distance ?? 0) <= PLAYER_RANGE))
        return 'player';
    for (const n of st.nearbyNpcs ?? []) {
        const range = danger.get(n.id);
        if (range === undefined) continue;
        const t = tileOf(n);
        if (cheb(t, g) <= range && cheb(t, me) > range) return 'npc';
    }
    return null;
}

// True for an item that goes on one stack: coins, a noted item, or a pile of more than one on one ground entry.
export const stacks = (g: Pick<Ground, 'id' | 'count'>, t: LootTables, pack: readonly Held[]) =>
    g.id === COINS || g.count > 1 || /^cert_/.test(t.info(g.id)?.debugname ?? '') || pack.some(i => i.id === g.id && i.count > 1);

// Room for the pile: 'ok', the slot to drop first, or null. The only item the job drops is one of several slots
// of one item (a resource the script gathers, not a tool it holds once) that is worth under a tenth of the pile,
// is not kept and is not reserved.
export function lootRoom(pack: readonly Held[], g: Ground, t: LootTables, keep: (id: number) => boolean): 'ok' | number | null {
    if (stacks(g, t, pack) && pack.some(i => i.id === g.id)) return 'ok';
    if (pack.length < 28) return 'ok';
    const worth = pileValue(g, t), slots = new Map<number, number>();
    for (const i of pack) slots.set(i.id, (slots.get(i.id) ?? 0) + 1);
    let best: Held | null = null, bestValue = Infinity;
    for (const i of pack) {
        if (keep(i.id) || (slots.get(i.id) ?? 0) < 2) continue;
        const v = unitValue(i.id, t) * i.count;
        if (v * 10 >= worth || v > bestValue) continue;
        if (v < bestValue || (best && i.slot > best.slot)) { best = i; bestValue = v; }
    }
    return best ? best.slot : null;
}

// One claim per pile across the sessions of one process (the bot host runs many bots in one process), so two of
// our bots never walk to the same pile.
const claims = new Map<string, { by: string; until: number }>();
export const pileKey = (level: number, g: Pick<Ground, 'id' | 'x' | 'z'>) => `${level}:${g.x}:${g.z}:${g.id}`;
export function claimPile(key: string, by: string, now = Date.now(), ms = 20_000): boolean {
    const c = claims.get(key);
    if (c && c.by !== by && c.until > now) return false;
    claims.set(key, { by, until: now + ms });
    return true;
}
export const releasePile = (key: string, by: string) => { if (claims.get(key)?.by === by) claims.delete(key); };

// One set of tables for all sessions of a process.
let shared: LootTables | null = null;
export const sharedLootTables = (): LootTables => (shared ??= fileTables());

// The tables from disk: knowledge/items.json, the GE file and the supply bill (.practice/coordinator). The two
// .practice files are read again when they change, at most each RELOAD_MS. A missing file gives no prices or no bill.
const RELOAD_MS = 600_000;
export function fileTables(root = resolve(import.meta.dir, '..', '..', '..')): LootTables {
    const items = new Map<number, ItemInfo>();
    try {
        for (const i of JSON.parse(readFileSync(join(root, 'knowledge', 'items.json'), 'utf8')) as any[])
            items.set(i.id, { name: i.name ?? '', debugname: i.debugname ?? '', cost: i.cost ?? 0, tradeable: i.tradeable === true });
    } catch { /* no item file: every item is worth 0 */ }
    const byDebug = new Map([...items].map(([id, i]) => [i.debugname, id]));
    const pricesFile = join(root, '.practice', 'coordinator', 'market-prices.json');
    const billFile = join(root, '.practice', 'coordinator', 'supply-bill.json');
    let bids = new Map<number, number>(), wanted = new Set<number>(), checked = 0, stamp = '';
    const load = () => {
        const now = Date.now();
        if (now - checked < RELOAD_MS && checked) return;
        checked = now;
        const mtime = (f: string) => { try { return String(statSync(f).mtimeMs); } catch { return '-'; } };
        const next = `${mtime(pricesFile)}|${mtime(billFile)}`;
        if (next === stamp) return;
        stamp = next;
        const b = new Map<number, number>(), w = new Set<number>();
        try {
            for (const [name, p] of Object.entries(JSON.parse(readFileSync(pricesFile, 'utf8')) as Record<string, any>)) {
                const id = byDebug.get(name);
                if (id !== undefined && typeof p?.bid === 'number' && p.bid > 0) b.set(id, p.bid);
            }
        } catch { /* no prices */ }
        try {
            for (const row of (JSON.parse(readFileSync(billFile, 'utf8')).rows ?? []) as any[])
                if ((row?.short ?? 0) > 0) for (const id of row.ids ?? []) w.add(id);
        } catch { /* no bill */ }
        bids = b; wanted = w;
    };
    return {
        info: id => items.get(id),
        bid: id => { load(); return bids.get(id) ?? 0; },
        wanted: id => { load(); return wanted.has(id); },
    };
}
